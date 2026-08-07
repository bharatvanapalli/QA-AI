import { describe, expect, it } from 'vitest';
import model from '../../server/services/universalControlModel.js';

describe('universal control model', () => {
  it('models owner, trigger, popup, options, and value as separate identities', () => {
    const control = model.createUniversalControl({
      action: 'select',
      target: 'Equipment',
      controlType: 'combobox',
      owner: { ref: 'equipment-owner', role: 'combobox', accessibleName: 'Equipment', visible: true },
      trigger: { ref: 'equipment-trigger', role: 'button', accessibleName: 'Open Equipment', visible: true },
      popup: { ref: 'equipment-list', role: 'listbox', accessibleName: 'Equipment options', visible: true },
      optionContainer: { ref: 'equipment-list', role: 'listbox', accessibleName: 'Equipment options', visible: true },
      valueElement: { ref: 'equipment-owner', role: 'combobox', accessibleName: 'Equipment', value: 'LTL', visible: true },
      expectedValue: 'LTL',
      transactionState: 'observing',
      relationships: { ownerToTrigger: 'adjacent_trigger', ownerToPopup: 'aria-controls', popupToOptions: 'aria-owns' },
    });

    expect(control).toMatchObject({
      schema: model.SCHEMA,
      controlType: 'combobox',
      ownerNode: { ref: 'equipment-owner' },
      interactionNode: { ref: 'equipment-trigger' },
      popupNode: { ref: 'equipment-list' },
      valueNode: { ref: 'equipment-owner', value: 'LTL' },
      ownerElement: { ref: 'equipment-owner' },
      interactionElement: { ref: 'equipment-trigger' },
      popupElement: { ref: 'equipment-list' },
      optionContainer: { ref: 'equipment-list' },
      valueElement: { ref: 'equipment-owner', value: 'LTL' },
      expectedValue: 'LTL',
      transactionState: 'observing',
    });
    expect(control.ownerElement).toBe(control.ownerNode);
    expect(control.interactionElement).toBe(control.interactionNode);
    expect(control.popupElement).toBe(control.popupNode);
    expect(control.valueElement).toBe(control.valueNode);
    expect(model.validateUniversalControl(control)).toEqual([]);
  });

  it('rejects a calendar intent resolved to an unrelated Pickup Number textbox', () => {
    const control = model.createUniversalControl({
      action: 'date',
      target: 'Early Pickup Date calendar',
      owner: {
        ref: 'wrong-field',
        role: 'textbox',
        accessibleName: 'Enter a Pickup Number',
        placeholder: 'Enter a Pickup Number',
        visible: true,
        editable: true,
      },
    });

    expect(control.controlType).toBe('textbox');
    expect(model.compareSemanticIdentity(control)).toMatchObject({
      ok: false,
      code: 'semantic_control_type_mismatch',
      action: 'date',
      controlType: 'textbox',
      score: 0,
    });
    expect(model.validateUniversalControl(control)).toContain('semantic_control_type_mismatch');
  });

  it('scores and rejects a click resolution whose label contradicts the authored calendar owner', () => {
    const control = model.createUniversalControl({
      action: 'click',
      target: 'Early Pickup Date',
      ownerNode: {
        ref: 'pickup-number',
        role: 'textbox',
        accessibleName: 'Pickup Number',
        visible: true,
        enabled: true,
      },
    });

    expect(control.semanticMatch).toMatchObject({
      ok: false,
      code: 'semantic_control_identity_mismatch',
      matchedLabel: 'Pickup Number',
    });
    expect(control.semanticMatch.score).toBeLessThan(model.MINIMUM_SEMANTIC_IDENTITY_SCORE);
  });

  it('accepts a concise associated label when it uniquely preserves the authored identity', () => {
    const control = model.createUniversalControl({
      action: 'fill',
      target: 'Email Address field',
      ownerNode: {
        ref: 'email',
        role: 'textbox',
        associatedLabels: ['Email'],
        visible: true,
        enabled: true,
        editable: true,
      },
    });

    expect(control.semanticMatch).toMatchObject({
      ok: true,
      code: 'semantic_control_identity_matched',
      matchedLabel: 'Email',
    });
  });

  it('accepts an exact date input bound to its authored label', () => {
    const control = model.createUniversalControl({
      action: 'date',
      target: 'Early Pickup Date',
      owner: {
        ref: 'early-pickup-date',
        tag: 'input',
        inputType: 'date',
        associatedLabels: ['Early Pickup Date'],
        visible: true,
        enabled: true,
        editable: true,
      },
      expectedValue: '2026-08-20',
    });

    expect(control.controlType).toBe('date_input');
    expect(model.compareSemanticIdentity(control)).toMatchObject({ ok: true });
  });

  it('rejects a repeated temporal control from a contradictory field group', () => {
    const control = model.createUniversalControl({
      action: 'click',
      target: 'Early Pickup Time Zone',
      owner: {
        ref: 'wrong-time-control',
        role: 'button',
        accessibleName: 'dropdown trigger',
        associatedLabels: [
          'Pickup and Delivery',
          'Early Delivery Date and Time',
          'Select Time',
        ],
        visible: true,
        enabled: true,
      },
    });

    expect(control.semanticMatch).toMatchObject({
      ok: false,
      code: 'semantic_control_identity_mismatch',
    });
    expect(control.semanticMatch.contradictions).toContain('pickup_versus_delivery');
  });

  it('accepts a repeated temporal control when group and facet identities agree', () => {
    const control = model.createUniversalControl({
      action: 'click',
      target: 'Early Pickup Time Zone',
      owner: {
        ref: 'early-pickup-timezone',
        role: 'button',
        accessibleName: 'dropdown trigger',
        associatedLabels: ['Early Pickup Date and Time', 'Select Time Zone'],
        visible: true,
        enabled: true,
      },
    });

    expect(control.semanticMatch).toMatchObject({
      ok: true,
      code: 'semantic_control_identity_matched',
    });
  });

  it('preserves an exact owner label after long ancestor context', () => {
    const control = model.createUniversalControl({
      action: 'click',
      target: 'Freight Term',
      owner: {
        ref: 'term-trigger',
        role: 'button',
        accessibleName: 'dropdown trigger',
        associatedLabels: [
          'General Information Order identifiers organization equipment references and additional explanatory content that exceeds the token budget',
          'Freight Term *',
        ],
        visible: true,
        enabled: true,
      },
    });

    expect(model.compareSemanticIdentity(control)).toMatchObject({
      ok: true,
      code: 'semantic_control_identity_matched',
    });
  });

  it('does not persist raw sensitive values', () => {
    const control = model.createUniversalControl({
      action: 'fill',
      target: 'Password',
      sensitive: true,
      valueRef: 'env.QAAI_PASSWORD',
      expectedValue: 'raw-secret',
      owner: {
        ref: 'password',
        tag: 'input',
        inputType: 'password',
        associatedLabels: ['Password'],
        value: 'raw-secret',
        sensitive: true,
        valueRef: 'env.QAAI_PASSWORD',
      },
    });

    expect(control.currentValue).toBeNull();
    expect(control.expectedValue).toBeNull();
    expect(JSON.stringify(control)).not.toContain('raw-secret');
    expect(model.validateUniversalControl(control)).toEqual([]);
  });

  it('classifies universal control families without website vocabulary', () => {
    expect(model.inferControlType({ tag: 'select' })).toBe('native_select');
    expect(model.inferControlType({ role: 'combobox', attributes: { 'aria-autocomplete': 'list' } })).toBe('autocomplete');
    expect(model.inferControlType({ tag: 'input', inputType: 'time' })).toBe('time_input');
    expect(model.inferControlType({ role: 'switch' })).toBe('switch');
    expect(model.inferControlType({ tag: 'canvas' })).toBe('canvas');
  });
});
