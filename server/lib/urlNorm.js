'use strict';

/**
 * Shared URL normaliser used by:
 *   - recordSuccessfulLocator (conductor.js)
 *   - buildManifest page key (_locators.js)
 *   - evidenceRepair batching and cache key
 *   - _replayContract.js gap deduplication
 *
 * Consolidated here to prevent three separate implementations drifting apart.
 */

/**
 * Normalise a page URL to a stable cache/comparison key:
 *   - Strip query string and fragment
 *   - Lower-case
 *   - Trim and cap at 500 chars
 *   - Strip UUID-like path segments (ephemeral resource IDs that change per-record)
 *     e.g. /employees/a1b2c3d4-e5f6-... → /employees/
 */
function normPageUrl(url) {
  if (!url) return '';
  let u = String(url).split(/[?#]/)[0].trim().toLowerCase().slice(0, 500);
  // Strip trailing UUID path segments (resource IDs that differ per row)
  u = u.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/gi, '/');
  // Collapse double slashes introduced by the above
  u = u.replace(/\/\/+/g, '/');
  return u;
}

/**
 * Fallback probe URL: strip the last path segment.
 * Used by evidence repair when the exact URL returns 404 or redirects to login
 * (e.g. /employees/42 → /employees/).
 * Returns the same URL if there's nothing to strip (root or empty).
 */
function normPageUrlFallback(url) {
  const n = normPageUrl(url);
  if (!n) return '';
  // Remove the last non-empty path segment
  const stripped = n.replace(/\/[^/]+\/?$/, '/');
  return stripped === n ? n : stripped; // avoid infinite loop if already at root
}

module.exports = { normPageUrl, normPageUrlFallback };
