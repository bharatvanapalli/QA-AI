'use strict';

const pageFingerprint = require('./pageFingerprint');

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function semanticVisibleName(value) {
  const original = String(value || '').trim();
  if (!original) return '';
  const reduced = original
    .replace(/\s+(?:page|screen|view|section|panel|control|option|field|dropdown|menu)\s*$/i, '')
    .trim();
  return reduced || original;
}

function typedExpectedStateFromStep(step = {}) {
  const operationCheck = objectOrNull(step.operationCheck);
  const direct = objectOrNull(operationCheck?.expectedState) || objectOrNull(step.expectedState);
  if (direct) return direct;

  const verify = objectOrNull(step.verify);
  if (!verify) return null;
  const nested = objectOrNull(verify.expectedState);
  if (nested) return nested;

  const kind = String(verify.kind || '').toLowerCase();
  if (kind === 'url') {
    const urlPattern = verify.urlPattern || verify.pattern || verify.equals || verify.url;
    return urlPattern ? { urlPattern } : null;
  }
  if (kind === 'text') {
    const visibleText = verify.equals || verify.text || verify.expected;
    return visibleText ? { visibleText } : null;
  }
  if (kind === 'visible') {
    const element = objectOrNull(verify.element) || objectOrNull(verify.control) || objectOrNull(verify.field);
    if (!element) return null;
    const role = String(element.role || '').toLowerCase();
    const name = element.name || element.label || element.text;
    if (!name && !role) return null;
    if (['button', 'link', 'tab', 'menuitem'].includes(role)) return { control: { role, name } };
    if (['textbox', 'searchbox', 'combobox', 'spinbutton', 'checkbox', 'radio', 'switch'].includes(role)) {
      return { field: { role, name, type: element.type || null } };
    }
    if (name && /\s+(?:page|screen|view)\s*$/i.test(String(name))) {
      return { primaryHeadingIncludes: semanticVisibleName(name) };
    }
    return name ? { visibleText: semanticVisibleName(name) } : null;
  }
  return null;
}

function genericTransitionAlreadySatisfied({
  step = null,
  beforeFingerprint = null,
  currentFingerprint = null,
} = {}) {
  const expectedState = typedExpectedStateFromStep(step || {});
  const fingerprint = objectOrNull(currentFingerprint);
  if (!expectedState || !fingerprint) {
    return {
      satisfied: false,
      reason: 'transition_not_proven',
      evidence: { expectedState, checked: false, match: null, pageEffect: null },
    };
  }

  const match = pageFingerprint.matchesExpectedState(fingerprint, expectedState);
  const pageEffect = objectOrNull(beforeFingerprint)
    ? pageFingerprint.diff(beforeFingerprint, fingerprint)
    : null;
  if (!match.checked || !match.matched) {
    return {
      satisfied: false,
      reason: 'transition_not_proven',
      evidence: { expectedState, checked: match.checked, match, pageEffect },
    };
  }
  return {
    satisfied: true,
    reason: 'declared_transition_already_satisfied',
    evidence: {
      expectedState,
      checked: true,
      match,
      pageEffect,
      observedFingerprint: {
        schema: fingerprint.schema || null,
        structuralHash: fingerprint.structuralHash || null,
        url: fingerprint.url || null,
        title: fingerprint.title || null,
        primaryHeading: fingerprint.primaryHeading || null,
      },
    },
  };
}

module.exports = {
  semanticVisibleName,
  typedExpectedStateFromStep,
  genericTransitionAlreadySatisfied,
};
