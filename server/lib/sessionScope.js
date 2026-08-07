'use strict';

/**
 * Session-establishing detector (site-INDEPENDENT) — used to scope the
 * Conductor's per-row session reset to cases that actually LOG IN (so an
 * authenticated data-driven case, e.g. "search by name", is NOT reset and keeps
 * its inherited session). Keyed off the step contract — a login/auth navigation
 * + a password field — never a site string.
 *
 * review P0b: `tc.steps` is a JSON STRING on persisted cases. The previous inline
 * `Array.isArray(steps) ? steps : []` read a string as `[]` → returned false →
 * the per-row reset NEVER ran on real (persisted) runs and auth state leaked
 * across rows. Decode the string shape first. Extracted here so it's unit-testable.
 */
function caseEstablishesSessionLive(caseObj) {
  let rowExecutionPlan = caseObj && (caseObj.rowExecutionPlan || caseObj.rowExecutionPlanJson);
  if (typeof rowExecutionPlan === 'string') {
    try { rowExecutionPlan = JSON.parse(rowExecutionPlan); } catch (_) { rowExecutionPlan = null; }
  }
  // The Conductor uses this predicate to decide whether later matrix rows need
  // an isolated browser context. A compiler-owned inline per-row contract with
  // fresh session semantics is itself an isolation boundary even when the flow
  // is not a login: row 2 must not inherit row 1's mutated page/session state.
  // modeStartsFresh remains enforced by the Conductor at the call site.
  if (rowExecutionPlan && rowExecutionPlan.mode === 'inline'
    && rowExecutionPlan.executionMode === 'per_row'
    && Array.isArray(rowExecutionPlan.rowIds)
    && rowExecutionPlan.rowIds.length > 1) return true;

  let steps = caseObj && caseObj.steps;
  if (typeof steps === 'string') {
    try { steps = JSON.parse(steps); } catch (_) { steps = [steps]; }
  }
  const blob = JSON.stringify(Array.isArray(steps) ? steps : (steps ? [steps] : [])).toLowerCase();
  return /(login|auth|signin|sign[-_]?in|logon)/.test(blob) && /password/.test(blob);
}

module.exports = { caseEstablishesSessionLive };
