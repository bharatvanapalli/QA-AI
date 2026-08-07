import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  controllerAssertionContract,
  evaluateControllerAssertionSnapshot,
} = require('../../server/services/controllerMcpRuntimeAdapter');

function assertion(overrides = {}) {
  return {
    kind: 'assertion',
    type: 'AssertText',
    operationId: 'assertion:case:step.001',
    actionOccurrenceId: 'occurrence:assertion:case:step.001:1',
    targetIdentity: { accessibleName: 'Status field' },
    expected: 'the Status field displays exactly Ready.',
    verify: { kind: 'text', text: 'Ready' },
    ...overrides,
  };
}

function candidate({ ref, role, name, labels = [], scopes = [] }) {
  return {
    ref,
    reference: ref,
    role,
    accessibleName: name,
    name,
    controlLabels: labels,
    scopeLabels: scopes,
    semanticNames: [name, ...labels, ...scopes].filter(Boolean),
    stability: 100,
  };
}

describe('controller MCP typed assertion observation', () => {
  it('uses the semantic heading role instead of requiring the authored wrapper noun in page text', () => {
    const operation = assertion({
      type: 'AssertVisible',
      targetIdentity: { accessibleName: 'Create New Order heading' },
      expected: 'the Create New Order heading is visible.',
      verify: { kind: 'visible', element: { name: 'Create New Order heading' } },
    });
    const candidates = [
      candidate({ ref: 'e1', role: 'link', name: 'Create new order' }),
      candidate({ ref: 'e2', role: 'heading', name: 'Create New Order' }),
    ];
    expect(evaluateControllerAssertionSnapshot({ operation, candidates, snapshotText: '' }))
      .toMatchObject({ matched: true, assertionType: 'VISIBLE', candidateRef: 'e2' });
  });

  it('turns an ordinal option assertion into exact visible option evidence', () => {
    const operation = assertion({
      type: 'AssertVisible',
      targetIdentity: { accessibleName: 'second visible Organization option' },
      expected: 'the second visible Organization option is exactly *GROUP EUROPE 01.',
      verify: { kind: 'visible', element: { name: 'second visible Organization option' } },
    });
    expect(controllerAssertionContract(operation)).toMatchObject({
      type: 'VISIBLE',
      payload: { target: { name: '*GROUP EUROPE 01', role: 'option' } },
    });
    expect(evaluateControllerAssertionSnapshot({
      operation,
      snapshotText: '',
      candidates: [candidate({ ref: 'e3', role: 'option', name: '*GROUP EUROPE 01' })],
    })).toMatchObject({ matched: true, candidateRef: 'e3' });
  });

  it('commits the authored selected timezone while preserving application invalidity as a separate fact', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'selected Early Pickup Time Zone' },
      expected: 'the selected Early Pickup Time Zone label contains Central.',
      verify: {
        kind: 'text',
        text: 'verify that the selected Early Pickup Time Zone label contains Central.',
      },
    });
    const owner = candidate({
      ref: 'e4',
      role: 'combobox',
      name: '(UTC-06:00) US/Central',
      labels: ['Time Zone'],
      scopes: ['Early Pickup Date and Time'],
    });
    const observed = evaluateControllerAssertionSnapshot({
      operation,
      candidates: [owner],
      snapshotText: '- combobox "(UTC-06:00) US/Central" [invalid] [ref=e4]',
    });
    expect(observed).toMatchObject({ matched: true, observedKind: 'exact-owner-value' });
  });

  it('reports a wrong selected value instead of accepting the mutation', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'selected Early Pickup Time Zone' },
      expected: 'the selected Early Pickup Time Zone label contains Central.',
      verify: {
        kind: 'text',
        text: 'verify that the selected Early Pickup Time Zone label contains Central.',
      },
    });
    const owner = candidate({
      ref: 'e5',
      role: 'combobox',
      name: '(UTC-05:00) US/Eastern',
      labels: ['Time Zone'],
      scopes: ['Early Pickup Date and Time'],
    });
    expect(evaluateControllerAssertionSnapshot({ operation, candidates: [owner], snapshotText: '' }))
      .toMatchObject({ matched: false });
  });

  it('decodes a quoted accessibility snapshot owner value before exact comparison', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Pickup Number field' },
      expected: 'the Pickup Number field displays exactly 7995145776.',
      verify: { kind: 'text', text: '7995145776' },
    });
    const owner = candidate({
      ref: 'q1',
      role: 'textbox',
      name: 'Pickup Number',
      labels: ['Pickup Number'],
    });
    expect(evaluateControllerAssertionSnapshot({
      operation,
      candidates: [owner],
      snapshotText: '- textbox "Pickup Number" [ref=q1]: "7995145776"',
    })).toMatchObject({ matched: true, observed: '7995145776' });
  });

  it('compares the exact visible ordered option collection', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Equipment options appear in this exact order: RR, LCL, LTL, TL, FCL' },
      expected: 'the Equipment options appear in this exact order: RR, LCL, LTL, TL, FCL.',
      verify: {
        kind: 'text',
        text: 'Verify that the Equipment options appear in this exact order: RR, LCL, LTL, TL, FCL.',
      },
    });
    const candidates = ['RR', 'LCL', 'LTL', 'TL', 'FCL']
      .map((name, index) => candidate({ ref: `o${index}`, role: 'option', name }));
    expect(evaluateControllerAssertionSnapshot({ operation, candidates, snapshotText: '' }))
      .toMatchObject({ matched: true, assertionType: 'COLLECTION' });
  });

  it('normalizes displayed dates before comparing them', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Early Pickup Date' },
      expected: 'Early Pickup Date represents August 20, 2026 and displays an equivalent value such as 08/20/2026.',
      verify: { kind: 'text', text: 'August 20, 2026 (08/20/2026)' },
    });
    const owner = candidate({
      ref: 'd1',
      role: 'combobox',
      name: 'Early Pickup Date and Time',
      labels: ['Date'],
      scopes: ['Early Pickup Date and Time'],
    });
    expect(evaluateControllerAssertionSnapshot({
      operation,
      candidates: [owner],
      snapshotText: '- combobox "Early Pickup Date and Time" [ref=d1]: 08/20/2026',
    })).toMatchObject({ matched: true, assertionType: 'DATE' });
  });

  it('evaluates chronological relationships from the exact four owner values', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Early Pickup Date/Time' },
      expected: 'Early Pickup Date/Time is before Late Pickup Date/Time.',
      verify: { kind: 'text', text: 'Verify that Early Pickup Date/Time is before Late Pickup Date/Time.' },
    });
    const candidates = [
      candidate({ ref: 'd1', role: 'combobox', name: 'Early Pickup Date and Time', labels: ['Date'], scopes: ['Early Pickup Date and Time'] }),
      candidate({ ref: 't1', role: 'combobox', name: '09:00', labels: ['Time'], scopes: ['Early Pickup Date and Time'] }),
      candidate({ ref: 'd2', role: 'combobox', name: 'Late Pickup Date and Time', labels: ['Date'], scopes: ['Late Pickup Date and Time'] }),
      candidate({ ref: 't2', role: 'combobox', name: '11:00', labels: ['Time'], scopes: ['Late Pickup Date and Time'] }),
    ];
    const snapshotText = [
      '- combobox "Early Pickup Date and Time" [ref=d1]: 08/20/2026',
      '- combobox "09:00" [ref=t1]',
      '- combobox "Late Pickup Date and Time" [ref=d2]: 08/20/2026',
      '- combobox "11:00" [ref=t2]',
    ].join('\n');
    expect(evaluateControllerAssertionSnapshot({ operation, candidates, snapshotText }))
      .toMatchObject({ matched: true, assertionType: 'TEMPORAL_RELATIONSHIP' });
  });

  it('reads exact accordion state instead of searching for the verification sentence', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Pickup and Delivery section' },
      expected: 'the Pickup and Delivery section is expanded.',
      verify: { kind: 'text', text: 'Verify that the Pickup and Delivery section is expanded.' },
    });
    const owner = candidate({ ref: 'a1', role: 'button', name: 'Pickup and Delivery' });
    expect(evaluateControllerAssertionSnapshot({
      operation,
      candidates: [owner],
      snapshotText: '- button "Pickup and Delivery" [expanded] [ref=a1]',
    })).toMatchObject({ matched: true, assertionType: 'ATTRIBUTE' });
  });

  it('accepts agreeing expanded state from duplicate semantic representations', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Pickup and Delivery section' },
      expected: 'the Pickup and Delivery section is expanded.',
      verify: { kind: 'text', text: 'Verify that the Pickup and Delivery section is expanded.' },
    });
    const candidates = [
      candidate({ ref: 'a2', role: 'button', name: 'Pickup and Delivery' }),
      candidate({ ref: 'a3', role: 'region', name: 'Pickup and Delivery' }),
    ];
    expect(evaluateControllerAssertionSnapshot({
      operation,
      candidates,
      snapshotText: [
        '- button "Pickup and Delivery" [expanded] [ref=a2]',
        '- region "Pickup and Delivery" [expanded] [ref=a3]',
      ].join('\n'),
    })).toMatchObject({
      matched: true,
      assertionType: 'ATTRIBUTE',
      observedKind: 'corroborated-semantic-aria-state',
    });
  });

  it('keeps conflicting duplicate expanded states unknown', () => {
    const operation = assertion({
      targetIdentity: { accessibleName: 'Pickup and Delivery section' },
      expected: 'the Pickup and Delivery section is expanded.',
      verify: { kind: 'text', text: 'Verify that the Pickup and Delivery section is expanded.' },
    });
    const candidates = [
      candidate({ ref: 'a4', role: 'button', name: 'Pickup and Delivery' }),
      candidate({ ref: 'a5', role: 'region', name: 'Pickup and Delivery' }),
    ];
    expect(evaluateControllerAssertionSnapshot({
      operation,
      candidates,
      snapshotText: [
        '- button "Pickup and Delivery" [expanded] [ref=a4]',
        '- region "Pickup and Delivery" [collapsed] [ref=a5]',
      ].join('\n'),
    })).toMatchObject({
      matched: null,
      reason: 'typed_assertion_attribute_state_conflicting',
    });
  });
});
