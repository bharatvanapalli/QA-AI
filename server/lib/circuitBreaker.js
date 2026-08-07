'use strict';

/**
 * Per-provider circuit breaker for LLM upstreams.
 *
 * Wraps every `provider.complete()` call so a sustained outage on
 * Anthropic or Google doesn't leave every in-flight QAAI run hanging on
 * 30-second retries. After N consecutive failures the breaker opens —
 * subsequent calls fail-fast with BREAKER_OPEN, and the conductor's
 * existing error path surfaces "BLOCKED: upstream unavailable" cleanly.
 *
 * Failure classification (per-call):
 *   COUNTS toward trips:
 *     - HTTP 5xx (server error) — provider misbehaving
 *     - HTTP 503 (overloaded)   — explicit upstream pressure
 *     - Network errors with no status code (DNS, connection refused, …)
 *   DOES NOT count:
 *     - HTTP 429 (RATE_LIMIT)   — provider is fine, just back off
 *     - HTTP 4xx (BAD_REQUEST)  — caller's fault, not upstream
 *     - CANCELLED (status 499)  — user action, not failure
 *     - GEMINI_INVALID_KEY      — config issue, not upstream
 *
 * State machine:
 *   closed     — normal; success resets, failure increments streak
 *   open       — fail-fast for `coolDownMs`, then promote to half_open
 *   half_open  — exactly ONE call allowed through; success → closed,
 *                failure → open with exponentially-longer cool-down
 *                (capped at MAX_COOLDOWN_MS)
 *
 * Failure streak semantics (CORRECTED): the streak counts CONSECUTIVE upstream
 * failures with no intervening SUCCESS — it is reset by a success, NOT by
 * elapsed time. The previous time-window reset (failures had to cluster within
 * 60s) was fundamentally broken for this workload: a single LLM generation call
 * legitimately takes 360–600s, so two real timeout failures are ALWAYS spaced
 * further apart than the 60s window. The streak was therefore reset to 0 before
 * the second failure could extend it, and the breaker NEVER tripped during a
 * genuine sustained outage — exactly when it is needed most. Because only one
 * call per provider is typically in flight at a time, "consecutive failures
 * with no success between" is the correct, latency-independent trip condition.
 *
 * Additionally, pure NETWORK failures (status == null: DNS / connection refused
 * / socket reset) FAST-TRIP after 2 in a row — these are unambiguous upstream-
 * unreachable signals and don't warrant waiting for the full threshold. The
 * 429 / 4xx / CANCELLED / config exclusions are unchanged (see isUpstreamFailure).
 */

const FAILURE_THRESHOLD = 5;
const NETWORK_FAST_TRIP = 2;       // 2 consecutive status==null network errors → trip
const INITIAL_COOLDOWN_MS = 30_000; // 30s after first trip
const MAX_COOLDOWN_MS = 5 * 60_000; // 5min ceiling
const COOLDOWN_BACKOFF = 1.5;       // 30 → 45 → 67 → 101 → 152 → 228 → 300 cap

// Per-provider state. Lazily seeded so unknown providers (tests, future)
// just create their own row.
const state = new Map();

function init(provider) {
  return {
    status: 'closed',     // 'closed' | 'open' | 'half_open'
    failureCount: 0,        // consecutive upstream failures (reset by SUCCESS, not time)
    networkFailureCount: 0, // consecutive status==null network failures (fast-trip)
    lastFailureAt: 0,
    openedAt: 0,
    coolDownMs: INITIAL_COOLDOWN_MS,
    lastError: null,      // short string surfaced to the UI
    halfOpenInFlight: false,
  };
}

function get(provider) {
  let s = state.get(provider);
  if (!s) {
    s = init(provider);
    state.set(provider, s);
  }
  return s;
}

/**
 * Promote `open → half_open` once the cool-down has elapsed. Idempotent;
 * safe to call on every check.
 */
function maybePromoteToHalfOpen(s) {
  if (s.status !== 'open') return;
  if (Date.now() - s.openedAt >= s.coolDownMs) {
    s.status = 'half_open';
    s.halfOpenInFlight = false;
  }
}

/**
 * Errors we count as upstream-misbehaviour. See module-level docs.
 */
function isUpstreamFailure(err) {
  if (!err) return false;
  const status = err.status;
  const code = err.code;
  if (code === 'CANCELLED' || status === 499) return false;
  if (code === 'GEMINI_INVALID_KEY' || code === 'NO_API_KEY') return false;
  if (status === 429) return false;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  // 5xx, missing status (network), or 503 — all upstream issues.
  if (typeof status === 'number' && status >= 500) return true;
  if (status == null) return true; // network / DNS / abort-without-status
  return false;
}

/**
 * Check whether a call is allowed through right now. Throws BREAKER_OPEN
 * when the breaker is open; in half_open, allows exactly one probe.
 *
 *   try { breaker.check('claude'); } catch (e) { handleBreakerOpen(e); }
 *
 * Returns a probe token when in half_open (truthy), or undefined when
 * closed. Caller passes that token back to recordSuccess/recordFailure
 * so we know whether to release the half_open slot. (Closed state needs
 * no token.)
 */
function check(provider) {
  const s = get(provider);
  maybePromoteToHalfOpen(s);

  if (s.status === 'open') {
    const remaining = Math.max(0, s.coolDownMs - (Date.now() - s.openedAt));
    const err = new Error(
      `${provider} upstream is in cool-down (${Math.ceil(remaining / 1000)}s remaining). ` +
      `Last failure: ${s.lastError || 'unknown'}.`
    );
    err.code = 'BREAKER_OPEN';
    err.status = 503;
    err.retryAfter = Math.ceil(remaining / 1000);
    throw err;
  }

  if (s.status === 'half_open') {
    if (s.halfOpenInFlight) {
      // Another probe is already running. Fail fast — don't pile on.
      const err = new Error(`${provider} upstream is probing recovery; try again shortly.`);
      err.code = 'BREAKER_OPEN';
      err.status = 503;
      err.retryAfter = 5;
      throw err;
    }
    s.halfOpenInFlight = true;
    return { probe: true };
  }

  return undefined;
}

function recordSuccess(provider, token) {
  const s = get(provider);
  // Success is what resets the streak — NOT elapsed time. This is the core of
  // the window fix: as long as no success lands between failures, the streak
  // grows regardless of how far apart (slow) the failing calls are spaced.
  s.failureCount = 0;
  s.networkFailureCount = 0;
  s.lastFailureAt = 0;
  s.lastError = null;
  if (s.status === 'half_open' || s.status === 'open') {
    s.status = 'closed';
    s.openedAt = 0;
    s.coolDownMs = INITIAL_COOLDOWN_MS;
  }
  if (token?.probe) s.halfOpenInFlight = false;
}

function recordFailure(provider, err, token) {
  const s = get(provider);

  // Non-upstream errors don't move the breaker but still release the
  // probe slot so a recovery probe isn't permanently held by a CANCELLED.
  // They also DON'T reset the streak: a 429 between two 5xx timeouts is not a
  // success and shouldn't paper over a real outage.
  if (!isUpstreamFailure(err)) {
    if (token?.probe) s.halfOpenInFlight = false;
    return;
  }

  const now = Date.now();
  // Streak is reset ONLY by recordSuccess (see module docs) — never by elapsed
  // time. Consecutive upstream failures with no success between them extend it,
  // however far apart the slow calls land.
  s.failureCount += 1;
  s.lastFailureAt = now;
  s.lastError = String(err.message || err).slice(0, 200);

  // Pure network failures (no HTTP status: DNS / refused / reset) get their own
  // consecutive counter for a faster trip — these are unambiguous "upstream
  // unreachable" signals. Any failure that DID carry a status breaks the
  // network streak (it reached the server) but still counts toward failureCount.
  if (err && err.status == null) s.networkFailureCount += 1;
  else s.networkFailureCount = 0;

  if (s.status === 'half_open') {
    // Probe failed → re-open with longer cool-down.
    s.status = 'open';
    s.openedAt = now;
    s.coolDownMs = Math.min(Math.round(s.coolDownMs * COOLDOWN_BACKOFF), MAX_COOLDOWN_MS);
    s.halfOpenInFlight = false;
    return;
  }

  if (s.failureCount >= FAILURE_THRESHOLD || s.networkFailureCount >= NETWORK_FAST_TRIP) {
    s.status = 'open';
    s.openedAt = now;
    s.coolDownMs = INITIAL_COOLDOWN_MS;
  }
}

/**
 * Read-only snapshot for /api/health and admin UIs.
 */
function getState(provider) {
  const s = get(provider);
  maybePromoteToHalfOpen(s);
  return {
    provider,
    status: s.status,
    failureCount: s.failureCount,
    lastError: s.lastError,
    coolDownMs: s.status === 'open' ? Math.max(0, s.coolDownMs - (Date.now() - s.openedAt)) : 0,
  };
}

function getAllStates() {
  return Array.from(state.keys()).map(getState);
}

// Test hook only — not used in production paths.
function _reset(provider) {
  if (provider) state.delete(provider);
  else state.clear();
}

module.exports = {
  check,
  recordSuccess,
  recordFailure,
  getState,
  getAllStates,
  isUpstreamFailure,
  _reset,
  // Exported for tests / introspection.
  FAILURE_THRESHOLD,
  INITIAL_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
};
