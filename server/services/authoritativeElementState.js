'use strict';

const PLAYWRIGHT_FILL_INPUT_TYPES = new Set([
  'color', 'date', 'datetime-local', 'email', 'month', 'number', 'password',
  'range', 'search', 'tel', 'text', 'time', 'url', 'week',
]);

const READONLY_INPUT_TYPES = new Set([
  'date', 'datetime-local', 'email', 'month', 'number', 'password', 'search',
  'tel', 'text', 'time', 'url', 'week',
]);

const HTML_DISABLEABLE_TAGS = new Set([
  'button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea',
]);

const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'switch']);

function normalized(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function booleanOrNull(value) {
  return value === true || value === false ? value : null;
}

function ariaBoolean(value) {
  if (value === true || value === false) return value;
  const text = normalized(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

function axEditable(value) {
  const bool = ariaBoolean(value);
  if (bool !== null) return bool;
  const text = normalized(value);
  if (!text) return null;
  if (text === 'none' || text === 'undefined') return false;
  return ['plaintext', 'plain text', 'richtext', 'rich text'].includes(text) ? true : null;
}

function hasHtmlBooleanAttribute(attributes, name) {
  return Object.prototype.hasOwnProperty.call(attributes || {}, name);
}

function triAnd(...values) {
  if (values.some((value) => value === false)) return false;
  return values.every((value) => value === true) ? true : null;
}

function contentEditableAttribute(value, present) {
  if (!present) return null;
  const text = normalized(value);
  if (text === '' || text === 'true' || text === 'plaintext-only') return true;
  if (text === 'false') return false;
  return null;
}

function normalizeAuthoritativeElementState({
  node = {},
  accessibility = {},
  layout = {},
  domState = null,
  pointerHitTest = null,
  connected = null,
} = {}) {
  const attributes = node.attributes && typeof node.attributes === 'object' ? node.attributes : {};
  const ax = accessibility.properties && typeof accessibility.properties === 'object'
    ? accessibility.properties
    : {};
  const dom = domState && domState.available === true ? domState : null;
  const tag = normalized(dom?.tagName || node.localName || node.nodeName);
  const role = normalized(accessibility.role || attributes.role);
  // The live DOM property normalizes missing/invalid input types to "text".
  const inputType = normalized(dom?.inputType || attributes.type || 'text');
  const pointerEvents = normalized(dom?.pointerEvents || layout.styles?.['pointer-events']);

  const connectedState = booleanOrNull(dom?.isConnected) ?? booleanOrNull(connected);
  const ariaDisabled = ariaBoolean(attributes['aria-disabled']);
  const axDisabled = ariaBoolean(ax.disabled);
  const nativeDisabledFromDom = booleanOrNull(dom?.matchesDisabled);
  const reflectedDisabled = booleanOrNull(dom?.disabledProperty);
  const nativeDisabledFromSnapshot = HTML_DISABLEABLE_TAGS.has(tag)
    ? hasHtmlBooleanAttribute(attributes, 'disabled')
    : false;
  const disabled = [nativeDisabledFromDom, reflectedDisabled, nativeDisabledFromSnapshot, ariaDisabled, axDisabled]
    .some((value) => value === true);

  const supportsNativeReadOnly = tag === 'textarea'
    || (tag === 'input' && READONLY_INPUT_TYPES.has(inputType));
  const nativeReadOnly = supportsNativeReadOnly
    ? (booleanOrNull(dom?.readOnlyProperty) ?? hasHtmlBooleanAttribute(attributes, 'readonly'))
    : false;
  const readOnly = nativeReadOnly === true
    || ariaBoolean(attributes['aria-readonly']) === true
    || ariaBoolean(ax.readonly ?? ax.readOnly) === true;

  const inert = booleanOrNull(dom?.effectiveInert)
    ?? (hasHtmlBooleanAttribute(attributes, 'inert') ? true : null);
  const effectiveHidden = booleanOrNull(dom?.effectiveHidden);
  const effectiveOpacity = Number.isFinite(Number(dom?.effectiveOpacity))
    ? Number(dom.effectiveOpacity)
    : null;
  let visible = null;
  if (connectedState === false || layout.visible === false || effectiveHidden === true || effectiveOpacity === 0) {
    visible = false;
  } else if (connectedState === true && layout.visible === true && effectiveHidden === false && effectiveOpacity !== null) {
    visible = true;
  }

  const enabled = connectedState === false ? false : (disabled ? false : connectedState);
  const exactContentEditable = booleanOrNull(dom?.isContentEditable);
  const attributeContentEditable = contentEditableAttribute(
    attributes.contenteditable,
    hasHtmlBooleanAttribute(attributes, 'contenteditable'),
  );
  const semanticEditable = axEditable(ax.editable);
  const contentEditable = exactContentEditable ?? attributeContentEditable ?? semanticEditable;
  const nativeFillControl = tag === 'textarea'
    || (tag === 'input' && PLAYWRIGHT_FILL_INPUT_TYPES.has(inputType));
  const structurallyFillable = nativeFillControl || contentEditable === true
    ? true
    : (contentEditable === null && !dom ? null : false);
  const notInert = inert === null ? null : !inert;
  const editable = triAnd(enabled, !readOnly, structurallyFillable, notInert);

  const localHit = pointerHitTest && pointerHitTest.available === true
    ? booleanOrNull(pointerHitTest.targetOrDescendant)
    : null;
  let receivesPointerInput = null;
  if (visible === false || pointerEvents === 'none' || inert === true || localHit === false) {
    receivesPointerInput = false;
  } else if (visible === true && pointerEvents && inert === false && localHit === true) {
    receivesPointerInput = true;
  }

  const clickable = triAnd(receivesPointerInput, enabled);
  const nativeSelect = tag === 'select';
  const semanticSelectLike = role === 'combobox' || role === 'listbox';
  const nativeCheckable = tag === 'input' && (inputType === 'checkbox' || inputType === 'radio');
  const semanticCheckable = CHECKABLE_ROLES.has(role);
  const checkable = nativeCheckable || semanticCheckable;
  const fileInput = tag === 'input' && inputType === 'file';

  const actionableBy = {
    click: clickable,
    fill: triAnd(visible, enabled, editable, notInert),
    select: nativeSelect ? triAnd(visible, enabled, !readOnly, notInert) : false,
    semanticSelect: semanticSelectLike ? triAnd(clickable, !readOnly) : false,
    check: checkable ? triAnd(clickable, !readOnly) : false,
    setInputFiles: fileInput ? triAnd(connectedState, enabled, notInert) : false,
    hover: receivesPointerInput,
  };

  return {
    connected: connectedState,
    visible,
    enabled,
    disabled,
    editable,
    readOnly,
    inert,
    pointerEvents: pointerEvents || null,
    control: {
      tag: tag || null,
      role: role || null,
      inputType: tag === 'input' ? inputType : null,
      nativeSelect,
      semanticSelectLike,
      nativeCheckable,
      semanticCheckable,
      fileInput,
    },
    proof: {
      domState: dom ? 'verified' : 'unavailable',
      pointerHitTest: pointerHitTest?.available === true ? 'verified' : 'unavailable',
      unknownOperations: Object.entries(actionableBy)
        .filter(([, value]) => value === null)
        .map(([operation]) => operation),
    },
    actionableBy,
  };
}

module.exports = {
  PLAYWRIGHT_FILL_INPUT_TYPES,
  READONLY_INPUT_TYPES,
  HTML_DISABLEABLE_TAGS,
  CHECKABLE_ROLES,
  ariaBoolean,
  axEditable,
  contentEditableAttribute,
  normalizeAuthoritativeElementState,
};
