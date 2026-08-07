'use strict';

/**
 * Precision Action Kernel (Phase B-2c.1) — the ONE atomic action-time capture
 * path. For every action the conductor dispatches it produces a single
 * PrecisionActionRecord that ties together: which approved step, what page we
 * were on, the intended target, the live ref we resolved it to, that ref's role/
 * type, the chosen locator candidate, the widget state before, the action
 * performed, the OBSERVED post-action effect, and a code-ready method intent.
 *
 * This is NOT a gate — it is the primary capture. Memory reuse (B-2c.2),
 * widget routines (B-2c.3), and codegen / the Certified Action Trace (Phase E)
 * all PLUG INTO this record instead of each re-deriving precision separately:
 * codegen consumes `codeReadyIntent`; a gate (if any) reads `certification`.
 *
 * Pure + deterministic (CLAUDE.md "Node unless genuine novelty"): given the
 * before/after observations it computes the record — no LLM, no DB, no MCP
 * roundtrip. Reuses the canonical snapshot parser + role sets from mcp.js so the
 * "is this an interactive target" judgement matches the certified resolver.
 */

const { buildRefRoleMap, CLICKABLE_ROLES, INPUT_ROLES } = require('./mcp');
const { selectExportLocator } = require('./locatorEvidenceCascade');

const INTERACTIVE_ROLES = new Set([...(CLICKABLE_ROLES || []), ...(INPUT_ROLES || []), 'listbox', 'slider', 'spinbutton']);
// Roles that are NEVER a valid interactive target (the wrong-nearby-click set).
const STATIC_ROLES = new Set(['heading', 'text', 'img', 'image', 'paragraph', 'banner', 'navigation', 'row', 'cell', 'rowheader', 'columnheader', 'list', 'listitem', 'article', 'region', 'separator', 'main', 'complementary', 'contentinfo']);

function normUrl(u) { return String(u || '').trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, ''); }

function actionVerb(toolName) {
  if (/type|fill/i.test(toolName)) return 'fill';
  if (/select/i.test(toolName)) return 'select';
  if (/click|hover|drag/i.test(toolName)) return 'click';
  if (/navigate/i.test(toolName)) return 'navigate';
  return 'other';
}

function valueFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  if (typeof args.text === 'string') return args.text;
  if (typeof args.value === 'string') return args.value;
  if (typeof args.values === 'string') return args.values;
  if (Array.isArray(args.values)) return args.values.join(', ');
  return null;
}

/**
 * Classify what the page did after the action — the EFFECT proof. A click/fill
 * that produced no observable change is recorded honestly (not silently "done").
 */
function classifyEffect({ urlBefore, urlAfter, snapshotBefore, snapshotAfter }) {
  const urlChanged = urlBefore != null && urlAfter != null && normUrl(urlBefore) !== normUrl(urlAfter);
  if (urlChanged) return { kind: 'navigated', observed: true, detail: `URL ${urlBefore} -> ${urlAfter}` };
  const haveBoth = typeof snapshotBefore === 'string' && typeof snapshotAfter === 'string';
  if (haveBoth && snapshotBefore !== snapshotAfter) return { kind: 'dom_changed', observed: true, detail: 'accessibility tree changed' };
  if (snapshotAfter == null && urlAfter == null) return { kind: 'unknown', observed: false, detail: 'no post-action observation captured' };
  return { kind: 'no_effect', observed: false, detail: 'no URL change and no accessibility-tree change after the action' };
}

/**
 * @param {object} input
 * @param {object} [input.approvedStep]   { id?, intent?, urlPattern? } — the step this action belongs to
 * @param {string} input.toolName
 * @param {object} input.args             the (resolved) tool args
 * @param {string} [input.targetLabel]    the model's human-readable target description
 * @param {string} [input.resolvedRef]    the live ref the action dispatched on (e.g. "e5")
 * @param {string} [input.snapshotBefore] accessibility snapshot before the action
 * @param {string} [input.snapshotAfter]  accessibility snapshot after the action
 * @param {string} [input.urlBefore]
 * @param {string} [input.urlAfter]
 * @param {object} [input.locatorCandidate] the chosen export locator (actionLocatorResolver output) or null
 * @param {object} [input.widgetStateBefore] widget-specific state (B-2c.3 plugs richer data here)
 * @param {string} [input.source]         'model' | 'memory_fast_path' | 'live_ref' | 'auto_injected'
 * @returns {object} PrecisionActionRecord
 */
function buildPrecisionActionRecord(input = {}) {
  const {
    approvedStep = null, toolName = '', args = {}, targetLabel = null, resolvedRef = null,
    snapshotBefore = null, snapshotAfter = null, urlBefore = null, urlAfter = null,
    locatorCandidate = null, locatorEvidence = null, widgetStateBefore = null, source = 'model',
  } = input;

  // B-2d.2c — the EXPORT locator comes from the Gold/Silver cascade when
  // action-time evidence is present (never Bronze/coordinates); otherwise fall
  // back to a legacy locatorCandidate. A bronze-only evidence yields null here →
  // the step is not export-ready (codegen fails closed, no coordinate fallback).
  const exportLocator = locatorEvidence ? selectExportLocator(locatorEvidence) : null;
  const finalLocator = exportLocator || locatorCandidate || null;

  // Resolve the ref's role/name from the BEFORE snapshot (what we acted on).
  let targetRole = null;
  let targetName = null;
  if (resolvedRef && typeof snapshotBefore === 'string') {
    const map = buildRefRoleMap(snapshotBefore);
    const hit = map.get(resolvedRef);
    if (hit) { targetRole = hit.role || null; targetName = hit.name || null; }
  }

  const verb = actionVerb(toolName);
  const value = valueFromArgs(args);
  const effect = classifyEffect({ urlBefore, urlAfter, snapshotBefore, snapshotAfter });

  // Target certification — interactive (not a static nearby element), resolved.
  const targetResolved = !!resolvedRef;
  const targetInteractive = !!(targetRole && INTERACTIVE_ROLES.has(targetRole) && !STATIC_ROLES.has(targetRole));
  const targetIsStatic = !!(targetRole && STATIC_ROLES.has(targetRole));
  const pageKnown = urlBefore != null;
  const pageMatchesStep = (approvedStep && approvedStep.urlPattern && urlBefore != null)
    ? normUrl(urlBefore).includes(normUrl(approvedStep.urlPattern).split('/').filter(Boolean).slice(-2).join('/'))
    : null; // null = no expectation declared

  // Overall status — honest, ordered. (This is data for an enforcer; the kernel
  // itself never blocks.)
  // Precedence mirrors the certification order (PAGE first, then TARGET, then
  // EFFECT): if you are on the wrong page you should not be acting here at all,
  // so that outranks any target-role finding.
  let status;
  if (!pageKnown) status = 'page_unknown';
  else if (pageMatchesStep === false) status = 'wrong_page_for_step';
  else if (verb !== 'navigate' && !targetResolved) status = 'target_unresolved';
  else if (targetIsStatic) status = 'target_static_role'; // a wrong-nearby-click candidate
  else if (verb !== 'navigate' && targetRole && !targetInteractive) status = 'target_role_unverified';
  else if (!effect.observed) status = 'no_observable_effect';
  else status = 'certified';

  const certified = status === 'certified';

  return {
    approvedStepId: approvedStep ? (approvedStep.id ?? null) : null,
    source,
    page: { before: urlBefore, after: urlAfter, known: pageKnown, matchesStep: pageMatchesStep },
    intendedTarget: targetLabel,
    resolvedRef,
    target: { role: targetRole, name: targetName, interactive: targetInteractive, isStatic: targetIsStatic },
    locatorCandidate: locatorCandidate || null,
    locatorEvidence: locatorEvidence || null,
    locatorTier: exportLocator ? exportLocator.tier : (locatorCandidate ? 'legacy' : (locatorEvidence ? 'bronze_only' : 'none')),
    widgetStateBefore: widgetStateBefore || null,
    action: { verb, tool: toolName, value },
    effect,
    // What codegen / the Certified Action Trace will emit — no post-run recovery.
    // Locator is Gold/Silver only (cascade); Bronze/coordinates never exported.
    codeReadyIntent: {
      action: verb,
      target: { role: targetRole, name: targetName, locator: finalLocator },
      value: (verb === 'fill' || verb === 'select') ? value : undefined,
    },
    certification: {
      status,
      certified,
      targetResolved,
      targetInteractive,
      targetIsStatic,
      pageKnown,
      pageMatchesStep,
      effectObserved: effect.observed,
    },
  };
}

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/**
 * B-2c.2 — Memory / live-ref RE-CERTIFICATION. A remembered or model-supplied ref
 * must NOT be reused just because it worked before: between then and now the page
 * may have re-rendered and reassigned that ref to a DIFFERENT (or static) element.
 * Re-confirm the ref against the CURRENT snapshot and decide:
 *   reuse      — ref still present, interactive, and its name still matches intent.
 *   reresolve  — ref absent / now static / name drifted → resolve a fresh certified
 *                ref by description (role-safe, unambiguous) and use THAT instead.
 *   block      — neither the remembered ref nor a certified re-resolution is valid
 *                → do not dispatch (let the strict gate ask the model).
 *
 * Pure + deterministic. `resolveByDescription` is injected (the conductor passes
 * mcp.resolveActionRefByDescription) so this stays unit-testable and reuses the
 * one certified resolver. Returns the decision + the ref to actually use + a
 * pre-dispatch PrecisionActionRecord (effect filled in post-action by the caller).
 */
function recertifyRememberedTarget(input = {}) {
  const {
    rememberedRef = null, intendedLabel = null, snapshotBefore = null, urlBefore = null,
    approvedStep = null, toolName = '', source = 'memory_fast_path', resolveByDescription = null,
  } = input;

  const map = (typeof snapshotBefore === 'string') ? buildRefRoleMap(snapshotBefore) : new Map();
  const hit = rememberedRef ? map.get(rememberedRef) : null;
  const reresolve = () => (typeof resolveByDescription === 'function' && intendedLabel)
    ? resolveByDescription(snapshotBefore, intendedLabel, toolName) : null;

  let decision; let useRef = null; let reason;
  if (!hit) {
    const fresh = reresolve();
    if (fresh) { decision = 'reresolve'; useRef = fresh; reason = 'remembered ref absent in current snapshot (page re-rendered); re-resolved by description'; }
    else { decision = 'block'; reason = 'remembered ref absent and no certified re-resolution available'; }
  } else {
    const role = hit.role || null;
    const interactive = !!(role && INTERACTIVE_ROLES.has(role) && !STATIC_ROLES.has(role));
    const nameMatches = !intendedLabel || (hit.name && (_norm(hit.name).includes(_norm(intendedLabel)) || _norm(intendedLabel).includes(_norm(hit.name))));
    if (interactive && nameMatches) { decision = 'reuse'; useRef = rememberedRef; reason = 'remembered ref still present, interactive, and name matches intent'; }
    else {
      const fresh = reresolve();
      if (fresh) { decision = (fresh === rememberedRef) ? 'reuse' : 'reresolve'; useRef = fresh; reason = `remembered ref drifted (role=${role}, nameMatch=${!!nameMatches}); re-resolved by description`; }
      else { decision = 'block'; reason = `remembered ref drifted (role=${role}, nameMatch=${!!nameMatches}) and no certified re-resolution`; }
    }
  }

  const record = buildPrecisionActionRecord({
    approvedStep, toolName, args: useRef ? { ref: useRef } : {}, targetLabel: intendedLabel,
    resolvedRef: useRef, snapshotBefore, urlBefore, source,
  });
  return { decision, ref: useRef, reason, record };
}

module.exports = { buildPrecisionActionRecord, recertifyRememberedTarget, classifyEffect, actionVerb, INTERACTIVE_ROLES, STATIC_ROLES };
