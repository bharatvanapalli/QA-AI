import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const dropdownTransaction = require('../../server/services/dropdownTransaction');

function comboboxControl(overrides = {}) {
  const owner = {
    ref: 'equipment-owner',
    backendNodeId: 101,
    role: 'combobox',
    label: 'Equipment',
    visible: true,
    enabled: true,
    attributes: {
      'aria-controls': 'equipment-options',
      'aria-expanded': 'false',
    },
    framePath: ['main'],
    ...overrides.ownerElement,
  };
  return {
    controlType: 'combobox',
    requestedTarget: 'Equipment dropdown',
    ownerElement: owner,
    interactionElement: {
      ...owner,
      ref: 'equipment-trigger',
      backendNodeId: 102,
      label: 'Equipment',
      ...overrides.interactionElement,
    },
    valueElement: {
      ...owner,
      ref: 'equipment-value',
      backendNodeId: 103,
      label: 'Equipment',
      ...overrides.valueElement,
    },
    ...overrides,
  };
}

function option(text, index, overrides = {}) {
  return {
    ref: `option-${index}`,
    backendNodeId: 200 + index,
    role: 'option',
    text,
    value: text,
    visible: true,
    index,
    framePath: ['main'],
    ...overrides,
  };
}

function closedState(control = comboboxControl()) {
  return {
    owner: {
      ...control.ownerElement,
      expanded: false,
    },
    trigger: {
      ...control.interactionElement,
      expanded: false,
    },
    valueNode: control.valueElement,
    popups: [],
  };
}

function openState(options, control = comboboxControl(), popupOverrides = {}) {
  return {
    owner: {
      ...control.ownerElement,
      expanded: true,
      attributes: {
        ...(control.ownerElement.attributes || {}),
        'aria-controls': 'equipment-options',
        'aria-expanded': 'true',
      },
    },
    trigger: {
      ...control.interactionElement,
      expanded: true,
      attributes: {
        ...(control.interactionElement.attributes || {}),
        'aria-controls': 'equipment-options',
        'aria-expanded': 'true',
      },
    },
    valueNode: control.valueElement,
    popup: {
      ref: 'equipment-options',
      backendNodeId: 150,
      role: 'listbox',
      visible: true,
      newlyVisible: true,
      framePath: ['main'],
      options,
      ...popupOverrides,
    },
  };
}

function committedState(value, control = comboboxControl()) {
  return {
    owner: {
      ...control.ownerElement,
      expanded: false,
      displayedValue: value,
      selectedValue: value,
      attributes: {
        ...(control.ownerElement.attributes || {}),
        'aria-expanded': 'false',
      },
    },
    trigger: {
      ...control.interactionElement,
      expanded: false,
    },
    valueNode: {
      ...control.valueElement,
      displayedValue: value,
      value,
    },
    popups: [],
    eventEvidence: {
      type: 'change',
      selectedValue: value,
    },
  };
}

function transactionIdentity() {
  return {
    runId: 'run-choice-1',
    caseId: 'case-choice-1',
    stepId: 'step-choice-1',
    sequenceIndex: 4,
    occurrenceIndex: 0,
    actionOccurrenceId: 'choice-occurrence-1',
  };
}

describe('dropdownTransaction', () => {
  it('runs the universal CLOSED to VALUE_COMMITTED transaction with exactly one open and select dispatch', async () => {
    const control = comboboxControl();
    const options = ['RR', 'LCL', 'LTL', 'TL', 'FCL'].map(option);
    const dispatchOpen = vi.fn(async () => ({ delivered: true, eventId: 'open-event' }));
    const dispatchSelect = vi.fn(async ({ option: selected }) => ({ delivered: true, optionRef: selected.ref }));
    let openObservations = 0;
    let selectionObservations = 0;

    const result = await dropdownTransaction.executeDropdownTransaction({
      ...transactionIdentity(),
      control,
      expectedValue: 'LTL',
      expectedOptions: ['RR', 'LCL', 'LTL', 'TL', 'FCL'],
      dispatchOpen,
      dispatchSelect,
      sleep: async () => {},
      captureState: async ({ phase }) => {
        if (phase === 'before_open') return closedState(control);
        if (phase === 'observe_open') {
          openObservations += 1;
          return openObservations === 1 ? closedState(control) : openState(options, control);
        }
        if (phase === 'before_select') return openState(options, control);
        if (phase === 'observe_select') {
          selectionObservations += 1;
          return selectionObservations === 1 ? openState(options, control) : committedState('LTL', control);
        }
        throw new Error(`unexpected phase ${phase}`);
      },
    });

    expect(result.status).toBe('passed');
    expect(result.shouldContinue).toBe(true);
    expect(result.blockDependents).toBe(false);
    expect(result.stateHistory).toEqual([
      dropdownTransaction.STATES.CLOSED,
      dropdownTransaction.STATES.OPENING,
      dropdownTransaction.STATES.OPEN,
      dropdownTransaction.STATES.SELECTING,
      dropdownTransaction.STATES.VALUE_COMMITTED,
    ]);
    expect(dispatchOpen).toHaveBeenCalledOnce();
    expect(dispatchSelect).toHaveBeenCalledOnce();
    expect(openObservations).toBe(2);
    expect(selectionObservations).toBe(2);
    expect(result.openTransaction.dispatchAttemptCount).toBe(1);
    expect(result.selectionTransaction.dispatchAttemptCount).toBe(1);
    expect(result.selectedOption).toMatchObject({ text: 'LTL', index: 2 });
    expect(result.validations[0]).toMatchObject({
      kind: 'visible_option_order',
      matched: true,
      actual: ['RR', 'LCL', 'LTL', 'TL', 'FCL'],
    });
    expect(result.canonicalEvidence.open).toMatchObject({
      owner: { ref: 'equipment-owner' },
      trigger: { ref: 'equipment-trigger' },
      popup: { ref: 'equipment-options' },
      optionContainer: { ref: 'equipment-options' },
    });
    expect(result.canonicalEvidence.selection).toMatchObject({
      ownerReadback: ['LTL'],
      popupClose: { closed: true },
    });
    expect(result.evidenceLedger.filter((entry) => entry.type === 'dispatch')).toEqual([
      expect.objectContaining({ phase: 'open', attemptStatus: 'attempted' }),
      expect.objectContaining({ phase: 'select', attemptStatus: 'attempted' }),
    ]);
    expect(result.evidenceLedger.filter((entry) => entry.attemptStatus === 'canonical').length).toBeGreaterThan(4);
  });

  it('rejects a visible popup that is unrelated to the requested owner', async () => {
    const control = comboboxControl();
    const dispatchOpen = vi.fn(async () => ({ delivered: true }));
    const dispatchSelect = vi.fn();

    const result = await dropdownTransaction.executeDropdownTransaction({
      ...transactionIdentity(),
      control,
      expectedValue: 'LTL',
      dispatchOpen,
      dispatchSelect,
      maxOpenObservations: 3,
      sleep: async () => {},
      captureState: async ({ phase }) => {
        if (phase === 'before_open') return closedState(control);
        return {
          owner: { ...control.ownerElement, expanded: true },
          trigger: { ...control.interactionElement, expanded: true },
          popup: {
            ref: 'notifications-menu',
            role: 'menu',
            visible: true,
            newlyVisible: true,
            ownerRef: 'header-notifications',
            framePath: ['main'],
            options: [option('Alert', 0)],
          },
        };
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('visible_popup_unrelated_to_dropdown_owner');
    expect(result.stateHistory).toEqual([
      dropdownTransaction.STATES.CLOSED,
      dropdownTransaction.STATES.OPENING,
    ]);
    expect(dispatchOpen).toHaveBeenCalledOnce();
    expect(dispatchSelect).not.toHaveBeenCalled();
  });

  it('supports autocomplete contains selection while retaining option-order mismatch as non-blocking validation evidence', async () => {
    const control = comboboxControl({
      controlType: 'autocomplete',
      requestedTarget: 'Time zone',
      ownerElement: {
        ref: 'timezone-owner',
        backendNodeId: 301,
        role: 'combobox',
        label: 'Time zone',
        visible: true,
        enabled: true,
        attributes: { 'aria-autocomplete': 'list' },
        framePath: ['main'],
      },
      interactionElement: {
        ref: 'timezone-owner',
        backendNodeId: 301,
        role: 'combobox',
        label: 'Time zone',
        visible: true,
        enabled: true,
        attributes: { 'aria-autocomplete': 'list' },
        framePath: ['main'],
      },
      valueElement: {
        ref: 'timezone-owner',
        backendNodeId: 301,
        role: 'combobox',
        label: 'Time zone',
        visible: true,
        enabled: true,
        framePath: ['main'],
      },
      popupElement: {
        ref: 'timezone-options',
        backendNodeId: 302,
        role: 'listbox',
        label: 'Time zone options',
        visible: false,
        framePath: ['main'],
      },
    });
    const options = [option('Eastern Time', 0), option('Central Standard Time', 1)];
    const open = {
      owner: { ...control.ownerElement, expanded: true },
      trigger: { ...control.interactionElement, expanded: true },
      popup: {
        ref: 'timezone-options',
        backendNodeId: 302,
        role: 'listbox',
        visible: true,
        newlyVisible: true,
        framePath: ['main'],
        options,
      },
    };

    const result = await dropdownTransaction.executeDropdownTransaction({
      ...transactionIdentity(),
      control,
      expectedValue: 'Central',
      matchMode: 'contains',
      expectedOptions: ['Central Standard Time', 'Eastern Time'],
      dispatchOpen: vi.fn(async () => ({ delivered: true })),
      dispatchSelect: vi.fn(async () => ({ delivered: true })),
      sleep: async () => {},
      captureState: async ({ phase }) => {
        if (phase === 'before_open') return closedState(control);
        if (phase === 'observe_open' || phase === 'before_select') return open;
        return committedState('Central Standard Time', control);
      },
    });

    expect(result.status).toBe('completed_with_validation_failures');
    expect(result.shouldContinue).toBe(true);
    expect(result.blockDependents).toBe(false);
    expect(result.selectedOption.text).toBe('Central Standard Time');
    expect(result.validationFailures).toEqual([
      expect.objectContaining({ reason: 'visible_option_order_mismatch', matched: false }),
    ]);
  });

  it('does not dispatch selection when a contains request is ambiguous', async () => {
    const control = comboboxControl();
    const options = [option('Central Standard Time', 0), option('Central Daylight Time', 1)];
    const dispatchSelect = vi.fn();

    const result = await dropdownTransaction.executeDropdownTransaction({
      ...transactionIdentity(),
      control,
      expectedValue: 'Central',
      matchMode: 'contains',
      dispatchOpen: vi.fn(async () => ({ delivered: true })),
      dispatchSelect,
      sleep: async () => {},
      captureState: async ({ phase }) => (
        phase === 'before_open' ? closedState(control) : openState(options, control)
      ),
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('requested_option_ambiguous');
    expect(result.state).toBe(dropdownTransaction.STATES.OPEN);
    expect(dispatchSelect).not.toHaveBeenCalled();
  });

  it('supports native select through the same exactly-once transaction contract', async () => {
    const owner = {
      ref: 'priority-select',
      backendNodeId: 401,
      tag: 'select',
      role: 'combobox',
      label: 'Priority',
      visible: true,
      enabled: true,
      framePath: ['main'],
    };
    const control = {
      controlType: 'native_select',
      requestedTarget: 'Priority',
      ownerElement: owner,
      interactionElement: owner,
      valueElement: owner,
    };
    const options = [option('Low', 0), option('Medium', 1), option('High', 2)];
    const dispatchOpen = vi.fn(async () => ({ delivered: true }));
    const dispatchSelect = vi.fn(async () => ({ delivered: true }));

    const result = await dropdownTransaction.executeDropdownTransaction({
      ...transactionIdentity(),
      control,
      expectedValue: 'High',
      expectedOptions: ['Low', 'Medium', 'High'],
      dispatchOpen,
      dispatchSelect,
      sleep: async () => {},
      captureState: async ({ phase }) => {
        if (phase === 'before_open') return { owner, valueNode: owner };
        if (phase === 'observe_open' || phase === 'before_select') {
          return { owner, valueNode: owner, nativeSelectReady: true, visibleOptions: options };
        }
        return {
          owner: { ...owner, selectedValue: 'High', displayedValue: 'High' },
          valueNode: { ...owner, value: 'High', selectedValue: 'High' },
          visibleOptions: options,
        };
      },
    });

    expect(result.status).toBe('passed');
    expect(result.control.controlAdapter.id).toBe('native-select-v1');
    expect(dispatchOpen).toHaveBeenCalledOnce();
    expect(dispatchSelect).toHaveBeenCalledOnce();
    expect(result.canonicalEvidence.selection.popupClose).toEqual({
      closed: true,
      reason: 'native_select_has_no_dom_popup_requirement',
    });
  });

  it('does not repeat selection when owner readback succeeds but the popup close is not proven', async () => {
    const control = comboboxControl();
    const options = ['RR', 'LTL'].map(option);
    const dispatchSelect = vi.fn(async () => ({ delivered: true }));

    const result = await dropdownTransaction.executeDropdownTransaction({
      ...transactionIdentity(),
      control,
      expectedValue: 'LTL',
      dispatchOpen: vi.fn(async () => ({ delivered: true })),
      dispatchSelect,
      maxSelectObservations: 3,
      sleep: async () => {},
      captureState: async ({ phase }) => {
        if (phase === 'before_open') return closedState(control);
        if (phase === 'observe_open' || phase === 'before_select') return openState(options, control);
        const state = openState(options, control);
        state.owner.displayedValue = 'LTL';
        state.owner.selectedValue = 'LTL';
        state.valueNode = { ...control.valueElement, value: 'LTL', displayedValue: 'LTL' };
        return state;
      },
    });

    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('correlated_popup_still_visible');
    expect(dispatchSelect).toHaveBeenCalledOnce();
    expect(result.selectionTransaction.dispatchAttemptCount).toBe(1);
    expect(result.selectionTransaction.observations).toHaveLength(3);
  });

  it('accepts a declared popup that becomes visible without fabricating an unrelated relationship', () => {
    const control = dropdownTransaction.createDropdownControl({
      control: comboboxControl({
        popupElement: {
          ref: 'city-options',
          backendNodeId: 502,
          role: 'listbox',
          label: 'City options',
          visible: false,
          framePath: ['main'],
        },
      }),
      expectedValue: 'North',
    });
    const proof = dropdownTransaction.proveOpen(
      control,
      closedState(control),
      {
        owner: { ...control.ownerElement, expanded: true, attributes: {} },
        trigger: { ...control.interactionElement, expanded: true, attributes: {} },
        popup: {
          ref: 'city-options',
          backendNodeId: 502,
          role: 'listbox',
          visible: true,
          newlyVisible: true,
          framePath: ['main'],
          options: [option('North', 0)],
        },
      },
    );

    expect(proof).toMatchObject({
      matched: true,
      reason: 'aria_expanded_and_popup_correlated',
      evidence: {
        popup: { ref: 'city-options' },
        correlation: { reason: 'declared_popup_became_visible' },
      },
    });
  });
});
