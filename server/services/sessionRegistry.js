'use strict';

/**
 * Registry of active live-browser sessions keyed by userId.
 * One session per user — picker controls and external endpoints
 * look up the session here.
 */
const sessions = new Map();
const groupLeases = new Map();

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeScope(userOrScope, scope = {}) {
  const base = userOrScope && typeof userOrScope === 'object'
    ? userOrScope
    : { ...scope, userId: userOrScope };
  return {
    userId: clean(base.userId),
    projectId: clean(base.projectId),
    runId: clean(base.runId),
    caseId: clean(base.caseId),
    continuityGroupId: clean(base.continuityGroupId || base.groupId),
  };
}

function scopedKey(scope) {
  const normalized = normalizeScope(scope);
  if (!normalized.userId || !normalized.projectId || !normalized.runId || !normalized.caseId) return null;
  return `scope:${JSON.stringify([normalized.userId, normalized.projectId, normalized.runId, normalized.caseId])}`;
}

function groupKey(scope) {
  const normalized = normalizeScope(scope);
  if (!normalized.userId || !normalized.projectId || !normalized.runId || !normalized.continuityGroupId) return null;
  return `continuity-group:${JSON.stringify([
    normalized.userId,
    normalized.projectId,
    normalized.runId,
    normalized.continuityGroupId,
  ])}`;
}

function sessionIsUsable(session) {
  return Boolean(session && typeof session === 'object' && session.closed !== true);
}

function claimGroupLease(scope, session) {
  const key = groupKey(scope);
  if (!key) return { claimed: false, reason: 'invalid_continuity_group_scope' };
  if (!sessionIsUsable(session)) return { claimed: false, reason: 'continuity_session_closed' };
  const normalized = normalizeScope(scope);
  const prior = groupLeases.get(key);
  if (prior && sessionIsUsable(prior.session) && prior.session !== session) {
    return { claimed: false, reason: 'continuity_group_session_conflict', priorSession: prior.session };
  }
  const memberCaseIds = new Set(prior?.memberCaseIds || []);
  if (normalized.caseId) memberCaseIds.add(normalized.caseId);
  const lease = {
    scope: normalized,
    session,
    memberCaseIds,
    claimedAt: prior?.claimedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  groupLeases.set(key, lease);
  return { claimed: true, lease, reason: prior ? 'continuity_group_extended' : 'continuity_group_claimed' };
}

function rememberScope(session, scope) {
  if (!session || typeof session !== 'object') return;
  const key = scopedKey(scope);
  if (!key) return;
  const scopes = Array.isArray(session.qaaiSessionScopes) ? session.qaaiSessionScopes : [];
  if (!scopes.some((entry) => scopedKey(entry) === key)) scopes.push(normalizeScope(scope));
  session.qaaiSessionScopes = scopes;
}

function setScoped(scope, session) {
  const key = scopedKey(scope);
  if (!key) throw new Error('setScoped requires userId, projectId, runId and caseId');
  if (!sessionIsUsable(session)) throw new Error('setScoped requires a live session');
  const normalized = normalizeScope(scope);
  if (normalized.continuityGroupId) {
    const groupClaim = claimGroupLease(normalized, session);
    if (!groupClaim.claimed) {
      const error = new Error(groupClaim.reason);
      error.code = groupClaim.reason;
      throw error;
    }
  }
  const prior = sessions.get(key);
  if (prior && prior !== session) {
    // Raw ad-hoc close using field names (prior.context, prior.browser)
    // that don't match the actual live-CDP session shape (nested under
    // prior.liveCdp.context, no top-level .browser at all) — never really
    // closed anything. Also must NOT set prior.closed = true before
    // calling mcp.stopMcpSession() — that function's own first line is
    // `if (session.closed) return;`, an idempotency guard that setting
    // the flag first defeats, skipping all real teardown. Route through
    // the one real teardown function instead.
    require('./mcp').stopMcpSession(prior).catch((error) => (
      console.error('[sessionRegistry] stopMcpSession threw for prior scoped session:', error)
    ));
  }
  rememberScope(session, scope);
  sessions.set(key, session);
  return session;
}

function set(userId, session) {
  if (userId && typeof userId === 'object') return setScoped(userId, session);
  // Close any prior session for this user
  const prior = sessions.get(userId);
  if (prior && prior !== session) {
    require('./mcp').stopMcpSession(prior).catch((error) => (
      console.error('[sessionRegistry] stopMcpSession threw for prior session:', error)
    ));
  }
  sessions.set(userId, session);
}

function get(userId, scope = null) {
  if (userId && typeof userId === 'object') {
    const key = scopedKey(userId);
    return key ? sessions.get(key) : undefined;
  }
  if (scope && typeof scope === 'object') {
    const key = scopedKey({ ...scope, userId });
    return key ? sessions.get(key) : undefined;
  }
  return sessions.get(userId);
}

function remove(userId, scope = null) {
  if (userId && typeof userId === 'object') {
    const key = scopedKey(userId);
    return key ? sessions.delete(key) : false;
  }
  if (scope && typeof scope === 'object') {
    const key = scopedKey({ ...scope, userId });
    return key ? sessions.delete(key) : false;
  }
  return sessions.delete(userId);
}

function continuityArtifacts(session) {
  return {
    pageAlias: session?.pageAlias || session?.activePageAlias || null,
    tabAlias: session?.tabAlias || session?.activeTabAlias || null,
    pageAliases: Array.isArray(session?.pageAliases) ? session.pageAliases.slice() : [],
    tabAliases: Array.isArray(session?.tabAliases) ? session.tabAliases.slice() : [],
    contextTransitions: Array.isArray(session?.contextTransitions) ? session.contextTransitions.slice() : [],
  };
}

function leaseContinuation({
  userId,
  projectId,
  runId,
  caseId,
  dependsOnCaseId,
  dependsOnCaseIds = [],
  continuityGroupId = null,
} = {}) {
  const dependencyIds = [...new Set([
    ...(Array.isArray(dependsOnCaseIds) ? dependsOnCaseIds : []),
    dependsOnCaseId,
  ].filter(Boolean).map(String))];
  if (!dependencyIds.length) return { session: null, reused: false, reason: 'invalid_dependency_session_scope' };
  const dependencyScopes = dependencyIds.map((dependencyCaseId) => ({
    userId, projectId, runId, caseId: dependencyCaseId, continuityGroupId,
  }));
  if (dependencyScopes.some((scope) => !scopedKey(scope))) {
    return { session: null, reused: false, reason: 'invalid_dependency_session_scope' };
  }
  const directSessions = dependencyScopes
    .map((scope) => sessions.get(scopedKey(scope)))
    .filter(sessionIsUsable);
  const distinctDirectSessions = [...new Set(directSessions)];
  if (distinctDirectSessions.length > 1) {
    return { session: null, reused: false, reason: 'dependency_sessions_conflict' };
  }
  const requestedGroupKey = groupKey({ userId, projectId, runId, continuityGroupId });
  const groupLease = requestedGroupKey ? groupLeases.get(requestedGroupKey) : null;
  const groupSession = sessionIsUsable(groupLease?.session) ? groupLease.session : null;
  const directSession = distinctDirectSessions[0] || null;
  if (continuityGroupId && !groupSession) {
    const groupWasClosed = groupLease?.session?.closed === true;
    return {
      session: null,
      reused: false,
      reason: groupWasClosed ? 'continuity_session_closed' : 'continuity_group_not_found',
    };
  }
  if (groupLease && !dependencyIds.every((id) => groupLease.memberCaseIds.has(id))) {
    return { session: null, reused: false, reason: 'dependency_session_not_committed' };
  }
  if (directSession && groupSession && directSession !== groupSession) {
    return { session: null, reused: false, reason: 'continuity_group_session_conflict' };
  }
  let session = directSession;
  let leaseSource = directSession ? 'dependency_scope' : null;
  if (!session && groupSession) {
    const allDependenciesBelongToGroup = dependencyIds.every((id) => groupLease.memberCaseIds.has(id));
    if (!allDependenciesBelongToGroup) {
      return { session: null, reused: false, reason: 'dependency_session_not_found' };
    }
    session = groupSession;
    leaseSource = 'continuity_group';
  }
  if (!session) {
    const hadClosedSession = dependencyScopes.some((scope) => {
      const candidate = sessions.get(scopedKey(scope));
      return candidate && candidate.closed === true;
    }) || (groupLease?.session && groupLease.session.closed === true);
    return { session: null, reused: false, reason: hadClosedSession ? 'continuity_session_closed' : 'dependency_session_not_found' };
  }
  if (continuityGroupId) {
    // Acquisition validates/extends the lease but does not mark the target case
    // complete. Post-outcome persistence is the only place allowed to add that
    // case to memberCaseIds.
    const groupClaim = claimGroupLease({ userId, projectId, runId, continuityGroupId }, session);
    if (!groupClaim.claimed) return { session: null, reused: false, reason: groupClaim.reason };
  }
  const targetScope = { userId, projectId, runId, caseId, continuityGroupId };
  const targetKey = scopedKey(targetScope);
  if (!targetKey) return { session: null, reused: false, reason: 'invalid_continuation_session_scope' };
  rememberScope(session, targetScope);
  // Alias the exact same live object. Never close, clone, recreate, or navigate it.
  sessions.set(targetKey, session);
  return {
    session,
    reused: true,
    leaseSource,
    continuityGroupId: clean(continuityGroupId) || null,
    sameBrowser: session.browser || null,
    sameContext: session.context || null,
    samePage: session.page || session.currentPage || null,
    dependencyScope: normalizeScope(dependencyScopes[0]),
    dependencyScopes: dependencyScopes.map(normalizeScope),
    targetScope: normalizeScope(targetScope),
    artifacts: continuityArtifacts(session),
  };
}

async function closeForUser(userId) {
  const normalizedUserId = clean(userId);
  const ownedSessions = new Set();
  for (const [key, session] of sessions) {
    const ownedByScopedMetadata = Array.isArray(session?.qaaiSessionScopes)
      && session.qaaiSessionScopes.some((scope) => clean(scope?.userId) === normalizedUserId);
    if (key === normalizedUserId || ownedByScopedMetadata) {
      ownedSessions.add(session);
      sessions.delete(key);
    }
  }
  for (const [key, lease] of groupLeases) {
    if (lease.scope.userId === normalizedUserId) {
      ownedSessions.add(lease.session);
      groupLeases.delete(key);
    }
  }
  if (!ownedSessions.size) return false;
  await Promise.allSettled([...ownedSessions].map(async (session) => {
    if (session && typeof session === 'object') session.closed = true;
    try { await session?.cdp?.send('Page.stopScreencast'); } catch (_) {}
    try { await session?.context?.close(); } catch (_) {}
    try { await session?.browser?.close(); } catch (_) {}
  }));
  return true;
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
  const closed = new Set();
  for (const [userId, session] of sessions) {
    if (closed.has(session)) { sessions.delete(userId); continue; }
    closed.add(session);
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
  groupLeases.clear();
}

module.exports = {
  set,
  setScoped,
  get,
  remove,
  closeForUser,
  sessions,
  groupLeases,
  closeAll,
  normalizeScope,
  scopedKey,
  groupKey,
  sessionIsUsable,
  claimGroupLease,
  leaseContinuation,
  continuityArtifacts,
};
