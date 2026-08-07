'use strict';

/**
 * Vision-DOM fusion (Phase B-2d.2b) — runtime mapping of numbered visual marks to
 * DOM/ref/role/box/locator. NOT a UI feature first: this is the capture-time
 * registry that lets the AI disambiguate "which of these look-alike controls" and
 * lets DOM-atlas repair tie a screenshot mark back to a durable locator.
 *
 *   buildMarkRegistry(atlasEntries) → [{ markId, role, name, id/name/testId,
 *       bbox, surroundingText, evidence(cascade), exportLocator }]
 *   findMarkForTarget(marks, target) → the mark for the element actually acted on
 *
 * Export boundary preserved: a mark's `exportLocator` is Gold/Silver only (from
 * the cascade); markId, bbox and coordinates are visual TELEMETRY — never exported
 * as code. Pure + deterministic; fed by cdpSidecar.captureAtlas at action time.
 */

const { buildLocatorEvidence, selectExportLocator } = require('./locatorEvidenceCascade');

function n(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

function bboxOverlaps(a, b) {
  if (!a || !b) return false;
  const ax2 = a.x + a.w; const ay2 = a.y + a.h; const bx2 = b.x + b.w; const by2 = b.y + b.h;
  return a.x < bx2 && ax2 > b.x && a.y < by2 && ay2 > b.y;
}

/** Assign a stable markId to every visible interactive atlas candidate. */
function buildMarkRegistry(atlasEntries) {
  const marks = [];
  (Array.isArray(atlasEntries) ? atlasEntries : []).forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    const evidence = buildLocatorEvidence({
      role: e.role, name: e.name, testId: e.testId, placeholder: e.placeholder,
      idAttr: e.idAttr, nameAttr: e.nameAttr, bbox: e.bbox, surroundingText: e.surroundingText,
    });
    marks.push({
      markId: `m${i + 1}`,
      role: e.role || null,
      name: e.name || null,
      idAttr: e.idAttr || null,
      nameAttr: e.nameAttr || null,
      testId: e.testId || null,
      placeholder: e.placeholder || null,
      bbox: e.bbox || null,
      surroundingText: e.surroundingText || null,
      // Carried through for label_region / record_action forging in the promotion
      // engine (the rich enterprise-control strategies need these).
      ancestors: Array.isArray(e.ancestors) ? e.ancestors : null,
      record: e.record || null,
      labelText: e.labelText || null,
      actionSelector: e.actionSelector || null,
      inputType: e.type || e.inputType || null,
      evidence,
      // Gold/Silver only; null when the candidate is bronze-only (telemetry, not exportable).
      exportLocator: selectExportLocator(evidence),
    });
  });
  return marks;
}

/**
 * Map the element actually acted on back to its mark. Priority: stable id →
 * role+name exact → unique name → bbox overlap (visual fallback). Returns null
 * when nothing matches or a name is ambiguous with no box to disambiguate.
 */
function findMarkForTarget(marks, target) {
  if (!Array.isArray(marks) || !marks.length || !target) return null;
  if (target.idAttr) { const m = marks.find((x) => x.idAttr && x.idAttr === target.idAttr); if (m) return m; }
  if (target.testId) { const m = marks.find((x) => x.testId && x.testId === target.testId); if (m) return m; }
  if (target.role && target.name) { const m = marks.find((x) => n(x.role) === n(target.role) && n(x.name) === n(target.name)); if (m) return m; }
  if (target.name) { const byName = marks.filter((x) => n(x.name) === n(target.name)); if (byName.length === 1) return byName[0]; }
  if (target.bbox) { const m = marks.find((x) => bboxOverlaps(x.bbox, target.bbox)); if (m) return m; }
  return null;
}

/**
 * Attach vision telemetry to a PrecisionActionRecord-shaped object: the selected
 * mark + the full mark set (telemetry only). Returns { markId, mark, allMarks }.
 * The caller merges the mark's cascade evidence into locatorEvidence when the
 * action didn't already carry richer evidence.
 */
function fuseSelectedMark(marks, target) {
  const mark = findMarkForTarget(marks, target);
  return {
    markId: mark ? mark.markId : null,
    mark: mark || null,
    allMarks: Array.isArray(marks) ? marks.map((m) => ({ markId: m.markId, role: m.role, name: m.name, bbox: m.bbox })) : [],
  };
}

module.exports = { buildMarkRegistry, findMarkForTarget, fuseSelectedMark, bboxOverlaps };
