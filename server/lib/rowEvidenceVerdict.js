'use strict';

/**
 * ROW EVIDENCE VERDICT (audit #2 — wire the deterministic evidence contract into
 * the LIVE conductor verdict).
 *
 * The case-level declaredAssertions are frequently malformed for data-driven rows
 * (e.g. a negative-login PAGE assertion whose pageName is an unresolved token
 * "{{expectedValidationError}}"). Those collapse to `uncheckable` → the verdict
 * ladder returns `needs_human`, FALSE-BLOCKING a row whose LIVE evidence clearly
 * proves the correct outcome (still on login + login form visible + dashboard
 * absent + the inline field error). The fix: for a data-driven row, judge the
 * per-row `requiredEvidence` contract against the live page-state and let its
 * DECISIVE result be the oracle — never the malformed declaredAssertion.
 *
 * Pure + deterministic (no MCP/LLM/DB). The conductor passes the final live
 * snapshot + URL; this reuses the already-proven checker stack:
 *   buildRowEvidenceContract → buildPageState → toCertifiedCheckerPageState
 *   (refuses if a required channel is unobserved — no fake-pass) → judgeRowEvidence
 *   → mapVerdictToRunStatus.
 *
 * Returns { status: 'pass'|'fail'|null, reason, intentClass }:
 *   - 'pass'  — the evidence contract is fully satisfied (`works`). DECISIVE.
 *   - 'fail'  — a NEGATIVE row demonstrably LEFT the entry/login page (reached an
 *               authenticated area) — the inverse bug. URL-only signal, so no
 *               field-error scoping risk. DECISIVE.
 *   - null    — not decisive here (evidence uncertified, or a `bug` from
 *               field-error/form-scoping we won't risk a false-fail on). The
 *               caller keeps the declaredAssertion verdict (needs_human last resort).
 */

const { buildRowEvidenceContract } = require('../services/testDataMatrix');
const { buildPageState, toCertifiedCheckerPageState } = require('../services/pageStateBuilder');
const { judgeRowEvidence, urlMatches } = require('../services/evidenceCheckers');
const { mapVerdictToRunStatus } = require('../services/verdictEngine');

function isNegativeIntent(cls) {
  return cls === 'required_validation' || cls === 'auth_rejection' || cls === 'boundary';
}

function judgeRowFromLiveSnapshot({ row, snapshotText, url, networkLog = null, consoleErrors = null, entryUrlPattern = null, authedUrlPattern = null } = {}) {
  if (!row) return { status: null, reason: 'no_row' };
  let contract;
  try { contract = buildRowEvidenceContract(row); } catch (e) { return { status: null, reason: `contract_error:${e && e.message}` }; }
  const re = (contract && Array.isArray(contract.requiredEvidence)) ? contract.requiredEvidence : [];
  const intentClass = contract && contract.intentClass;
  if (!re.length) return { status: null, reason: 'no_required_evidence', intentClass };

  // Decisive inverse-bug FIRST (URL-only, no dependency on full evidence
  // certification): a NEGATIVE row whose final URL LEFT the entry/login page
  // reached an authenticated area when it should have stayed put. This is the
  // inverse bug and the URL alone proves it — so it must be checked BEFORE the
  // evidence-certification gate (on the dashboard the login-form / field-error
  // channels are legitimately empty and would otherwise short-circuit to defer).
  if (isNegativeIntent(intentClass) && url && entryUrlPattern && !urlMatches(url, entryUrlPattern)) {
    return { status: 'fail', reason: `evidence_contract:${intentClass}:reached_destination`, intentClass };
  }

  let ps;
  try { ps = buildPageState({ snapshotText, url, networkLog, consoleErrors, settled: true }); }
  catch (e) { return { status: null, reason: `pagestate_error:${e && e.message}`, intentClass }; }

  const certified = toCertifiedCheckerPageState(ps, re, { entryUrlPattern, authedUrlPattern });
  if (!certified.ok) {
    // A required channel could not be observed from the live snapshot. Do NOT
    // decide — let the declaredAssertion verdict stand (needs_human last resort).
    return { status: null, reason: 'evidence_uncertified', intentClass, pending: certified.pending };
  }

  const ev = judgeRowEvidence({ requiredEvidence: re }, certified.checkerPageState);
  if (ev && ev.verdict === 'works') {
    return { status: 'pass', reason: `evidence_contract:${intentClass}:works`, intentClass };
  }
  // A `bug` for other reasons (field-error scoping / form not visible in the
  // snapshot) is NOT decisive enough to risk a false fail — defer.
  return { status: null, reason: `evidence_contract:${intentClass}:${ev && ev.verdict}`, intentClass, verdict: ev && ev.verdict };
}

module.exports = { judgeRowFromLiveSnapshot, isNegativeIntent };
