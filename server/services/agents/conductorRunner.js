'use strict';

/**
 * Shared conductor orchestration service.
 *
 * Extracted from routes/agents.js so that both the main agent pipeline
 * (routes/agents.js) and the blocked-item path (routes/blocked.js)
 * enter the same single-attempt BrowserTransactionController runtime.
 *
 * Exports:
 *   runConductorWithRetries   — compatibility name for the single controller entry
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
const { decodeJson } = require('../jsonField');
const {
  assertPersistedExecutionLineage,
} = require('../testDesignLineageGuard');
const blockageAnalyzer = require('./blockageAnalyzer');
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
};
