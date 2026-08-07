'use strict';

/**
 * Shared PAGE-identity de-poison (used by BOTH the data-matrix binder
 * `testDataMatrix.bindExpectedColumnToAssertion` AND the runtime PAGE matcher
 * `mcp.matchPageAssertion`, so the two layers can never drift).
 *
 * A PAGE assertion's `pageName` is a human IDENTITY LABEL, not data. The
 * architect/matrix sometimes fills it with a row-variable data token
 * ("{{expectedValidationError}}"), and after token substitution that becomes a
 * plain error STRING ("Username is required"). Such a label must NEVER drive a
 * PAGE verdict. `isUntrustedPageName` marks a pageName as UNTRUSTED purely off
 * SHAPE (template braces, prose, "(none)", outcome words, slug/sentence) — never
 * a site string. False positives are harmless: an untrusted label just routes to
 * the structural-signal claim, which is at least as good.
 */
function isUntrustedPageName(name) {
  if (typeof name !== 'string') return true;
  const n = name.trim();
  if (!n) return true;
  if (n.indexOf('{{') !== -1 || n.indexOf('}}') !== -1) return true;   // unbound data token
  const low = n.toLowerCase();
  if (low === '(none)' || low === 'none' || low === 'n/a' || low === 'null'
      || low === 'undefined' || low === 'unknown' || low === 'this page') return true;
  if (n.indexOf(';') !== -1) return true;                              // multi-clause phrase
  if (/[()]/.test(n)) return true;                                     // parenthetical description
  // Split on whitespace AND underscores: the matrix substitutes the data token
  // into pageName, yielding snake_case slugs like "username_is_required" or a
  // plain error sentence "Username is required" — expected-RESULT strings, not
  // page identities. A real page identity is a short noun label.
  const tokens = low.split(/[\s_]+/).filter(Boolean);
  if (n.length > 40 || tokens.length > 4) return true;                 // a sentence/slug, not a label
  const RESULT_WORDS = new Set([
    'is', 'are', 'was', 'were', 'be', 'been', 'must', 'should', 'shall', 'will',
    'require', 'required', 'requires', 'matching', 'visible', 'hidden', 'below', 'above',
    'invalid', 'valid', 'error', 'errors', 'rejection', 'rejected', 'graceful',
    'expected', 'message', 'empty', 'blank', 'missing', 'present', 'absent', 'or',
    'remain', 'remains', 'stay', 'stays', 'redirect', 'redirected', 'redirects',
    'navigate', 'navigated', 'navigates',
    // single-word negative outcomes that can be a substituted error value
    'failed', 'failure', 'denied', 'deny', 'forbidden', 'unauthorized', 'unauthorised',
    'locked', 'lockout', 'timeout', 'timedout', 'incorrect', 'wrong', 'mismatch',
  ]);
  if (tokens.some((t) => RESULT_WORDS.has(t))) return true;
  return false;
}

module.exports = { isUntrustedPageName };
