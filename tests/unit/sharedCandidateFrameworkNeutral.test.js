'use strict';

const {
  normalizeCandidates,
} = require('../../server/services/codegen/adapters/_candidateNormalize');
const {
  compileReplayIR,
  validateReplayIR,
} = require('../../server/services/codegen/adapters/frameworkAdapter');

function fakeAdapter(observed) {
  return {
    id: 'neutral-test-adapter',
    emitSetup: () => '// setup',
    emitAuth: () => '// auth',
    emitLocatorResolver: () => '',
    emitStep: (step) => {
      observed.act = step;
      return `ACT:${step.stepId}`;
    },
    emitWait: (condition, step) => `WAIT:${step.stepId}:${condition || ''}`,
    emitPopupHandling: (known, step) => `POPUP:${step.stepId}:${known.length}`,
    emitAssertion: (step) => {
      observed.assertion = step;
      return `ASSERT:${step.stepId}`;
    },
    emitDataProvider: () => '// data',
    emitRetryPolicy: () => '// retry',
    emitHumanInput: (disposition, step) => {
      observed.unsupported.push(step);
      return `UNSUPPORTED:${step.stepId || 'none'}:${step.unsupportedOperation || disposition}`;
    },
    emitTeardown: () => '// teardown',
    fileLayout: () => ({ testFile: 'tests/neutral.spec.js' }),
    compileCmd: () => 'node --check tests/neutral.spec.js',
    runCmd: () => 'node tests/neutral.spec.js',
    validatePackage: () => ({ valid: true, findings: [] }),
    regressionCorpus: [],
  };
}

describe('shared candidate normalization', () => {
  it('preserves exact evidence and unverified candidates while localizing warnings', () => {
    const provenance = { source: 'live_dom', captureId: 'capture-a' };
    const contextEvidence = { pageAlias: 'primary', framePath: ['frame-a'] };
    const candidates = normalizeCandidates([
      {
        strategy: 'css',
        selector: 'getByRole("button", { name: "Continue" })',
        verificationStatus: 'unverified',
        provenance,
        contextEvidence,
        frameworkExpressions: { playwright: 'page.getByRole("button", { name: "Continue" })' },
      },
      {
        strategy: 'text',
        text: 'profile menu inside header',
        verificationStatus: 'unverified',
        provenance: { source: 'llm_candidate' },
      },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      strategy: 'role',
      role: 'button',
      name: 'Continue',
      selector: 'getByRole("button", { name: "Continue" })',
      verificationStatus: 'unverified',
      provenance,
      contextEvidence,
    });
    expect(candidates[0].frameworkExpressions.playwright).toContain('getByRole');
    expect(candidates[0].normalizationMetadata.evidencePreserved).toBe(true);
    expect(candidates[1].warningMetadata).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'descriptive_text_candidate', nonBlocking: true, localized: true }),
    ]));
  });

  it('retains uncorroborated role evidence instead of deleting it', () => {
    const candidates = normalizeCandidates([
      { strategy: 'role', role: 'textbox', name: 'RuntimeValue90210', provenance: { source: 'candidate' } },
      { strategy: 'role', role: 'textbox', name: 'Account', provenance: { source: 'verified' } },
      { strategy: 'placeholder', text: 'Account', provenance: { source: 'verified' } },
    ]);

    expect(candidates).toHaveLength(3);
    expect(candidates.find((candidate) => candidate.name === 'RuntimeValue90210')).toMatchObject({
      provenance: { source: 'candidate' },
      warningMetadata: expect.arrayContaining([
        expect.objectContaining({ code: 'uncorroborated_accessible_name' }),
      ]),
    });
  });
});

describe('shared framework lowering', () => {
  it('retains authored order, typed bindings, and unknown operations without promoting observed transitions', () => {
    const valueBinding = { kind: 'workbook_column', sheet: 'Rows', column: 'Account' };
    const expectedBinding = { kind: 'runtime_output', output: 'visibleCount' };
    const bindingMetadata = { proof: 'uploaded_workbook', sourceId: 'source-a' };
    const observedTransition = { authored: false, from: 'primary', to: 'popup-a', source: 'observed' };
    const ir = {
      caseId: 'case-a',
      authProfile: null,
      steps: [
        { op: 'resolve', stepId: 'step-resolve', contractStepId: 'contract-resolve', candidates: [] },
        { op: 'act', stepId: 'step-act', contractStepId: 'contract-act', action: 'fill', valueBinding, bindingMetadata },
        { op: 'future_operation', stepId: 'step-future', contractStepId: 'contract-future', sourceContractStepId: 'source-future' },
        { op: 'assert', stepId: 'step-assert', contractStepId: 'contract-assert', contractRef: 'oracle-a', channel: 'UI_TEXT', expectedBinding, bindingMetadata },
      ],
      contextTransitions: [observedTransition],
      verdict: { status: 'pass' },
    };
    const observed = { unsupported: [] };
    const result = compileReplayIR(fakeAdapter(observed), ir);

    expect(result.authoredStepCount).toBe(4);
    expect(result.authoredSteps.map((step) => step.stepId)).toEqual([
      'step-resolve',
      'step-act',
      'step-future',
      'step-assert',
    ]);
    expect(result.authoredSteps.map((step) => step.contractStepId)).toEqual([
      'contract-resolve',
      'contract-act',
      'contract-future',
      'contract-assert',
    ]);
    expect(observed.act.valueBinding).toBe(valueBinding);
    expect(observed.act.bindingMetadata).toBe(bindingMetadata);
    expect(observed.assertion.expectedBinding).toBe(expectedBinding);
    expect(observed.assertion.bindingMetadata).toBe(bindingMetadata);
    expect(observed.unsupported.map((step) => step.stepId)).toEqual(['step-resolve', 'step-future']);
    expect(observed.unsupported[1]).toMatchObject({
      unsupportedOperation: 'future_operation',
      authoredOperationContract: expect.objectContaining({
        authoredIndex: 2,
        sourceContractStepId: 'source-future',
        authored: true,
      }),
    });
    expect(result.files['tests/neutral.spec.js']).toContain('UNSUPPORTED:step-future:future_operation');
    expect(ir.contextTransitions).toEqual([observedTransition]);
    expect(result.authoredSteps).toHaveLength(ir.steps.length);
  });

  it('reports missing auth and unknown operations diagnostically instead of invalidating export', () => {
    const check = validateReplayIR({
      caseId: 'case-b',
      steps: [{ op: 'future_operation', stepId: 'step-a' }],
      verdict: { status: 'pass' },
    });

    expect(check.valid).toBe(true);
    expect(check.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'replayir_auth_profile_missing', severity: 'warn' }),
      expect.objectContaining({ rule: 'replayir_step_unknown_op', severity: 'warn' }),
    ]));
  });
});
