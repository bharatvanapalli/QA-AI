import { describe, expect, it, vi } from 'vitest';
import policy from '../../server/services/runtimeHealingPolicy.js';

describe('runtime healing policy', () => {
  it('uses strict defaults from the architecture plan', () => {
    expect(policy.DEFAULT_HEALING_BUDGET).toMatchObject({
      max_locator_repairs: 2,
      max_alternate_action_strategies: 1,
      max_page_state_recoveries: 1,
      max_heal_time_ms: 15000,
      max_heal_tool_calls: 6,
      max_heal_input_tokens: 12000,
      max_heal_output_tokens: 1500,
    });
  });

  it('stops runaway locator repair attempts', () => {
    const tracker = policy.createHealingBudgetTracker({
      budget: policy.healingBudgetFromEnv({}, { max_locator_repairs: 1 }),
    });
    tracker.recordLocatorRepair();
    expect(() => tracker.recordLocatorRepair()).toThrow(/locator-repair budget exhausted/i);
  });

  it('enforces input token caps before healer execution continues', () => {
    const tracker = policy.createHealingBudgetTracker({
      budget: policy.healingBudgetFromEnv({}, { max_heal_input_tokens: 2 }),
    });
    expect(() => tracker.recordInput('this text is definitely more than two approximate tokens')).toThrow(/input-token budget/i);
  });

  it('enforces tool-call caps across snapshot, healer, and retry work', () => {
    const tracker = policy.createHealingBudgetTracker({
      budget: policy.healingBudgetFromEnv({}, { max_heal_tool_calls: 2 }),
    });
    tracker.recordToolCall({ phase: 'fresh_snapshot' });
    tracker.recordToolCall({ phase: 'healer_llm' });
    expect(() => tracker.recordToolCall({ phase: 'healed_retry' })).toThrow(/tool calls/i);
  });

  it('allows only observation retries while delegating mutation retries to the coordinator', () => {
    expect(policy.healingToolPolicy('browser_snapshot', {})).toMatchObject({
      mutating: false,
      dispatchOwner: 'observation_lane',
      retryMode: 'observation_retry_allowed',
    });
    expect(policy.healingToolPolicy('browser_click', { target: 'e1' })).toMatchObject({
      mutating: true,
      dispatchOwner: 'action_execution_gateway',
      retryMode: 'coordinator_positive_non_delivery_only',
    });
  });

  it('enforces output token caps for healer proposals and retry results', () => {
    const tracker = policy.createHealingBudgetTracker({
      budget: policy.healingBudgetFromEnv({}, { max_heal_output_tokens: 2 }),
    });
    expect(() => tracker.recordOutput('this healed locator explanation is too long')).toThrow(/output-token budget/i);
  });

  it('times out long-running healer calls', async () => {
    vi.useFakeTimers();
    const task = policy.runWithHealingTimeout(
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 100)),
      10,
      { step: 1 },
    );
    const assertion = expect(task).rejects.toMatchObject({
      code: 'healing_budget_time_exhausted',
      runtimeStatus: 'runtime_failed_after_healing_budget',
    });
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    vi.useRealTimers();
  });
});
