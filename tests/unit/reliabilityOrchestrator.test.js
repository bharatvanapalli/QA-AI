import { describe, expect, it } from 'vitest';
import contracts from '../../server/services/reliability/contracts.js';
import orchestrator from '../../server/services/reliability/orchestrator.js';

function defect(code, extra = {}) {
  return contracts.createReliabilityDefect({ code, caseId: 'case-1', ...extra });
}

describe('reliability repair orchestrator', () => {
  it('groups defects into targeted repair families', () => {
    const groups = orchestrator.groupDefectsByRepairFamily([
      defect('missing_row_execution_plan'),
      defect('silent_row_skip', { rowId: 'row-2' }),
      defect('weak_oracle'),
    ]);

    expect(groups.map((group) => group.family)).toEqual(expect.arrayContaining([
      'missing_row_coverage',
      'weak_oracle',
    ]));
    expect(groups.find((group) => group.family === 'missing_row_coverage').defects).toHaveLength(2);
  });

  it('applies repair budget caps and reports skipped repair chunks', () => {
    const defects = Array.from({ length: 5 }, (_, index) => defect('missing_required_story_field', {
      id: `defect-${index + 1}`,
      caseId: `case-${index + 1}`,
    }));

    const plan = orchestrator.createRepairTasks({
      defects,
      budget: { maxCasesPerRepairPrompt: 2, maxTargetedRepairsPerDefectFamily: 1 },
    });

    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].targetDefectIds).toHaveLength(2);
    expect(plan.skippedRepairsDueToBudget).toBe(2);
  });

  it('rejects safe merge when coverage refs are dropped', () => {
    const guard = orchestrator.safeMergeCase({
      beforeCase: {
        id: 'case-1',
        coverageRefs: ['admin-search'],
        declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Records Found' } }],
      },
      afterCase: {
        id: 'case-1',
        coverageRefs: [],
        declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Records Found' } }],
      },
    });

    expect(guard.ok).toBe(false);
    expect(guard.reason).toBe('coverage_ref_dropped');
  });

  it('accepts before/after comparison only when target defects reduce', () => {
    const before = [defect('weak_oracle')];
    const after = [];

    const comparison = orchestrator.compareDefects({
      beforeDefects: before,
      afterDefects: after,
      targetDefects: before,
    });

    expect(comparison.targetDefectsReduced).toBe(true);
    expect(comparison.accepted).toBe(true);
  });

  it('rejects before/after comparison when a higher-severity defect appears', () => {
    const before = [defect('weak_oracle')];
    const after = [
      contracts.createReliabilityDefect({
        code: 'repair_introduced_regression',
        severity: 'critical',
        caseId: 'case-1',
      }),
    ];

    const comparison = orchestrator.compareDefects({
      beforeDefects: before,
      afterDefects: after,
      targetDefects: before,
    });

    expect(comparison.targetDefectsReduced).toBe(true);
    expect(comparison.higherSeverityNewDefects).toHaveLength(1);
    expect(comparison.accepted).toBe(false);
  });

  it('runs a repairer, safe-merges, validates, and writes audit history', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Save employee',
        coverageRefs: ['pim-save'],
        steps: [{ order: 1, action: 'Click', target: 'Save button', expected: 'page ready' }],
      }],
    }];
    const defects = [defect('weak_oracle')];

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      generationId: 'gen-1',
      scenarios,
      defects,
      repairers: {
        weak_oracle: ({ scenarios: current }) => ({
          scenarios: [{
            ...current[0],
            cases: [{
              ...current[0].cases[0],
              declaredAssertions: [{ type: 'TEXT', payload: { expectedText: 'Personal Details' } }],
            }],
          }],
        }),
      },
      validate: () => [],
    });

    expect(result.accepted).toBe(true);
    expect(result.repairRounds).toHaveLength(1);
    expect(result.repairRounds[0].accepted).toBe(true);
    expect(result.auditEvents.some((event) => event.action === 'repair_accepted')).toBe(true);
    expect(result.scenarios[0].cases[0].declaredAssertions).toHaveLength(1);
  });

  it('preserves the suite and records system defect when repair fails', async () => {
    const scenarios = [{ id: 'scenario-1', cases: [{ id: 'case-1', coverageRefs: ['claim-validation'] }] }];
    const defects = [defect('missing_required_story_field', { coverageRef: 'claim-validation' })];

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      generationId: 'gen-2',
      scenarios,
      defects,
      repairers: {
        missing_required_field: () => {
          throw new Error('repair service unavailable');
        },
      },
    });

    expect(result.scenarios).toEqual(scenarios);
    expect(result.defects.map((item) => item.code)).toContain('llm_repair_failed');
    expect(result.repairStopReason).toBe('llm_repair_failed');
    expect(result.auditEvents.some((event) => event.action === 'repair_failed')).toBe(true);
  });

  it('stops when the same target defect repeats after repair', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Search system users',
        coverageRefs: ['admin-search'],
        steps: [{ action: 'Click', target: 'Search button', expected: 'Records Found' }],
      }],
    }];
    const defects = [defect('weak_oracle')];

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      generationId: 'gen-3',
      scenarios,
      defects,
      repairers: {
        weak_oracle: ({ scenarios: current }) => ({ scenarios: current }),
      },
      validate: () => defects,
    });

    expect(result.repairStopReason).toBe('same_defect_repeated');
    expect(result.repairRounds[0].accepted).toBe(false);
    expect(result.repairRounds[0].rejectionReason).toBe('same_defect_repeated');
  });

  it('re-plans after an accepted repair and fixes a newly exposed second defect', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Search system users',
        coverageRefs: ['admin-search'],
        steps: [{ action: 'Click', target: 'Search button', expected: 'Records Found' }],
      }],
    }];
    const firstDefect = defect('missing_required_story_field', { evidence: { field: 'role' } });
    const weakOracle = defect('weak_oracle');

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      generationId: 'gen-4',
      scenarios,
      defects: [firstDefect],
      repairers: {
        missing_required_field: ({ scenarios: current }) => ({
          scenarios: [{
            ...current[0],
            cases: [{
              ...current[0].cases[0],
              steps: [
                { action: 'Select', target: 'User Role filter', value: '{{userrolefilter}}' },
                ...current[0].cases[0].steps,
              ],
            }],
          }],
        }),
        weak_oracle: ({ scenarios: current }) => ({
          scenarios: [{
            ...current[0],
            cases: [{
              ...current[0].cases[0],
              oracles: [{ kind: 'table_row', target: 'System Users results table', expected: 'matching user row' }],
            }],
          }],
        }),
      },
      validate: (current) => {
        const c = current[0].cases[0];
        if (!c.steps.some((step) => /role/i.test(step.target))) return [firstDefect];
        if (!Array.isArray(c.oracles) || !c.oracles.length) return [weakOracle];
        return [];
      },
    });

    expect(result.repairStopReason).toBe('all_contracts_passed');
    expect(result.repairRounds).toHaveLength(2);
    expect(result.repairRounds.every((round) => round.accepted)).toBe(true);
    expect(result.defects).toHaveLength(0);
  });

  it('stops re-planning at maxFullSuiteRepairRounds', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Search system users',
        coverageRefs: ['admin-search'],
        steps: [{ action: 'Click', target: 'Search button', expected: 'Records Found' }],
      }],
    }];
    const firstDefect = defect('missing_required_story_field', { evidence: { field: 'role' } });
    const weakOracle = defect('weak_oracle');

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects: [firstDefect],
      budget: { maxFullSuiteRepairRounds: 1 },
      repairers: {
        missing_required_field: ({ scenarios: current }) => ({
          scenarios: [{
            ...current[0],
            cases: [{
              ...current[0].cases[0],
              steps: [{ action: 'Select', target: 'User Role filter', value: '{{userrolefilter}}' }, ...current[0].cases[0].steps],
            }],
          }],
        }),
      },
      validate: () => [weakOracle],
    });

    expect(result.repairRounds).toHaveLength(1);
    expect(result.repairStopReason).toBe('max_rounds_reached');
    expect(result.defects.map((item) => item.code)).toContain('weak_oracle');
  });

  it('stops before repair when tool-call budget is exhausted', async () => {
    const scenarios = [{ id: 'scenario-1', cases: [{ id: 'case-1', coverageRefs: ['admin-search'] }] }];
    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects: [defect('weak_oracle')],
      budget: { maxRepairToolCalls: 0 },
      repairers: {
        weak_oracle: ({ scenarios: current }) => ({ scenarios: current }),
      },
    });

    expect(result.repairStopReason).toBe('budget_exhausted');
    expect(result.repairRounds).toHaveLength(0);
    expect(result.budget.budgetExhausted).toBe(true);
  });

  it('enforces token budget when a repairer reports token usage', async () => {
    const scenarios = [{ id: 'scenario-1', cases: [{ id: 'case-1', coverageRefs: ['admin-search'] }] }];
    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects: [defect('weak_oracle')],
      budget: { maxRepairTokens: 10 },
      repairers: {
        weak_oracle: ({ scenarios: current }) => ({ scenarios: current, tokensUsed: 15 }),
      },
    });

    expect(result.repairStopReason).toBe('budget_exhausted');
    expect(result.tokensUsed).toBe(15);
    expect(result.budget.tokenBudgetStatus).toBe('enforced');
  });

  it('honors active cancellation before running a repair task', async () => {
    const scenarios = [{ id: 'scenario-1', cases: [{ id: 'case-1', coverageRefs: ['admin-search'] }] }];
    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects: [defect('weak_oracle')],
      isCancelled: () => true,
      repairers: {
        weak_oracle: () => {
          throw new Error('should not run');
        },
      },
    });

    expect(result.cancelled).toBe(true);
    expect(result.repairStopReason).toBe('cancelled');
    expect(result.repairRounds).toHaveLength(0);
    expect(result.auditEvents.some((event) => event.action === 'repair_cancelled')).toBe(true);
  });
});
