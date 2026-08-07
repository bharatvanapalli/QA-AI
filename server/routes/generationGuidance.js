'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const generationGuidance = require('../services/generationGuidance');
const { decodeJson } = require('../services/jsonField');
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
    select: { id: true },
  });
}

function serialize(row) {
  if (!row) return row;
  return {
    ...row,
    quickIntents: decodeJson(row.quickIntentsJson, []),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const where = { projectId: project.id };
    if (req.query.scope) where.scope = String(req.query.scope);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.generationId) where.generationId = String(req.query.generationId);
    if (req.query.scenarioId) where.scenarioId = String(req.query.scenarioId);
    if (req.query.testCaseId) where.testCaseId = String(req.query.testCaseId);
    const guidance = await prisma.generationGuidance.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit) || 20, 100),
    });
    res.json({ success: true, guidance: guidance.map(serialize) });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 60 }),
  async (req, res, next) => {
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      const guidance = await generationGuidance.createGuidance(prisma, {
        projectId: project.id,
        userId: req.user.id,
        sprintId: req.body?.sprintId || null,
        generationId: req.body?.generationId || null,
        scenarioId: req.body?.scenarioId || null,
        testCaseId: req.body?.testCaseId || null,
        scope: req.body?.scope || 'suite',
        sourceSurface: req.body?.sourceSurface || null,
        instruction: req.body?.instruction || '',
        quickIntents: req.body?.quickIntents || [],
        subject: req.body?.subject || null,
      });
      await audit.log({
        userId: req.user.id,
        action: 'generationGuidance.create',
        target: project.id,
        metadata: { guidanceId: guidance.id, scope: guidance.scope, sourceSurface: guidance.sourceSurface },
        req,
      });
      res.json({ success: true, guidance: serialize(guidance) });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
      next(err);
    }
  },
);

router.post('/:id/reject', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.generationGuidance.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const guidance = await prisma.generationGuidance.update({
      where: { id: existing.id },
      data: { status: 'rejected' },
    });
    res.json({ success: true, guidance: serialize(guidance) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
