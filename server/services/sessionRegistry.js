'use strict';

/**
 * Registry of active live-browser sessions keyed by userId.
 * One session per user — picker controls and external endpoints
 * look up the session here.
 */
const sessions = new Map();

function set(userId, session) {
  // Close any prior session for this user
  const prior = sessions.get(userId);
  if (prior && prior !== session) {
    try { prior.cdp?.send('Page.stopScreencast'); } catch (_) {}
    try { prior.context?.close(); } catch (_) {}
    try { prior.browser?.close(); } catch (_) {}
  }
  sessions.set(userId, session);
}

function get(userId) {
  return sessions.get(userId);
}

function remove(userId) {
  sessions.delete(userId);
}

/**
 * Tear down every active MCP/browser session. Called from the process
 * SIGTERM / SIGINT handler so a Ctrl-C on the dev server doesn't leave
 * Chromium child processes alive holding ports / file handles.
 *
 * Each session close is wrapped in try/catch because we're already on the
 * shutdown path — one stuck session should not prevent the others from
 * closing.
 */
async function closeAll() {
  const closing = [];
  for (const [userId, session] of sessions) {
    closing.push(
      (async () => {
        try { await session.cdp?.send('Page.stopScreencast'); } catch (_) {}
        try { await session.context?.close(); } catch (_) {}
        try { await session.browser?.close(); } catch (_) {}
        sessions.delete(userId);
      })(),
    );
  }
  await Promise.allSettled(closing);
}

module.exports = { set, get, remove, sessions, closeAll };
