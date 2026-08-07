'use strict';

/**
 * In-memory registry of paused conductor runs waiting for human input.
 *
 * The Conductor calls `awaitInput(...)` which returns a Promise that
 * resolves when the user sends an `agent.inputProvided` WS message or
 * rejects when the timeout fires or the user cancels the run.
 *
 * Key shape: `${runId}|${tcId}|${stepIndex}`. Only ONE pause can be
 * in-flight per case-step at a time — re-issuing for the same key
 * resolves the prior pause with `{ action: 'superseded' }` so the
 * conductor can recover deterministically.
 *
 * The registry is in-memory by design: pauses are tightly coupled to a
 * live conductor process, and surviving a server restart isn't useful
 * (the browser session would be dead anyway). On server restart all
 * pauses are abandoned and their owning runs get reaped by the
 * stale-run reaper in server/index.js.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Map<string, { resolve, reject, timeout, payload }>
const pending = new Map();

function keyOf({ runId, tcId, stepIndex }) {
  return `${runId}|${tcId}|${stepIndex}`;
}

/**
 * Begin a human-input pause. Returns a Promise resolving to a result of
 * shape `{ action, value? }`:
 *   - { action: 'continue', value }  — user provided input
 *   - { action: 'skip' }              — user chose to skip the step
 *   - { action: 'block', reason }     — user aborted the case
 *   - { action: 'timeout' }           — auto-resolution after timeoutMs
 *   - { action: 'cancelled' }         — owning run was cancelled
 *   - { action: 'superseded' }        — same key was re-issued (shouldn't happen normally)
 *
 * The promise NEVER throws; the caller can branch deterministically on
 * `action`. This keeps the conductor loop straightforward.
 */
function awaitInput({ runId, projectId = null, tcId, tcName = null, stepIndex, prompt, inputType = 'text', options = null, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null }) {
  const key = keyOf({ runId, tcId, stepIndex });
  // Supersede any prior pause for the same key — defensive; not expected.
  const prior = pending.get(key);
  if (prior) {
    clearTimeout(prior.timeout);
    pending.delete(key);
    prior.resolve({ action: 'superseded' });
  }

  return new Promise((resolve) => {
    // Already-cancelled? Resolve immediately so the conductor doesn't even
    // broadcast the pause.
    if (signal?.aborted) {
      resolve({ action: 'cancelled' });
      return;
    }
    const timeoutHandle = setTimeout(() => {
      const entry = pending.get(key);
      if (!entry) return;
      pending.delete(key);
      resolve({ action: 'timeout' });
    }, timeoutMs);

    // If a cancel signal is provided, hook into it so user-cancellation
    // propagates instantly instead of waiting for the 5-minute timeout.
    const onAbort = () => {
      const entry = pending.get(key);
      if (!entry) return;
      clearTimeout(entry.timeout);
      pending.delete(key);
      resolve({ action: 'cancelled' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    pending.set(key, {
      resolve,
      timeout: timeoutHandle,
      cleanup: () => { if (signal) signal.removeEventListener('abort', onAbort); },
      payload: { runId, projectId, tcId, tcName, stepIndex, prompt, inputType, options, deadline: Date.now() + timeoutMs },
    });
  });
}

/**
 * Resolve a pending pause with the user's input. Returns true if a
 * matching pause was found and resolved, false otherwise. The conductor's
 * awaitInput Promise continues with the supplied `result` payload.
 */
function provideInput({ runId, tcId, stepIndex, action, value, reason }) {
  const key = keyOf({ runId, tcId, stepIndex });
  const entry = pending.get(key);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  if (entry.cleanup) entry.cleanup();
  pending.delete(key);
  // Sanitise — only the action verbs we recognise.
  const safeAction = ['continue', 'skip', 'block'].includes(action) ? action : 'continue';
  entry.resolve({
    action: safeAction,
    value: safeAction === 'continue' ? (typeof value === 'string' ? value : null) : null,
    reason: safeAction === 'block' ? (typeof reason === 'string' ? reason.slice(0, 240) : null) : null,
  });
  return true;
}

/**
 * Cancel every pending pause for a given run id. Called from the run
 * cancellation path so a CANCEL while the case is awaiting input frees
 * the conductor's await deterministically (otherwise the conductor's
 * loop hangs until the 5-minute timeout).
 */
function cancelRun(runId) {
  let count = 0;
  for (const [key, entry] of pending.entries()) {
    if (!key.startsWith(`${runId}|`)) continue;
    clearTimeout(entry.timeout);
    if (entry.cleanup) entry.cleanup();
    pending.delete(key);
    entry.resolve({ action: 'cancelled' });
    count += 1;
  }
  return count;
}

/**
 * Return the list of pending pauses (payload only) so the UI can
 * reconnect after a page navigation / refresh and re-render the modal.
 * Filtered to the calling user's run if needed by the caller.
 */
function listPending() {
  return [...pending.values()].map((e) => e.payload);
}

/**
 * Return a single pending pause's payload by key.
 */
function getPending({ runId, tcId, stepIndex }) {
  const entry = pending.get(keyOf({ runId, tcId, stepIndex }));
  return entry ? entry.payload : null;
}

module.exports = {
  awaitInput,
  provideInput,
  cancelRun,
  listPending,
  getPending,
  DEFAULT_TIMEOUT_MS,
};
