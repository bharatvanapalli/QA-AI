'use strict';

const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  looksLikePasswordField,
  SECRET_KEY_RE,
  MASK: SECRET_MASK,
} = require('../../lib/redactSecrets');
const {
  CONTRACT_VERSION,
  SCHEMA_VERSION,
  SUITE_RELIABILITY_STATUS,
  withContractVersions,
} = require('./contracts');

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  GROUNDING_APP: 'grounding_app',
  BUILDING_EXAMPLES: 'building_examples',
  GENERATING: 'generating',
  VALIDATING: 'validating',
  REPAIRING: 'repairing',
  AWAITING_USER_DECISION: 'awaiting_user_decision',
  READY: 'ready',
  READY_WITH_USER_DECISIONS: 'ready_with_user_decisions',
  NEEDS_REPAIR: 'needs_repair',
  FAILED: 'failed',
});

const TERMINAL_STATUSES = new Set([
  JOB_STATUS.READY,
  JOB_STATUS.READY_WITH_USER_DECISIONS,
  JOB_STATUS.NEEDS_REPAIR,
  JOB_STATUS.FAILED,
]);

const ACTIVE_BY_ID = new Map();
const ACTIVE_BY_IDEMPOTENCY = new Map();
const STALE_BOOT_FAILURE_REASON = 'Server restarted before this scenario generation job completed.';
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
let storeLoaded = false;
let persistenceEnabled = process.env.QAAI_RELIABILITY_JOB_PERSISTENCE !== 'false';
let staleLoadedJobFailureEnabled = process.env.NODE_ENV !== 'test'
  && process.env.QAAI_MARK_STALE_JOBS_ON_LOAD !== '0';
let retentionMs = Number(process.env.QAAI_RELIABILITY_JOB_RETENTION_MS) || DEFAULT_RETENTION_MS;
let storeNow = () => Date.now();
let storePath = process.env.QAAI_RELIABILITY_JOB_STORE
  || path.join(__dirname, '..', '..', '..', '.qaai-runtime', 'scenario-generation-jobs.json');
let lastStorePersistence = Object.freeze({ ok: true, status: 'not_loaded', durable: persistenceEnabled });

function nowIso() {
  return new Date(storeNow()).toISOString();
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

const SENSITIVE_CLASSIFICATIONS = new Set([
  'sensitive',
  'secret',
  'credential',
  'restricted',
  'masked',
  'pii_secret',
]);
const EXECUTABLE_VALUE_KEYS = new Set([
  'value',
  'values',
  'input',
  'inputvalue',
  'text',
  'expected',
  'actual',
  'observed',
  'selectedvalue',
]);
const DIRECT_SECRET_VALUE_KEY_RE = /^(?:password|passwd|pwd|passcode|secret|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|credential(?:value)?)$/i;

function normalizeDataRef(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^data\./i, '')
    .replace(/^\{\{\s*|\s*\}\}$/g, '')
    .toLowerCase();
}

function sensitiveBindingNames(caseObj = {}) {
  const names = new Set();
  const quality = caseObj.qualityContract && typeof caseObj.qualityContract === 'object'
    ? caseObj.qualityContract
    : {};
  const contracts = [caseObj.caseContractV1, quality.caseContractV1]
    .filter((value) => value && typeof value === 'object');
  const bindingGroups = [
    ...contracts.flatMap((contract) => [contract.dataBindings, contract.dataDictionary]),
    caseObj.dataBinding && caseObj.dataBinding.bindings,
  ];
  for (const bindings of bindingGroups) {
    for (const binding of (Array.isArray(bindings) ? bindings : [])) {
      if (!binding || !SENSITIVE_CLASSIFICATIONS.has(String(binding.classification || binding.sensitivity || '').toLowerCase())) continue;
      for (const candidate of [binding.name, binding.id, binding.token, binding.dataRef, binding.ref]) {
        const normalized = normalizeDataRef(candidate);
        if (normalized) names.add(normalized);
      }
    }
  }
  return names;
}

function objectDataRefs(value = {}) {
  const refs = [];
  for (const candidate of [value.dataRef, value.boundDataRef, value.reference, value.ref]) {
    if (candidate != null) refs.push(candidate);
  }
  for (const list of [value.dataRefs, value.boundDataRefs, value.references]) {
    if (Array.isArray(list)) refs.push(...list);
  }
  return refs.map(normalizeDataRef).filter(Boolean);
}

function objectDeclaresSensitiveBinding(value, sensitiveNames) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.sensitive === true || value.isSensitive === true) return true;
  const classification = String(value.classification || value.sensitivity || '').toLowerCase();
  if (SENSITIVE_CLASSIFICATIONS.has(classification)) return true;
  if (objectDataRefs(value).some((ref) => sensitiveNames.has(ref))) return true;
  if (looksLikePasswordField(value)) return true;
  const fieldIdentity = [
    value.element,
    value.target,
    value.field,
    value.label,
    value.placeholder,
    value.autocomplete,
  ].filter(Boolean).join(' ');
  return !!fieldIdentity && SECRET_KEY_RE.test(fieldIdentity);
}

function isReferenceOrMask(value) {
  const text = String(value == null ? '' : value).trim();
  return !text
    || text === SECRET_MASK
    || /^\[REDACTED\]$/i.test(text)
    || /^\{\{[^}]+\}\}$/.test(text)
    || /^\$\{[^}]+\}$/.test(text)
    || /^(?:env|vault|credential):/i.test(text);
}

function collectScalarLiterals(value, out) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectScalarLiterals(item, out));
    return;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const literal = String(value);
  if (!isReferenceOrMask(literal)) out.add(literal);
}

function collectSensitiveLiterals(value, sensitiveNames, out = new Set(), inheritedSensitive = false) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectSensitiveLiterals(item, sensitiveNames, out, inheritedSensitive));
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const objectSensitive = inheritedSensitive || objectDeclaresSensitiveBinding(value, sensitiveNames);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase();
    const directSecretValue = DIRECT_SECRET_VALUE_KEY_RE.test(key);
    if (directSecretValue || (objectSensitive && EXECUTABLE_VALUE_KEYS.has(normalizedKey))) {
      collectScalarLiterals(item, out);
    }
    if (item && typeof item === 'object') {
      collectSensitiveLiterals(item, sensitiveNames, out, objectSensitive);
    }
  }
  return out;
}

function redactSensitiveLiterals(value, literals) {
  if (typeof value === 'string') {
    let redacted = value;
    for (const literal of literals) redacted = redacted.split(literal).join(SECRET_MASK);
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveLiterals(item, literals));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, redactSensitiveLiterals(item, literals)]));
}

function redactCaseSnapshot(caseObj) {
  if (!caseObj || typeof caseObj !== 'object') return caseObj;
  const sensitiveNames = sensitiveBindingNames(caseObj);
  const literals = collectSensitiveLiterals(caseObj, sensitiveNames);
  return literals.size ? redactSensitiveLiterals(caseObj, literals) : cloneJson(caseObj);
}

function redactScenarioSnapshots(scenarios = []) {
  return (Array.isArray(scenarios) ? scenarios : []).map((scenario) => {
    const copy = cloneJson(scenario);
    if (!copy || typeof copy !== 'object') return copy;
    copy.cases = (Array.isArray(copy.cases) ? copy.cases : []).map(redactCaseSnapshot);
    return copy;
  });
}

function redactJobSnapshots(job) {
  const copy = cloneJson(job);
  if (!copy || typeof copy !== 'object') return copy;
  copy.snapshots = (Array.isArray(copy.snapshots) ? copy.snapshots : []).map((snapshot) => ({
    ...snapshot,
    scenarios: redactScenarioSnapshots(snapshot && snapshot.scenarios),
  }));
  return copy;
}

function safeParseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function safeStringify(value) {
  return JSON.stringify(value, null, 2);
}

function markLoadedJobStaleIfNeeded(job) {
  if (!job || TERMINAL_STATUSES.has(job.status)) return job;
  const previousStatus = job.status || null;
  const previousStage = job.stage || null;
  const ts = nowIso();
  job.status = JOB_STATUS.FAILED;
  job.stage = JOB_STATUS.FAILED;
  job.progress = 100;
  job.failureReason = STALE_BOOT_FAILURE_REASON;
  job.resumeFromStage = null;
  job.metadata = {
    ...(job.metadata || {}),
    recovery: {
      code: 'SCENARIO_GENERATION_INTERRUPTED_BY_RESTART',
      executableResumeAvailable: false,
      previousStatus,
      previousStage,
    },
  };
  job.completedAt = job.completedAt || ts;
  job.updatedAt = ts;
  job.history = Array.isArray(job.history) ? job.history : [];
  job.history.push({
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    at: ts,
    reason: 'stale_after_server_restart',
  });
  return job;
}

function configureScenarioGenerationJobStore({
  filePath = undefined,
  persist = undefined,
  markStaleOnLoad = undefined,
  retention = undefined,
  now = undefined,
} = {}) {
  if (filePath) storePath = filePath;
  if (persist !== undefined) persistenceEnabled = !!persist;
  staleLoadedJobFailureEnabled = markStaleOnLoad === undefined
    ? process.env.NODE_ENV !== 'test' && process.env.QAAI_MARK_STALE_JOBS_ON_LOAD !== '0'
    : !!markStaleOnLoad;
  if (retention !== undefined) {
    const parsed = Number(retention);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError('retention must be a positive number.');
    retentionMs = parsed;
  } else {
    retentionMs = Number(process.env.QAAI_RELIABILITY_JOB_RETENTION_MS) || DEFAULT_RETENTION_MS;
  }
  storeNow = typeof now === 'function' ? now : () => Date.now();
  storeLoaded = false;
  ACTIVE_BY_ID.clear();
  ACTIVE_BY_IDEMPOTENCY.clear();
  lastStorePersistence = Object.freeze({ ok: true, status: 'configured', durable: persistenceEnabled });
  return lastStorePersistence;
}

function persistenceState(ok, status, details = {}) {
  return Object.freeze({ ok, status, durable: persistenceEnabled, ...details });
}

function persistenceFailure(status, code, message, error = null, details = {}) {
  return persistenceState(false, status, {
    code,
    message,
    errorCode: error && error.code ? String(error.code) : null,
    ...details,
  });
}

function persistenceException(persistence) {
  const error = new Error(persistence && persistence.message
    || 'The scenario generation job mutation could not be persisted.');
  error.name = 'ScenarioGenerationJobPersistenceError';
  error.code = persistence && persistence.code || 'SCENARIO_GENERATION_JOB_STORE_WRITE_FAILED';
  error.persistence = cloneJson(persistence);
  return error;
}

function promoteJobStoreFile(tempPath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.renameSync(tempPath, targetPath);
    return;
  }
  const targetStat = fs.statSync(targetPath);
  if (!targetStat.isFile()) {
    throw Object.assign(new Error('The scenario generation job store target is not a file.'), {
      code: 'SCENARIO_GENERATION_JOB_STORE_TARGET_INVALID',
    });
  }
  const backupPath = `${targetPath}.previous`;
  fs.rmSync(backupPath, { force: true, maxRetries: 3, retryDelay: 10 });
  fs.renameSync(targetPath, backupPath);
  try {
    fs.renameSync(tempPath, targetPath);
    fs.rmSync(backupPath, { force: true, maxRetries: 3, retryDelay: 10 });
  } catch (error) {
    if (!fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, targetPath);
    }
    throw error;
  }
}

function restoreMutableObject(target, snapshot) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, cloneJson(snapshot));
}

function pruneExpiredTerminalJobs(at = storeNow()) {
  let removed = 0;
  for (const [jobId, job] of ACTIVE_BY_ID.entries()) {
    if (!TERMINAL_STATUSES.has(job && job.status)) continue;
    const timestamp = Date.parse(job.completedAt || job.updatedAt || job.createdAt || '');
    if (!Number.isFinite(timestamp) || at - timestamp <= retentionMs) continue;
    ACTIVE_BY_ID.delete(jobId);
    if (job.idempotencyKey && ACTIVE_BY_IDEMPOTENCY.get(job.idempotencyKey) === jobId) {
      ACTIVE_BY_IDEMPOTENCY.delete(job.idempotencyKey);
    }
    removed += 1;
  }
  return removed;
}

function ensureStoreLoaded() {
  if (storeLoaded) return lastStorePersistence;
  storeLoaded = true;
  if (!persistenceEnabled) {
    lastStorePersistence = persistenceState(true, 'disabled');
    return lastStorePersistence;
  }
  try {
    if (!fs.existsSync(storePath)) {
      lastStorePersistence = persistenceState(true, 'empty', { loaded: 0, removedExpired: 0 });
      return lastStorePersistence;
    }
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) {
      throw Object.assign(new Error('The scenario generation job store format is invalid.'), {
        code: 'SCENARIO_GENERATION_JOB_STORE_FORMAT_INVALID',
      });
    }
    const jobs = Array.isArray(parsed && parsed.jobs) ? parsed.jobs : [];
    let loaded = 0;
    for (const job of jobs) {
      if (!job || !job.id) continue;
      const safeJob = redactJobSnapshots(job);
      const loadedJob = staleLoadedJobFailureEnabled ? markLoadedJobStaleIfNeeded(safeJob) : safeJob;
      ACTIVE_BY_ID.set(loadedJob.id, loadedJob);
      if (job.idempotencyKey) ACTIVE_BY_IDEMPOTENCY.set(job.idempotencyKey, job.id);
      loaded += 1;
    }
    const removedExpired = pruneExpiredTerminalJobs();
    lastStorePersistence = persistenceState(true, 'loaded', { loaded, removedExpired });
    if (staleLoadedJobFailureEnabled || removedExpired) {
      const persisted = persistJobStore();
      lastStorePersistence = persistenceState(persisted.ok, persisted.status, {
        ...persisted,
        loaded,
        removedExpired,
      });
    }
  } catch (error) {
    ACTIVE_BY_ID.clear();
    ACTIVE_BY_IDEMPOTENCY.clear();
    lastStorePersistence = persistenceFailure(
      'read_failed',
      'SCENARIO_GENERATION_JOB_STORE_READ_FAILED',
      'The scenario generation job store could not be loaded.',
      error,
    );
  }
  return lastStorePersistence;
}

function persistJobStore() {
  if (!persistenceEnabled) {
    lastStorePersistence = persistenceState(true, 'disabled');
    return lastStorePersistence;
  }
  const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(tempPath, safeStringify({
      schemaVersion: SCHEMA_VERSION,
      contractVersion: CONTRACT_VERSION,
      jobs: Array.from(ACTIVE_BY_ID.values()).map(redactJobSnapshots),
      updatedAt: nowIso(),
    }), { encoding: 'utf8' });
    promoteJobStoreFile(tempPath, storePath);
    lastStorePersistence = persistenceState(true, 'persisted', { jobCount: ACTIVE_BY_ID.size });
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
    lastStorePersistence = persistenceFailure(
      'write_failed',
      'SCENARIO_GENERATION_JOB_STORE_WRITE_FAILED',
      'The scenario generation job store could not be written.',
      error,
    );
  }
  return lastStorePersistence;
}

function getScenarioGenerationJobStoreStatus() {
  return cloneJson(lastStorePersistence);
}

function createScenarioGenerationJob({
  projectId,
  generationId = undefined,
  idempotencyKey = undefined,
  retryOfJobId = undefined,
  resumeFromStage = undefined,
  status = JOB_STATUS.QUEUED,
  metadata = {},
} = {}) {
  ensureStoreLoaded();
  const key = idempotencyKey || `scenario-generation:${projectId || 'project'}:${randomUUID()}`;
  const existingId = ACTIVE_BY_IDEMPOTENCY.get(key);
  if (existingId && ACTIVE_BY_ID.has(existingId)) {
    return ACTIVE_BY_ID.get(existingId);
  }
  const ts = nowIso();
  const job = withContractVersions({
    id: randomUUID(),
    idempotencyKey: key,
    projectId: projectId || null,
    generationId: generationId || null,
    status,
    stage: status,
    progress: 0,
    cancelRequested: false,
    retryOfJobId: retryOfJobId || null,
    resumeFromStage: resumeFromStage || null,
    failureReason: null,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: ts,
    updatedAt: ts,
    startedAt: status === JOB_STATUS.QUEUED ? null : ts,
    completedAt: TERMINAL_STATUSES.has(status) ? ts : null,
    history: [{
      status,
      stage: status,
      progress: 0,
      at: ts,
      reason: 'created',
    }],
  });
  const beforeById = new Map(ACTIVE_BY_ID);
  const beforeByIdempotency = new Map(ACTIVE_BY_IDEMPOTENCY);
  ACTIVE_BY_ID.set(job.id, job);
  ACTIVE_BY_IDEMPOTENCY.set(key, job.id);
  const persistence = persistJobStore();
  if (!persistence.ok) {
    ACTIVE_BY_ID.clear();
    ACTIVE_BY_IDEMPOTENCY.clear();
    for (const [jobId, existingJob] of beforeById.entries()) ACTIVE_BY_ID.set(jobId, existingJob);
    for (const [idempotencyKey, jobId] of beforeByIdempotency.entries()) {
      ACTIVE_BY_IDEMPOTENCY.set(idempotencyKey, jobId);
    }
    throw persistenceException(persistence);
  }
  return job;
}

function getScenarioGenerationJob(jobId) {
  ensureStoreLoaded();
  return ACTIVE_BY_ID.get(jobId) || null;
}

function listScenarioGenerationJobs({ projectId = undefined } = {}) {
  ensureStoreLoaded();
  return Array.from(ACTIVE_BY_ID.values())
    .filter((job) => !projectId || job.projectId === projectId)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function updateScenarioGenerationJob(job, {
  status = undefined,
  stage = undefined,
  progress = undefined,
  failureReason = undefined,
  generationId = undefined,
  metadata = undefined,
  cancelRequested = undefined,
  snapshots = undefined,
  reason = undefined,
} = {}) {
  if (!job) return null;
  const beforeMutation = cloneJson(job);
  const nextStatus = status || job.status;
  const ts = nowIso();
  job.status = nextStatus;
  job.stage = stage || nextStatus;
  if (Number.isFinite(Number(progress))) job.progress = Math.max(0, Math.min(100, Number(progress)));
  if (failureReason !== undefined) job.failureReason = failureReason;
  if (generationId !== undefined) job.generationId = generationId || null;
  if (metadata && typeof metadata === 'object') job.metadata = { ...(job.metadata || {}), ...metadata };
  if (cancelRequested !== undefined) job.cancelRequested = !!cancelRequested;
  if (snapshots !== undefined) job.snapshots = cloneJson(snapshots);
  if (!job.startedAt && nextStatus !== JOB_STATUS.QUEUED) job.startedAt = ts;
  if (TERMINAL_STATUSES.has(nextStatus)) {
    job.completedAt = ts;
    if (job.progress < 100) job.progress = 100;
  }
  job.updatedAt = ts;
  job.history.push({
    status: nextStatus,
    stage: job.stage,
    progress: job.progress,
    at: ts,
    reason: reason || null,
  });
  const persistence = persistJobStore();
  if (!persistence.ok) {
    restoreMutableObject(job, beforeMutation);
    throw persistenceException(persistence);
  }
  return job;
}

function summarizeScenarioSnapshot(scenarios = []) {
  const scenarioList = Array.isArray(scenarios) ? scenarios : [];
  const caseCount = scenarioList.reduce((sum, scenario) => {
    const cases = Array.isArray(scenario && scenario.cases) ? scenario.cases : [];
    return sum + cases.length;
  }, 0);
  return {
    scenarioCount: scenarioList.length,
    caseCount,
  };
}

function recordScenarioGenerationJobSnapshot(job, {
  stage,
  scenarios = [],
  metadata = {},
  reason = undefined,
} = {}) {
  if (!job) return null;
  const snapshotStage = stage || job.stage || job.status;
  const snapshot = withContractVersions({
    stage: snapshotStage,
    at: nowIso(),
    summary: summarizeScenarioSnapshot(scenarios),
    scenarios: redactScenarioSnapshots(scenarios),
    metadata: metadata && typeof metadata === 'object' ? cloneJson(metadata) : {},
  });
  const existing = Array.isArray(job.snapshots) ? job.snapshots : [];
  const nextSnapshots = [
    ...existing.filter((item) => item && item.stage !== snapshotStage),
    snapshot,
  ].slice(-8);
  return updateScenarioGenerationJob(job, {
    stage: job.stage || job.status,
    progress: job.progress,
    metadata: {
      latestSnapshotStage: snapshotStage,
      latestSnapshotSummary: snapshot.summary,
    },
    snapshots: nextSnapshots,
    reason: reason || `snapshot:${snapshotStage}`,
  });
}

function requestScenarioGenerationJobCancel(job, reason = 'cancel_requested') {
  if (!job) return null;
  return updateScenarioGenerationJob(job, {
    stage: job.stage || job.status,
    progress: job.progress,
    cancelRequested: true,
    reason,
  });
}

function retryScenarioGenerationJob(job, overrides = {}) {
  if (!job) return null;
  const resumeStage = overrides.resumeFromStage || job.resumeFromStage || 'full';
  return createScenarioGenerationJob({
    projectId: overrides.projectId || job.projectId,
    generationId: overrides.generationId,
    idempotencyKey: overrides.idempotencyKey || `${job.id}:retry:${resumeStage}`,
    retryOfJobId: job.id,
    resumeFromStage: resumeStage,
    metadata: {
      retryOfJobId: job.id,
      sourceJobStatus: job.status || null,
      ...(overrides.metadata || {}),
    },
  });
}

async function resumeScenarioGenerationJob(job, resumeFromStage) {
  if (!job) return null;
  const requestedStage = typeof resumeFromStage === 'string'
    ? resumeFromStage
    : resumeFromStage && resumeFromStage.resumeFromStage || job.resumeFromStage || JOB_STATUS.VALIDATING;
  const executable = !!(resumeFromStage && typeof resumeFromStage === 'object'
    && resumeFromStage.executable === true
    && typeof resumeFromStage.execute === 'function');
  if (!executable) {
    return updateScenarioGenerationJob(job, {
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      metadata: {
        recovery: {
          ...(job.metadata && job.metadata.recovery || {}),
          code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_UNAVAILABLE',
          executableResumeAvailable: false,
          requestedStage,
          resumeAccepted: false,
        },
      },
      reason: 'resume_rejected_no_executor',
    });
  }
  let executorResult;
  try {
    executorResult = await resumeFromStage.execute({
      job,
      resumeFromStage: requestedStage,
    });
    if (executorResult === false || (executorResult && executorResult.ok === false)) {
      throw Object.assign(new Error('The scenario generation resume executor rejected the request.'), {
        code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_REJECTED',
      });
    }
  } catch (error) {
    updateScenarioGenerationJob(job, {
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      metadata: {
        recovery: {
          ...(job.metadata && job.metadata.recovery || {}),
          code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_FAILED',
          executableResumeAvailable: true,
          requestedStage,
          resumeAccepted: false,
          errorCode: error && error.code ? String(error.code) : null,
        },
      },
      reason: 'resume_executor_failed',
    });
    const resumeError = new Error('The scenario generation resume executor failed.');
    resumeError.name = 'ScenarioGenerationResumeError';
    resumeError.code = 'SCENARIO_GENERATION_RESUME_EXECUTOR_FAILED';
    resumeError.cause = error;
    throw resumeError;
  }
  return updateScenarioGenerationJob(job, {
    status: requestedStage,
    stage: requestedStage,
    metadata: {
      recovery: {
        code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_ACCEPTED',
        executableResumeAvailable: true,
        requestedStage,
        resumeAccepted: true,
        executorCompleted: true,
      },
    },
    reason: 'resume_executor_accepted',
  });
}

function statusFromReliabilityReport(report = {}) {
  if (!report) return JOB_STATUS.NEEDS_REPAIR;
  if (report.status === SUITE_RELIABILITY_STATUS.READY || report.status === 'ready') return JOB_STATUS.READY;
  if (report.status === SUITE_RELIABILITY_STATUS.READY_WITH_USER_DECISIONS || report.status === 'ready_with_user_decisions') {
    return JOB_STATUS.READY_WITH_USER_DECISIONS;
  }
  if (report.status === SUITE_RELIABILITY_STATUS.NEEDS_USER_DECISION || report.status === 'needs_user_decision') {
    return JOB_STATUS.AWAITING_USER_DECISION;
  }
  if (report.status === SUITE_RELIABILITY_STATUS.NEEDS_REPAIR || report.status === 'needs_repair') return JOB_STATUS.NEEDS_REPAIR;
  return JOB_STATUS.NEEDS_REPAIR;
}

function completeScenarioGenerationJobFromReport(job, report = {}) {
  const status = statusFromReliabilityReport(report);
  return updateScenarioGenerationJob(job, {
    status,
    stage: status,
    progress: 100,
    metadata: {
      reliabilityStatus: report.status || null,
      unresolvedDefects: Array.isArray(report.unresolvedDefects) ? report.unresolvedDefects.length : 0,
      repairRoundsUsed: Number(report.repairRoundsUsed || 0),
    },
    reason: 'reliability_report_complete',
  });
}

function failScenarioGenerationJob(job, failureReason) {
  return updateScenarioGenerationJob(job, {
    status: JOB_STATUS.FAILED,
    stage: JOB_STATUS.FAILED,
    progress: 100,
    failureReason: failureReason || 'Scenario generation job failed.',
    reason: 'failed',
  });
}

function serializeScenarioGenerationJob(job) {
  return redactJobSnapshots(job);
}

async function persistScenarioGenerationJobToGeneration(prismaClient, job, { generationId = undefined } = {}) {
  if (!prismaClient || !job) {
    return persistenceFailure(
      'generation_evidence_invalid',
      'SCENARIO_GENERATION_JOB_PERSIST_INPUT_INVALID',
      'A Prisma client and scenario generation job are required.',
    );
  }
  const targetGenerationId = generationId || job.generationId;
  if (!targetGenerationId) {
    return persistenceFailure(
      'generation_id_missing',
      'SCENARIO_GENERATION_JOB_GENERATION_ID_REQUIRED',
      'A generation ID is required to persist scenario generation job evidence.',
    );
  }
  try {
    const row = await prismaClient.scenarioGeneration.findUnique({
      where: { id: targetGenerationId },
      select: { id: true, coverageValidationJson: true },
    });
    if (!row) {
      return persistenceFailure(
        'generation_not_found',
        'SCENARIO_GENERATION_JOB_GENERATION_NOT_FOUND',
        'The target scenario generation does not exist.',
        null,
        { generationId: targetGenerationId },
      );
    }
    const existing = safeParseJson(row.coverageValidationJson, {}) || {};
    const report = existing.reliabilityReport && typeof existing.reliabilityReport === 'object'
      ? existing.reliabilityReport
      : {};
    report.scenarioGenerationJob = serializeScenarioGenerationJob({ ...job, generationId: targetGenerationId });
    await prismaClient.scenarioGeneration.update({
      where: { id: targetGenerationId },
      data: {
        coverageValidationJson: safeStringify({
          ...existing,
          reliabilityReport: report,
        }),
      },
    });
    return {
      ...report.scenarioGenerationJob,
      persistence: persistenceState(true, 'generation_evidence_persisted', {
        generationId: targetGenerationId,
      }),
    };
  } catch (error) {
    return persistenceFailure(
      'generation_evidence_write_failed',
      'SCENARIO_GENERATION_JOB_GENERATION_PERSIST_FAILED',
      'Scenario generation job evidence could not be persisted to the generation.',
      error,
      { generationId: targetGenerationId },
    );
  }
}

function clearScenarioGenerationJobsForTest() {
  ACTIVE_BY_ID.clear();
  ACTIVE_BY_IDEMPOTENCY.clear();
  storeLoaded = true;
  if (persistenceEnabled) persistJobStore();
}

module.exports = {
  JOB_STATUS,
  TERMINAL_STATUSES,
  DEFAULT_RETENTION_MS,
  configureScenarioGenerationJobStore,
  getScenarioGenerationJobStoreStatus,
  createScenarioGenerationJob,
  getScenarioGenerationJob,
  listScenarioGenerationJobs,
  updateScenarioGenerationJob,
  recordScenarioGenerationJobSnapshot,
  requestScenarioGenerationJobCancel,
  retryScenarioGenerationJob,
  resumeScenarioGenerationJob,
  completeScenarioGenerationJobFromReport,
  failScenarioGenerationJob,
  serializeScenarioGenerationJob,
  persistScenarioGenerationJobToGeneration,
  clearScenarioGenerationJobsForTest,
};
