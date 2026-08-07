'use strict';

/**
 * Conductor Precision Bridge (Phase B-2d) — the SINGLE flag-gated integration
 * surface the live conductor calls at each dispatch hook. It composes the
 * offline-proven B-2c/B-2b pieces so the conductor edits stay tiny:
 *   if (bridge.enabled()) { const rec = bridge.captureAction(...) ; ... }
 *
 * HARD SAFETY CONTRACT: when the rollout flag (QAAI_CERTIFIED_ACTION_TARGETS) is
 * OFF, every hook returns null / passthrough, so the conductor falls through to
 * its current behavior — flag-off is byte-identical. The new path only activates
 * with the flag ON, and is proven live at B-2e.
 *
 * Pure orchestration (no LLM, no DB). Live I/O (snapshots, browser_evaluate) is
 * injected via the `observer` the conductor builds with
 * evidenceAcquisitionEngine.createMcpObserver — so this stays unit-testable.
 */

const { planCaseStart, certifyEntryReached } = require('./caseStartPrecision');
const { buildPrecisionActionRecord, recertifyRememberedTarget, classifyEffect } = require('./precisionActionKernel');
const { certifyInteraction, classifyInteraction } = require('./interactionProtocols');
const { acquireEvidence } = require('./evidenceAcquisitionEngine');
const { judgeRowEvidence } = require('./evidenceCheckers');
const { mapVerdictToRunStatus } = require('./verdictEngine');
const { assembleCodeReadyTrace, tracePreferred } = require('./codeReadyTrace');
const { buildMarkRegistry, fuseSelectedMark } = require('./visionDomFusion');
const { buildPassport } = require('./locatorPromotionEngine');
const { proveEffect, EFFECT_PROBE_FN } = require('./postActionEffectProof');
const { acquireRecord, SCROLL_STEP_FN } = require('./virtualizedRowAcquisition');
const mcp = require('./mcp');

function enabled() {
  return /^(1|true|yes|on)$/i.test(process.env.QAAI_CERTIFIED_ACTION_TARGETS || '');
}

/** Hook 1 — case-start plan (reset/navigate/fresh-snapshot/certify-entry). */
function planStart(input) {
  if (!enabled()) return null;
  return planCaseStart(input || {});
}
function entryReached(input) {
  if (!enabled()) return null;
  return certifyEntryReached(input || {});
}

/**
 * Hook 2/3/4 — resolve a target ref for an action. For a model-supplied label
 * with no ref → certified resolver. For a remembered/live ref → re-certify.
 * Returns { ref, decision, reason } or null (flag off).
 */
function resolveTarget({ snapshotBefore, intendedLabel, toolName, rememberedRef = null, approvedStep = null, urlBefore = null } = {}) {
  if (!enabled()) return null;
  if (rememberedRef) {
    return recertifyRememberedTarget({ rememberedRef, intendedLabel, snapshotBefore, urlBefore, approvedStep, toolName, resolveByDescription: mcp.resolveActionRefByDescription });
  }
  const ref = mcp.resolveActionRefByDescription(snapshotBefore, intendedLabel, toolName);
  return { decision: ref ? 'resolved' : 'block', ref: ref || null, reason: ref ? 'certified resolver matched by role+name' : 'no certified target match' };
}

/**
 * Hook 5/6 — build the PrecisionActionRecord for an action (pre- or post-action;
 * pass snapshotAfter/urlAfter once the action ran to capture the effect). Attaches
 * the interaction-protocol certification when a widget intent/observation is given.
 */
function captureAction(input) {
  if (!enabled()) return null;
  const inp = input || {};
  // B-2d.2b — Vision-DOM fusion: if action-time atlas candidates are supplied
  // (cdpSidecar.captureAtlas), map the selected target to its numbered mark and
  // use that mark's Gold/Silver cascade evidence as locatorEvidence when the
  // action didn't already carry richer evidence. markId/bbox stay telemetry.
  let locatorEvidence = inp.locatorEvidence || null;
  let visualTelemetry = null;
  if (Array.isArray(inp.atlasEntries) && inp.atlasEntries.length) {
    const marks = buildMarkRegistry(inp.atlasEntries);
    visualTelemetry = fuseSelectedMark(marks, {
      idAttr: inp.targetIdAttr, testId: inp.targetTestId,
      role: inp.targetRole, name: inp.targetLabel, bbox: inp.targetBbox,
    });
    if (!locatorEvidence && visualTelemetry.mark && visualTelemetry.mark.evidence) {
      locatorEvidence = visualTelemetry.mark.evidence;
    }
  }
  const rec = buildPrecisionActionRecord({ ...inp, locatorEvidence });
  const intentKind = inp.intentKind;
  const widgetObs = inp.widgetObs;
  // Always classify the interaction PROTOCOL (cheap, role+tool based).
  rec.interaction = { protocol: classifyInteraction({ toolName: inp.toolName, targetRole: rec.target.role, intentKind }) };
  // When widget observations are available, also run the protocol's certify.
  if (intentKind || widgetObs) {
    rec.interaction = certifyInteraction({ toolName: inp.toolName, targetRole: rec.target.role, intentKind }, widgetObs || inp);
  }
  if (visualTelemetry) rec.visualTelemetry = visualTelemetry;

  // ── B-2d.2c+ — forge a LocatorPassport (Bulletproof Synthesizer). Attach the
  // candidate passport; a forged primary becomes codeReadyIntent's locator marked
  // proven:false (a CANDIDATE — codegen requires LIVE proof). A supplied proven
  // passport (post live-proof) is used as-is and marks the locator proven:true.
  // bronzeOnly/repairRequired => repair, never export.
  const mark = visualTelemetry && visualTelemetry.mark;
  // Pull the rich action-time context from the fused atlas mark when the caller
  // didn't supply it — this is what lets the promotion engine forge label_region
  // (role-less controls near a label) and record_action (table/grid/list rows).
  const promoCtx = {
    role: rec.target.role || (mark && mark.role) || null, name: rec.target.name || (mark && mark.name) || null,
    testId: inp.targetTestId || (mark && mark.testId) || null,
    idAttr: inp.targetIdAttr || (mark && mark.idAttr) || null,
    nameAttr: inp.targetNameAttr || (mark && mark.nameAttr) || null,
    placeholder: inp.placeholder || (mark && mark.placeholder) || null,
    inputType: inp.inputType || (mark && mark.inputType) || null,
    labelText: inp.labelText || (mark && mark.labelText) || null,
    ancestors: inp.ancestors || (mark && mark.ancestors) || null,
    record: inp.record || (mark && mark.record) || null,
    actionSelector: inp.actionSelector || (mark && mark.actionSelector) || null,
    frame: inp.frame || null,
    text: inp.text || null,
    textUnique: inp.textUnique || false,
    childTag: inp.childTag || null,
    dataAttrs: inp.dataAttrs || null,
    scopedCss: inp.scopedCss || null,
    bbox: inp.targetBbox || (mark && mark.bbox) || null,
  };
  const passport = inp.provenLocatorPassport || buildPassport(promoCtx);
  const isProven = passport.kind === 'ProvenLocatorPassport';
  rec.candidatePassport = isProven ? null : passport;
  rec.provenLocatorPassport = isProven ? passport : null;
  rec.bronzeRepairRequired = !!(passport.bronzeOnly || passport.repairRequired);
  rec.locatorPromotionStatus = passport.bronzeOnly ? 'bronze_repair_required'
    : passport.repairRequired ? 'proof_failed_repair_required'
      : isProven ? 'proven' : (passport.primary ? 'candidate_forged' : 'none');
  // STRUCTURAL no-leak boundary: codeReadyIntent.target.locator is populated ONLY
  // by a PROVEN passport. An unproven candidate goes to `.candidateLocator`
  // (diagnostic / repair input) and `.locator` is set to NULL — so any exporter
  // that reads `.locator` directly fails closed instead of shipping an unproven
  // locator. (The kernel's pre-set legacy value is cleared on the precision path.)
  const primary = passport.primary;
  if (isProven && primary) {
    rec.codeReadyIntent.target.locator = { strategy: primary.strategy, tier: primary.tier, expression: primary.expression, build: primary.build, proven: true };
    rec.codeReadyIntent.target.candidateLocator = null;
    rec.locatorTier = primary.tier;
  } else {
    rec.codeReadyIntent.target.candidateLocator = primary
      ? { strategy: primary.strategy, tier: primary.tier, expression: primary.expression, build: primary.build, proven: false }
      : (rec.codeReadyIntent.target.locator || null); // fall back to the kernel's candidate as diagnostic only
    rec.codeReadyIntent.target.locator = null; // never expose an unproven locator
    rec.locatorTier = primary ? primary.tier : rec.locatorTier;
  }

  // ── B-2e — POST-ACTION EFFECT PROOF. When the conductor supplies before/after
  // observations (EFFECT_PROBE_FN fingerprints + a targeted value/checked
  // readback), prove the TYPED effect (value set / selection changed / checked
  // changed / command effect). An action that dispatched but produced no
  // observable effect is recorded honestly and the record is NOT certified —
  // "tool clicked" never counts as "step worked".
  if (inp.effect && typeof inp.effect === 'object') {
    const ep = proveEffect({
      toolName: inp.toolName, targetRole: rec.target.role,
      intendedValue: rec.action && rec.action.value,
      before: inp.effect.before, after: inp.effect.after,
      valueAfter: inp.effect.valueAfter, checkedBefore: inp.effect.checkedBefore,
      checkedAfter: inp.effect.checkedAfter, networkOk: inp.effect.networkOk,
    });
    rec.effectProof = ep;
    rec.certification.effectProven = ep.proven;
    if (!ep.proven && rec.certification.status === 'certified') {
      rec.certification.status = 'effect_unproven';
      rec.certification.certified = false;
    }
  }
  return rec;
}

/**
 * Hook 6b — acquire a target ROW in a (possibly virtualized) grid by its
 * distinguishing text: filter-first, scroll + recapture + flush stale rows,
 * prove only the current viewport, then forge record_action. `captureAtlas`,
 * `scrollNext`, `applyFilter`, and `resolve` are injected by the conductor.
 */
async function acquireRow(input) {
  if (!enabled()) return null;
  return acquireRecord({ ...input, buildPassport, buildProvenPassport: require('./locatorPromotionEngine').buildProvenPassport });
}

/**
 * Hook 7 — judge the row from LIVE captured page-state. Acquires evidence (the
 * loop escalates needs_acquisition; never finalizes a null) then runs the
 * deterministic VerdictEngine. Returns { verdict, runStatus, acquisition } or null.
 */
async function judgeRow({ requiredEvidence, observer, patterns, maxRounds } = {}) {
  if (!enabled()) return null;
  const acq = await acquireEvidence({ requiredEvidence, observer, patterns, maxRounds });
  if (!acq.ok) {
    // Honest: evidence could not be certified after escalation. NOT a website bug
    // and NOT a pass — an internal automation_capture_failure to retry/heal.
    return { verdict: 'not_judged', runStatus: { status: 'blocked', blockedReason: acq.status }, acquisition: acq };
  }
  const result = judgeRowEvidence({ requiredEvidence }, acq.checkerPageState);
  return { verdict: result.verdict, runStatus: mapVerdictToRunStatus(result), result, acquisition: acq };
}

/**
 * Hook 8 — assemble the code-ready trace for the case from its PrecisionActionRecords.
 * `tracePreferred` tells codegen to consume it and BYPASS legacy locator recovery.
 */
function caseTrace(records) {
  if (!enabled()) return null;
  return { trace: assembleCodeReadyTrace(records), preferred: tracePreferred(records) };
}

module.exports = {
  enabled,
  planStart,
  entryReached,
  resolveTarget,
  captureAction,
  acquireRow,
  judgeRow,
  caseTrace,
  // re-exports for the conductor's convenience
  classifyInteraction,
  classifyEffect,
  EFFECT_PROBE_FN,
  SCROLL_STEP_FN,
};
