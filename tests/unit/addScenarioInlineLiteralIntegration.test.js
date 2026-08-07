import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const appendScenarioRequest = require('../../server/services/appendScenarioRequest');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const planningBridge = require('../../server/services/caseContractPlanningBridge');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');
const canonicalGenerationPipeline = require('../../server/services/canonicalGenerationPipeline');

const EMAIL = 'append.user@example.test';
const PASSWORD = 'Append-Inline-Credential-7!';
const EXPECTED_BANNER = 'Ready for review';
const APPEND_ROWS = [
  ['append.first@example.test', 'Append-First-Secret-1!', 'Append first ready'],
  ['append.second@example.test', 'Append-Second-Secret-2!', 'Append second ready'],
];

function appendPayload() {
  return {
    appendToCurrent: true,
    sessionGuidance: `
Inline test data:
Email Address: ${EMAIL}
Password: ${PASSWORD}
Expected Banner: ${EXPECTED_BANNER}

Test Case: Open the assigned work queue
Test steps:
1. Enter ${EMAIL} in the Email Address field.
2. Enter ${PASSWORD} in the Password field.
3. Verify ${EXPECTED_BANNER} is visible.

Final validation:
Verify ${EXPECTED_BANNER} is visible.
`,
  };
}

function multiRowAppendPayload() {
  return {
    appendToCurrent: true,
    sessionGuidance: `
Inline test data:
| Email Address | Password | Expected Banner |
| --- | --- | --- |
| ${APPEND_ROWS[0][0]} | ${APPEND_ROWS[0][1]} | ${APPEND_ROWS[0][2]} |
| ${APPEND_ROWS[1][0]} | ${APPEND_ROWS[1][1]} | ${APPEND_ROWS[1][2]} |

Test Case: Open the assigned work queue for each appended row
Test steps:
1. Enter Email Address in the Email Address field.
2. Enter Password in the Password field.
3. Verify Expected Banner is visible.
`,
  };
}

function executableProjection(value) {
  return JSON.stringify({
    assertions: value.assertions,
    steps: value.steps,
    declaredAssertions: value.declaredAssertions,
    oracles: value.oracles,
  });
}

describe('Add Scenario inline literal route-to-persistence integration', () => {
  it('turns appendToCurrent + sessionGuidance into add_scenario authority and stores authored literals', async () => {
    const project = { id: 'project-append-inline' };
    const request = appendScenarioRequest.buildAppendScenarioRequest(project, appendPayload());

    expect(request).toMatchObject({
      appendToCurrent: true,
      requirement: {
        projectId: project.id,
        source: 'add_scenario',
        sourceType: 'USER_STORY',
      },
      requirementClause: {
        source: 'add_scenario',
        sourceType: 'USER_STORY',
        testable: true,
        verified: true,
      },
    });
    expect(request.requirement.content).toBe(appendPayload().sessionGuidance.trim());

    const procedural = proceduralFlowContract.extractProceduralFlowContract([request.requirement]);
    expect(procedural.isProcedural).toBe(true);
    expect(procedural.caseContractV1.source.requirementIds).toContain(request.requirement.id);

    const bridged = planningBridge.buildCaseContractPlanningBridge({
      proceduralFlowContract: procedural,
      coverageManifest: { version: 1, items: [] },
      caseContractPacks: [],
    });
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: bridged.coverageManifest,
      caseContractPacks: bridged.caseContractPacks,
      requirements: [request.requirement],
      requirementClauses: [request.requirementClause],
    });
    const casePlan = plan.scenarios[0].cases[0];
    const candidate = architect.deterministicScenarioFromPack({
      ...bridged.caseContractPacks[0],
      planCaseId: casePlan.planCaseId,
    }, 'add_scenario_inline_literal_integration');
    const compiled = stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [candidate],
      proceduralFlowContract: procedural,
    }).scenarios[0].cases[0];

    const compiledText = executableProjection(compiled);
    expect(compiled.steps[0].value).toBe(EMAIL);
    expect(compiled.steps[1].value).toBe(PASSWORD);
    expect(compiledText).toContain(EXPECTED_BANNER);
    expect(compiledText).not.toMatch(/\{\{[^}]+\}\}/);

    const created = [];
    const log = { info: vi.fn(), warn: vi.fn() };
    const prisma = {
      scenarioGeneration: {
        findUnique: async () => ({
          id: 'generation-current',
          coveragePlanJson: JSON.stringify({ testDesignPlanV1: plan }),
        }),
      },
      requirementClause: { findMany: async () => [] },
      testCase: {
        create: async ({ data }) => {
          created.push(data);
          return { id: 'case-persisted', ...data };
        },
        update: async () => ({}),
      },
    };
    await canonicalGenerationPipeline.persistCases({
      prisma,
      projectId: project.id,
      scenarioId: 'scenario-appended',
      generationId: 'generation-current',
      moduleName: compiled.module,
      cases: [compiled],
      log,
    });

    expect(created).toHaveLength(1);
    const stored = created[0];
    const storedSteps = JSON.parse(stored.steps);
    const storedAssertions = JSON.parse(stored.declaredAssertions);
    expect(storedSteps[0].value).toBe(EMAIL);
    expect(storedSteps[1].value).toBe(PASSWORD);
    expect(stored.assertions).toContain(EXPECTED_BANNER);
    expect(JSON.stringify(storedAssertions)).toContain(EXPECTED_BANNER);
    expect(JSON.stringify({ storedSteps, storedAssertions, assertions: stored.assertions }))
      .not.toMatch(/\{\{[^}]+\}\}/);
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(PASSWORD);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(PASSWORD);
  });

  it('keeps Add Scenario multi-row text as one case with exact literal row instances', () => {
    const project = { id: 'project-append-inline-rows' };
    const request = appendScenarioRequest.buildAppendScenarioRequest(project, multiRowAppendPayload());
    const procedural = proceduralFlowContract.extractProceduralFlowContract([request.requirement]);
    const bridged = planningBridge.buildCaseContractPlanningBridge({
      proceduralFlowContract: procedural,
      coverageManifest: { version: 1, items: [] },
      caseContractPacks: [],
    });
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: bridged.coverageManifest,
      caseContractPacks: bridged.caseContractPacks,
      requirements: [request.requirement],
      requirementClauses: [request.requirementClause],
    });
    const casePlan = plan.scenarios[0].cases[0];
    const candidate = architect.deterministicScenarioFromPack({
      ...bridged.caseContractPacks[0],
      planCaseId: casePlan.planCaseId,
    }, 'add_scenario_inline_rows');
    expect(candidate.cases[0].steps[2]).toMatchObject({
      dataRefs: ['data.expected_banner'],
      expected: '{{expected_banner}}',
      target: '{{expected_banner}}',
      element: '{{expected_banner}}',
      verify: { kind: 'visible', element: { name: '{{expected_banner}}' } },
    });
    const compiledSuite = stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [candidate],
      proceduralFlowContract: procedural,
    });

    expect(compiledSuite.cases).toHaveLength(1);
    const compiled = compiledSuite.cases[0];
    expect(compiled.rowExecutionPlan).toMatchObject({
      mode: 'inline',
      executionMode: 'per_row',
      rowIds: ['row-001', 'row-002'],
    });
    expect(compiled.rowExecutionPlan.instances).toHaveLength(2);
    compiled.rowExecutionPlan.instances.forEach((instance, index) => {
      const [email, password, banner] = APPEND_ROWS[index];
      expect(instance.inputs).toMatchObject({ email, password, expected_banner: banner });
      expect(instance.executableProjection.steps[0].value).toBe(email);
      expect(instance.executableProjection.steps[1].value).toBe(password);
      expect(instance.executableProjection.steps[2].expected).toBe(banner);
      expect(instance.executableProjection.steps[2]).toMatchObject({
        verify: { kind: 'visible', element: { name: banner } },
      });
      expect(instance.executableProjection.declaredAssertions.some((assertion) => (
        assertion && (assertion.target === banner || assertion.element === banner)
      ))).toBe(true);
      expect(JSON.stringify(instance.executableProjection)).not.toMatch(/\{\{[^}]+\}\}/);
    });
  });

  it('does not replace an explicit visibility target with its singular data binding', () => {
    const candidate = architect.deterministicScenarioFromPack({
      coverageRef: 'explicit-visibility-target',
      caseContractV1: {
        id: 'case.explicit-visibility-target',
        name: 'Explicit visibility target',
        steps: [{
          id: 'step.explicit-visibility-target',
          ordinal: 1,
          type: 'AssertVisible',
          text: 'Verify Expected Banner is visible.',
          targetIdentity: { kind: 'control', label: 'Status banner', role: 'status', scope: 'Work queue' },
          dataRefs: ['data.expected_banner'],
          dependsOn: [],
        }],
      },
    }, 'explicit_visibility_target');
    expect(candidate.cases[0].steps[0]).toMatchObject({
      target: 'Status banner',
      element: 'Status banner',
      dataRefs: ['data.expected_banner'],
    });
    expect(candidate.cases[0].steps[0].verify.element.name).toBe('Status banner');
  });

  it('does not guess a row-bound visibility target when multiple data references are present', () => {
    const candidate = architect.deterministicScenarioFromPack({
      coverageRef: 'ambiguous-visibility-target',
      caseContractV1: {
        id: 'case.ambiguous-visibility-target',
        name: 'Ambiguous visibility target',
        steps: [{
          id: 'step.ambiguous-visibility-target',
          ordinal: 1,
          type: 'AssertVisible',
          text: 'Verify the expected status is visible.',
          dataRefs: ['data.expected_banner', 'data.expected_status'],
          dependsOn: [],
        }],
      },
    }, 'ambiguous_visibility_target');
    expect(candidate.cases[0].steps[0].dataRefs).toEqual(['data.expected_banner', 'data.expected_status']);
    expect(candidate.cases[0].steps[0].target).not.toMatch(/\{\{/);
    expect(candidate.cases[0].steps[0].element).not.toMatch(/\{\{/);
    expect(candidate.cases[0].steps[0].verify.element.name).not.toMatch(/\{\{/);
  });

  it('keeps the HTTP route pinned to the tested pure append payload boundary', () => {
    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), 'server/routes/scenarios.js'),
      'utf8',
    );
    expect(routeSource).toContain("require('../services/appendScenarioRequest')");
    expect(routeSource).toContain('const requestBody = req.body || {}');
    expect(routeSource).toContain('buildAppendScenarioRequest(project, requestBody)');
    expect(routeSource).toContain('const appendToCurrent = appendRequest.appendToCurrent');
    expect(routeSource).toContain('const appendDesignRequirement = appendRequest.requirement');
  });

  it('does not reinterpret sessionGuidance as Add Scenario without boolean appendToCurrent=true', () => {
    const guidance = appendPayload().sessionGuidance;
    expect(appendScenarioRequest.buildAppendScenarioRequest(
      { id: 'project-fresh' },
      { appendToCurrent: false, sessionGuidance: guidance },
    )).toMatchObject({
      appendToCurrent: false,
      sessionGuidance: guidance.trim(),
      requirement: null,
      requirementClause: null,
    });
  });

  it('uses an opaque SHA-256 requirement ID that does not disclose inline text or credentials', () => {
    const request = appendScenarioRequest.buildAppendScenarioRequest(
      { id: 'project-opaque-id' },
      appendPayload(),
    );

    expect(request.requirement.id)
      .toMatch(/^append-design:project-opaque-id:sha256-[a-f0-9]{64}$/);
    expect(request.requirement.id).not.toContain(PASSWORD);
    expect(request.requirement.id).not.toContain('inline-test-data');
    expect(request.requirement.id).not.toContain('append-user-example-test');
  });

  it('gives same-prefix append texts different IDs based on the complete content', () => {
    const sharedPrefix = [
      'Test Case: Same title and deliberately identical prefix',
      'Test steps:',
      '1. Open the assigned queue.',
    ].join('\n');
    const first = appendScenarioRequest.buildAppendDesignRequirement(
      { id: 'project-digest' },
      `${sharedPrefix}\n2. Verify First outcome is visible.`,
    );
    const second = appendScenarioRequest.buildAppendDesignRequirement(
      { id: 'project-digest' },
      `${sharedPrefix}\n2. Verify Second outcome is visible.`,
    );

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/:sha256-[a-f0-9]{64}$/);
    expect(second.id).toMatch(/:sha256-[a-f0-9]{64}$/);
  });
});
