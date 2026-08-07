'use strict';

/**
 * Phase D — Evidence Repair Agent.
 *
 * Deterministic DOM probe that fills kbMiss gaps before codegen.
 * For each repairable action (has pageUrl, no locator), the agent:
 *   1. Groups actions by normalised URL (one browser session per unique URL)
 *   2. Navigates to each URL using the project's auth session
 *   3. Probes the DOM via MCP browser_snapshot
 *   4. Matches elements using token-overlap scoring (no LLM)
 *   5. Validates uniqueness before accepting a match
 *   6. Upserts the confirmed locator into KnowledgeBaseLocator with lineage
 *
 * This is intentionally NOT an LLM repair loop. The browser answers
 * "what element matches this narration?" — the AI does not rewrite code.
 * Rewriting code to make a failing test pass risks verdict inversion.
 *
 * Pure output: resolved[] + failed[] arrays. DB writes happen here.
 * No code generation.
 */

const { normPageUrl, normPageUrlFallback } = require('../../lib/urlNorm');
const actionLocatorResolver = require('../actionLocatorResolver');
const envContract = require('../codegen/_env');
const mcpCore = require('../mcp');
const pageAtlas = require('../pageAtlas');

// ── Scoring constants ─────────────────────────────────────────────────────────

const MATCH_THRESHOLD = 0.5;   // minimum token-overlap fraction to accept a candidate
const MIN_TOKEN_LEN = 3;        // minimum word length to include in token set
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'are', 'was',
  'has', 'have', 'not', 'its', 'into', 'but', 'can', 'all', 'been',
]);

// Auth failure detection: if navigation lands on a login page
const AUTH_FAILURE_RE = /(?:sign[\s_]?in|log[\s_]?in|password|authentication|unauthorized|please[\s_]?sign)/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callRepairTool(session, name, args = {}) {
  if (!session) {
    const err = new Error('MCP session not connected');
    err.code = 'MCP_NO_SESSION';
    throw err;
  }
  if (typeof session.callTool === 'function') {
    return session.callTool(name, args);
  }
  if (session.client && typeof session.client.callTool === 'function') {
    return session.client.callTool({ name, arguments: args || {} });
  }
  const err = new Error('MCP session has no callable tool bridge');
  err.code = 'MCP_NO_TOOL_BRIDGE';
  throw err;
}

function snapshotText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result.text === 'string') return result.text;
  const content = result && result.content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).filter(Boolean).join('\n');
  }
  return '';
}

function isAuthWallSnapshot(text) {
  const body = String(text || '');
  return AUTH_FAILURE_RE.test(body) && /(?:password|username|user name)/i.test(body);
}

function pickSnapshotCandidate(candidates, roleRe, nameRe) {
  const pool = (candidates || []).filter((c) => roleRe.test(String(c.role || '').toLowerCase()) && c.ref);
  return pool.find((c) => nameRe.test(`${c.accessibleName || c.name || ''}`)) || pool[0] || null;
}

function normaliseCredential(row) {
  if (!row || typeof row !== 'object') return null;
  const username = row.username || row.email || row.name;
  const password = row.password;
  if (!username || !password) return null;
  return { username: String(username), password: String(password), name: row.name ? String(row.name) : 'default' };
}

async function harvestLoginFromCases(prisma, projectId) {
  if (!prisma || !projectId) return null;
  const cases = await prisma.testCase.findMany({
    where: { projectId },
    select: { steps: true },
    orderBy: { createdAt: 'asc' },
    take: 300,
  }).catch(() => []);
  for (const tc of cases || []) {
    let steps = [];
    try { steps = JSON.parse(tc.steps || '[]'); } catch (_) { continue; }
    let username = null;
    let password = null;
    for (const step of steps) {
      if (!step || !/fill|type|enter|input/i.test(String(step.action || ''))) continue;
      const value = typeof step.value === 'string' ? step.value.trim() : '';
      if (!value) continue;
      const target = `${step.target || ''} ${step.name || ''} ${step.field || ''}`.toLowerCase();
      if (!username && /user|email|login|account/.test(target)) username = value;
      if (!password && /pass|pwd|secret/.test(target)) password = value;
    }
    if (username && password) return { username, password, name: 'harvested-positive-login' };
  }
  return null;
}

async function injectAuthFixture({ mcp, fixture, send }) {
  if (!fixture || !fixture.storageState) return { ok: false, reason: 'missing_auth_fixture' };
  let state;
  try { state = JSON.parse(fixture.storageState); } catch (_) {
    return { ok: false, reason: 'invalid_auth_fixture' };
  }
  const cookies = (state.cookies || []).map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: c.secure || false,
    httpOnly: c.httpOnly || false,
    sameSite: c.sameSite || 'None',
    ...(c.expires > 0 ? { expires: c.expires } : {}),
  })).filter((c) => c.name && c.domain);

  if (cookies.length) {
    await callRepairTool(mcp, 'browser_execute_cdp_command', {
      command: 'Network.setCookies',
      params: { cookies },
    }).catch((err) => {
      send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'warn',
        message: `[EvidenceRepair] auth fixture cookie injection failed: ${err.message}` });
    });
  }

  for (const origin of state.origins || []) {
    const items = origin && Array.isArray(origin.localStorage) ? origin.localStorage : [];
    if (!origin?.origin || !items.length) continue;
    try {
      await callRepairTool(mcp, 'browser_navigate', { url: origin.origin });
      const expression = items
        .map((item) => `try{localStorage.setItem(${JSON.stringify(item.name)},${JSON.stringify(item.value)})}catch(_){}`)
        .join(';');
      // MCP 0.0.75: use `function` (callable), not `expression` (removed).
      await callRepairTool(mcp, 'browser_evaluate', { function: `() => { ${expression} }` });
    } catch (err) {
      send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'warn',
        message: `[EvidenceRepair] auth fixture localStorage injection failed for ${origin.origin}: ${err.message}` });
    }
  }

  return { ok: cookies.length > 0 || (state.origins || []).length > 0, source: 'auth_fixture' };
}

async function attemptFormLogin({ mcp, startUrl, credential, send }) {
  if (!credential || !credential.username || !credential.password || !startUrl) {
    return { ok: false, reason: 'missing_credentials' };
  }
  try {
    await callRepairTool(mcp, 'browser_navigate', { url: startUrl });
    let candidates = [];
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      await sleep(candidates.length ? 900 : 700);
      const snap = await callRepairTool(mcp, 'browser_snapshot', {});
      candidates = parseSnapshotCandidates(snapshotText(snap));
      if (candidates.some((c) => /textbox|searchbox|combobox/.test(String(c.role || '').toLowerCase()))) break;
    }

    const userField = pickSnapshotCandidate(candidates, /textbox|searchbox|combobox/, /user|email|login|account/i);
    const passwordPool = candidates.filter((c) => /textbox/.test(String(c.role || '').toLowerCase()) && c.ref && c.ref !== userField?.ref);
    const passwordField = passwordPool.find((c) => /pass|pwd|secret/i.test(`${c.accessibleName || c.name || ''}`)) || passwordPool[0] || null;
    const submit = pickSnapshotCandidate(candidates, /button/, /log\s*in|sign\s*in|submit|continue|enter|next/i);
    if (!userField || !passwordField) {
      return { ok: false, reason: 'login_fields_not_found' };
    }

    await callRepairTool(mcp, 'browser_type', {
      element: 'Username field',
      target: userField.ref,
      ref: userField.ref,
      text: credential.username,
    });
    await callRepairTool(mcp, 'browser_type', {
      element: 'Password field',
      target: passwordField.ref,
      ref: passwordField.ref,
      text: credential.password,
    });
    if (submit) {
      await callRepairTool(mcp, 'browser_click', {
        element: 'Login button',
        target: submit.ref,
        ref: submit.ref,
      });
    } else {
      await callRepairTool(mcp, 'browser_type', {
        element: 'Password field',
        target: passwordField.ref,
        ref: passwordField.ref,
        text: '',
        submit: true,
      });
    }

    await sleep(2500);
    const after = await callRepairTool(mcp, 'browser_snapshot', {});
    const afterText = snapshotText(after);
    const afterCandidates = parseSnapshotCandidates(afterText);
    const stillLoginButton = afterCandidates.some((c) =>
      /button/.test(String(c.role || '').toLowerCase()) && /log\s*in|sign\s*in/i.test(String(c.accessibleName || c.name || '')));
    const textboxCount = afterCandidates.filter((c) => /textbox/.test(String(c.role || '').toLowerCase())).length;
    if (isAuthWallSnapshot(afterText) || (stillLoginButton && textboxCount >= 2)) {
      return { ok: false, reason: 'login_rejected' };
    }
    send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'info',
      message: `[EvidenceRepair] authenticated repair session as "${credential.username}"` });
    return { ok: true, source: 'form_login' };
  } catch (err) {
    return { ok: false, reason: 'login_error', detail: err.message };
  }
}

async function authenticateRepairSession({ mcp, projectId, pageUrl, prisma, send }) {
  if (!prisma || !projectId) return { ok: false, reason: 'missing_project_context' };
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { targetUrl: true, defaultAuthFixtureId: true, testCredentials: true },
  }).catch(() => null);
  if (!project) return { ok: false, reason: 'missing_project' };

  if (project.defaultAuthFixtureId) {
    const fixture = await prisma.authFixture.findFirst({
      where: { id: project.defaultAuthFixtureId, projectId },
      select: { id: true, name: true, storageState: true },
    }).catch(() => null);
    const injected = await injectAuthFixture({ mcp, fixture, send });
    if (injected.ok) {
      send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'info',
        message: `[EvidenceRepair] using auth fixture "${fixture?.name || fixture?.id}" for protected-page recapture` });
      return injected;
    }
  }

  const stored = envContract.parseStoredCredentials(project.testCredentials);
  let credential = stored.length ? normaliseCredential(stored[0]) : null;
  if (!credential) credential = await harvestLoginFromCases(prisma, projectId);
  if (!credential) return { ok: false, reason: 'missing_credentials' };

  let startUrl = project.targetUrl || null;
  if (!startUrl && pageUrl) {
    try { startUrl = new URL(pageUrl).origin; } catch (_) {}
  }
  const login = await attemptFormLogin({ mcp, startUrl, credential, send });
  if (!login.ok) {
    send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'warn',
      message: `[EvidenceRepair] authenticated recapture could not log in (${login.reason || 'login_failed'}). Check Project Setup credentials or auth fixture.` });
  }
  return login;
}

function tokenise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN && !STOPWORDS.has(w));
}

function tokenScore(queryTokens, candidateText) {
  if (!queryTokens.length) return 0;
  const candidateTokens = tokenise(candidateText);
  let matches = 0;
  for (const qt of queryTokens) {
    if (candidateTokens.some((ct) => ct.includes(qt) || qt.includes(ct))) matches++;
  }
  return matches / queryTokens.length;
}

function textScore(left, right) {
  const leftTokens = tokenise(left);
  const rightText = String(right || '');
  if (!leftTokens.length || !rightText.trim()) return 0;
  return tokenScore(leftTokens, rightText);
}

function repairMatchText(item) {
  const action = item && item.action || {};
  const locator = item && item.locator || {};
  const actionLocator = locator.actionLocator || null;
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator) || actionLocator || {};
  const facts = primary.targetFacts || actionLocator && actionLocator.targetFacts || {};
  return [
    action.narration,
    action.elementLabel,
    action.tool,
    locator.intent,
    locator.name,
    facts.accessibleName,
    facts.text,
    primary.elementLabel,
  ].filter(Boolean).join(' ');
}

function replayStepText(step) {
  if (!step || typeof step !== 'object') return '';
  const parts = [step.as, step.target, step.action, step.valueRef, step.rawValue, step.dataRole];
  for (const c of Array.isArray(step.candidates) ? step.candidates : []) {
    if (!c || typeof c !== 'object') continue;
    parts.push(c.name, c.text, c.label, c.placeholder, c.role, c.selector, c.expression);
  }
  return parts.filter(Boolean).join(' ');
}

function replayStepMatchesRepair(step, resolvedItem) {
  const needle = repairMatchText(resolvedItem);
  if (!needle) return false;
  const hay = replayStepText(step);
  if (!hay) return false;
  const score = Math.max(textScore(needle, hay), textScore(hay, needle));
  return score >= 0.5;
}

function candidateFromActionLocator(actionLocator, fallback = {}) {
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator) || actionLocator;
  if (!primary) return null;
  const facts = primary.targetFacts || actionLocator && actionLocator.targetFacts || {};
  const expression = primary.frameworkExpressions?.playwright || primary.expression || fallback.expression || null;
  const role = facts.role || primary.role || fallback.role || null;
  const name = facts.accessibleName || facts.text || primary.accessibleName || primary.elementLabel || fallback.name || null;
  if (role && name) {
    return {
      strategy: 'role',
      role,
      name,
      expression: expression || `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`,
      verified: true,
      source: primary.verificationSource || primary.evidenceSource || primary.proof?.source || 'evidence_repair',
    };
  }
  if (expression) {
    return {
      strategy: expression.startsWith('getBy') ? 'playwright' : 'css',
      selector: expression,
      expression,
      verified: true,
      source: primary.verificationSource || primary.evidenceSource || primary.proof?.source || 'evidence_repair',
    };
  }
  return null;
}

function candidateKey(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  return [
    candidate.strategy,
    candidate.role,
    candidate.name,
    candidate.text,
    candidate.selector,
    candidate.expression,
  ].filter(Boolean).join('|').toLowerCase();
}

function addCandidate(step, candidate) {
  if (!step || !candidate) return false;
  if (!Array.isArray(step.candidates)) step.candidates = [];
  const key = candidateKey(candidate);
  if (key && step.candidates.some((c) => candidateKey(c) === key)) return false;
  step.candidates.unshift(candidate);
  return true;
}

function replayActionNeedsLocator(action) {
  return [
    'click', 'doubleclick', 'doubleClick', 'tripleclick', 'tripleClick',
    'fill', 'type', 'selectoption', 'selectOption', 'check', 'uncheck',
    'press', 'hover', 'upload', 'drag',
  ].includes(String(action || ''));
}

function patchReplayIrEnvelope({ envelope, resolved = [] }) {
  if (!envelope || typeof envelope !== 'object') return { changed: false, patchedCount: 0, patchedKeys: [] };
  const ir = envelope.ir && typeof envelope.ir === 'object' ? envelope.ir : null;
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  if (!steps.length || !resolved.length) return { changed: false, patchedCount: 0, patchedKeys: [] };

  let changed = false;
  let patchedCount = 0;
  const patchedKeys = [];

  for (const item of resolved) {
    const locator = item && item.locator || {};
    const actionLocator = locator.actionLocator || null;
    if (!actionLocatorResolver.isVerifiedActionLocator(actionLocator)) continue;
    const candidate = candidateFromActionLocator(actionLocator, locator);
    const matchedResolveTargets = new Set();
    let itemPatched = false;

    for (const step of steps) {
      if (!step || step.op !== 'resolve') continue;
      if (!replayStepMatchesRepair(step, item)) continue;
      if (!actionLocatorResolver.isVerifiedActionLocator(step.actionLocator)) {
        step.actionLocator = actionLocator;
        changed = true;
        itemPatched = true;
      }
      if (addCandidate(step, candidate)) {
        changed = true;
        itemPatched = true;
      }
      if (step.as) matchedResolveTargets.add(step.as);
    }

    for (const step of steps) {
      if (!step || step.op !== 'act' || !replayActionNeedsLocator(step.action)) continue;
      const targetMatched = step.target && matchedResolveTargets.has(step.target);
      if (!targetMatched && !replayStepMatchesRepair(step, item)) continue;
      if (!actionLocatorResolver.isVerifiedActionLocator(step.actionLocator)) {
        step.actionLocator = actionLocator;
        changed = true;
        itemPatched = true;
      }
    }

    if (itemPatched) {
      patchedCount += 1;
      patchedKeys.push({
        runResultId: item.action && item.action.runResultId || null,
        gapIndex: item.action && item.action.gapIndex,
        narration: item.action && item.action.narration || locator.intent || null,
      });
    }
  }

  if (changed) {
    const patchedTexts = patchedKeys.map((k) => k.narration).filter(Boolean);
    const remaining = [];
    for (const gap of Array.isArray(envelope.gaps) ? envelope.gaps : []) {
      const gapText = [gap.narration, gap.elementLabel, gap.detail, gap.description, gap.where].filter(Boolean).join(' ');
      const matched = patchedTexts.some((text) => Math.max(textScore(text, gapText), textScore(gapText, text)) >= 0.5);
      if (!matched) remaining.push(gap);
    }
    envelope.gaps = remaining;
    if (remaining.length === 0) envelope.complete = true;
    envelope.repairedAt = new Date().toISOString();
    envelope.repairSource = 'evidence_repair_replayir_patch';
  }

  return { changed, envelope, patchedCount, patchedKeys };
}

/**
 * Parse MCP snapshot text into a list of candidate element descriptors.
 * Each candidate: { role, accessibleName, selector, line }
 *
 * The snapshot format from @playwright/mcp is:
 *   role "accessible name" [ref=eN]
 *   e.g.:  button "Save Employee" [ref=e42]
 *          textbox "Username" [ref=e7]
 */
function parseSnapshotCandidates(snapshotText) {
  const canonical = (mcpCore.parseMcpSnapshotToCandidates(snapshotText) || [])
    .filter((c) => c && c.role && c.ref)
    .map((c) => ({
      role: c.role,
      accessibleName: c.name || '',
      name: c.name || '',
      ref: c.ref || '',
      expression: c.expression || '',
      strategy: c.strategy || 'snapshot',
      line: `${c.role}${c.name ? ` "${c.name}"` : ''}${c.ref ? ` [ref=${c.ref}]` : ''}`,
    }));
  if (canonical.length) return canonical;

  const candidates = [];
  if (!snapshotText) return candidates;
  const ELEMENT_RE = /^[\s│├└─]*(\w[\w-]*)(?:\s+"([^"]*)")?(?:\s+\[ref=(e\d+)\])?/gm;
  let m;
  while ((m = ELEMENT_RE.exec(snapshotText)) !== null) {
    const role = m[1];
    const accessibleName = m[2] || '';
    const ref = m[3] || '';
    if (!role || role === 'document' || role === 'generic' || role === 'none') continue;
    candidates.push({ role, accessibleName, name: accessibleName, ref, line: m[0].trim() });
  }
  return candidates;
}

/**
 * Build a Playwright expression from a matched candidate.
 * Prefer getByRole when role + accessibleName are available.
 */
function expressionFromCandidate(candidate) {
  const { role, accessibleName } = candidate || {};
  if (candidate && candidate.expression) return candidate.expression;
  if (role && accessibleName) {
    const name = accessibleName.replace(/\s+/g, ' ').trim();
    if (name) {
      const needsRegex = /[^\w\s\-]/.test(name) || name.length > 40;
      if (needsRegex) {
        const esc = name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
        return `getByRole(${JSON.stringify(role)}, { name: /${esc}/i })`;
      }
      return `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`;
    }
  }
  return null;
}

function targetFactsFromCandidate(candidate) {
  const facts = {};
  if (candidate && candidate.role) facts.role = candidate.role;
  if (candidate && (candidate.accessibleName || candidate.name)) facts.accessibleName = candidate.accessibleName || candidate.name;
  if (candidate && candidate.ref) facts.snapshotRef = candidate.ref;
  return facts;
}

function buildActionLocatorCandidateFromRepair({ gap, winner, expression, pageUrl, narration }) {
  const source = 'snapshot_ref_fallback';
  const targetFacts = targetFactsFromCandidate(winner);
  const elementLabel = narration || winner.accessibleName || winner.role || 'element';
  const proof = {
    source,
    verified: false,
    count: null,
    snapshotCandidateCount: 1,
    sameElement: false,
    actionTimeResolved: false,
    actedNodeBound: false,
    identityVerified: false,
    visible: null,
    enabled: null,
    ref: winner.ref || null,
  };
  const action = {
    toolName: gap?.action?.tool || 'unknown',
    elementLabel,
    strategy: 'accessibility_snapshot_repair',
    expression,
    frameworkExpressions: { playwright: expression },
    targetFacts,
    context: {
      source,
      narration,
      snapshotLine: winner.line || null,
    },
    proof,
  };
  const domAtlas = actionLocatorResolver.normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1',
    url: pageUrl || gap?.pageUrl || null,
    counts: { controls: 1 },
    controls: [{
      selector: expression,
      role: winner.role || null,
      name: winner.accessibleName || null,
      visible: null,
      enabled: null,
      source,
      ref: winner.ref || null,
    }],
    forms: [],
    tables: [],
    dialogs: [],
    landmarks: [],
    frames: [],
    shadowHosts: [],
    headings: [],
  }, { pageUrl: pageUrl || gap?.pageUrl || null });
  const actionLocator = {
    kind: 'playwright',
    verified: false,
    verificationStatus: 'unverified',
    verificationSource: source,
    evidenceSource: source,
    diagnosticOnly: true,
    guess: {
      isGuess: true,
      reviewRequired: true,
      source,
      reason: 'Accessibility-snapshot repair was not recertified against the acted DOM node.',
      annotation: 'QAAI-GUESSED: snapshot repair candidate; review before relying on this locator.',
    },
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: 'accessibility_snapshot_repair',
    toolName: gap?.action?.tool || 'unknown',
    pageUrl: pageUrl || gap?.pageUrl || null,
    elementLabel,
    targetFacts,
    context: action.context,
    proof,
    domAtlas,
    candidates: [{
      strategy: 'role',
      expression,
      frameworkExpressions: { playwright: expression },
      targetFacts,
      proof,
      score: 1,
    }],
    allCandidates: [{
      strategy: 'role',
      expression,
      proof,
      score: 1,
    }],
  };
  return actionLocatorResolver.isExportSafeActionLocator(actionLocator) ? actionLocator : null;
}

// Compatibility export for existing callers. This function no longer fabricates
// verified evidence; only a live action-node recertification may do that.
const buildVerifiedActionLocatorFromRepair = buildActionLocatorCandidateFromRepair;

// ── Main repair function ──────────────────────────────────────────────────────

/**
 * Repair missing locator evidence for a set of repairable actions.
 *
 * @param {object}   p
 * @param {Array}    p.repairableGaps  – from replayContract.validateContract (type=missing_locator)
 * @param {string}   p.projectId
 * @param {string}   p.runId           – for updatedByRunId lineage
 * @param {object}   p.mcp             – active MCP session with callTool
 * @param {Function} p.send            – WS progress emitter (optional)
 * @param {object}   p.prisma          – Prisma client
 *
 * @returns {Promise<{
 *   resolved: [{action, locator, kbRowId}],
 *   failed:   [{action, reason}],
 *   repairSummary: string,
 * }>}
 */
async function repairEvidence({ repairableGaps = [], projectId, runId, mcp, send, prisma }) {
  const resolved = [];
  const failed = [];

  if (!repairableGaps.length || !mcp) return { resolved, failed, repairSummary: 'no repairable gaps' };

  // ── Group gaps by normalised URL ─────────────────────────────────────────
  const byUrl = new Map();
  for (const gap of repairableGaps) {
    if (!gap.pageUrl) continue;
    const normUrl = normPageUrl(gap.pageUrl);
    if (!normUrl) continue;
    const group = byUrl.get(normUrl) || [];
    group.push(gap);
    byUrl.set(normUrl, group);
  }

  if (!byUrl.size) return { resolved, failed, repairSummary: 'no repairable gaps with page URLs' };

  // ── Snapshot cache: one browser session per unique URL ───────────────────
  const snapshotCache = new Map(); // normUrl → ParsedCandidates[]

  let authAttemptPromise = null;
  const ensureAuthenticated = (pageUrl) => {
    if (!authAttemptPromise) {
      authAttemptPromise = authenticateRepairSession({ mcp, projectId, pageUrl, prisma, send });
    }
    return authAttemptPromise;
  };

  send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'info',
    message: `[EvidenceRepair] Probing ${byUrl.size} URL(s) for ${repairableGaps.length} missing locator(s)` });

  for (const [normUrl, gaps] of byUrl) {
    let candidates = null;

    // ── Probe the URL ──────────────────────────────────────────────────────
    try {
      // Navigate to the target page
      await callRepairTool(mcp, 'browser_navigate', { url: gaps[0].pageUrl });
      // Take a snapshot
      let snap = await callRepairTool(mcp, 'browser_snapshot', {});
      let snapText = snapshotText(snap);

      // Auth failure: check if we landed on a login page
      if (isAuthWallSnapshot(snapText)) {
        const auth = await ensureAuthenticated(gaps[0].pageUrl);
        if (auth && auth.ok) {
          await callRepairTool(mcp, 'browser_navigate', { url: gaps[0].pageUrl });
          snap = await callRepairTool(mcp, 'browser_snapshot', {});
          snapText = snapshotText(snap);
        }
      }

      if (isAuthWallSnapshot(snapText)) {
        // All gaps for this URL and project fail with auth_required
        for (const gap of gaps) {
          failed.push({ action: gap.action, reason: 'auth_required', pageUrl: gap.pageUrl });
        }
        send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'warn',
          message: `[EvidenceRepair] Auth failure navigating to ${normUrl} — all ${gaps.length} gaps for this URL marked auth_required` });
        continue;
      }

      candidates = parseSnapshotCandidates(snapText);
      snapshotCache.set(normUrl, candidates);
    } catch (navErr) {
      // Navigation failed — try parent path fallback
      const fallbackUrl = normPageUrlFallback(gaps[0].pageUrl);
      if (fallbackUrl && fallbackUrl !== normUrl) {
        try {
          await callRepairTool(mcp, 'browser_navigate', { url: fallbackUrl });
          const snap = await callRepairTool(mcp, 'browser_snapshot', {});
          const snapText = snapshotText(snap);
          candidates = parseSnapshotCandidates(snapText);
          snapshotCache.set(normUrl, candidates);
        } catch (_) {}
      }
    }

    if (!candidates) {
      for (const gap of gaps) {
        failed.push({ action: gap.action, reason: 'page_not_reached', pageUrl: gap.pageUrl });
      }
      send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'warn',
        message: `[EvidenceRepair] Could not reach ${normUrl} — ${gaps.length} gap(s) not repairable` });
      continue;
    }

    // ── Match each gap against candidates ─────────────────────────────────
    for (const gap of gaps) {
      const narration = gap.narration || (gap.action && gap.action.narration) || '';
      const queryTokens = tokenise(narration);
      if (!queryTokens.length) {
        failed.push({ action: gap.action, reason: 'no_query_tokens', narration });
        continue;
      }

      // Score all candidates
      const scored = candidates
        .map((c) => ({
          candidate: c,
          score: tokenScore(queryTokens, `${c.role} ${c.accessibleName}`),
        }))
        .filter((s) => s.score >= MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      if (!scored.length) {
        failed.push({ action: gap.action, reason: 'element_not_in_snapshot', narration, queryTokens });
        continue;
      }

      // Uniqueness check: if multiple candidates share the top score, it's ambiguous
      const topScore = scored[0].score;
      const topTied = scored.filter((s) => s.score === topScore);
      if (topTied.length > 1) {
        // Try to disambiguate by exact accessible name match
        const exact = topTied.filter((s) => {
          const name = s.candidate.accessibleName.toLowerCase().trim();
          return queryTokens.some((t) => name === t || name.includes(t));
        });
        if (exact.length !== 1) {
          failed.push({ action: gap.action, reason: 'ambiguous_locator', narration,
            candidates: topTied.slice(0, 3).map((s) => s.candidate.accessibleName) });
          continue;
        }
        scored.splice(0, scored.length, ...exact);
      }

      const winner = scored[0].candidate;
      const expression = expressionFromCandidate(winner);
      if (!expression) {
        failed.push({ action: gap.action, reason: 'no_expression_built', candidate: winner });
        continue;
      }
      const repairedActionLocator = buildActionLocatorCandidateFromRepair({
        gap,
        winner,
        expression,
        pageUrl: normUrl,
        narration,
      });
      if (!repairedActionLocator) {
        failed.push({ action: gap.action, reason: 'snapshot_repair_candidate_not_export_safe', candidate: winner, expression });
        continue;
      }

      // ── Upsert into KnowledgeBaseLocator ──────────────────────────────
      const element = narration.slice(0, 500);
      const pageUrl = normUrl;
      let kbRowId = null;
      const mayPromoteRepairEvidence = actionLocatorResolver.isVerifiedActionLocator(repairedActionLocator);
      if (mayPromoteRepairEvidence) {
        try {
        const existing = await prisma.knowledgeBaseLocator.findFirst({
          where: { projectId, element, pageUrl },
          select: { id: true, healthScore: true },
        });
        const now = new Date();
        if (existing) {
          // Don't overwrite healthy locators (healthScore > 70)
          if ((existing.healthScore || 0) <= 70) {
            await prisma.knowledgeBaseLocator.update({
              where: { id: existing.id },
              data: {
                role: winner.role || null,
                accessibleName: winner.accessibleName || null,
                selector: expression,
                strategy: 'repair',
                updatedByRunId: runId || null,
                lastUsedAt: now,
                deprecated: false,
              },
            });
          }
          kbRowId = existing.id;
        } else {
          const created = await prisma.knowledgeBaseLocator.create({
            data: {
              projectId,
              element,
              selector: expression,
              role: winner.role || null,
              accessibleName: winner.accessibleName || null,
              strategy: 'repair',
              pageUrl,
              healthScore: 50, // Start at 50 — not fully trusted until a real run confirms it
              occurrences: 1,
              updatedByRunId: runId || null,
              lastUsedAt: now,
              deprecated: false,
            },
          });
          kbRowId = created.id;
        }
      } catch (dbErr) {
        // DB write failed — still surface the locator to the caller for this run
      }

      if (repairedActionLocator.domAtlas) {
        try {
          await pageAtlas.recordDomAtlas(prisma, projectId, repairedActionLocator.domAtlas, {
            pageUrl,
            pageKey: normUrl,
          });
        } catch (_) {
          // Atlas persistence is best-effort; the verified action locator still
          // patches this ReplayIR result below.
        }
      }
      }

      const locator = {
        intent: narration,
        role: winner.role || null,
        name: winner.accessibleName || null,
        expression,
        strategy: 'repair',
        source: 'qaaiGuessedLocator',
        verified: false,
        guessedLocator: true,
        warning: repairedActionLocator.guess.annotation,
        verificationSource: repairedActionLocator.verificationSource,
        actionLocator: repairedActionLocator,
      };
      resolved.push({ action: gap.action, locator, kbRowId });
    }
  }

  const repairSummary = `EvidenceRepair: ${repairableGaps.length} gaps → ${resolved.length} resolved, ${failed.length} failed`;
  send && send({ type: 'agent.phase.log', phase: 'evidence_repair', level: 'info', message: `[${repairSummary}]` });

  return { resolved, failed, repairSummary };
}

/**
 * Apply repair results back into a set of journeyCases.
 * Updates action.locator and clears action.kbMiss for resolved actions.
 * Returns the updated journeyCases array (mutates in place).
 */
function applyRepairResults({ journeyCases, resolved }) {
  if (!resolved || !resolved.length) return journeyCases;

  const resolvedByNarration = new Map();
  for (const r of resolved) {
    const key = (r.action && (r.action.narration || r.action.tool)) || '';
    if (key) resolvedByNarration.set(key, r);
  }

  for (const jc of journeyCases) {
    const actions = jc.actionPlan && jc.actionPlan.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const key = action.narration || action.tool || '';
      const repaired = resolvedByNarration.get(key);
      if (repaired && repaired.locator) {
        action.locator = repaired.locator;
        if (repaired.locator.actionLocator) {
          action.actionLocator = repaired.locator.actionLocator;
        }
        if (
          repaired.locator.verified === true
          && actionLocatorResolver.isVerifiedActionLocator(repaired.locator.actionLocator)
        ) {
          delete action.kbMiss;
          delete action.guessedLocator;
        } else {
          action.kbMiss = true;
          action.guessedLocator = true;
        }
      }
    }
  }
  return journeyCases;
}

module.exports = {
  repairEvidence,
  applyRepairResults,
  patchReplayIrEnvelope,
  parseSnapshotCandidates,
  expressionFromCandidate,
  buildActionLocatorCandidateFromRepair,
  buildVerifiedActionLocatorFromRepair,
  tokenScore,
};
