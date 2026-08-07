'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DRAFT_VERSION = 'AddScenarioDraftV1';
const DRAFT_STORE_VERSION = 'AddScenarioDraftStoreV1';
const DEFAULT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_STORE_PATH = process.env.QAAI_ADD_SCENARIO_DRAFT_STORE
  || path.join(__dirname, '..', '..', '.qaai-runtime', 'add-scenario-drafts.json');
const DEFAULT_KEY_PATH = process.env.QAAI_ADD_SCENARIO_DRAFT_KEY_FILE
  || path.join(__dirname, '..', '..', '.qaai-runtime', 'add-scenario-drafts.key');

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

function clean(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
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
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function persistenceResult(ok, status, details = {}) {
  return deepFreeze({ ok, status, ...clone(details) });
}

function normalizeEncryptionKey(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_) {}
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

function loadOrCreateEncryptionKey({ key, keyPath, persist }) {
  const configured = normalizeEncryptionKey(key || process.env.QAAI_ADD_SCENARIO_DRAFT_KEY);
  if (configured) return { key: configured, source: 'configured' };
  if (!persist || !keyPath) return { key: null, source: 'disabled' };
  try {
    if (fs.existsSync(keyPath)) {
      const loaded = normalizeEncryptionKey(fs.readFileSync(keyPath, 'utf8'));
      if (!loaded) throw new Error('Draft encryption key file is invalid.');
      return { key: loaded, source: 'key_file' };
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    const generated = crypto.randomBytes(32);
    try {
      fs.writeFileSync(keyPath, generated.toString('base64'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      return { key: generated, source: 'generated_key_file' };
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        const loaded = normalizeEncryptionKey(fs.readFileSync(keyPath, 'utf8'));
        if (loaded) return { key: loaded, source: 'key_file' };
      }
      throw error;
    }
  } catch (error) {
    return { key: null, source: 'error', error };
  }
}

function promoteStoreFile(tempPath, targetPath) {
  if (!fs.existsSync(targetPath)) {
    fs.renameSync(tempPath, targetPath);
    return;
  }
  const targetStat = fs.statSync(targetPath);
  if (!targetStat.isFile()) {
    throw Object.assign(new Error('The Add Scenario draft store target is not a file.'), {
      code: 'ADD_SCENARIO_DRAFT_STORE_TARGET_INVALID',
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

function encryptRecord(record, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(stableSerialize(record), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: DRAFT_VERSION,
    userId: record.userId,
    projectId: record.projectId,
    draftId: record.draftId,
    previewId: record.previewId,
    revision: record.revision,
    sourceDigest: record.sourceDigest,
    currentGenerationId: record.currentGenerationId,
    approvalStatus: record.approval && record.approval.status || 'ready',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAccess: record.lastAccess,
    expiresAt: record.expiresAt,
    redacted: true,
    encrypted: {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    },
  };
}

function decryptRecord(envelope, key) {
  if (!isObject(envelope) || !isObject(envelope.encrypted) || !key) return null;
  const encrypted = envelope.encrypted;
  if (encrypted.algorithm !== 'aes-256-gcm') return null;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encrypted.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plaintext);
  return isObject(parsed) ? parsed : null;
}

function keyPart(value) {
  const safe = clean(value);
  return `${safe.length}:${safe}`;
}

function primaryKey(userId, projectId, draftId) {
  return `${keyPart(userId)}|${keyPart(projectId)}|draft|${keyPart(draftId)}`;
}

function previewKey(userId, projectId, previewId) {
  return `${keyPart(userId)}|${keyPart(projectId)}|preview|${keyPart(previewId)}`;
}

function derivedDraftId(userId, projectId, previewId) {
  return `draft.${digest(stableSerialize({ userId, projectId, previewId })).slice(0, 24)}`;
}

function failure(status, code, message, details = {}) {
  return deepFreeze({ ok: false, status, code, message, ...clone(details) });
}

function success(status, draft, details = {}) {
  return deepFreeze({ ok: true, status, draft, ...clone(details) });
}

function validateAuthority(input) {
  const userId = clean(input && input.userId);
  const projectId = clean(input && input.projectId);
  const preview = input && input.preview;
  const previewId = clean(input && input.previewId) || clean(preview && preview.previewId);
  const revision = clean(input && input.revision);
  const sourceDigest = clean(input && input.sourceDigest);
  const originalSource = typeof (input && input.originalSource) === 'string' ? input.originalSource : null;
  if (!userId || !projectId || !previewId) {
    return failure(400, 'ADD_SCENARIO_DRAFT_IDENTITY_REQUIRED', 'userId, projectId, and previewId are required.');
  }
  if (!isObject(preview) || clean(preview.previewId) !== previewId) {
    return failure(400, 'ADD_SCENARIO_DRAFT_PREVIEW_INVALID', 'The preview must match the supplied previewId.');
  }
  if (!revision || clean(preview.revision) !== revision) {
    return failure(400, 'ADD_SCENARIO_DRAFT_REVISION_INVALID', 'The preview revision must match the supplied revision.');
  }
  if (!sourceDigest || !preview.source || clean(preview.source.digest) !== sourceDigest) {
    return failure(400, 'ADD_SCENARIO_DRAFT_SOURCE_INVALID', 'The preview source digest must match the supplied sourceDigest.');
  }
  if (originalSource === null || !isObject(input && input.semanticPlan)) {
    return failure(400, 'ADD_SCENARIO_DRAFT_CONTENT_REQUIRED', 'originalSource and semanticPlan are required.');
  }
  if (!preview.persistence || preview.persistence.status !== 'not_persisted') {
    return failure(400, 'ADD_SCENARIO_DRAFT_ALREADY_PERSISTED', 'Only non-persisted previews may enter the draft registry.');
  }
  return {
    ok: true,
    userId,
    projectId,
    previewId,
    draftId: clean(input && input.draftId) || derivedDraftId(userId, projectId, previewId),
    revision,
    sourceDigest,
    originalSource,
    semanticPlan: input.semanticPlan,
    preview,
    currentGenerationId: clean(input && input.currentGenerationId)
      || clean(preview.persistence.currentGenerationId)
      || null,
  };
}

function createAddScenarioDraftRegistry({
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  now = () => Date.now(),
  persist = false,
  storePath = null,
  keyPath = null,
  encryptionKey = null,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive number.');
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) throw new TypeError('maxEntries must be a positive integer.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');

  const records = new Map();
  const previewIndex = new Map();
  const effectiveStorePath = storePath ? path.resolve(storePath) : null;
  const effectiveKeyPath = keyPath ? path.resolve(keyPath) : null;
  const keyMaterial = loadOrCreateEncryptionKey({
    key: encryptionKey,
    keyPath: effectiveKeyPath,
    persist,
  });
  let lastPersistence = persistenceResult(!persist, persist ? 'not_started' : 'disabled', {
    durable: false,
  });

  function persistenceError(code, message, error = null, details = {}) {
    return persistenceResult(false, 'error', {
      durable: false,
      code,
      message,
      errorCode: clean(error && error.code, 120) || null,
      ...details,
    });
  }

  function persistStore() {
    if (!persist) {
      lastPersistence = persistenceResult(true, 'disabled', { durable: false });
      return lastPersistence;
    }
    if (!effectiveStorePath) {
      lastPersistence = persistenceError(
        'ADD_SCENARIO_DRAFT_STORE_PATH_REQUIRED',
        'Durable draft persistence requires a store path.',
      );
      return lastPersistence;
    }
    if (!keyMaterial.key) {
      lastPersistence = persistenceError(
        'ADD_SCENARIO_DRAFT_STORE_KEY_UNAVAILABLE',
        'Durable draft persistence requires an available encryption key.',
        keyMaterial.error,
      );
      return lastPersistence;
    }
    const tempPath = `${effectiveStorePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(effectiveStorePath), { recursive: true });
      const payload = {
        version: DRAFT_STORE_VERSION,
        encrypted: true,
        recordCount: records.size,
        records: Array.from(records.values()).map((record) => encryptRecord(record, keyMaterial.key)),
        updatedAt: new Date(now()).toISOString(),
      };
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      promoteStoreFile(tempPath, effectiveStorePath);
      lastPersistence = persistenceResult(true, 'persisted', {
        durable: true,
        recordCount: records.size,
      });
    } catch (error) {
      try { fs.rmSync(tempPath, { force: true }); } catch (_) {}
      lastPersistence = persistenceError(
        'ADD_SCENARIO_DRAFT_STORE_WRITE_FAILED',
        'The Add Scenario draft store could not be written.',
        error,
      );
    }
    return lastPersistence;
  }

  function loadStore() {
    if (!persist) {
      lastPersistence = persistenceResult(true, 'disabled', { durable: false, loaded: 0 });
      return lastPersistence;
    }
    if (!effectiveStorePath || !keyMaterial.key) return persistStore();
    if (!fs.existsSync(effectiveStorePath)) {
      lastPersistence = persistenceResult(true, 'empty', { durable: true, loaded: 0, skipped: 0 });
      return lastPersistence;
    }
    let loaded = 0;
    let skipped = 0;
    let recoveredApprovals = 0;
    try {
      const parsed = JSON.parse(fs.readFileSync(effectiveStorePath, 'utf8'));
      if (!isObject(parsed) || parsed.version !== DRAFT_STORE_VERSION || !Array.isArray(parsed.records)) {
        throw Object.assign(new Error('The Add Scenario draft store format is unsupported.'), {
          code: 'ADD_SCENARIO_DRAFT_STORE_VERSION_INVALID',
        });
      }
      for (const envelope of parsed.records) {
        try {
          let record = decryptRecord(envelope, keyMaterial.key);
          if (!record
            || record.version !== DRAFT_VERSION
            || !clean(record.userId)
            || !clean(record.projectId)
            || !clean(record.draftId)
            || !clean(record.previewId)
            || !Number.isFinite(Number(record.expiresAt))) {
            skipped += 1;
            continue;
          }
          if (record.approval && record.approval.status === 'approving') {
            record = {
              ...record,
              approval: {
                ...record.approval,
                status: 'ready',
                token: null,
                startedAt: null,
                completedAt: null,
                result: null,
                recoveredAfterRestart: true,
              },
            };
            recoveredApprovals += 1;
          }
          const frozen = deepFreeze(clone(record));
          const key = primaryKey(frozen.userId, frozen.projectId, frozen.draftId);
          const pKey = previewKey(frozen.userId, frozen.projectId, frozen.previewId);
          if (records.has(key) || previewIndex.has(pKey)) {
            skipped += 1;
            continue;
          }
          records.set(key, frozen);
          previewIndex.set(pKey, key);
          loaded += 1;
        } catch (_) {
          skipped += 1;
        }
      }
      const removedExpired = removeExpired(now(), false);
      const removedOverLimit = enforceBound();
      lastPersistence = persistenceResult(true, 'loaded', {
        durable: true,
        loaded,
        skipped,
        removedExpired,
        removedOverLimit,
        recoveredApprovals,
      });
      if (skipped || removedExpired || removedOverLimit || recoveredApprovals) persistStore();
    } catch (error) {
      records.clear();
      previewIndex.clear();
      lastPersistence = persistenceError(
        error.code || 'ADD_SCENARIO_DRAFT_STORE_READ_FAILED',
        'The Add Scenario draft store could not be loaded.',
        error,
      );
    }
    return lastPersistence;
  }

  function snapshotState() {
    return {
      records: new Map(records),
      previewIndex: new Map(previewIndex),
    };
  }

  function restoreState(snapshot) {
    records.clear();
    previewIndex.clear();
    for (const [key, record] of snapshot.records.entries()) records.set(key, record);
    for (const [key, recordKey] of snapshot.previewIndex.entries()) previewIndex.set(key, recordKey);
  }

  function commitSuccess(status, draft, details = {}, beforeMutation = null) {
    const persistence = persistStore();
    if (!persistence.ok) {
      if (beforeMutation) restoreState(beforeMutation);
      return failure(
        503,
        persistence.code || 'ADD_SCENARIO_DRAFT_STORE_WRITE_FAILED',
        persistence.message || 'The Add Scenario draft mutation could not be persisted.',
        { persistence },
      );
    }
    return success(status, draft, { ...details, persistence });
  }

  function removeByKey(key) {
    const record = records.get(key);
    if (!record) return false;
    records.delete(key);
    previewIndex.delete(previewKey(record.userId, record.projectId, record.previewId));
    return true;
  }

  function removeExpired(at = now(), persistChanges = true) {
    let removed = 0;
    for (const [key, record] of records.entries()) {
      if (record.expiresAt <= at && removeByKey(key)) removed += 1;
    }
    if (removed && persistChanges) persistStore();
    return removed;
  }

  function enforceBound() {
    let removed = 0;
    while (records.size > maxEntries) {
      let oldest = null;
      for (const [key, record] of records.entries()) {
        if (!oldest
          || record.lastAccess < oldest.record.lastAccess
          || (record.lastAccess === oldest.record.lastAccess && record.createdAt < oldest.record.createdAt)
          || (record.lastAccess === oldest.record.lastAccess
            && record.createdAt === oldest.record.createdAt
            && key.localeCompare(oldest.key) < 0)) {
          oldest = { key, record };
        }
      }
      if (!oldest || !removeByKey(oldest.key)) break;
      removed += 1;
    }
    return removed;
  }

  function locate({ userId, projectId, draftId, previewId } = {}) {
    const safeUserId = clean(userId);
    const safeProjectId = clean(projectId);
    const safeDraftId = clean(draftId);
    const safePreviewId = clean(previewId);
    if (!safeUserId || !safeProjectId || (!safeDraftId && !safePreviewId)) return null;
    const byDraft = safeDraftId ? primaryKey(safeUserId, safeProjectId, safeDraftId) : null;
    const byPreview = safePreviewId
      ? previewIndex.get(previewKey(safeUserId, safeProjectId, safePreviewId)) || null
      : null;
    if (byDraft && byPreview && byDraft !== byPreview) return null;
    const key = byDraft || byPreview;
    if (!key || !records.has(key)) return null;
    const record = records.get(key);
    if (safeDraftId && record.draftId !== safeDraftId) return null;
    if (safePreviewId && record.previewId !== safePreviewId) return null;
    return { key, record };
  }

  function touched(record, at) {
    return deepFreeze({
      ...clone(record),
      lastAccess: at,
      expiresAt: at + ttlMs,
    });
  }

  function put(input = {}) {
    const beforeMutation = snapshotState();
    const at = now();
    removeExpired(at, false);
    const authority = validateAuthority(input);
    if (!authority.ok) return authority;
    const key = primaryKey(authority.userId, authority.projectId, authority.draftId);
    const pKey = previewKey(authority.userId, authority.projectId, authority.previewId);
    const existingKey = records.has(key) ? key : previewIndex.get(pKey);
    if (existingKey) {
      const existing = records.get(existingKey);
      const exactReplay = existing
        && existing.draftId === authority.draftId
        && existing.previewId === authority.previewId
        && existing.revision === authority.revision
        && existing.sourceDigest === authority.sourceDigest
        && existing.originalSource === authority.originalSource;
      if (!exactReplay) {
        const allowSameOwnerRefresh = input.allowSameOwnerRefresh === true;
        const approvalStatus = existing && existing.approval && existing.approval.status || 'ready';
        if (!allowSameOwnerRefresh) {
          return failure(409, 'ADD_SCENARIO_DRAFT_IDENTITY_CONFLICT', 'The draft or preview identity is already registered.');
        }
        if (approvalStatus === 'approving' || approvalStatus === 'completed') {
          const next = touched(existing, at);
          records.set(existingKey, next);
          return commitSuccess(200, next, {
            created: false,
            reused: true,
            approvalStatus,
          }, beforeMutation);
        }
        records.delete(existingKey);
        previewIndex.delete(previewKey(existing.userId, existing.projectId, existing.previewId));
      } else {
        const next = touched(existing, at);
        records.set(existingKey, next);
        return commitSuccess(200, next, { created: false }, beforeMutation);
      }
    }
    const record = deepFreeze({
      version: DRAFT_VERSION,
      userId: authority.userId,
      projectId: authority.projectId,
      draftId: authority.draftId,
      previewId: authority.previewId,
      originalSource: authority.originalSource,
      semanticPlan: clone(authority.semanticPlan),
      preview: clone(authority.preview),
      currentGenerationId: authority.currentGenerationId,
      revision: authority.revision,
      sourceDigest: authority.sourceDigest,
      approval: {
        status: 'ready',
        attempts: 0,
        token: null,
        startedAt: null,
        completedAt: null,
        result: null,
      },
      ttlMs,
      createdAt: at,
      updatedAt: at,
      lastAccess: at,
      expiresAt: at + ttlMs,
    });
    records.set(key, record);
    previewIndex.set(pKey, key);
    enforceBound();
    return commitSuccess(201, record, { created: true }, beforeMutation);
  }

  function get(identity = {}) {
    const beforeMutation = snapshotState();
    const at = now();
    removeExpired(at, false);
    const located = locate(identity);
    if (!located) {
      return failure(404, 'ADD_SCENARIO_DRAFT_NOT_FOUND', 'The Add Scenario draft is unavailable.');
    }
    const next = touched(located.record, at);
    records.set(located.key, next);
    return commitSuccess(200, next, {}, beforeMutation);
  }

  function update(input = {}) {
    const beforeMutation = snapshotState();
    const at = now();
    removeExpired(at, false);
    const located = locate(input);
    if (!located) {
      return failure(404, 'ADD_SCENARIO_DRAFT_NOT_FOUND', 'The Add Scenario draft is unavailable.');
    }
    const current = located.record;
    if (current.approval && current.approval.status !== 'ready') {
      return failure(409, 'ADD_SCENARIO_DRAFT_APPROVAL_LOCKED', 'The draft cannot be refined while approval is active or completed.');
    }
    const expectedRevision = clean(input.expectedRevision);
    if (!expectedRevision || expectedRevision !== current.revision) {
      return failure(409, 'ADD_SCENARIO_DRAFT_REVISION_STALE', 'The draft revision is stale.', {
        expectedRevision: expectedRevision || null,
        currentRevision: current.revision,
      });
    }
    const preview = input.preview;
    const semanticPlan = input.semanticPlan;
    const revision = clean(input.revision);
    const sourceDigest = clean(input.sourceDigest);
    if (!isObject(preview)
      || clean(preview.previewId) !== current.previewId
      || !preview.persistence
      || preview.persistence.status !== 'not_persisted') {
      return failure(409, 'ADD_SCENARIO_DRAFT_PREVIEW_CONFLICT', 'The update must retain the same non-persisted preview identity.');
    }
    if (!revision || clean(preview.revision) !== revision || !isObject(semanticPlan)) {
      return failure(400, 'ADD_SCENARIO_DRAFT_UPDATE_INVALID', 'semanticPlan and a matching preview revision are required.');
    }
    if (!sourceDigest || sourceDigest !== current.sourceDigest || clean(preview.source && preview.source.digest) !== sourceDigest) {
      return failure(409, 'ADD_SCENARIO_DRAFT_SOURCE_CONFLICT', 'The original source digest cannot change during refinement.');
    }
    const next = deepFreeze({
      ...clone(current),
      semanticPlan: clone(semanticPlan),
      preview: clone(preview),
      revision,
      updatedAt: at,
      lastAccess: at,
      expiresAt: at + ttlMs,
    });
    records.set(located.key, next);
    return commitSuccess(200, next, { previousRevision: current.revision }, beforeMutation);
  }

  function approvalAuthority(input, at) {
    removeExpired(at, false);
    const located = locate(input);
    if (!located) {
      return failure(404, 'ADD_SCENARIO_DRAFT_NOT_FOUND', 'The Add Scenario draft is unavailable.');
    }
    const current = located.record;
    const expectedRevision = clean(input && input.expectedRevision);
    if (!expectedRevision || expectedRevision !== current.revision) {
      return failure(409, 'ADD_SCENARIO_DRAFT_REVISION_STALE', 'The draft revision is stale.', {
        expectedRevision: expectedRevision || null,
        currentRevision: current.revision,
      });
    }
    const expectedGenerationId = clean(input && input.expectedGenerationId);
    if (!expectedGenerationId || expectedGenerationId !== current.currentGenerationId) {
      return failure(409, 'ADD_SCENARIO_DRAFT_GENERATION_STALE', 'The target generation changed before approval.', {
        expectedGenerationId: expectedGenerationId || null,
        currentGenerationId: current.currentGenerationId,
      });
    }
    return { ok: true, key: located.key, current };
  }

  function approvalReplay(current, mode = 'replay') {
    return success(200, current, {
      mode,
      approvalToken: current.approval && current.approval.token || null,
      approvalResult: clone(current.approval && current.approval.result),
    });
  }

  function beginApproval(input = {}) {
    const beforeMutation = snapshotState();
    const at = now();
    const authority = approvalAuthority(input, at);
    if (!authority.ok) return authority;
    const { key, current } = authority;
    const approval = current.approval || { status: 'ready', attempts: 0 };
    if (approval.status === 'completed') return approvalReplay(current);
    if (approval.status === 'approving') {
      return success(202, current, {
        mode: 'in_progress',
        approvalToken: approval.token,
        approvalResult: null,
      });
    }
    if (approval.status !== 'ready') {
      return failure(409, 'ADD_SCENARIO_DRAFT_APPROVAL_STATE_INVALID', 'The draft approval state is invalid.');
    }
    const token = crypto.randomUUID();
    const next = deepFreeze({
      ...clone(current),
      approval: {
        status: 'approving',
        attempts: Number(approval.attempts || 0) + 1,
        token,
        startedAt: at,
        completedAt: null,
        result: null,
      },
      updatedAt: at,
      lastAccess: at,
      expiresAt: at + ttlMs,
    });
    records.set(key, next);
    return commitSuccess(202, next, {
      mode: 'acquired',
      approvalToken: token,
      approvalResult: null,
    }, beforeMutation);
  }

  function completeApproval(input = {}) {
    const beforeMutation = snapshotState();
    const at = now();
    const authority = approvalAuthority(input, at);
    if (!authority.ok) return authority;
    const { key, current } = authority;
    const approval = current.approval || { status: 'ready', attempts: 0 };
    if (approval.status === 'completed') return approvalReplay(current);
    if (approval.status !== 'approving') {
      return failure(409, 'ADD_SCENARIO_DRAFT_APPROVAL_NOT_ACTIVE', 'The draft does not have an active approval claim.');
    }
    const approvalToken = clean(input.approvalToken);
    if (!approvalToken || approvalToken !== approval.token) {
      return failure(409, 'ADD_SCENARIO_DRAFT_APPROVAL_TOKEN_STALE', 'The approval claim token is stale.');
    }
    if (!isObject(input.approvalResult)) {
      return failure(400, 'ADD_SCENARIO_DRAFT_APPROVAL_RESULT_REQUIRED', 'An immutable approval result object is required.');
    }
    const completedResult = clone(input.approvalResult);
    const next = deepFreeze({
      ...clone(current),
      approval: {
        status: 'completed',
        attempts: Number(approval.attempts || 0),
        token: approval.token,
        startedAt: approval.startedAt,
        completedAt: at,
        result: completedResult,
      },
      updatedAt: at,
      lastAccess: at,
      expiresAt: at + ttlMs,
    });
    records.set(key, next);
    return commitSuccess(200, next, {
      mode: 'completed',
      approvalToken: approval.token,
      approvalResult: completedResult,
    }, beforeMutation);
  }

  function failApproval(input = {}) {
    const beforeMutation = snapshotState();
    const at = now();
    const authority = approvalAuthority(input, at);
    if (!authority.ok) return authority;
    const { key, current } = authority;
    const approval = current.approval || { status: 'ready', attempts: 0 };
    if (approval.status === 'completed') return approvalReplay(current);
    if (approval.status === 'ready') {
      return success(200, current, {
        mode: 'already_ready',
        approvalToken: null,
        approvalResult: null,
      });
    }
    if (approval.status !== 'approving') {
      return failure(409, 'ADD_SCENARIO_DRAFT_APPROVAL_STATE_INVALID', 'The draft approval state is invalid.');
    }
    const approvalToken = clean(input.approvalToken);
    if (!approvalToken || approvalToken !== approval.token) {
      return failure(409, 'ADD_SCENARIO_DRAFT_APPROVAL_TOKEN_STALE', 'The approval claim token is stale.');
    }
    const next = deepFreeze({
      ...clone(current),
      approval: {
        status: 'ready',
        attempts: Number(approval.attempts || 0),
        token: null,
        startedAt: null,
        completedAt: null,
        result: null,
      },
      updatedAt: at,
      lastAccess: at,
      expiresAt: at + ttlMs,
    });
    records.set(key, next);
    return commitSuccess(200, next, {
      mode: 'released',
      approvalToken: null,
      approvalResult: null,
    }, beforeMutation);
  }

  function sweep() {
    const beforeMutation = snapshotState();
    const removedExpired = removeExpired(now(), false);
    const removedOverLimit = enforceBound();
    const persistence = removedExpired || removedOverLimit ? persistStore() : lastPersistence;
    if (!persistence.ok) restoreState(beforeMutation);
    return deepFreeze({ removedExpired, removedOverLimit, size: records.size, persistence });
  }

  function clear() {
    const beforeMutation = snapshotState();
    records.clear();
    previewIndex.clear();
    const persistence = persistStore();
    if (!persistence.ok) restoreState(beforeMutation);
    return persistence;
  }

  function size() {
    return records.size;
  }

  function persistenceStatus() {
    return deepFreeze(clone(lastPersistence));
  }

  loadStore();

  return Object.freeze({
    put,
    get,
    update,
    beginApproval,
    completeApproval,
    failApproval,
    sweep,
    clear,
    size,
    persistenceStatus,
  });
}

const addScenarioDraftRegistry = createAddScenarioDraftRegistry({
  persist: process.env.QAAI_ADD_SCENARIO_DRAFT_PERSISTENCE !== 'false',
  storePath: DEFAULT_STORE_PATH,
  keyPath: DEFAULT_KEY_PATH,
});

module.exports = {
  DRAFT_VERSION,
  DRAFT_STORE_VERSION,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_STORE_PATH,
  DEFAULT_KEY_PATH,
  createAddScenarioDraftRegistry,
  addScenarioDraftRegistry,
};
