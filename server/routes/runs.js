'use strict';

const express = require('express');
const runs = require('../services/runs');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router();
router.use(requireAuth);
router.use(requireOrg);

// ── POST /api/runs ────────────────────────────────────────
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const { projectId, testCaseIds, sprintName, sprintId } = req.body || {};
    if (!projectId || !Array.isArray(testCaseIds) || !testCaseIds.length) {
      return res
        .status(400)
        .json({ success: false, code: 'MISSING_FIELDS', message: 'projectId and testCaseIds required' });
    }
    const broadcast = req.app.locals.broadcastToUser;
    const send = (msg) => broadcast && broadcast(req.user.id, msg);

    try {
      const { run } = await runs.startRun({
        userId: req.user.id,
        orgId: req.org.id,
        projectId,
        testCaseIds,
        sprintName,
        sprintId,
        send,
      });
      res.status(202).json({ success: true, runId: run.id, status: run.status });
    } catch (err) {
      return res
        .status(err.status || 500)
        .json({ success: false, code: err.code || 'RUN_FAILED', message: err.message });
    }
  } catch (err) {
    next(err);
  }
});

// ── GET /api/runs ─────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const list = await runs.listRuns(
      req.user.id,
      req.query.projectId,
      parseInt(req.query.limit || '50', 10),
      req.query.sprintId || null,
      req.org.id,
    );
    res.json({ success: true, runs: list });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/runs/compare?a=&b= ──────────────────────────
// Note: this route MUST be declared before the `/:id` route below — Express
// matches in declaration order, and `/:id` would otherwise swallow `/compare`.
router.get('/compare', async (req, res, next) => {
  try {
    const { a, b } = req.query || {};
    if (!a || !b) {
      return res.status(400).json({ success: false, code: 'MISSING_FIELDS', message: 'Both ?a= and ?b= run ids are required.' });
    }
    const result = await runs.compareRuns(req.user.id, a, b, req.org.id);
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    next(err);
  }
});

// ── GET /api/runs/:id ─────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const run = await runs.getRun(req.user.id, req.params.id, req.org.id);
    if (!run) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    res.json({ success: true, run });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
