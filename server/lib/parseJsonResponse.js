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
  //    a) Complete fence (both opener and closer present): parse content
  //       inside; if invalid, fall through with the fence-stripped content
  //       so strategies 3 + 4 can attempt repair.
  //    b) Opening fence only (response truncated before the closer was
  //       emitted, which Gemini does often with long plans): strip the
  //       opening and pass the rest forward. Without this, strategy 3's
  //       lastIndexOf('}') misses the case entirely.
  let body = text;
  const fence = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) {
    try { const v = JSON.parse(fence[1].trim()); const c = check(v); if (c !== null) return c; } catch (_) {}
    body = fence[1].trim();
  } else {
    const openOnly = text.match(/^\s*```(?:json|JSON)?\s*\n?/);
    if (openOnly) body = text.slice(openOnly[0].length);
  }

  // 3. First-opener-to-last-closer extraction (scans valid JSON opener positions)
  const tryRange = (opener, closer) => {
    let searchFrom = 0;
    while (searchFrom < body.length) {
      const first = body.indexOf(opener, searchFrom);
      if (first === -1) break;
      const last = body.lastIndexOf(closer);
      if (last <= first) break;
      try {
        const candidate = body.slice(first, last + 1);
        const v = JSON.parse(candidate);
        const c = check(v);
        if (c !== null) return c;
      } catch (_) {}
      searchFrom = first + 1;
    }
    return null;
  };
  if (type === 'array') {
    const r = tryRange('[', ']'); if (r !== null) return r;
  } else if (type === 'object') {
    const r = tryRange('{', '}'); if (r !== null) return r;
  } else {
    // Try both; prefer whichever appears first in the body.
    const objFirst = body.indexOf('{');
    const arrFirst = body.indexOf('[');
    const order = arrFirst !== -1 && (arrFirst < objFirst || objFirst === -1)
      ? [['[', ']'], ['{', '}']]
      : [['{', '}'], ['[', ']']];
    for (const [o, c] of order) {
      const r = tryRange(o, c); if (r !== null) return r;
    }
  }

  // 4. Stack-aware truncation recovery for object/array. Walk the body
  //    tracking the brace/bracket stack. At every valid close (whose
  //    closer matches the top of the stack), record the position AND the
  //    closers still needed to terminate the remaining open scopes. After
  //    the walk, try each recorded point from latest to earliest, slicing
  //    the body up to that close and appending the remaining closers.
  //
  //    This handles arbitrarily-nested truncation — including the case
  //    that broke the previous (depth-1-only) version: a top-level object
  //    with an array of objects (e.g. the Planner's `{ "waves": [...] }`),
  //    where Gemini ran out of tokens mid-wave-array. The previous code
  //    only salvaged on `depth === 1 && c === '}'` (the ROOT close), which
  //    never happens when the response is truncated.
  if (type === 'array' || type === 'object') {
    const rootOpener = type === 'array' ? '[' : '{';
    const first = body.indexOf(rootOpener);
    if (first !== -1) {
      const scanBody = body.slice(first);
      const stack = [];
      const safePoints = []; // [{ pos, remaining }]
      let inString = false;
      let escape = false;
      for (let i = 0; i < scanBody.length; i++) {
        const c = scanBody[i];
        if (escape) { escape = false; continue; }
        if (inString) {
          if (c === '\\') { escape = true; continue; }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') {
          if (stack.length && stack[stack.length - 1] === c) {
            stack.pop();
            // Closers still needed = remaining stack in reverse order
            // (innermost first).
            safePoints.push({ pos: i, remaining: stack.slice().reverse().join('') });
            if (!stack.length) break; // root closed; further chars are postamble
          } else {
            break; // unmatched closer — JSON corrupt past here
          }
        }
      }
      // Try latest to earliest. Latest = most data salvaged; if it has a
      // dangling comma we'll fall back to the previous valid close.
      for (let i = safePoints.length - 1; i >= 0; i--) {
        const sp = safePoints[i];
        const salvaged = scanBody.slice(0, sp.pos + 1) + sp.remaining;
        try { const v = JSON.parse(salvaged); const c = check(v); if (c !== null) return c; } catch (_) {}
        // Trailing comma between this close and the next array/object
        // element is the most common cause; try stripping any whitespace
        // + comma immediately before the closer pos.
        const trimmed = scanBody.slice(0, sp.pos + 1).replace(/,\s*$/, '') + sp.remaining;
        if (trimmed !== salvaged) {
          try { const v = JSON.parse(trimmed); const c = check(v); if (c !== null) return c; } catch (_) {}
        }
      }
    }
  }

  return null;
}

module.exports = { parseJsonResponse };
