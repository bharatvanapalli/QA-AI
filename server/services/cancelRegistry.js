'use strict';

/**
 * Per-user cancellation registry for in-flight agent pipelines.
 *
 * Each token carries:
 *   • `cancelled`   — boolean flag checked between steps in the orchestrator
 *   • `reason`      — why cancellation was requested
 *   • `controller`  — AbortController whose `signal` is passed to the
 *                     Anthropic SDK / MCP / Playwright child process so the
 *                     in-flight HTTP request / child process is actually torn
 *                     down (not just observed and ignored).
 *
 * Without the AbortController the Claude API call kept running for its full
 * 180-second timeout even after the user clicked Terminate, so the pipeline
 * would happily produce results AFTER cancellation. With the controller, the
 * Anthropic SDK aborts the request immediately and throws an AbortError —
 * which the route layer surfaces as a graceful "cancelled" phase complete.
 */

const tokens = new Map();   // userId -> { cancelled, reason, requestedAt, controller }

function create(userId) {
  // If a stale token exists, abort its controller first so the previous run
  // tears down before the new one starts. Replacing the entry silently would
  // orphan the prior AbortController and leave a zombie Claude request alive.
  const prior = tokens.get(userId);
  if (prior?.controller && !prior.cancelled) {
    try { prior.controller.abort(); } catch (_) {}
    prior.cancelled = true;
    prior.reason = 'superseded';
  }
  const controller = new AbortController();
  const token = {
    cancelled: false,
    reason: null,
    requestedAt: null,
    controller,
    signal: controller.signal,
    // Track when the token was created so the leak-detection self-heal in
    // routes/agents.js doesn't reap a freshly-created live token before the
    // IIFE has had time to write its first AgentRun.status='running' row.
    // Run rows lag AgentRun rows by one phase (Run is created by the
    // Conductor, not the Planner) so the leak-check window has to be both
    // age-bounded AND DB-aware.
    createdAt: Date.now(),
  };
  tokens.set(userId, token);
  return token;
}

function get(userId) {
  return tokens.get(userId);
}

function cancel(userId, reason = 'user_requested') {
  const token = tokens.get(userId);
  if (!token) return false;
  if (token.cancelled) return false;
  token.cancelled = true;
  token.reason = reason;
  token.requestedAt = new Date();
  // Abort the in-flight HTTP request / child process. The Anthropic SDK
  // checks `signal.aborted` and rejects the pending request with an
  // AbortError, which lets routes return promptly instead of waiting for
  // the 180-second LLM timeout.
  try { token.controller?.abort(); } catch (_) {}
  return true;
}

function clear(userId) {
  const token = tokens.get(userId);
  // Be defensive: even though the consumer should have settled by the time
  // they call clear(), don't leave a dangling controller subscribed.
  if (token?.controller && !token.cancelled) {
    try { token.controller.abort(); } catch (_) {}
  }
  tokens.delete(userId);
}

/** True if the error came from our AbortController firing. */
function isAbortError(err) {
  if (!err) return false;
  return (
    err.name === 'AbortError' ||
    err.code === 'ABORT_ERR' ||
    /aborted|cancel/i.test(err.message || '')
  );
}

module.exports = { create, get, cancel, clear, tokens, isAbortError };
