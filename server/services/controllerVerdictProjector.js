'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  CONTROLLER_STATE,
} = require('./browserTransactionContract');
const {
  CONTROLLER_CAPABILITY,
  assertControllerAuthority,
} = require('./browserTransactionAuthority');
const {
  SCHEDULE_STATE,
} = require('./controllerExecutionScheduler');

const VERDICT_VERSION = 'qaai-controller-verdict-v1';

const CASE_VERDICT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  EXECUTION_ERROR: 'EXECUTION_ERROR',
  MANUAL_BOUNDARY: 'MANUAL_BOUNDARY',
  CANCELLED: 'CANCELLED',
});

class ControllerVerdictProjectorError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerVerdictProjectorError';
    this.code = code;
    Object.assign(this, details);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}

function projectControllerVerdict({ scopeId, schedulerSnapshot } = {}) {
  const id = String(scopeId || '').trim();
  const records = Array.isArray(schedulerSnapshot?.records) ? schedulerSnapshot.records : [];
  if (!id || !records.length) {
    throw new ControllerVerdictProjectorError(
      'Verdict projection requires a scope and completed scheduler records.',
      'CONTROLLER_VERDICT_INPUT_REQUIRED',
      { scopeId: id || null, recordCount: records.length },
    );
  }
  const terminalStates = records.map((record) => record.terminalState).filter(Boolean);
  const verdictBearingRecords = records.filter((record) => !(
    record.terminalState === CONTROLLER_STATE.EXECUTION_ERROR
    && record.kind === 'synchronization'
  ));
  const verdictBearingStates = verdictBearingRecords
    .map((record) => record.terminalState)
    .filter(Boolean);
  let verdict;
  let reason;
  if (schedulerSnapshot.cancelled || terminalStates.includes(CONTROLLER_STATE.CANCELLED)) {
    verdict = CASE_VERDICT.CANCELLED;
    reason = 'controller_cancelled';
  } else if (schedulerSnapshot.paused || terminalStates.includes(CONTROLLER_STATE.MANUAL_BOUNDARY)) {
    verdict = CASE_VERDICT.MANUAL_BOUNDARY;
    reason = 'controller_manual_boundary';
  } else if (verdictBearingStates.includes(CONTROLLER_STATE.EXECUTION_ERROR)) {
    verdict = CASE_VERDICT.EXECUTION_ERROR;
    reason = 'controller_execution_error';
  } else if (verdictBearingStates.includes(CONTROLLER_STATE.PRODUCT_FAILURE)
    || verdictBearingStates.includes(CONTROLLER_STATE.ASSERTION_FAILED)) {
    verdict = CASE_VERDICT.FAIL;
    reason = verdictBearingStates.includes(CONTROLLER_STATE.PRODUCT_FAILURE)
      ? 'controller_product_failure'
      : 'controller_assertion_failure';
  } else if (records.some((record) => record.scheduleState === SCHEDULE_STATE.SKIPPED_DEPENDENCY)) {
    verdict = CASE_VERDICT.EXECUTION_ERROR;
    reason = 'controller_dependency_skipped_without_terminal_source';
  } else if (verdictBearingRecords.every((record) => (
    record.terminalState === CONTROLLER_STATE.COMMITTED
    || record.terminalState === CONTROLLER_STATE.ASSERTION_FAILED
  ))) {
    verdict = CASE_VERDICT.PASS;
    reason = 'all_controller_operations_committed';
  } else {
    throw new ControllerVerdictProjectorError(
      'Verdict cannot be projected from incomplete controller state.',
      'CONTROLLER_VERDICT_STATE_INCOMPLETE',
      { scopeId: id },
    );
  }

  const counts = Object.freeze({
    committed: terminalStates.filter((state) => state === CONTROLLER_STATE.COMMITTED).length,
    assertionFailed: terminalStates.filter((state) => state === CONTROLLER_STATE.ASSERTION_FAILED).length,
    productFailed: terminalStates.filter((state) => state === CONTROLLER_STATE.PRODUCT_FAILURE).length,
    executionError: terminalStates.filter((state) => state === CONTROLLER_STATE.EXECUTION_ERROR).length,
    recoverableExecutionError: records.filter((record) => (
      record.terminalState === CONTROLLER_STATE.EXECUTION_ERROR
      && record.skipDependents === false
    )).length,
    synchronizationInconclusive: records.filter((record) => (
      record.kind === 'synchronization'
      && record.terminalState === CONTROLLER_STATE.EXECUTION_ERROR
    )).length,
    skippedDependency: records.filter((record) => record.scheduleState === SCHEDULE_STATE.SKIPPED_DEPENDENCY).length,
  });
  const projection = {
    schemaVersion: VERDICT_VERSION,
    scopeId: id,
    verdict,
    reason,
    counts,
  };
  return Object.freeze({
    ...projection,
    decisionDigest: digest(projection),
  });
}

function createInMemoryVerdictRepository() {
  const verdicts = new Map();
  return Object.freeze({
    loadVerdict: async (scopeId) => verdicts.get(scopeId) || null,
    appendVerdict: async (verdict) => {
      if (verdicts.has(verdict.scopeId)) return { persisted: false, reason: 'scope_already_has_verdict' };
      verdicts.set(verdict.scopeId, Object.freeze({ ...verdict }));
      return { persisted: true };
    },
    allVerdicts: () => [...verdicts.values()],
  });
}

function createFileVerdictRepository({ rootDir } = {}) {
  const root = path.resolve(String(rootDir || ''));
  if (!rootDir) throw new TypeError('File verdict repository requires rootDir.');
  const fileFor = (scopeId) => path.join(root, `${digest(String(scopeId)).slice(0, 40)}.json`);
  return Object.freeze({
    loadVerdict: async (scopeId) => {
      try {
        return JSON.parse(await fs.readFile(fileFor(scopeId), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    appendVerdict: async (verdict) => {
      await fs.mkdir(root, { recursive: true });
      try {
        await fs.writeFile(fileFor(verdict.scopeId), `${JSON.stringify(verdict)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
        return { persisted: true };
      } catch (error) {
        if (error?.code === 'EEXIST') return { persisted: false, reason: 'scope_already_has_verdict' };
        throw error;
      }
    },
  });
}

async function persistControllerVerdict({
  authority,
  projection,
  repository,
  journal = null,
} = {}) {
  assertControllerAuthority(authority, CONTROLLER_CAPABILITY.PROJECT_VERDICT);
  if (!projection || projection.schemaVersion !== VERDICT_VERSION) {
    throw new ControllerVerdictProjectorError(
      'Only a canonical controller verdict may be persisted.',
      'CONTROLLER_VERDICT_PROJECTION_REQUIRED',
    );
  }
  if (!repository
    || typeof repository.loadVerdict !== 'function'
    || typeof repository.appendVerdict !== 'function') {
    throw new TypeError('Verdict persistence requires a write-once repository.');
  }
  const existing = await repository.loadVerdict(projection.scopeId);
  if (existing) {
    if (existing.decisionDigest === projection.decisionDigest) {
      return Object.freeze({ persisted: true, idempotent: true, verdict: existing });
    }
    throw new ControllerVerdictProjectorError(
      'Canonical verdict is write-once and cannot be reinterpreted.',
      'CONTROLLER_VERDICT_WRITE_ONCE_VIOLATION',
      {
        scopeId: projection.scopeId,
        existingDigest: existing.decisionDigest,
        requestedDigest: projection.decisionDigest,
      },
    );
  }
  const persisted = await repository.appendVerdict(projection);
  if (persisted?.persisted !== true) {
    throw new ControllerVerdictProjectorError(
      'Verdict repository refused the canonical append.',
      'CONTROLLER_VERDICT_PERSISTENCE_REQUIRED',
      { scopeId: projection.scopeId, reason: persisted?.reason || null },
    );
  }
  if (journal?.appendControllerEvent) {
    await journal.appendControllerEvent({
      authority,
      capability: CONTROLLER_CAPABILITY.PROJECT_VERDICT,
      event: {
        eventType: 'FINAL_VERDICT_PROJECTED',
        operationId: null,
        scopeId: projection.scopeId,
        verdict: projection.verdict,
        decisionDigest: projection.decisionDigest,
      },
    });
  }
  return Object.freeze({ persisted: true, idempotent: false, verdict: projection });
}

module.exports = {
  VERDICT_VERSION,
  CASE_VERDICT,
  ControllerVerdictProjectorError,
  digest,
  projectControllerVerdict,
  createInMemoryVerdictRepository,
  createFileVerdictRepository,
  persistControllerVerdict,
};
