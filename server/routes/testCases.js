'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const generator = require('../services/testGenerator');
const integrations = require('../services/integrations');
const runsService = require('../services/runs');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

// ── GET /api/projects/:projectId/test-cases ───────────────
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const testCases = await prisma.testCase.findMany({
      where: { projectId: project.id },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ success: true, testCases });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/generate ─────
router.post(
  '/generate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { requirementIds, replace } = req.body || {};
      const where = { projectId: project.id };
      if (Array.isArray(requirementIds) && requirementIds.length) {
        where.id = { in: requirementIds };
      }
      const requirements = await prisma.requirement.findMany({ where });
      if (!requirements.length) {
        return res.status(400).json({
          success: false,
          code: 'NO_REQUIREMENTS',
          message: 'No requirements available. Upload documents or pull from ADO/Jira first.',
        });
      }

      const integration = await integrations.get(req.user.id, 'claude');
      const apiKey = await vault.get(req.user.id, 'claude.apiKey');
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false,
          code: 'CLAUDE_NOT_CONFIGURED',
          message: 'Claude API key not configured. Visit Settings → Claude API.',
        });
      }

      let result;
      try {
        result = await generator.generate({
          apiKey,
          model: integration.config?.model || 'claude-sonnet-4-6',
          requirements,
        });
      } catch (err) {
        return res.status(err.status || 502).json({
          success: false,
          code: err.code || 'GENERATION_FAILED',
          message: err.message,
        });
      }

      if (replace) {
        // Wipe ALL prior TCs so dashboards never see scenario-less orphans
        // (status='running'/'rejected' would otherwise survive a regen and
        // diverge from the Test Cases page count).
        await prisma.testCase.deleteMany({ where: { projectId: project.id } });
      }

      const created = [];
      for (const tc of result.cases) {
        const row = await prisma.testCase.create({
          data: {
            projectId: project.id,
            name: tc.name,
            type: tc.type,
            module: tc.module,
            confidence: tc.confidence,
            assertions: tc.assertions,
            status: 'pending',
          },
        });
        created.push(row);
      }

      await audit.log({
        userId: req.user.id,
        action: 'test-cases.generate',
        target: project.id,
        metadata: { count: created.length, requirementCount: requirements.length },
        req,
      });

      res.json({ success: true, testCases: created, generated: created.length });
    } catch (err) {
      next(err);
    }
  }
);

// ── PUT /api/projects/:projectId/test-cases/:tcId ─────────
router.put('/:tcId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { name, type, module, confidence, assertions, status, userGuidance } = req.body || {};
    const data = {};
    if (typeof name === 'string') data.name = name.slice(0, 200);
    if (type) data.type = type;
    if (module) data.module = String(module).toLowerCase();
    if (typeof confidence === 'number') data.confidence = Math.max(0, Math.min(100, confidence));
    if (typeof assertions === 'string') data.assertions = assertions;
    if (status && ['pending', 'approved', 'rejected'].includes(status)) data.status = status;
    // userGuidance: free-form notes the user wants Conductor/Critic/Supervisor
    // to honour on future runs of THIS case. Accept '' to clear; cap length so
    // a runaway editor can't bloat the row.
    if (typeof userGuidance === 'string') {
      if (userGuidance.length > 4000) {
        return res.status(400).json({ success: false, code: 'TOO_LONG', message: 'Per-case guidance is capped at 4,000 characters.' });
      }
      const trimmed = userGuidance.trim();
      data.userGuidance = trimmed || null;
    }

    const tc = await prisma.testCase.update({ where: { id: existing.id }, data });
    res.json({ success: true, testCase: tc });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/approve-all ──
router.post('/approve-all', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const result = await prisma.testCase.updateMany({
      where: { projectId: project.id, status: 'pending' },
      data: { status: 'approved' },
    });
    res.json({ success: true, updated: result.count });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/bulk-update ──
// Replaces the previous "approve impacted" pattern that did one PUT per case
// (50 cases = 50 sequential round-trips + frozen UI + torn state on mid-loop
// failure). One request, one updateMany, atomic.
router.post('/bulk-update', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({
        success: false, code: 'MISSING_IDS',
        message: 'ids[] is required.',
      });
    }
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false, code: 'INVALID_STATUS',
        message: 'status must be one of pending, approved, rejected.',
      });
    }
    const result = await prisma.testCase.updateMany({
      where: { projectId: project.id, id: { in: ids } },
      data: { status },
    });
    res.json({ success: true, updated: result.count });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/test-cases/:tcId/history ──
// Compact per-test history across runs — powers the Reports detail pane's
// sparkline + flaky score. Read-only, no CSRF needed.
router.get('/:tcId/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    const data = await runsService.getTestCaseHistory(
      req.user.id, req.params.projectId, req.params.tcId, limit
    );
    res.json({ success: true, ...data });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    next(err);
  }
});

// ── DELETE /api/projects/:projectId/test-cases/:tcId ──────
router.delete('/:tcId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.testCase.deleteMany({
      where: { id: req.params.tcId, projectId: project.id },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
