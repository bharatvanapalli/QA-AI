'use strict';

const express = require('express');
const prisma = require('../prisma');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { runCalibrator } = require('../services/agents/calibrator');
const cancelRegistry = require('../services/cancelRegistry');
const crawlPlanner = require('../lib/crawlPlanner');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

// GET /api/projects/:projectId/calibrations — list calibrations (newest first)
router.get('/', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const calibrations = await prisma.calibration.findMany({
      where: {
        projectId,
        ...(req.query.module ? { module: String(req.query.module) } : {}),
        ...(req.query.authProfileId ? { authProfileId: String(req.query.authProfileId) } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true, status: true, startUrl: true, pagesCount: true, errorMessage: true,
        createdAt: true, completedAt: true, module: true, authProfileId: true,
        version: true, isCurrent: true, staleAt: true,
      },
    });
    res.json(calibrations);
  } catch (err) { next(err); }
});

// POST /api/projects/:projectId/calibrations — start a calibration run
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { startUrl, maxPages, module, authProfileId, crawlScope } = req.body || {};
    // Safe default: the requested page and its main-content destinations.
    // Whole-site/global-navigation discovery requires crawlScope: "site".
    const resolvedCrawlScope = crawlPlanner.resolveCrawlScope(crawlScope);
    // P3b — Focus-first: the caller names which module (+ identity) this slice
    // covers. Both optional; null = legacy whole-app / role-agnostic slice.
    const sliceModule = (typeof module === 'string' && module.trim()) ? module.trim() : null;
    const sliceAuthProfileId = (typeof authProfileId === 'string' && authProfileId.trim()) ? authProfileId.trim() : null;

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true, targetUrl: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const resolvedUrl = startUrl || project.targetUrl;
    if (!resolvedUrl) return res.status(400).json({ error: 'startUrl is required (or set a targetUrl on the project)' });

    // Create the Calibration row. Slice fields are written on the rich attempt
    // only; a pre-regen client (columns unknown until the next restart) falls
    // back to the base create so calibration still starts.
    let calibration;
    try {
      calibration = await prisma.calibration.create({
        data: { projectId, startUrl: resolvedUrl, status: 'running', module: sliceModule, authProfileId: sliceAuthProfileId },
        select: { id: true, startUrl: true, status: true, createdAt: true },
      });
    } catch (_) {
      calibration = await prisma.calibration.create({
        data: { projectId, startUrl: resolvedUrl, status: 'running' },
        select: { id: true, startUrl: true, status: true, createdAt: true },
      });
    }

    // Run in background — response returns immediately with calibrationId
    const userId = req.user.id;
    const { signal, cancel } = cancelRegistry.create(userId + ':calibrator');

    setImmediate(async () => {
      try {
        await runCalibrator({
          projectId,
          userId,
          calibrationId: calibration.id,
          startUrl: resolvedUrl,
          maxPages: typeof maxPages === 'number' ? Math.min(maxPages, 500) : undefined,
          module: sliceModule,
          authProfileId: sliceAuthProfileId,
          crawlScope: resolvedCrawlScope,
          signal,
        });
      } catch (err) {
        console.error('[calibrator] background run failed:', err.message);
      } finally {
        cancelRegistry.clear(userId + ':calibrator');
      }
    });

    res.status(201).json(calibration);
  } catch (err) { next(err); }
});

// DELETE /api/projects/:projectId/calibrations/:calibrationId — cancel + delete
router.delete('/:calibrationId', requireCsrf, async (req, res, next) => {
  try {
    const { projectId, calibrationId } = req.params;
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Cancel if running
    cancelRegistry.cancel(req.user.id + ':calibrator');

    await prisma.calibration.deleteMany({ where: { id: calibrationId, projectId } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
