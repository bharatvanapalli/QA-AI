'use strict';

/**
 * Helpers for fields stored as JSON-encoded strings in SQLite.
 * On Postgres these would be native `String[]` columns, so callers that
 * switch providers later only have to remove these wrappers.
 */

function encodeArray(arr) {
  if (Array.isArray(arr)) return JSON.stringify(arr);
  if (typeof arr === 'string') return arr; // already JSON
  return '[]';
}

function decodeArray(s) {
  if (Array.isArray(s)) return s;
  if (!s || typeof s !== 'string') return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Returns a shallow clone of `row` with the listed string-encoded array
 * fields decoded into real arrays. Skips missing fields silently.
 */
function decodeArrayFields(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (f in out) out[f] = decodeArray(out[f]);
  }
  return out;
}

/**
 * Encode an arbitrary JSON-serialisable value as a TEXT column value for SQLite.
 * On Postgres these would be native `Json` columns.
 */
function encodeJson(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value; // already serialised
  return JSON.stringify(value);
}

function decodeJson(s, fallback = null) {
  if (s === undefined || s === null) return fallback;
  if (typeof s !== 'string') return s; // pass-through object
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

module.exports = { encodeArray, decodeArray, decodeArrayFields, encodeJson, decodeJson };
