'use strict';

/**
 * Step 3D — the per-case ORACLE CONTRACT (composed, deterministic, derivable).
 *
 * The platform's "what must be true for this case to pass" was scattered across
 * FIVE disconnected columns — declaredAssertions (the expectations), dataBindingJson
 * (where the data comes from), requirementRefs/storyId (what requirement it proves),
 * operationsJson (the typed plan), and the WorkbookContract on the TestDataSet (the
 * row-level expected-value evidence). Every consumer (the verdict engine, the
 * CaseCompiler promotion gate, the RTM, the export) re-derived its own partial view
 * from those columns, so none of them agreed on the oracle and none could see, in one
 * place, "this expected value is supposed to come from THIS workbook column."
 *
 * buildOracleContract() composes those sources into ONE canonical snapshot:
 *
 *   {
 *     schemaVersion:'oc-1', caseName, module, automatable,
 *     storyId, requirementRefs[], coverageItemId,
 *     dataBinding:{ sheet, rowSelector, storyColumn, matchKind, status, needsReview } | null,
 *     rowEvidence:{ sheet, storyColumn, rowSelector, rowCount, expectedColumns[],
 *                   oracleRoles[], requiredPlaceholders[], intentClass } | null,
 *     expectations:[ { id, type, criticality, expected, provenance, source, valid } ],
 *     operations:{ status, count, dropped },
 *     verdict:{ mode, mustCount, requiredEvidenceKinds[], unresolvedTokens[], expectsDataValue },
 *     findings:[ { code, severity, detail } ],
 *   }
 *
 * DESIGN — DERIVABLE, NOT a new persisted column. The CaseCompiler is deliberately
 * recompute-based (it never trusts a cached promotion column, so a stale snapshot can
 * never let a blocked case pass). The Oracle Contract follows the same rule: it is
 * COMPOSED ON DEMAND from the already-persisted columns (+ the WorkbookContract that
 * already lives on the TestDataSet), so it is always fresh and can never go stale.
 * persistCases assembles it at the canonical chokepoint (returned in `out[]` for the
 * route to log/use); the CaseCompiler assembles + CONSUMES it so its promotion verdict
 * is driven by the composed contract, not a sixth ad-hoc re-derivation.
 *
 * Pure — no DB, no LLM, no IO. Generic across any site/workbook — keyed off contract
 * shape (oracle types, header roles), never a site/sheet string.
 */

const declaredAssertionsLib = require('../lib/declaredAssertions');
const { normalizeStoryId } = require('../lib/storyId');

const SCHEMA_VERSION = 'oc-1';

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

function _parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) { try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; } }
  return [];
}
function _parseObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) { try { const j = JSON.parse(v); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null; } catch { return null; } }
  return null;
}

function _collectStrings(v, out) {
  if (v == null) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) _collectStrings(x, out); return; }
  if (typeof v === 'object') { for (const k of Object.keys(v)) _collectStrings(v[k], out); return; }
}
function scanTokens(...parts) {
  const strs = [];
  for (const p of parts) _collectStrings(p, strs);
  const set = new Set();
  for (const s of strs) { TOKEN_RE.lastIndex = 0; let m; while ((m = TOKEN_RE.exec(s)) !== null) set.add(m[1]); }
  return [...set];
}

/**
 * Extract the EXPECTED VALUE an assertion declares, by type. Returns a string (or
 * null when the assertion declares no concrete expected value, e.g. a presence-only
 * ROLE). Used to bind an expectation to the workbook column that should supply it.
 */
function expectedValueOf(a) {
  const type = String((a && a.type) || '').toUpperCase();
  const p = (a && a.payload && typeof a.payload === 'object') ? a.payload : (a || {});
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (type) {
    case 'TEXT': return s(p.expectedText) || s(p.unexpectedText);
    case 'FORBIDDEN_TEXT': return s(p.unexpectedText) || s(p.expectedText);
    case 'URL': return s(p.expectedUrlPattern);
    case 'ROLE': return s(p.expectedName) || s(p.expectedRole);
    case 'FORBIDDEN_ROLE': return s(p.unexpectedName) || s(p.unexpectedRole);
    case 'PAGE': return s(p.pageName) || s(p.url);
    case 'EVALUATE': return s(p.expectedReturn);
    case 'DOWNLOAD': return s(p.filenamePattern);
    case 'PERFORMANCE': return s(p.threshold) || s(p.expected);
    case 'A11Y': return s(p.level) || s(p.expected);
    default: return null;
  }
}

/**
 * The deterministic-evidence KIND a `must` assertion of this type requires the
 * conductor to observe (the verdict engine's vocabulary). Keeps the oracle honest:
 * the contract states up front which checks must run, so a verdict can't pass on a
 * kind that was never gathered.
 */
function evidenceKindOf(a) {
  const type = String((a && a.type) || '').toUpperCase();
  switch (type) {
    case 'TEXT': return 'text_present';
    case 'FORBIDDEN_TEXT': return 'text_absent';
    case 'URL': return 'url_match';
    case 'ROLE': return 'role_present';
    case 'FORBIDDEN_ROLE': return 'role_absent';
    case 'PAGE': return 'page_present';
    case 'EVALUATE': return 'evaluate_return';
    case 'DOWNLOAD': return 'download_present';
    case 'PERFORMANCE': return 'perf_within_budget';
    case 'A11Y': return 'a11y_within_level';
    default: return null;
  }
}

/**
 * Find the CoverageItem (from a WorkbookContract's buildCoverageItems output) that a
 * case's binding points at — by explicit coverageItemId, else by (sheet, storyId).
 * Returns null when no workbook contract / coverage items were supplied.
 */
function _resolveCoverageItem({ coverageItemId, sheet, storyId }, coverageItems) {
  if (!Array.isArray(coverageItems) || !coverageItems.length) return null;
  if (coverageItemId) {
    const byId = coverageItems.find((i) => i && i.id === coverageItemId);
    if (byId) return byId;
  }
  const wantSheet = sheet ? String(sheet).toLowerCase() : null;
  const wantStory = storyId ? normalizeStoryId(storyId) : null;
  if (wantSheet && wantStory) {
    const exact = coverageItems.find((i) => i && String(i.sheet).toLowerCase() === wantSheet && i.storyId && normalizeStoryId(i.storyId) === wantStory);
    if (exact) return exact;
  }
  if (wantSheet) {
    const bySheet = coverageItems.find((i) => i && String(i.sheet).toLowerCase() === wantSheet);
    if (bySheet) return bySheet;
  }
  return null;
}

/**
 * Compose the Oracle Contract for one case.
 *
 * @param {object} view normalized case (or stored-derived shape):
 *   { name, module, automatability, steps, assertions, declaredAssertions[],
 *     dataBinding|null, operations|null, requirementRefs[], storyId, coverageItemId }
 * @param {object} [opts]
 *   { workbookContract?, coverageItems? }  — optional row-evidence source. When a
 *   WorkbookContract (or its buildCoverageItems output) is supplied, the contract
 *   binds the case's expectations to the workbook columns that should supply them.
 * @returns {object} the Oracle Contract (serializable).
 */
function buildOracleContract(view, opts = {}) {
  const v = view || {};
  const automatable = String(v.automatability || 'automatable') !== 'manual';
  const declared = _parseArr(v.declaredAssertions);
  const binding = _parseObj(v.dataBinding);
  const operations = _parseObj(v.operations);
  const requirementRefs = Array.isArray(v.requirementRefs) ? v.requirementRefs.filter(Boolean) : [];
  const storyId = (typeof v.storyId === 'string' && v.storyId.trim()) ? v.storyId.trim()
    : (binding && typeof binding.storyId === 'string' ? binding.storyId : null);
  const coverageItemId = (typeof v.coverageItemId === 'string' && v.coverageItemId.trim()) ? v.coverageItemId.trim()
    : (binding && typeof binding.coverageItemId === 'string' ? binding.coverageItemId : null);

  const findings = [];

  // ── expectations: the declared oracle, normalized to a flat, typed view ───────
  const expectations = declared.map((a) => {
    const type = String((a && a.type) || '').toUpperCase();
    const valid = declaredAssertionsLib.VALID_TYPES.has(type) && a && a.parseFailed !== true;
    const criticality = declaredAssertionsLib.normalizeCriticality(a && a.criticality);
    const provenance = String((a && a.provenance) || '').toLowerCase() || null;
    return {
      id: (a && a.id) || null,
      type: type || null,
      criticality,
      expected: expectedValueOf(a),
      provenance,
      source: provenance === 'qa_standard' ? 'qa_standard' : 'doc',
      valid: !!valid,
    };
  });
  const musts = expectations.filter((e) => e.valid && e.criticality === 'must');

  // ── dataBinding (compact) + row evidence binding ──────────────────────────────
  let dataBindingView = null;
  let rowEvidence = null;
  const isDataDriven = !!(binding && binding.sheet);
  if (binding) {
    dataBindingView = {
      sheet: binding.sheet || null,
      rowSelector: binding.rowSelector || null,
      storyColumn: binding.storyColumn || null,
      matchKind: binding.matchKind || null,
      status: binding.status || null,
      needsReview: binding.needsReview === true ? true : undefined,
    };
  }
  const coverageItems = Array.isArray(opts.coverageItems)
    ? opts.coverageItems
    : (opts.workbookContract ? require('./workbookContract').buildCoverageItems(opts.workbookContract) : null);
  if (isDataDriven && coverageItems) {
    const ci = _resolveCoverageItem({ coverageItemId, sheet: binding.sheet, storyId }, coverageItems);
    if (ci) {
      rowEvidence = {
        sheet: ci.sheet,
        storyColumn: ci.storyColumn || null,
        rowSelector: ci.rowSelector || null,
        rowCount: ci.rowCount || 0,
        expectedColumns: Array.isArray(ci.expectedColumns) ? ci.expectedColumns : [],
        oracleRoles: Array.isArray(ci.oracleRoles) ? ci.oracleRoles.filter(Boolean) : [],
        requiredPlaceholders: Array.isArray(ci.requiredPlaceholders) ? ci.requiredPlaceholders : [],
        intentClass: ci.intentClass || null,
      };
    } else {
      findings.push({ code: 'row_evidence_unresolved', severity: 'info', detail: `data-driven case bound to sheet "${binding.sheet}"${storyId ? ` / story ${storyId}` : ''} but no matching CoverageItem in the supplied WorkbookContract` });
    }
  }

  // ── verdict requirements (the evidence the verdict engine must observe) ────────
  const tokens = scanTokens(v.name, v.steps, v.assertions, declared);
  const unresolvedTokens = tokens.length && !isDataDriven ? tokens : [];
  const requiredEvidenceKinds = [...new Set(musts.map(evidenceKindOf).filter(Boolean))];
  const expectsDataValue = isDataDriven && musts.some((m) => m.expected && TOKEN_RE.test(m.expected));
  TOKEN_RE.lastIndex = 0;
  const verdict = {
    mode: isDataDriven ? 'data_driven' : 'static',
    mustCount: musts.length,
    requiredEvidenceKinds,
    unresolvedTokens,
    expectsDataValue,
  };

  // ── composed findings (the row-evidence layer doing real work) ────────────────
  // A data-driven case whose oracle needs an expected OUTCOME, but the bound rows
  // expose NO expected column, has no data-sourced truth: any pass would be
  // self-asserted. Surface it (needs_review-class — never silently certified).
  if (automatable && isDataDriven && rowEvidence && musts.length && rowEvidence.oracleRoles.length === 0) {
    findings.push({ code: 'data_oracle_missing', severity: 'warning', detail: `data-driven case has ${musts.length} must assertion(s) but the bound rows ("${rowEvidence.sheet}") carry no expected/oracle column — the expected outcome cannot be sourced from data` });
  }
  // A must assertion whose expected text is a bare {{token}} the data can't supply.
  // The supply set must include the BINDING ALIASES, not just raw workbook column
  // names: dataBinding.columnToField maps a ROLE (e.g. `expected`) to a HEADER (e.g.
  // `expectedVisibleSignal`), so {{expected}} IS supplied when the binding aliases it.
  // Match on a normalized key (strip non-alphanumeric + lowercase) so {{expected}},
  // {{expectedVisibleSignal}} and {{expectedvisiblesignal}} all resolve. Include the
  // primary columnToField (roles + headers), expectedColumn / expectedColumns,
  // rowClassColumn, and any companion source columnToField. Without this the contract
  // false-flagged ~every data-oracle case as expected_value_token_unsupplied.
  if (automatable && isDataDriven && rowEvidence) {
    const norm = (s) => String(s == null ? '' : s).replace(/[^a-z0-9]/gi, '').toLowerCase();
    const supply = new Set();
    const add = (x) => { const k = norm(x); if (k) supply.add(k); };
    for (const p of rowEvidence.requiredPlaceholders) add(p);
    for (const c of rowEvidence.expectedColumns) add(c && c.name);
    const c2f = (binding && binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
    for (const [role, header] of Object.entries(c2f)) { add(role); add(header); }
    if (binding && binding.expectedColumn) { add('expected'); add(binding.expectedColumn); }
    if (binding && binding.expectedColumns && typeof binding.expectedColumns === 'object' && !Array.isArray(binding.expectedColumns)) {
      for (const [role, header] of Object.entries(binding.expectedColumns)) { add(role); add(header); }
    }
    if (binding && binding.rowClassColumn) { add('rowclass'); add('rowclasscolumn'); add(binding.rowClassColumn); }
    for (const comp of (Array.isArray(binding && binding.companions) ? binding.companions : [])) {
      const cc = (comp && comp.columnToField && typeof comp.columnToField === 'object') ? comp.columnToField : {};
      for (const [role, header] of Object.entries(cc)) { add(role); add(header); }
    }
    for (const m of musts) {
      if (!m.expected) continue;
      TOKEN_RE.lastIndex = 0; let mm;
      while ((mm = TOKEN_RE.exec(m.expected)) !== null) {
        if (!supply.has(norm(mm[1]))) {
          findings.push({ code: 'expected_value_token_unsupplied', severity: 'warning', detail: `must assertion expects {{${mm[1]}}} but no bound column/alias supplies it` });
        }
      }
    }
  }
  // Automatable case with no valid must — nothing to prove (advisory; CaseCompiler
  // also warns, but the contract states it so the RTM/verdict see one source).
  if (automatable && expectations.some((e) => e.valid) && musts.length === 0) {
    findings.push({ code: 'no_must_expectation', severity: 'warning', detail: 'case has valid assertions but none are criticality:must — it proves nothing' });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    caseName: v.name || null,
    module: v.module || null,
    automatable,
    storyId: storyId || null,
    requirementRefs,
    coverageItemId: coverageItemId || null,
    dataBinding: dataBindingView,
    rowEvidence,
    expectations,
    operations: {
      status: (operations && operations.status) || (operations ? 'incomplete' : null),
      count: operations && Array.isArray(operations.operations) ? operations.operations.length : 0,
      dropped: operations && Array.isArray(operations.dropped) ? operations.dropped.length : 0,
    },
    verdict,
    findings,
  };
}

/**
 * Derive the Oracle Contract from a STORED TestCase row (JSON-string columns), so the
 * approve gate / RTM / acceptance guard read the SAME composed oracle as generation —
 * regardless of a pre-regen client. Mirrors caseCompiler.compileStoredCase.
 */
function buildOracleContractFromStored(tcRow, opts = {}) {
  if (!tcRow || typeof tcRow !== 'object') return null;
  return buildOracleContract({
    name: tcRow.name,
    module: tcRow.module,
    automatability: tcRow.automatability,
    steps: _parseArr(tcRow.steps),
    assertions: tcRow.assertions || '',
    declaredAssertions: _parseArr(tcRow.declaredAssertions),
    dataBinding: _parseObj(tcRow.dataBindingJson),
    operations: _parseObj(tcRow.operationsJson),
    requirementRefs: _parseArr(tcRow.requirementRefs),
    storyId: tcRow.storyId || null,
    coverageItemId: tcRow.coverageItemId || null,
  }, opts);
}

/** Compact one-line summary (for logs / the review dump). */
function summarizeOracleContract(oc) {
  if (!oc) return 'no oracle contract';
  const story = oc.storyId ? `story=${oc.storyId}` : 'no-story';
  const mode = oc.verdict ? oc.verdict.mode : '?';
  const ev = oc.rowEvidence ? `rowEvidence(${oc.rowEvidence.rowCount}r, oracle=[${oc.rowEvidence.oracleRoles.join(',')}])` : 'no-row-evidence';
  const f = oc.findings.length ? ` findings=[${oc.findings.map((x) => x.code).join(',')}]` : '';
  return `OracleContract ${oc.schemaVersion} "${oc.caseName}" — ${mode}, ${story}, must=${oc.verdict ? oc.verdict.mustCount : 0}, ${ev}${f}`;
}

module.exports = {
  SCHEMA_VERSION,
  buildOracleContract,
  buildOracleContractFromStored,
  summarizeOracleContract,
  // exported for guards / reuse
  expectedValueOf,
  evidenceKindOf,
};
