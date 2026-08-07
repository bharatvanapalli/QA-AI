'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

function occurrenceCount(source, signature) {
  if (!signature) throw new TypeError('Runtime transform signatures must be non-empty.');
  let count = 0;
  let offset = 0;
  while (offset <= source.length) {
    const found = source.indexOf(signature, offset);
    if (found < 0) break;
    count += 1;
    offset = found + signature.length;
  }
  return count;
}

function assertSingleSignature(source, label, signature) {
  const actual = occurrenceCount(source, signature);
  if (actual !== 1) {
    throw new Error(`CONDUCTOR_RUNTIME_TRANSFORM_SIGNATURE_MISMATCH:${label}:expected=1:actual=${actual}`);
  }
}

function replaceExactlyOnce(source, label, signature, replacement) {
  assertSingleSignature(source, label, signature);
  // Use a callback so replacement source is always literal. String
  // replacement would interpret compiler text such as "$&" as a special
  // substitution token and silently corrupt the generated Conductor source.
  return source.replace(signature, () => replacement);
}

function replaceSectionExactlyOnce(source, label, startSignature, endSignature, replacement) {
  assertSingleSignature(source, `${label}:start`, startSignature);
  assertSingleSignature(source, `${label}:end`, endSignature);
  const start = source.indexOf(startSignature);
  const end = source.indexOf(endSignature);
  if (end <= start) {
    throw new Error(`CONDUCTOR_RUNTIME_TRANSFORM_SIGNATURE_ORDER:${label}:end_before_start`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function sourceBlock(factory) {
  const rendered = Function.prototype.toString.call(factory);
  const open = rendered.indexOf('/*');
  const close = rendered.lastIndexOf('*/');
  if (open < 0 || close <= open) throw new Error('Invalid runtime source block.');
  return rendered.slice(open + 2, close).replace(/^\r?\n/, '').replace(/\r\n/g, '\n');
}

function normalizeOccurrencePart(value, fallback = 'action') {
  const normalized = String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9:._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function operationForTool(toolName) {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (/navigate|goto|open_url/.test(normalized)) return 'navigate';
  if (/fill_form|type|fill/.test(normalized)) return 'fill';
  if (/select/.test(normalized)) return 'select';
  if (/click|tap/.test(normalized)) return 'click';
  if (/hover/.test(normalized)) return 'hover';
  if (/press_key|keyboard/.test(normalized)) return 'keypress';
  if (/upload/.test(normalized)) return 'upload';
  return normalizeOccurrencePart(normalized.replace(/^browser_/, ''), 'action');
}

function actionOccurrenceReuseKey({
  caseId = 'case',
  contractStepId,
  authoredActionId = null,
  authoredActionIdSource = null,
  authoredStepIndex = null,
  stepIndex = null,
  toolName = null,
  operation = null,
} = {}) {
  const rawStepIndex = authoredStepIndex == null ? stepIndex : authoredStepIndex;
  const stableStepIndex = rawStepIndex == null || rawStepIndex === '' || !Number.isFinite(Number(rawStepIndex))
    ? 'unknown'
    : Math.max(0, Math.floor(Number(rawStepIndex)));
  const hasExplicitAuthoredId = !!authoredActionId && authoredActionIdSource !== 'allocator_fallback';
  const authoredOccurrence = hasExplicitAuthoredId
    ? `authored:${normalizeOccurrencePart(authoredActionId, 'action')}`
    : `step:${stableStepIndex}`;
  return [
    normalizeOccurrencePart(caseId, 'case'),
    normalizeOccurrencePart(contractStepId, `runtime-step-${stableStepIndex === 'unknown' ? 1 : stableStepIndex + 1}`),
    normalizeOccurrencePart(operation || operationForTool(toolName), 'action'),
    authoredOccurrence,
  ].join(':');
}

function createActionOccurrenceAllocator({ caseId = 'case' } = {}) {
  const stableCaseId = normalizeOccurrencePart(caseId, 'case');
  const ordinals = new Map();
  let sequenceIndex = 0;
  return function allocateActionOccurrence(input = {}) {
    const stepIndex = Number.isFinite(Number(input.stepIndex)) ? Math.max(0, Math.floor(Number(input.stepIndex))) : 0;
    const contractStepId = normalizeOccurrencePart(
      input.contractStepId || input.authoredStepId || `runtime-step-${stepIndex + 1}`,
      `runtime-step-${stepIndex + 1}`,
    );
    const operation = normalizeOccurrencePart(input.operation || operationForTool(input.toolName), 'action');
    const ordinalKey = `${contractStepId}:${operation}`;
    const occurrenceOrdinal = (ordinals.get(ordinalKey) || 0) + 1;
    ordinals.set(ordinalKey, occurrenceOrdinal);
    sequenceIndex += 1;
    const actionOccurrenceId = `${contractStepId}:${operation}:${occurrenceOrdinal}`;
    const suppliedAuthoredActionId = String(input.authoredActionId == null ? '' : input.authoredActionId).trim()
      ? normalizeOccurrencePart(input.authoredActionId, `${contractStepId}:action:${occurrenceOrdinal}`)
      : null;
    const authoredActionId = suppliedAuthoredActionId
      || normalizeOccurrencePart(
        `${contractStepId}:action:${occurrenceOrdinal}`,
        `${contractStepId}:action:${occurrenceOrdinal}`,
      );
    const actionIdentity = {
      schemaVersion: 'qaai-action-identity-v1',
      caseId: stableCaseId,
      contractStepId,
      sourceContractStepId: input.sourceContractStepId || null,
      actionOccurrenceId,
      sourceActionOccurrenceId: input.sourceActionOccurrenceId || null,
      authoredActionId,
      authoredActionIdSource: suppliedAuthoredActionId ? 'authored_contract' : 'allocator_fallback',
      authoredStepIndex: stepIndex,
      sequenceIndex,
      occurrenceOrdinal,
      occurrenceKey: `${stableCaseId}:${contractStepId}:${occurrenceOrdinal}:${operation}`,
      toolUseId: input.toolUseId || actionOccurrenceId,
      toolName: input.toolName || null,
      operation,
    };
    return { ...actionIdentity, actionIdentity };
  };
}

function actionDispatchIdentity(entry = {}, options = {}) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const nested = source.actionIdentity && typeof source.actionIdentity === 'object' ? source.actionIdentity : {};
  const actionOccurrenceId = source.actionOccurrenceId || nested.actionOccurrenceId || null;
  if (!actionOccurrenceId) return { ...options, authoredAction: false };
  const identity = {
    schemaVersion: nested.schemaVersion || source.schemaVersion || 'qaai-action-identity-v1',
    caseId: source.caseId || nested.caseId || null,
    contractStepId: source.contractStepId || nested.contractStepId || null,
    sourceContractStepId: source.sourceContractStepId || nested.sourceContractStepId || null,
    actionOccurrenceId,
    sourceActionOccurrenceId: source.sourceActionOccurrenceId || nested.sourceActionOccurrenceId || null,
    authoredActionId: source.authoredActionId || nested.authoredActionId || null,
    sequenceIndex: source.sequenceIndex == null ? nested.sequenceIndex : source.sequenceIndex,
    occurrenceOrdinal: source.occurrenceOrdinal == null ? nested.occurrenceOrdinal : source.occurrenceOrdinal,
    occurrenceKey: source.occurrenceKey || nested.occurrenceKey || null,
    toolUseId: source.toolUseId || nested.toolUseId || null,
    toolName: source.tool || source.toolName || nested.toolName || null,
    operation: source.operation || nested.operation || operationForTool(source.tool || source.toolName || nested.toolName),
  };
  const authoredAction = options.authoredAction !== false;
  return {
    ...options,
    ...identity,
    authoredAction,
    enforceExactlyOnce: options.enforceExactlyOnce === true
      || (authoredAction && options.enforceExactlyOnce !== false),
    mutationPhaseId: options.mutationPhaseId || identity.operation || 'action',
    actionIdentity: identity,
    runBinding: { ...(options.runBinding || {}), ...identity },
    captureBinding: { ...(options.captureBinding || {}), ...identity },
  };
}

const ACTION_OCCURRENCE_HELPERS = [
  normalizeOccurrencePart,
  operationForTool,
  actionOccurrenceReuseKey,
  createActionOccurrenceAllocator,
  actionDispatchIdentity,
].map((fn) => Function.prototype.toString.call(fn)).join('\n\n');

const ACTION_OCCURRENCE_CASE_RUNTIME = sourceBlock(function actionOccurrenceCaseRuntime() {/*
  const actionTrail = [];
  const allocateActionOccurrence = createActionOccurrenceAllocator({ caseId: tc.id });
  const deferredActionOccurrences = new Map();
  const deferActionOccurrence = (identity) => {
    if (!identity?.actionOccurrenceId) return identity;
    deferredActionOccurrences.set(actionOccurrenceReuseKey(identity), identity);
    return identity;
  };
  const identityForNewActionOccurrence = ({ toolName, args = {}, stepIndex = currentStepIndex, sourceActionOccurrenceId = null, sourceContractStepId = null, toolUseId = null, reuseDeferred = false } = {}) => {
    const metadata = requireContractMetadataForTool(toolName, args, stepIndex);
    const metadataAuthoredActionId = metadata.authoredActionId || metadata.actionIdentity?.authoredActionId || null;
    const reuseKey = actionOccurrenceReuseKey({
      caseId: tc.id,
      contractStepId: metadata.contractStepId,
      authoredActionId: metadataAuthoredActionId,
      authoredActionIdSource: metadataAuthoredActionId ? 'authored_contract' : 'allocator_fallback',
      authoredStepIndex: stepIndex,
      toolName,
    });
    if (reuseDeferred && deferredActionOccurrences.has(reuseKey)) {
      const deferred = deferredActionOccurrences.get(reuseKey);
      deferredActionOccurrences.delete(reuseKey);
      return deferred;
    }
    return allocateActionOccurrence({
      caseId: tc.id,
      contractStepId: metadata.contractStepId,
      authoredActionId: metadata.authoredActionId || metadata.actionIdentity?.authoredActionId || null,
      sourceContractStepId: sourceContractStepId || metadata.sourceContractStepId || null,
      sourceActionOccurrenceId,
      toolUseId,
      toolName,
      operation: operationForTool(toolName),
      stepIndex,
    });
  };
  const ensureTrailActionOccurrence = (entry, { toolName = null, args = null, stepIndex = null, sourceActionOccurrenceId = null, sourceContractStepId = null } = {}) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (entry.actionOccurrenceId && entry.actionIdentity) return entry;
    Object.assign(entry, identityForNewActionOccurrence({
      toolName: toolName || entry.tool || entry.toolName,
      args: args || entry.args || {},
      stepIndex: stepIndex == null ? entry.stepIndex : stepIndex,
      sourceActionOccurrenceId,
      sourceContractStepId,
      toolUseId: entry.toolUseId || null,
      reuseDeferred: true,
    }));
    return entry;
  };
*/});

const ADAPTIVE_VALIDATION_WRAPPER = sourceBlock(function adaptiveValidationWrapper() {/*
  let lastAdaptiveValidationObservation = null;
  const validateSnapshotSinglePass = async (options = {}) => {
    const validationStep = options.step || approvedSteps[currentStepIndex] || null;
    const validationKind = options.kind
      || validationStep?.verify?.kind
      || validationStep?.operationCheck?.kind
      || validationStep?.expectedKind
      || 'assertion';
    lastAdaptiveValidationObservation = await validateSnapshotAdaptivePolicy({
      ...options,
      cachedSnapshot: options.cachedSnapshot == null ? cachedSnapshotText() : options.cachedSnapshot,
      refreshSnapshot: freshValidationSnapshot,
      validationContract: options.validationContract || adaptiveValidationContractForStep(validationStep, validationKind),
      isUsableSnapshot: options.isUsableSnapshot || ((text) => mcp.isSnapshotText(String(text || ''))),
    });
    return lastAdaptiveValidationObservation;
  };
*/});

const TYPED_ASSERTION_CHANNEL = sourceBlock(function typedAssertionChannel() {/*
    if (typedVerify && typeof typedVerify === 'object' && typedVerify.kind) {
      lastAdaptiveValidationObservation = null;
      const primitiveResult = await evaluateTypedExpectation({ verify: typedVerify, toolName, step: _stepForVerify });
      const status = primitiveResult.status === 'pass' ? 'pass'
        : primitiveResult.status === 'skipped' ? 'skipped' : 'blocked';
      const typedKindName = String(typedVerify.kind || '').toLowerCase();
      const attachedAssertion = isAdaptiveTypedAssertionKind(typedKindName);
      const adaptiveEvidence = attachedAssertion ? lastAdaptiveValidationObservation : null;
      const evidenceUnavailable = attachedAssertion && adaptiveEvidence?.qaaiEvidenceError === true;
      const matchedOut = evidenceUnavailable ? null
        : status === 'pass' ? true : status === 'skipped' ? null : false;
      const observationOnly = isObservationOnlyVerifyKind(typedKindName);
      const authoredBlocking = authoredAssertionBlocksStep(_stepForVerify);
      const operationRequired = status === 'blocked'
        && !observationOnly
        && !attachedAssertion
        && authoredBlocking
        && !evidenceUnavailable;
      const reportStatus = evidenceUnavailable
        ? 'skipped'
        : status === 'blocked' && !operationRequired ? 'warning' : status;
      const evidence = evidenceUnavailable
        ? `QAAI could not obtain stable browser evidence after bounded retries (${adaptiveEvidence?.reason || 'qaai_validation_snapshot_unavailable'}).`
        : (primitiveResult.evidence || '');
      const record = {
        status: reportStatus,
        matched: matchedOut,
        assertion: attachedAssertion ? contract.expected : null,
        assertionId: contract.oracleRef || trailEntry.contractStepId || null,
        reason: evidenceUnavailable
          ? (adaptiveEvidence?.reason || 'qaai_validation_snapshot_unavailable')
          : (primitiveResult.reason || 'typed_verify'),
        evidence,
        args: { verify: typedVerify },
        kind: attachedAssertion ? 'oracle' : 'operation_check',
        required: operationRequired,
        qaaiEvidenceError: evidenceUnavailable,
      };
      trailEntry.stepExpectation = {
        expected: contract.expected,
        expectedKind: typedVerify.kind,
        checked: !evidenceUnavailable,
        reason: record.reason,
      };
      if (attachedAssertion) {
        const channel = typedKindName === 'url' ? 'URL'
          : typedKindName === 'text' ? 'UI_TEXT' : 'UI_ROLE';
        const stepAssertion = publishStepAssertion({
          status: reportStatus === 'pass' ? 'pass' : reportStatus === 'skipped' ? 'skipped' : 'fail',
          checked: primitiveResult.checked === true && !evidenceUnavailable,
          matched: matchedOut,
          reason: record.reason,
          evidence,
          channel,
          assertion: { kind: typedKindName, expected: contract.expected, verify: typedVerify },
        });
        assertionCheckResults.push(record);
        trailEntry.stepAssertion = stepAssertion;
        trailEntry.stepAssertionResult = record;
        trailEntry.stepOperationCheck = null;
        trailEntry.operationCheckResult = null;
      } else {
        const stepOperationCheck = publishStepOperationCheck({
          status: reportStatus,
          checked: primitiveResult.checked === true,
          matched: matchedOut,
          reason: record.reason,
          evidence,
          channel: 'TYPED_VERIFY',
          kind: typedVerify.kind,
          required: operationRequired,
        });
        trailEntry.stepOperationCheck = stepOperationCheck;
        trailEntry.operationCheckResult = record;
      }
      trailEntry.op = trailEntry.op || 'act';
      send({
        type: 'browser.action',
        runId,
        tcId: tc.id,
        tool: attachedAssertion ? 'assertion_check' : 'operation_check',
        args: { verify: typedVerify },
        syntheticAssertion: attachedAssertion,
        syntheticOperationCheck: !attachedAssertion,
        stepIndex: stepOrdinal,
        expected: contract.expected,
        matched: matchedOut,
        status: reportStatus,
        reason: record.reason,
        evidence,
        narration: reportStatus === 'pass'
          ? `Step ${stepOrdinal} verified (${typedVerify.kind}). ${evidence}`
          : reportStatus === 'skipped'
            ? `Step ${stepOrdinal} ${typedVerify.kind} evidence was unavailable after bounded retries; recorded as a QAAI uncheckable result, not a product failure.`
          : reportStatus === 'warning'
              ? `Step ${stepOrdinal} ${typedVerify.kind} assertion did NOT match: ${evidence} The central continuation policy records the failed assertion and continues independent work.`
              : `Step ${stepOrdinal} ${typedVerify.kind} assertion did NOT match and is authored as required for continuation; dependent steps will be stopped.`,
      });
      return record;
    }
*/});

const SEAL_ASSERTION_CLASSIFICATION = sourceBlock(function sealAssertionClassification() {/*
    const isValidation = originalRow.assertionStep === true
      || /assert|verify|validate|expect|confirm/.test(actionText)
      || Boolean(assertionResult);
    const assertionNotEvaluated = originalRow.assertionStep === true && !assertionResult;
    const assertionMismatch = assertionResult?.matched === false
      || (originalRow.assertionStep !== true && isValidation && operationResult?.matched === false);
    const assertionUncheckable = assertionNotEvaluated
      || (!!assertionResult && assertionResult.matched == null);
    const assertionMatched = assertionResult?.matched === true
      || (originalRow.assertionStep !== true && isValidation && operationResult?.matched === true);
    const actionEvidence = assertionResult
      ? (originalRow.evidence || null)
      : (operationResult || originalRow.evidence || null);

*/});

const NO_RUNNABLE_PROMPT = sourceBlock(function noRunnablePrompt() {/*
  const currentRequiredStepIndex = approvedSteps.length && currentStepIndex < approvedSteps.length
    ? Math.max(currentStepIndex, 0)
    : -1;
  const currentRequiredStep = currentRequiredStepIndex >= 0
    ? approvedSteps[currentRequiredStepIndex]
    : null;
  const journalExecutedCount = stepResults.filter((row) => row?.actionOutcome
    && row.actionOutcome !== 'not_executed').length;
  const journalNotExecutedCount = stepResults.filter((row) => row?.actionOutcome === 'not_executed'
    || row?.dependencySkipped === true).length;
  const noRunnableJournalTruth = `(none - no approved step is runnable; journal: ${stepResults.length} planned, ${journalExecutedCount} executed, ${journalNotExecutedCount} not executed)`;
  const currentRequiredStepBlock = [
    `## Current required approved step`,
    currentRequiredStep
      ? `Step ${currentRequiredStepIndex + 1} of ${approvedSteps.length}:\n${JSON.stringify(serialiseStepsForPrompt([currentRequiredStep])[0] || currentRequiredStep, null, 2)}`
      : noRunnableJournalTruth,
    ``,
    currentRequiredStep
      ? `Only reason about and execute this current step. Do not discuss, summarize, plan, narrate, validate, or attempt later steps until the backend reports this step complete and asks for the next one.`
      : `Do not claim that every planned step executed or resolved. The execution journal is authoritative for executed, failed, uncheckable, and dependency-skipped outcomes.`,
  ].join('\n');
  const perCaseClosingInstruction = currentRequiredStep
    ? `Complete only the current required step above, then wait for the next backend prompt. Do not verify declared assertions or call final_verdict while approved steps are still pending.`
    : (verdictMode === 'mechanical_v1'
        ? `No approved step remains runnable. Preserve journal truth, verify only declared assertions that are mechanically checkable from the current state, then call final_verdict without describing unexecuted steps as resolved.`
        : `No approved step remains runnable. Preserve journal truth and do not describe dependency-skipped or unexecuted steps as completed.`);

*/});

const PRE_RATIFICATION_RECONCILIATION = sourceBlock(function preRatificationReconciliation() {/*
  if (isMechanical && !caseFatalError && !incompleteExecution) {
    const stepOracleRepair = reconcileRecordedOutcomesWithStepOracle({
      declared: declaredAssertions,
      recorded: v2RecordedFinal,
      stepResults: stepResults || [],
      approvedSteps: approvedSteps || [],
    });
    if (stepOracleRepair.changed) {
      v2RecordedFinal = stepOracleRepair.recorded;
      send({
        type: 'agent.phase.log',
        phase: 'conductor',
        level: 'info',
        message: `   Step oracle reconciled ${stepOracleRepair.repairs.length} assertion outcome(s) before post-loop ratification.`,
        tcId: tc.id,
      });
    }

    try {
      const ratified = await postLoopRatify({
        mcp,
        mcpSession,
        declared: declaredAssertions,
        recorded: v2RecordedFinal,
        currentUrl: mcpSession?.currentUrl || null,
        visitedUrls: mcpSession?.visitedUrls || new Set(),
        send,
        tcId: tc.id,
        // Settle the page and retry transient uncheckables before the verdict
        // ladder turns them into needs_human. postLoopRatify owns the retry cap.
        exhaustive: !!profile?.exhaustiveRatify,
      });
      v2RecordedFinal = ratified.recorded;
    } catch (ratifyErr) {
      replayCertificationGaps.push({
        code: 'ratification_failed',
        where: tc.id,
        detail: `post-loop ratification failed before all assertion evidence could be repaired: ${ratifyErr.message}`,
      });
      send({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `   post-loop ratification failed (${ratifyErr.message}); QAAI will hold certified export for this case instead of trusting unrepaired assertion evidence.`,
        tcId: tc.id,
      });
    }

*/});

const GENERIC_PAGE_READY_PROBE = sourceBlock(function genericPageReadyProbe() {/*
    if (normalized === 'page_ready') {
      const hasPageStructure = snapshotHasRole(snapshotText, [
        'main', 'form', 'heading', 'textbox', 'button', 'link', 'table', 'navigation',
      ]);
      const matched = !!snapshotText && hasPageStructure;
      return {
        matched,
        reason: matched ? 'generic_page_structure_observed' : 'generic_page_structure_not_observed',
        evidence: matched
          ? 'A usable page structure is present. Narrative step prose was not used as a visible-text requirement.'
          : 'A usable page structure was not available from the current browser evidence.',
      };
    }
*/});

const ADAPTIVE_PAGE_READY_RESOLVER = sourceBlock(function adaptivePageReadyResolver() {/*
async function resolvePageReadyProbe({
  cachedProbe = null,
  refreshProbe,
  timeoutMs = 20_000,
  pollIntervalMs = 250,
  stableObservations = 2,
  qaaiNow = Date.now,
  qaaiSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let probe = cachedProbe || {
    matched: false,
    reason: 'page_state_not_observed',
    evidence: 'No cached page state was available.',
  };
  const startedAt = qaaiNow();
  const deadline = startedAt + Math.max(0, Number(timeoutMs) || 0);
  let attempts = 0;
  let previousKey = null;
  let consecutiveEquivalent = 0;
  const observeProbe = (candidate) => {
    probe = candidate || probe;
    const key = probe?.matched === true
      ? String(probe.reason || 'page_ready') + '|' + String(probe.evidence || '')
      : null;
    consecutiveEquivalent = key && key === previousKey ? consecutiveEquivalent + 1 : (key ? 1 : 0);
    previousKey = key;
    return key && consecutiveEquivalent >= Math.max(1, Number(stableObservations) || 2);
  };
  if (observeProbe(probe)) {
    return { matched: true, probe, source: 'stable_cached', attempts, consecutiveEquivalent };
  }
  if (typeof refreshProbe !== 'function') {
    return {
      matched: false,
      probe,
      source: 'qaai_transition_evidence_inconclusive',
      attempts,
      consecutiveEquivalent,
      qaaiEvidenceError: true,
    };
  }
  while (qaaiNow() <= deadline) {
    attempts += 1;
    let refreshed = null;
    try { refreshed = await refreshProbe({ attempt: attempts, remainingMs: Math.max(1, deadline - qaaiNow()) }); } catch (_) {}
    if (observeProbe(refreshed)) {
      return { matched: true, probe, source: 'stable_fresh', attempts, consecutiveEquivalent };
    }
    const remainingMs = deadline - qaaiNow();
    if (remainingMs <= 0) break;
    await qaaiSleep(Math.min(Math.max(1, Number(pollIntervalMs) || 250), remainingMs));
  }
  return {
    matched: false,
    probe,
    source: 'qaai_transition_evidence_inconclusive',
    attempts,
    consecutiveEquivalent,
    qaaiEvidenceError: true,
  };
}
*/});

const GENERIC_PAGE_READY_OPERATION = sourceBlock(function genericPageReadyOperation() {/*
    if (kind === 'page_ready') {
      const step = approvedSteps[currentStepIndex] || {};
      const transitionWaitContract = waitContract.buildWaitContract({
        ...step,
        operationCheck: {
          ...(step.operationCheck || {}),
          kind: 'page_ready',
        },
      });
      const transition = await mcp.awaitPageTransitionObservation(mcpSession, {
        waitContract: transitionWaitContract,
        timeoutMs: Number(transitionWaitContract?.timeoutMs) || waitContract.DEFAULT_TIMEOUTS.navigation,
        pollIntervalMs: Number(transitionWaitContract?.pollIntervalMs) || waitContract.POLL_INTERVAL_MS,
        stableObservations: Number(transitionWaitContract?.stableObservations) || waitContract.STABLE_OBSERVATIONS,
      });
      if (transition?.status === 'confirmed' && transition.matched === true) {
        const signals = Array.isArray(transition.signals) ? transition.signals.join(', ') : 'browser transition';
        return {
          status: 'pass',
          matched: true,
          checked: true,
          reason: 'page_transition_confirmed',
          evidence: 'Browser transition confirmed by stable generic evidence (' + signals + ').',
          transitionEvidence: transition,
        };
      }
      return {
        status: 'blocked',
        matched: false,
        checked: false,
        reason: transition?.reason || 'qaai_transition_evidence_inconclusive',
        evidence: 'QAAI could not obtain stable URL, page-context, or structural transition evidence within the bounded navigation wait. This is an execution-evidence failure, not a website failure.',
        qaaiEvidenceError: true,
        executionError: true,
        failureType: transition?.failureType || 'qaai_transition_evidence_inconclusive',
        transitionEvidence: transition || null,
      };
    }
*/});

const GENERIC_CLICK_KERNEL_ADAPTER = sourceBlock(function genericClickKernelAdapter() {/*
  const runGenericClickKernelStep = async ({ idx, step }) => {
    let genericClickActionIdentity = null;
    const label = kernelStepTarget(step);
    const ensureGenericClickActionIdentity = ({ element = label, target = null } = {}) => {
      if (!genericClickActionIdentity) {
        genericClickActionIdentity = identityForNewActionOccurrence({
          toolName: 'browser_click',
          args: { element, ...(target ? { target } : {}) },
          stepIndex: idx,
        });
      }
      return genericClickActionIdentity;
    };
    const identityForGenericClickChild = ({ toolName, args = {} } = {}) => {
      const parentIdentity = ensureGenericClickActionIdentity({
        element: String(step?.target || step?.element || label || '').trim() || label,
      });
      return identityForNewActionOccurrence({
        toolName,
        args,
        stepIndex: idx,
        sourceActionOccurrenceId: parentIdentity.actionOccurrenceId,
        sourceContractStepId: parentIdentity.contractStepId,
      });
    };
    const transitionSteps = [step];
    const transitionLookaheadEnd = Math.min(approvedSteps.length, idx + 5);
    for (let cursor = idx + 1; cursor < transitionLookaheadEnd; cursor += 1) {
      const candidate = approvedSteps[cursor];
      if (!candidate) break;
      const candidateAction = String(candidate.action || candidate.kind || candidate.type || '')
        .toLowerCase().replace(/[\s_-]+/g, '');
      const internalWait = /^(?:waitforstate|wait|stabilize)$/.test(candidateAction);
      const verifiesEffect = kernelNextStepVerifiesEffect(cursor - 1)
        || /^(?:verify|check|assert|asserttext|assertvisible|assertvalue|confirm|validate)/.test(candidateAction)
        || !!candidate.verify
        || !!candidate.assertion;
      if (internalWait) {
        transitionSteps.push(candidate);
        continue;
      }
      if (verifiesEffect) transitionSteps.push(candidate);
      break;
    }
    const genericClickTransactionIdentity = {
      runId,
      caseId: tc.id,
      stepId: step.id || step.stepId || step.contractStepId || null,
      sequenceIndex: idx,
    };
    const persistedGenericClickTransaction = stepResults[idx]?.actionTransaction
      || await actionTransactionRepository.loadTransaction(genericClickTransactionIdentity);
    if (persistedGenericClickTransaction && stepResults[idx]) {
      stepResults[idx].actionTransaction = persistedGenericClickTransaction;
    }
    return genericClickExecution.executeGenericClick({
      step,
      target: label,
      transitionSteps,
      persistedTransaction: persistedGenericClickTransaction || null,
      transactionContext: {
        runId,
        caseId: tc.id,
        stepId: step.id || step.stepId || step.contractStepId || null,
        sequenceIndex: idx,
      },
      persistTransaction: async (transaction) => {
        if (!stepResults[idx]) throw new Error('journal_step_unavailable');
        const durable = await actionTransactionRepository.saveTransaction(genericClickTransactionIdentity, transaction);
        stepResults[idx].actionTransaction = transaction;
        return { ...durable, memoryRef: `step:${stepResults[idx].stepId || idx + 1}:action-transaction` };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      observe: async ({ phase }) => {
        const source = `generic_click_${phase}`;
        const snapshot = await mcp.snapshot(mcpSession, {
          skipSnapshotStability: true,
          source,
          timeoutMs: 2_000,
        });
        const snapshotText = snapshot?.text || mcp.textOfContent(snapshot?.content) || '';
        if (snapshotText) lastSnapshotText = snapshotText;
        currentPageUrl = (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null;
        return {
          snapshotText,
          url: currentPageUrl,
          title: (mcpSession && mcpSession.currentTitle) || null,
          source,
          fresh: !!snapshotText,
        };
      },
      resolveAuthoritative: async ({
        observation,
        target: authoritativeTarget,
        authoredOptionIntent,
        resolutionTarget,
        semanticResolution: suppliedSemanticResolution,
      }) => {
        if (!observation?.snapshotText || typeof actionLocatorResolver === 'undefined') return null;
        if (!(suppliedSemanticResolution?.ok === true && suppliedSemanticResolution?.ref)
          && typeof resolveClickableControl !== 'function') return null;
        const authoritativeLabel = String(
          authoredOptionIntent?.exactValue || authoritativeTarget || label,
        ).trim() || label;
        const semanticResolution = suppliedSemanticResolution?.ok === true && suppliedSemanticResolution?.ref
          ? suppliedSemanticResolution
          : resolveClickableControl(
              observation.snapshotText,
              resolutionTarget || { authoredLabel: authoritativeLabel },
            );
        if (!semanticResolution?.ok || !semanticResolution.ref) return null;
        const persistedLocatorCandidates = [
          step.actionLocator,
          step.runtimeActionLocator,
          step.locatorEvidenceV2?.actionLocator,
          step.locatorEvidenceV2?.locator,
          step.locatorRecipe?.actionLocator,
          step.evidence?.actionLocator,
        ].filter((candidate) => actionLocatorResolver.isVerifiedActionLocator(candidate));
        for (const actionLocator of persistedLocatorCandidates) {
          const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
          const binding = primary?.captureBinding || primary?.context?.captureBinding || null;
          const boundRef = String(binding?.ref || '').trim();
          let refIsCurrent = false;
          if (boundRef && typeof mcp.buildRefRoleMap === 'function') {
            try { refIsCurrent = mcp.buildRefRoleMap(observation.snapshotText).has(boundRef); } catch (_) {}
          }
          if (binding?.kind === 'mcp_bound_ref'
            && boundRef
            && refIsCurrent
            && boundRef === semanticResolution.ref) {
            return {
              ok: true,
              ref: boundRef,
              candidates: [],
              actionLocator,
              reason: 'authoritative_clickable_control_resolved',
            };
          }
        }
        const currentRef = semanticResolution.ref;
        const toolName = 'browser_click';
        const args = { element: authoritativeLabel, target: currentRef, ref: currentRef };
        const authoredClickIdentity = ensureGenericClickActionIdentity({
          element: authoritativeLabel,
          target: currentRef,
        });
        let resolved = null;
        try {
          resolved = await actionLocatorResolver.resolveVerifiedForTool({
            session: mcpSession,
            toolName,
            args,
            snapshotText: observation.snapshotText,
            pageUrl: observation.url || currentPageUrl || startUrl || null,
            elementLabel: authoritativeLabel,
            ...actionDispatchIdentity(authoredClickIdentity, {
              source: 'generic_click_authoritative_zero_candidate_resolution',
            }),
          });
        } catch (_) {
          resolved = null;
        }
        if (!resolved?.ok || !actionLocatorResolver.isVerifiedActionLocator(resolved.actionLocator)) return null;
        return {
          ok: true,
          ref: currentRef,
          candidates: [],
          actionLocator: resolved.actionLocator,
          reason: 'authoritative_clickable_control_resolved',
        };
      },
      prepareAuthoredOption: async ({ observation, authoredOptionIntent }) => {
        const ownerLabel = String(authoredOptionIntent?.ownerLabel || '').trim();
        if (!ownerLabel || !observation?.snapshotText || typeof resolveClickableControl !== 'function') return false;
        const ownerResolution = resolveClickableControl(observation.snapshotText, {
          authoredLabel: ownerLabel,
          role: 'combobox',
        });
        const ownerRole = String(ownerResolution?.control?.role || '').toLowerCase();
        if (!ownerResolution?.ok || !ownerResolution.ref
          || !['combobox', 'textbox', 'searchbox'].includes(ownerRole)) return false;

        let ownerState = null;
        try {
          const ownerProbeArgs = {
            function: '(element) => { if (!element) return null; const value = "value" in element ? String(element.value || "") : String(element.textContent || "").trim(); const editable = !element.disabled && !element.readOnly && element.getAttribute("aria-disabled") !== "true" && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable); if (editable && element.focus) element.focus(); return { value, editable, focused: document.activeElement === element }; }',
            element: ownerLabel,
            target: ownerResolution.ref,
          };
          const ownerProbeIdentity = identityForGenericClickChild({
            toolName: 'browser_evaluate',
            args: ownerProbeArgs,
          });
          const probe = await mcp.callTool(mcpSession, 'browser_evaluate', ownerProbeArgs,
          actionDispatchIdentity(ownerProbeIdentity, {
            strictActionEvidence: false,
            source: 'generic_click_option_owner_probe',
            telemetry: false,
            authoredAction: false,
            childOperation: true,
          }));
          const text = mcp.textOfContent(probe?.content) || '';
          ownerState = mcp.parseEvaluateReturnValue ? mcp.parseEvaluateReturnValue(text) : null;
          if (typeof ownerState === 'string') {
            try { ownerState = JSON.parse(ownerState); } catch (_) {}
          }
        } catch (_) {
          ownerState = null;
        }
        const query = String(ownerState?.value || '').trim();
        if (ownerState?.editable !== true || !query) return false;

        const queryCharacters = Array.from(query);
        const finalCharacter = queryCharacters[queryCharacters.length - 1];
        if (!finalCharacter) return false;

        const endIdentity = identityForGenericClickChild({
          toolName: 'browser_press_key',
          args: { element: ownerLabel, key: 'End' },
        });
        const movedToEnd = await mcp.callTool(mcpSession, 'browser_press_key', { key: 'End' },
          actionDispatchIdentity(endIdentity, {
            source: 'generic_click_option_query_end',
            authoredAction: false,
            childOperation: true,
          }));
        if (movedToEnd?.isError) return false;

        const backspaceIdentity = identityForGenericClickChild({
          toolName: 'browser_press_key',
          args: { element: ownerLabel, key: 'Backspace' },
        });
        const removedFinalCharacter = await mcp.callTool(mcpSession, 'browser_press_key', { key: 'Backspace' },
          actionDispatchIdentity(backspaceIdentity, {
            source: 'generic_click_option_query_backspace',
            authoredAction: false,
            childOperation: true,
          }));
        if (removedFinalCharacter?.isError) return false;

        const typeIdentity = identityForGenericClickChild({
          toolName: 'browser_type',
          args: { element: ownerLabel, target: ownerResolution.ref, text: finalCharacter },
        });
        const typed = await mcp.callTool(mcpSession, 'browser_type', {
          element: ownerLabel,
          target: ownerResolution.ref,
          text: finalCharacter,
          slowly: true,
        }, actionDispatchIdentity(typeIdentity, {
          source: 'generic_click_option_query_change_restore',
          authoredAction: false,
          childOperation: true,
        }));
        return !typed?.isError;
      },
      dispatch: async ({ attempt, retry, resolution, observation }) => {
        const toolName = 'browser_click';
        const dispatchLabel = String(
          resolution?.authoredOptionIntent?.exactValue || label,
        ).trim() || label;
        const args = { element: dispatchLabel, target: resolution.ref };
        send({
          type: 'browser.action',
          runId,
          tcId: tc.id,
          tool: toolName,
          args: redactArgs(args),
          deterministicKernel: true,
          narration: retry
            ? `Fresh page evidence semantically re-resolved "${dispatchLabel}"; retrying Click once.`
            : deterministicActionEngine.actionNarration({ kind: 'click', label: dispatchLabel }),
        });
        const authoredClickIdentity = ensureGenericClickActionIdentity({
          element: dispatchLabel,
          target: resolution.ref,
        });
        const dispatchLocator = resolution?.actionLocator || null;
        const locatorPrimary = dispatchLocator ? actionLocatorResolver.primaryActionLocator(dispatchLocator) : null;
        const verifiedTarget = actionLocatorResolver.isVerifiedActionLocator(dispatchLocator);
        let result;
        try {
          result = await mcp.callTool(mcpSession, toolName, args, actionDispatchIdentity(authoredClickIdentity, {
            source: retry ? 'generic_click_exact_retry' : 'generic_click_initial_dispatch',
            requireVerifiedTarget: true,
            targetAuthorization: {
              schemaVersion: 'qaai-live-target-authorization-v1',
              status: verifiedTarget ? 'verified' : 'unverified',
              liveMutationAllowed: verifiedTarget,
              diagnosticOnly: locatorPrimary?.diagnosticOnly === true,
              isGuess: locatorPrimary?.guess?.isGuess === true,
              verificationSource: locatorPrimary?.verificationSource || locatorPrimary?.evidenceSource || locatorPrimary?.proof?.source || null,
              reason: verifiedTarget ? 'verified_action_locator' : 'verified_action_locator_required',
            },
          }));
        } catch (error) {
          result = { isError: true, content: [{ type: 'text', text: error.message || String(error) }] };
        }
        const trailEntry = kernelAppendTrail({
          tool: toolName,
          args,
          stepIndex: idx,
          result,
          snapshotBefore: observation.snapshotText,
          narration: retry ? `Retried Click ${dispatchLabel} on the fresh semantic ref` : `Clicked ${dispatchLabel}`,
          actionIdentity: authoredClickIdentity,
        });
        const authoritativeActionLocator = typeof actionLocatorResolver !== 'undefined'
          && actionLocatorResolver.isVerifiedActionLocator(resolution?.actionLocator)
          ? resolution.actionLocator
          : null;
        if (authoritativeActionLocator) {
          trailEntry.actionLocatorPending = authoritativeActionLocator;
          trailEntry.actionLocator = authoritativeActionLocator;
          trailEntry.actionLocatorKernel = {
            status: 'fulfilled_before_dispatch',
            source: authoritativeActionLocator.verificationSource
              || authoritativeActionLocator.evidenceSource
              || authoritativeActionLocator.proof?.source
              || 'authoritative_chromium_cdp',
          };
        } else if (typeof actionLocatorResolver !== 'undefined'
          && actionLocatorResolver.isVerifiedActionLocator(result?.qaaiActionLocator)) {
          trailEntry.actionLocatorPending = result.qaaiActionLocator;
          trailEntry.actionLocator = result.qaaiActionLocator;
          trailEntry.actionLocatorKernel = {
            status: 'fulfilled_by_dispatch_capture',
            source: result.qaaiActionLocator.verificationSource
              || result.qaaiActionLocator.evidenceSource
              || result.qaaiActionLocator.proof?.source
              || null,
          };
        }
        if (retry) {
          trailEntry.kernelRecovery = {
            recovered: !result?.isError,
            strategy: 'fresh_observation_semantic_reresolve',
            attempt,
          };
        }
        currentPageUrl = (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null;
        return { ok: !result?.isError, result, trailEntry };
      },
      proveEffect: async ({ dispatch: dispatched, beforeObservation }) => {
        const verify = step.verify && typeof step.verify === 'object' ? step.verify : null;
        if (verify?.kind && String(verify.kind).toLowerCase() !== 'none') {
          const primitive = await evaluateTypedExpectation({ verify, toolName: 'browser_click', step });
          return { ...primitive, kind: 'operation_check', required: verify.required !== false };
        }
        const operation = step.operationCheck && typeof step.operationCheck === 'object'
          ? step.operationCheck
          : null;
        const operationKind = operation?.kind || step.expectedKind || null;
        if (!operationKind) return null;
        const primitive = await evaluateOperationalPrimitive({
          operationKind,
          expected: operation?.expected || step.expected || null,
          target: operation?.target || label,
          toolName: 'browser_click',
          toolArgs: dispatched?.trailEntry?.args || {},
          trailEntry: dispatched?.trailEntry || null,
          snapshotBeforeAction: beforeObservation?.snapshotText || '',
        });
        return { ...primitive, kind: 'operation_check', required: operation?.required !== false };
      },
      seal: async (outcome) => {
        const record = outcome.record || null;
        let projectedOperationCheck = null;
        const trailEntry = outcome.dispatch?.trailEntry || null;
        const beforeFingerprint = genericClickExecution.compactFingerprint(outcome.beforeFingerprint);
        const afterFingerprint = genericClickExecution.compactFingerprint(outcome.afterFingerprint);
        if (trailEntry) {
          trailEntry.beforeFingerprint = beforeFingerprint;
          trailEntry.afterFingerprint = afterFingerprint;
          trailEntry.pageEffect = outcome.pageEffect || null;
          trailEntry.clickAttemptDiagnostics = outcome.diagnostics;
        }
        if (record) {
          const operationCheck = {
            status: record.matched === true ? 'pass' : (record.status || 'blocked'),
            expected: record.observedState?.expectedState || step.operationCheck?.expected || step.expected || null,
            matched: record.matched === true,
            checked: record.checked === true,
            reason: record.reason || outcome.reason,
            evidence: record.evidence || null,
            kind: step.operationCheck?.kind || step.verify?.kind || 'page_fingerprint_state',
            target: label,
            required: record.required !== false,
            synthetic: true,
            observedState: record.observedState || null,
          };
          projectedOperationCheck = operationCheck;
          stepResults[idx].operationCheck = operationCheck;
          if (trailEntry) {
            trailEntry.operationCheckResult = record;
            trailEntry.stepOperationCheck = operationCheck;
          }
          send({ type: 'step.operationCheck', runId, tcId: tc.id, stepIndex: idx + 1, ...operationCheck });
        }

        const row = stepResults[idx] || {};
        const stepRef = row.stepId || row.index || idx + 1;
        const attemptId = trailEntry?.toolUseId || `generic-click-${tc.id}-${idx + 1}-${Date.now()}`;
        try {
          stepResults = executionJournal.recordAttempt(stepResults, stepRef, {
            toolUseId: attemptId,
            tool: outcome.internalOperationCompletion ? 'generic_transition_already_satisfied' : 'browser_click',
            target: label,
            beforeFingerprint,
            afterFingerprint,
            waitContract: waitContract.buildWaitContract(step),
            actualOutcome: outcome.status === 'pass' ? 'succeeded' : 'failed',
            reason: outcome.reason,
            clickAttemptDiagnostics: outcome.diagnostics,
          });
        } catch (_) {}

        const error = outcome.status === 'pass'
          ? null
          : `QAAI_CLICK_ACTION_UNCONFIRMED: Click "${label || `Step ${idx + 1}`}" was not proven after one semantic retry (${outcome.reason}).`;
        const reduced = kernelSeal({
          idx,
          proposedStatus: outcome.status,
          error,
          toolName: outcome.internalOperationCompletion
            ? 'generic_transition_already_satisfied'
            : 'browser_click',
          operationResult: record?.kind === 'oracle' || !projectedOperationCheck
            ? null
            : { ...projectedOperationCheck, kind: 'operation_check' },
          assertionResult: record?.kind === 'oracle' ? record : null,
          internalOperationCompletion: outcome.internalOperationCompletion === true,
          source: 'generic_click_execution',
        });
        return {
          sealed: stepResults[idx] || reduced,
          hasRunnableStep: currentStepIndex < totalSteps,
        };
      },
    });
  };
*/});

const UNIVERSAL_ACTION_RUNTIME_ADAPTER = sourceBlock(function universalActionRuntimeAdapter() {/*
  let activeUniversalActionIdentity = null;
  if (mcpSession && typeof mcpSession === 'object') {
    mcpSession.persistActionExecutionOccurrence = async (state) => {
      const stateIndex = Number.isFinite(Number(state?.authoredStepIndex))
        ? Math.max(0, Math.floor(Number(state.authoredStepIndex)))
        : currentStepIndex;
      const row = stepResults[stateIndex] || null;
      if (!row) throw new Error('journal_step_unavailable');
      const durable = await actionTransactionRepository.saveOccurrence({
        runId,
        caseId: tc.id,
        occurrenceKey: state.occurrenceKey,
      }, state);
      row.actionExecutionOccurrences = {
        ...(row.actionExecutionOccurrences || {}),
        [state.occurrenceKey]: { ...state },
      };
      return { ...durable, memoryRef: `step:${row.stepId || stateIndex + 1}:action-execution:${state.occurrenceKey}` };
    };
    mcpSession.loadActionExecutionOccurrence = async ({ occurrenceKey }) => actionTransactionRepository.loadOccurrence({
      runId,
      caseId: tc.id,
      occurrenceKey,
    });
  }
  const normalizeAssertionControlLabel = (value) => String(value == null ? '' : value)
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .replace(/^\s*(?:verify|assert|through\s+secure\s+input\s+readback\s+that|the|selected)\s+/i, '')
    .replace(/\b(?:field|input|control|dropdown|drop\s*down|combobox|calendar|picker)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const recentActionRefForAssertion = ({ label, type, snapshotText }) => {
    if (!['TEXT', 'VALUE', 'CHECKED', 'SELECTED', 'DATE', 'TIME', 'DATETIME'].includes(type)) return null;
    const expected = normalizeAssertionControlLabel(label);
    if (!expected || !Array.isArray(actionTrail)) return null;
    const lowerSnapshot = String(snapshotText || '').toLowerCase();
    for (let index = actionTrail.length - 1, inspected = 0; index >= 0 && inspected < 24; index -= 1, inspected += 1) {
      const entry = actionTrail[index];
      if (!entry || entry.result?.isError === true || entry.isError === true) continue;
      const args = entry.args && typeof entry.args === 'object' ? entry.args : {};
      const labels = [
        args.element,
        args.name,
        args.label,
        args.field,
        ...(Array.isArray(args.fields) ? args.fields.flatMap((field) => [field?.name, field?.element, field?.label]) : []),
        entry.actionLocator?.accessibleName,
        entry.actionLocator?.label,
      ].map(normalizeAssertionControlLabel).filter(Boolean);
      const matches = labels.some((candidate) => candidate === expected
        || (Math.min(candidate.length, expected.length) >= 5
          && (candidate.includes(expected) || expected.includes(candidate))));
      if (!matches) continue;
      const refs = [
        args.target,
        args.ref,
        ...(Array.isArray(args.fields) ? args.fields.flatMap((field) => [field?.target, field?.ref]) : []),
        entry.qaaiResolvedArgs?.target,
        entry.qaaiResolvedArgs?.ref,
        entry.actionLocator?.ref,
        ...(Array.isArray(entry.actionLocator?.fields)
          ? entry.actionLocator.fields.flatMap((field) => [field?.ref, field?.target, field?.actionLocator?.ref])
          : []),
        entry.actionLocatorPending?.ref,
      ].map((value) => String(value == null ? '' : value).trim()).filter(Boolean);
      const liveRef = refs.find((candidate) => lowerSnapshot.includes(candidate.toLowerCase()));
      if (liveRef) return liveRef;
    }
    return null;
  };
  const authoredLandingStatesAfterCurrentStep = () => {
    const steps = typeof approvedSteps !== 'undefined' && Array.isArray(approvedSteps) ? approvedSteps : [];
    return steps
      .slice(currentStepIndex + 1, Math.min(steps.length, currentStepIndex + 5))
      .map((nextStep) => ({
        id: nextStep?.id || nextStep?.stepId || nextStep?.contractStepId || null,
        action: nextStep?.action || nextStep?.kind || nextStep?.type || null,
        target: nextStep?.target || nextStep?.element || nextStep?.field || nextStep?.label || nextStep?.name || null,
        role: nextStep?.targetRole || nextStep?.role || nextStep?.controlRole || null,
        targetIdentity: nextStep?.targetIdentity && typeof nextStep.targetIdentity === 'object'
          ? {
              role: nextStep.targetIdentity.role || null,
              accessibleName: nextStep.targetIdentity.accessibleName || null,
              name: nextStep.targetIdentity.name || null,
              label: nextStep.targetIdentity.label || null,
            }
          : null,
        url: nextStep?.url || null,
        targetUrl: nextStep?.targetUrl || null,
        href: nextStep?.href || null,
        urlPattern: nextStep?.urlPattern || null,
        expectedUrl: nextStep?.expectedUrl || null,
        operationCheck: nextStep?.operationCheck && typeof nextStep.operationCheck === 'object'
          ? {
              url: nextStep.operationCheck.url || null,
              urlPattern: nextStep.operationCheck.urlPattern || null,
              expectedUrl: nextStep.operationCheck.expectedUrl || null,
            }
          : null,
        waitContract: nextStep?.waitContract && typeof nextStep.waitContract === 'object'
          ? {
              target: nextStep.waitContract.target || null,
              url: nextStep.waitContract.url || null,
              urlPattern: nextStep.waitContract.urlPattern || null,
              expectedUrl: nextStep.waitContract.expectedUrl || null,
            }
          : null,
        condition: nextStep?.condition && typeof nextStep.condition === 'object'
          ? { target: nextStep.condition.target || null }
          : null,
      }));
  };
  const observeAuthoredLandingOracle = async ({ oracle }) => {
    let snapshot = null;
    try {
      snapshot = await mcp.snapshot(mcpSession, {
        skipSnapshotStability: true,
        source: 'gateway_authored_landing_oracle',
        timeoutMs: 2_000,
      });
    } catch (_) {}
    const snapshotText = snapshot?.text || mcp.textOfContent(snapshot?.content) || '';
    if (snapshotText) lastSnapshotText = snapshotText;
    currentPageUrl = (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null;
    if (oracle?.kind === 'url') return { fresh: !!(snapshotText || currentPageUrl), url: currentPageUrl };
    if (!snapshotText || !oracle?.target) {
      return { fresh: false, matched: false, reason: 'fresh_targeted_snapshot_unavailable' };
    }
    const resolved = resolveSnapshotElement(snapshotText, {
      authoredLabel: oracle.target,
      role: oracle.role || null,
    });
    return {
      fresh: true,
      matched: resolved?.ok === true && !!resolved.ref,
      actionable: resolved?.ok === true && !!resolved.ref,
      reason: resolved?.reason || (resolved?.ok ? 'semantic_target_actionable' : 'semantic_target_not_actionable'),
    };
  };
  const conductorUniversalActionRuntime = conductorUniversalRuntime.createConductorUniversalRuntime({
    eventAdapters: mcpBrowserEventAdapters.createMcpBrowserEventAdapters({
      mcp,
      session: mcpSession,
      downloadWatcher,
      recordEvidence: async (evidence) => {
        const row = stepResults[currentStepIndex];
        if (!row) return { persisted: false, reason: 'journal_step_unavailable' };
        row.browserEventEvidence = evidence;
        return { persisted: true, ref: `step:${row.stepId || currentStepIndex + 1}:browser-event` };
      },
    }),
    hooks: {
      transactionContext: { runId, caseId: tc.id },
      readActionTransaction: async ({ idx }) => {
        const row = stepResults[idx] || null;
        if (!row) return null;
        const identity = {
          runId,
          caseId: tc.id,
          stepId: row.stepId || approvedSteps[idx]?.id || approvedSteps[idx]?.stepId || null,
          sequenceIndex: idx,
        };
        const transaction = row.actionTransaction || await actionTransactionRepository.loadTransaction(identity);
        if (transaction) row.actionTransaction = transaction;
        return transaction || null;
      },
      persistActionTransaction: async ({ idx, transaction }) => {
        if (!stepResults[idx]) throw new Error('journal_step_unavailable');
        const identity = {
          runId,
          caseId: tc.id,
          stepId: stepResults[idx].stepId || approvedSteps[idx]?.id || approvedSteps[idx]?.stepId || null,
          sequenceIndex: idx,
        };
        const durable = await actionTransactionRepository.saveTransaction(identity, transaction);
        stepResults[idx].actionTransaction = transaction;
        return { ...durable, memoryRef: `step:${stepResults[idx].stepId || idx + 1}:action-transaction` };
      },
      captureBrowserEvents: async ({ phase }) => {
        const captured = await mcp.captureInPageBrowserEvents(mcpSession, {
          mode: 'drain',
          maxEvents: 100,
          timeoutMs: 1_500,
        });
        return phase === 'pre' ? { ...captured, events: [] } : captured;
      },
      captureEvidenceScreenshot: async ({ phase, request }) => {
        if (request?.privacy?.sensitive === true) return null;
        return mcp.captureLiveEvidenceScreenshot(mcpSession, {
          label: `${runId}-${tc.id}-${request?.actionAttemptId || 'action'}-${phase}`,
          timeoutMs: 2_000,
        });
      },
      snapshot: async ({ source, phase, controlPhase, attempt, retry }) => {
        let snapshot = null;
        try {
          snapshot = await mcp.snapshot(mcpSession, {
            skipSnapshotStability: true,
            source,
            timeoutMs: 2_000,
          });
        } catch (_) {}
        const snapshotText = snapshot?.text || mcp.textOfContent(snapshot?.content) || '';
        if (snapshotText) lastSnapshotText = snapshotText;
        currentPageUrl = (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null;
        return {
          snapshotText,
          url: currentPageUrl,
          title: (mcpSession && mcpSession.currentTitle) || null,
          source,
          phase,
          controlPhaseId: controlPhase?.id || null,
          attempt,
          retry,
          fresh: !!snapshotText,
        };
      },
      resolveOptionalPresence: async ({ step, target }) => {
        let snapshot = null;
        try {
          snapshot = await mcp.snapshot(mcpSession, {
            skipSnapshotStability: true,
            source: 'optional_presence_preflight',
            timeoutMs: 2_000,
          });
        } catch (_) {}
        const snapshotText = snapshot?.text || mcp.textOfContent(snapshot?.content) || '';
        if (snapshotText) lastSnapshotText = snapshotText;
        if (!snapshotText) {
          return {
            present: null,
            authoritativeAbsence: false,
            source: 'fresh_snapshot_unavailable',
            reason: 'optional_presence_observation_unavailable',
          };
        }
        const label = String(
          target || step?.target || step?.element || step?.field || step?.label || step?.name || '',
        ).trim();
        if (!label) {
          return {
            present: null,
            authoritativeAbsence: false,
            source: 'authored_target_missing',
            reason: 'optional_presence_target_missing',
          };
        }
        const resolved = resolveSnapshotElement(snapshotText, {
          authoredLabel: label,
          role: step?.targetRole || step?.role || step?.controlRole || null,
        });
        if (resolved?.ok === true && resolved.ref) {
          return {
            present: true,
            authoritativeAbsence: false,
            source: 'fresh_semantic_snapshot',
            reason: 'optional_target_present',
          };
        }
        const candidates = Array.isArray(resolved?.candidates) ? resolved.candidates : [];
        if (candidates.length > 0 || /ambiguous/i.test(String(resolved?.reason || ''))) {
          return {
            present: null,
            authoritativeAbsence: false,
            source: 'fresh_semantic_snapshot',
            reason: resolved?.reason || 'optional_target_ambiguous',
          };
        }
        return {
          present: false,
          authoritativeAbsence: true,
          source: 'fresh_semantic_snapshot_zero_candidates',
          reason: resolved?.reason || 'optional_target_absent',
          evidence: 'Fresh semantic snapshot contained no candidate for the authored optional target.',
        };
      },
      evaluate: async ({ function: fn, element = null, target = null, source = 'universal_state_probe' }) => {
        try {
          const args = { function: fn };
          if (element) args.element = element;
          if (target) args.target = target;
          const result = await mcp.callTool(mcpSession, 'browser_evaluate', args, {
            strictActionEvidence: false,
            source,
            telemetry: false,
            timeoutMs: 2_000,
          });
          if (result?.isError) return null;
          const text = mcp.textOfContent(result?.content) || '';
          let parsed = mcp.parseEvaluateReturnValue ? mcp.parseEvaluateReturnValue(text) : null;
          if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch (_) {}
          }
          if (!parsed || typeof parsed !== 'object') {
            const match = text.match(/\{[\s\S]*\}/);
            if (match) { try { parsed = JSON.parse(match[0]); } catch (_) {} }
          }
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_) {
          return null;
        }
      },
      revealTarget: async ({ label, roleHints, semanticTarget, phase }) => {
        const fn = semanticTargetReveal.buildSemanticTargetRevealFunction({
          label,
          roleHints,
          semanticTarget,
        });
        try {
          if (!activeUniversalActionIdentity) {
            activeUniversalActionIdentity = identityForNewActionOccurrence({
              toolName: phase?.toolName || 'browser_evaluate',
              args: { element: label, semanticTarget },
              stepIndex: currentStepIndex,
            });
          }
          const revealMutationPhaseId = `semantic-reveal:${phase?.id || 'control'}`;
          const result = await mcp.callTool(mcpSession, 'browser_evaluate', { function: fn }, actionDispatchIdentity(activeUniversalActionIdentity, {
            strictActionEvidence: false,
            source: `semantic_target_reveal_${phase?.id || 'control'}`,
            telemetry: false,
            timeoutMs: 2_000,
            authoredAction: false,
            childOperation: true,
            enforceExactlyOnce: true,
            mutationPhaseId: revealMutationPhaseId,
          }));
          if (result?.isError) return null;
          const text = mcp.textOfContent(result?.content) || '';
          let parsed = mcp.parseEvaluateReturnValue ? mcp.parseEvaluateReturnValue(text) : null;
          if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch (_) {}
          }
          if (parsed && typeof parsed === 'object') {
            await actionExecutionGateway.recordOccurrencePostcondition({
              session: mcpSession,
              actionOccurrenceId: activeUniversalActionIdentity.actionOccurrenceId,
              mutationPhaseId: revealMutationPhaseId,
              proof: { matched: parsed.ok === true, reason: parsed.reason || 'semantic_target_reveal_observed' },
            });
            if (parsed.ok === true) {
              await actionExecutionGateway.commitOccurrence({
                session: mcpSession,
                actionOccurrenceId: activeUniversalActionIdentity.actionOccurrenceId,
                mutationPhaseId: revealMutationPhaseId,
              });
            }
            return parsed;
          }
          return null;
        } catch (_) {
          return null;
        }
      },
      releaseRevealedTarget: async ({ runtimeBinding, phase }) => {
        const fn = semanticTargetReveal.buildSemanticTargetReleaseFunction(runtimeBinding);
        try {
          if (!activeUniversalActionIdentity) return { ok: false, reason: 'action_identity_missing' };
          const releaseMutationPhaseId = `semantic-reveal-release:${phase?.id || 'control'}`;
          const result = await mcp.callTool(mcpSession, 'browser_evaluate', { function: fn }, actionDispatchIdentity(activeUniversalActionIdentity, {
            strictActionEvidence: false,
            source: `semantic_target_release_${phase?.id || 'control'}`,
            telemetry: false,
            timeoutMs: 2_000,
            authoredAction: false,
            childOperation: true,
            enforceExactlyOnce: true,
            mutationPhaseId: releaseMutationPhaseId,
          }));
          if (result?.isError) return { ok: false, reason: 'runtime_binding_release_error' };
          const text = mcp.textOfContent(result?.content) || '';
          let parsed = mcp.parseEvaluateReturnValue ? mcp.parseEvaluateReturnValue(text) : null;
          if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch (_) {}
          }
          if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'runtime_binding_release_unreadable' };
          await actionExecutionGateway.recordOccurrencePostcondition({
            session: mcpSession,
            actionOccurrenceId: activeUniversalActionIdentity.actionOccurrenceId,
            mutationPhaseId: releaseMutationPhaseId,
            proof: { matched: parsed.ok === true, reason: parsed.reason || 'runtime_binding_release_observed' },
          });
          if (parsed.ok === true) {
            await actionExecutionGateway.commitOccurrence({
              session: mcpSession,
              actionOccurrenceId: activeUniversalActionIdentity.actionOccurrenceId,
              mutationPhaseId: releaseMutationPhaseId,
            });
          }
          return parsed;
        } catch (_) {
          return { ok: false, reason: 'runtime_binding_release_exception' };
        }
      },
      resolveRef: ({ step, toolName, snapshotText, phase }) => {
        const phaseId = String(phase?.id || '').toLowerCase();
        if (phaseId === 'scroll-target-into-view' || phaseId === 'scroll-content') {
          const label = String(
            step?.target || step?.element || step?.field || step?.name || step?.label || '',
          ).trim();
          const target = resolveSnapshotElement(snapshotText, {
            authoredLabel: label,
            role: step.targetRole || step.role || null,
          });
          if (target?.ok && target.ref) return target.ref;
          if (target?.reason === 'ambiguous_snapshot_element') return null;
        }
        return kernelResolveRef({ step, toolName, snapshotText });
      },
      dispatch: async ({ step, plan, phase, resolution, attempt, retry, semanticOperation = null }) => {
        const toolName = phase.toolName;
        const args = { ...(phase.args || {}) };
        if (!activeUniversalActionIdentity) {
          activeUniversalActionIdentity = identityForNewActionOccurrence({ toolName, args, stepIndex: currentStepIndex });
        }
        if (toolName === 'browser_press_key' && args.resolvedTarget) {
          try {
            await mcp.callTool(mcpSession, 'browser_evaluate', {
              function: '(element) => { if (!element || !element.focus) return false; element.focus(); return document.activeElement === element; }',
              element: plan.target,
              target: args.resolvedTarget,
            }, actionDispatchIdentity(activeUniversalActionIdentity, {
              strictActionEvidence: false,
              source: 'universal_keyboard_focus',
              telemetry: false,
              timeoutMs: 2_000,
              authoredAction: false,
              childOperation: true,
            }));
          } catch (_) {}
          delete args.resolvedTarget;
        }
        send({
          type: 'browser.action', runId, tcId: tc.id, tool: toolName,
          args: redactArgs(args), deterministicKernel: true,
          narration: `${retry ? 'Retrying' : 'Executing'} ${plan.kind} on ${plan.target || 'the declared control'}${semanticOperation ? ' using structural calendar evidence' : ''}.`,
        });
        let result;
        const dispatchTimeoutMs = Math.max(
          500,
          Math.min(15_000, Number(plan?.waitContract?.timeoutMs) || 10_000),
        );
        const planPhases = Array.isArray(plan?.phases) ? plan.phases : [];
        const phasePosition = planPhases.findIndex((candidate) => candidate?.id === phase?.id);
        const terminalControlPhase = !planPhases.length
          || phasePosition < 0
          || phasePosition === planPhases.length - 1;
        const availableApprovedSteps = typeof approvedSteps !== 'undefined' && Array.isArray(approvedSteps)
          ? approvedSteps
          : [];
        const authoredNextStates = terminalControlPhase
          ? availableApprovedSteps
              .slice(currentStepIndex + 1, Math.min(availableApprovedSteps.length, currentStepIndex + 5))
              .map((nextStep) => ({
                id: nextStep?.id || nextStep?.stepId || nextStep?.contractStepId || null,
                action: nextStep?.action || nextStep?.kind || nextStep?.type || null,
                target: nextStep?.target || nextStep?.element || nextStep?.field || nextStep?.label || nextStep?.name || null,
                role: nextStep?.targetRole || nextStep?.role || nextStep?.controlRole || null,
                targetIdentity: nextStep?.targetIdentity && typeof nextStep.targetIdentity === 'object'
                  ? {
                      role: nextStep.targetIdentity.role || null,
                      accessibleName: nextStep.targetIdentity.accessibleName || null,
                      name: nextStep.targetIdentity.name || null,
                      label: nextStep.targetIdentity.label || null,
                    }
                  : null,
                url: nextStep?.url || null,
                targetUrl: nextStep?.targetUrl || null,
                href: nextStep?.href || null,
                urlPattern: nextStep?.urlPattern || null,
                expectedUrl: nextStep?.expectedUrl || null,
                operationCheck: nextStep?.operationCheck && typeof nextStep.operationCheck === 'object'
                  ? {
                      url: nextStep.operationCheck.url || null,
                      urlPattern: nextStep.operationCheck.urlPattern || null,
                      expectedUrl: nextStep.operationCheck.expectedUrl || null,
                    }
                  : null,
                waitContract: nextStep?.waitContract && typeof nextStep.waitContract === 'object'
                  ? {
                      target: nextStep.waitContract.target || null,
                      url: nextStep.waitContract.url || null,
                      urlPattern: nextStep.waitContract.urlPattern || null,
                      expectedUrl: nextStep.waitContract.expectedUrl || null,
                    }
                  : null,
                condition: nextStep?.condition && typeof nextStep.condition === 'object'
                  ? { target: nextStep.condition.target || null }
                  : null,
              }))
          : [];
        const observeLandingOracle = async ({ oracle }) => {
          let snapshot = null;
          try {
            snapshot = await mcp.snapshot(mcpSession, {
              skipSnapshotStability: true,
              source: 'gateway_authored_landing_oracle',
              timeoutMs: 2_000,
            });
          } catch (_) {}
          const snapshotText = snapshot?.text || mcp.textOfContent(snapshot?.content) || '';
          if (snapshotText) lastSnapshotText = snapshotText;
          currentPageUrl = (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null;
          if (oracle?.kind === 'url') {
            return { fresh: !!(snapshotText || currentPageUrl), url: currentPageUrl };
          }
          if (!snapshotText || !oracle?.target) {
            return { fresh: false, matched: false, reason: 'fresh_targeted_snapshot_unavailable' };
          }
          const resolved = resolveSnapshotElement(snapshotText, {
            authoredLabel: oracle.target,
            role: oracle.role || null,
          });
          return {
            fresh: true,
            matched: resolved?.ok === true && !!resolved.ref,
            actionable: resolved?.ok === true && !!resolved.ref,
            reason: resolved?.reason || (resolved?.ok ? 'semantic_target_actionable' : 'semantic_target_not_actionable'),
          };
        };
        const requiresVerifiedTarget = actionExecutionGateway.requiresVerifiedSemanticTarget(toolName, args);
        let dispatchLocator = resolution?.actionLocator || resolution?.qaaiActionLocator || null;
        if (requiresVerifiedTarget && !actionLocatorResolver.isVerifiedActionLocator(dispatchLocator)) {
          try {
            const authoritativeResolution = await actionLocatorResolver.resolveVerifiedForTool({
              session: mcpSession,
              toolName,
              args,
              snapshotText: mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '',
              pageUrl: currentPageUrl || startUrl || null,
              elementLabel: args.element || plan.target || phase?.resolution?.label || toolName,
              ...actionDispatchIdentity(activeUniversalActionIdentity, { source: 'universal_action_target_resolver' }),
            });
            if (authoritativeResolution?.ok
              && actionLocatorResolver.isVerifiedActionLocator(authoritativeResolution.actionLocator)) {
              dispatchLocator = authoritativeResolution.actionLocator;
            }
          } catch (_) {}
        }
        const locatorPrimary = dispatchLocator ? actionLocatorResolver.primaryActionLocator(dispatchLocator) : null;
        const runtimeVerifiedUtilityTarget = phase?.allowUtilityDispatch === true
          && resolution?.ok === true
          && !!resolution?.ref
          && args.target === resolution.ref;
        const verifiedTarget = !requiresVerifiedTarget
          || actionLocatorResolver.isVerifiedActionLocator(dispatchLocator)
          || runtimeVerifiedUtilityTarget;
        if (requiresVerifiedTarget && !verifiedTarget) {
          result = {
            isError: true,
            code: 'ACTION_EXECUTION_TARGET_UNVERIFIED',
            content: [{ type: 'text', text: 'The universal control target was not authoritatively verified before dispatch.' }],
          };
        }
        if (!result) {
          try { result = await mcp.callTool(mcpSession, toolName, args, actionDispatchIdentity(activeUniversalActionIdentity, {
            source: retry ? 'universal_action_retry' : 'universal_action_dispatch',
            mutationPhaseId: phase?.id || phase?.kind || `${plan.kind || 'control'}:${toolName}`,
            timeoutMs: dispatchTimeoutMs,
            waitForLandingOracle: terminalControlPhase && authoredNextStates.length > 0,
            authoredNextStates,
            observeLandingOracle,
            landingOracleTimeoutMs: Math.min(10_000, Math.max(500, Number(plan?.waitContract?.timeoutMs) || 5_000)),
            landingOraclePollIntervalMs: Math.min(500, Math.max(100, Number(plan?.waitContract?.pollIntervalMs) || 250)),
            landingOracleStableObservations: 1,
            ...(requiresVerifiedTarget ? {
              requireVerifiedTarget: true,
              targetAuthorization: {
                schemaVersion: 'qaai-live-target-authorization-v1',
                status: verifiedTarget ? 'verified' : 'unverified',
                liveMutationAllowed: verifiedTarget,
                diagnosticOnly: locatorPrimary?.diagnosticOnly === true,
                isGuess: locatorPrimary?.guess?.isGuess === true,
                verificationSource: runtimeVerifiedUtilityTarget
                  ? 'runtime_semantic_utility_ref'
                  : locatorPrimary?.verificationSource || locatorPrimary?.evidenceSource || locatorPrimary?.proof?.source || null,
                reason: runtimeVerifiedUtilityTarget
                  ? 'verified_runtime_utility_target'
                  : verifiedTarget ? 'verified_action_locator' : 'verified_action_locator_required',
              },
            } : {}),
          })); }
          catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message || String(error) }] }; }
        }
        const trailEntry = kernelAppendTrail({
          tool: toolName, args, stepIndex: currentStepIndex, result,
          snapshotBefore: mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '',
          narration: `${plan.kind} ${plan.target || ''}`.trim(),
          actionIdentity: activeUniversalActionIdentity,
        });
        const authoritativeActionLocator = actionLocatorResolver.isVerifiedActionLocator(dispatchLocator)
          ? dispatchLocator
          : actionLocatorResolver.isVerifiedActionLocator(result?.qaaiActionLocator)
            ? result.qaaiActionLocator
            : null;
        if (authoritativeActionLocator) {
          if (resolution && typeof resolution === 'object') resolution.actionLocator = authoritativeActionLocator;
          trailEntry.actionLocatorPending = authoritativeActionLocator;
          trailEntry.actionLocator = authoritativeActionLocator;
          trailEntry.actionLocatorKernel = {
            status: dispatchLocator === authoritativeActionLocator
              ? 'fulfilled_before_dispatch'
              : 'fulfilled_by_dispatch_capture',
            source: authoritativeActionLocator.verificationSource
              || authoritativeActionLocator.evidenceSource
              || authoritativeActionLocator.proof?.source
              || null,
          };
        }
        let parsed = null;
        if (toolName === 'browser_evaluate' && !result?.isError) {
          const text = mcp.textOfContent(result?.content) || '';
          try { parsed = mcp.parseEvaluateReturnValue ? mcp.parseEvaluateReturnValue(text) : JSON.parse(text); } catch (_) {}
        }
        currentPageUrl = (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null;
        return {
          ok: !result?.isError,
          result,
          trailEntry,
          parsed,
          attempt,
          toolName,
          qaaiActionLocator: authoritativeActionLocator,
          qaaiActionEvidence: result?.qaaiActionEvidence || null,
        };
      },
      dispatchEvent: async ({ step, eventKind }) => {
        const label = kernelStepTarget(step);
        let toolName = 'browser_click';
        let args = null;
        let triggerSnapshotText = '';
        if (eventKind === 'navigation' && ['navigate', 'navigation', 'goto', 'openpage'].includes(universalActionKernel.actionToken(step))) {
          toolName = 'browser_navigate';
          args = { url: kernelStepValue(step) || step.url || step.targetUrl };
        } else if (eventKind === 'upload') {
          toolName = 'browser_file_upload';
          const rawPaths = step.paths || step.files || step.filePaths || step.value || [];
          const paths = (Array.isArray(rawPaths) ? rawPaths : [rawPaths]).filter(Boolean).map(String);
          args = { paths };
        } else if (eventKind === 'dialog' && /^(?:acceptdialog|dismissdialog|dialog)$/.test(universalActionKernel.actionToken(step))) {
          toolName = 'browser_handle_dialog';
          args = { accept: universalActionKernel.actionToken(step) !== 'dismissdialog' };
          if (step.promptText != null) args.promptText = String(step.promptText);
        } else {
          const snap = await mcp.snapshot(mcpSession, { skipSnapshotStability: true, source: `event_${eventKind}_trigger`, timeoutMs: 2_000 });
          triggerSnapshotText = snap?.text || mcp.textOfContent(snap?.content) || '';
          const ref = await kernelResolveRef({ step, toolName: 'browser_click', snapshotText: triggerSnapshotText });
          if (!ref) return { isError: true, ok: false, error: 'unique_event_trigger_target_not_proven' };
          args = { element: label, target: ref };
        }
        if (!args || (toolName === 'browser_navigate' && !args.url) || (toolName === 'browser_file_upload' && !args.paths.length)) {
          return { isError: true, ok: false, error: 'typed_event_trigger_input_missing' };
        }
        if (!activeUniversalActionIdentity) {
          activeUniversalActionIdentity = identityForNewActionOccurrence({ toolName, args, stepIndex: currentStepIndex });
        }
        const requiresVerifiedTarget = actionExecutionGateway.requiresVerifiedSemanticTarget(toolName, args);
        let dispatchLocator = null;
        if (requiresVerifiedTarget) {
          try {
            const authoritativeResolution = await actionLocatorResolver.resolveVerifiedForTool({
              session: mcpSession,
              toolName,
              args,
              snapshotText: triggerSnapshotText || mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '',
              pageUrl: currentPageUrl || startUrl || null,
              elementLabel: args.element || label || toolName,
              ...actionDispatchIdentity(activeUniversalActionIdentity, { source: 'universal_typed_event_target_resolver' }),
            });
            if (authoritativeResolution?.ok
              && actionLocatorResolver.isVerifiedActionLocator(authoritativeResolution.actionLocator)) {
              dispatchLocator = authoritativeResolution.actionLocator;
            }
          } catch (_) {}
        }
        const locatorPrimary = dispatchLocator ? actionLocatorResolver.primaryActionLocator(dispatchLocator) : null;
        const verifiedTarget = !requiresVerifiedTarget
          || actionLocatorResolver.isVerifiedActionLocator(dispatchLocator);
        if (requiresVerifiedTarget && !verifiedTarget) {
          return {
            isError: true,
            ok: false,
            code: 'ACTION_EXECUTION_TARGET_UNVERIFIED',
            error: 'verified_event_trigger_target_required',
          };
        }
        send({ type: 'browser.action', runId, tcId: tc.id, tool: toolName, args: redactArgs(args), deterministicKernel: true,
          narration: `Executing typed ${eventKind} trigger with the listener already armed.` });
        const authoredNextStates = ['navigation', 'page_change'].includes(eventKind)
          ? authoredLandingStatesAfterCurrentStep()
          : [];
        let result;
        try { result = await mcp.callTool(mcpSession, toolName, args, actionDispatchIdentity(activeUniversalActionIdentity, {
          source: 'universal_typed_event_dispatch',
          waitForLandingOracle: authoredNextStates.length > 0,
          authoredNextStates,
          observeLandingOracle: observeAuthoredLandingOracle,
          landingOracleTimeoutMs: Math.min(10_000, Math.max(500, Number(step?.waitContract?.timeoutMs) || 5_000)),
          landingOraclePollIntervalMs: Math.min(500, Math.max(100, Number(step?.waitContract?.pollIntervalMs) || 250)),
          landingOracleStableObservations: 1,
          ...(requiresVerifiedTarget ? {
            requireVerifiedTarget: true,
            targetAuthorization: {
              schemaVersion: 'qaai-live-target-authorization-v1',
              status: verifiedTarget ? 'verified' : 'unverified',
              liveMutationAllowed: verifiedTarget,
              diagnosticOnly: locatorPrimary?.diagnosticOnly === true,
              isGuess: locatorPrimary?.guess?.isGuess === true,
              verificationSource: locatorPrimary?.verificationSource || locatorPrimary?.evidenceSource || locatorPrimary?.proof?.source || null,
              reason: verifiedTarget ? 'verified_action_locator' : 'verified_action_locator_required',
            },
          } : {}),
        })); }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message || String(error) }] }; }
        const trailEntry = kernelAppendTrail({ tool: toolName, args, stepIndex: currentStepIndex, result,
          snapshotBefore: mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '', narration: `Typed ${eventKind} trigger`,
          actionIdentity: activeUniversalActionIdentity });
        const authoritativeActionLocator = actionLocatorResolver.isVerifiedActionLocator(dispatchLocator)
          ? dispatchLocator
          : actionLocatorResolver.isVerifiedActionLocator(result?.qaaiActionLocator)
            ? result.qaaiActionLocator
            : null;
        if (authoritativeActionLocator && trailEntry) {
          trailEntry.actionLocatorPending = authoritativeActionLocator;
          trailEntry.actionLocator = authoritativeActionLocator;
          trailEntry.actionLocatorKernel = {
            status: dispatchLocator === authoritativeActionLocator
              ? 'fulfilled_before_dispatch'
              : 'fulfilled_by_dispatch_capture',
            source: authoritativeActionLocator.verificationSource
              || authoritativeActionLocator.evidenceSource
              || authoritativeActionLocator.proof?.source
              || null,
          };
        }
        return {
          ...result,
          ok: !result?.isError,
          toolName,
          files: toolName === 'browser_file_upload' ? args.paths : undefined,
          qaaiActionLocator: authoritativeActionLocator,
        };
      },
      readAssertion: async ({ assertion }) => {
        let snapshot = null;
        try {
          snapshot = await mcp.snapshot(mcpSession, {
            skipSnapshotStability: true,
            source: 'typed_assertion_state_probe',
            timeoutMs: 2_000,
          });
        } catch (_) {}
        const snapshotText = snapshot?.text || mcp.textOfContent(snapshot?.content) || '';
        if (!snapshotText) return { fresh: false };
        if (snapshotText) lastSnapshotText = snapshotText;
        const type = assertionStateProbe.assertionType(assertion);
        const target = assertionStateProbe.targetDescriptor(assertion);
        const assertionPayload = assertion?.payload && typeof assertion.payload === 'object'
          ? assertion.payload : assertion;
        const rawAssertionTarget = String(
          assertionPayload?.target?.name
          || assertionPayload?.target?.label
          || assertionPayload?.element?.name
          || assertionPayload?.element?.label
          || assertionPayload?.targetName
          || assertionPayload?.elementName
          || assertionPayload?.fieldName
          || assertionPayload?.label
          || '',
        ).trim();
        const page = {
          url: (mcpSession && mcpSession.currentUrl) || currentPageUrl || startUrl || null,
          text: snapshotText,
        };
        if (type === 'URL') return { fresh: true, actual: page.url };
        if (['TEXT', 'FORBIDDEN_TEXT', 'REGEX'].includes(type) && !target.name) {
          const expectedText = String(
            assertionPayload?.expectedText
            ?? assertionPayload?.expectedValue
            ?? assertionPayload?.expected
            ?? assertionPayload?.text
            ?? '',
          ).trim();
          const haystack = assertionPayload?.caseSensitive === true ? snapshotText : snapshotText.toLowerCase();
          const needle = assertionPayload?.caseSensitive === true ? expectedText : expectedText.toLowerCase();
          const visible = !!needle && haystack.includes(needle);
          return {
            fresh: true,
            actual: snapshotText,
            evidenceChannels: expectedText ? [{
              kind: 'dom_visible_text',
              text: visible ? expectedText : null,
              visible,
              searched: true,
              targetMatched: true,
              source: 'mcp_accessibility_snapshot_exact_text_search',
            }] : [],
          };
        }
        if (type === 'COUNT' && target.role && !target.name) {
          const rolePattern = new RegExp(`^\\s*-?\\s*${String(target.role).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
          const count = snapshotText.split(/\r?\n/).filter((line) => rolePattern.test(line)).length;
          return {
            fresh: true,
            actual: count,
            evidenceChannels: [{
              kind: 'scoped_collection',
              count,
              scopeMatched: true,
              stable: true,
              visible: true,
              source: 'mcp_accessibility_snapshot_role_scope',
            }],
          };
        }
        if (['COLLECTION', 'COLLECTION_MEMBERSHIP'].includes(type)) {
          const collectionState = assertionStateProbe.snapshotCollectionState(snapshotText, target.name || target.role || '');
          if (collectionState.found) return {
            fresh: true,
            actual: collectionState.items,
            evidenceChannels: [{
              kind: 'scoped_collection',
              items: collectionState.items,
              count: collectionState.items.length,
              scopeMatched: true,
              stable: true,
              visible: true,
              source: 'mcp_accessibility_snapshot_collection_scope',
            }],
          };
          if (collectionState.reason === 'collection_target_ambiguous') {
            return { fresh: true, uncheckable: true, reason: collectionState.reason };
          }
        }
        const authoredLabel = target.name || target.role;
        const label = type === 'HIDDEN' && /^no\s+/i.test(String(authoredLabel || ''))
          ? String(authoredLabel).replace(/^no\s+/i, '').trim()
          : authoredLabel;
        if (!label) return { fresh: true, uncheckable: true, reason: 'typed_assertion_target_missing' };
        const literalVisibleText = /^visible\s+text\s+["'].+?["']$/i.test(rawAssertionTarget);
        if (literalVisibleText && ['VISIBLE', 'HIDDEN'].includes(type)) {
          const present = elementPresentInSnapshot(snapshotText, null, label);
          return {
            fresh: true,
            actual: { visible: present },
            evidenceChannels: [{
              kind: 'ax_visibility',
              visible: present,
              targetMatched: true,
              source: 'mcp_accessibility_snapshot_literal_target',
            }],
          };
        }
        let ref = recentActionRefForAssertion({ label, type, snapshotText });
        if (['TEXT', 'VALUE', 'CHECKED', 'SELECTED', 'DATE', 'TIME', 'DATETIME'].includes(type)) {
          const inputType = type === 'DATE'
            ? 'date'
            : type === 'TIME'
              ? 'time'
              : type === 'DATETIME'
                ? 'datetime-local'
                : null;
          let editable = resolveEditableControl(snapshotText, {
            label,
            role: target.role || null,
            inputType,
          });
          if (!editable?.ok && inputType && editable?.reason !== 'ambiguous_editable_control') {
            const customControl = resolveEditableControl(snapshotText, {
              label,
              role: target.role || null,
            });
            if (customControl?.ok || customControl?.reason === 'ambiguous_editable_control') {
              editable = customControl;
            }
          }
          if (!ref && editable?.ok) {
            ref = editable.ref;
          } else if (!ref && editable?.reason === 'ambiguous_editable_control') {
            const duplicateRefs = [...new Set((editable.candidates || []).map((candidate) => candidate?.ref).filter(Boolean))];
            if (duplicateRefs.length === 1) ref = duplicateRefs[0];
          }
        }
        if (!ref && type === 'ATTRIBUTE') {
          const attributeOwner = resolveClickableControl(snapshotText, {
            authoredLabel: label,
            role: target.role || null,
          });
          if (attributeOwner?.ok) ref = attributeOwner.ref;
        }
        if (!ref && ['VISIBLE', 'HIDDEN'].includes(type)) {
          const visibleTarget = resolveSnapshotElement(snapshotText, {
            authoredLabel: label,
            role: target.role || null,
          });
          if (visibleTarget?.ok) ref = visibleTarget.ref;
        }
        if (!ref) {
          ref = await kernelResolveRef({
            step: { action: 'Hover', target: label, element: label, targetRole: target.role || null },
            toolName: 'browser_hover',
            snapshotText,
          });
        }
        if (!ref) {
          const present = elementPresentInSnapshot(snapshotText, target.role, target.name);
          if (['VISIBLE', 'HIDDEN'].includes(type)) {
            return {
              fresh: true,
              actual: { visible: present },
              evidenceChannels: [{
                kind: 'ax_visibility',
                visible: present,
                targetMatched: true,
                source: 'mcp_accessibility_snapshot_target_search',
              }],
            };
          }
          return { fresh: true, uncheckable: true, reason: present
            ? 'typed_assertion_target_ambiguous' : 'typed_assertion_target_not_observed' };
        }
        const fn = assertionStateProbe.probeFunction(assertion);
        let evidence = null;
        try {
          const result = await mcp.callTool(mcpSession, 'browser_evaluate', {
            function: fn,
            element: label,
            target: ref,
          }, { strictActionEvidence: false, source: 'typed_assertion_exact_target', telemetry: false, timeoutMs: 2_000 });
          if (!result?.isError) {
            const text = mcp.textOfContent(result?.content) || '';
            evidence = mcp.parseEvaluateReturnValue ? mcp.parseEvaluateReturnValue(text) : null;
            if (typeof evidence === 'string') { try { evidence = JSON.parse(evidence); } catch (_) {} }
            if (!evidence || typeof evidence !== 'object') {
              const match = text.match(/\{[\s\S]*\}/);
              if (match) { try { evidence = JSON.parse(match[0]); } catch (_) {} }
            }
          }
        } catch (_) {}
        if (!evidence || evidence.found === false) {
          return { fresh: true, uncheckable: true, reason: 'typed_assertion_dom_evidence_unavailable' };
        }
        const actual = assertionStateProbe.actualFromEvidence(assertion, evidence, page);
        const scalarActual = actual && typeof actual === 'object'
          ? (actual.value ?? actual.actual ?? actual.selectedValue ?? actual.selectedText ?? actual.text ?? actual.textContent ?? actual)
          : actual;
        const visible = evidence.visible !== false && evidence.hidden !== true;
        const evidenceChannels = [];
        if (type === 'TEXT') {
          evidenceChannels.push({
            kind: 'dom_visible_text', text: scalarActual, visible, searched: true,
            targetMatched: true, source: 'browser_evaluate_exact_target',
          });
        } else if (['VALUE', 'DATE', 'TIME', 'DATE_TIME', 'DATETIME'].includes(type)) {
          evidenceChannels.push({
            kind: 'owner_control_value', value: scalarActual,
            ownerMatched: true, readback: true, source: 'browser_evaluate_owner_readback',
          });
        } else if (type === 'SELECTED') {
          evidenceChannels.push({
            kind: 'owner_selected_value', selectedValue: scalarActual,
            ownerMatched: true, readback: true, source: 'browser_evaluate_selected_readback',
          });
        } else if (['VISIBLE', 'HIDDEN'].includes(type)) {
          evidenceChannels.push({
            kind: 'dom_visibility', visible: actual?.visible ?? visible,
            targetMatched: true, source: 'browser_evaluate_exact_target',
          });
        }
        return { fresh: true, actual, evidenceChannels };
      },
      seal: async ({ idx, step, payload }) => {
        const record = payload.record || null;
        const isAssertion = payload.family === 'assertion';
        const internalOperationCompletion = payload.internalOperationCompletion === true;
        const internalWaitCompletion = internalOperationCompletion
          && payload.internalOperationKind === 'wait_for_state';
        const internalOptionalAbsent = internalOperationCompletion
          && (payload.internalOperationKind === 'optional_absent' || record?.optionalAbsent === true);
        const internalScrollCompletion = internalOperationCompletion
          && payload.internalOperationKind === 'scroll_utility';
        const runtimeToolName = internalWaitCompletion
          ? 'internal_wait_for_state'
          : internalOptionalAbsent
            ? 'internal_optional_absent'
          : internalScrollCompletion
            ? 'internal_scroll_utility'
          : internalOperationCompletion
            ? 'generic_transition_already_satisfied'
          : isAssertion
            ? 'assertion_check'
            : (payload.runtimeToolName || 'unresolved_runtime_tool');
        const resultReason = internalWaitCompletion || internalOptionalAbsent || internalScrollCompletion
          ? payload.reason
          : internalOperationCompletion
            ? 'declared_transition_already_satisfied'
          : payload.reason;
        const resultCheck = {
          status: payload.status,
          expected: isAssertion ? (record?.expected ?? step.expected ?? null) : (step.operationCheck?.expected || step.expected || null),
          actual: isAssertion ? (record?.actual ?? record?.observed ?? null) : null,
          comparator: isAssertion ? (record?.comparator || null) : null,
          matched: internalOptionalAbsent ? true : payload.assertionOutcome === 'matched' ? true : payload.assertionOutcome === 'not_matched' ? false : null,
          checked: internalOptionalAbsent || internalScrollCompletion ? true : payload.assertionOutcome !== 'uncheckable' && record?.evaluated !== false,
          reason: resultReason,
          evidence: record?.evidence || record?.reason || resultReason,
          kind: isAssertion ? 'oracle' : internalScrollCompletion ? 'scroll_utility' : (step.operationCheck?.kind || record?.kind || payload.family),
          target: kernelStepTarget(step),
          required: payload.family === 'wait' || isAssertion || internalOptionalAbsent || internalScrollCompletion ? false : step.required !== false,
          synthetic: true,
          outcomeKind: payload.outcomeKind,
          optionalAbsent: internalOptionalAbsent,
        };
        if (stepResults[idx]) {
          if (isAssertion) stepResults[idx].assertionResult = resultCheck;
          else stepResults[idx].operationCheck = resultCheck;
          if (payload.family === 'event') stepResults[idx].browserEventEvidence = record;
        }
        const row = stepResults[idx] || {};
        const stepRef = row.stepId || row.index || idx + 1;
        try {
          stepResults = executionJournal.recordAttempt(stepResults, stepRef, {
            toolUseId: `universal-${tc.id}-${idx + 1}-${Date.now()}`,
            tool: runtimeToolName,
            target: kernelStepTarget(step),
            waitContract: waitContract.buildWaitContract(step),
            actualOutcome: payload.actionOutcome || (payload.status === 'pass' ? 'succeeded' : 'failed'),
            reason: resultReason,
            optionalAbsent: internalOptionalAbsent,
            universalActionDiagnostics: payload.diagnostics || null,
          });
        } catch (_) {}
        const error = payload.status === 'pass' ? null
          : payload.outcomeKind === universalActionKernel.OUTCOME_KINDS.FUNCTIONAL_FAILURE
            ? `FUNCTIONAL_EXPECTATION_NOT_MATCHED: ${payload.reason}`
            : `QAAI_ACTION_EXECUTION_UNCERTAIN: ${payload.reason}`;
        const reduced = kernelSeal({
          idx,
          proposedStatus: payload.status,
          error,
          toolName: runtimeToolName,
          operationResult: isAssertion ? null : {
            ...record,
            ...resultCheck,
            reason: resultReason,
            kind: internalWaitCompletion || internalScrollCompletion ? resultCheck.kind : 'operation_check',
            required: resultCheck.required,
          },
          assertionResult: isAssertion ? { ...record, ...resultCheck, kind: 'oracle', required: resultCheck.required } : null,
          internalOperationCompletion,
          source: 'universal_action_kernel',
        });
        const sealedRow = stepResults[idx] || reduced || {};
        const finalStatus = sealedRow.status || resultCheck.status;
        const finalReason = finalStatus === resultCheck.status
          ? resultCheck.reason
          : (sealedRow.continuationReason || sealedRow.reason || sealedRow.error || resultCheck.reason);
        const emittedCheck = { ...resultCheck, status: finalStatus, reason: finalReason };
        if (stepResults[idx]) {
          if (isAssertion) stepResults[idx].assertionResult = emittedCheck;
          else stepResults[idx].operationCheck = emittedCheck;
        }
        if (isAssertion) {
          assertionCheckResults.push({
            ...emittedCheck,
            assertionId: step.assertionId || step.contractStepId || step.id || null,
            outcome: payload.assertionOutcome,
            source: record?.assertionKind ? 'strict_assertion_engine' : 'typed_assertion_comparator',
          });
        }
        send({ type: isAssertion ? 'step.assertion' : 'step.operationCheck', runId, tcId: tc.id, stepIndex: idx + 1, ...emittedCheck });
        return { sealed: sealedRow, hasRunnableStep: currentStepIndex < totalSteps };
      },
    },
  });
*/});

const SESSION_CONTINUITY_BRIDGE = sourceBlock(function sessionContinuityBridge() {/*
          const tcSessionMode = sessionModeForCase(tc);
          const tcDependencyIds = dependencyGraph.decodeDeps(tc && tc.dependsOnIds);
          const tcContinuityGroupId = dependencyGraph.continuityGroupId(tc.id, runGraph);
          let forceFreshCaseStart = modeStartsFresh(tcSessionMode);

          const blockUnavailableContinuation = async ({ reason, dependencyCaseId = null } = {}) => {
            const blockedReason = 'session_continuity_unavailable';
            const detail = String(reason || 'continuation_session_not_found');
            const error = `Required continuation session for "${tc.name}" is unavailable (${detail}). The case was not executed; QAAI did not create a browser, reuse an unrelated session, replay authentication, or revisit login.`;
            let created = null;
            try {
              created = await prisma.runResult.create({
                data: { runId: runRow.id, testCaseId: tc.id, status: 'blocked', error, blockedReason },
                select: { id: true },
              });
            } catch (_) {}
            caseOutcomes.set(tc.id, {
              status: 'blocked',
              runResultId: created ? created.id : null,
              blockedReason,
              continuationSatisfied: false,
            });
            dependencyFindings.push({
              code: blockedReason,
              tcId: tc.id,
              dependencyCaseId,
              continuityGroupId: tcContinuityGroupId,
              reason: detail,
              enforced: true,
            });
            send({ type: 'result', runId: runRow.id, tcId: tc.id, status: 'blocked', error, blockedReason, durationMs: null });
            send({
              type: 'agent.phase.log',
              phase: 'conductor',
              level: 'blocked',
              message: `   BLOCKED "${tc.name}" before execution: required session continuity was unavailable (${detail}).`,
              tcId: tc.id,
            });
            try {
              const counters = await recomputeRunCounters(runRow.id);
              send({ type: 'run.counters', runId: runRow.id, projectId, ...counters });
            } catch (_) {}
          };

          if (modeRequiresDependency(tcSessionMode)) {
            if (tcDependencyIds.length === 0) {
              await blockUnavailableContinuation({
                reason: 'dependency_case_missing',
              });
              continue;
            }
            if (!tcContinuityGroupId) {
              await blockUnavailableContinuation({
                reason: 'continuity_group_unresolvable',
                dependencyCaseId: tcDependencyIds[0] || null,
              });
              continue;
            } else {
              let continuationLease = null;
              try {
                continuationLease = await universalAuthSessionManager.acquireSessionForCase({
                  registry: sessionRegistry,
                  userId,
                  projectId,
                  runId: runRow.id,
                  testCase: tc,
                  continuityGroupId: tcContinuityGroupId,
                });
              } catch (leaseError) {
                continuationLease = {
                  session: null,
                  reused: false,
                  reason: leaseError && leaseError.message ? leaseError.message : 'continuation_session_lease_failed',
                };
              }
              if (continuationLease && continuationLease.session) {
                mcpSession = continuationLease.session;
                forceFreshCaseStart = false;
                send({
                  type: 'agent.phase.log',
                  phase: 'conductor',
                  level: 'info',
                  message: `   Reusing the exact authenticated browser session from dependency group "${tcContinuityGroupId}" for "${tc.name}" (${continuationLease.leaseSource || 'dependency_scope'}). No browser, context, page, or login flow was recreated.`,
                  tcId: tc.id,
                });
              } else {
                await blockUnavailableContinuation({
                  reason: continuationLease && continuationLease.reason ? continuationLease.reason : 'dependency_session_not_found',
                  dependencyCaseId: tcDependencyIds[0] || null,
                });
                continue;
              }
            }
          }

          if (forceFreshCaseStart && scenarioContext && scenarioContext.casesCompleted > 0 && !dryRun) {
            send({
              type: 'agent.phase.log',
              phase: 'conductor',
              level: 'info',
              message: `   "${tc.name}" declares sessionMode=${tcSessionMode}; starting a clean browser session instead of inheriting prior case state.`,
              tcId: tc.id,
            });
            try { await startFreshMcpSessionForScenario(scenario); } catch (_) {}
            scenarioContext.messages = null;
          }
*/});

const DATA_BINDING_DIAGNOSTIC_FALLBACK = sourceBlock(function dataBindingDiagnosticFallback() {/*
          if (__bindingDefect) {
            dependencyFindings.push({
              code: 'data_binding_contract_diagnostic',
              tcId: tc.id,
              defectCode: __bindingDefect.code || null,
              message: __bindingDefect.message || null,
              enforced: false,
            });
            send({
              type: 'agent.phase.log',
              phase: 'conductor',
              level: 'warn',
              message: `   WARN Test-data binding diagnostic for "${tc.name}": ${__bindingDefect.message || __bindingDefect.code || 'invalid data binding'}. QAAI will preserve and execute the complete authored case instead of dropping its steps.`,
              tcId: tc.id,
            });
          }
          let dataRows = [];
          try {
            dataRows = testDataMatrix.resolveCaseRows(runtimeBaseTc, scenario, runTestData, {
              isJourneyMember,
              collector: dependencyFindings,
              onLog: (level, message) => send({ type: 'agent.phase.log', phase: 'conductor', level, message, tcId: tc.id }),
            });
          } catch (rowResolutionError) {
            dependencyFindings.push({
              code: 'data_row_resolution_diagnostic',
              tcId: tc.id,
              message: rowResolutionError && rowResolutionError.message ? rowResolutionError.message : String(rowResolutionError || 'unknown row-resolution error'),
              enforced: false,
            });
            send({
              type: 'agent.phase.log',
              phase: 'conductor',
              level: 'warn',
              message: `   WARN Test-data rows could not be resolved for "${tc.name}" (${rowResolutionError && rowResolutionError.message ? rowResolutionError.message : rowResolutionError}). Executing the complete authored case once with its inline/runtime values.`,
              tcId: tc.id,
            });
            dataRows = [];
          }
*/});

const ROW_DEFECT_DIAGNOSTIC = sourceBlock(function rowDefectDiagnostic() {/*
              if (__rowDefect) {
                dependencyFindings.push({
                  code: 'data_row_contract_diagnostic',
                  tcId: tc.id,
                  dataRowIndex: row.index,
                  message: String(__rowDefect),
                  enforced: false,
                });
                send({
                  type: 'agent.phase.log',
                  phase: 'conductor',
                  level: 'warn',
                  message: `   WARN Data row ${(row.index || 0) + 1}/${executions.length} has a contract contradiction (${__rowDefect}). The complete row and authored steps will still execute; the result will retain this data diagnostic.`,
                  tcId: tc.id,
                });
              }
            }
*/});

const UNRESOLVED_TOKEN_DIAGNOSTIC = sourceBlock(function unresolvedTokenDiagnostic() {/*
            // Residual data tokens are visible diagnostics, never a reason to omit
            // the authored row or its dependent steps from execution/output.
            {
              const unresolved = testDataMatrix.findUnresolvedTokens(useTc);
              if (unresolved.length) {
                const { recordDegradation } = require('../../lib/degradationSignal');
                recordDegradation({
                  onLog: (level, message) => send({ type: 'agent.phase.log', phase: 'conductor', level, message, tcId: tc.id }),
                  collector: dependencyFindings,
                  stage: 'data-binding',
                  severity: 'warning',
                  reason: row
                    ? `unresolved data token(s): ${unresolved.map((token) => `{{${token}}}`).join(', ')} for "${tc.name}" data row ${ei + 1}/${executions.length}`
                    : `unresolved executable token(s): ${unresolved.map((token) => `{{${token}}}`).join(', ')} for "${tc.name}"`,
                  impact: 'authored execution retained; replace or map the diagnosed token value',
                });
                send({
                  type: 'agent.phase.log',
                  phase: 'conductor',
                  level: 'warn',
                  message: `   WARN "${tc.name}" retains ${unresolved.length} unresolved data token(s) (${unresolved.map((token) => `{{${token}}}`).join(', ')}). QAAI will execute every authored step and expose the exact tokens for repair instead of skipping the row.`,
                  tcId: tc.id,
                });
              }
            }
*/});

const MALFORMED_ASSERTION_DIAGNOSTIC = sourceBlock(function malformedAssertionDiagnostic() {/*
            if (!row) {
              const malformedMust = declaredAssertionsLib.findMalformedMustAssertions(useTc.declaredAssertions);
              if (malformedMust.length) {
                const first = malformedMust[0] || {};
                dependencyFindings.push({
                  code: 'malformed_assertion_diagnostic',
                  tcId: tc.id,
                  assertionId: first.id || null,
                  issue: first.issue || null,
                  enforced: false,
                });
                send({
                  type: 'agent.phase.log',
                  phase: 'conductor',
                  level: 'warn',
                  message: `   WARN "${tc.name}" contains a malformed must assertion (${first.issue || 'unknown'}). The browser flow and every authored step will still execute; this assertion will be reported as uncheckable rather than blocking the case.`,
                  tcId: tc.id,
                });
              }
            }
*/});

const DATA_MUTEX_DIAGNOSTIC = sourceBlock(function dataMutexDiagnostic() {/*
            let __rowLease = null;
            let caseResult = null;
            if (row && !dryRun) {
              try {
                __rowLease = await testDataMutex.acquireRowLeases({
                  prisma,
                  projectId,
                  runId: runRow.id,
                  testCaseId: tc.id,
                  row,
                  onLog: (level, message) => send({ type: 'agent.phase.log', phase: 'conductor', level, message, tcId: tc.id }),
                });
              } catch (mutexError) {
                dependencyFindings.push({
                  code: 'test_data_mutex_diagnostic',
                  tcId: tc.id,
                  dataRowIndex: row.index,
                  message: mutexError && mutexError.message ? mutexError.message : String(mutexError || 'mutex unavailable'),
                  enforced: false,
                });
                send({
                  type: 'agent.phase.log',
                  phase: 'conductor',
                  level: 'warn',
                  message: `   WARN Test-data row lease is unavailable for "${tc.name}" row ${(row.index || 0) + 1}/${executions.length} (${mutexError && mutexError.message ? mutexError.message : mutexError}). Execution will continue and retain this collision-risk diagnostic.`,
                  tcId: tc.id,
                });
                __rowLease = null;
              }
            }
*/});

const CASE_SESSION_PERSISTENCE = sourceBlock(function caseSessionPersistence() {/*
          try {
            const __outcome = caseOutcomes.get(tc.id);
            const __continuationSatisfied = __outcome
              && (__outcome.status === 'pass' || __outcome.continuationSatisfied === true);
            if (__continuationSatisfied) {
              if (__outcome.status === 'pass') {
                scenarioContext.casesPassed = (scenarioContext.casesPassed || 0) + 1;
              }
              if (mcpSession && userId && projectId && runRow.id && tc.id) {
                const __continuityGroupId = dependencyGraph.continuityGroupId(tc.id, runGraph);
                sessionRegistry.setScoped(
                  {
                    userId,
                    projectId,
                    runId: runRow.id,
                    caseId: tc.id,
                    continuityGroupId: __continuityGroupId,
                  },
                  mcpSession,
                );
              }
              if (__outcome.status !== 'pass') {
                send({
                  type: 'agent.phase.log',
                  phase: 'conductor',
                  level: 'warn',
                  message: `   WARN "${tc.name}" retained validation-only failures, but its execution state is complete. Dependent cases will reuse this exact browser session.`,
                  tcId: tc.id,
                });
              }
            } else if (__outcome && __outcome.status) {
              send({
                type: 'agent.phase.log',
                phase: 'conductor',
                level: 'warn',
                message: `   WARN "${tc.name}" completed with status ${__outcome.status}${__outcome.blockedReason ? `/${__outcome.blockedReason}` : ''}. This result is retained as evidence and does not implicitly block unrelated later cases; only an authored failurePolicy=block_dependents dependency can do that.`,
                tcId: tc.id,
              });
            }
          } catch (_) {}
*/});

const ACTION_EXECUTION_GATEWAY_FACADE = sourceBlock(function actionExecutionGatewayFacade() {/*
const mcpTransport = require('../mcp');
const actionExecutionGateway = require('../actionExecutionGateway');
let gatewayInfrastructureSequence = 0;
const mcp = {
  ...mcpTransport,
  callTool(session, toolName, args, options = {}) {
    const dispatchOptions = options && typeof options === 'object' ? { ...options } : {};
    if (session && typeof session === 'object') session.executionGatewayRequired = true;
    const targetRequirements = actionExecutionGateway.targetActionabilityRequirements(toolName, args || {});
    if (targetRequirements.required) {
      dispatchOptions.requireActionableTarget = true;
      dispatchOptions.targetActionabilityTimeoutMs = Math.min(
        15_000,
        Math.max(500, Number(dispatchOptions.targetActionabilityTimeoutMs || dispatchOptions.timeoutMs) || 5_000),
      );
      dispatchOptions.targetActionabilityPollIntervalMs = Math.min(
        500,
        Math.max(100, Number(dispatchOptions.targetActionabilityPollIntervalMs) || 250),
      );
      if (typeof dispatchOptions.observeTargetActionability !== 'function') {
        dispatchOptions.observeTargetActionability = async ({ requirements }) => {
          let snapshot = null;
          try {
            snapshot = await mcpTransport.snapshot(session, {
              skipSnapshotStability: true,
              source: 'gateway_target_actionability',
              timeoutMs: 2_000,
            });
          } catch (_) {}
          const snapshotText = snapshot?.text || mcpTransport.textOfContent(snapshot?.content) || '';
          return actionExecutionGateway.evaluateTargetActionabilitySnapshot({ requirements, snapshotText });
        };
      }
    }
    const actionOccurrenceId = dispatchOptions.actionOccurrenceId
      || `gateway:${session?.id || 'session'}:${toolName}:${++gatewayInfrastructureSequence}`;
    return actionExecutionGateway.dispatchMcpTool({
      callTool: mcpTransport.callTool,
      session,
      toolName,
      args: args || {},
      options: dispatchOptions,
      actionOccurrenceId,
      source: dispatchOptions.source || 'conductor_gateway',
    });
  },
};
*/});

const AUTH_FIXTURE_CDP_DIRECT_CALL = sourceBlock(function authFixtureCdpDirectCall() {/*
      await mcpSession.client.callTool({
        name: 'browser_execute_cdp_command',
        arguments: { command: 'Network.setCookies', params: { cookies } },
      });
*/});

const AUTH_FIXTURE_CDP_GATEWAY_CALL = sourceBlock(function authFixtureCdpGatewayCall() {/*
      await mcp.callTool(mcpSession, 'browser_execute_cdp_command', {
        command: 'Network.setCookies',
        params: { cookies },
      }, {
        actionOccurrenceId: `auth-fixture:${fixture?.id || fixture?.name || 'fixture'}:cookies`,
        source: 'auth_fixture_cookie_injection',
        authoredAction: false,
      });
*/});

const AUTH_FIXTURE_NAVIGATE_DIRECT_CALL = sourceBlock(function authFixtureNavigateDirectCall() {/*
      await mcpSession.client.callTool({ name: 'browser_navigate', arguments: { url: origin.origin } });
*/});

const AUTH_FIXTURE_NAVIGATE_GATEWAY_CALL = sourceBlock(function authFixtureNavigateGatewayCall() {/*
      await mcp.callTool(mcpSession, 'browser_navigate', { url: origin.origin }, {
        actionOccurrenceId: `auth-fixture:${fixture?.id || fixture?.name || 'fixture'}:${origin.origin}:navigate`,
        source: 'auth_fixture_storage_origin',
        authoredAction: false,
      });
*/});

const AUTH_FIXTURE_EVALUATE_DIRECT_CALL = sourceBlock(function authFixtureEvaluateDirectCall() {/*
      await mcpSession.client.callTool({ name: 'browser_evaluate', arguments: { function: `() => { ${script} }` } });
*/});

const AUTH_FIXTURE_EVALUATE_GATEWAY_CALL = sourceBlock(function authFixtureEvaluateGatewayCall() {/*
      await mcp.callTool(mcpSession, 'browser_evaluate', { function: `() => { ${script} }` }, {
        actionOccurrenceId: `auth-fixture:${fixture?.id || fixture?.name || 'fixture'}:${origin.origin}:local-storage`,
        source: 'auth_fixture_local_storage',
        authoredAction: false,
      });
*/});

function transformConductorSource(input) {
  let source = String(input || '').replace(/\r\n/g, '\n');

  source = replaceExactlyOnce(
    source,
    'action-execution-gateway-facade',
    "const mcp = require('../mcp');",
    ACTION_EXECUTION_GATEWAY_FACADE,
  );
  source = replaceExactlyOnce(
    source,
    'auth-fixture-cdp-gateway',
    AUTH_FIXTURE_CDP_DIRECT_CALL,
    AUTH_FIXTURE_CDP_GATEWAY_CALL,
  );
  source = replaceExactlyOnce(
    source,
    'auth-fixture-navigation-gateway',
    AUTH_FIXTURE_NAVIGATE_DIRECT_CALL,
    AUTH_FIXTURE_NAVIGATE_GATEWAY_CALL,
  );
  source = replaceExactlyOnce(
    source,
    'auth-fixture-local-storage-gateway',
    AUTH_FIXTURE_EVALUATE_DIRECT_CALL,
    AUTH_FIXTURE_EVALUATE_GATEWAY_CALL,
  );

  source = replaceExactlyOnce(
    source,
    'generic-click-execution-authority',
    "const { genericTransitionAlreadySatisfied } = require('../transitionState');",
    `const { genericTransitionAlreadySatisfied } = require('../transitionState');\nconst genericClickExecution = require('../genericClickExecution');\nconst universalActionKernel = require('../universalActionKernel');\nconst conductorUniversalRuntime = require('../conductorUniversalRuntime');\nconst mcpBrowserEventAdapters = require('../mcpBrowserEventAdapters');\nconst assertionStateProbe = require('../assertionStateProbe');\nconst universalAuthSessionManager = require('../universalAuthSessionManager');\nconst semanticTargetReveal = require('../semanticTargetReveal');\nconst actionTransactionRepository = require('../actionTransactionRepository');\n\n${ACTION_OCCURRENCE_HELPERS}`,
  );

  source = replaceExactlyOnce(
    source,
    'reject-unrelated-generic-text-fill-fallback',
    "    if (kindCompatible) score += 40;\n    if (hits === 0 && !kindCompatible && parsed.ref !== structuralRef) continue;",
    "    if (kindCompatible) score += 40;\n    if (requestedKind === 'text' && hits === 0 && parsed.ref !== structuralRef) continue;\n    if (hits === 0 && !kindCompatible && parsed.ref !== structuralRef) continue;",
  );

  source = replaceSectionExactlyOnce(
    source,
    'remove-implicit-scenario-poison-declaration',
    '        // -- STATEFUL CONTINUITY GUARD (audit) --------------------------------',
    '        // Enterprise Mode P5 - execute this scenario\'s cases in dependency order',
    "        // Session continuity is governed by authored dependency metadata and\n        // scoped live-session leases. A failed case never poisons unrelated cases.\n",
  );
  source = replaceSectionExactlyOnce(
    source,
    'install-authored-session-continuity',
    '          // -- STATEFUL CONTINUITY GATE (audit) - implicit prerequisite enforcement --',
    '          // TestData Round B - resolve a data-bound case',
    SESSION_CONTINUITY_BRIDGE,
  );
  source = replaceSectionExactlyOnce(
    source,
    'data-binding-diagnostic-fallback',
    '            if (__bindingDefect) {',
    '          const executions = dataRows.length ? dataRows : [null];',
    DATA_BINDING_DIAGNOSTIC_FALLBACK,
  );
  source = replaceSectionExactlyOnce(
    source,
    'data-row-defect-diagnostic',
    '              if (__rowDefect) {',
    '            // -- B-2d.2 hook 2 (flag-gated) - PER-CASE SESSION RESET --------------',
    ROW_DEFECT_DIAGNOSTIC,
  );
  source = replaceSectionExactlyOnce(
    source,
    'unresolved-token-diagnostic',
    '            // #36a - EXECUTION-TIME UNRESOLVED-TOKEN GATE. A data-driven row whose',
    '            if (!row) {',
    UNRESOLVED_TOKEN_DIAGNOSTIC,
  );
  source = replaceSectionExactlyOnce(
    source,
    'malformed-assertion-diagnostic',
    '            if (!row) {',
    "            if (row && typeof __emitDataRowStart === 'function') {",
    MALFORMED_ASSERTION_DIAGNOSTIC,
  );
  source = replaceSectionExactlyOnce(
    source,
    'data-mutex-diagnostic',
    '            let __rowLease = null;\n            let caseResult = null;\n            if (row && !dryRun) {',
    '            try {\n              activeExecutionCase = { id: useTc.id || tc.id, name: useTc.name || tc.name };',
    DATA_MUTEX_DIAGNOSTIC,
  );
  source = replaceSectionExactlyOnce(
    source,
    'case-session-persistence-without-poison',
    '          // STATEFUL CONTINUITY: if this case did NOT pass, the scenario\'s shared',
    '          if (suiteAbortReason) break;',
    CASE_SESSION_PERSISTENCE,
  );
  source = replaceExactlyOnce(
    source,
    'action-occurrence-case-runtime',
    '  const actionTrail = [];',
    ACTION_OCCURRENCE_CASE_RUNTIME,
  );

  source = replaceExactlyOnce(
    source,
    'data-row-storage-clear-non-authored',
    "      }, { source: 'data_row_recovery' });",
    "      }, { source: 'data_row_recovery', authoredAction: false });",
  );
  source = replaceExactlyOnce(
    source,
    'data-row-recovery-navigation-non-authored',
    "        await mcp.callTool(mcpSession, 'browser_navigate', { url: targetUrl }, { source: 'data_row_recovery' });",
    "        await mcp.callTool(mcpSession, 'browser_navigate', { url: targetUrl }, { source: 'data_row_recovery', authoredAction: false });",
  );
  source = replaceExactlyOnce(
    source,
    'per-row-storage-clear-non-authored',
    "                  await mcp.callTool(mcpSession, 'browser_evaluate', {\n                    function: '() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }',\n                  });",
    "                  await mcp.callTool(mcpSession, 'browser_evaluate', {\n                    function: '() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} }',\n                  }, { source: 'per_row_session_reset', authoredAction: false });",
  );

  source = replaceExactlyOnce(
    source,
    'main-action-occurrence-after-realignment',
    '      await realignPastPassiveVerification();',
    `      await realignPastPassiveVerification();
      {
        const occurrenceTrailEntry = actionTrail[actionTrail.length - 1];
        if (occurrenceTrailEntry && occurrenceTrailEntry.tool === tu.name && occurrenceTrailEntry.toolUseId === tu.id
            && isStepMutatingTool(tu.name, tu.input || occurrenceTrailEntry.args || {})) {
          Object.assign(occurrenceTrailEntry, requireContractMetadataForTool(tu.name, tu.input || occurrenceTrailEntry.args || {}, currentStepIndex));
          ensureTrailActionOccurrence(occurrenceTrailEntry, { toolName: tu.name, args: tu.input || {}, stepIndex: currentStepIndex });
        }
      }`,
  );
  source = replaceExactlyOnce(
    source,
    'main-action-resolver-identity',
    '                elementLabel: targetElement,\n              });',
    "                elementLabel: targetElement,\n                ...actionDispatchIdentity(trailEntry, { source: 'main_pre_dispatch_resolver' }),\n              });",
  );
  source = replaceExactlyOnce(
    source,
    'main-action-dispatch-identity',
    '              result = await mcp.callTool(mcpSession, tu.name, resolvedInput, dispatchOptions);',
    "              const dispatchTrailEntry = actionTrail[actionTrail.length - 1] || null;\n              const requiresVerifiedTarget = actionExecutionGateway.requiresVerifiedSemanticTarget(tu.name, resolvedInput);\n              const dispatchLocator = pendingActionLocator || dispatchTrailEntry?.actionLocatorPending || null;\n              const verifiedTarget = !requiresVerifiedTarget || actionLocatorResolver.isVerifiedActionLocator(dispatchLocator);\n              const locatorPrimary = dispatchLocator ? actionLocatorResolver.primaryActionLocator(dispatchLocator) : null;\n              Object.assign(dispatchOptions, actionDispatchIdentity(dispatchTrailEntry || {}, { source: 'main_authored_dispatch' }), requiresVerifiedTarget ? {\n                requireVerifiedTarget: true,\n                targetAuthorization: {\n                  schemaVersion: 'qaai-live-target-authorization-v1',\n                  status: verifiedTarget ? 'verified' : 'unverified',\n                  liveMutationAllowed: verifiedTarget,\n                  diagnosticOnly: locatorPrimary?.diagnosticOnly === true,\n                  isGuess: locatorPrimary?.guess?.isGuess === true,\n                  verificationSource: locatorPrimary?.verificationSource || locatorPrimary?.evidenceSource || locatorPrimary?.proof?.source || null,\n                  reason: verifiedTarget ? 'verified_action_locator' : 'verified_action_locator_required',\n                },\n              } : {});\n              result = await mcp.callTool(mcpSession, tu.name, resolvedInput, dispatchOptions);",
  );
  source = replaceExactlyOnce(
    source,
    'weak-live-ref-observation-only',
    '} else if (refPresentInSnapshot) {\n                    liveRefDispatch = true;',
    '} else if (refPresentInSnapshot) {\n                    // Snapshot presence is discovery evidence only. Without a verified semantic locator,\n                    // the gateway must reject live mutation rather than treating this ref as dispatch authority.\n                    liveRefDispatch = false;',
  );
  source = replaceExactlyOnce(
    source,
    'memory-replay-occurrence-allocation',
    "      const targetElement = elementLabelFromArgs(toolName, resolvedArgs) || memoryReplayTargetForStep(declaredStep) || memoryResolution.reason || toolName;\n      let pendingActionLocator = null;",
    "      const targetElement = elementLabelFromArgs(toolName, resolvedArgs) || memoryReplayTargetForStep(declaredStep) || memoryResolution.reason || toolName;\n      const memoryActionIdentity = identityForNewActionOccurrence({ toolName, args: resolvedArgs, stepIndex: i, reuseDeferred: true });\n      let pendingActionLocator = null;",
  );
  source = replaceExactlyOnce(
    source,
    'memory-to-model-occurrence-reuse',
    '      if (!actionLocatorResolver.isVerifiedActionLocator(pendingActionLocator)) {\n        memoryReplayNotes.push(`memory locator for "${targetElement}" was not verified by browser-side DOM inspection; model execution will continue instead of replaying weak evidence`);\n        break;\n      }',
    '      if (!actionLocatorResolver.isVerifiedActionLocator(pendingActionLocator)) {\n        deferActionOccurrence(memoryActionIdentity);\n        memoryReplayNotes.push(`memory locator for "${targetElement}" was not verified by browser-side DOM inspection; model execution will continue instead of replaying weak evidence`);\n        break;\n      }',
  );
  source = replaceExactlyOnce(
    source,
    'optional-dismiss-fresh-presence-preflight',
    "    let snap = mcp.getLastSnapshot(mcpSession) || lastSnapshotText || '';\n    if (!snap) {\n      const refreshed = await freshValidationSnapshot();\n      if (refreshed.fresh) snap = refreshed.text;\n    }",
    "    const refreshedOptionalPresence = await freshValidationSnapshot();\n    if (!refreshedOptionalPresence?.fresh || !refreshedOptionalPresence.text) return false;\n    const snap = refreshedOptionalPresence.text;",
  );
  source = replaceExactlyOnce(
    source,
    'optional-dismiss-canonical-absence-commit',
    "        'optional_prompt_absent',\n        `Optional prompt \"${target}\" is not present in the current page state; no dismissal action is needed.`,\n      );",
    "        'optional_target_absent',\n        `Optional prompt \"${target}\" is not present in the fresh page state; no dismissal action is needed.`,\n        { optionalAbsent: true, failureImpact: 'optional_absent' },\n      );",
  );
  source = replaceExactlyOnce(
    source,
    'optional-dismiss-occurrence-and-trail',
    "      const result = await mcp.callTool(mcpSession, 'browser_click', args).catch((err) => ({\n        isError: true,\n        content: [{ type: 'text', text: err.message || String(err) }],\n      }));",
    "      const optionalDismissIdentity = identityForNewActionOccurrence({ toolName: 'browser_click', args, stepIndex: currentStepIndex, reuseDeferred: true });\n      const result = await mcp.callTool(mcpSession, 'browser_click', args, actionDispatchIdentity(optionalDismissIdentity, { source: 'optional_prompt_dismiss' })).catch((err) => ({\n        isError: true,\n        content: [{ type: 'text', text: err.message || String(err) }],\n      }));\n      const optionalDismissTrail = {\n        turn: -0.4, tool: 'browser_click', args, stepIndex: currentStepIndex,\n        narration: 'Dismissed optional prompt ' + target + ' by clicking ' + label + '.',\n        ok: !result?.isError, actionStatus: 'executed', ...optionalDismissIdentity,\n        ...requireContractMetadataForTool('browser_click', args, currentStepIndex),\n      };\n      appendActionTrailEntry(optionalDismissTrail, { result, status: result?.isError ? 'fail' : 'pass' });\n      if (result?.isError) deferActionOccurrence(optionalDismissIdentity);",
  );
  source = replaceExactlyOnce(
    source,
    'authored-or-infrastructure-pre-navigation',
    "      const navRes = await mcp.callTool(mcpSession, 'browser_navigate', { url: startUrl });",
    "      const preNavigationStep = approvedSteps[0] || null;\n      const preNavigationAuthored = !!(preNavigationStep && pipelineContract.toolCanCompleteStep('browser_navigate', preNavigationStep));\n      const preNavigationIdentity = preNavigationAuthored\n        ? identityForNewActionOccurrence({ toolName: 'browser_navigate', args: { url: startUrl }, stepIndex: 0, reuseDeferred: true })\n        : null;\n      const navRes = await mcp.callTool(mcpSession, 'browser_navigate', { url: startUrl }, actionDispatchIdentity(preNavigationIdentity || {}, { source: preNavigationAuthored ? 'authored_case_start_navigation' : 'infrastructure_case_start_navigation' }));\n      if (navRes?.isError && preNavigationIdentity) deferActionOccurrence(preNavigationIdentity);",
  );
  source = replaceExactlyOnce(
    source,
    'pre-navigation-trail-occurrence',
    "        turn: -1,\n        tool: 'browser_navigate',",
    "        turn: -1,\n        ...(preNavigationIdentity || {}),\n        tool: 'browser_navigate',",
  );
  source = replaceExactlyOnce(
    source,
    'continuation-navigation-non-authored',
    "            const nav = await mcp.callTool(mcpSession, 'browser_navigate', { url: startUrl });",
    "            const nav = await mcp.callTool(mcpSession, 'browser_navigate', { url: startUrl }, { source: 'continuation_entry_recovery', authoredAction: false });",
  );
  source = replaceExactlyOnce(
    source,
    'continuation-snapshot-non-authored',
    "          const snap = await mcp.callTool(mcpSession, 'browser_snapshot', {});",
    "          const snap = await mcp.callTool(mcpSession, 'browser_snapshot', {}, { source: 'continuation_state_refresh', authoredAction: false });",
  );
  source = replaceExactlyOnce(
    source,
    'blocked-field-probe-diagnostic-identity',
    "          { strictActionEvidence: false, source: 'field_blocked_probe', telemetry: false, timeoutMs: VALIDATION_SNAPSHOT_TIMEOUT_MS });",
    "          { strictActionEvidence: false, source: 'field_blocked_probe', telemetry: false, timeoutMs: VALIDATION_SNAPSHOT_TIMEOUT_MS, authoredAction: false, assertionLinked: true, diagnosticMutation: true, sourceContractStepId: trailEntry?.contractStepId || approvedSteps[currentStepIndex]?.contractStepId || null });",
  );
  source = replaceExactlyOnce(
    source,
    'restore-trail-identity-parameter',
    "  const appendRestoreTrailEntry = ({ turnNo, tool, args, result, stepIndex, narration, beforeSnapshot, recoveryReason = 'lost_form_state' }) => {",
    "  const appendRestoreTrailEntry = ({ turnNo, tool, args, result, stepIndex, narration, beforeSnapshot, recoveryReason = 'lost_form_state', actionIdentity }) => {",
  );
  source = replaceExactlyOnce(
    source,
    'restore-trail-deterministic-identity',
    "      toolUseId: `restore-${tc.id}-${stepIndex + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,",
    "      toolUseId: actionIdentity.actionOccurrenceId,\n      ...actionIdentity,",
  );
  source = replaceExactlyOnce(
    source,
    'restore-trail-recorder-refresh',
    '    actionTrail.splice(insertAt, 0, entry);\n    return entry;',
    "    actionTrail.splice(insertAt, 0, entry);\n    refreshActionTrailEvidence(entry, { result, status: result?.isError ? 'fail' : 'pass' });\n    return entry;",
  );
  source = replaceExactlyOnce(
    source,
    'restore-fill-source-link-parameter',
    '  const restoreFillStep = async ({ desc, turnNo }) => {',
    '  const restoreFillStep = async ({ desc, turnNo, sourceTrailEntry = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'restore-fill-predispatch-identity',
    "    const args = { element: desc.element, target, text: desc.value };\n    const result = await mcp.callTool(mcpSession, 'browser_type', args).catch((err) => ({",
    "    const args = { element: desc.element, target, text: desc.value };\n    const restoreActionIdentity = identityForNewActionOccurrence({ toolName: 'browser_type', args, stepIndex: desc.stepIndex, sourceActionOccurrenceId: sourceTrailEntry?.actionOccurrenceId || null, sourceContractStepId: sourceTrailEntry?.contractStepId || null });\n    const result = await mcp.callTool(mcpSession, 'browser_type', args, actionDispatchIdentity(restoreActionIdentity, { source: 'pre_submit_restore_fill' })).catch((err) => ({",
  );
  source = replaceExactlyOnce(
    source,
    'restore-fill-trail-identity',
    '      beforeSnapshot: snapshotText,\n    });\n    return { ok: !result?.isError, reason: result?.isError ? \'restore_type_failed\' : \'restored\' };',
    "      beforeSnapshot: snapshotText,\n      actionIdentity: restoreActionIdentity,\n    });\n    return { ok: !result?.isError, reason: result?.isError ? 'restore_type_failed' : 'restored' };",
  );
  source = replaceExactlyOnce(
    source,
    'restore-select-source-link-parameter',
    '  const restoreSelectStep = async ({ desc, turnNo }) => {',
    '  const restoreSelectStep = async ({ desc, turnNo, sourceTrailEntry = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'restore-native-select-predispatch-identity',
    "    const selectArgs = { element: desc.element, target: controlTarget, values: [desc.value] };\n    let result = await mcp.callTool(mcpSession, 'browser_select_option', selectArgs).catch((err) => ({",
    "    const selectArgs = { element: desc.element, target: controlTarget, values: [desc.value] };\n    const restoreSelectIdentity = identityForNewActionOccurrence({ toolName: 'browser_select_option', args: selectArgs, stepIndex: desc.stepIndex, sourceActionOccurrenceId: sourceTrailEntry?.actionOccurrenceId || null, sourceContractStepId: sourceTrailEntry?.contractStepId || null });\n    let result = await mcp.callTool(mcpSession, 'browser_select_option', selectArgs, actionDispatchIdentity(restoreSelectIdentity, { source: 'pre_submit_restore_select' })).catch((err) => ({",
  );
  source = replaceExactlyOnce(
    source,
    'restore-native-select-trail-identity',
    '      narration: `Restored ${desc.element} selection after form state loss`,\n      beforeSnapshot: snapshotText,\n    });',
    '      narration: `Restored ${desc.element} selection after form state loss`,\n      beforeSnapshot: snapshotText,\n      actionIdentity: restoreSelectIdentity,\n    });',
  );
  source = replaceExactlyOnce(
    source,
    'restore-open-select-predispatch-identity',
    "    const clickArgs = { element: desc.element, target: controlTarget };\n    result = await mcp.callTool(mcpSession, 'browser_click', clickArgs).catch((err) => ({",
    "    const clickArgs = { element: desc.element, target: controlTarget };\n    const restoreOpenIdentity = identityForNewActionOccurrence({ toolName: 'browser_click', args: clickArgs, stepIndex: desc.stepIndex, sourceActionOccurrenceId: sourceTrailEntry?.actionOccurrenceId || null, sourceContractStepId: sourceTrailEntry?.contractStepId || null });\n    result = await mcp.callTool(mcpSession, 'browser_click', clickArgs, actionDispatchIdentity(restoreOpenIdentity, { source: 'pre_submit_restore_open_select' })).catch((err) => ({",
  );
  source = replaceExactlyOnce(
    source,
    'restore-open-select-trail-identity',
    '      narration: `Opened ${desc.element} to restore selection`,\n      beforeSnapshot: snapshotText,\n    });',
    '      narration: `Opened ${desc.element} to restore selection`,\n      beforeSnapshot: snapshotText,\n      actionIdentity: restoreOpenIdentity,\n    });',
  );
  source = replaceExactlyOnce(
    source,
    'restore-option-predispatch-identity',
    "    const optionArgs = { element: `${desc.value} option`, target: optionTarget };\n    result = await mcp.callTool(mcpSession, 'browser_click', optionArgs).catch((err) => ({",
    "    const optionArgs = { element: `${desc.value} option`, target: optionTarget };\n    const restoreOptionIdentity = identityForNewActionOccurrence({ toolName: 'browser_click', args: optionArgs, stepIndex: desc.stepIndex, sourceActionOccurrenceId: sourceTrailEntry?.actionOccurrenceId || null, sourceContractStepId: sourceTrailEntry?.contractStepId || null });\n    result = await mcp.callTool(mcpSession, 'browser_click', optionArgs, actionDispatchIdentity(restoreOptionIdentity, { source: 'pre_submit_restore_option' })).catch((err) => ({",
  );
  source = replaceExactlyOnce(
    source,
    'restore-option-trail-identity',
    '      narration: `Selected ${desc.value} to restore ${desc.element}`,\n      beforeSnapshot: snapshotText,\n    });',
    '      narration: `Selected ${desc.value} to restore ${desc.element}`,\n      beforeSnapshot: snapshotText,\n      actionIdentity: restoreOptionIdentity,\n    });',
  );
  source = replaceExactlyOnce(
    source,
    'restore-coordinator-source-link-parameter',
    '  const autoRestoreLostFormState = async ({ turnNo, submitTarget }) => {',
    '  const autoRestoreLostFormState = async ({ turnNo, submitTarget, sourceTrailEntry = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'restore-coordinator-source-link-forwarding',
    '        ? await restoreSelectStep({ desc, turnNo })\n        : await restoreFillStep({ desc, turnNo });',
    '        ? await restoreSelectStep({ desc, turnNo, sourceTrailEntry })\n        : await restoreFillStep({ desc, turnNo, sourceTrailEntry });',
  );
  source = replaceExactlyOnce(
    source,
    'restore-submit-source-link-call',
    "              const restoreSummary = await autoRestoreLostFormState({\n                turnNo: turn,\n                submitTarget: targetElement || resolvedInput?.element || resolvedInput?.label || 'submit',\n              });",
    "              const restoreSummary = await autoRestoreLostFormState({\n                turnNo: turn,\n                submitTarget: targetElement || resolvedInput?.element || resolvedInput?.label || 'submit',\n                sourceTrailEntry: trailEntry,\n              });",
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-fill-identity-parameter',
    '  const deterministicDomFillByLabel = async ({ label, value }) => {',
    '  const deterministicDomFillByLabel = async ({ label, value, actionIdentity = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-fill-dispatch-identity',
    "      const res = await mcp.callTool(mcpSession, 'browser_evaluate', { function: fn },\n        { strictActionEvidence: false, source: 'deterministic_dom_fill', telemetry: false });",
    "      const mutationIdentity = actionIdentity || identityForNewActionOccurrence({ toolName: 'deterministic_dom_fill', args: { label, value }, stepIndex: currentStepIndex });\n      const res = await mcp.callTool(mcpSession, 'browser_evaluate', { function: fn },\n        actionDispatchIdentity(mutationIdentity, { strictActionEvidence: false, source: 'deterministic_dom_fill', telemetry: false }));",
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-fill-return-identity',
    "      return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'unparseable_dom_fill_result' };",
    "      return parsed && typeof parsed === 'object' ? { ...parsed, actionIdentity: mutationIdentity } : { ok: false, reason: 'unparseable_dom_fill_result', actionIdentity: mutationIdentity };",
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-select-identity-parameter',
    '  const deterministicDomSelectByLabel = async ({ label, value }) => {',
    '  const deterministicDomSelectByLabel = async ({ label, value, actionIdentity = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-select-dispatch-identity',
    "      const res = await mcp.callTool(mcpSession, 'browser_evaluate', { function: fn },\n        { strictActionEvidence: false, source: 'deterministic_dom_select', telemetry: false });",
    "      const mutationIdentity = actionIdentity || identityForNewActionOccurrence({ toolName: 'deterministic_dom_select', args: { label, value }, stepIndex: currentStepIndex });\n      const res = await mcp.callTool(mcpSession, 'browser_evaluate', { function: fn },\n        actionDispatchIdentity(mutationIdentity, { strictActionEvidence: false, source: 'deterministic_dom_select', telemetry: false }));",
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-select-return-identity',
    "      return parsed && typeof parsed === 'object' ? parsed : { ok: false, reason: 'unparseable_dom_select_result' };",
    "      return parsed && typeof parsed === 'object' ? { ...parsed, actionIdentity: mutationIdentity } : { ok: false, reason: 'unparseable_dom_select_result', actionIdentity: mutationIdentity };",
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-select-trail-identity',
    '          narration: `Selected ${label} by deterministic DOM label matching`,\n        });',
    '          narration: `Selected ${label} by deterministic DOM label matching`,\n          actionIdentity: domResult.actionIdentity,\n        });',
  );
  source = replaceExactlyOnce(
    source,
    'deterministic-dom-select-recovery-reuse',
    '        const recovery = await deterministicDomSelectByLabel({ label, value });',
    '        const recovery = await deterministicDomSelectByLabel({ label, value, actionIdentity: trailEntry });',
  );
  source = replaceExactlyOnce(
    source,
    'memory-replay-resolver-identity',
    "          elementLabel: targetElement,\n        });\n        pendingActionLocator = strictLocatorResult.actionLocator || null;",
    "          elementLabel: targetElement,\n          ...actionDispatchIdentity(memoryActionIdentity, { source: 'project_memory_resolver' }),\n        });\n        pendingActionLocator = strictLocatorResult.actionLocator || null;",
  );
  source = replaceExactlyOnce(
    source,
    'memory-replay-trail-identity',
    '        ...requireContractMetadataForTool(toolName, resolvedArgs, i),\n      };\n      appendActionTrailEntry(trailEntry, { status: \'blocked\' });',
    "        ...requireContractMetadataForTool(toolName, resolvedArgs, i),\n        ...memoryActionIdentity,\n      };\n      appendActionTrailEntry(trailEntry, { status: 'blocked' });",
  );
  source = replaceExactlyOnce(
    source,
    'memory-replay-dispatch-identity',
    '        result = await mcp.callTool(mcpSession, toolName, resolvedArgs);',
    "        result = await mcp.callTool(mcpSession, toolName, resolvedArgs, actionDispatchIdentity(memoryActionIdentity, { source: 'project_memory_dispatch' }));",
  );
  source = replaceExactlyOnce(
    source,
    'memory-dispatch-failure-occurrence-reuse',
    '      if (result?.isError) {\n        if (memoryResolution.memoryId) {',
    '      if (result?.isError) {\n        deferActionOccurrence(memoryActionIdentity);\n        if (memoryResolution.memoryId) {',
  );
  source = replaceExactlyOnce(
    source,
    'pre-submit-form-resolver-identity',
    "      elementLabel: targetElement || 'current form',\n    }).catch(() => null);",
    "      elementLabel: targetElement || 'current form',\n      ...actionDispatchIdentity(trailEntry, { source: 'pre_submit_form_resolver' }),\n    }).catch(() => null);",
  );
  source = replaceExactlyOnce(
    source,
    'bounded-resolver-occurrence-identity',
    '        elementLabel: targetElement,\n      });\n      lastFulfillment = fulfillment || lastFulfillment;',
    "        elementLabel: targetElement,\n        ...actionDispatchIdentity(trailEntry, { source: 'bounded_pre_dispatch_resolver' }),\n      });\n      lastFulfillment = fulfillment || lastFulfillment;",
  );
  source = replaceExactlyOnce(
    source,
    'forced-resolver-occurrence-identity',
    '          contractNode,\n        });\n        if (actionLocatorResolver.isVerifiedActionLocator(forced)) {',
    "          contractNode,\n          ...actionDispatchIdentity(trailEntry, { source: 'forced_deep_locator_resolver' }),\n        });\n        if (actionLocatorResolver.isVerifiedActionLocator(forced)) {",
  );
  source = replaceExactlyOnce(
    source,
    'kb-retry-resolver-occurrence-identity',
    '                  elementLabel: targetElement,\n                });\n                if (actionLocatorResolver.isVerifiedActionLocator(strictRetryLocator.actionLocator)) {',
    "                  elementLabel: targetElement,\n                  ...actionDispatchIdentity(healingTrailEntry, { source: 'kb_retry_resolver' }),\n                });\n                if (actionLocatorResolver.isVerifiedActionLocator(strictRetryLocator.actionLocator)) {",
  );
  source = replaceExactlyOnce(
    source,
    'kb-retry-dispatch-occurrence-identity',
    '              retryRes = await mcp.callTool(mcpSession, tu.name, retryArgs);\n              healBudget.recordOutput(retryRes, { targetElement, toolName: tu.name, phase: \'kb_ref_retry\' });',
    "              retryRes = await mcp.callTool(mcpSession, tu.name, retryArgs, actionDispatchIdentity(healingTrailEntry, { source: 'kb_ref_retry' }));\n              healBudget.recordOutput(retryRes, { targetElement, toolName: tu.name, phase: 'kb_ref_retry' });",
  );
  source = replaceExactlyOnce(
    source,
    'healed-retry-resolver-occurrence-identity',
    '                    elementLabel: targetElement,\n                  });\n                  if (actionLocatorResolver.isVerifiedActionLocator(strictRetryLocator.actionLocator)) {',
    "                    elementLabel: targetElement,\n                    ...actionDispatchIdentity(healingTrailEntry, { source: 'healed_retry_resolver' }),\n                  });\n                  if (actionLocatorResolver.isVerifiedActionLocator(strictRetryLocator.actionLocator)) {",
  );
  source = replaceExactlyOnce(
    source,
    'healed-retry-dispatch-occurrence-identity',
    "                retryRes = await mcp.callTool(mcpSession, tu.name, retryArgs);\n                healBudget.recordOutput(retryRes, { targetElement, toolName: tu.name, phase: 'healed_retry' });",
    "                retryRes = await mcp.callTool(mcpSession, tu.name, retryArgs, actionDispatchIdentity(healingTrailEntry, { source: 'healed_retry' }));\n                healBudget.recordOutput(retryRes, { targetElement, toolName: tu.name, phase: 'healed_retry' });",
  );
  source = replaceExactlyOnce(
    source,
    'post-action-reacquisition-occurrence-identity',
    '              elementLabel: targetElement || elementLabelFromArgs(tu.name, tu.input || trailEntry.args || {}) || tu.name,\n            });\n            const repairedLocator =',
    "              elementLabel: targetElement || elementLabelFromArgs(tu.name, tu.input || trailEntry.args || {}) || tu.name,\n              ...actionDispatchIdentity(trailEntry, { source: 'post_action_locator_reacquisition' }),\n            });\n            const repairedLocator =",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-trail-occurrence-parameter',
    '  const kernelAppendTrail = ({ tool, args, stepIndex, result, snapshotBefore, narration }) => {',
    '  const kernelAppendTrail = ({ tool, args, stepIndex, result, snapshotBefore, narration, actionIdentity = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'kernel-trail-deterministic-identity',
    "    const text = mcp.textOfContent(result?.content) || '';\n    const entry = {\n      toolUseId: `kernel-${tc.id}-${stepIndex + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,",
    "    const text = mcp.textOfContent(result?.content) || '';\n    const occurrenceIdentity = actionIdentity || identityForNewActionOccurrence({ toolName: tool, args, stepIndex });\n    const entry = {\n      toolUseId: occurrenceIdentity.actionOccurrenceId,\n      ...occurrenceIdentity,",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-exact-fill-identity-parameter',
    '  const kernelRetryExactFill = async ({ idx, step, label, value, snapshotBefore, reason }) => {',
    '  const kernelRetryExactFill = async ({ idx, step, label, value, snapshotBefore, reason, actionIdentity = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'kernel-exact-fill-dispatch-identity',
    '    let retryResult;\n    try {\n      retryResult = await mcp.callTool(mcpSession, retryTool, retryArgs);',
    "    const retryActionIdentity = actionIdentity || identityForNewActionOccurrence({ toolName: retryTool, args: retryArgs, stepIndex: idx });\n    let retryResult;\n    try {\n      retryResult = await mcp.callTool(mcpSession, retryTool, retryArgs, actionDispatchIdentity(retryActionIdentity, { source: 'deterministic_exact_fill_retry' }));",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-exact-fill-trail-identity',
    '      narration: `Retried Fill ${label} on the fresh exact ref`,\n    });',
    '      narration: `Retried Fill ${label} on the fresh exact ref`,\n      actionIdentity: retryActionIdentity,\n    });',
  );
  source = replaceExactlyOnce(
    source,
    'kernel-exact-click-identity-parameter',
    '  const kernelRetryExactClick = async ({ idx, label, snapshotBefore, reason }) => {',
    '  const kernelRetryExactClick = async ({ idx, label, snapshotBefore, reason, actionIdentity = null }) => {',
  );
  source = replaceExactlyOnce(
    source,
    'kernel-exact-click-dispatch-identity',
    "    let result;\n    try { result = await mcp.callTool(mcpSession, 'browser_click', args); }",
    "    const retryActionIdentity = actionIdentity || identityForNewActionOccurrence({ toolName: 'browser_click', args, stepIndex: idx });\n    let result;\n    try { result = await mcp.callTool(mcpSession, 'browser_click', args, actionDispatchIdentity(retryActionIdentity, { source: 'deterministic_exact_click_retry' })); }",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-exact-click-trail-identity',
    '      narration: `Retried Click ${label} on the fresh exact ref`,\n    });',
    '      narration: `Retried Click ${label} on the fresh exact ref`,\n      actionIdentity: retryActionIdentity,\n    });',
  );
  source = replaceExactlyOnce(
    source,
    'kernel-initial-dispatch-identity',
    '    let result;\n    try {\n      result = await mcp.callTool(mcpSession, toolName, args);',
    "    const kernelActionIdentity = identityForNewActionOccurrence({ toolName, args, stepIndex: idx });\n    let result;\n    try {\n      result = await mcp.callTool(mcpSession, toolName, args, actionDispatchIdentity(kernelActionIdentity, { source: 'deterministic_kernel_initial_dispatch' }));",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-initial-trail-identity',
    '      narration: isFill ? `Filled ${label}` : isNavigate ? `Opened ${value || label}` : isSelect ? `Selected ${label}` : `Clicked ${label}`,\n    });',
    '      narration: isFill ? `Filled ${label}` : isNavigate ? `Opened ${value || label}` : isSelect ? `Selected ${label}` : `Clicked ${label}`,\n      actionIdentity: kernelActionIdentity,\n    });',
  );
  source = replaceExactlyOnce(
    source,
    'kernel-failed-fill-retry-reuse',
    "        const retry = await kernelRetryExactFill({ idx, step, label, value, snapshotBefore, reason: 'initial_dispatch_failed' });",
    "        const retry = await kernelRetryExactFill({ idx, step, label, value, snapshotBefore, reason: 'initial_dispatch_failed', actionIdentity: trailEntry });",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-failed-click-retry-reuse',
    "        const recovery = await kernelRetryExactClick({ idx, label, snapshotBefore, reason: 'initial_dispatch_failed' });",
    "        const recovery = await kernelRetryExactClick({ idx, label, snapshotBefore, reason: 'initial_dispatch_failed', actionIdentity: trailEntry });",
  );
  source = replaceExactlyOnce(
    source,
    'kernel-readback-fill-retry-reuse',
    '        const retry = await kernelRetryExactFill({ idx, step, label, value, snapshotBefore, reason: finalReason });',
    '        const retry = await kernelRetryExactFill({ idx, step, label, value, snapshotBefore, reason: finalReason, actionIdentity: trailEntry });',
  );

  source = replaceExactlyOnce(
    source,
    'adaptive-validation-observation-source',
    "source: 'single_pass_validation_snapshot'",
    "source: 'adaptive_validation_observation'",
  );
  source = replaceSectionExactlyOnce(
    source,
    'adaptive-page-ready-resolver',
    'async function resolvePageReadyProbe({',
    'async function validateSnapshotSinglePassPolicy({',
    ADAPTIVE_PAGE_READY_RESOLVER,
  );
  source = replaceSectionExactlyOnce(
    source,
    'adaptive-validation-wrapper',
    '  const validateSnapshotSinglePass = (options = {}) => validateSnapshotSinglePassPolicy({',
    '  const normName =',
    ADAPTIVE_VALIDATION_WRAPPER,
  );

  source = replaceSectionExactlyOnce(
    source,
    'typed-assertion-channel',
    "    if (typedVerify && typeof typedVerify === 'object' && typedVerify.kind) {",
    '    const stepIsOracle = contract.verificationPoint === true;',
    TYPED_ASSERTION_CHANNEL,
  );

  source = replaceSectionExactlyOnce(
    source,
    'generic-page-ready-probe',
    "    if (normalized === 'page_ready') {",
    '    return {\n      matched: !!snapshotText,',
    GENERIC_PAGE_READY_PROBE,
  );
  source = replaceSectionExactlyOnce(
    source,
    'generic-page-ready-operation',
    "    if (kind === 'page_ready') {",
    "    if (kind === 'style_changed') {",
    GENERIC_PAGE_READY_OPERATION,
  );

  source = replaceExactlyOnce(
    source,
    'generic-click-kernel-adapter',
    '  const runDeterministicKernelStep = async ({ fillOnly = false } = {}) => {',
    `${GENERIC_CLICK_KERNEL_ADAPTER}\n  const runDeterministicKernelStep = async ({ fillOnly = false } = {}) => {`,
  );
  source = replaceExactlyOnce(
    source,
    'universal-action-runtime-adapter',
    '  const runDeterministicKernelStep = async ({ fillOnly = false } = {}) => {',
    `${UNIVERSAL_ACTION_RUNTIME_ADAPTER}\n  const runDeterministicKernelStep = async ({ fillOnly = false } = {}) => {`,
  );
  source = replaceExactlyOnce(
    source,
    'universal-action-runtime-dispatch',
    "    if (!step || stepResults[idx]?.status !== 'pending') return { handled: false, reason: 'not_pending' };\n    const kernelKind = deterministicActionEngine.stepKind(step, pipelineContract);",
    "    if (!step || stepResults[idx]?.status !== 'pending') return { handled: false, reason: 'not_pending' };\n    if (process.env.QAAI_DISABLE_UNIVERSAL_ACTION_RUNTIME !== '1') {\n      activeUniversalActionIdentity = null;\n      let universalResult;\n      try {\n        universalResult = await conductorUniversalActionRuntime.run({ idx, step, fillOnly, actionId: `${runId}:${tc.id}:${idx + 1}` });\n      } finally {\n        activeUniversalActionIdentity = null;\n      }\n      if (universalResult.handled) return universalResult;\n    }\n    const kernelKind = deterministicActionEngine.stepKind(step, pipelineContract);",
  );
  source = replaceExactlyOnce(
    source,
    'generic-click-kernel-dispatch',
    "    let snapshotBefore = '';",
    "    const ownerAwarePopupClick = isClick && /\\b(dropdown|drop down|combobox|combo box|select menu|options menu)\\b/i.test([\n      kernelStepTarget(step),\n      step.action,\n      step.type,\n      step.expected,\n      step.check,\n      step.operationCheck?.expected,\n    ].filter(Boolean).join(' '));\n    if (isClick && !ownerAwarePopupClick) return runGenericClickKernelStep({ idx, step });\n\n    let snapshotBefore = '';",
  );

  source = replaceSectionExactlyOnce(
    source,
    'seal-assertion-classification',
    '    const isValidation = originalRow.assertionStep === true',
    '    try {\n      const latestTrail =',
    SEAL_ASSERTION_CLASSIFICATION,
  );
  source = replaceExactlyOnce(
    source,
    'seal-assertion-branch',
    '    if (assertionMismatch) {',
    '    if (assertionMismatch || assertionUncheckable) {',
  );
  source = replaceExactlyOnce(
    source,
    'seal-action-evidence-mismatch',
    '        evidence: assertionResult || operationResult || originalRow.evidence || null,\n      });\n      stepResults = executionJournal.recordAssertionOutcome',
    '        evidence: actionEvidence,\n      });\n      stepResults = executionJournal.recordAssertionOutcome',
  );
  source = replaceExactlyOnce(
    source,
    'seal-assertion-outcome',
    "        outcome: 'not_matched',\n        blocking: blockingAssertion,\n        requiredForContinuation: blockingAssertion,",
    "        outcome: assertionUncheckable ? 'uncheckable' : 'not_matched',\n        blocking: false,\n        requiredForContinuation: false,",
  );
  source = replaceExactlyOnce(
    source,
    'seal-action-evidence-pass',
    '        evidence: operationResult || assertionResult || originalRow.evidence || null,\n      });\n      if (isValidation',
    '        evidence: actionEvidence,\n      });\n      if (isValidation',
  );
  source = replaceExactlyOnce(
    source,
    'journal-boundary-oracle-fallback',
    '            if (!proved && !result.isError) {',
    "            if (!proved && !result.isError && record?.kind !== 'oracle') {",
  );

  source = replaceSectionExactlyOnce(
    source,
    'no-runnable-journal-prompt',
    '  const currentRequiredStepIndex = approvedSteps.length && currentStepIndex < approvedSteps.length',
    '  let perCaseUserMsg;',
    NO_RUNNABLE_PROMPT,
  );

  source = replaceSectionExactlyOnce(
    source,
    'pre-ratification-journal-reconciliation',
    '  if (isMechanical && !caseFatalError && !incompleteExecution) {',
    '    // Termination-signal inputs for the ladder.',
    PRE_RATIFICATION_RECONCILIATION,
  );

  return source;
}

let runtimeAuthority = null;

function loadConductorRuntime() {
  if (runtimeAuthority) return runtimeAuthority;
  const filename = require.resolve('./conductor');
  const original = fs.readFileSync(filename, 'utf8');
  const transformed = transformConductorSource(original);

  // Compile the CommonJS wrapper before touching require.cache. A malformed
  // runtime patch therefore fails startup without partially installing itself.
  new vm.Script(Module.wrap(transformed), { filename, displayErrors: true });

  const previous = require.cache[filename];
  const runtimeModule = new Module(filename, module.parent || module);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  require.cache[filename] = runtimeModule;
  try {
    runtimeModule._compile(transformed, filename);
    runtimeAuthority = runtimeModule.exports;
    return runtimeAuthority;
  } catch (error) {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
    throw error;
  }
}

module.exports = {
  actionOccurrenceReuseKey,
  transformConductorSource,
  loadConductorRuntime,
};
