'use strict';

const crypto = require('node:crypto');
const { privacySafeValue } = require('./actionTransactionJournal');
const browserMutationTaxonomy = require('./browserMutationTaxonomy');

const SCHEMA_VERSION = 1;

const TRANSACTION_STATUS = Object.freeze({
  CREATED: 'created',
  CAPTURING_PRE_STATE: 'capturing_pre_state',
  READY: 'ready',
  DISPATCHING: 'dispatching',
  OBSERVING: 'observing',
  COMMITTED: 'committed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

const DISPATCH_STATUS = Object.freeze({
  NOT_DISPATCHED: 'not_dispatched',
  DISPATCHING: 'dispatching',
  DELIVERED: 'delivered',
  NOT_DELIVERED: 'not_delivered',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
  NOT_REQUIRED: 'not_required',
});

const OUTCOME_KIND = Object.freeze({
  SUCCESS: 'success',
  FUNCTIONAL_FAILURE: 'functional_failure',
  EXECUTION_UNCERTAINTY: 'execution_uncertainty',
});

const FAILURE_MODE = Object.freeze({
  DEPENDENT_BLOCK: 'dependent_block',
  VALIDATION_ONLY: 'validation_only',
});

const TERMINAL_STATUSES = new Set([
  TRANSACTION_STATUS.COMMITTED,
  TRANSACTION_STATUS.FAILED,
  TRANSACTION_STATUS.BLOCKED,
]);

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function stableId(prefix, seed) {
  const digest = crypto.createHash('sha256').update(stableStringify(seed)).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

function identityTarget(target) {
  if (target == null || typeof target !== 'object') return String(target || '').trim();
  return {
    id: target.id || target.testId || target.qaaiId || null,
    role: target.role || null,
    name: target.name || target.label || target.text || null,
    frame: target.frameId || target.framePath || null,
  };
}

function transactionIdentity(input = {}) {
  const action = input.action && typeof input.action === 'object' ? input.action : {};
  return {
    runId: input.runId || null,
    caseId: input.caseId || input.testCaseId || null,
    stepId: input.stepId || action.stepId || null,
    sequenceIndex: Number.isInteger(input.sequenceIndex) ? input.sequenceIndex : 0,
    occurrenceIndex: Number.isInteger(input.occurrenceIndex) ? input.occurrenceIndex : 0,
    actionKind: input.actionKind || action.kind || action.action || action.type || 'action',
    target: identityTarget(input.target || action.target || null),
  };
}

function toSerializable(value) {
  return privacySafeValue(value);
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(toSerializable(value)));
}

function sensitiveTransactionInput(input = {}) {
  const action = input.action && typeof input.action === 'object' ? input.action : {};
  const target = input.target || action.target || {};
  const semantic = [
    action.kind,
    action.type,
    action.inputType,
    action.name,
    action.label,
    typeof target === 'string' ? target : target.type,
    target && typeof target === 'object' ? target.inputType : null,
    target && typeof target === 'object' ? target.name : null,
    target && typeof target === 'object' ? target.label : null,
  ].filter(Boolean).join(' ');
  return input.sensitive === true
    || input.privacy?.sensitive === true
    || action.sensitive === true
    || (target && typeof target === 'object' && target.sensitive === true)
    || /(?:password|passwd|passphrase|secret|credential|access token|refresh token|api key|private key)/i.test(semantic);
}

function transactionPrivacy(input = {}, transactionId = 'pending') {
  const action = input.action && typeof input.action === 'object' ? input.action : {};
  const sensitive = sensitiveTransactionInput(input);
  const valueRef = input.valueRef || input.privacy?.valueRef || action.valueRef || null;
  return {
    sensitive,
    valueRef: sensitive ? String(valueRef || `redacted://action-transaction/${transactionId}/value`) : null,
    persistence: sensitive ? 'value_ref_only' : 'literal_allowed',
  };
}

function transactionSafeValue(value, transaction) {
  return privacySafeValue(value, { sensitive: transaction?.privacy?.sensitive === true });
}

function safeTransactionSnapshot(transaction) {
  const snapshot = cloneSerializable(transaction);
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  snapshot.privacy = transactionPrivacy(snapshot, snapshot.transactionId || 'persisted');
  for (const key of ['action', 'preState', 'dispatchAttempts', 'observations', 'canonicalOutcome']) {
    snapshot[key] = transactionSafeValue(snapshot[key], snapshot);
  }
  return snapshot;
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(Number(value)).toISOString();
}

function normalizeFailureMode(value) {
  return value === FAILURE_MODE.VALIDATION_ONLY
    ? FAILURE_MODE.VALIDATION_ONLY
    : FAILURE_MODE.DEPENDENT_BLOCK;
}

function createActionTransaction(input = {}, { now = Date.now } = {}) {
  const identity = transactionIdentity(input);
  const actionOccurrenceId = input.actionOccurrenceId || stableId('action-occurrence', identity);
  const transactionId = input.transactionId || stableId('action-transaction', {
    actionOccurrenceId,
    schemaVersion: SCHEMA_VERSION,
  });
  const createdAt = timestamp(now);
  const action = input.action && typeof input.action === 'object' ? input.action : {};
  const toolName = String(input.toolName || action.toolName || action.tool || '').trim();
  const mutationPolicy = browserMutationTaxonomy.mutationPolicyForTool(toolName);
  const mutating = browserMutationTaxonomy.isMutatingTool(toolName, input.args || action.args || {})
    || input.mutating !== false;
  const privacy = transactionPrivacy(input, transactionId);
  return {
    schemaVersion: SCHEMA_VERSION,
    transactionId,
    actionOccurrenceId,
    toolName: toolName || null,
    mutationPolicy,
    runId: identity.runId,
    caseId: identity.caseId,
    stepId: identity.stepId,
    sequenceIndex: identity.sequenceIndex,
    occurrenceIndex: identity.occurrenceIndex,
    action: transactionSafeValue(input.action || {
      kind: identity.actionKind,
      target: input.target || null,
    }, { privacy }),
    privacy,
    mutating,
    failureMode: normalizeFailureMode(input.failureMode),
    status: TRANSACTION_STATUS.CREATED,
    dispatchStatus: mutating ? DISPATCH_STATUS.NOT_DISPATCHED : DISPATCH_STATUS.NOT_REQUIRED,
    dispatchTimestamp: null,
    dispatchAttemptCount: 0,
    dispatchAttempts: [],
    preState: null,
    preStateCaptured: false,
    observations: [],
    canonicalOutcome: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function hydrateActionTransaction(value) {
  if (!value || typeof value !== 'object') throw new TypeError('persisted transaction must be an object');
  const transaction = safeTransactionSnapshot(value);
  if (!transaction.transactionId || !transaction.actionOccurrenceId) {
    throw new Error('persisted transaction is missing its stable identity');
  }
  transaction.schemaVersion = Number(transaction.schemaVersion || SCHEMA_VERSION);
  transaction.failureMode = normalizeFailureMode(transaction.failureMode);
  transaction.dispatchAttempts = Array.isArray(transaction.dispatchAttempts) ? transaction.dispatchAttempts : [];
  transaction.dispatchAttemptCount = Number.isInteger(transaction.dispatchAttemptCount)
    ? transaction.dispatchAttemptCount
    : transaction.dispatchAttempts.length;
  transaction.observations = Array.isArray(transaction.observations) ? transaction.observations : [];
  transaction.preStateCaptured = transaction.preStateCaptured === true || transaction.preState != null;
  transaction.canonicalOutcome = transaction.canonicalOutcome || null;
  return transaction;
}

function serializeActionTransaction(transaction) {
  return JSON.stringify(safeTransactionSnapshot(transaction));
}

function isTerminalTransaction(transaction) {
  return TERMINAL_STATUSES.has(transaction?.status);
}

function normalizeProof(value, transaction = null) {
  if (value === true) return { matched: true, checked: true, terminal: true, reason: 'postcondition_proven' };
  if (value === false) return { matched: false, checked: true, terminal: false, reason: 'postcondition_not_matched' };
  if (!value || typeof value !== 'object') {
    return { matched: null, checked: false, terminal: false, reason: 'postcondition_uncheckable' };
  }
  return {
    ...transactionSafeValue(value, transaction),
    matched: value.matched === true ? true : value.matched === false ? false : null,
    checked: value.checked === true || value.matched === true || value.matched === false,
    terminal: value.terminal === true || value.matched === true,
    reason: String(value.reason || (value.matched === true
      ? 'postcondition_proven'
      : value.matched === false ? 'postcondition_not_matched' : 'postcondition_uncheckable')),
  };
}

function positiveNonDeliveryProof(value) {
  return value === true || value?.proven === true || value?.positivelyNotDelivered === true;
}

function continuationMetadata(failureMode, passed) {
  if (passed) {
    return {
      failureMode,
      shouldContinue: true,
      blockDependents: false,
      validationOnly: failureMode === FAILURE_MODE.VALIDATION_ONLY,
    };
  }
  const validationOnly = failureMode === FAILURE_MODE.VALIDATION_ONLY;
  return {
    failureMode,
    shouldContinue: validationOnly,
    blockDependents: !validationOnly,
    validationOnly,
  };
}

async function persistState(transaction, persist, now) {
  transaction.updatedAt = timestamp(now);
  if (typeof persist === 'function') await persist(safeTransactionSnapshot(transaction));
}

async function finalize(transaction, proof, { persist, now, reason } = {}) {
  const matched = proof?.matched === true;
  const checkedMismatch = proof?.matched === false && proof?.checked === true;
  const failureMode = normalizeFailureMode(transaction.failureMode);
  const validationOnly = failureMode === FAILURE_MODE.VALIDATION_ONLY;
  transaction.status = matched
    ? TRANSACTION_STATUS.COMMITTED
    : validationOnly ? TRANSACTION_STATUS.FAILED : TRANSACTION_STATUS.BLOCKED;
  transaction.canonicalOutcome = {
    status: matched ? 'passed' : validationOnly ? 'failed' : 'blocked',
    outcomeKind: matched
      ? OUTCOME_KIND.SUCCESS
      : checkedMismatch ? OUTCOME_KIND.FUNCTIONAL_FAILURE : OUTCOME_KIND.EXECUTION_UNCERTAINTY,
    matched: matched ? true : checkedMismatch ? false : null,
    checked: proof?.checked === true,
    reason: String(reason || proof?.reason || (matched ? 'postcondition_proven' : 'postcondition_unproven')),
    evidence: transactionSafeValue(proof?.evidence || proof?.actual || null, transaction),
    continuation: continuationMetadata(failureMode, matched),
    completedAt: timestamp(now),
  };
  await persistState(transaction, persist, now);
  return transaction;
}

async function observeAndProve(transaction, options, phase, attempt) {
  let data = null;
  let observationError = null;
  try {
    data = await options.observe({
      transaction: cloneSerializable(transaction),
      phase,
      attempt,
      preState: cloneSerializable(transaction.preState),
    });
  } catch (error) {
    observationError = error;
  }
  const observation = {
    index: transaction.observations.length,
    attempt,
    phase,
    timestamp: timestamp(options.now),
    data: transactionSafeValue(data, transaction),
    error: transactionSafeValue(observationError, transaction),
    proof: null,
  };
  transaction.observations.push(observation);
  transaction.status = TRANSACTION_STATUS.OBSERVING;
  await persistState(transaction, options.persist, options.now);

  let proof;
  try {
    const proofObservation = {
      ...cloneSerializable(observation),
      // Proof runs inside this call and needs the exact browser readback. Only
      // the separately constructed `observation` above is persisted.
      data,
      error: observationError,
    };
    proof = normalizeProof(await options.provePostcondition({
      transaction: cloneSerializable(transaction),
      preState: cloneSerializable(transaction.preState),
      observation: proofObservation,
      observations: cloneSerializable(transaction.observations),
    }), transaction);
  } catch (error) {
    proof = normalizeProof({
      matched: null,
      checked: false,
      reason: 'postcondition_proof_error',
      error,
    }, transaction);
  }
  observation.proof = transactionSafeValue(proof, transaction);
  await persistState(transaction, options.persist, options.now);
  return { observation, proof };
}

async function proveNotDelivered(transaction, options, context) {
  if (typeof options.proveNotDelivered !== 'function') return false;
  try {
    const result = await options.proveNotDelivered({
      transaction: cloneSerializable(transaction),
      ...context,
    });
    return positiveNonDeliveryProof(result);
  } catch (_) {
    return false;
  }
}

async function dispatchOnce(transaction, options) {
  const attempt = transaction.dispatchAttemptCount + 1;
  const startedAt = timestamp(options.now);
  const dispatchRecord = {
    attempt,
    startedAt,
    completedAt: null,
    status: DISPATCH_STATUS.DISPATCHING,
    result: null,
    error: null,
    positivelyNotDelivered: false,
  };
  transaction.dispatchAttemptCount = attempt;
  transaction.dispatchAttempts.push(dispatchRecord);
  transaction.dispatchStatus = DISPATCH_STATUS.DISPATCHING;
  transaction.dispatchTimestamp = startedAt;
  transaction.status = TRANSACTION_STATUS.DISPATCHING;

  // This marker must be durable before dispatch. A crash after the browser call
  // then resumes as an uncertain delivery and reconciles instead of clicking again.
  await persistState(transaction, options.persist, options.now);

  try {
    const result = await options.dispatch({
      transaction: cloneSerializable(transaction),
      attempt,
      preState: cloneSerializable(transaction.preState),
    });
    dispatchRecord.result = transactionSafeValue(result, transaction);
    dispatchRecord.completedAt = timestamp(options.now);
    if (result?.delivered === false && positiveNonDeliveryProof(result)) {
      dispatchRecord.status = DISPATCH_STATUS.NOT_DELIVERED;
      dispatchRecord.positivelyNotDelivered = true;
      transaction.dispatchStatus = DISPATCH_STATUS.NOT_DELIVERED;
    } else {
      dispatchRecord.status = DISPATCH_STATUS.DELIVERED;
      transaction.dispatchStatus = DISPATCH_STATUS.DELIVERED;
    }
  } catch (error) {
    dispatchRecord.error = transactionSafeValue(error, transaction);
    dispatchRecord.completedAt = timestamp(options.now);
    dispatchRecord.status = DISPATCH_STATUS.DELIVERY_UNCERTAIN;
    transaction.dispatchStatus = DISPATCH_STATUS.DELIVERY_UNCERTAIN;
  }
  await persistState(transaction, options.persist, options.now);
  return dispatchRecord;
}

async function coordinateActionTransaction(input = {}) {
  if (typeof input.observe !== 'function') throw new TypeError('observe hook is required');
  if (typeof input.provePostcondition !== 'function') throw new TypeError('provePostcondition hook is required');

  const resumed = !!input.persistedTransaction;
  const transaction = resumed
    ? hydrateActionTransaction(input.persistedTransaction)
    : createActionTransaction(input, { now: input.now });
  if (isTerminalTransaction(transaction)) return { transaction, outcome: transaction.canonicalOutcome, resumed };

  const options = {
    ...input,
    now: input.now || Date.now,
    persist: input.persist,
    observe: input.observe,
    provePostcondition: input.provePostcondition,
  };
  const maxObservationAttempts = Math.max(1, Number(input.maxObservationAttempts || 5));
  const maxDispatchAttempts = Math.max(1, Number(input.maxDispatchAttempts || 2));
  const sleep = typeof input.sleep === 'function'
    ? input.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const observationIntervalMs = Math.max(0, Number(input.observationIntervalMs || 0));

  if (transaction.preStateCaptured !== true) {
    transaction.status = TRANSACTION_STATUS.CAPTURING_PRE_STATE;
    await persistState(transaction, options.persist, options.now);
    try {
      transaction.preState = transactionSafeValue(typeof input.capturePreState === 'function'
        ? await input.capturePreState({ transaction: cloneSerializable(transaction) })
        : null, transaction);
      transaction.preStateCaptured = true;
      transaction.status = TRANSACTION_STATUS.READY;
      await persistState(transaction, options.persist, options.now);
    } catch (error) {
      return {
        transaction: await finalize(transaction, normalizeProof({
          matched: null,
          checked: false,
          reason: 'pre_state_capture_failed',
          error,
        }), options),
        outcome: transaction.canonicalOutcome,
        resumed,
      };
    }
  }

  let lastProof = normalizeProof(null);
  let observationNumber = 0;

  // Persisted transactions always reconcile before dispatch, including those
  // that claim no dispatch occurred. The observable browser state is authority.
  if (resumed) {
    const reconciled = await observeAndProve(transaction, options, 'resume_reconcile', observationNumber++);
    lastProof = reconciled.proof;
    if (lastProof.matched === true) {
      const completed = await finalize(transaction, lastProof, options);
      return { transaction: completed, outcome: completed.canonicalOutcome, resumed };
    }
  }

  const needsInitialDispatch = transaction.mutating !== false
    && (transaction.dispatchStatus === DISPATCH_STATUS.NOT_DISPATCHED
      || transaction.dispatchStatus === DISPATCH_STATUS.NOT_DELIVERED);
  if (needsInitialDispatch) {
    if (typeof input.dispatch !== 'function') throw new TypeError('dispatch hook is required for mutating actions');
    await dispatchOnce(transaction, options);
  }

  for (; observationNumber < maxObservationAttempts; observationNumber += 1) {
    const result = await observeAndProve(
      transaction,
      options,
      resumed && observationNumber === 0 ? 'resume_reconcile' : 'post_dispatch',
      observationNumber,
    );
    const currentProof = result.proof;
    if (currentProof.checked === true || lastProof.checked !== true) lastProof = currentProof;
    if (currentProof.matched === true) {
      const completed = await finalize(transaction, currentProof, options);
      return { transaction: completed, outcome: completed.canonicalOutcome, resumed };
    }
    if (currentProof.terminal === true && currentProof.checked === true) break;

    const positivelyNotDelivered = transaction.dispatchStatus === DISPATCH_STATUS.NOT_DELIVERED;
    const deliveryUncertain = transaction.dispatchStatus === DISPATCH_STATUS.DELIVERY_UNCERTAIN
      || transaction.dispatchStatus === DISPATCH_STATUS.DISPATCHING;
    if (transaction.mutating !== false
      && transaction.dispatchAttemptCount < maxDispatchAttempts
      && (positivelyNotDelivered || (deliveryUncertain && await proveNotDelivered(transaction, options, {
          observation: cloneSerializable(result.observation),
          proof: cloneSerializable(lastProof),
        })))) {
      transaction.dispatchStatus = DISPATCH_STATUS.NOT_DELIVERED;
      const current = transaction.dispatchAttempts[transaction.dispatchAttempts.length - 1];
      if (current) {
        current.status = DISPATCH_STATUS.NOT_DELIVERED;
        current.positivelyNotDelivered = true;
      }
      await persistState(transaction, options.persist, options.now);
      await dispatchOnce(transaction, options);
    }

    if (observationNumber + 1 < maxObservationAttempts && observationIntervalMs > 0) {
      await sleep(observationIntervalMs);
    }
  }

  const completed = await finalize(transaction, lastProof, options);
  return { transaction: completed, outcome: completed.canonicalOutcome, resumed };
}

function resumeActionTransaction(persistedTransaction, options = {}) {
  return coordinateActionTransaction({ ...options, persistedTransaction });
}

module.exports = {
  SCHEMA_VERSION,
  TRANSACTION_STATUS,
  DISPATCH_STATUS,
  OUTCOME_KIND,
  FAILURE_MODE,
  createActionTransaction,
  hydrateActionTransaction,
  serializeActionTransaction,
  isTerminalTransaction,
  coordinateActionTransaction,
  resumeActionTransaction,
};
