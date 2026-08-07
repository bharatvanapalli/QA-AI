'use strict';

const crypto = require('crypto');
const mcp = require('./mcp');
const actionLocatorResolver = require('./actionLocatorResolver');
const locatorIntelligenceV2 = require('./locatorIntelligenceV2');
const pageAtlas = require('./pageAtlas');

const STEP_INTENT_HASH_VERSION = 'qaai-step-intent-v1';
const MIN_MEMORY_HEALTH = 30;
const TRUSTED_SUCCESS_COUNT = 2;

const ACTION_TYPE = {
  browser_click: 'click',
  browser_mouse_click: 'click',
  browser_click_xy: 'click',
  browser_double_click: 'click',
  // LEGACY-TRACE: the conductor emits no browser_triple_click (MCP has none). This
  // entry only NORMALIZES a historical recorded triple-click to 'click' so an old KB
  // memory never surfaces a phantom tool name to the live model. Cannot inject it.
  browser_triple_click: 'click',
  browser_type: 'fill',
  browser_fill: 'fill',
  browser_fill_form: 'fill',
  browser_select_option: 'selectOption',
  browser_select: 'selectOption',
  browser_hover: 'hover',
  browser_drag: 'drag',
  browser_file_upload: 'fileUpload',
};

function clean(value, max = 160) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeText(value) {
  return clean(value, 220)
    .toLowerCase()
    .replace(/[^\w\s.-]+/g, ' ')
    .replace(/\b(button|link|field|input|textbox|searchbox|combobox|dropdown|select|menu|item|icon|control|element|target)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function routeKeyFromUrl(url) {
  if (!url) return '/';
  try {
    const u = new URL(String(url));
    return u.pathname || '/';
  } catch (_) {
    return String(url).replace(/[?#].*$/, '') || '/';
  }
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parseJson(value, fallback = null) {
  try {
    if (value == null || value === '') return fallback;
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return fallback;
  }
}

function primaryTargetFacts(actionLocator, domFacts) {
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  const fromLocator = primary && primary.targetFacts && typeof primary.targetFacts === 'object'
    ? primary.targetFacts
    : null;
  if (fromLocator) return fromLocator;
  const target = domFacts && domFacts.target && typeof domFacts.target === 'object' ? domFacts.target : null;
  const facts = target || (domFacts && typeof domFacts === 'object' ? domFacts : null);
  if (facts && (facts.role || facts.accessibleName || facts.placeholder || facts.text || facts.selector)) return facts;
  return null;
}

function declaredTargetText(declaredStep) {
  if (!declaredStep || typeof declaredStep !== 'object') return '';
  return clean(
    declaredStep.target || declaredStep.element || declaredStep.name ||
    declaredStep.description || declaredStep.intent || declaredStep.text || ''
  );
}

function argsTargetText(args) {
  if (!args || typeof args !== 'object') return '';
  if (args.element) return clean(args.element);
  if (args.target) return clean(args.target);
  if (args.selector) return clean(args.selector);
  if (args.fields && Array.isArray(args.fields) && args.fields[0]) {
    const f = args.fields[0];
    return clean(f.element || f.label || f.name || f.placeholder || f.target || '');
  }
  return '';
}

function stableContextFromFacts(facts, actionLocator) {
  const context = (actionLocator && actionLocator.context && typeof actionLocator.context === 'object')
    ? actionLocator.context
    : {};
  return {
    formSelector: clean(context.formSelector || facts && facts.formSelector || ''),
    formAction: clean(context.formAction || facts && facts.formAction || ''),
    tableSelector: clean(context.tableSelector || facts && facts.tableSelector || ''),
    rowText: normalizeText(context.rowText || facts && facts.rowText || ''),
    cardText: normalizeText(context.cardText || facts && facts.cardText || ''),
    dialogName: normalizeText(context.dialogName || facts && facts.dialogName || ''),
    landmark: normalizeText(context.landmark || facts && facts.landmark || ''),
    nearbyText: Array.from(new Set([...(context.nearbyText || []), ...(facts && facts.nearbyText || [])]
      .map(normalizeText)
      .filter(Boolean))).slice(0, 5),
  };
}

function actionTypeFor(toolName) {
  return ACTION_TYPE[toolName] || String(toolName || '').replace(/^browser_/, '') || 'action';
}

function elementKeyFromParts(parts) {
  return [
    parts.semantic.role,
    parts.semantic.targetText,
    parts.semantic.placeholder,
    parts.semantic.label,
    parts.semantic.testId,
    parts.semantic.nameAttr,
    parts.context.formSelector,
    parts.context.rowText,
    parts.context.cardText,
  ].map((v) => normalizeText(v)).filter(Boolean).join('|') || 'unknown-element';
}

function buildStepIntentHash({ toolName, args, actionLocator, domFacts, snapshotText, pageUrl, declaredStep, testCaseId } = {}) {
  const actionType = actionTypeFor(toolName);
  const primary = actionLocatorResolver.primaryActionLocator(actionLocator);
  const facts = primaryTargetFacts(actionLocator, domFacts) || {};
  const declaredText = declaredTargetText(declaredStep);
  const argText = argsTargetText(args);
  const targetText = normalizeText(
    facts.accessibleName || facts.placeholder || facts.label || facts.text ||
    primary && primary.elementLabel || declaredText || argText
  );
  const routeKey = routeKeyFromUrl(pageUrl || (primary && primary.pageUrl));
  const parts = {
    version: STEP_INTENT_HASH_VERSION,
    actionType,
    routeKey,
    semantic: {
      targetText,
      declaredTarget: normalizeText(declaredText),
      argTarget: normalizeText(argText),
      role: normalizeText(facts.role),
      placeholder: normalizeText(facts.placeholder),
      label: normalizeText(facts.label),
      testId: normalizeText(facts.testId || facts.testid || facts.dataTestId),
      nameAttr: normalizeText(facts.nameAttr || facts.name),
      title: normalizeText(facts.title),
      alt: normalizeText(facts.alt),
      tag: normalizeText(facts.tag),
      type: normalizeText(facts.type),
    },
    context: stableContextFromFacts(facts, primary),
  };

  // Snapshot is intentionally not serialized into the hash. It is only used as a
  // last-resort source of target text when neither args nor actionLocator had any
  // semantic label; including raw snapshots would make the hash volatile.
  if (!parts.semantic.targetText && snapshotText) {
    const candidates = mcp.parseMcpSnapshotToCandidates(snapshotText || '').slice(0, 1);
    if (candidates[0] && candidates[0].name) parts.semantic.targetText = normalizeText(candidates[0].name);
  }

  parts.elementKey = elementKeyFromParts(parts);
  const canonical = stableStringify(parts);
  return {
    version: STEP_INTENT_HASH_VERSION,
    hash: sha256(canonical),
    parts,
    canonical,
    actionType,
    routeKey,
    testCaseId: testCaseId || '',
    elementKey: parts.elementKey,
    elementLabel: clean(facts.accessibleName || facts.placeholder || declaredText || argText || primary && primary.elementLabel || ''),
  };
}

async function preloadActionMemory({ prisma, projectId, testCaseIds = [], routeKeys = [] } = {}) {
  if (!prisma || !projectId) return [];
  const where = {
    projectId,
    healthScore: { gte: MIN_MEMORY_HEALTH },
    trustState: { not: 'quarantined' },
  };
  const or = [];
  const cleanTc = (testCaseIds || []).filter(Boolean);
  if (cleanTc.length) or.push({ testCaseId: { in: cleanTc } });
  const cleanRoutes = (routeKeys || []).filter(Boolean);
  if (cleanRoutes.length) or.push({ routeKey: { in: cleanRoutes } });
  if (or.length) where.OR = or;
  return prisma.projectActionMemory.findMany({
    where,
    orderBy: [{ trustState: 'desc' }, { healthScore: 'desc' }, { successCount: 'desc' }, { updatedAt: 'desc' }],
    take: 500,
  }).catch(() => []);
}

function memoryExpression(memory) {
  if (!memory) return '';
  const fx = parseJson(memory.frameworkExpressionsJson, null);
  return clean(fx && fx.playwright || memory.selectorExpression || '');
}

function parseLocatorLiteral(expr, method) {
  const m = String(expr || '').match(new RegExp(`${method}\\(\\s*(['"\`])([^'"\`]*)\\1`));
  return m ? m[2] : '';
}

function parseRoleLocator(expr) {
  const s = String(expr || '');
  const role = /getByRole\(\s*(['"`])([^'"`]+)\1/i.exec(s)?.[2] || null;
  const name = /name\s*:\s*(?:new\s+RegExp\()?\s*(['"`])([^'"`]+)\1/i.exec(s)?.[2] || null;
  const regexName = /name\s*:\s*\/([^/]+)\//i.exec(s)?.[1] || null;
  return role ? { role, name: name || regexName } : null;
}

function sameText(a, b) {
  const aa = normalizeText(a);
  const bb = normalizeText(b);
  return !!aa && !!bb && (aa === bb || aa.includes(bb) || bb.includes(aa));
}

function refFromSnapshot(snapshotText, memory) {
  if (!snapshotText || !memory) return null;
  const candidates = mcp.parseMcpSnapshotToCandidates(snapshotText || '');
  if (!candidates.length) return null;
  const expr = memoryExpression(memory);
  const facts = parseJson(memory.targetFactsJson, {}) || {};
  const storedActionLocator = parseJson(memory.actionLocatorJson, null);
  const storedPrimary = actionLocatorResolver.primaryActionLocator(storedActionLocator) || {};
  const storedContext = parseJson(memory.contextJson, {}) || {};
  const expectedFingerprint = storedPrimary.locatorFingerprint || storedPrimary.fingerprint || locatorIntelligenceV2.buildLocatorFingerprint({
    expression: expr,
    strategy: storedPrimary.strategy || '',
    targetFacts: facts,
    context: storedPrimary.context || storedContext,
    pageUrl: memory.pageUrl,
  });
  const fingerprintPick = (pool, strategy, threshold = 60) => {
    const ranked = locatorIntelligenceV2.rankHealingCandidatesByFingerprint(expectedFingerprint, pool, { threshold });
    const top = ranked.find((entry) => entry.candidate && entry.candidate.ref && entry.fingerprintMatch.matched);
    if (!top) return null;
    return {
      ref: top.candidate.ref,
      strategy,
      reason: `fingerprint:${top.fingerprintMatch.score}:${top.fingerprintMatch.reasons.slice(0, 3).join(',')}`,
    };
  };
  const parts = parseJson(memory.stepIntentPartsJson, {}) || {};
  const roleLocator = parseRoleLocator(expr);
  const role = roleLocator && roleLocator.role || facts.role || parts.semantic && parts.semantic.role || null;
  const name = roleLocator && roleLocator.name || facts.accessibleName || facts.placeholder || memory.elementLabel || parts.semantic && parts.semantic.targetText || null;
  const placeholder = parseLocatorLiteral(expr, 'getByPlaceholder') || facts.placeholder || null;
  const label = parseLocatorLiteral(expr, 'getByLabel') || facts.label || null;
  const testId = parseLocatorLiteral(expr, 'getByTestId') || facts.testId || facts.testid || null;
  const text = parseLocatorLiteral(expr, 'getByText') || null;

  const byTestId = testId && candidates.find((c) => String(c.expression || '').includes(testId));
  if (byTestId && byTestId.ref) return { ref: byTestId.ref, strategy: 'memory-testid', reason: testId };

  const placeholderPool = placeholder ? candidates.filter((c) => c.strategy === 'placeholder' && sameText(c.expression, placeholder)) : [];
  const byPlaceholderFingerprinted = fingerprintPick(placeholderPool, 'memory-placeholder-fingerprint', 55);
  if (byPlaceholderFingerprinted) return byPlaceholderFingerprinted;
  const byPlaceholder = placeholderPool[0];
  if (byPlaceholder && byPlaceholder.ref) return { ref: byPlaceholder.ref, strategy: 'memory-placeholder', reason: placeholder };

  const labelPool = label ? candidates.filter((c) => sameText(c.name, label)) : [];
  const byLabelFingerprinted = fingerprintPick(labelPool, 'memory-label-fingerprint', 55);
  if (byLabelFingerprinted) return byLabelFingerprinted;
  const byLabel = labelPool[0];
  if (byLabel && byLabel.ref) return { ref: byLabel.ref, strategy: 'memory-label', reason: label };

  const rolePool = role ? candidates.filter((c) => c.strategy === 'role' && c.role === role && (!name || sameText(c.name, name))) : [];
  const byRoleFingerprinted = fingerprintPick(rolePool, 'memory-role-fingerprint', 55);
  if (byRoleFingerprinted) return byRoleFingerprinted;
  const byRole = rolePool[0];
  if (byRole && byRole.ref) return { ref: byRole.ref, strategy: 'memory-role', reason: `${role}:${name || ''}` };

  const byAnyFingerprint = fingerprintPick(candidates, 'memory-fingerprint', 70);
  if (byAnyFingerprint) return byAnyFingerprint;

  const byName = name && candidates.find((c) => sameText(c.name, name));
  if (byName && byName.ref) return { ref: byName.ref, strategy: 'memory-name', reason: name };

  const byText = text && candidates.find((c) => sameText(c.name, text));
  if (byText && byText.ref) return { ref: byText.ref, strategy: 'memory-text', reason: text };

  return null;
}

function scoreMemory(memory, intent) {
  if (!memory || !intent) return 0;
  let score = 0;
  if (memory.stepIntentHash === intent.hash) score += 100;
  if (memory.routeKey === intent.routeKey) score += 20;
  if (memory.actionType === intent.actionType) score += 20;
  if (sameText(memory.elementKey, intent.elementKey)) score += 20;
  if (sameText(memory.elementLabel, intent.elementLabel)) score += 20;
  const parts = parseJson(memory.stepIntentPartsJson, {}) || {};
  if (sameText(parts.semantic && parts.semantic.targetText, intent.parts.semantic.targetText)) score += 20;
  score += Math.min(20, Math.max(0, Number(memory.successCount || 0) * 4));
  score += Math.min(10, Math.max(0, Number(memory.healthScore || 0) / 10));
  return score;
}

function pickMemory(memories, intent) {
  const candidates = (memories || [])
    .filter((m) => m && (m.healthScore == null || m.healthScore >= MIN_MEMORY_HEALTH) && m.trustState !== 'quarantined')
    .filter((m) => !m.testCaseId || !intent.testCaseId || m.testCaseId === intent.testCaseId)
    .filter((m) => m.actionType === intent.actionType)
    .map((m) => ({ memory: m, score: scoreMemory(m, intent) }))
    .filter((x) => x.score >= 40)
    .sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

async function resolveActionMemory({ memories, snapshotText, pageUrl, currentArgs, toolName, declaredStep, testCaseId } = {}) {
  const intent = buildStepIntentHash({ toolName, args: currentArgs, snapshotText, pageUrl, declaredStep, testCaseId });
  const picked = pickMemory(memories, intent);
  if (!picked) {
    return { status: 'not_found', ref: null, stepIntentHash: intent.hash, reason: 'no matching trusted memory', proof: { pageIdentityScore: 0, count: 0, sameElement: false, visible: false, enabled: false } };
  }
  const { memory, score } = picked;
  const translated = refFromSnapshot(snapshotText, memory);
  if (!translated || !translated.ref) {
    return { status: 'page_changed', ref: null, memoryId: memory.id, stepIntentHash: intent.hash, expression: memoryExpression(memory), reason: 'memory target not present in current snapshot', proof: { pageIdentityScore: score, count: 0, sameElement: false, visible: false, enabled: false } };
  }
  const storedActionLocator = parseJson(memory.actionLocatorJson, null);
  const storedFacts = parseJson(memory.targetFactsJson, null);
  const memoryAnchoredIntent = buildStepIntentHash({
    toolName,
    args: currentArgs,
    actionLocator: storedActionLocator,
    domFacts: storedFacts,
    snapshotText,
    pageUrl,
    declaredStep,
    testCaseId: intent.testCaseId,
  });
  const status = memory.stepIntentHash === intent.hash || memory.stepIntentHash === memoryAnchoredIntent.hash
    ? 'reused'
    : 'drift_repaired';
  return {
    status,
    ref: translated.ref,
    memoryId: memory.id,
    stepIntentHash: intent.hash,
    expression: memoryExpression(memory),
    // Carry the FULL locator this memory was LEARNED with (gold-verified, or unique
    // by construction — see recordActionMemorySuccess). The conductor's memory
    // fast-path dispatches on the remembered ref WITHOUT re-resolving a locator, so
    // without this the replayed action reaches codegen with no export-safe locator
    // and starves the deterministic export (allBlocked → empty Output Files). The
    // gold/KB/verdict gate is untouched — this feeds codegen only.
    actionLocator: storedActionLocator,
    reason: translated.reason,
    proof: {
      pageIdentityScore: score,
      candidateCount: 1,
      count: null,
      sameElement: false,
      actionTimeResolved: false,
      identityVerified: false,
      visible: null,
      enabled: null,
      source: 'project_action_memory_snapshot_translation',
    },
  };
}

function domAtlasPageFromActionLocator(actionLocator) {
  const atlas = actionLocatorResolver.domAtlasFromActionLocator(actionLocator);
  if (!atlas) return null;
  return pageAtlas.normalizeDomAtlasPage(atlas, { pageUrl: atlas.url || null });
}

async function recordActionMemorySuccess({ prisma, projectId, runId, runResultId, testCaseId, scenarioId, module, stepOrdinal, toolName, args, actionLocator, codegenLocator, domFacts, snapshotText, pageUrl, declaredStep } = {}) {
  if (!prisma || !projectId || !toolName || !actionLocatorResolver.MUTATING_ELEMENT_TOOLS.has(toolName)) return null;
  // Gold-verified locators (count=1 + sameElement proof) are remembered as
  // before. Additionally — so custom dropdowns / nameless widgets stop being
  // re-discovered from a fresh snapshot every run — we ALSO remember a NON-gold
  // locator, but ONLY when it carries a UNIQUE identifier (testid, role+
  // accessibleName, label, or an #id CSS). Those are unique by construction, so
  // reusing them cannot cause the ambiguous wrong-element clicks the gold gate
  // guards against. Anything weaker (.first()/.nth(), bare role, getByText,
  // generic CSS) is still NEVER remembered. Non-gold rows enter at a lower
  // health so a single failure quarantines them quickly.
  const goldVerified = actionLocatorResolver.isVerifiedActionLocator(actionLocator);
  let chosen = actionLocator;
  if (!goldVerified) {
    const cand = codegenLocator || actionLocator;
    const cp = actionLocatorResolver.primaryActionLocator(cand);
    const cexpr = cp && (cp.frameworkExpressions && cp.frameworkExpressions.playwright || cp.expression || '');
    const uniqueSignal = !!cexpr
      && actionLocatorResolver.locatorExpressionIsExportSafe(cexpr)
      && !/\.(first|nth|last)\s*\(/.test(cexpr)
      && (
        /getByTestId\s*\(/.test(cexpr)
        || /getByLabel\s*\(/.test(cexpr)
        || (/getByRole\s*\(/.test(cexpr) && /name\s*:/.test(cexpr))
        || /locator\(\s*['"]#[\w-]+/.test(cexpr)
      );
    if (!uniqueSignal) return null;
    chosen = cand;
  }
  const initialHealth = goldVerified ? 100 : 70;
  const primary = actionLocatorResolver.primaryActionLocator(chosen);
  if (!primary) return null;
  const intent = buildStepIntentHash({ toolName, args, actionLocator: chosen, domFacts, snapshotText, pageUrl, declaredStep });
  const facts = primaryTargetFacts(chosen, domFacts) || {};
  const expression = primary.frameworkExpressions && primary.frameworkExpressions.playwright || primary.expression || null;
  if (!expression) return null;
  const locatorFingerprint = locatorIntelligenceV2.buildLocatorFingerprint({
    expression,
    strategy: primary.strategy || '',
    targetFacts: facts,
    context: primary.context || {},
    pageUrl,
  });
  const primaryWithFingerprint = locatorFingerprint
    ? { ...primary, locatorFingerprint }
    : primary;
  const actionType = intent.actionType;
  const routeKey = intent.routeKey;
  const normalizedPageUrl = pageUrl ? String(pageUrl).split(/[?#]/)[0].slice(0, 500) : '';
  const domAtlasPage = domAtlasPageFromActionLocator(chosen);
  const where = {
    projectId_testCaseId_routeKey_actionType_stepIntentHash: {
      projectId,
      testCaseId: testCaseId || '',
      routeKey,
      actionType,
      stepIntentHash: intent.hash,
    },
  };

  const create = {
    projectId,
    testCaseId: testCaseId || '',
    scenarioId: scenarioId || null,
    module: module || null,
    stepOrdinal: Number.isFinite(Number(stepOrdinal)) ? Number(stepOrdinal) : null,
    stepIntentHash: intent.hash,
    stepIntentHashVersion: intent.version,
    stepIntentPartsJson: JSON.stringify(intent.parts),
    routeKey,
    pageUrl: normalizedPageUrl,
    toolName,
    actionType,
    elementKey: intent.elementKey,
    elementLabel: intent.elementLabel || null,
    selectorExpression: expression,
    frameworkExpressionsJson: JSON.stringify(primary.frameworkExpressions || { playwright: expression }),
    actionLocatorJson: JSON.stringify(primaryWithFingerprint),
    targetFactsJson: JSON.stringify(facts),
    contextJson: JSON.stringify(primary.context || {}),
    domAtlasPageJson: domAtlasPage ? JSON.stringify(domAtlasPage) : null,
    successCount: 1,
    failureCount: 0,
    healthScore: initialHealth,
    trustState: 'candidate',
    lastRunId: runId || null,
    lastRunResultId: runResultId || null,
    lastUsedAt: new Date(),
  };
  return prisma.projectActionMemory.upsert({
    where,
    create,
    update: {
      scenarioId: scenarioId || undefined,
      module: module || undefined,
      stepOrdinal: Number.isFinite(Number(stepOrdinal)) ? Number(stepOrdinal) : undefined,
      stepIntentPartsJson: JSON.stringify(intent.parts),
      pageUrl: normalizedPageUrl,
      toolName,
      elementKey: intent.elementKey,
      elementLabel: intent.elementLabel || undefined,
      selectorExpression: expression,
      frameworkExpressionsJson: JSON.stringify(primary.frameworkExpressions || { playwright: expression }),
      actionLocatorJson: JSON.stringify(primaryWithFingerprint),
      targetFactsJson: JSON.stringify(facts),
      contextJson: JSON.stringify(primary.context || {}),
      domAtlasPageJson: domAtlasPage ? JSON.stringify(domAtlasPage) : undefined,
      successCount: { increment: 1 },
      healthScore: 100,
      trustState: 'trusted',
      lastRunId: runId || undefined,
      lastRunResultId: runResultId || undefined,
      lastUsedAt: new Date(),
    },
  }).catch(async (err) => {
    // Prisma compound keys with nullable fields are awkward on older generated
    // clients. Fall back to find/update so memory recording stays best-effort.
    const existing = await prisma.projectActionMemory.findFirst({
      where: { projectId, testCaseId: testCaseId || '', routeKey, actionType, stepIntentHash: intent.hash },
    }).catch(() => null);
    if (!existing) throw err;
    return prisma.projectActionMemory.update({
      where: { id: existing.id },
      data: { ...create, successCount: { increment: 1 }, trustState: 'trusted', lastUsedAt: new Date() },
    });
  });
}

async function recordActionMemoryFailure({ prisma, memoryId, reason } = {}) {
  if (!prisma || !memoryId) return null;
  const existing = await prisma.projectActionMemory.findUnique({ where: { id: memoryId } }).catch(() => null);
  if (!existing) return null;
  const failureCount = (existing.failureCount || 0) + 1;
  const healthScore = Math.max(0, (existing.healthScore == null ? 100 : existing.healthScore) - 15);
  const trustState = healthScore < MIN_MEMORY_HEALTH ? 'quarantined' : 'degraded';
  return prisma.projectActionMemory.update({
    where: { id: memoryId },
    data: { failureCount, healthScore, trustState, lastUsedAt: new Date(), contextJson: existing.contextJson || JSON.stringify({ lastFailureReason: reason || null }) },
  }).catch(() => null);
}

module.exports = {
  STEP_INTENT_HASH_VERSION,
  MIN_MEMORY_HEALTH,
  buildStepIntentHash,
  preloadActionMemory,
  resolveActionMemory,
  recordActionMemorySuccess,
  recordActionMemoryFailure,
  routeKeyFromUrl,
  normalizeText,
  stableStringify,
};
