import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const executableTestContract = require('../../server/services/executableTestContract.js');

const COMPILED_REVISION = 'c'.repeat(64);

function caseContract({ steps = null, assertions = null } = {}) {
  return {
    version: 'CaseContractV1',
    id: 'case.order',
    initialState: { kind: 'authenticated_dashboard' },
    expectedFinalState: { kind: 'order_form_populated' },
    sessionRequirement: {
      mode: 'continue_from_case',
      predecessorCaseId: 'case.login',
      producesAuthenticatedState: false,
    },
    dataBindings: [
      { id: 'data.order_number', name: 'order_number', classification: 'normal' },
      { id: 'data.password', name: 'password', classification: 'sensitive' },
    ],
    steps: steps || [{
      id: 'step.fill-order',
      ordinal: 1,
      type: 'Fill',
      text: 'Fill Order Number with 007995145',
      dataRefs: ['data.order_number'],
      dependsOn: [],
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    }],
    assertions: assertions || [{
      id: 'assert.order-number',
      ordinal: 1,
      type: 'AssertText',
      text: 'Verify Order Number equals 007995145',
      dataRefs: ['data.order_number'],
      dependsOn: ['step.fill-order'],
      flowImpact: 'observation',
      failureBehavior: 'continue',
    }],
  };
}

function testCase(overrides = {}) {
  const contract = overrides.caseContractV1 || caseContract();
  const qualityContractJson = JSON.stringify({
    caseContractV1: contract,
    testDesignPlan: {
      version: 'TestDesignPlanV1',
      planId: 'plan-add-scenario',
      revision: 'plan-revision',
      planCaseId: 'case.order',
      caseRevision: 'authored-case-revision',
      compiledCaseRevision: COMPILED_REVISION,
    },
  });
  return {
    id: 'tc-order',
    name: 'Continue order creation',
    generationId: 'generation-5',
    compiledCaseRevision: COMPILED_REVISION,
    sessionMode: 'continue_from_dependency',
    dependsOnIds: JSON.stringify(['tc-login']),
    steps: JSON.stringify([{ id: 'step.fill-order', action: 'Fill', element: 'Order Number', value: '007995145' }]),
    declaredAssertions: JSON.stringify([{
      id: 'assert.order-number',
      type: 'AssertText',
      expectedText: '007995145',
      description: 'Verify Order Number equals 007995145',
    }]),
    qualityContractJson,
    ...overrides,
    caseContractV1: undefined,
  };
}

describe('Add Scenario execution authority', () => {
  it('preserves immutable revision, runtime session mode, IDs, bindings, and dependencies without leaking sensitive row data', () => {
    const contract = executableTestContract.buildExecutionContract({
      testCase: testCase(),
      dataRow: {
        rowId: 'inline-row-1',
        index: 0,
        fields: { order_number: '007995145', password: 'Raw-Secret-Must-Not-Escape' },
        publicBindings: {
          order_number: { kind: 'inline', value: '007995145' },
          password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD' },
        },
      },
      runId: 'run-5',
    });

    expect(contract.revision).toBe(COMPILED_REVISION);
    expect(contract.caseInstanceV1.caseRevision).toBe(COMPILED_REVISION);
    expect(contract.caseInstanceV1.sessionPlan).toEqual(expect.objectContaining({
      mode: 'continue_from_dependency',
      authoredMode: 'continue_from_case',
      predecessorCaseRefs: ['case.login'],
      predecessorCaseIds: ['tc-login'],
    }));
    expect(contract.nodes[0]).toMatchObject({
      persistedStepId: 'step.fill-order',
      caseContractStepId: 'step.fill-order',
      dataRefs: ['data.order_number'],
      dependencies: [],
      failureBehavior: 'stop_descendants',
    });
    expect(contract.nodes[1]).toMatchObject({
      persistedAssertionId: 'assert.order-number',
      caseContractStepId: 'assert.order-number',
      dataRefs: ['data.order_number'],
      dependencies: ['step.fill-order'],
      failureBehavior: 'continue',
    });
    expect(JSON.stringify(contract)).not.toContain('Raw-Secret-Must-Not-Escape');
  });

  it('fails closed when persisted step order drifts from the immutable CaseContract', () => {
    const immutable = caseContract({
      steps: [
        { id: 'step.first', type: 'Fill', text: 'Fill first', dependsOn: [] },
        { id: 'step.second', type: 'Click', text: 'Click second', dependsOn: ['step.first'] },
      ],
      assertions: [],
    });
    const row = testCase({
      caseContractV1: immutable,
      steps: JSON.stringify([
        { id: 'step.second', action: 'Click', element: 'Second' },
        { id: 'step.first', action: 'Fill', element: 'First', value: 'value' },
      ]),
      declaredAssertions: '[]',
    });

    expect(() => executableTestContract.buildExecutionContract({ testCase: row }))
      .toThrow(expect.objectContaining({ code: 'EXECUTION_CONTRACT_ORDER_DRIFT' }));
  });

  it('fails closed when a persisted node identity is absent from the immutable CaseContract', () => {
    const row = testCase({
      steps: JSON.stringify([{ id: 'step.unapproved', action: 'Fill', element: 'Order Number', value: '007995145' }]),
    });

    expect(() => executableTestContract.buildExecutionContract({ testCase: row }))
      .toThrow(expect.objectContaining({ code: 'EXECUTION_CONTRACT_IDENTITY_DRIFT' }));
  });
});
