'use strict';

/**
 * Phase H M3 — declared-assertion normalisation, ID stamping, validation.
 *
 * The Architect emits a structured `declaredAssertions` array per case (see
 * SCHEMA in server/services/agents/architect.js). This module is the
 * server-side contract enforcement layer between what the Architect produced
 * and what gets persisted on TestCase.declaredAssertions:
 *
 *   1. Stamp a stable `id` on every record (server-generated; the Architect
 *      doesn't assign IDs to avoid a class of duplication mistakes).
 *   2. Validate the type/payload shape and default missing fields
 *      (checkAt → 'end' when omitted; clamps unknown types).
 *   3. Surface structural problems via a `parseFailed` flag rather than
 *      rejecting the whole TC — at runtime, M4 routes parseFailed records
 *      to uncheckable("declared_assertion_unparseable") → needs_human, which
 *      lets QA see the malformed case instead of silently dropping it.
 *
 * Pure functions. No DB, no LLM, no side effects. Safe to call from any
 * persistence path.
 */

const crypto = require('crypto');

const VALID_TYPES = new Set([
  'REGEX',
  'NUMBER',
  'CURRENCY',
  'DATE',
  'TIME',
  'DATE_TIME',
  'DATETIME',
  'VISIBLE',
  'HIDDEN',
  'ENABLED',
  'DISABLED',
  'ATTRIBUTE',
  'VALUE',
  'SELECTED',
  'CHECKED',
  'COUNT',
  'TABLE',
  'TABLE_ROW',
  'TABLE_CELL',
  'TABLE_COLUMN',
  'TABLE_QUERY',
  'COLLECTION',
  'COLLECTION_MEMBERSHIP',
  'TEMPORAL',
  'TEXT',
  'URL',
  'ROLE',
  'DOWNLOAD',
  'FORBIDDEN_TEXT',  // negative-text assertion (Phase 2 stability layer)
  'FORBIDDEN_ROLE',  // negative-role assertion (Phase 2 stability layer)
  'EVALUATE',        // assertion against a browser_evaluate JS return value
  'PAGE',            // multi-signal page-identity (matchPageAssertion: weighted
                     // role/text/url quorum + primaryIndicator + atlas + LLM
                     // rescue). The STRONGEST grounded check, and the type the
                     // Architect schema marks PREFERRED for "user lands on X".
                     // Was missing here → every PAGE assertion the Architect
                     // emitted was rejected unknown_type:PAGE, double-wrapped as
                     // a parseFailed TEXT placeholder, and silently excluded from
                     // the verdict. Whole class of must-checks discarded.
  'PERFORMANCE',     // timing budget check — expected = threshold in ms (e.g. "2000");
                     // uses Navigation Timing API to measure actual page-load time.
                     // criticality 'must' hard-fails; 'should'/'incidental' annotates only.
  'A11Y',            // accessibility audit via axe-core — expected = min impact level
                     // ('critical'|'serious'|'moderate'|'minor'); violations at or above
                     // that level throw. Default 'critical' (WCAG AA critical issues only).
]);

const VALID_CHECK_AT = new Set(['end', 'transient']);

// Criticality tier — how essential the assertion is to the case's purpose.
// 'must' = acceptance criterion (hard-fails); 'should'/'incidental' = warning
// on mismatch, never a failure. DEFAULT is 'must': silence means hard
// requirement, so an Architect that omits the field can NEVER accidentally
// soften a real acceptance criterion. Only an explicit downgrade relaxes a
// check. (Pairs with computeVerdict's criticality-aware ladder.)
const VALID_CRITICALITY = new Set(['must', 'should', 'incidental']);
const DEFAULT_CRITICALITY = 'must';

function normalizeCriticality(raw) {
  const c = String(raw || '').toLowerCase();
  return VALID_CRITICALITY.has(c) ? c : DEFAULT_CRITICALITY;
}

// Provenance — where the assertion's expected value came from. Surfaced to the
// user in the Reports "Verdict & Evidence" tab so a human understands WHY a
// check exists and how the AI decided it. Default 'inferred' (the most modest
// claim) when the Architect omits it. `note` is a short plain-language string.
//   'qa_standard' = NOT in the uploaded document; the platform ADDED this check
//   on its own initiative from a universal web/UX/QA convention for the platform
//   class (e.g. an empty required field MUST surface a validation error). It is
//   a PRESENCE / SCOPE / error-CLASS structural check — never an invented exact
//   string — so it can never fabricate copy. Kept distinct from 'doc_quoted' so
//   the human always sees spec-derived vs AI-derived (senior-QA) expectations.
const VALID_PROVENANCE = new Set(['doc_quoted', 'atlas_reconciled', 'inferred', 'qa_standard', 'uploaded_requirement', 'inline_text']);
const DEFAULT_PROVENANCE = 'inferred';

function normalizeProvenance(raw) {
  const p = String(raw || '').toLowerCase();
  return VALID_PROVENANCE.has(p) ? p : DEFAULT_PROVENANCE;
}

function normalizeNote(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim();
  if (!n) return null;
  return n.length > 140 ? `${n.slice(0, 139)}…` : n;
}

function newAssertionId() {
  // ASN-<8 hex chars>. Short enough to read in a tool-use trace, unique
  // enough across millions of records. Server-side only; Architect never
  // sees these IDs (it emits records without ids; we assign here).
  return `ASN-${crypto.randomBytes(4).toString('hex')}`;
}

function hasPayloadValue(payload, ...keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(payload, key)
    && payload[key] !== undefined && payload[key] !== null);
}

function hasTargetDescriptor(payload) {
  return hasPayloadValue(payload, 'target', 'selector', 'locator', 'role', 'name', 'expectedRole', 'expectedText');
}

function numericLike(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || !value.trim()) return false;
  return Number.isFinite(Number(value.replace(/[\s,]/g, '')));
}

function tableModeFor(type, payload) {
  if (type.startsWith('TABLE_')) return type.slice('TABLE_'.length).toLowerCase();
  return String(payload.mode || payload.tableMode || payload.operation || '').toLowerCase();
}

/**
 * Validate a single raw declared-assertion record from Architect output.
 * Returns { ok, normalized, issue } — ok=false means the record will be
 * persisted with parseFailed:true so runtime can route it to needs_human.
 */
function validateRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, issue: 'not_an_object' };
  }
  const type = String(raw.type || '').toUpperCase();
  if (!VALID_TYPES.has(type)) {
    return { ok: false, issue: `unknown_type:${type || '(missing)'}` };
  }
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : null;
  if (!payload) {
    return { ok: false, issue: 'missing_payload' };
  }
  // Per-type payload shape check — minimal, just enough to catch obvious
  // garbage. M4's checkAssertion does the deep semantic validation.
  switch (type) {
    case 'TEXT':
    case 'FORBIDDEN_TEXT':
      if (typeof payload.expectedText !== 'string' && typeof payload.text === 'string') {
        payload.expectedText = payload.text;
      }
      if (typeof payload.expectedText !== 'string' && typeof payload.unexpectedText !== 'string') {
        return { ok: false, issue: 'text_assertion_needs_expectedText_or_unexpectedText' };
      }
      break;
    case 'URL':
      if (typeof payload.expectedUrlPattern !== 'string' && typeof payload.expectedUrl !== 'string') {
        return { ok: false, issue: 'url_assertion_needs_expectedUrlPattern' };
      }
      break;
    case 'REGEX':
      if (typeof payload.expectedPattern !== 'string' && typeof payload.pattern !== 'string') {
        return { ok: false, issue: 'regex_assertion_needs_pattern' };
      }
      break;
    case 'NUMBER': {
      const expected = hasPayloadValue(payload, 'expectedNumber') ? payload.expectedNumber
        : hasPayloadValue(payload, 'expectedValue') ? payload.expectedValue : payload.expected;
      if (!numericLike(expected)) return { ok: false, issue: 'number_assertion_needs_numeric_expected' };
      if (hasPayloadValue(payload, 'tolerance') && (!numericLike(payload.tolerance) || Number(payload.tolerance) < 0)) {
        return { ok: false, issue: 'number_assertion_tolerance_invalid' };
      }
      break;
    }
    case 'CURRENCY':
      if (!hasPayloadValue(payload, 'expectedAmount', 'expectedValue', 'expected')) {
        return { ok: false, issue: 'currency_assertion_needs_expected_amount' };
      }
      break;
    case 'DATE':
      if (!hasPayloadValue(payload, 'expectedDate', 'expectedValue', 'expected')) {
        return { ok: false, issue: 'date_assertion_needs_expected_date' };
      }
      break;
    case 'TIME':
      if (!hasPayloadValue(payload, 'expectedTime', 'expectedValue', 'expected')) {
        return { ok: false, issue: 'time_assertion_needs_expected_time' };
      }
      break;
    case 'DATE_TIME':
    case 'DATETIME':
      if (!hasPayloadValue(payload, 'expectedDateTime', 'expectedValue', 'expected')) {
        return { ok: false, issue: 'date_time_assertion_needs_expected_date_time' };
      }
      break;
    case 'VISIBLE':
    case 'HIDDEN':
      if (!hasTargetDescriptor(payload)) return { ok: false, issue: 'visibility_assertion_needs_target' };
      break;
    case 'ENABLED':
    case 'DISABLED':
      if (!hasTargetDescriptor(payload) || typeof payload.expectedEnabled !== 'boolean') {
        return { ok: false, issue: 'enablement_assertion_needs_target_and_expectedEnabled' };
      }
      break;
    case 'ATTRIBUTE':
      if (typeof (payload.attributeName || payload.name) !== 'string') {
        return { ok: false, issue: 'attribute_assertion_needs_attribute_name' };
      }
      break;
    case 'VALUE':
      if (!hasPayloadValue(payload, 'expectedValue', 'expected')) {
        return { ok: false, issue: 'value_assertion_needs_expected_value' };
      }
      break;
    case 'SELECTED':
    case 'CHECKED':
      if (!hasTargetDescriptor(payload)) return { ok: false, issue: 'state_assertion_needs_target' };
      break;
    case 'COUNT': {
      const expected = hasPayloadValue(payload, 'expectedCount') ? payload.expectedCount
        : hasPayloadValue(payload, 'expectedValue') ? payload.expectedValue : payload.expected;
      if (!numericLike(expected) || Number(expected) < 0) {
        return { ok: false, issue: 'count_assertion_needs_nonnegative_expected_count' };
      }
      break;
    }
    case 'TABLE':
    case 'TABLE_ROW':
    case 'TABLE_CELL':
    case 'TABLE_COLUMN':
    case 'TABLE_QUERY': {
      const mode = tableModeFor(type, payload);
      if (!['row', 'cell', 'column', 'query'].includes(mode)) {
        return { ok: false, issue: 'table_assertion_needs_supported_mode' };
      }
      if (mode === 'row' && !hasPayloadValue(payload, 'expectedRow', 'row')) {
        return { ok: false, issue: 'table_row_assertion_needs_expected_row' };
      }
      if (mode === 'cell' && (!hasPayloadValue(payload, 'column', 'columnName')
          || !hasPayloadValue(payload, 'expectedValue', 'expected'))) {
        return { ok: false, issue: 'table_cell_assertion_needs_column_and_expected_value' };
      }
      if (mode === 'column' && (!hasPayloadValue(payload, 'column', 'columnName')
          || !hasPayloadValue(payload, 'expectedValues', 'expectedValue', 'expected'))) {
        return { ok: false, issue: 'table_column_assertion_needs_column_and_expected_values' };
      }
      if (mode === 'query' && (!payload.where || typeof payload.where !== 'object' || Array.isArray(payload.where))) {
        return { ok: false, issue: 'table_query_assertion_needs_where_object' };
      }
      break;
    }
    case 'COLLECTION':
    case 'COLLECTION_MEMBERSHIP':
      if (!hasPayloadValue(payload, 'expectedMember', 'expectedItems', 'expectedValue', 'expected')) {
        return { ok: false, issue: 'collection_assertion_needs_expected_member_or_items' };
      }
      break;
    case 'TEMPORAL':
      if (typeof payload.comparator !== 'string'
        || !Array.isArray(payload.operands)
        || payload.operands.length !== 2) {
        return { ok: false, issue: 'temporal_assertion_needs_comparator_and_two_operands' };
      }
      break;
    case 'ROLE':
    case 'FORBIDDEN_ROLE':
      if (typeof payload.expectedRole !== 'string' && typeof payload.unexpectedRole !== 'string') {
        return { ok: false, issue: 'role_assertion_needs_expectedRole_or_unexpectedRole' };
      }
      break;
    case 'DOWNLOAD':
      if (!payload.filenamePattern && !payload.minSize && !payload.mimeType) {
        return { ok: false, issue: 'download_assertion_needs_at_least_one_criterion' };
      }
      break;
    case 'EVALUATE':
      if (typeof payload.script !== 'string' && typeof payload.expectedReturn !== 'string') {
        return { ok: false, issue: 'evaluate_assertion_needs_script_or_expectedReturn' };
      }
      break;
    case 'PAGE': {
      const sig = payload.expectedSignals;
      // #1 — a PAGE identity must be a REAL page, never an unresolved {{token}}.
      // The "blind bind" poison stamped an error-message column into a page name
      // (pageName="{{expectedValidationError}}"); such a PAGE can NEVER be checked
      // (missing_criteria → uncheckable → needs_human) and FALSE-BLOCKS the case.
      // Reject it as a contract defect (preserved parseFailed, excluded from the
      // hard verdict). Error expectations belong in TEXT/FIELD_ERROR/evidence —
      // NOT in PAGE identity. Generic: keyed off the unresolved-token shape only.
      const UNRESOLVED_TOKEN = /\{\{[^}]*\}\}/;
      const identStrings = [payload.pageName, payload.url]
        .concat(sig && Array.isArray(sig.url) ? sig.url : [])
        .concat(sig && Array.isArray(sig.text) ? sig.text : [])
        .filter((v) => typeof v === 'string');
      if (identStrings.some((v) => UNRESOLVED_TOKEN.test(v))) {
        return { ok: false, issue: 'page_assertion_unresolved_token' };
      }
      // Mirror the Architect's own checkability floor (architect.js
      // isCheckablePayload): a PAGE is structurally valid if expectedSignals has
      // at least ONE populated channel (text / role / url). The stricter
      // ≥2-channel rule is enforced upstream (markUnderspecifiedPage); this is
      // the defensive floor so a misordered call path can't pass an empty PAGE.
      // matchPageAssertion (mcp.js) does the deep semantic scoring at runtime.
      if (!sig || typeof sig !== 'object') {
        return { ok: false, issue: 'page_assertion_needs_expectedSignals' };
      }
      const hasText = Array.isArray(sig.text) && sig.text.some((v) => typeof v === 'string' && v.length > 0);
      const hasRole = Array.isArray(sig.role) && sig.role.some((r) => r && typeof r === 'object' && typeof r.role === 'string' && r.role.length > 0);
      const hasUrl  = Array.isArray(sig.url)  && sig.url.some((v) => typeof v === 'string' && v.length > 0);
      if (!hasText && !hasRole && !hasUrl) {
        return { ok: false, issue: 'page_assertion_needs_at_least_one_signal_channel' };
      }
      break;
    }
  }
  const checkAt = VALID_CHECK_AT.has(raw.checkAt) ? raw.checkAt : 'end';
  const targetUrl = typeof raw.targetUrl === 'string' && raw.targetUrl ? raw.targetUrl : null;
  // Preserve upstream-set parseFailed flag + reason (Rule 3: ungrounded text,
  // and future grounding rules for other types). When set, the assertion
  // validated structurally but was demoted by a higher-level policy — the
  // verdict layer reads parseFailedReason to route to the right uncheckable
  // bucket (e.g., "text_ungrounded") rather than the generic placeholder.
  const normalized = {
    id: typeof raw.id === 'string' && raw.id.startsWith('ASN-') ? raw.id : newAssertionId(),
    type,
    criticality: normalizeCriticality(raw.criticality),
    provenance: normalizeProvenance(raw.provenance),
    note: normalizeNote(raw.note),
    payload,
    targetUrl,
    checkAt,
    source: raw.source || 'architect',
  };
  if (raw.parseFailed === true) {
    normalized.parseFailed = true;
    if (typeof raw.parseFailedReason === 'string' && raw.parseFailedReason) {
      normalized.parseFailedReason = raw.parseFailedReason;
    }
  }
  return { ok: true, normalized };
}

/**
 * Normalize the Architect's `declaredAssertions` array for one case.
 *
 *   options.automatability: 'automatable' | 'manual'. Manual cases don't run
 *     through the verdict layer, so an empty array is fine for them. Automatable
 *     cases with an empty/missing array get a single placeholder record with
 *     parseFailed:true so M4 routes the TC to needs_human(no_assertions_declared)
 *     — surfaces the malformed case to QA instead of silently passing.
 *   options.caseName: included in synthetic placeholder for debugging.
 *
 * Returns { normalized: Array, issues: string[] }. `normalized` is always an
 * array (may be empty for manual cases, single-placeholder for malformed
 * automatable). `issues` lists problems for logging, never throws.
 */
function normalizeForCase(rawArray, { automatability = 'automatable', caseName = '' } = {}) {
  const issues = [];
  const inputArray = Array.isArray(rawArray) ? rawArray : null;

  if (!inputArray || inputArray.length === 0) {
    if (automatability === 'manual') {
      // Manual cases don't need declared assertions — verdict layer is bypassed.
      return { normalized: [], issues };
    }
    // Automatable case with no declared assertions — emit a parseFailed
    // placeholder so M4 routes to needs_human(no_assertions_declared).
    issues.push(`automation case "${caseName}" has empty declaredAssertions; routing to parseFailed placeholder`);
    return {
      normalized: [{
        id: newAssertionId(),
        type: 'TEXT',
        criticality: DEFAULT_CRITICALITY,
        payload: {},
        targetUrl: null,
        checkAt: 'end',
        source: 'architect',
        parseFailed: true,
        parseIssue: 'no_assertions_declared',
      }],
      issues,
    };
  }

  const normalized = [];
  for (let i = 0; i < inputArray.length; i++) {
    const raw = inputArray[i];
    const v = validateRecord(raw);
    if (v.ok) {
      normalized.push(v.normalized);
    } else {
      issues.push(`case "${caseName}" assertion[${i}] invalid: ${v.issue}`);
      // Preserve the broken record under a parseFailed flag — M4 routes it
      // to uncheckable("declared_assertion_unparseable") at runtime, which
      // becomes needs_human at the case verdict level. Better than dropping.
      normalized.push({
        id: newAssertionId(),
        type: 'TEXT',
        criticality: DEFAULT_CRITICALITY,
        payload: raw && typeof raw === 'object' ? raw : {},
        targetUrl: null,
        checkAt: 'end',
        source: 'architect',
        parseFailed: true,
        parseIssue: v.issue,
      });
    }
  }
  // Safety: an automatable case whose declaredAssertions array is non-empty
  // but contains ZERO non-parseFailed records — still surface as malformed
  // so QA reviews. parseFailed records alone aren't enough signal to verify.
  if (automatability !== 'manual' && normalized.every((n) => n.parseFailed)) {
    issues.push(`automation case "${caseName}" had ${normalized.length} declared assertions but ALL parseFailed`);
  }
  // Guardrail (DEFECT 4): an automatable case must keep at least one 'must'
  // assertion — the thing it proves. If the Architect downgraded everything to
  // should/incidental, the case could "pass" while proving nothing. Log only
  // for now (computeVerdict's criticality ladder enforces it once landed).
  const validRecords = normalized.filter((n) => !n.parseFailed);
  if (automatability !== 'manual' && validRecords.length > 0
      && !validRecords.some((n) => n.criticality === 'must')) {
    issues.push(`automation case "${caseName}" has ${validRecords.length} assertions but NONE are criticality:'must' — case would prove nothing`);
  }
  return { normalized, issues };
}

function parseAssertionArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function findMalformedMustAssertions(rawArray) {
  const records = parseAssertionArray(rawArray);
  const issues = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;
    const criticality = normalizeCriticality(raw.criticality);
    if (criticality !== 'must') continue;
    if (raw.parseFailed === true) {
      issues.push({
        id: raw.id || null,
        issue: raw.parseFailedReason || 'parse_failed',
        type: raw.type || null,
      });
      continue;
    }
    const checked = validateRecord(raw);
    if (!checked.ok) {
      issues.push({
        id: raw.id || null,
        issue: checked.issue,
        type: raw.type || null,
      });
    }
  }
  return issues;
}

function buildDeclaredAssertionsFromSteps(stepsInput, existingDeclared = []) {
  const steps = Array.isArray(stepsInput) ? stepsInput : [];
  const existing = parseAssertionArray(existingDeclared);
  const out = [];

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || typeof step !== 'object') continue;

    const actionName = step.action || step.type || '';
    const isVerify = step.verificationPoint || step.stepKind === 'verification' || /^Assert|^Verify/i.test(actionName) || !!step.verify;
    if (!isVerify) continue;

    const rawExpected = step.expected || (typeof step.verify === 'string' ? step.verify : step.verify?.text) || step.text || step.authoredText || '';
    let cleanExpected = String(rawExpected)
      .replace(/^Verify\s+that\s+/i, '')
      .replace(/\s+is\s+visible\.?$/i, '')
      .replace(/^["']|["']$/g, '')
      .replace(/["']\s+is\s+visible\.?$/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();
    if (!cleanExpected) continue;

    const target = step.element || step.target || null;
    const isTextVerify = /contains|has text|text/i.test(cleanExpected) || /Text/i.test(actionName);
    const assertionType = isTextVerify ? 'TEXT' : 'VISIBLE';

    out.push({
      id: newAssertionId(),
      type: assertionType,
      criticality: 'must',
      payload: isTextVerify
        ? { expectedText: cleanExpected, text: cleanExpected, target }
        : { text: cleanExpected, target: target || cleanExpected },
      targetUrl: null,
      checkAt: 'step',
      stepOrder: step.order || (index + 1),
      source: 'step_mutation',
    });
  }

  return out.length ? out : existing;
}

module.exports = {
  normalizeForCase,
  validateRecord,   // exported for tests
  findMalformedMustAssertions,
  newAssertionId,   // exported for tests
  normalizeCriticality,
  normalizeProvenance,
  normalizeNote,
  buildDeclaredAssertionsFromSteps,
  VALID_TYPES,
  VALID_CHECK_AT,
  VALID_CRITICALITY,
  DEFAULT_CRITICALITY,
  VALID_PROVENANCE,
  DEFAULT_PROVENANCE,
};
