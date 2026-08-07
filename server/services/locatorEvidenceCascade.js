'use strict';

/**
 * Locator Evidence Cascade (Phase B-2d.2c) — the durable-locator contract that
 * decides what generated code is ALLOWED to use.
 *
 *   GOLD   (semantic):   role+name, testId, label, placeholder
 *   SILVER (structural): #id, [name], scoped CSS, DOM relationship (+ frame/shadow)
 *   BRONZE (visual telemetry): bounding box, screenshot-mark id, surrounding text, coordinates
 *
 * Export boundary (HARD): generated POM/spec locators may use GOLD or SILVER
 * only. BRONZE is internal telemetry — for repair, AI disambiguation, and
 * diagnosis — and may help REBUILD Gold/Silver, but is NEVER selected as the
 * exported locator. Coordinate clicks are NEVER exported. A bronze-only step is
 * NOT export-ready (codegen fails closed) — never a silent coordinate fallback.
 *
 * Pure + deterministic. Fed by the action-time capture (cdpSidecar / DOM atlas /
 * MCP snapshot); consumed by the Precision Action Kernel's codeReadyIntent.
 */

function esc(s) { return String(s == null ? '' : s).replace(/'/g, "\\'"); }

/**
 * @param {object} ev  raw evidence fields captured at action time
 * @returns {{ gold:Array, silver:Array, bronze:Array, frame, shadow, tier }}
 */
function buildLocatorEvidence(ev = {}) {
  const gold = [];
  if (ev.role && ev.name) gold.push({ strategy: 'role', tier: 'gold', expression: `getByRole('${esc(ev.role)}', { name: '${esc(ev.name)}' })` });
  if (ev.testId) gold.push({ strategy: 'testId', tier: 'gold', expression: `getByTestId('${esc(ev.testId)}')` });
  if (ev.label) gold.push({ strategy: 'label', tier: 'gold', expression: `getByLabel('${esc(ev.label)}')` });
  if (ev.placeholder) gold.push({ strategy: 'placeholder', tier: 'gold', expression: `getByPlaceholder('${esc(ev.placeholder)}')` });

  const silver = [];
  if (ev.idAttr) silver.push({ strategy: 'id', tier: 'silver', expression: `locator('#${esc(ev.idAttr)}')` });
  if (ev.nameAttr) silver.push({ strategy: 'name', tier: 'silver', expression: `locator('[name="${esc(ev.nameAttr)}"]')` });
  if (ev.scopedCss) silver.push({ strategy: 'css', tier: 'silver', expression: `locator('${esc(ev.scopedCss)}')` });
  if (ev.domPath) silver.push({ strategy: 'dom_relationship', tier: 'silver', expression: `locator('${esc(ev.domPath)}')` });

  const bronze = [];
  if (ev.bbox) bronze.push({ strategy: 'bounding_box', tier: 'bronze', value: ev.bbox });
  if (ev.markId != null) bronze.push({ strategy: 'screenshot_mark', tier: 'bronze', value: ev.markId });
  if (ev.surroundingText) bronze.push({ strategy: 'surrounding_text', tier: 'bronze', value: String(ev.surroundingText).slice(0, 200) });
  if (ev.coordinates) bronze.push({ strategy: 'coordinates', tier: 'bronze', value: ev.coordinates });

  const tier = gold.length ? 'gold' : silver.length ? 'silver' : bronze.length ? 'bronze' : 'none';
  return { gold, silver, bronze, frame: ev.frame || null, shadow: ev.shadow || null, tier };
}

/**
 * Select the EXPORT locator honoring the boundary: Gold first, else Silver, else
 * null. BRONZE is never returned. Coordinates are never returned. A null result
 * means "not export-ready" — codegen must fail closed on that step.
 */
function selectExportLocator(evidence) {
  if (!evidence) return null;
  if (Array.isArray(evidence.gold) && evidence.gold.length) return { ...evidence.gold[0] };
  if (Array.isArray(evidence.silver) && evidence.silver.length) return { ...evidence.silver[0] };
  return null;
}

function isExportable(evidence) { return !!selectExportLocator(evidence); }

/** Bronze can REPAIR Gold/Silver but is never the answer itself. */
function bronzeRepairHints(evidence) {
  return (evidence && Array.isArray(evidence.bronze)) ? evidence.bronze : [];
}

module.exports = { buildLocatorEvidence, selectExportLocator, isExportable, bronzeRepairHints };
