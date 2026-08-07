'use strict';

/**
 * EVIDENCE VOCABULARY REGISTRY (friend checkpoint #1).
 *
 * The single source of truth for every `requiredEvidence.kind` the platform may
 * emit. It closes the vocabulary and binds each kind to whether the VerdictEngine
 * has a DETERMINISTIC checker for it.
 *
 * Two enforced rules:
 *   1. CLOSED VOCABULARY — the Architect / ADO generator / contract builder may
 *      only emit a kind that is REGISTERED here. A rogue/typo'd kind is caught at
 *      generation time (assertKindsRegistered), never silently shipped.
 *   2. NO UNVERIFIABLE GATING — a kind whose `hasChecker` is false is DEMOTED to
 *      advisory at consumption (partitionByCheckability). It can be SHOWN to the
 *      user (and put in the architect grounding) but it NEVER gates the verdict —
 *      so a "beautiful but unverifiable" expectation can neither fake a pass nor
 *      force a false not_judged. When Phase B implements its checker, flip
 *      `hasChecker` to true and it starts gating automatically.
 *
 * `hasChecker` reflects ENGINE-WIRED reality. Phase B-slice wired the five
 * login/slice checkers in evidenceCheckers.js (page_present, destination_absent,
 * field_error, error_present, page_settled) — those are `true` and now gate the
 * verdict. The role-access (element_present/absent, empty_result) and ADO/rich-UI
 * kinds remain `false` => demoted to advisory at consumption until their
 * deterministic checkers land. Each flips to true in the commit that wires it.
 */

// kind -> { hasChecker, phase, desc }. phase = where its checker lands.
const EVIDENCE_KINDS = {
  // ── login/slice vocabulary (Phase B-slice checkers — WIRED in evidenceCheckers.js) ──
  page_present:       { hasChecker: true,  phase: 'B-slice', desc: 'expected entry/destination page is present (URL match)' },
  destination_absent: { hasChecker: true,  phase: 'B-slice', desc: 'a forbidden destination (e.g. dashboard) is ABSENT' },
  field_error:        { hasChecker: true,  phase: 'B-slice', desc: 'a validation error present + scoped to a named field + right class' },
  error_present:      { hasChecker: true,  phase: 'B-slice', desc: 'a general (e.g. auth-rejection) error is present' },
  page_settled:       { hasChecker: true,  phase: 'B-slice', desc: 'fallback: the page settled (unknown intent — Conductor resolves live)' },
  login_form_present: { hasChecker: true,  phase: 'B-slice', desc: 'the login form is visible (username + password inputs; submit strengthens) — the negative-login composite 4th signal' },
  // ── role-access vocabulary (Phase B) ─────────────────────────────────
  element_present:    { hasChecker: false, phase: 'B', desc: 'a named element/menu item is present' },
  element_absent:     { hasChecker: false, phase: 'B', desc: 'a named element/menu item is absent (forbidden)' },
  // ── ADO/rich-UI vocabulary (Phase B-ADO checkers) ────────────────────
  field_accepts_value:{ hasChecker: false, phase: 'B-ADO', desc: 'a field accepts a value (optionally of a given length)' },
  value_rejected:     { hasChecker: false, phase: 'B-ADO', desc: 'an over-limit / invalid value is rejected/prevented/truncated' },
  counter_shows:      { hasChecker: false, phase: 'B-ADO', desc: 'a character/usage counter shows the expected text (e.g. 200/200)' },
  item_count:         { hasChecker: false, phase: 'B-ADO', desc: 'a collection has the expected item count (e.g. 5 notes)' },
  control_disabled:   { hasChecker: false, phase: 'B-ADO', desc: 'a named control is disabled' },
  control_enabled:    { hasChecker: false, phase: 'B-ADO', desc: 'a named control is enabled' },
  message_visible:    { hasChecker: false, phase: 'B-ADO', desc: 'an expected message/text is visible' },
  confirmation_visible:{ hasChecker: false, phase: 'B-ADO', desc: 'a confirmation prompt with expected text is visible' },
  choice_outcome:     { hasChecker: false, phase: 'B-ADO', desc: 'a Yes/No choice produces the expected outcome (element present/absent)' },
  ordering_correct:   { hasChecker: false, phase: 'B-ADO', desc: 'entries are in the expected order (e.g. newest-first / edited-to-top)' },
  format_rejected:    { hasChecker: false, phase: 'B-ADO', desc: 'an invalid value FORMAT (e.g. bad email) is rejected' },
  empty_result:       { hasChecker: false, phase: 'B', desc: 'a search/filter yields an empty-state / zero results' },
};

function isRegistered(kind) {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(EVIDENCE_KINDS, kind);
}
function isCheckable(kind) {
  return isRegistered(kind) && EVIDENCE_KINDS[kind].hasChecker === true;
}
function registeredKinds() { return Object.keys(EVIDENCE_KINDS); }
function checkableKinds() { return registeredKinds().filter((k) => EVIDENCE_KINDS[k].hasChecker === true); }
function uncheckedKinds() { return registeredKinds().filter((k) => EVIDENCE_KINDS[k].hasChecker !== true); }

/**
 * Verify every evidence item's kind is in the closed vocabulary. Used as a
 * generation-time guard so a rogue/typo'd kind never ships.
 * @returns {{ ok: boolean, unregistered: string[] }}
 */
function assertKindsRegistered(items) {
  const list = Array.isArray(items) ? items : [];
  const unregistered = [];
  for (const it of list) {
    const k = it && it.kind;
    if (!isRegistered(k) && !unregistered.includes(k)) unregistered.push(k);
  }
  return { ok: unregistered.length === 0, unregistered };
}

/**
 * Split a requiredEvidence list into the part that GATES the verdict (kinds with
 * a real checker) and the part that is advisory-only (registered but not yet
 * checkable). Anything unregistered is reported separately so the caller can
 * surface a defect rather than silently drop it. The Conductor/VerdictEngine
 * (Phase B) gates ONLY on `required`.
 * @returns {{ required: object[], advisory: object[], unregistered: object[] }}
 */
function partitionByCheckability(items) {
  const required = [];
  const advisory = [];
  const unregistered = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const k = it && it.kind;
    if (!isRegistered(k)) unregistered.push(it);
    else if (isCheckable(k)) required.push(it);
    else advisory.push({ ...it, advisoryReason: 'no_deterministic_checker_yet' });
  }
  return { required, advisory, unregistered };
}

module.exports = {
  EVIDENCE_KINDS,
  isRegistered,
  isCheckable,
  registeredKinds,
  checkableKinds,
  uncheckedKinds,
  assertKindsRegistered,
  partitionByCheckability,
};
