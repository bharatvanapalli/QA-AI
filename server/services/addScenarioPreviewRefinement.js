'use strict';

const crypto = require('node:crypto');
const { buildAddScenarioPreview } = require('./addScenarioPreview');
const { validateSemanticCaseContract, DEFAULT_MAX_STEPS } = require('./caseContractSemanticValidator');

const REFINEMENT_VERSION = 'AddScenarioPreviewRefinementV1';
const RESULT_STATUS = Object.freeze({
  APPLIED: 'ready_for_review',
  NEEDS_REVIEW: 'needs_review',
});

const PROTECTED_OPERATION_FIELDS = new Set([
  'id',
  'ordinal',
  'sourceQuote',
  'sourceSpan',
  'sourceClauseRefs',
  'dependsOn',
  'stepId',
  'dataRefs',
]);

const ACTION_EDITABLE_FIELDS = new Set([
  'type',
  'text',
  'targetIdentity',
  'target',
  'value',
  'valueRef',
  'selectionCriteria',
  'condition',
  'postcondition',
  'waitContract',
  'flowImpact',
  'failureBehavior',
]);

const ASSERTION_EDITABLE_FIELDS = new Set([
  'type',
  'text',
  'targetIdentity',
  'target',
  'comparator',
  'payload',
  'required',
  'failureBehavior',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return `sha256-${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function clean(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalized(value) {
  return clean(value).toLocaleLowerCase().replace(/\s+/g, ' ');
}

function semanticEnvelope(plan) {
  if (!isObject(plan)) return null;
  if (isObject(plan.caseContractV1)) return { key: 'caseContractV1', value: plan.caseContractV1 };
  if (isObject(plan.envelope)) return { key: 'envelope', value: plan.envelope };
  return null;
}

function operationCatalog(envelope) {
  const output = [];
  for (const [caseIndex, caseContract] of (Array.isArray(envelope && envelope.cases) ? envelope.cases : []).entries()) {
    const caseId = clean(caseContract && caseContract.id) || `case.${caseIndex + 1}`;
    for (const [index, record] of (Array.isArray(caseContract && caseContract.steps) ? caseContract.steps : []).entries()) {
      output.push({
        caseIndex,
        caseId,
        collection: 'steps',
        index,
        kind: 'action',
        record,
      });
    }
    for (const [index, record] of (Array.isArray(caseContract && caseContract.assertions) ? caseContract.assertions : []).entries()) {
      output.push({
        caseIndex,
        caseId,
        collection: 'assertions',
        index,
        kind: 'assertion',
        record,
      });
    }
  }
  return output.sort((left, right) => {
    if (left.caseIndex !== right.caseIndex) return left.caseIndex - right.caseIndex;
    const leftStart = Number(left.record && left.record.sourceSpan && left.record.sourceSpan.start);
    const rightStart = Number(right.record && right.record.sourceSpan && right.record.sourceSpan.start);
    const a = Number.isInteger(leftStart) ? leftStart : Number.MAX_SAFE_INTEGER;
    const b = Number.isInteger(rightStart) ? rightStart : Number.MAX_SAFE_INTEGER;
    return a - b || (left.kind === right.kind ? left.index - right.index : left.kind.localeCompare(right.kind));
  });
}

function targetValues(record) {
  const target = record && (record.targetIdentity || record.target);
  if (!isObject(target)) return [];
  return ['id', 'ref', 'label', 'name', 'description', 'role']
    .map((key) => target[key])
    .filter((value) => typeof value === 'string' && value.trim());
}

function targetMatches(record, requestedTarget) {
  const target = record && (record.targetIdentity || record.target);
  if (typeof requestedTarget === 'string') {
    const expected = normalized(requestedTarget);
    return expected !== '' && targetValues(record).some((value) => normalized(value) === expected);
  }
  if (!isObject(requestedTarget) || !isObject(target)) return false;
  const entries = Object.entries(requestedTarget).filter(([, value]) => typeof value === 'string' && value.trim());
  return entries.length > 0 && entries.every(([key, value]) => normalized(target[key]) === normalized(value));
}

function canonicalKind(value) {
  const kind = normalized(value);
  if (kind === 'action' || kind === 'step') return 'action';
  if (kind === 'assertion' || kind === 'check') return 'assertion';
  return null;
}

function resolveSelector(catalog, selector) {
  if (!isObject(selector)) return { matches: [], reason: 'selector_required' };
  const operationId = clean(selector.operationId);
  const caseId = clean(selector.caseId);
  const kind = selector.kind === undefined ? null : canonicalKind(selector.kind);
  const ordinal = Number.isInteger(selector.ordinal) && selector.ordinal > 0 ? selector.ordinal : null;
  const hasTarget = selector.semanticTarget !== undefined;
  if (!operationId && !caseId && !kind && !ordinal && !hasTarget) {
    return { matches: [], reason: 'selector_required' };
  }
  if (selector.kind !== undefined && !kind) return { matches: [], reason: 'selector_kind_invalid' };
  if (selector.ordinal !== undefined && !ordinal) return { matches: [], reason: 'selector_ordinal_invalid' };
  return {
    reason: null,
    matches: catalog.filter((entry) => {
      if (operationId && clean(entry.record && entry.record.id) !== operationId) return false;
      if (caseId && entry.caseId !== caseId) return false;
      if (kind && entry.kind !== kind) return false;
      if (ordinal && Number(entry.record && entry.record.ordinal) !== ordinal) return false;
      if (hasTarget && !targetMatches(entry.record, selector.semanticTarget)) return false;
      return true;
    }),
  };
}

function resolveRange(catalog, range) {
  if (!isObject(range)) return { matches: [], reason: 'range_required' };
  const startResolution = resolveSelector(catalog, range.start);
  const endResolution = resolveSelector(catalog, range.end);
  if (startResolution.reason || endResolution.reason) return { matches: [], reason: 'range_selector_invalid' };
  if (startResolution.matches.length !== 1 || endResolution.matches.length !== 1) {
    return { matches: [], reason: 'range_selector_ambiguous' };
  }
  const start = startResolution.matches[0];
  const end = endResolution.matches[0];
  if (start.caseId !== end.caseId) return { matches: [], reason: 'range_cross_case' };
  const startIndex = catalog.indexOf(start);
  const endIndex = catalog.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) return { matches: [], reason: 'range_not_contiguous' };
  const matches = catalog.slice(startIndex, endIndex + 1);
  if (!matches.length || matches.some((entry) => entry.caseId !== start.caseId)) {
    return { matches: [], reason: 'range_not_contiguous' };
  }
  return { matches, reason: null };
}

function refinementSourceAuthority(sourceText, guidanceText, refinementId, disposition = 'mixed') {
  const base = typeof sourceText === 'string' ? sourceText : '';
  const guidance = clean(guidanceText, 20_000);
  if (!guidance) return null;
  const separator = base && !base.endsWith('\n') ? '\n' : '';
  const start = base.length + separator.length;
  return {
    text: `${base}${separator}${guidance}`,
    clause: {
      id: `source.${refinementId}`,
      ordinal: null,
      disposition,
      sourceQuote: guidance,
      sourceSpan: { start, end: start + guidance.length },
    },
  };
}

function stableReplacementId(kind, refinementId, caseId, selectionIndex, replacementIndex) {
  const prefix = kind === 'assertion' ? 'assert' : 'step';
  return `${prefix}.refine.${digest(`${refinementId}|${caseId}|${selectionIndex}|${replacementIndex}`).slice(7, 23)}`;
}

function candidateSummary(entry) {
  return {
    operationId: clean(entry.record && entry.record.id) || null,
    caseId: entry.caseId,
    kind: entry.kind,
    ordinal: Number(entry.record && entry.record.ordinal) || entry.index + 1,
    semanticTargets: targetValues(entry.record),
  };
}

function clarificationResult({ preview, semanticPlan, code, reason, question, selector = null, candidates = [] }) {
  const previewCopy = clone(preview);
  const planCopy = clone(semanticPlan);
  return deepFreeze({
    version: REFINEMENT_VERSION,
    status: RESULT_STATUS.NEEDS_REVIEW,
    applied: false,
    previewId: previewCopy && previewCopy.previewId || null,
    baseRevision: previewCopy && previewCopy.revision || null,
    revision: previewCopy && previewCopy.revision || null,
    sourceDigest: previewCopy && previewCopy.source && previewCopy.source.digest || null,
    preview: previewCopy,
    semanticPlan: planCopy,
    persistence: {
      status: 'not_persisted',
      scenarioCountCreated: 0,
      caseCountCreated: 0,
    },
    appliedOperations: [],
    clarifications: [{
      id: `refinement.${code}`,
      code,
      blocking: true,
      question,
      reason,
      selector: clone(selector),
      candidates: candidates.map(candidateSummary),
    }],
  });
}

function validateChanges(kind, changes) {
  if (!isObject(changes) || Object.keys(changes).length === 0) {
    return { ok: false, code: 'refinement_changes_required', reason: 'At least one exact semantic change is required.' };
  }
  const editable = kind === 'action' ? ACTION_EDITABLE_FIELDS : ASSERTION_EDITABLE_FIELDS;
  for (const key of Object.keys(changes)) {
    if (PROTECTED_OPERATION_FIELDS.has(key)) {
      return { ok: false, code: 'refinement_identity_protected', reason: `The protected operation field "${key}" cannot be refined.` };
    }
    if (!editable.has(key)) {
      return { ok: false, code: 'refinement_field_unsupported', reason: `The operation field "${key}" is not editable for ${kind} records.` };
    }
  }
  return { ok: true };
}

function replacementValidation(records) {
  if (!Array.isArray(records)) return { ok: false, code: 'refinement_replacement_invalid', reason: 'replaceWith must be an array.' };
  for (const record of records) {
    if (!isObject(record)) return { ok: false, code: 'refinement_replacement_invalid', reason: 'Every replacement must be one object.' };
    const kind = canonicalKind(record.kind);
    if (!kind) return { ok: false, code: 'refinement_replacement_kind_invalid', reason: 'Replacement kind must be action or assertion.' };
    const changes = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'kind'));
    const validation = validateChanges(kind, changes);
    if (!validation.ok) return validation;
    if (!clean(changes.type, 160)) return { ok: false, code: 'refinement_replacement_type_required', reason: 'Every replacement requires an exact operation type.' };
  }
  return { ok: true };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function remapDependencies(value, removedIds, replacementIds) {
  const deps = Array.isArray(value) ? value : [];
  return unique(deps.flatMap((dependency) => (removedIds.has(dependency) ? replacementIds : [dependency])));
}

function refineAddScenarioPreview({
  projectId,
  preview,
  semanticPlan,
  baseRevision,
  sourceDigest,
  guidance,
  refinementSourceText,
} = {}) {
  if (!isObject(preview) || !isObject(preview.persistence) || preview.persistence.status !== 'not_persisted') {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_preview_invalid',
      question: 'Please reopen the current non-persisted Add Scenario preview and try again.',
      reason: 'Refinement is only valid for a non-persisted preview.',
    });
  }
  if (!clean(baseRevision) || baseRevision !== preview.revision) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_revision_stale',
      question: 'The preview changed. Review the latest revision before applying this refinement.',
      reason: `Requested revision ${clean(baseRevision) || '(missing)'} does not match the current revision ${clean(preview.revision) || '(missing)'}.`,
    });
  }
  if (!clean(sourceDigest) || !preview.source || sourceDigest !== preview.source.digest) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_source_stale',
      question: 'The source changed. Review the latest source before applying this refinement.',
      reason: 'The requested source digest does not match the current preview source.',
    });
  }
  const envelopeAuthority = semanticEnvelope(semanticPlan);
  if (!envelopeAuthority || !Array.isArray(envelopeAuthority.value.cases)) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_semantic_plan_invalid',
      question: 'Regenerate the preview before refining it.',
      reason: 'The current semantic plan does not contain a projected CaseContractV1 case list.',
    });
  }
  const requested = isObject(guidance) && Array.isArray(guidance.operations) ? guidance.operations : [];
  if (!requested.length) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_guidance_required',
      question: 'Which exact preview operation should change, and what should replace it?',
      reason: 'No structured refinement operations were supplied.',
    });
  }

  const nextPlan = clone(semanticPlan);
  const nextAuthority = semanticEnvelope(nextPlan);
  const catalog = operationCatalog(nextAuthority.value);
  const resolutions = [];
  const claimed = new Set();
  for (const instruction of requested) {
    const selector = isObject(instruction) ? instruction.selector : null;
    const hasRange = isObject(instruction) && instruction.range !== undefined;
    const resolution = hasRange ? resolveRange(catalog, instruction.range) : resolveSelector(catalog, selector);
    if (resolution.reason || resolution.matches.length === 0) {
      return clarificationResult({
        preview,
        semanticPlan,
        code: resolution.reason || 'refinement_target_not_found',
        question: 'Which exact operation should this refinement change?',
        reason: resolution.reason ? 'The refinement selector is incomplete or invalid.' : 'No operation matches the supplied stable identity, ordinal, and semantic target.',
        selector: hasRange ? instruction.range : selector,
      });
    }
    if (!hasRange && resolution.matches.length !== 1) {
      return clarificationResult({
        preview,
        semanticPlan,
        code: 'refinement_target_ambiguous',
        question: 'More than one operation matches. Select one stable operation ID.',
        reason: 'The refinement selector does not uniquely identify one operation.',
        selector,
        candidates: resolution.matches,
      });
    }
    const selectedRecords = resolution.matches;
    const selectedKeys = selectedRecords.map((selected) => `${selected.caseId}:${selected.kind}:${clean(selected.record && selected.record.id) || selected.index}`);
    if (selectedKeys.some((key) => claimed.has(key))) {
      return clarificationResult({
        preview,
        semanticPlan,
        code: 'refinement_target_conflict',
        question: 'Combine the requested changes for this operation into one refinement.',
        reason: 'Multiple refinement instructions target the same operation.',
        selector,
        candidates: selectedRecords,
      });
    }
    const hasChanges = isObject(instruction) && instruction.changes !== undefined;
    const hasReplacement = isObject(instruction) && instruction.replaceWith !== undefined;
    if (hasChanges === hasReplacement || (hasChanges && selectedRecords.length !== 1)) {
      return clarificationResult({
        preview,
        semanticPlan,
        code: 'refinement_mode_invalid',
        question: 'Choose one exact field correction or one bounded operation replacement.',
        reason: 'Use changes for one operation, or replaceWith for one selected operation/contiguous range.',
        selector: hasRange ? instruction.range : selector,
        candidates: selectedRecords,
      });
    }
    const changeValidation = hasChanges
      ? validateChanges(selectedRecords[0].kind, instruction.changes)
      : replacementValidation(instruction.replaceWith);
    if (!changeValidation.ok) {
      return clarificationResult({
        preview,
        semanticPlan,
        code: changeValidation.code,
        question: 'Provide an exact supported semantic change while keeping operation identity and order unchanged.',
        reason: changeValidation.reason,
        selector: hasRange ? instruction.range : selector,
        candidates: selectedRecords,
      });
    }
    selectedKeys.forEach((key) => claimed.add(key));
    resolutions.push({ instruction, selectedRecords, selectedKeys });
  }

  const exactRefinementSource = clean(refinementSourceText, 20_000);
  if (!exactRefinementSource) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_source_required',
      question: 'Repeat the exact correction you want to apply.',
      reason: 'The exact user-authored refinement text is required as immutable source authority.',
    });
  }

  const projectedOperationCount = catalog.length + resolutions.reduce((delta, { instruction, selectedRecords }) => (
    delta + (Array.isArray(instruction.replaceWith) ? instruction.replaceWith.length - selectedRecords.length : 0)
  ), 0);
  if (projectedOperationCount > DEFAULT_MAX_STEPS) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_operation_limit',
      question: `Keep the refined case at ${DEFAULT_MAX_STEPS} operations or fewer.`,
      reason: `The requested refinement would create ${projectedOperationCount} operations.`,
    });
  }

  const guidanceSummary = clean(guidance.summary, 4_000);
  const refinementAuthority = {
    baseRevision,
    sourceDigest,
    sourceText: exactRefinementSource,
    summary: guidanceSummary,
    operations: clone(requested),
  };
  const refinementId = `refinement.${digest(stableSerialize(refinementAuthority)).slice(7, 31)}`;
  const refinedKinds = new Set(resolutions.flatMap(({ instruction, selectedRecords }) => (
    Array.isArray(instruction.replaceWith)
      ? instruction.replaceWith.map((record) => canonicalKind(record.kind)).filter(Boolean)
      : selectedRecords.map((record) => record.kind)
  )));
  const refinementDisposition = refinedKinds.size === 1 ? [...refinedKinds][0] : 'mixed';
  const sourceAuthority = refinementSourceAuthority(
    preview.source && (preview.source.effectiveText || preview.source.text),
    exactRefinementSource,
    refinementId,
    refinementDisposition,
  );
  const refinementClause = sourceAuthority.clause;
  const clauses = Array.isArray(nextAuthority.value.sourceClauses) ? nextAuthority.value.sourceClauses : [];
  nextAuthority.value.sourceClauses = [...clauses, { ...refinementClause, ordinal: clauses.length + 1 }];

  const appliedOperations = [];
  for (const [selectionIndex, { instruction, selectedRecords }] of resolutions.entries()) {
    if (instruction.changes) {
      const selected = selectedRecords[0];
      const record = nextAuthority.value.cases[selected.caseIndex][selected.collection][selected.index];
      for (const [key, value] of Object.entries(instruction.changes)) record[key] = clone(value);
      record.sourceQuote = refinementClause.sourceQuote;
      record.sourceSpan = clone(refinementClause.sourceSpan);
      record.sourceClauseRefs = [refinementClause.id];
      appliedOperations.push({
        operationId: clean(record.id) || null,
        caseId: selected.caseId,
        kind: selected.kind,
        ordinal: Number(record.ordinal) || selected.index + 1,
        changedFields: Object.keys(instruction.changes).sort(),
      });
      continue;
    }

    const caseIndex = selectedRecords[0].caseIndex;
    const caseId = selectedRecords[0].caseId;
    const caseContract = nextAuthority.value.cases[caseIndex];
    const caseCatalog = catalog.filter((entry) => entry.caseIndex === caseIndex);
    const selectedSet = new Set(selectedRecords.map((entry) => clean(entry.record && entry.record.id)));
    const firstIndex = caseCatalog.findIndex((entry) => selectedSet.has(clean(entry.record && entry.record.id)));
    const removedActionIds = new Set(selectedRecords.filter((entry) => entry.kind === 'action').map((entry) => clean(entry.record && entry.record.id)).filter(Boolean));
    const inheritedDependencies = unique(selectedRecords
      .filter((entry) => entry.kind === 'action')
      .flatMap((entry) => Array.isArray(entry.record.dependsOn) ? entry.record.dependsOn : [])
      .filter((dependency) => !removedActionIds.has(dependency)));
    const previousAction = caseCatalog.slice(0, firstIndex).reverse().find((entry) => entry.kind === 'action' && !selectedSet.has(clean(entry.record && entry.record.id)));
    const replacements = [];
    let previousActionId = inheritedDependencies[inheritedDependencies.length - 1]
      || clean(previousAction && previousAction.record && previousAction.record.id)
      || null;
    for (const [replacementIndex, rawReplacement] of instruction.replaceWith.entries()) {
      const kind = canonicalKind(rawReplacement.kind);
      const record = clone(Object.fromEntries(Object.entries(rawReplacement).filter(([key]) => key !== 'kind')));
      record.id = stableReplacementId(kind, refinementId, caseId, selectionIndex, replacementIndex);
      record.sourceQuote = refinementClause.sourceQuote;
      record.sourceSpan = clone(refinementClause.sourceSpan);
      record.sourceClauseRefs = [refinementClause.id];
      record.dataRefs = Array.isArray(record.dataRefs) ? record.dataRefs : [];
      if (kind === 'action') {
        record.dependsOn = previousActionId ? [previousActionId] : inheritedDependencies;
        previousActionId = record.id;
      } else if (!record.stepId && previousActionId) {
        record.stepId = previousActionId;
      }
      replacements.push({ kind, record });
    }
    const replacementActionIds = replacements.filter((entry) => entry.kind === 'action').map((entry) => entry.record.id);
    const dependencyReplacement = replacementActionIds.length
      ? [replacementActionIds[replacementActionIds.length - 1]]
      : inheritedDependencies;
    const rebuilt = [];
    let inserted = false;
    for (const entry of caseCatalog) {
      const entryId = clean(entry.record && entry.record.id);
      if (selectedSet.has(entryId)) {
        if (!inserted) rebuilt.push(...replacements);
        inserted = true;
        continue;
      }
      const record = clone(entry.record);
      if (entry.kind === 'action') record.dependsOn = remapDependencies(record.dependsOn, removedActionIds, dependencyReplacement);
      if (entry.kind === 'assertion' && removedActionIds.has(record.stepId)) record.stepId = dependencyReplacement[dependencyReplacement.length - 1] || null;
      rebuilt.push({ kind: entry.kind, record });
    }
    caseContract.steps = rebuilt.filter((entry) => entry.kind === 'action').map((entry, index) => ({ ...entry.record, ordinal: index + 1 }));
    caseContract.assertions = rebuilt.filter((entry) => entry.kind === 'assertion').map((entry, index) => ({ ...entry.record, ordinal: index + 1 }));
    appliedOperations.push({
      operationId: null,
      caseId,
      kind: 'range',
      ordinal: firstIndex + 1,
      replacedOperationIds: [...selectedSet],
      replacementOperationIds: replacements.map((entry) => entry.record.id),
      changedFields: ['replaceWith'],
    });
  }

  const history = Array.isArray(nextAuthority.value.refinementLedger)
    ? nextAuthority.value.refinementLedger.filter((entry) => entry && entry.id !== refinementId)
    : [];
  nextAuthority.value.refinementLedger = [...history, { id: refinementId, ...refinementAuthority }];
  nextPlan.refinementAuthority = {
    version: REFINEMENT_VERSION,
    projectedContractKey: nextAuthority.key,
    currentRefinementId: refinementId,
    sourceText: exactRefinementSource,
  };
  nextPlan.authoritativeSourceText = sourceAuthority.text;

  const validation = validateSemanticCaseContract(nextAuthority.value, {
    sourceText: sourceAuthority.text,
    maxSteps: DEFAULT_MAX_STEPS,
  });
  const validationError = validation.ok ? null : Object.assign(new Error('The refined preview still needs semantic correction.'), {
    code: 'ADD_SCENARIO_REFINEMENT_SEMANTIC_INVALID',
    findings: validation.findings,
  });
  if (validation.contract && isObject(validation.contract)) nextPlan[nextAuthority.key] = validation.contract;

  const nextPreview = buildAddScenarioPreview({
    projectId: clean(projectId) || null,
    currentGenerationId: preview.persistence && preview.persistence.currentGenerationId || null,
    sourceText: preview.source && preview.source.text || '',
    semanticPlan: nextPlan,
    error: validationError,
  });
  if (nextPreview.previewId !== preview.previewId) {
    return clarificationResult({
      preview,
      semanticPlan,
      code: 'refinement_preview_identity_conflict',
      question: 'Reopen the latest preview before applying this refinement.',
      reason: 'The refined content did not retain the current preview identity.',
    });
  }

  return deepFreeze({
    version: REFINEMENT_VERSION,
    status: nextPreview.status,
    applied: true,
    previewId: nextPreview.previewId,
    baseRevision,
    revision: nextPreview.revision,
    sourceDigest,
    preview: nextPreview,
    semanticPlan: nextPlan,
    persistence: clone(nextPreview.persistence),
    appliedOperations,
    clarifications: validation.ok ? [] : clone(validation.findings),
  });
}

module.exports = {
  REFINEMENT_VERSION,
  RESULT_STATUS,
  refineAddScenarioPreview,
  _private: {
    operationCatalog,
    resolveSelector,
    stableSerialize,
  },
};
