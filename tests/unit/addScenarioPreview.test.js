import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  PREVIEW_STATUS,
  PREVIEW_VERSION,
  buildAddScenarioPreview,
} = require('../../server/services/addScenarioPreview');

const SOURCE = [
  'Continue in the current authenticated session.',
  'Fill Order Number with 007995145.',
  'Verify that the Order Number equals 007995145.',
].join('\n');

function semanticPlan(overrides = {}) {
  const fillQuote = 'Fill Order Number with 007995145.';
  const assertionQuote = 'Verify that the Order Number equals 007995145.';
  const fillStart = SOURCE.indexOf(fillQuote);
  const assertionStart = SOURCE.indexOf(assertionQuote);
  return {
    semanticIntentPlan: { version: 'SemanticIntentPlanV1' },
    metadata: { attempts: 1 },
    sourceCompleteness: {
      complete: true,
      findings: [],
      consumedSourceUnitIds: ['source.1', 'source.2', 'source.3'],
    },
    caseContractV1: {
      version: 'CaseContractV1',
      sourceClauses: [
        { id: 'source.1', text: 'Continue in the current authenticated session.' },
        { id: 'source.2', text: fillQuote },
        { id: 'source.3', text: assertionQuote },
      ],
      sourceCoverage: [
        { sourceId: 'source.1', disposition: 'session' },
        { sourceId: 'source.2', disposition: 'action', recordId: 'step.fill-order' },
        { sourceId: 'source.3', disposition: 'assertion', recordId: 'assert.order-number' },
      ],
      cases: [{
        id: 'case.order',
        name: 'Continue order creation',
        intent: 'Continue from the authenticated dashboard and populate the order.',
        initialState: { kind: 'authenticated_dashboard' },
        expectedFinalState: { kind: 'order_form_populated' },
        sessionRequirement: {
          mode: 'continue_from_case',
          predecessorCaseId: 'case.login',
        },
        dependencies: ['case.login'],
        failurePolicy: { default: 'stop_descendants' },
        steps: [{
          id: 'step.fill-order',
          ordinal: 1,
          type: 'Fill',
          target: { label: 'Order Number', role: 'textbox' },
          value: '007995145',
          sourceQuote: fillQuote,
          sourceSpan: { start: fillStart, end: fillStart + fillQuote.length },
        }],
        assertions: [{
          id: 'assert.order-number',
          ordinal: 1,
          type: 'AssertText',
          target: { label: 'Order Number', role: 'textbox' },
          comparator: 'equals',
          payload: {
            operands: [
              { role: 'actual', ref: 'target.value' },
              { role: 'expected', value: '007995145' },
            ],
          },
          sourceQuote: assertionQuote,
          sourceSpan: { start: assertionStart, end: assertionStart + assertionQuote.length },
        }],
      }],
    },
    ...overrides,
  };
}

function build(overrides = {}) {
  return buildAddScenarioPreview({
    projectId: 'project-1',
    currentGenerationId: 'generation-5',
    sourceText: SOURCE,
    semanticPlan: semanticPlan(),
    ...overrides,
  });
}

describe('addScenarioPreview', () => {
  it('returns a complete immutable, non-persisted review contract', () => {
    const preview = build();
    const previewCase = preview.scenarios[0].cases[0];

    expect(preview.version).toBe(PREVIEW_VERSION);
    expect(preview.status).toBe(PREVIEW_STATUS.READY);
    expect(preview.approvalEligible).toBe(true);
    expect(preview.persistence).toEqual({
      status: 'not_persisted',
      currentGenerationId: 'generation-5',
      scenarioCountCreated: 0,
      caseCountCreated: 0,
    });
    expect(previewCase.continuation).toEqual({
      mode: 'continue_from_case',
      predecessorCaseId: 'case.login',
    });
    expect(previewCase.steps).toHaveLength(1);
    expect(previewCase.assertions).toHaveLength(1);
    expect(previewCase.orderedOperations.map((operation) => operation.kind))
      .toEqual(['action', 'assertion']);
    expect(previewCase.inlineLiterals).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordId: 'step.fill-order', field: 'value', value: '007995145' }),
      expect.objectContaining({ recordId: 'assert.order-number', field: 'expected', value: '007995145' }),
    ]));
    expect(preview.source.completeness.complete).toBe(true);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.scenarios[0].cases[0].steps)).toBe(true);
  });

  it('keeps preview identity stable and revisions content-addressed', () => {
    const first = build();
    const second = build();
    const changedPlan = semanticPlan();
    changedPlan.caseContractV1.cases[0].steps[0].value = '007995146';
    const changed = build({ semanticPlan: changedPlan });

    expect(second).toEqual(first);
    expect(second.previewId).toBe(first.previewId);
    expect(second.revision).toBe(first.revision);
    expect(changed.previewId).toBe(first.previewId);
    expect(changed.revision).not.toBe(first.revision);
  });

  it('returns semantic failures as a reviewable clarification state with zero persistence', () => {
    const error = Object.assign(new Error('The authored target is ambiguous.'), {
      code: 'ADD_SCENARIO_SEMANTIC_OUTPUT_INVALID',
      findings: [{
        code: 'semantic_target_ambiguous',
        path: '$.cases[0].actions[0].target',
        detail: 'Two authored targets have equal confidence.',
      }],
      sourceCompleteness: {
        complete: false,
        findings: [{ code: 'source_unit_unresolved', path: '$.source.2' }],
      },
    });
    const preview = buildAddScenarioPreview({
      projectId: 'project-1',
      currentGenerationId: 'generation-5',
      sourceText: SOURCE,
      error,
    });

    expect(preview.status).toBe(PREVIEW_STATUS.NEEDS_REVIEW);
    expect(preview.approvalEligible).toBe(false);
    expect(preview.scenarios).toEqual([]);
    expect(preview.clarifications.error).toEqual(expect.objectContaining({
      code: 'ADD_SCENARIO_SEMANTIC_OUTPUT_INVALID',
    }));
    expect(preview.clarifications.findings.map((finding) => finding.code))
      .toEqual(['source_unit_unresolved', 'semantic_target_ambiguous']);
    expect(preview.persistence.scenarioCountCreated).toBe(0);
    expect(preview.persistence.caseCountCreated).toBe(0);
  });

  it('does not mark incomplete source coverage as approval eligible', () => {
    const incomplete = semanticPlan();
    incomplete.sourceCompleteness = {
      complete: false,
      findings: [{
        code: 'source_unit_unresolved',
        path: '$.source.3',
        detail: 'The assertion is not represented.',
      }],
    };
    const preview = build({ semanticPlan: incomplete });

    expect(preview.status).toBe(PREVIEW_STATUS.NEEDS_REVIEW);
    expect(preview.approvalEligible).toBe(false);
    expect(preview.scenarios[0].cases[0].steps).toHaveLength(1);
    expect(preview.clarifications.findings).toHaveLength(1);
    expect(preview.persistence.status).toBe('not_persisted');
  });
});
