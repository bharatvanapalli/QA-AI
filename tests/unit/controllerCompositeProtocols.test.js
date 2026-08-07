import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const protocol = require('../../server/services/controllerCompositeProtocols');

function operation(overrides = {}) {
  return {
    operationId: 'action:order:equipment',
    actionOccurrenceId: 'occurrence:action:order:equipment:1',
    type: 'Select',
    selection: { kind: 'exact_text', value: 'Dry Van' },
    ...overrides,
  };
}

describe('controller composite protocols', () => {
  it('requires owner popup option and owner-readback phases for dropdowns', () => {
    const value = protocol.createDropdownProtocol({
      operation: operation(),
      ownerRef: 'equipment-owner',
    });
    expect(value.phases.map((phaseValue) => phaseValue.phaseId)).toEqual([
      'owner-ready',
      'open-owner',
      'popup-associated',
      'option-resolved',
      'select-option',
      'owner-readback',
    ]);
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'open-owner'))
      .toMatchObject({ skipWhenClaim: 'associated_popup_open' });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'popup-associated').commitEligible)
      .toBe(false);
    expect(value.phases.at(-1)).toMatchObject({
      requiredClaim: 'owner_state_committed',
      commitEligible: true,
    });
  });

  it('keeps virtualized custom option discovery and selection in one mutation', () => {
    const value = protocol.createDropdownProtocol({
      operation: operation({
        operationId: 'action:order:timezone',
        actionOccurrenceId: 'occurrence:action:order:timezone:1',
        value: 'Central',
        selection: { kind: 'exact_text', value: 'Central' },
        targetIdentity: { accessibleName: 'Pickup Time Zone', role: 'combobox' },
      }),
      ownerRef: 'timezone-owner',
      triggerRef: 'timezone-trigger',
      atomicSelection: true,
    });

    expect(value.phases.map((phaseValue) => phaseValue.phaseId)).toEqual([
      'owner-ready',
      'select-option',
      'owner-readback',
    ]);
    expect(value.metadata.atomicVirtualizedSelection).toBe(true);
    expect(value.phases[1]).toMatchObject({
      kind: 'MUTATION',
      requiredClaim: 'exact_option_selected',
      skipWhenClaim: 'owner_state_committed',
      semanticAcknowledgmentClaim: 'exact_option_selected',
      dynamicCandidate: null,
      mutation: {
        toolName: 'browser_evaluate',
        args: { target: 'timezone-owner' },
      },
    });
    expect(value.phases[1].mutation.args.function).toContain('virtualized_selection_semantic_ambiguous');
    expect(value.phases[2]).toMatchObject({
      acceptSemanticAcknowledgmentClaim: 'exact_option_selected',
      observationAttempts: 1,
    });
  });

  it('enforces calendar year month day and owner-readback order', () => {
    const value = protocol.createCalendarProtocol({
      operation: operation({
        operationId: 'action:order:ship-date',
        actionOccurrenceId: 'occurrence:action:order:ship-date:1',
        type: 'Date',
        value: '2026-08-20',
        selection: null,
        targetIdentity: {
          accessibleName: 'Ship Date',
          role: 'combobox',
        },
      }),
      ownerRef: 'ship-date-owner',
    });
    expect(value.metadata).toMatchObject({
      year: '2026',
      month: '08',
      day: '20',
    });
    expect(value.phases.map((phaseValue) => phaseValue.phaseId)).toEqual([
      'owner-ready',
      'open-owner',
      'popup-associated',
      'open-year-picker',
      'choose-year',
      'year-committed',
      'open-month-picker',
      'choose-month',
      'month-committed',
      'choose-day',
      'commit-date',
      'owner-readback',
    ]);
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'choose-year'))
      .toMatchObject({ mutation: { toolName: 'browser_evaluate' } });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'open-year-picker'))
      .toMatchObject({ mutation: { toolName: 'browser_evaluate' } });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'open-month-picker'))
      .toMatchObject({ mutation: { toolName: 'browser_evaluate' } });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'choose-month'))
      .toMatchObject({ mutation: { toolName: 'browser_evaluate' } });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'choose-day'))
      .toMatchObject({ mutation: { toolName: 'browser_evaluate' } });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'commit-date'))
      .toMatchObject({ mutation: { toolName: 'browser_evaluate' } });
  });

  it('normalizes equivalent 12-hour and 24-hour time options', () => {
    expect(protocol.normalizeTime('09:00 AM')).toBe('09:00');
    expect(protocol.normalizeTime('21:05')).toBe('21:05');
    expect(protocol.resolveExactOptionCandidate({
      selection: { kind: 'exact_text', value: '09:00 AM' },
      valueKind: 'time',
      owner: { ref: 'time-owner' },
      candidates: [{
        label: '09:00',
        ownerRef: 'time-owner',
        ref: 'time-option-9',
        actionable: true,
      }],
    })).toMatchObject({
      status: protocol.OPTION_RESOLUTION_STATUS.RESOLVED,
      candidate: { ref: 'time-option-9' },
    });
  });

  it('uses one bound bounded virtualized transaction for time options', () => {
    const value = protocol.createTimeProtocol({
      operation: operation({
        operationId: 'action:order:pickup-time',
        actionOccurrenceId: 'occurrence:action:order:pickup-time:1',
        type: 'Time',
        value: '09:00 AM',
        selection: null,
        targetIdentity: {
          accessibleName: 'Early Pickup Time',
          role: 'combobox',
        },
      }),
      ownerRef: 'pickup-time-owner',
      ownerAccessibleName: 'Select Time',
    });

    expect(value.phases.map((phaseValue) => phaseValue.phaseId)).toEqual([
      'owner-ready',
      'select-time-option',
      'owner-readback',
    ]);
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'select-time-option'))
      .toMatchObject({
        kind: 'MUTATION',
        requiredClaim: 'exact_time_selected',
        skipWhenClaim: 'normalized_time_owner_value',
        dynamicCandidate: null,
        mutation: {
          toolName: 'browser_evaluate',
          args: {
            target: 'pickup-time-owner',
            element: 'Select Time',
            function: expect.stringContaining('"maxScrolls":12'),
          },
        },
      });
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'select-time-option')
      .mutation.args.function).toContain('"revealOnly":false');
    expect(value.phases.find((phaseValue) => phaseValue.phaseId === 'select-time-option')
      .mutation.args.function).toContain('popupOpenedByTransaction');
  });

  it('does not guess between partial timezone candidates', () => {
    expect(protocol.resolveExactOptionCandidate({
      selection: { kind: 'exact_text', value: 'Central' },
      owner: { ref: 'timezone-owner' },
      candidates: [{
        label: 'Central Standard Time',
        ownerRef: 'timezone-owner',
        ref: 'cst',
      }, {
        label: 'Central Daylight Time',
        ownerRef: 'timezone-owner',
        ref: 'cdt',
      }],
    })).toMatchObject({
      status: protocol.OPTION_RESOLUTION_STATUS.NOT_FOUND,
      candidate: null,
      mayObserveMore: true,
    });
  });

  it('never creates a mutation directive without an exact dynamic candidate', () => {
    const value = protocol.createDropdownProtocol({
      operation: operation(),
      ownerRef: 'equipment-owner',
    });
    const optionMutation = protocol.protocolDirective(value, 4, {});
    expect(optionMutation).toMatchObject({
      status: protocol.DIRECTIVE_STATUS.RESOLVE_EXACT_CANDIDATE,
      mutation: null,
    });
  });
});
