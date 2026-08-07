'use strict';

/**
 * Tests for the two new architect output validators:
 *   - P0-15 markUnderspecifiedPage  (PAGE assertion needs ≥2 channels)
 *   - P0-16 markBundledMultiUrl     (no bundled multi-URL redirect cases)
 *
 * Run with:
 *   node server/services/agents/__tests__/pageGroundingRules.test.js
 */

const { markUnderspecifiedPage, markBundledMultiUrl } = require('../architect');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

function scenWithCase(c) {
  return [{ name: 'Scen', cases: [c] }];
}

// ─────────────────────────────────────────────────────────────────────────
console.log('P0-15 — PAGE with text + role + url: VALID (no demotion)');
{
  const c = {
    name: 'login redirect',
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'ASN-x', type: 'PAGE',
      payload: {
        pageName: 'login_page',
        expectedSignals: {
          text: ['Username'],
          role: [{ role: 'textbox', name: 'Username' }],
          url:  ['/login'],
        },
      },
    }],
  };
  const r = markUnderspecifiedPage(scenWithCase(c));
  expect('validCount=1', r.validCount, 1);
  expect('demotedCount=0', r.demotedCount, 0);
  expect('parseFailed not set', c.declaredAssertions[0].parseFailed, undefined);
}

console.log('');
console.log('P0-15 — PAGE with text + role only (no url): VALID (2 channels)');
{
  const c = {
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'ASN-y', type: 'PAGE',
      payload: {
        pageName: 'login_page',
        expectedSignals: {
          text: ['Username'],
          role: [{ role: 'textbox', name: 'Username' }],
        },
      },
    }],
  };
  const r = markUnderspecifiedPage(scenWithCase(c));
  expect('text+role qualifies (2 channels)', r.validCount, 1);
  expect('no demotion', r.demotedCount, 0);
}

console.log('');
console.log('P0-15 — PAGE with role only (1 channel): DEMOTED');
{
  const c = {
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'ASN-z', type: 'PAGE',
      payload: {
        pageName: 'login_page',
        expectedSignals: {
          role: [{ role: 'textbox', name: 'Username' }],
        },
      },
    }],
  };
  const r = markUnderspecifiedPage(scenWithCase(c));
  expect('role-only demoted', r.demotedCount, 1);
  expect('parseFailed=true', c.declaredAssertions[0].parseFailed, true);
  expect('reason=underspecified_page',
    c.declaredAssertions[0].parseFailedReason, 'underspecified_page');
}

console.log('');
console.log('P0-15 — PAGE with empty arrays masquerading as populated: DEMOTED');
{
  const c = {
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'ASN-empty', type: 'PAGE',
      payload: {
        pageName: 'foo',
        expectedSignals: {
          text: ['', '   '],          // whitespace-only, not populated
          role: [],                    // empty
          url:  ['/foo'],
        },
      },
    }],
  };
  const r = markUnderspecifiedPage(scenWithCase(c));
  expect('whitespace-text + empty-role + url-only = 1 channel populated → demoted', r.demotedCount, 1);
}

console.log('');
console.log('P0-15 — non-PAGE assertion is left alone');
{
  const c = {
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'ASN-text', type: 'TEXT',
      payload: { expectedText: 'hello' },
    }],
  };
  const r = markUnderspecifiedPage(scenWithCase(c));
  expect('TEXT assertion not counted', r.validCount, 0);
  expect('TEXT assertion not demoted', r.demotedCount, 0);
  expect('parseFailed untouched', c.declaredAssertions[0].parseFailed, undefined);
}

console.log('');
console.log('P0-15 — already-failed PAGE is skipped (no double-stamp)');
{
  const c = {
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'ASN-prev', type: 'PAGE',
      parseFailed: true,
      parseFailedReason: 'some_earlier_reason',
      payload: { expectedSignals: { text: ['x'] } },   // would be demoted otherwise
    }],
  };
  const r = markUnderspecifiedPage(scenWithCase(c));
  expect('skipped, not re-demoted', r.demotedCount, 0);
  expect('original reason preserved',
    c.declaredAssertions[0].parseFailedReason, 'some_earlier_reason');
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('P0-16 — bundled multi-URL redirect case: DEMOTED to manual');
{
  const c = {
    name: 'Unauthenticated direct access to protected routes redirects to login',
    automatability: 'automatable',
    declaredAssertions: [
      { id: 'A', type: 'PAGE', targetUrl: '/inventory.html', payload: {
        expectedSignals: { text: ['Username'], role: [{ role: 'textbox', name: 'Username' }] } } },
      { id: 'B', type: 'PAGE', targetUrl: '/cart.html', payload: {
        expectedSignals: { text: ['Username'], role: [{ role: 'textbox', name: 'Username' }] } } },
      { id: 'C', type: 'PAGE', targetUrl: '/checkout.html', payload: {
        expectedSignals: { text: ['Username'], role: [{ role: 'textbox', name: 'Username' }] } } },
    ],
  };
  const r = markBundledMultiUrl(scenWithCase(c));
  expect('1 case demoted', r.demotedCases, 1);
  expect('3 assertions flagged', r.flaggedAssertions, 3);
  expect('case is now manual', c.automatability, 'manual');
  expect('all assertions parseFailed', c.declaredAssertions.every((a) => a.parseFailed === true), true);
  expect('reason=bundled_multi_url',
    c.declaredAssertions[0].parseFailedReason, 'bundled_multi_url');
  expect('automatabilityReason includes "Split"',
    /Split/.test(c.automatabilityReason || ''), true);
}

console.log('');
console.log('P0-16 — single targetUrl PAGE case is left alone');
{
  const c = {
    name: 'Accessing /inventory.html after logout redirects to login',
    automatability: 'automatable',
    declaredAssertions: [{
      id: 'A', type: 'PAGE', targetUrl: '/inventory.html',
      payload: { expectedSignals: { text: ['Username'], role: [{ role: 'textbox', name: 'Username' }] } },
    }],
  };
  const r = markBundledMultiUrl(scenWithCase(c));
  expect('single-target not demoted', r.demotedCases, 0);
  expect('case still automatable', c.automatability, 'automatable');
}

console.log('');
console.log('P0-16 — multi-URL but NOT redirect-shaped is left alone');
{
  // A legit case with multiple PAGE assertions targeting different pages
  // (e.g. "Verify the dashboard then navigate to settings") is multi-URL
  // but isn't bundled-redirect — leave it alone.
  const c = {
    name: 'Dashboard then settings flow',
    automatability: 'automatable',
    declaredAssertions: [
      { id: 'A', type: 'PAGE', targetUrl: '/dashboard', payload: {
        expectedSignals: { text: ['Dashboard'], role: [{ role: 'heading', name: 'Dashboard' }] } } },
      { id: 'B', type: 'PAGE', targetUrl: '/settings', payload: {
        expectedSignals: { text: ['Settings'], role: [{ role: 'heading', name: 'Settings' }] } } },
    ],
  };
  const r = markBundledMultiUrl(scenWithCase(c));
  expect('not redirect-shaped, no demotion', r.demotedCases, 0);
  expect('case stays automatable', c.automatability, 'automatable');
}

console.log('');
console.log('P0-16 — manual cases are skipped');
{
  const c = {
    name: 'all routes redirect',
    automatability: 'manual',
    declaredAssertions: [
      { id: 'A', type: 'PAGE', targetUrl: '/a', payload: {} },
      { id: 'B', type: 'PAGE', targetUrl: '/b', payload: {} },
    ],
  };
  const r = markBundledMultiUrl(scenWithCase(c));
  expect('manual case not touched', r.demotedCases, 0);
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
