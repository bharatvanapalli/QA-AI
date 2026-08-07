'use strict';

const replayEmitter = require('./codegen/replayEmitter');
const actionEvidenceRecorder = require('./actionEvidenceRecorder');
const featureFlags = require('./generationFeatureFlags');

const SCHEMA_VERSION = 'qaai-evidence-built-replayir-v1';
const OCCURRENCE_PARITY_SCHEMA_VERSION = 'qaai-authored-occurrence-parity-v1';
const OCCURRENCE_IDENTITY_FIELDS = [
  'schemaVersion',
  'caseId',
  'contractStepId',
  'sourceContractStepId',
  'actionOccurrenceId',
  'sourceActionOccurrenceId',
  'authoredActionId',
  'sequenceIndex',
  'occurrenceOrdinal',
  'occurrenceKey',
  'toolUseId',
  'toolName',
  'operation',
];

const TOOL_OPERATION = Object.freeze({
  browser_navigate: 'navigate',
  browser_navigate_back: 'navigateBack',
  browser_navigate_forward: 'navigateForward',
  browser_click: 'click',
  browser_dblclick: 'doubleClick',
  browser_double_click: 'doubleClick',
  browser_fill: 'fill',
  browser_type: 'fill',
  browser_fill_form: 'fillForm',
  browser_select_option: 'selectOption',
  browser_check: 'check',
  browser_uncheck: 'uncheck',
  browser_hover: 'hover',
  browser_drag: 'drag',
  browser_drag_and_drop: 'drag',
  browser_upload: 'upload',
  browser_file_upload: 'upload',
  browser_press_key: 'press',
  browser_wait_for: 'waitFor',
  browser_wait_for_selector: 'waitFor',
  browser_handle_dialog: 'handleDialog',
  browser_resize: 'resize',
  browser_close: 'close',
  assertion_check: 'assert',
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

function operationOf(value = {}) {
  const identity = occurrenceIdentityOf(value);
  const raw = text(identity?.operation || value.action || value.actionKind || value.toolName || value.tool);
  if (!raw) return '';
  if (TOOL_OPERATION[raw]) return TOOL_OPERATION[raw];
  const normalized = raw.replace(/[\s_-]+(.)?/g, (_, next) => next ? next.toUpperCase() : '');
  return TOOL_OPERATION[normalized] || normalized;
}

function occurrenceIdentityOf(value = {}) {
  if (!value || typeof value !== 'object') return null;
  const evidenceJson = parseJson(value.evidenceJson) || {};
  const recipeJson = parseJson(value.locatorRecipeJson) || {};
  const sources = [
    value.actionIdentity,
    value.stepAuthoring?.actionIdentity,
    value.actionDispatchIdentity,
    value.locatorEvidenceV2?.actionIdentity,
    value.actionLocator?.actionIdentity,
    value.actionLocator?.context?.captureBinding,
    value._recipe?.actionIdentity,
    recipeJson.actionIdentity,
    evidenceJson.authoredIdentity,
    value,
  ].filter((item) => item && typeof item === 'object');
  const identity = {};
  for (const field of OCCURRENCE_IDENTITY_FIELDS) {
    for (const source of sources) {
      const candidate = source[field];
      if (candidate == null || candidate === '') continue;
      identity[field] = clone(candidate);
      break;
    }
  }
  if (value.authoredSequenceIndex != null) identity.sequenceIndex = Number(value.authoredSequenceIndex);
  if (!identity.toolUseId && value.actionAttemptId) identity.toolUseId = String(value.actionAttemptId);
  if (!identity.toolName && value.toolName) identity.toolName = String(value.toolName);
  if (!identity.operation && value.actionKind) identity.operation = String(value.actionKind);
  return stableOccurrenceId(identity) ? identity : null;
}

function stableOccurrenceId(identity) {
  if (!identity || typeof identity !== 'object') return '';
  const stableId = text(identity.actionOccurrenceId || identity.occurrenceKey);
  if (stableId) return stableId;
  const contractStepId = text(identity.contractStepId);
  const ordinal = identity.occurrenceOrdinal == null
    ? null
    : Number(identity.occurrenceOrdinal);
  if (contractStepId && Number.isFinite(ordinal)) {
    return `${contractStepId}:occurrence:${ordinal}`;
  }
  // Legacy evidence may have only an authoredActionId. Retain it for
  // backwards-compatible diagnostics, but never combine it with a stronger
  // occurrence identity because those IDs are produced in different
  // namespaces by older runtime and contract compilers.
  return text(identity.authoredActionId);
}

function scopeOf({ runResultId, testCaseId } = {}) {
  return {
    runResultId: text(runResultId) || 'unknown-run-result',
    testCaseId: text(testCaseId) || 'unknown-test-case',
  };
}

function identityScopeStatus(identity, scope) {
  if (!identity || !stableOccurrenceId(identity)) return 'unstable';
  const identityCaseId = text(identity.caseId);
  if (!identityCaseId) return 'unscoped';
  return identityCaseId === scope.testCaseId ? 'local' : 'foreign';
}

function scopedOccurrenceKey(scope, identity, operation) {
  if (identityScopeStatus(identity, scope) !== 'local') return null;
  const stableId = text(identity.actionOccurrenceId || identity.occurrenceKey);
  if (stableId) {
    return JSON.stringify([
      scope.runResultId,
      scope.testCaseId,
      text(identity.caseId),
      'stable-occurrence',
      stableId,
    ]);
  }
  const contractStepId = text(identity.contractStepId);
  const normalizedOperation = text(operation);
  const occurrenceOrdinal = identity.occurrenceOrdinal == null
    ? null
    : Number(identity.occurrenceOrdinal);
  if (contractStepId && normalizedOperation && Number.isFinite(occurrenceOrdinal)) {
    return JSON.stringify([
      scope.runResultId,
      scope.testCaseId,
      text(identity.caseId),
      'contract-operation-ordinal',
      contractStepId,
      normalizedOperation,
      occurrenceOrdinal,
    ]);
  }
  const legacyAuthoredActionId = text(identity.authoredActionId);
  if (!legacyAuthoredActionId) return null;
  return JSON.stringify([
    scope.runResultId,
    scope.testCaseId,
    text(identity.caseId),
    'legacy-authored-action',
    legacyAuthoredActionId,
    normalizedOperation,
  ]);
}

function attemptIdOf(entry, index) {
  const identity = occurrenceIdentityOf(entry);
  return text(entry?.toolUseId || entry?.actionAttemptId || identity?.toolUseId) || `trail-attempt-${index}`;
}

function verifiedLocatorScore(entry = {}) {
  const locator = entry.actionLocator || entry.codegenLocator || null;
  if (!locator || typeof locator !== 'object') return 0;
  const proof = locator.proof || {};
  if (locator.verified === true && proof.verified === true && proof.sameElement === true && Number(proof.count) === 1) return 40;
  return 10;
}

function replayAttemptScore(entry = {}) {
  let score = entry.ok === false ? 0 : 100;
  score += verifiedLocatorScore(entry);
  if (entry.pageUrlAfter || entry.afterSnapshot || entry.snapshotAfter) score += 5;
  if (entry.retryOfActionEvidenceId || entry.retryOfActionAttemptId) score += 1;
  return score;
}

function occurrenceDiagnostic(code, detail, scope, entry, extra = {}) {
  const identity = occurrenceIdentityOf(entry) || {};
  return {
    code,
    severity: code === 'foreign_occurrence_isolated' ? 'warning' : 'info',
    nonBlocking: true,
    detail,
    runResultId: scope.runResultId,
    testCaseId: scope.testCaseId,
    contractStepId: identity.contractStepId || null,
    actionOccurrenceId: identity.actionOccurrenceId || null,
    authoredActionId: identity.authoredActionId || null,
    occurrenceOrdinal: identity.occurrenceOrdinal ?? null,
    occurrenceKey: identity.occurrenceKey || null,
    toolName: entry?.tool || entry?.toolName || identity.toolName || null,
    actionAttemptId: extra.actionAttemptId || entry?.toolUseId || entry?.actionAttemptId || identity.toolUseId || null,
    ...extra,
  };
}

function canonicalizeReplayTrailOccurrences({ trail = [], runResultId, testCaseId } = {}) {
  const scope = scopeOf({ runResultId, testCaseId });
  const entries = asArray(trail);
  const groups = new Map();
  const retained = [];
  const diagnostics = [];
  const selectedAttemptByOccurrenceKey = new Map();

  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const identity = occurrenceIdentityOf(entry);
    const status = identityScopeStatus(identity, scope);
    const explicitlyDiagnostic = entry.authored === false
      || entry.authoredAction === false
      || entry.evidenceOnly === true
      || entry.diagnosticOnly === true;
    if (explicitlyDiagnostic && identity) {
      diagnostics.push(occurrenceDiagnostic(
        'diagnostic_attempt_isolated',
        'A diagnostic-only runtime attempt was retained as evidence and excluded from authored ReplayIR cardinality.',
        scope,
        entry,
      ));
      return;
    }
    if (status === 'foreign') {
      diagnostics.push(occurrenceDiagnostic(
        'foreign_occurrence_isolated',
        `A stable occurrence belonging to test case "${identity.caseId}" was excluded from test case "${scope.testCaseId}".`,
        scope,
        entry,
        { foreignTestCaseId: identity.caseId },
      ));
      return;
    }
    if (status !== 'local') {
      retained.push({ index, entry });
      if (status === 'unscoped') {
        diagnostics.push(occurrenceDiagnostic(
          'unscoped_occurrence_retained',
          'A stable occurrence without a test-case scope was retained for backward compatibility but cannot satisfy authored occurrence parity.',
          scope,
          entry,
        ));
      }
      return;
    }
    const key = scopedOccurrenceKey(scope, identity, operationOf(entry));
    const bucket = groups.get(key) || [];
    bucket.push({ index, entry, score: replayAttemptScore(entry) });
    groups.set(key, bucket);
  });

  for (const [key, attempts] of groups.entries()) {
    const selected = attempts.slice().sort((left, right) => right.score - left.score || right.index - left.index)[0];
    const retryGroup = attempts.some((attempt) => attempt.entry.retryOfActionEvidenceId || attempt.entry.retryOfActionAttemptId);
    const firstIndex = Math.min(...attempts.map((attempt) => attempt.index));
    retained.push({ index: firstIndex, entry: selected.entry });
    selectedAttemptByOccurrenceKey.set(key, attemptIdOf(selected.entry, selected.index));
    for (const attempt of attempts) {
      if (attempt === selected) continue;
      diagnostics.push(occurrenceDiagnostic(
        retryGroup
          ? 'retry_attempt_isolated'
          : 'duplicate_attempt_isolated',
        'A repeated runtime attempt for the same immutable authored occurrence remains in evidence but is not emitted as an additional authored action.',
        scope,
        attempt.entry,
        {
          actionAttemptId: attemptIdOf(attempt.entry, attempt.index),
          retainedActionAttemptId: attemptIdOf(selected.entry, selected.index),
        },
      ));
    }
  }

  retained.sort((left, right) => left.index - right.index);
  return {
    scope,
    trail: retained.map((item) => item.entry),
    diagnostics,
    selectedAttemptByOccurrenceKey,
  };
}

const WAIT_CONDITION_FIELDS = [
  'timeoutMs',
  'refreshAfterMs',
  'reloadAfterMs',
  'pollIntervalMs',
  'pollMs',
  'stableObservations',
  'recovery',
  'recoveryAction',
  'recoveryLimit',
  'maxAttempts',
  'sameSession',
];

function waitObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function runtimeWaitObservationOf(entry = {}) {
  return waitObject(entry.waitObservation)
    || waitObject(entry.waitResult)
    || waitObject(entry.runtimeWaitObservation)
    || waitObject(entry.recoveryObservation)
    || (Array.isArray(entry.waitObservations) ? { observations: entry.waitObservations } : null)
    || null;
}

function authoredWaitCandidateOf(entry = {}, index = 0) {
  const evidenceJson = parseJson(entry.evidenceJson) || {};
  const retry = !!(entry.retryOfActionEvidenceId || entry.retryOfActionAttemptId);
  const candidates = [
    { contract: waitObject(entry.stepAuthoring?.waitContract), source: 'stepAuthoring.waitContract', rank: 500 },
    { contract: waitObject(entry.authoredWaitContract), source: 'authoredWaitContract', rank: 450 },
    { contract: waitObject(evidenceJson.authoredWaitContract), source: 'evidence.authoredWaitContract', rank: 425 },
    { contract: waitObject(entry.waitContract), source: retry ? 'retry.waitContract' : 'waitContract', rank: retry ? 100 : 350 },
    { contract: waitObject(evidenceJson.waitContract), source: retry ? 'retry.evidence.waitContract' : 'evidence.waitContract', rank: retry ? 90 : 325 },
    { contract: waitObject(entry.args?.waitContract), source: retry ? 'retry.args.waitContract' : 'args.waitContract', rank: retry ? 80 : 300 },
  ].filter((candidate) => candidate.contract);
  if (!candidates.length) return null;
  const selected = candidates.sort((left, right) => right.rank - left.rank)[0];
  return {
    ...selected,
    contract: clone(selected.contract),
    retry,
    index,
    actionAttemptId: attemptIdOf(entry, index),
  };
}

function buildAuthoredWaitContractIndex({ trail = [], scope }) {
  const groups = new Map();
  const diagnostics = [];
  asArray(trail).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const identity = occurrenceIdentityOf(entry);
    if (identityScopeStatus(identity, scope) !== 'local') return;
    const key = scopedOccurrenceKey(scope, identity, operationOf(entry));
    if (!key) return;
    const candidate = authoredWaitCandidateOf(entry, index);
    const observation = runtimeWaitObservationOf(entry);
    if (observation) {
      diagnostics.push(occurrenceDiagnostic(
        'runtime_wait_observation_retained',
        'A runtime wait/recovery observation remains diagnostic evidence and cannot replace the authored wait contract.',
        scope,
        entry,
        {
          waitOutcome: observation.outcome || observation.status || observation.reason || null,
          retryObservation: !!(entry.retryOfActionEvidenceId || entry.retryOfActionAttemptId),
        },
      ));
    }
    if (!candidate) return;
    const bucket = groups.get(key) || { key, identity, operation: operationOf(entry), candidates: [] };
    bucket.candidates.push({ ...candidate, entry });
    groups.set(key, bucket);
  });

  for (const bucket of groups.values()) {
    bucket.candidates.sort((left, right) => right.rank - left.rank || left.index - right.index);
    bucket.selected = bucket.candidates[0];
    for (const candidate of bucket.candidates.slice(1)) {
      if (!candidate.retry) continue;
      diagnostics.push(occurrenceDiagnostic(
        'retry_wait_contract_observation_isolated',
        'A retry/runtime wait contract was preserved as diagnostic evidence and did not replace the authored non-retry wait contract.',
        scope,
        candidate.entry,
        {
          waitContractSource: candidate.source,
          retainedWaitContractSource: bucket.selected.source,
          retainedActionAttemptId: bucket.selected.actionAttemptId,
        },
      ));
    }
  }
  return { scope, groups, diagnostics };
}

function attachAuthoredWaitContractsToEvidence(evidence, waitIndex) {
  for (const row of asArray(evidence?.actionEvidences)) {
    const identity = occurrenceIdentityOf(row);
    const key = scopedOccurrenceKey(waitIndex.scope, identity, operationOf(row));
    const selected = key ? waitIndex.groups.get(key)?.selected : null;
    if (!selected) continue;
    row.authoredWaitContract = clone(selected.contract);
    const evidenceJson = parseJson(row.evidenceJson) || {};
    row.evidenceJson = JSON.stringify({
      ...evidenceJson,
      authoredWaitContract: clone(selected.contract),
      authoredWaitContractSource: selected.source,
    });
  }
}

function applyVerbatimWaitContract(condition, contract) {
  const output = { ...(condition || {}) };
  for (const field of WAIT_CONDITION_FIELDS) delete output[field];
  for (const field of WAIT_CONDITION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(contract, field)) continue;
    output[field] = clone(contract[field]);
  }
  if (Object.prototype.hasOwnProperty.call(contract, 'pollMs')
    && !Object.prototype.hasOwnProperty.call(contract, 'pollIntervalMs')) {
    output.pollIntervalMs = clone(contract.pollMs);
  }
  if (Object.prototype.hasOwnProperty.call(contract, 'reloadAfterMs')
    && !Object.prototype.hasOwnProperty.call(contract, 'refreshAfterMs')) {
    output.refreshAfterMs = clone(contract.reloadAfterMs);
  }
  if (!Object.prototype.hasOwnProperty.call(contract, 'recovery')) {
    const action = contract.recoveryAction;
    const limit = contract.recoveryLimit ?? contract.maxAttempts;
    if (action != null || limit != null) {
      output.recovery = {
        ...(action != null ? { action: clone(action) } : {}),
        ...(limit != null ? { maxAttempts: clone(limit) } : {}),
      };
    }
  }
  return output;
}

function applyAuthoredWaitContractsToReplayIr({ emit, waitIndex }) {
  const ir = emit?.ir;
  const diagnostics = [...asArray(waitIndex?.diagnostics)];
  if (!ir || !Array.isArray(ir.steps)) {
    return {
      report: {
        schemaVersion: 'qaai-authored-wait-propagation-v1',
        ...waitIndex.scope,
        authoredWaitContractCount: waitIndex.groups.size,
        propagatedWaitCount: 0,
        missingReplayWaitCount: waitIndex.groups.size,
      },
      diagnostics,
    };
  }
  const waitsByKey = new Map();
  for (const step of ir.steps) {
    if (!step || step.op !== 'waitFor') continue;
    if (step.authored === false || step.evidenceOnly === true) {
      diagnostics.push(occurrenceDiagnostic(
        'runtime_wait_step_retained_as_diagnostic',
        'A runtime-only ReplayIR wait remains diagnostic and cannot receive or replace an authored wait contract.',
        waitIndex.scope,
        step,
      ));
      continue;
    }
    const identity = occurrenceIdentityOf(step);
    const key = scopedOccurrenceKey(waitIndex.scope, identity, operationOf(step));
    if (!key) continue;
    const bucket = waitsByKey.get(key) || [];
    bucket.push(step);
    waitsByKey.set(key, bucket);
  }

  let propagatedWaitCount = 0;
  let missingReplayWaitCount = 0;
  for (const [key, group] of waitIndex.groups.entries()) {
    const waitSteps = waitsByKey.get(key) || [];
    const authoredWait = waitSteps[0] || null;
    if (!authoredWait) {
      missingReplayWaitCount += 1;
      diagnostics.push({
        code: 'authored_wait_contract_missing_replay_wait',
        severity: 'warning',
        nonBlocking: true,
        detail: 'An authored wait contract had no matching ReplayIR waitFor node. The diagnostic is non-blocking and does not alter output completion.',
        ...waitIndex.scope,
        contractStepId: group.identity.contractStepId || null,
        actionOccurrenceId: group.identity.actionOccurrenceId || null,
      });
      continue;
    }
    authoredWait.waitContract = clone(group.selected.contract);
    authoredWait.condition = applyVerbatimWaitContract(authoredWait.condition, group.selected.contract);
    authoredWait.authoredWaitContractSource = group.selected.source;
    propagatedWaitCount += 1;
    for (const extra of waitSteps.slice(1)) {
      extra.authored = false;
      extra.evidenceOnly = true;
      extra.origin = 'runtime_wait_observation';
      diagnostics.push(occurrenceDiagnostic(
        'duplicate_runtime_wait_isolated',
        'An additional runtime wait for the same authored occurrence remains diagnostic-only and cannot replace the authored wait.',
        waitIndex.scope,
        extra,
      ));
    }
  }

  const report = {
    schemaVersion: 'qaai-authored-wait-propagation-v1',
    ...waitIndex.scope,
    authoredWaitContractCount: waitIndex.groups.size,
    propagatedWaitCount,
    missingReplayWaitCount,
    diagnosticWaitObservationCount: diagnostics.length,
  };
  ir.authoredWaitContractPropagation = report;
  if (diagnostics.length) {
    ir.runtimeEvidence = [...asArray(ir.runtimeEvidence), ...diagnostics.map((item) => clone(item))];
    emit.findings = [...asArray(emit.findings), ...diagnostics];
  }
  return { report, diagnostics };
}

function gap(code, detail, extra = {}) {
  return {
    code,
    where: extra.where || extra.testCaseId || 'case',
    detail,
    pageUrl: extra.pageUrl || null,
    narration: extra.narration || null,
    elementLabel: extra.elementLabel || null,
    source: 'capture_first_evidence',
  };
}

function ledgerGapsFromEvidence(ledger = {}) {
  const gaps = [];
  const testCaseId = ledger.testCaseId || null;
  if ((ledger.missingActionEvidenceCount || 0) > 0) {
    gaps.push(gap(
      'missing_action_evidence',
      `${ledger.missingActionEvidenceCount} planned exportable action(s) have no captured ActionEvidence.`,
      { testCaseId },
    ));
  }
  if ((ledger.missingLocatorCount || 0) > 0) {
    gaps.push(gap(
      'missing_locator_evidence',
      `${ledger.missingLocatorCount} exportable DOM action(s) have no durable LocatorRecipe.`,
      { testCaseId },
    ));
  }
  if ((ledger.missingAssertionCount || 0) > 0) {
    gaps.push(gap(
      'missing_assertion_evidence',
      `${ledger.missingAssertionCount} required assertion(s) have no concrete AssertionEvidence.`,
      { testCaseId },
    ));
  }
  if ((ledger.parseFailedAssertionCount || 0) > 0) {
    gaps.push(gap(
      'parse_failed_assertion',
      `${ledger.parseFailedAssertionCount} assertion(s) could not be parsed into concrete expected/actual evidence.`,
      { testCaseId },
    ));
  }
  if ((ledger.missingNavigationEvidenceCount || 0) > 0) {
    gaps.push(gap(
      'missing_navigation_evidence',
      `${ledger.missingNavigationEvidenceCount} navigation action(s) lack requested/resolved URL, load-state, or post-navigation oracle proof.`,
      { testCaseId },
    ));
  }
  if ((ledger.missingAuthSetupCount || 0) > 0) {
    gaps.push(gap(
      'missing_auth_setup_evidence',
      'Auth/session setup was required, but QAAI did not capture complete AuthSetupEvidence with post-login proof.',
      { testCaseId },
    ));
  }
  return gaps;
}

function isLocatorOnlyGap(item) {
  const code = String(item && (item.code || item.type || item.rule) || '').toLowerCase();
  return /locator|target_resolution|excavation/.test(code);
}

function guessedResolveCount(ir) {
  return asArray(ir && ir.steps).filter((step) => step && step.op === 'resolve' && (
    step.guessedLocator === true
    || step.locatorConfidence === 'guessed'
    || step.locatorProvenance?.kind === 'qaai_guessed_locator'
  )).length;
}

function nonLocatorMissingEvidenceCount(ledger = {}) {
  return [
    'missingActionEvidenceCount',
    'missingAssertionCount',
    'parseFailedAssertionCount',
    'missingNavigationEvidenceCount',
    'missingAuthSetupCount',
  ].reduce((sum, key) => sum + Number(ledger[key] || 0), 0);
}

function gapKey(item) {
  return [
    item && (item.code || item.type || 'gap'),
    item && (item.where || ''),
    item && (item.detail || item.description || ''),
  ].join('::');
}

function dedupeGaps(items) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(items)) {
    if (!item) continue;
    const normalized = {
      ...item,
      code: String(item.code || item.type || 'replayir_gap'),
      detail: String(item.detail || item.description || 'ReplayIR evidence gap.'),
    };
    const key = gapKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function hasLegacyInertGap(envelopeOrEmit) {
  return asArray(envelopeOrEmit && envelopeOrEmit.gaps).some((item) => /legacy_inert/i.test(String(item && (item.code || item.type))));
}

function fieldIndexOfEvidenceRow(row) {
  const evidenceJson = parseJson(row?.evidenceJson) || {};
  const numeric = Number(evidenceJson.fieldIndex);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function rowScore(row, selectedAttemptId) {
  let score = selectedAttemptId && text(row?.actionAttemptId) === selectedAttemptId ? 100 : 0;
  if (!row?.retryOfActionEvidenceId) score += 20;
  const evidenceJson = parseJson(row?.evidenceJson) || {};
  if (evidenceJson.ok !== false) score += 10;
  if (row?.locatorRecipeId) score += 5;
  return score;
}

function canonicalEvidenceGroups({ evidence, scope, selectedAttemptByOccurrenceKey }) {
  const groups = new Map();
  const ignored = [];
  for (const row of asArray(evidence?.actionEvidences)) {
    if (!row || row.exportable === false) continue;
    const identity = occurrenceIdentityOf(row);
    const rowScopeMatches = text(row.runResultId) === scope.runResultId
      && text(row.testCaseId) === scope.testCaseId;
    const identityStatus = identityScopeStatus(identity, scope);
    if (!rowScopeMatches || identityStatus !== 'local') {
      if (identity) ignored.push({ row, identity, rowScopeMatches, identityStatus });
      continue;
    }
    const operation = operationOf(row);
    const key = scopedOccurrenceKey(scope, identity, operation);
    if (!key) continue;
    const bucket = groups.get(key) || {
      key,
      identity,
      operation,
      attempts: [],
      rowsByField: new Map(),
    };
    bucket.attempts.push(row);
    const fieldIndex = fieldIndexOfEvidenceRow(row);
    const fieldKey = fieldIndex == null ? 'scalar' : `field:${fieldIndex}`;
    const fieldRows = bucket.rowsByField.get(fieldKey) || [];
    fieldRows.push(row);
    bucket.rowsByField.set(fieldKey, fieldRows);
    groups.set(key, bucket);
  }

  for (const bucket of groups.values()) {
    const selectedAttemptId = selectedAttemptByOccurrenceKey.get(bucket.key) || null;
    bucket.canonicalRows = Array.from(bucket.rowsByField.entries())
      .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
      .map(([, rows]) => rows.slice().sort((left, right) => rowScore(right, selectedAttemptId) - rowScore(left, selectedAttemptId))[0]);
    bucket.expectedReplayStepCount = Math.max(1, bucket.canonicalRows.length);
  }
  return { groups, ignored };
}

function executableReplayStep(step) {
  if (!step || !['act', 'assert', 'waitFor'].includes(step.op)) return false;
  const origin = text(step.origin).toLowerCase();
  if (/foreign_runtime_evidence|duplicate_or_retry_runtime_evidence/.test(origin)) return false;
  // Exact persisted occurrence identity is stronger than an earlier semantic
  // demotion. Reconciliation must be allowed to promote that same occurrence.
  if (stableOccurrenceId(occurrenceIdentityOf(step))) return true;
  return step.authored !== false && step.evidenceOnly !== true;
}

function locatorRecipeValue(record) {
  if (!record) return null;
  return record._recipe || parseJson(record.locatorRecipeJson) || null;
}

function comparableOccurrenceValue(field, value) {
  if (value == null || value === '') return null;
  if (field === 'sequenceIndex' || field === 'occurrenceOrdinal') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : text(value);
  }
  return text(value);
}

function locatorRecipeOccurrenceCompatibility({ actionEvidence, locatorRecipe, scope }) {
  const mismatchFields = [];
  if (!locatorRecipe) {
    return { compatible: false, mismatchFields: ['locatorRecipeId'] };
  }
  if (text(locatorRecipe.runResultId) !== scope.runResultId) mismatchFields.push('runResultId');
  if (text(locatorRecipe.testCaseId) !== scope.testCaseId) mismatchFields.push('testCaseId');

  const actionIdentity = occurrenceIdentityOf(actionEvidence);
  const locatorIdentity = occurrenceIdentityOf(locatorRecipe);
  if (identityScopeStatus(actionIdentity, scope) !== 'local') mismatchFields.push('actionIdentity.caseId');
  if (identityScopeStatus(locatorIdentity, scope) !== 'local') mismatchFields.push('locatorIdentity.caseId');

  const structuralFields = ['contractStepId', 'occurrenceOrdinal'];
  for (const field of structuralFields) {
    const actionValue = comparableOccurrenceValue(field, actionIdentity?.[field]);
    const locatorValue = comparableOccurrenceValue(field, locatorIdentity?.[field]);
    if (actionValue != null && locatorValue != null && actionValue !== locatorValue) {
      mismatchFields.push(field);
    }
  }

  const actionOperation = operationOf(actionEvidence);
  const locatorOperation = operationOf(locatorRecipe);
  if (actionOperation && locatorOperation && actionOperation !== locatorOperation) mismatchFields.push('operation');

  const actionOccurrenceId = comparableOccurrenceValue('actionOccurrenceId', actionIdentity?.actionOccurrenceId);
  const locatorOccurrenceId = comparableOccurrenceValue('actionOccurrenceId', locatorIdentity?.actionOccurrenceId);
  const actionOccurrenceKey = comparableOccurrenceValue('occurrenceKey', actionIdentity?.occurrenceKey);
  const locatorOccurrenceKey = comparableOccurrenceValue('occurrenceKey', locatorIdentity?.occurrenceKey);
  if (actionOccurrenceId != null && locatorOccurrenceId != null) {
    if (actionOccurrenceId !== locatorOccurrenceId) mismatchFields.push('actionOccurrenceId');
  } else if (actionOccurrenceKey != null && locatorOccurrenceKey != null) {
    if (actionOccurrenceKey !== locatorOccurrenceKey) mismatchFields.push('occurrenceKey');
  } else {
    const actionContractStepId = comparableOccurrenceValue('contractStepId', actionIdentity?.contractStepId);
    const locatorContractStepId = comparableOccurrenceValue('contractStepId', locatorIdentity?.contractStepId);
    const actionOrdinal = comparableOccurrenceValue('occurrenceOrdinal', actionIdentity?.occurrenceOrdinal);
    const locatorOrdinal = comparableOccurrenceValue('occurrenceOrdinal', locatorIdentity?.occurrenceOrdinal);
    const fallbackComplete = actionContractStepId != null
      && locatorContractStepId != null
      && actionOrdinal != null
      && locatorOrdinal != null
      && !!actionOperation
      && !!locatorOperation;
    if (!fallbackComplete) mismatchFields.push('stableOccurrenceIdentity');
  }

  return {
    compatible: mismatchFields.length === 0,
    mismatchFields: Array.from(new Set(mismatchFields)),
    actionIdentity,
    locatorIdentity,
    actionOperation,
    locatorOperation,
  };
}

function applyPersistedOccurrenceEvidence({ step, identity, scope, actionEvidence, locatorRecipe }) {
  if (!step || !identity) return;
  const immutableIdentity = clone(identity);
  step.actionIdentity = immutableIdentity;
  for (const field of OCCURRENCE_IDENTITY_FIELDS) {
    if (immutableIdentity[field] != null && immutableIdentity[field] !== '') {
      step[field] = clone(immutableIdentity[field]);
    }
  }
  step.occurrenceScope = clone(scope);
  if (actionEvidence?.id) step.actionEvidenceId = actionEvidence.id;
  const persistedRecipe = locatorRecipeValue(locatorRecipe);
  if (!persistedRecipe) return;
  step.locatorRecipeId = locatorRecipe.id;
  // This is the exact persisted recipe captured for the acted-upon node. It is
  // copied verbatim; no element label, narration, or LLM reconstruction is used.
  step.actionLocator = clone(persistedRecipe);
  if (persistedRecipe.context) step.locatorContext = clone(persistedRecipe.context);
  if (persistedRecipe.captureEvidence) step.captureEvidence = clone(persistedRecipe.captureEvidence);
}

function demoteReplayEvidenceStep(step, resolve, reason) {
  if (!step) return;
  step.authored = false;
  step.evidenceOnly = true;
  step.origin = reason;
  if (resolve) {
    resolve.authored = false;
    resolve.evidenceOnly = true;
    resolve.origin = reason;
  }
}

function applyAuthoredOccurrenceParityInvariant({ emit, evidence, canonicalization } = {}) {
  const ir = emit?.ir;
  const scope = canonicalization?.scope || scopeOf({
    runResultId: evidence?.runResultId,
    testCaseId: evidence?.testCaseId || ir?.caseId,
  });
  const diagnostics = [...asArray(canonicalization?.diagnostics)];
  if (!ir || !Array.isArray(ir.steps)) {
    const report = {
      schemaVersion: OCCURRENCE_PARITY_SCHEMA_VERSION,
      ...scope,
      satisfied: false,
      expectedAuthoredOccurrenceCount: 0,
      matchedAuthoredOccurrenceCount: 0,
      missingAuthoredOccurrenceCount: 0,
      duplicateReplayOccurrenceCount: 0,
      retryOrDiagnosticAttemptCount: diagnostics.length,
      foreignOccurrenceCount: diagnostics.filter((item) => item.code === 'foreign_occurrence_isolated').length,
      occurrences: [],
    };
    return { report, diagnostics };
  }

  const selectedAttemptByOccurrenceKey = canonicalization?.selectedAttemptByOccurrenceKey || new Map();
  const expected = canonicalEvidenceGroups({ evidence, scope, selectedAttemptByOccurrenceKey });
  for (const ignored of expected.ignored) {
    diagnostics.push(occurrenceDiagnostic(
      ignored.identityStatus === 'foreign' || !ignored.rowScopeMatches
        ? 'foreign_persisted_occurrence_isolated'
        : 'unscoped_persisted_occurrence_isolated',
      'Persisted evidence outside the exact run-result and test-case occurrence scope cannot satisfy ReplayIR parity.',
      scope,
      ignored.row,
      {
        evidenceRunResultId: ignored.row.runResultId || null,
        evidenceTestCaseId: ignored.row.testCaseId || null,
        foreignTestCaseId: ignored.identity.caseId || null,
      },
    ));
  }

  const resolveByRef = new Map(ir.steps
    .filter((step) => step?.op === 'resolve' && step.as)
    .map((step) => [step.as, step]));
  const replayByKey = new Map();
  for (const step of ir.steps.filter(executableReplayStep)) {
    const identity = occurrenceIdentityOf(step);
    const status = identityScopeStatus(identity, scope);
    if (status === 'foreign') {
      const resolve = step.target ? resolveByRef.get(step.target) || null : null;
      demoteReplayEvidenceStep(step, resolve, 'foreign_runtime_evidence');
      diagnostics.push(occurrenceDiagnostic(
        'foreign_replay_occurrence_isolated',
        'A ReplayIR operation with a stable foreign test-case identity was retained as diagnostic evidence and cannot satisfy local authored parity.',
        scope,
        step,
        { foreignTestCaseId: identity.caseId },
      ));
      continue;
    }
    const key = scopedOccurrenceKey(scope, identity, operationOf(step));
    if (!key) continue;
    const bucket = replayByKey.get(key) || [];
    bucket.push(step);
    replayByKey.set(key, bucket);
  }

  const locatorRecipeById = new Map(asArray(evidence?.locatorRecipes)
    .filter((record) => record?.id)
    .map((record) => [record.id, record]));
  const occurrences = [];
  let matchedAuthoredOccurrenceCount = 0;
  let missingAuthoredOccurrenceCount = 0;
  let duplicateReplayOccurrenceCount = 0;

  for (const bucket of expected.groups.values()) {
    const replaySteps = replayByKey.get(bucket.key) || [];
    const primaryReplaySteps = replaySteps.filter((step) => step.op !== 'waitFor');
    // A post-action wait may intentionally share the action occurrence ID. It
    // is supplemental synchronization, not a duplicate execution. A wait-only
    // authored occurrence (for example a projected navigation wait) remains a
    // valid primary parity candidate.
    const parityReplaySteps = primaryReplaySteps.length ? primaryReplaySteps : replaySteps;
    const expectedStepCount = bucket.expectedReplayStepCount;
    const keptSteps = parityReplaySteps.slice(0, expectedStepCount);
    const extraSteps = parityReplaySteps.slice(expectedStepCount);
    for (const extra of extraSteps) {
      const resolve = extra.target ? resolveByRef.get(extra.target) || null : null;
      demoteReplayEvidenceStep(extra, resolve, 'duplicate_or_retry_runtime_evidence');
      duplicateReplayOccurrenceCount += 1;
      diagnostics.push(occurrenceDiagnostic(
        'duplicate_replay_occurrence_isolated',
        'An extra ReplayIR operation for an already represented authored occurrence was demoted to diagnostic-only evidence.',
        scope,
        extra,
      ));
    }

    keptSteps.forEach((step, index) => {
      const evidenceRow = bucket.canonicalRows[Math.min(index, bucket.canonicalRows.length - 1)] || bucket.attempts[0];
      const locatorRecipeCandidate = evidenceRow?.locatorRecipeId
        ? locatorRecipeById.get(evidenceRow.locatorRecipeId) || null
        : null;
      const locatorCompatibility = evidenceRow?.locatorRecipeId
        ? locatorRecipeOccurrenceCompatibility({
          actionEvidence: evidenceRow,
          locatorRecipe: locatorRecipeCandidate,
          scope,
        })
        : null;
      const locatorRecipe = locatorCompatibility?.compatible === true
        ? locatorRecipeCandidate
        : null;
      if (locatorCompatibility && !locatorCompatibility.compatible) {
        diagnostics.push({
          code: 'locator_recipe_occurrence_mismatch_isolated',
          severity: 'warning',
          nonBlocking: true,
          detail: 'A persisted locator recipe did not prove the same scoped authored occurrence as its ActionEvidence row, so it remains diagnostic evidence and was not attached to executable ReplayIR.',
          ...scope,
          actionEvidenceId: evidenceRow.id || null,
          locatorRecipeId: evidenceRow.locatorRecipeId || null,
          locatorRunResultId: locatorRecipeCandidate?.runResultId || null,
          locatorTestCaseId: locatorRecipeCandidate?.testCaseId || null,
          contractStepId: bucket.identity.contractStepId || null,
          actionOccurrenceId: bucket.identity.actionOccurrenceId || null,
          mismatchFields: locatorCompatibility.mismatchFields,
        });
      }
      applyPersistedOccurrenceEvidence({
        step,
        identity: bucket.identity,
        scope,
        actionEvidence: evidenceRow,
        locatorRecipe,
      });
      step.authored = true;
      step.evidenceOnly = false;
      if (step.origin === 'unmatched_runtime_evidence') step.origin = 'persisted_occurrence_match';
      const resolve = step.target ? resolveByRef.get(step.target) || null : null;
      if (resolve) {
        applyPersistedOccurrenceEvidence({
          step: resolve,
          identity: bucket.identity,
          scope,
          actionEvidence: evidenceRow,
          locatorRecipe,
        });
        resolve.authored = true;
        resolve.evidenceOnly = false;
        if (resolve.origin === 'unmatched_runtime_evidence') resolve.origin = 'persisted_occurrence_match';
      }
    });

    const matched = keptSteps.length === expectedStepCount;
    if (matched) matchedAuthoredOccurrenceCount += 1;
    else {
      missingAuthoredOccurrenceCount += 1;
      diagnostics.push({
        code: 'authored_occurrence_missing_from_replayir',
        severity: 'warning',
        nonBlocking: true,
        detail: 'Persisted authored occurrence evidence did not have exactly one corresponding ReplayIR occurrence. The diagnostic is surfaced without blocking output generation.',
        ...scope,
        contractStepId: bucket.identity.contractStepId || null,
        actionOccurrenceId: bucket.identity.actionOccurrenceId || null,
        authoredActionId: bucket.identity.authoredActionId || null,
        expectedReplayStepCount: expectedStepCount,
        actualReplayStepCount: keptSteps.length,
      });
    }
    occurrences.push({
      contractStepId: bucket.identity.contractStepId || null,
      actionOccurrenceId: bucket.identity.actionOccurrenceId || null,
      authoredActionId: bucket.identity.authoredActionId || null,
      occurrenceOrdinal: bucket.identity.occurrenceOrdinal ?? null,
      occurrenceKey: bucket.identity.occurrenceKey || null,
      operation: bucket.operation,
      persistedAttemptCount: bucket.attempts.length,
      expectedReplayStepCount: expectedStepCount,
      actualReplayStepCount: keptSteps.length,
      matched,
    });
  }

  const expectedKeys = new Set(expected.groups.keys());
  for (const [key, steps] of replayByKey.entries()) {
    if (expectedKeys.has(key)) continue;
    for (const step of steps) {
      const resolve = step.target ? resolveByRef.get(step.target) || null : null;
      demoteReplayEvidenceStep(step, resolve, 'unmatched_runtime_evidence');
      diagnostics.push(occurrenceDiagnostic(
        'replay_occurrence_without_persisted_evidence',
        'A runtime ReplayIR occurrence has no exact persisted occurrence identity in this run and test case; it remains diagnostic-only evidence.',
        scope,
        step,
      ));
    }
  }

  const report = {
    schemaVersion: OCCURRENCE_PARITY_SCHEMA_VERSION,
    ...scope,
    satisfied: missingAuthoredOccurrenceCount === 0 && duplicateReplayOccurrenceCount === 0,
    expectedAuthoredOccurrenceCount: expected.groups.size,
    matchedAuthoredOccurrenceCount,
    missingAuthoredOccurrenceCount,
    duplicateReplayOccurrenceCount,
    retryOrDiagnosticAttemptCount: diagnostics.filter((item) => /retry|duplicate|diagnostic/.test(item.code)).length,
    foreignOccurrenceCount: diagnostics.filter((item) => /foreign/.test(item.code)).length,
    occurrences,
  };
  ir.authoredOccurrenceParity = report;
  if (diagnostics.length) {
    ir.runtimeEvidence = [...asArray(ir.runtimeEvidence), ...diagnostics.map((item) => clone(item))];
  }
  emit.findings = [...asArray(emit.findings), ...diagnostics];
  return { report, diagnostics };
}

function enforceReplayIrCompletionInvariant({ emit, evidence }) {
  const ledger = evidence && evidence.ledger ? evidence.ledger : {};
  const evidenceGaps = ledgerGapsFromEvidence(ledger);
  // Evidence gaps describe how the live run was observed; they do not remove
  // authored operations from generated code. ReplayIR contract reconciliation
  // supplies missing action/locator nodes, so keep ledger gaps as warnings and
  // reserve blocking gaps for actual structural emitter failures.
  const allGaps = dedupeGaps(asArray(emit && emit.gaps));
  const evidenceWarnings = dedupeGaps(evidenceGaps).map((item) => ({
    ...item,
    severity: 'warning',
    nonBlocking: true,
  }));
  const evidenceLocatorWarnings = evidenceWarnings.filter(isLocatorOnlyGap);
  if (hasLegacyInertGap({ gaps: allGaps }) && !allGaps.some((item) => item.code === 'legacy_inert_not_exportable')) {
    allGaps.push(gap(
      'legacy_inert_not_exportable',
      'ReplayIR contains legacy_inert evidence. Old or inert trail entries must be recaptured through the capture-first kernel.',
      { testCaseId: ledger.testCaseId || null },
    ));
  }
  const ir = emit && emit.ir ? emit.ir : null;
  const locatorGaps = allGaps.filter(isLocatorOnlyGap);
  const blockingGaps = allGaps.filter((item) => !isLocatorOnlyGap(item));
  const locatorMissing = Number(ledger.missingLocatorCount || 0);
  const requiredGuesses = Math.max(locatorMissing, locatorGaps.length ? 1 : 0);
  const guesses = guessedResolveCount(ir);
  const locatorGapsCovered = requiredGuesses === 0 || guesses >= requiredGuesses;
  const emitHasOnlyCoveredLocatorGaps = emit && emit.complete === false
    && asArray(emit.gaps).length > 0
    && asArray(emit.gaps).every(isLocatorOnlyGap)
    && locatorGapsCovered;
  const emitComplete = !!emit && (emit.complete !== false || emitHasOnlyCoveredLocatorGaps);
  const complete = blockingGaps.length === 0
    && locatorGapsCovered
    && emitComplete;
  const locatorWarnings = locatorGapsCovered ? locatorGaps.map((item) => ({
    ...item,
    severity: 'warning',
    nonBlocking: true,
    message: item.message || item.detail || 'QAAI generated an editable guessed locator because durable DOM locator evidence was unavailable.',
  })) : [];
  return {
    ir,
    findings: [...asArray(emit && emit.findings), ...evidenceWarnings, ...locatorWarnings],
    complete,
    gaps: blockingGaps,
    nonBlockingLocatorGaps: [...evidenceLocatorWarnings, ...locatorWarnings],
    evidenceCompletenessLedger: ledger,
    evidenceBuiltReplayIr: {
      schemaVersion: SCHEMA_VERSION,
      evidenceStatus: ledger.evidenceStatus || 'capture_failed',
      actionEvidenceCount: ledger.actionEvidenceCount || 0,
      assertionEvidenceCount: ledger.assertionEvidenceCount || 0,
      missingEvidenceCount: ledger.missingEvidenceCount || 0,
      missingLocatorCount: locatorMissing,
      guessedLocatorCount: guesses,
      nonBlockingLocatorGapCount: evidenceLocatorWarnings.length + locatorWarnings.length,
    },
  };
}

function buildEvidenceBuiltReplayIR({
  replayInput = {},
  evidenceInput = {},
} = {}) {
  const evidence = actionEvidenceRecorder.buildEvidenceFromTrail(evidenceInput);
  const canonicalization = canonicalizeReplayTrailOccurrences({
    trail: replayInput.trail,
    runResultId: evidence.runResultId || evidenceInput.runResultId,
    testCaseId: evidence.testCaseId || evidenceInput.testCase?.id || replayInput.caseId,
  });
  const waitContractIndex = buildAuthoredWaitContractIndex({
    trail: asArray(evidenceInput.trail).length ? evidenceInput.trail : replayInput.trail,
    scope: canonicalization.scope,
  });
  attachAuthoredWaitContractsToEvidence(evidence, waitContractIndex);
  const platformGaps = [
    ...asArray(replayInput.platformGaps),
    ...ledgerGapsFromEvidence(evidence.ledger),
  ];
  const emit = replayEmitter.buildReplayIR({
    ...replayInput,
    trail: canonicalization.trail,
    platformGaps,
  });
  const occurrenceParity = applyAuthoredOccurrenceParityInvariant({
    emit,
    evidence,
    canonicalization,
  });
  const authoredWaitPropagation = applyAuthoredWaitContractsToReplayIr({
    emit,
    waitIndex: waitContractIndex,
  });
  const normalized = enforceReplayIrCompletionInvariant({ emit, evidence });
  normalized.authoredOccurrenceParity = occurrenceParity.report;
  normalized.authoredWaitContractPropagation = authoredWaitPropagation.report;
  normalized.evidenceBuiltReplayIr.authoredOccurrenceParity = {
    schemaVersion: occurrenceParity.report.schemaVersion,
    satisfied: occurrenceParity.report.satisfied,
    expectedAuthoredOccurrenceCount: occurrenceParity.report.expectedAuthoredOccurrenceCount,
    matchedAuthoredOccurrenceCount: occurrenceParity.report.matchedAuthoredOccurrenceCount,
    missingAuthoredOccurrenceCount: occurrenceParity.report.missingAuthoredOccurrenceCount,
    duplicateReplayOccurrenceCount: occurrenceParity.report.duplicateReplayOccurrenceCount,
    retryOrDiagnosticAttemptCount: occurrenceParity.report.retryOrDiagnosticAttemptCount,
    foreignOccurrenceCount: occurrenceParity.report.foreignOccurrenceCount,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    emit: normalized,
    evidence,
  };
}

function assertCompletedRunReplayIrInvariant({ envelope, statuses = {} } = {}) {
  if (!featureFlags.enabled('strictReplayIrCompletionEnabled', true)) return true;
  const overallRunStatus = statuses.overallRunStatus || null;
  if (overallRunStatus !== 'complete') return true;
  const gaps = asArray(envelope && envelope.gaps);
  if (!envelope || envelope.complete !== true || gaps.length > 0) {
    const err = new Error('Completed run cannot persist incomplete ReplayIR evidence.');
    err.code = 'COMPLETED_RUN_REPLAYIR_INCOMPLETE';
    err.gaps = gaps;
    throw err;
  }
  return true;
}

module.exports = {
  SCHEMA_VERSION,
  OCCURRENCE_PARITY_SCHEMA_VERSION,
  ledgerGapsFromEvidence,
  canonicalizeReplayTrailOccurrences,
  buildAuthoredWaitContractIndex,
  applyAuthoredWaitContractsToReplayIr,
  applyAuthoredOccurrenceParityInvariant,
  enforceReplayIrCompletionInvariant,
  buildEvidenceBuiltReplayIR,
  assertCompletedRunReplayIrInvariant,
  isLocatorOnlyGap,
};
