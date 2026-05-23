'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const architect = require('../services/agents/architect');
const cancelRegistry = require('../services/cancelRegistry');
const { encodeJson, decodeJson } = require('../services/jsonField');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, userId: req.user.id },
  });
}

function inflateScenario(s) {
  if (!s) return s;
  const out = { ...s, dependencyOn: decodeJson(s.dependencyOn, []) || [] };
  if (Array.isArray(out.cases)) {
    out.cases = out.cases.map((c) => ({ ...c, steps: decodeJson(c.steps, []) || [] }));
  }
  return out;
}

// ── GET /api/projects/:projectId/scenarios ────────────────
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const scenarios = await prisma.testScenario.findMany({
      where: { projectId: project.id },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: { cases: true },
    });

    // Attach the latest RunResult per test case (post-CRIT-6) — TC.status
    // no longer carries pass/fail/blocked. Consumers can read
    // case.latestResult.status to render the execution outcome alongside
    // the approval state held in case.status.
    const allCaseIds = scenarios.flatMap((s) => s.cases.map((c) => c.id));
    const latestByTc = new Map();
    if (allCaseIds.length) {
      const results = await prisma.runResult.findMany({
        where: { testCaseId: { in: allCaseIds } },
        orderBy: [{ run: { startedAt: 'desc' } }],
        select: { testCaseId: true, status: true, runId: true, durationMs: true, error: true, run: { select: { startedAt: true } } },
      });
      for (const r of results) {
        if (!latestByTc.has(r.testCaseId)) {
          latestByTc.set(r.testCaseId, {
            status: r.status,
            runId: r.runId,
            durationMs: r.durationMs,
            error: r.error,
            startedAt: r.run?.startedAt || null,
          });
        }
      }
    }
    const inflated = scenarios.map(inflateScenario).map((s) => ({
      ...s,
      cases: s.cases.map((c) => ({ ...c, latestResult: latestByTc.get(c.id) || null })),
    }));
    res.json({ success: true, scenarios: inflated });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/scenarios/generate ──────
// Runs Agent 1 (Scenario Architect) and persists output.
router.post(
  '/generate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    const TAG = `[scenarios.generate user=${req.user.id} proj=${req.params.projectId}]`;
    console.log(`${TAG} request received`);
    try {
      const project = await getProject(req);
      if (!project) {
        console.log(`${TAG} project not found`);
        return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      }

      const { requirementIds, replace = true } = req.body || {};
      const where = { projectId: project.id };
      if (Array.isArray(requirementIds) && requirementIds.length) {
        where.id = { in: requirementIds };
      }
      const requirements = await prisma.requirement.findMany({ where });
      console.log(`${TAG} loaded ${requirements.length} requirement(s)`);
      if (!requirements.length) {
        return res.status(400).json({
          success: false,
          code: 'NO_REQUIREMENTS',
          message: 'No requirements available. Upload documents or pull from ADO/Jira first.',
        });
      }

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        console.log(`${TAG} ${provider} not configured. status=${integration?.status} hasKey=${!!apiKey}`);
        return res.status(400).json({
          success: false,
          code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }
      console.log(`${TAG} using provider=${provider} model=${model}`);

      // Broadcast streaming reasoning over per-user WS
      const broadcast = req.app.locals.broadcastToUser;
      const send = (type, payload) =>
        broadcast && broadcast(req.user.id, { type, ...payload });

      send('agent.phase.start', { phase: 'architect', label: 'Scenario Architect' });
      const onLog = async (level, message) =>
        send('agent.phase.log', { phase: 'architect', level, message });
      const onRateLimit = (info) => send('claude.rate-limit', info);

      // Project-wide AI guidance, if set.
      const projectRow = await prisma.project.findUnique({
        where: { id: project.id },
        select: { aiGuidance: true },
      });

      // Register a cancel token BEFORE the Claude call so POST /agents/cancel
      // can abort the in-flight request. Without this, Terminate would no-op
      // until architect.run returned naturally (could be 60+ seconds).
      const cancelToken = cancelRegistry.create(req.user.id);
      let result;
      try {
        result = await architect.run({
          apiKey,
          model,
          provider,
          requirements,
          onLog,
          onRateLimit,
          signal: cancelToken.signal,
          extraGuidance: projectRow?.aiGuidance || null,
        });
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        send('agent.phase.complete', {
          phase: 'architect',
          error: cancelled ? 'cancelled' : err.message,
          cancelled,
        });
        if (cancelled) {
          return res.status(499).json({
            success: false, code: 'CANCELLED',
            message: 'Generation cancelled by user.',
          });
        }
        return res.status(err.status || 502).json({
          success: false,
          code: err.code || 'AGENT_FAILED',
          message: err.message,
        });
      }
      cancelRegistry.clear(req.user.id);

      // Persist scenarios + cases (transactional)
      if (replace) {
        // Delete ALL test cases on regen, not just pending+approved. Previously
        // we kept rows whose status was 'rejected' or 'running' (e.g. an
        // interrupted run that never flipped status back to 'approved'), and
        // they survived as scenario-less orphans — invisible to the Test
        // Cases page (which queries via scenarios) but still counted by the
        // dashboard (which queries TestCase directly), producing the
        // "Overview says 4 passed, Test Cases says 0 passed" divergence.
        //
        // RunResult and GovernancePR/BlockedItem rows linked to these TCs
        // are cleaned up by cascade / SetNull declared in schema.prisma, so
        // the Run row (with its denormalised counters) survives as history
        // but no orphan results are left dangling.
        await prisma.testScenario.deleteMany({ where: { projectId: project.id } });
        await prisma.testCase.deleteMany({ where: { projectId: project.id } });
      }

      const created = [];
      for (const s of result.scenarios) {
        const scenario = await prisma.testScenario.create({
          data: {
            projectId: project.id,
            name: s.name,
            module: s.module,
            priority: s.priority,
            category: s.category,
            rationale: s.rationale,
            dependencyOn: encodeJson(s.dependencyOn),
            source: 'agent',
          },
        });
        const cases = [];
        for (const c of s.cases) {
          const tc = await prisma.testCase.create({
            data: {
              projectId: project.id,
              scenarioId: scenario.id,
              name: c.name,
              type: c.type,
              module: s.module,
              confidence: c.confidence,
              assertions: c.assertions,
              steps: encodeJson(c.steps || []),
              status: 'pending',
            },
          });
          cases.push({ ...tc, steps: c.steps || [] });
        }
        created.push({ ...inflateScenario(scenario), cases });
      }

      await audit.log({
        userId: req.user.id,
        action: 'agents.architect.run',
        target: project.id,
        metadata: {
          scenarios: created.length,
          cases: created.reduce((a, s) => a + s.cases.length, 0),
        },
        req,
      });

      send('agent.phase.complete', {
        phase: 'architect',
        output: {
          scenarios: created.length,
          cases: created.reduce((a, s) => a + s.cases.length, 0),
        },
      });

      console.log(`${TAG} SUCCESS — ${created.length} scenarios, ${created.reduce((a, s) => a + s.cases.length, 0)} cases`);
      res.json({
        success: true,
        scenarios: created,
        stats: {
          scenarios: created.length,
          cases: created.reduce((a, s) => a + s.cases.length, 0),
        },
      });
    } catch (err) {
      console.error(`${TAG} ERROR:`, err.message, err.code || '', err.stack?.split('\n').slice(0, 3).join('\n'));
      // Surface error to the client AND broadcast on WS so any open Theater/Suite sees it
      const broadcast = req.app.locals.broadcastToUser;
      if (broadcast) {
        broadcast(req.user.id, {
          type: 'agent.phase.complete',
          phase: 'architect',
          error: err.message || 'Generation failed',
        });
      }
      if (!res.headersSent) {
        return res.status(err.status || 500).json({
          success: false,
          code: err.code || 'GENERATION_FAILED',
          message: err.message || 'Unknown error',
        });
      }
      next(err);
    }
  }
);

// ── DELETE /api/projects/:projectId/scenarios/:id ─────────
router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await prisma.testScenario.deleteMany({ where: { id: req.params.id, projectId: project.id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/scenarios/:id/regenerate ─
// Re-runs the Architect scoped to ONE scenario's module — drops the old
// scenario + its TestCases, then asks Claude to produce a fresh scenario
// for the same module from the project's requirements.
//
// Why per-scenario regen exists: a single bad scenario shouldn't force the
// user to throw away 11 good ones and pay for a full re-architect. The
// scoped call uses the same architect prompt but with module-filtered
// requirement text, so the output stays narrow.
router.post(
  '/:id/regenerate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    const TAG = `[scenarios.regenerate.one user=${req.user.id} scenario=${req.params.id}]`;
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const existing = await prisma.testScenario.findFirst({
        where: { id: req.params.id, projectId: project.id },
      });
      if (!existing) return res.status(404).json({ success: false, code: 'SCENARIO_NOT_FOUND' });
      const targetModule = existing.module;

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      // Pull requirements that mention this module — fall back to all if
      // there's no match. Architect understands module context from the
      // prompt; we just narrow the input to keep cost down.
      const allReqs = await prisma.requirement.findMany({ where: { projectId: project.id } });
      const moduleLower = targetModule.toLowerCase();
      const matched = allReqs.filter((r) =>
        (r.content || '').toLowerCase().includes(moduleLower) ||
        (r.title || '').toLowerCase().includes(moduleLower)
      );
      const requirementsForPrompt = matched.length ? matched : allReqs;
      if (!requirementsForPrompt.length) {
        return res.status(400).json({
          success: false, code: 'NO_REQUIREMENTS',
          message: 'No requirements available to regenerate this scenario.',
        });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (type, payload) => broadcast && broadcast(req.user.id, { type, ...payload });
      send('agent.phase.start', { phase: 'architect', label: `Architect — regenerating "${existing.name}"`, projectId: project.id });
      const onLog = async (level, message) =>
        send('agent.phase.log', { phase: 'architect', level, message, projectId: project.id });

      const cancelToken = cancelRegistry.create(req.user.id);
      let result;
      try {
        result = await architect.run({
          apiKey,
          model,
          provider,
          requirements: requirementsForPrompt,
          onLog,
          signal: cancelToken.signal,
        });
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        send('agent.phase.complete', { phase: 'architect', error: cancelled ? 'cancelled' : err.message, cancelled, projectId: project.id });
        if (cancelled) return res.status(499).json({ success: false, code: 'CANCELLED', message: 'Regeneration cancelled by user.' });
        return res.status(err.status || 502).json({ success: false, code: err.code || 'AGENT_FAILED', message: err.message });
      }
      cancelRegistry.clear(req.user.id);

      // Keep only the scenario(s) whose module matches the target. Architect
      // returns up to 12 scenarios from the requirement set — for a scoped
      // regen we discard everything outside the target module so we replace
      // exactly one slot, not 12.
      const moduleScenarios = (result.scenarios || []).filter((s) => (s.module || '').toLowerCase() === moduleLower);
      const replacements = moduleScenarios.length ? moduleScenarios : (result.scenarios || []).slice(0, 1);
      if (!replacements.length) {
        return res.status(502).json({
          success: false, code: 'EMPTY_OUTPUT',
          message: 'Architect produced no scenarios for this module. Try regenerating the full suite or refining the BRD.',
        });
      }

      // Replace the old scenario + its cases atomically.
      await prisma.testScenario.deleteMany({ where: { id: existing.id, projectId: project.id } });

      const created = [];
      for (const s of replacements) {
        const scenario = await prisma.testScenario.create({
          data: {
            projectId: project.id,
            name: s.name, module: s.module, priority: s.priority,
            category: s.category, rationale: s.rationale,
            dependencyOn: encodeJson(s.dependencyOn), source: 'agent',
          },
        });
        const cases = [];
        for (const c of s.cases) {
          const tc = await prisma.testCase.create({
            data: {
              projectId: project.id,
              scenarioId: scenario.id,
              name: c.name, type: c.type, module: s.module,
              confidence: c.confidence, assertions: c.assertions,
              steps: encodeJson(c.steps || []),
              status: 'pending',
            },
          });
          cases.push({ ...tc, steps: c.steps || [] });
        }
        created.push({ ...inflateScenario(scenario), cases });
      }

      send('agent.phase.complete', { phase: 'architect', output: { scenarios: created.length, cases: created.reduce((a, s) => a + s.cases.length, 0), scoped: targetModule }, projectId: project.id });

      await audit.log({
        userId: req.user.id, action: 'agents.architect.regenerate-one',
        target: project.id,
        metadata: { module: targetModule, replaced: existing.id, scenarios: created.length },
        req,
      });

      res.json({ success: true, scenarios: created, scoped: targetModule });
    } catch (err) {
      console.error(`${TAG} ERROR:`, err.message);
      if (!res.headersSent) {
        return res.status(err.status || 500).json({ success: false, code: err.code || 'REGEN_FAILED', message: err.message });
      }
      next(err);
    }
  }
);

module.exports = router;
