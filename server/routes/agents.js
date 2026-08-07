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
const readinessCompiler = require('../services/readinessCompiler');
const { resolveCaseDependencyClosure } = require('../services/caseDependencyClosure');
const verifier = require('../services/agents/verifier');
const mcp = require('../services/mcp');
const sessionRegistry = require('../services/sessionRegistry');
const cancelRegistry = require('../services/cancelRegistry');
const blockageAnalyzer = require('../services/agents/blockageAnalyzer');
const reporter = require('../services/agents/reporter');
const postMortem = require('../services/agents/postMortem');
const failurePatterns = require('../services/failurePatterns');
const budget = require('../services/budget');
const { buildQuarantineContextBlock } = require('../lib/architectPriorContext');
const pipelineContract = require('../services/pipelineContract');
const canonicalGenerationPipeline = require('../services/canonicalGenerationPipeline');
const { syncScenarioGenerationCounts } = require('../services/scenarioGenerationCounts');
const {
  normalizeScenarioPersistenceBatch,
  buildScenarioCreateData,
} = require('../services/scenarioPersistenceContract');
const sourceGrounding = require('../services/sourceGrounding');
const coveragePlanner = require('../services/coveragePlanner');
const { extractProceduralFlowContract } = require('../services/proceduralFlowContract');
const { isPlanBackedCase, assertPersistedExecutionLineage } = require('../services/testDesignLineageGuard');
const {
  coverageDefectsFromValidation,
  collectScenarioReliabilityArtifacts,
  collectScenarioReliabilityDefects,
  summarizeDefects,
} = require('../services/reliability/contracts');
const { createScenarioReliabilityReport } = require('../services/reliability/promotion');
const { runGenerationSelfHealingPipeline } = require('../services/reliability/selfHealingPipeline');
const {
  createRepairTasks,
  runReliabilityRepairOrchestrator,
  stopReasonForDefects,
} = require('../services/reliability/orchestrator');
const { defaultReliabilityRepairers } = require('../services/reliability/repairers');
const reliabilityJobs = require('../services/reliability/jobs');
const { verifyPersistedGenerationContract } = require('../services/reliability/postPersistVerification');
const {
  promotionIssuesForGeneration,
} = require('../services/reliability/generationPromotionGuard');
const {
  hasRealExecutionResult,
  isNonExecutionPlaceholderResult,
} = require('../lib/runResultSemantics');
const {
  runControllerConductorOnce,
} = require('../services/controllerConductorRunner');

function summarizePostPersistDefects(verification, limit = 12) {
  const defects = Array.isArray(verification && verification.defects) ? verification.defects : [];
  return defects.slice(0, limit).map((defect) => ({
    code: defect && defect.code,
    caseId: defect && defect.caseId,
    message: defect && defect.message,
    evidence: defect && defect.evidence,
  }));
}

function countPostPersistDefects(verification) {
  const defects = Array.isArray(verification && verification.defects) ? verification.defects : [];
  return defects.reduce((acc, defect) => {
    const code = defect && defect.code || 'unknown';
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {});
}

// Agent review may propose safer steps, but approved test contracts must not be
// silently overwritten during execution. Operators can temporarily opt in for
// legacy self-healing retry behavior, but the default is review-only.
const AUTO_APPLY_AGENT_REWRITES = pipelineContract.autoApplyAgentRewritesEnabled();

function coverageAcceptedRegistry(scenarios = []) {
  return (Array.isArray(scenarios) ? scenarios : []).map((s) => ({
    name: s && s.name,
    cases: (Array.isArray(s && s.cases) ? s.cases : []).map((c) => ({
      name: c && c.name,
      coverageRefs: coveragePlanner.caseCoverageRefs(c),
    })),
  }));
}

function repairOrchestratorEnabled() {
  const raw = process.env.QAAI_REPAIR_ORCHESTRATOR_ENABLED
    || process.env.REPAIR_ORCHESTRATOR_ENABLED
    || 'true';
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function capabilityGroundingEnabled() {
  const raw = process.env.QAAI_CAPABILITY_GROUNDING_ENABLED
    || process.env.CAPABILITY_GROUNDING_ENABLED
    || 'true';
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

async function finalizeAgentCoverage({
  manifest,
  scenarios,
  testData,
  projectId = null,
  generationId = null,
  idempotencyKey = null,
  retryOfJobId = null,
  resumeFromStage = null,
  calibrationAtlas = null,
  appCapabilityMap = null,
  targetUrl = null,
  authRole = null,
}) {
  const scenarioGenerationJob = reliabilityJobs.createScenarioGenerationJob({
    projectId,
    generationId,
    idempotencyKey,
    retryOfJobId,
    resumeFromStage,
  });
  reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {
    status: reliabilityJobs.JOB_STATUS.VALIDATING,
    stage: reliabilityJobs.JOB_STATUS.VALIDATING,
    progress: 35,
    reason: 'coverage_validation_started',
  });
  try {
  if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) {
    reliabilityJobs.completeScenarioGenerationJobFromReport(scenarioGenerationJob, { status: 'ready', unresolvedDefects: [] });
    return {
      scenarios,
      validation: null,
      repair: null,
      summary: { required: 0, covered: 0, repaired: 0, needsReview: 0, missingCapability: 0 },
    };
  }
  const first = coveragePlanner.validateCoveragePlan({ manifest, scenarios, testData });
  const working = Array.isArray(scenarios) ? [...scenarios] : [];
  const repair = {
    repaired: 0,
    synthesizedScenarioCount: 0,
    missingBefore: first.missingRequired.map((item) => item.manifestItemId),
    prompts: [],
  };
  // Synthesis removed: the Architect's output is authoritative. Deterministic synthesis
  // was creating blob scenarios that packed all uncovered items into one unlabelled scenario
  // instead of distributing them logically. The Architect already decided which cases to
  // generate; if a manifest item isn't covered, that is a quality hint — not a trigger to
  // append synthetic cases. The story-match fallback in validateCoveragePlan credits most
  // cases; anything genuinely uncovered is surfaced in qualityHints for diagnostics only.
  let validation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: working, testData });
  // Coverage gaps are quality warnings, not fatal generation errors. Only throw for
  // structural failures (invalid schema, etc.) — not for uncovered manifest items.
  const fatalFindings = (validation.findings || []).filter(
    (f) => f.severity === 'error' && f.code !== 'coverage_required_missing',
  );
  if (fatalFindings.length) {
    const err = new Error(`Coverage plan validation failed: ${fatalFindings.map((f) => f.code).join(', ')}`);
    err.code = 'COVERAGE_PLAN_VALIDATION_FAILED';
    err.status = 422;
    err.coverageValidation = validation;
    throw err;
  }
  let summary = coveragePlanner.coverageSummary(validation, repair);
  summary.ok = validation.ok;
  summary.missingRequired = Array.isArray(validation.missingRequired) ? validation.missingRequired.length : 0;
  summary.needsReview = working.flatMap((s) => Array.isArray(s.cases) ? s.cases : [])
    .filter((c) => c && (c.coverageDisposition === 'needs_review' || c.automatability === 'manual')).length;
  let groundedCapabilityMap = appCapabilityMap || null;
  let appCapabilitySummary = {};
  if (capabilityGroundingEnabled()) {
    try {
      const capabilityService = require('../services/reliability/capabilityMap');
      groundedCapabilityMap = groundedCapabilityMap || (calibrationAtlas
        ? capabilityService.buildAppCapabilityMapFromAtlas({
          projectId,
          atlas: calibrationAtlas,
          source: 'calibration_atlas_fallback',
        })
        : null);
      appCapabilitySummary = capabilityService.summarizeCapabilityMap(groundedCapabilityMap);
    } catch (_) {
      groundedCapabilityMap = null;
      appCapabilitySummary = { present: false, missing: 1 };
    }
  }
  const reliabilityContext = {
    coverageManifest: manifest,
    appCapabilityMap: groundedCapabilityMap,
    capabilityGroundingRequired: capabilityGroundingEnabled(),
    targetUrl,
    authRole,
  };
  let reliabilityDefects = [
    ...coverageDefectsFromValidation(validation),
    ...collectScenarioReliabilityDefects(working, reliabilityContext),
  ];
  let repairPlan = createRepairTasks({ defects: reliabilityDefects });
  let repairRounds = [];
  let repairAuditEvents = [];
  let repairStopReason = stopReasonForDefects(reliabilityDefects);
  let repairWallClockMs = 0;
  let repairToolCallsUsed = 0;
  let skippedRepairsDueToBudget = repairPlan.skippedRepairsDueToBudget;
  if (repairOrchestratorEnabled() && repairPlan.tasks.length) {
    reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {
      status: reliabilityJobs.JOB_STATUS.REPAIRING,
      stage: reliabilityJobs.JOB_STATUS.REPAIRING,
      progress: 62,
      reason: 'repair_orchestrator_started',
    });
    const validateReliability = (nextScenarios) => {
      const nextValidation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: nextScenarios, testData });
      return [
        ...coverageDefectsFromValidation(nextValidation),
        ...collectScenarioReliabilityDefects(nextScenarios, reliabilityContext),
      ];
    };
    const repairResult = await runReliabilityRepairOrchestrator({
      scenarios: working,
      defects: reliabilityDefects,
      context: reliabilityContext,
      repairers: defaultReliabilityRepairers,
      validate: validateReliability,
      isCancelled: () => scenarioGenerationJob.cancelRequested,
    });
    working.splice(0, working.length, ...(repairResult.scenarios || working));
    reliabilityDefects = repairResult.defects || reliabilityDefects;
    validation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: working, testData });
    summary = coveragePlanner.coverageSummary(validation, repair);
    summary.ok = validation.ok;
    summary.missingRequired = Array.isArray(validation.missingRequired) ? validation.missingRequired.length : 0;
    summary.needsReview = working.flatMap((s) => Array.isArray(s.cases) ? s.cases : [])
      .filter((c) => c && (c.coverageDisposition === 'needs_review' || c.automatability === 'manual')).length;
    repairPlan = createRepairTasks({ defects: reliabilityDefects });
    repairRounds = repairResult.repairRounds || [];
    repairAuditEvents = repairResult.auditEvents || [];
    repairStopReason = repairResult.repairStopReason || stopReasonForDefects(reliabilityDefects);
    repairWallClockMs = repairResult.wallClockMs || 0;
    repairToolCallsUsed = repairResult.toolCallsUsed || 0;
    repair.tokensUsed = repairResult.tokensUsed || 0;
    repair.repairBudget = repairResult.budget || null;
    skippedRepairsDueToBudget = repairResult.skippedRepairsDueToBudget || repairPlan.skippedRepairsDueToBudget;
    repair.reliabilityRepairRounds = repairRounds;
    repair.reliabilityAuditEvents = repairAuditEvents;
    repair.reliabilityStopReason = repairStopReason;
  }
  const reliabilityArtifacts = collectScenarioReliabilityArtifacts(working, reliabilityContext);
  const defectSummary = summarizeDefects(reliabilityDefects);
  const reliabilityReport = createScenarioReliabilityReport({
    scenarios: working,
    defects: reliabilityDefects,
    coverageSummary: summary,
    reliabilityArtifacts,
    repairTasks: repairPlan.tasks,
    repairRounds,
    repairAuditEvents,
    repairStopReason,
    repairRoundsUsed: repairRounds.length,
    tokensUsed: repair.tokensUsed || 0,
    wallClockMs: repairWallClockMs,
    toolCallsUsed: repairToolCallsUsed,
    skippedRepairsDueToBudget,
    repairBudget: repair.repairBudget || null,
    stepShapeSummary: defectSummary.step_shape || {},
    dataBindingSummary: defectSummary.data_binding || {},
    browserActionSummary: defectSummary.browser_action || {},
    oracleSummary: defectSummary.oracle || {},
    semanticQualitySummary: defectSummary.semantic_quality || {},
    appCapabilitySummary: {
      ...appCapabilitySummary,
      ...(defectSummary.app_capability || {}),
    },
  });
  if (scenarioGenerationJob.cancelRequested || repairStopReason === 'cancelled') {
    reliabilityJobs.failScenarioGenerationJob(scenarioGenerationJob, 'Reliability repair job was cancelled.');
  } else {
    reliabilityJobs.completeScenarioGenerationJobFromReport(scenarioGenerationJob, reliabilityReport);
  }
  reliabilityReport.scenarioGenerationJob = reliabilityJobs.serializeScenarioGenerationJob(scenarioGenerationJob);
  summary.reliabilityStatus = reliabilityReport.status;
  summary.unresolvedDefects = reliabilityReport.unresolvedDefects.length;
  return { scenarios: working, validation, repair, summary, reliabilityReport, appCapabilityMap: groundedCapabilityMap, appCapabilitySummary };
  } catch (err) {
    reliabilityJobs.failScenarioGenerationJob(scenarioGenerationJob, err && err.message ? err.message : 'Agent coverage finalization failed.');
    if (err && typeof err === 'object') {
      err.scenarioGenerationJob = reliabilityJobs.serializeScenarioGenerationJob(scenarioGenerationJob);
    }
    throw err;
  }
}

async function assertRunBudgetAvailable(req, res) {
  try {
    await budget.assertWithinLimit(req.user.id);
    return true;
  } catch (err) {
    if (err?.code !== 'BUDGET_EXCEEDED') throw err;
    res.status(429).json({
      success: false,
      code: 'BUDGET_EXCEEDED',
      message: err.message,
      budget: err.budget || null,
    });
    return false;
  }
}
const { encodeJson, decodeJson, encodeArray } = require('../services/jsonField');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');
const { joinGuidance } = require('../lib/promptCompose');

// Format Project.testCredentials (JSON string) into a system-prompt block the
// Conductor can inject. Returns null when the field is empty so the prompt
// stays clean. Passwords ARE included — they're already user-authorised for
// the agent's use; the alternative (forcing the user to re-paste per run) is
// worse UX without adding security since the agent runs server-side.
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

// Resolve the active sprint's aiGuidance for the given sprintId. Returns null
// when no sprint is in scope, or when the sprint has no guidance set. Phase B+
// stacks this between project-wide guidance and per-case guidance via
// promptCompose.joinGuidance. Look-up is one row; cached per run is fine.
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

// Phase E1.7 — proactive KB priming. At the start of every run, load the
// project's non-quarantined `KnowledgeBaseLocator` rows so the Conductor's
// system prompt can prepend a "Known locators on this site" block. The
// agent uses these on FIRST attempt (not just on failure via the healer),
// which is what makes Sprint 2 genuinely faster than Sprint 1.
//
// Filter:  healthScore >= 30 (quarantine threshold) AND occurrences >= 1.
// Order:   healthScore desc, occurrences desc — best-known locators first.
// Cap:     50 rows. More than that and the prompt budget loses signal.
//
// Returns formatted markdown block or null when KB is empty / brand-new.
async function loadKnownLocatorsBlock(projectId) {
  if (!projectId) return null;
  try {
    const rows = await prisma.knowledgeBaseLocator.findMany({
      where: { projectId, healthScore: { gte: 30 } },
      orderBy: [{ healthScore: 'desc' }, { occurrences: 'desc' }],
      take: 50,
      select: {
        element: true, selector: true, strategy: true, role: true,
        accessibleName: true, intent: true, healthScore: true, pageUrl: true,
      },
    });
    if (!rows.length) return null;
    const lines = ['## Known locators on this site (from prior runs — prefer these on first try)'];
    for (const r of rows) {
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
    }
    lines.push(`If a known locator no longer matches the page, the healer will refresh it on failure — you don't need to be cautious about trying them.`);
    return lines.length > 2 ? lines.join('\n') : null;
  } catch (_) {
    return null;
  }
}

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
router.use(requireOrg);

// Live browser sessions are kept in sessionRegistry (singleton module).

async function ownProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

async function requireExecutionGeneration(projectId, requestedGenerationId) {
  const generationId = typeof requestedGenerationId === 'string' ? requestedGenerationId.trim() : '';
  if (!generationId) {
    const err = new Error('generationId is required for execution. Run the exact generation currently visible in Test Cases.');
    err.status = 400;
    err.code = 'GENERATION_ID_REQUIRED';
    throw err;
  }
  const generation = await prisma.scenarioGeneration.findFirst({
    where: { id: generationId, projectId },
    select: { id: true, version: true, isCurrent: true },
  });
  if (!generation) {
    const err = new Error('The requested scenario generation does not belong to this project. Refresh Test Cases and select a valid generation.');
    err.status = 409;
    err.code = 'GENERATION_MISMATCH';
    throw err;
  }
  return generation;
}

const STALE_AGENT_RUN_MS = Number(process.env.QAAI_STALE_AGENT_RUN_MS || 30 * 60 * 1000);

function staleAgentRunCutoff() {
  return new Date(Date.now() - STALE_AGENT_RUN_MS);
}

async function cleanupStaleAgentRuns({ projectId, userId = null } = {}) {
  const where = {
    status: 'running',
    startedAt: { lt: staleAgentRunCutoff() },
  };
  if (projectId) where.projectId = projectId;
  if (userId) where.userId = userId;
  return prisma.agentRun.updateMany({
    where,
    data: {
      status: 'cancelled',
      completedAt: new Date(),
      error: 'Stale agent run cleaned up after no active pipeline heartbeat.',
    },
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
  await cleanupStaleAgentRuns({ projectId: project.id, userId: req.user.id });
  // Phase E8 — scope to the project (which is already org-gated via the
  // ownProject helper). Drops the userId filter so a teammate's running
  // pipeline correctly blocks a second user in the same org.
  const activeRun = await prisma.run.findFirst({
    where: { projectId: project.id, status: 'running' },
    select: { id: true },
  });
  const liveToken = cancelRegistry.get(req.user.id);
  // Self-heal a leaked cancelRegistry token. The check has to be both
  // age-bounded AND DB-aware:
  //   • Run rows only exist once the Conductor starts — Architect / Planner
  //     phases run BEFORE any Run row, so checking Run alone would falsely
  //     reap a token whose Planner is mid-flight (regression 2026-05-28:
  //     planner cancelled mid-call when /status fired during the bootstrap
  //     window). Use AgentRun in addition — every phase writes one with
  //     status='running' on entry.
  //   • Bootstrap window: even the AgentRun.create takes ~50–200 ms after
  //     cancelRegistry.create. A 10-second age floor covers any combination
  //     of slow DB + slow loadSprintGuidance + slow IIFE startup.
  if (!activeRun && liveToken && !liveToken.cancelled) {
    const tokenAgeMs = Date.now() - (liveToken.createdAt || 0);
    const activeAgentRun = await prisma.agentRun.findFirst({
      where: {
        projectId: project.id,
        userId: req.user.id,
        status: 'running',
        startedAt: { gte: staleAgentRunCutoff() },
      },
      select: { id: true },
    });
    if (!activeAgentRun && tokenAgeMs > 10_000) {
      console.warn('[agents] leaked cancelRegistry token cleared for user', req.user.id,
        '— no active Run/AgentRun in DB, token age', Math.round(tokenAgeMs / 1000), 's.');
      cancelRegistry.clear(req.user.id);
      return null;
    }
  }
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
  const closure = await resolveCaseDependencyClosure({
    prisma,
    projectId,
    caseIds: testCaseIds,
    strict: true,
  });
  const cases = closure.cases;
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
          readinessStatus: readiness?.readinessStatus || 'blocked',
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

function normalizeRunMode(input) {
  return input === 'sequential' ? 'sequential' : 'grouped';
}

function strictSequentialPlan(scenarios, sourcePlan = null) {
  const byId = new Map((Array.isArray(scenarios) ? scenarios : []).map((s) => [s.id, s]));
  const orderedIds = [];
  const seen = new Set();
  for (const wave of sourcePlan?.waves || []) {
    for (const sid of wave?.scenarioIds || []) {
      if (byId.has(sid) && !seen.has(sid)) {
        seen.add(sid);
        orderedIds.push(sid);
      }
    }
  }
  for (const scenario of byId.values()) {
    if (!seen.has(scenario.id)) orderedIds.push(scenario.id);
  }
  return {
    waves: orderedIds.map((scenarioId, index) => ({
      id: index + 1,
      scenarioIds: [scenarioId],
      parallel: false,
      why: 'Strict sequential trigger mode — one scenario per wave.',
    })),
    estimatedDurationSec: Number(sourcePlan?.estimatedDurationSec || 0),
    riskFactors: [
      ...(Array.isArray(sourcePlan?.riskFactors) ? sourcePlan.riskFactors : []),
      'Trigger mode forced strict sequential scenario waves.',
    ],
  };
}

function planForRunMode(plan, scenarios, runMode) {
  return normalizeRunMode(runMode) === 'sequential'
    ? strictSequentialPlan(scenarios, plan)
    : (plan || singleWavePlan(scenarios));
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
// THOROUGH-mode staleness threshold for the Site Atlas. A crawl older than
// this (or missing, or zero-page) is refreshed before a thorough run.
const ATLAS_STALE_DAYS = Number(process.env.QAAI_ATLAS_STALE_DAYS) || 14;

/**
 * THOROUGH only — refresh the Site Atlas before a run when it's missing or
 * stale, so the executor resolves elements against a live-verified map rather
 * than a months-old one (or improvising blind). Best-effort: any failure
 * leaves the previous atlas (if any) in place and the run proceeds. Honours
 * the pipeline cancel token so a user-cancel during the crawl aborts it.
 */
async function maybeRecalibrateStaleAtlas({ project, execMode, userId, send, cancelToken }) {
  if (execMode !== 'thorough' || cancelToken?.cancelled) return;
  const startUrl = project.targetUrl || process.env.QAAI_TARGET_URL || null;
  if (!startUrl) return; // nothing to crawl

  const latest = await prisma.calibration.findFirst({
    where: { projectId: project.id, status: 'complete' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, pagesCount: true },
  });
  const ageDays = latest ? (Date.now() - new Date(latest.createdAt).getTime()) / 86_400_000 : Infinity;
  const stale = !latest || (latest.pagesCount || 0) === 0 || ageDays > ATLAS_STALE_DAYS;
  if (!stale) {
    send({ type: 'agent.phase.log', phase: 'calibrator', level: 'info',
           message: `🗺 Site Atlas is fresh (${latest.pagesCount} pages, ~${Math.round(ageDays)}d old) — skipping recalibration.` });
    return;
  }
  // Don't start a second crawl if one is already live for this user.
  const existing = cancelRegistry.get(userId + ':calibrator');
  if (existing && !existing.cancelled) {
    send({ type: 'agent.phase.log', phase: 'calibrator', level: 'warn',
           message: `🗺 A calibration is already running — proceeding with whatever atlas is available.` });
    return;
  }

  send({ type: 'agent.phase.start', phase: 'calibrator', label: 'Calibrator · refreshing Site Atlas (thorough)' });
  send({ type: 'agent.phase.log', phase: 'calibrator', level: 'info',
         message: latest
           ? `🗺 Atlas is ~${Math.round(ageDays)} days old — thorough mode is refreshing it against the live site before executing.`
           : `🗺 No Site Atlas yet — thorough mode is crawling the site before executing so the executor runs on verified ground truth.` });

  const calibration = await prisma.calibration.create({
    data: { projectId: project.id, startUrl, status: 'running' },
    select: { id: true },
  });
  try {
    const { runCalibrator } = require('../services/agents/calibrator');
    // Reuse the pipeline cancel token's signal so a user-cancel aborts the
    // crawl too. The calibrator manages its own MCP session under a separate
    // sessionRegistry key, so it won't collide with the Conductor (which
    // hasn't started yet — this runs before the retry loop).
    await runCalibrator({
      projectId: project.id, userId, calibrationId: calibration.id,
      startUrl, send, signal: cancelToken?.signal,
    });
    send({ type: 'agent.phase.complete', phase: 'calibrator', output: { refreshed: true } });
  } catch (err) {
    send({ type: 'agent.phase.log', phase: 'calibrator', level: 'warn',
           message: `🗺 Recalibration failed (${err.message}) — proceeding with the previous atlas if any.` });
    send({ type: 'agent.phase.complete', phase: 'calibrator', error: err.message });
  }
}

async function runConductorWithRetries({
  project, sprintId, sprintGuidance, scenarios, plan, apiKey, model, provider, send, userId, requirements, onLog, cancelToken,
  generationId = null,
  // DEFECT 4 — semantic_fallback is now the STANDARD verifier, not an opt-in.
  // On a deterministic miss it asks the LLM "does this snapshot satisfy the
  // assertion's intent?" (mid-tier model, ~600-token cap, fires only on a
  // miss, never overrides a deterministic pass). This is what stops the AI
  // from failing a case over a real-site label the BRD didn't predict.
  verifierMode = 'semantic_fallback',
  existingRunId = null,
  resumeMode = false,
}) {
  const scenarioGenerationIds = new Set(
    (scenarios || []).flatMap((scenario) => (scenario && scenario.cases) || [])
      .map((testCase) => testCase && testCase.generationId)
      .filter(Boolean),
  );
  const executionGenerationId = generationId || (scenarioGenerationIds.size === 1 ? [...scenarioGenerationIds][0] : null);
  if (!existingRunId && scenarioGenerationIds.size > 1) {
    const err = new Error('Execution refused because the selected cases span multiple scenario generations.');
    err.code = 'GENERATION_MIXED_EXECUTION';
    err.status = 409;
    throw err;
  }
  if (!existingRunId && !executionGenerationId && scenarioGenerationIds.size > 0) {
    const err = new Error('Execution requires an explicit generationId so the visible cases are the cases that run.');
    err.code = 'GENERATION_ID_REQUIRED';
    err.status = 400;
    throw err;
  }
  if (executionGenerationId && scenarioGenerationIds.size === 1 && !scenarioGenerationIds.has(executionGenerationId)) {
    const err = new Error('Execution generation does not match the generation of the selected cases.');
    err.code = 'GENERATION_MISMATCH';
    err.status = 409;
    throw err;
  }
  if (executionGenerationId) {
    const generationAuthority = await prisma.scenarioGeneration.findFirst({
      where: { id: executionGenerationId, projectId: project.id },
      select: { id: true, projectId: true, coveragePlanJson: true },
    });
    if (!generationAuthority) {
      const err = new Error('Execution generation no longer belongs to this project.');
      err.code = 'GENERATION_MISMATCH';
      err.status = 409;
      throw err;
    }
    const lineageReport = assertPersistedExecutionLineage(
      generationAuthority,
      (scenarios || []).flatMap((scenario) => Array.isArray(scenario && scenario.cases) ? scenario.cases : []),
    );
    if (lineageReport.diagnosticFindings.length) {
      const affectedCaseIds = [...new Set(lineageReport.diagnosticFindings.map((finding) => finding.testCaseId).filter(Boolean))];
      const findingCodes = [...new Set(lineageReport.diagnosticFindings.map((finding) => finding.code).filter(Boolean))];
      send({
        type: 'agent.phase.log',
        phase: 'conductor',
        level: 'warn',
        message: `Proceeding with ${affectedCaseIds.length || 'approved'} selected case${affectedCaseIds.length === 1 ? '' : 's'} despite persisted lineage diagnostic(s): ${findingCodes.join(', ')}. The exact approved cases from generation ${executionGenerationId} will execute.`,
      });
    }
  }
  // ── Promotion gate (universal conductor chokepoint) ────────────────────────
  // Every conductor entry point (/execute, /run-smoke, and the focused/rerun
  // paths) funnels through here, and several AUTO-APPROVE pending cases via
  // updateMany — bypassing the approve-route gate. So this is the catch-all: the
  // CaseCompiler drops any case that compiles to `blocked` (a legacy approved-
  // but-broken case, or an auto-approved one) BEFORE it can run. Filtering (not
  // refusing the whole run) keeps the good cases running; excluded cases are
  // logged loudly. Empty scenarios after filtering are removed.
  {
    const __gate = await excludeNotRunReadyScenarios(scenarios, {
      onExcluded: (ex) => send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `Proceeding with ${ex.length} approved not-run-ready case${ex.length === 1 ? '' : 's'} by user choice: ${ex.slice(0, 8).map((e) => `"${e.name}" [${e.readinessStatus}]`).join(', ')}${ex.length > 8 ? `, +${ex.length - 8} more` : ''}.` }),
    });
    scenarios = __gate.scenarios;
    if (!Array.isArray(scenarios) || !scenarios.length) {
      send({ type: 'agent.phase.log', phase: 'conductor', level: 'warn', message: 'No approved cases were loaded. Nothing to execute.' });
      send({ type: 'agent.phase.complete', phase: 'conductor', output: { ran: 0, noApprovedCases: true } });
      return;
    }
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
    resumeMode,
    generationId: executionGenerationId,
  });

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

/**
 * Best-effort post-run RCA + cross-run pattern extraction (Phase G).
 * Runs Reporter on fresh fail/blocked results, then hands the enriched
 * failures to postMortem so FailurePattern rows accumulate automatically
 * after every run — not only when the user clicks the Analyze button.
 * Only processes results where rcaWhat is still null (won't re-analyze
 * results the user already analyzed manually).
 */
async function autoAnalyseFailuresForRun({ projectId, runId, apiKey, model, provider, aiGuidance, send, cancelToken }) {
  if (!runId || cancelToken?.cancelled) return;
  try {
    const failures = await prisma.runResult.findMany({
      where: { runId, status: { in: ['fail', 'blocked'] }, rcaWhat: null },
      include: { testCase: { select: { id: true, name: true, module: true, type: true } } },
    });
    if (!failures.length) return;

    send({ type: 'agent.phase.start', phase: 'reporter', label: 'Reporter (auto)' });

    const preparedFailures = failures.map((f) => ({
      id: f.id,
      testCase: f.testCase,
      status: f.status,
      error: f.error,
      trace: f.trace,
      networkLog: decodeJson(f.networkLog, []),
    }));

    const result = await reporter.run({
      apiKey, model, provider,
      failures: preparedFailures,
      onLog: async (level, message) => send({ type: 'agent.phase.log', phase: 'reporter', level, message }),
      onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
      extraGuidance: aiGuidance,
    });

    const idToAnalysis = new Map(result.analyses.map((a) => [a.id, a]));
    await Promise.all(failures.map((f) => {
      const a = idToAnalysis.get(f.id);
      if (!a) return null;
      return prisma.runResult.update({
        where: { id: f.id },
        data: { rcaWhat: a.what, rcaWhy: a.why, rcaFix: a.fix, rcaClass: a.classification, rcaConfidence: a.confidence },
      });
    }).filter(Boolean));

    send({ type: 'agent.phase.complete', phase: 'reporter', output: { analyzed: result.analyses.length } });

    // postMortem pattern extraction — Phase G cross-run learning
    const enriched = failures.map((f) => {
      const a = idToAnalysis.get(f.id) || {};
      return {
        id: f.id,
        testCaseName: f.testCase?.name || null,
        status: f.status,
        error: f.error,
        trace: f.trace,
        rcaWhat: a.what || null,
        rcaWhy: a.why || null,
        rcaFix: a.fix || null,
        rcaClass: a.classification || null,
      };
    }).filter((f) => f.rcaWhat);

    if (enriched.length) {
      const existing = await failurePatterns.loadProjectPatterns(projectId, { limit: 40 });
      const pm = await postMortem.run({
        apiKey, model, provider,
        failures: enriched,
        existingPatterns: existing,
        onLog: async (level, message) => send({ type: 'agent.phase.log', phase: 'post-mortem', level, message }),
        onRateLimit: (info) => send({ type: 'claude.rate-limit', ...info }),
        extraGuidance: aiGuidance,
      });
      const patternStats = await failurePatterns.upsertPatterns(projectId, pm.patterns || []);
      if (patternStats.created || patternStats.updated) {
        send({
          type: 'agent.phase.log', phase: 'post-mortem', level: 'info',
          message: `Learning loop: ${patternStats.created} new, ${patternStats.updated} reinforced. Next run on this project will see them.`,
        });
      }
    }
  } catch (err) {
    if (err.code !== 'CANCELLED') {
      send({ type: 'agent.phase.complete', phase: 'reporter', error: err.message });
    }
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

      return res.status(410).json({
        success: false,
        code: 'CANONICAL_GENERATION_REQUIRED',
        message: 'The legacy Architect-to-execution endpoint is retired. Generate and approve cases through /scenarios/generate, then execute the explicit generation through the Conductor.',
      });

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

      if (!(await assertRunBudgetAvailable(req, res))) return;

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
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
      // Phase B+: sprint-scoped operator guidance flows down with the
      // sprintId. Resolved once up-front so each agent call uses the same
      // value, even if the user edits Sprint.aiGuidance mid-pipeline.
      const startSprintId = (req.body && req.body.sprintId) || null;
      const startSprintGuidance = await loadSprintGuidance(startSprintId);
      (async () => {
        try {
          // ── Phase 1: Architect ────────────────────────────
          send({ type: 'agent.phase.start', phase: 'architect', label: 'Scenario Architect' });
          const requirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          const proceduralFlowContract = extractProceduralFlowContract(requirements);
          if (!requirements.length) {
            send({ type: 'agent.phase.complete', phase: 'architect', error: 'No requirements found' });
            return;
          }

          const architectRun = await prisma.agentRun.create({
            data: { projectId: project.id, userId: req.user.id, phase: 'architect', input: encodeJson({ requirementCount: requirements.length }) },
          });

          // Phase E1.7 — count prior completed runs to tell the Architect
          // "this project has been tested before". Cheap COUNT query.
          const priorRunCount = await prisma.run.count({
            where: { projectId: project.id, status: 'completed' },
          });
          const priorContextBlocks = [];
          if (priorRunCount > 0) {
            priorContextBlocks.push(
              `## Prior testing context\nThis project has ${priorRunCount} completed run(s) against this site. The Knowledge Base holds locators the agent has already learned. Bias scenarios toward modules and surfaces the team has covered before so existing locators get re-exercised; only generate fresh-exploratory scenarios for surfaces the prior runs didn't touch.`,
            );
          }
          // Phase E3 — fold in the most recent diff context so the Architect
          // can lean into the changed surface. Prefer a sprint-scoped diff
          // when this run is tagged to a sprint; otherwise the most-recent
          // project-wide diff.
          const diffWhere = { projectId: project.id };
          if (startSprintId) diffWhere.sprintId = startSprintId;
          const latestDiff = await prisma.diffContext.findFirst({
            where: diffWhere,
            orderBy: { fetchedAt: 'desc' },
          });
          if (latestDiff) {
            let changedModules = [];
            try { changedModules = JSON.parse(latestDiff.changedModules || '[]'); } catch (_) {}
            const moduleLine = Array.isArray(changedModules) && changedModules.length
              ? `\nImpacted modules: ${changedModules.join(', ')}.`
              : '';
            const summary = (latestDiff.summary || '').trim();
            priorContextBlocks.push(
              `## Recent code changes (${latestDiff.ref} vs ${latestDiff.baseRef})\n${summary || 'No summary recorded.'}${moduleLine}\n\nWhen generating scenarios, prioritise coverage of these impacted modules and the behaviour the diff describes.`,
            );
          }
          // P0-8 — Architect quarantine awareness via shared helper.
          // Symmetric to the Conductor's "Known locators on this site"
          // block — closes the one-way KB loop.
          const quarantineBlock = await buildQuarantineContextBlock(prisma, project.id);
          if (quarantineBlock) priorContextBlocks.push(quarantineBlock);
          const priorContext = priorContextBlocks.length ? priorContextBlocks.join('\n\n') : null;

          // TestData M-C — load the project's mapped test data (null when none →
          // Architect runs unchanged). Makes generation data-aware once data exists.
          const generationTestDataBundle = await require('../services/testDataGenerationContract').loadGenerationTestDataContract({
            projectId: project.id,
            preferApproved: true,
          });
          const testData = generationTestDataBundle.testData;
          const enforceApprovedTestData = !!(generationTestDataBundle
            && generationTestDataBundle.source === 'approved'
            && generationTestDataBundle.contract
            && generationTestDataBundle.contract.strict);
          let architectCalibrationContext = null;
          let calibrationAtlas = null;
          try {
            const { getCalibrationContext, getCalibrationAtlas } = require('../services/agents/calibrator');
            architectCalibrationContext = await getCalibrationContext(project.id);
            calibrationAtlas = await getCalibrationAtlas(project.id);
          } catch (_) { /* calibrator not yet run - no atlas */ }
          // Enterprise Mode P2-integration — extract verified requirement clauses
          // (DLP-gated) so this path traces cases to the oracle exactly like
          // scenarios.js. Hybrid (default once clauses exist) data-minimizes the
          // Architect input. Never throws → legacy path on any failure.
          let clausePrep = { requirementClauses: [], contextMode: 'additive', knownModules: [] };
          try {
            clausePrep = await require('../services/requirementOracle').prepareArchitectClauses({
              prisma, projectId: project.id, providerName: provider, apiKey, model, knownModules: [],
              send, log: console,
            });
          } catch (e) { console.warn('[agents.execute] requirement oracle prep failed (non-fatal):', e.message); }
          let firecrawlSourceArtifacts = [];
          const firecrawlInput = Array.isArray(req.body?.firecrawlArtifacts)
            ? req.body.firecrawlArtifacts
            : (Array.isArray(req.body?.sourceArtifacts) ? req.body.sourceArtifacts.filter((artifact) => String(artifact?.source || '').toLowerCase() === 'firecrawl') : []);
          const firecrawlUrls = sourceGrounding.normalizeFirecrawlUrls(
            req.body?.firecrawlUrls || req.body?.sourceUrls || req.body?.sourceUrl,
          );
          if (firecrawlInput.length || firecrawlUrls.length) {
            try {
              const intake = await sourceGrounding.ingestFirecrawlSourceArtifacts({
                prisma,
                projectId: project.id,
                artifacts: firecrawlInput,
                log: console,
              });
              const live = await sourceGrounding.crawlFirecrawlSourceUrls({
                prisma,
                projectId: project.id,
                urls: firecrawlUrls,
                log: console,
              });
              if (live.skipped && firecrawlUrls.length) {
                send({
                  type: 'agent.phase.log',
                  phase: 'architect',
                  level: 'info',
                  message: `Firecrawl live crawl skipped: ${live.reason}. Generation continues with uploaded requirements and existing app context.`,
                });
              }
              if (Array.isArray(live.errors) && live.errors.length) {
                send({
                  type: 'agent.phase.log',
                  phase: 'architect',
                  level: 'warn',
                  message: `Firecrawl live crawl had ${live.errors.length} non-blocking issue(s); generation continues.`,
                });
              }
              firecrawlSourceArtifacts = [
                ...((intake && intake.artifacts) || []),
                ...((live && live.artifacts) || []),
              ];
              const firecrawlClauses = sourceGrounding.sourceArtifactsToRequirementClauses(firecrawlSourceArtifacts);
              if (firecrawlClauses.length) {
                clausePrep = {
                  ...clausePrep,
                  requirementClauses: [
                    ...(Array.isArray(clausePrep.requirementClauses) ? clausePrep.requirementClauses : []),
                    ...firecrawlClauses,
                  ],
                  stats: {
                    ...((clausePrep && clausePrep.stats) || {}),
                    firecrawlClauseCount: firecrawlClauses.length,
                  },
                };
                send({
                  type: 'agent.phase.log',
                  phase: 'architect',
                  level: 'info',
                  message: `Firecrawl source grounding: ${firecrawlSourceArtifacts.length} artifact(s), ${firecrawlClauses.length} discovered clause(s) appended below uploaded requirements.`,
                });
              }
            } catch (sourceErr) {
              console.warn('[agents.execute] Firecrawl source intake failed (non-fatal):', sourceErr.message);
            }
          }
          let architectResult;
          let coveragePlan = null;
          let coverageResult = null;
          try {
            coveragePlan = coveragePlanner.buildCoveragePlanManifest({
              requirements,
              requirementClauses: clausePrep.requirementClauses,
              testData,
              calibrationAtlas,
            });
            // ADO/text lane (Phase A) — best-effort structured grounding from
            // story-like requirement text via the SHARED helper (also used by
            // scenarios.js so the two routes can't drift). null/error -> generation
            // unchanged; CANCELLED propagates to the outer catch.
            let behaviorGrounding = null;
            try {
              behaviorGrounding = await require('../services/agents/storyBehaviorExtractor').buildBehaviorGroundingFromRequirements({
                requirements, apiKey, model, provider,
                signal: cancelToken.signal, onRateLimit, onLog: onLog('architect'),
                isCancelled: () => cancelToken.cancelled,
              });
            } catch (bmErr) {
              if (bmErr && bmErr.code === 'CANCELLED') throw bmErr;
              console.warn('[agents.execute] behavior-model grounding failed (non-fatal):', bmErr && bmErr.message);
              behaviorGrounding = null;
            }
            architectResult = await architect.run({
              apiKey,
              behaviorGrounding,
              model,
              provider,
              requirements,
              onLog: onLog('architect'),
              signal: cancelToken.signal,
              onRateLimit,
              extraGuidance: joinGuidance({ projectGuidance: project.aiGuidance, sprintGuidance: startSprintGuidance }),
              priorContext,
              testData,
              siteContext: architectCalibrationContext,
              requirementClauses: clausePrep.requirementClauses,
              contextMode: clausePrep.contextMode,
              knownModules: clausePrep.knownModules,
              capabilities: calibrationAtlas ? (calibrationAtlas.capabilities || []) : [],
              coveragePlan,
              projectId: project.id,
              calibrationAtlas,
            });
            if (firecrawlSourceArtifacts.length && Array.isArray(architectResult.scenarios)) {
              architectResult.scenarios = sourceGrounding.attachSourceArtifactsToCases(architectResult.scenarios, firecrawlSourceArtifacts);
            }
            coverageResult = await finalizeAgentCoverage({
              manifest: coveragePlan,
              scenarios: architectResult.scenarios || [],
              testData,
              projectId: project.id,
              idempotencyKey: `agent-scenario-reliability:${project.id}:${Date.now()}`,
              calibrationAtlas,
              targetUrl: project.targetUrl,
            });
            {
              const selfHeal = await runGenerationSelfHealingPipeline({
                scenarios: coverageResult.scenarios || architectResult.scenarios || [],
                manifest: coveragePlan,
                testData,
                context: {
                  targetUrl: project.targetUrl,
                  appCapabilityMap: coverageResult && coverageResult.appCapabilityMap,
                  capabilityGroundingRequired: capabilityGroundingEnabled(),
                },
                enableTargetedRepair: repairOrchestratorEnabled(),
              });
              coverageResult = {
                ...(coverageResult || {}),
                scenarios: selfHeal.scenarios,
                validation: selfHeal.validation,
                repair: {
                  ...((coverageResult && coverageResult.repair) || {}),
                  selfHealingPipeline: selfHeal.repair,
                },
                summary: {
                  ...((coverageResult && coverageResult.summary) || {}),
                  ...selfHeal.summary,
                },
                reliabilityReport: selfHeal.reliabilityReport,
              };
              architectResult.scenarios = firecrawlSourceArtifacts.length
                ? sourceGrounding.attachSourceArtifactsToCases(selfHeal.scenarios, firecrawlSourceArtifacts)
                : selfHeal.scenarios;
              coverageResult.scenarios = architectResult.scenarios;
            }
          } catch (err) {
            const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
            await prisma.agentRun.update({ where: { id: architectRun.id }, data: { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : err.message, completedAt: new Date() } });
            send({ type: 'agent.phase.complete', phase: 'architect', error: cancelled ? 'cancelled' : err.message, cancelled });
            return;
          }

          // Persist scenarios as a new generation. No project-wide delete:
          // previous generations stay available until this draft passes
          // post-persist verification and the promotion guard.
          let persistedScenarios = [];
          let postPersistVerification = null;
          let generation = null;
          try {
            const scenarioPersistenceRows = normalizeScenarioPersistenceBatch(architectResult.scenarios);
            const persistenceResult = await prisma.$transaction(async (tx) => {
              const prevGen = await tx.scenarioGeneration.findFirst({
                where: { projectId: project.id },
                orderBy: { version: 'desc' },
                select: { version: true },
              });
              const nextVersion = (prevGen?.version || 0) + 1;
              const generationInTx = await tx.scenarioGeneration.create({
                data: {
                  projectId: project.id,
                  version: nextVersion,
                  label: `Agent generation ${nextVersion}`,
                  isCurrent: false,
                },
              });

              const persistedScenariosInTx = [];
          // Stash the architect-emitted dependsOnNames alongside the freshly-
          // persisted row so we can resolve names → IDs in a second pass once
          // EVERY case exists (a case may depend on a case in a later
          // scenario, so resolution can't happen inline).
          const pendingDeps = []; // [{ caseId, dependsOnNames: string[] }]
          for (const persistenceRow of scenarioPersistenceRows) {
            const s = persistenceRow.scenario;
            const scenario = await tx.testScenario.create({
              data: buildScenarioCreateData({
                scenario: s,
                metadata: persistenceRow.metadata,
                projectId: project.id,
                generationId: generationInTx.id,
              }),
            });
            // Enterprise Mode P1 — the all-in-one agent path now persists through
            // the SAME canonical contract writer as scenarios.js. Before this it
            // dropped declaredAssertions / businessRisk / producesData /
            // requiresData, so a case born here was UNVERIFIABLE (the verdict
            // layer had nothing to check). One path, one complete contract.
            const persisted = await canonicalGenerationPipeline.persistCases({
              prisma: tx,
              projectId: project.id,
              scenarioId: scenario.id,
              generationId: generationInTx.id,
              moduleName: persistenceRow.metadata.module,
              cases: s.cases,
              calibrationAtlas,
              approvedTestData: enforceApprovedTestData && generationTestDataBundle && generationTestDataBundle.testData ? generationTestDataBundle.testData : null,
              requireApprovedMapping: enforceApprovedTestData,
              enterpriseMode: enforceApprovedTestData,
              log: console,
            });
            const cases = [];
            for (const p of persisted) {
              if (p.dependsOnNames.length) pendingDeps.push({ caseId: p.tc.id, dependsOnNames: p.dependsOnNames });
              cases.push({ ...p.tc, steps: p.source.steps || [] });
            }
            persistedScenariosInTx.push({ ...scenario, dependencyOn: s.dependencyOn, cases });
          }
          // Resolve case-level dependsOnNames → dependsOnIds. Names that
          // don't match any persisted case are dropped silently — the
          // Architect occasionally invents references, and storing an
          // unresolvable id is worse than dropping the dep.
          if (pendingDeps.length) {
            const depsByCaseId = new Map(pendingDeps.map((row) => [row.caseId, row.dependsOnNames]));
            const allCases = persistedScenariosInTx.flatMap((sc) => sc.cases || []);
            for (const cs of allCases) cs.dependsOnNames = depsByCaseId.get(cs.id) || [];
            await canonicalGenerationPipeline.resolveNamedDependenciesForCases({
              prisma: tx,
              projectId: project.id,
              cases: allCases,
            });
          }
              let verification = null;
              try {
                verification = await verifyPersistedGenerationContract({ prisma: tx, generationId: generationInTx.id });
              } catch (verifyErr) {
                verification = {
                  ok: false,
                  generationId: generationInTx.id,
                  checkedCases: 0,
                  defects: [{ code: 'post_persist_verification_failed', message: verifyErr.message }],
                };
              }
              if (coverageResult && coverageResult.reliabilityReport) {
                coverageResult.reliabilityReport.postPersistVerification = verification;
              }
              if (verification && Array.isArray(verification.defects) && verification.defects.length) {
                console.warn(`${TAG} post-persist contract verification defect counts:`, JSON.stringify(countPostPersistDefects(verification), null, 2));
              }
              if (verification && verification.ok === false) {
                const defectCount = Array.isArray(verification.defects) ? verification.defects.length : 0;
                console.warn(`${TAG} post-persist contract verification defects:`, JSON.stringify(summarizePostPersistDefects(verification), null, 2));
                const defectSummary = summarizePostPersistDefects(verification, 6)
                  .map((defect) => `${defect.code}${defect.caseId ? `@${defect.caseId}` : ''}`)
                  .join(', ');
                const contractErr = new Error(`Post-persist contract verification failed for ${defectCount} issue(s): ${defectSummary}; the agent-generated suite was not promoted.`);
                contractErr.code = 'POST_PERSIST_CONTRACT_FAILED';
                contractErr.status = 422;
                contractErr.postPersistVerification = verification;
                throw contractErr;
              }
              const promotionIssues = promotionIssuesForGeneration({
                scenarios: persistedScenariosInTx,
                coverageValidation: coverageResult && coverageResult.validation,
                requirementClauses: clausePrep.requirementClauses,
                options: {
                  proceduralOneCase: !!(proceduralFlowContract && proceduralFlowContract.singleBehavioralPartition),
                },
              });
              if (promotionIssues.length) {
                const promotionErr = new Error(`Generation promotion blocked: ${promotionIssues.map((issue) => issue.code).join(', ')}; previous generation kept current.`);
                promotionErr.code = 'GENERATION_PROMOTION_BLOCKED';
                promotionErr.status = 422;
                promotionErr.promotionIssues = promotionIssues;
                throw promotionErr;
              }
              await syncScenarioGenerationCounts(tx, {
                projectId: project.id,
                generationId: generationInTx.id,
              });
              await tx.scenarioGeneration.update({
                where: { id: generationInTx.id },
                data: {
                  coveragePlanJson: encodeJson(coveragePlan),
                  coverageValidationJson: encodeJson(coverageResult && coverageResult.validation),
                  coverageRepairJson: encodeJson(coverageResult && coverageResult.repair),
                },
              });
              await tx.scenarioGeneration.updateMany({
                where: { projectId: project.id, isCurrent: true },
                data: { isCurrent: false },
              });
              await tx.scenarioGeneration.update({
                where: { id: generationInTx.id },
                data: { isCurrent: true },
              });
              return { generation: generationInTx, persistedScenarios: persistedScenariosInTx, postPersistVerification: verification };
            }, { timeout: 120_000, maxWait: 15_000 });
            generation = persistenceResult.generation;
            persistedScenarios = persistenceResult.persistedScenarios;
            postPersistVerification = persistenceResult.postPersistVerification;
            if (coverageResult && coverageResult.reliabilityReport) {
              coverageResult.reliabilityReport.generationId = generation && generation.id;
              coverageResult.reliabilityReport.postPersistVerification = postPersistVerification;
            }
          } catch (persistErr) {
            if (persistErr && persistErr.postPersistVerification && coverageResult && coverageResult.reliabilityReport) {
              coverageResult.reliabilityReport.postPersistVerification = persistErr.postPersistVerification;
            }
            if (persistErr && persistErr.promotionIssues && coverageResult && coverageResult.reliabilityReport) {
              coverageResult.reliabilityReport.promotionVerification = { ok: false, issues: persistErr.promotionIssues };
            }
            await prisma.agentRun.update({
              where: { id: architectRun.id },
              data: {
                status: 'failed',
                error: persistErr.message,
                output: encodeJson({
                  coverageSummary: coverageResult && coverageResult.summary,
                  reliabilityReport: coverageResult && coverageResult.reliabilityReport,
                }),
                completedAt: new Date(),
              },
            });
            send({
              type: 'agent.phase.complete',
              phase: 'architect',
              error: persistErr.message,
              code: persistErr.code,
              postPersistVerification: persistErr.postPersistVerification,
            });
            return;
          }
          await prisma.agentRun.update({
            where: { id: architectRun.id },
            data: {
              status: 'complete',
              output: encodeJson({
                scenarioCount: persistedScenarios.length,
                coverageSummary: coverageResult && coverageResult.summary,
                reliabilityReport: coverageResult && coverageResult.reliabilityReport,
              }),
              completedAt: new Date(),
            },
          });
          send({
            type: 'agent.phase.complete',
            phase: 'architect',
            output: {
              scenarios: persistedScenarios.length,
              coverageSummary: coverageResult && coverageResult.summary,
              reliabilityReport: coverageResult && coverageResult.reliabilityReport,
            },
          });

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
            planResult = await planner.run({ apiKey, model, provider, scenarios: scenariosForPlanner, onLog: onLog('planner'), signal: cancelToken.signal, onRateLimit, extraGuidance: joinGuidance({ projectGuidance: project.aiGuidance, sprintGuidance: startSprintGuidance }) });
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
            generationId: generation && generation.id,
            sprintId: startSprintId,
            sprintGuidance: startSprintGuidance,
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

      // The client must name the exact visible generation. Falling back to
      // `isCurrent` here can execute a different revision than the one the user
      // reviewed and approved in Test Cases.
      if (!(await assertRunBudgetAvailable(req, res))) return;
      const executionGeneration = await requireExecutionGeneration(project.id, req.body?.generationId);
      const generationCaseFilter = { generationId: executionGeneration.id };
      // A browser/process crash or hard refresh can leave approved cases in
      // the transient "running" state. Treat those as approved again for a
      // fresh full-suite execution, matching the smoke-run recovery path.
      await prisma.testCase.updateMany({
        where: {
          projectId: project.id,
          status: 'running',
          automatability: { not: 'manual' },
          ...generationCaseFilter,
        },
        data: { status: 'approved' },
      });
      // Load scenarios with ONLY approved AND automatable cases. Manual
      // cases live on the Manual tab and are completed by a human; pushing
      // them through Playwright would produce a guaranteed false-fail.
      const scenarios = await prisma.testScenario.findMany({
        where: { projectId: project.id, generationId: executionGeneration.id },
        orderBy: { createdAt: 'asc' },
        include: { cases: { where: { status: 'approved', automatability: { not: 'manual' } }, orderBy: { createdAt: 'asc' } } },
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
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });
      const onRateLimit = (info) => send({ type: 'claude.rate-limit', ...info });
      const requestedRunMode = normalizeRunMode(req.body?.runMode);

      res.status(202).json({
        success: true,
        message: `Executing ${scenariosWithApproved.length} scenario(s) with ${scenariosWithApproved.reduce((a, s) => a + s.cases.length, 0)} approved case(s). Watch the Theater.`,
        runMode: requestedRunMode,
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      const executeSprintId = (req.body && req.body.sprintId) || null;
      const executeSprintGuidance = await loadSprintGuidance(executeSprintId);
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
            planResult = await planner.run({ apiKey, model, provider, scenarios: scenariosForPlanner, onLog: onLog('planner'), signal: cancelToken.signal, onRateLimit, extraGuidance: joinGuidance({ projectGuidance: project.aiGuidance, sprintGuidance: executeSprintGuidance }) });
          } catch (err) {
            const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
            await prisma.agentRun.update({ where: { id: plannerRun.id }, data: { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? 'cancelled' : err.message, completedAt: new Date() } });
            send({ type: 'agent.phase.complete', phase: 'planner', error: cancelled ? 'cancelled' : err.message, cancelled });
            return;
          }
          const executionPlan = planForRunMode(planResult.plan, scenariosWithApproved, requestedRunMode);
          await prisma.agentRun.update({
            where: { id: plannerRun.id },
            data: { status: 'complete', output: encodeJson(executionPlan), completedAt: new Date() },
          });
          if (requestedRunMode === 'sequential') {
            send({ type: 'agent.phase.log', phase: 'planner', level: 'info', message: 'Trigger mode: strict sequential — planner waves flattened to one scenario per wave.' });
          }
          send({ type: 'agent.phase.complete', phase: 'planner', output: executionPlan });

          if (cancelToken.cancelled) return;

          // ── Phase 3+: Conductor (with retry loop) + Critic + Supervisor ──
          const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          await runConductorWithRetries({
            project,
            generationId: executionGeneration.id,
            sprintId: executeSprintId,
            sprintGuidance: executeSprintGuidance,
            scenarios: scenariosWithApproved,
            plan: executionPlan,
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
    const recentRuns = await prisma.run.findMany({
      where: { projectId: project.id },
      orderBy: { startedAt: 'desc' },
      take: 30,
      select: {
        id: true,
        sprintName: true,
        status: true,
        passed: true,
        failed: true,
        blocked: true,
        skipped: true,
        startedAt: true,
        completedAt: true,
        results: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    const latestDate = (...values) => {
      let latest = null;
      for (const value of values) {
        if (!value) continue;
        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) continue;
        if (!latest || date.getTime() > latest.getTime()) latest = date;
      }
      return latest;
    };
    const lastRun = recentRuns
      .map((run) => {
        const latestResultAt = run.results?.[0]?.createdAt || null;
        return {
          ...run,
          latestResultAt,
          lastActivityAt: latestDate(latestResultAt, run.completedAt, run.startedAt),
        };
      })
      .sort((a, b) => (b.lastActivityAt?.getTime?.() || 0) - (a.lastActivityAt?.getTime?.() || 0))[0] || null;
    if (!lastRun) {
      return res.json({ success: true, lastRun: null, failedCount: 0 });
    }
    // Count test cases whose RunResult on this run was not 'pass'
    const failedResults = await prisma.runResult.findMany({
      where: { runId: lastRun.id, status: { not: 'pass' } },
      select: {
        id: true,
        runId: true,
        testCaseId: true,
        status: true,
        error: true,
        mechanicalVerdictReason: true,
        assertionCheckResults: true,
        stepResults: true,
        rcaWhat: true,
        rcaWhy: true,
        rcaFix: true,
        createdAt: true,
        testCase: {
          select: {
            name: true,
            module: true,
            scenario: { select: { name: true } },
          },
        },
      },
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
        latestResultAt: lastRun.latestResultAt,
        lastActivityAt: lastRun.lastActivityAt,
      },
      failedCount: uniq.size,
      failedCases: Array.from(uniq.values()).slice(0, 50).map((r) => ({
        id: r.testCaseId,
        runResultId: r.id,
        runId: r.runId,
        status: r.status,
        name: r.testCase?.name || null,
        module: r.testCase?.module || null,
        scenarioName: r.testCase?.scenario?.name || null,
        error: (r.error || '').slice(0, 400),
        mechanicalVerdictReason: r.mechanicalVerdictReason || null,
        assertionCheckResults: r.assertionCheckResults || null,
        stepResults: r.stepResults || null,
        rcaWhat: r.rcaWhat || null,
        rcaWhy: r.rcaWhy || null,
        rcaFix: r.rcaFix || null,
        createdAt: r.createdAt,
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

      if (!(await assertRunBudgetAvailable(req, res))) return;

      const lastRun = await prisma.run.findFirst({
        where: { projectId: project.id },
        orderBy: { startedAt: 'desc' },
      });
      if (!lastRun) {
        return res.status(400).json({ success: false, code: 'NO_RUNS', message: 'No previous run found for this project.' });
      }
      const failedResults = await prisma.runResult.findMany({
        where: { runId: lastRun.id, status: { not: 'pass' } },
        select: { testCaseId: true, status: true, error: true, blockedReason: true, mechanicalVerdictReason: true },
      });
      const failedTcIds = [...new Set(failedResults.map((r) => r.testCaseId))];
      if (failedTcIds.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_FAILURES', message: 'No failing cases in the last run.' });
      }
      const hasPriorExecutedFailure = failedResults.some(hasRealExecutionResult);

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
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });

      res.status(202).json({
        success: true,
        message: `Re-running ${failedTcIds.length} failed case(s). Watch the Live Pipeline.`,
        caseCount: failedTcIds.length,
        previousRunId: lastRun.id,
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      // Inherit the failing run's sprint so the rerun lands in the same release container.
      const rerunSprintId = lastRun.sprintId || (req.body && req.body.sprintId) || null;
      const rerunSprintGuidance = await loadSprintGuidance(rerunSprintId);
      (async () => {
        try {
          const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          // Architect/Planner already ran on the original pipeline. Synthesise a
          // single-wave plan over just the failed cases so the Conductor + Critic +
          // Supervisor loop kicks in immediately.
          await runConductorWithRetries({
            project,
            generationId: lastRun.generationId || null,
            sprintId: rerunSprintId,
            sprintGuidance: rerunSprintGuidance,
            scenarios: scenariosForRerun,
            plan: singleWavePlan(scenariosForRerun),
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
            // In-place only when the previous non-pass rows represent real
            // executed failures. If the rows are only cancelled/not-run
            // placeholders, create a fresh run so "Re-run failed" behaves like
            // normal executable work and opens a real browser/action stream.
            ...(hasPriorExecutedFailure ? { existingRunId: lastRun.id } : {}),
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

// ── POST /api/projects/:projectId/agents/run-smoke ────────
// Cherry-pick smoke run — execute ONLY the test cases the user has selected
// on the Test Cases page. Distinct from /execute (which runs all approved
// cases) and from /rerun-failed (which auto-targets the prior run's
// failures). The use case is "I want to re-test these 3 specific cases I
// just modified" without re-running an entire suite of 17 approved cases
// and burning the API budget.
//
// Architect + Planner are skipped — the cases already exist in the DB and
// have their steps; we synthesise a single-wave plan and hand them to the
// same conductor/critic/supervisor loop /rerun-failed uses.
//
// Body: { testCaseIds: string[], sprintId?: string }
//   - testCaseIds: 1 to 200 IDs, must belong to this project, must be in
//     'approved' or 'running' state (a running case from a stale prior
//     attempt is forced back to approved).
router.post(
  '/run-smoke',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      const rawIds = Array.isArray(req.body?.testCaseIds) ? req.body.testCaseIds : [];
      const testCaseIds = [...new Set(rawIds.filter((s) => typeof s === 'string' && s.length > 0))];
      if (testCaseIds.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_CASES_SELECTED',
          message: 'Select at least one test case from the Test Cases page before running a smoke.' });
      }
      if (testCaseIds.length > 200) {
        return res.status(400).json({ success: false, code: 'TOO_MANY_CASES',
          message: 'Smoke run is capped at 200 cases. Use Execute approved for full suites.' });
      }

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      if (!(await assertRunBudgetAvailable(req, res))) return;

      const executionGeneration = await requireExecutionGeneration(project.id, req.body?.generationId);

      // Verify the requested cases actually belong to this project. Silently
      // dropping unknown IDs would mask a frontend bug; we surface the
      // mismatch so the caller can fix the selection.
      const ownedCases = await prisma.testCase.findMany({
        where: { id: { in: testCaseIds }, projectId: project.id, generationId: executionGeneration.id },
        select: { id: true, status: true, name: true, generationId: true },
      });
      const ownedIds = new Set(ownedCases.map((c) => c.id));
      const missingIds = testCaseIds.filter((id) => !ownedIds.has(id));
      if (missingIds.length) {
        return res.status(400).json({ success: false, code: 'INVALID_CASES',
          message: `${missingIds.length} test case ID(s) do not belong to this project.` });
      }
      // Force any 'running' orphan back to 'approved' so the conductor picks
      // it up. Reject any case still in pending/rejected — those need to go
      // through the approval workflow first.
      const notApproved = ownedCases.filter((c) => c.status !== 'approved' && c.status !== 'running');
      if (notApproved.length) {
        const sample = notApproved.slice(0, 3).map((c) => c.name).join(', ');
        return res.status(400).json({ success: false, code: 'NOT_APPROVED',
          message: `${notApproved.length} selected case(s) are not approved (e.g., ${sample}). Approve them first.` });
      }
      const runningIds = ownedCases.filter((c) => c.status === 'running').map((c) => c.id);
      if (runningIds.length) {
        await prisma.testCase.updateMany({
          where: { id: { in: runningIds }, projectId: project.id },
          data: { status: 'approved' },
        });
      }

      const scenariosForSmoke = await reloadScenariosForFailingCases(testCaseIds, project.id);
      if (scenariosForSmoke.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_SCENARIOS',
          message: 'Selected cases could not be reloaded as scenarios.' });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });
      const requestedRunMode = normalizeRunMode(req.body?.runMode);

      res.status(202).json({
        success: true,
        message: `Smoke-running ${testCaseIds.length} case(s). Watch the Live Pipeline.`,
        caseCount: testCaseIds.length,
        runMode: requestedRunMode,
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      const smokeSprintId = (req.body && req.body.sprintId) || null;
      const smokeSprintGuidance = await loadSprintGuidance(smokeSprintId);
      (async () => {
        try {
          const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          const smokePlan = planForRunMode(singleWavePlan(scenariosForSmoke), scenariosForSmoke, requestedRunMode);
          if (requestedRunMode === 'sequential') {
            send({ type: 'agent.phase.log', phase: 'planner', level: 'info', message: 'Trigger mode: strict sequential — smoke scenarios will run one wave at a time.' });
          }
          await runConductorWithRetries({
            project,
            generationId: executionGeneration.id,
            sprintId: smokeSprintId,
            sprintGuidance: smokeSprintGuidance,
            scenarios: scenariosForSmoke,
            plan: smokePlan,
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
          });
          await audit.log({ userId: req.user.id, action: 'agents.run_smoke.complete', target: project.id, req });
        } catch (err) {
          console.error('[agents] run-smoke error', err);
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

// ── POST /api/projects/:projectId/agents/rerun-case-semantic ──────────
// Per-case rerun with LLM semantic-fallback verifier enabled.
//
// Use case: the user looked at a failed case in Reports/Blocked, sees that
// the page actually contains the right semantic content but the deterministic
// substring matcher couldn't bridge the wording gap (e.g. assertion
// "confirmation page" vs SUT copy "Thank you for your order!"). The user
// clicks "Rerun with AI verification" — this endpoint spawns a single-case
// run where every deterministic miss is re-checked by the LLM verifier.
// On pass, the rescued equivalence(s) get surfaced for "Save as project
// synonyms" so future runs match deterministically.
//
// Body: { testCaseId, note? }
router.post(
  '/rerun-case-semantic',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      const testCaseId = req.body?.testCaseId;
      const note = (req.body?.note && typeof req.body.note === 'string') ? req.body.note.trim() : '';
      if (!testCaseId || typeof testCaseId !== 'string') {
        return res.status(400).json({ success: false, code: 'TESTCASE_ID_REQUIRED',
          message: 'testCaseId is required.' });
      }

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({
          success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      if (!(await assertRunBudgetAvailable(req, res))) return;

      const tc = await prisma.testCase.findFirst({
        where: { id: testCaseId, projectId: project.id },
        select: { id: true, status: true, userGuidance: true, name: true },
      });
      if (!tc) return res.status(404).json({ success: false, code: 'TESTCASE_NOT_FOUND' });

      // Force the case back to approved so the conductor picks it up.
      // Also append the user's note to userGuidance — the agent will see
      // it next run (additive — preserves prior guidance).
      const updates = { status: 'approved' };
      if (note) {
        const existing = (tc.userGuidance || '').trim();
        updates.userGuidance = existing
          ? `${existing}\n\n[${new Date().toISOString().slice(0, 10)}] ${note}`
          : note;
      }
      await prisma.testCase.update({ where: { id: tc.id }, data: updates });

      const scenariosForRerun = await reloadScenariosForFailingCases([tc.id], project.id);
      if (scenariosForRerun.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_SCENARIOS',
          message: 'Case could not be reloaded as a scenario.' });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });

      res.status(202).json({
        success: true,
        message: `Re-running "${tc.name}" with AI semantic verification. Watch the Live Pipeline.`,
        testCaseId: tc.id,
        verifierMode: 'semantic_fallback',
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      const sprintId = (req.body && req.body.sprintId) || null;
      const sprintGuidance = await loadSprintGuidance(sprintId);
      (async () => {
        try {
          const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
          // Resolve the run to rerun INTO so the rescued case merges back
          // into its original run instead of spawning an orphan single-case
          // run. Prefer an explicit body.runId (the run the user is viewing);
          // else the most recent run that holds this case. Null → fresh run.
          let inPlaceRunId = null;
          const bodyRunId = (req.body && typeof req.body.runId === 'string') ? req.body.runId : null;
          if (bodyRunId) {
            const r = await prisma.run.findFirst({ where: { id: bodyRunId, projectId: project.id }, select: { id: true } });
            inPlaceRunId = r?.id || null;
          }
          if (!inPlaceRunId) {
            const lastResult = await prisma.runResult.findFirst({
              where: { testCaseId: tc.id, run: { projectId: project.id } },
              orderBy: { createdAt: 'desc' },
              select: { runId: true },
            });
            inPlaceRunId = lastResult?.runId || null;
          }
          await runConductorWithRetries({
            project,
            sprintId,
            sprintGuidance,
            scenarios: scenariosForRerun,
            plan: singleWavePlan(scenariosForRerun),
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
            verifierMode: 'semantic_fallback',
            // Merge the rescued case back into its original run (replace its
            // failed row + spec in place, recompute that run's counters).
            existingRunId: inPlaceRunId,
          });
          await audit.log({
            userId: req.user.id, action: 'agents.rerun_case_semantic.complete', target: project.id, req,
            metadata: { testCaseId: tc.id, hadNote: !!note, inPlaceRunId },
          });
        } catch (err) {
          console.error('[agents] rerun-case-semantic error', err);
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

// ── POST /api/projects/:projectId/agents/runs/:runId/cases/:caseId/rerun ──
// In-place single-case rerun.  Mutates the EXISTING Run (identified by
// runId) rather than spawning a new Run row.  The old RunResult for the
// case is deleted by conductor.run() before the new one is written, so
// Reports sees one result per case per run at all times.
//
// Design contract (per architecture doc):
//   - Body: { note? }           — appended to userGuidance if present
//   - Response: 202             — conductor runs async, result via WS
//   - WS events emitted:        result, run.counters, run.inplace.complete
//   - Run.status is NOT changed — the run stays 'completed'
//
// Used by: CaseGuidanceEditor (Reports) and "Rerun after guidance" button
// (BlockedItems).
router.post(
  '/runs/:runId/cases/:caseId/rerun',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { runId, caseId } = req.params;
      const note = (req.body?.note && typeof req.body.note === 'string') ? req.body.note.trim() : '';

      // Validate the run belongs to this project
      const targetRun = await prisma.run.findFirst({
        where: { id: runId, projectId: project.id },
        select: { id: true, status: true, sprintId: true },
      });
      if (!targetRun) {
        return res.status(404).json({ success: false, code: 'RUN_NOT_FOUND',
          message: 'Run not found or does not belong to this project.' });
      }
      // Allow reruns on completed/cancelled runs only — not while a suite run
      // is already in-flight (that would race on the MCP session).
      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      // Validate the test case
      const tc = await prisma.testCase.findFirst({
        where: { id: caseId, projectId: project.id },
        select: { id: true, status: true, userGuidance: true, name: true },
      });
      if (!tc) return res.status(404).json({ success: false, code: 'TESTCASE_NOT_FOUND' });

      const { provider, apiKey, model } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey) {
        return res.status(400).json({ success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → API.` });
      }

      if (!(await assertRunBudgetAvailable(req, res))) return;

      // Append user note to guidance (additive — preserves prior guidance)
      const updates = { status: 'approved' };
      if (note) {
        const existing = (tc.userGuidance || '').trim();
        updates.userGuidance = existing
          ? `${existing}\n\n[${new Date().toISOString().slice(0, 10)}] ${note}`
          : note;
      }
      await prisma.testCase.update({ where: { id: tc.id }, data: updates });

      const scenariosForRerun = await reloadScenariosForFailingCases([tc.id], project.id);
      if (scenariosForRerun.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_SCENARIOS',
          message: 'Case could not be loaded for rerun.' });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });

      res.status(202).json({
        success: true,
        message: `"${tc.name}" is being rerun in-place within run ${runId.slice(0, 8)}…`,
        testCaseId: tc.id,
        runId,
        mode: 'inplace',
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });
      // Carry the sprint context from the original run so sprint-scoped
      // operator guidance (Sprint.aiGuidance) is injected into the rerun.
      // Previously these were undefined, silently dropping sprint guidance.
      const rerunSprintId = targetRun.sprintId || null;
      const rerunSprintGuidance = await loadSprintGuidance(rerunSprintId);
      (async () => {
        try {
          await runConductorWithRetries({
            project,
            sprintId: rerunSprintId,
            sprintGuidance: rerunSprintGuidance,
            scenarios: scenariosForRerun,
            plan: singleWavePlan(scenariosForRerun),
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
            existingRunId: runId,
          });
          await audit.log({
            userId: req.user.id, action: 'agents.inplace_rerun.complete',
            target: project.id, req,
            metadata: { testCaseId: tc.id, runId, hadNote: !!note },
          });
        } catch (err) {
          console.error('[agents] inplace-rerun error', err);
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
    const send = (msg) => { if (broadcast) broadcast(req.user.id, { ...msg, projectId: project.id }); };

    // Make the stop AUTHORITATIVE immediately. The token (above) tells the
    // Conductor to break, but winding the in-flight case down — plus the rescue
    // pass that records already-finished work — takes a few seconds, during
    // which the DB Run is still 'running' and Reports (DB) and the Live theatre
    // (WS) disagree ("cancelled, N done" vs "still running"). Flip the in-flight
    // Run to 'cancelled' NOW and emit a terminal event so BOTH surfaces snap to
    // cancelled the moment Terminate is clicked. The Conductor's finalize is
    // status-guarded (updateMany where status='running') and won't override it.
    let cancelledRunId = null;
    let cancelCounters = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
    let resetCaseCount = 0;
    let browserClosed = false;
    try {
      const inflight = await prisma.run.findFirst({
        where: { projectId: project.id, userId: req.user.id, status: 'running' },
        orderBy: { startedAt: 'desc' },
        select: { id: true },
      });
      if (inflight) {
        await prisma.run.update({ where: { id: inflight.id }, data: { status: 'cancelled', completedAt: new Date() } });
        cancelledRunId = inflight.id;
        await prisma.testDataLease.deleteMany({ where: { runId: inflight.id } }).catch(() => {});
        // Recompute counters so the cancellation summary shows the real
        // pass/fail/blocked for cases that completed before the cancel.
        try {
          const { recomputeRunCounters } = require('../services/runs');
          cancelCounters = await recomputeRunCounters(inflight.id);
        } catch (_) {}
      }
      await prisma.agentRun.updateMany({
        where: { projectId: project.id, userId: req.user.id, status: 'running' },
        data: { status: 'cancelled', completedAt: new Date(), error: 'Cancelled by user.' },
      }).catch(() => {});
      const reset = await prisma.testCase.updateMany({
        where: { projectId: project.id, status: 'running' },
        data: { status: 'approved' },
      });
      resetCaseCount = reset.count || 0;
      try {
        browserClosed = await sessionRegistry.closeForUser(req.user.id);
      } catch (err) {
        console.warn('[agents] cancel: failed to close live browser session', err.message);
      }
    } catch (_) { /* best-effort — the Conductor finalize is the backstop */ }

    if (broadcast && (cancelled || cancelledRunId || resetCaseCount || browserClosed)) {
      send({ type: 'agent.phase.log', phase: 'pipeline', level: 'warn', message: '⛔ Cancellation requested — stopping the run' });
      if (browserClosed) {
        send({ type: 'agent.phase.log', phase: 'pipeline', level: 'info', message: 'Live browser session closed.' });
      }
      if (resetCaseCount > 0) {
        send({ type: 'testcases.updated', projectId: project.id, reset: resetCaseCount });
      }
      // "cancellation acknowledged" so the UI snaps to a stopping state (the
      // consumer clears nowTestingStep + sets a cancelling flag).
      send({ type: 'run.cancelling', projectId: project.id });
      if (cancelled && !cancelledRunId) {
        send({ type: 'agent.phase.log', phase: 'architect', level: 'warn', message: 'Cancellation requested - stopping generation.' });
        send({ type: 'agent.phase.complete', phase: 'architect', error: 'cancelled', cancelled: true });
      }
      // Terminal event so Reports + the indicator land on 'cancelled' at once,
      // rather than lagging 30–60 s while the active Claude call winds down.
      // Include actual pass/fail/blocked counts from cases that DID complete.
      if (cancelledRunId) {
        const cTotal = cancelCounters.passed + cancelCounters.failed + cancelCounters.blocked + cancelCounters.skipped;
        const cPassRate = cTotal ? Math.round((cancelCounters.passed / cTotal) * 100) : 0;
        send({ type: 'run.complete', runId: cancelledRunId, projectId: project.id, cancelled: true,
          summary: { ...cancelCounters, total: cTotal, passRate: cPassRate, cancelled: true, status: 'cancelled' } });
      }
    }
    res.json({ success: true, cancelled, runId: cancelledRunId, resetCaseCount, browserClosed });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/agents/resume ──────────
// Continues a cancelled or conductor-failed run from where it stopped.
// Identifies cases without real RunResults (or with only "did not run"
// placeholders) and executes them within the SAME Run row, preserving
// all previously-completed results. Output files accumulate in the same
// run folder since persistResultAndCodegen uses the same runId.
router.post('/resume', requireCsrf,
  rateLimit({ windowMs: 60_000, max: 5 }),
  async (req, res, next) => {
    try {
      const project = await ownProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

      const { runId } = req.body || {};
      if (!runId) return res.status(400).json({ success: false, code: 'MISSING_RUN_ID', message: 'runId is required.' });

      const targetRun = await prisma.run.findFirst({
        where: { id: runId, projectId: project.id },
        select: { id: true, status: true, sprintId: true, generationId: true },
      });
      if (!targetRun) return res.status(404).json({ success: false, code: 'RUN_NOT_FOUND' });
      if (targetRun.status === 'running') {
        return res.status(409).json({ success: false, code: 'RUN_IN_PROGRESS', message: 'This run is still active.' });
      }

      const block = await blockIfRunInProgress(req, project);
      if (block) return res.status(409).json(block);

      // Cases that already have a REAL result. Cancelled/not-run placeholders
      // are still runnable work and must remain eligible for resume.
      const priorResults = await prisma.runResult.findMany({
        where: { runId },
        select: { testCaseId: true, status: true, error: true, blockedReason: true, mechanicalVerdictReason: true },
      });
      const doneCaseIds = new Set(priorResults
        .filter((r) => !isNonExecutionPlaceholderResult(r))
        .map((r) => r.testCaseId));

      // All approved, automatable cases in this project's current generation.
      const genFilter = targetRun.generationId ? { generationId: targetRun.generationId } : {};
      const allApproved = await prisma.testCase.findMany({
        where: { projectId: project.id, status: { in: ['approved'] }, ...genFilter },
        select: { id: true },
      });
      const remainingIds = allApproved.map((c) => c.id).filter((id) => !doneCaseIds.has(id));

      if (remainingIds.length === 0) {
        return res.status(400).json({
          success: false, code: 'NOTHING_TO_RESUME',
          message: 'All cases in this run already have results. Use "Run again" to start fresh.',
        });
      }

      const { provider, apiKey, model } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey) {
        return res.status(400).json({ success: false, code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → API.` });
      }

      if (!(await assertRunBudgetAvailable(req, res))) return;

      const scenariosForResume = await reloadScenariosForFailingCases(remainingIds, project.id);
      if (scenariosForResume.length === 0) {
        return res.status(400).json({ success: false, code: 'NO_SCENARIOS', message: 'Could not load remaining cases.' });
      }

      const broadcast = req.app.locals.broadcastToUser;
      const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });
      const onLog = (phase) => async (level, message) =>
        send({ type: 'agent.phase.log', phase, level, message });

      const resumeSprintId = targetRun.sprintId || null;
      const resumeSprintGuidance = await loadSprintGuidance(resumeSprintId);
      const allRequirements = await prisma.requirement.findMany({ where: { projectId: project.id } });

      res.status(202).json({
        success: true,
        message: `Resuming run — ${remainingIds.length} case(s) remaining (${doneCaseIds.size} already completed).`,
        runId,
        resumedCaseCount: remainingIds.length,
        completedCaseCount: doneCaseIds.size,
      });

      const cancelToken = cancelRegistry.create(req.user.id);
      (async () => {
        try {
          await runConductorWithRetries({
            project,
            sprintId: resumeSprintId,
            sprintGuidance: resumeSprintGuidance,
            scenarios: scenariosForResume,
            plan: singleWavePlan(scenariosForResume),
            apiKey, model, provider,
            send,
            userId: req.user.id,
            requirements: allRequirements,
            onLog,
            cancelToken,
            existingRunId: runId,
            resumeMode: true,
          });
          await audit.log({
            userId: req.user.id, action: 'agents.resume.complete',
            target: project.id, req,
            metadata: { runId, resumedCaseCount: remainingIds.length },
          });
        } catch (err) {
          console.error('[agents] resume error', err);
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

// ── GET /api/projects/:projectId/agents/status ───────────
// Lightweight check: is there a cancel token alive for this user? The UI uses
// this on page load to decide whether to show the Cancel button.
router.get('/status', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    await cleanupStaleAgentRuns({ projectId: project.id, userId: req.user.id });
    let token = cancelRegistry.get(req.user.id);
    // Self-heal a leaked token. Same age + AgentRun-aware check as
    // blockIfRunInProgress — Run rows lag AgentRun rows by one phase, and
    // a 10-second age floor protects fresh tokens whose IIFE hasn't yet
    // written its first AgentRun.status='running' row.
    if (token && !token.cancelled) {
      const tokenAgeMs = Date.now() - (token.createdAt || 0);
      const anyUserRun = await prisma.run.findFirst({
        where: { projectId: project.id, userId: req.user.id, status: 'running' },
        select: { id: true },
      });
      const activeAgentRun = anyUserRun ? null : await prisma.agentRun.findFirst({
        where: {
          projectId: project.id,
          userId: req.user.id,
          status: 'running',
          startedAt: { gte: staleAgentRunCutoff() },
        },
        select: { id: true },
      });
      if (!anyUserRun && !activeAgentRun && tokenAgeMs > 10_000) {
        console.warn('[agents] /status: leaked cancelRegistry token cleared for user', req.user.id,
          'token age', Math.round(tokenAgeMs / 1000), 's.');
        cancelRegistry.clear(req.user.id);
        token = null;
      }
    }
    // generationRunning = token alive but no active conductor Run row exists.
    // Execution (conductor) always creates a Run row; scenario generation does not.
    // This lets the UI distinguish "generating scenarios" from "executing tests".
    let generationRunning = false;
    if (token && !token.cancelled) {
      const activeExecutionRun = await prisma.run.findFirst({
        where: { projectId: project.id, status: 'running' },
        select: { id: true },
      });
      generationRunning = !activeExecutionRun;
    }
    res.json({
      success: true,
      running: !!token && !token.cancelled,
      cancelRequested: !!token && token.cancelled,
      generationRunning,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/agents/pending-pauses ────
// Returns the list of currently-paused steps awaiting human input — used by
// the Live Pipeline modal to reconnect after a page refresh / navigation
// without losing the active prompt. Scoped by org via ownProject, but the
// registry is in-memory and tagged only by runId, so we return ALL pending
// pauses and let the client filter (the page knows which run is current).
router.get('/pending-pauses', async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const pauseRegistry = require('../services/pauseRegistry');
    res.json({ success: true, pending: pauseRegistry.listPending() });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/agents/provide-input ────
// HTTP fallback for the PauseModal when the WebSocket happens to be down.
// Normal flow delivers the verdict via WS `agent.inputProvided`; this route
// exists so a transient socket disconnect during the pause window doesn't
// strand the user. Body: { runId, tcId, stepIndex, action, value?, reason? }.
router.post('/provide-input', requireCsrf, async (req, res, next) => {
  try {
    const project = await ownProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { runId, tcId, stepIndex, action, value, reason } = req.body || {};
    if (!runId || !tcId || !Number.isFinite(stepIndex)) {
      return res.status(400).json({ success: false, code: 'BAD_INPUT', message: 'runId, tcId, stepIndex required.' });
    }
    const pauseRegistry = require('../services/pauseRegistry');
    const ok = pauseRegistry.provideInput({ runId, tcId, stepIndex, action, value, reason });
    if (!ok) return res.status(404).json({ success: false, code: 'NO_PAUSE', message: 'No pending pause for this case-step.' });
    res.json({ success: true });
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
    const send = (msg) => broadcast && broadcast(req.user.id, { ...msg, projectId: project.id });

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
