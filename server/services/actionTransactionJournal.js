'use strict';

const crypto = require('node:crypto');

const JOURNAL_SCHEMA_VERSION = 1;

const RECORD_TYPE = Object.freeze({
  ACTION_ATTEMPT: 'action_attempt',
  DISPATCH_MARKER: 'dispatch_marker',
  REPLACEMENT: 'replacement',
  RECONCILIATION: 'reconciliation',
});

const ATTEMPT_STATUS = Object.freeze({
  ATTEMPTED: 'attempted',
  DISCARDED: 'discarded',
  CANONICAL: 'canonical',
});

const DISPATCH_STATUS = Object.freeze({
  NOT_DISPATCHED: 'not_dispatched',
  DISPATCH_MARKED: 'dispatch_marked',
  DELIVERED: 'delivered',
  NOT_DELIVERED: 'not_delivered',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
  NOT_REQUIRED: 'not_required',
});

const SECRET_KEY_RE = /(?:password|passwd|pwd|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|storage[_-]?state)/i;
const SENSITIVE_SEMANTIC_RE = /(?:password|passwd|secret|credential|access token|refresh token|api key|private key)/i;
const GENERIC_VALUE_KEY_RE = /^(?:value|input|text|actual|expected|beforevalue|aftervalue|rawvalue|valueafter|actualvalue|inputvalue|ownervalue|selectedvalue|selectedvalues|readbackvalue|observedvalue|currentvalue|previousvalue|newvalue|oldvalue)$/i;
const SNAPSHOT_KEY_RE = /^(?:snapshottext|rawsnapshot|domsnapshot|accessibilitysnapshot|pagesource|html|outerhtml|innerhtml)$/i;
const SENSITIVE_CONTENT_KEY_RE = /^(?:message|reason|note|details?|content|body|payload|evidence|result|observation|outcome|error|response|request)$/i;

function timestamp(now = Date.now) {
  const value = typeof now === 'function' ? now() : now;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(Number(value)).toISOString();
}

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

function scrubString(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(\[\s*ref\s*=\s*)[^\]\s]+/gi, '$1[REDACTED]')
    .replace(/([?&#])(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|session|code|access_token|refresh_token)=[^&#\s]*/gi, '$1[REDACTED]')
    .replace(/\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]');
}

function semanticText(value) {
  if (!value || typeof value !== 'object') return '';
  const target = value.target && typeof value.target === 'object' ? value.target : {};
  return [
    value.type,
    value.inputType,
    value.name,
    value.label,
    value.role,
    target.type,
    target.inputType,
    target.name,
    target.label,
    target.role,
  ].filter(Boolean).join(' ');
}

function redactedReference(path) {
  const safePath = path.filter(Boolean).map((part) => String(part).replace(/[^a-z0-9_-]+/gi, '_')).join('/');
  return `redacted://action-journal/${safePath || 'value'}`;
}

function isFullBrowserSnapshot(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.snapshotText === 'string'
    && (value.fresh === true || value.fresh === false || value.url != null || value.capturedAt != null);
}

function compactBrowserSnapshot(value, path) {
  const compact = {
    snapshotRef: redactedReference([...path, 'snapshot']),
    fresh: value.fresh === true,
    usable: value.fresh === true && value.snapshotText.trim() !== '',
  };
  if (value.capturedAt != null) compact.capturedAt = scrubString(value.capturedAt);
  if (value.url != null) compact.url = scrubString(value.url);
  return compact;
}

function isSensitiveContentKey(key) {
  if (/(?:ref|refs|id|ids|type|kind|status|name|role)$/i.test(key)) return false;
  return GENERIC_VALUE_KEY_RE.test(key) || SENSITIVE_CONTENT_KEY_RE.test(key);
}

function privacySafeValue(value, context = {}) {
  const seen = context.seen || new WeakSet();
  const path = context.path || [];
  const inheritedSensitive = context.sensitive === true;
  const redactScalar = context.redactScalar === true;

  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') {
    return redactScalar ? redactedReference(path) : scrubString(value);
  }
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: scrubString(value.name || 'Error'),
      code: value.code == null ? null : scrubString(value.code),
      message: inheritedSensitive || redactScalar
        ? redactedReference([...path, 'message'])
        : scrubString(value.message || ''),
    };
  }
  if (typeof value !== 'object') return scrubString(value);
  if (seen.has(value)) return '[Circular]';

  if (isFullBrowserSnapshot(value)) return compactBrowserSnapshot(value, path);

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map((item, index) => privacySafeValue(item, {
      seen,
      path: [...path, index],
      sensitive: inheritedSensitive,
      redactScalar,
    }));
    seen.delete(value);
    return result;
  }

  const intrinsicSensitive = value.sensitive === true
    || value.secret === true
    || SENSITIVE_SEMANTIC_RE.test(semanticText(value));
  const ownSensitive = inheritedSensitive || intrinsicSensitive;
  const hasValueRef = typeof value.valueRef === 'string' && value.valueRef.trim() !== '';
  const result = {};

  for (const [key, item] of Object.entries(value)) {
    if (key === 'stack') continue;
    const keyIsSecret = SECRET_KEY_RE.test(key) && !/(?:Ref|Id)$/i.test(key);
    if (keyIsSecret) {
      const refKey = `${key}Ref`;
      if (!Object.prototype.hasOwnProperty.call(result, refKey)) {
        const suppliedRef = Object.entries(value).find(([candidateKey, candidateValue]) => (
          candidateKey.toLowerCase() === refKey.toLowerCase()
          && typeof candidateValue === 'string'
          && candidateValue.trim() !== ''
        ));
        result[refKey] = suppliedRef
          ? scrubString(suppliedRef[1])
          : redactedReference([...path, key]);
      }
      continue;
    }
    if (SNAPSHOT_KEY_RE.test(key)) {
      result[`${key}Ref`] = redactedReference([...path, key]);
      continue;
    }
    if ((ownSensitive || hasValueRef) && GENERIC_VALUE_KEY_RE.test(key)) continue;
    const contentLeaf = item == null || typeof item !== 'object' || Array.isArray(item);
    const childRedactScalar = redactScalar
      || keyIsSecret
      || (contentLeaf && (ownSensitive || hasValueRef) && isSensitiveContentKey(key));
    const normalized = privacySafeValue(item, {
      seen,
      path: [...path, key],
      sensitive: ownSensitive || keyIsSecret,
      redactScalar: childRedactScalar,
    });
    if (normalized !== undefined) result[key] = normalized;
  }

  if (intrinsicSensitive && !result.valueRef) {
    result.valueRef = hasValueRef ? scrubString(value.valueRef) : redactedReference([...path, 'value']);
  }
  seen.delete(value);
  return result;
}

function cloneSafe(value, context = {}) {
  const normalized = privacySafeValue(value, context);
  return normalized === undefined ? null : JSON.parse(JSON.stringify(normalized));
}

function journalEntryIsSensitive(value = {}) {
  return value.sensitive === true
    || value.action?.sensitive === true
    || value.replay?.sensitive === true
    || SENSITIVE_SEMANTIC_RE.test(semanticText(value.action || value.replay || value));
}

function normalizeString(value) {
  return value == null ? null : String(value).trim() || null;
}

function normalizeRefs(value, context = {}) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.map((item) => cloneSafe(item, context)).filter((item) => item != null);
}

function normalizeAttemptStatus(value, canonicalOutcome) {
  if (Object.values(ATTEMPT_STATUS).includes(value)) return value;
  return canonicalOutcome ? ATTEMPT_STATUS.CANONICAL : ATTEMPT_STATUS.ATTEMPTED;
}

function normalizeDispatch(value = {}, mutating = true, context = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const status = Object.values(DISPATCH_STATUS).includes(input.status)
    ? input.status
    : mutating ? DISPATCH_STATUS.NOT_DISPATCHED : DISPATCH_STATUS.NOT_REQUIRED;
  return {
    status,
    markerPersistedAt: normalizeString(input.markerPersistedAt),
    dispatchTimestamp: normalizeString(input.dispatchTimestamp),
    dispatchAttempt: Number.isInteger(input.dispatchAttempt) ? input.dispatchAttempt : 0,
    resultRef: cloneSafe(input.resultRef || null, context),
  };
}

function createActionTransactionJournal(input = {}, { now = Date.now } = {}) {
  const createdAt = timestamp(now);
  const identity = {
    runId: normalizeString(input.runId),
    runResultId: normalizeString(input.runResultId),
    caseId: normalizeString(input.caseId),
  };
  const journalId = normalizeString(input.journalId) || stableId('action-journal', identity);
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    journalId,
    ...identity,
    revision: 0,
    createdAt,
    updatedAt: createdAt,
    entries: [],
  };
}

function parseJournal(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new TypeError(`persisted journal is not valid JSON: ${error.message}`);
  }
}

function hydrateActionTransactionJournal(value) {
  const parsed = parseJournal(value);
  if (!parsed || typeof parsed !== 'object') throw new TypeError('persisted journal must be an object');
  if (!parsed.journalId) throw new Error('persisted journal is missing journalId');
  const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const journal = cloneSafe({ ...parsed, entries: [] });
  journal.schemaVersion = Number(journal.schemaVersion || JOURNAL_SCHEMA_VERSION);
  journal.revision = Number.isInteger(journal.revision) ? journal.revision : 0;
  journal.entries = rawEntries.map((entry) => {
    const sensitive = journalEntryIsSensitive(entry);
    return cloneSafe({ ...entry, sensitive }, { sensitive });
  });

  const entryIds = new Set();
  for (let index = 0; index < journal.entries.length; index += 1) {
    const entry = journal.entries[index];
    if (!entry?.journalEntryId || !entry?.actionOccurrenceId) {
      throw new Error(`persisted journal entry ${index} is missing stable identity`);
    }
    if (entryIds.has(entry.journalEntryId)) throw new Error(`duplicate journal entry id: ${entry.journalEntryId}`);
    entryIds.add(entry.journalEntryId);
    entry.ordinal = Number.isInteger(entry.ordinal) ? entry.ordinal : index;
  }
  return journal;
}

function serializeActionTransactionJournal(journal) {
  return JSON.stringify(cloneSafe(hydrateActionTransactionJournal(journal)));
}

function entryById(journal, journalEntryId) {
  return journal.entries.find((entry) => entry.journalEntryId === journalEntryId) || null;
}

function replacementTargets(journal) {
  return new Set(journal.entries.map((entry) => entry.replacesJournalEntryId).filter(Boolean));
}

function isLeafEntry(journal, journalEntryId) {
  return !replacementTargets(journal).has(journalEntryId);
}

function nextAttemptIndex(journal, actionOccurrenceId) {
  const indexes = journal.entries
    .filter((entry) => entry.actionOccurrenceId === actionOccurrenceId)
    .map((entry) => Number(entry.attemptIndex))
    .filter(Number.isInteger);
  return indexes.length ? Math.max(...indexes) + 1 : 0;
}

function normalizeJournalEntry(journal, input = {}, { now = Date.now } = {}) {
  const recordedAt = timestamp(now);
  const ordinal = journal.entries.length;
  const actionOccurrenceId = normalizeString(input.actionOccurrenceId);
  if (!actionOccurrenceId) throw new TypeError('actionOccurrenceId is required');

  const attemptIndex = Number.isInteger(input.attemptIndex)
    ? input.attemptIndex
    : nextAttemptIndex(journal, actionOccurrenceId);
  const attemptId = normalizeString(input.attemptId) || stableId('action-attempt', {
    journalId: journal.journalId,
    actionOccurrenceId,
    attemptIndex,
  });
  const sensitive = journalEntryIsSensitive(input);
  const privacyContext = { sensitive };
  const canonicalOutcome = cloneSafe(input.canonicalOutcome || null, privacyContext);
  const attemptStatus = normalizeAttemptStatus(input.attemptStatus, canonicalOutcome);
  const mutating = input.mutating !== false;
  const recordType = Object.values(RECORD_TYPE).includes(input.recordType)
    ? input.recordType
    : RECORD_TYPE.ACTION_ATTEMPT;
  const journalEntryId = normalizeString(input.journalEntryId) || stableId('journal-entry', {
    journalId: journal.journalId,
    ordinal,
    recordType,
    actionOccurrenceId,
    attemptId,
    recordedAt,
  });

  return cloneSafe({
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    journalEntryId,
    journalId: journal.journalId,
    ordinal,
    recordType,
    runId: normalizeString(input.runId) || journal.runId || null,
    runResultId: normalizeString(input.runResultId) || journal.runResultId || null,
    caseId: normalizeString(input.caseId) || journal.caseId || null,
    stepId: normalizeString(input.stepId),
    sequenceIndex: Number.isInteger(input.sequenceIndex) ? input.sequenceIndex : ordinal,
    actionOccurrenceId,
    attemptId,
    attemptIndex,
    attemptStatus,
    mutating,
    sensitive,
    action: cloneSafe(input.action || null, privacyContext),
    replay: cloneSafe(input.replay || input.action || null, privacyContext),
    ledgerLineId: normalizeString(input.ledgerLineId),
    actionEvidenceId: normalizeString(input.actionEvidenceId),
    assertionEvidenceId: normalizeString(input.assertionEvidenceId),
    preEvidenceRefs: normalizeRefs(input.preEvidenceRefs, privacyContext),
    actionEvidenceRefs: normalizeRefs(input.actionEvidenceRefs, privacyContext),
    postEvidenceRefs: normalizeRefs(input.postEvidenceRefs, privacyContext),
    dispatch: normalizeDispatch(input.dispatch, mutating, privacyContext),
    canonicalOutcome,
    assertion: cloneSafe(input.assertion || null, privacyContext),
    urlTransition: cloneSafe(input.urlTransition || null, privacyContext),
    failureBoundary: cloneSafe(input.failureBoundary || null, privacyContext),
    retryOfActionOccurrenceId: normalizeString(input.retryOfActionOccurrenceId),
    retryOfJournalEntryId: normalizeString(input.retryOfJournalEntryId),
    replacesJournalEntryId: normalizeString(input.replacesJournalEntryId),
    reconciliation: cloneSafe(input.reconciliation || null, privacyContext),
    recordedAt,
  }, privacyContext);
}

function validateLinkage(journal, entry) {
  if (entry.replacesJournalEntryId) {
    const replaced = entryById(journal, entry.replacesJournalEntryId);
    if (!replaced) throw new Error(`replacement target does not exist: ${entry.replacesJournalEntryId}`);
    if (!isLeafEntry(journal, replaced.journalEntryId)) {
      throw new Error(`replacement target is not the latest immutable entry: ${entry.replacesJournalEntryId}`);
    }
    if (replaced.actionOccurrenceId !== entry.actionOccurrenceId) {
      throw new Error('replacement must preserve actionOccurrenceId');
    }
  }
  if (entry.retryOfJournalEntryId && !entryById(journal, entry.retryOfJournalEntryId)) {
    throw new Error(`retry target does not exist: ${entry.retryOfJournalEntryId}`);
  }
}

function appendJournalEntry(journalValue, input = {}, options = {}) {
  const journal = hydrateActionTransactionJournal(journalValue);
  const entry = normalizeJournalEntry(journal, input, options);
  if (entryById(journal, entry.journalEntryId)) throw new Error(`journal entry already exists: ${entry.journalEntryId}`);
  validateLinkage(journal, entry);
  const next = {
    ...journal,
    revision: journal.revision + 1,
    updatedAt: entry.recordedAt,
    entries: [...journal.entries, entry],
  };
  return cloneSafe(next);
}

function appendReplacement(journalValue, replacesJournalEntryId, patch = {}, options = {}) {
  const journal = hydrateActionTransactionJournal(journalValue);
  const previous = entryById(journal, replacesJournalEntryId);
  if (!previous) throw new Error(`replacement target does not exist: ${replacesJournalEntryId}`);
  const merged = {
    ...previous,
    ...patch,
    dispatch: { ...previous.dispatch, ...(patch.dispatch || {}) },
    recordType: patch.recordType || RECORD_TYPE.REPLACEMENT,
    journalEntryId: patch.journalEntryId || null,
    replacesJournalEntryId,
    actionOccurrenceId: previous.actionOccurrenceId,
    attemptId: patch.attemptId || previous.attemptId,
    attemptIndex: Number.isInteger(patch.attemptIndex) ? patch.attemptIndex : previous.attemptIndex,
  };
  return appendJournalEntry(journal, merged, options);
}

function appendDispatchMarker(journalValue, journalEntryId, input = {}, options = {}) {
  const journal = hydrateActionTransactionJournal(journalValue);
  const previous = entryById(journal, journalEntryId);
  if (!previous) throw new Error(`dispatch target does not exist: ${journalEntryId}`);
  if (previous.dispatch?.markerPersistedAt) return journal;
  const markerPersistedAt = timestamp(options.now || Date.now);
  return appendReplacement(journal, journalEntryId, {
    recordType: RECORD_TYPE.DISPATCH_MARKER,
    dispatch: {
      ...previous.dispatch,
      status: DISPATCH_STATUS.DISPATCH_MARKED,
      markerPersistedAt,
      dispatchTimestamp: input.dispatchTimestamp || null,
      dispatchAttempt: Number.isInteger(input.dispatchAttempt)
        ? input.dispatchAttempt
        : Number(previous.dispatch?.dispatchAttempt || 0) + 1,
    },
  }, { ...options, now: () => markerPersistedAt });
}

function appendRetryAttempt(journalValue, priorJournalEntryId, input = {}, options = {}) {
  const journal = hydrateActionTransactionJournal(journalValue);
  const prior = entryById(journal, priorJournalEntryId);
  if (!prior) throw new Error(`retry target does not exist: ${priorJournalEntryId}`);
  const actionOccurrenceId = normalizeString(input.actionOccurrenceId) || stableId('action-occurrence-retry', {
    priorActionOccurrenceId: prior.actionOccurrenceId,
    retryIndex: Number(prior.attemptIndex || 0) + 1,
  });
  return appendJournalEntry(journal, {
    ...prior,
    ...input,
    journalEntryId: null,
    recordType: RECORD_TYPE.ACTION_ATTEMPT,
    actionOccurrenceId,
    attemptId: input.attemptId || null,
    attemptIndex: Number.isInteger(input.attemptIndex) ? input.attemptIndex : Number(prior.attemptIndex || 0) + 1,
    attemptStatus: ATTEMPT_STATUS.ATTEMPTED,
    canonicalOutcome: null,
    retryOfActionOccurrenceId: prior.actionOccurrenceId,
    retryOfJournalEntryId: prior.journalEntryId,
    replacesJournalEntryId: null,
    dispatch: input.dispatch || { status: DISPATCH_STATUS.NOT_DISPATCHED },
    preEvidenceRefs: input.preEvidenceRefs || prior.preEvidenceRefs,
    actionEvidenceRefs: input.actionEvidenceRefs || [],
    postEvidenceRefs: input.postEvidenceRefs || [],
  }, options);
}

function leafEntries(journalValue) {
  const journal = hydrateActionTransactionJournal(journalValue);
  const replaced = replacementTargets(journal);
  return journal.entries.filter((entry) => !replaced.has(entry.journalEntryId));
}

function latestEntryForOccurrence(journalValue, actionOccurrenceId) {
  return leafEntries(journalValue)
    .filter((entry) => entry.actionOccurrenceId === actionOccurrenceId)
    .sort((left, right) => right.ordinal - left.ordinal)[0] || null;
}

function isAssertionRecord(entry) {
  if (entry.assertion || entry.assertionEvidenceId) return true;
  const kind = String(entry.replay?.kind || entry.replay?.action || entry.action?.kind || entry.action?.action || '').toLowerCase();
  return /^(?:assert|verify|expect)/.test(kind);
}

function projectCanonicalReplay(journalValue) {
  const leaves = leafEntries(journalValue);
  const latestByOccurrence = new Map();
  for (const entry of leaves) {
    const previous = latestByOccurrence.get(entry.actionOccurrenceId);
    if (!previous || previous.ordinal < entry.ordinal) latestByOccurrence.set(entry.actionOccurrenceId, entry);
  }
  const candidates = [...latestByOccurrence.values()].filter((entry) => (
    entry.attemptStatus === ATTEMPT_STATUS.CANONICAL && entry.canonicalOutcome
  ));
  const supersededOccurrences = new Set(candidates.map((entry) => entry.retryOfActionOccurrenceId).filter(Boolean));
  return candidates
    .filter((entry) => !supersededOccurrences.has(entry.actionOccurrenceId))
    .sort((left, right) => left.sequenceIndex - right.sequenceIndex || left.ordinal - right.ordinal)
    .map((entry) => cloneSafe({
      journalEntryId: entry.journalEntryId,
      actionOccurrenceId: entry.actionOccurrenceId,
      attemptId: entry.attemptId,
      caseId: entry.caseId,
      stepId: entry.stepId,
      sequenceIndex: entry.sequenceIndex,
      ledgerLineId: entry.ledgerLineId,
      actionEvidenceId: entry.actionEvidenceId,
      assertionEvidenceId: entry.assertionEvidenceId,
      action: entry.action,
      replay: entry.replay,
      preEvidenceRefs: entry.preEvidenceRefs,
      actionEvidenceRefs: entry.actionEvidenceRefs,
      postEvidenceRefs: entry.postEvidenceRefs,
      dispatch: entry.dispatch,
      canonicalOutcome: entry.canonicalOutcome,
      assertion: entry.assertion,
      urlTransition: entry.urlTransition,
      failureBoundary: entry.failureBoundary,
      retryOfActionOccurrenceId: entry.retryOfActionOccurrenceId,
    }));
}

function normalizeOutcome(proof = {}) {
  const matched = proof.matched === true ? true : proof.matched === false ? false : null;
  const checked = proof.checked === true || matched !== null;
  const terminal = proof.terminal === true || matched !== null;
  if (!terminal) return null;
  return cloneSafe(proof.canonicalOutcome || {
    status: matched === true ? 'passed' : matched === false ? 'failed' : 'blocked',
    matched,
    checked,
    reason: proof.reason || (matched === true ? 'postcondition_proven' : matched === false ? 'postcondition_mismatch' : 'postcondition_unproven'),
  });
}

async function saveActionTransactionJournal(repository, journalValue) {
  if (!repository) return hydrateActionTransactionJournal(journalValue);
  const journal = hydrateActionTransactionJournal(journalValue);
  const snapshot = cloneSafe(journal);
  if (typeof repository === 'function') await repository(snapshot);
  else if (typeof repository.save === 'function') await repository.save(snapshot);
  else if (typeof repository.write === 'function') await repository.write(snapshot);
  else throw new TypeError('repository must be a save callback or expose save/write');
  return journal;
}

async function loadActionTransactionJournal(repository, identity = {}) {
  if (!repository || typeof repository === 'function') {
    throw new TypeError('repository must expose load/read to load a journal');
  }
  const loader = typeof repository.load === 'function' ? repository.load : repository.read;
  if (typeof loader !== 'function') throw new TypeError('repository must expose load/read to load a journal');
  const value = await loader(cloneSafe(identity));
  return value == null ? null : hydrateActionTransactionJournal(value);
}

async function appendAndPersist(journalValue, input, options = {}) {
  const next = appendJournalEntry(journalValue, input, options);
  await saveActionTransactionJournal(options.repository, next);
  return next;
}

async function reconcileJournalOnResume(journalValue, actionOccurrenceId, options = {}) {
  if (typeof options.observe !== 'function') throw new TypeError('observe callback is required');
  if (typeof options.provePostcondition !== 'function') throw new TypeError('provePostcondition callback is required');

  let journal = hydrateActionTransactionJournal(journalValue);
  let current = latestEntryForOccurrence(journal, actionOccurrenceId);
  if (!current) throw new Error(`action occurrence does not exist: ${actionOccurrenceId}`);
  if (current.attemptStatus === ATTEMPT_STATUS.CANONICAL && current.canonicalOutcome) {
    return {
      journal,
      entry: cloneSafe(current),
      outcome: cloneSafe(current.canonicalOutcome),
      resumed: true,
      reconciled: false,
      redispatched: false,
      shouldRedispatch: false,
    };
  }

  const maxObservationAttempts = Math.max(1, Number(options.maxObservationAttempts || 3));
  for (let attempt = 0; attempt < maxObservationAttempts; attempt += 1) {
    const observation = await options.observe({
      journal: cloneSafe(journal),
      entry: cloneSafe(current),
      actionOccurrenceId,
      attempt,
      phase: 'resume_reconcile',
    });
    const proof = cloneSafe(await options.provePostcondition({
      journal: cloneSafe(journal),
      entry: cloneSafe(current),
      observation,
      actionOccurrenceId,
      attempt,
    }) || {});
    const outcome = normalizeOutcome(proof);
    journal = appendReplacement(journal, current.journalEntryId, {
      recordType: RECORD_TYPE.RECONCILIATION,
      attemptStatus: outcome ? ATTEMPT_STATUS.CANONICAL : ATTEMPT_STATUS.ATTEMPTED,
      postEvidenceRefs: [
        ...current.postEvidenceRefs,
        ...normalizeRefs(observation?.postEvidenceRefs || observation?.evidenceRefs),
      ],
      canonicalOutcome: outcome,
      urlTransition: proof.urlTransition || current.urlTransition,
      assertion: proof.assertion || current.assertion,
      failureBoundary: proof.failureBoundary || current.failureBoundary,
      reconciliation: {
        attempt,
        reason: proof.reason || 'postcondition_uncheckable',
        checked: proof.checked === true || proof.matched === true || proof.matched === false,
        matched: proof.matched === true ? true : proof.matched === false ? false : null,
        observationRef: observation?.observationRef || null,
      },
    }, options);
    await saveActionTransactionJournal(options.repository, journal);
    current = latestEntryForOccurrence(journal, actionOccurrenceId);
    if (outcome) {
      return {
        journal,
        entry: cloneSafe(current),
        outcome: cloneSafe(outcome),
        resumed: true,
        reconciled: true,
        redispatched: false,
        shouldRedispatch: false,
      };
    }
  }

  return {
    journal,
    entry: cloneSafe(current),
    outcome: null,
    resumed: true,
    reconciled: true,
    redispatched: false,
    shouldRedispatch: false,
  };
}

function countUrlTransitions(records) {
  return records.reduce((count, record) => {
    if (Array.isArray(record.urlTransition)) return count + record.urlTransition.length;
    return count + (record.urlTransition ? 1 : 0);
  }, 0);
}

function failureBoundaryFrom(records) {
  const explicit = records.find((record) => record.failureBoundary);
  if (explicit) return cloneSafe(explicit.failureBoundary);
  const failed = records.find((record) => ['failed', 'blocked'].includes(record.canonicalOutcome?.status));
  return failed ? { actionOccurrenceId: failed.actionOccurrenceId, stepId: failed.stepId || null } : null;
}

function expectedValue(expected, key) {
  if (Object.prototype.hasOwnProperty.call(expected, key)) return expected[key];
  const alias = `expected${key.charAt(0).toUpperCase()}${key.slice(1)}`;
  return Object.prototype.hasOwnProperty.call(expected, alias) ? expected[alias] : undefined;
}

function buildParitySummary(journalValue, expected = {}) {
  const records = projectCanonicalReplay(journalValue);
  const assertions = records.filter(isAssertionRecord);
  const actions = records.filter((record) => !isAssertionRecord(record));
  const ledgerIds = new Set(records.map((record) => record.ledgerLineId).filter(Boolean));
  const actual = {
    ledgerActionCount: ledgerIds.size || records.length,
    actionCount: actions.length,
    assertionCount: assertions.length,
    urlTransitionCount: countUrlTransitions(records),
    failureBoundary: failureBoundaryFrom(records),
  };
  const keys = Object.keys(actual);
  const parity = {};
  const drift = [];
  for (const key of keys) {
    const wanted = expectedValue(expected, key);
    if (wanted === undefined) {
      parity[key] = null;
      continue;
    }
    const matches = stableStringify(actual[key]) === stableStringify(cloneSafe(wanted));
    parity[key] = matches;
    if (!matches) drift.push({ dimension: key, expected: cloneSafe(wanted), actual: cloneSafe(actual[key]) });
  }
  return {
    actual,
    expected: cloneSafe(expected),
    parity,
    complete: drift.length === 0,
    drift,
  };
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  RECORD_TYPE,
  ATTEMPT_STATUS,
  DISPATCH_STATUS,
  createActionTransactionJournal,
  hydrateActionTransactionJournal,
  serializeActionTransactionJournal,
  appendJournalEntry,
  appendReplacement,
  appendDispatchMarker,
  appendRetryAttempt,
  appendAndPersist,
  saveActionTransactionJournal,
  loadActionTransactionJournal,
  latestEntryForOccurrence,
  projectCanonicalReplay,
  reconcileJournalOnResume,
  buildParitySummary,
  privacySafeValue,
};
