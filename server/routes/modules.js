'use strict';

const express = require('express');
const prisma = require('../prisma');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { detectProjectModules } = require('../services/moduleIntelligence');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
    select: { id: true, name: true, targetUrl: true },
  });
}

async function safeFindMany(modelName, args, fallback = []) {
  try {
    const model = prisma[modelName];
    if (!model || typeof model.findMany !== 'function') return fallback;
    return await model.findMany(args);
  } catch (_) {
    return fallback;
  }
}

async function loadCurrentScenarios(projectId) {
  const generation = await safeFindMany('scenarioGeneration', {
    where: { projectId, isCurrent: true },
    orderBy: { version: 'desc' },
    take: 1,
    select: { id: true },
  }, []);
  const generationId = generation[0]?.id || null;
  return safeFindMany('testScenario', {
    where: generationId ? { projectId, generationId } : { projectId },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true, module: true },
  }, []);
}

async function loadData(req, projectId) {
  const sprintId = req.query.sprintId ? String(req.query.sprintId) : null;
  const scoped = sprintId ? { projectId, sprintId } : { projectId };
  const documents = await safeFindMany('document', {
    where: scoped,
    orderBy: { uploadedAt: 'desc' },
    select: { id: true, name: true, category: true, content: true, uploadedAt: true },
  }, []);
  const requirementClauses = await safeFindMany('requirementClause', {
    where: scoped,
    orderBy: { createdAt: 'asc' },
    select: { id: true, sourceType: true, behaviourText: true, excerpt: true, sourceDocId: true },
  }, []);
  const testDataSets = await safeFindMany('testDataSet', {
    where: scoped,
    orderBy: { uploadedAt: 'desc' },
    select: { id: true, name: true, rowCount: true, sheetsJson: true, mappingJson: true, uploadedAt: true },
  }, []);
  const scenarios = await loadCurrentScenarios(projectId);
  const calibrations = await safeFindMany('calibration', {
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      module: true,
      authProfileId: true,
      version: true,
      isCurrent: true,
      pagesCount: true,
      startUrl: true,
      status: true,
      staleAt: true,
      completedAt: true,
    },
  }, []);
  return { documents, requirementClauses, testDataSets, scenarios, calibrations };
}

// GET /api/projects/:projectId/modules/preview
// Read-only module discovery for the setup/generation UI. This does not persist
// module choices; it only reports deterministic evidence and counts.
router.get('/preview', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const data = await loadData(req, project.id);
    const preview = detectProjectModules(data);
    res.json({
      success: true,
      project,
      preview,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
