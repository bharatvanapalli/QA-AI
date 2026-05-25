'use strict';

/**
 * Sprint CRUD (Phase B / option B3 hybrid).
 *
 * A Sprint is a per-project release container for Documents, Requirements,
 * Runs, BlockedItems, and GovernancePRs. TestCases stay project-level and
 * reference sprints via the SprintTestCase join (populated when a Run starts).
 *
 * Lifecycle:
 *   planning → in_progress → completed → archived
 *
 * Archived sprints reject lifecycle/name changes (SPRINT_LOCKED).
 *
 * Deletes use SetNull semantics in the application layer because the
 * `sprintId` columns on Document/Requirement/Run/BlockedItem/GovernancePR
 * are plain TEXT without an enforced FK — see migration
 * 20260525140000_add_sprints/migration.sql.
 */

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

const VALID_LIFECYCLE = ['planning', 'in_progress', 'completed', 'archived'];

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
    select: { id: true },
  });
}

async function loadSprint(req) {
  const project = await ownProject(req);
  if (!project) return { error: { status: 404, code: 'NOT_FOUND' } };
  const sprint = await prisma.sprint.findFirst({
    where: { id: req.params.id, projectId: project.id },
  });
  if (!sprint) return { error: { status: 404, code: 'NOT_FOUND' } };
  return { project, sprint };
}

// ── GET /api/projects/:projectId/sprints ─────────────────
// Returns sprints newest first, with counts of attached artefacts so the
// UI can render "Sprint 5 · 3 docs · 12 reqs · 2 runs · 4 PRs · 1 blocker"
// without an N+1 fetch. caseCount comes from the SprintTestCase join.
router.get('/', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const sprints = await prisma.sprint.findMany({
      where: { projectId: project.id },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      include: {
        _count: { select: { cases: true } },
      },
    });
    // Phase B+ fields surfaced alongside lifecycle so the UI can render them
    // inline without a per-sprint detail fetch.

    // Counts for the tagged-on-create artefacts. Aggregate in JS to avoid
    // five `groupBy` calls — one batched count per table is plenty for the
    // sizes a real QA project will see.
    const ids = sprints.map((s) => s.id);
    const tally = (rows) => {
      const map = new Map();
      for (const r of rows) {
        map.set(r.sprintId, (map.get(r.sprintId) || 0) + 1);
      }
      return map;
    };
    const [docs, reqs, runs, blockers, prs] = await Promise.all([
      prisma.document.findMany({ where: { projectId: project.id, sprintId: { in: ids } }, select: { sprintId: true } }),
      prisma.requirement.findMany({ where: { projectId: project.id, sprintId: { in: ids } }, select: { sprintId: true } }),
      prisma.run.findMany({ where: { projectId: project.id, sprintId: { in: ids } }, select: { sprintId: true } }),
      prisma.blockedItem.findMany({ where: { projectId: project.id, sprintId: { in: ids } }, select: { sprintId: true } }),
      prisma.governancePR.findMany({ where: { projectId: project.id, sprintId: { in: ids } }, select: { sprintId: true } }),
    ]);
    const docCount = tally(docs);
    const reqCount = tally(reqs);
    const runCount = tally(runs);
    const blockedCount = tally(blockers);
    const prCount = tally(prs);

    const enriched = sprints.map((s) => ({
      id: s.id,
      projectId: s.projectId,
      name: s.name,
      lifecycle: s.lifecycle,
      aiGuidance: s.aiGuidance || null,
      expectedEndAt: s.expectedEndAt || null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      counts: {
        cases: s._count.cases || 0,
        documents: docCount.get(s.id) || 0,
        requirements: reqCount.get(s.id) || 0,
        runs: runCount.get(s.id) || 0,
        blockers: blockedCount.get(s.id) || 0,
        prs: prCount.get(s.id) || 0,
      },
    }));

    res.json({ success: true, sprints: enriched });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/sprints ────────────────
router.post('/', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { name, lifecycle } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ success: false, code: 'INVALID_NAME', message: 'Sprint name must be at least 2 characters.' });
    }
    if (name.length > 80) {
      return res.status(400).json({ success: false, code: 'NAME_TOO_LONG', message: 'Sprint name is capped at 80 characters.' });
    }
    if (lifecycle !== undefined && !VALID_LIFECYCLE.includes(lifecycle)) {
      return res.status(400).json({ success: false, code: 'INVALID_LIFECYCLE', message: `lifecycle must be one of ${VALID_LIFECYCLE.join(', ')}` });
    }

    const sprint = await prisma.sprint.create({
      data: {
        projectId: project.id,
        name: name.trim(),
        lifecycle: lifecycle || 'in_progress',
      },
    });
    await audit.log({
      userId: req.user.id,
      action: 'sprint.create',
      target: sprint.id,
      metadata: { projectId: project.id, name: sprint.name },
      req,
    });
    res.status(201).json({ success: true, sprint });
  } catch (err) {
    next(err);
  }
});

// Phase B+ lifecycle gate: refuse the planning|in_progress → completed flip
// when there are approved P0 cases that haven't been attempted in this
// sprint. "Attempted" = any RunResult row exists, regardless of pass/fail/
// blocked — the gate is about coverage, not pass-rate. Skip the check on
// ?force=1 so the user always has an escape hatch.
async function uncoveredP0Cases(projectId, sprintId) {
  // All approved P0 cases for the project.
  const p0Scenarios = await prisma.testScenario.findMany({
    where: { projectId, priority: 'P0' },
    select: { id: true, name: true, module: true },
  });
  if (!p0Scenarios.length) return [];
  const p0ScenarioIds = p0Scenarios.map((s) => s.id);
  const cases = await prisma.testCase.findMany({
    where: { projectId, scenarioId: { in: p0ScenarioIds }, status: 'approved' },
    select: { id: true, name: true, module: true, scenarioId: true },
  });
  if (!cases.length) return [];
  // Which of those cases have ANY result in this sprint's runs.
  const sprintRuns = await prisma.run.findMany({
    where: { projectId, sprintId },
    select: { id: true },
  });
  if (!sprintRuns.length) {
    return cases.map((c) => ({ id: c.id, name: c.name, module: c.module }));
  }
  const runIds = sprintRuns.map((r) => r.id);
  const coveredResults = await prisma.runResult.findMany({
    where: { runId: { in: runIds }, testCaseId: { in: cases.map((c) => c.id) } },
    select: { testCaseId: true },
  });
  const coveredTcIds = new Set(coveredResults.map((r) => r.testCaseId));
  return cases
    .filter((c) => !coveredTcIds.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, module: c.module }));
}

// ── PATCH /api/projects/:projectId/sprints/:id ───────────
router.patch('/:id', requireCsrf, async (req, res, next) => {
  try {
    const { project, sprint, error } = await loadSprint(req);
    if (error) return res.status(error.status).json({ success: false, code: error.code });

    if (sprint.lifecycle === 'archived') {
      return res.status(409).json({ success: false, code: 'SPRINT_LOCKED', message: 'Archived sprints cannot be modified. Reactivate first (move to in_progress) if you really need to edit.' });
    }

    const { name, lifecycle, aiGuidance, expectedEndAt } = req.body || {};
    const data = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ success: false, code: 'INVALID_NAME', message: 'Sprint name must be at least 2 characters.' });
      }
      if (name.length > 80) {
        return res.status(400).json({ success: false, code: 'NAME_TOO_LONG' });
      }
      data.name = name.trim();
    }
    if (lifecycle !== undefined) {
      if (!VALID_LIFECYCLE.includes(lifecycle)) {
        return res.status(400).json({ success: false, code: 'INVALID_LIFECYCLE' });
      }
      // Lifecycle gate: planning | in_progress → completed requires P0 coverage.
      if (lifecycle === 'completed' && sprint.lifecycle !== 'completed') {
        const force = req.query.force === '1' || req.query.force === 'true';
        if (!force) {
          const missing = await uncoveredP0Cases(project.id, sprint.id);
          if (missing.length) {
            return res.status(409).json({
              success: false,
              code: 'SPRINT_INCOMPLETE',
              message: `${missing.length} P0 case${missing.length === 1 ? ' has' : 's have'} not run in this sprint yet.`,
              missing,
            });
          }
        }
      }
      data.lifecycle = lifecycle;
    }
    if (aiGuidance !== undefined) {
      // Allow clearing via empty string. Trim to keep stored values clean.
      if (aiGuidance !== null && typeof aiGuidance !== 'string') {
        return res.status(400).json({ success: false, code: 'INVALID_GUIDANCE' });
      }
      const trimmed = (aiGuidance || '').trim();
      data.aiGuidance = trimmed.length ? trimmed : null;
    }
    if (expectedEndAt !== undefined) {
      if (expectedEndAt === null || expectedEndAt === '') {
        data.expectedEndAt = null;
      } else {
        const d = new Date(expectedEndAt);
        if (Number.isNaN(d.getTime())) {
          return res.status(400).json({ success: false, code: 'INVALID_DATE', message: 'expectedEndAt must be a valid ISO date.' });
        }
        data.expectedEndAt = d;
      }
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ success: false, code: 'NO_FIELDS', message: 'Body must include at least one of name, lifecycle, aiGuidance, expectedEndAt.' });
    }

    const updated = await prisma.sprint.update({
      where: { id: sprint.id },
      data,
    });
    await audit.log({
      userId: req.user.id,
      action: 'sprint.update',
      target: updated.id,
      metadata: { fields: Object.keys(data), lifecycle: updated.lifecycle },
      req,
    });
    res.json({ success: true, sprint: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:projectId/sprints/:id ──────────
// Hard-deletes the sprint row. Tagged artefacts (Document/Requirement/Run/
// BlockedItem/GovernancePR) keep their rows but have their `sprintId`
// cleared to NULL — this preserves history without leaving dangling FKs
// (the columns are plain TEXT, not real FKs, so the application enforces).
// SprintTestCase rows cascade via the real FK on that table.
router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const { sprint, error } = await loadSprint(req);
    if (error) return res.status(error.status).json({ success: false, code: error.code });

    // Clear sprintId on tagged artefacts before removing the parent.
    // updateMany returns counts so we can audit them.
    const [doc, req_, run, blk, pr] = await Promise.all([
      prisma.document.updateMany({ where: { sprintId: sprint.id }, data: { sprintId: null } }),
      prisma.requirement.updateMany({ where: { sprintId: sprint.id }, data: { sprintId: null } }),
      prisma.run.updateMany({ where: { sprintId: sprint.id }, data: { sprintId: null } }),
      prisma.blockedItem.updateMany({ where: { sprintId: sprint.id }, data: { sprintId: null } }),
      prisma.governancePR.updateMany({ where: { sprintId: sprint.id }, data: { sprintId: null } }),
    ]);

    await prisma.sprint.delete({ where: { id: sprint.id } });

    await audit.log({
      userId: req.user.id,
      action: 'sprint.delete',
      target: sprint.id,
      metadata: {
        clearedDocuments: doc.count,
        clearedRequirements: req_.count,
        clearedRuns: run.count,
        clearedBlockers: blk.count,
        clearedPrs: pr.count,
      },
      req,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Helper: latest RunResult per TestCase in a given sprint. Used by carry-
// forward (gather the latest fail-or-similar) and the compare endpoint
// (build the per-case outcome map for diff).
async function latestResultsPerCase(projectId, sprintId) {
  if (!sprintId) return new Map();
  const runs = await prisma.run.findMany({
    where: { projectId, sprintId },
    select: { id: true, startedAt: true },
    orderBy: { startedAt: 'desc' },
  });
  if (!runs.length) return new Map();
  const runIds = runs.map((r) => r.id);
  // Fetch all results in this sprint ordered by run startedAt desc so the
  // first hit per testCaseId is the latest.
  const results = await prisma.runResult.findMany({
    where: { runId: { in: runIds } },
    select: {
      id: true, runId: true, testCaseId: true, status: true,
      createdAt: true, error: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  const byCase = new Map();
  for (const r of results) {
    if (!byCase.has(r.testCaseId)) byCase.set(r.testCaseId, r);
  }
  return byCase;
}

// ── POST /api/projects/:projectId/sprints/:id/carry-forward-failures ──
// Copies the failing cases from the most recent COMPLETED sprint (other than
// this one) into this sprint's SprintTestCase join. Idempotent: pre-existing
// (sprintId, testCaseId) rows are skipped.
router.post('/:id/carry-forward-failures', requireCsrf, async (req, res, next) => {
  try {
    const { project, sprint, error } = await loadSprint(req);
    if (error) return res.status(error.status).json({ success: false, code: error.code });
    if (sprint.lifecycle === 'archived') {
      return res.status(409).json({ success: false, code: 'SPRINT_LOCKED' });
    }

    // Find the most recent completed sprint that isn't this one.
    const source = await prisma.sprint.findFirst({
      where: { projectId: project.id, lifecycle: 'completed', NOT: { id: sprint.id } },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (!source) {
      return res.status(400).json({
        success: false, code: 'NO_PREVIOUS_SPRINT',
        message: 'No completed sprint to carry forward from.',
      });
    }

    const latest = await latestResultsPerCase(project.id, source.id);
    const failingTcIds = [];
    for (const [tcId, r] of latest) {
      if (r.status === 'fail' || r.status === 'blocked') failingTcIds.push(tcId);
    }
    if (!failingTcIds.length) {
      return res.json({
        success: true, carried: 0, skipped: 0,
        fromSprint: { id: source.id, name: source.name },
      });
    }

    // Skip pre-existing rows so the operation is idempotent.
    const existing = await prisma.sprintTestCase.findMany({
      where: { sprintId: sprint.id, testCaseId: { in: failingTcIds } },
      select: { testCaseId: true },
    });
    const existingSet = new Set(existing.map((r) => r.testCaseId));
    const toCreate = failingTcIds.filter((id) => !existingSet.has(id));

    if (toCreate.length) {
      await prisma.sprintTestCase.createMany({
        data: toCreate.map((tcId) => ({ sprintId: sprint.id, testCaseId: tcId })),
      });
    }

    await audit.log({
      userId: req.user.id,
      action: 'sprint.carry_forward',
      target: sprint.id,
      metadata: { fromSprintId: source.id, carried: toCreate.length, skipped: existingSet.size },
      req,
    });
    res.json({
      success: true,
      carried: toCreate.length,
      skipped: existingSet.size,
      fromSprint: { id: source.id, name: source.name },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/sprints/:id/health ─────
// Aggregates pass-rate + regressions/recoveries against the previous sprint.
// Designed to feed the Overview "sprint health" tile in a single fetch.
router.get('/:id/health', async (req, res, next) => {
  try {
    const { project, sprint, error } = await loadSprint(req);
    if (error) return res.status(error.status).json({ success: false, code: error.code });

    const previous = await prisma.sprint.findFirst({
      where: {
        projectId: project.id,
        lifecycle: { in: ['completed', 'in_progress'] },
        NOT: { id: sprint.id },
        createdAt: { lt: sprint.createdAt },
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    const [thisLatest, prevLatest] = await Promise.all([
      latestResultsPerCase(project.id, sprint.id),
      previous ? latestResultsPerCase(project.id, previous.id) : Promise.resolve(new Map()),
    ]);

    let passed = 0, failed = 0, blocked = 0, skipped = 0;
    for (const r of thisLatest.values()) {
      if (r.status === 'pass') passed++;
      else if (r.status === 'fail') failed++;
      else if (r.status === 'blocked') blocked++;
      else if (r.status === 'skipped') skipped++;
    }
    const executed = passed + failed + blocked;
    const passRate = executed ? Math.round((passed / executed) * 100) : null;

    // Regressions = passed previously, failing/blocked now.
    // Recoveries  = failing/blocked previously, passing now.
    let regressions = 0, recoveries = 0, newCases = 0;
    if (previous) {
      for (const [tcId, r] of thisLatest) {
        const prev = prevLatest.get(tcId);
        if (!prev) { newCases++; continue; }
        const prevBad = prev.status === 'fail' || prev.status === 'blocked';
        const nowBad = r.status === 'fail' || r.status === 'blocked';
        if (prev.status === 'pass' && nowBad) regressions++;
        if (prevBad && r.status === 'pass') recoveries++;
      }
    }

    const blockerCount = await prisma.blockedItem.count({
      where: { projectId: project.id, sprintId: sprint.id, resolved: false },
    });
    const runCount = await prisma.run.count({
      where: { projectId: project.id, sprintId: sprint.id },
    });
    const caseCount = await prisma.sprintTestCase.count({
      where: { sprintId: sprint.id },
    });

    const now = Date.now();
    const daysOpen = Math.max(0, Math.floor((now - new Date(sprint.createdAt).getTime()) / 86_400_000));
    const daysToCut = sprint.expectedEndAt
      ? Math.floor((new Date(sprint.expectedEndAt).getTime() - now) / 86_400_000)
      : null;

    res.json({
      success: true,
      sprint: {
        id: sprint.id, name: sprint.name, lifecycle: sprint.lifecycle,
        createdAt: sprint.createdAt, expectedEndAt: sprint.expectedEndAt || null,
      },
      previous: previous ? { id: previous.id, name: previous.name, lifecycle: previous.lifecycle } : null,
      stats: {
        passed, failed, blocked, skipped,
        executed, passRate,
        regressions, recoveries, newCases,
        openBlockers: blockerCount,
        runCount, caseCount,
        daysOpen, daysToCut,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/sprints/compare?a=&b= ──
// Diff two sprints by test-case outcome — A is the baseline (older), B is
// the candidate (newer). The UI typically calls this with B=current and
// A=previous-completed.
router.get('/compare', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { a, b } = req.query || {};
    if (!a || !b) {
      return res.status(400).json({ success: false, code: 'MISSING_IDS', message: 'a and b sprint ids are required.' });
    }
    if (a === b) {
      return res.status(400).json({ success: false, code: 'SAME_SPRINT' });
    }
    const [sprintA, sprintB] = await Promise.all([
      prisma.sprint.findFirst({ where: { id: a, projectId: project.id } }),
      prisma.sprint.findFirst({ where: { id: b, projectId: project.id } }),
    ]);
    if (!sprintA || !sprintB) {
      return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    }

    const [latestA, latestB] = await Promise.all([
      latestResultsPerCase(project.id, sprintA.id),
      latestResultsPerCase(project.id, sprintB.id),
    ]);

    const tcIds = new Set([...latestA.keys(), ...latestB.keys()]);
    const cases = tcIds.size
      ? await prisma.testCase.findMany({
          where: { id: { in: Array.from(tcIds) } },
          select: { id: true, name: true, module: true, scenarioId: true },
        })
      : [];
    const caseById = new Map(cases.map((c) => [c.id, c]));

    const bad = (s) => s === 'fail' || s === 'blocked';
    const newFailures = [];
    const newPasses = [];
    const stillFailing = [];
    const stillPassing = [];
    const onlyInA = [];
    const onlyInB = [];

    const slim = (tcId, ra, rb) => ({
      id: tcId,
      name: caseById.get(tcId)?.name || null,
      module: caseById.get(tcId)?.module || null,
      a: ra ? { status: ra.status, error: (ra.error || '').slice(0, 200) } : null,
      b: rb ? { status: rb.status, error: (rb.error || '').slice(0, 200) } : null,
    });

    for (const tcId of tcIds) {
      const ra = latestA.get(tcId);
      const rb = latestB.get(tcId);
      if (ra && rb) {
        if (ra.status === 'pass' && bad(rb.status)) newFailures.push(slim(tcId, ra, rb));
        else if (bad(ra.status) && rb.status === 'pass') newPasses.push(slim(tcId, ra, rb));
        else if (bad(ra.status) && bad(rb.status)) stillFailing.push(slim(tcId, ra, rb));
        else if (ra.status === 'pass' && rb.status === 'pass') stillPassing.push(slim(tcId, ra, rb));
        else {
          // Mixed (e.g. one is skipped) — treat as informational, drop into
          // onlyInB so it shows up but doesn't inflate regression count.
          onlyInB.push(slim(tcId, ra, rb));
        }
      } else if (rb) {
        onlyInB.push(slim(tcId, null, rb));
      } else if (ra) {
        onlyInA.push(slim(tcId, ra, null));
      }
    }

    res.json({
      success: true,
      a: { id: sprintA.id, name: sprintA.name, lifecycle: sprintA.lifecycle, expectedEndAt: sprintA.expectedEndAt || null },
      b: { id: sprintB.id, name: sprintB.name, lifecycle: sprintB.lifecycle, expectedEndAt: sprintB.expectedEndAt || null },
      summary: {
        newFailures: newFailures.length,
        newPasses: newPasses.length,
        stillFailing: stillFailing.length,
        stillPassing: stillPassing.length,
        onlyInA: onlyInA.length,
        onlyInB: onlyInB.length,
      },
      newFailures, newPasses, stillFailing, stillPassing, onlyInA, onlyInB,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
