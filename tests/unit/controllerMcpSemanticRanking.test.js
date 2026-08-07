import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  candidateForOperation,
  dedupeCandidates,
  diagnosticCandidatesForOperation,
  evaluatePayload,
  interactionTriggerHints,
  proposeTargetRecoveryFromSnapshot,
  rankSemanticCandidates,
  structuralExcerpt,
  structuralLabelHints,
  structuralScopeHints,
} = require('../../server/services/controllerMcpRuntimeAdapter');
const {
  RESOLUTION_STATUS,
} = require('../../server/services/browserTransactionController');

function operation(overrides = {}) {
  return {
    type: 'Click',
    targetIdentity: {
      accessibleName: 'Orders',
      role: null,
      form: null,
      section: null,
    },
    targetAliases: [],
    operationCheck: {
      kind: 'menu_opened',
    },
    ...overrides,
  };
}

describe('controller MCP semantic candidate ranking', () => {
  it('parses a JSON-stringified browser evaluate acknowledgment', () => {
    const payload = evaluatePayload({
      content: [{
        type: 'text',
        text: '### Result\n"{\\"ok\\":true,\\"value\\":\\"08/20/2026\\"}"\n### Ran Playwright code',
      }],
    });

    expect(payload).toEqual({ ok: true, value: '08/20/2026' });
  });

  it('uses authored popup intent to choose the expandable control instead of an equally named link', () => {
    const result = candidateForOperation(operation(), [{
      ref: 'orders-link',
      role: 'link',
      accessibleName: 'Orders',
      stability: 92,
    }, {
      ref: 'orders-button',
      role: 'button',
      accessibleName: 'Orders',
      stability: 92,
    }]);

    expect(result).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'orders-button',
      },
    });
  });

  it('keeps an exact combobox owner eligible for a menu-opening click', () => {
    const result = candidateForOperation(operation({
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Equipment dropdown',
      },
      targetAliases: ['Open the Equipment dropdown.'],
      operationCheck: {
        kind: 'menu_opened',
      },
    }), [{
      ref: 'section-button',
      role: 'button',
      accessibleName: 'General Information Order identifiers, organization, equipment, and references',
      semanticNames: ['General Information Order identifiers, organization, equipment, and references'],
      stability: 92,
    }, {
      ref: 'equipment-trigger',
      role: 'button',
      accessibleName: null,
      semanticNames: ['General Information Order identifiers, organization, equipment, and references'],
      stability: 92,
    }, {
      ref: 'equipment-owner',
      role: 'combobox',
      accessibleName: 'Equipment *',
      semanticNames: ['Equipment *', 'General Information Order identifiers, organization, equipment, and references'],
      stability: 92,
    }]);

    expect(result).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'equipment-owner',
      },
    });
  });

  it('rejects a nearby checkable control for a menu-opening click even when its container text matches', () => {
    const result = candidateForOperation(operation({
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Scheduled Date calendar',
      },
      targetAliases: ['Open the Scheduled Date calendar.'],
      operationCheck: {
        kind: 'menu_opened',
      },
    }), [{
      ref: 'appointment-toggle',
      role: 'checkbox',
      accessibleName: 'Appointment',
      semanticNames: ['Appointment', 'Scheduled Date and Time'],
      scopeLabels: ['Planning', 'Scheduled Date and Time'],
      stability: 99,
    }, {
      ref: 'scheduled-date-trigger',
      role: 'button',
      accessibleName: 'Choose date',
      semanticNames: ['Choose date', 'Scheduled Date and Time'],
      scopeLabels: ['Planning', 'Scheduled Date and Time'],
      stability: 92,
    }]);

    expect(result).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'scheduled-date-trigger',
      },
    });
  });

  it('does not treat container text as permission to use a checkbox as a popup owner', () => {
    expect(candidateForOperation(operation({
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Scheduled Date calendar',
      },
      targetAliases: ['Open the Scheduled Date calendar.'],
      operationCheck: {
        kind: 'menu_opened',
      },
    }), [{
      ref: 'appointment-toggle',
      role: 'checkbox',
      accessibleName: 'Appointment',
      semanticNames: ['Appointment', 'Scheduled Date and Time'],
      scopeLabels: ['Planning', 'Scheduled Date and Time'],
      stability: 99,
    }])).toMatchObject({
      status: RESOLUTION_STATUS.NOT_FOUND,
    });
  });

  it('keeps an exact authored name above broader role-favored partial names', () => {
    const result = candidateForOperation(operation(), [{
      ref: 'orders-link',
      role: 'link',
      accessibleName: 'Orders',
      stability: 92,
    }, {
      ref: 'orders-dashboard-button',
      role: 'button',
      accessibleName: 'Go to Orders',
      stability: 92,
    }, {
      ref: 'create-order-dashboard-button',
      role: 'button',
      accessibleName: 'Go to Create a New Order',
      stability: 92,
    }]);

    expect(result).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'orders-link',
      },
    });
  });

  it('prefers an exact semantic field name over a broader partial match', () => {
    const ranked = rankSemanticCandidates(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
      operationCheck: {
        kind: 'input_accepted',
      },
    }), [{
      ref: 'exact-order-number',
      role: 'textbox',
      accessibleName: 'Order Number',
      stability: 92,
    }, {
      ref: 'order-reference',
      role: 'textbox',
      accessibleName: 'Order Reference Number',
      stability: 92,
    }]);

    expect(ranked.map(({ candidate }) => candidate.ref)).toEqual([
      'exact-order-number',
      'order-reference',
    ]);
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(45);
  });

  it('keeps indistinguishable exact controls ambiguous instead of guessing by ref order', () => {
    const result = candidateForOperation(operation(), [{
      ref: 'orders-a',
      role: 'button',
      accessibleName: 'Orders',
      stability: 92,
    }, {
      ref: 'orders-b',
      role: 'button',
      accessibleName: 'Orders',
      stability: 92,
    }]);

    expect(result).toMatchObject({
      status: RESOLUTION_STATUS.AMBIGUOUS,
    });
    expect(result.candidates).toHaveLength(2);
  });

  it('retains grouping context when a higher-stability candidate shares the same browser ref', () => {
    const candidates = dedupeCandidates([
      '- group "Equipment"',
      '  - combobox "-- Select --" [ref=e20]',
    ].join('\n'), 'epoch-1');

    expect(candidates).toEqual([
      expect.objectContaining({
        ref: 'e20',
        accessibleName: '-- Select --',
        section: 'Equipment',
        semanticNames: expect.arrayContaining(['-- Select --', 'Equipment']),
      }),
    ]);
    expect(candidateForOperation(operation({
      type: 'Select',
      targetIdentity: {
        accessibleName: 'Equipment dropdown',
      },
      operationCheck: {
        kind: 'control_state',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e20',
      },
    });
  });

  it('retains placeholder semantics for an otherwise unnamed input owner', () => {
    const candidates = dedupeCandidates(
      '- textbox [ref=e41] [placeholder="Order Number"]',
      'epoch-1',
    );

    expect(candidates).toEqual([
      expect.objectContaining({
        ref: 'e41',
        role: 'textbox',
        accessibleName: null,
        semanticNames: expect.arrayContaining(['Order Number']),
      }),
    ]);
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
      operationCheck: {
        kind: 'input_accepted',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e41',
      },
    });
  });

  it('augments a prompt-named owner with its exact visible structural label without contaminating sibling fields', () => {
    const snapshot = [
      '- region "General Information Order identifiers, organization, equipment, and references" [ref=e1557]:',
      '  - generic [ref=e1559]:',
      '    - generic [ref=e1560]:',
      '      - generic [ref=e1562]:',
      '        - generic [ref=e1564]:',
      '          - text: Order Number',
      '          - textbox "Enter an ID" [ref=e1570]',
      '          - paragraph [ref=e1571]: Auto-generated if left blank.',
      '        - generic [ref=e1573]:',
      '          - generic [ref=e1574]: Owning Organization *',
      '          - generic [ref=e1577]:',
      '            - combobox "Owning Organization *" [ref=e1578]',
      '            - button [ref=e1579]',
      '        - generic [ref=e1584]:',
      '          - generic [ref=e1585]: Equipment *',
      '          - generic [ref=e1588]:',
      '            - combobox "Equipment *" [ref=e1589]',
      '            - button [ref=e1590]',
    ].join('\n');

    const hints = structuralLabelHints(snapshot);
    expect(hints.get('e1570')).toEqual(['Order Number']);
    expect(hints.has('e1579')).toBe(false);
    expect(hints.has('e1590')).toBe(false);
    const candidates = dedupeCandidates(snapshot, 'epoch-1');
    const orderOwner = candidates.find(({ ref }) => ref === 'e1570');
    expect(orderOwner).toMatchObject({
      ref: 'e1570',
      accessibleName: 'Enter an ID',
      role: 'textbox',
      section: 'General Information Order identifiers, organization, equipment, and references',
      semanticNames: expect.arrayContaining(['Enter an ID', 'Order Number']),
    });
    expect(orderOwner.semanticNames).not.toContain('Auto-generated if left blank.');
    expect(orderOwner.semanticNames).not.toContain('Owning Organization *');
    expect(orderOwner.semanticNames).not.toContain('Equipment *');
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
        role: 'textbox',
      },
      operationCheck: {
        kind: 'input_accepted',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e1570',
      },
    });
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Owning Organization field',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e1578',
        interactionRef: 'e1579',
      },
    });
    expect(candidateForOperation(operation({
      type: 'Select',
      targetIdentity: {
        accessibleName: 'Equipment dropdown',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e1589',
        interactionRef: 'e1590',
      },
    });
  });

  it('does not augment a distinctly named owner with an unrelated structural label', () => {
    const snapshot = [
      '- group "General Information"',
      '  - text: Order Number',
      '  - textbox "Customer Reference" [ref=e42] [placeholder="Enter an ID"]',
    ].join('\n');

    expect(structuralLabelHints(snapshot).has('e42')).toBe(false);
    expect(dedupeCandidates(snapshot, 'epoch-1')[0]).toMatchObject({
      ref: 'e42',
      semanticNames: ['Customer Reference', 'Enter an ID', 'General Information'],
    });
  });

  it('prefers the unique named dropdown trigger and rejects a sibling clear action', () => {
    const snapshot = [
      '- generic [ref=field-shell]:',
      '  - combobox "Delivery Method" [ref=delivery-owner]',
      '  - button "Clear Delivery Method" [ref=delivery-clear]',
      '  - button "dropdown trigger" [ref=delivery-trigger]',
    ].join('\n');

    expect(interactionTriggerHints(snapshot).get('delivery-owner')).toBe('delivery-trigger');
    expect(dedupeCandidates(snapshot, 'epoch-1')[0]).toMatchObject({
      ref: 'delivery-owner',
      interactionRef: 'delivery-trigger',
    });
  });

  it('does not guess when an owner has multiple unnamed sibling buttons', () => {
    const snapshot = [
      '- generic [ref=field-shell]:',
      '  - combobox "Delivery Method" [ref=delivery-owner]',
      '  - button [ref=delivery-action-one]',
      '  - button [ref=delivery-action-two]',
    ].join('\n');

    expect(interactionTriggerHints(snapshot).has('delivery-owner')).toBe(false);
    expect(dedupeCandidates(snapshot, 'epoch-1')[0]).toMatchObject({
      ref: 'delivery-owner',
      interactionRef: null,
    });
  });

  it('binds repeated time and time-zone controls to their local label and temporal group', () => {
    const snapshot = [
      '- group "Planning Date/Time" [ref=planning]:',
      '  - combobox "Early Pickup Date and Time" [ref=ship-mode]',
      '  - generic [ref=early-pickup]:',
      '    - generic [ref=early-pickup-title]: Early Pickup Date and Time',
      '    - generic [ref=early-pickup-time-field]:',
      '      - generic [ref=early-pickup-time-label]: Time',
      '      - combobox "Select Time" [ref=early-pickup-time]',
      '    - generic [ref=early-pickup-zone-field]:',
      '      - generic [ref=early-pickup-zone-label]: Time Zone',
      '      - combobox "Select Timezone" [ref=early-pickup-zone]',
      '  - generic [ref=late-delivery]:',
      '    - generic [ref=late-delivery-title]: Late Delivery Date and Time',
      '    - generic [ref=late-delivery-time-field]:',
      '      - generic [ref=late-delivery-time-label]: Time',
      '      - combobox "Select Time" [ref=late-delivery-time]',
      '    - generic [ref=late-delivery-zone-field]:',
      '      - generic [ref=late-delivery-zone-label]: Time Zone',
      '      - combobox "Select Timezone" [ref=late-delivery-zone]',
    ].join('\n');
    const candidates = dedupeCandidates(snapshot, 'epoch-1');

    expect(structuralScopeHints(snapshot).get('early-pickup-zone')).toEqual([
      'Planning Date/Time',
      'Early Pickup Date and Time',
      'Time Zone',
    ]);
    expect(candidateForOperation(operation({
      type: 'Select',
      targetIdentity: {
        accessibleName: 'Early Pickup Time Zone dropdown',
      },
      operationCheck: {
        kind: 'control_state',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'early-pickup-zone',
      },
    });
    expect(candidateForOperation(operation({
      type: 'Select',
      targetIdentity: {
        accessibleName: 'Late Delivery Time Zone dropdown',
      },
      operationCheck: {
        kind: 'control_state',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'late-delivery-zone',
      },
    });
  });

  it('uses a temporal control own identity before a generic ancestor date-time heading', () => {
    const snapshot = [
      '- region "Scheduling" [ref=scheduling]:',
      '  - generic "Planning Date/Time" [ref=planning]:',
      '    - generic [ref=requested-start]:',
      '      - generic [ref=requested-start-title]: Requested Start Date and Time',
      '      - checkbox "Appointment" [ref=requested-start-appointment]',
      '      - generic [ref=requested-start-date-field]:',
      '        - generic [ref=requested-start-date-label]: Date',
      '        - combobox "Requested Start Date and Time" [ref=requested-start-date]',
      '    - generic [ref=requested-finish]:',
      '      - generic [ref=requested-finish-title]: Requested Finish Date and Time',
      '      - combobox "Requested Finish Date and Time" [ref=requested-finish-date]',
    ].join('\n');

    expect(candidateForOperation(operation({
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Requested Start Date calendar',
      },
      targetAliases: ['Open the Requested Start Date calendar.'],
      operationCheck: {
        kind: 'menu_opened',
      },
    }), dedupeCandidates(snapshot, 'epoch-temporal-owner'))).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'requested-start-date',
        role: 'combobox',
      },
    });
  });

  it('keeps a value-named time owner bound to a sibling group header', () => {
    const snapshot = [
      '- region "Scheduling" [ref=scheduling]:',
      '  - generic "Planning Date/Time" [ref=planning]:',
      '    - generic [ref=requested-start-group]:',
      '      - generic [ref=requested-start-header]:',
      '        - generic [ref=requested-start-title]: Requested Start Date and Time',
      '        - checkbox "Appointment" [ref=requested-start-appointment]',
      '      - generic [ref=requested-start-controls]:',
      '        - generic [ref=requested-start-date-field]:',
      '          - generic [ref=requested-start-date-label]: Date',
      '          - combobox "Requested Start Date and Time" [ref=requested-start-date]: 08/20/2026',
      '        - generic [ref=requested-start-time-field]:',
      '          - generic [ref=requested-start-time-label]: Time',
      '          - generic [ref=requested-start-time-owner]:',
      '            - combobox "00:00" [ref=requested-start-time]',
      '            - button "dropdown trigger" [ref=requested-start-time-trigger]',
      '    - generic [ref=requested-finish-group]:',
      '      - generic [ref=requested-finish-header]:',
      '        - generic [ref=requested-finish-title]: Requested Finish Date and Time',
      '      - generic [ref=requested-finish-controls]:',
      '        - generic [ref=requested-finish-time-field]:',
      '          - generic [ref=requested-finish-time-label]: Time',
      '          - generic [ref=requested-finish-time-owner]:',
      '            - combobox "00:00" [ref=requested-finish-time]',
      '            - button "dropdown trigger" [ref=requested-finish-time-trigger]',
    ].join('\n');

    expect(candidateForOperation(operation({
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Requested Start Time dropdown',
      },
      operationCheck: {
        kind: 'menu_opened',
      },
    }), dedupeCandidates(snapshot, 'epoch-value-owner'))).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'requested-start-time',
        interactionRef: 'requested-start-time-trigger',
      },
    });
  });

  it('keeps a selected-value timezone owner bound to its repeated temporal group', () => {
    const snapshot = [
      '- generic "Planning Date/Time" [ref=planning]:',
      '  - generic [ref=pickup-column]:',
      '    - generic [ref=early-pickup-group]:',
      '      - generic [ref=early-pickup-title]: Early Pickup Date and Time',
      '      - generic [ref=early-pickup-controls]:',
      '        - generic [ref=early-pickup-zone-field]:',
      '          - generic [ref=early-pickup-zone-label]: Time Zone',
      '          - generic [ref=early-pickup-zone-shell]:',
      '            - combobox "(UTC-06:00) US/Central" [ref=early-pickup-zone]',
      '            - button "dropdown trigger" [ref=early-pickup-zone-trigger]',
      '    - generic [ref=late-pickup-group]:',
      '      - generic [ref=late-pickup-title]: Late Pickup Date and Time',
      '      - generic [ref=late-pickup-controls]:',
      '        - generic [ref=late-pickup-time-field]:',
      '          - generic [ref=late-pickup-time-label]: Time*',
      '          - generic [ref=late-pickup-time-shell]:',
      '            - combobox "11:00" [ref=late-pickup-time]',
      '            - button "dropdown trigger" [ref=late-pickup-time-trigger]',
      '        - generic [ref=late-pickup-zone-field]:',
      '          - generic [ref=late-pickup-zone-label]: Time Zone *',
      '          - generic [ref=late-pickup-zone-shell]:',
      '            - combobox "(UTC-06:00) US/Central" [ref=late-pickup-zone]',
      '            - button "dropdown trigger" [ref=late-pickup-zone-trigger]',
      '  - generic [ref=delivery-column]:',
      '    - generic [ref=late-delivery-group]:',
      '      - generic [ref=late-delivery-title]: Late Delivery Date and Time',
      '      - generic [ref=late-delivery-controls]:',
      '        - generic [ref=late-delivery-zone-field]:',
      '          - generic [ref=late-delivery-zone-label]: Time Zone',
      '          - generic [ref=late-delivery-zone-shell]:',
      '            - combobox "Select Timezone" [ref=late-delivery-zone]',
      '            - button "dropdown trigger" [ref=late-delivery-zone-trigger]',
    ].join('\n');
    const candidates = dedupeCandidates(snapshot, 'epoch-selected-zone');

    expect(structuralLabelHints(snapshot).get('late-pickup-zone')).toEqual(['Time Zone *']);
    expect(candidateForOperation(operation({
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Late Pickup Time Zone dropdown',
      },
      operationCheck: {
        kind: 'menu_opened',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'late-pickup-zone',
        interactionRef: 'late-pickup-zone-trigger',
      },
    });
  });

  it('does not propagate an ordinary sibling heading into unrelated controls', () => {
    const snapshot = [
      '- generic [ref=page]:',
      '  - generic [ref=header-row]:',
      '    - generic [ref=dashboard-title]: Dashboard Overview',
      '  - generic [ref=content-row]:',
      '    - button "Open Orders" [ref=open-orders]',
      '    - button "Edit View" [ref=edit-view]',
    ].join('\n');

    expect(structuralScopeHints(snapshot).get('edit-view') || []).not.toContain('Dashboard Overview');
  });

  it('resolves every repeated temporal facet to its exact local owner and rejects cross-owner refs', () => {
    const section = 'Pickup and Delivery Shipper, Consignee, and Planning Dates';
    const snapshot = [
      `- region "${section}" [ref=planning-region]:`,
      '  - generic "Planning Date/Time" [ref=planning]:',
      '    - generic [ref=early-row]:',
      '      - generic [ref=early-pickup]:',
      '        - generic [ref=early-pickup-title]: Early Pickup Date and Time',
      '        - generic [ref=early-pickup-date-field]:',
      '          - generic [ref=early-pickup-date-label]: Date',
      '          - combobox "Early Pickup Date and Time" [ref=early-pickup-date]',
      '        - generic [ref=early-pickup-time-field]:',
      '          - generic [ref=early-pickup-time-label]: Time',
      '          - generic [ref=early-pickup-time-owner]:',
      '            - combobox "Select Time" [ref=early-pickup-time]',
      '            - button "dropdown trigger" [ref=early-pickup-time-trigger]',
      '        - generic [ref=early-pickup-zone-field]:',
      '          - generic [ref=early-pickup-zone-label]: Time Zone',
      '          - generic [ref=early-pickup-zone-owner]:',
      '            - combobox "Select Timezone" [ref=early-pickup-zone]',
      '            - button "dropdown trigger" [ref=early-pickup-zone-trigger]',
      '      - generic [ref=early-delivery]:',
      '        - generic [ref=early-delivery-title]: Early Delivery Date and Time',
      '        - generic [ref=early-delivery-date-field]:',
      '          - generic [ref=early-delivery-date-label]: Date',
      '          - combobox "Early Delivery Date and Time" [ref=early-delivery-date]',
      '        - generic [ref=early-delivery-time-field]:',
      '          - generic [ref=early-delivery-time-label]: Time',
      '          - generic [ref=early-delivery-time-owner]:',
      '            - combobox "Select Time" [ref=early-delivery-time]',
      '        - generic [ref=early-delivery-zone-field]:',
      '          - generic [ref=early-delivery-zone-label]: Time Zone',
      '          - generic [ref=early-delivery-zone-owner]:',
      '            - combobox "Select Timezone" [ref=early-delivery-zone]',
      '    - generic [ref=late-row]:',
      '      - generic [ref=late-pickup]:',
      '        - generic [ref=late-pickup-title]: Late Pickup Date and Time',
      '        - generic [ref=late-pickup-date-field]:',
      '          - generic [ref=late-pickup-date-label]: Date*',
      '          - combobox "Late Pickup Date and Time" [ref=late-pickup-date]',
      '        - generic [ref=late-pickup-time-field]:',
      '          - generic [ref=late-pickup-time-label]: Time*',
      '          - generic [ref=late-pickup-time-owner]:',
      '            - combobox "Select Time" [ref=late-pickup-time]',
      '        - generic [ref=late-pickup-zone-field]:',
      '          - generic [ref=late-pickup-zone-label]: Time Zone *',
      '          - generic [ref=late-pickup-zone-owner]:',
      '            - combobox "Select Timezone" [ref=late-pickup-zone]',
      '      - generic [ref=late-delivery]:',
      '        - generic [ref=late-delivery-title]: Late Delivery Date and Time',
      '        - generic [ref=late-delivery-date-field]:',
      '          - generic [ref=late-delivery-date-label]: Date',
      '          - combobox "Late Delivery Date and Time" [ref=late-delivery-date]',
      '        - generic [ref=late-delivery-time-field]:',
      '          - generic [ref=late-delivery-time-label]: Time',
      '          - generic [ref=late-delivery-time-owner]:',
      '            - combobox "Select Time" [ref=late-delivery-time]',
      '        - generic [ref=late-delivery-zone-field]:',
      '          - generic [ref=late-delivery-zone-label]: Time Zone',
      '          - generic [ref=late-delivery-zone-owner]:',
      '            - combobox "Select Timezone" [ref=late-delivery-zone]',
    ].join('\n');
    const candidates = dedupeCandidates(snapshot, 'epoch-temporal');
    const cases = [
      ['Date', 'Early Pickup Date calendar', 'early-pickup-date'],
      ['Time', 'Early Pickup Time dropdown', 'early-pickup-time'],
      ['Select', 'Early Pickup Time Zone dropdown', 'early-pickup-zone'],
      ['Date', 'Early Delivery Date calendar', 'early-delivery-date'],
      ['Time', 'Early Delivery Time dropdown', 'early-delivery-time'],
      ['Select', 'Early Delivery Time Zone dropdown', 'early-delivery-zone'],
      ['Date', 'Late Pickup Date calendar', 'late-pickup-date'],
      ['Time', 'Late Pickup Time dropdown', 'late-pickup-time'],
      ['Select', 'Late Pickup Time Zone dropdown', 'late-pickup-zone'],
      ['Date', 'Late Delivery Date calendar', 'late-delivery-date'],
      ['Time', 'Late Delivery Time dropdown', 'late-delivery-time'],
      ['Select', 'Late Delivery Time Zone dropdown', 'late-delivery-zone'],
    ];

    for (const [type, accessibleName, ref] of cases) {
      expect(candidateForOperation(operation({
        type,
        targetIdentity: {
          accessibleName,
          section,
        },
        operationCheck: {
          kind: type === 'Date' ? 'date_value' : 'control_state',
        },
      }), candidates), accessibleName).toMatchObject({
        status: RESOLUTION_STATUS.RESOLVED,
        candidate: {
          ref,
          reference: ref,
          section,
        },
      });
    }

    expect(candidateForOperation(operation({
      type: 'Time',
      targetIdentity: {
        accessibleName: 'Late Pickup Time dropdown',
        section,
        reference: 'late-delivery-time',
      },
      operationCheck: {
        kind: 'control_state',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.NOT_FOUND,
    });
  });

  it('accepts an exact numeric field exposed through the ARIA spinbutton role', () => {
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
      operationCheck: {
        kind: 'input_accepted',
      },
    }), [{
      ref: 'e42',
      role: 'spinbutton',
      accessibleName: 'Order Number',
      stability: 92,
    }])).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e42',
      },
    });
  });

  it('uses an exact quoted literal from verbose authored assertion text', () => {
    expect(candidateForOperation(operation({
      kind: 'assertion',
      type: 'AssertVisible',
      targetIdentity: {
        accessibleName: 'visible text "Welcome OdysseyOne!"',
      },
      operationCheck: null,
    }), [{
      ref: 'e158',
      role: 'heading',
      accessibleName: 'Welcome OdysseyOne!',
      stability: 92,
    }])).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e158',
      },
    });
  });

  it('reports bounded interactive and lexically related candidates without deciding for the controller', () => {
    const diagnostics = diagnosticCandidatesForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
    }), [
      {
        ref: 'order-label',
        role: 'heading',
        accessibleName: 'Order Number',
      },
      {
        ref: 'unlabelled-input',
        role: 'textbox',
        accessibleName: null,
      },
      ...Array.from({ length: 30 }, (_, index) => ({
        ref: `button-${index}`,
        role: 'button',
        accessibleName: `Other ${index}`,
      })),
    ]);

    expect(diagnostics.length).toBeLessThanOrEqual(24);
    expect(diagnostics[0]).toMatchObject({
      ref: 'order-label',
      sharedWordCount: 2,
    });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      ref: 'unlabelled-input',
      role: 'textbox',
    }));
  });

  it('correlates a nearest static field label to its following unnamed owner', () => {
    const snapshot = [
      '- group "General Information Order identifiers, organization, equipment, and references"',
      '  - text: Order Number',
      '  - textbox [ref=e1570]',
      '  - text: Owning Organization',
      '  - combobox [ref=e1578]',
    ].join('\n');
    expect(structuralLabelHints(snapshot).get('e1570')).toContain('Order Number');

    const candidates = dedupeCandidates(snapshot, 'epoch-1');
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ref: 'e1570',
        role: 'textbox',
        semanticNames: expect.arrayContaining(['Order Number']),
      }),
    ]));
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
      operationCheck: {
        kind: 'input_accepted',
      },
    }), candidates)).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e1570',
      },
    });
  });

  it('correlates a generic floating label that follows its unnamed owner', () => {
    const snapshot = [
      '- group "General Information"',
      '  - textbox [ref=e1570]',
      '    - generic: Order Number',
      '  - combobox [ref=e1578]',
      '    - generic: Owning Organization',
    ].join('\n');

    expect(structuralLabelHints(snapshot).get('e1570')).toEqual(['Order Number']);
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
    }), dedupeCandidates(snapshot, 'epoch-1'))).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: {
        ref: 'e1570',
      },
    });
  });

  it('does not cross a same-level sibling wrapper to borrow a nested label', () => {
    const snapshot = [
      '- group "General Information"',
      '  - generic [ref=e1568]:',
      '    - textbox [ref=e1570]',
      '    - generic [ref=e1571]:',
      '      - generic [ref=e1572]:',
      '        - text: Order Number',
      '  - generic [ref=e1576]:',
      '    - combobox [ref=e1578]',
    ].join('\n');

    expect(structuralLabelHints(snapshot).has('e1570')).toBe(false);
    expect(candidateForOperation(operation({
      type: 'Fill',
      targetIdentity: {
        accessibleName: 'Order Number field',
      },
    }), dedupeCandidates(snapshot, 'epoch-1'))).toMatchObject({
      status: RESOLUTION_STATUS.NOT_FOUND,
    });
  });

  it('creates a bounded redacted structural excerpt around relevant refs', () => {
    const excerpt = structuralExcerpt([
      '- group "General Information"',
      '  - text: Order Number',
      '  - textbox [ref=e1570] [value="007995145"]',
      '  - text: Password: super-secret',
    ].join('\n'), ['e1570'], { radius: 2, maxLines: 4 });

    expect(excerpt).toHaveLength(4);
    expect(excerpt.join('\n')).toContain('Order Number');
    expect(excerpt.join('\n')).toContain('value="[redacted]"');
    expect(excerpt.join('\n')).not.toContain('007995145');
    expect(excerpt.join('\n')).not.toContain('super-secret');
  });

  it('offers one evidence-bound Healer proposal for a unique partial semantic candidate', () => {
    const proposal = proposeTargetRecoveryFromSnapshot({
      operation: operation({
        type: 'Fill',
        targetIdentity: {
          accessibleName: 'Email address',
          role: 'textbox',
        },
      }),
      snapshot: { factRefs: ['snapshot:email-page'] },
      candidates: [{
        ref: 'email-input',
        role: 'textbox',
        accessibleName: 'Email',
        factRef: 'candidate:email',
      }],
    });

    expect(proposal).toMatchObject({
      proposalKind: 'TARGET_REPAIR',
      targetIdentity: {
        accessibleName: 'Email',
        role: 'textbox',
      },
      supportingFactRefs: expect.arrayContaining([
        'snapshot:email-page',
        'candidate:email',
      ]),
    });
  });

  it('does not offer a Healer proposal when equally plausible candidates remain', () => {
    expect(proposeTargetRecoveryFromSnapshot({
      operation: operation({
        type: 'Fill',
        targetIdentity: {
          accessibleName: 'Pickup Number',
          role: 'textbox',
        },
      }),
      snapshot: { factRefs: ['snapshot:order'] },
      candidates: [{
        ref: 'pickup-early',
        role: 'textbox',
        accessibleName: 'Pickup',
      }, {
        ref: 'pickup-late',
        role: 'textbox',
        accessibleName: 'Pickup',
      }],
    })).toBeNull();
  });
});
