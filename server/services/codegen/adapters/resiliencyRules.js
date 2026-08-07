'use strict';

/**
 * Evidence-preserving locator selection. Captured names and selectors are
 * emitted exactly. Runtime context is retained as metadata; it never creates
 * an authored step or navigation operation.
 */

// Compatibility export. Captured accessible-name words are never removed.
const STOP_WORDS = new Set();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compatibility helper: exact and case-sensitive, never partial. */
function semanticRegex(accessibleName) {
  const name = String(accessibleName == null ? '' : accessibleName);
  if (!name) return null;
  return new RegExp(`^${escapeRegExp(name)}$`, 'u');
}

/** Preferred emission: an exact string, not a regular expression. */
function nameArg(accessibleName) {
  return JSON.stringify(String(accessibleName == null ? '' : accessibleName));
}

function asArray(value) {
  return Array.isArray(value) ? value.slice() : [];
}

function contextEvidence(candidate = {}) {
  return {
    pageAlias: candidate.pageAlias || null,
    tabAlias: candidate.tabAlias || null,
    popupIdentity: candidate.popupIdentity || null,
    framePath: asArray(candidate.framePath),
    shadowPath: asArray(candidate.shadowPath),
    waitContract: candidate.waitContract || null,
    contextTransition: candidate.contextTransition || null,
  };
}

function provenanceEvidence(candidate = {}) {
  return {
    source: candidate.verificationSource || candidate.source || null,
    status: candidate.verificationStatus || candidate.status || null,
    capturedAt: candidate.capturedAt || candidate.captureTimestamp || null,
    unique: candidate.unique === true || candidate.isUnique === true,
    actionable: candidate.actionable === true || candidate.isActionable === true,
  };
}

function isVerified(candidate = {}) {
  const status = String(candidate.verificationStatus || candidate.status || '').toLowerCase();
  return candidate.verified === true || status === 'verified' || status === 'captured';
}

function selectCandidate(candidates) {
  if (!Array.isArray(candidates)) return null;
  const usable = candidates.filter((candidate) => candidate && typeof candidate === 'object');
  return usable.find((candidate) => candidate.selected === true)
    || usable.find(isVerified)
    || usable[0]
    || null;
}

function exactCapturedExpression(candidate = {}) {
  for (const key of ['playwrightExpression', 'locatorExpression', 'expression']) {
    if (typeof candidate[key] === 'string' && candidate[key].trim()) return candidate[key].trim();
  }
  return null;
}

function pageRoot(candidate = {}) {
  const ref = candidate.pageRef || candidate.pageAlias || 'page';
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(ref)) ? String(ref) : 'page';
}

function exactCandidateExpression(candidate) {
  const captured = exactCapturedExpression(candidate);
  if (captured) return captured;

  const q = (value) => JSON.stringify(String(value == null ? '' : value));
  let root = pageRoot(candidate);
  for (const frame of asArray(candidate.framePath)) {
    const selector = typeof frame === 'string' ? frame : frame && frame.selector;
    if (typeof selector === 'string' && selector) root += `.frameLocator(${q(selector)})`;
  }
  for (const shadow of asArray(candidate.shadowPath)) {
    const selector = typeof shadow === 'string' ? shadow : shadow && shadow.selector;
    if (typeof selector === 'string' && selector) root += `.locator(${q(selector)})`;
  }

  if (candidate.strategy === 'role' && candidate.role && candidate.name != null) {
    return `${root}.getByRole(${q(candidate.role)}, { name: ${nameArg(candidate.name)}, exact: true })`;
  }
  if (candidate.strategy === 'label' && candidate.text != null) {
    return `${root}.getByLabel(${nameArg(candidate.text)}, { exact: true })`;
  }
  if (candidate.strategy === 'placeholder' && candidate.text != null) {
    return `${root}.getByPlaceholder(${nameArg(candidate.text)}, { exact: true })`;
  }
  if (candidate.strategy === 'testId' && candidate.testId != null) {
    return `${root}.getByTestId(${q(candidate.testId)})`;
  }
  if (candidate.strategy === 'css' && candidate.selector && !/^getBy/i.test(String(candidate.selector)) && !/\[ref\s*=/i.test(String(candidate.selector))) {
    return `${root}.locator(${q(candidate.selector)})`;
  }
  return null;
}

function buildLocatorPlan(candidates) {
  const candidate = selectCandidate(candidates);
  if (!candidate) return null;
  const expression = exactCandidateExpression(candidate);
  if (!expression) return null;
  return {
    expression,
    candidate,
    provenance: provenanceEvidence(candidate),
    context: contextEvidence(candidate),
    warnings: isVerified(candidate)
      ? []
      : ['Locator candidate is not runtime-verified; replace it with captured DOM evidence when available.'],
  };
}

/** Compatibility APIs now return at most one exact locator expression. */
function buildOrChainParts(candidates) {
  const plan = buildLocatorPlan(candidates);
  return plan ? [plan.expression] : null;
}

function buildOrChain(candidates) {
  const parts = buildOrChainParts(candidates);
  return parts && parts.length ? parts[0] : null;
}

module.exports = {
  semanticRegex,
  nameArg,
  buildOrChain,
  buildOrChainParts,
  buildLocatorPlan,
  selectCandidate,
  contextEvidence,
  provenanceEvidence,
  STOP_WORDS,
};
