'use strict';

const express = require('express');
const runs = require('../services/runs');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { explainFailure } = require('../services/agents/failureExplainer');
const prisma = require('../prisma');

const router = express.Router();
router.use(requireAuth);
router.use(requireOrg);

function safeExplainFailureError(err) {
  if (err?.code === 'CANCELLED' || err?.status === 499) {
    return {
      status: 499,
      body: { success: false, code: 'CANCELLED', message: 'Explanation generation was cancelled.' },
    };
  }

  const raw = String(err?.message || '');
  const schemaStale = /Unknown field|Invalid `prisma\.|Available options are marked|Unknown argument/i.test(raw);
  if (schemaStale) {
    return {
      status: 503,
      body: {
        success: false,
        code: 'EXPLANATION_SCHEMA_STALE',
        message: 'AI explanation is temporarily unavailable while the backend schema catches up. The verdict evidence below is still valid.',
      },
    };
  }

  const status = err?.status && err.status < 500 ? err.status : 503;
  return {
    status,
    body: {
      success: false,
      code: err?.code || 'EXPLANATION_UNAVAILABLE',
      message: status === 403
        ? 'You do not have access to this result.'
        : 'AI explanation is temporarily unavailable. The verdict evidence below is still valid.',
    },
  };
}

async function readCachedFailureExplanation(runResultId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT failureExplanation FROM "RunResult" WHERE id = ?',
      runResultId
    );
    const cached = rows[0];
    if (!cached?.failureExplanation) return null;
    return JSON.parse(cached.failureExplanation);
  } catch (_) {
    return null;
  }
}

// ── POST /api/runs ────────────────────────────────────────
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const { projectId, testCaseIds } = req.body || {};
    if (!projectId || !Array.isArray(testCaseIds) || !testCaseIds.length) {
      return res
        .status(400)
        .json({ success: false, code: 'MISSING_FIELDS', message: 'projectId and testCaseIds required' });
    }
    // Compatibility alias only. Live browser execution has one authority:
    // the Conductor selected-case route. A 307 keeps the POST body (including
    // generationId, sprintId and runMode) intact for same-origin clients and
    // prevents this legacy endpoint from invoking the alternate worker directly.
    res.set('Cache-Control', 'no-store');
    res.set('X-QAAI-Execution-Authority', 'conductor');
    return res.redirect(
      307,
      `/api/projects/${encodeURIComponent(projectId)}/agents/run-smoke`,
    );
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
      req.query.generationId || null,
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

// ── DELETE /api/runs/:id ──────────────────────────────────
// User-initiated cleanup of a Run from the Reports page. Org-scoped:
// the run must belong to a project in the caller's org. RunResult rows
// cascade via the FK in schema.prisma.
// ── POST /api/runs/results/:resultId/explain-failure ─────────────────────────
// Generates or returns a cached AI explanation for why a specific RunResult
// failed. The explanation is stored on the RunResult so subsequent opens don't
// re-call the LLM. Force-regenerate by passing ?refresh=1.
router.post('/results/:resultId/explain-failure', requireCsrf, async (req, res, next) => {
  try {
    const result = await prisma.runResult.findFirst({
      where: { id: req.params.resultId },
      select: {
        id: true,
        status: true,
        run: { select: { projectId: true, project: { select: { orgId: true } } } },
      },
    });
    if (!result) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    // Verify the user has access to this result's project via org scoping
    if (result.run?.project?.orgId !== req.org.id) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN' });
    }
    const projectId = result.run?.projectId;
    if (!projectId) return res.status(404).json({ success: false, code: 'RUN_NOT_FOUND' });

    const refresh = req.query.refresh === '1';
    if (!refresh) {
      const cached = await readCachedFailureExplanation(result.id);
      if (cached) return res.json({ success: true, explanation: cached, cached: true });
    }

    const explanation = await explainFailure({
      runResultId: result.id,
      projectId,
      userId: req.user.id,
      signal: req.signal,
    });
    res.json({ success: true, explanation, cached: false });
  } catch (err) {
    const safe = safeExplainFailureError(err);
    if (safe) return res.status(safe.status).json(safe.body);
    next(err);
  }
});

router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const result = await runs.deleteRun(req.user.id, req.params.id, req.org.id);
    if (!result.deleted) {
      if (result.code === 'NOT_FOUND') {
        return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      }
      if (result.code === 'RUN_IN_PROGRESS') {
        return res.status(409).json({
          success: false,
          code: 'RUN_IN_PROGRESS',
          message: 'This run is still in progress. Cancel it from Live Pipeline before deleting.',
        });
      }
      return res.status(400).json({ success: false, code: result.code || 'DELETE_FAILED' });
    }
    try {
      audit?.log?.({ userId: req.user.id, orgId: req.org.id, action: 'run.delete', entityId: req.params.id });
    } catch (_) { /* audit failures shouldn't fail the delete */ }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
