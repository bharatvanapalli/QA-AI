'use strict';

const browserMutationTaxonomy = require('./browserMutationTaxonomy');

const DEFAULT_HEALING_BUDGET = Object.freeze({
  max_locator_repairs: 2,
  max_alternate_action_strategies: 1,
  max_page_state_recoveries: 1,
  max_heal_time_ms: 15000,
  max_heal_tool_calls: 6,
  max_heal_input_tokens: 12000,
  max_heal_output_tokens: 1500,
});

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function healingBudgetFromEnv(env = process.env, overrides = {}) {
  return Object.freeze({
    max_locator_repairs: positiveInt(overrides.max_locator_repairs ?? env.QAAI_MAX_LOCATOR_REPAIRS, DEFAULT_HEALING_BUDGET.max_locator_repairs),
    max_alternate_action_strategies: positiveInt(overrides.max_alternate_action_strategies ?? env.QAAI_MAX_ALTERNATE_ACTION_STRATEGIES, DEFAULT_HEALING_BUDGET.max_alternate_action_strategies),
    max_page_state_recoveries: positiveInt(overrides.max_page_state_recoveries ?? env.QAAI_MAX_PAGE_STATE_RECOVERIES, DEFAULT_HEALING_BUDGET.max_page_state_recoveries),
    max_heal_time_ms: positiveInt(overrides.max_heal_time_ms ?? env.QAAI_MAX_HEAL_TIME_MS, DEFAULT_HEALING_BUDGET.max_heal_time_ms),
    max_heal_tool_calls: positiveInt(overrides.max_heal_tool_calls ?? env.QAAI_MAX_HEAL_TOOL_CALLS, DEFAULT_HEALING_BUDGET.max_heal_tool_calls),
    max_heal_input_tokens: positiveInt(overrides.max_heal_input_tokens ?? env.QAAI_MAX_HEAL_INPUT_TOKENS, DEFAULT_HEALING_BUDGET.max_heal_input_tokens),
    max_heal_output_tokens: positiveInt(overrides.max_heal_output_tokens ?? env.QAAI_MAX_HEAL_OUTPUT_TOKENS, DEFAULT_HEALING_BUDGET.max_heal_output_tokens),
  });
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(0, Math.ceil(String(text || '').length / 4));
}

function healingToolPolicy(toolName, args = {}) {
  const mutating = browserMutationTaxonomy.isMutatingTool(toolName, args);
  return Object.freeze({
    toolName: String(toolName || ''),
    mutationPolicy: browserMutationTaxonomy.mutationPolicyForTool(toolName),
    mutating,
    dispatchOwner: mutating ? 'action_execution_gateway' : 'observation_lane',
    retryMode: mutating ? 'coordinator_positive_non_delivery_only' : 'observation_retry_allowed',
  });
}

function budgetError(code, detail, evidence = {}) {
  const err = new Error(detail);
  err.code = code;
  err.runtimeStatus = 'runtime_failed_after_healing_budget';
  err.healingEvidence = evidence;
  return err;
}

function createHealingBudgetTracker({ budget = DEFAULT_HEALING_BUDGET, now = Date.now } = {}) {
  const startedAt = now();
  const state = {
    locatorRepairs: 0,
    alternateActionStrategies: 0,
    pageStateRecoveries: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const elapsedMs = () => Math.max(0, now() - startedAt);
  const remainingTimeMs = () => Math.max(0, budget.max_heal_time_ms - elapsedMs());

  function summary(extra = {}) {
    return {
      budget,
      usage: { ...state, elapsedMs: elapsedMs(), remainingTimeMs: remainingTimeMs() },
      ...extra,
    };
  }

  function assertCanContinue(extra = {}) {
    if (elapsedMs() >= budget.max_heal_time_ms) {
      throw budgetError('healing_budget_time_exhausted', `Healing budget exhausted after ${elapsedMs()}ms.`, summary(extra));
    }
    if (state.toolCalls > budget.max_heal_tool_calls) {
      throw budgetError('healing_budget_tool_calls_exhausted', `Healing budget exhausted after ${state.toolCalls} tool calls.`, summary(extra));
    }
    if (state.inputTokens > budget.max_heal_input_tokens) {
      throw budgetError('healing_budget_input_tokens_exhausted', `Healing input-token budget exhausted (${state.inputTokens}).`, summary(extra));
    }
    if (state.outputTokens > budget.max_heal_output_tokens) {
      throw budgetError('healing_budget_output_tokens_exhausted', `Healing output-token budget exhausted (${state.outputTokens}).`, summary(extra));
    }
  }

  function recordToolCall(extra = {}) {
    state.toolCalls += 1;
    assertCanContinue(extra);
  }

  function recordLocatorRepair(extra = {}) {
    state.locatorRepairs += 1;
    if (state.locatorRepairs > budget.max_locator_repairs) {
      throw budgetError('healing_budget_locator_repairs_exhausted', `Healing locator-repair budget exhausted (${state.locatorRepairs}).`, summary(extra));
    }
    assertCanContinue(extra);
  }

  function recordAlternateAction(extra = {}) {
    state.alternateActionStrategies += 1;
    if (state.alternateActionStrategies > budget.max_alternate_action_strategies) {
      throw budgetError('healing_budget_alternate_actions_exhausted', `Healing alternate-action budget exhausted (${state.alternateActionStrategies}).`, summary(extra));
    }
    assertCanContinue(extra);
  }

  function recordPageStateRecovery(extra = {}) {
    state.pageStateRecoveries += 1;
    if (state.pageStateRecoveries > budget.max_page_state_recoveries) {
      throw budgetError('healing_budget_page_state_recoveries_exhausted', `Healing page-state recovery budget exhausted (${state.pageStateRecoveries}).`, summary(extra));
    }
    assertCanContinue(extra);
  }

  function recordInput(value, extra = {}) {
    state.inputTokens += estimateTokens(value);
    assertCanContinue(extra);
  }

  function recordOutput(value, extra = {}) {
    state.outputTokens += estimateTokens(value);
    assertCanContinue(extra);
  }

  return Object.freeze({
    budget,
    startedAt,
    elapsedMs,
    remainingTimeMs,
    summary,
    assertCanContinue,
    recordToolCall,
    recordLocatorRepair,
    recordAlternateAction,
    recordPageStateRecovery,
    recordInput,
    recordOutput,
  });
}

async function runWithHealingTimeout(task, timeoutMs, evidence = {}) {
  const timeout = positiveInt(timeoutMs, DEFAULT_HEALING_BUDGET.max_heal_time_ms);
  let timeoutId = null;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(budgetError('healing_budget_time_exhausted', `Healing timed out after ${timeout}ms.`, evidence));
        }, timeout);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

module.exports = {
  DEFAULT_HEALING_BUDGET,
  healingBudgetFromEnv,
  estimateTokens,
  healingToolPolicy,
  createHealingBudgetTracker,
  runWithHealingTimeout,
};
