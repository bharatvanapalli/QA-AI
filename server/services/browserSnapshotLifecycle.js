'use strict';

const crypto = require('node:crypto');

const SNAPSHOT_VERSION = 'qaai-browser-snapshot-lifecycle-v1';

const SNAPSHOT_STATUS = Object.freeze({
  VALID: 'VALID',
  TRANSIENT_EMPTY: 'TRANSIENT_EMPTY',
  STALE: 'STALE',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  SESSION_LOST: 'SESSION_LOST',
});

const SNAPSHOT_SOURCE = Object.freeze({
  BROWSER_SNAPSHOT: 'BROWSER_SNAPSHOT',
  PLAYWRIGHT: 'PLAYWRIGHT',
  DOM: 'DOM',
  ACCESSIBILITY: 'ACCESSIBILITY',
  CDP: 'CDP',
  EVENT: 'EVENT',
  SCREENSHOT: 'SCREENSHOT',
});

const SOURCE_VALUES = new Set(Object.values(SNAPSHOT_SOURCE));

class BrowserSnapshotLifecycleError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserSnapshotLifecycleError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeSources(values) {
  const sources = [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value).toUpperCase()).filter(Boolean))];
  const unknown = sources.filter((source) => !SOURCE_VALUES.has(source));
  if (unknown.length) {
    throw new BrowserSnapshotLifecycleError(
      'Snapshot request contains unknown evidence sources.',
      'BROWSER_SNAPSHOT_SOURCE_INVALID',
      { unknownSources: unknown },
    );
  }
  return Object.freeze(sources);
}

function factRefsOf(snapshot = {}) {
  return Object.freeze([
    ...new Set(
      (Array.isArray(snapshot.factRefs) ? snapshot.factRefs : snapshot.factRef ? [snapshot.factRef] : [])
        .map(clean)
        .filter(Boolean),
    ),
  ]);
}

function isTransientEmpty(snapshot = {}) {
  if (snapshot.transientEmpty === true || snapshot.whitePage === true) return true;
  const snapshotText = clean(snapshot.snapshotText || snapshot.text);
  const domNodeCount = Number(snapshot.domNodeCount ?? snapshot.dom?.nodeCount ?? 0);
  const axNodeCount = Number(snapshot.axNodeCount ?? snapshot.accessibility?.nodeCount ?? 0);
  const screenshotWhite = snapshot.screenshot?.uniformWhite === true
    || snapshot.screenshotUniformWhite === true;
  const hasUrlOrTitle = Boolean(clean(snapshot.url) || clean(snapshot.title));
  return !snapshotText
    && domNodeCount <= 0
    && axNodeCount <= 0
    && (screenshotWhite || !hasUrlOrTitle);
}

function classifySnapshot(snapshot = {}, {
  browserEpoch,
  requiredSources = [],
  minimumCandidateCount = 0,
  nowMs = Date.now(),
  maxAgeMs = 1_500,
} = {}) {
  const requestedSources = normalizeSources(requiredSources);
  const providedSources = normalizeSources(snapshot.sources || snapshot.providedSources || []);
  const capturedAtMs = Number(snapshot.capturedAtMs ?? snapshot.capturedAt ?? nowMs);
  const snapshotEpoch = clean(snapshot.browserEpoch);
  const expectedEpoch = clean(browserEpoch);
  const candidateCount = Math.max(
    Number(snapshot.domNodeCount ?? snapshot.dom?.nodeCount ?? 0),
    Number(snapshot.axNodeCount ?? snapshot.accessibility?.nodeCount ?? 0),
  );
  const base = {
    schemaVersion: SNAPSHOT_VERSION,
    snapshotId: clean(snapshot.snapshotId) || `snapshot:${crypto.randomUUID()}`,
    browserEpoch: snapshotEpoch || expectedEpoch || null,
    capturedAtMs,
    sources: providedSources,
    factRefs: factRefsOf(snapshot),
    snapshot,
  };

  if (snapshot.sessionLost === true || snapshot.browserAlive === false) {
    return Object.freeze({ ...base, status: SNAPSHOT_STATUS.SESSION_LOST, reason: 'browser_session_lost' });
  }
  if (snapshot.captureError || snapshot.failed === true) {
    return Object.freeze({
      ...base,
      status: SNAPSHOT_STATUS.CAPTURE_FAILED,
      reason: clean(snapshot.captureError?.code || snapshot.captureError?.name || snapshot.reason)
        || 'snapshot_capture_failed',
    });
  }
  if ((expectedEpoch && snapshotEpoch && expectedEpoch !== snapshotEpoch)
    || nowMs - capturedAtMs > Math.max(0, Number(maxAgeMs) || 0)
    || snapshot.stale === true) {
    return Object.freeze({ ...base, status: SNAPSHOT_STATUS.STALE, reason: 'snapshot_epoch_or_age_stale' });
  }
  if (isTransientEmpty(snapshot)) {
    return Object.freeze({ ...base, status: SNAPSHOT_STATUS.TRANSIENT_EMPTY, reason: 'snapshot_temporarily_empty' });
  }
  if (candidateCount < Math.max(0, Number(minimumCandidateCount) || 0)) {
    return Object.freeze({
      ...base,
      status: SNAPSHOT_STATUS.TRANSIENT_EMPTY,
      reason: 'snapshot_interaction_tree_empty',
    });
  }
  const missingSources = requestedSources.filter((source) => !providedSources.includes(source));
  if (missingSources.length) {
    return Object.freeze({
      ...base,
      status: SNAPSHOT_STATUS.CAPTURE_FAILED,
      reason: 'required_snapshot_sources_missing',
      missingSources: Object.freeze(missingSources),
    });
  }
  return Object.freeze({ ...base, status: SNAPSHOT_STATUS.VALID, reason: 'snapshot_valid' });
}

function createBrowserSnapshotLifecycle({
  capture,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxAgeMs = 1_500,
  defaultAttempts = 2,
  retryIntervalMs = 50,
  heartbeat = () => {},
} = {}) {
  if (typeof capture !== 'function') {
    throw new TypeError('BrowserSnapshotLifecycle requires capture().');
  }
  let cache = null;

  const cacheMatches = ({ browserEpoch, requiredSources, minimumCandidateCount, nowMs }) => (
    cache?.status === SNAPSHOT_STATUS.VALID
    && clean(cache.browserEpoch) === clean(browserEpoch)
    && nowMs - cache.capturedAtMs <= Math.max(0, Number(maxAgeMs) || 0)
    && requiredSources.every((source) => cache.sources.includes(source))
    && Math.max(
      Number(cache.snapshot?.domNodeCount ?? cache.snapshot?.dom?.nodeCount ?? 0),
      Number(cache.snapshot?.axNodeCount ?? cache.snapshot?.accessibility?.nodeCount ?? 0),
    ) >= Math.max(0, Number(minimumCandidateCount) || 0)
  );

  const callBounded = async (work, remainingMs) => {
    const boundedMs = Math.max(1, Math.trunc(remainingMs));
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise((_, reject) => {
          timer = setTimer(() => reject(new BrowserSnapshotLifecycleError(
            'Snapshot capture exceeded the remaining observation deadline.',
            'BROWSER_SNAPSHOT_CAPTURE_DEADLINE',
            { remainingMs: boundedMs },
          )), boundedMs);
        }),
      ]);
    } finally {
      if (timer != null) clearTimer(timer);
    }
  };

  const acquire = async ({
    browserEpoch,
    requiredSources = [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT],
    minimumCandidateCount = 0,
    forceFresh = false,
    deadlineAtMs = Number(now()) + 1_000,
    maxAttempts = defaultAttempts,
    reason = 'operation_observation',
  } = {}) => {
    const sources = normalizeSources(requiredSources);
    const currentMs = Number(now());
    if (!forceFresh && cacheMatches({
      browserEpoch,
      requiredSources: sources,
      minimumCandidateCount,
      nowMs: currentMs,
    })) {
      heartbeat({
        snapshotStatus: SNAPSHOT_STATUS.VALID,
        cacheHit: true,
        browserEpoch,
        reason,
      });
      return Object.freeze({ ...cache, cacheHit: true, attempts: 0 });
    }

    const attempts = Math.max(1, Math.min(5, Math.trunc(Number(maxAttempts) || defaultAttempts)));
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const remainingMs = Number(deadlineAtMs) - Number(now());
      if (remainingMs <= 0) break;
      let captured;
      try {
        captured = await callBounded(
          () => capture({
            browserEpoch,
            requiredSources: sources,
            remainingMs,
            attempt,
            reason,
          }),
          remainingMs,
        );
      } catch (error) {
        captured = { captureError: error, browserEpoch, sources: [] };
      }
      last = classifySnapshot(captured || {}, {
        browserEpoch,
        requiredSources: sources,
        minimumCandidateCount,
        nowMs: Number(now()),
        maxAgeMs,
      });
      heartbeat({
        snapshotStatus: last.status,
        cacheHit: false,
        browserEpoch,
        attempt,
        reason: last.reason,
      });
      if (last.status === SNAPSHOT_STATUS.VALID) {
        cache = last;
        return Object.freeze({ ...last, cacheHit: false, attempts: attempt });
      }
      if (last.status === SNAPSHOT_STATUS.SESSION_LOST) {
        return Object.freeze({ ...last, cacheHit: false, attempts: attempt });
      }
      const nextRemainingMs = Number(deadlineAtMs) - Number(now());
      if (attempt < attempts && nextRemainingMs > 0) {
        await sleep(Math.min(Math.max(0, Number(retryIntervalMs) || 0), nextRemainingMs));
      }
    }
    return Object.freeze({
      ...(last || {
        schemaVersion: SNAPSHOT_VERSION,
        snapshotId: null,
        browserEpoch: clean(browserEpoch) || null,
        capturedAtMs: Number(now()),
        sources,
        factRefs: Object.freeze([]),
        snapshot: null,
        status: SNAPSHOT_STATUS.CAPTURE_FAILED,
        reason: 'snapshot_deadline_reached_before_capture',
      }),
      cacheHit: false,
      attempts: last ? attempts : 0,
    });
  };

  const invalidate = ({ browserEpoch = null, reason = 'browser_state_changed' } = {}) => {
    const previous = cache;
    cache = null;
    return Object.freeze({
      invalidated: Boolean(previous),
      previousSnapshotId: previous?.snapshotId || null,
      browserEpoch: clean(browserEpoch) || null,
      reason,
    });
  };

  return Object.freeze({
    acquire,
    invalidate,
    peek: () => cache,
  });
}

module.exports = {
  SNAPSHOT_VERSION,
  SNAPSHOT_STATUS,
  SNAPSHOT_SOURCE,
  BrowserSnapshotLifecycleError,
  normalizeSources,
  isTransientEmpty,
  classifySnapshot,
  createBrowserSnapshotLifecycle,
};
