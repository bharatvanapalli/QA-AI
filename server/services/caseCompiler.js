'use strict';

/**
 * caseCompiler — the deterministic PROMOTION AUTHORITY for generated test cases.
 *
 * The platform used to TREAT generation output as advisory: a case could carry
 * unresolved {{tokens}}, parseFailed/malformed `must` assertions, a structurally
 * broken data binding, or no typed operation plan, and still be approvable and
 * runnable ("Ready"). This module makes a case's runnability a COMPILED verdict,
 * not a hope: each case is classified
 *
 *     blocked       — a CORE INVARIANT is violated; the case cannot execute
 *                     correctly and must NEVER become approved/runnable.
 *     needs_review  — runnable, but incomplete (missing typed operations, weak
 *                     data binding, coverage gap) — surfaced loudly, not hidden.
 *     ready         — passes every invariant.
 *
 * The approve path refuses to promote a `blocked` case to `approved`; the run
 * path only runs `approved` cases — so a blocked case is structurally unrunnable
 * without ever bricking legitimate (ready / needs_review) generation.
 *
 * CORE INVARIANTS (hard blockers — the compiler rules, kept from the scattered
 * guards and made first-class):
 *   - an unresolved {{token}} that the case's data binding cannot fill cannot
 *     execute (it would type a literal "{{username}}");
 *   - a `must` assertion that is parseFailed / malformed / a malformed PAGE /
 *     an unresolved-token PAGE cannot be valid evidence;
 *   - a structurally broken data binding (sheet/column missing, intent mismatch)
 *     cannot run;
 *   - a URL assertion whose pattern is an unresolved placeholder cannot match.
 *
 * Pure + deterministic — no DB, no LLM, no side effects. Reuses the existing
 * declaredAssertions contract layer for assertion validity (no parser fork).
 * Generic across any site/workbook — keyed off contract shape, never a site
 * string. This is a compiler stage, NOT a patch: it is the single authority on
 * "can this generated case become runnable".
 */

const declaredAssertionsLib = require('../lib/declaredAssertions');
const oracleContractLib = require('./oracleContract');

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

// Step 3D — Oracle-Contract findings the compiler ELEVATES to a promotion signal.
// These are needs_review (warnings), never hard blockers: a data-driven case whose
// expected OUTCOME cannot be sourced from the bound rows is runnable but unverifiable
// from data, so it must be surfaced — not silently certified, not blocked.
const ORACLE_REVIEW_FINDINGS = new Set(['data_oracle_missing', 'expected_value_token_unsupplied']);

// Data-binding finding codes that mean the binding is structurally un-runnable
// (mirrors testDataAuthoring.STRUCTURAL_DATA_ERRORS — kept in sync; duplicated
// here so the compiler has no import cycle with the authoring module).
const STRUCTURAL_BINDING_CODES = new Set([
  'data_binding_sheet_not_found',
  'data_binding_column_not_found',
  'data_binding_column_corrupted',
  'data_binding_intent_mismatch',
  'data_binding_mixed_rows_without_scope',
]);

function _collectStrings(v, out) {
  if (v == null) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) _collectStrings(x, out); return; }
  if (typeof v === 'object') { for (const k of Object.keys(v)) _collectStrings(v[k], out); return; }
}

/** Every distinct {{token}} name appearing anywhere in the supplied parts. */
function scanTokens(...parts) {
  const strs = [];
  for (const p of parts) _collectStrings(p, strs);
  const set = new Set();
  for (const s of strs) {
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(s)) !== null) set.add(m[1]);
  }
  return [...set];
}

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

/**
 * Compile one case into a promotion verdict.
 *
 * @param {object} c normalized case: { name, steps[], assertions, declaredAssertions[], dataBinding|null, operations|null, automatability }
 * @param {object} [opts] { atlasHasCapabilities?: boolean, coverageUnmapped?: Set<string>|string[],
 *                          workbookContract?, coverageItems? }
 *   workbookContract/coverageItems — Step 3D row-evidence source. When supplied, the
 *   compiler composes the Oracle Contract WITH row evidence and elevates its
 *   data-oracle findings to needs_review. When absent (e.g. the execution gate), the
 *   Oracle Contract still composes (for the result) but no new findings fire — so the
 *   gate's behaviour is byte-identical to before 3D.
 * @returns {{ state:'ready'|'needs_review'|'blocked', blockers:Array, warnings:Array, automatable:boolean, oracleContract:object }}
 */
function compileCase(c, opts = {}) {
  const blockers = [];
  const warnings = [];
  const automatable = String((c && c.automatability) || 'automatable') !== 'manual';

  // Step 3D — compose the per-case Oracle Contract from ALL contract sources and
  // CONSUME it (not a disconnected layer): the compiler's promotion verdict is now
  // partly driven by the contract's composed row-evidence findings, and the contract
  // travels on the result for the RTM / verdict / report to read one source.
  let oracleContract = null;
  try {
    oracleContract = oracleContractLib.buildOracleContract(c, { workbookContract: opts.workbookContract, coverageItems: opts.coverageItems });
  } catch (_) { oracleContract = null; }

  // Manual cases are not executed by the agent — they carry no automation
  // contract, so the compiler does not block them. They are 'ready' (the manual
  // tester runs them by hand).
  if (!automatable) return { state: 'ready', blockers, warnings, automatable: false, oracleContract };

  const declared = _parseArr(c && c.declaredAssertions);
  const binding = _parseObj(c && c.dataBinding);
  const operations = _parseObj(c && c.operations);

  // ── 1) Assertion invariants (reuse the declaredAssertions contract layer) ──
  // parseFailed / malformed / malformed-PAGE / unresolved-token-PAGE `must`
  // assertions cannot be valid evidence → blocked.
  let malformedMust = [];
  try { malformedMust = declaredAssertionsLib.findMalformedMustAssertions(declared); } catch { malformedMust = []; }
  for (const m of malformedMust) {
    blockers.push({ code: 'assertion_invalid', detail: `must assertion ${m.id || '(unnamed)'} [${m.type || '?'}]: ${m.issue}` });
  }
  // An automatable case with ZERO declared assertions can verify nothing → blocked.
  // persistCases emits a parseFailed placeholder for this (caught above), but a
  // legacy direct-create path bypasses persistCases — so the compiler enforces it
  // independently rather than trusting an upstream placeholder.
  if (declared.length === 0) {
    blockers.push({ code: 'no_assertions', detail: 'automatable case has no declared assertions — nothing to verify' });
  }
  // An automatable case whose VALID assertions contain no `must` proves nothing —
  // runnable but should be reviewed (not a hard block; it can still execute).
  const validRecords = declared.filter((a) => a && a.parseFailed !== true);
  const hasMust = validRecords.some((a) => declaredAssertionsLib.normalizeCriticality(a.criticality) === 'must');
  if (validRecords.length > 0 && !hasMust) {
    warnings.push({ code: 'no_must_assertion', detail: 'case has assertions but none are criticality:must — it would prove nothing' });
  }

  // ── 2) Unresolved {{token}} invariant ──────────────────────────────────────
  // PROVISIONAL needs_review binding — the authoring layer explicitly flagged the
  // binding as unresolved-pending-human (a story_id_conflict, or a sheet matched by
  // NAME only with no CoverageItem/storyId proof). The correct sheet is not yet
  // settled, so a token "block" here would be misdiagnosed: once the human resolves
  // the story/sheet, the tokens fill from the correct source. These cases are
  // needs_review (surfaced, never silently ready, never auto-approved) rather than a
  // hard block. A NON-provisional binding still hard-blocks unresolved tokens (the
  // core invariant — a committed binding that can't fill its tokens can't run).
  const provisionalReview = !!(binding && Array.isArray(binding.findings)
    && binding.findings.some((f) => f && (f.code === 'story_id_conflict' || f.code === 'data_binding_sheet_exists_only')));
  const tokens = scanTokens(c && c.name, c && c.steps, c && c.assertions, declared);
  if (tokens.length) {
    if (!binding || !binding.sheet) {
      if (provisionalReview) {
        warnings.push({ code: 'tokens_pending_binding_review', tokens, detail: 'case uses {{tokens}} but its data binding is provisional (the story/sheet assignment must be confirmed) — resolve the binding and the tokens fill from the correct sheet' });
      } else {
        // Tokens but nothing to fill them → they execute as literal "{{x}}".
        blockers.push({ code: 'unresolved_tokens_no_binding', tokens, detail: 'case uses {{tokens}} but has no data binding to resolve them' });
      }
    } else {
      // The binding exists. Tokens the mapping CANNOT fill are flagged by the
      // authoring layer as data_placeholder_not_in_mapping (today advisory and
      // STILL marked complete — the exact "warnings are advisory" defect). The
      // compiler ELEVATES them: an unmappable token never gets substituted.
      const unmapped = (Array.isArray(binding.findings) ? binding.findings : [])
        .filter((f) => f && f.code === 'data_placeholder_not_in_mapping')
        .map((f) => f.token)
        .filter(Boolean);
      if (unmapped.length) {
        if (provisionalReview) warnings.push({ code: 'tokens_pending_binding_review', tokens: unmapped, sheet: binding.sheet });
        else blockers.push({ code: 'unmapped_tokens', tokens: unmapped, sheet: binding.sheet });
      }
    }
  }

  // ── 3) Structurally broken data binding ────────────────────────────────────
  if (binding) {
    const structural = (Array.isArray(binding.findings) ? binding.findings : [])
      .filter((f) => f && f.severity === 'error' && STRUCTURAL_BINDING_CODES.has(f.code));
    // A real STRUCTURAL error (sheet/column genuinely missing) ALWAYS blocks. A bare
    // status:'incomplete' blocks ONLY for a COMMITTED binding — a PROVISIONAL binding
    // (story_id_conflict / sheet_exists_only) is needs_review pending human resolution,
    // so a legacy/stale 'incomplete' left on such a binding must NOT hard-block it (that
    // kept old + partially-repaired sheet-exists cases blocked even after the repair
    // stopped writing 'incomplete'). It surfaces as a needs_review warning instead.
    if (structural.length || (binding.status === 'incomplete' && !provisionalReview)) {
      blockers.push({ code: 'data_binding_incomplete', sheet: binding.sheet, findings: structural.map((f) => f.code) });
    } else if (binding.status === 'incomplete' && provisionalReview) {
      warnings.push({ code: 'binding_provisional_incomplete', detail: 'binding is provisional (story/sheet pending human confirmation) — a stale incomplete status is treated as needs_review, not a hard block' });
    }
    // Advisory findings (literal-leak, missing input/expected placeholder) →
    // runnable, but worth review.
    const advisory = (Array.isArray(binding.findings) ? binding.findings : [])
      .filter((f) => f && f.severity !== 'error' && f.code !== 'data_placeholder_not_in_mapping');
    for (const f of advisory) warnings.push({ code: `binding_${f.code}` });
  }

  // ── 4) URL assertion whose pattern is an unresolved placeholder ─────────────
  for (const a of validRecords) {
    const type = String(a && a.type || '').toUpperCase();
    const payload = (a && a.payload) || {};
    if (type === 'URL' && typeof payload.expectedUrlPattern === 'string') {
      TOKEN_RE.lastIndex = 0;
      if (TOKEN_RE.test(payload.expectedUrlPattern)) {
        blockers.push({ code: 'url_pattern_unresolved_token', detail: payload.expectedUrlPattern });
      }
    }
  }

  // ── 5) Typed operations[] (soft — whole-project pipeline gap) ───────────────
  // When the atlas HAS capabilities but this automatable case has no complete
  // typed operation plan, it is incomplete (no certified execution plan). This
  // is needs_review, NOT blocked: the conductor can still run from steps, and
  // whole-project generation does not yet feed capabilities (a separate fix).
  if (opts.atlasHasCapabilities) {
    const opsComplete = !!(operations && operations.status === 'complete'
      && Array.isArray(operations.operations) && operations.operations.length);
    if (!opsComplete) {
      warnings.push({ code: 'no_typed_operations', detail: operations ? `operationStatus=${operations.status}; ${(operations.dropped || []).length} dropped` : 'no operation plan (atlas capabilities not wired into this generation path)' });
    }
  }

  // ── 6) Crawl-coverage gap (soft) ────────────────────────────────────────────
  if (opts.coverageUnmapped) {
    const unmappedSet = opts.coverageUnmapped instanceof Set ? opts.coverageUnmapped : new Set(opts.coverageUnmapped || []);
    const mod = String((c && c.module) || '').toLowerCase();
    if (mod && unmappedSet.has(mod)) {
      warnings.push({ code: 'crawl_coverage_gap', detail: `module "${mod}" was not mapped by the crawl — steps/assertions for it are unverified` });
    }
  }

  // ── 7) Oracle-Contract data-oracle findings (Step 3D) ───────────────────────
  // Elevate the composed contract's row-evidence findings to promotion warnings.
  // Only fires when a workbookContract/coverageItems was supplied (else the contract
  // carries no rowEvidence and these never appear) — so the execution gate is
  // unaffected. A data-driven case with no data-sourced oracle is needs_review, never
  // a hard block (it can still run; it just can't be verified from data).
  if (oracleContract && Array.isArray(oracleContract.findings)) {
    for (const f of oracleContract.findings) {
      if (f && ORACLE_REVIEW_FINDINGS.has(f.code)) {
        warnings.push({ code: f.code, detail: f.detail });
      }
    }
  }

  const state = blockers.length ? 'blocked' : (warnings.length ? 'needs_review' : 'ready');
  return { state, blockers, warnings, automatable: true, oracleContract };
}

/**
 * Compile a STORED TestCase row (JSON string columns) → verdict. Used by the
 * approve gate + the DB-acceptance guard, so enforcement reads the real persisted
 * contract (and works regardless of a pre-regen client — no new column needed).
 */
function compileStoredCase(tcRow, opts = {}) {
  if (!tcRow || typeof tcRow !== 'object') return { state: 'blocked', blockers: [{ code: 'no_case' }], warnings: [], automatable: false };
  return compileCase({
    name: tcRow.name,
    steps: _parseArr(tcRow.steps),
    assertions: tcRow.assertions || '',
    declaredAssertions: _parseArr(tcRow.declaredAssertions),
    dataBinding: _parseObj(tcRow.dataBindingJson),
    operations: _parseObj(tcRow.operationsJson),
    automatability: tcRow.automatability,
    module: tcRow.module,
    // Step 3D — thread the persisted traceability fields so the Oracle Contract
    // composed inside compileCase can resolve the bound CoverageItem by storyId /
    // explicit coverageItemId (the stored row carries both; dropping them made the
    // stored-path contract fall back to sheet-only resolution).
    requirementRefs: _parseArr(tcRow.requirementRefs),
    storyId: tcRow.storyId || null,
    coverageItemId: tcRow.coverageItemId || null,
  }, opts);
}

/**
 * The SINGLE execution gate shared by every conductor runner. Given the
 * `scenarios[]` (each with `.cases[]` of stored TestCase rows), it returns a new
 * scenarios array with every `blocked` case removed (and empty scenarios pruned),
 * plus the list of what was excluded. Non-mutating. Both runConductorWithRetries
 * implementations (route-local in agents.js AND the shared conductorRunner.js)
 * call this so there is ONE chokepoint — no run path can execute a blocked case.
 */
function excludeBlockedScenarios(scenarios, { onExcluded } = {}) {
  const excluded = [];
  const out = [];
  for (const scn of (Array.isArray(scenarios) ? scenarios : [])) {
    if (!scn || !Array.isArray(scn.cases)) { if (scn) out.push(scn); continue; }
    const kept = [];
    for (const tc of scn.cases) {
      let v = null;
      try { v = compileStoredCase(tc); } catch (_) { v = null; }
      if (v && v.state === 'blocked') { excluded.push({ id: tc.id, name: tc.name, blockers: v.blockers.map((b) => b.code) }); continue; }
      kept.push(tc);
    }
    if (kept.length) out.push({ ...scn, cases: kept });
  }
  if (excluded.length && typeof onExcluded === 'function') { try { onExcluded(excluded); } catch (_) {} }
  return { scenarios: out, excluded };
}

module.exports = {
  compileCase,
  compileStoredCase,
  excludeBlockedScenarios,
  scanTokens,
  STRUCTURAL_BINDING_CODES,
};
