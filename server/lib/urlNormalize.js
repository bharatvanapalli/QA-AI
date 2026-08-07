'use strict';

/**
 * Phase H M2 — URL normalization for verdict-layer URL matching.
 *
 * Used by the post-loop ratification path (M4) when comparing the agent's
 * captured visitedUrls to a declared assertion's targetUrl. SPAs append
 * `?tab=overview` / `#section` to almost every navigation; exact-match
 * Set.has() on raw URLs would false-flip transient_window_missed →
 * agent_never_reached on otherwise-correct cases.
 *
 * Normalization rules (applied before insert AND before query):
 *   1. Strip query string  ("?foo=bar")
 *   2. Strip fragment      ("#section")
 *   3. Decode percent-escapes where safe (leave path safe; no double-decode)
 *   4. Collapse repeated slashes ("//api//x" → "/api/x")
 *   5. Trim trailing slash UNLESS the path is exactly "/" (preserve root)
 *   6. Lowercase the host (case-insensitive per RFC); leave path case intact
 *      (path case can be load-bearing on some SUTs).
 *
 * Returns the canonical form. Pure function; no side effects.
 *
 * Examples:
 *   "https://EXAMPLE.com/Dashboard/?tab=overview" → "https://example.com/Dashboard"
 *   "/Dashboard/"                                  → "/Dashboard"
 *   "/dashboard?session=abc#top"                   → "/dashboard"
 *   "/"                                            → "/"
 */
function normalizeUrl(input) {
  if (typeof input !== 'string' || !input) return '';
  let s = input.trim();

  // Strip fragment first (handles "/foo#bar?baz" → "/foo")
  const hashIdx = s.indexOf('#');
  if (hashIdx !== -1) s = s.slice(0, hashIdx);

  // Strip query string
  const qIdx = s.indexOf('?');
  if (qIdx !== -1) s = s.slice(0, qIdx);

  // Detect absolute (http://, https://) vs relative path
  const isAbsolute = /^https?:\/\//i.test(s);
  if (isAbsolute) {
    // Split scheme://host/path; lowercase scheme + host, leave path alone.
    const protoEnd = s.indexOf('://') + 3;
    const pathStart = s.indexOf('/', protoEnd);
    if (pathStart === -1) {
      // No path component: "https://example.com" → "https://example.com"
      return s.slice(0, protoEnd).toLowerCase() + s.slice(protoEnd).toLowerCase();
    }
    const prefix = s.slice(0, pathStart).toLowerCase();
    let path = s.slice(pathStart);
    path = path.replace(/\/{2,}/g, '/');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return prefix + path;
  }

  // Relative path
  let p = s.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Extract just the path portion (no scheme/host) from a possibly-absolute URL,
 * normalized. Used when matching against `targetUrl` which may be declared as
 * either a relative path ("/dashboard") or an absolute URL.
 *
 *   "https://example.com/dashboard?x=1" → "/dashboard"
 *   "/dashboard/"                        → "/dashboard"
 */
function normalizePath(input) {
  const n = normalizeUrl(input);
  if (!n) return '';
  if (/^https?:\/\//i.test(n)) {
    const protoEnd = n.indexOf('://') + 3;
    const pathStart = n.indexOf('/', protoEnd);
    return pathStart === -1 ? '/' : n.slice(pathStart);
  }
  return n;
}

/**
 * Test whether `visitedSet` (a Set<string> of normalized paths) contains a
 * match for `target`. Match semantics: exact equality on normalized path. We
 * intentionally do NOT do prefix-match on relatives — "/dashboard" should not
 * match "/dashboard/settings" since the user is asking about a specific page.
 *
 * Used by M4 post-loop ratification to disambiguate transient_window_missed
 * (target was visited, agent moved on) from agent_never_reached (target
 * never visited).
 */
function visitedSetContains(visitedSet, target) {
  if (!visitedSet || !(visitedSet instanceof Set)) return false;
  const normTarget = normalizePath(target);
  if (!normTarget) return false;
  if (visitedSet.has(normTarget)) return true;
  // Also check exact-match on the absolute form, in case visited entries
  // were stored absolute (defensive — recommended insertion uses normalizePath).
  return visitedSet.has(normalizeUrl(target));
}

module.exports = { normalizeUrl, normalizePath, visitedSetContains };
