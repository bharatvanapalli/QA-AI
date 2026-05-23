'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const lintGates = require('../services/lintGates');
const { encodeJson, decodeJson } = require('../services/jsonField');

function inflate(pr) {
  if (!pr) return pr;
  return { ...pr, lintFindings: decodeJson(pr.lintFindings, []) || [] };
}
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
    const prs = await prisma.governancePR.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'desc' },
      include: {
        // Pull test-case name for context
      },
    });
    res.json({ success: true, prs: prs.map(inflate) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!pr) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.update({
      where: { id: req.params.id },
      data: { status: 'approved', reviewer: req.user.email, reviewedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.approve',
      target: pr.id,
      req,
    });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/merge', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (existing.status !== 'approved') {
      return res.status(400).json({
        success: false,
        code: 'NOT_APPROVED',
        message: 'PR must be approved before merging.',
      });
    }
    if (!existing.lintPassed) {
      return res.status(400).json({
        success: false,
        code: 'LINT_FAILED',
        message: 'Cannot merge a PR with lint errors. Re-generate the test or fix the spec.',
      });
    }
    const pr = await prisma.governancePR.update({
      where: { id: existing.id },
      data: { status: 'merged', reviewedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.merge',
      target: pr.id,
      req,
    });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/lint', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.governancePR.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const lint = lintGates.lint(existing.specCode || '');
    const pr = await prisma.governancePR.update({
      where: { id: existing.id },
      data: { lintPassed: lint.lintPassed, lintFindings: encodeJson(lint.findings) },
    });
    res.json({
      success: true,
      pr: inflate(pr),
      lint: {
        passed: lint.lintPassed,
        errorCount: lint.errorCount,
        warningCount: lint.warningCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pr = await prisma.governancePR.update({
      where: { id: req.params.id },
      data: { status: 'rejected', reviewer: req.user.email, reviewedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'governance.reject',
      target: pr.id,
      req,
    });
    res.json({ success: true, pr: inflate(pr) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
