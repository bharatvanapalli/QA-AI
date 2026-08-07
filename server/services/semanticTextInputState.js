'use strict';

const TEXT_INPUT_STATE_VERSION = 'qaai-semantic-text-input-state-v1';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function token(value) {
  return clean(value).toLocaleLowerCase('en-US');
}

function digits(value) {
  return clean(value).replace(/\D+/g, '');
}

function valuesMatch(expectedValue, observedValue, actionType = 'Fill') {
  const action = clean(actionType).toLowerCase();
  const expected = clean(expectedValue);
  const observed = clean(observedValue);
  if (action === 'clear') return observed === '';
  if (token(observed) === token(expected)) return true;
  const expectedDigits = digits(expected);
  const observedDigits = digits(observed);
  const expectedIsNumericLike = expectedDigits.length >= 7
    && expected.replace(/[\d\s()+\-./]/g, '') === '';
  const observedIsNumericLike = observedDigits.length >= 7
    && observed.replace(/[\d\s()+\-./]/g, '') === '';
  return expectedIsNumericLike
    && observedIsNumericLike
    && expectedDigits === observedDigits;
}

function buildBoundTextInputRevealFunction() {
  return `async (owner) => {
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const attr = (node, name) => node?.getAttribute ? node.getAttribute(name) : null;
    const rendered = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const inViewport = (node) => {
      if (!rendered(node)) return false;
      const rect = node.getBoundingClientRect();
      return rect.bottom > 0
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.left < window.innerWidth;
    };
    if (!owner || owner.nodeType !== 1) {
      return JSON.stringify({
        ok: false,
        reason: 'bound_text_input_owner_unavailable_for_reveal',
        candidateCount: 0,
      });
    }

    const editableSelector = [
      'input:not([type="hidden"])',
      'textarea',
      '[role="textbox"]',
      '[contenteditable="true"]',
    ].join(',');
    const candidates = owner.matches?.(editableSelector) && rendered(owner)
      ? [owner]
      : Array.from(owner.querySelectorAll?.(editableSelector) || [])
        .filter((node) => rendered(node));
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) {
      return JSON.stringify({
        ok: false,
        reason: unique.length
          ? 'bound_text_input_owner_ambiguous_for_reveal'
          : 'bound_text_input_owner_not_found_for_reveal',
        candidateCount: unique.length,
      });
    }

    const exactOwner = unique[0];
    const before = exactOwner.getBoundingClientRect();
    exactOwner.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      exactOwner.focus({ preventScroll: true });
    } catch (_) {
      exactOwner.focus();
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const after = exactOwner.getBoundingClientRect();
    const ownerConnected = exactOwner.isConnected === true;
    const viewportVisible = inViewport(exactOwner);
    const focused = document.activeElement === exactOwner
      || exactOwner.contains?.(document.activeElement);
    const disabled = exactOwner.disabled === true || attr(exactOwner, 'aria-disabled') === 'true';
    const readOnly = exactOwner.readOnly === true || attr(exactOwner, 'aria-readonly') === 'true';
    const ok = ownerConnected && viewportVisible && focused && !disabled && !readOnly;
    return JSON.stringify({
      ok,
      reason: !ownerConnected
        ? 'bound_text_input_owner_replaced_during_reveal'
        : disabled || readOnly
          ? 'bound_text_input_owner_not_actionable_for_reveal'
          : !viewportVisible
            ? 'bound_text_input_owner_not_in_viewport_after_reveal'
            : !focused
              ? 'bound_text_input_owner_not_focused_after_reveal'
              : 'bound_text_input_owner_revealed_and_focused',
      candidateCount: 1,
      ownerConnected,
      viewportVisible,
      focused,
      disabled,
      readOnly,
      moved: Math.abs(before.top - after.top) > 1 || Math.abs(before.left - after.left) > 1,
      role: clean(attr(exactOwner, 'role') || exactOwner.tagName).toLowerCase(),
      inputType: clean(attr(exactOwner, 'type') || exactOwner.tagName).toLowerCase(),
    });
  }`;
}

function buildBoundTextInputReadFunction({
  expectedValue,
  actionType = 'Fill',
} = {}) {
  const action = clean(actionType) || 'Fill';
  const expected = String(expectedValue == null ? '' : expectedValue);
  const payload = Object.freeze({
    expectedValue: expected,
    actionType: action,
  });
  return `async (owner) => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const token = (value) => clean(value).toLocaleLowerCase('en-US');
    const digits = (value) => clean(value).replace(/\\D+/g, '');
    const attr = (node, name) => node?.getAttribute ? node.getAttribute(name) : null;
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    if (!owner || owner.nodeType !== 1) {
      return {
        ok: false,
        reason: 'bound_text_input_owner_unavailable',
        matched: false,
        ownerStateCommitted: false,
        candidateCount: 0,
      };
    }

    const editableSelector = [
      'input:not([type="hidden"])',
      'textarea',
      '[role="textbox"]',
      '[contenteditable="true"]',
    ].join(',');
    const descendants = Array.from(owner.querySelectorAll?.(editableSelector) || [])
      .filter((node) => visible(node));
    const candidates = owner.matches?.(editableSelector) && visible(owner)
      ? [owner]
      : descendants;
    const unique = [...new Set(candidates)];
    if (unique.length !== 1) {
      return {
        ok: false,
        reason: unique.length
          ? 'bound_text_input_owner_ambiguous'
          : 'bound_text_input_owner_not_found',
        matched: false,
        ownerStateCommitted: false,
        candidateCount: unique.length,
      };
    }

    const exactOwner = unique[0];
    const tag = clean(exactOwner.tagName).toLowerCase();
    const inputType = clean(attr(exactOwner, 'type') || tag).toLowerCase();
    const expected = clean(payload.expectedValue);
    const action = clean(payload.actionType).toLowerCase();
    const expectedDigits = digits(expected);
    const expectedIsNumericLike = expectedDigits.length >= 7
      && expected.replace(/[\\d\\s()+\\-./]/g, '') === '';
    const readValue = () => exactOwner.isContentEditable === true
      ? clean(exactOwner.textContent)
      : String(exactOwner.value ?? attr(exactOwner, 'value') ?? '');
    const evaluateValue = (rawValue) => {
      const observed = clean(rawValue);
      const observedDigits = digits(observed);
      const observedIsNumericLike = observedDigits.length >= 7
        && observed.replace(/[\\d\\s()+\\-./]/g, '') === '';
      const exactMatched = action === 'clear'
        ? observed === ''
        : token(observed) === token(expected);
      const digitNormalizedMatched = !exactMatched
        && expectedIsNumericLike
        && observedIsNumericLike
        && expectedDigits === observedDigits;
      return {
        rawValue,
        observedDigits,
        exactMatched,
        digitNormalizedMatched,
        matched: exactMatched || digitNormalizedMatched,
      };
    };
    const first = evaluateValue(readValue());
    await new Promise((resolve) => setTimeout(resolve, 200));
    const ownerConnected = exactOwner.isConnected === true;
    const second = evaluateValue(readValue());
    const stableAcrossSettle = ownerConnected
      && first.matched
      && second.matched
      && token(first.rawValue) === token(second.rawValue);
    const matched = second.matched;
    const disabled = exactOwner.disabled === true || attr(exactOwner, 'aria-disabled') === 'true';
    const readOnly = exactOwner.readOnly === true || attr(exactOwner, 'aria-readonly') === 'true';
    const invalid = attr(exactOwner, 'aria-invalid') === 'true'
      || attr(owner, 'aria-invalid') === 'true';
    const ownerStateCommitted = stableAcrossSettle && !disabled && !readOnly;
    return {
      ok: true,
      reason: ownerStateCommitted
        ? 'text_input_owner_value_committed'
        : !ownerConnected
          ? 'text_input_owner_replaced_during_settle'
          : matched && (disabled || readOnly)
            ? 'text_input_owner_not_actionable'
            : matched
              ? 'text_input_owner_value_settling'
              : 'text_input_owner_value_not_committed',
      matched,
      ownerStateCommitted,
      stableAcrossSettle,
      ownerConnected,
      matchMode: second.exactMatched
        ? 'exact'
        : second.digitNormalizedMatched
          ? 'digits'
          : null,
      candidateCount: 1,
      tag,
      role: clean(attr(exactOwner, 'role') || tag).toLowerCase(),
      inputType,
      valuePresent: second.rawValue.length > 0,
      valueLength: second.rawValue.length,
      digitCount: second.observedDigits.length,
      disabled,
      readOnly,
      invalid,
    };
  }`;
}

function evaluateTextInputReadback({
  readback,
  expectedValue,
  actionType = 'Fill',
} = {}) {
  const current = readback && typeof readback === 'object' ? readback : null;
  if (!current || current.ok !== true) {
    return Object.freeze({
      valueMatched: null,
      ownerStateCommitted: null,
      reason: clean(current?.reason) || 'text_input_owner_readback_unavailable',
    });
  }
  const valueMatched = current.matched === true
    || (
      Object.hasOwn(current, 'value')
      && valuesMatch(expectedValue, current.value, actionType)
    );
  if (!valueMatched) {
    return Object.freeze({
      valueMatched: false,
      ownerStateCommitted: false,
      reason: 'text_input_owner_value_not_committed',
    });
  }
  if (current.disabled === true || current.readOnly === true) {
    return Object.freeze({
      valueMatched: true,
      ownerStateCommitted: false,
      reason: 'text_input_owner_not_actionable',
    });
  }
  if (current.ownerStateCommitted !== true) {
    return Object.freeze({
      valueMatched: true,
      ownerStateCommitted: false,
      reason: clean(current.reason) || 'text_input_owner_value_settling',
    });
  }
  return Object.freeze({
    valueMatched: true,
    ownerStateCommitted: true,
    reason: 'text_input_owner_value_committed',
  });
}

module.exports = {
  TEXT_INPUT_STATE_VERSION,
  valuesMatch,
  buildBoundTextInputRevealFunction,
  buildBoundTextInputReadFunction,
  evaluateTextInputReadback,
};
