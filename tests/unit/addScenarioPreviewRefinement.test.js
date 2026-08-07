import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildAddScenarioPreview } = require('../../server/services/addScenarioPreview');
const {
  REFINEMENT_VERSION,
  RESULT_STATUS,
  refineAddScenarioPreview,
} = require('../../server/services/addScenarioPreviewRefinement');

const PROJECT_ID = 'project-1';
const GENERATION_ID = 'generation-5';
const SOURCE = [
  'Continue from the authenticated dashboard.',
  'Fill Order Number with 007995145.',
  'Verify Order Number equals 007995145.',
  'Fill Pickup Number with 7995145776.',
  'Verify Pickup Number equals 7995145776.',
].join('\n');

function span(quote) {
  const start = SOURCE.indexOf(quote);
  return { start, end: start + quote.length };
}

function target(label) {
  return { kind: 'field', label, role: 'textbox', scope: 'order form' };
}

function expectedPayload(value) {
  return {
    channel: 'text',
    operands: [
      { role: 'actual', kind: 'target_property', property: 'text' },
      { role: 'expected', kind: 'literal', value },
    ],
  };
}

function atomicOrderReplacement() {
  return [
    {
      kind: 'action',
      type: 'Click',
      text: 'Open the Order Number choices.',
      targetIdentity: { kind: 'control', label: 'Order Number', role: 'combobox', scope: 'order form' },
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    },
    {
      kind: 'action',
      type: 'Select',
      text: 'Select 007995145 from the Order Number choices.',
      targetIdentity: { kind: 'collection', label: 'Order Number choices', role: 'listbox', scope: 'order form' },
      selectionCriteria: { kind: 'exact_text', text: '007995145' },
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    },
    {
      kind: 'assertion',
      type: 'AssertText',
      text: 'Verify Order Number equals 007995145.',
      targetIdentity: target('Order Number'),
      comparator: 'equals',
      payload: expectedPayload('007995145'),
      required: true,
      failureBehavior: 'continue_independent',
    },
  ];
}

function semanticPlan() {
  const continuation = 'Continue from the authenticated dashboard.';
  const orderAction = 'Fill Order Number with 007995145.';
  const orderAssertion = 'Verify Order Number equals 007995145.';
  const pickupAction = 'Fill Pickup Number with 7995145776.';
  const pickupAssertion = 'Verify Pickup Number equals 7995145776.';
  return {
    semanticIntentPlanV1: {
      version: 'SemanticIntentPlanV1',
      cases: [{ key: 'order-case', actions: [], assertions: [] }],
    },
    sourceCompleteness: { complete: true, findings: [] },
    caseContractV1: {
      version: 'CaseContractV1',
      sourceClauses: [
        { id: 'source.1', ordinal: 1, disposition: 'metadata', sourceQuote: continuation, sourceSpan: span(continuation) },
        { id: 'source.2', ordinal: 2, disposition: 'action', sourceQuote: orderAction, sourceSpan: span(orderAction) },
        { id: 'source.3', ordinal: 3, disposition: 'assertion', sourceQuote: orderAssertion, sourceSpan: span(orderAssertion) },
        { id: 'source.4', ordinal: 4, disposition: 'action', sourceQuote: pickupAction, sourceSpan: span(pickupAction) },
        { id: 'source.5', ordinal: 5, disposition: 'assertion', sourceQuote: pickupAssertion, sourceSpan: span(pickupAssertion) },
      ],
      sourceCoverage: [
        { sourceRef: 'source.1', disposition: 'session' },
        { sourceRef: 'source.2', disposition: 'action', operationId: 'step.order' },
        { sourceRef: 'source.3', disposition: 'assertion', operationId: 'assert.order' },
        { sourceRef: 'source.4', disposition: 'action', operationId: 'step.pickup' },
        { sourceRef: 'source.5', disposition: 'assertion', operationId: 'assert.pickup' },
      ],
      cases: [{
        id: 'case.order',
        name: 'Continue order creation',
        intent: 'Continue the authenticated order flow.',
        sourceQuote: SOURCE,
        sourceSpan: { start: 0, end: SOURCE.length },
        initialState: { kind: 'authenticated_dashboard', sourceClauseRefs: ['source.1'] },
        expectedFinalState: { kind: 'order_form_populated', sourceClauseRefs: ['source.5'] },
        sessionRequirement: {
          mode: 'continue_from_case',
          predecessorCaseId: 'case.login',
          dependsOnCaseRefs: ['case.login'],
          sourceClauseRefs: ['source.1'],
        },
        dependencies: ['case.login'],
        failurePolicy: {
          default: 'stop_descendants',
          onActionFailure: 'stop_descendants',
          onAssertionFailure: 'continue_independent',
          sourceClauseRefs: ['source.1'],
        },
        steps: [{
          id: 'step.order',
          ordinal: 1,
          type: 'Fill',
          text: orderAction,
          targetIdentity: target('Order Number'),
          value: '007995145',
          sourceQuote: orderAction,
          sourceSpan: span(orderAction),
          sourceClauseRefs: ['source.2'],
          dependsOn: [],
          dataRefs: [],
          flowImpact: 'state_change',
          failureBehavior: 'stop_descendants',
        }, {
          id: 'step.pickup',
          ordinal: 2,
          type: 'Fill',
          text: pickupAction,
          targetIdentity: target('Pickup Number'),
          value: '7995145776',
          sourceQuote: pickupAction,
          sourceSpan: span(pickupAction),
          sourceClauseRefs: ['source.4'],
          dependsOn: ['step.order'],
          dataRefs: [],
          flowImpact: 'state_change',
          failureBehavior: 'stop_descendants',
        }],
        assertions: [{
          id: 'assert.order',
          ordinal: 1,
          type: 'AssertText',
          text: orderAssertion,
          targetIdentity: target('Order Number'),
          comparator: 'equals',
          payload: expectedPayload('007995145'),
          sourceQuote: orderAssertion,
          sourceSpan: span(orderAssertion),
          sourceClauseRefs: ['source.3'],
          dataRefs: [],
          stepId: 'step.order',
          required: true,
          failureBehavior: 'continue_independent',
        }, {
          id: 'assert.pickup',
          ordinal: 2,
          type: 'AssertText',
          text: pickupAssertion,
          targetIdentity: target('Pickup Number'),
          comparator: 'equals',
          payload: expectedPayload('7995145776'),
          sourceQuote: pickupAssertion,
          sourceSpan: span(pickupAssertion),
          sourceClauseRefs: ['source.5'],
          dataRefs: [],
          stepId: 'step.pickup',
          required: true,
          failureBehavior: 'continue_independent',
        }],
      }],
    },
  };
}

function authority(plan = semanticPlan()) {
  const preview = buildAddScenarioPreview({
    projectId: PROJECT_ID,
    currentGenerationId: GENERATION_ID,
    sourceText: SOURCE,
    semanticPlan: plan,
  });
  return { plan, preview };
}

function refine({ plan, preview }, guidance, overrides = {}) {
  return refineAddScenarioPreview({
    projectId: PROJECT_ID,
    preview,
    semanticPlan: plan,
    baseRevision: preview.revision,
    sourceDigest: preview.source.digest,
    guidance,
    refinementSourceText: guidance.sourceText || guidance.summary,
    ...overrides,
  });
}

describe('addScenarioPreviewRefinement', () => {
  it('refines one stable operation ID and preserves every unaffected authority', () => {
    const current = authority();
    const result = refine(current, {
      summary: 'In the Pickup Number step, replace 7995145776 with 7995145888.',
      operations: [{
        selector: { operationId: 'step.pickup' },
        changes: { value: '7995145888' },
      }],
    });
    const originalCase = current.plan.caseContractV1.cases[0];
    const refinedCase = result.semanticPlan.caseContractV1.cases[0];

    expect(result.version).toBe(REFINEMENT_VERSION);
    expect(result.status).toBe(RESULT_STATUS.APPLIED);
    expect(result.applied).toBe(true);
    expect(result.previewId).toBe(current.preview.previewId);
    expect(result.baseRevision).toBe(current.preview.revision);
    expect(result.revision).not.toBe(current.preview.revision);
    expect(result.persistence).toEqual({
      status: 'not_persisted',
      currentGenerationId: GENERATION_ID,
      scenarioCountCreated: 0,
      caseCountCreated: 0,
    });
    expect(refinedCase.steps.map((step) => [step.id, step.ordinal]))
      .toEqual(originalCase.steps.map((step) => [step.id, step.ordinal]));
    expect(refinedCase.assertions).toEqual(originalCase.assertions);
    expect(refinedCase.steps[0]).toEqual(originalCase.steps[0]);
    expect(refinedCase.steps[1]).toEqual(expect.objectContaining({
      id: originalCase.steps[1].id,
      value: '7995145888',
      sourceQuote: 'In the Pickup Number step, replace 7995145776 with 7995145888.',
    }));
    expect(refinedCase.sessionRequirement).toEqual(expect.objectContaining({
      mode: originalCase.sessionRequirement.mode,
      predecessorCaseId: originalCase.sessionRequirement.predecessorCaseId,
      dependsOnCaseRefs: originalCase.sessionRequirement.dependsOnCaseRefs,
      sourceClauseRefs: originalCase.sessionRequirement.sourceClauseRefs,
    }));
    expect(refinedCase.dependencies).toEqual(originalCase.dependencies);
    expect(result.semanticPlan.caseContractV1.sourceCoverage)
      .toEqual(current.plan.caseContractV1.sourceCoverage);
    expect(result.semanticPlan.sourceCompleteness).toEqual(current.plan.sourceCompleteness);
    expect(current.plan.caseContractV1.cases[0].steps[1].value).toBe('7995145776');
    expect(result.preview.scenarios[0].cases[0].inlineLiterals)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ recordId: 'step.order', value: '007995145' }),
        expect.objectContaining({ recordId: 'step.pickup', value: '7995145888' }),
      ]));
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('produces the same content-addressed revision for the same base and guidance', () => {
    const current = authority();
    const guidance = {
      summary: 'Change the Pickup Number assertion to verify exactly 7995145888.',
      operations: [{
        selector: { caseId: 'case.order', kind: 'assertion', ordinal: 2 },
        changes: {
          text: 'Verify Pickup Number equals 7995145888.',
          payload: expectedPayload('7995145888'),
        },
      }],
    };

    const first = refine(current, guidance);
    const second = refine(current, guidance);

    expect(first).toEqual(second);
    expect(first.revision).toBe(second.revision);
    expect(first.appliedOperations).toEqual([{
      operationId: 'assert.pickup',
      caseId: 'case.order',
      kind: 'assertion',
      ordinal: 2,
      changedFields: ['payload', 'text'],
    }]);
  });

  it('can uniquely refine by exact semantic target when kind and case scope disambiguate it', () => {
    const current = authority();
    const result = refine(current, {
      summary: 'Rename the Pickup Number target to Pickup Reference Number.',
      operations: [{
        selector: {
          caseId: 'case.order',
          kind: 'action',
          semanticTarget: { label: 'Pickup Number', role: 'textbox' },
        },
        changes: {
          targetIdentity: target('Pickup Reference Number'),
        },
      }],
    });

    expect(result.applied).toBe(true);
    expect(result.semanticPlan.caseContractV1.cases[0].steps[1].targetIdentity.label)
      .toBe('Pickup Reference Number');
    expect(result.semanticPlan.caseContractV1.cases[0].steps[1].id).toBe('step.pickup');
  });

  it('rejects a stale revision as a reviewable clarification without changing content', () => {
    const current = authority();
    const result = refine(current, {
      operations: [{ selector: { operationId: 'step.pickup' }, changes: { value: '7995145888' } }],
    }, { baseRevision: 'sha256-stale' });

    expect(result.status).toBe(RESULT_STATUS.NEEDS_REVIEW);
    expect(result.applied).toBe(false);
    expect(result.revision).toBe(current.preview.revision);
    expect(result.preview).toEqual(current.preview);
    expect(result.semanticPlan).toEqual(current.plan);
    expect(result.persistence.status).toBe('not_persisted');
    expect(result.clarifications).toEqual([
      expect.objectContaining({ code: 'refinement_revision_stale', blocking: true }),
    ]);
  });

  it('rejects an ambiguous semantic target with stable candidate choices', () => {
    const current = authority();
    const result = refine(current, {
      operations: [{
        selector: { semanticTarget: 'Pickup Number' },
        changes: { text: 'Use the reviewed pickup number.' },
      }],
    });

    expect(result.status).toBe(RESULT_STATUS.NEEDS_REVIEW);
    expect(result.applied).toBe(false);
    expect(result.clarifications[0]).toEqual(expect.objectContaining({
      code: 'refinement_target_ambiguous',
      blocking: true,
    }));
    expect(result.clarifications[0].candidates.map((candidate) => candidate.operationId))
      .toEqual(['step.pickup', 'assert.pickup']);
    expect(result.revision).toBe(current.preview.revision);
  });

  it('protects identity and ordering fields from refinement', () => {
    const current = authority();
    const result = refine(current, {
      operations: [{
        selector: { operationId: 'step.pickup' },
        changes: { ordinal: 9 },
      }],
    });

    expect(result.applied).toBe(false);
    expect(result.clarifications[0].code).toBe('refinement_identity_protected');
    expect(result.semanticPlan).toEqual(current.plan);
  });

  it('replaces one compound operation with three atomic operations deterministically and remaps dependencies', () => {
    const current = authority();
    const sourceText = 'Replace the Order Number step with three operations: open Order Number choices, select 007995145, and verify Order Number equals 007995145.';
    const guidance = {
      summary: sourceText,
      sourceText,
      operations: [{
        selector: { operationId: 'step.order' },
        replaceWith: atomicOrderReplacement(),
      }],
    };

    const first = refine(current, guidance);
    const second = refine(current, guidance);
    const refinedCase = first.semanticPlan.caseContractV1.cases[0];
    const replacement = first.appliedOperations[0].replacementOperationIds;

    expect(first.status).toBe(RESULT_STATUS.APPLIED);
    expect(first).toEqual(second);
    expect(replacement).toHaveLength(3);
    expect(refinedCase.steps.map((record) => record.id)).toEqual([
      replacement[0],
      replacement[1],
      'step.pickup',
    ]);
    expect(refinedCase.assertions.map((record) => record.id)).toEqual([
      replacement[2],
      'assert.order',
      'assert.pickup',
    ]);
    expect(refinedCase.steps[1].dependsOn).toEqual([replacement[0]]);
    expect(refinedCase.steps[2].dependsOn).toEqual([replacement[1]]);
    expect(refinedCase.assertions.find((record) => record.id === 'assert.order').stepId).toBe(replacement[1]);
    expect(refinedCase.assertions.find((record) => record.id === replacement[2]).stepId).toBe(replacement[1]);
    expect(first.semanticPlan.caseContractV1.refinementLedger[0].sourceText).toBe(sourceText);
    expect(first.semanticPlan.authoritativeSourceText.endsWith(sourceText)).toBe(true);
    expect(first.preview.source.effectiveText.endsWith(sourceText)).toBe(true);
    expect(first.preview.approvalEligible).toBe(true);
  });

  it('replaces one contiguous action/assertion range while preserving unaffected operation identities and order', () => {
    const current = authority();
    const sourceText = 'Replace the Order Number action and its assertion with an atomic fill and an exact verification for 007995145.';
    const replacements = [
      {
        kind: 'action', type: 'Fill', text: 'Fill Order Number with 007995145.',
        targetIdentity: target('Order Number'), value: '007995145',
        flowImpact: 'state_change', failureBehavior: 'stop_descendants',
      },
      {
        kind: 'assertion', type: 'AssertText', text: 'Verify Order Number equals 007995145.',
        targetIdentity: target('Order Number'), comparator: 'equals', payload: expectedPayload('007995145'),
        required: true, failureBehavior: 'continue_independent',
      },
    ];
    const result = refine(current, {
      summary: sourceText,
      sourceText,
      operations: [{
        range: {
          start: { operationId: 'step.order' },
          end: { operationId: 'assert.order' },
        },
        replaceWith: replacements,
      }],
    });
    const refinedCase = result.semanticPlan.caseContractV1.cases[0];
    const newIds = result.appliedOperations[0].replacementOperationIds;

    expect(result.status).toBe(RESULT_STATUS.APPLIED);
    expect(result.appliedOperations[0].replacedOperationIds).toEqual(['step.order', 'assert.order']);
    expect(refinedCase.steps.map((record) => record.id)).toEqual([newIds[0], 'step.pickup']);
    expect(refinedCase.assertions.map((record) => record.id)).toEqual([newIds[1], 'assert.pickup']);
    expect(refinedCase.steps[1].dependsOn).toEqual([newIds[0]]);
    expect(refinedCase.assertions[1].stepId).toBe('step.pickup');
  });

  it('rejects stale source authority without changing the preview', () => {
    const current = authority();
    const result = refine(current, {
      summary: 'Change Pickup Number to 7995145888.',
      operations: [{ selector: { operationId: 'step.pickup' }, changes: { value: '7995145888' } }],
    }, { sourceDigest: 'sha256-stale' });

    expect(result.applied).toBe(false);
    expect(result.clarifications[0].code).toBe('refinement_source_stale');
    expect(result.preview).toEqual(current.preview);
    expect(result.semanticPlan).toEqual(current.plan);
  });

  it('keeps a semantically invalid replacement non-approvable while preserving it for further review', () => {
    const current = authority();
    const sourceText = 'Replace the Pickup Number step with a click operation on the reviewed control.';
    const result = refine(current, {
      summary: sourceText,
      sourceText,
      operations: [{
        selector: { operationId: 'step.pickup' },
        replaceWith: [{
          kind: 'action',
          type: 'Click',
          text: 'Click the reviewed control.',
          flowImpact: 'state_change',
          failureBehavior: 'stop_descendants',
        }],
      }],
    });

    expect(result.applied).toBe(true);
    expect(result.status).toBe(RESULT_STATUS.NEEDS_REVIEW);
    expect(result.preview.approvalEligible).toBe(false);
    expect(result.clarifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'semantic_contract_target_identity_missing' }),
    ]));
  });
});
