'use strict';

/**
 * Shared conductor orchestration service.
 *
 * Extracted from routes/agents.js so that both the main agent pipeline
 * (routes/agents.js) and the blocked-item rerun path (routes/blocked.js)
 * can call runConductorWithRetries without duplicating the retry machinery
 * or creating a route-to-route require() dependency.
 *
 * Exports:
 *   runConductorWithRetries   — full retry orchestrator (Conductor + Critic + Supervisor)
 *   autoAnalyseBlockersForRun — post-run blockage analysis (inline, no HTTP round-trip)
 *   reloadScenariosForFailingCases — reload TC+scenario shape for a set of failing case IDs
 *   singleWavePlan            — wrap scenarios in a single serial wave
 *   loadSprintGuidance        — fetch Sprint.aiGuidance for a sprintId
 *   buildCaseGuidanceBlock    — build per-TC guidance bullet list for extraGuidance
 *   buildTestCredentialsBlock — format Project.testCredentials for the system prompt
 *   loadKnownLocatorsBlock    — build KB locator hint block for system prompt
 */

const prisma = require('../../prisma');
const readinessCompiler = require('../readinessCompiler');
const { resolveCaseDependencyClosure } = require('../caseDependencyClosure');
const { encodeJson, decodeJson } = require('../jsonField');
const {
  isPlanBackedCase,
  assertPersistedExecutionLineage,
} = require('../testDesignLineageGuard');
// Deterministic precondition stops — the test case is fine, a required input/record
// is missing. Critic/Supervisor must NOT run for these: there is nothing to rewrite,
// and running them adds a long silent delay (and can corrupt a valid case). Audit #3.
const TERMINAL_PRECONDITION_REASONS = new Set(['test_data_invalid', 'precondition_failed']);
const { joinGuidance } = require('../../lib/promptCompose');
const conductor = require('./conductorPinned');
const critic = require('./critic');
const supervisor = require('./supervisor');
const blockageAnalyzer = require('./blockageAnalyzer');
const failurePatterns = require('../failurePatterns');
const sessionRegistry = require('../sessionRegistry');
const { recomputeRunCounters } = require('../runs');
const {
  runControllerConductorOnce,
} = require('../controllerConductorRunner');

function loadedCasesOf(scenarios) {
  return (Array.isArray(scenarios) ? scenarios : [])
    .flatMap((scenario) => Array.isArray(scenario && scenario.cases) ? scenario.cases : [])
    .filter(Boolean);
}

async function assertRunnerExecutionLineage({ projectId, scenarios, client = prisma }) {
  const cases = loadedCasesOf(scenarios);
  if (!cases.length) return { ok: true, planBacked: false, executionAllowed: true, findings: [], blockingFindings: [], diagnosticFindings: [] };

  const generationIds = new Set(cases.map((testCase) => testCase.generationId).filter(Boolean));
  if (generationIds.size > 1) {
    const err = new Error('Execution refused because immutable cases do not identify one selected scenario generation.');
    err.code = 'GENERATION_MIXED_EXECUTION';
    err.status = 409;
    err.findings = [{
      code: 'execution_generation_mixed',
      generationIds: [...generationIds],
      testCaseIds: cases.map((testCase) => testCase.id).filter(Boolean),
    }];
    throw err;
  }

  if (!generationIds.size) {
    return { ok: true, planBacked: false, executionAllowed: true, findings: [], blockingFindings: [], diagnosticFindings: [] };
  }

  const generationId = [...generationIds][0];
  const generation = await client.scenarioGeneration.findFirst({
    where: { id: generationId, projectId },
    select: { id: true, projectId: true, coveragePlanJson: true },
  });
  if (!generation) {
    const err = new Error('Execution generation no longer belongs to this project.');
    err.code = 'GENERATION_MISMATCH';
    err.status = 409;
    throw err;
  }
  return assertPersistedExecutionLineage(generation, cases);
}

async function applyAgentCaseRevision({ testCase, revisedCase, client = prisma }) {
  if (!testCase || !revisedCase) return { applied: false, advisory: false, reason: 'revision_missing' };
  if (isPlanBackedCase(testCase)) {
    return { applied: false, advisory: true, reason: 'immutable_test_design_plan' };
  }
  const updated = await client.testCase.update({
    where: { id: testCase.id },
    data: {
      name: revisedCase.name || undefined,
      steps: encodeJson(revisedCase.steps || []),
      assertions: revisedCase.assertions || undefined,
      status: 'approved',
    },
  });
  const readiness = readinessCompiler.compileCaseReadiness(updated);
  await client.testCase.update({
    where: { id: updated.id },
    data: readinessCompiler.readinessUpdateData(readiness),
  }).catch(() => null);
  return { applied: true, advisory: false, reason: null, updated };
}

// Phase F (cost control) — execMode-driven attempt cap.
function maxConductorAttemptsFor(execMode) {
  const envOverride = Number(process.env.QAAI_MAX_CONDUCTOR_ATTEMPTS);
  if (Number.isFinite(envOverride) && envOverride > 0) return envOverride;
  return execMode === 'thorough' ? 2 : 1;
}

function buildTestCredentialsBlock(rawJson) {
  if (!rawJson || typeof rawJson !== 'string') return null;
  let arr;
  try { arr = JSON.parse(rawJson); } catch (_) { return null; }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const lines = ['## Available test users (use ONLY these — do not invent credentials)'];
  for (const u of arr) {
    if (!u || !u.email || !u.password) continue;
    const label = u.name ? `"${u.name}"` : `<unnamed>`;
    const notes = u.notes ? ` — notes: ${u.notes}` : '';
    lines.push(`- ${label} → email: ${u.email} / password: ${u.password}${notes}`);
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

async function loadSprintGuidance(sprintId) {
  if (!sprintId) return null;
  try {
    const row = await prisma.sprint.findUnique({
      where: { id: sprintId },
      select: { aiGuidance: true },
    });
    return row?.aiGuidance || null;
  } catch (_) {
    return null;
  }
}

async function loadKnownLocatorsBlock(projectId) {
  if (!projectId) return null;
  try {
    const allRows = await prisma.knowledgeBaseLocator.findMany({
      where: { projectId, healthScore: { gte: 30 } },
      orderBy: [{ healthScore: 'desc' }, { occurrences: 'desc' }],
      take: 60,
      select: {
        element: true, selector: true, strategy: true, role: true,
        accessibleName: true, intent: true, healthScore: true, pageUrl: true,
        domAnchor: true,
      },
    });
    if (!allRows.length) return null;

    // Split: discovered credentials vs DOM locators
    const credRows = allRows.filter((r) => r.role === 'discovered_credential');
    const locatorRows = allRows.filter((r) => r.role !== 'discovered_credential').slice(0, 50);

    const sections = [];

    if (credRows.length) {
      const credLines = ['## Known working credentials from prior runs'];
      credLines.push('USE THESE FIRST — do not reset passwords again unless these no longer work.');
      for (const r of credRows) {
        // element = "cred:{username}", selector = "{password}", intent = "...role: ESS..."
        const username = r.element.replace(/^cred:/, '');
        const password = r.selector || '(unknown)';
        const roleMatch = (r.intent || '').match(/role:\s*(\S+)/i);
        const userRole = roleMatch ? roleMatch[1] : '';
        credLines.push(`- Username: ${username} | Password: ${password}${userRole ? ` | Role: ${userRole}` : ''}`);
      }
      sections.push(credLines.join('\n'));
    }

    if (locatorRows.length) {
      const lines = ['## Known locators on this site (from prior runs — prefer these on first try)'];
      for (const r of locatorRows) {
        const intent = (r.intent || r.element || '').trim();
        if (!intent) continue;
        const parts = [];
        if (r.role) parts.push(`role=${r.role}`);
        if (r.accessibleName) parts.push(`name="${r.accessibleName.slice(0, 60)}"`);
        const meta = parts.length ? ` (${parts.join(', ')})` : '';
        const sel = r.selector && r.selector !== '(captured)' && r.selector !== '(unknown)'
          ? ` — last selector: ${String(r.selector).slice(0, 100)}`
          : '';
        lines.push(`- "${intent.slice(0, 60)}"${meta}${sel} — health ${r.healthScore}`);
        if (r.domAnchor) {
          const flat = r.domAnchor.replace(/\r?\n/g, ' ↵ ').replace(/\[ref=\w+\]/g, '').slice(0, 250);
          lines.push(`  ↳ DOM context: ${flat}`);
        }
      }
      lines.push(`If a known locator no longer matches the page, the healer will refresh it on failure — you don't need to be cautious about trying them.`);
      if (lines.length > 2) sections.push(lines.join('\n'));
    }

    return sections.length ? sections.join('\n\n') : null;
  } catch (_) {
    return null;
  }
}

function buildCaseGuidanceBlock(scenarios) {
  const items = (scenarios || [])
    .flatMap((s) => s.cases || [])
    .filter((c) => c && typeof c.userGuidance === 'string' && c.userGuidance.trim())
    .map((c) => `- TC "${c.name}": ${c.userGuidance.trim()}`);
  if (!items.length) return null;
  return items.join('\n');
}

async function reloadScenariosForFailingCases(testCaseIds, projectId) {
  if (!testCaseIds?.length) return [];
  const closure = await resolveCaseDependencyClosure({
    prisma,
    projectId,
    caseIds: testCaseIds,
    strict: true,
  });
  const cases = closure.cases;
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

async function excludeNotRunReadyScenarios(scenarios, { onExcluded } = {}) {
  const excluded = [];
  const out = [];
  for (const scn of (Array.isArray(scenarios) ? scenarios : [])) {
    if (!scn || !Array.isArray(scn.cases)) {
      if (scn) out.push(scn);
      continue;
    }
    const kept = [];
    for (const tc of scn.cases) {
      let readiness = null;
      try {
        readiness = readinessCompiler.compileCaseReadiness(tc);
        await prisma.testCase.update({
          where: { id: tc.id },
          data: readinessCompiler.readinessUpdateData(readiness),
        }).catch(() => null);
      } catch (_) {
        readiness = null;
      }
      if (!readiness || readiness.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED) {
        excluded.push({
          id: tc.id,
          name: tc.name,
          readinessStatus: readiness?.readinessStatus || readinessCompiler.READINESS_STATUS.BLOCKED,
          reasons: readiness?.readinessReasons || [{ code: 'readiness_compile_failed' }],
        });
      }
      kept.push(tc);
    }
    if (kept.length) out.push({ ...scn, cases: kept });
  }
  if (excluded.length && typeof onExcluded === 'function') {
    try { onExcluded(excluded); } catch (_) {}
  }
  return { scenarios: out, excluded };
}

function relevantRequirementText(allRequirements, tc) {
  if (!Array.isArray(allRequirements) || allRequirements.length === 0) return '';
  const matchModule = allRequirements.filter((r) => r.module && tc?.module && r.module.toLowerCase() === tc.module.toLowerCase());
  const pool = matchModule.length ? matchModule : allRequirements;
  return pool
    .map((r) => `### ${r.title || r.externalKey || r.id}\n${r.body || ''}`)
    .join('\n\n')
    .slice(0, 8000);
}

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

async function autoAnalyseBlockersForRun({ projectId, runId, apiKey, model, provider, aiGuidance, send, cancelToken }) {
  if (!runId || cancelToken?.cancelled) return;
  try {
    const blockerRows = await prisma.blockedItem.findMany({
      where: { projectId, runId, resolved: false },
      orderBy: { createdAt: 'desc' },
    });
    if (blockerRows.length === 0) return;

    send({ type: 'agent.phase.start', phase: 'analyst', label: 'Blockage Analyzer (auto)' });

    const tcIds = Array.from(new Set(blockerRows.map((b) => b.testCaseId).filter(Boolean)));
    const tcs = tcIds.length
      ? await prisma.testCase.findMany({
          where: { id: { in: tcIds } },
          select: { id: true, name: true, module: true, scenarioId: true },
        })
      : [];
    const tcById = new Map(tcs.map((t) => [t.id, t]));

    const runResults = await prisma.runResult.findMany({
      where: { runId },
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
      return tc ? { id: tc.id, name: tc.name, module: tc.module, assertions: tc.assertions, status: r.status } : null;
    }).filter(Boolean);

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

    const result = await blockageAnalyzer.run({
      apiKey, model, provider,
      blockers, runCases, dependencies,
      onLog: async (level, message) => send({ type: 'agent.phase.log', phase: 'analyst', level, message }),
      onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
      extraGuidance: aiGuidance,
      signal: cancelToken?.signal,
    });
    const now = new Date();
    await Promise.all(result.analyses.map((a) =>
      prisma.blockedItem.update({
        where: { id: a.id },
        data: {
          aiSummary: a.summary,
          aiCategory: a.category,
          aiSuggestedFix: a.suggestedFix,
          aiRootCauseTcId: a.rootCauseTcId,
          severity: a.severity,
          aiAnalyzedAt: now,
        },
      })
    ));
    send({ type: 'agent.phase.complete', phase: 'analyst', output: { analysed: result.analyses.length } });
    send({ type: 'blocked.analyzed', runId, count: result.analyses.length });
  } catch (err) {
    if (err.code !== 'CANCELLED') {
      send({ type: 'agent.phase.complete', phase: 'analyst', error: err.message });
    }
  }
}

async function runConductorWithRetries({
  project, sprintId, sprintGuidance, scenarios, plan, apiKey, model, provider, send, userId, requirements, onLog, cancelToken,
  verifierMode = 'deterministic',
  existingRunId = null,
}) {
  const execMode = project?.execMode === 'thorough' ? 'thorough' : 'fast';
  const MAX_CONDUCTOR_ATTEMPTS = maxConductorAttemptsFor(execMode);
  const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });

  // Shared execution gate — same promotion authority as the main pipeline. Drops
  // any case that compiles to `blocked` so the blocked-item rerun path (the only
  // caller of this runner) can't execute a blocked / no-assertions case. If every
  // case is excluded, emit a clear no-runnable-cases event and stop.
  {
    const __gate = await excludeNotRunReadyScenarios(scenarios, {
      onExcluded: (ex) => send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `Proceeding with ${ex.length} approved not-run-ready case${ex.length === 1 ? '' : 's'} by user choice: ${ex.slice(0, 8).map((e) => `"${e.name}" [${e.readinessStatus}]`).join(', ')}.` }),
    });
    scenarios = __gate.scenarios;
    if (!scenarios.length) {
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: 'No approved cases were loaded. Nothing to execute.' });
      send({ type: 'agent.phase.complete', phase: 'conductor', output: { ran: 0, noApprovedCases: true } });
      return;
    }
  }

  // Shared blocked/rerun execution chokepoint. Immutable generated cases must
  // still match the selected persisted TestDesignPlan revision before any
  // browser action or model phase starts.
  const lineageReport = await assertRunnerExecutionLineage({ projectId: project.id, scenarios });
  if (lineageReport.diagnosticFindings.length) {
    const affectedCaseIds = [...new Set(lineageReport.diagnosticFindings.map((finding) => finding.testCaseId).filter(Boolean))];
    const findingCodes = [...new Set(lineageReport.diagnosticFindings.map((finding) => finding.code).filter(Boolean))];
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
      message: `Proceeding with ${affectedCaseIds.length || 'approved'} selected case${affectedCaseIds.length === 1 ? '' : 's'} despite persisted lineage diagnostic(s): ${findingCodes.join(', ')}. The exact approved persisted cases will execute.` });
  }

  return runControllerConductorOnce({
    project,
    sprintId,
    scenarios,
    plan,
    userId,
    send,
    cancelToken,
    verifierMode,
    existingRunId,
  });

  /* Unreachable migration code below is removed in Phase 24. */
  let extraGuidance = joinGuidance({
    projectGuidance: project.aiGuidance,
    sprintGuidance,
    caseGuidance: buildCaseGuidanceBlock(scenarios),
  });
  const testCredentialsBlock = buildTestCredentialsBlock(project.testCredentials);
  const knownLocatorsBlock = await loadKnownLocatorsBlock(project.id);
  if (knownLocatorsBlock) {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
           message: `🧠 KB primed: injecting ${knownLocatorsBlock.split('\n').filter((l) => l.startsWith('- ')).length} known locator(s) into the agent prompt.` });
  }
  const learnedPatternsBlock = await failurePatterns.buildLearnedPatternsBlock(project.id);
  if (learnedPatternsBlock) {
    const patternCount = (learnedPatternsBlock.match(/^### /gm) || []).length;
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'info',
           message: `📚 Learning loop: injecting ${patternCount} pattern${patternCount === 1 ? '' : 's'} from prior runs on this project.` });
  }
  const inlineCritic = (input) => critic.runInline({ apiKey, model, provider, ...input, onLog: onLog('critic'), onRateLimit, extraGuidance });

  // In-place reruns always run exactly one attempt — the user has already
  // guided the case and wants one targeted execution, not a retry wave.
  const effectiveMaxAttempts = existingRunId ? 1 : MAX_CONDUCTOR_ATTEMPTS;

  let attempt = 1;
  let scenariosToRun = scenarios;
  let runningPlan = plan;
  let lastOutcome = null;
  const attemptHistories = new Map();

  while (attempt <= effectiveMaxAttempts && scenariosToRun.length > 0) {
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
        sprintId: sprintId || null,
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
        testCredentialsBlock,
        knownLocatorsBlock,
        learnedPatternsBlock,
        execMode,
        projectConfig: project,
        verifierMode,
        existingRunId,
        requirements,
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
      try {
        const inflight = await prisma.run.findFirst({
          where: { projectId: project.id, userId, status: 'running' },
          orderBy: { startedAt: 'desc' },
          select: { id: true },
        });
        if (inflight) {
          await prisma.run.update({
            where: { id: inflight.id },
            data: { status: 'failed', completedAt: new Date() },
          });
          const counters = await recomputeRunCounters(inflight.id);
          send({ type: 'run.counters', runId: inflight.id, projectId: project.id, ...counters });
          send({
            type: 'run.complete',
            runId: inflight.id,
            summary: {
              ...counters,
              total: counters.passed + counters.failed + counters.blocked + counters.skipped,
              passRate: 0,
              cancelled: false,
            },
            cancelled: false,
            systemic: true,
            suiteAbortReason: err.message,
          });
        }
      } catch (_) {}
      try {
        const closed = await sessionRegistry.closeForUser(userId);
        if (closed) send({ type: 'browser.session.end', runId: null });
      } catch (_) {}
      send({ type: 'agent.phase.complete', phase: 'conductor', attempt, error: err.message });
      return;
    }

    for (const h of (lastOutcome.history || [])) {
      const arr = attemptHistories.get(h.testCaseId) || [];
      arr.push({ attempt, ...h });
      attemptHistories.set(h.testCaseId, arr);
    }

    if (lastOutcome.cancelled || cancelToken?.cancelled) {
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'warn',
             message: `⛔ Run cancelled — skipping remaining attempts and Supervisor` });
      return;
    }

    if (lastOutcome.systemic) {
      if (lastOutcome.suiteAbortReason === 'daily token budget exceeded') {
        send({ type: 'agent.phase.log', phase: 'pipeline', level: 'warn',
               message: 'Daily AI budget reached - skipping retries and Supervisor. This is not a website failure.' });
      } else
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'error',
             message: `⚠ Systemic environment failure — skipping retries and Supervisor. Fix the environment and re-run.` });
      return;
    }

    const stillFailing = (lastOutcome.history || []).filter((h) => h.status !== 'pass');
    if (stillFailing.length === 0) break;

    // Audit #3 — deterministic precondition stop: if EVERY still-failing case stopped
    // on a terminal precondition (e.g. a required data record does not exist), there is
    // nothing for the Critic to REWRITE. The case is correct; the DATA is missing.
    // Running Critic/Supervisor here only adds a ~2-minute silent delay and risks
    // corrupting a valid case — so finish now (same "done, no more AI phases" return
    // the execMode-fast skip uses; the run was already finalized by the conductor pass).
    const rewritableFailing = stillFailing.filter((h) => !TERMINAL_PRECONDITION_REASONS.has(h.blockedReason));
    if (rewritableFailing.length === 0) {
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'info',
             message: `ℹ Skipping Critic/Supervisor — ${stillFailing.length} case(s) stopped on a deterministic precondition (test data / required record missing), not a rewritable defect. This is not a website failure.` });
      return;
    }

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
      let appliedRewriteCount = 0;
      let advisoryRewriteCount = 0;
      for (const rw of rewrites) {
        const rewriteTarget = await prisma.testCase.findUnique({
          where: { id: rw.testCaseId },
          select: { id: true, qualityContractJson: true },
        });
        const result = await applyAgentCaseRevision({ testCase: rewriteTarget, revisedCase: rw });
        if (result.applied) appliedRewriteCount += 1;
        if (result.advisory) {
          advisoryRewriteCount += 1;
          send({ type: 'agent.phase.log', phase: 'critic', level: 'info',
            message: `Critic revision for ${rw.testCaseId} is advisory only because the approved case is pinned to an immutable TestDesignPlan.` });
        }
      }
      await prisma.agentRun.update({
        where: { id: criticRun.id },
        data: { status: 'complete', output: encodeJson({ rewriteCount: rewrites.length, appliedRewriteCount, advisoryRewriteCount, notes }), completedAt: new Date() },
      });
      send({ type: 'agent.phase.complete', phase: 'critic', attempt, output: { rewriteCount: rewrites.length, appliedRewriteCount, advisoryRewriteCount, notes } });
    } catch (err) {
      await prisma.agentRun.update({
        where: { id: criticRun.id },
        data: { status: 'failed', error: err.message, completedAt: new Date() },
      });
      send({ type: 'agent.phase.complete', phase: 'critic', attempt, error: err.message });
    }

    scenariosToRun = await reloadScenariosForFailingCases(
      stillFailing.map((h) => h.testCaseId),
      project.id,
    );
    const retryGate = await excludeNotRunReadyScenarios(scenariosToRun, {
      onExcluded: (ex) => send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `Proceeding with ${ex.length} retry case${ex.length === 1 ? '' : 's'} despite readiness warning(s): ${ex.slice(0, 8).map((e) => `"${e.name}" [${e.readinessStatus}]`).join(', ')}.` }),
    });
    scenariosToRun = retryGate.scenarios;
    if (!scenariosToRun.length) {
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: 'No retry cases were loaded after refresh.' });
      return;
    }
    runningPlan = singleWavePlan(scenariosToRun);
    attempt++;
  }

  if (cancelToken?.cancelled) return;
  const finalFailing = (lastOutcome?.history || []).filter((h) => h.status !== 'pass');
  if (finalFailing.length === 0) return;

  // Audit #3 — same precondition guard before Supervisor: if all remaining failures are
  // terminal precondition stops, there is nothing to supervise/rewrite. Finish now.
  const supervisableFailing = finalFailing.filter((h) => !TERMINAL_PRECONDITION_REASONS.has(h.blockedReason));
  if (supervisableFailing.length === 0) {
    send({ type: 'agent.phase.log', phase: 'pipeline', level: 'info',
           message: `ℹ Skipping Supervisor — remaining failure(s) are deterministic precondition stops (missing test data / record), not rewritable defects.` });
    return;
  }

  if (execMode === 'fast') {
    send({ type: 'agent.phase.log', phase: 'pipeline', level: 'info',
           message: `ℹ Skipping Supervisor + supervised retry — project execMode is 'fast'. Switch to 'thorough' in Project Setup to enable.` });
    return;
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
        await prisma.blockedItem.create({
          data: {
            projectId: project.id,
            sprintId: sprintId || null,
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
        const revisionResult = await applyAgentCaseRevision({ testCase: tcRow, revisedCase: sup.revisedCase });
        if (revisionResult.advisory) {
          send({ type: 'agent.phase.log', phase: 'supervisor', level: 'info',
            message: `Supervisor revision for "${tcRow?.name}" is advisory only because the approved case is pinned to an immutable TestDesignPlan.` });
        }
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

  if (cancelToken?.cancelled) return;
  const supervisedIds = Object.keys(guidanceByTcId);
  if (supervisedIds.length === 0) return;

  let finalScenarios = await reloadScenariosForFailingCases(supervisedIds, project.id);
  if (finalScenarios.length === 0) return;
  const finalGate = await excludeNotRunReadyScenarios(finalScenarios, {
    onExcluded: (ex) => send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
      message: `Proceeding with ${ex.length} supervised case${ex.length === 1 ? '' : 's'} despite readiness warning(s): ${ex.slice(0, 8).map((e) => `"${e.name}" [${e.readinessStatus}]`).join(', ')}.` }),
  });
  finalScenarios = finalGate.scenarios;
  if (finalScenarios.length === 0) {
    send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: 'No supervised cases were loaded after refresh.' });
    return;
  }

  send({ type: 'agent.phase.start', phase: 'conductor', label: 'Execution Conductor · final (supervised)', attempt: MAX_CONDUCTOR_ATTEMPTS + 1 });
  const finalRun = await prisma.agentRun.create({
    data: { projectId: project.id, userId, phase: `conductor.${MAX_CONDUCTOR_ATTEMPTS + 1}` },
  });
  try {
    const finalGuidance = joinGuidance({
      projectGuidance: project.aiGuidance,
      sprintGuidance,
      caseGuidance: buildCaseGuidanceBlock(finalScenarios),
    });
    const outcome = await conductor.run({
      userId,
      provider,
      projectId: project.id,
      sprintId: sprintId || null,
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
      testCredentialsBlock,
      knownLocatorsBlock,
      learnedPatternsBlock,
      execMode,
      projectConfig: project,
      requirements,
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

  await autoAnalyseBlockersForRun({
    projectId: project.id,
    runId: lastOutcome?.runId,
    apiKey, model, provider,
    aiGuidance: project.aiGuidance || null,
    send, cancelToken,
  });
}

module.exports = {
  runConductorWithRetries,
  autoAnalyseBlockersForRun,
  reloadScenariosForFailingCases,
  singleWavePlan,
  loadSprintGuidance,
  buildCaseGuidanceBlock,
  buildTestCredentialsBlock,
  loadKnownLocatorsBlock,
  loadedCasesOf,
  assertRunnerExecutionLineage,
  applyAgentCaseRevision,
};
