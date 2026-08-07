import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const conductor = require('../../server/services/agents/conductorPinned');

const EDITABLE_CONTROLS = [
  {
    name: 'ordinary text',
    label: 'Display name field',
    ref: 'display-name',
    snapshot: '- textbox "Display name" [ref=display-name] [type="text"]',
  },
  {
    name: 'email',
    label: 'Work email field',
    ref: 'work-email',
    snapshot: '- textbox "Work email" [ref=work-email] [type="email"] [autocomplete="email"]',
  },
  {
    name: 'password',
    label: 'Password field',
    ref: 'account-password',
    snapshot: '- textbox "Password" [ref=account-password] [type="password"] [autocomplete="current-password"]',
  },
  {
    name: 'number',
    label: 'Quantity field',
    ref: 'quantity',
    snapshot: '- spinbutton "Quantity" [ref=quantity] [type="number"]',
  },
];

describe('Conductor generic Fill target contract', () => {
  it.each(EDITABLE_CONTROLS)(
    'uses the same editable-control resolver for $name input',
    ({ label, ref, snapshot }) => {
      const resolution = conductor._resolveEditableControl(snapshot, label);

      expect(resolution).toMatchObject({
        reason: 'editable_control_resolved',
        field: { ref },
      });
    },
  );

  it('selects the password control when an earlier email control remains in the DOM', () => {
    const snapshot = [
      '- heading "Enter password"',
      '- textbox "Email, phone, or account" [ref=retained-email] [type="email"] [autocomplete="username"]',
      '- textbox "Password" [ref=active-password] [type="password"] [autocomplete="current-password"]',
      '- button "Submit" [ref=submit-control]',
    ].join('\n');

    expect(conductor._resolveEditableControl(snapshot, 'Password field')).toMatchObject({
      reason: 'editable_control_resolved',
      field: { ref: 'active-password', type: 'password' },
    });
  });

  it('does not use DOM order to break an equal semantic tie', () => {
    const snapshot = [
      '- textbox "Contact" [ref=contact-one] [type="text"]',
      '- textbox "Contact" [ref=contact-two] [type="text"]',
    ].join('\n');

    expect(conductor._resolveEditableControl(snapshot, 'Contact field')).toMatchObject({
      field: null,
      reason: 'ambiguous_editable_control',
      candidates: [{ ref: 'contact-one' }, { ref: 'contact-two' }],
    });
  });

  it('resolves an unnamed text input from one uniquely adjacent structural label', () => {
    const snapshot = [
      '- text "Order reference"',
      '- textbox "" [ref=order-reference] [type="text"]',
      '- text "Pickup reference"',
      '- textbox "" [ref=pickup-reference] [type="text"]',
    ].join('\n');

    expect(conductor._resolveEditableControl(snapshot, 'Order reference field')).toMatchObject({
      reason: 'editable_control_resolved',
      field: { ref: 'order-reference', type: 'text' },
    });
  });

  it('does not treat the word number as proof that an identifier uses a numeric input', () => {
    const snapshot = [
      '- text "Order Number"',
      '- textbox "" [ref=order-number] [type="text"]',
    ].join('\n');

    expect(conductor._resolveEditableControl(snapshot, 'Order Number field')).toMatchObject({
      reason: 'editable_control_resolved',
      field: { ref: 'order-number', type: 'text' },
    });
  });

  it('does not substitute an unrelated global text control for a missing authored field', () => {
    const snapshot = '- combobox "Search" [ref=global-search] [type="text"]';

    expect(conductor._resolveEditableControl(snapshot, 'Pickup Number field')).toMatchObject({
      field: null,
      reason: 'no_editable_control',
    });
  });

  it.each([
    ['disabled', '- textbox "Display name" [ref=disabled-name] [type="text"] [disabled]'],
    ['readonly', '- textbox "Display name" [ref=readonly-name] [type="text"] [readonly]'],
  ])('rejects a %s control as a Fill target', (_state, snapshot) => {
    expect(conductor._resolveEditableControl(snapshot, 'Display name field')).toMatchObject({
      field: null,
      reason: 'no_editable_control',
    });
  });

  it('confirms readback only when it comes from the exact node used by Fill', () => {
    const disposition = conductor._domFillReadbackDisposition({
      label: 'Display name field',
      value: 'Ada Lovelace',
      domResult: {
        ok: true,
        valueMatches: true,
        identityVerified: true,
        sameNodeProof: true,
        targetIdentity: { ref: 'display-name', type: 'text' },
        readbackIdentity: { ref: 'display-name', type: 'text' },
      },
    });

    expect(disposition).toEqual({
      readback: 'confirmed',
      reason: 'same_node_value_confirmed',
      qaaiExecutionError: false,
    });
  });

  it('rejects a matching value read from a different editable node', () => {
    const disposition = conductor._domFillReadbackDisposition({
      label: 'Work email field',
      value: 'qa@example.test',
      domResult: {
        ok: true,
        valueMatches: true,
        identityVerified: true,
        sameNodeProof: false,
        targetIdentity: { ref: 'work-email', type: 'email' },
        readbackIdentity: { ref: 'retained-email', type: 'email' },
      },
    });

    expect(disposition).toMatchObject({
      readback: 'unknown',
      reason: 'readback_node_identity_mismatch',
      qaaiExecutionError: true,
    });
  });
});
