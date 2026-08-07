'use strict';

/**
 * Phase H M2 — URL normalization smoke.
 *
 * Run with: node server/lib/__tests__/urlNormalize.test.js
 * Returns non-zero exit on any failure so it can be wired into CI later.
 */

const { normalizeUrl, normalizePath, visitedSetContains } = require('../urlNormalize');

let failures = 0;
function eq(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}
function truthy(label, actual) {
  if (actual) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}  (expected truthy, got ${JSON.stringify(actual)})`);
    failures += 1;
  }
}
function falsy(label, actual) {
  if (!actual) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}  (expected falsy, got ${JSON.stringify(actual)})`);
    failures += 1;
  }
}

console.log('normalizeUrl');
eq('empty', normalizeUrl(''), '');
eq('null', normalizeUrl(null), '');
eq('strips fragment', normalizeUrl('/foo#bar'), '/foo');
eq('strips query', normalizeUrl('/foo?q=1'), '/foo');
eq('strips query+fragment', normalizeUrl('/foo?q=1#bar'), '/foo');
eq('trims trailing slash', normalizeUrl('/foo/'), '/foo');
eq('preserves root slash', normalizeUrl('/'), '/');
eq('collapses double slashes', normalizeUrl('//api//x'), '/api/x');
// Host MUST lowercase (case-insensitive per RFC). Path case MUST be preserved —
// some SUTs route on path case (e.g. /API vs /api as distinct endpoints).
eq('absolute lowercased host, path case preserved', normalizeUrl('https://EXAMPLE.com/Dashboard'), 'https://example.com/Dashboard');
eq('absolute strips query', normalizeUrl('https://example.com/foo?x=1'), 'https://example.com/foo');
eq('absolute trims trailing /', normalizeUrl('https://example.com/foo/'), 'https://example.com/foo');
eq('host-only preserved', normalizeUrl('https://example.com'), 'https://example.com');

console.log('normalizePath');
eq('absolute → path', normalizePath('https://example.com/dashboard?x=1'), '/dashboard');
eq('absolute root → /', normalizePath('https://example.com'), '/');
eq('relative pass-through', normalizePath('/dashboard/'), '/dashboard');
eq('relative with fragment', normalizePath('/foo#bar'), '/foo');

console.log('visitedSetContains');
const visited = new Set([
  normalizePath('/dashboard?tab=overview'),
  normalizePath('https://app.example.com/profile/'),
  normalizePath('/'),
]);
truthy('exact', visitedSetContains(visited, '/dashboard'));
truthy('with query stripped', visitedSetContains(visited, '/dashboard?tab=other'));
truthy('with fragment stripped', visitedSetContains(visited, '/dashboard#section'));
truthy('absolute → path match', visitedSetContains(visited, 'https://app.example.com/profile'));
truthy('root', visitedSetContains(visited, '/'));
falsy('different path', visitedSetContains(visited, '/settings'));
falsy('deeper path is not a match', visitedSetContains(visited, '/dashboard/billing'));
falsy('empty target', visitedSetContains(visited, ''));
falsy('null target', visitedSetContains(visited, null));

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
