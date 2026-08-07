import { describe, expect, it } from 'vitest';
import guard from '../../server/services/reliability/generationPromotionGuard.js';
import floorFill from '../../server/services/reliability/scenarioFloorFill.js';
import selfHealing from '../../server/services/reliability/selfHealingPipeline.js';
import architect from '../../server/services/agents/architect.js';
import generationCompiler from '../../server/services/generationCompiler.js';
import executionReadiness from '../../server/services/executionReadinessCompiler.js';

function clauses(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `req-${index + 1}`,
    behaviourText: `Requirement ${index + 1}`,
    testable: true,
  }));
}

function businessClauses(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `req-${index + 1}`,
    behaviourText: `Requirement ${index + 1} searches and filters records, verifies matching results, and validates missing required fields.`,
    testable: true,
  }));
}

describe('scenario generation promotion guard', () => {
  it('blocks a four-scenario suite when the requirement surface requires more', () => {
    const issues = guard.promotionIssuesForGeneration({
      scenarios: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }],
      requirementClauses: clauses(58),
      coverageValidation: { ok: true, missingRequired: [], summary: { required: 4, covered: 4 } },
    });

    expect(issues.map((issue) => issue.code)).toContain('scenario_floor_shortfall');
    expect(issues.find((issue) => issue.code === 'scenario_floor_shortfall').evidence.minScenarios).toBe(8);
  });

  it('does not apply the scenario floor to an explicit one-case procedural flow', () => {
    const issues = guard.promotionIssuesForGeneration({
      scenarios: [{ id: 'login-flow' }],
      requirementClauses: clauses(17),
      coverageValidation: { ok: true, missingRequired: [], summary: { required: 1, covered: 1 } },
      options: { proceduralOneCase: true },
    });

    expect(issues).toEqual([]);
  });

  it('does not reject authoritative authored cases for inferred coverage gaps', () => {
    const issues = guard.promotionIssuesForGeneration({
      scenarios: [{ id: 'login-flow' }, { id: 'order-flow' }],
      requirementClauses: [],
      coverageValidation: {
        ok: false,
        missingRequired: [{ manifestItemId: 'inferred-coverage-item' }],
        summary: { required: 1, covered: 0 },
      },
      options: { authoritativeAuthoredCases: true },
    });

    expect(issues).toEqual([]);
  });

  it('blocks promotion when coverage validation still reports required gaps', () => {
    const issues = guard.promotionIssuesForGeneration({
      scenarios: clauses(8).map((clause) => ({ id: `scenario-${clause.id}` })),
      requirementClauses: clauses(58),
      coverageValidation: {
        ok: false,
        missingRequired: [{ manifestItemId: 'admin-system-user-search' }],
        summary: { required: 4, covered: 3 },
      },
    });

    expect(issues.map((issue) => issue.code)).toEqual([
      'coverage_validation_failed',
      'coverage_required_missing',
    ]);
  });

  it('allows promotion when floor and required coverage both pass', () => {
    const issues = guard.promotionIssuesForGeneration({
      scenarios: clauses(8).map((clause) => ({ id: `scenario-${clause.id}` })),
      requirementClauses: clauses(58),
      coverageValidation: { ok: true, missingRequired: [], summary: { required: 4, covered: 4 } },
    });

    expect(issues).toEqual([]);
  });

  it('fills an under-floor suite with deterministic verified-clause scenarios', () => {
    const result = floorFill.floorFillScenarioSuite({
      scenarios: clauses(4).map((clause) => ({
        name: `Existing ${clause.id}`,
        cases: [{ name: `Case ${clause.id}`, requirementRefs: [clause.id], steps: [{ action: 'Navigate', target: 'Page' }] }],
      })),
      requirementClauses: clauses(58),
      targetFloor: 8,
      scenarioFactory: (pack) => ({
        name: `Fallback ${pack.coverageRef}`,
        module: pack.module,
        cases: [{
          name: `Fallback case ${pack.coverageRef}`,
          coverageRefs: [pack.coverageRef],
          requirementRefs: [pack.storyId],
          steps: [{ action: 'Navigate', target: pack.pageIntent }],
        }],
      }),
    });

    expect(result.added).toBe(4);
    expect(result.scenarios).toHaveLength(8);
    expect(result.scenarios.slice(4).every((scenario) => scenario.name.startsWith('Fallback req-'))).toBe(true);
  });

  it('uses Architect deterministic fallback without letting the compiler collapse below floor', () => {
    const seedClauses = businessClauses(4);
    const requirementClauses = businessClauses(58);
    const seed = seedClauses.map((clause, index) => architect.deterministicScenarioFromPack({
      coverageRef: clause.id,
      storyId: clause.id,
      module: 'PIM',
      title: `Requirement ${index + 1}`,
      pageIntent: `Requirement ${index + 1}`,
      requiredActions: ['verify'],
      requiredOracles: [{
        kind: 'visible',
        target: `Requirement ${index + 1}`,
        expected: true,
        source: 'case_contract_pack',
        required: true,
      }],
    }, 'unit_seed'));

    expect(seed.every((scenario) => scenario.cases.every((testCase) => (
      testCase.steps.some((step) => step.action === 'AssertVisible')
      && testCase.declaredAssertions.some((assertion) => (
        (assertion.type === 'VISIBLE' && assertion.payload?.expectedVisible === true)
        || (assertion.type === 'TEXT' && assertion.payload?.expectedText)
      ))
    )))).toBe(true);

    const filled = floorFill.floorFillScenarioSuite({
      scenarios: seed,
      requirementClauses,
      targetFloor: 8,
      scenarioFactory: (pack) => architect.deterministicScenarioFromPack(pack, 'unit_floor_fill'),
    });

    const compiled = generationCompiler.compileGeneration({
      scenarios: filled.scenarios,
      testData: null,
      project: { name: 'New Orange HRM', targetUrl: 'https://opensource-demo.orangehrmlive.com' },
      authProfileName: 'ADMIN_DEFAULT',
      atlasHasCapabilities: false,
    });

    expect(filled.scenarios).toHaveLength(8);
    const authoredCases = filled.scenarios.flatMap((scenario) => Array.isArray(scenario.cases) ? scenario.cases : []);
    expect(authoredCases.length).toBeGreaterThan(filled.scenarios.length);
    expect(compiled.readyScenarios).toHaveLength(8);
    expect(compiled.report.ready).toBeGreaterThanOrEqual(8);

    const executionReady = executionReadiness.compileExecutionReadiness({
      scenarios: compiled.readyScenarios,
      loginTemplate: null,
    });

    expect(executionReady.scenarios).toHaveLength(8);
    expect(executionReady.report.dropped).toEqual([]);
    expect(executionReady.report.needsAuthSetup.length).toBeGreaterThan(0);
  });

  it('authors rich deterministic fallback cases instead of one placeholder per contract pack', () => {
    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'admin-system-user-search',
      storyId: 'story-admin-search',
      title: 'System user search by username role employee name and status',
      pageIntent: 'Admin system users page',
      requiredFields: ['username', 'userRole', 'employeeName', 'status'],
      requiredActions: ['search'],
      rowIntents: ['positive', 'negative'],
      requiredOracles: [{
        kind: 'table_row',
        target: 'System Users table',
        expected: 'matching system user row',
        source: 'case_contract_pack',
        required: true,
      }],
    }, 'unit_provider_timeout');

    expect(scenario.module).toMatch(/^Admin(?:\s|$)/);
    expect(scenario.cases.length).toBeGreaterThanOrEqual(2);
    expect(scenario.cases.some((testCase) => /no matching result/i.test(testCase.name))).toBe(true);
    expect(scenario.cases.every((testCase) => testCase.primaryCoverageRef === 'admin-system-user-search')).toBe(true);
    expect(scenario.cases.every((testCase) => testCase.rowExecutionPlan && testCase.rowExecutionPlan.rowIntents.length > 0)).toBe(true);
  });

  it('prioritizes benchmark-critical coverage aliases in contract pack selection', () => {
    const manifest = {
      items: [
        ...Array.from({ length: 12 }, (_, index) => ({
          coverageRef: `cov::filler-${index}::standard`,
          title: `Filler data-bound flow ${index}`,
          required: false,
          requiredFields: ['field1', 'field2', 'field3', 'field4'],
          dataSource: { sheet: `Sheet${index}`, rows: [{ rowId: '1' }] },
          requiredOracles: [{ kind: 'state_change', target: `Filler ${index}`, expected: true, required: true }],
        })),
        {
          coverageRef: 'cov::req-cfb62c0008::standard',
          requirementId: 'REQ-cfb62c0008',
          title: 'US-OHRM-003: Admin user search finds enabled Admin users and supports filters',
          module: 'Admin',
          required: false,
          requiredFields: ['username', 'role', 'employee name', 'status'],
          requiredOracles: [{ kind: 'text', target: 'Result row', expected: 'matching user', required: true }],
        },
        {
          coverageRef: 'cov::req-26307b78cb::standard',
          requirementId: 'REQ-26307b78cb',
          title: 'Save and verify the Personal Details page opens for the created employee.',
          module: 'PIM',
          required: false,
          requiredFields: ['first name', 'middle name', 'last name', 'employee id'],
          requiredOracles: [{ kind: 'text', target: 'Personal Details', expected: 'Personal Details', required: true }],
        },
      ],
    };

    const packs = selfHealing.buildCaseContractPacks({ manifest, targetPackCount: 4 });
    expect(packs.map((pack) => pack.coverageRef)).toContain('cov::req-cfb62c0008::standard');
    expect(packs.map((pack) => pack.coverageRef)).toContain('cov::req-26307b78cb::standard');
    const admin = packs.find((pack) => pack.coverageRef === 'cov::req-cfb62c0008::standard');
    const pim = packs.find((pack) => pack.coverageRef === 'cov::req-26307b78cb::standard');
    expect(admin.requiredFields).toEqual(expect.arrayContaining(['username', 'role', 'employee name', 'status']));
    expect(admin.requiredOracles.some((oracle) => oracle.kind === 'text' && oracle.target === 'Result row')).toBe(true);
    expect(pim.requiredFields).toEqual(expect.arrayContaining(['first name', 'middle name', 'last name', 'employee id']));
    expect(pim.rowIntents).toEqual(expect.arrayContaining(['positive', 'boundary']));
  });

  it('preserves contract validation oracle target in deterministic fallback variants', () => {
    const scenario = architect.deterministicScenarioFromPack({
      coverageRef: 'claim-validation',
      title: 'Claim request form validates event currency amount and remarks',
      module: 'Claim',
      requiredFields: ['event', 'currency', 'amount', 'remarks'],
      requiredActions: ['submit'],
      requiredOracles: [{
        kind: 'validation_message',
        target: 'Claim validation message',
        expected: 'Required',
        source: 'case_contract_pack',
        required: true,
      }],
    }, 'unit_provider_timeout');

    const validationCase = scenario.cases.find((testCase) => /required field validation/i.test(testCase.name));
    const finalStep = validationCase.steps[validationCase.steps.length - 1];
    expect(finalStep.oracle.target).toBe('Claim validation message');
    expect(validationCase.declaredAssertions[0].payload.pageName).toBe('Claim validation message');
  });

  it('forces contract-pack batch mode for large requirement surfaces with packs', () => {
    expect(architect.shouldUseContractPackBatch({
      enabled: true,
      singleScenario: false,
      packCount: 1,
      batchSize: 4,
      largeRequirementSurface: true,
    })).toBe(true);

    expect(architect.shouldUseContractPackBatch({
      enabled: true,
      singleScenario: false,
      packCount: 0,
      batchSize: 4,
      largeRequirementSurface: true,
    })).toBe(false);

    expect(architect.shouldUseContractPackBatch({
      enabled: true,
      singleScenario: true,
      packCount: 10,
      batchSize: 4,
      largeRequirementSurface: true,
    })).toBe(false);
  });
});
