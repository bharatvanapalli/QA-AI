import { describe, expect, it, vi } from 'vitest';

const {
  REFINEMENT_INTENT_VERSION,
  AddScenarioRefinementIntentPlannerError,
  planAddScenarioRefinementIntent,
} = require('../../server/services/addScenarioRefinementIntentPlanner');

function operationCatalog() {
  return [
    {
      operationId: 'step.order-number',
      caseId: 'case.create-order',
      kind: 'action',
      ordinal: 10,
      type: 'Fill',
      semanticTarget: { label: 'Order Number', role: 'textbox' },
      summary: 'Fill Order Number with 007995145.',
    },
    {
      operationId: 'assert.order-number',
      caseId: 'case.create-order',
      kind: 'assertion',
      ordinal: 11,
      type: 'AssertText',
      semanticTarget: { label: 'Order Number', role: 'textbox' },
      summary: 'Verify Order Number equals 007995145.',
    },
    {
      operationId: 'step.pickup-number',
      caseId: 'case.create-order',
      kind: 'action',
      ordinal: 35,
      type: 'Fill',
      semanticTarget: { label: 'Pickup Number', role: 'textbox' },
      summary: 'Fill Pickup Number.',
    },
  ];
}

function validIntent(overrides = {}) {
  return {
    version: REFINEMENT_INTENT_VERSION,
    summary: 'Change only the Pickup Number value.',
    operations: [{
      selector: { operationId: 'step.pickup-number' },
      changes: { value: '7995145776' },
    }],
    ...overrides,
  };
}

function replacementOperations() {
  return [
    {
      kind: 'action',
      type: 'Click',
      text: 'Open Pickup Number options.',
      targetIdentity: { kind: 'control', label: 'Pickup Number', role: 'combobox', scope: 'order form' },
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    },
    {
      kind: 'action',
      type: 'Select',
      text: 'Select 7995145776 from Pickup Number options.',
      targetIdentity: { kind: 'collection', label: 'Pickup Number options', role: 'listbox', scope: 'order form' },
      selectionCriteria: { kind: 'exact_text', text: '7995145776' },
      flowImpact: 'state_change',
      failureBehavior: 'stop_descendants',
    },
    {
      kind: 'assertion',
      type: 'AssertText',
      text: 'Verify Pickup Number equals 7995145776.',
      targetIdentity: { kind: 'field', label: 'Pickup Number', role: 'textbox', scope: 'order form' },
      comparator: 'equals',
      payload: {
        channel: 'text',
        operands: [
          { role: 'actual', kind: 'target_property', property: 'text' },
          { role: 'expected', kind: 'literal', value: '7995145776' },
        ],
      },
      required: true,
      failureBehavior: 'continue_independent',
    },
  ];
}

function sizedCatalog(count) {
  return Array.from({ length: count }, (_, index) => ({
    operationId: `step.${index + 1}`,
    caseId: 'case.limit',
    kind: 'action',
    ordinal: index + 1,
    type: 'Click',
    semanticTarget: { label: `Control ${index + 1}`, role: 'button' },
    summary: `Click Control ${index + 1}.`,
  }));
}

function providerFor(output) {
  return {
    complete: vi.fn(async () => ({
      content: [{ text: typeof output === 'string' ? output : JSON.stringify(output) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })),
  };
}

function baseInput(overrides = {}) {
  return {
    provider: 'claude',
    apiKey: 'test-key',
    model: 'claude-test',
    operationCatalog: operationCatalog(),
    semanticPlanSummary: {
      caseCount: 1,
      operationCount: 3,
      continuation: { mode: 'continue_from_case', predecessorCaseId: 'case.login' },
    },
    refinementGuidance: 'In the Pickup Number step, replace the value with 7995145776. Do not change any other step.',
    sourceDigest: 'sha256-source',
    revision: 'sha256-revision-1',
    ...overrides,
  };
}

describe('Add Scenario natural-language refinement intent planner', () => {
  it('returns one compact validated patch intent and performs exactly one provider call', async () => {
    const provider = providerFor(validIntent());
    const onLog = vi.fn();

    const result = await planAddScenarioRefinementIntent(baseInput({ onLog }), { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'ready',
      unresolved: false,
      preserveCurrentPreview: true,
      persisted: false,
      findings: [],
      metadata: {
        providerCalls: 1,
        sourceDigest: 'sha256-source',
        baseRevision: 'sha256-revision-1',
      },
    });
    expect(result.refinementIntentV1).toEqual(validIntent());
    expect(Object.isFrozen(result)).toBe(true);

    const request = provider.complete.mock.calls[0][0];
    expect(request.temperature).toBe(0);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toContain('7995145776');
    expect(request.messages[0].content).toContain('step.pickup-number');
    expect(request.messages[0].content).toContain('sha256-revision-1');
    expect(request.system).toContain('Never emit a complete case');
    expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('one bounded provider call'));
  });

  it('accepts a unique case+kind+ordinal selector and canonicalizes it to the stable operation id', async () => {
    const intent = validIntent({
      summary: 'Correct the Order Number assertion comparator.',
      operations: [{
        selector: { caseId: 'case.create-order', kind: 'assertion', ordinal: 11 },
        changes: { comparator: 'equals' },
      }],
    });
    const provider = providerFor(intent);

    const result = await planAddScenarioRefinementIntent(baseInput(), { provider });

    expect(result.status).toBe('ready');
    expect(result.refinementIntentV1.operations).toEqual([{
      selector: { operationId: 'assert.order-number' },
      changes: { comparator: 'equals' },
    }]);
  });

  it('accepts one exact unique semantic target but rejects an ambiguous target', async () => {
    const uniqueProvider = providerFor(validIntent({
      operations: [{
        selector: { semanticTarget: { label: 'Pickup Number', role: 'textbox' } },
        changes: { value: '7995145776' },
      }],
    }));
    const unique = await planAddScenarioRefinementIntent(baseInput(), { provider: uniqueProvider });
    expect(unique.status).toBe('ready');
    expect(unique.refinementIntentV1.operations[0].selector).toEqual({ operationId: 'step.pickup-number' });

    const ambiguousProvider = providerFor(validIntent({
      operations: [{
        selector: { semanticTarget: 'Order Number' },
        changes: { text: 'Use the corrected Order Number behavior.' },
      }],
    }));
    const ambiguous = await planAddScenarioRefinementIntent(baseInput(), { provider: ambiguousProvider });
    expect(ambiguous.status).toBe('needs_review');
    expect(ambiguous.refinementIntentV1).toBeNull();
    expect(ambiguous.findings.map((entry) => entry.code)).toContain('refinement_operation_ambiguous');
    expect(ambiguousProvider.complete).toHaveBeenCalledTimes(1);
  });

  it('accepts one selected compound operation replaced by three typed atomic operations', async () => {
    const intent = validIntent({
      summary: 'Split the Pickup Number compound behavior into open, select, and verify operations.',
      operations: [{
        selector: { operationId: 'step.pickup-number' },
        replaceWith: replacementOperations(),
      }],
    });

    const result = await planAddScenarioRefinementIntent(baseInput(), { provider: providerFor(intent) });

    expect(result.status).toBe('ready');
    expect(result.refinementIntentV1.operations).toEqual([{
      selector: { operationId: 'step.pickup-number' },
      replaceWith: replacementOperations(),
    }]);
  });

  it('canonicalizes one contiguous same-case range and rejects cross-case ranges', async () => {
    const rangeIntent = validIntent({
      summary: 'Replace the Order Number action and assertion together.',
      operations: [{
        range: {
          start: { operationId: 'step.order-number' },
          end: { operationId: 'assert.order-number' },
        },
        replaceWith: replacementOperations().slice(0, 2),
      }],
    });
    const accepted = await planAddScenarioRefinementIntent(baseInput(), { provider: providerFor(rangeIntent) });
    expect(accepted.status).toBe('ready');
    expect(accepted.refinementIntentV1.operations[0].range).toEqual({
      start: { operationId: 'step.order-number' },
      end: { operationId: 'assert.order-number' },
    });

    const crossCaseCatalog = [
      operationCatalog()[0],
      { ...operationCatalog()[1], operationId: 'assert.other', caseId: 'case.other' },
    ];
    const crossCaseIntent = {
      ...rangeIntent,
      operations: [{
        ...rangeIntent.operations[0],
        range: {
          start: { operationId: 'step.order-number' },
          end: { operationId: 'assert.other' },
        },
      }],
    };
    const rejected = await planAddScenarioRefinementIntent(baseInput({ operationCatalog: crossCaseCatalog }), {
      provider: providerFor(crossCaseIntent),
    });
    expect(rejected.status).toBe('needs_review');
    expect(rejected.findings.map((entry) => entry.code)).toContain('refinement_range_cross_case');
  });

  it('rejects a backwards noncontiguous replacement range', async () => {
    const intent = validIntent({
      summary: 'Replace a reversed range.',
      operations: [{
        range: {
          start: { operationId: 'step.pickup-number' },
          end: { operationId: 'step.order-number' },
        },
        replaceWith: replacementOperations(),
      }],
    });
    const result = await planAddScenarioRefinementIntent(baseInput(), { provider: providerFor(intent) });
    expect(result.status).toBe('needs_review');
    expect(result.findings.map((entry) => entry.code)).toContain('refinement_range_not_contiguous');
  });

  it('accepts exactly 100 projected operations and rejects 101', async () => {
    const intent = validIntent({
      summary: 'Split one compound operation into three atomic operations.',
      operations: [{
        selector: { operationId: 'step.1' },
        replaceWith: replacementOperations(),
      }],
    });
    const accepted = await planAddScenarioRefinementIntent(baseInput({ operationCatalog: sizedCatalog(98) }), {
      provider: providerFor(intent),
    });
    expect(accepted.status).toBe('ready');

    const rejected = await planAddScenarioRefinementIntent(baseInput({ operationCatalog: sizedCatalog(99) }), {
      provider: providerFor(intent),
    });
    expect(rejected.status).toBe('needs_review');
    expect(rejected.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'refinement_operation_limit' }),
    ]));
  });

  it('returns reviewable findings for strict-JSON failure without retries or repair calls', async () => {
    const provider = providerFor(`\`\`\`json\n${JSON.stringify(validIntent())}\n\`\`\``);

    const result = await planAddScenarioRefinementIntent(baseInput(), { provider });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('needs_review');
    expect(result.persisted).toBe(false);
    expect(result.preserveCurrentPreview).toBe(true);
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'refinement_output_unparseable' }),
    ]));
  });

  it('rejects full-case output and unknown operations as reviewable findings', async () => {
    const fullCaseProvider = providerFor({
      ...validIntent(),
      cases: [{ steps: [] }],
    });
    const fullCase = await planAddScenarioRefinementIntent(baseInput(), { provider: fullCaseProvider });
    expect(fullCase.status).toBe('needs_review');
    expect(fullCase.findings.map((entry) => entry.code)).toContain('refinement_root_field_unknown');

    const unknownProvider = providerFor(validIntent({
      operations: [{ selector: { operationId: 'step.missing' }, changes: { value: 'x' } }],
    }));
    const unknown = await planAddScenarioRefinementIntent(baseInput(), { provider: unknownProvider });
    expect(unknown.status).toBe('needs_review');
    expect(unknown.findings.map((entry) => entry.code)).toContain('refinement_operation_unknown');
  });

  it('rejects compiler-owned fields recursively and unsupported changes', async () => {
    const provider = providerFor(validIntent({
      operations: [{
        selector: { operationId: 'step.pickup-number' },
        changes: {
          targetIdentity: { label: 'Pickup Number', id: 'compiler-owned-target-id' },
          ordinal: 99,
          arbitraryRuntimePolicy: 'retry forever',
        },
      }],
    }));

    const result = await planAddScenarioRefinementIntent(baseInput(), { provider });

    expect(result.status).toBe('needs_review');
    expect(result.findings.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'refinement_protected_field',
      'refinement_change_field_unsupported',
    ]));
    expect(result.refinementIntentV1).toBeNull();
  });

  it('rejects malformed values even when the change field itself is supported', async () => {
    const provider = providerFor(validIntent({
      operations: [{
        selector: { operationId: 'step.pickup-number' },
        changes: { value: { invented: 'nested scalar' } },
      }],
    }));

    const result = await planAddScenarioRefinementIntent(baseInput(), { provider });

    expect(result.status).toBe('needs_review');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'refinement_change_value_invalid' }),
    ]));
  });

  it('rejects mixed selector modes and duplicate targets as ambiguous output', async () => {
    const mixedProvider = providerFor(validIntent({
      operations: [{
        selector: { operationId: 'step.pickup-number', semanticTarget: 'Pickup Number' },
        changes: { value: '7995145776' },
      }],
    }));
    const mixed = await planAddScenarioRefinementIntent(baseInput(), { provider: mixedProvider });
    expect(mixed.findings.map((entry) => entry.code)).toContain('refinement_selector_ambiguous');

    const duplicateProvider = providerFor(validIntent({
      operations: [
        { selector: { operationId: 'step.pickup-number' }, changes: { value: '7995145776' } },
        { selector: { operationId: 'step.pickup-number' }, changes: { text: 'Fill the pickup number.' } },
      ],
    }));
    const duplicate = await planAddScenarioRefinementIntent(baseInput(), { provider: duplicateProvider });
    expect(duplicate.findings.map((entry) => entry.code)).toContain('refinement_operation_duplicate');
  });

  it('honors an already-aborted signal without calling the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = providerFor(validIntent());

    await expect(planAddScenarioRefinementIntent(baseInput({ signal: controller.signal }), { provider }))
      .rejects.toMatchObject({
        name: AddScenarioRefinementIntentPlannerError.name,
        code: 'CANCELLED',
        status: 499,
      });
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
