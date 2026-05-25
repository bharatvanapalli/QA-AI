'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const { decodeArray, decodeJson } = require('../services/jsonField');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const blockageAnalyzer = require('../services/agents/blockageAnalyzer');
const cancelRegistry = require('../services/cancelRegistry');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

// Severity sort order — high first, then normal, then low.
const SEVERITY_RANK = { high: 0, normal: 1, low: 2 };
function compareBySeverity(a, b) {
  const ra = SEVERITY_RANK[a.severity] ?? 1;
  const rb = SEVERITY_RANK[b.severity] ?? 1;
  if (ra !== rb) return ra - rb;
  return new Date(b.createdAt) - new Date(a.createdAt);
}

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
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

    // Sprint filter takes precedence over the "latest run" scope — if the
    // user has switched to a sprint via the header pill, they want EVERY
    // unresolved blocker for that sprint, not just the latest run within
    // it. Without that override the page would silently hide most of the
    // sprint's blockers.
    const sprintFilter = req.query.sprintId ? { sprintId: String(req.query.sprintId) } : null;
    const where = {
      projectId: project.id,
      resolved: false,
      ...(sprintFilter || (scope === 'latest' && latestRunId ? { runId: latestRunId } : {})),
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

    // Pre-fetch the upstream root-cause TCs so the UI can render their
    // name on the "Why blocked?" panel without an extra round trip.
    const rootIds = Array.from(new Set(items.map((i) => i.aiRootCauseTcId).filter(Boolean)));
    const rootCauseRows = rootIds.length
      ? await prisma.testCase.findMany({
          where: { id: { in: rootIds } },
          select: { id: true, name: true, module: true },
        })
      : [];
    const rootCauseById = new Map(rootCauseRows.map((t) => [t.id, t]));

    // Phase E1.4 — for selector_drift blockers, attach the matching
    // KnowledgeBaseLocator row id so the UI can render a "Heal locator from
    // current DOM" button that POSTs to /knowledge-base/:id/heal-now.
    //
    // Match strategy: the conductor's heal flow stores `locator = kb.selector
    // || targetElement`, so a drift blocker's `locator` string equals either
    // the KB row's `element` (first failure, KB didn't exist yet) or its
    // `selector` (subsequent failures, KB row created on first sighting).
    // Look up both in one batched query.
    const driftLocators = Array.from(new Set(
      items.filter((i) => i.aiCategory === 'selector_drift').map((i) => i.locator).filter(Boolean),
    ));
    const kbMatches = driftLocators.length
      ? await prisma.knowledgeBaseLocator.findMany({
          where: {
            projectId: project.id,
            OR: [
              { element: { in: driftLocators } },
              { selector: { in: driftLocators } },
            ],
          },
          select: { id: true, element: true, selector: true, healthScore: true },
        })
      : [];
    // Build a lookup keyed on BOTH element and selector — whichever the
    // blocker's locator string equals.
    const kbByLocator = new Map();
    for (const k of kbMatches) {
      if (k.element) kbByLocator.set(k.element, k);
      if (k.selector) kbByLocator.set(k.selector, k);
    }

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
        severity: it.severity || 'normal',
        assignee: it.assignee || null,
        resolveNote: it.resolveNote || null,
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
        // AI blockage reasoning (Phase 7) — null when the analyzer hasn't
        // run yet. UI shows a "Why blocked?" panel when aiSummary is set.
        aiSummary: it.aiSummary || null,
        aiCategory: it.aiCategory || null,
        aiSuggestedFix: it.aiSuggestedFix || null,
        aiAnalyzedAt: it.aiAnalyzedAt || null,
        aiRootCauseTc: it.aiRootCauseTcId
          ? rootCauseById.get(it.aiRootCauseTcId) || { id: it.aiRootCauseTcId, name: null, module: null }
          : null,
        // Phase E1.4 — present when the failing locator maps to a known KB
        // row. Drives the "Heal from current DOM" CTA on selector_drift
        // blockers.
        kbLocator: it.aiCategory === 'selector_drift' && it.locator
          ? kbByLocator.get(it.locator) || null
          : null,
      };
    });

    enriched.sort(compareBySeverity);

    res.json({ success: true, items: enriched, scope, latestRunId });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { newSelector, healthScore, note } = req.body || {};

    const existing = await prisma.blockedItem.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    // Mark resolved (with optional free-form note for triage history)
    const updated = await prisma.blockedItem.update({
      where: { id: existing.id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolveNote: typeof note === 'string' && note.trim() ? note.trim().slice(0, 600) : existing.resolveNote,
      },
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
    const { note } = req.body || {};
    const existing = await prisma.blockedItem.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const updated = await prisma.blockedItem.update({
      where: { id: existing.id },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolveNote: typeof note === 'string' && note.trim() ? note.trim().slice(0, 600) : existing.resolveNote,
      },
    });
    await audit.log({
      userId: req.user.id,
      action: 'blocked.skip',
      target: updated.id,
      metadata: { hasNote: !!(note && note.trim()) },
      req,
    });
    res.json({ success: true, item: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/projects/:projectId/blocked/:id
 *
 * Lightweight metadata update — currently used for severity overrides and
 * assignee. Body: { severity?, assignee? }. Both are optional; null/empty
 * string clears assignee. Severity validated against blockageAnalyzer enum
 * so the dashboard sort stays consistent.
 */
router.patch('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.blockedItem.findFirst({
      where: { id: req.params.id, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { severity, assignee } = req.body || {};
    const data = {};
    if (severity !== undefined) {
      if (!blockageAnalyzer.VALID_SEVERITIES.includes(severity)) {
        return res.status(400).json({ success: false, code: 'INVALID_SEVERITY', message: `severity must be one of ${blockageAnalyzer.VALID_SEVERITIES.join(', ')}` });
      }
      data.severity = severity;
    }
    if (assignee !== undefined) {
      data.assignee = assignee === null || assignee === '' ? null : String(assignee).slice(0, 120).trim() || null;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, code: 'NO_FIELDS', message: 'Body must include severity and/or assignee.' });
    }

    const updated = await prisma.blockedItem.update({
      where: { id: existing.id },
      data,
    });
    await audit.log({
      userId: req.user.id,
      action: 'blocked.update',
      target: updated.id,
      metadata: { fields: Object.keys(data) },
      req,
    });
    res.json({ success: true, item: updated });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/projects/:projectId/blocked/analyze
 *
 * Run the Blockage Analyzer over the unresolved blockers for this project.
 *
 * Query params:
 *   - runId   : limit analysis to one run's blockers (defaults to latest run)
 *   - all     : 'true' to analyse every unresolved blocker across history
 *               (use sparingly — costs one Claude call per batch)
 *
 * Returns the freshly persisted analyses. Streams `agent.phase.{start,log,
 * complete}` over the user's WS channel so the global indicator + page
 * banner show progress.
 *
 * Triggered automatically from the agents pipeline (see runConductorWithRetries
 * in routes/agents.js) AND via the "Re-analyse" button in the UI.
 */
router.post('/analyze', requireCsrf, rateLimit({ windowMs: 60_000, max: 6 }), async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
    if (!apiKey || integration?.status !== 'valid') {
      return res.status(400).json({
        success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
        message: `${provider} API key not configured for this project.`,
      });
    }

    const targetRunId = req.query.runId ? String(req.query.runId) : null;
    const all = req.query.all === 'true';

    let runIdForAnalysis = targetRunId;
    if (!runIdForAnalysis && !all) {
      const latest = await prisma.run.findFirst({
        where: { projectId: project.id },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      runIdForAnalysis = latest?.id || null;
    }

    const blockerRows = await prisma.blockedItem.findMany({
      where: {
        projectId: project.id,
        resolved: false,
        ...(runIdForAnalysis ? { runId: runIdForAnalysis } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (blockerRows.length === 0) {
      return res.json({ success: true, analyses: [], scope: { runId: runIdForAnalysis, all, count: 0 } });
    }

    const broadcast = req.app.locals.broadcastToUser;
    const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
    send({ type: 'agent.phase.start', phase: 'analyst', label: 'Blockage Analyzer' });

    // ── Build the agent input from this project's run state ────────
    const tcIds = Array.from(new Set(blockerRows.map((b) => b.testCaseId).filter(Boolean)));
    const tcs = tcIds.length
      ? await prisma.testCase.findMany({
          where: { id: { in: tcIds } },
          select: { id: true, name: true, module: true, scenarioId: true },
        })
      : [];
    const tcById = new Map(tcs.map((t) => [t.id, t]));

    // Also include EVERY case from runIdForAnalysis with its RunResult status,
    // so the analyzer can find upstream failures referenced by downstream
    // blockers. When all=true we widen to every case for this project that
    // has any RunResult.
    const runResults = runIdForAnalysis
      ? await prisma.runResult.findMany({
          where: { runId: runIdForAnalysis },
          select: { testCaseId: true, status: true, error: true },
        })
      : await prisma.runResult.findMany({
          where: { run: { projectId: project.id } },
          orderBy: { createdAt: 'desc' },
          take: 200,
          select: { testCaseId: true, status: true, error: true },
        });
    const runTcIds = Array.from(new Set(runResults.map((r) => r.testCaseId)));
    const runTcRows = runTcIds.length
      ? await prisma.testCase.findMany({
          where: { id: { in: runTcIds } },
          select: { id: true, name: true, module: true, assertions: true, scenarioId: true },
        })
      : [];
    const runTcById = new Map(runTcRows.map((t) => [t.id, t]));

    const runCases = runResults.map((r) => {
      const tc = runTcById.get(r.testCaseId);
      return tc ? {
        id: tc.id,
        name: tc.name,
        module: tc.module,
        assertions: tc.assertions,
        status: r.status,
      } : null;
    }).filter(Boolean);

    // Dependencies — fetch the scenarios for the touched cases and decode
    // `dependencyOn` into a tcId -> upstream-tcId[] map. Architect's
    // dependencyOn stores scenario IDs, so we have to project upstream
    // scenarios to their cases.
    const scenarioIds = Array.from(new Set([
      ...tcs.map((t) => t.scenarioId).filter(Boolean),
      ...runTcRows.map((t) => t.scenarioId).filter(Boolean),
    ]));
    const scenarios = scenarioIds.length
      ? await prisma.testScenario.findMany({
          where: { id: { in: scenarioIds } },
          select: { id: true, dependencyOn: true, cases: { select: { id: true } } },
        })
      : [];
    const casesByScenarioId = new Map(scenarios.map((s) => [s.id, (s.cases || []).map((c) => c.id)]));
    const upstreamScenariosById = new Map(scenarios.map((s) => [s.id, decodeJson(s.dependencyOn, []) || []]));

    const dependencies = {};
    for (const c of runTcRows) {
      if (!c.scenarioId) continue;
      const upstreamScenarios = upstreamScenariosById.get(c.scenarioId) || [];
      const upstreamTcIds = upstreamScenarios.flatMap((sid) => casesByScenarioId.get(sid) || []);
      if (upstreamTcIds.length) dependencies[c.id] = upstreamTcIds;
    }

    const blockers = blockerRows.map((b) => {
      const tc = b.testCaseId ? tcById.get(b.testCaseId) : null;
      const r = runResults.find((rr) => rr.testCaseId === b.testCaseId);
      return {
        id: b.id,
        testCaseId: b.testCaseId,
        testCaseName: tc?.name || null,
        module: tc?.module || null,
        reason: b.reason,
        locator: b.locator,
        message: b.message,
        severity: b.severity || 'normal',
        errorPreview: r?.error || null,
      };
    });

    let result;
    try {
      result = await blockageAnalyzer.run({
        apiKey, model, provider,
        blockers, runCases, dependencies,
        onLog: async (level, message) => send({ type: 'agent.phase.log', phase: 'analyst', level, message }),
        onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
        extraGuidance: project.aiGuidance || null,
      });
    } catch (err) {
      send({ type: 'agent.phase.complete', phase: 'analyst', error: err.message });
      return res.status(err.status || 500).json({ success: false, code: err.code || 'ANALYZE_FAILED', message: err.message });
    }

    // Persist + collect the freshly-analysed rows for the response.
    const now = new Date();
    const updates = [];
    for (const a of result.analyses) {
      updates.push(prisma.blockedItem.update({
        where: { id: a.id },
        data: {
          aiSummary: a.summary,
          aiCategory: a.category,
          aiSuggestedFix: a.suggestedFix,
          aiRootCauseTcId: a.rootCauseTcId,
          severity: a.severity,
          aiAnalyzedAt: now,
        },
      }));
    }
    await Promise.all(updates);

    send({ type: 'agent.phase.complete', phase: 'analyst', output: { analysed: result.analyses.length } });

    await audit.log({
      userId: req.user.id,
      action: 'blocked.analyze',
      target: project.id,
      metadata: { runId: runIdForAnalysis, scope: all ? 'all' : 'run', count: result.analyses.length },
      req,
    });
    res.json({
      success: true,
      analyses: result.analyses,
      scope: { runId: runIdForAnalysis, all, count: result.analyses.length },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
