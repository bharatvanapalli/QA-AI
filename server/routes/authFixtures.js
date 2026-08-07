'use strict';

const express = require('express');
const prisma = require('../prisma');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

// GET /api/projects/:projectId/auth-fixtures
router.get('/', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const fixtures = await prisma.authFixture.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, name: true, environment: true, notes: true,
        validUntil: true, createdAt: true, updatedAt: true,
        // storageState intentionally omitted from list — it can be large
      },
    });
    res.json(fixtures);
  } catch (err) { next(err); }
});

// POST /api/projects/:projectId/auth-fixtures
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { name, storageState, environment = 'default', notes, validUntil } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!storageState || typeof storageState !== 'string') {
      return res.status(400).json({ error: 'storageState JSON string is required' });
    }
    // Validate storageState is parseable JSON
    try { JSON.parse(storageState); } catch {
      return res.status(400).json({ error: 'storageState must be valid JSON' });
    }

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const fixture = await prisma.authFixture.create({
      data: {
        projectId,
        name: name.trim(),
        storageState,
        environment: environment || 'default',
        notes: notes || null,
        validUntil: validUntil ? new Date(validUntil) : null,
        updatedAt: new Date(),
      },
      select: {
        id: true, name: true, environment: true, notes: true,
        validUntil: true, createdAt: true, updatedAt: true,
      },
    });
    res.status(201).json(fixture);
  } catch (err) { next(err); }
});

// DELETE /api/projects/:projectId/auth-fixtures/:fixtureId
router.delete('/:fixtureId', requireCsrf, async (req, res, next) => {
  try {
    const { projectId, fixtureId } = req.params;
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const deleted = await prisma.authFixture.deleteMany({
      where: { id: fixtureId, projectId },
    });
    if (deleted.count === 0) return res.status(404).json({ error: 'Fixture not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
