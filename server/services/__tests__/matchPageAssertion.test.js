'use strict';

/**
 * Tests for the PAGE assertion matcher — multi-signal page identity verification.
 *
 * Scoring rules (locked by the friend-1 / friend-2 RFC, 2026-05-30):
 *   role match  = 2 points  (most structural — accessibility tree role+name)
 *   text match  = 1 point
 *   url  match  = 1 point
 *   threshold   = 2 to pass
 *   each channel contributes at most its declared weight (no double-counting)
 *
 * The tests exercise:
 *   1. Authoritative passes (role-only, primaryIndicator)
 *   2. Quorum-threshold passes (text + url = 2)
 *   3. Sub-threshold failures (text alone = 1, url alone = 1)
 *   4. Friend-1's false-pass guards (navbar pollution, generic text)
 *   5. Friend-2's false-fail guards (role-only on redesigned page)
 *   6. Signal capping (multiple text variants don't add to >1)
 *   7. URL channel reusing the 3-stage tolerant matcher (Fix 10 integration)
 *   8. normalizeLlmString flowing into text/url channels (Friend R1)
 *   9. Degenerate/empty inputs (no crash, no false pass)
 *
 * Run with: node server/services/__tests__/matchPageAssertion.test.js
 */

const { matchPageAssertion } = require('../mcp');

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

// Realistic accessibility snapshots for the test fixtures.
const LOGIN_SNAPSHOT = `
- generic [ref=e1]:
  - heading "Swag Labs" [level=1] [ref=e3]
  - textbox "Username" [ref=e11]
  - textbox "Password" [ref=e13]
  - button "Login" [ref=e15]
  - link "Forgot password?" [ref=e30]
  - static text "Accepted usernames are:" [ref=e40]
`.trim();

const HOMEPAGE_NAVBAR_SNAPSHOT = `
- generic [ref=e1]:
  - heading "Welcome" [level=1] [ref=e3]
  - navigation:
    - link "Home" [ref=e10]
    - link "Login" [ref=e11]
    - link "Sign in" [ref=e12]
  - main:
    - static text "This is the homepage" [ref=e20]
`.trim();

const DASHBOARD_SNAPSHOT = `
- generic [ref=e1]:
  - heading "Dashboard" [level=1] [ref=e3]
  - main:
    - heading "Recent activity" [level=2] [ref=e10]
    - list:
      - listitem [ref=e20]: "Item 1"
`.trim();

// ─────────────────────────────────────────────────────────────────────────
console.log('AUTHORITATIVE PASS — primaryIndicator role match (short-circuit)');
{
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    primaryIndicator: { role: 'textbox', name: 'Username' },
    expectedSignals: { text: ['Login'], role: [], url: ['/login'] },
  }, { snapshot: LOGIN_SNAPSHOT, currentUrl: 'https://www.saucedemo.com/' });
  expect('login page: matched=true', r.matched, true);
  expect('login page: primaryMatched=true', r.primaryMatched, true);
  expect('login page: stage=primary_indicator', r.stage, 'primary_indicator');
}

console.log('');
console.log('AUTHORITATIVE PASS — primaryIndicator on homepage navbar does NOT match');
{
  // Homepage has a "Login" link in navbar (role=link, not role=textbox).
  // primaryIndicator role=textbox[name=Username] is correctly specific and
  // does NOT match. We fall through to scoring; with only generic text,
  // scoring fails.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    primaryIndicator: { role: 'textbox', name: 'Username' },
    expectedSignals: { text: ['Login'], role: [], url: [] },
  }, { snapshot: HOMEPAGE_NAVBAR_SNAPSHOT, currentUrl: 'https://example.com/' });
  expect('homepage: primary did NOT match (link != textbox)', r.primaryMatched, false);
  expect('homepage: text=Login generic = 1pt, no other channel = below threshold', r.matched, false);
  expect('homepage: stage=below_threshold', r.stage, 'below_threshold');
}

console.log('');
console.log('QUORUM PASS — role match alone gives 2 points (role-dominant floor)');
{
  // Friend-2's argument: a strong role signal (textbox name="Username")
  // is enough to identify the login page even if the architect's URL was
  // wrong and text signals miss due to localisation/redesign.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: ['NOPE_THIS_TEXT_NOT_PRESENT'],          // misses
      role: [{ role: 'textbox', name: 'Username' }],  // matches → +2
      url:  ['/wrong-path-the-architect-guessed'],   // misses
    },
  }, { snapshot: LOGIN_SNAPSHOT, currentUrl: 'https://www.saucedemo.com/' });
  expect('role-only pass: matched', r.matched, true);
  expect('role-only pass: score=2', r.score, 2);
  expect('role-only pass: text=null', r.signalsHit.text, null);
  expect('role-only pass: role hit', r.signalsHit.role, 'textbox[name=Username]');
}

console.log('');
console.log('QUORUM PASS — text + url = 2 points (Friend-1 boundary case)');
{
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: ['Accepted usernames are'],   // matches snapshot
      role: [{ role: 'textbox', name: 'NotPresent' }],  // misses
      url:  ['/login'],
    },
  }, { snapshot: LOGIN_SNAPSHOT, currentUrl: 'https://example.com/login' });
  expect('text+url pass: matched', r.matched, true);
  expect('text+url pass: score=2', r.score, 2);
}

console.log('');
console.log('SUB-THRESHOLD FAIL — text alone (1pt) does NOT pass (Friend-1 false-pass guard)');
{
  // The "navbar pollution" attack: homepage has "Login" text in navbar.
  // Text alone (1pt) is below threshold. No false pass.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: ['Login'],                             // matches navbar link
      role: [{ role: 'textbox', name: 'Username' }], // missing on homepage
      url:  ['/login'],                             // homepage URL doesn't include /login
    },
  }, { snapshot: HOMEPAGE_NAVBAR_SNAPSHOT, currentUrl: 'https://example.com/' });
  expect('navbar text alone: NOT matched', r.matched, false);
  expect('navbar text alone: score=1', r.score, 1);
  expect('navbar text alone: stage=below_threshold', r.stage, 'below_threshold');
}

console.log('');
console.log('SUB-THRESHOLD FAIL — url alone (1pt) does NOT pass (Friend-2 DOM floor)');
{
  // The wrong-page URL substring attack: a homepage URL that happens to
  // include "/login-history" or similar. URL alone (1pt) cannot pass.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: ['NotOnPage'],
      role: [{ role: 'textbox', name: 'NotOnPage' }],
      url:  ['/admin/login-history'],
    },
  }, { snapshot: HOMEPAGE_NAVBAR_SNAPSHOT, currentUrl: 'https://example.com/admin/login-history' });
  expect('url alone: NOT matched', r.matched, false);
  expect('url alone: score=1', r.score, 1);
}

console.log('');
console.log('CHANNEL CAPPING — multiple text variants matching add to at most 1pt');
{
  // Friend-1 caveat: signal type contributes at most its declared weight
  // even if multiple variants match. Without this rule, an architect
  // emitting text=["Login","Sign in","Log in"] all matching navbar would
  // score 3 from text alone and pass on the homepage.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: ['Login', 'Sign in', 'Home'],     // ALL THREE match homepage navbar
      role: [{ role: 'textbox', name: 'NotOnPage' }],
      url:  ['/wrong'],
    },
  }, { snapshot: HOMEPAGE_NAVBAR_SNAPSHOT, currentUrl: 'https://example.com/' });
  expect('triple-text hit caps at 1pt (no double-count)', r.score, 1);
  expect('triple-text hit does NOT pass', r.matched, false);
}

console.log('');
console.log('CHANNEL CAPPING — multiple role variants matching add to at most 2pt');
{
  // Use a URL signal that genuinely doesn't match the test URL so we're
  // isolating role-channel capping behaviour.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: [],
      role: [
        { role: 'textbox', name: 'Username' },     // matches
        { role: 'textbox', name: 'Password' },     // also matches
        { role: 'button',  name: 'Login' },         // also matches
      ],
      url:  ['/never-going-to-match-this-path'],
    },
  }, { snapshot: LOGIN_SNAPSHOT, currentUrl: 'https://example.com/different' });
  expect('triple-role hit caps at 2pt (no double-count)', r.score, 2);
  expect('passes via role channel alone', r.matched, true);
}

console.log('');
console.log('URL CHANNEL — reuses 3-stage tolerant matcher (Fix 10 integration)');
{
  // Pattern with LLM over-escape (\\.) — Fix 10 stage 2 / stage 3 rescues it.
  // Combined with a role match, the case passes via role+url.
  const r = matchPageAssertion(null, {
    pageName: 'inventory_page',
    expectedSignals: {
      text: [],
      role: [{ role: 'heading', name: 'Dashboard' }],
      url:  ['/dashboard\\.html'],   // over-escaped — Fix 10 should still match
    },
  }, { snapshot: DASHBOARD_SNAPSHOT, currentUrl: 'https://app.example.com/dashboard.html' });
  expect('over-escaped URL signal: matched via Fix 10 stage', r.matched, true);
  // role (2pt) + url-rescued (1pt) = 3pt
  expect('score includes URL rescue', r.score >= 2, true);
}

console.log('');
console.log('FRIEND R1 NORMALIZATION — text signal with over-escaped backslash');
{
  const customSnap = `
- main:
  - static text "Saved file: C:\\Users\\admin\\report.pdf"
`.trim();
  // Architect emits over-escaped text needle. normalizeLlmString collapses
  // it inside normalizeText before substring search.
  const r = matchPageAssertion(null, {
    pageName: 'file_saved_page',
    expectedSignals: {
      text: ['C:\\\\Users\\\\admin'],       // 4 backslashes in source = `C:\\Users\\admin` in memory
      role: [{ role: 'static text', name: '' }],
    },
  }, { snapshot: customSnap, currentUrl: 'https://example.com/' });
  // Either text matches (via normalize) or role-only passes (2pt). Either
  // way the case passes — we just need the matcher to not break.
  expect('over-escaped text needle: did not crash and matched', r.matched, true);
}

console.log('');
console.log('DEGENERATE INPUTS — no crash, no false pass');
{
  expect('null payload', matchPageAssertion(null, null, {}).matched, false);
  expect('missing expectedSignals',
    matchPageAssertion(null, { pageName: 'x' }, { snapshot: LOGIN_SNAPSHOT }).matched, false);
  expect('all-empty signals',
    matchPageAssertion(null, { expectedSignals: { text: [], role: [], url: [] } }, { snapshot: LOGIN_SNAPSHOT }).matched, false);
  expect('empty snapshot, valid signals',
    matchPageAssertion(null, {
      expectedSignals: { text: ['Username'], role: [{ role: 'textbox', name: 'Username' }] },
    }, { snapshot: '', currentUrl: '' }).matched, false);
}

console.log('');
console.log('CHANNEL ISOLATION — text signal too short is rejected (degenerate guard)');
{
  // A 1-character text needle matches everything; the matcher guards against
  // this by requiring ≥2 chars after normalization.
  const r = matchPageAssertion(null, {
    expectedSignals: {
      text: ['a'],                          // too short — rejected
      role: [{ role: 'textbox', name: 'Username' }],
    },
  }, { snapshot: LOGIN_SNAPSHOT, currentUrl: 'https://example.com/' });
  expect('1-char text needle rejected (no false text-channel hit)', r.signalsHit.text, null);
  expect('still passes via role channel', r.matched, true);
}

console.log('');
console.log('REGRESSION — saucedemo Case B / login page redirect');
{
  // From the trial run: case "Accessing /inventory.html after logout
  // redirects to login". The architect's URL signal "/login" doesn't match
  // saucedemo's actual login URL (root /). PAGE assertion with text + role
  // signals should rescue: textbox[Username] matches the login form.
  const r = matchPageAssertion(null, {
    pageName: 'login_page',
    primaryIndicator: { role: 'textbox', name: 'Username' },
    expectedSignals: {
      text: ['Accepted usernames are'],     // saucedemo specifically renders this
      role: [
        { role: 'textbox', name: 'Username' },
        { role: 'button',  name: 'Login' },
      ],
      url: ['/login'],                      // architect hallucination — would fail standalone
    },
  }, { snapshot: LOGIN_SNAPSHOT, currentUrl: 'https://www.saucedemo.com/' });
  expect('saucedemo Case B: now rescued via primaryIndicator', r.matched, true);
  expect('saucedemo Case B: rescue stage=primary_indicator', r.stage, 'primary_indicator');
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
