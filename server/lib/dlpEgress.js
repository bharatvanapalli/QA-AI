'use strict';

/**
 * Enterprise Mode — DLP / data-residency egress gate.
 *
 * Cognizant policy (and the Enterprise Mode doctrine): BRD / test-data / site
 * content / generated code must not leave approved infrastructure. This module
 * is the single decision point for "may this document text be sent to provider
 * X?" — currently used by the Requirement Oracle before it ships any BRD /
 * user-story / release-note text to an LLM for clause extraction.
 *
 * Policy source: env QAAI_LLM_EGRESS_ALLOW — a comma-separated allow-list of
 * provider names that MAY receive document content (e.g. "claude" or
 * "claude,gemini").
 *   - UNSET / empty  → no egress policy configured → allowed (backward
 *     compatible: today everything already flows to the configured provider).
 *     The gate still exists as the enforcement hook so P9 can flip the org to
 *     deny-by-default without touching call sites.
 *     ⚠ ENTERPRISE / SECURITY MODE (P9): the default INVERTS to DENY — an unset
 *     allow-list will mean "no provider may receive document text" (deterministic
 *     extraction only). Teams MUST set QAAI_LLM_EGRESS_ALLOW before real BRD /
 *     test-data use. See ENTERPRISE_MODE.md → "P2-integration".
 *   - SET            → ONLY the listed providers may receive content. A
 *     provider not on the list is denied → the caller degrades to a
 *     deterministic, no-egress path (never silently leaks).
 *
 * The decision is ALWAYS logged by the caller (egressDisposition supplies the
 * structured reason) so an auditor can see, per generation, whether content
 * left and to where.
 *
 * Pure + deterministic (reads env, no I/O), so scripts/verify_contract.cjs can
 * assert the deny path. Override the env read in tests via opts.allowEnv.
 */

const ENV_KEY = 'QAAI_LLM_EGRESS_ALLOW';

function parseAllowList(raw) {
  return String(raw == null ? '' : raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * @param {string} provider  e.g. 'claude' | 'gemini'
 * @param {object} [opts]
 * @param {string} [opts.allowEnv]  override for the env value (tests)
 * @returns {boolean}
 */
function isProviderEgressAllowed(provider, opts = {}) {
  const raw = opts.allowEnv !== undefined ? opts.allowEnv : process.env[ENV_KEY];
  const list = parseAllowList(raw);
  if (!list.length) return true; // no policy configured → allowed (the hook is inert)
  return list.includes(String(provider || '').trim().toLowerCase());
}

/**
 * Structured disposition for logging + the caller's branch decision.
 * @returns {{ allowed: boolean, policyConfigured: boolean, provider: string, reason: string }}
 */
function egressDisposition(provider, opts = {}) {
  const raw = opts.allowEnv !== undefined ? opts.allowEnv : process.env[ENV_KEY];
  const list = parseAllowList(raw);
  const p = String(provider || '').trim().toLowerCase();
  if (!list.length) {
    return { allowed: true, policyConfigured: false, provider: p, reason: `no ${ENV_KEY} policy set — egress permitted (set the env to enforce an allow-list)` };
  }
  const allowed = list.includes(p);
  return {
    allowed,
    policyConfigured: true,
    provider: p,
    reason: allowed
      ? `provider "${p}" is on ${ENV_KEY} — egress permitted`
      : `provider "${p}" is NOT on ${ENV_KEY} (${list.join(', ')}) — egress DENIED; falling back to deterministic, no-egress extraction`,
  };
}

module.exports = { ENV_KEY, parseAllowList, isProviderEgressAllowed, egressDisposition };
