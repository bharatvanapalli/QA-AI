import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const planningBridge = require('../../server/services/caseContractPlanningBridge');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');

const VALUES = Object.freeze({
  order_number: '007995145',
  equipment: 'LTL',
  expected_status: 'Ready for review',
});
const RAW_SECRET = 'Inline-Test-Credential-9!';
const SHARED_DATE = '08/20/2026';

function sourceText() {
  return `
Inline test data:
Order Number: ${VALUES.order_number}
Equipment: ${VALUES.equipment}
Expected Status: ${VALUES.expected_status}

Test Case: Prepare an order for review
Test steps:
1. Enter ${VALUES.order_number} in the Order Number field.
2. Select ${VALUES.equipment} in the Equipment dropdown.
3. Verify ${VALUES.expected_status} is visible.

Final validation:
Verify ${VALUES.expected_status} is visible.
`;
}

function replaceInlineTokens(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.-]*)\s*\}\}/g, (match, rawToken) => (
      Object.prototype.hasOwnProperty.call(VALUES, rawToken.toLowerCase())
        ? VALUES[rawToken.toLowerCase()]
        : match
    ));
  }
  if (Array.isArray(value)) return value.map(replaceInlineTokens);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceInlineTokens(entry)]));
}

function prepareLiteralCandidate() {
  const requirement = {
    id: 'add-scenario:inline-literal-candidate',
    source: 'add_scenario',
    title: 'Prepare an order for review',
    content: sourceText(),
  };
  const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
  const bridged = planningBridge.buildCaseContractPlanningBridge({
    proceduralFlowContract: procedural,
    coverageManifest: { version: 1, items: [] },
    caseContractPacks: [],
  });
  const plan = testDesignPlanV1.buildTestDesignPlanV1({
    coverageManifest: bridged.coverageManifest,
    caseContractPacks: bridged.caseContractPacks,
    requirements: [requirement],
  });
  const casePlan = plan.scenarios[0].cases[0];
  const tokenCandidate = architect.deterministicScenarioFromPack({
    ...bridged.caseContractPacks[0],
    planCaseId: casePlan.planCaseId,
  }, 'inline_literal_candidate_test');
  return {
    plan,
    procedural,
    candidate: replaceInlineTokens(tokenCandidate),
  };
}

function prepareSensitiveLiteralCandidate() {
  const requirement = {
    id: 'add-scenario:sensitive-literal-candidate',
    source: 'add_scenario',
    title: 'Authenticate with an inline credential',
    content: `
Inline test data:
Password: ${RAW_SECRET}

Test Case: Authenticate
Test steps:
1. Enter ${RAW_SECRET} in the Password field.
2. Verify Home is visible.
`,
  };
  const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
  const bridged = planningBridge.buildCaseContractPlanningBridge({
    proceduralFlowContract: procedural,
    coverageManifest: { version: 1, items: [] },
    caseContractPacks: [],
  });
  const plan = testDesignPlanV1.buildTestDesignPlanV1({
    coverageManifest: bridged.coverageManifest,
    caseContractPacks: bridged.caseContractPacks,
    requirements: [requirement],
  });
  const casePlan = plan.scenarios[0].cases[0];
  const tokenCandidate = architect.deterministicScenarioFromPack({
    ...bridged.caseContractPacks[0],
    planCaseId: casePlan.planCaseId,
  }, 'sensitive_inline_literal_candidate_test');
  const candidate = structuredClone(tokenCandidate);
  const fill = candidate.cases[0].steps.find((step) => /^fill$/i.test(step.action));
  fill.value = RAW_SECRET;
  return { plan, procedural, candidate, tokenCandidate };
}

function prepareDuplicateLiteralCandidate() {
  const requirement = {
    id: 'add-scenario:duplicate-literal-bindings',
    source: 'add_scenario',
    title: 'Schedule a generic window',
    content: `
Inline test data:
Window Start Date: ${SHARED_DATE}
Window End Date: ${SHARED_DATE}

Test Case: Schedule a generic window
Test steps:
1. Enter ${SHARED_DATE} in the Window Start Date field.
2. Enter ${SHARED_DATE} in the Window End Date field.
3. Verify the scheduling form remains visible.
`,
  };
  const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
  // Construct the compiler-boundary ambiguity before the immutable plan is
  // hashed. The parser resolves the labelled fields correctly; this fixture
  // deliberately supplies an ambiguous authored contract to prove the
  // compiler still fails closed.
  procedural.caseContractV1.cases[0].steps
    .filter((step) => /^fill$/i.test(step.type))
    .forEach((step) => {
      step.dataRefs = ['data.window_start_date', 'data.window_end_date'];
    });
  const bridged = planningBridge.buildCaseContractPlanningBridge({
    proceduralFlowContract: procedural,
    coverageManifest: { version: 1, items: [] },
    caseContractPacks: [],
  });
  const plan = testDesignPlanV1.buildTestDesignPlanV1({
    coverageManifest: bridged.coverageManifest,
    caseContractPacks: bridged.caseContractPacks,
    requirements: [requirement],
  });
  const casePlan = plan.scenarios[0].cases[0];
  const candidate = architect.deterministicScenarioFromPack({
    ...bridged.caseContractPacks[0],
    planCaseId: casePlan.planCaseId,
  }, 'duplicate_inline_literal_candidate_test');
  candidate.cases[0].steps
    .filter((step) => /^fill$/i.test(step.action))
    .forEach((step) => { step.value = SHARED_DATE; });
  return { plan, procedural, candidate };
}

function compile(prepared) {
  return stepCompiler.compileCandidateSuite({
    testDesignPlan: prepared.plan,
    candidateScenarios: [prepared.candidate],
    proceduralFlowContract: prepared.procedural,
  }).scenarios[0].cases[0];
}

function expectFinding(fn, code) {
  try {
    fn();
    throw new Error('Expected strict inline compilation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(stepCompiler.TestDesignStepCompilationError);
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code, severity: 'error' }),
    ]));
    return error.findings.find((finding) => finding.code === code);
  }
}

describe('TestDesignStepCompiler Add Scenario literal candidates', () => {
  it('accepts exact proven literals while retaining internal data lineage and token-free executable output', () => {
    const prepared = prepareLiteralCandidate();
    const before = structuredClone(prepared.candidate);
    const compiled = compile(prepared);
    const fill = compiled.steps.find((step) => /^fill$/i.test(step.action));
    const select = compiled.steps.find((step) => /^select$/i.test(step.action));
    const executable = JSON.stringify({
      steps: compiled.steps,
      declaredAssertions: compiled.declaredAssertions,
      oracles: compiled.oracles,
    });

    expect(prepared.candidate).toEqual(before);
    expect(fill).toMatchObject({ value: VALUES.order_number, dataRefs: ['data.order_number'] });
    expect(select).toMatchObject({ value: VALUES.equipment, dataRefs: ['data.equipment'] });
    expect(executable).toContain(VALUES.expected_status);
    expect(executable).not.toMatch(/\{\{[^}]+\}\}/);
    expect(compiled.dataBinding).toMatchObject({ mode: 'inline', source: 'case_contract_v1' });
  });

  it('accepts boundary-safe proven literals carried only in same-ordinal Fill and Select narrative text', () => {
    const prepared = prepareLiteralCandidate();
    const candidateSteps = prepared.candidate.cases[0].steps;
    const fillCandidate = candidateSteps.find((step) => /^fill$/i.test(step.action));
    const selectCandidate = candidateSteps.find((step) => /^select$/i.test(step.action));
    delete fillCandidate.value;
    delete selectCandidate.value;

    expect(fillCandidate.text).toContain(VALUES.order_number);
    expect(selectCandidate.text).toContain(VALUES.equipment);

    const compiled = compile(prepared);
    const fill = compiled.steps.find((step) => /^fill$/i.test(step.action));
    const select = compiled.steps.find((step) => /^select$/i.test(step.action));
    const executable = JSON.stringify({
      steps: compiled.steps,
      declaredAssertions: compiled.declaredAssertions,
      oracles: compiled.oracles,
    });

    expect(fill).toMatchObject({
      text: expect.stringContaining(VALUES.order_number),
      dataRefs: ['data.order_number'],
    });
    expect(select).toMatchObject({
      text: expect.stringContaining(VALUES.equipment),
      dataRefs: ['data.equipment'],
    });
    expect(fill).toHaveProperty('value', VALUES.order_number);
    expect(select).toHaveProperty('value', VALUES.equipment);
    expect(executable).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('ignores candidate-declared dataRefs and projects the authored per-step binding', () => {
    const prepared = prepareLiteralCandidate();
    const fillCandidate = prepared.candidate.cases[0].steps.find((step) => /^fill$/i.test(step.action));
    fillCandidate.dataRefs = ['data.model_invented_ref'];

    const compiled = compile(prepared);
    const fill = compiled.steps.find((step) => /^fill$/i.test(step.action));

    expect(fill).toMatchObject({
      value: VALUES.order_number,
      dataRefs: ['data.order_number'],
    });
    expect(JSON.stringify(compiled.steps)).not.toContain('model_invented_ref');
  });

  it('rejects a genuine candidate action contradiction with exact step diagnostics', () => {
    const prepared = prepareLiteralCandidate();
    const fill = prepared.candidate.cases[0].steps.find((step) => /^fill$/i.test(step.action));
    fill.action = 'Click';
    fill.type = 'Click';

    const finding = expectFinding(() => compile(prepared), 'test_design_step_data_binding_drift');
    expect(finding).toMatchObject({
      reason: 'candidate_action_contradicts_authored_step',
      resolutionDecision: 'rejected_candidate_contradiction',
      stepOrdinal: expect.any(Number),
      contractStepId: expect.any(String),
    });
    expect(finding.message).toContain(`Step ${finding.stepOrdinal} rejected`);
  });

  it('rejects a literal that is not the exact value authored for that CaseContract step', () => {
    const prepared = prepareLiteralCandidate();
    const fill = prepared.candidate.cases[0].steps.find((step) => /^fill$/i.test(step.action));
    fill.value = '007995146';
    fill.dataRefs = ['data.order_number'];

    const finding = expectFinding(() => compile(prepared), 'test_design_step_data_binding_drift');
    expect(finding).toMatchObject({
      reason: 'candidate_explicit_value_not_authorized',
      resolutionDecision: 'rejected_candidate_contradiction',
      stepOrdinal: expect.any(Number),
      contractStepId: expect.any(String),
    });
    expect(finding.message).toContain(`Step ${finding.stepOrdinal} rejected`);
  });

  it('materializes a sensitive env reference only for execution and rejects a model-emitted raw literal', () => {
    const prepared = prepareSensitiveLiteralCandidate();
    const compiled = compile({ ...prepared, candidate: prepared.tokenCandidate });
    const fill = compiled.steps.find((step) => /^fill$/i.test(step.action));

    expect(JSON.stringify(prepared.plan)).not.toContain(RAW_SECRET);
    expect(JSON.stringify(compiled.caseContractV1)).not.toContain(RAW_SECRET);
    expect(fill).toMatchObject({ value: RAW_SECRET, dataRefs: ['data.password'] });
    expectFinding(() => compile(prepared), 'test_design_sensitive_literal');
  });

  it('fails closed when one repeated literal is ambiguously assigned to two authored data references', () => {
    const prepared = prepareDuplicateLiteralCandidate();
    const contractSteps = prepared.plan.scenarios[0].cases[0].caseContractV1.steps
      .filter((step) => /^fill$/i.test(step.type));

    expect(contractSteps).toHaveLength(2);
    expect(contractSteps[0].dataRefs).toEqual(expect.arrayContaining([
      'data.window_start_date',
      'data.window_end_date',
    ]));
    expect(contractSteps[1].dataRefs).toEqual(expect.arrayContaining([
      'data.window_start_date',
      'data.window_end_date',
    ]));
    expectFinding(() => compile(prepared), 'test_design_step_data_binding_drift');
  });

});
