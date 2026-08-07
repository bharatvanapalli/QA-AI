'use strict';

/**
 * Enterprise Mode P3 — the Capability Operation Vocabulary (FROZEN SEAM).
 *
 * THE point of P3 + the BDD pipeline: a single, UNIVERSAL vocabulary of typed
 * operations spans three layers —
 *
 *     atlas (produces capabilities, bound to VERIFIED selectors)
 *       → ReplayIR (executes the operations over those locators)
 *         → BDD (.feature renders each operation as ONE fixed Given/When/Then;
 *                glue calls the operation — never free model prose).
 *
 * The vocabulary is domain-independent (HR / CRM / banking / insurance /
 * e-commerce / admin). ONLY the evidence + locators are site-specific. That is
 * what makes "pick iPhone 17 black with the least visible price" expressible the
 * same way as "open the highest-priority claim": same operations, different atlas
 * evidence.
 *
 * CONTRACT DOCTRINE (same spine as P1/P2): the LLM may SELECT operations and bind
 * parameters; NODE owns the vocabulary, the type→operations map, and validation.
 * The LLM never invents an operation name, a capability type, or a step sentence.
 *
 * Pure (no DB / LLM / IO) so scripts/verify_atlas.cjs guards it directly. Imported
 * by the atlas (server side, mine) AND the BDD codegen lane (adapters, friend's) —
 * this file is the shared seam; neither side forks it.
 *
 * See ENTERPRISE_MODE.md → "P3 — Role-aware atlas" + "BDD as a first-class pipeline".
 */

// ── Capability types (locked vocabulary). entity_collection is the NORMALIZED
//    concept across table/grid/card/list — the surface you select/rank/choose over.
const CAPABILITY_TYPES = Object.freeze([
  'form',
  'table',
  'list',
  'search_filter_sort',
  'menu',
  'modal',
  'file',
  'workflow_action',
  'entity_collection',
]);

// ── Comparison operators for selectEntityWhere / assertTableContains criteria.
//    Deterministic, finite set — Node evaluates these, never the model.
const CRITERIA_OPERATORS = Object.freeze([
  'equals', 'not_equals', 'contains', 'not_contains',
  'starts_with', 'ends_with', 'gt', 'lt', 'gte', 'lte', 'in',
]);

/**
 * The operations. Each entry declares its parameter names (`?` = optional) and a
 * one-line intent. `criteria` params are arrays of { field, operator, value }
 * (operator ∈ CRITERIA_OPERATORS). This list is the BDD step registry's source of
 * truth: one operation ⇔ one canonical Given/When/Then sentence (rendered by the
 * friend's emitter, not here).
 */
const OPERATIONS = Object.freeze({
  // ── global / session (not bound to a single page capability) ──
  authenticateAs:      { scope: 'global', params: ['role'],            intent: 'establish the identity/auth-profile the rest of the flow runs as' },
  navigateToModule:    { scope: 'global', params: ['module'],          intent: 'go to a named module/area of the app' },
  assertVisibleText:   { scope: 'global', params: ['text'],            intent: 'assert a literal text is visible (text provenance comes from the requirement, never invented)' },

  // ── form ──
  fillField:           { scope: 'form', params: ['field', 'value'],    intent: 'enter a value into a named field' },
  submitForm:          { scope: 'form', params: [],                    intent: 'submit the current form via its verified submit control' },

  // ── entity_collection (table/grid/card/list) ──
  selectEntityWhere:   { scope: 'entity_collection', params: ['entity', 'criteria'], intent: 'narrow the collection to rows/cards matching ALL criteria' },
  rankByMin:           { scope: 'entity_collection', params: ['field'], intent: 'among the current selection, keep the one with the minimum value of field' },
  rankByMax:           { scope: 'entity_collection', params: ['field'], intent: 'among the current selection, keep the one with the maximum value of field' },
  chooseSelected:      { scope: 'entity_collection', params: [],        intent: 'act on the single entity the prior select/rank narrowed to' },
  assertTableContains: { scope: 'entity_collection', params: ['criteria'], intent: 'assert at least one row/card matches ALL criteria' },

  // ── workflow_action ──
  invokeAction:        { scope: 'workflow_action', params: ['action'],  intent: 'invoke a named workflow action (Approve/Delete/Save/Place Order…) via its verified control' },

  // ── file ──
  downloadFile:        { scope: 'file', params: ['target?'],            intent: 'trigger a download via the verified control' },
});

// ── Which operations each capability type may expose (plus the always-available
//    global ops). A capability record may only list operations from this set.
const GLOBAL_OPS = Object.freeze(['authenticateAs', 'navigateToModule', 'assertVisibleText']);
const CAPABILITY_OPERATIONS = Object.freeze({
  form:               ['fillField', 'submitForm'],
  search_filter_sort: ['fillField', 'selectEntityWhere'],
  table:              ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'],
  list:               ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'],
  entity_collection:  ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'],
  menu:               ['navigateToModule', 'invokeAction'],
  modal:              ['fillField', 'submitForm', 'invokeAction'],
  workflow_action:    ['invokeAction', 'submitForm'],
  file:               ['downloadFile'],
});

function isOperation(op) { return Object.prototype.hasOwnProperty.call(OPERATIONS, op); }
function isCapabilityType(t) { return CAPABILITY_TYPES.includes(t); }
function operationsForType(type) {
  return Array.from(new Set([...(CAPABILITY_OPERATIONS[type] || []), ...GLOBAL_OPS]));
}

/**
 * Validate one criteria array ([{ field, operator, value }]).
 * @returns {string[]} violations (empty = ok)
 */
function validateCriteria(criteria, path = 'criteria') {
  const v = [];
  if (!Array.isArray(criteria) || !criteria.length) { v.push(`${path}: must be a non-empty array`); return v; }
  criteria.forEach((c, i) => {
    if (!c || typeof c !== 'object') { v.push(`${path}[${i}]: not an object`); return; }
    if (!c.field || typeof c.field !== 'string') v.push(`${path}[${i}].field required`);
    if (!CRITERIA_OPERATORS.includes(c.operator)) v.push(`${path}[${i}].operator "${c.operator}" not in CRITERIA_OPERATORS`);
    if (!('value' in c)) v.push(`${path}[${i}].value required`);
  });
  return v;
}

/**
 * Validate a CapabilityRecord. NODE-OWNED — this is what keeps a capability (and
 * therefore any BDD generated from it) trustworthy.
 *
 * CapabilityRecord shape:
 *   {
 *     type: <CAPABILITY_TYPES>,
 *     name: string,                       // human label, e.g. "Add Employee"
 *     operations: [<operation names>],    // ⊆ operationsForType(type)
 *     evidence: { ...type-specific, every selector VERIFIED at extraction time... },
 *     elementRefs: string[],              // snapshot refs the evidence resolved from
 *   }
 *
 * CRITICAL RULE: a capability with NO verified evidence selector is UNUSABLE — the
 * caller (calibrator) drops it. validateCapabilityRecord enforces "evidence must
 * carry at least one selector"; the calibrator separately proves each selector
 * resolves against the live snapshot before persisting (a selector that can't
 * resolve ⇒ capability not usable).
 *
 * @returns {{ ok: boolean, violations: string[] }}
 */
function validateCapabilityRecord(rec) {
  const violations = [];
  if (!rec || typeof rec !== 'object') return { ok: false, violations: ['record: not an object'] };

  if (!isCapabilityType(rec.type)) violations.push(`type "${rec.type}" not in CAPABILITY_TYPES`);
  if (!rec.name || typeof rec.name !== 'string') violations.push('name required');

  const ops = Array.isArray(rec.operations) ? rec.operations : [];
  if (!ops.length) violations.push('operations: at least one required (a capability with no operation is inert)');
  const allowed = isCapabilityType(rec.type) ? operationsForType(rec.type) : [];
  for (const op of ops) {
    if (!isOperation(op)) violations.push(`operation "${op}" is not in the vocabulary`);
    else if (allowed.length && !allowed.includes(op)) violations.push(`operation "${op}" is not valid for capability type "${rec.type}"`);
  }

  // Evidence must exist and carry at least one selector string somewhere — the
  // "verified selector or the capability is unusable" rule. (Deep resolution
  // against the snapshot is the calibrator's job at extraction time.)
  const evidence = rec.evidence;
  if (!evidence || typeof evidence !== 'object') {
    violations.push('evidence required (a capability without verified evidence is unusable)');
  } else {
    // A non-empty "selector" STRING must appear somewhere in the evidence — the
    // key alone is not enough (a null/empty selector means we could not durably
    // locate the control, so the capability is not replayable). This is the
    // teeth behind "no verified selector ⇒ unusable".
    const hasSelector = /"selector"\s*:\s*"[^"]+"/.test(JSON.stringify(evidence));
    if (!hasSelector) violations.push('evidence carries no verified selector — capability is unusable');
  }

  return { ok: violations.length === 0, violations: Array.from(new Set(violations)) };
}

module.exports = {
  CAPABILITY_TYPES,
  CRITERIA_OPERATORS,
  OPERATIONS,
  GLOBAL_OPS,
  CAPABILITY_OPERATIONS,
  isOperation,
  isCapabilityType,
  operationsForType,
  validateCriteria,
  validateCapabilityRecord,
};
