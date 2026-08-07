'use strict';

const actionLocatorResolver = require('../actionLocatorResolver');

const VERIFIED_ACTION_LOCATOR_SOURCES = new Set([
  'verified_dom_inspection',
  'active_dom_excavation',
]);

const AUTHORITATIVE_CDP_SOURCES = new Set([
  'chromium_cdp',
  'chromium_cdp_dom_snapshot_accessibility',
]);

function locatorExpressionIsExportSafe(expression) {
  const raw = String(expression || '').trim();
  if (!raw) return false;
  if (/\.(?:first|nth|last)\s*\(/.test(raw)) return false;
  if (/:(?:nth-of-type|nth-child)\s*\(/i.test(raw)) return false;
  if (/\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i.test(raw)) return false;
  if (/^getByRole\(\s*["'][^"']+["']\s*\)$/i.test(raw)) return false;
  if (/(?:#|\[id\s*=\s*["'])[^"'\]\s]*(?:[-_:])\d{6,}(?:["']?\]|\b)/i.test(raw))
    return false;
  if (/[\uE000-\uF8FF\u2600-\u27BF]|(?:ÃƒÂ¯|ÃƒÂ°|ÃƒÂ¢|ÃƒÆ’|Ã¯Â¿Â½)[\w\u0080-\u00ffÃ¯Â¿Â½]{0,8}/.test(raw))
    return false;
  return true;
}

function hasExactActionNodeIdentity(proof = {}) {
  const target =
    proof.targetIdentity && typeof proof.targetIdentity === 'object'
      ? proof.targetIdentity
      : null;
  const matched =
    proof.matchedIdentity && typeof proof.matchedIdentity === 'object'
      ? proof.matchedIdentity
      : null;
  return (
    proof.identityVerified === true &&
    !!target &&
    !!matched &&
    !!target.documentId &&
    !!target.nodeId &&
    target.documentId === matched.documentId &&
    target.nodeId === matched.nodeId
  );
}

function hasPersistedAuthoritativeContextProof(actionLocator, proof, source) {
  if (!AUTHORITATIVE_CDP_SOURCES.has(String(source || ''))) return false;
  const context =
    actionLocator.context && typeof actionLocator.context === 'object'
      ? actionLocator.context
      : actionLocator.browserContext && typeof actionLocator.browserContext === 'object'
        ? actionLocator.browserContext
        : null;
  const authoritative = context?.authoritativeCdp;
  const pre = authoritative?.pre;
  const post = authoritative?.post;
  const reverification = authoritative?.reverification;
  const binding = actionLocator.captureBinding || context?.captureBinding;
  const preBackendNodeId = Number(pre?.backendNodeId);
  const postBackendNodeId = Number(post?.backendNodeId);
  const expectedBackendNodeId = Number(reverification?.expectedBackendNodeId);
  const beforeBackendNodeId = Number(reverification?.backendNodeIdBefore);
  const afterBackendNodeId = Number(reverification?.backendNodeIdAfter);
  const pageId = String(context?.pageIdentity?.pageId || '');
  const exactPageId = String(reverification?.exactPageId || '');
  const captureSourceAccepted = (value) => AUTHORITATIVE_CDP_SOURCES.has(String(value || ''));

  return (
    binding?.kind === 'mcp_bound_ref' &&
    pre?.captured === true &&
    post?.captured === true &&
    pre?.authoritative === true &&
    post?.authoritative === true &&
    captureSourceAccepted(pre?.source) &&
    captureSourceAccepted(post?.source) &&
    Number.isInteger(preBackendNodeId) &&
    preBackendNodeId > 0 &&
    preBackendNodeId === postBackendNodeId &&
    preBackendNodeId === expectedBackendNodeId &&
    preBackendNodeId === beforeBackendNodeId &&
    preBackendNodeId === afterBackendNodeId &&
    Number(reverification?.countBefore) === 1 &&
    Number(reverification?.countAfter) === 1 &&
    reverification?.stableAcrossSnapshots === true &&
    (!pageId || !exactPageId || pageId === exactPageId) &&
    proof.verified === true &&
    proof.actionTimeResolved === true &&
    proof.actedNodeBound === true &&
    proof.sameElement === true &&
    proof.identityVerified === true &&
    proof.authoritativeCdpVerified === true &&
    proof.backendNodeVerified === true &&
    proof.stableAcrossSnapshots === true &&
    Number(proof.count) === 1 &&
    hasExactActionNodeIdentity(proof)
  );
}

function isVerifiedActionLocator(actionLocator) {
  if (!actionLocator || typeof actionLocator !== 'object') return false;
  if (actionLocatorResolver.isVerifiedActionLocator(actionLocator)) return true;
  if (actionLocator.kind === 'multi') {
    const fields = Array.isArray(actionLocator.fields) ? actionLocator.fields : [];
    return (
      fields.length > 0 &&
      fields.every((field) => isVerifiedActionLocator(field && field.actionLocator))
    );
  }
  const proof =
    actionLocator.proof && typeof actionLocator.proof === 'object'
      ? actionLocator.proof
      : {};
  const source =
    actionLocator.verificationSource || actionLocator.evidenceSource || proof.source || null;
  const expression =
    actionLocator.frameworkExpressions?.playwright || actionLocator.expression || null;
  const domAtlas =
    actionLocator.domAtlas && typeof actionLocator.domAtlas === 'object'
      ? actionLocator.domAtlas
      : null;
  const persistedAuthoritativeContextProof = hasPersistedAuthoritativeContextProof(
    actionLocator,
    proof,
    source,
  );
  return (
    (VERIFIED_ACTION_LOCATOR_SOURCES.has(String(source)) || persistedAuthoritativeContextProof) &&
    (actionLocator.verified === true || proof.verified === true) &&
    proof.count === 1 &&
    proof.sameElement === true &&
    hasExactActionNodeIdentity(proof) &&
    (persistedAuthoritativeContextProof || (
      domAtlas &&
      Array.isArray(domAtlas.verifiedActions) &&
      domAtlas.verifiedActions.length > 0
    )) &&
    locatorExpressionIsExportSafe(expression)
  );
}

module.exports = {
  hasExactActionNodeIdentity,
  hasPersistedAuthoritativeContextProof,
  isVerifiedActionLocator,
  locatorExpressionIsExportSafe,
};
