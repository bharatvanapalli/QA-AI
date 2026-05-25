'use strict';

/**
 * Request-scoped user context propagated via AsyncLocalStorage.
 *
 * Why ALS instead of threading userId through every agent signature:
 * the budget cap (E10.3) needs to know which user a `provider.complete()`
 * call belongs to, but adding `userId` to every agent's `run()` would
 * touch ~12 files and every call site. ALS sets the context once at the
 * route boundary and the provider wrapper reads it on the way out — no
 * agent code changes.
 *
 * Callers without a request context (background scripts, the reaper,
 * etc.) get `null` from getUserId() and the wrapper skips budget
 * enforcement — those calls are operator-initiated and not billable to
 * an end-user account.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/**
 * Express middleware: mount AFTER auth populates req.user. Wraps the
 * remainder of the request chain in an ALS scope so any downstream code
 * (agents → provider.complete → llmProvider wrapper) can read userId
 * without threading it through every signature.
 */
function userContextMiddleware(req, res, next) {
  const userId = req.user?.id || null;
  const orgId = req.org?.id || null;
  als.run({ userId, orgId }, next);
}

function getUserId() {
  return als.getStore()?.userId || null;
}

function getOrgId() {
  return als.getStore()?.orgId || null;
}

/**
 * Mutate the active ALS store's orgId. Used by requireOrg AFTER
 * requireAuth has opened the scope — we can't re-run als.run() at that
 * point so we mutate the live store object instead. Safe because the
 * store is per-request and the mutation is visible to all subsequent
 * reads in that same async chain.
 */
function setOrgId(orgId) {
  const store = als.getStore();
  if (store) store.orgId = orgId;
}

/**
 * Programmatic scope-runner — used by long-running background tasks
 * (Conductor loops spawned from a route but executing after res ends)
 * to keep their ALS context alive. Pattern:
 *
 *   userContext.runAsUser(req.user.id, req.org.id, async () => {
 *     await pipeline.run(...);
 *   });
 */
function runAsUser(userId, orgId, callback) {
  return als.run({ userId, orgId }, callback);
}

module.exports = { userContextMiddleware, getUserId, getOrgId, setOrgId, runAsUser };
