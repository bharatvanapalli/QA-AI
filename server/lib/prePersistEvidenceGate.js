'use strict';

/**
 * PRE-PERSIST EVIDENCE GATE (run 91d6301a).
 *
 * The verdict layer must never persist a `pass` that is not backed by real
 * evidence. computeVerdict() fixes the mechanical ladder, but a false `pass`
 * can still arrive at the DB write from OTHER paths — the legacy ladder, the
 * dry-run/no-provider path, or a skipped-only finalize. The conductor funnels
 * EVERY case-result write through persistResultAndCodegen(), so this gate sits
 * there as the last honest checkpoint over all of them.
 *
 * Contract: pure + deterministic. It only ever DOWNGRADES a `pass` — a genuine
 * fail/blocked/skipped/needs_human is returned untouched (never upgraded). When
 * it downgrades, it returns the new status + a structured reason the caller
 * stamps onto blockedReason / mechanicalVerdictReason / error so Reports can
 * explain WHY a would-be green row is not green.
 *
 * Downgrade ladder (worst first):
 *   1. no screenshots AND no assertion checks AND no passing step
 *        → blocked / no_evidence            (the row-9 class: nothing happened)
 *   2. no real browser action (narration-only trail)
 *        → blocked / no_execution           (only narrate/agent_narration entries)
 *   3. planned steps exist but NONE passed (all skipped/pending/blocked/fail)
 *        → blocked / incomplete_execution
 *   4. [mechanical_v1 only] declared assertions exist but ZERO checks recorded
 *        → needs_human / assertion_missing_record
 *
 * Why 1-3 are mode-agnostic but 4 is scoped to mechanical_v1: in legacy mode the
 * `assertionCheckResults` (v2) array is legitimately empty on a real pass — the
 * legacy ladder records its verification in the trail's assertion_check lines,
 * not this column. Applying #4 in legacy mode would false-downgrade every legacy
 * pass that carries declared assertions. #1-#3 key off universal execution
 * evidence (screenshots, real actions, a passing step) that a genuine pass has
 * in EITHER mode, so they are safe to run always.
 */

function isNarration(a) {
  return !!(a && (a.agentNarration === true || a.tool === 'agent_narration' || a.tool === 'narrate' || a.kind === 'narrate'));
}

/**
 * @param {object} input
 * @param {string} input.status                 incoming verdict status
 * @param {Array}  [input.screenshots]          screenshot URLs/objects captured
 * @param {Array}  [input.assertionCheckResults] the v2Recorded outcome array
 * @param {Array}  [input.stepResults]          [{ index, status }]
 * @param {Array}  [input.actionTrail]          recorded action objects (tool/args/ok/…)
 * @param {Array|string} [input.declaredAssertions] declared assertions (array or JSON string)
 * @param {string} [input.verdictMode]          'legacy' | 'mechanical_v1'
 * @param {boolean} [input.runnerCertified]     true when an EXTERNAL assertion
 *        runner (e.g. Playwright `expect()`) produced this status — its pass is
 *        its own certification, so the conductor-shaped evidence checks (which
 *        expect assertionCheckResults / stepResults / a captured action trail)
 *        do NOT apply and would false-downgrade a legitimate runner pass that
 *        simply captured no screenshots. The Conductor path passes this false
 *        (default) so the evidence gate applies in full.
 * @returns {{ status: string, downgraded: boolean, blockedReason?: string|null,
 *             mechanicalVerdictReason?: string, error?: string, gateReason?: string }}
 */
function enforcePrePersistEvidenceGate(input) {
  const { status, screenshots, assertionCheckResults, stepResults, actionTrail, declaredAssertions, verdictMode, runnerCertified } = input || {};
  // Only ever downgrade a pass; everything else is already honest.
  if (status !== 'pass') return { status, downgraded: false };
  // An external assertion runner (Playwright expect()) already certified this
  // pass; the conductor-shaped evidence checks don't model its evidence.
  if (runnerCertified === true) return { status, downgraded: false, runnerCertified: true };

  const ssLen = Array.isArray(screenshots) ? screenshots.length : 0;
  const acr = Array.isArray(assertionCheckResults) ? assertionCheckResults : [];
  const steps = Array.isArray(stepResults) ? stepResults : [];
  const anyStepPass = steps.some((s) => s && s.status === 'pass');
  const plannedSteps = steps.length;
  const trail = Array.isArray(actionTrail) ? actionTrail : [];
  const realActions = trail.filter((a) => a && a.tool && !isNarration(a));

  let decl = [];
  try {
    decl = Array.isArray(declaredAssertions) ? declaredAssertions
      : (typeof declaredAssertions === 'string' ? JSON.parse(declaredAssertions || '[]') : []);
  } catch (_) { decl = []; }
  const declValid = (Array.isArray(decl) ? decl : []).filter((d) => d && d.id && d.parseFailed !== true);

  let g = null;
  if (ssLen === 0 && acr.length === 0 && !anyStepPass) {
    g = { status: 'blocked', blockedReason: 'no_evidence', reason: 'pass_without_any_evidence' };
  } else if (realActions.length === 0) {
    g = { status: 'blocked', blockedReason: 'no_execution', reason: 'pass_with_narration_only' };
  } else if (plannedSteps > 0 && !anyStepPass) {
    g = { status: 'blocked', blockedReason: 'incomplete_execution', reason: 'pass_all_planned_steps_unexecuted' };
  } else if (verdictMode === 'mechanical_v1' && declValid.length > 0 && acr.length === 0) {
    g = { status: 'needs_human', blockedReason: null, reason: 'pass_with_declared_assertions_but_no_checks' };
  }
  if (!g) return { status: 'pass', downgraded: false };

  return {
    status: g.status,
    downgraded: true,
    blockedReason: g.blockedReason,
    mechanicalVerdictReason: `verdict_downgraded:${g.reason}`,
    error: `Verdict downgraded from pass: ${g.reason.replace(/_/g, ' ')} — a pass requires real execution and verification evidence.`,
    gateReason: g.reason,
  };
}

module.exports = { enforcePrePersistEvidenceGate, isNarration };
