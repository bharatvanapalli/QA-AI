'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { decodeArray } = require('../services/jsonField');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, userId: req.user.id },
  });
}

/**
 * GET /api/projects/:projectId/blocked?scope=latest|all
 *
 * `scope=latest` (default) returns only blockers from the most recent run,
 * so users don't see a 47-deep history that mixes successful runs with old
 * failed ones. `scope=all` shows every unresolved row across history.
 *
 * Response items are enriched with the parent TestCase + Scenario so the
 * UI can show meaningful titles instead of "UNKNOWN", and with the first
 * RunResult screenshot when available so users have visual context.
 */
router.get('/', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const scope = (req.query.scope === 'all') ? 'all' : 'latest';

    // Find the most recent run id to scope by (latest scope only). Falls
    // back to "all" semantics if there are no runs yet.
    let latestRunId = null;
    if (scope === 'latest') {
      const latest = await prisma.run.findFirst({
        where: { projectId: project.id },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      latestRunId = latest?.id || null;
    }

    const where = {
      projectId: project.id,
      resolved: false,
      ...(scope === 'latest' && latestRunId ? { runId: latestRunId } : {}),
    };

    const items = await prisma.blockedItem.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    // Hydrate each item with TC + scenario in two batched queries so we
    // don't N+1 the database. RunResult lookup is also batched per (runId,
    // testCaseId) pair to pull the first screenshot.
    const tcIds = Array.from(new Set(items.map((i) => i.testCaseId).filter(Boolean)));
    const tcs = tcIds.length
      ? await prisma.testCase.findMany({
          where: { id: { in: tcIds } },
          select: {
            id: true, name: true, module: true, type: true, scenarioId: true,
            scenario: { select: { id: true, name: true, priority: true, category: true } },
          },
        })
      : [];
    const tcById = new Map(tcs.map((t) => [t.id, t]));

    const resultPairs = items
      .filter((i) => i.runId && i.testCaseId)
      .map((i) => ({ runId: i.runId, testCaseId: i.testCaseId }));
    const results = resultPairs.length
      ? await prisma.runResult.findMany({
          where: { OR: resultPairs },
          select: { runId: true, testCaseId: true, screenshots: true, error: true, durationMs: true },
        })
      : [];
    const resultByKey = new Map(results.map((r) => [`${r.runId}|${r.testCaseId}`, r]));

    const enriched = items.map((it) => {
      const tc = it.testCaseId ? tcById.get(it.testCaseId) : null;
      const rr = (it.runId && it.testCaseId) ? resultByKey.get(`${it.runId}|${it.testCaseId}`) : null;
      const shots = rr ? decodeArray(rr.screenshots) : [];
      return {
        id: it.id,
        runId: it.runId,
        testCaseId: it.testCaseId,
        reason: it.reason,
        locator: it.locator,
        message: it.message,
        createdAt: it.createdAt,
        testCase: tc
          ? { id: tc.id, name: tc.name, module: tc.module, type: tc.type }
          : null,
        scenario: tc?.scenario || null,
        // First screenshot (if any) for visual context; the rest are
        // accessible via the Reports page if the user wants them.
        screenshot: shots[0] || null,
        // Surface result.error too so the UI can show the original Playwright
        // message alongside the (often dedup'd) BlockedItem.message.
        resultError: rr?.error || null,
      };
    });

    res.json({ success: true, items: enriched, scope, latestRunId });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { newSelector, healthScore } = req.body || {};

    const existing = await prisma.blockedItem.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    // Mark resolved
    const updated = await prisma.blockedItem.update({
      where: { id: existing.id },
      data: { resolved: true, resolvedAt: new Date() },
    });

    // If a new selector was supplied, upsert it into the knowledge base
    if (newSelector && existing.locator) {
      const elementKey = existing.locator.slice(0, 200);
      const kbExisting = await prisma.knowledgeBaseLocator.findUnique({
        where: { projectId_element: { projectId: project.id, element: elementKey } },
      });
      if (kbExisting) {
        await prisma.knowledgeBaseLocator.update({
          where: { id: kbExisting.id },
          data: {
            selector: newSelector,
            healthScore: typeof healthScore === 'number' ? healthScore : 90,
            lastHealedAt: new Date(),
            occurrences: kbExisting.occurrences + 1,
          },
        });
      } else {
        await prisma.knowledgeBaseLocator.create({
          data: {
            projectId: project.id,
            element: elementKey,
            selector: newSelector,
            healthScore: typeof healthScore === 'number' ? healthScore : 90,
          },
        });
      }
    }

    await audit.log({
      userId: req.user.id,
      action: 'blocked.resolve',
      target: updated.id,
      metadata: { hadNewSelector: !!newSelector },
      req,
    });
    res.json({ success: true, item: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/projects/:projectId/blocked/:id
 *
 * Hard-delete a blocked row. Used by the "Delete" action in the UI when a
 * user has triaged a blocker outside the system (or simply doesn't care)
 * and wants it gone from the list permanently — not just "resolved" but
 * removed so it never re-surfaces.
 */
router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.blockedItem.findFirst({
      where: { id: req.params.id, projectId: project.id },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.blockedItem.delete({ where: { id: existing.id } });
    await audit.log({
      userId: req.user.id,
      action: 'blocked.delete',
      target: existing.id,
      req,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/projects/:projectId/blocked/:id/skip
 *
 * Soft-resolve without supplying a fix. Recorded distinctly from
 * `resolve(newSelector)` in the audit log so we can tell genuine fixes
 * apart from "user gave up on this one" later.
 */
router.post('/:id/skip', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.blockedItem.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const updated = await prisma.blockedItem.update({
      where: { id: existing.id },
      data: { resolved: true, resolvedAt: new Date() },
    });
    await audit.log({
      userId: req.user.id,
      action: 'blocked.skip',
      target: updated.id,
      req,
    });
    res.json({ success: true, item: updated });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
