'use strict';

/**
 * Code-ready trace assembly (Phase B-2c.5) — the BRIDGE from B-2c capture to
 * Phase E codegen. Turns the per-action `PrecisionActionRecord`s captured during
 * a case into the trace shape codegen consumes DIRECTLY: an ordered step list
 * (action + target + locator + value) plus a deduped locator manifest.
 *
 * The governing rule (acquisition-first applied to codegen): Phase E must NOT
 * recover precision after the run. When precision records exist for a case,
 * codegen consumes THIS trace and the old post-run locator-inference path is
 * bypassed (gated). `tracePreferred()` is that decision.
 *
 * Honesty: an UNCERTIFIED action (no effect / static target / wrong page) or a
 * certified action with NO locator candidate is surfaced as a `warning` and
 * marked `exportReady:false` — never silently emitted as a clean step. Codegen
 * can then fail closed on that step instead of shipping a wrong/empty locator.
 *
 * Pure + deterministic. No LLM, no DB.
 */

function isCertified(r) { return !!(r && r.certification && r.certification.certified); }

/**
 * @param {Array} records  PrecisionActionRecord[] for a case (in execution order)
 * @returns {{ steps:Array, locatorManifest:Array, warnings:Array, total:number, certifiedCount:number, exportReadyCount:number }}
 */
function assembleCodeReadyTrace(records) {
  const steps = [];
  const manifest = new Map();
  const warnings = [];

  for (const r of (Array.isArray(records) ? records : [])) {
    if (!r || !r.codeReadyIntent) continue;
    const ci = r.codeReadyIntent;
    const tgt = ci.target || {};
    const certified = isCertified(r);
    const hasLocator = !!tgt.locator;
    const hasCandidate = !!tgt.candidateLocator; // forged but not yet proven
    // Export-ready ONLY when there is a locator and it is proven. The precision
    // path never puts an unproven candidate in `.locator` (it lives in
    // `.candidateLocator`); a legacy locator with no `proven` field is allowed.
    const locatorProven = hasLocator ? (tgt.locator.proven !== false) : false;
    const exportReady = certified && hasLocator && locatorProven;

    if (!certified) {
      warnings.push({ approvedStepId: r.approvedStepId || null, action: ci.action, status: r.certification ? r.certification.status : 'unknown', reason: 'uncertified action — not export-ready (codegen must fail closed on this step)' });
    } else if (hasCandidate && !hasLocator) {
      warnings.push({ approvedStepId: r.approvedStepId || null, action: ci.action, status: 'locator_unproven', reason: 'locator is a forged CANDIDATE not yet proven live — prove/repair before export (never ship an unproven locator)' });
    } else if (!hasLocator) {
      warnings.push({ approvedStepId: r.approvedStepId || null, action: ci.action, status: 'certified_no_locator', reason: 'certified action has no locator candidate — codegen gap (no narration-based inference allowed)' });
    } else if (!locatorProven) {
      warnings.push({ approvedStepId: r.approvedStepId || null, action: ci.action, status: 'locator_unproven', reason: 'locator marked unproven — must prove/repair before export' });
    }

    steps.push({
      approvedStepId: r.approvedStepId || null,
      action: ci.action,
      target: { role: tgt.role || null, name: tgt.name || null, locator: tgt.locator || null },
      value: ci.value,
      certified,
      exportReady,
      status: r.certification ? r.certification.status : null,
      effect: r.effect ? r.effect.kind : null,
      source: r.source || null,
    });

    // Locator manifest — deduped by target name; only export-ready locators.
    if (exportReady && tgt.name) {
      if (!manifest.has(tgt.name)) manifest.set(tgt.name, { name: tgt.name, role: tgt.role || null, locator: tgt.locator });
    }
  }

  const certifiedCount = steps.filter((s) => s.certified).length;
  const exportReadyCount = steps.filter((s) => s.exportReady).length;
  return { steps, locatorManifest: Array.from(manifest.values()), warnings, total: steps.length, certifiedCount, exportReadyCount };
}

/**
 * Should codegen consume the precision trace (and BYPASS legacy post-run locator
 * recovery)? Only when the trace is COMPLETE — every captured step is export-ready
 * (certified + proven locator) with NO warnings. A partial trace (one step ready,
 * others unproven/uncertified) must NOT be preferred: the platform continues
 * promotion/repair until the whole business flow is export-ready. Gated upstream
 * by the rollout flag.
 */
function tracePreferred(records) {
  if (!Array.isArray(records) || !records.length) return false;
  const t = assembleCodeReadyTrace(records);
  return traceFullyExportReady(t);
}

/** A case is fully export-ready iff every captured step is export-ready. */
function traceFullyExportReady(trace) {
  return !!trace && trace.total > 0 && trace.exportReadyCount === trace.total && trace.warnings.length === 0;
}

module.exports = { assembleCodeReadyTrace, tracePreferred, traceFullyExportReady };
