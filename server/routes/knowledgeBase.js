'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const mcp = require('../services/mcp');
const healer = require('../services/agents/healer');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const HEAL_BUMP = 5;
const FAIL_HIT  = 20;

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

function appendHealHistory(prevJson, entry) {
  let arr = [];
  if (prevJson) {
    try { arr = JSON.parse(prevJson); } catch (_) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
  }
  arr.push(entry);
  if (arr.length > 50) arr = arr.slice(-50);
  return JSON.stringify(arr);
}

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

router.get('/', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const locators = await prisma.knowledgeBaseLocator.findMany({
      where: { projectId: project.id },
      orderBy: [{ healthScore: 'asc' }, { occurrences: 'desc' }],
    });
    res.json({ success: true, locators });
  } catch (err) {
    next(err);
  }
});

router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { element, selector, strategy, healthScore } = req.body || {};
    if (!element || !selector)
      return res
        .status(400)
        .json({ success: false, code: 'MISSING_FIELDS', message: 'element and selector required' });

    const existing = await prisma.knowledgeBaseLocator.findUnique({
      where: { projectId_element: { projectId: project.id, element } },
    });
    const row = existing
      ? await prisma.knowledgeBaseLocator.update({
          where: { id: existing.id },
          data: {
            selector,
            strategy: strategy || existing.strategy,
            healthScore: typeof healthScore === 'number' ? healthScore : existing.healthScore,
            lastHealedAt: new Date(),
            occurrences: existing.occurrences + 1,
          },
        })
      : await prisma.knowledgeBaseLocator.create({
          data: {
            projectId: project.id,
            element,
            selector,
            strategy: strategy || null,
            healthScore: typeof healthScore === 'number' ? healthScore : 100,
          },
        });
    await audit.log({
      userId: req.user.id,
      action: 'kb.upsert',
      target: row.id,
      metadata: { element },
      req,
    });
    res.json({ success: true, locator: row });
  } catch (err) {
    next(err);
  }
});

// ── Phase E1.4 — manual heal trigger ─────────────────────────────────
// Launches a fresh MCP session, navigates to the locator's `pageUrl` (or
// project's default targetUrl as fallback), takes a snapshot, and asks the
// healer to propose a new selector. The result is persisted into
// `healHistory` and the row's selector / healthScore are updated when the
// healer's confidence is high enough. The user sees the healer's proposal
// inline and can accept/test from the UI.
//
// Rate-limited (3/min/user) — each call spawns Chromium and burns a Claude
// call; clicking the button repeatedly should be cheap-but-not-free.
router.post(
  '/:id/heal-now',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 3 }),
  async (req, res, next) => {
    let mcpSession = null;
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const locator = await prisma.knowledgeBaseLocator.findFirst({
        where: { id: req.params.id, projectId: project.id },
      });
      if (!locator) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      const startUrl = locator.pageUrl || project.targetUrl;
      if (!startUrl) {
        return res.status(400).json({
          success: false, code: 'NO_PAGE_URL',
          message: 'Locator has no pageUrl and project has no default target URL. Set one before healing manually.',
        });
      }

      try {
        mcpSession = await mcp.startMcpSession({
          userId: req.user.id,
          targetUrl: startUrl,
          broadcast: () => {}, // standalone session; no Theater stream
          // E10.5 — heal-now uses the project's browser context too, so
          // the locator we capture reflects the same browser conditions
          // the actual run will see (locale, geo, auth, etc).
          project,
        });
      } catch (mcpErr) {
        return res.status(503).json({
          success: false, code: 'MCP_UNAVAILABLE',
          message: `Couldn't start a Chromium session: ${mcpErr.message}`,
        });
      }

      const snapRes = await mcp.snapshot(mcpSession);
      const freshSnapshot = snapRes?.text || '';
      if (!freshSnapshot.trim()) {
        await mcp.stopMcpSession(mcpSession);
        return res.status(502).json({
          success: false, code: 'EMPTY_SNAPSHOT',
          message: 'MCP returned an empty snapshot — page may have failed to load.',
        });
      }

      let history = [];
      if (locator.healHistory) {
        try { history = JSON.parse(locator.healHistory) || []; } catch (_) {}
      }

      let healed = null;
      try {
        healed = await healer.healLocator({
          apiKey, model, provider,
          intent: locator.intent || locator.element,
          brokenLocator: locator.selector,
          brokenStrategy: locator.strategy,
          freshSnapshot,
          history,
        });
      } catch (healErr) {
        await mcp.stopMcpSession(mcpSession);
        return res.status(502).json({ success: false, code: 'HEALER_FAILED', message: healErr.message });
      }

      await mcp.stopMcpSession(mcpSession);
      mcpSession = null;

      if (!healed) {
        const updated = await prisma.knowledgeBaseLocator.update({
          where: { id: locator.id },
          data: {
            failureCount: (locator.failureCount || 0) + 1,
            lastFailedAt: new Date(),
            healthScore: Math.max(0, (locator.healthScore ?? 100) - FAIL_HIT),
            healHistory: appendHealHistory(locator.healHistory, {
              ts: new Date().toISOString(),
              oldSelector: locator.selector,
              newSelector: null,
              strategy: null,
              confidence: 0,
              reason: 'Healer returned no proposal.',
              outcome: 'failed',
              source: 'manual',
            }),
          },
        });
        await audit.log({
          userId: req.user.id, action: 'kb.heal_now.no_proposal',
          target: locator.id, metadata: { element: locator.element }, req,
        });
        return res.json({ success: true, healed: null, locator: updated });
      }

      const selectorStr = typeof healed.selector === 'string'
        ? healed.selector
        : JSON.stringify(healed.selector || {});
      const outcome = healed.confidence >= 70 ? 'success' : 'low_confidence';
      const nextHistory = appendHealHistory(locator.healHistory, {
        ts: new Date().toISOString(),
        oldSelector: locator.selector,
        newSelector: selectorStr,
        strategy: healed.strategy,
        confidence: healed.confidence,
        reason: healed.reasoning,
        outcome,
        source: 'manual',
      });

      // For manual heals we DON'T auto-promote the selector — the operator
      // should review and re-test before the locator becomes load-bearing.
      // We update healHistory and stamp lastHealedAt; selector + healthScore
      // tick up only when confidence is high.
      const updated = await prisma.knowledgeBaseLocator.update({
        where: { id: locator.id },
        data: {
          healHistory: nextHistory,
          lastHealedAt: new Date(),
          ...(healed.confidence >= 70
            ? {
                selector: selectorStr,
                strategy: healed.strategy,
                healthScore: Math.min(100, (locator.healthScore ?? 0) + HEAL_BUMP),
                failureCount: Math.max(0, (locator.failureCount || 0) - 1),
              }
            : {}),
        },
      });

      await audit.log({
        userId: req.user.id, action: 'kb.heal_now',
        target: locator.id,
        metadata: { element: locator.element, strategy: healed.strategy, confidence: healed.confidence, outcome },
        req,
      });

      res.json({
        success: true,
        healed: { ...healed, selector: selectorStr },
        locator: updated,
      });
    } catch (err) {
      if (mcpSession) {
        try { await mcp.stopMcpSession(mcpSession); } catch (_) {}
      }
      next(err);
    }
  },
);

router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.knowledgeBaseLocator.deleteMany({
      where: { id: req.params.id, projectId: project.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
