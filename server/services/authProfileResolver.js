'use strict';
/**
 * authProfileResolver (Enterprise Mode P4b) — declared auth-profile identity
 * resolution. Pure: no prisma, no LLM (the caller loads the AuthProfile row and
 * passes the record in; the route/conductor act on the resolution). A case binds
 * to an IDENTITY (admin/demo/maker/checker/…), not to a captured session blob.
 *
 * Frozen enums — see ENTERPRISE_MODE.md → "P4 → P4b".
 */

const STRATEGIES = new Set(['form', 'sso', 'token', 'mfa', 'basic', 'none']);
const DISPOSITIONS = new Set(['bypass_fixture', 'supported_test_hook', 'manual_gate', 'unsupported']);

function isStrategy(s) { return STRATEGIES.has(String(s == null ? '' : s).toLowerCase()); }
function isDisposition(d) { return DISPOSITIONS.has(String(d == null ? '' : d).toLowerCase()); }

/**
 * Normalize an AuthProfile record into the run/export resolution contract.
 * `storageStateRef` / `credentialRef` are valueRef-style refs — NEVER inline
 * secrets (the package shell binds them, same discipline as P4a sensitivity):
 *   bypass_fixture       → storageStateRef = "fixture:<authFixtureId>"
 *   supported_test_hook  → credentialRef stays a NAMED key (Project.testCredentials)
 *   manual_gate          → neither (the run pauses for a human)
 *   unsupported          → neither (the case is marked, never silently passed)
 */
function resolveAuthProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const strategy = isStrategy(profile.strategy) ? String(profile.strategy).toLowerCase() : 'form';
  const disposition = isDisposition(profile.disposition) ? String(profile.disposition).toLowerCase() : 'bypass_fixture';
  const out = { name: profile.name || null, strategy, disposition, storageStateRef: null, credentialRef: null };
  if (disposition === 'bypass_fixture' && profile.authFixtureId) out.storageStateRef = `fixture:${profile.authFixtureId}`;
  if (disposition === 'supported_test_hook' && profile.credentialRef) out.credentialRef = String(profile.credentialRef);
  return out;
}

/**
 * Deterministic validation of a profile record. Bad strategy/disposition/name are
 * ERRORS; a disposition that needs a binding but lacks one is a WARNING (surfaced,
 * not silently passed). P9 decides what blocks.
 */
function validateAuthProfile(profile) {
  const findings = [];
  const add = (code, severity, message) => findings.push({ code, severity, message });
  if (!profile || !profile.name) add('auth_profile_no_name', 'error', 'AuthProfile requires a name.');
  if (!isStrategy(profile && profile.strategy)) add('auth_profile_bad_strategy', 'error', 'strategy must be one of form|sso|token|mfa|basic|none.');
  if (!isDisposition(profile && profile.disposition)) add('auth_profile_bad_disposition', 'error', 'disposition must be one of bypass_fixture|supported_test_hook|manual_gate|unsupported.');
  const disp = String((profile && profile.disposition) || '').toLowerCase();
  if (disp === 'bypass_fixture' && !(profile && profile.authFixtureId)) add('auth_profile_fixture_missing', 'warning', 'bypass_fixture has no authFixtureId — the run cannot inject a session until one is attached.');
  if (disp === 'supported_test_hook' && !(profile && profile.credentialRef)) add('auth_profile_credential_missing', 'warning', 'supported_test_hook has no credentialRef — the run cannot authenticate until a credential is named.');
  return { ok: !findings.some((x) => x.severity === 'error'), findings };
}

module.exports = {
  STRATEGIES: [...STRATEGIES],
  DISPOSITIONS: [...DISPOSITIONS],
  isStrategy,
  isDisposition,
  resolveAuthProfile,
  validateAuthProfile,
};
