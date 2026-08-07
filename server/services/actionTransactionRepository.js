'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { privacySafeValue } = require('./actionTransactionJournal');

const REPOSITORY_SCHEMA = 'qaai-action-transaction-repository-v1';
const DEFAULT_ROOT = path.join(__dirname, '..', '..', 'playwright', 'test-results', 'live', 'action-transactions');
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithTransientLockRetry(source, target, {
  maxAttempts = 9,
  initialDelayMs = 20,
} = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await fs.promises.rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= maxAttempts) throw error;
      const delayMs = Math.min(300, initialDelayMs * (2 ** (attempt - 1)));
      await wait(delayMs);
    }
  }
  throw lastError;
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeReason(value) {
  const text = clean(value).slice(0, 240);
  if (!text) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : `reason-digest:${digest(text)}`;
}

function occurrenceSnapshot(state = {}) {
  const allowed = [
    'schemaVersion', 'occurrenceKey', 'actionOccurrenceId', 'mutationPhaseId',
    'authoredStepIndex', 'toolName', 'argsDigest', 'source', 'status',
    'intentPersistedAt', 'dispatchAttemptCount', 'dispatchStartedAt',
    'dispatchedAt', 'browserEventObservedAt', 'postconditionObservedAt',
    'postconditionMatched', 'committedAt', 'positiveNonDeliveryProvenAt',
    'dispatchErrorCode', 'targetActionabilityMatched', 'targetActionabilityEditable',
    'targetActionabilityTargetDigest', 'targetActionabilityReason',
    'targetActionabilityObservedAt', 'landingOracleKind', 'landingOracleTargetDigest',
    'landingOracleMatched', 'landingOracleReason', 'landingOracleObservedAt',
    'reconciliationAttemptCount', 'lastReconciliationAt', 'updatedAt',
  ];
  const snapshot = {};
  for (const key of allowed) {
    if (state[key] !== undefined) snapshot[key] = state[key];
  }
  if (state.postconditionReason !== undefined) snapshot.postconditionReason = safeReason(state.postconditionReason);
  if (snapshot.dispatchErrorCode !== undefined) snapshot.dispatchErrorCode = safeReason(snapshot.dispatchErrorCode);
  if (snapshot.targetActionabilityReason !== undefined) snapshot.targetActionabilityReason = safeReason(snapshot.targetActionabilityReason);
  if (snapshot.landingOracleReason !== undefined) snapshot.landingOracleReason = safeReason(snapshot.landingOracleReason);
  return snapshot;
}

function normalizedIdentity(kind, identity = {}) {
  const runId = clean(identity.runId);
  const caseId = clean(identity.caseId);
  if (!runId || !caseId) throw new TypeError(`${kind} persistence requires runId and caseId`);
  if (kind === 'transaction') {
    const stepId = clean(identity.stepId);
    const sequenceIndex = Number.isFinite(Number(identity.sequenceIndex)) ? Number(identity.sequenceIndex) : null;
    if (!stepId && sequenceIndex == null) throw new TypeError('transaction persistence requires stepId or sequenceIndex');
    return { runId, caseId, entityId: stepId || `sequence:${sequenceIndex}` };
  }
  const occurrenceKey = clean(identity.occurrenceKey);
  if (!occurrenceKey) throw new TypeError('occurrence persistence requires occurrenceKey');
  return { runId, caseId, entityId: occurrenceKey };
}

function createActionTransactionRepository({ rootDir = process.env.QAAI_ACTION_TRANSACTION_DIR || DEFAULT_ROOT } = {}) {
  const root = path.resolve(rootDir);

  const recordPath = (kind, identity) => {
    const normalized = normalizedIdentity(kind, identity);
    const scope = digest(`${normalized.runId}\u0000${normalized.caseId}`);
    return path.join(root, kind, scope.slice(0, 2), scope, `${digest(normalized.entityId)}.json`);
  };

  const save = async (kind, identity, value) => {
    const target = recordPath(kind, identity);
    const directory = path.dirname(target);
    await fs.promises.mkdir(directory, { recursive: true });
    const payload = {
      schema: REPOSITORY_SCHEMA,
      kind,
      identityDigest: digest(JSON.stringify(normalizedIdentity(kind, identity))),
      savedAt: new Date().toISOString(),
      value: kind === 'occurrence'
        ? occurrenceSnapshot(value)
        : privacySafeValue(value, { source: 'durable_action_transaction' }),
    };
    const temp = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle = null;
    try {
      handle = await fs.promises.open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await renameWithTransientLockRetry(temp, target);
    } catch (error) {
      try { await handle?.close(); } catch (_) {}
      try { await fs.promises.unlink(temp); } catch (_) {}
      throw error;
    }
    return { persisted: true, ref: `action-transaction:${kind}:${payload.identityDigest}` };
  };

  const load = async (kind, identity) => {
    const target = recordPath(kind, identity);
    let payload;
    try {
      payload = JSON.parse(await fs.promises.readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (payload?.schema !== REPOSITORY_SCHEMA || payload?.kind !== kind) {
      throw new Error('action transaction repository record has an incompatible schema');
    }
    const expectedDigest = digest(JSON.stringify(normalizedIdentity(kind, identity)));
    if (payload.identityDigest !== expectedDigest) throw new Error('action transaction repository identity mismatch');
    return payload.value == null ? null : JSON.parse(JSON.stringify(payload.value));
  };

  return Object.freeze({
    root,
    saveTransaction: (identity, transaction) => save('transaction', identity, transaction),
    loadTransaction: (identity) => load('transaction', identity),
    saveOccurrence: (identity, occurrence) => save('occurrence', identity, occurrence),
    loadOccurrence: (identity) => load('occurrence', identity),
    recordPath,
  });
}

const defaultRepository = createActionTransactionRepository();

module.exports = {
  REPOSITORY_SCHEMA,
  DEFAULT_ROOT,
  occurrenceSnapshot,
  renameWithTransientLockRetry,
  createActionTransactionRepository,
  saveTransaction: defaultRepository.saveTransaction,
  loadTransaction: defaultRepository.loadTransaction,
  saveOccurrence: defaultRepository.saveOccurrence,
  loadOccurrence: defaultRepository.loadOccurrence,
};
