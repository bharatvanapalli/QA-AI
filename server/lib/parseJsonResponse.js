'use strict';

/**
 * Robust JSON parser for LLM responses.
 *
 * Why this exists:
 *   Different providers wrap JSON differently. Anthropic mostly returns clean
 *   JSON when asked; Gemini frequently adds preamble ("Here is the plan:"),
 *   markdown code fences, or trailing prose ("Let me know if you need more
 *   detail."). A naive `JSON.parse` fails on all of those. Every agent that
 *   asks the model for structured JSON should funnel through this helper.
 *
 * Recovery strategies, tried in order:
 *   1. Direct JSON.parse on the trimmed text.
 *   2. Extract from a ```json …``` fenced block.
 *   3. Extract from first opener (`{` or `[`) to last matching closer.
 *   4. Truncation recovery — walk the depth counter forward, slice at the
 *      last position where we returned to top-level, append the closer.
 *
 * Optional `type` parameter accepts 'array' or 'object'; the parser will only
 * return values of that shape. With no type the first successful parse is
 * returned regardless of shape.
 *
 * Returns the parsed value, or null if every strategy failed. Callers should
 * treat null as "model produced unparseable output" and surface that to the
 * user — the upstream cause is almost always a model that ignored the
 * "JSON only, no preamble" rule.
 */
function parseJsonResponse(raw, { type } = {}) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim();
  const check = (v) => {
    if (type === 'array') return Array.isArray(v) ? v : null;
    if (type === 'object') return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    return v;
  };

  // 1. Direct parse
  try { const v = JSON.parse(text); const c = check(v); if (c !== null) return c; } catch (_) {}

  // 2. Markdown fence ```json ... ```
  const fence = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try { const v = JSON.parse(fence[1].trim()); const c = check(v); if (c !== null) return c; } catch (_) {}
  }

  // 3. First-opener-to-last-closer extraction
  const tryRange = (opener, closer) => {
    const first = text.indexOf(opener);
    const last = text.lastIndexOf(closer);
    if (first === -1 || last <= first) return null;
    try {
      const v = JSON.parse(text.slice(first, last + 1));
      return check(v);
    } catch (_) { return null; }
  };
  if (type === 'array') {
    const r = tryRange('[', ']'); if (r !== null) return r;
  } else if (type === 'object') {
    const r = tryRange('{', '}'); if (r !== null) return r;
  } else {
    // Try both; prefer whichever appears first in the text.
    const objFirst = text.indexOf('{');
    const arrFirst = text.indexOf('[');
    const order = arrFirst !== -1 && (arrFirst < objFirst || objFirst === -1)
      ? [['[', ']'], ['{', '}']]
      : [['{', '}'], ['[', ']']];
    for (const [o, c] of order) {
      const r = tryRange(o, c); if (r !== null) return r;
    }
  }

  // 4. Truncation recovery for object/array (the model stopped mid-output,
  //    or max_tokens cut it off). Walk forward tracking brace depth; when
  //    we last returned to top-level (depth 1) on a closer, truncate there.
  if (type === 'array' || type === 'object') {
    const opener = type === 'array' ? '[' : '{';
    const closer = type === 'array' ? ']' : '}';
    const first = text.indexOf(opener);
    if (first !== -1) {
      const body = text.slice(first);
      let depth = 0;
      let inString = false;
      let escape = false;
      let lastSafeEnd = -1;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (escape) { escape = false; continue; }
        if (inString) {
          if (c === '\\') { escape = true; continue; }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 1 && c === '}') lastSafeEnd = i;
        }
      }
      if (lastSafeEnd > 0) {
        const salvaged = body.slice(0, lastSafeEnd + 1) + closer;
        try { const v = JSON.parse(salvaged); const c = check(v); if (c !== null) return c; } catch (_) {}
      }
    }
  }

  return null;
}

module.exports = { parseJsonResponse };
