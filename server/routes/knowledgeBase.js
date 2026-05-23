'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, userId: req.user.id },
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
