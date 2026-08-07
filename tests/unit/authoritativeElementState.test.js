import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeAuthoritativeElementState } = require('../../server/services/authoritativeElementState.js');

const DISABLEABLE = new Set(['button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea']);

function state({
  tag = 'button',
  attributes = {},
  role = 'button',
  ax = {},
  visible = true,
  pointerEvents = 'auto',
  connected = true,
  dom = {},
  exactDom = true,
  hit = { available: true, targetOrDescendant: true },
} = {}) {
  const inputType = tag === 'input' ? String(attributes.type || 'text').toLowerCase() : null;
  const disabledAttribute = Object.prototype.hasOwnProperty.call(attributes, 'disabled');
  const readOnlyAttribute = Object.prototype.hasOwnProperty.call(attributes, 'readonly');
  const contentEditableValue = Object.prototype.hasOwnProperty.call(attributes, 'contenteditable')
    && ['', 'true', 'plaintext-only'].includes(String(attributes.contenteditable).toLowerCase());
  const domState = exactDom ? {
    available: true,
    isConnected: connected,
    tagName: tag,
    inputType,
    matchesDisabled: DISABLEABLE.has(tag) ? disabledAttribute : false,
    disabledProperty: DISABLEABLE.has(tag) ? disabledAttribute : null,
    readOnlyProperty: readOnlyAttribute,
    isContentEditable: contentEditableValue,
    effectiveInert: false,
    effectiveHidden: false,
    effectiveOpacity: 1,
    pointerEvents,
    ...dom,
  } : { available: false, reason: 'test_dom_proof_unavailable' };
  return normalizeAuthoritativeElementState({
    node: { localName: tag, nodeName: tag.toUpperCase(), attributes },
    accessibility: { role, properties: ax },
    layout: { visible, styles: { 'pointer-events': pointerEvents } },
    domState,
    pointerHitTest: hit,
    connected,
  });
}

describe('authoritative element state normalization', () => {
  it('marks a proven visible enabled button click- and hover-actionable only', () => {
    expect(state()).toMatchObject({
      connected: true,
      visible: true,
      enabled: true,
      disabled: false,
      editable: false,
      readOnly: false,
      inert: false,
      actionableBy: {
        click: true, fill: false, select: false, semanticSelect: false,
        check: false, setInputFiles: false, hover: true,
      },
    });
  });

  it.each([
    [{ disabled: '' }, {}, { matchesDisabled: true, disabledProperty: true }],
    [{ 'aria-disabled': 'true' }, {}, {}],
    [{}, { disabled: true }, {}],
  ])('normalizes disabled evidence from applicable HTML, ARIA, or AX', (attributes, ax, dom) => {
    expect(state({ attributes, ax, dom })).toMatchObject({
      enabled: false,
      disabled: true,
      actionableBy: { click: false, hover: true },
    });
  });

  it('does not treat a meaningless disabled attribute on an arbitrary custom control as native disabled state', () => {
    expect(state({ tag: 'div', role: 'button', attributes: { disabled: '' } })).toMatchObject({
      disabled: false,
      enabled: true,
      actionableBy: { click: true },
    });
  });

  it('uses native readonly semantics only for supported controls', () => {
    expect(state({ tag: 'input', role: 'textbox', attributes: { readonly: '', type: 'text' } })).toMatchObject({
      enabled: true,
      readOnly: true,
      editable: false,
      actionableBy: { click: true, fill: false },
    });
    expect(state({ tag: 'select', role: 'combobox', attributes: { readonly: '' }, dom: { readOnlyProperty: null } }))
      .toMatchObject({ readOnly: false, actionableBy: { select: true } });
  });

  it.each(['', 'true', 'plaintext-only'])('recognizes contenteditable=%j through exact DOM state', (value) => {
    expect(state({ tag: 'div', role: 'textbox', attributes: { contenteditable: value } })).toMatchObject({
      editable: true,
      actionableBy: { fill: true },
    });
  });

  it('recognizes inherited contenteditable through isContentEditable rather than local attributes', () => {
    expect(state({ tag: 'span', role: 'textbox', dom: { isContentEditable: true } })).toMatchObject({
      editable: true,
      actionableBy: { fill: true },
    });
  });

  it('separates native selectOption from semantic custom-control selection', () => {
    expect(state({ tag: 'select', role: 'combobox' }).actionableBy).toMatchObject({
      select: true,
      semanticSelect: true,
    });
    expect(state({ tag: 'div', role: 'combobox' }).actionableBy).toMatchObject({
      select: false,
      semanticSelect: true,
    });
  });

  it('does not check a read-only semantic checkable control', () => {
    expect(state({ tag: 'div', role: 'checkbox', attributes: { 'aria-readonly': 'true' } }).actionableBy)
      .toMatchObject({ click: true, check: false });
  });

  it('uses operation-specific input compatibility for color, range, and file inputs', () => {
    expect(state({ tag: 'input', role: 'textbox', attributes: { type: 'color' } }).actionableBy)
      .toMatchObject({ fill: true, setInputFiles: false });
    expect(state({ tag: 'input', role: 'slider', attributes: { type: 'range' } }).actionableBy)
      .toMatchObject({ fill: true, setInputFiles: false });
    expect(state({ tag: 'input', role: 'button', attributes: { type: 'file' } }).actionableBy)
      .toMatchObject({ fill: false, setInputFiles: true });
  });

  it('does not require pointer hit evidence for Playwright fill', () => {
    expect(state({
      tag: 'input',
      role: 'textbox',
      attributes: { type: 'text' },
      pointerEvents: 'none',
      hit: { available: true, targetOrDescendant: false },
    }).actionableBy).toMatchObject({ click: false, hover: false, fill: true });
  });

  it.each([
    [{ visible: false }, { visible: false, click: false, hover: false }],
    [{ dom: { effectiveInert: true } }, { visible: true, click: false, hover: false }],
    [{ dom: { effectiveHidden: true } }, { visible: false, click: false, hover: false }],
    [{ dom: { effectiveOpacity: 0 } }, { visible: false, click: false, hover: false }],
    [{ connected: false, dom: { isConnected: false } }, { connected: false, visible: false, click: false, hover: false }],
    [{ hit: { available: true, targetOrDescendant: false } }, { visible: true, click: false, hover: false }],
  ])('rejects non-actionable rendered states without losing their exact reason', (input, expected) => {
    const result = state(input);
    expect(result).toMatchObject({ connected: expected.connected ?? true, visible: expected.visible });
    expect(result.actionableBy).toMatchObject({ click: expected.click, hover: expected.hover });
  });

  it('returns explicit unknown pointer operations when hit-test proof is unavailable', () => {
    const result = state({ hit: { available: false, targetOrDescendant: null, reason: 'outside_viewport' } });
    expect(result.actionableBy).toMatchObject({ click: null, hover: null });
    expect(result.proof).toMatchObject({ pointerHitTest: 'unavailable' });
    expect(result.proof.unknownOperations).toEqual(expect.arrayContaining(['click', 'hover']));
  });

  it('does not promote missing exact DOM proof into runnable actionability', () => {
    const result = state({
      tag: 'input',
      role: 'textbox',
      attributes: { type: 'text' },
      exactDom: false,
      hit: { available: false, targetOrDescendant: null, reason: 'runtime_proof_unavailable' },
    });
    expect(result).toMatchObject({ visible: null, inert: null });
    expect(result.actionableBy).toMatchObject({ click: null, fill: null, hover: null });
    expect(result.proof).toMatchObject({ domState: 'unavailable', pointerHitTest: 'unavailable' });
    expect(result.proof.unknownOperations).toEqual(expect.arrayContaining(['click', 'fill', 'hover']));
  });
});
