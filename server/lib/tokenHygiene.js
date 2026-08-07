'use strict';

/**
 * The ONE token-hygiene engine. Used by the coverage planner (per-case repair) and the canonical
 * persistence writer (universal guarantee, every route) so corrupted {{placeholder}} tokens can
 * never reach storage regardless of which generation path produced the case.
 *
 * All rules key off the {{...}} adjacency pattern — never a site/word-specific string — so they
 * are generic and idempotent. Properly space-separated tokens are left untouched (the runner still
 * substitutes those at execution time).
 */

// Remove/repair {{token}} placeholders that are corrupting words, over-wrapped, or fused to URLs.
function sanitizeTokenCorruptions(value) {
  if (typeof value !== 'string') return value;
  let s = value;
  // 0. Collapse over-wrapped tokens FIRST: "{{{{password}}}}" / "{{{role}}}" → "{{password}}".
  //    Must run before the de-fuse passes so a collapsed token reads as a clean standalone.
  s = s.replace(/\{{2,}\s*([a-zA-Z0-9_]+)\s*\}{2,}/g, '{{$1}}');
  // 1. Token appended directly to a URL: "https://site.com{{expected}}" → "https://site.com"
  s = s.replace(/(https?:\/\/[^\s"'\]]+?)\{\{[^}]+\}\}/g, '$1');
  // 2. Token fused mid-word: "s{{role}}ion" → de-fuse (last-resort; prevention happens upstream
  //    in the boundary-aware replacer, so this rarely fires).
  s = s.replace(/([a-zA-Z])\{\{[^}]+\}\}([a-zA-Z])/g, '$1$2');
  // 3. Token fused at start of word (no letter before): "{{role}}Admin" → "Admin"
  s = s.replace(/\{\{[^}]+\}\}(?=[a-zA-Z])/g, '');
  // 4. Token fused at end of word (no letter/brace after): "Admin{{role}}" → "Admin"
  s = s.replace(/([a-zA-Z])\{\{[^}]+\}\}(?![a-zA-Z\s{}])/g, '$1');
  // 5. Collapse redundant '//' INSIDE an http(s) URL (".../index.php//viewSystemUsers" →
  //    ".../index.php/viewSystemUsers"), preserving the scheme "://". Scoped to URL substrings so
  //    ordinary prose is untouched. This is the canonical-writer guarantee — it runs on every
  //    persisted string, so a malformed deep-link can never reach storage regardless of which
  //    upstream normalizer ran.
  s = s.replace(/(https?:\/\/[^\s"'<>]+)/gi, (m) => m.replace(/([^:])\/{2,}/g, '$1/'));
  return s;
}

// Recursively sanitize every string in an object/array (used for steps[]/declaredAssertions[]).
function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeTokenCorruptions(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out;
  }
  return value;
}

// Boundary-aware literal→token replacement: replaces the literal only as a standalone token,
// never inside a larger word and never inside an existing {{...}} placeholder. Generic.
function replaceLiteralBoundaryAware(text, literal, token) {
  if (typeof text !== 'string' || !literal || literal.length < 3 || !text.includes(literal)) return text;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9{])${escaped}(?![A-Za-z0-9}])`, 'g');
  return text.replace(re, token);
}

module.exports = { sanitizeTokenCorruptions, sanitizeDeep, replaceLiteralBoundaryAware };
