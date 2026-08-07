'use strict';

/**
 * Replay a persisted run trace back into a codegen actionPlan (P1c).
 *
 * The journey-emission pass runs at RUN COMPLETION (not inline), so it must
 * rebuild each member case's actionPlan from what was flushed to disk during
 * the run — NOT from an in-memory stash. Stashing megabytes of DOM snapshots
 * per step for a 45-minute enterprise suite would OOM the orchestrator; reading
 * the gz trace back at the end keeps the run's memory footprint flat.
 *
 * This is the single reconstruction path: the live completion pass AND the
 * offline scripts/_recodegen_verify.cjs both call it (DRY).
 *
 * Pure I/O over a file path — no prisma, no LLM.
 */

const fs = require('fs');
const zlib = require('zlib');
const actionPlanLib = require('./_actionPlan');

/**
 * Read a gzipped richTrace file back into a flat ordered action trail.
 * Prefer toolResults over toolUses: toolUses are only what the assistant asked
 * to do, while toolResults are what actually executed and whether it worked.
 * Missing/corrupt file -> [] (never throws).
 */
function reconstructTrail(traceFile) {
  if (!traceFile || !fs.existsSync(traceFile)) return [];
  let j;
  try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(traceFile)).toString('utf8')); }
  catch (_) { return []; }
  const turns = Array.isArray(j.turns) ? j.turns : [];
  const trail = [];
  const hasResultRecords = turns.some((t) => Array.isArray(t.toolResults) && t.toolResults.length > 0);
  for (const t of turns) {
    if (hasResultRecords) {
      for (const tr of (t.toolResults || [])) {
        trail.push({
          tool: tr.name,
          args: tr.input || {},
          ok: tr.ok === true && tr.isError !== true,
          error: tr.errorPreview || undefined,
          pageUrl: tr.pageUrlBefore || tr.pageUrl || undefined,
          pageUrlAfter: tr.pageUrlAfter || undefined,
          domFacts: tr.domFacts || undefined,
          actionLocator: tr.actionLocator || undefined,
          codegenLocator: tr.codegenLocator || undefined,
          fieldCodegenLocators: tr.fieldCodegenLocators || undefined,
          fieldLocatorDiagnostics: tr.fieldLocatorDiagnostics || undefined,
          locatorDiagnostic: tr.locatorDiagnostic || undefined,
          actionLocatorGap: tr.actionLocatorGap || undefined,
          actionLocatorKernel: tr.actionLocatorKernel || undefined,
          stepAuthoring: tr.stepAuthoring || undefined,
          locatorRecipe: tr.locatorRecipe || undefined,
          locatorEvidenceV2: tr.locatorEvidenceV2 || tr.stepAuthoring?.locatorEvidenceV2 || undefined,
          transitionProof: tr.transitionProof || undefined,
        });
      }
    } else {
      // Legacy rich traces did not record toolResults. Fall back to toolUses,
      // but downstream action-plan shaping still removes non-scriptable tools.
      for (const tu of (t.toolUses || [])) {
        trail.push({ tool: tu.name, args: tu.input || {}, ok: tu.ok !== false });
      }
    }
  }
  return trail;
}

/**
 * Build the codegen actionPlan from a reconstructed trail + the case's verdict.
 * Mirrors EXACTLY the inline shape conductor.persistResultAndCodegen builds, so
 * a reconstructed plan and a live plan are interchangeable.
 */
function buildActionPlan({ trail, status, stepResults }) {
  return actionPlanLib.buildActionPlan({ trail, status, stepResults });
}

module.exports = { reconstructTrail, buildActionPlan };
