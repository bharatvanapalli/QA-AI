'use strict';

const {
  SNAPSHOT_SOURCE,
  normalizeSources,
} = require('./browserSnapshotLifecycle');

const EVIDENCE_READER_VERSION = 'qaai-controller-evidence-reader-v1';

const SOURCE_STATUS = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
  SESSION_LOST: 'SESSION_LOST',
});

class ControllerEvidenceReaderError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerEvidenceReaderError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function normalizeResult(source, value, durationMs) {
  const result = value && typeof value === 'object' ? value : {};
  const sessionLost = result.sessionLost === true || result.browserAlive === false;
  const unavailable = result.unavailable === true || result.captureFailed === true;
  return Object.freeze({
    source,
    status: sessionLost
      ? SOURCE_STATUS.SESSION_LOST
      : unavailable
        ? SOURCE_STATUS.UNAVAILABLE
        : SOURCE_STATUS.AVAILABLE,
    durationMs,
    facts: Object.freeze({ ...(result.facts || {}) }),
    claims: Object.freeze(Array.isArray(result.claims) ? result.claims.slice() : []),
    candidates: Object.freeze(Array.isArray(result.candidates) ? result.candidates.slice() : []),
    factRefs: Object.freeze([
      ...new Set(
        (Array.isArray(result.factRefs) ? result.factRefs : result.factRef ? [result.factRef] : [])
          .map(clean)
          .filter(Boolean),
      ),
    ]),
    reason: clean(result.reason) || (
      sessionLost ? 'browser_session_lost'
        : unavailable ? 'evidence_source_unavailable'
          : 'evidence_source_available'
    ),
  });
}

function createControllerEvidenceReader({
  readers = {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  perSourceDeadlineMs = 1_000,
  heartbeat = () => {},
} = {}) {
  const registry = new Map(
    Object.entries(readers || {}).map(([source, reader]) => [clean(source).toUpperCase(), reader]),
  );

  const readBounded = async (source, input, remainingMs) => {
    const reader = registry.get(source);
    const startedAt = Number(now());
    if (typeof reader !== 'function') {
      return normalizeResult(source, {
        unavailable: true,
        reason: 'evidence_reader_not_registered',
      }, 0);
    }
    const budgetMs = Math.max(1, Math.min(
      remainingMs,
      boundedInteger(perSourceDeadlineMs, 1_000, 1, 10_000),
    ));
    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => reader({ ...input, source, remainingMs: budgetMs })),
        new Promise((_, reject) => {
          timer = setTimer(() => reject(new ControllerEvidenceReaderError(
            'Evidence source exceeded its bounded capture deadline.',
            'CONTROLLER_EVIDENCE_SOURCE_DEADLINE',
            { source, budgetMs },
          )), budgetMs);
        }),
      ]);
      return normalizeResult(source, result, Math.max(0, Number(now()) - startedAt));
    } catch (error) {
      return normalizeResult(source, {
        unavailable: true,
        reason: clean(error?.code || error?.name) || 'evidence_reader_error',
      }, Math.max(0, Number(now()) - startedAt));
    } finally {
      if (timer != null) clearTimer(timer);
    }
  };

  const capture = async ({
    requiredSources,
    remainingMs,
    operation,
    resolution,
    phase,
    attempt,
    snapshot,
  } = {}) => {
    const sources = normalizeSources(requiredSources);
    if (!sources.length) {
      throw new ControllerEvidenceReaderError(
        'Evidence capture requires at least one explicit source.',
        'CONTROLLER_EVIDENCE_SOURCES_REQUIRED',
      );
    }
    const totalBudgetMs = boundedInteger(remainingMs, 1_000, 1, 60_000);
    const startedAt = Number(now());

    // Start every independent reader before awaiting any of them.
    const observations = await Promise.all(sources.map((source) => readBounded(source, {
      operation,
      resolution,
      phase,
      attempt,
      snapshot,
    }, totalBudgetMs)));

    const sessionLost = observations.some((observation) => (
      observation.status === SOURCE_STATUS.SESSION_LOST
    ));
    const claims = Object.freeze(observations.flatMap((observation) => observation.claims));
    const candidates = Object.freeze(observations.flatMap((observation) => observation.candidates));
    const factRefs = Object.freeze([
      ...new Set(observations.flatMap((observation) => observation.factRefs)),
    ]);
    const durationMs = Math.max(0, Number(now()) - startedAt);
    heartbeat({
      evidenceReaderVersion: EVIDENCE_READER_VERSION,
      operationId: operation?.operationId || null,
      phase: phase || null,
      sourceCount: sources.length,
      availableCount: observations.filter((observation) => observation.status === SOURCE_STATUS.AVAILABLE).length,
      unavailableCount: observations.filter((observation) => observation.status === SOURCE_STATUS.UNAVAILABLE).length,
      sessionLost,
      durationMs,
    });
    return Object.freeze({
      schemaVersion: EVIDENCE_READER_VERSION,
      sources,
      observations: Object.freeze(observations),
      claims,
      candidates,
      factRefs,
      sessionLost,
      durationMs,
      unavailableSources: Object.freeze(
        observations
          .filter((observation) => observation.status === SOURCE_STATUS.UNAVAILABLE)
          .map((observation) => observation.source),
      ),
    });
  };

  return Object.freeze({
    capture,
    registeredSources: () => Object.freeze([...registry.keys()]),
  });
}

module.exports = {
  EVIDENCE_READER_VERSION,
  SOURCE_STATUS,
  ControllerEvidenceReaderError,
  normalizeResult,
  createControllerEvidenceReader,
  SNAPSHOT_SOURCE,
};
