import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caseContractV1 = require('../../server/services/caseContractV1');
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');

describe('inline CaseContractV1 through immutable test design', () => {
  it('preserves authored action order and safe/env data references through compilation', () => {
    const source = `
Test Data:
email=person@example.test
password=Never-Persist-This-Secret

Steps:
1. Enter person@example.test in the Email field.
2. Click Continue.
3. Enter person@example.test in the Confirmation Email field.
4. Enter Never-Persist-This-Secret in the Password field.
5. Click Sign in.
6. Verify Home is visible.
`;
    const requirements = [{ id: 'REQ-INLINE', content: source }];
    const procedural = proceduralFlowContract.extractProceduralFlowContract(requirements);
    const contract = procedural.caseContractV1.cases[0];
    const coverageRef = `case-contract::${contract.id}`;
    const requiredActions = contract.steps.filter((step) => !/^Assert/i.test(step.type)).map((step) => step.type);
    const pack = {
      coverageRef,
      storyId: 'REQ-INLINE',
      title: contract.name,
      pageIntent: contract.intent,
      initialState: contract.initialState,
      expectedFinalState: contract.expectedFinalState,
      sessionRequirement: contract.sessionRequirement,
      requiredActions,
      requiredFields: contract.dataBindings.map((binding) => binding.name),
      semanticTokenMap: Object.fromEntries(contract.dataBindings.map((binding) => [binding.name, `{{${binding.name}}}`])),
      requiredOracle: {
        id: contract.assertions[0].id,
        kind: 'visible',
        target: 'Home',
        expected: true,
        required: true,
      },
      requiredOracles: [{
        id: contract.assertions[0].id,
        kind: 'visible',
        target: 'Home',
        expected: true,
        required: true,
      }],
      caseContractV1: contract,
    };
    const coverageManifest = {
      version: 1,
      items: [{
        manifestItemId: coverageRef,
        required: true,
        storyRef: { id: 'REQ-INLINE', title: contract.name },
        requiredActions,
        requiredOracles: pack.requiredOracles,
      }],
    };
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest,
      caseContractPacks: [pack],
      requirements,
    });
    const casePlan = plan.scenarios[0].cases[0];
    const candidatePack = { ...pack, planCaseId: casePlan.planCaseId };
    const candidate = architect.deterministicScenarioFromPack(candidatePack, 'unit_test');
    expect(candidate.cases[0].declaredAssertions[0].type).toBe('VISIBLE');
    const compiled = stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [candidate],
      proceduralFlowContract: procedural,
    }).scenarios[0].cases[0];

    expect(casePlan.actionTopology).toEqual(['Fill', 'Click', 'Fill', 'Fill', 'Click']);
    expect(casePlan.dependencies).toEqual([]);
    expect(casePlan.failurePolicy).toEqual({ default: 'continue_independent' });
    expect(casePlan.dataPlan).toMatchObject({
      mode: 'inline',
      approved: true,
      allowedTokens: ['email', 'password'],
      sensitiveDataRefs: ['data.password'],
    });
    expect(compiled.steps.map((step) => step.action)).toEqual([
      'Fill', 'Click', 'Fill', 'Fill', 'Click', 'AssertVisible',
    ]);
    expect(compiled.steps.filter((step) => JSON.stringify(step).includes('person@example.test'))).toHaveLength(2);
    expect(JSON.stringify(compiled.steps)).toContain('Never-Persist-This-Secret');
    expect(JSON.stringify(compiled.steps)).not.toContain('{{email}}');
    expect(JSON.stringify(compiled.steps)).not.toContain('{{password}}');
    expect(compiled.dependsOnIds).toEqual([]);
    expect(compiled.failurePolicy).toBe('continue_independent');
    expect(compiled.dataBinding).toMatchObject({ source: 'case_contract_v1', mode: 'inline', approved: true });
    expect(compiled.qualityContract.caseContractV1.id).toBe(contract.id);
    expect(JSON.stringify(plan)).not.toContain('Never-Persist-This-Secret');

    const reboundCandidate = structuredClone(candidate);
    const reboundSteps = reboundCandidate.cases[0].steps;
    [reboundSteps[0], reboundSteps[3]] = [reboundSteps[3], reboundSteps[0]];
    expect(() => stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [reboundCandidate],
      proceduralFlowContract: procedural,
    })).toThrowError(expect.objectContaining({
      code: stepCompiler.COMPILATION_ERROR_CODE,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'test_design_step_data_binding_drift', stepOrdinal: 1 }),
        expect.objectContaining({ code: 'test_design_step_data_binding_drift', stepOrdinal: 4 }),
      ]),
    }));

    const metadataOnlyCandidate = structuredClone(candidate);
    metadataOnlyCandidate.cases[0].steps[0].value = 'literal-not-from-the-plan';
    metadataOnlyCandidate.cases[0].steps[0].dataRefs = ['data.email'];
    expect(() => stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: [metadataOnlyCandidate],
      proceduralFlowContract: procedural,
    })).toThrowError(expect.objectContaining({
      code: stepCompiler.COMPILATION_ERROR_CODE,
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'test_design_step_data_binding_drift',
          stepOrdinal: 1,
          expectedDataRefs: ['data.email'],
          actualDataRefs: [],
        }),
      ]),
    }));
  });
});
