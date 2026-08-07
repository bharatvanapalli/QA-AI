import { describe, expect, it } from 'vitest';
import contracts from '../../server/services/reliability/contracts.js';
import orchestrator from '../../server/services/reliability/orchestrator.js';
import repairers from '../../server/services/reliability/repairers.js';
import promotion from '../../server/services/reliability/promotion.js';

function validate(scenarios, context = {}) {
  return contracts.collectScenarioReliabilityDefects(scenarios, context);
}

function adminContext() {
  return {
    coverageManifest: {
      items: [{
        manifestItemId: 'admin-search',
        title: 'System user search by username, role, employee name, and status',
        required: true,
        requiredFields: ['username', 'role', 'employee name', 'status'],
      }],
    },
  };
}

function claimContext() {
  return {
    coverageManifest: {
      items: [{
        manifestItemId: 'claim-validation',
        title: 'Claim request form validation for event, currency, amount, and remarks',
        required: true,
        requiredFields: ['event', 'currency', 'amount', 'remarks'],
      }],
    },
  };
}

describe('default reliability repairers', () => {
  it('repairs defective Admin Search required fields', async () => {
    const scenarios = [{
      id: 'scenario-admin',
      name: 'Admin System User Search',
      cases: [{
        id: 'case-admin',
        name: 'Search system users',
        module: 'Admin',
        caseIntent: 'admin_search',
        coverageRefs: ['admin-search'],
        steps: [
          { action: 'Fill', target: 'Username filter', value: '{{usernamefilter}}' },
          { action: 'Fill', target: 'Employee Name filter', value: '{{employeename}}' },
          { action: 'Click', target: 'Search button', expected: 'Records Found', verify: { kind: 'text', target: 'System Users results table', expected: 'Records Found' } },
        ],
      }],
    }];
    const context = adminContext();
    const defects = validate(scenarios, context);

    expect(defects.filter((defect) => defect.code === 'missing_required_story_field').map((defect) => defect.evidence.field))
      .toEqual(expect.arrayContaining(['role', 'status']));

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects,
      context,
      repairers: repairers.defaultReliabilityRepairers,
      validate,
    });

    expect(result.accepted).toBe(true);
    expect(result.defects.filter((defect) => defect.code === 'missing_required_story_field')).toHaveLength(0);
    const repairedSteps = result.scenarios[0].cases[0].steps;
    expect(repairedSteps.some((step) => /role/i.test(step.target) && step.action === 'Select')).toBe(true);
    expect(repairedSteps.some((step) => /status/i.test(step.target) && step.action === 'Select')).toBe(true);
  });

  it('repairs defective Claim validation required fields', async () => {
    const scenarios = [{
      id: 'scenario-claim',
      name: 'Claim Submit and Validation',
      cases: [{
        id: 'case-claim',
        name: 'Validate claim request required fields',
        module: 'Claim',
        caseIntent: 'claim_validation',
        coverageRefs: ['claim-validation'],
        steps: [
          { action: 'Fill', target: 'Remarks field', value: '{{claimremarks}}' },
          { action: 'Click', target: 'Submit button', expected: 'Required', verify: { kind: 'validation_message', target: 'Claim required fields', expected: 'Required' } },
        ],
      }],
    }];
    const context = claimContext();
    const defects = validate(scenarios, context);

    expect(defects.filter((defect) => defect.code === 'missing_required_story_field').map((defect) => defect.evidence.field))
      .toEqual(expect.arrayContaining(['event', 'currency', 'amount']));

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects,
      context,
      repairers: repairers.defaultReliabilityRepairers,
      validate,
    });

    expect(result.accepted).toBe(true);
    expect(result.defects.filter((defect) => defect.code === 'missing_required_story_field')).toHaveLength(0);
    const targets = result.scenarios[0].cases[0].steps.map((step) => step.target);
    expect(targets).toEqual(expect.arrayContaining(['Event field', 'Currency field', 'Amount field']));
  });

  it('preserves the full suite when a repairer fails', async () => {
    const scenarios = [{ id: 'scenario-1', cases: [{ id: 'case-1', coverageRefs: ['admin-search'] }] }];
    const defects = [contracts.createReliabilityDefect({ code: 'missing_required_story_field', caseId: 'case-1', evidence: { field: 'role' } })];

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects,
      repairers: {
        missing_required_field: () => {
          throw new Error('repair unavailable');
        },
      },
    });

    expect(result.scenarios).toEqual(scenarios);
    expect(result.defects.map((defect) => defect.code)).toContain('llm_repair_failed');
    expect(result.repairStopReason).toBe('llm_repair_failed');
  });

  it('does not replace a case when safe merge rejects the repair', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Save employee',
        coverageRefs: ['pim-save'],
        steps: [{ action: 'Click', target: 'Save button', expected: 'page ready', verify: { kind: 'none' } }],
      }],
    }];
    const defects = [contracts.createReliabilityDefect({ code: 'weak_oracle', caseId: 'case-1' })];

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects,
      repairers: {
        weak_oracle: ({ scenarios: current }) => ({
          scenarios: [{
            ...current[0],
            cases: [{ ...current[0].cases[0], coverageRefs: [], name: 'Unsafe replacement' }],
          }],
        }),
      },
      validate: () => [],
    });

    expect(result.scenarios[0].cases[0].name).toBe('Save employee');
    expect(result.repairRounds[0].accepted).toBe(false);
    expect(result.auditEvents.some((event) => event.action === 'repair_rejected_safe_merge')).toBe(true);
  });

  it('blocks merge acceptance when repair introduces a higher-severity regression', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Save employee',
        coverageRefs: ['pim-save'],
        steps: [{ action: 'Click', target: 'Save button', expected: 'page ready', verify: { kind: 'none' } }],
      }],
    }];
    const defects = [contracts.createReliabilityDefect({ code: 'weak_oracle', caseId: 'case-1' })];
    const critical = contracts.createReliabilityDefect({
      code: 'repair_introduced_regression',
      severity: 'critical',
      caseId: 'case-1',
    });

    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects,
      repairers: {
        weak_oracle: ({ scenarios: current }) => ({
          scenarios: [{
            ...current[0],
            cases: [{ ...current[0].cases[0], oracles: [{ kind: 'text', target: 'Personal Details', expected: 'Personal Details' }] }],
          }],
        }),
      },
      validate: () => [critical],
    });

    expect(result.accepted).toBe(false);
    expect(result.scenarios).toEqual(scenarios);
    expect(result.repairRounds[0].rejectionReason).toBe('defect_regression_guard_rejected');
  });

  it('attaches repair rounds and audit events to the reliability report', async () => {
    const scenarios = [{
      id: 'scenario-1',
      cases: [{
        id: 'case-1',
        name: 'Search system users',
        coverageRefs: ['admin-search'],
        steps: [
          { action: 'Fill', target: 'Username filter', value: '{{usernamefilter}}' },
          { action: 'Click', target: 'Search button', expected: 'Records Found', verify: { kind: 'text', target: 'System Users results table', expected: 'Records Found' } },
        ],
      }],
    }];
    const context = adminContext();
    const defects = validate(scenarios, context);
    const result = await orchestrator.runReliabilityRepairOrchestrator({
      scenarios,
      defects,
      context,
      repairers: repairers.defaultReliabilityRepairers,
      validate,
    });
    const report = promotion.createScenarioReliabilityReport({
      scenarios: result.scenarios,
      defects: result.defects,
      repairRounds: result.repairRounds,
      repairAuditEvents: result.auditEvents,
      repairStopReason: result.repairStopReason,
      repairRoundsUsed: result.repairRounds.length,
      tokensUsed: result.tokensUsed,
      repairBudget: result.budget,
    });

    expect(report.repairRounds).toHaveLength(result.repairRounds.length);
    expect(report.repairAuditEvents.length).toBeGreaterThan(0);
    expect(report.repairStopReason).toBe(result.repairStopReason);
    expect(report.repairBudget.tokenBudgetStatus).toBe('not_applicable_deterministic');
    expect(report.unresolvedDefects).toEqual(result.defects);
  });
});
