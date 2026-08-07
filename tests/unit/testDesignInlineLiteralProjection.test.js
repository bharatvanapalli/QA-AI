import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const planningBridge = require('../../server/services/caseContractPlanningBridge');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');
const testCaseContract = require('../../server/services/testCaseContract');

const AUTHORED_EMAIL = 'inline.user@example.test';
const AUTHORED_SECRET = 'Inline-Credential-For-Test-9!';
const AUTHORED_BANNER = 'Ready for review';
const INLINE_ROWS = [
  {
    email: 'first.inline@example.test',
    password: 'First-Inline-Credential-1!',
    banner: 'Welcome first inline user',
  },
  {
    email: 'second.inline@example.test',
    password: 'Second-Inline-Credential-2!',
    banner: 'Welcome second inline user',
  },
];

function sourceText() {
  return `
Inline test data:
Email Address: ${AUTHORED_EMAIL}
Password: ${AUTHORED_SECRET}
Expected Banner: ${AUTHORED_BANNER}

Test Case: Open the assigned work queue
Test steps:
1. Enter ${AUTHORED_EMAIL} in the Email Address field.
2. Enter ${AUTHORED_SECRET} in the Password field.
3. Verify ${AUTHORED_BANNER} is visible.

Final validation:
Verify ${AUTHORED_BANNER} is visible.
`;
}

function multiRowSourceText() {
  return `
Inline test data:
| Email Address | Password | Expected Banner |
| --- | --- | --- |
| ${INLINE_ROWS[0].email} | ${INLINE_ROWS[0].password} | ${INLINE_ROWS[0].banner} |
| ${INLINE_ROWS[1].email} | ${INLINE_ROWS[1].password} | ${INLINE_ROWS[1].banner} |

Test Case: Open the assigned work queue for each inline row
Test steps:
1. Enter Email Address in the Email Address field.
2. Enter Password in the Password field.
3. Verify Expected Banner is visible.

Final validation:
Verify Expected Banner is visible.
`;
}

function prepareCanonicalInlineCase(source, content = sourceText()) {
  const requirement = {
    id: `${source}:work-queue`,
    source,
    title: 'Work queue flow',
    content,
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
  const candidate = architect.deterministicScenarioFromPack({
    ...bridged.caseContractPacks[0],
    planCaseId: casePlan.planCaseId,
  }, 'inline_literal_projection_test');
  return { candidate, plan, procedural };
}

function compileCanonicalInlineCase(source, content = sourceText()) {
  const prepared = prepareCanonicalInlineCase(source, content);
  const compiled = stepCompiler.compileCandidateSuite({
    testDesignPlan: prepared.plan,
    candidateScenarios: [prepared.candidate],
    proceduralFlowContract: prepared.procedural,
  }).scenarios[0].cases[0];
  return { ...prepared, compiled };
}

function expectCompilationFinding(fn, code) {
  try {
    fn();
    throw new Error('Expected strict inline compilation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(stepCompiler.TestDesignStepCompilationError);
    expect(error.code).toBe(stepCompiler.COMPILATION_ERROR_CODE);
    expect(error.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code, severity: 'error' }),
    ]));
  }
}

describe('canonical inline literal executable projection', () => {
  it.each([
    ['fresh uploaded text', 'uploaded_requirement'],
    ['Add Scenario text', 'add_scenario'],
  ])('restores authored inputs, assertions, and validations for %s', async (_label, source) => {
    const { compiled, plan } = compileCanonicalInlineCase(source);
    const executableText = JSON.stringify({
      name: compiled.name,
      assertions: compiled.assertions,
      steps: compiled.steps,
      declaredAssertions: compiled.declaredAssertions,
      oracles: compiled.oracles,
    });

    expect(compiled.steps[0].value).toBe(AUTHORED_EMAIL);
    expect(compiled.steps[1].value).toBe(AUTHORED_SECRET);
    expect(executableText).toContain(AUTHORED_BANNER);
    expect(executableText).not.toMatch(/\{\{\s*(?:email|password|expected_banner)\s*\}\}/i);
    expect(compiled.compiledCaseRevision).toBe(stepCompiler.compiledCaseRevision(compiled));

    // Authored inline text remains literal in CaseContractV1. Deterministic
    // lineage stays compiler-owned through dataRefs/dataPlan instead of
    // rewriting visible steps to {{...}} placeholders.
    const plannedCase = plan.scenarios[0].cases[0];
    expect(JSON.stringify(plannedCase.caseContractV1)).toContain(AUTHORED_EMAIL);
    expect(JSON.stringify(compiled.caseContractV1)).toContain(AUTHORED_EMAIL);
    expect(JSON.stringify(plannedCase.caseContractV1)).not.toContain(AUTHORED_SECRET);
    expect(JSON.stringify(compiled.caseContractV1)).not.toContain(AUTHORED_SECRET);
    expect(JSON.stringify(plannedCase.caseContractV1)).not.toMatch(/\{\{\s*email\s*\}\}/i);
    expect(JSON.stringify(compiled.caseContractV1)).not.toMatch(/\{\{\s*email\s*\}\}/i);
    expect(plannedCase.dataPlan.allowedTokens).toContain('email');
    expect(compiled.dataBinding).toMatchObject({ mode: 'inline', source: 'case_contract_v1' });

    const created = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const prisma = {
      requirementClause: { findMany: async () => [] },
      testCase: {
        create: async ({ data }) => {
          created.push(data);
          return { id: `${source}:persisted`, ...data };
        },
        update: async () => ({}),
      },
    };
    await testCaseContract.persistCases({
      prisma,
      projectId: 'project-inline',
      scenarioId: 'scenario-inline',
      generationId: 'generation-inline',
      moduleName: compiled.module,
      cases: [compiled],
      log,
    });

    expect(created).toHaveLength(1);
    expect(JSON.parse(created[0].steps)[0].value).toBe(AUTHORED_EMAIL);
    expect(JSON.parse(created[0].steps)[1].value).toBe(AUTHORED_SECRET);
    expect(created[0].assertions).toContain(AUTHORED_BANNER);
    expect(JSON.stringify(JSON.parse(created[0].declaredAssertions))).not.toContain('{{expected_banner}}');
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(AUTHORED_SECRET);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(AUTHORED_SECRET);
  });

  it.each([
    ['fresh uploaded text', 'uploaded_requirement'],
    ['Add Scenario text', 'add_scenario'],
  ])('compiles one logical case with row-keyed literal instances for %s', async (_label, source) => {
    const { compiled } = compileCanonicalInlineCase(source, multiRowSourceText());
    const plan = compiled.rowExecutionPlan;

    expect(plan).toMatchObject({
      version: 1,
      mode: 'inline',
      executionMode: 'per_row',
      rowSelector: 'all_rows',
      rowIds: ['row-001', 'row-002'],
      inlineRevision: compiled.dataBinding.inlineRevision,
    });
    expect(plan.instances).toHaveLength(2);
    expect(plan.defaultInstanceId).toBe(plan.instances[0].instancePlanId);
    expect(new Set(plan.instances.map((instance) => instance.instancePlanId)).size).toBe(2);
    expect(new Set(plan.instances.map((instance) => instance.instanceRevision)).size).toBe(2);

    plan.instances.forEach((instance, index) => {
      const authored = INLINE_ROWS[index];
      expect(instance).toMatchObject({
        rowId: `row-00${index + 1}`,
        ordinal: index + 1,
        inputs: {
          email: authored.email,
          password: authored.password,
          expected_banner: authored.banner,
        },
      });
      expect(instance.publicBindings.password).toMatchObject({ kind: 'environment' });
      expect(instance.publicBindings.password).not.toHaveProperty('value');
      expect(instance.executableProjection.steps[0].value).toBe(authored.email);
      expect(instance.executableProjection.steps[1].value).toBe(authored.password);
      expect(instance.executableProjection.steps[2].expected).toBe(authored.banner);
      expect(instance.executableProjection.steps[2].target).toBe('Expected Banner');
      expect(instance.executableProjection.oracles[0].target).toBe(authored.banner);
      expect(instance.executableProjection.declaredAssertions[0].target).toBe('Expected Banner');
      expect(JSON.stringify(instance.executableProjection)).not.toMatch(/\{\{[^}]+\}\}/);
    });

    // The flat TestCase projection is explicitly the declared default row for
    // compatibility. Runtime authority for row 2 remains its own instance.
    expect(compiled.steps).toEqual(plan.instances[0].executableProjection.steps);
    expect(compiled.steps[0].value).not.toBe(plan.instances[1].executableProjection.steps[0].value);
    expect(compiled.compiledCaseRevision).toBe(stepCompiler.compiledCaseRevision(compiled));

    const created = [];
    const prisma = {
      requirementClause: { findMany: async () => [] },
      testCase: {
        create: async ({ data }) => {
          created.push(data);
          return { id: `${source}:multi-row`, ...data };
        },
        update: async () => ({}),
      },
    };
    await testCaseContract.persistCases({
      prisma,
      projectId: 'project-inline-rows',
      scenarioId: 'scenario-inline-rows',
      generationId: 'generation-inline-rows',
      moduleName: compiled.module,
      cases: [compiled],
      log: { info: vi.fn(), warn: vi.fn() },
    });

    expect(created).toHaveLength(1);
    const storedPlan = JSON.parse(created[0].rowExecutionPlanJson);
    expect(storedPlan.instances).toHaveLength(2);
    expect(storedPlan.instances[1].executableProjection.steps[0].value).toBe(INLINE_ROWS[1].email);
    expect(JSON.stringify(storedPlan.instances.map((instance) => instance.executableProjection)))
      .not.toMatch(/\{\{[^}]+\}\}/);
  });

  it('fails closed when one inline executable reference has multiple authored values', () => {
    const ambiguousSource = `
Inline test data:
Email Address: first.user@example.test
Email Address: second.user@example.test
Expected Banner: ${AUTHORED_BANNER}

Test Case: Open the assigned work queue
Test steps:
1. Enter second.user@example.test in the Email Address field.
2. Verify ${AUTHORED_BANNER} is visible.
`;
    const prepared = prepareCanonicalInlineCase('uploaded_requirement', ambiguousSource);

    expectCompilationFinding(() => stepCompiler.compileCandidateSuite({
      testDesignPlan: prepared.plan,
      candidateScenarios: [prepared.candidate],
      proceduralFlowContract: prepared.procedural,
    }), 'test_design_inline_literal_resolution_ambiguous');
  });

  it('reports duplicate row identity and incomplete row bindings as typed plan defects', () => {
    const prepared = prepareCanonicalInlineCase('uploaded_requirement', multiRowSourceText());
    const tampered = structuredClone(prepared.plan);
    const dataPlan = tampered.scenarios[0].cases[0].dataPlan;
    dataPlan.rowIds[1] = dataPlan.rowIds[0];
    dataPlan.rows[1].id = dataPlan.rows[0].id;
    delete dataPlan.rows[1].bindings.email;

    const validation = testDesignPlanV1.validateTestDesignPlanV1(tampered);
    expect(validation.ok).toBe(false);
    expect(validation.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'test_design_inline_row_id_duplicate' }),
      expect.objectContaining({
        code: 'test_design_inline_row_binding_missing',
        rowId: 'row-001',
        dataRefs: expect.arrayContaining(['data.email']),
      }),
    ]));
  });

  it('fails closed instead of retaining tokens when the supplied ephemeral binding map is incomplete', () => {
    const prepared = prepareCanonicalInlineCase('add_scenario');
    const detachedProceduralSource = {
      ...prepared.procedural,
      // JSON reconstruction intentionally drops CaseContractV1's process-local
      // raw binding WeakMap while retaining the visible contract shape.
      caseContractV1: structuredClone(prepared.procedural.caseContractV1),
    };

    expectCompilationFinding(() => stepCompiler.compileCandidateSuite({
      testDesignPlan: prepared.plan,
      candidateScenarios: [prepared.candidate],
      proceduralFlowContract: detachedProceduralSource,
    }), 'test_design_inline_literal_resolution_incomplete');
  });

  it('requires regeneration instead of persisting a tokenized inline compatibility case', () => {
    const prepared = prepareCanonicalInlineCase('uploaded_requirement');
    expectCompilationFinding(() => stepCompiler.compileCandidateSuite({
      testDesignPlan: prepared.plan,
      candidateScenarios: [prepared.candidate],
    }), 'test_design_inline_literal_resolution_incomplete');
  });
});
