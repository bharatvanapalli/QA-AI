'use strict';

/**
 * Orchestrates the three-agent pipeline:
 *   1. Architect  — produces scenarios from requirements
 *   2. Planner    — produces an execution plan from scenarios
 *   3. Conductor  — drives the live browser, emits real spec files, persists Run/PRs/Blocked
 *
 * Streams progress to the user's per-user WebSocket channel.
 */

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const architect = require('../services/agents/architect');
const planner = require('../services/agents/planner');
const conductor = require('../services/agents/conductor');
const critic = require('../services/agents/critic');
const supervisor = require('../services/agents/supervisor');
const mcp = require('../services/mcp');
const sessionRegistry = require('../services/sessionRegistry');
const cancelRegistry = require('../services/cancelRegistry');

const MAX_CONDUCTOR_ATTEMPTS = Number(process.env.QAAI_MAX_CONDUCTOR_ATTEMPTS) || 3;
const { encodeJson, decodeJson, encodeArray } = require('../services/jsonField');
const { requireAuth } = require('../middleware/auth');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const { joinGuidance } = require('../lib/promptCompose');

// Build a per-test-case guidance block for the scenarios about to run.
// Each TC with a non-empty `userGuidance` becomes a bullet. Returns null
// when no cases have guidance, so the composer can skip the section.
function buildCaseGuidanceBlock(scenarios) {
  const items = (scenarios || [])
    .flatMap((s) => s.cases || [])
    .filter((c) => c && typeof c.userGuidance === 'string' && c.userGuidance.trim())
    .map((c) => `- TC "${c.name}": ${c.userGuidance.trim()}`);
  if (!items.length) return null;
  return items.join('\n');
}

const router = express.Router({ mergeParams: true });
router.use(requireAuth);

// Live browser sessions are kept in sessionRegistry (singleton module).

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, userId: req.user.id },
  });
}

/**
 * Refuse a new pipeline start if one is already alive for this user+project.
 * Two signals: a 'running' Run row, or a live cancel token. Either means a
 * pipeline is in flight — starting another would race on the MCP session
 * and on the architect's `deleteMany scenarios` call.
 *
 * Reaper flips crashed runs to 'cancelled' within ~30 s so a legitimate
 * retry isn't blocked for long.
 *
 * @returns {object|null} A response payload to send with status 409 if a
 *   run is in progress, otherwise null.
 */
async function blockIfRunInProgress(req, project) {
  const activeRun = await prisma.run.findFirst({
    where: { userId: req.user.id, projectId: project.id, status: 'running' },
    select: { id: true },
  });
  const liveToken = cancelRegistry.get(req.user.id);
  if (activeRun || (liveToken && !liveToken.cancelled)) {
    return {
      success: false,
      code: 'RUN_IN_PROGRESS',
      message: 'A pipeline is already running for this project. Open the Live Pipeline or wait for it to finish.',
      runId: activeRun?.id || null,
    };
  }
  return null;
}

/**
 * Load TestCase rows by id and reshape them as the Conductor expects:
 *   [{ scenario..., cases: [{...tc, steps: [...] }] }, ...]
 *
 * Used by the retry loop to feed the latest (Critic-rewritten) versions
 * of failing cases back into the Conductor.
 */
async function reloadScenariosForFailingCases(testCaseIds, projectId) {
  if (!testCaseIds?.length) return [];
  const cases = await prisma.testCase.findMany({
    where: { id: { in: testCaseIds }, projectId },
  });
  // Group by scenarioId. Cases without a scenarioId fall into a synthetic group.
  const byScenario = new Map();
  for (const c of cases) {
    const sid = c.scenarioId || `__loose_${c.id}`;
    const arr = byScenario.get(sid) || [];
    arr.push({ ...c, steps: decodeJson(c.steps, []) || [] });
    byScenario.set(sid, arr);
  }
  const scenarios = [];
  for (const [sid, casesArr] of byScenario.entries()) {
    let scenarioRow = null;
    if (!sid.startsWith('__loose_')) {
      scenarioRow = await prisma.testScenario.findUnique({ where: { id: sid } });
    }
    scenarios.push({
      id: scenarioRow?.id || sid,
      name: scenarioRow?.name || `Retry batch · ${casesArr[0]?.module || 'misc'}`,
      module: scenarioRow?.module || casesArr[0]?.module || 'misc',
      priority: scenarioRow?.priority || 'P2',
      category: scenarioRow?.category || 'positive',
      rationale: scenarioRow?.rationale || '',
      dependencyOn: scenarioRow ? (decodeJson(scenarioRow.dependencyOn, []) || []) : [],
      cases: casesArr,
    });
  }
  return scenarios;
}

/**
 * Best-effort: find the Requirement text that produced this test case.
 * Strategy: pick requirements with matching module if any; otherwise
 * concatenate the project's requirements (truncated) and let Claude figure
 * it out.
 */
function relevantRequirementText(allRequirements, tc) {
  if (!Array.isArray(allRequirements) || allRequirements.length === 0) return '';
  const matchModule = allRequirements.filter((r) => r.module && tc?.module && r.module.toLowerCase() === tc.module.toLowerCase());
  const pool = matchModule.length ? matchModule : allRequirements;
  return pool
    .map((r) => `### ${r.title || r.externalKey || r.id}\n${r.body || ''}`)
    .join('\n\n')
    .slice(0, 8000);
}

/**
 * Build a wave plan that contains every supplied scenario in a single wave.
 * Used by the retry path — the original Planner output may not reference the
 * rewritten test cases by scenarioId, so we synthesise a fresh single-wave plan.
 */
function singleWavePlan(scenarios) {
  return {
    waves: [{
      id: 1,
      scenarioIds: scenarios.map((s) => s.id),
      parallel: false,
      why: 'Retry wave — sequential to share one MCP session',
    }],
    estimatedDurationSec: 0,
    riskFactors: [],
  };
}

/**
 * Full retry orchestrator: runs up to MAX_CONDUCTOR_ATTEMPTS Conductor passes,
 * invoking the post-mortem Critic between each. If cases still fail, escalates
 * to the Supervisor and runs one final supervised attempt.
 *
 * @param {object} opts
 * @param {object} opts.project
 * @param {Array}  opts.scenarios          initial scenarios for attempt 1
 * @param {object} opts.plan               initial Planner output
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {function} opts.send             WS broadcaster
 * @param {string} opts.userId
 * @param {Array}  opts.requirements       Requirement rows for Supervisor context
 * @param {function} opts.onLog
 */
async function runConductorWithRetries({
  project, scenarios, plan, apiKey, model, provider, send, userId, requirements, onLog, cancelToken,
}) {
  // Forwards Anthropic rate-limit headers to the client over WS so the
  // Reports page can render a live TPM-remaining chip. Defined once and
  // reused by every Claude call below (Conductor + Critic + Supervisor +
  // inline-Critic).
  const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

  // Compose the operator guidance block that all per-run agents share:
  //   * Project-wide `aiGuidance` (Settings → Claude)
  //   * Per-case `userGuidance` for cases in this batch (Reports detail pane)
  // Built once at the top of the retry loop because the scenarios list is
  // stable across attempts (Critic/Supervisor mutate cases in DB but the
  // userGuidance field isn't touched). Refreshed via the reload step below.
  let extraGuidance = joinGuidance({
    projectGuidance: project.aiGuidance,
    caseGuidance: buildCaseGuidanceBlock(scenarios),
  });
  const inlineCritic = (input) => critic.runInline({ apiKey, model, provider, ...input, onLog: onLog('critic'), onRateLimit, extraGuidance });

  let attempt = 1;
  let scenariosToRun = scenarios;
  let runningPlan = plan;
  let lastOutcome = null;
  const attemptHistories = new Map();   // testCaseId -> [{ attempt, ...history }]

  while (attempt <= MAX_CONDUCTOR_ATTEMPTS && scenariosToRun.length > 0) {
    if (cancelToken?.cancelled) {
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'warn',
             message: `⛔ Cancelled before attempt ${attempt} (${cancelToken.reason || 'user_requested'})` });
      return;
    }
    const phaseLabel = MAX_CONDUCTOR_ATTEMPTS > 1
      ? `Execution Conductor · attempt ${attempt}/${MAX_CONDUCTOR_ATTEMPTS}`
      : 'Execution Conductor';
    send({ type: 'agent.phase.start', phase: 'conductor', label: phaseLabel, attempt });
    const conductorRun = await prisma.agentRun.create({
      data: { projectId: project.id, userId, phase: `conductor.${attempt}` },
    });
    try {
      lastOutcome = await conductor.run({
        userId,
        provider,
        projectId: project.id,
        plan: runningPlan,
        scenarios: scenariosToRun,
        apiKey, model,
        framework: project.framework || 'playwright-pom',
        targetUrl: project.targetUrl || process.env.QAAI_TARGET_URL || 'https://demo.playwright.dev/todomvc',
        send,
        inlineCritic,
        attempt,
        cancelToken,
        onRateLimit,
        extraGuidance,
      });
      await prisma.agentRun.update({
        where: { id: conductorRun.id },
        data: { status: 'complete', output: encodeJson({ runId: lastOutcome.runId, summary: lastOutcome.summary }), completedAt: new Date() },
      });
      send({ type: 'agent.phase.complete', phase: 'conductor', attempt, output: { runId: lastOutcome.runId, summary: lastOutcome.summary } });
    } catch (err) {
      await prisma.agentRun.update({
        where: { id: conductorRun.id },
        data: { status: 'failed', error: err.message, completedAt: new Date() },
      });
      send({ type: 'agent.phase.complete', phase: 'conductor', attempt, error: err.message });
      return; // a hard Conductor failure stops the loop
    }

    for (const h of (lastOutcome.history || [])) {
      const arr = attemptHistories.get(h.testCaseId) || [];
      arr.push({ attempt, ...h });
      attemptHistories.set(h.testCaseId, arr);
    }

    // Short-circuit if the user cancelled mid-attempt
    if (lastOutcome.cancelled || cancelToken?.cancelled) {
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'warn',
             message: `⛔ Run cancelled — skipping remaining attempts and Supervisor` });
      return;
    }

    // Short-circuit if the failure was systemic (environment, not test logic).
    // Retrying or escalating to Supervisor cannot help when Chromium isn't installed,
    // the corp proxy is blocking, or the MCP session can't start.
    if (lastOutcome.systemic) {
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'error',
             message: `⚠ Systemic environment failure — skipping retries and Supervisor. Fix the environment and re-run.` });
      return;
    }

    const stillFailing = (lastOutcome.history || []).filter((h) => h.status !== 'pass');
    if (stillFailing.length === 0) break;

    // ── Post-mortem Critic ──────────────────────────────────────
    send({ type: 'agent.phase.start', phase: 'critic', label: `Critic · attempt ${attempt}`, attempt });
    const criticRun = await prisma.agentRun.create({
      data: { projectId: project.id, userId, phase: `critic.${attempt}` },
    });
    try {
      const { rewrites, notes } = await critic.run({
        apiKey, model, provider,
        runOutcome: { runId: lastOutcome.runId, history: stillFailing, summary: lastOutcome.summary },
        onLog: onLog('critic'),
        onRateLimit,
        extraGuidance,
      });
      for (const rw of rewrites) {
        await prisma.testCase.update({
          where: { id: rw.testCaseId },
          data: {
            name: rw.name || undefined,
            steps: encodeJson(rw.steps || []),
            assertions: rw.assertions || undefined,
            // Auto-approve the rewrite for the next retry attempt — the user
            // would have to re-approve manually otherwise, which defeats the
            // automatic retry loop. The final status is decided by the loop.
            status: 'approved',
          },
        });
      }
      await prisma.agentRun.update({
        where: { id: criticRun.id },
        data: { status: 'complete', output: encodeJson({ rewriteCount: rewrites.length, notes }), completedAt: new Date() },
      });
      send({ type: 'agent.phase.complete', phase: 'critic', attempt, output: { rewriteCount: rewrites.length, notes } });
    } catch (err) {
      await prisma.agentRun.update({
        where: { id: criticRun.id },
        data: { status: 'failed', error: err.message, completedAt: new Date() },
      });
      send({ type: 'agent.phase.complete', phase: 'critic', attempt, error: err.message });
      // If the Critic broke we still try one more Conductor pass with the
      // unmodified failing cases — sometimes flakiness alone is the issue.
    }

    // Reload the (possibly rewritten) failing cases for the next attempt
    scenariosToRun = await reloadScenariosForFailingCases(
      stillFailing.map((h) => h.testCaseId),
      project.id,
    );
    runningPlan = singleWavePlan(scenariosToRun);
    attempt++;
  }

  // ── Supervisor fallback ────────────────────────────────────────
  if (cancelToken?.cancelled) return;
  const finalFailing = (lastOutcome?.history || []).filter((h) => h.status !== 'pass');
  if (finalFailing.length === 0) {
    return; // everything passed — no supervisor needed
  }

  send({ type: 'agent.phase.start', phase: 'supervisor', label: 'Supervisor (final intervention)' });
  const supRun = await prisma.agentRun.create({
    data: { projectId: project.id, userId, phase: 'supervisor' },
  });
  const guidanceByTcId = {};
  const giveUps = [];
  try {
    for (const h of finalFailing) {
      const attemptsForCase = attemptHistories.get(h.testCaseId) || [];
      const tcRow = await prisma.testCase.findUnique({ where: { id: h.testCaseId } });
      let sup;
      try {
        sup = await supervisor.run({
          apiKey, model, provider,
          attempts: attemptsForCase,
          originalCase: tcRow ? { ...tcRow, steps: decodeJson(tcRow.steps, []) || [] } : null,
          requirement: relevantRequirementText(requirements, tcRow),
          onLog: onLog('supervisor'),
          onRateLimit,
          extraGuidance,
        });
      } catch (err) {
        send({ type: 'agent.phase.log', phase: 'supervisor', level: 'error', message: `   ✗ supervisor call failed for ${tcRow?.name}: ${err.message}` });
        continue;
      }

      if (sup.giveUp) {
        await prisma.testCase.update({ where: { id: h.testCaseId }, data: { status: 'blocked' } });
        await prisma.blockedItem.create({
          data: {
            projectId: project.id,
            runId: lastOutcome.runId,
            testCaseId: h.testCaseId,
            reason: 'supervisor_giveup',
            locator: null,
            message: String(sup.giveUp.reason || '').slice(0, 1000),
          },
        });
        giveUps.push({ testCaseId: h.testCaseId, reason: sup.giveUp.reason });
        send({ type: 'agent.phase.log', phase: 'supervisor', level: 'warn',
               message: `   ⛔ giving up on "${tcRow?.name}": ${sup.giveUp.reason}` });
      } else if (sup.revisedCase) {
        await prisma.testCase.update({
          where: { id: h.testCaseId },
          data: {
            name: sup.revisedCase.name || undefined,
            steps: encodeJson(sup.revisedCase.steps || []),
            assertions: sup.revisedCase.assertions || undefined,
            status: 'approved',
          },
        });
        if (sup.guidance) guidanceByTcId[h.testCaseId] = sup.guidance;
        send({ type: 'agent.phase.log', phase: 'supervisor', level: 'info',
               message: `   🧭 guidance for "${tcRow?.name}": ${(sup.guidance || '').slice(0, 200)}` });
        if (sup.contextNotes) {
          send({ type: 'agent.phase.log', phase: 'supervisor', level: 'info',
                 message: `   📝 context note: ${sup.contextNotes.slice(0, 200)}` });
        }
      }
    }
    await prisma.agentRun.update({
      where: { id: supRun.id },
      data: {
        status: 'complete',
        output: encodeJson({ reviewedCount: finalFailing.length, giveUps: giveUps.length, guidedCount: Object.keys(guidanceByTcId).length }),
        completedAt: new Date(),
      },
    });
    send({ type: 'agent.phase.complete', phase: 'supervisor',
           output: { reviewed: finalFailing.length, giveUps: giveUps.length, guided: Object.keys(guidanceByTcId).length } });
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: supRun.id },
      data: { status: 'failed', error: err.message, completedAt: new Date() },
    });
    send({ type: 'agent.phase.complete', phase: 'supervisor', error: err.message });
    return;
  }

  // ── Final supervised attempt ───────────────────────────────────
  if (cancelToken?.cancelled) return;
  const supervisedIds = Object.keys(guidanceByTcId);
  if (supervisedIds.length === 0) return;

  const finalScenarios = await reloadScenariosForFailingCases(supervisedIds, project.id);
  if (finalScenarios.length === 0) return;

  send({ type: 'agent.phase.start', phase: 'conductor', label: 'Execution Conductor · final (supervised)', attempt: MAX_CONDUCTOR_ATTEMPTS + 1 });
  const finalRun = await prisma.agentRun.create({
    data: { projectId: project.id, userId, phase: `conductor.${MAX_CONDUCTOR_ATTEMPTS + 1}` },
  });
  try {
    // Refresh extra-guidance with the (potentially supervisor-rewritten)
    // final scenario set so any per-case notes still apply.
    const finalGuidance = joinGuidance({
      projectGuidance: project.aiGuidance,
      caseGuidance: buildCaseGuidanceBlock(finalScenarios),
    });
    const outcome = await conductor.run({
      userId,
      provider,
      projectId: project.id,
      plan: singleWavePlan(finalScenarios),
      scenarios: finalScenarios,
      apiKey, model,
      framework: project.framework || 'playwright-pom',
      targetUrl: project.targetUrl || process.env.QAAI_TARGET_URL || 'https://demo.playwright.dev/todomvc',
      send,
      inlineCritic,
      onRateLimit,
      extraGuidance: finalGuidance,
      attempt: MAX_CONDUCTOR_ATTEMPTS + 1,
      guidanceByTcId,
      cancelToken,
    });
    await prisma.agentRun.update({
      where: { id: finalRun.id },
      data: { status: 'complete', output: encodeJson({ runId: outcome.runId, summary: outcome.summary }), completedAt: new Date() },
    });
    send({ type: 'agent.phase.complete', phase: 'conductor', attempt: MAX_CONDUCTOR_ATTEMPTS + 1, output: { runId: outcome.runId, summary: outcome.summary } });
  } catch (err) {
    await prisma.agentRun.update({
      where: { id: finalRun.id },
      data: { status: 'failed', error: err.message, completedAt: new Date() },
    });
    send({ type: 'agent.phase.complete', phase: 'conductor', attempt: MAX_CONDUCTOR_ATTEMPTS + 1, error: err.message });
  }
}

// ── POST /api/projects/:projectId/agents/start ────────────
// Runs Architect → Planner → Conductor end-to-end and streams progress over WS.
router.post(
  '/start',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false,
          code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured for this project. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });
      // Forwards rate-limit headers to the client over WS — the Reports page
      // consumes these to render a live TPM-remaining chip. Gemini provider
      // never emits these events (Google's API doesn't return per-request
      // remaining-tokens headers); the UI hides the chip when provider!=claude.
      const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

      // Respond immediately — work runs async
      res.status(202).json({ success: true, message: 'Agent pipeline started. Open the Theater view.' });

      // ── Fire and forget ─────────────────────────────────
      // Cancel token created up-front (BEFORE architect) so Terminate works
      // during the entire pipeline, not only after planner completes.
      const cancelToken = cancelRegistry.create(req.user.id);
      (async () => {
        try {
          // ── Phase 1: Architect ────────────────────────────
          send({ type: 'agent.phase.start', phase: 'architect', label: 'Scenario Architect' });
          const requirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          if (!requirements.length) {
            send({ type: 'agent.phase.complete', phase: 'architect', error: 'No requirements found' });
            return;
          }

          const architectRun = await prisma.agentRun.create({
            data: { projectId: project.id, userId: req.user.id, phase: 'architect', input: encodeJson({ requirementCount: requirements.length }) },
          });

          let architectResult;
          try {
            architectResult = await architect.run({ apiKey, model, provider, requirements, onLog: onLog('architect'), signal: cancelToken.signal, onRateLimit, extraGuidance: project.aiGuidance || null });
          } catch (err) {
            const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
            await prisma.agentRun.update({ where: { id: architectRun.id }, data: { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : err.message, completedAt: new Date() } });
            send({ type: 'agent.phase.complete', phase: 'architect', error: cancelled ? 'cancelled' : err.message, cancelled });
            return;
          }

          // Persist scenarios
          // Wipe the prior generation cleanly so the Test Cases page and the
          // dashboard always agree on what "current" means. Status-filtered
          // delete left scenario-less orphans (status='running' from
          // interrupted runs, status='rejected' from user actions) that
          // contaminated dashboard counts. RunResult / GovernancePR /
          // BlockedItem rows clean up by cascade / SetNull from schema.
          await prisma.testScenario.deleteMany({ where: { projectId: project.id } });
          await prisma.testCase.deleteMany({ where: { projectId: project.id } });

          const persistedScenarios = [];
          for (const s of architectResult.scenarios) {
            const scenario = await prisma.testScenario.create({
              data: {
                projectId: project.id, name: s.name, module: s.module, priority: s.priority,
                category: s.category, rationale: s.rationale,
                dependencyOn: encodeJson(s.dependencyOn), source: 'agent',
              },
            });
            const cases = [];
            for (const c of s.cases) {
              const tc = await prisma.testCase.create({
                data: {
                  projectId: project.id, scenarioId: scenario.id, name: c.name, type: c.type,
                  module: s.module, confidence: c.confidence, assertions: c.assertions,
                  steps: encodeJson(c.steps || []),
                  status: 'pending',
                },
              });
              cases.push({ ...tc, steps: c.steps || [] });
            }
            persistedScenarios.push({ ...scenario, dependencyOn: s.dependencyOn, cases });
          }
          await prisma.agentRun.update({
            where: { id: architectRun.id },
            data: { status: 'complete', output: encodeJson({ scenarioCount: persistedScenarios.length }), completedAt: new Date() },
          });
          send({ type: 'agent.phase.complete', phase: 'architect', output: { scenarios: persistedScenarios.length } });

          if (cancelToken.cancelled) return;

          // ── Phase 2: Planner ─────────────────────────────
          send({ type: 'agent.phase.start', phase: 'planner', label: 'Dependency Planner' });
          const plannerRun = await prisma.agentRun.create({
            data: { projectId: project.id, userId: req.user.id, phase: 'planner' },
          });
          let planResult;
          try {
            // Convert persisted scenario names→ids in dependencyOn (Architect produced names)
            const scenariosForPlanner = persistedScenarios.map((s) => ({
              id: s.id, name: s.name, module: s.module, priority: s.priority, category: s.category,
              rationale: s.rationale,
              dependencyOn: (s.dependencyOn || []).map((depName) => persistedScenarios.find((x) => x.name === depName)?.id).filter(Boolean),
            }));
            planResult = await planner.run({ apiKey, model, provider, scenarios: scenariosForPlanner, onLog: onLog('planner'), signal: cancelToken.signal, onRateLimit, extraGuidance: project.aiGuidance || null });
          } catch (err) {
            const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
            await prisma.agentRun.update({ where: { id: plannerRun.id }, data: { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : err.message, completedAt: new Date() } });
            send({ type: 'agent.phase.complete', phase: 'planner', error: cancelled ? 'cancelled' : err.message, cancelled });
            return;
          }
          await prisma.agentRun.update({
            where: { id: plannerRun.id },
            data: { status: 'complete', output: encodeJson(planResult.plan), completedAt: new Date() },
          });
          send({ type: 'agent.phase.complete', phase: 'planner', output: planResult.plan });

          if (cancelToken.cancelled) return;

          // ── Phase 3+: Conductor (with retry loop) + Critic + Supervisor ──
          await runConductorWithRetries({
            project,
            scenarios: persistedScenarios,
            plan: planResult.plan,
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements,
            onLog,
            cancelToken,
          });

          await audit.log({ userId: req.user.id, action: 'agents.pipeline.complete', target: project.id, req });
        } catch (err) {
          console.error('[agents] pipeline error', err);
          send({ type: 'agent.phase.log', phase: 'pipeline', level: 'error', message: err.message });
        } finally {
          cancelRegistry.clear(req.user.id);
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

// ── POST /api/projects/:projectId/agents/execute ──────────
// Runs Planner + Conductor on already-persisted scenarios.
// Only APPROVED test cases are executed; scenarios with no approved cases are skipped.
router.post(
  '/execute',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      // Load scenarios with ONLY approved cases
      const scenarios = await prisma.testScenario.findMany({
        where: { projectId: project.id },
        include: { cases: { where: { status: 'approved' } } },
      });
      const scenariosWithApproved = scenarios
        .filter((s) => s.cases.length > 0)
        .map((s) => ({
          ...s,
          dependencyOn: decodeJson(s.dependencyOn, []) || [],
          cases: s.cases.map((c) => ({ ...c, steps: decodeJson(c.steps, []) || [] })),
        }));

      if (!scenariosWithApproved.length) {
        return res.status(400).json({
          success: false, code: 'NO_APPROVED',
          message: 'Approve at least one test case before running.',
        });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });
      const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

      res.status(202).json({
        success: true,
        message: `Executing ${scenariosWithApproved.length} scenario(s) with ${scenariosWithApproved.reduce((a, s) => a + s.cases.length, 0)} approved case(s). Watch the Theater.`,
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      (async () => {
        try {
          // ── Phase 2: Planner ─────────────────────────────
          send({ type: 'agent.phase.start', phase: 'planner', label: 'Dependency Planner' });
          const plannerRun = await prisma.agentRun.create({
            data: { projectId: project.id, userId: req.user.id, phase: 'planner' },
          });
          let planResult;
          try {
            const scenariosForPlanner = scenariosWithApproved.map((s) => ({
              id: s.id, name: s.name, module: s.module, priority: s.priority, category: s.category,
              rationale: s.rationale, dependencyOn: s.dependencyOn || [],
            }));
            planResult = await planner.run({ apiKey, model, provider, scenarios: scenariosForPlanner, onLog: onLog('planner'), signal: cancelToken.signal, onRateLimit, extraGuidance: project.aiGuidance || null });
          } catch (err) {
            const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
            await prisma.agentRun.update({ where: { id: plannerRun.id }, data: { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : err.message, completedAt: new Date() } });
            send({ type: 'agent.phase.complete', phase: 'planner', error: cancelled ? 'cancelled' : err.message, cancelled });
            return;
          }
          await prisma.agentRun.update({
            where: { id: plannerRun.id },
            data: { status: 'complete', output: encodeJson(planResult.plan), completedAt: new Date() },
          });
          send({ type: 'agent.phase.complete', phase: 'planner', output: planResult.plan });

          if (cancelToken.cancelled) return;

          // ── Phase 3+: Conductor (with retry loop) + Critic + Supervisor ──
          const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          await runConductorWithRetries({
            project,
            scenarios: scenariosWithApproved,
            plan: planResult.plan,
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
          });

          await audit.log({ userId: req.user.id, action: 'agents.execute.complete', target: project.id, req });
        } catch (err) {
          console.error('[agents] execute error', err);
          send({ type: 'agent.phase.log', phase: 'pipeline', level: 'error', message: err.message });
        } finally {
          cancelRegistry.clear(req.user.id);
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/projects/:projectId/agents/failed-cases ─────
// Returns a summary of the latest Run for this project + how many cases
// did not pass — used by the Theater banner to decide whether to surface
// the "Re-run failed cases" prompt.
router.get('/failed-cases', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const lastRun = await prisma.run.findFirst({
      where: { projectId: project.id, userId: req.user.id },
      orderBy: { startedAt: 'desc' },
    });
    if (!lastRun) {
      return res.json({ success: true, lastRun: null, failedCount: 0 });
    }
    // Count test cases whose RunResult on this run was not 'pass'
    const failedResults = await prisma.runResult.findMany({
      where: { runId: lastRun.id, status: { not: 'pass' } },
      select: { testCaseId: true, status: true, error: true, testCase: { select: { name: true, module: true } } },
    });
    const uniq = new Map();
    for (const r of failedResults) {
      if (!uniq.has(r.testCaseId)) uniq.set(r.testCaseId, r);
    }
    res.json({
      success: true,
      lastRun: {
        id: lastRun.id,
        sprintName: lastRun.sprintName,
        status: lastRun.status,
        passed: lastRun.passed,
        failed: lastRun.failed,
        blocked: lastRun.blocked,
        skipped: lastRun.skipped,
        startedAt: lastRun.startedAt,
        completedAt: lastRun.completedAt,
      },
      failedCount: uniq.size,
      failedCases: Array.from(uniq.values()).slice(0, 50).map((r) => ({
        id: r.testCaseId,
        status: r.status,
        name: r.testCase?.name || null,
        module: r.testCase?.module || null,
        error: (r.error || '').slice(0, 200),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/agents/rerun-failed ────
// Re-runs ONLY the cases that did not pass in the latest Run for this
// project. Flips those cases back to 'approved', synthesises a single-wave
// plan, then calls the same runConductorWithRetries helper used by /execute.
router.post(
  '/rerun-failed',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      const lastRun = await prisma.run.findFirst({
        where: { projectId: project.id, userId: req.user.id },
        orderBy: { startedAt: 'desc' },
      });
      if (!lastRun) {
        return res.status(400).json({ success: false, code: 'NO_RUNS', message: 'No previous run found for this project.' });
      }
      const failedResults = await prisma.runResult.findMany({
        where: { runId: lastRun.id, status: { not: 'pass' } },
        select: { testCaseId: true },
      });
      const failedTcIds = [...new Set(failedResults.map((r) => r.testCaseId))];
      if (failedTcIds.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_FAILURES', message: 'No failing cases in the last run.' });
      }

      // Flip the failed cases back to approved so the Conductor picks them up
      await prisma.testCase.updateMany({
        where: { id: { in: failedTcIds }, projectId: project.id },
        data: { status: 'approved' },
      });

      const scenariosForRerun = await reloadScenariosForFailingCases(failedTcIds, project.id);
      if (scenariosForRerun.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_SCENARIOS', message: 'Failed cases could not be reloaded as scenarios.' });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, msg);
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });

      res.status(202).json({
        success: true,
        message: `Re-running ${failedTcIds.length} failed case(s). Watch the Live Pipeline.`,
        caseCount: failedTcIds.length,
        previousRunId: lastRun.id,
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      (async () => {
        try {
          const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          // Architect/Planner already ran on the original pipeline. Synthesise a
          // single-wave plan over just the failed cases so the Conductor + Critic +
          // Supervisor loop kicks in immediately.
          await runConductorWithRetries({
            project,
            scenarios: scenariosForRerun,
            plan: singleWavePlan(scenariosForRerun),
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
          });
          await audit.log({ userId: req.user.id, action: 'agents.rerun_failed.complete', target: project.id, req });
        } catch (err) {
          console.error('[agents] rerun-failed error', err);
          send({ type: 'agent.phase.log', phase: 'pipeline', level: 'error', message: err.message });
        } finally {
          cancelRegistry.clear(req.user.id);
        }
      })();
    } catch (err) {
      next(err);
    }
  }
);

// ── GET /api/projects/:projectId/agents/runs ──────────────
router.get('/runs', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const runs = await prisma.agentRun.findMany({
      where: { projectId: project.id },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    res.json({
      success: true,
      runs: runs.map((r) => ({
        ...r,
        input: decodeJson(r.input, null),
        output: decodeJson(r.output, null),
        log: decodeJson(r.log, []),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/agents/cancel ──────────
// Sets the cancel flag on the user's active run token. The Conductor and
// retry orchestrator check this between turns/attempts and exit early.
// The in-flight MCP browser session is torn down in the Conductor's finally block.
router.post('/cancel', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const cancelled = cancelRegistry.cancel(req.user.id, 'user_requested');
    const broadcast = req.app.locals.broadcastToUser;
    if (cancelled && broadcast) {
      broadcast(req.user.id, { type: 'agent.phase.log', phase: 'pipeline', level: 'warn', message: '⛔ Cancellation requested — stopping after current step' });
    }
    res.json({ success: true, cancelled });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/agents/status ───────────
// Lightweight check: is there a cancel token alive for this user? The UI uses
// this on page load to decide whether to show the Cancel button.
router.get('/status', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const token = cancelRegistry.get(req.user.id);
    res.json({
      success: true,
      running: !!token && !token.cancelled,
      cancelRequested: !!token && token.cancelled,
    });
  } catch (err) {
    next(err);
  }
});

// ── Element-picker control ────────────────────────────────
// POST /api/projects/:projectId/agents/picker/arm
// Phase S: the picker is snapshot-driven via MCP. We grab a fresh
// accessibility snapshot from the live MCP session, translate every visible
// interactable element into Playwright locator candidates ranked by stability,
// and broadcast them as `picker.candidates` — the same WS message the Theater
// UI already consumes.
router.post('/picker/arm', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const session = sessionRegistry.get(req.user.id);
    if (!session || !session.client) {
      return res.status(400).json({ success: false, code: 'NO_SESSION', message: 'No active MCP browser session. Start a pipeline first.' });
    }
    const broadcast = req.app.locals.broadcastToUser;
    const send = (msg) => broadcast && broadcast(req.user.id, msg);

    const snap = await mcp.snapshot(session);
    if (snap.error) {
      send({ type: 'picker.candidates', candidates: [] });
      return res.status(502).json({ success: false, code: 'SNAPSHOT_FAILED', message: snap.error });
    }
    const candidates = mcp.parseMcpSnapshotToCandidates(snap.text);
    send({ type: 'picker.armed' });
    send({ type: 'picker.candidates', candidates });
    res.json({ success: true, count: candidates.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
