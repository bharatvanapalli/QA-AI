'use strict';

/**
 * StoryDataAlignmentPlanV1
 *
 * Deterministically aligns immutable requirement/story identities to immutable
 * DatasetContractV1 row groups.  It is deliberately a planning contract: it
 * never reads workbook cell values, never invents an oracle, and never resolves
 * an equal/low-confidence match by taking the first candidate.
 */

const { normalizeStoryId } = require('../lib/storyId');
const {
  SCHEMA_VERSION: DATASET_SCHEMA_VERSION,
  canonicalHash,
  stableId,
} = require('./datasetContractV1');

const SCHEMA_VERSION = 'story-data-alignment-plan-v1';
const DEFAULT_THRESHOLDS = Object.freeze({
  select: 0.55,
  ambiguous: 0.28,
  margin: 0.15,
});

const AUTH_ROLE_RE = /^(username|user(name)?|email|login(id)?|password|pass(word)?|pwd|secret|credential|token|otp|pin)$/i;
const CREDENTIAL_ROLE_RE = /(password|pass(word)?|pwd|secret|credential|token|otp|pin)/i;
const USER_ROLE_RE = /(username|user(name)?|email|login(id)?|account(name)?)/i;
const SUPPORT_PURPOSES = new Set(['auth_profiles', 'reference_data', 'unknown']);
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'has',
  'have', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'should', 'that', 'the',
  'their', 'then', 'this', 'to', 'user', 'users', 'when', 'where', 'with',
]);

function clean(value, max = 260) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalized(value) {
  return clean(value, 600).normalize('NFKC').toLocaleLowerCase('en-US');
}

function roundScore(value) {
  return Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 10000) / 10000;
}

function thresholdsFrom(value) {
  const source = value && typeof value === 'object' ? value : {};
  const select = Number.isFinite(Number(source.select)) ? Number(source.select) : DEFAULT_THRESHOLDS.select;
  const ambiguous = Number.isFinite(Number(source.ambiguous)) ? Number(source.ambiguous) : DEFAULT_THRESHOLDS.ambiguous;
  const margin = Number.isFinite(Number(source.margin)) ? Number(source.margin) : DEFAULT_THRESHOLDS.margin;
  if (select <= 0 || select > 1) throw new Error('Alignment select threshold must be in (0, 1].');
  if (ambiguous < 0 || ambiguous >= select) throw new Error('Alignment ambiguous threshold must be >= 0 and below select.');
  if (margin < 0 || margin > 1) throw new Error('Alignment margin threshold must be in [0, 1].');
  return { select: roundScore(select), ambiguous: roundScore(ambiguous), margin: roundScore(margin) };
}

function tokens(value) {
  const parts = normalized(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return Array.from(new Set(parts)).sort();
}

function cosineTokens(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.sqrt(a.size * b.size);
}

function clauseIdOf(clause, ordinal) {
  return clean(
    clause && (clause.clauseId || clause.requirementClauseId || clause.id || clause.requirementId),
    180,
  ) || stableId('clause', [ordinal, canonicalHash(clause || {})]);
}

function moduleOf(value) {
  if (!value || typeof value !== 'object') return null;
  const moduleValue = value.module || value.moduleKey || value.moduleHint || value.feature || value.area;
  return clean(moduleValue, 180) || null;
}

function storyTextOf(clause) {
  if (!clause || typeof clause !== 'object') return '';
  return [
    clause.title,
    clause.name,
    clause.behaviourText,
    clause.behaviorText,
    clause.excerpt,
    clause.text,
    clause.description,
    clause.module,
    clause.moduleHint,
    clause.feature,
    clause.sourceType,
  ].map((part) => clean(part, 4000)).filter(Boolean).join(' ');
}

function normalizeRequirementUnits(clauses) {
  const byKey = new Map();
  (Array.isArray(clauses) ? clauses : []).forEach((clause, ordinal) => {
    const clauseId = clauseIdOf(clause, ordinal);
    const storyId = normalizeStoryId(clause && (clause.storyId || clause.userStoryId || clause.storyKey));
    const key = storyId ? `story:${storyId}` : `clause:${clauseId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        requirementUnitId: stableId('requirement-unit', [key]),
        storyId: storyId || null,
        clauseIds: [],
        modules: [],
        textParts: [],
      });
    }
    const unit = byKey.get(key);
    unit.clauseIds.push(clauseId);
    const moduleName = moduleOf(clause);
    if (moduleName) unit.modules.push(moduleName);
    const text = storyTextOf(clause);
    if (text) unit.textParts.push(text);
  });

  return Array.from(byKey.values()).map((unit) => {
    const modules = Array.from(new Set(unit.modules.map(normalized).filter(Boolean))).sort();
    return {
      requirementUnitId: unit.requirementUnitId,
      storyId: unit.storyId,
      clauseIds: Array.from(new Set(unit.clauseIds)),
      module: modules.length === 1 ? unit.modules.find((value) => normalized(value) === modules[0]) : null,
      moduleConflict: modules.length > 1,
      _text: unit.textParts.join(' '),
    };
  });
}

function datasetsOf(catalogOrContracts) {
  if (Array.isArray(catalogOrContracts)) return catalogOrContracts;
  if (!catalogOrContracts) return [];
  if (catalogOrContracts.schemaVersion === DATASET_SCHEMA_VERSION) return [catalogOrContracts];
  return Array.isArray(catalogOrContracts.datasets) ? catalogOrContracts.datasets : [];
}

function mappedRoles(sheet) {
  return Array.from(new Set((sheet.columns || []).flatMap((column) => (
    Array.isArray(column.mappedRoles) && column.mappedRoles.length
      ? column.mappedRoles
      : [column.normalizedHeader || column.header]
  )).map(normalized).filter(Boolean))).sort();
}

function authSupportReason(sheet) {
  if (normalized(sheet.purpose) === 'auth profiles' || normalized(sheet.purpose) === 'auth_profiles') return 'auth_profile';
  const roles = mappedRoles(sheet);
  const hasUser = roles.some((role) => USER_ROLE_RE.test(role));
  const hasSecret = roles.some((role) => CREDENTIAL_ROLE_RE.test(role));
  if (hasUser && hasSecret && !(sheet.rowGroups || []).some((group) => (group.oracleSignature || []).length)) return 'auth_profile';
  return null;
}

function safeBindingRef(bindingRef) {
  if (!bindingRef || typeof bindingRef !== 'object') return null;
  return {
    bindingId: bindingRef.bindingId || null,
    mappingId: bindingRef.mappingId || null,
    mappingVersion: bindingRef.mappingVersion == null ? null : bindingRef.mappingVersion,
    status: bindingRef.status || null,
  };
}

function flattenRowGroups(datasets) {
  const refs = [];
  for (const dataset of datasets) {
    for (const sheet of (Array.isArray(dataset && dataset.sheets) ? dataset.sheets : [])) {
      const sheetRoles = mappedRoles(sheet);
      const columnHeaders = (sheet.columns || []).map((column) => clean(column.header, 240));
      const authReason = authSupportReason(sheet);
      for (const group of (Array.isArray(sheet.rowGroups) ? sheet.rowGroups : [])) {
        const hasOracle = Array.isArray(group.oracleSignature) && group.oracleSignature.length > 0;
        let supportReason = authReason;
        if (!supportReason && !hasOracle && SUPPORT_PURPOSES.has(normalized(sheet.purpose).replace(/ /g, '_'))) {
          supportReason = 'no_oracle_reference';
        } else if (!supportReason && !hasOracle) {
          supportReason = 'no_oracle';
        }
        refs.push({
          datasetId: dataset.datasetId,
          datasetRevisionId: dataset.datasetRevisionId,
          contractId: dataset.contractId || null,
          sheetId: sheet.sheetId,
          sheetName: sheet.name,
          purpose: sheet.purpose || 'unknown',
          module: sheet.module || null,
          bindingRef: safeBindingRef(sheet.bindingRef),
          columnHeaders,
          mappedRoles: sheetRoles,
          rowGroupId: group.rowGroupId,
          groupHash: group.groupHash,
          storyId: normalizeStoryId(group.storyId),
          intentClass: group.intentClass || null,
          oracleSignature: Array.isArray(group.oracleSignature) ? [...group.oracleSignature] : [],
          inputRoleSignature: Array.isArray(group.inputRoleSignature) ? [...group.inputRoleSignature] : [],
          rowIds: Array.isArray(group.rowIds) ? [...group.rowIds] : [],
          rowCount: Number(group.rowCount) || (Array.isArray(group.rowIds) ? group.rowIds.length : 0),
          hasOracle,
          supportReason,
        });
      }
    }
  }
  return refs.sort((a, b) => [a.datasetRevisionId, a.sheetId, a.rowGroupId].join('|')
    .localeCompare([b.datasetRevisionId, b.sheetId, b.rowGroupId].join('|')));
}

function sameModule(left, right) {
  const a = normalized(left);
  const b = normalized(right);
  return !a || !b || a === b;
}

function scoreSheetStory(unit, ref) {
  const storyTokens = tokens(`${unit._text || ''} ${unit.module || ''}`);
  const sheetTokens = tokens([
    ref.sheetName,
    ref.purpose,
    ref.module,
    ...ref.columnHeaders,
    ...ref.mappedRoles,
    ...ref.inputRoleSignature,
    ref.intentClass,
  ].filter(Boolean).join(' '));
  const base = cosineTokens(storyTokens, sheetTokens);
  const sheetNameTokens = tokens(ref.sheetName);
  const moduleExact = normalized(unit.module) && normalized(unit.module) === normalized(ref.module) ? 0.25 : 0;
  const nameCovered = sheetNameTokens.length && sheetNameTokens.every((token) => storyTokens.includes(token)) ? 0.2 : 0;
  const purposeOverlap = cosineTokens(storyTokens, tokens(ref.purpose)) > 0 ? 0.1 : 0;
  const roleOverlap = cosineTokens(storyTokens, [...ref.mappedRoles, ...ref.inputRoleSignature]) > 0 ? 0.1 : 0;
  return roundScore((base * 0.55) + moduleExact + nameCovered + purposeOverlap + roleOverlap);
}

function publicRef(ref, extra = {}) {
  return {
    datasetId: ref.datasetId,
    datasetRevisionId: ref.datasetRevisionId,
    sheetId: ref.sheetId,
    sheetName: ref.sheetName,
    rowGroupId: ref.rowGroupId,
    rowIds: [...ref.rowIds],
    bindingRef: ref.bindingRef,
    intentClass: ref.intentClass,
    oracleSignature: [...ref.oracleSignature],
    ...extra,
  };
}

function supportRef(ref) {
  return publicRef(ref, {
    supportReason: ref.supportReason,
    scenarioDriving: false,
  });
}

function conflict(code, refs, detail = {}) {
  const normalizedRefs = (Array.isArray(refs) ? refs : []).map((ref) => ({
    datasetId: ref.datasetId || null,
    datasetRevisionId: ref.datasetRevisionId || null,
    sheetId: ref.sheetId || null,
    rowGroupId: ref.rowGroupId || null,
    storyId: ref.storyId || null,
  }));
  return {
    conflictId: stableId('alignment-conflict', [code, normalizedRefs, detail]),
    code,
    refs: normalizedRefs,
    ...detail,
  };
}

function duplicateRevisionConflicts(refs) {
  const byHash = new Map();
  for (const ref of refs) {
    if (!ref.groupHash) continue;
    if (!byHash.has(ref.groupHash)) byHash.set(ref.groupHash, []);
    byHash.get(ref.groupHash).push(ref);
  }
  const duplicates = [];
  const blocked = new Set();
  for (const candidates of byHash.values()) {
    const revisions = new Set(candidates.map((ref) => ref.datasetRevisionId));
    if (revisions.size < 2) continue;
    candidates.forEach((ref) => blocked.add(ref.rowGroupId));
    duplicates.push(conflict('ambiguous_duplicate_source_revision', candidates, {
      groupHash: candidates[0].groupHash,
    }));
  }
  return { duplicates, blocked };
}

function semanticSheetCandidates(unit, refs) {
  const bySheet = new Map();
  for (const ref of refs) {
    if (ref.storyId || ref.supportReason || !sameModule(unit.module, ref.module)) continue;
    const key = `${ref.datasetRevisionId}|${ref.sheetId}`;
    if (!bySheet.has(key)) bySheet.set(key, { key, refs: [], score: scoreSheetStory(unit, ref) });
    bySheet.get(key).refs.push(ref);
  }
  return Array.from(bySheet.values()).sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

function alignmentCore(unit) {
  return {
    alignmentId: stableId('story-alignment', [unit.requirementUnitId, unit.storyId, unit.clauseIds]),
    requirementUnitId: unit.requirementUnitId,
    storyId: unit.storyId,
    clauseIds: [...unit.clauseIds],
    module: unit.module,
    status: 'unmapped',
    selected: [],
    candidates: [],
    conflictIds: [],
    decision: {
      rule: 'none',
      topScore: null,
      margin: null,
      reason: 'no eligible data source',
    },
  };
}

function alignUnit(unit, allRefs, thresholds, globalConflicts) {
  const alignment = alignmentCore(unit);
  if (unit.moduleConflict) {
    const item = conflict('requirement_module_conflict', [], {
      requirementUnitId: unit.requirementUnitId,
      storyId: unit.storyId,
    });
    globalConflicts.push(item);
    alignment.status = 'conflict';
    alignment.conflictIds.push(item.conflictId);
    alignment.decision = { rule: 'module_conflict', topScore: null, margin: null, reason: 'clauses for the same story declare different modules' };
    return alignment;
  }

  const explicitAll = unit.storyId ? allRefs.filter((ref) => ref.storyId === unit.storyId) : [];
  const explicitEligible = [];
  for (const ref of explicitAll) {
    if (!sameModule(unit.module, ref.module)) {
      const item = conflict('explicit_story_cross_module', [ref], {
        requirementUnitId: unit.requirementUnitId,
        storyId: unit.storyId,
        requirementModule: unit.module,
        datasetModule: ref.module,
      });
      globalConflicts.push(item);
      alignment.conflictIds.push(item.conflictId);
    } else if (!ref.supportReason) {
      explicitEligible.push(ref);
    }
  }

  if (explicitAll.length) {
    const duplicateCheck = duplicateRevisionConflicts(explicitEligible);
    globalConflicts.push(...duplicateCheck.duplicates);
    alignment.conflictIds.push(...duplicateCheck.duplicates.map((item) => item.conflictId));
    const eligible = explicitEligible.filter((ref) => !duplicateCheck.blocked.has(ref.rowGroupId));
    alignment.candidates = explicitEligible.map((ref) => publicRef(ref, {
      matchKind: 'story_id',
      score: 1,
      margin: 1,
    }));
    if (eligible.length) {
      alignment.status = 'aligned_explicit';
      alignment.selected = eligible.map((ref) => publicRef(ref, {
        matchKind: 'story_id',
        score: 1,
        margin: 1,
      }));
      alignment.decision = {
        rule: 'explicit_story_id',
        topScore: 1,
        margin: 1,
        reason: eligible.length > 1 ? 'all exact story-id row groups selected' : 'exact story-id row group selected',
      };
    } else {
      alignment.status = alignment.conflictIds.length ? 'conflict' : 'support_only';
      alignment.decision = {
        rule: 'explicit_story_id_unusable',
        topScore: explicitEligible.length ? 1 : null,
        margin: explicitEligible.length ? 1 : null,
        reason: alignment.conflictIds.length ? 'exact matches conflict and require resolution' : 'exact matches contain no scenario-driving oracle',
      };
    }
    return alignment;
  }

  const sheets = semanticSheetCandidates(unit, allRefs);
  if (!sheets.length) return alignment;
  const top = sheets[0];
  const secondScore = sheets.length > 1 ? sheets[1].score : 0;
  const margin = roundScore(top.score - secondScore);
  alignment.candidates = sheets.flatMap((candidate) => candidate.refs.map((ref) => publicRef(ref, {
    matchKind: 'semantic_metadata',
    score: candidate.score,
    margin: candidate === top ? margin : null,
  })));

  if (top.score >= thresholds.select && margin >= thresholds.margin) {
    const duplicateCheck = duplicateRevisionConflicts(top.refs);
    globalConflicts.push(...duplicateCheck.duplicates);
    alignment.conflictIds.push(...duplicateCheck.duplicates.map((item) => item.conflictId));
    if (duplicateCheck.duplicates.length) {
      alignment.status = 'conflict';
      alignment.decision = { rule: 'semantic_duplicate_source', topScore: top.score, margin, reason: 'same row-group content exists in multiple dataset revisions' };
    } else {
      alignment.status = 'aligned_semantic';
      alignment.selected = top.refs.map((ref) => publicRef(ref, {
        matchKind: 'semantic_metadata',
        score: top.score,
        margin,
      }));
      alignment.decision = { rule: 'semantic_unique_margin', topScore: top.score, margin, reason: 'metadata score and confidence margin satisfied' };
    }
  } else if (top.score >= thresholds.ambiguous) {
    alignment.status = 'ambiguous';
    alignment.decision = {
      rule: top.score < thresholds.select ? 'semantic_below_select_threshold' : 'semantic_insufficient_margin',
      topScore: top.score,
      margin,
      reason: top.score < thresholds.select ? 'candidate requires review before scenario planning' : 'top candidates are too close; no candidate selected',
    };
  } else {
    alignment.status = 'unmapped';
    alignment.decision = { rule: 'semantic_below_ambiguous_threshold', topScore: top.score, margin, reason: 'no candidate has enough metadata evidence' };
  }
  return alignment;
}

function inventory(datasets, refs, alignments, supportingSources) {
  const selectedGroups = new Set(alignments.flatMap((alignment) => alignment.selected.map((ref) => ref.rowGroupId)));
  const supportGroups = new Set(supportingSources.map((ref) => ref.rowGroupId));
  const usedGroups = new Set([...selectedGroups, ...supportGroups]);
  const unusedRefs = refs.filter((ref) => !usedGroups.has(ref.rowGroupId));
  const usedSheetKeys = new Set([
    ...alignments.flatMap((alignment) => alignment.selected.map((ref) => `${ref.datasetRevisionId}|${ref.sheetId}`)),
    ...supportingSources.map((ref) => `${ref.datasetRevisionId}|${ref.sheetId}`),
  ]);
  const unusedSheets = [];
  const unusedColumns = [];
  for (const dataset of datasets) {
    for (const sheet of (dataset.sheets || [])) {
      const key = `${dataset.datasetRevisionId}|${sheet.sheetId}`;
      if (usedSheetKeys.has(key)) continue;
      unusedSheets.push({ datasetId: dataset.datasetId, datasetRevisionId: dataset.datasetRevisionId, sheetId: sheet.sheetId, sheetName: sheet.name });
      for (const column of (sheet.columns || [])) {
        unusedColumns.push({ datasetId: dataset.datasetId, datasetRevisionId: dataset.datasetRevisionId, sheetId: sheet.sheetId, columnId: column.columnId, header: column.header });
      }
    }
  }
  return {
    stories: alignments.filter((alignment) => !alignment.selected.length).map((alignment) => ({
      requirementUnitId: alignment.requirementUnitId,
      storyId: alignment.storyId,
      status: alignment.status,
    })),
    sheets: unusedSheets,
    rowGroups: unusedRefs.map((ref) => publicRef(ref)),
    rows: unusedRefs.flatMap((ref) => ref.rowIds.map((rowId) => ({
      datasetId: ref.datasetId,
      datasetRevisionId: ref.datasetRevisionId,
      sheetId: ref.sheetId,
      rowGroupId: ref.rowGroupId,
      rowId,
    }))),
    columns: unusedColumns,
  };
}

function buildStoryDataAlignmentPlanV1({
  requirementRevision = null,
  clauses = [],
  requirements = null,
  datasetCatalog = null,
  datasetContracts = null,
  thresholds = null,
} = {}) {
  const resolvedThresholds = thresholdsFrom(thresholds);
  const units = normalizeRequirementUnits(Array.isArray(requirements) ? requirements : clauses);
  const datasets = datasetsOf(datasetCatalog || datasetContracts || []);
  const refs = flattenRowGroups(datasets);
  const knownStories = new Set(units.map((unit) => unit.storyId).filter(Boolean));
  const conflicts = [];

  for (const ref of refs) {
    if (ref.storyId && !knownStories.has(ref.storyId)) {
      conflicts.push(conflict('unknown_explicit_story_id', [ref], { storyId: ref.storyId }));
    }
  }

  const supportingSources = refs.filter((ref) => ref.supportReason).map(supportRef);
  const alignments = units.map((unit) => alignUnit(unit, refs, resolvedThresholds, conflicts));
  const unused = inventory(datasets, refs, alignments, supportingSources);
  const revisionRefs = datasets.map((dataset) => ({
    datasetId: dataset.datasetId,
    datasetRevisionId: dataset.datasetRevisionId,
    contractId: dataset.contractId || null,
    mappingRef: dataset.mappingRef || null,
  })).sort((a, b) => `${a.datasetRevisionId}|${a.datasetId}`.localeCompare(`${b.datasetRevisionId}|${b.datasetId}`));
  const core = {
    schemaVersion: SCHEMA_VERSION,
    requirementRevision: requirementRevision == null ? null : clean(requirementRevision, 180),
    thresholds: resolvedThresholds,
    datasetRevisions: revisionRefs,
    alignments,
    supportingSources,
    conflicts,
    unused,
    stats: {
      requirementUnitCount: units.length,
      alignedRequirementCount: alignments.filter((alignment) => alignment.selected.length > 0).length,
      selectedRowGroupCount: alignments.reduce((sum, alignment) => sum + alignment.selected.length, 0),
      ambiguousRequirementCount: alignments.filter((alignment) => alignment.status === 'ambiguous').length,
      conflictingRequirementCount: alignments.filter((alignment) => alignment.status === 'conflict').length,
      unmappedRequirementCount: alignments.filter((alignment) => alignment.status === 'unmapped').length,
      supportingSourceCount: supportingSources.length,
      unusedRowGroupCount: unused.rowGroups.length,
    },
  };
  return {
    ...core,
    planId: stableId('story-data-plan', [canonicalHash(core)]),
  };
}

function alignmentForStory(plan, storyId) {
  const wanted = normalizeStoryId(storyId);
  const matches = (plan && Array.isArray(plan.alignments) ? plan.alignments : [])
    .filter((alignment) => alignment.storyId === wanted);
  if (matches.length === 1) return { status: 'resolved', alignment: matches[0], candidates: [] };
  return {
    status: matches.length ? 'ambiguous' : 'missing',
    alignment: null,
    candidates: matches.map((alignment) => alignment.alignmentId),
  };
}

function alignmentForSheet(plan, ref = {}) {
  const matches = (plan && Array.isArray(plan.alignments) ? plan.alignments : []).filter((alignment) => (
    alignment.selected.some((selected) => (
      (!ref.datasetRevisionId || selected.datasetRevisionId === ref.datasetRevisionId)
      && (!ref.sheetId || selected.sheetId === ref.sheetId)
      && (!ref.rowGroupId || selected.rowGroupId === ref.rowGroupId)
    ))
  ));
  if (matches.length === 1) return { status: 'resolved', alignment: matches[0], candidates: [] };
  return {
    status: matches.length ? 'ambiguous' : 'missing',
    alignment: null,
    candidates: matches.map((alignment) => alignment.alignmentId),
  };
}

function toCoverageItems(plan) {
  const items = [];
  for (const alignment of (plan && Array.isArray(plan.alignments) ? plan.alignments : [])) {
    for (const selected of (alignment.selected || [])) {
      items.push({
        coverageItemId: stableId('coverage-item', [plan.planId, alignment.alignmentId, selected.rowGroupId]),
        planId: plan.planId,
        alignmentId: alignment.alignmentId,
        requirementUnitId: alignment.requirementUnitId,
        storyId: alignment.storyId,
        clauseIds: [...alignment.clauseIds],
        datasetId: selected.datasetId,
        datasetRevisionId: selected.datasetRevisionId,
        sheetId: selected.sheetId,
        rowGroupId: selected.rowGroupId,
        rowIds: [...selected.rowIds],
        bindingRef: selected.bindingRef,
        matchKind: selected.matchKind,
      });
    }
  }
  return items;
}

function stampCaseBinding(testCase, plan, selector = {}) {
  if (!testCase || typeof testCase !== 'object') throw new Error('stampCaseBinding requires a test case object.');
  if (!plan || plan.schemaVersion !== SCHEMA_VERSION) throw new Error('stampCaseBinding requires StoryDataAlignmentPlanV1.');
  const existing = testCase.dataBinding && typeof testCase.dataBinding === 'object' ? testCase.dataBinding : {};
  const rowGroupId = selector.rowGroupId || existing.rowGroupId || testCase.rowGroupId;
  const alignmentId = selector.alignmentId || existing.alignmentId || testCase.alignmentId;
  const matches = [];
  for (const alignment of plan.alignments || []) {
    if (alignmentId && alignment.alignmentId !== alignmentId) continue;
    for (const selected of alignment.selected || []) {
      if (rowGroupId && selected.rowGroupId !== rowGroupId) continue;
      matches.push({ alignment, selected });
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length
      ? 'Case data binding is ambiguous; provide alignmentId and rowGroupId.'
      : 'Case data binding does not resolve to one selected row group.');
  }
  const { alignment, selected } = matches[0];
  return {
    ...testCase,
    dataBinding: {
      ...existing,
      alignmentPlanId: plan.planId,
      alignmentId: alignment.alignmentId,
      requirementUnitId: alignment.requirementUnitId,
      storyId: alignment.storyId,
      datasetId: selected.datasetId,
      datasetRevisionId: selected.datasetRevisionId,
      sheetId: selected.sheetId,
      rowGroupId: selected.rowGroupId,
      rowIds: [...selected.rowIds],
      bindingRef: selected.bindingRef,
    },
  };
}

function toTestDesignAlignments(plan, { testData = null, coverageManifest = null } = {}) {
  if (!plan || plan.schemaVersion !== SCHEMA_VERSION) throw new Error('toTestDesignAlignments requires StoryDataAlignmentPlanV1.');
  const sheets = testData && Array.isArray(testData.sheets) ? testData.sheets : [];
  const mapping = testData && testData.mapping && typeof testData.mapping === 'object' ? testData.mapping : {};
  const bindings = Array.isArray(mapping.bindings) ? mapping.bindings : [];
  const items = coverageManifest && Array.isArray(coverageManifest.items) ? coverageManifest.items : [];
  const out = [];
  for (const item of items) {
    const ref = item && item.alignmentRef;
    if (!ref || ref.planId !== plan.planId || !ref.rowGroupId) continue;
    const alignment = (plan.alignments || []).find((entry) => entry.alignmentId === ref.alignmentId);
    const selected = alignment && (alignment.selected || []).find((entry) => entry.rowGroupId === ref.rowGroupId);
    if (!selected) throw new Error(`Coverage item ${item.manifestItemId} references an unknown aligned row group.`);
    const sheetMatches = sheets.filter((sheet) => (
      (!selected.datasetRevisionId || sheet.datasetRevisionId === selected.datasetRevisionId)
      && (!selected.sheetId || sheet.sheetId === selected.sheetId)
    ));
    const bindingMatches = bindings.filter((binding) => (
      (!selected.datasetRevisionId || binding.datasetRevisionId === selected.datasetRevisionId)
      && (!selected.sheetId || binding.sheetId === selected.sheetId)
    ));
    if (sheetMatches.length !== 1 || bindingMatches.length !== 1) {
      throw new Error(`Coverage item ${item.manifestItemId} cannot resolve one approved sheet and binding.`);
    }
    const sheet = sheetMatches[0];
    const binding = bindingMatches[0];
    out.push({
      coverageRef: item.manifestItemId,
      alignmentId: alignment.alignmentId,
      storyId: alignment.storyId || item.storyRef && item.storyRef.id || null,
      sheet: sheet.name,
      sheetId: selected.sheetId,
      rowGroupId: selected.rowGroupId,
      rowIds: [...selected.rowIds],
      testDataSetId: binding.testDataSetId || selected.datasetId,
      datasetRevisionId: selected.datasetRevisionId,
      mappingId: binding.mappingId || selected.bindingRef && selected.bindingRef.mappingId || null,
      mappingVersion: binding.mappingVersion != null
        ? binding.mappingVersion
        : selected.bindingRef && selected.bindingRef.mappingVersion,
      status: binding.status || selected.bindingRef && selected.bindingRef.status || 'approved',
      approved: (binding.status || selected.bindingRef && selected.bindingRef.status || 'approved') === 'approved',
      columnToField: binding.columnToField || {},
      expectedColumn: binding.expectedColumn || item.dataSource && item.dataSource.expectedColumn || null,
      rowClassColumn: binding.rowClassColumn || item.dataSource && item.dataSource.rowClassColumn || null,
      rowSelector: binding.rowSelector || item.dataSource && item.dataSource.rowSelector || 'all',
      matchKind: selected.matchKind,
    });
  }
  return out;
}

function renderStoryDataAlignmentPlanBlock(plan) {
  if (!plan || plan.schemaVersion !== SCHEMA_VERSION) return '';
  const lines = [
    `Alignment plan: ${plan.planId}`,
    `Requirement revision: ${plan.requirementRevision || '(unversioned)'}`,
    `Dataset revisions: ${plan.datasetRevisions.map((item) => `${item.datasetId}@${item.datasetRevisionId}`).join(', ') || '(none)'}`,
  ];
  for (const alignment of plan.alignments) {
    lines.push(`- ${alignment.storyId || alignment.requirementUnitId}: ${alignment.status}`);
    for (const selected of alignment.selected) {
      lines.push(`  selected ${selected.datasetRevisionId}/${selected.sheetId}/${selected.rowGroupId} (${selected.matchKind})`);
    }
    if (!alignment.selected.length && alignment.candidates.length) {
      lines.push(`  candidates ${alignment.candidates.map((item) => `${item.sheetId}/${item.rowGroupId}:${item.score}`).join(', ')}`);
    }
  }
  return lines.join('\n');
}

function validateStoryDataAlignmentPlanV1(plan) {
  const errors = [];
  const warnings = [];
  if (!plan || plan.schemaVersion !== SCHEMA_VERSION) errors.push({ code: 'alignment_plan_version_invalid' });
  if (!plan || !plan.planId) errors.push({ code: 'alignment_plan_id_missing' });
  const alignmentIds = new Set();
  const selectedKeys = new Set();
  for (const alignment of (plan && Array.isArray(plan.alignments) ? plan.alignments : [])) {
    if (!alignment.alignmentId) errors.push({ code: 'alignment_id_missing' });
    else if (alignmentIds.has(alignment.alignmentId)) errors.push({ code: 'alignment_id_duplicate', alignmentId: alignment.alignmentId });
    else alignmentIds.add(alignment.alignmentId);
    if (['ambiguous', 'conflict', 'unmapped', 'support_only'].includes(alignment.status) && alignment.selected.length) {
      errors.push({ code: 'non_aligned_status_has_selection', alignmentId: alignment.alignmentId });
    }
    for (const selected of (alignment.selected || [])) {
      for (const key of ['datasetId', 'datasetRevisionId', 'sheetId', 'rowGroupId']) {
        if (!selected[key]) errors.push({ code: 'selected_reference_incomplete', alignmentId: alignment.alignmentId, field: key });
      }
      const identity = `${selected.datasetRevisionId}|${selected.sheetId}|${selected.rowGroupId}`;
      if (selectedKeys.has(identity)) warnings.push({ code: 'row_group_selected_multiple_times', identity });
      selectedKeys.add(identity);
    }
  }
  const expectedPlanId = plan && plan.schemaVersion === SCHEMA_VERSION
    ? stableId('story-data-plan', [canonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planId')))])
    : null;
  if (plan && plan.planId && expectedPlanId !== plan.planId) errors.push({ code: 'alignment_plan_hash_mismatch' });
  return { ok: errors.length === 0, errors, warnings, stats: plan && plan.stats ? { ...plan.stats } : null };
}

module.exports = {
  SCHEMA_VERSION,
  DEFAULT_THRESHOLDS,
  buildStoryDataAlignmentPlanV1,
  validateStoryDataAlignmentPlanV1,
  renderStoryDataAlignmentPlanBlock,
  alignmentForStory,
  alignmentForSheet,
  toCoverageItems,
  stampCaseBinding,
  toTestDesignAlignments,
  _private: {
    tokens,
    cosineTokens,
    normalizeRequirementUnits,
    scoreSheetStory,
    flattenRowGroups,
    duplicateRevisionConflicts,
    authSupportReason,
    thresholdsFrom,
    AUTH_ROLE_RE,
  },
};
