import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const kernel = require('../../server/services/universalActionKernel');

function queueObserver(values) {
  const queue = [...values];
  return vi.fn(async () => queue.shift());
}

function fresh(overrides = {}) {
  return {
    fresh: true,
    snapshotText: '- textbox "Display name" [ref=name-ref]',
    url: 'https://neutral.example/form',
    ...overrides,
  };
}

function uniqueResolution(ref = 'name-ref') {
  return { ok: true, ref, actionLocator: { ref }, candidateCount: 1, confidenceMargin: 20 };
}

describe('universalActionKernel', () => {
  it('classifies website-neutral action families without provider rules', () => {
    expect(kernel.classifyActionFamily({ action: 'Click' })).toBe(kernel.FAMILIES.CLICK);
    expect(kernel.classifyActionFamily({ action: 'Select' })).toBe(kernel.FAMILIES.CONTROL);
    expect(kernel.classifyActionFamily({ action: 'Verify', assertion: { type: 'TEXT' } })).toBe(kernel.FAMILIES.ASSERTION);
    expect(kernel.classifyActionFamily({ action: 'AssertText', target: 'Order number', verify: { kind: 'text', text: '42' } }))
      .toBe(kernel.FAMILIES.ASSERTION);
    expect(kernel.classifyActionFamily({ action: 'AssertVisible', target: 'Create order', verify: { kind: 'visible' } }))
      .toBe(kernel.FAMILIES.ASSERTION);
    expect(kernel.classifyActionFamily({ action: 'Download' })).toBe(kernel.FAMILIES.EVENT);
    expect(kernel.classifyActionFamily(
      { action: 'Click', eventKind: 'popup' },
      { eventAdapter: { canHandle: (step) => step.eventKind === 'popup' } },
    )).toBe(kernel.FAMILIES.EVENT);
    expect(kernel.classifyActionFamily({ action: 'Quantum jump' })).toBe(kernel.FAMILIES.UNSUPPORTED);
  });

  it('recognizes only explicit website-neutral control opener Click intents', () => {
    expect(kernel.controlOpenerIntent({ action: 'Click', target: 'Equipment dropdown' }))
      .toMatchObject({ controlKind: 'choice', ownerTarget: 'Equipment' });
    expect(kernel.controlOpenerIntent({ action: 'Click', target: 'Pickup Date calendar' }))
      .toMatchObject({ controlKind: 'date', ownerTarget: 'Pickup Date' });
    expect(kernel.controlOpenerIntent({ action: 'Click', target: 'Pickup Time dropdown' }))
      .toMatchObject({ controlKind: 'time', ownerTarget: 'Pickup Time' });
    expect(kernel.controlOpenerIntent({ action: 'Click', target: 'Submit request' })).toBeNull();

    const plan = kernel.buildControlOpenerPlan({ action: 'Click', target: 'Equipment dropdown' });
    expect(plan).toMatchObject({
      kind: 'expand',
      target: 'Equipment',
      phases: [
        {
          id: 'open-choice-control',
          toolName: 'browser_click',
          semanticTarget: { kind: 'control_opener', controlKind: 'choice', ownerTarget: 'Equipment' },
        },
        {
          id: 'open-choice-control-trigger-assist',
          toolName: 'browser_click',
          resolutionToolName: 'browser_click',
          semanticTarget: { preferTrigger: true },
        },
        {
          id: 'open-choice-control-keyboard-assist',
          toolName: 'browser_press_key',
          resolutionToolName: 'browser_click',
          args: { key: 'ArrowDown' },
        },
      ],
      metadata: { semanticControlOpener: true, openerKind: 'choice' },
    });
    const timePlan = kernel.buildControlOpenerPlan({ action: 'Click', target: 'Pickup Time dropdown' });
    expect(timePlan.phases.map((phase) => [phase.id, phase.toolName])).toEqual([
      ['open-time-control', 'browser_click'],
      ['open-time-control-trigger-assist', 'browser_click'],
      ['open-time-control-keyboard-assist', 'browser_press_key'],
    ]);
    const datePlan = kernel.buildControlOpenerPlan({ action: 'Click', target: 'Pickup Date calendar' });
    expect(datePlan.phases.map((phase) => [phase.id, phase.toolName]))
      .toEqual([['open-calendar', 'browser_click']]);
  });

  it('stops opener fallbacks as soon as browser evidence proves the popup opened', async () => {
    const plan = kernel.buildControlOpenerPlan({ action: 'Click', target: 'Equipment dropdown' });
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_click' }));
    const observe = queueObserver([
      fresh({ snapshotText: '- combobox "Equipment" [ref=equipment-ref]' }),
      fresh({ snapshotText: '- combobox "Equipment" [expanded] [ref=equipment-ref]\n- listbox [ref=list-ref]\n  - option "LTL" [ref=ltl-ref]' }),
      fresh({ snapshotText: '- combobox "Equipment" [expanded] [ref=equipment-ref]\n- listbox [ref=list-ref]\n  - option "LTL" [ref=ltl-ref]' }),
    ]);

    const result = await kernel.executeControlAction({
      step: { id: 'equipment-open', action: 'Click', target: 'Equipment dropdown' },
      plan,
      observe,
      resolve: async () => uniqueResolution('equipment-ref'),
      dispatch,
      prove: async ({ observation }) => ({
        kind: 'control_open',
        matched: /\[expanded\]|- listbox\b/.test(observation.snapshotText || observation.snapshotAfter || ''),
        checked: true,
        status: /\[expanded\]|- listbox\b/.test(observation.snapshotText || observation.snapshotAfter || '') ? 'pass' : 'fail',
        reason: 'semantic_control_open_probe',
      }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ status: 'pass' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].phase.id).toBe('open-choice-control');
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it('does not reverse a proven expanded state when a redundant final observation is unavailable', async () => {
    const plan = kernel.buildControlOpenerPlan({ action: 'Click', target: 'Freight Term dropdown' });
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_click' }));
    const observe = queueObserver([
      fresh({ snapshotText: '- combobox "Freight Term" [ref=freight-ref]' }),
      fresh({ snapshotText: '- combobox "Freight Term" [expanded] [ref=freight-ref]\n- listbox [ref=freight-options]' }),
      undefined,
    ]);

    const result = await kernel.executeControlAction({
      step: { id: 'freight-open', action: 'Click', target: 'Freight Term dropdown' },
      plan,
      observe,
      resolve: async () => uniqueResolution('freight-ref'),
      dispatch,
      prove: async ({ observation }) => ({
        kind: 'control_open',
        matched: /\[expanded\]|- listbox\b/.test(observation.snapshotText || observation.snapshotAfter || ''),
        checked: true,
        status: /\[expanded\]|- listbox\b/.test(observation.snapshotText || observation.snapshotAfter || '') ? 'pass' : 'fail',
        reason: 'semantic_control_expanded',
      }),
      seal: async () => ({}),
      maxFreshPostconditionAttempts: 1,
    });

    expect(result).toMatchObject({ status: 'pass', reason: 'control_postcondition_matched' });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('dispatches the canonical interaction node while retaining the value owner', async () => {
    const plan = kernel.buildControlOpenerPlan({ action: 'Click', target: 'Equipment dropdown' });
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_click' }));
    const resolvedControl = {
      ownerNode: { ref: 'equipment-owner', role: 'combobox', labels: ['Equipment'] },
      interactionNode: { ref: 'equipment-trigger', role: 'button', labels: ['Equipment'] },
      valueNode: { ref: 'equipment-owner', role: 'combobox', labels: ['Equipment'] },
      popupNode: null,
    };
    const result = await kernel.executeControlAction({
      step: { id: 'equipment-open', action: 'Click', target: 'Equipment dropdown' },
      plan,
      observe: queueObserver([
        fresh({ snapshotText: '- combobox "Equipment" [ref=equipment-owner]\n- button [ref=equipment-trigger]' }),
        fresh({ snapshotText: '- combobox "Equipment" [expanded] [ref=equipment-owner]\n- listbox [ref=equipment-popup]' }),
        fresh({ snapshotText: '- combobox "Equipment" [expanded] [ref=equipment-owner]\n- listbox [ref=equipment-popup]' }),
      ]),
      resolve: async () => ({
        ...uniqueResolution('equipment-owner'),
        resolvedCandidate: { ref: 'equipment-owner', resolvedControl },
      }),
      dispatch,
      prove: async ({ observation }) => ({
        kind: 'control_open',
        matched: /\[expanded\]|- listbox\b/.test(observation.snapshotText || ''),
        checked: true,
        status: /\[expanded\]|- listbox\b/.test(observation.snapshotText || '') ? 'pass' : 'fail',
        reason: 'semantic_control_open_probe',
      }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ status: 'pass' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      resolution: { ref: 'equipment-owner' },
      phase: { args: { target: 'equipment-trigger' } },
    });
  });

  it('dispatches fill actions to the value owner instead of an associated opener button', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_fill_form' }));
    const resolvedControl = {
      schema: 'qaai_universal_control_v1',
      controlType: 'autocomplete',
      requestedAction: 'fill',
      requestedTarget: 'Owning Organization field',
      ownerNode: { ref: 'organization-owner', role: 'combobox', labels: ['Owning Organization'] },
      interactionNode: { ref: 'organization-trigger', role: 'button', labels: ['Owning Organization'] },
      valueNode: { ref: 'organization-owner', role: 'combobox', labels: ['Owning Organization'] },
      popupNode: null,
    };

    const result = await kernel.executeUniversalAction({
      step: { id: 'organization-fill', action: 'Fill', target: 'Owning Organization field', value: 'SIGROUP' },
      observe: queueObserver([
        fresh({ snapshotText: '- combobox "Owning Organization" [ref=organization-owner]', actualValue: '' }),
        fresh({ snapshotText: '- combobox "Owning Organization" [ref=organization-owner]', actualValue: 'SIGROUP' }),
      ]),
      resolve: async () => ({
        ...uniqueResolution('organization-owner'),
        resolvedCandidate: { ref: 'organization-owner', resolvedControl },
      }),
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ status: 'pass' });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].phase.args.fields[0]).toMatchObject({
      target: 'organization-owner',
      ref: 'organization-owner',
    });
  });

  it('keeps an unconfirmed scroll utility from blocking later authored controls', async () => {
    const seal = vi.fn(async () => ({}));
    const result = await kernel.executeUniversalAction({
      step: { id: 'references-scroll', action: 'Scroll', target: 'References section', scrollMode: 'target' },
      observe: vi.fn(async () => fresh({ snapshotText: '- region "References" [ref=references]' })),
      resolve: async () => uniqueResolution('references'),
      dispatch: async () => ({ ok: false, isError: true, error: 'scroll_delivery_uncertain' }),
      seal,
    });

    expect(result).toMatchObject({
      status: 'pass',
      reason: 'scroll_utility_unconfirmed_continue',
      continuation: { terminal: false, outcome: 'continue' },
    });
    expect(seal).toHaveBeenCalledWith(expect.objectContaining({
      internalOperationCompletion: true,
      internalOperationKind: 'scroll_utility',
      runtimeToolName: 'internal_scroll_utility',
    }));
  });

  it('recomputes semantic identity and rejects a contradictory ok resolution before dispatch', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_click' }));
    const observe = vi.fn(async () => fresh({
      snapshotText: '- textbox "Pickup Number" [ref=pickup-number]',
    }));
    const contradictoryControl = {
      schema: 'qaai_universal_control_v1',
      controlType: 'textbox',
      requestedAction: 'click',
      requestedTarget: 'Pickup Number',
      ownerNode: { ref: 'pickup-number', role: 'textbox', labels: ['Pickup Number'] },
      interactionNode: { ref: 'pickup-number', role: 'textbox', labels: ['Pickup Number'] },
      valueNode: { ref: 'pickup-number', role: 'textbox', labels: ['Pickup Number'] },
    };
    const result = await kernel.executeControlAction({
      step: { id: 'pickup-date-open', action: 'Click', target: 'Early Pickup Date calendar' },
      plan: kernel.buildControlOpenerPlan({ action: 'Click', target: 'Early Pickup Date calendar' }),
      observe,
      resolve: async () => ({
        ok: true,
        ref: 'pickup-number',
        actionLocator: { ref: 'pickup-number' },
        candidateCount: 1,
        confidenceMargin: 100,
        resolvedCandidate: { ref: 'pickup-number', resolvedControl: contradictoryControl },
      }),
      dispatch,
      prove: async () => ({ checked: true, matched: false, status: 'fail', reason: 'not_open' }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'control_target_resolution_uncertain',
      diagnostics: {
        resolutions: expect.arrayContaining([
          expect.objectContaining({
            ok: false,
            code: 'semanticcontrolidentitymismatch',
            semanticMatch: expect.objectContaining({
              ok: false,
              source: 'universal_kernel_pre_dispatch',
              authoredTarget: 'Early Pickup Date',
            }),
          }),
        ]),
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('commits an already-visible disclosure body without dispatching or re-failing on aria state', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_click' }));
    const result = await kernel.executeControlAction({
      step: { id: 'details-expand', action: 'Expand', target: 'Details section' },
      observe: queueObserver([
        fresh({
          snapshotText: [
            '- button "Details" [ref=details-trigger]',
            '- generic [ref=details-body]:',
            '  - textbox "Reference" [ref=reference]',
          ].join('\n'),
          expanded: false,
          ariaExpanded: 'false',
        }),
        fresh({ expanded: false, ariaExpanded: 'false' }),
      ]),
      resolve: async () => ({ ...uniqueResolution('details-trigger'), phaseAlreadySatisfied: true }),
      dispatch,
      prove: async () => ({
        kind: 'expanded_exact',
        matched: false,
        checked: true,
        status: 'blocked',
        reason: 'expanded state did not match',
      }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      status: 'pass',
      reason: 'control_postcondition_matched',
      diagnostics: {
        proofs: expect.arrayContaining([
          expect.objectContaining({ reason: 'semantic_control_state_already_satisfied' }),
        ]),
      },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps opener and option phases distinct when fresh evidence proves the owner is already open', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_click' }));
    const resolve = vi.fn(async ({ phase, completedPhaseIds }) => {
      if (phase.id === 'open-choice-control') {
        expect(completedPhaseIds).toEqual([]);
        return { ...uniqueResolution('equipment-ref'), phaseAlreadySatisfied: true };
      }
      if (phase.id === 'open-choice-control-keyboard-assist') {
        expect(completedPhaseIds).toEqual(['open-choice-control']);
        return { ...uniqueResolution('equipment-ref'), phaseAlreadySatisfied: true };
      }
      expect(completedPhaseIds).toEqual([
        'open-choice-control',
        'open-choice-control-keyboard-assist',
      ]);
      return uniqueResolution('ltl-ref');
    });
    const result = await kernel.executeControlAction({
      step: { action: 'Select', target: 'Equipment', value: 'LTL', controlKind: 'custom' },
      observe: queueObserver([
        fresh({ snapshotText: '- combobox "Equipment" [expanded] [ref=equipment-ref]' }),
        fresh({ snapshotText: '- combobox "Equipment" [expanded] [ref=equipment-ref]' }),
        fresh({ snapshotText: '- option "LTL" [ref=ltl-ref]' }),
        fresh({ selectedText: 'LTL', selectedTexts: ['LTL'] }),
      ]),
      resolve,
      dispatch,
      prove: async () => ({ kind: 'selection_exact', matched: true, checked: true, status: 'pass', reason: 'selected' }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ status: 'pass' });
    expect(resolve.mock.calls.map(([call]) => call.phase.id))
      .toEqual([
        'open-choice-control',
        'open-choice-control-keyboard-assist',
        'choose-exact-option',
      ]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0].phase).toMatchObject({
      id: 'choose-exact-option',
      args: { target: 'ltl-ref' },
    });
  });

  it('commits only authoritative optional absence and never skips required or ambiguous actions', async () => {
    const seal = vi.fn(async () => ({}));
    const optionalStep = {
      id: 'optional-email',
      action: 'Fill',
      target: 'Backup Email',
      value: 'backup@example.test',
      optional: true,
    };
    const absent = await kernel.executeOptionalPresencePreflight({
      step: optionalStep,
      family: kernel.FAMILIES.CONTROL,
      resolveOptionalPresence: async () => ({
        present: false,
        authoritativeAbsence: true,
        source: 'fresh_semantic_snapshot_zero_candidates',
      }),
      seal,
    });
    expect(absent).toMatchObject({
      handled: true,
      terminal: false,
      status: 'pass',
      reason: 'optional_target_absent',
      runtimeToolName: 'internal_optional_absent',
      record: { matched: true, required: false, optionalAbsent: true },
      diagnostics: { dispatches: [] },
    });
    expect(seal).toHaveBeenCalledWith(expect.objectContaining({
      internalOperationCompletion: true,
      internalOperationKind: 'optional_absent',
      runtimeToolName: 'internal_optional_absent',
    }));

    await expect(kernel.executeOptionalPresencePreflight({
      step: optionalStep,
      resolveOptionalPresence: async () => ({ present: null, authoritativeAbsence: false, reason: 'ambiguous' }),
    })).resolves.toBeNull();
    await expect(kernel.executeOptionalPresencePreflight({
      step: { ...optionalStep, contractRequired: true },
      resolveOptionalPresence: vi.fn(),
    })).resolves.toBeNull();
  });

  it('grounds generated verify contracts in their authored target and expected value', () => {
    expect(kernel.assertionContractOf({
      action: 'AssertText',
      target: 'Order Number field',
      verify: { kind: 'text', text: '007995145' },
    })).toEqual({
      type: 'text',
      payload: {
        kind: 'text',
        text: '007995145',
        expectedText: '007995145',
        target: { name: 'Order Number field', label: 'Order Number field' },
      },
    });
  });

  it('upgrades authored list, selected-value, date, and temporal prose into typed assertions', () => {
    expect(kernel.assertionContractOf({
      action: 'AssertText',
      target: 'Equipment options appear in this exact order: RR, LCL, LTL, TL, FCL',
      expected: 'the Equipment options appear in this exact order: RR, LCL, LTL, TL, FCL.',
      verify: { kind: 'text', text: 'Verify that the Equipment options appear in this exact order: RR, LCL, LTL, TL, FCL.' },
    })).toMatchObject({
      type: 'COLLECTION',
      payload: {
        target: { name: 'Equipment option list', role: 'listbox' },
        expectedItems: ['RR', 'LCL', 'LTL', 'TL', 'FCL'],
        comparator: 'ordered_equals',
      },
    });

    expect(kernel.assertionContractOf({
      action: 'Select', target: 'Time Zone dropdown', expected: 'selected Time Zone label contains Central.',
      verify: { kind: 'selected', value: 'Central' },
    })).toMatchObject({
      type: 'VALUE',
      payload: { expectedValue: 'Central', comparator: 'contains' },
    });

    expect(kernel.assertionContractOf({
      action: 'AssertText', target: 'selected Organization',
      expected: 'the selected Organization is exactly Example Group.',
      verify: { kind: 'text', text: 'Verify the selected Organization is exactly Example Group.' },
    })).toMatchObject({
      type: 'VALUE',
      payload: { expectedValue: 'Example Group', comparator: 'equals' },
    });

    expect(kernel.assertionContractOf({
      action: 'AssertText', target: 'Email Address field',
      expected: 'the Email Address field contains exactly tester@example.com.',
      verify: { kind: 'text', text: 'Verify the Email Address field contains exactly tester@example.com.' },
    })).toMatchObject({
      type: 'VALUE',
      payload: { expectedValue: 'tester@example.com', comparator: 'equals' },
    });

    expect(kernel.assertionContractOf({
      action: 'AssertText', target: 'Details section',
      expected: 'the Details section is expanded.',
      verify: { kind: 'text', text: 'Verify that the Details section is expanded.' },
    })).toMatchObject({
      type: 'ATTRIBUTE',
      payload: { attributeName: 'aria-expanded', expectedValue: 'true', comparator: 'equals' },
    });

    expect(kernel.assertionContractOf({
      action: 'AssertText', target: 'Pickup Date',
      expected: 'Pickup Date represents August 20, 2026 and displays an equivalent value such as 08/20/2026.',
      verify: { kind: 'text', text: 'August 20, 2026 (08/20/2026)' },
    })).toMatchObject({ type: 'DATE', payload: { expectedDate: '2026-08-20' } });

    expect(kernel.assertionContractOf({
      action: 'AssertText', target: 'Pickup Date/Time',
      expected: 'Pickup Date/Time is before Delivery Date/Time.',
      verify: { kind: 'text', text: 'Verify that Pickup Date/Time is before Delivery Date/Time.' },
    })).toMatchObject({
      type: 'TEMPORAL_RELATIONSHIP',
      payload: {
        comparator: 'before',
        operands: [
          { parts: [{ name: 'Pickup Date' }, { name: 'Pickup Time' }] },
          { parts: [{ name: 'Delivery Date' }, { name: 'Delivery Time' }] },
        ],
      },
    });
  });

  it('removes an optional conjunction after a comma in collection expectations', () => {
    expect(kernel.assertionContractOf({
      action: 'AssertText',
      target: 'Transport mode option list',
      expected: 'the Transport mode option list contains Road, Rail, Air, and Sea.',
      verify: { kind: 'text', text: 'Verify that the Transport mode option list contains Road, Rail, Air, and Sea.' },
    })).toMatchObject({
      type: 'COLLECTION',
      payload: {
        target: { name: 'Transport mode option list', role: 'listbox' },
        expectedItems: ['Road', 'Rail', 'Air', 'Sea'],
        comparator: 'contains_all',
      },
    });
  });

  it('runs a control through fresh observation, unique resolution, dispatch, and proof', async () => {
    const observe = queueObserver([
      fresh({ actualValue: '' }),
      fresh({ actualValue: 'Alice' }),
    ]);
    const resolve = vi.fn(async () => uniqueResolution());
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_fill_form' }));
    const seal = vi.fn(async () => ({}));

    const result = await kernel.executeUniversalAction({
      step: { id: 'name', action: 'Fill', target: 'Display name', value: 'Alice' },
      observe,
      resolve,
      dispatch,
      seal,
    });

    expect(result).toMatchObject({
      family: 'control',
      status: 'pass',
      outcomeKind: 'success',
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
      terminal: false,
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls.every(([request]) => request.requireFresh === true)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].phase.args.fields[0]).toMatchObject({ target: 'name-ref', ref: 'name-ref' });
    expect(seal).toHaveBeenCalledOnce();
    expect(seal.mock.calls[0][0]).toMatchObject({
      family: 'control',
      status: 'pass',
      actionOutcome: 'succeeded',
      assertionOutcome: 'matched',
      runtimeToolName: 'browser_fill_form',
    });
    expect(result).toMatchObject({
      runtimeToolName: 'browser_fill_form',
      continuation: { terminal: false, outcome: 'continue' },
    });
  });

  it('resolves secure textbox values only for dispatch and persists fingerprint-safe proof', async () => {
    const secret = 'runtime-only-password';
    const observations = [
      fresh({ snapshotText: '- textbox "Password" [ref=pw]' }),
      fresh({ snapshotText: '- textbox "Password" [ref=pw]', actualValue: secret }),
    ];
    const persisted = [];
    const dispatch = vi.fn(async ({ phase }) => {
      expect(phase.args.fields[0].value).toBe(secret);
      return { ok: true, toolName: 'browser_fill_form' };
    });

    const result = await kernel.executeUniversalAction({
      step: { id: 'secure-fill', action: 'Fill', element: 'Password', valueRef: 'env://LOGIN_PASSWORD', sensitive: true },
      observe: vi.fn(async () => observations.shift() || fresh({ actualValue: secret })),
      resolve: async () => uniqueResolution('pw'),
      resolveValueRef: async ({ valueRef }) => valueRef === 'env://LOGIN_PASSWORD' ? secret : null,
      dispatch,
      persistTransaction: async (transaction) => persisted.push(structuredClone(transaction)),
    });

    expect(result.status).toBe('pass');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ result, persisted })).not.toContain(secret);
    expect(JSON.stringify({ result, persisted })).toContain('env://LOGIN_PASSWORD');
  });

  it('blocks an unresolved secure value reference before browser mutation', async () => {
    const dispatch = vi.fn();
    const result = await kernel.executeUniversalAction({
      step: { id: 'secure-fill', action: 'Fill', element: 'Password', valueRef: 'vault://missing', sensitive: true },
      observe: vi.fn(async () => fresh({ snapshotText: '- textbox "Password" [ref=pw]' })),
      resolveValueRef: async () => null,
      dispatch,
    });

    expect(result).toMatchObject({ status: 'blocked', reason: 'control_value_ref_unresolved' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('cannot return success when the execution journal rejects a proposed pass', async () => {
    const result = await kernel.executeUniversalAction({
      step: { id: 'name', action: 'Fill', target: 'Display name', value: 'Alice' },
      observe: queueObserver([
        fresh({ actualValue: '' }),
        fresh({ actualValue: 'Alice' }),
      ]),
      resolve: async () => uniqueResolution(),
      dispatch: async () => ({ ok: true, toolName: 'browser_fill_form' }),
      seal: async () => ({
        hasRunnableStep: false,
        sealed: {
          status: 'blocked',
          actionOutcome: 'failed',
          assertionOutcome: 'uncheckable',
          continuationOutcome: 'stop_descendants',
          continuationReason: 'unregistered_runtime_tool',
        },
      }),
    });

    expect(result.status).not.toBe('pass');
    expect(result).toMatchObject({
      outcomeKind: 'qaai_execution_uncertainty',
      actionOutcome: 'failed',
      terminal: true,
      continuation: {
        terminal: true,
        outcome: 'stop_descendants',
        reason: 'unregistered_runtime_tool',
      },
    });
  });

  it('re-observes a delivered control until its value settles without dispatching again', async () => {
    const observe = queueObserver([
      fresh({ actualValue: '' }),
      fresh({ actualValue: 'Bob' }),
      fresh({ actualValue: 'Bob' }),
      fresh({ actualValue: 'Alice' }),
    ]);
    const resolve = vi.fn(async ({ attempt }) => uniqueResolution(`name-ref-${attempt}`));
    const dispatch = vi.fn(async () => ({ ok: true }));

    const result = await kernel.executeControlAction({
      step: { action: 'Fill', target: 'Display name', value: 'Alice' },
      observe,
      resolve,
      dispatch,
      seal: async () => ({}),
    });

    expect(result.status).toBe('pass');
    expect(dispatch).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledOnce();
    expect(result.diagnostics.retries).toEqual([]);
    expect(result.diagnostics.transaction.dispatchAttemptCount).toBe(1);
  });

  it('re-snapshots the current page and re-resolves one non-ambiguous pre-dispatch miss', async () => {
    const observe = queueObserver([
      fresh({ snapshotText: '- main "Loading"' }),
      fresh({ snapshotText: '- textbox "Display name" [ref=name-ref]' }),
      fresh({ snapshotText: '- textbox "Display name" [ref=name-ref]', actualValue: 'Alice' }),
    ]);
    const resolve = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        code: 'target_not_observed_in_current_snapshot',
        candidateCount: 0,
      })
      .mockResolvedValueOnce(uniqueResolution());
    const dispatch = vi.fn(async () => ({ ok: true, toolName: 'browser_fill_form' }));

    const result = await kernel.executeControlAction({
      step: { action: 'Fill', target: 'Display name', value: 'Alice' },
      observe,
      resolve,
      dispatch,
      sleep: async () => {},
      seal: async () => ({}),
    });

    expect(result.status).toBe('pass');
    expect(observe).toHaveBeenCalledTimes(3);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.retries).toContainEqual(expect.objectContaining({
      retry: true,
      reason: 'bounded_resolution_resnapshot',
      nextResolutionRecoveryCount: 1,
      freshObservationRequired: true,
      reResolveRequired: true,
    }));
  });

  it('continues to the semantic Date branch after a zero-candidate native miss', async () => {
    const observe = vi.fn(async () => fresh());
    const resolve = vi.fn(async ({ phase }) => {
      if (phase.branch === 'target_is_native_date_input') {
        return { ok: false, code: 'unique_live_target_not_proven', candidateCount: 0 };
      }
      return uniqueResolution(`${phase.id}-ref`);
    });
    const dispatch = vi.fn(async () => ({ ok: true }));

    const result = await kernel.executeControlAction({
      step: { action: 'Date', target: 'Due date', value: '2027-11-09' },
      observe,
      resolve,
      dispatch,
      prove: async () => ({ matched: true, checked: true, reason: 'date_exact' }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ status: 'pass', reason: 'control_postcondition_matched' });
    expect(dispatch.mock.calls.map(([call]) => call.rawPhase.id)).toEqual([
      'open-calendar',
      'position-calendar',
      'choose-calendar-day',
    ]);
    expect(result.diagnostics.resolutions[0]).toMatchObject({
      phaseId: 'set-native-date',
      candidateCount: 0,
      ambiguous: false,
    });
  });

  it('keeps an ambiguous native Date target blocked', async () => {
    const dispatch = vi.fn();
    const result = await kernel.executeControlAction({
      step: { action: 'Date', target: 'Due date', value: '2027-11-09' },
      observe: async () => fresh(),
      resolve: async () => ({
        ok: false,
        code: 'ambiguous_target',
        candidateCount: 2,
        confidenceMargin: 0,
      }),
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'control_target_ambiguous',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('fails ambiguous control identity closed as QAAI uncertainty and continues independent work', async () => {
    const dispatch = vi.fn();
    const result = await kernel.executeControlAction({
      step: { action: 'Fill', target: 'Display name', value: 'Alice' },
      observe: queueObserver([fresh({ actualValue: '' })]),
      resolve: async () => ({
        ok: false,
        code: 'ambiguous_target',
        candidateCount: 2,
        confidenceMargin: 0,
      }),
      dispatch,
      seal: async () => ({ hasRunnableStep: true, sealed: { continuationOutcome: 'continue' } }),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      outcomeKind: 'qaai_execution_uncertainty',
      errorKind: 'qaai_execution_uncertainty',
      reason: 'control_target_ambiguous',
      terminal: false,
      continuation: { outcome: 'continue', reason: 'independent_runnable_step_available' },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('treats a readable exact postcondition mismatch as a functional failure', async () => {
    const result = await kernel.executeControlAction({
      step: {
        action: 'Fill',
        target: 'Display name',
        value: 'Alice',
        retryPolicy: { maxRetries: 0 },
      },
      observe: queueObserver([
        fresh({ actualValue: '' }),
        fresh({ actualValue: 'Bob' }),
      ]),
      resolve: async () => uniqueResolution(),
      dispatch: async () => ({ ok: true }),
      seal: async () => ({ hasRunnableStep: true }),
    });

    expect(result).toMatchObject({
      status: 'fail',
      outcomeKind: 'functional_failure',
      reason: 'control_postcondition_not_matched',
      actionOutcome: 'failed',
      assertionOutcome: 'not_matched',
      terminal: false,
    });
  });

  it('does not stop descendants when an exact calendar candidate was dispatched and immediate readback is stale', async () => {
    const result = await kernel.executeControlAction({
      step: { action: 'Date', target: 'Early Pickup Date', value: '2026-08-20' },
      plan: {
        kind: 'date',
        target: 'Early Pickup Date',
        phases: [{
          id: 'choose-calendar-day',
          toolName: 'browser_click',
          args: { target: '20' },
          semanticTarget: { kind: 'calendar_day', label: 'August 20, 2026' },
          resolution: { roleHints: ['gridcell', 'button'] },
        }],
        postcondition: { kind: 'date_exact', expected: '2026-08-20' },
        waitContract: { timeoutMs: 500, pollIntervalMs: 1 },
        metadata: {},
      },
      observe: queueObserver([
        fresh({ actualValue: '' }),
        fresh({ actualValue: '' }),
      ]),
      resolve: async () => ({
        ok: true,
        ref: 'day-20',
        candidate: { ref: 'day-20', role: 'gridcell', name: 'August 20, 2026' },
      }),
      dispatch: async () => ({ ok: true }),
      seal: async () => ({ hasRunnableStep: true, sealed: { continuationOutcome: 'continue' } }),
      maxPostconditionObservations: 1,
      maxFreshPostconditionAttempts: 1,
    });

    expect(result).toMatchObject({
      status: 'pass',
      terminal: false,
      reason: 'control_postcondition_matched',
      actionOutcome: 'succeeded',
    });
    expect(result.diagnostics.proofs).toContainEqual(expect.objectContaining({
      phase: 'dispatch_commit',
      reason: 'exact_control_candidate_dispatched_readback_deferred_to_authored_assertion',
    }));
  });

  it('retries a transiently unavailable postcondition observation without repeating the action', async () => {
    const observe = queueObserver([
      fresh({ actualValue: '' }),
      { fresh: false, snapshotText: '' },
      fresh({ actualValue: 'Alice' }),
    ]);
    const dispatch = vi.fn(async () => ({ ok: true }));
    const sleep = vi.fn(async () => {});

    const result = await kernel.executeControlAction({
      step: { action: 'Fill', target: 'Display name', value: 'Alice' },
      observe,
      resolve: async () => uniqueResolution(),
      dispatch,
      sleep,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      status: 'pass',
      reason: 'control_postcondition_matched',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledOnce();
    expect(result.diagnostics.observations.slice(-2)).toEqual([
      expect.objectContaining({ phase: 'postcondition', observationAttempt: 1, fresh: false }),
      expect.objectContaining({ phase: 'postcondition', observationAttempt: 2, fresh: true }),
    ]);
  });

  it('treats a missing fresh observation as execution uncertainty without dispatching', async () => {
    const dispatch = vi.fn();
    const result = await kernel.executeControlAction({
      step: { action: 'Check', target: 'Accept terms' },
      observe: async () => ({ fresh: false, snapshotText: '- checkbox "Accept terms"' }),
      resolve: async () => uniqueResolution('terms-ref'),
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      status: 'blocked',
      outcomeKind: 'qaai_execution_uncertainty',
      reason: 'fresh_control_observation_unavailable',
      actionOutcome: 'not_executed',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('executes typed assertions with matched, not-matched, and uncheckable truth channels', async () => {
    const matched = await kernel.executeTypedAssertion({
      step: { action: 'Verify' },
      assertion: { type: 'TEXT', expectedText: 'Ready', comparator: 'equals' },
      actual: 'Ready',
      seal: async () => ({}),
    });
    const failed = await kernel.executeTypedAssertion({
      step: { action: 'Verify' },
      assertion: { type: 'NUMBER', expectedNumber: 7, comparator: 'equals' },
      actual: 6,
      seal: async () => ({ hasRunnableStep: true }),
    });
    const uncertain = await kernel.executeTypedAssertion({
      step: { action: 'Verify' },
      assertion: { type: 'VISIBLE' },
      observeAssertion: async () => ({ fresh: false, actual: { visible: true } }),
      seal: async () => ({}),
    });

    expect(matched).toMatchObject({ status: 'pass', assertionOutcome: 'matched', actionOutcome: 'succeeded' });
    expect(failed).toMatchObject({ status: 'fail', outcomeKind: 'functional_failure', assertionOutcome: 'not_matched', terminal: false });
    expect(uncertain).toMatchObject({ status: 'blocked', outcomeKind: 'qaai_execution_uncertainty', assertionOutcome: 'uncheckable' });
  });

  it('preserves authored continue-independent policy through strict assertion evaluation', async () => {
    const result = await kernel.executeTypedAssertion({
      step: {
        action: 'Verify',
        failurePolicy: { onAssertionFailure: 'continue_independent' },
      },
      assertion: { type: 'TEXT', expectedText: 'Ready' },
      observeAssertion: async () => fresh({
        actual: 'Not ready',
        channels: [{
          kind: 'dom_visible_text',
          text: 'Not ready',
          visible: true,
          targetMatched: true,
          source: 'playwright_dom',
        }],
      }),
      strictAssertionEvidenceRequired: true,
      seal: async () => ({ hasRunnableStep: true }),
    });

    expect(result).toMatchObject({
      status: 'fail',
      assertionOutcome: 'not_matched',
      terminal: false,
      record: {
        status: 'fail',
        matched: false,
        failurePolicy: {
          classification: 'validation_only',
          onFailure: 'record_and_continue',
          continueExecution: true,
          continueIndependent: true,
          blockDependents: false,
        },
      },
    });
  });

  it('preserves authored dependency policy instead of downgrading strict assertion failures', async () => {
    const result = await kernel.executeTypedAssertion({
      step: {
        action: 'Verify',
        flowCritical: true,
        failurePolicy: { onAssertionFailure: 'block_dependents' },
      },
      assertion: { type: 'TEXT', expectedText: 'Ready' },
      observeAssertion: async () => fresh({
        actual: 'Not ready',
        channels: [{
          kind: 'ax_visible_text',
          value: 'Not ready',
          exposed: true,
          exactTarget: true,
          source: 'cdp_accessibility',
        }],
      }),
      strictAssertionEvidenceRequired: true,
      seal: async () => ({ hasRunnableStep: true }),
    });

    expect(result).toMatchObject({
      status: 'fail',
      assertionOutcome: 'not_matched',
      record: {
        failurePolicy: {
          classification: 'dependency',
          onFailure: 'block_dependents_only',
          continueExecution: true,
          continueIndependent: true,
          blockDependents: true,
          blockCase: false,
          blockRun: false,
        },
      },
    });
  });

  it('delegates Click to the existing generic click executor', async () => {
    const observations = [
      {
        fresh: true,
        snapshotText: '- main "Form"\n  - button "Submit request" [ref=submit-ref]',
        url: 'https://neutral.example/form',
        title: 'Form',
      },
      {
        fresh: true,
        snapshotText: '- main "Complete"\n  - heading "Complete"',
        url: 'https://neutral.example/done',
        title: 'Complete',
      },
    ];
    const result = await kernel.executeUniversalAction({
      step: {
        action: 'Click',
        target: 'Submit request',
        operationCheck: { expectedState: { urlPattern: '/done', titleIncludes: 'Complete' } },
      },
      observe: queueObserver(observations),
      dispatch: async ({ resolution }) => ({ ok: resolution.ref === 'submit-ref' }),
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ family: 'click', status: 'pass', outcomeKind: 'success', terminal: false });
    expect(result.diagnostics.schema).toBe('generic_click_attempt_v1');
  });

  it('routes event actions only through an injected adapter hook', async () => {
    const eventAdapter = {
      execute: vi.fn(async () => ({ status: 'pass', terminal: false, reason: 'download_observed' })),
    };
    const handled = await kernel.executeUniversalAction({
      step: { action: 'Download', target: 'Export' },
      eventAdapter,
    });
    const missing = await kernel.executeUniversalAction({
      step: { action: 'Download', target: 'Export' },
      seal: async () => ({}),
    });

    expect(handled).toMatchObject({ handled: true, family: 'event', status: 'pass' });
    expect(eventAdapter.execute).toHaveBeenCalledOnce();
    expect(missing).toMatchObject({
      family: 'event',
      status: 'blocked',
      outcomeKind: 'qaai_execution_uncertainty',
      reason: 'event_action_adapter_unavailable',
    });
  });

  it('runs WaitForState with stable bounded observations and no dispatch authority', async () => {
    const dispatch = vi.fn();
    const seal = vi.fn(async () => ({}));
    const result = await kernel.executeUniversalAction({
      step: {
        action: 'WaitForState',
        waitContract: { kind: 'stabilization', timeoutMs: 20, pollIntervalMs: 1, stableObservations: 2, expected: { effect: 'fingerprint_stable' } },
      },
      observeWait: async () => ({ fresh: true, fingerprint: { url: 'https://neutral.test/ready', title: 'Ready' } }),
      sleep: async () => {},
      dispatch,
      seal,
    });
    expect(result).toMatchObject({ family: 'wait', status: 'pass', outcomeKind: 'success', assertionOutcome: 'matched' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(seal).toHaveBeenCalledOnce();
    expect(seal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pass',
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
      runtimeToolName: 'internal_wait_for_state',
    }));
  });

  it('keeps a bounded wait timeout advisory while leaving the next concrete action responsible for proof', async () => {
    let clock = 0;
    let read = 0;
    const seal = vi.fn(async () => ({}));
    const result = await kernel.executeUniversalAction({
      step: {
        action: 'WaitForState',
        target: 'destination page',
        waitContract: { kind: 'stabilization', timeoutMs: 2, pollIntervalMs: 1, stableObservations: 2, expected: { effect: 'fingerprint_stable' } },
      },
      observeWait: async () => ({
        fresh: true,
        fingerprint: { url: `https://neutral.test/state-${read++}`, title: 'Changing' },
      }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      seal,
    });

    expect(result).toMatchObject({
      family: 'wait',
      status: 'pass',
      outcomeKind: 'success',
      reason: 'wait_budget_elapsed_continue_to_concrete_step',
      record: { status: 'warning', matched: null, required: false },
      terminal: false,
    });
    expect(seal).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pass',
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_applicable',
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
      runtimeToolName: 'internal_wait_for_state',
    }));
  });

  it('keeps WaitForState advisory when no observation hook is available', async () => {
    const seal = vi.fn(async () => ({}));
    const result = await kernel.executeUniversalAction({
      step: { action: 'WaitForState', target: 'destination page' },
      seal,
    });

    expect(result).toMatchObject({
      family: 'wait',
      status: 'pass',
      reason: 'wait_observer_unavailable_continue_to_concrete_step',
      record: { status: 'warning', required: false },
      terminal: false,
    });
    expect(seal).toHaveBeenCalledWith(expect.objectContaining({
      internalOperationCompletion: true,
      internalOperationKind: 'wait_for_state',
      runtimeToolName: 'internal_wait_for_state',
    }));
  });
});
