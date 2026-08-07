'use strict';

const { normalizeModuleKey, tokenize: moduleTokens } = require('./moduleIntelligence');
const { isNonExecutableSheet } = require('./testDataSheetPolicy');
const { sanitizeTokenCorruptions } = require('../lib/tokenHygiene');
const { recordDegradation } = require('../lib/degradationSignal');

const VERSION = 1;

const ITEM_TYPES = Object.freeze({
  DATA_BOUND: 'DATA_BOUND',
  STANDARD: 'STANDARD',
  EXPANSION: 'EXPANSION',
  MISSING_CAPABILITY: 'MISSING_CAPABILITY',
});

const DISPOSITIONS = Object.freeze({
  COVERED: 'covered',
  ADVISORY_USED: 'advisory_used',
  MISSING_CAPABILITY: 'missing_capability',
  NEEDS_REVIEW: 'needs_review',
});

const SECURITY_TERMS = new Set(['security', 'xss', 'sql', 'injection', 'script', 'payload', 'sanitize', 'escape', 'malicious']);
const VALIDATION_TERMS = new Set(['validation', 'invalid', 'empty', 'blank', 'required', 'mandatory', 'boundary', 'error', 'form']);
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those',
  'user', 'users', 'system', 'shall', 'should', 'must', 'will', 'able',
  'into', 'page', 'field', 'data', 'test', 'case', 'expected', 'result',
  'value', 'when', 'then', 'where', 'there', 'their', 'have', 'has',
]);

function clean(value, max = 240) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function norm(value) {
  return clean(value).toLowerCase();
}

// Sheet-name normalization strips spaces, underscores, hyphens and lowercases so that
// "RoleAccessControl", "Role Access Control", and "role_access_control" all match.
function normSheet(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[\s_\-]+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function tokens(value) {
  return Array.from(new Set(
    String(value == null ? '' : value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  ));
}

// #24 — the STOP/SECURITY/VALIDATION sets and the [^a-z0-9] tokenizer above are
// ASCII/English-only. For a clause/row written in a non-Latin script the tokenizer
// yields ~nothing, so every overlap score silently collapses to 0 and the planner
// scores the requirement as "uncovered" with no signal that it simply couldn't read
// the text. This detects that shape STRUCTURALLY (text has real content, but
// stripping ASCII-alphanumerics removes almost none of it → the bytes are non-ASCII
// letters the tokenizer can't see) so the caller can recordDegradation instead of
// emitting a confident 0. Generic: keys off the alphabet of the bytes, not any word.
function isLikelyUntokenizable(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw.length < 3) return false;            // genuinely empty/trivial, not a script gap
  if (tokens(raw).length > 0) return false;    // tokenizer DID extract usable tokens
  // The text has content but produced no ASCII tokens — count letters the
  // tokenizer can never see (Unicode letters outside the ASCII range).
  const nonAscii = (raw.match(/[^\x00-\x7F]/g) || []).length;
  return nonAscii >= 3 && (nonAscii / raw.length) >= 0.3;
}

// Remove {{token}} placeholders that are corrupting words or concatenated to URLs.
// Does NOT touch tokens that are properly space-separated (the runner still substitutes those).
// sanitizeTokenCorruptions is imported from the single shared engine (../lib/tokenHygiene) so the
// coverage path and the canonical writer can never drift apart.

// When the planner proves a binding's sheet exists and stamps it 'complete', any prior
// structural finding (sheet/column-not-found) is now resolved and must be dropped — otherwise a
// stale error finding keeps the UI "Data incomplete" badge red on a binding that is actually fine.
const STRUCTURAL_DATA_FINDINGS = new Set(['data_binding_sheet_not_found', 'data_binding_column_not_found', 'data_binding_column_corrupted']);
function clearResolvedFindings(findings) {
  if (!Array.isArray(findings)) return undefined;
  const kept = findings.filter((f) => f && !STRUCTURAL_DATA_FINDINGS.has(f.code));
  return kept.length ? kept : undefined;
}

function parseMaybe(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function sheetsFor(testData) {
  if (!testData || typeof testData !== 'object') return [];
  const raw = Array.isArray(testData.sheets)
    ? testData.sheets
    : (() => { const p = parseMaybe(testData.sheetsJson, null); return Array.isArray(p && p.sheets) ? p.sheets : []; })();
  // Strip README / instructional sheets — they are documentation, not executable test data.
  return raw.filter((s) => s && !isNonExecutableSheet(s));
}

function mappingFor(testData) {
  if (!testData || typeof testData !== 'object') return { bindings: [], unmapped: [] };
  const parsed = parseMaybe(testData.mapping, null);
  return parsed && typeof parsed === 'object' ? parsed : { bindings: [], unmapped: [] };
}

function bindingsFor(testData, moduleScope = null) {
  const mapping = mappingFor(testData);
  const allBindings = Array.isArray(mapping.bindings) ? mapping.bindings : [];
  // Strip bindings that point to README / non-executable sheets.
  const bindings = allBindings.filter((b) => {
    if (!b || !b.sheet) return false;
    return !isNonExecutableSheet({ name: b.sheet, headers: [], rows: [] });
  });
  if (!moduleScope) return bindings.filter((b) => b && b.sheet);
  const wanted = normalizeModuleKey(moduleScope);
  return bindings.filter((b) => {
    if (!b || !b.sheet) return false;
    const candidates = [b.moduleKey, b.module, b.scenarioName, b.sheet]
      .filter(Boolean)
      .map(normalizeModuleKey);
    if (candidates.some((c) => c === wanted)) return true;
    const hay = moduleTokens(`${b.sheet || ''} ${b.module || ''} ${b.purpose || ''}`);
    return moduleTokens(moduleScope).some((t) => hay.includes(t));
  });
}

function storyIdOf(story, index) {
  // Prefer a compact explicit ID (requirement/clause ID like "REQ-001" or "RC-5").
  const explicit = clean(story && (story.id || story.requirementId || story.key), 40);
  if (explicit) return explicit;
  // Derive a short slug from the title so manifest IDs are reliably copyable.
  const slug = clean(story && (story.title || story.behaviourText || story.name), 50)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);
  return slug || `s${index + 1}`;
}

function storyTextOf(story) {
  return [
    story && story.id,
    story && story.requirementId,
    story && story.title,
    story && story.name,
    story && story.moduleHint,
    story && story.behaviourText,
    story && story.excerpt,
    story && story.content,
    story && story.description,
  ].filter(Boolean).join(' ');
}

function storiesFor({ requirements = [], requirementClauses = [], moduleScope = null } = {}) {
  const clauses = Array.isArray(requirementClauses)
    ? requirementClauses.filter((c) => c && (c.id || c.requirementId) && (c.behaviourText || c.excerpt))
    : [];
  const source = clauses.length ? clauses : (Array.isArray(requirements) ? requirements : []);
  const wanted = normalizeModuleKey(moduleScope);
  return source
    .map((story, index) => {
      const text = storyTextOf(story);
      return {
        id: storyIdOf(story, index),
        title: clean(story && (story.title || story.name || story.behaviourText || story.excerpt || story.content), 180),
        text,
        moduleHint: clean(story && (story.moduleHint || story.module || ''), 120) || null,
        source: clauses.length ? 'requirement_clause' : 'requirement',
        raw: story,
      };
    })
    .filter((story) => {
      if (!story.text) return false;
      if (!wanted) return true;
      const candidates = [story.moduleHint, story.title, story.text].filter(Boolean).map(normalizeModuleKey);
      return candidates.some((c) => c === wanted) || moduleTokens(story.text).some((t) => moduleTokens(moduleScope).includes(t));
    });
}

function overlapScore(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  let hits = 0;
  for (const token of a) if (set.has(token)) hits += 1;
  return hits / Math.sqrt(a.length * b.length);
}

function rowText(row) {
  if (!row || typeof row !== 'object') return '';
  return Object.values(row).map((v) => clean(v, 200)).join(' ');
}

function rowFeatures(rows) {
  const text = (rows || []).map(rowText).join(' ').toLowerCase();
  const security = /\b(xss|sql|injection|script|payload|sanitize|escape|malicious|select\s+\*|drop\s+table|<script|onerror|or\s+1\s*=\s*1)\b/i.test(text);
  const validation = /\b(empty|blank|required|mandatory|invalid|boundary|error|too short|too long|null|missing)\b/i.test(text);
  return { security, validation };
}

function storyHasAny(story, set) {
  const storyTokens = new Set(tokens(story && story.text));
  for (const token of set) if (storyTokens.has(token)) return true;
  return false;
}

function bindingText(binding, sheet) {
  const roles = Object.keys(binding && binding.columnToField || {}).join(' ');
  const headers = Object.values(binding && binding.columnToField || {}).join(' ');
  const sheetHeaders = Array.isArray(sheet && sheet.headers) ? sheet.headers.join(' ') : '';
  return [
    binding && binding.sheet,
    binding && binding.purpose,
    binding && binding.module,
    binding && binding.moduleKey,
    binding && binding.scenarioName,
    binding && binding.expectedColumn,
    binding && binding.rowClassColumn,
    roles,
    headers,
    sheetHeaders,
  ].filter(Boolean).join(' ');
}

function classifyBindingStory({ binding, sheet, story }) {
  const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
  const features = rowFeatures(rows);
  const storySecurity = storyHasAny(story, SECURITY_TERMS);
  const storyValidation = storyHasAny(story, VALIDATION_TERMS);
  let score = overlapScore(bindingText(binding, sheet), story.text);
  const bModule = normalizeModuleKey(binding && (binding.moduleKey || binding.module || ''));
  const sModule = normalizeModuleKey(story && story.moduleHint || '');
  if (bModule && sModule && bModule === sModule) score += 0.3;
  if (features.security && storySecurity) score += 0.45;
  if (features.validation && storyValidation) score += 0.3;
  const authLikeBinding = /\bauth|login|credential|password/i.test(`${binding && binding.purpose || ''} ${binding && binding.sheet || ''}`);
  if (authLikeBinding
    && /\bauth|login|sign.?in|credential|password|session/i.test(story.text)) {
    score += 0.25;
  }
  if (features.security && !storySecurity) score = Math.min(score, 0.27);
  if (features.validation && !storyValidation && !authLikeBinding) score = Math.min(score, 0.27);

  let confidence = 'low';
  if (score >= 0.55) confidence = 'high';
  else if (score >= 0.28) confidence = 'medium';

  return {
    score: Number(score.toFixed(3)),
    confidence,
    rowFeatures: features,
    reason: [
      features.security && storySecurity ? 'security_row_story_match' : null,
      features.validation && storyValidation ? 'validation_row_story_match' : null,
      bModule && sModule && bModule === sModule ? 'module_match' : null,
    ].filter(Boolean),
  };
}

function flattenCapabilities(calibrationAtlas) {
  if (!calibrationAtlas || typeof calibrationAtlas !== 'object') return [];
  if (Array.isArray(calibrationAtlas.capabilities)) return calibrationAtlas.capabilities;
  const pages = Array.isArray(calibrationAtlas.pages) ? calibrationAtlas.pages : [];
  return pages.flatMap((p) => Array.isArray(p.capabilities) ? p.capabilities.map((c) => ({ ...c, pageUrl: c.pageUrl || p.url })) : []);
}

function capabilityText(cap) {
  return [
    cap && cap.capabilityId,
    cap && cap.type,
    cap && cap.name,
    cap && cap.pageUrl,
    Array.isArray(cap && cap.operations) ? cap.operations.join(' ') : '',
    cap && cap.evidence ? JSON.stringify(cap.evidence) : '',
  ].filter(Boolean).join(' ');
}

function bindAtlasCapability(story, capabilities) {
  let best = null;
  for (const cap of capabilities || []) {
    const score = overlapScore(story.text, capabilityText(cap));
    if (score > 0.18 && (!best || score > best.score)) {
      best = { score, cap };
    }
  }
  if (!best) return null;
  return {
    capabilityId: best.cap.capabilityId || null,
    type: best.cap.type || null,
    name: best.cap.name || null,
    pageUrl: best.cap.pageUrl || null,
    score: Number(best.score.toFixed(3)),
  };
}

function rowSelectorFor(binding, sheet, rowIndexes) {
  if (!binding || !binding.rowClassColumn || !sheet || !Array.isArray(sheet.rows)) return 'all';
  const values = rowIndexes
    .map((i) => sheet.rows[i])
    .map((row) => clean(row && row[binding.rowClassColumn]).toLowerCase())
    .filter(Boolean);
  if (!values.length) return 'all';
  if (values.every((v) => /negative|invalid|error|fail|empty|blank|required/.test(v))) return 'negative';
  if (values.every((v) => /positive|valid|success|happy/.test(v))) return 'positive';
  return 'all';
}

function itemId(parts) {
  return parts.map((p) => clean(p, 80).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()).filter(Boolean).join('::');
}

function storyKey(value) {
  return clean(value, 180).toLowerCase().replace(/\s+/g, '');
}

function plannedAlignmentForStory(plan, story) {
  if (!plan || !Array.isArray(plan.alignments)) return null;
  const wanted = storyKey(story && story.id);
  const matches = plan.alignments.filter((alignment) => (
    (alignment.storyId && storyKey(alignment.storyId) === wanted)
    || (Array.isArray(alignment.clauseIds) && alignment.clauseIds.some((id) => storyKey(id) === wanted))
  ));
  return matches.length === 1 ? matches[0] : null;
}

function rowIndexesForSelection(sheet, selected) {
  const wanted = new Set((Array.isArray(selected && selected.rowIds) ? selected.rowIds : []).map(String));
  const rows = Array.isArray(sheet && sheet.rows) ? sheet.rows : [];
  if (!wanted.size) return rows.map((_, index) => index);
  return rows
    .map((row, index) => wanted.has(String(row && (row.__datasetRowId || row.rowId))) ? index : -1)
    .filter((index) => index >= 0);
}

function buildCoveragePlanManifest({
  requirements = [],
  requirementClauses = [],
  testData = null,
  calibrationAtlas = null,
  moduleScope = null,
  existingCoverageRefs = [],
  onLog = null,
  collector = null,
  storyDataAlignmentPlan = null,
} = {}) {
  const stories = storiesFor({ requirements, requirementClauses, moduleScope });
  const sheets = sheetsFor(testData);
  const sheetByName = new Map(sheets.map((s) => [norm(s && s.name), s]));
  const bindings = bindingsFor(testData, moduleScope);
  const capabilities = flattenCapabilities(calibrationAtlas);
  const existing = new Set((Array.isArray(existingCoverageRefs) ? existingCoverageRefs : []).map(String));
  const items = [];
  const advisory = [];

  // #24 — honest signal when story text is non-Latin and the English tokenizer can
  // read ~nothing. Without this the matcher silently scores every binding at 0 and
  // the clause looks "uncovered" for a reason the operator can't see. One aggregate
  // record (not one per story) keeps the signal loud but not noisy. Evaluate the
  // human-readable title + behaviour ONLY — story.text also concatenates the clause
  // ID ("REQ-1a2b") and source tag, which are always ASCII and would mask a fully
  // non-Latin requirement. The matcher scores against story.text, so a story whose
  // ONLY ASCII tokens come from its ID still scores ~0 against real bindings.
  const humanText = (s) => [s && s.title, s && s.raw && (s.raw.behaviourText || s.raw.excerpt || s.raw.description)]
    .filter(Boolean).join(' ');
  const untokenizableStories = stories.filter((s) => isLikelyUntokenizable(humanText(s)));
  if (untokenizableStories.length) {
    recordDegradation({
      onLog,
      collector,
      stage: 'coverage-planner',
      severity: 'warning',
      code: 'coverage_untokenizable_requirement',
      reason: `${untokenizableStories.length} of ${stories.length} requirement clause(s) are in a non-Latin script the English tokenizer cannot read (e.g. "${clean(humanText(untokenizableStories[0]) || untokenizableStories[0].id, 60)}").`,
      impact: 'Data/atlas binding for those clauses falls back to story-only coverage; security/validation row matching is skipped — verify their coverage manually.',
    });
  }

  for (const story of stories) {
    const plannedAlignment = plannedAlignmentForStory(storyDataAlignmentPlan, story);
    if (storyDataAlignmentPlan && plannedAlignment) {
      if (Array.isArray(plannedAlignment.selected) && plannedAlignment.selected.length) {
        for (const selected of plannedAlignment.selected) {
          const matchingSheets = sheets.filter((sheet) => (
            (!selected.datasetRevisionId || sheet.datasetRevisionId === selected.datasetRevisionId)
            && (!selected.sheetId || sheet.sheetId === selected.sheetId)
          ));
          const matchingBindings = bindings.filter((binding) => (
            (!selected.datasetRevisionId || binding.datasetRevisionId === selected.datasetRevisionId)
            && (!selected.sheetId || binding.sheetId === selected.sheetId)
          ));
          if (matchingSheets.length !== 1 || matchingBindings.length !== 1) {
            const err = new Error(`The approved alignment for ${story.id} does not resolve to exactly one sheet and mapping.`);
            err.code = 'STORY_DATA_ALIGNMENT_UNRESOLVED';
            err.status = 422;
            err.findings = [{
              storyId: story.id,
              datasetRevisionId: selected.datasetRevisionId,
              sheetId: selected.sheetId,
              sheetCandidates: matchingSheets.length,
              bindingCandidates: matchingBindings.length,
            }];
            throw err;
          }
          const sheet = matchingSheets[0];
          const binding = matchingBindings[0];
          const rowIndexes = rowIndexesForSelection(sheet, selected);
          if (selected.rowIds && selected.rowIds.length && rowIndexes.length !== selected.rowIds.length) {
            const err = new Error(`The approved row group for ${story.id} no longer matches the selected dataset revision.`);
            err.code = 'STORY_DATA_ROW_REVISION_MISMATCH';
            err.status = 422;
            err.findings = [{ storyId: story.id, rowGroupId: selected.rowGroupId }];
            throw err;
          }
          const plannedId = itemId(['cov', story.id, selected.sheetId, selected.rowGroupId]);
          items.push({
            manifestItemId: plannedId,
            priority: 1,
            type: ITEM_TYPES.DATA_BOUND,
            required: !existing.has(plannedId),
            confidence: selected.matchKind === 'story_id' ? 'exact' : 'high',
            storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
            dataSource: {
              datasetId: selected.datasetId,
              datasetRevisionId: selected.datasetRevisionId,
              sheetId: selected.sheetId,
              sheet: sheet.name,
              rowGroupId: selected.rowGroupId,
              rowIds: [...(selected.rowIds || [])],
              rows: rowIndexes,
              rowSelector: binding.rowSelector || 'all',
              placeholders: Object.keys(binding.columnToField || {}),
              expectedToken: binding.expectedColumn ? 'expected' : null,
              expectedColumn: binding.expectedColumn || null,
              rowClassColumn: binding.rowClassColumn || null,
              mappingId: binding.mappingId || selected.bindingRef && selected.bindingRef.mappingId || null,
              mappingVersion: binding.mappingVersion || selected.bindingRef && selected.bindingRef.mappingVersion || null,
            },
            alignmentRef: {
              planId: storyDataAlignmentPlan.planId,
              alignmentId: plannedAlignment.alignmentId,
              rowGroupId: selected.rowGroupId,
              matchKind: selected.matchKind,
            },
            atlasBinding: bindAtlasCapability(story, capabilities),
            requiredCoverage: { kind: 'all_rows', rowCount: rowIndexes.length },
            strategy: 'Generate one case contract for this preselected immutable row group.',
            score: selected.score,
            reason: plannedAlignment.decision && plannedAlignment.decision.reason,
          });
        }
      } else {
        const atlasBinding = bindAtlasCapability(story, capabilities);
        const isMissingCapability = !atlasBinding && capabilities.length > 0;
        const manifestItemId = itemId(['cov', story.id, 'standard']);
        items.push({
          manifestItemId,
          priority: 2,
          type: isMissingCapability ? ITEM_TYPES.MISSING_CAPABILITY : ITEM_TYPES.STANDARD,
          required: !existing.has(manifestItemId) && !isMissingCapability,
          advisory: isMissingCapability,
          confidence: 'none',
          storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
          dataSource: null,
          alignmentRef: { planId: storyDataAlignmentPlan.planId, alignmentId: plannedAlignment.alignmentId, status: plannedAlignment.status },
          atlasBinding,
          requiredCoverage: { kind: 'story' },
          strategy: 'Generate from the requirement without binding unused or unselected test data.',
          score: 0,
        });
      }
      continue;
    }
    if (storyDataAlignmentPlan) {
      const atlasBinding = bindAtlasCapability(story, capabilities);
      const isMissingCapability = !atlasBinding && capabilities.length > 0;
      const manifestItemId = itemId(['cov', story.id, 'standard']);
      items.push({
        manifestItemId,
        priority: 2,
        type: isMissingCapability ? ITEM_TYPES.MISSING_CAPABILITY : ITEM_TYPES.STANDARD,
        required: !existing.has(manifestItemId) && !isMissingCapability,
        advisory: isMissingCapability,
        confidence: 'none',
        storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
        dataSource: null,
        alignmentRef: { planId: storyDataAlignmentPlan.planId, status: 'unmapped_requirement_unit' },
        atlasBinding,
        requiredCoverage: { kind: 'story' },
        strategy: 'Generate from the requirement; no exact pre-step data alignment exists.',
        score: 0,
      });
      continue;
    }
    const scored = bindings
      .map((binding) => {
        const sheet = sheetByName.get(norm(binding.sheet));
        const classification = classifyBindingStory({ binding, sheet, story });
        return { binding, sheet, ...classification };
      })
      .sort((a, b) => b.score - a.score || String(a.binding.sheet).localeCompare(String(b.binding.sheet)));
    const high = scored.filter((s) => s.confidence === 'high');
    const medium = scored.filter((s) => s.confidence === 'medium');
    const atlasBinding = bindAtlasCapability(story, capabilities);

    if (high.length) {
      // One required DATA_BOUND item per story — the best-scoring binding only.
      // Additional high-confidence bindings become advisory so the manifest stays
      // lean and synthesis doesn't explode when a story matches multiple sheets.
      const [best, ...extras] = high;
      const bestRows = Array.isArray(best.sheet && best.sheet.rows) ? best.sheet.rows : [];
      const bestIndexes = bestRows.map((_, i) => i);
      const bestId = itemId(['cov', story.id, best.binding.sheet]);
      items.push({
        manifestItemId: bestId,
        priority: 1,
        type: ITEM_TYPES.DATA_BOUND,
        required: !existing.has(bestId),
        confidence: 'high',
        storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
        dataSource: {
          sheet: best.binding.sheet,
          rows: bestIndexes,
          rowSelector: rowSelectorFor(best.binding, best.sheet, bestIndexes),
          placeholders: Object.keys(best.binding.columnToField || {}),
          expectedToken: best.binding.expectedColumn ? 'expected' : null,
          expectedColumn: best.binding.expectedColumn || null,
          rowClassColumn: best.binding.rowClassColumn || null,
        },
        atlasBinding,
        requiredCoverage: { kind: 'all_rows', rowCount: bestIndexes.length },
        strategy: `Generate a data-bound case for ${best.binding.sheet} using placeholders and fan-out rows.`,
        score: best.score,
        reason: best.reason,
      });
      // Remaining high-confidence bindings → advisory (not required).
      for (const match of extras.slice(0, 2)) {
        const rows = Array.isArray(match.sheet && match.sheet.rows) ? match.sheet.rows : [];
        const rowIndexes = rows.map((_, i) => i);
        advisory.push({
          manifestItemId: itemId(['adv', story.id, match.binding.sheet]),
          priority: 3,
          type: ITEM_TYPES.DATA_BOUND,
          required: false,
          advisory: true,
          confidence: 'high',
          storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
          dataSource: {
            sheet: match.binding.sheet,
            rows: rowIndexes,
            rowSelector: rowSelectorFor(match.binding, match.sheet, rowIndexes),
            placeholders: Object.keys(match.binding.columnToField || {}),
            expectedToken: match.binding.expectedColumn ? 'expected' : null,
            expectedColumn: match.binding.expectedColumn || null,
            rowClassColumn: match.binding.rowClassColumn || null,
          },
          atlasBinding,
          requiredCoverage: { kind: 'advisory' },
          strategy: 'Secondary high-confidence binding — use if it fits; omission is not blocked.',
          score: match.score,
          reason: match.reason,
        });
      }
    } else {
      // No high-confidence data binding found.
      // MISSING_CAPABILITY = atlas exists but no matching capability for this story.
      // These are NOT required — the Architect MAY author a manual case but synthesis
      // must not fire for a capability gap the atlas simply hasn't mapped yet.
      const isMissingCapability = !atlasBinding && capabilities.length > 0;
      const manifestItemId = itemId(['cov', story.id, 'standard']);
      items.push({
        manifestItemId,
        priority: 2,
        type: isMissingCapability ? ITEM_TYPES.MISSING_CAPABILITY : ITEM_TYPES.STANDARD,
        required: !existing.has(manifestItemId) && !isMissingCapability,
        advisory: isMissingCapability,
        confidence: 'none',
        storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
        dataSource: null,
        atlasBinding,
        requiredCoverage: { kind: 'story' },
        strategy: atlasBinding
          ? 'Generate a normal functional case from the requirement and atlas capability.'
          : 'Generate a normal functional case from the requirement; do not invent unavailable site capabilities.',
        score: medium[0] ? medium[0].score : 0,
      });
    }

    for (const match of medium.slice(0, 2)) {
      advisory.push({
        manifestItemId: itemId(['adv', story.id, match.binding.sheet]),
        priority: 3,
        type: ITEM_TYPES.DATA_BOUND,
        required: false,
        advisory: true,
        confidence: 'medium',
        storyRef: { id: story.id, title: story.title, source: story.source, moduleHint: story.moduleHint },
        dataSource: {
          sheet: match.binding.sheet,
          rows: Array.isArray(match.sheet && match.sheet.rows) ? match.sheet.rows.map((_, i) => i) : [],
          rowSelector: 'all',
          placeholders: Object.keys(match.binding.columnToField || {}),
          expectedToken: match.binding.expectedColumn ? 'expected' : null,
          expectedColumn: match.binding.expectedColumn || null,
          rowClassColumn: match.binding.rowClassColumn || null,
        },
        atlasBinding: bindAtlasCapability(story, capabilities),
        requiredCoverage: { kind: 'advisory' },
        strategy: 'Use this data binding only if it naturally fits the case; omission is logged, not blocked.',
        score: match.score,
        reason: match.reason,
      });
    }
  }

  items.push(...advisory);
  const required = items.filter((i) => i.required);
  return {
    version: VERSION,
    sourceMode: requirementClauses && requirementClauses.length ? 'requirement_clauses' : 'fallback_requirements',
    moduleScope: moduleScope || null,
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    requiredCount: required.length,
    advisoryCount: advisory.length,
    capabilityCount: capabilities.length,
    items,
  };
}

function renderCoveragePlanBlock(manifest) {
  if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) return null;
  const lines = [
    'COVERAGE PLAN CONTRACT - deterministic requirements/data/site coverage plan.',
    'Every generated case MUST include coverageRefs with manifest item ids from this list.',
    'Use ONLY the listed ids. Do not invent coverageRefs.',
    'Required DATA_BOUND items must use the declared dataBinding.sheet, row selector/group, and {{role}}/{{expected}} placeholders.',
    '{{expected}} is a TEXT value (heading, message, label). NEVER embed it inside a URL string. Wrong: "https://site.com{{expected}}". Right: assert that {{expected}} appears on the page.',
    'Never paste workbook cell values into steps, assertions, case names, or operations.',
    'Required STANDARD items must be covered even when no test data exists.',
    'EXPANSION/advisory items are optional and must not replace required coverage.',
    'MISSING_CAPABILITY items are advisory ONLY — they reflect a Site Atlas gap, NOT a test requirement. Skip them entirely. Do NOT generate manual cases for them.',
    '',
  ];
  // Only show required (STANDARD / DATA_BOUND) items to the Architect.
  // MISSING_CAPABILITY items are advisory and the Architect must skip them;
  // showing them only invites spurious manual case generation.
  const architectItems = manifest.items.filter((item) => item.required && item.type !== ITEM_TYPES.MISSING_CAPABILITY);
  for (const item of architectItems.slice(0, 50)) {
    const rows = item.dataSource && item.dataSource.rows;
    const rowSummary = Array.isArray(rows) && rows.length > 6
      ? `${rows.slice(0, 4).join(',')}…(${rows.length})`
      : (rows || []).join(',') || 'all';
    const data = item.dataSource
      ? ` sheet=${item.dataSource.sheet} rows=${rowSummary} placeholders=${(item.dataSource.placeholders || []).map((p) => `{{${p}}}`).join(',')}${item.dataSource.expectedToken ? ',{{expected}}' : ''}`
      : '';
    const atlas = item.atlasBinding ? ` atlas=${item.atlasBinding.name || item.atlasBinding.capabilityId || item.atlasBinding.type}` : '';
    lines.push(`- ${item.manifestItemId} [${item.required ? 'REQUIRED' : 'ADVISORY'} ${item.type} ${item.confidence || ''}] story=${item.storyRef && item.storyRef.id}: ${item.storyRef && item.storyRef.title || ''}${data}${atlas}`);
  }
  return lines.join('\n');
}

function caseCoverageRefs(caseObj) {
  const refs = new Set();
  for (const ref of (Array.isArray(caseObj && caseObj.coverageRefs) ? caseObj.coverageRefs : [])) {
    if (ref) refs.add(String(ref));
  }
  const ops = parseMaybe(caseObj && caseObj.operationsJson, null) || {};
  for (const ref of (Array.isArray(ops.coverageRefs) ? ops.coverageRefs : [])) {
    if (ref) refs.add(String(ref));
  }
  if (caseObj && caseObj.coverageRef) refs.add(String(caseObj.coverageRef));
  return Array.from(refs);
}

function allCaseText(caseObj) {
  return JSON.stringify({
    steps: caseObj && caseObj.steps,
    declaredAssertions: caseObj && caseObj.declaredAssertions,
    operations: caseObj && caseObj.operations,
    dataBinding: caseObj && caseObj.dataBinding,
  });
}

function workbookLiterals(testData) {
  const out = new Set();
  const sheets = sheetsFor(testData);
  const mapping = mappingFor(testData);
  const bySheet = new Map(sheets.map((s) => [s.name, s]));
  for (const binding of (Array.isArray(mapping.bindings) ? mapping.bindings : [])) {
    const sheet = bySheet.get(binding.sheet);
    if (!sheet || !Array.isArray(sheet.rows)) continue;
    const headers = [
      ...Object.values(binding.columnToField || {}),
      binding.expectedColumn,
      binding.rowClassColumn,
    ].filter(Boolean);
    for (const row of sheet.rows) {
      for (const header of headers) {
        const value = clean(row && row[header], 120);
        if (value.length >= 3 && !/^(positive|negative|valid|invalid|true|false|yes|no|n\/a)$/i.test(value)) {
          out.add(value);
        }
      }
    }
  }
  return Array.from(out);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function workbookLiteralReplacements(testData) {
  const replacements = [];
  const sheets = sheetsFor(testData);
  const mapping = mappingFor(testData);
  const bySheet = new Map(sheets.map((s) => [s.name, s]));
  const seen = new Set();
  const push = (literal, token, sheet, header) => {
    const value = clean(literal, 500);
    if (!value || value.length < 3) return;
    if (/^(positive|negative|valid|invalid|true|false|yes|no|n\/a)$/i.test(value)) return;
    const key = `${value}\u0000${token}`;
    if (seen.has(key)) return;
    seen.add(key);
    replacements.push({ literal: value, token, sheet, header });
  };
  for (const binding of (Array.isArray(mapping.bindings) ? mapping.bindings : [])) {
    const sheet = bySheet.get(binding.sheet);
    if (!sheet || !Array.isArray(sheet.rows)) continue;
    const roleToHeader = binding.columnToField && typeof binding.columnToField === 'object'
      ? binding.columnToField
      : {};
    for (const row of sheet.rows) {
      for (const [role, header] of Object.entries(roleToHeader)) {
        push(row && row[header], `{{${role}}}`, binding.sheet, header);
      }
      if (binding.expectedColumn) push(row && row[binding.expectedColumn], '{{expected}}', binding.sheet, binding.expectedColumn);
    }
  }
  return replacements.sort((a, b) => b.literal.length - a.literal.length);
}

// Literal→token rewriting is a SAFETY NET for credential/data values the Architect pasted into
// the INPUT it types — it must touch ONLY data-input slots. It must NEVER rewrite a label,
// element name, assertion expected-text, selector, URL, or prose, because UI labels legitimately
// equal data values: a menu module can literally be named "Admin", which also happens to be
// the admin row's username value. Rewriting element.name "Admin" → "{{username}}" (exact match)
// silently re-points a menu-visibility assertion at the login identity — the assertion then only
// passes for Admin by coincidence and is meaningless for every other role. So we scope the rewrite
// to the fill-input keys only; the Architect authors {{tokens}} everywhere else directly.
const DATA_INPUT_KEYS = new Set(['value', 'input']);

function replaceStringsDeep(value, replacements, counters, key = null) {
  if (typeof value === 'string') {
    // Only rewrite inside a data-input field; leave labels / names / expected-text / selectors /
    // URLs / prose exactly as authored.
    if (!key || !DATA_INPUT_KEYS.has(String(key).toLowerCase())) return value;
    let next = value;
    for (const { literal, token } of replacements) {
      if (!literal || !next.includes(literal)) continue;
      if (next === literal) {
        // Exact full-string match in a fill-input — safe to tokenize.
        next = token;
        counters.literalRewrites += 1;
        continue;
      }
      // Short literals (< 6 chars) are substrings of common words; only the exact-match above.
      if (literal.length < 6) continue;
      // Longer literals: word boundaries, and reject braces so we never rewrite inside an existing
      // {{...}} token (no "{{{{password}}}}" double-wrap).
      const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![a-zA-Z0-9{])${escaped}(?![a-zA-Z0-9}])`, 'g');
      const replaced = next.replace(re, token);
      if (replaced !== next) {
        next = replaced;
        counters.literalRewrites += 1;
      }
    }
    return next;
  }
  // Arrays inherit the parent key (e.g. a list under "value").
  if (Array.isArray(value)) return value.map((entry) => replaceStringsDeep(entry, replacements, counters, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, entry] of Object.entries(value)) out[k] = replaceStringsDeep(entry, replacements, counters, k);
    return out;
  }
  return value;
}

function parseOpsJson(caseObj) {
  const parsed = parseMaybe(caseObj && caseObj.operationsJson, null);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function writeOpsJson(caseObj, ops) {
  if (!caseObj || !ops || typeof ops !== 'object') return;
  caseObj.operationsJson = JSON.stringify(ops);
}

function repairCoveragePlanScenarios({ manifest, scenarios = [], testData = null } = {}) {
  const items = Array.isArray(manifest && manifest.items) ? manifest.items : [];
  const itemById = new Map(items.map((item) => [item.manifestItemId, item]));
  const replacements = workbookLiteralReplacements(testData);
  const repaired = cloneJson(Array.isArray(scenarios) ? scenarios : []) || [];
  const repairs = {
    invalidRefsRemoved: 0,
    dataBindingsRepaired: 0,
    literalRewrites: 0,
    missingCapabilitiesMarked: 0,
  };

  for (const scenario of repaired) {
    for (const c of (Array.isArray(scenario && scenario.cases) ? scenario.cases : [])) {
      const originalRefs = caseCoverageRefs(c);
      // Step 4 — NEVER let coverage repair override a STRONG binding the storyId-first
      // resolver set (matchKind storyId / coverageItem / module). Those are the
      // authoritative binds; a downstream "sheet exists → complete" repair must not
      // pollute them. Ref cleanup below is still safe; only the binding overwrites
      // are gated on !__strongBind.
      const __strongBind = !!(c.dataBinding && (c.dataBinding.matchKind === 'storyId' || c.dataBinding.matchKind === 'coverageItem' || c.dataBinding.matchKind === 'module'));
      const validRefs = originalRefs.filter((ref) => itemById.has(ref));
      const invalidCount = originalRefs.length - validRefs.length;
      if (invalidCount > 0) {
        repairs.invalidRefsRemoved += invalidCount;
        c.coverageRefs = validRefs;
        if (c.coverageRef && !itemById.has(String(c.coverageRef))) delete c.coverageRef;
        const ops = parseOpsJson(c);
        if (ops) {
          ops.coverageRefs = Array.isArray(ops.coverageRefs)
            ? ops.coverageRefs.filter((ref) => itemById.has(String(ref)))
            : [];
          writeOpsJson(c, ops);
        }
      }

      for (const ref of validRefs) {
        const item = itemById.get(ref);
        if (!item) continue;
        if (item.type === ITEM_TYPES.MISSING_CAPABILITY) {
          // MISSING_CAPABILITY items are purely advisory — never override the architect's
          // automatability classification. An atlas gap is an atlas problem, not an
          // automation gate. Just mark the disposition and move on.
          c.coverageDisposition = DISPOSITIONS.ADVISORY_USED;
          continue;
        }
        if (item.type !== ITEM_TYPES.DATA_BOUND || !item.dataSource || __strongBind) continue;
        const existing = c.dataBinding && typeof c.dataBinding === 'object' ? c.dataBinding : {};
        const expectedSelector = item.dataSource.rowSelector || 'all';
        const needsRepair = existing.sheet !== item.dataSource.sheet
          || existing.rowSelector !== expectedSelector
          || existing.status === 'incomplete';
        if (!needsRepair) continue;
        c.dataBinding = {
          ...existing,
          sheet: item.dataSource.sheet,
          rowSelector: expectedSelector,
          expectedColumn: item.dataSource.expectedColumn || existing.expectedColumn || undefined,
          rowClassColumn: item.dataSource.rowClassColumn || existing.rowClassColumn || undefined,
          placeholders: item.dataSource.placeholders || existing.placeholders || [],
          status: 'complete',
          findings: clearResolvedFindings(existing.findings),
          repairedBy: 'coverage_planner',
        };
        c.coverageDisposition = item.advisory ? DISPOSITIONS.ADVISORY_USED : DISPOSITIONS.COVERED;
        // Wire requirementRef so storyDataAlignment doesn't mark this incomplete.
        if (item.storyRef && item.storyRef.id) {
          const sid = String(item.storyRef.id);
          const existingReqs = Array.isArray(c.requirementRefs) ? c.requirementRefs : [];
          if (!existingReqs.includes(sid)) c.requirementRefs = [...existingReqs, sid];
        }
        repairs.dataBindingsRepaired += 1;
      }

      // Sheet-match fallback: Architect authored a dataBinding.sheet but omitted coverageRefs,
      // so the validRefs loop above never ran the repair. Uses normSheet (strips spaces/camelCase)
      // so "RoleAccessControl" matches "Role Access Control" in the manifest.
      if (c.dataBinding && c.dataBinding.sheet && c.dataBinding.status !== 'complete' && !__strongBind) {
        const sheetKey = normSheet(c.dataBinding.sheet);
        const matchItem = Array.from(itemById.values()).find(
          (mi) => mi.type === ITEM_TYPES.DATA_BOUND && mi.dataSource
            && normSheet(mi.dataSource.sheet || '') === sheetKey,
        );
        if (matchItem) {
          const ex2 = c.dataBinding;
          c.dataBinding = {
            ...ex2,
            sheet: matchItem.dataSource.sheet,
            rowSelector: matchItem.dataSource.rowSelector || ex2.rowSelector || 'all',
            expectedColumn: matchItem.dataSource.expectedColumn || ex2.expectedColumn || undefined,
            rowClassColumn: matchItem.dataSource.rowClassColumn || ex2.rowClassColumn || undefined,
            placeholders: matchItem.dataSource.placeholders || ex2.placeholders || [],
            status: 'complete',
            findings: clearResolvedFindings(ex2.findings),
            repairedBy: 'coverage_planner_sheet_match',
          };
          c.coverageDisposition = c.coverageDisposition || (matchItem.advisory ? DISPOSITIONS.ADVISORY_USED : DISPOSITIONS.COVERED);
          if (matchItem.storyRef && matchItem.storyRef.id) {
            const sid2 = String(matchItem.storyRef.id);
            const existingReqs2 = Array.isArray(c.requirementRefs) ? c.requirementRefs : [];
            if (!existingReqs2.includes(sid2)) c.requirementRefs = [...existingReqs2, sid2];
          }
          repairs.dataBindingsRepaired += 1;
        }
      }

      // Nuclear fallback: manifest had no DATA_BOUND item for this sheet name, but the sheet
      // EXISTS in the uploaded test data. The architect referenced a real sheet — mark complete.
      // This catches naming mismatches between manifest and architect output (e.g. manifest built
      // with slightly different sheet name casing than what the architect wrote).
      if (c.dataBinding && c.dataBinding.sheet && c.dataBinding.status !== 'complete' && testData && !__strongBind) {
        const sheetKey = normSheet(c.dataBinding.sheet);
        const allSheets = sheetsFor(testData);
        const matchedSheet = allSheets.find((s) => normSheet(s.name || '') === sheetKey);
        if (matchedSheet) {
          // Step 4 / Fix 4 — a sheet merely EXISTING does NOT prove the case belongs to
          // it. No coverage item / storyId / mapping confirmed this bind, so it must NOT
          // be marked complete AND it must NOT be a data-driven binding the compiler
          // hard-blocks as data_binding_incomplete. It is a provisional NEEDS_REVIEW
          // bind (surfaced, never silently certified, never blocked): matchKind
          // needs_review + the data_binding_sheet_exists_only defect, and NO
          // status:'incomplete' (that value is what triggered the data_binding_incomplete
          // block). A human confirms the sheet before approval; the CaseCompiler treats
          // this provisional state as needs_review, not blocked.
          c.dataBinding = {
            ...c.dataBinding,
            sheet: matchedSheet.name,
            matchKind: c.dataBinding.matchKind || 'needs_review',
            needsReview: true,
            findings: [
              ...((Array.isArray(c.dataBinding.findings) ? c.dataBinding.findings : []).filter((f) => f && f.code !== 'data_binding_sheet_not_found')),
              { code: 'data_binding_sheet_exists_only', severity: 'warning', detail: 'bound only because a sheet with this name exists — no coverage item, storyId, or mapping confirms it. Review before approval.' },
            ],
            repairedBy: 'coverage_planner_sheet_exists',
          };
          delete c.dataBinding.status; // never leave a stale 'incomplete'/'complete' — this is provisional needs_review
          c.coverageDisposition = c.coverageDisposition || DISPOSITIONS.NEEDS_REVIEW || 'needs_review';
          repairs.dataBindingsRepaired += 1;
        }
      }

      // Safety-net: reclassify cases marked manual for infra/tooling reasons rather than
      // genuine human-only constraints. Atlas gaps, credential gaps, fixture gaps are all
      // system concerns — not a reason to exclude a test from automation.
      // Genuine manual cases describe physical channels, subjective opinions, org-gate approvals,
      // or hardware I/O that Playwright cannot exercise.
      if (c.automatability === 'manual' && c.automatabilityReason) {
        const reason = String(c.automatabilityReason).toLowerCase();
        const isInvalidManualReason =
          reason.includes('site atlas') || reason.includes('atlas capability')
          || reason.includes('atlas gap') || reason.includes('not confirmed in')
          || reason.includes('coverage item')
          || reason.includes('credential') || reason.includes('not configured')
          || reason.includes('fixture') || reason.includes('not set up')
          || reason.includes('not available') || reason.includes('access control')
          || reason.includes('role') || reason.includes('permission');
        if (isInvalidManualReason) {
          c.automatability = 'automatable';
          delete c.automatabilityReason;
          c.coverageDisposition = c.coverageDisposition || DISPOSITIONS.COVERED;
        }
      }

      const refsAfterRepair = caseCoverageRefs(c);
      const hasDataBoundRef = refsAfterRepair.some((ref) => {
        const item = itemById.get(ref);
        return item && item.type === ITEM_TYPES.DATA_BOUND;
      });
      if ((hasDataBoundRef || (c.dataBinding && c.dataBinding.sheet)) && replacements.length) {
        const counters = { literalRewrites: 0 };
        const nextCase = replaceStringsDeep(c, replacements, counters);
        Object.assign(c, nextCase);
        repairs.literalRewrites += counters.literalRewrites;
      }

      // Sanitize token corruptions: remove {{tokens}} that are embedded mid-word or
      // fused to URLs — these are authoring defects, not data bindings.
      if (c.name) c.name = sanitizeTokenCorruptions(c.name);
      if (c.description) c.description = sanitizeTokenCorruptions(c.description);
      if (Array.isArray(c.steps)) {
        c.steps = c.steps.map((step) => {
          if (!step || typeof step !== 'object') return step;
          const s = { ...step };
          if (s.description) s.description = sanitizeTokenCorruptions(s.description);
          if (s.element) s.element = sanitizeTokenCorruptions(s.element);
          if (s.value) s.value = sanitizeTokenCorruptions(s.value);
          if (s.verify) s.verify = sanitizeTokenCorruptions(s.verify);
          if (s.check) s.check = sanitizeTokenCorruptions(s.check);
          return s;
        });
      }
      if (Array.isArray(c.declaredAssertions)) {
        c.declaredAssertions = c.declaredAssertions.map((a) => {
          if (!a || typeof a !== 'object') return a;
          const da = { ...a };
          if (da.expectedText) da.expectedText = sanitizeTokenCorruptions(da.expectedText);
          if (da.description) da.description = sanitizeTokenCorruptions(da.description);
          return da;
        });
      }
    }
  }

  return { scenarios: repaired, repairs };
}

function validateCoveragePlan({ manifest, scenarios = [], testData = null, onLog = null, collector = null } = {}) {
  const items = Array.isArray(manifest && manifest.items) ? manifest.items : [];
  const itemById = new Map(items.map((item) => [item.manifestItemId, item]));
  const required = items.filter((item) => item.required);
  const advisory = items.filter((item) => item.advisory);
  const covered = new Set();
  const advisoryUsed = new Set();
  const cases = [];

  // Quality hints — collected for internal reporting only, never affect ok/findings.
  const qualityHints = { invalidRefs: [], literalLeaks: [], missingBindings: [], wrongBindings: [], rowUndercoverage: [] };
  const literals = workbookLiterals(testData);

  // #22 — per-row coverage accounting. Coverage was tracked at clause/story level
  // only: a DATA_BOUND item whose contract is requiredCoverage.kind === 'all_rows'
  // was counted "fully covered" even when the case bound rowSelector='negative'
  // (or 'positive'), exercising a SUBSET of the sheet's rows. Track, per all_rows
  // item, whether ANY covering case actually binds the full row set; if every
  // covering case is a partial-row selector, surface it (the requirement implied
  // all rows matter but only some are exercised). Keyed off the manifest's declared
  // requiredCoverage shape + the case's rowSelector — never a site-specific value.
  const allRowsItems = new Set(
    items.filter((it) => it.type === ITEM_TYPES.DATA_BOUND
      && it.requiredCoverage && it.requiredCoverage.kind === 'all_rows'
      && Number(it.requiredCoverage.rowCount) > 1)
      .map((it) => it.manifestItemId),
  );
  const itemHasFullRowCase = new Set();   // all_rows item ids that got at least one full-row case
  const itemHasPartialRowCase = new Map(); // id -> sample partial selector (for the finding)

  for (const scenario of (Array.isArray(scenarios) ? scenarios : [])) {
    for (const c of (Array.isArray(scenario && scenario.cases) ? scenario.cases : [])) {
      const refs = caseCoverageRefs(c);
      cases.push({ scenarioName: scenario && scenario.name, caseName: c && c.name, coverageRefs: refs });
      for (const ref of refs) {
        const item = itemById.get(ref);
        if (!item) {
          qualityHints.invalidRefs.push({ ref, caseName: c && c.name });
          continue;
        }
        if (item.advisory) advisoryUsed.add(ref);
        else covered.add(ref);
        if (item.type === ITEM_TYPES.DATA_BOUND && item.dataSource) {
          const binding = c && c.dataBinding && typeof c.dataBinding === 'object' ? c.dataBinding : null;
          const sheet = binding && binding.sheet;
          const rowSelector = binding && binding.rowSelector;
          if (!sheet) {
            qualityHints.missingBindings.push({ ref, caseName: c && c.name, expectedSheet: item.dataSource.sheet });
          } else if (sheet !== item.dataSource.sheet) {
            qualityHints.wrongBindings.push({ ref, caseName: c && c.name, expectedSheet: item.dataSource.sheet, actualSheet: sheet });
          }
          if (item.dataSource.rowSelector && item.dataSource.rowSelector !== 'all' && rowSelector !== item.dataSource.rowSelector) {
            qualityHints.wrongBindings.push({
              ref, caseName: c && c.name,
              expectedRowSelector: item.dataSource.rowSelector,
              actualRowSelector: rowSelector || null,
            });
          }
          // #22 — record whether this covering case exercises the FULL row set or a
          // subset, for items whose contract is all_rows. Absent/blank selector or
          // an explicit 'all' = full coverage; 'negative'/'positive'/any subset key
          // = partial. (A run-time fan-out over a row-class column still only feeds
          // the rows that match that class, so a class selector is partial here.)
          if (allRowsItems.has(ref)) {
            const sel = String(rowSelector || 'all').toLowerCase();
            if (!sel || sel === 'all') itemHasFullRowCase.add(ref);
            else if (!itemHasPartialRowCase.has(ref)) itemHasPartialRowCase.set(ref, sel);
          }
        }
      }
      const hasDataBoundRef = refs.some((ref) => {
        const item = itemById.get(ref);
        return item && item.type === ITEM_TYPES.DATA_BOUND;
      });
      if (hasDataBoundRef || (c && c.dataBinding && c.dataBinding.sheet)) {
        const hay = allCaseText(c);
        for (const literal of literals) {
          if (literal && hay.includes(literal)) {
            qualityHints.literalLeaks.push({ caseName: c && c.name, literal: literal.slice(0, 80) });
            break;
          }
        }
      }
    }
  }

  // Story-match fallback: the Architect often writes high-quality cases but omits
  // the exact manifest item ID in coverageRefs. Before declaring an item "missing"
  // and triggering synthesis, check whether any Architect case's name+assertions
  // clearly covers the same story by keyword overlap (≥50% of the story title words
  // appear in the case text). This bridges the ID-copy gap without loosening coverage.
  const allCasesFlat = (Array.isArray(scenarios) ? scenarios : []).flatMap(
    (s) => Array.isArray(s && s.cases) ? s.cases : [],
  );
  qualityHints.storyMatchFallbacks = [];
  for (const item of required) {
    if (covered.has(item.manifestItemId)) continue;
    if (!item.storyRef || !item.storyRef.title) continue;
    const storyWords = tokens(item.storyRef.title);
    if (storyWords.length < 2) continue;
    const threshold = Math.max(2, Math.ceil(storyWords.length * 0.5));
    for (const c of allCasesFlat) {
      const caseText = `${c && c.name || ''} ${c && c.assertions || ''}`.toLowerCase();
      const matchCount = storyWords.filter((w) => caseText.includes(w)).length;
      if (matchCount >= threshold) {
        covered.add(item.manifestItemId);
        qualityHints.storyMatchFallbacks.push({ manifestItemId: item.manifestItemId, matchedCase: c && c.name });
        break;
      }
    }
  }

  // #22 — emit a per-row under-coverage signal for all_rows items that were
  // "covered" (clause-level) but never bound by a full-row case. This is a quality
  // WARNING, not a coverage error: the requirement is referenced, but only a subset
  // of the rows the sheet supplies is exercised, so a reviewer should confirm the
  // omitted rows (e.g. the positive cases when only negatives were bound) don't matter.
  for (const ref of allRowsItems) {
    if (!covered.has(ref)) continue;            // genuine miss is handled by coverage_required_missing
    if (itemHasFullRowCase.has(ref)) continue;  // at least one case binds the full row set — fine
    if (!itemHasPartialRowCase.has(ref)) continue;
    const item = itemById.get(ref);
    const rowCount = item && item.requiredCoverage ? Number(item.requiredCoverage.rowCount) : null;
    const partialSel = itemHasPartialRowCase.get(ref);
    qualityHints.rowUndercoverage.push({
      manifestItemId: ref,
      sheet: item && item.dataSource ? item.dataSource.sheet : null,
      rowCount,
      boundSelector: partialSel,
      story: item && item.storyRef ? item.storyRef.id : null,
    });
    recordDegradation({
      onLog,
      collector,
      stage: 'coverage-planner',
      severity: 'warning',
      code: 'coverage_partial_row_coverage',
      reason: `Data-bound coverage for ${ref} (sheet "${item && item.dataSource ? item.dataSource.sheet : '?'}", ${rowCount || '?'} rows) is exercised only by a '${partialSel}' row subset.`,
      impact: 'Rows outside that subset are not run though the requirement implies all rows matter — confirm the omitted rows are intentionally out of scope.',
    });
  }

  // Only coverage completeness affects ok — the Architect cannot reliably produce
  // exact manifest IDs or binding contracts; synthesis handles genuine gaps deterministically.
  const missingRequired = required.filter((item) => !covered.has(item.manifestItemId));
  const missingCapability = required.filter((item) => item.type === ITEM_TYPES.MISSING_CAPABILITY && !covered.has(item.manifestItemId));
  const findings = [];
  for (const item of missingRequired) findings.push({ severity: 'error', code: 'coverage_required_missing', manifestItemId: item.manifestItemId, type: item.type });

  const summary = {
    required: required.length,
    covered: required.length - missingRequired.length,
    repaired: 0,
    needsReview: 0,
    missingCapability: missingCapability.length,
  };

  return {
    ok: !findings.some((f) => f.severity === 'error'),
    summary,
    missingRequired,
    advisoryOmitted: advisory.filter((item) => !advisoryUsed.has(item.manifestItemId)),
    cases,
    findings,
    qualityHints,
  };
}

function buildAppendOnlyRepairPrompt({ manifest, acceptedRegistry = [], missingItems = [] } = {}) {
  const items = Array.isArray(missingItems) ? missingItems : [];
  return [
    'You are repairing missing QAAI scenario coverage.',
    'Accepted scenarios are frozen. Do not rewrite, rename, delete, merge, or improve them.',
    '',
    'Accepted registry:',
    JSON.stringify(acceptedRegistry || [], null, 2),
    '',
    'Generate ONLY new scenarios/cases for these missing manifest items:',
    JSON.stringify(items, null, 2),
    '',
    'Rules:',
    '- Return JSON array only.',
    '- Every new case must cite coverageRefs from the missing items only.',
    '- Use placeholders for data-bound values.',
    '- Do not paste workbook values.',
    '- Do not include accepted scenarios or cases.',
    '',
    'Full manifest summary:',
    JSON.stringify({ version: manifest && manifest.version, moduleScope: manifest && manifest.moduleScope }, null, 2),
  ].join('\n');
}

function synthesizeCaseForItem(item) {
  const storyTitle = item && item.storyRef && item.storyRef.title ? item.storyRef.title : item.manifestItemId;
  const refs = [item.manifestItemId];
  const base = {
    name: `${storyTitle} - coverage placeholder`,
    type: 'functional',
    confidence: 70,
    assertions: item.type === ITEM_TYPES.MISSING_CAPABILITY
      ? 'Manual review required: no verified Site Atlas capability was available for this required story.'
      : `Verify ${storyTitle}.`,
    coverageRefs: refs,
    coverageDisposition: item.type === ITEM_TYPES.MISSING_CAPABILITY ? DISPOSITIONS.NEEDS_REVIEW : DISPOSITIONS.COVERED,
    automatability: item.type === ITEM_TYPES.MISSING_CAPABILITY ? 'manual' : 'automatable',
    automatabilityReason: item.type === ITEM_TYPES.MISSING_CAPABILITY ? 'No verified Site Atlas capability for this required coverage item.' : undefined,
    declaredAssertions: [{
      type: 'TEXT',
      criticality: 'must',
      provenance: 'requirement',
      payload: { expectedText: item && item.dataSource && item.dataSource.expectedToken ? '{{expected}}' : storyTitle },
      requirementRefs: item && item.storyRef && item.storyRef.id ? [item.storyRef.id] : [],
    }],
    steps: item.type === ITEM_TYPES.MISSING_CAPABILITY
      ? [{ order: 1, action: 'human_input', element: storyTitle, value: 'Verify this coverage item manually or re-run atlas discovery.' }]
      : [{ order: 1, action: 'Verify', element: storyTitle, expected: item && item.dataSource && item.dataSource.expectedToken ? '{{expected}}' : storyTitle }],
  };
  if (item && item.type === ITEM_TYPES.DATA_BOUND && item.dataSource) {
    base.dataBinding = {
      sheet: item.dataSource.sheet,
      rowSelector: item.dataSource.rowSelector || 'all',
      expectedColumn: item.dataSource.expectedColumn || undefined,
      rowClassColumn: item.dataSource.rowClassColumn || undefined,
    };
    base.steps = (item.dataSource.placeholders || []).map((role, i) => ({
      order: i + 1,
      action: 'Type',
      element: role,
      value: `{{${role}}}`,
    }));
    base.steps.push({ order: base.steps.length + 1, action: 'Verify', element: 'Expected outcome', expected: '{{expected}}' });
  }
  return base;
}

// Distribute synthesized cases into the closest matching existing scenario rather
// than dumping all of them into a single giant "Coverage" scenario. Cases whose
// module doesn't match any existing scenario are grouped into compact new scenarios
// keyed by module. Returns { newScenarios, injections } where injections is an
// array of { scenarioName, cases } to be appended to existing scenarios by the caller.
function synthesizeMissingCoverage({ missingItems = [], existingScenarios = [] } = {}) {
  // Build a lookup of existing scenario names by normalized module key.
  const scenarioByModule = new Map();
  for (const s of Array.isArray(existingScenarios) ? existingScenarios : []) {
    const key = normalizeModuleKey(s && (s.module || s.name || ''));
    if (key && !scenarioByModule.has(key)) scenarioByModule.set(key, s.name || key);
  }

  const byModule = new Map();
  for (const item of missingItems || []) {
    const module = clean(item && item.storyRef && item.storyRef.moduleHint) || 'Coverage';
    if (!byModule.has(module)) byModule.set(module, []);
    byModule.get(module).push(item);
  }

  const newScenarios = [];
  const injections = [];

  for (const [module, items] of byModule.entries()) {
    const moduleKey = normalizeModuleKey(module);
    const targetName = scenarioByModule.get(moduleKey);
    if (targetName) {
      // Inject synthesized cases into the matching existing scenario.
      injections.push({ scenarioName: targetName, cases: items.map(synthesizeCaseForItem) });
    } else {
      newScenarios.push({
        name: `${module} - coverage completion`,
        module,
        priority: 'P1',
        category: 'functional',
        rationale: 'Synthesized to satisfy required CoveragePlanManifest items the Architect did not cover.',
        dependencyOn: [],
        cases: items.map(synthesizeCaseForItem),
      });
    }
  }

  return { newScenarios, injections };
}

function coverageSummary(validation, repair = null) {
  const summary = {
    required: validation && validation.summary ? validation.summary.required : 0,
    covered: validation && validation.summary ? validation.summary.covered : 0,
    repaired: repair && Number.isFinite(Number(repair.repaired)) ? Number(repair.repaired) : 0,
    needsReview: validation && validation.summary ? validation.summary.needsReview : 0,
    missingCapability: validation && validation.summary ? validation.summary.missingCapability : 0,
  };
  return summary;
}

module.exports = {
  VERSION,
  ITEM_TYPES,
  DISPOSITIONS,
  SECURITY_TERMS,
  VALIDATION_TERMS,
  buildCoveragePlanManifest,
  renderCoveragePlanBlock,
  validateCoveragePlan,
  buildAppendOnlyRepairPrompt,
  synthesizeMissingCoverage,
  repairCoveragePlanScenarios,
  coverageSummary,
  caseCoverageRefs,
};
