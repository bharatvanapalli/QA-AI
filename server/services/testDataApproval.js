'use strict';
/**
 * testDataApproval (Enterprise Mode P4a) — the deterministic gate behind the
 * TestData approval workflow. dataMapper.js PROPOSES a column→field mapping;
 * THIS module DISPOSES: it verifies every bound column actually EXISTS in the
 * sheet, advisory-checks that typed columns hold conforming values, surfaces
 * UNCLEAR mappings (unmapped / low-confidence) for human approval, and resolves
 * {{placeholders}} against the APPROVED mapping. Same doctrine as operationPlan.js
 * (LLM proposes, Node disposes) and CLAUDE.md (Node unless genuine novelty) — no
 * prisma, no fs, no LLM here. Pure + unit-tested by scripts/verify_testdata.cjs.
 *
 * Output contract (frozen) — see ENTERPRISE_MODE.md → "P4":
 *   verifyMapping  → { ok, findings:[{ code, severity, sheet, header, detail }] }
 *   resolvePlaceholders → { ok, unresolved:[{ caseId, token, where }] }
 */

// Roles whose VALUES are type-checkable. Advisory only (warning, never blocks an
// approval) — a human can approve a "weird-looking" column on purpose. Role names
// mirror dataMapper.js FIELD_SYNONYMS so the two stay in lockstep.
const TYPED_ROLES = {
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v),
  amount: (v) => /^-?[$£€]?\s*\d[\d,]*(\.\d+)?$/.test(v),
  quantity: (v) => /^\d+$/.test(v),
  phone: (v) => /^[+()\-\s\d]{6,}$/.test(v),
  zip: (v) => /^[A-Za-z0-9\s-]{3,10}$/.test(v),
  otp: (v) => /^\d{4,8}$/.test(v),
  date: (v) => !Number.isNaN(Date.parse(v)),
};

// Roles whose values are secrets/PII → default sensitivity 'masked' (the P7 export
// binds these via valueRef, never an inline literal). Everything else 'synthetic'.
const MASKED_ROLES = new Set(['password', 'secret', 'otp', 'token', 'pin']);

// At least this fraction of sampled non-empty values must conform, else warn.
const TYPE_TOLERANCE = 0.5;

// Special row-describing tokens that resolve when the binding declares the column.
const EXPECTED_TOKEN = 'expected';
const ROWCLASS_TOKEN = 'rowclass';

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const { isNonExecutableSheet } = require('./testDataSheetPolicy');

/** Default per-column sensitivity for the approved-mapping seam (UI may override). */
function defaultSensitivity(role) {
  return MASKED_ROLES.has(String(role || '').toLowerCase()) ? 'masked' : 'synthetic';
}

function parseMaybe(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/**
 * Verify a draft (or to-be-approved) mapping against the actual uploaded sheets.
 * EXISTS is the only error-severity check (a binding that names a column the sheet
 * doesn't have is unapprovable). TYPED + UNCLEAR are warnings — surfaced for the
 * human, never auto-blocking ([[qaai-is-not-jira]]: expose, don't gate-by-default).
 */
function verifyMapping({ mapping, sheets } = {}) {
  const findings = [];
  const sheetGroupsByName = new Map();
  for (const sheet of (Array.isArray(sheets) ? sheets : [])) {
    const key = String(sheet && sheet.name || '').trim().toLowerCase();
    if (!sheetGroupsByName.has(key)) sheetGroupsByName.set(key, []);
    sheetGroupsByName.get(key).push(sheet);
  }
  const bindings = (mapping && Array.isArray(mapping.bindings)) ? mapping.bindings : [];

  for (const b of bindings) {
    if (!b || !b.sheet) continue;
    const candidates = sheetGroupsByName.get(String(b.sheet || '').trim().toLowerCase()) || [];
    if (candidates.length > 1) {
      findings.push({ code: 'ambiguous_sheet_reference', severity: 'error', sheet: b.sheet, header: null, detail: `binding references duplicate sheet name "${b.sheet}"; select an immutable sheet id before approval` });
      continue;
    }
    const sheet = candidates[0] || null;
    if (b.purpose === 'non_executable_metadata' || isNonExecutableSheet(sheet || { name: b.sheet, headers: [] })) {
      findings.push({ code: 'non_executable_sheet_mapped', severity: 'error', sheet: b.sheet, header: null, detail: `sheet "${b.sheet}" is workbook documentation/metadata and cannot be approved as executable test data` });
      continue;
    }
    if (!sheet) {
      findings.push({ code: 'sheet_not_found', severity: 'error', sheet: b.sheet, header: null, detail: `binding references sheet "${b.sheet}" which is not in the uploaded data` });
      continue;
    }
    // Match headers by a normalized (trim + case-insensitive) key so a draft
    // edited with stray case/whitespace still resolves — but ALWAYS report the
    // ORIGINAL header text in findings, and read row values by the actual header.
    const origHeaders = (Array.isArray(sheet.headers) ? sheet.headers : []).filter(Boolean);
    const normToOrig = new Map(origHeaders.map((h) => [String(h).trim().toLowerCase(), h]));
    const hasHeader = (h) => normToOrig.has(String(h == null ? '' : h).trim().toLowerCase());
    const origHeaderFor = (h) => normToOrig.get(String(h == null ? '' : h).trim().toLowerCase());
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];

    // EXISTS — every bound column must be a real header in this sheet.
    const cols = [];
    const c2f = (b.columnToField && typeof b.columnToField === 'object') ? b.columnToField : {};
    for (const [role, header] of Object.entries(c2f)) {
      cols.push({ role, header });
      if (!hasHeader(header)) {
        findings.push({ code: 'column_not_in_sheet', severity: 'error', sheet: b.sheet, header, detail: `column "${header}" (role ${role}) is not a header in sheet "${b.sheet}"` });
      }
    }
    for (const special of ['expectedColumn', 'rowClassColumn']) {
      if (b[special] && !hasHeader(b[special])) {
        findings.push({ code: 'column_not_in_sheet', severity: 'error', sheet: b.sheet, header: b[special], detail: `${special} "${b[special]}" is not a header in sheet "${b.sheet}"` });
      }
    }

    // TYPED — advisory: sampled values for a typeable role should mostly conform.
    for (const { role, header } of cols) {
      const validator = TYPED_ROLES[role];
      if (!validator || !hasHeader(header)) continue;
      const actual = origHeaderFor(header);
      const vals = rows.map((r) => r && r[actual]).filter((v) => v != null && String(v).trim() !== '');
      if (!vals.length) continue;
      const conforming = vals.filter((v) => validator(String(v).trim())).length;
      if (conforming / vals.length < TYPE_TOLERANCE) {
        findings.push({ code: 'column_type_mismatch', severity: 'warning', sheet: b.sheet, header, detail: `column "${header}" is bound to "${role}" but ${vals.length - conforming}/${vals.length} sampled values don't look like ${role}` });
      }
    }

    // UNCLEAR — low-confidence binding wants a human look before approval.
    if (b.confidence === 'low') {
      findings.push({ code: 'mapping_unclear', severity: 'warning', sheet: b.sheet, header: null, detail: `sheet "${b.sheet}" binding is low-confidence — review before approval` });
    }
  }

  // UNCLEAR — unmapped columns: map them or confirm they aren't inputs.
  const unmapped = (mapping && Array.isArray(mapping.unmapped)) ? mapping.unmapped : [];
  for (const u of unmapped) {
    if (u && u.header) findings.push({ code: 'mapping_unclear', severity: 'warning', sheet: u.sheet || null, header: u.header, detail: `column "${u.header}" is unmapped — map it or confirm it is not an input before approval` });
  }

  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/** The set of placeholder tokens an APPROVED mapping can resolve (lowercased). */
function mappingRoles(approvedMapping) {
  const roles = new Set();
  const bindings = (approvedMapping && Array.isArray(approvedMapping.bindings)) ? approvedMapping.bindings : [];
  for (const b of bindings) {
    const c2f = (b && b.columnToField && typeof b.columnToField === 'object') ? b.columnToField : {};
    for (const role of Object.keys(c2f)) roles.add(String(role).toLowerCase());
    if (b && b.expectedColumn) roles.add(EXPECTED_TOKEN);
    if (b && b.rowClassColumn) roles.add(ROWCLASS_TOKEN);
  }
  return roles;
}

function scanString(s, tokens) {
  if (typeof s !== 'string') return;
  PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER_RE.exec(s))) tokens.add(m[1]);
}

function deepScan(o, tokens) {
  if (o == null) return;
  if (typeof o === 'string') { scanString(o, tokens); return; }
  if (Array.isArray(o)) { for (const x of o) deepScan(x, tokens); return; }
  if (typeof o === 'object') { for (const x of Object.values(o)) deepScan(x, tokens); }
}

/** Every distinct {{token}} a case references (steps, assertions, declaredAssertions, operationsJson params). */
function placeholdersInCase(caseObj) {
  const tokens = new Set();
  if (!caseObj) return [];
  const steps = parseMaybe(caseObj.steps);
  if (Array.isArray(steps)) for (const st of steps) { scanString(st && st.value, tokens); scanString(st && st.element, tokens); scanString(st && st.action, tokens); }
  scanString(caseObj.assertions, tokens);
  const da = parseMaybe(caseObj.declaredAssertions);
  if (Array.isArray(da)) for (const a of da) { if (a && a.payload) deepScan(a.payload, tokens); }
  const ops = parseMaybe(caseObj.operationsJson);
  if (ops && Array.isArray(ops.operations)) for (const op of ops.operations) { if (op && op.params) deepScan(op.params, tokens); }
  return [...tokens];
}

/**
 * Resolve every case's {{placeholders}} against the APPROVED mapping. A token
 * resolves iff it's a mapped role (or the special expected/rowClass tokens the
 * binding declares). Unresolved tokens are the export-/contract-gate signal.
 */
function resolvePlaceholders({ cases, approvedMapping } = {}) {
  const roles = mappingRoles(approvedMapping);
  const unresolved = [];
  for (const c of (Array.isArray(cases) ? cases : [])) {
    for (const t of placeholdersInCase(c)) {
      if (!roles.has(String(t).toLowerCase())) {
        unresolved.push({ caseId: c.id || c.name || null, token: t, where: 'case' });
      }
    }
  }
  return { ok: unresolved.length === 0, unresolved };
}

/**
 * Recursively key-sorted JSON string — stable across key order + whitespace.
 * Used to diff a draft mapping against the approved snapshot WITHOUT a raw
 * string compare falsely flagging `draft_unapproved_changes` on reordered keys.
 */
function canonicalJson(value) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) return v.map(norm);
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = norm(v[k]); return acc; }, {});
  };
  try { return JSON.stringify(norm(value)); } catch (_) { return null; }
}

module.exports = {
  verifyMapping,
  resolvePlaceholders,
  defaultSensitivity,
  canonicalJson,
  // pure helpers used by the contract gate + guard
  placeholdersInCase,
  mappingRoles: (m) => [...mappingRoles(m)],
};
