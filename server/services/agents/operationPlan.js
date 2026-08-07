'use strict';

/**
 * Enterprise Mode P3d — Node disposition for the Architect's operations[] plan.
 *
 * The LLM PROPOSES a bounded operations[] plan per case (operations chosen from
 * the module's verified capability menu); NODE DISPOSES — same spine as
 * architect.markRequirementRefs. Pure (no DB / LLM / IO) → guarded directly by
 * scripts/verify_atlas.cjs.
 *
 * Drops (findings-only at authoring; HARD-gated at BDD package export):
 *   - operation_not_in_vocabulary          op ∉ capabilityVocabulary.OPERATIONS
 *   - operation_missing_capability_ref      non-global op with no capabilityRef
 *   - capability_not_in_atlas               capabilityRef matches no verified capability
 *                                           in this (module, authProfile) slice (RequirementSiteMismatch-class)
 *   - operation_not_allowed_for_type        op ∉ operationsForType(capability.type)
 *   - capability_operation_missing          capability does not expose the op
 *   - bad_criteria_operator                 a criterion operator ∉ CRITERIA_OPERATORS
 * Soft (kept, flagged): operation_unbound_placeholder — a {{token}} not in the
 *   approved TestData keys when TestData exists (P4 hardens this binding).
 *
 * THE EXPORT HARD LINE: a case with ANY dropped operation is stamped
 * operationStatus='incomplete'. The BDD package-export gate MUST refuse to ship
 * such a case as a complete-looking feature — block / mark unsupported until the
 * missing capability or data binding is resolved.
 *
 * Resolution keys (id / capabilityId / ref / key / name) MIRROR the BDD bridge's
 * buildCapabilityIndex EXACTLY, so a capabilityRef that resolves at authoring
 * resolves identically at compile — zero drift across the seam.
 */

const vocab = require('../../lib/capabilityVocabulary');

const stable = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();

function buildCapabilityIndex(capabilities) {
  const index = new Map();
  for (const cap of (Array.isArray(capabilities) ? capabilities : [])) {
    if (!cap || typeof cap !== 'object') continue;
    for (const k of [cap.id, cap.capabilityId, cap.ref, cap.key, cap.name]) {
      const key = stable(k);
      if (key && !index.has(key)) index.set(key, cap);
    }
  }
  return index;
}

function refOf(step) {
  return stable(step && (step.capabilityRef || step.capabilityId || step.capabilityKey || step.capabilityName));
}

function collectPlaceholders(value, found = new Set()) {
  if (value == null) return found;
  if (Array.isArray(value)) { value.forEach((v) => collectPlaceholders(v, found)); return found; }
  if (typeof value === 'object') { Object.values(value).forEach((v) => collectPlaceholders(v, found)); return found; }
  String(value).replace(/\{\{\s*([^}]+?)\s*\}\}|<([^>]+)>/g, (_, a, b) => { const n = String(a || b).trim(); if (n) found.add(n); return _; });
  return found;
}

/**
 * Validate ONE case's operations[] against the slice capability inventory.
 * @returns {{ operations: object[], dropped: Array<{operation,capabilityRef,reason,detail}>, findings: object[] }}
 */
function validateCaseOperations(operations, { capabilities = [], testDataKeys = [] } = {}) {
  const index = buildCapabilityIndex(capabilities);
  const keys = new Set((Array.isArray(testDataKeys) ? testDataKeys : []).map((k) => String(k).trim()).filter(Boolean));
  const kept = [];
  const dropped = [];
  const findings = [];
  const drop = (op, reason, detail) => {
    dropped.push({ operation: op && op.operation, capabilityRef: op && op.capabilityRef, reason, detail });
    findings.push({ kind: 'operation_dropped', reason, detail });
  };

  for (const op of (Array.isArray(operations) ? operations : [])) {
    if (!op || typeof op !== 'object' || typeof op.operation !== 'string') {
      drop(op, 'malformed', 'operation entry is not an object with an operation name');
      continue;
    }
    if (!vocab.isOperation(op.operation)) {
      drop(op, 'operation_not_in_vocabulary', `"${op.operation}" is not a capabilityVocabulary operation`);
      continue;
    }

    const isGlobal = vocab.GLOBAL_OPS.includes(op.operation);
    const params = (op.params && typeof op.params === 'object') ? op.params : {};

    if (!isGlobal) {
      const ref = refOf(op);
      if (!ref) { drop(op, 'operation_missing_capability_ref', `"${op.operation}" needs a capabilityRef`); continue; }
      const cap = index.get(ref);
      if (!cap) { drop(op, 'capability_not_in_atlas', `capabilityRef "${ref}" matches no verified capability in this module slice`); continue; }
      if (!vocab.operationsForType(cap.type).includes(op.operation)) { drop(op, 'operation_not_allowed_for_type', `"${op.operation}" is not valid for capability type "${cap.type}"`); continue; }
      const listed = Array.isArray(cap.operations) ? cap.operations : [];
      if (!listed.includes(op.operation)) { drop(op, 'capability_operation_missing', `capability "${cap.name}" does not expose "${op.operation}"`); continue; }
    }

    if (Array.isArray(params.criteria)) {
      const v = vocab.validateCriteria(params.criteria);
      if (v.length) { drop(op, 'bad_criteria_operator', v.join('; ')); continue; }
    }

    // Soft: only flag unbound placeholders when TestData EXISTS but this token is
    // not mapped (no TestData at all → P4 introduces it; not a finding yet).
    if (keys.size) {
      for (const ph of collectPlaceholders(params)) {
        if (!keys.has(ph)) findings.push({ kind: 'operation_unbound_placeholder', reason: 'unbound_placeholder', detail: `{{${ph}}} has no approved TestData binding`, soft: true });
      }
    }

    kept.push(op);
  }

  return { operations: kept, dropped, findings };
}

/**
 * Mark every case's operations[] IN PLACE (mirrors architect.markRequirementRefs,
 * which runs on the parsed JSON before normaliseCase). Stamps:
 *   c.operations        — the cleaned (kept) plan
 *   c.operationStatus   — 'complete' | 'incomplete'  (the export-gate signal)
 *   c.operationsDropped — [{operation, capabilityRef, reason, detail}]
 * No-op when a case has no operations[] (legacy / whole-project / manual cases).
 * @returns {{ casesWithOps, totalKept, totalDropped, incompleteCases, findings }}
 */
function markCaseOperations(parsedScenarios, capabilities = [], testDataKeys = []) {
  let casesWithOps = 0; let totalKept = 0; let totalDropped = 0; let incompleteCases = 0;
  const allFindings = [];
  const inv = Array.isArray(capabilities) ? capabilities : [];
  for (const s of (Array.isArray(parsedScenarios) ? parsedScenarios : [])) {
    for (const c of (s && Array.isArray(s.cases) ? s.cases : [])) {
      if (!c || !Array.isArray(c.operations) || !c.operations.length) continue;
      casesWithOps++;
      const r = validateCaseOperations(c.operations, { capabilities: inv, testDataKeys });
      c.operations = r.operations;
      c.operationsDropped = r.dropped;
      c.operationStatus = r.dropped.length ? 'incomplete' : 'complete';
      totalKept += r.operations.length;
      totalDropped += r.dropped.length;
      if (r.dropped.length) incompleteCases++;
      for (const f of r.findings) allFindings.push({ ...f, caseName: c.name });
    }
  }
  return { casesWithOps, totalKept, totalDropped, incompleteCases, findings: allFindings };
}

module.exports = { validateCaseOperations, markCaseOperations, buildCapabilityIndex, collectPlaceholders, refOf };
