'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const analyst = require('../services/agents/analyst');
const cancelRegistry = require('../services/cancelRegistry');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

// ── PUT /api/projects/:projectId/documents/:id/category ─────
// User can correct the auto-detected category in the UI.
router.put('/documents/:id/category', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { category } = req.body || {};
    const valid = ['brd', 'user-stories', 'release-notes', 'api-spec', 'other'];
    if (!valid.includes(category)) {
      return res.status(400).json({ success: false, code: 'INVALID_CATEGORY' });
    }
    const doc = await prisma.document.updateMany({
      where: { id: req.params.id, projectId: project.id },
      data: { category },
    });
    // Mirror onto requirements that reference this doc
    await prisma.requirement.updateMany({
      where: { projectId: project.id, sourceIdentifier: { equals: (await prisma.document.findUnique({ where: { id: req.params.id }, select: { name: true } }))?.name } },
      data: { category },
    });
    res.json({ success: true, updated: doc.count });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/analyst/detect-discrepancies ──
router.post(
  '/analyst/detect-discrepancies',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured.`,
        });
      }
      const docs = await prisma.document.findMany({ where: { projectId: project.id } });
      if (docs.length < 2) {
        return res.status(400).json({
          success: false, code: 'INSUFFICIENT_DOCS',
          message: 'Need at least 2 documents (ideally a BRD and a release-notes doc) to detect discrepancies.',
        });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);
      const onLog = async (level, message) => send({ type: 'agent.phase.log', phase: 'analyst', level, message });
      const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

      send({ type: 'agent.phase.start', phase: 'analyst', label: 'Document Analyst' });
      const cancelToken = cancelRegistry.create(req.user.id);
      let result;
      try {
        result = await analyst.detectDiscrepancies({
          apiKey, model, provider,
          documents: docs, onLog, onRateLimit, signal: cancelToken.signal,
          extraGuidance: project.aiGuidance || null,
        });
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        send({ type: 'agent.phase.complete', phase: 'analyst', error: cancelled ? 'cancelled' : err.message, cancelled });
        if (cancelled) return res.status(499).json({ success: false, code: 'CANCELLED', message: 'Detection cancelled by user.' });
        return res.status(err.status || 502).json({
          success: false, code: err.code || 'ANALYST_FAILED', message: err.message,
        });
      }
      cancelRegistry.clear(req.user.id);

      // Wipe any prior unresolved discrepancies and replace with the new set
      await prisma.discrepancy.deleteMany({ where: { projectId: project.id, resolved: false } });
      const created = [];
      for (const d of result.discrepancies) {
        const row = await prisma.discrepancy.create({
          data: { projectId: project.id, kind: d.kind, summary: d.summary, detail: d.detail, severity: d.severity },
        });
        created.push(row);
      }

      await audit.log({
        userId: req.user.id, action: 'analyst.discrepancies',
        target: project.id, metadata: { count: created.length }, req,
      });
      res.json({ success: true, discrepancies: created });
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/projects/:projectId/discrepancies ──────────────
router.get('/discrepancies', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const items = await prisma.discrepancy.findMany({
      where: { projectId: project.id, resolved: false },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    });
    res.json({ success: true, discrepancies: items });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/discrepancies/:id/resolve ──
router.post('/discrepancies/:id/resolve', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.discrepancy.updateMany({
      where: { id: req.params.id, projectId: project.id },
      data: { resolved: true, resolvedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/analyst/select-impacted ───
// Marks scenarios as impacted based on the latest release-notes documents.
router.post(
  '/analyst/select-impacted',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const integration = await integrations.get(req.user.id, 'claude');
      const apiKey = await vault.get(req.user.id, 'claude.apiKey');
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({ success: false, code: 'CLAUDE_NOT_CONFIGURED' });
      }

      const scenarios = await prisma.testScenario.findMany({ where: { projectId: project.id } });
      if (!scenarios.length) {
        return res.status(400).json({
          success: false, code: 'NO_SCENARIOS',
          message: 'Generate scenarios first.',
        });
      }
      const releaseDocs = await prisma.document.findMany({
        where: { projectId: project.id, category: 'release-notes' },
      });
      const releaseNotesText = releaseDocs.map((d) => d.content).join('\n\n').trim();

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);
      const onLog = async (level, message) => send({ type: 'agent.phase.log', phase: 'analyst', level, message });
      const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

      send({ type: 'agent.phase.start', phase: 'analyst', label: 'Smart Selection' });
      const cancelToken = cancelRegistry.create(req.user.id);
      let result;
      try {
        result = await analyst.selectImpactedScenarios({
          apiKey, model, provider,
          scenarios, releaseNotesText, onLog, onRateLimit, signal: cancelToken.signal,
          extraGuidance: project.aiGuidance || null,
        });
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        send({ type: 'agent.phase.complete', phase: 'analyst', error: cancelled ? 'cancelled' : err.message, cancelled });
        if (cancelled) return res.status(499).json({ success: false, code: 'CANCELLED', message: 'Smart selection cancelled by user.' });
        return res.status(err.status || 502).json({ success: false, code: err.code, message: err.message });
      }
      cancelRegistry.clear(req.user.id);

      // No-release-notes early return — service signals via `result.code`.
      // We don't touch DB flags (preserves any prior impacted markings from
      // a real run) and surface a structured 400 so the UI can render a
      // "upload release notes" banner instead of "20 scenarios impacted".
      if (result.code === 'NO_RELEASE_NOTES') {
        send({ type: 'agent.phase.complete', phase: 'analyst', output: { impacted: 0, code: 'NO_RELEASE_NOTES' } });
        return res.status(400).json({
          success: false, code: 'NO_RELEASE_NOTES',
          message: 'Upload a release-notes document before running Smart selection. Impact analysis needs something to compare scenarios against.',
        });
      }

      // Clear previous flags
      await prisma.testScenario.updateMany({
        where: { projectId: project.id },
        data: { impacted: false, impactReason: null },
      });
      // Mark impacted
      const impactedIds = new Set(result.impacted.map((i) => i.id));
      for (const i of result.impacted) {
        await prisma.testScenario.updateMany({
          where: { id: i.id, projectId: project.id },
          data: { impacted: true, impactReason: i.reason },
        });
      }

      await audit.log({
        userId: req.user.id, action: 'analyst.select-impacted',
        target: project.id,
        metadata: { impacted: impactedIds.size, total: scenarios.length }, req,
      });
      res.json({
        success: true,
        impacted: result.impacted.length,
        total: scenarios.length,
        details: result.impacted,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
