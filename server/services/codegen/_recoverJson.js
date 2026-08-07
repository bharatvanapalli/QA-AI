'use strict';

/**
 * Shared robust recovery of the `{ pageObject: {path, content}, test: {path,
 * content} }` JSON envelope every QAAI codegen prompt asks the model to emit.
 *
 * Why this exists: the models (Gemini especially) frequently emit content
 * strings containing LITERAL newlines, which is invalid JSON and makes strict
 * JSON.parse throw. The old code then wrote the raw JSON blob straight into a
 * .ts/.js/.java file (the "JSON in Output Files" bug). This module recovers the
 * real source via three tiers and NEVER returns the raw text as a file body —
 * a total failure returns null so the caller can emit a labeled stub instead.
 *
 * Tier 1: strict JSON.parse of the whole response.
 * Tier 2: strict JSON.parse of the outermost {...} substring (drops prose).
 * Tier 3: regex salvage of each key's content/path, tolerating literal
 *         newlines (the content character class [^"\\] matches newlines; \\.
 *         consumes escaped quotes so we don't stop at an escaped ").
 *
 * Returns { pageContent, pagePath, testContent, testPath } or null.
 */

// JSON string-body unescape, single left-to-right pass (handles \n \t \" \\ \/ \uXXXX).
function jsonUnescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === '"') out += '"';
      else if (n === '\\') out += '\\';
      else if (n === '/') out += '/';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === 'u') { out += String.fromCharCode(parseInt(s.substr(i + 2, 4), 16) || 0); i += 4; }
      else out += n;
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Pull the { path, content } pair for one top-level key out of a JSON blob even
// when JSON.parse failed (literal newlines / unescaped control chars).
function grabPair(text, key) {
  const block = new RegExp('"' + key + '"\\s*:\\s*\\{([\\s\\S]*?)\\}\\s*(?:,\\s*"\\w+"\\s*:|\\}\\s*$)');
  const bm = text.match(block);
  const scope = bm ? bm[1] : text;
  const cm = scope.match(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const pm = scope.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  return {
    content: cm ? jsonUnescape(cm[1]) : '',
    path: pm ? jsonUnescape(pm[1]) : '',
  };
}

function tryJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Recover a two-file envelope keyed by arbitrary names. The generators ask for
// { pageObject, test } (POM frameworks) or { feature, steps } (BDD); this is
// the shared engine. Returns { aContent, aPath, bContent, bPath } or null.
function recoverTwo(rawText, keyA, keyB) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  const pick = (parsed) => ({
    aContent: parsed[keyA]?.content || '', aPath: parsed[keyA]?.path || '',
    bContent: parsed[keyB]?.content || '', bPath: parsed[keyB]?.path || '',
  });

  // Tier 1: strict parse of the whole response.
  const strict = tryJson(text);
  if (strict) return pick(strict);

  // Tier 2: strict parse of the outermost {...} substring (drops prose).
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sub = tryJson(text.slice(start, end + 1));
    if (sub) return pick(sub);
  }

  // Tier 3: regex salvage (literal newlines / unescaped control chars).
  if (text.includes(`"${keyA}"`) || text.includes(`"${keyB}"`) || text.includes('"content"')) {
    const a = grabPair(text, keyA);
    const b = grabPair(text, keyB);
    if (a.content || b.content) {
      return { aContent: a.content, aPath: a.path, bContent: b.content, bPath: b.path };
    }
  }
  return null;
}

// Recover a single-file envelope keyed by one name (e.g. { auth: {path,content} }).
// Same three-tier robustness as recoverTwo. Returns { content, path } or null.
function recoverOne(rawText, key) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const pick = (parsed) => ({ content: parsed[key]?.content || '', path: parsed[key]?.path || '' });

  const strict = tryJson(text);
  if (strict && strict[key]) return pick(strict);

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const sub = tryJson(text.slice(start, end + 1));
    if (sub && sub[key]) return pick(sub);
  }

  if (text.includes(`"${key}"`) || text.includes('"content"')) {
    const a = grabPair(text, key);
    if (a.content) return { content: a.content, path: a.path };
  }
  return null;
}

// Back-compat shape for the POM generators (pageObject + test).
function parseGeneratedJson(rawText) {
  const r = recoverTwo(rawText, 'pageObject', 'test');
  return r ? { pageContent: r.aContent, pagePath: r.aPath, testContent: r.bContent, testPath: r.bPath } : null;
}

module.exports = { parseGeneratedJson, recoverTwo, recoverOne, jsonUnescape };
