'use strict';

/**
 * Shared message-class vocabulary — the ONE place that decides whether a piece
 * of observed page text is a validation/error message and what class it is.
 *
 * Used by BOTH the upstream observer (pageStateBuilder — classifies the error
 * text it finds in a snapshot) and the downstream checker (evidenceCheckers —
 * matches a required messageClass against observed text), so the two layers
 * can never drift on "is this a 'required' error vs an 'auth' error".
 *
 * Generic, language-leaning-English heuristics — no site strings. (B-2b's DOM
 * channel will add aria-invalid / error-container signals that don't depend on
 * the copy at all.)
 */

// A field-level "you must fill this" validation message.
const REQUIRED_MSG_RE = /required|cannot be empty|must be|mandatory|is missing|please (?:enter|fill|provide)/i;
// A general rejection (auth failure, invalid value, locked, etc.).
const AUTH_ERR_RE = /invalid|incorrect|denied|not found|do not match|wrong|unauthori[sz]ed|disabled|locked|failed/i;
// Generic "this is an error message at all" gate (kept deliberately broad but
// not so broad it captures ordinary labels/headings).
const ERROR_TEXT_RE = /required|cannot be empty|mandatory|is missing|invalid|incorrect|denied|do not match|unauthori[sz]ed|locked|failed|\berror\b|not valid|must be|please (?:enter|fill|provide)/i;

/** Is this text plausibly a validation/error message (vs a label/heading/value)? */
function isErrorText(text) {
  return typeof text === 'string' && ERROR_TEXT_RE.test(text);
}

/** Classify confirmed error text into a messageClass. */
function classifyMessageText(text) {
  const t = typeof text === 'string' ? text : '';
  if (REQUIRED_MSG_RE.test(t)) return 'required';
  if (AUTH_ERR_RE.test(t)) return 'auth';
  return 'generic';
}

module.exports = { REQUIRED_MSG_RE, AUTH_ERR_RE, ERROR_TEXT_RE, isErrorText, classifyMessageText };
