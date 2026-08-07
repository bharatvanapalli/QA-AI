'use strict';

/**
 * storageState export (P3 — pre-authenticated suites).
 *
 * THE SSO PROBLEM
 * For SSO / OAuth / SAML / magic-link sites the generated specs CANNOT drive the
 * login flow (redirects to an identity provider, MFA, one-time codes) — and they
 * shouldn't try. The enterprise-correct pattern is to capture the authenticated
 * browser session ONCE (QAAI's E2 AuthFixture = a Playwright storageState blob:
 * cookies + localStorage) and have EVERY exported spec start already logged in
 * via Playwright's `use.storageState`. The login form is never touched in CI.
 * Bonus: even for plain form login this is faster (authenticate once, not per
 * test) and removes login flakiness from every test's critical path.
 *
 * This module bakes a captured state into the exported project and provides the
 * prompt rule that tells codegen to SKIP login when the suite is pre-authed.
 * Pure (fs/path injected) — no prisma.
 */

const STATE_REL = '.auth/state.json';

/** True if the value is a usable Playwright storageState (has cookies/origins). */
function isUsableState(stateJson) {
  let obj = stateJson;
  if (typeof stateJson === 'string') { try { obj = JSON.parse(stateJson); } catch (_) { return false; } }
  if (!obj || typeof obj !== 'object') return false;
  const hasCookies = Array.isArray(obj.cookies) && obj.cookies.length > 0;
  const hasOrigins = Array.isArray(obj.origins) && obj.origins.length > 0;
  return hasCookies || hasOrigins;
}

/** Write the captured state to <root>/.auth/state.json. Returns true on success. */
function writeStorageState(projectRoot, stateJson, fs, path) {
  if (!isUsableState(stateJson)) return false;
  const obj = typeof stateJson === 'string' ? JSON.parse(stateJson) : stateJson;
  const full = path.join(projectRoot, STATE_REL);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(obj, null, 2), 'utf8');
  return true;
}

/** The `use:` config line that wires the baked state in (empty when not pre-authed). */
function configUseLine(preAuthed) {
  return preAuthed
    ? `    // Pre-authenticated: every test starts from this captured session\n    // (SSO/OAuth handled out-of-band; refresh via your QAAI Auth Fixture).\n    storageState: ${JSON.stringify(STATE_REL)},`
    : '';
}

/** Prompt rule: when pre-authed, do NOT author/call login — skip the login steps. */
function preAuthPromptBlock() {
  return `## PRE-AUTHENTICATED SUITE (storageState)
This project is configured with a CAPTURED authenticated session (use.storageState in playwright.config) — every test STARTS ALREADY LOGGED IN. The site uses SSO/an external identity provider, so there is no login form to drive.
- Do NOT call login(), do NOT import the auth helper, do NOT navigate to or fill any login form.
- If the recorded action trail begins with login steps (navigate to /login, type username/password, submit), SKIP them entirely — the captured session already covers them.
- Begin each test by navigating to the authenticated page under test (a deep link / the app's landing route), then perform the actions and assertions.`;
}

module.exports = { STATE_REL, isUsableState, writeStorageState, configUseLine, preAuthPromptBlock };
