'use strict';

/**
 * Story/Data alignment contract.
 *
 * The Architect can propose a dataBinding, but Node owns whether that binding
 * is actually aligned to the BRD/user-story clause the case claims to cover.
 * This module builds a deterministic sheet-to-requirement matrix and then marks
 * mismatched data-bound cases incomplete before they can reach execution/codegen.
 */

const { normalizeModuleKey, tokenize: moduleTokens } = require('./moduleIntelligence');
const { recordDegradation } = require('../lib/degradationSignal');

const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'user',
  'users', 'system', 'shall', 'should', 'must', 'can', 'will', 'able', 'into',
  'page', 'field', 'data', 'test', 'case', 'expected', 'result', 'value',
]);

function clean(value, max = 240) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function norm(value) {
  return clean(value).toLowerCase();
}

function toks(value) {
  return Array.from(new Set(
    String(value == null ? '' : value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  ));
}

function parseMapping(testData) {
  if (!testData || typeof testData !== 'object') return null;
  let mapping = testData.mapping;
  if (typeof mapping === 'string') {
    try { mapping = JSON.parse(mapping); } catch (_) { mapping = null; }
  }
  return mapping && typeof mapping === 'object' ? mapping : null;
}

function sheetsFor(testData) {
  if (!testData || typeof testData !== 'object') return [];
  if (Array.isArray(testData.sheets)) return testData.sheets;
  let parsed = testData.sheetsJson;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; }
  }
  return Array.isArray(parsed && parsed.sheets) ? parsed.sheets : [];
}

function bindingsFor(testData) {
  const mapping = parseMapping(testData);
  return Array.isArray(mapping && mapping.bindings)
    ? mapping.bindings.filter((b) => b && b.sheet)
    : [];
}

function bindingBySheet(testData) {
  return new Map(bindingsFor(testData).map((b) => [norm(b.sheet), b]));
}

function sheetByName(testData) {
  return new Map(sheetsFor(testData).map((s) => [norm(s && s.name), s]));
}

function isAuthBinding(binding) {
  return /auth|credential|login/i.test(`${binding?.purpose || ''} ${binding?.sheet || ''}`);
}

function moduleMatches(binding, moduleScope) {
  if (!moduleScope) return true;
  const wanted = normalizeModuleKey(moduleScope);
  const candidates = [binding?.moduleKey, binding?.module, binding?.scenarioName, binding?.sheet]
    .filter(Boolean)
    .map(normalizeModuleKey);
  if (candidates.some((c) => c === wanted)) return true;
  const hay = moduleTokens(`${binding?.sheet || ''} ${binding?.module || ''} ${binding?.purpose || ''}`);
  return moduleTokens(moduleScope).some((t) => hay.includes(t));
}

function bindingText(binding, sheet) {
  const roles = Object.keys(binding?.columnToField || {}).join(' ');
  const headers = Object.values(binding?.columnToField || {}).join(' ');
  const sheetHeaders = Array.isArray(sheet?.headers) ? sheet.headers.join(' ') : '';
  return [
    binding?.sheet,
    binding?.purpose,
    binding?.module,
    binding?.moduleKey,
    binding?.scenarioName,
    roles,
    headers,
    binding?.expectedColumn,
    binding?.rowClassColumn,
    sheetHeaders,
  ].filter(Boolean).join(' ');
}

function clauseText(clause) {
  return [
    clause?.id,
    clause?.requirementId,
    clause?.sourceType,
    clause?.moduleHint,
    clause?.behaviourText,
    clause?.excerpt,
  ].filter(Boolean).join(' ');
}

function overlapScore(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) return 0;
  const right = new Set(rightTokens);
  let hits = 0;
  for (const token of leftTokens) if (right.has(token)) hits += 1;
  return hits / Math.sqrt(leftTokens.length * rightTokens.length);
}

function scoreBindingClause(binding, sheet, clause) {
  const bTokens = toks(bindingText(binding, sheet));
  const cTokens = toks(clauseText(clause));
  let score = overlapScore(bTokens, cTokens);
  const bModule = normalizeModuleKey(binding?.moduleKey || binding?.module || '');
  const cModule = normalizeModuleKey(clause?.moduleHint || '');
  if (bModule && cModule && bModule === cModule) score += 0.5;
  const purposeTokens = toks(String(binding?.purpose || '').replace(/[_-]+/g, ' '));
  if (purposeTokens.length && purposeTokens.some((token) => toks(clauseText(clause)).includes(token))) score += 0.1;
  return score;
}

function buildStoryDataAlignmentIndex(testData, requirementClauses = [], opts = {}) {
  const sheets = sheetByName(testData);
  const clauses = (requirementClauses || []).filter((c) => c && (c.id || c.requirementId) && (c.behaviourText || c.excerpt));
  return bindingsFor(testData)
    .filter((binding) => moduleMatches(binding, opts.moduleScope))
    .map((binding) => {
      const sheet = sheets.get(norm(binding.sheet));
      const scored = clauses
        .map((clause) => ({
          clause,
          score: scoreBindingClause(binding, sheet, clause),
        }))
        .filter((item) => item.score > 0.08)
        .sort((a, b) => b.score - a.score || String(a.clause.id || a.clause.requirementId).localeCompare(String(b.clause.id || b.clause.requirementId)))
        .slice(0, 8);
      const alignedRequirementRefs = scored.map((item) => String(item.clause.id || item.clause.requirementId));
      const required = !isAuthBinding(binding);
      return {
        sheet: binding.sheet,
        purpose: binding.purpose || null,
        module: binding.module || binding.moduleKey || null,
        required,
        columnToField: binding.columnToField || {},
        expectedColumn: binding.expectedColumn || null,
        rowClassColumn: binding.rowClassColumn || null,
        alignedRequirementRefs,
        alignmentScore: scored[0] ? Number(scored[0].score.toFixed(3)) : 0,
        stories: scored.map((item) => ({
          id: String(item.clause.id || item.clause.requirementId),
          text: clean(item.clause.behaviourText || item.clause.excerpt, 180),
          score: Number(item.score.toFixed(3)),
        })),
      };
    });
}

function caseRequirementRefs(caseObj) {
  const refs = new Set();
  for (const ref of (Array.isArray(caseObj?.requirementRefs) ? caseObj.requirementRefs : [])) {
    if (ref) refs.add(String(ref));
  }
  const assertions = Array.isArray(caseObj?.declaredAssertions) ? caseObj.declaredAssertions : [];
  for (const assertion of assertions) {
    for (const ref of (Array.isArray(assertion?.requirementRefs) ? assertion.requirementRefs : [])) {
      if (ref) refs.add(String(ref));
    }
  }
  return Array.from(refs);
}

function appendBindingFinding(caseObj, finding) {
  if (!caseObj.dataBinding || typeof caseObj.dataBinding !== 'object') caseObj.dataBinding = {};
  const existing = Array.isArray(caseObj.dataBinding.findings) ? caseObj.dataBinding.findings : [];
  caseObj.dataBinding.findings = [...existing, finding].slice(0, 30);
  // Story↔data alignment is a token-overlap heuristic, not proof the data is missing. It must
  // never flip a binding (whose sheet/columns exist) to 'incomplete' — that would brand
  // user-provided data as incomplete because Node couldn't guess the link. Advisory only.
}

function validateScenarioDataAlignment(scenarios, testData, requirementClauses = [], opts = {}) {
  const index = buildStoryDataAlignmentIndex(testData, requirementClauses, opts);
  const bySheet = new Map(index.map((row) => [norm(row.sheet), row]));
  const hasClauses = (requirementClauses || []).some((c) => c && (c.id || c.requirementId));
  const stats = {
    alignmentCount: index.length,
    checkedCases: 0,
    mismatchedCases: 0,
    missingRefs: 0,
    unresolvedSheets: 0,
    uncoveredSheets: [],
    index,
  };
  if (!Array.isArray(scenarios) || !index.length) return stats;

  const coveredSheets = new Set();
  for (const scenario of scenarios) {
    for (const caseObj of (Array.isArray(scenario?.cases) ? scenario.cases : [])) {
      const sheetName = caseObj?.dataBinding?.sheet;
      if (!sheetName) continue;
      const alignment = bySheet.get(norm(sheetName));
      if (!alignment || !alignment.required) continue;
      // Binding was already resolved and verified by the coverage planner repair — trust it.
      if (caseObj?.dataBinding?.status === 'complete') {
        coveredSheets.add(norm(sheetName));
        continue;
      }
      stats.checkedCases += 1;
      const refs = caseRequirementRefs(caseObj);
      const alignedRefs = new Set(alignment.alignedRequirementRefs || []);
      if (hasClauses && alignedRefs.size === 0) {
        stats.unresolvedSheets += 1;
        appendBindingFinding(caseObj, {
          code: 'story_data_alignment_missing',
          severity: 'warning',
          sheet: sheetName,
          message: 'This data sheet could not be aligned to a BRD/user-story clause by token overlap; advisory only.',
        });
        continue;
      }
      if (hasClauses && refs.length === 0) {
        stats.missingRefs += 1;
        appendBindingFinding(caseObj, {
          code: 'story_data_requirement_ref_missing',
          severity: 'warning',
          sheet: sheetName,
          alignedRequirementRefs: Array.from(alignedRefs).slice(0, 8),
          message: 'Data-bound case did not cite a BRD/user-story clause; advisory only.',
        });
        continue;
      }
      const intersects = refs.some((ref) => alignedRefs.has(ref));
      if (hasClauses && alignedRefs.size && !intersects) {
        stats.mismatchedCases += 1;
        appendBindingFinding(caseObj, {
          code: 'story_data_requirement_mismatch',
          severity: 'warning',
          sheet: sheetName,
          caseRequirementRefs: refs,
          alignedRequirementRefs: Array.from(alignedRefs).slice(0, 8),
          message: 'Case requirementRefs do not match the clauses aligned to this data sheet (heuristic); advisory only.',
        });
        continue;
      }
      coveredSheets.add(norm(sheetName));
      if (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') {
        caseObj.dataBinding.alignedRequirementRefs = Array.from(alignedRefs).slice(0, 8);
        caseObj.dataBinding.alignmentScore = alignment.alignmentScore;
      }
    }
  }

  stats.uncoveredSheets = index
    .filter((row) => row.required && row.alignedRequirementRefs.length && !coveredSheets.has(norm(row.sheet)))
    .map((row) => ({ sheet: row.sheet, purpose: row.purpose, alignedRequirementRefs: row.alignedRequirementRefs.slice(0, 8) }));

  // SILENT-DEGRADATION META-FIX: per-case advisory findings are attached above,
  // but they live on each case object and never reach the operator as one honest
  // signal. When clauses were supplied yet a required data sheet could NOT be
  // aligned to any clause (token-overlap heuristic found nothing), emit a loud,
  // structured degradation so the reviewer knows story↔data linkage is
  // incomplete — instead of silently shipping data-bound cases whose provenance
  // we could not establish. This stays ADVISORY (it never flips a binding to
  // incomplete); it only makes the gap visible.
  if (hasClauses) {
    const unalignable = stats.unresolvedSheets + stats.missingRefs + stats.mismatchedCases;
    if (unalignable > 0) {
      recordDegradation({
        onLog: opts.onLog,
        collector: opts.collector,
        stage: 'story-data-alignment',
        reason: `${unalignable} data-bound case(s)/sheet(s) could not be aligned to a BRD/user-story clause by token overlap`
          + ` (${stats.unresolvedSheets} sheet(s) with no aligned clause, ${stats.missingRefs} case(s) citing no clause, ${stats.mismatchedCases} case(s) whose refs disagree with the aligned clauses)`,
        impact: 'story↔data provenance is unverified for these cases; their data binding is advisory and may not reflect the documented requirement',
        severity: 'warning',
      });
    }
  }
  return stats;
}

function buildStoryDataAlignmentBlock({ testData, requirementClauses = [], moduleScope = null, onLog = null, collector = null } = {}) {
  const hasClauses = (requirementClauses || []).some((c) => c && (c.id || c.requirementId) && (c.behaviourText || c.excerpt));
  if (!hasClauses) return null;
  const index = buildStoryDataAlignmentIndex(testData, requirementClauses, { moduleScope });
  const relevant = index.filter((row) => row.required || row.alignedRequirementRefs.length);
  if (!relevant.length) {
    // Clauses AND data bindings exist, yet no required sheet could be tied to a
    // clause — the Architect will get NO alignment contract and must guess the
    // story↔data linkage. Surface that honestly instead of returning null and
    // letting the prompt silently lose the contract.
    if (index.length) {
      recordDegradation({
        onLog,
        collector,
        stage: 'story-data-alignment',
        reason: `${index.length} data binding(s) present but none could be aligned to a BRD/user-story clause; no alignment contract was produced for the Architect`,
        impact: 'data-bound cases will be authored without a verified story↔data link, so their data may not match the documented requirement',
        severity: 'warning',
      });
    }
    return null;
  }
  const lines = [
    'STORY-DATA ALIGNMENT CONTRACT - Node verified which uploaded sheets belong to which BRD/user-story clauses.',
    'Use dataBinding ONLY when the case requirementRefs intersect the sheet alignedRequirementRefs.',
    'If a sheet has no alignedRequirementRefs, do not create a data-bound automated case from it unless the source text explicitly connects it.',
    'Every data-bound case must use {{role}} placeholders for inputs and {{expected}} for the expected outcome column.',
    '',
  ];
  for (const row of relevant.slice(0, 20)) {
    const roles = Object.entries(row.columnToField || {}).map(([role, header]) => `${role}<-"${header}"`).join(', ') || '(none)';
    lines.push(`Sheet "${row.sheet}" (${row.purpose || 'data'}, module ${row.module || 'unknown'})`);
    lines.push(`  roles: ${roles}`);
    if (row.expectedColumn) lines.push(`  expected: "${row.expectedColumn}"`);
    if (row.rowClassColumn) lines.push(`  row class: "${row.rowClassColumn}"`);
    lines.push(`  alignedRequirementRefs: ${row.alignedRequirementRefs.length ? row.alignedRequirementRefs.join(', ') : '(none - do not guess)'}`);
    for (const story of row.stories.slice(0, 3)) {
      lines.push(`    - ${story.id}: ${story.text}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  buildStoryDataAlignmentIndex,
  buildStoryDataAlignmentBlock,
  validateScenarioDataAlignment,
  caseRequirementRefs,
};
