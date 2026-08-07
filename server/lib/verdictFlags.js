'use strict';

/**
 * Phase H — feature flags for the verdict-layer rollout.
 *
 * Two independent flags so each merge in the M1–M5 chain can be enabled
 * separately:
 *
 *   QAAI_ASSERTION_V2     — assertion_check returns { outcome, reason } in
 *                           addition to the legacy { matched } field, and
 *                           the tool description teaches the three-outcome
 *                           semantics to the agent. Lands in M2. Default off.
 *
 *   QAAI_VERDICT_MODE     — the case verdict computation. 'legacy' = pre-M4
 *                           behaviour (agent's final_verdict tool argument
 *                           drives status). 'mechanical_v1' = computeVerdict()
 *                           drives status from recorded assertion outcomes;
 *                           agent's claim is recorded for the disagreement
 *                           metric but does NOT determine the verdict. Lands
 *                           in M4. Default 'legacy'.
 *
 * The Project.verdictMode column lets the env default be overridden per
 * project (null = use env). The Run.verdictMode column captures the resolved
 * mode at run-start and is immutable for the duration of that run; mid-run
 * env flips do not affect in-flight runs (coherent reports require a single
 * verdict logic for the whole suite — see [[verdict-layer-implementation-spec]]).
 */

function isAssertionV2Enabled() {
  return String(process.env.QAAI_ASSERTION_V2 || '').toLowerCase() === 'on';
}

function envVerdictMode() {
  // mechanical_v1 is now the DEFAULT — the evidence-anchored verdict (computeVerdict)
  // is the trustworthy verdict; the agent's own claim never determines the outcome.
  // `legacy` is opt-in ONLY (env QAAI_VERDICT_MODE=legacy, or a per-project override),
  // kept so historical reports/runs can still be reproduced. New projects/runs with no
  // explicit setting resolve to mechanical_v1.
  const v = String(process.env.QAAI_VERDICT_MODE || '').toLowerCase();
  return v === 'legacy' ? 'legacy' : 'mechanical_v1';
}

/**
 * Resolve the effective verdict mode for a project, with the env as
 * the fallback when the project hasn't set an override. Called once at
 * run-start; the resolved value is then persisted onto Run.verdictMode
 * and read from there for every case in the run.
 */
function resolveVerdictMode(project) {
  if (project && project.verdictMode === 'mechanical_v1') return 'mechanical_v1';
  if (project && project.verdictMode === 'legacy') return 'legacy';
  return envVerdictMode();
}

module.exports = { isAssertionV2Enabled, envVerdictMode, resolveVerdictMode };
