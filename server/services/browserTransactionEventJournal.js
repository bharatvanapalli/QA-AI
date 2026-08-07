'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  assertControllerAuthority,
} = require('./browserTransactionAuthority');

const JOURNAL_VERSION = 'qaai-browser-transaction-event-journal-v1';
const GENESIS_HASH = '0'.repeat(64);
const SENSITIVE_KEY_RE = /^(?:password|passwd|pwd|secret|token|apiKey|api_key|authorization|cookie|credential|privateKey|private_key|accessKey|access_key|refreshToken|refresh_token|value|text|args)$/i;
const SENSITIVE_TEXT_RE = /\b(password|passwd|pwd|secret|token|api[_ -]?key|authorization|cookie|credential)\s*([:=])\s*(?:"[^"]*"|'[^']*'|\S+)/gi;

class BrowserTransactionEventJournalError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserTransactionEventJournalError';
    this.code = code;
    Object.assign(this, details);
  }
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function hash(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function privacySafe(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => privacySafe(item, seen));
  if (typeof value === 'string') {
    return value.replace(SENSITIVE_TEXT_RE, (_match, key, separator) => `${key}${separator}[REDACTED]`);
  }
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_RE.test(key) && item != null
      ? '[REDACTED]'
      : privacySafe(item, seen);
  }
  return output;
}

function eventPayload(rawEvent, sequence, previousHash, now) {
  const safe = privacySafe(rawEvent || {});
  const base = {
    ...safe,
    journalVersion: JOURNAL_VERSION,
    journalSequence: sequence,
    previousHash,
    recordedAt: new Date(Number(now())).toISOString(),
  };
  delete base.eventHash;
  return Object.freeze({
    ...base,
    eventHash: hash(base),
  });
}

function verifyJournalIntegrity(events) {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const expectedSequence = index + 1;
    const payload = { ...event };
    const recordedHash = payload.eventHash;
    delete payload.eventHash;
    if (event.journalVersion !== JOURNAL_VERSION
      || event.journalSequence !== expectedSequence
      || event.previousHash !== previousHash
      || recordedHash !== hash(payload)) {
      return Object.freeze({
        valid: false,
        index,
        expectedSequence,
        actualSequence: event.journalSequence,
        reason: 'journal_hash_chain_invalid',
      });
    }
    previousHash = recordedHash;
  }
  return Object.freeze({
    valid: true,
    eventCount: events.length,
    headHash: previousHash,
  });
}

function createMemoryStore(initialEvents = []) {
  const persisted = initialEvents.map((event) => Object.freeze({ ...event }));
  return Object.freeze({
    load: async () => persisted.slice(),
    append: async (event) => {
      persisted.push(Object.freeze({ ...event }));
      return { persisted: true };
    },
    snapshot: () => persisted.slice(),
  });
}

function createJsonlStore(filePath) {
  const absolutePath = path.resolve(String(filePath || ''));
  return Object.freeze({
    load: async () => {
      let source;
      try {
        source = await fs.readFile(absolutePath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new BrowserTransactionEventJournalError(
            'Append-only journal contains invalid JSON.',
            'BROWSER_TRANSACTION_JOURNAL_JSON_INVALID',
            { filePath: absolutePath, line: index + 1 },
          );
        }
      });
    },
    append: async (event) => {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.appendFile(absolutePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
      return { persisted: true };
    },
    filePath: absolutePath,
  });
}

function createBrowserTransactionEventJournal({
  store = createMemoryStore(),
  now = Date.now,
} = {}) {
  if (!store || typeof store.load !== 'function' || typeof store.append !== 'function') {
    throw new TypeError('BrowserTransactionEventJournal requires an append-only store.');
  }

  let loaded = false;
  let events = [];
  let queue = Promise.resolve();

  const ensureLoaded = async () => {
    if (loaded) return;
    events = await store.load();
    const integrity = verifyJournalIntegrity(events);
    if (!integrity.valid) {
      throw new BrowserTransactionEventJournalError(
        'Append-only journal integrity check failed.',
        'BROWSER_TRANSACTION_JOURNAL_INTEGRITY_FAILED',
        integrity,
      );
    }
    loaded = true;
  };

  const appendQueued = (rawEvent) => {
    const work = queue.then(async () => {
      await ensureLoaded();
      const previousHash = events.length ? events[events.length - 1].eventHash : GENESIS_HASH;
      const record = eventPayload(rawEvent, events.length + 1, previousHash, now);
      const persisted = await store.append(record);
      if (persisted?.persisted === false) {
        throw new BrowserTransactionEventJournalError(
          'Append-only journal persistence was refused.',
          'BROWSER_TRANSACTION_JOURNAL_PERSISTENCE_REQUIRED',
          { eventType: clean(record.eventType) || null },
        );
      }
      events.push(record);
      return record;
    });
    queue = work.catch(() => {});
    return work;
  };

  const readAll = async () => {
    await queue;
    await ensureLoaded();
    return events.slice();
  };

  const appendDispatchEvent = async (event = {}) => appendQueued({
    ...event,
    writer: 'ActionExecutionGateway',
    recordKind: 'dispatch_fact',
  }).then((record) => ({ persisted: true, record }));

  const appendControllerEvent = async ({
    authority,
    capability,
    event = {},
  } = {}) => {
    const authorization = assertControllerAuthority(authority, capability);
    return appendQueued({
      ...event,
      writer: authorization.owner,
      controllerCapability: authorization.capability,
      recordKind: 'controller_decision',
    }).then((record) => ({ persisted: true, record }));
  };

  const appendObservation = async (observation = {}) => {
    if (observation?.kind !== 'observation' || !observation?.role) {
      throw new BrowserTransactionEventJournalError(
        'Observation journal entries require a typed observation envelope.',
        'BROWSER_TRANSACTION_OBSERVATION_ENVELOPE_REQUIRED',
      );
    }
    return appendQueued({
      ...observation,
      writer: observation.role,
      recordKind: 'observation_fact',
    }).then((record) => ({ persisted: true, record }));
  };

  const appendProposal = async (proposal = {}) => {
    if (proposal?.kind !== 'proposal'
      || proposal?.mayMutateBrowser !== false
      || proposal?.mayChangeVerdict !== false
      || proposal?.mayStopExecution !== false) {
      throw new BrowserTransactionEventJournalError(
        'Recovery proposals must be typed and proposal-only.',
        'BROWSER_TRANSACTION_PROPOSAL_ENVELOPE_REQUIRED',
      );
    }
    return appendQueued({
      ...proposal,
      writer: proposal.role,
      recordKind: 'recovery_proposal',
    }).then((record) => ({ persisted: true, record }));
  };

  const eventsForOccurrence = async (occurrenceKey) => (
    (await readAll()).filter((event) => event.occurrenceKey === occurrenceKey)
  );
  const eventsForOperation = async (operationId) => (
    (await readAll()).filter((event) => event.operationId === operationId)
  );

  return Object.freeze({
    journalVersion: JOURNAL_VERSION,
    appendDispatchEvent,
    appendControllerEvent,
    appendObservation,
    appendProposal,
    eventsForOccurrence,
    eventsForOperation,
    readAll,
    verifyIntegrity: async () => verifyJournalIntegrity(await readAll()),
  });
}

function createFileBrowserTransactionEventJournal({
  rootDir,
  journalId,
  now = Date.now,
} = {}) {
  const root = path.resolve(String(rootDir || ''));
  const id = clean(journalId);
  if (!rootDir || !id) {
    throw new TypeError('File journal requires explicit rootDir and journalId.');
  }
  const fileName = `${hash(id).slice(0, 32)}.jsonl`;
  return createBrowserTransactionEventJournal({
    store: createJsonlStore(path.join(root, fileName)),
    now,
  });
}

module.exports = {
  JOURNAL_VERSION,
  GENESIS_HASH,
  BrowserTransactionEventJournalError,
  stableStringify,
  hash,
  privacySafe,
  verifyJournalIntegrity,
  createMemoryStore,
  createJsonlStore,
  createBrowserTransactionEventJournal,
  createFileBrowserTransactionEventJournal,
};
