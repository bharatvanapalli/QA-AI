'use strict';

/**
 * CENTRAL secret redaction for action args before they are persisted or streamed.
 *
 * Two leak shapes, both covered:
 *   1. a secret-NAMED key — password / pwd / token / secret / apiKey / credential;
 *   2. a typed VALUE going INTO a password field — browser_type / browser_fill /
 *      browser_fill_form where the element/target/selector names a password field;
 *      there the secret sits under an innocuous key (`text` / `value`), so
 *      key-matching alone would miss it (the run-91d6301a `admin123` leak).
 *
 * Returns a DEEP CLONE — never mutates the live args object, so codegen can still
 * tokenise the real value into an env var / fixture separately. Pure + deterministic
 * (unit-tested by verify_trace_redaction.cjs).
 */

const SECRET_KEY_RE = /pass|pwd|secret|token|api[_-]?key|credential/i;
const PWD_FIELD_RE = /pass|pwd|type=["']?password|\[password\]/i;
const MASK = '••••••';

function looksLikePasswordField(args) {
  const hint = `${(args && args.element) || ''} ${(args && args.target) || ''} ${(args && args.ref) || ''} ${(args && args.locator_hint) || ''} ${(args && args.selector) || ''}`;
  return PWD_FIELD_RE.test(hint);
}

function redactArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const isPwdField = looksLikePasswordField(args);
  const out = Array.isArray(args) ? [] : {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_KEY_RE.test(k)) { out[k] = MASK; continue; }
    if ((k === 'text' || k === 'value') && isPwdField && typeof v === 'string' && v.length) { out[k] = MASK; continue; }
    if (v && typeof v === 'object') { out[k] = redactArgs(v); continue; }
    out[k] = v;
  }
  return out;
}

/**
 * Redact a flat inputs/record object by KEY only (data-row values: password,
 * sensitivity-masked fields). Used for data.row.start inputs + any place that
 * streams a row's mapped values. `sensitivityHint` lets a row mark itself MASKED.
 */
function redactRecord(record, { maskAll = false } = {}) {
  if (!record || typeof record !== 'object') return record;
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = (maskAll || SECRET_KEY_RE.test(k)) ? MASK : v;
  }
  return out;
}

module.exports = { redactArgs, redactRecord, looksLikePasswordField, SECRET_KEY_RE, PWD_FIELD_RE, MASK };
