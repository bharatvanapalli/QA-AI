'use strict';

const express = require('express');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const integrations = require('../services/integrations');
const runsService = require('../services/runs');
const architect = require('../services/agents/architect');
const generationGuidance = require('../services/generationGuidance');
const declaredAssertionsLib = require('../lib/declaredAssertions');
const readinessCompiler = require('../services/readinessCompiler');
const canonicalGenerationPipeline = require('../services/canonicalGenerationPipeline');
const sourceGrounding = require('../services/sourceGrounding');
const generationFeatureFlags = require('../services/generationFeatureFlags');
const { getProvider } = require('../lib/llmProvider');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const { parseJsonResponse } = require('../lib/parseJsonResponse');
const { encodeJson, decodeJson } = require('../services/jsonField');
const { buildDataLiteralRepairs, dataBindingsFor, repairDataLiteralsInCase } = require('../lib/dataLiteralRepair');
const { sanitizeDeep, sanitizeTokenCorruptions } = require('../lib/tokenHygiene');
const { mutationBlockedPayload } = require('../services/testDesignLineageGuard');
const { syncScenarioGenerationCounts } = require('../services/scenarioGenerationCounts');
const testCaseStepMutations = require('../services/testCaseStepMutations');
const {
  BULK_APPROVAL_DISPOSITION,
  bulkApprovalDisposition,
  bulkApprovalReportEntry,
} = require('../services/bulkApprovalPolicy');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

async function resolveGenerationId(projectId, req) {
  const flags = generationFeatureFlags.flags();
  if (!flags.generationScopedTestCasesEnabled) return null;
  const q = typeof req.query?.generationId === 'string' ? req.query.generationId.trim() : '';
  if (q && q !== 'current') {
    if (q === 'legacy') return null;
    const gen = await prisma.scenarioGeneration.findFirst({
      where: { id: q, projectId },
      select: { id: true },
    });
    return gen?.id || null;
  }
  const current = await prisma.scenarioGeneration.findFirst({
    where: { projectId, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  return current?.id || null;
}

function readinessAsCompiledShape(readiness) {
  const reasons = Array.isArray(readiness?.readinessReasons) ? readiness.readinessReasons : [];
  return {
    state: readiness?.readinessStatus === readinessCompiler.READINESS_STATUS.READY
      ? 'ready'
      : readiness?.readinessStatus === readinessCompiler.READINESS_STATUS.BLOCKED
        ? 'blocked'
        : 'needs_review',
    blockers: reasons.filter((r) => r.severity === 'error'),
    warnings: reasons.filter((r) => r.severity !== 'error'),
    readinessStatus: readiness?.readinessStatus || readinessCompiler.READINESS_STATUS.NEEDS_REVIEW,
    approvalEligibility: readiness?.approvalEligibility || readinessCompiler.APPROVAL_ELIGIBILITY.ELIGIBLE,
    runEligibility: readiness?.runEligibility || readinessCompiler.RUN_ELIGIBILITY.BLOCKED,
    sessionMode: readiness?.sessionMode || readinessCompiler.SESSION_MODE.FRESH,
    reasons,
  };
}

// Step 6 — load the project's WorkbookContract (row-evidence source) so the
// CaseCompiler/Oracle Contract can resolve each case's bound CoverageItem and surface
// the data-oracle findings (data_oracle_missing, expected_value_token_unsupplied) in
// readiness/approval. Best-effort: no test data / pre-migration client → null, and the
// compiler degrades to no row evidence (behaviour unchanged). Built from the persisted
// sheets, so it reflects exactly what generation bound against.
async function loadProjectWorkbookContract(projectId) {
  try {
    const td = await require('../services/testDataContext').loadTestDataContext(projectId, null, {});
    if (td && Array.isArray(td.sheets) && td.sheets.length) {
      return require('../services/workbookContract').buildWorkbookContract({ sheets: td.sheets });
    }
  } catch (_) { /* no test data / older client → no row evidence */ }
  return null;
}

function llmText(resp) {
  if (typeof resp?.content === 'string') return resp.content.trim();
  if (Array.isArray(resp?.content)) {
    return resp.content.map((b) => (b && b.type === 'text' ? b.text : '')).join('').trim();
  }
  return '';
}

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function authoringProgress(req, payload = {}) {
  const broadcast = req.app.locals.broadcastToUser;
  if (!broadcast) return;
  broadcast(req.user.id, {
    type: 'authoring.progress',
    projectId: req.params.projectId,
    ts: new Date().toISOString(),
    ...payload,
  });
}

function testCaseRollbackPayload(tc) {
  if (!tc) return null;
  return {
    id: tc.id,
    projectId: tc.projectId,
    scenarioId: tc.scenarioId || null,
    generationId: tc.generationId || null,
    name: tc.name,
    type: tc.type,
    module: tc.module,
    confidence: tc.confidence,
    status: tc.status,
    assertions: tc.assertions,
    steps: tc.steps,
    specCode: tc.specCode,
    userGuidance: tc.userGuidance,
    dependsOnIds: tc.dependsOnIds,
    producesData: tc.producesData,
    requiresData: tc.requiresData,
    dataBindingJson: tc.dataBindingJson,
    requirementRefs: tc.requirementRefs,
    operationsJson: tc.operationsJson,
    authProfile: tc.authProfile,
    automatability: tc.automatability,
    automatabilityReason: tc.automatabilityReason,
    manualGuide: tc.manualGuide,
    manualCompletedAt: tc.manualCompletedAt,
    declaredAssertions: tc.declaredAssertions,
    businessRisk: tc.businessRisk,
  };
}

function testCaseRestoreData(snapshot, projectId) {
  return {
    projectId,
    scenarioId: snapshot.scenarioId || null,
    generationId: snapshot.generationId || null,
    name: snapshot.name,
    type: snapshot.type,
    module: snapshot.module,
    confidence: snapshot.confidence,
    status: snapshot.status,
    assertions: snapshot.assertions,
    steps: snapshot.steps,
    specCode: snapshot.specCode || null,
    userGuidance: snapshot.userGuidance || null,
    dependsOnIds: snapshot.dependsOnIds || null,
    producesData: snapshot.producesData || null,
    requiresData: snapshot.requiresData || null,
    dataBindingJson: snapshot.dataBindingJson || null,
    requirementRefs: snapshot.requirementRefs || null,
    operationsJson: snapshot.operationsJson || null,
    authProfile: snapshot.authProfile || null,
    automatability: snapshot.automatability || 'automatable',
    automatabilityReason: snapshot.automatabilityReason || null,
    manualGuide: snapshot.manualGuide || null,
    manualCompletedAt: snapshot.manualCompletedAt || null,
    declaredAssertions: snapshot.declaredAssertions || null,
    businessRisk: snapshot.businessRisk || 'P1',
  };
}

function parseAuditMetadata(row) {
  return parseJsonSafe(row?.metadata, null) || {};
}

function requestedStepsHash(req) {
  const bodyHash = typeof req.body?.baseStepsHash === 'string' ? req.body.baseStepsHash.trim() : '';
  const headerHash = typeof req.headers?.['if-match'] === 'string'
    ? req.headers['if-match'].trim().replace(/^W\//, '').replace(/^"|"$/g, '')
    : '';
  return bodyHash || headerHash || null;
}

function stepInputFromBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.prototype.hasOwnProperty.call(body, 'step')) {
    return body.step && typeof body.step === 'object' && !Array.isArray(body.step)
      ? body.step
      : null;
  }
  const {
    baseStepsHash: _baseStepsHash,
    index: _index,
    afterStepId: _afterStepId,
    stepIds: _stepIds,
    step: _step,
    projectId: _projectId,
    applyTo: _applyTo,
    ...step
  } = body;
  return step;
}

function broadcastStepMutation(req, result, type) {
  const broadcast = req.app.locals.broadcastToUser;
  if (!broadcast) return;
  broadcast(req.user.id, {
    type: 'testcases.updated',
    projectId: req.params.projectId,
    testCaseId: req.params.tcId,
    mutation: type,
    logicalStepCount: result.logicalStepCount,
    atomicActionCount: result.atomicActionCount,
    ts: new Date().toISOString(),
  });
}

function stepMutationResponse(result, type, undoAvailable = false) {
  return {
    success: true,
    testCase: {
      ...result.testCase,
      steps: result.steps,
    },
    steps: result.steps,
    stepsHash: result.afterHash,
    logicalStepCount: result.logicalStepCount,
    atomicActionCount: result.atomicActionCount,
    mutation: {
      id: result.mutationId,
      type,
      stepId: result.changedStepId || null,
      removedStep: result.removedStep || null,
      diagnostics: result.diagnostics || [],
      observationOnly: result.observationOnly || null,
      undoAvailable,
      appliesTo: result.appliesTo || 'next_execution',
    },
  };
}

function sendStepMutationError(err, res, next) {
  if (!(err instanceof testCaseStepMutations.StepMutationError)) return next(err);
  return res.status(err.status || 400).json({
    success: false,
    code: err.code || 'STEP_MUTATION_FAILED',
    message: err.message,
    ...(err.details ? { details: err.details } : {}),
  });
}

async function recordStepMutation(req, result, type) {
  const undoAvailable = Array.isArray(result.undoSnapshot);
  try {
    const readinessObservation = readinessCompiler.compileCaseReadiness(result.testCase || {});
    result.observationOnly = {
      mode: 'observation_only',
      readinessStatus: readinessObservation.readinessStatus,
      runEligibility: readinessObservation.runEligibility,
      approvalEligibility: readinessObservation.approvalEligibility,
      wouldHaveBlockedRun: readinessObservation.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED,
      reasonCodes: (readinessObservation.readinessReasons || []).map((reason) => reason && reason.code).filter(Boolean),
    };
  } catch (error) {
    result.observationOnly = {
      mode: 'observation_only',
      readinessStatus: 'observation_unavailable',
      wouldHaveBlockedRun: false,
      reasonCodes: [],
      diagnostic: String(error && error.message || error || 'readiness observation unavailable').slice(0, 500),
    };
  }
  await audit.log({
    userId: req.user.id,
    action: 'testCases.stepMutation',
    target: req.params.tcId,
    metadata: {
      projectId: req.params.projectId,
      mutationId: result.mutationId,
      type,
      changedStepId: result.changedStepId || null,
      removedStep: result.removedStep || null,
      beforeSteps: undoAvailable ? result.undoSnapshot : null,
      beforeHash: result.beforeHash,
      afterHash: result.afterHash,
      logicalStepCount: result.logicalStepCount,
      atomicActionCount: result.atomicActionCount,
      diagnostics: result.diagnostics || [],
      observationOnly: result.observationOnly,
      appliesTo: result.appliesTo,
    },
    req,
  });
  broadcastStepMutation(req, result, type);
  return undoAvailable;
}

function atlasSummaryForPrompt(calibrationAtlas) {
  if (!calibrationAtlas || typeof calibrationAtlas !== 'object') return null;
  const pages = Array.isArray(calibrationAtlas.pages)
    ? calibrationAtlas.pages.slice(0, 12).map((p) => ({
        pageRole: p.pageRole || null,
        url: p.url || p.normalizedUrl || null,
        visibleText: Array.isArray(p.textCorpus) ? p.textCorpus.slice(0, 25) : [],
        elements: Array.isArray(p.elementLabels) ? p.elementLabels.slice(0, 15) : [],
      }))
    : [];
  const capabilities = Array.isArray(calibrationAtlas.capabilities)
    ? calibrationAtlas.capabilities.slice(0, 30).map((c) => ({
        id: c.capabilityId || null,
        type: c.type || null,
        name: c.name || null,
        operations: Array.isArray(c.operations) ? c.operations.slice(0, 8) : [],
        pageUrl: c.pageUrl || null,
      }))
    : [];
  if (!pages.length && !capabilities.length) return null;
  return {
    degraded: calibrationAtlas.degraded || null,
    stale: calibrationAtlas.stale === true,
    slice: calibrationAtlas.slice || null,
    pages,
    capabilities,
  };
}

function repairableLogoutAssertion(testCase, assertion) {
  const intent = [
    testCase?.name,
    testCase?.assertions,
    testCase?.steps,
  ].filter(Boolean).join(' ').toLowerCase();
  const payload = assertion?.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  const expected = [
    assertion?.type,
    payload.pageName,
    Array.isArray(payload.expectedSignals) ? payload.expectedSignals.join(' ') : payload.expectedSignals,
    payload.expectedUrl,
    payload.expectedUrlPattern,
  ].filter(Boolean).join(' ').toLowerCase();
  return assertion?.type === 'PAGE'
    && /\b(log\s*out|logout|sign\s*out|session\s+end|redirects?\s+.*login)\b/.test(intent)
    && /\bdashboard\b|\/dashboard(?:\/index)?\b/.test(expected);
}

function repairedLogoutAssertion(testCase, assertion) {
  const now = new Date().toISOString();
  return {
    ...assertion,
    type: 'PAGE',
    criticality: assertion.criticality || 'must',
    payload: {
      ...(assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {}),
      pageName: 'login_page',
      expectedSignals: ['Login', 'Username', 'Password', '/auth/login'],
      primaryIndicator: 'Login',
      expectedUrlPattern: '/auth/login',
    },
    note: 'Repaired by QAAI: logout flow should verify the login page, not dashboard.',
    metadata: {
      ...(assertion.metadata && typeof assertion.metadata === 'object' ? assertion.metadata : {}),
      repairedBy: 'qaai_assertion_contract_defect',
      repairedAt: now,
      repairReason: 'Logout/sign-out flow had a PAGE dashboard assertion; expected state is login_page.',
      originalAssertion: assertion,
      testCaseName: testCase?.name || null,
    },
  };
}

// ── GET /api/projects/:projectId/test-cases ───────────────
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const generationId = await resolveGenerationId(project.id, req);
    const scopedWhere = generationFeatureFlags.flags().generationScopedTestCasesEnabled
      ? (generationId ? { projectId: project.id, generationId } : { projectId: project.id, generationId: null })
      : { projectId: project.id };
    const testCases = await prisma.testCase.findMany({
      where: scopedWhere,
      orderBy: [{ confidence: 'desc' }, { createdAt: 'asc' }],
    });
    // Compiled readiness per case (ready | needs_review | blocked) so the UI can
    // show it BEFORE approval — never present a blocked case as approvable. Pass
    // real atlas-capability context so "no typed operations" surfaces consistently
    // (not only when a flag is hand-passed). Best-effort; null atlas → no caps.
    let atlasHasCapabilities = false;
    try {
      const calib = await prisma.calibration.findFirst({
        where: { projectId: project.id, status: 'complete' },
        orderBy: { createdAt: 'desc' }, select: { id: true },
      });
      if (calib) {
        const capPage = await prisma.calibrationPage.findFirst({
          where: { calibrationId: calib.id, AND: [{ capabilitiesJson: { not: null } }, { capabilitiesJson: { not: '[]' } }] },
          select: { id: true },
        });
        atlasHasCapabilities = !!capPage;
      }
    } catch (_) { atlasHasCapabilities = false; }
    // Step 6 — supply the WorkbookContract so readiness reflects the Oracle Contract's
    // row-evidence findings (a data-driven case whose bound rows carry no expected
    // oracle surfaces as needs_review with data_oracle_missing, not a false "ready").
    const workbookContract = await loadProjectWorkbookContract(project.id);
    const sourceArtifacts = await sourceGrounding.listActiveSourceArtifacts({ prisma, projectId: project.id, generationId });
    const withReadiness = [];
    for (const tc of testCases) {
      let readiness = null;
      try {
        readiness = readinessCompiler.compileCaseReadiness(tc, { atlasHasCapabilities, workbookContract, sourceArtifacts });
        if (!readinessCompiler.isCachedReadinessCurrent(tc)) {
          await prisma.testCase.update({
            where: { id: tc.id },
            data: readinessCompiler.readinessUpdateData(readiness),
          }).catch(() => null);
        }
      } catch (_) {
        readiness = null;
      }
      withReadiness.push({
        ...tc,
        ...(readiness ? readinessCompiler.readinessUpdateData(readiness) : {}),
        readinessReasons: readiness?.readinessReasons || [],
        compiledReadiness: readiness ? readinessAsCompiledShape(readiness) : null,
      });
    }
    res.json({ success: true, testCases: withReadiness, generationId });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/generate ─────
router.post(
  '/generate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res) => {
    // RETIRED (Step 5 — persistence-bypass removal). This legacy path minted bare
    // TestCase rows via testGenerator WITHOUT the canonical contract: no
    // declaredAssertions, dataBindingJson, operationsJson, scenario/generation
    // linkage, and — critically — no CaseCompiler readiness. Those are exactly the
    // "cases born outside the compiler" that could be approved/run unverifiably.
    // It has NO frontend caller; the canonical path is the Architect → persistCases
    // → CaseCompiler pipeline at POST /api/projects/:projectId/scenarios/generate.
    // Refuse loudly (410) instead of silently creating naked cases.
    return res.status(410).json({
      success: false,
      code: 'ENDPOINT_RETIRED',
      message: 'This legacy generation endpoint has been retired because it bypassed the test-case contract (no declared assertions / data binding / operations / compiler readiness). Use the scenario-generation pipeline: POST /api/projects/:projectId/scenarios/generate (the "Generate" action on the Run Suite / Test Cases page).',
    });
  },
);

// ── PUT /api/projects/:projectId/test-cases/:tcId ─────────
router.put('/:tcId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const { name, type, module, confidence, assertions, status, userGuidance } = req.body || {};
    const data = {};
    if (typeof name === 'string') data.name = name.slice(0, 200);
    if (type) data.type = type;
    if (module) data.module = String(module).toLowerCase();
    if (typeof confidence === 'number') data.confidence = Math.max(0, Math.min(100, confidence));
    if (typeof assertions === 'string') data.assertions = assertions;
    if (status && ['pending', 'approved', 'rejected'].includes(status)) data.status = status;
    // Promotion gate — a case the CaseCompiler classifies as `blocked` (unresolved
    // tokens, malformed/parseFailed must-assertions, structurally broken binding,
    // placeholder URL) can NEVER become approved/runnable. needs_review is allowed
    // (runnable but flagged). Recomputed from the stored contract so it holds even
    // on a pre-regen client.
    if (data.status === 'approved') {
      const workbookContract = await loadProjectWorkbookContract(project.id);
      const readiness = readinessCompiler.compileCaseReadiness(existing, { workbookContract });
      if (readiness.approvalEligibility === readinessCompiler.APPROVAL_ELIGIBILITY.BLOCKED) {
        return res.status(422).json({
          success: false,
          code: 'CASE_NOT_APPROVABLE',
          message: `"${existing.name}" cannot be approved until its authored intent is recoverable.`,
          readiness,
        });
      }
      Object.assign(data, readinessCompiler.readinessUpdateData(readiness));
    }
    // userGuidance: free-form notes the user wants Conductor/Critic/Supervisor
    // to honour on future runs of THIS case. Accept '' to clear; cap length so
    // a runaway editor can't bloat the row.
    if (typeof userGuidance === 'string') {
      if (userGuidance.length > 4000) {
        return res.status(400).json({ success: false, code: 'TOO_LONG', message: 'Per-case guidance is capped at 4,000 characters.' });
      }
      const trimmed = userGuidance.trim();
      data.userGuidance = trimmed || null;
    }

    let tc = await prisma.testCase.update({ where: { id: existing.id }, data });
    try {
      const workbookContract = await loadProjectWorkbookContract(project.id);
      const readiness = readinessCompiler.compileCaseReadiness(tc, { workbookContract });
      const readinessData = readinessCompiler.readinessUpdateData(readiness);
      tc = await prisma.testCase.update({ where: { id: tc.id }, data: readinessData });
      return res.json({ success: true, testCase: { ...tc, readinessReasons: readiness.readinessReasons, compiledReadiness: readinessAsCompiledShape(readiness) } });
    } catch (_) {
      return res.json({ success: true, testCase: tc });
    }
  } catch (err) {
    next(err);
  }
});

// ── User-authored step mutations ────────────────────────────────────────────
// These routes intentionally do NOT invoke TestDesignStepCompiler or the
// immutable-plan mutation guard. A manual edit is authorized user intent:
// preserve it exactly, derive a best-effort executable interpretation, and let
// Conductor adapt it against the live application. Semantic uncertainty is a
// diagnostic, never a save gate. Existing/active executions must consume their
// run-start snapshot; these mutations apply to the next execution.
router.post('/:tcId/steps/undo', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const current = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
      select: { id: true, steps: true },
    });
    if (!current) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const currentHash = testCaseStepMutations.stepsHash(current.steps);
    const logs = await prisma.auditLog.findMany({
      where: {
        action: 'testCases.stepMutation',
        target: current.id,
        orgId: req.org.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const restorePoint = logs
      .map((row) => ({ row, metadata: parseAuditMetadata(row) }))
      .find(({ metadata }) => (
        metadata.projectId === project.id
        && metadata.afterHash === currentHash
        && Array.isArray(metadata.beforeSteps)
      ));
    if (!restorePoint) {
      return res.status(404).json({
        success: false,
        code: 'NO_UNDO_AVAILABLE',
        message: 'No matching step edit is available to undo.',
      });
    }

    const result = await testCaseStepMutations.restoreSteps({
      prisma,
      projectId: project.id,
      testCaseId: current.id,
      previousSteps: restorePoint.metadata.beforeSteps,
      expectedStepsHash: currentHash,
    });
    await audit.log({
      userId: req.user.id,
      action: 'testCases.stepUndo',
      target: current.id,
      metadata: {
        projectId: project.id,
        mutationId: result.mutationId,
        restoredMutationId: restorePoint.metadata.mutationId || null,
        restoredFromAuditLogId: restorePoint.row.id,
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
        logicalStepCount: result.logicalStepCount,
        atomicActionCount: result.atomicActionCount,
        appliesTo: result.appliesTo,
      },
      req,
    });
    broadcastStepMutation(req, result, 'undo');
    return res.json(stepMutationResponse(result, 'undo', false));
  } catch (err) {
    return sendStepMutationError(err, res, next);
  }
});

router.post('/:tcId/steps', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const step = stepInputFromBody(req.body);
    const result = await testCaseStepMutations.persistMutation({
      prisma,
      projectId: project.id,
      testCaseId: req.params.tcId,
      type: 'add',
      step,
      index: Number.isInteger(req.body?.index) ? req.body.index : null,
      afterStepId: typeof req.body?.afterStepId === 'string' ? req.body.afterStepId : null,
      expectedStepsHash: requestedStepsHash(req),
    });
    const undoAvailable = await recordStepMutation(req, result, 'add');
    return res.status(201).json(stepMutationResponse(result, 'add', undoAvailable));
  } catch (err) {
    return sendStepMutationError(err, res, next);
  }
});

router.patch('/:tcId/steps/order', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const result = await testCaseStepMutations.persistMutation({
      prisma,
      projectId: project.id,
      testCaseId: req.params.tcId,
      type: 'reorder',
      stepIds: req.body?.stepIds,
      expectedStepsHash: requestedStepsHash(req),
    });
    const undoAvailable = await recordStepMutation(req, result, 'reorder');
    return res.json(stepMutationResponse(result, 'reorder', undoAvailable));
  } catch (err) {
    return sendStepMutationError(err, res, next);
  }
});

router.patch('/:tcId/steps/:stepId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const step = stepInputFromBody(req.body);
    const result = await testCaseStepMutations.persistMutation({
      prisma,
      projectId: project.id,
      testCaseId: req.params.tcId,
      type: 'edit',
      stepId: req.params.stepId,
      step,
      expectedStepsHash: requestedStepsHash(req),
    });
    const undoAvailable = await recordStepMutation(req, result, 'edit');
    return res.json(stepMutationResponse(result, 'edit', undoAvailable));
  } catch (err) {
    return sendStepMutationError(err, res, next);
  }
});

router.delete('/:tcId/steps/:stepId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const result = await testCaseStepMutations.persistMutation({
      prisma,
      projectId: project.id,
      testCaseId: req.params.tcId,
      type: 'remove',
      stepId: req.params.stepId,
      expectedStepsHash: requestedStepsHash(req),
    });
    const undoAvailable = await recordStepMutation(req, result, 'remove');
    return res.json(stepMutationResponse(result, 'remove', undoAvailable));
  } catch (err) {
    return sendStepMutationError(err, res, next);
  }
});

// ── POST /api/projects/:projectId/test-cases/approve-all ──
// Scoped to the CURRENT generation only. "Approve all" (and the "run all" flow
// that calls it) must NEVER reach back and flip pending cases from older
// generation batches — those are historical/trial data the user has moved on
// from, and approving them would silently widen the next run's scope (and
// resurrect stale cases in dashboards). The current generation
// (isCurrent=true, exactly one per project) is the only batch the UI shows.
// This mirrors the exact generation scoping /agents/execute uses to choose its
// runnable set, so "approve all" and "run all" stay in lockstep on the SAME set.
router.post('/approve-all', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const currentGen = await prisma.scenarioGeneration.findFirst({
      where: { projectId: project.id, isCurrent: true },
      select: { id: true },
    });
    // Promotion gate — bulk "approve all" auto-approves ONLY `ready` cases. A
    // `needs_review` case is NOT silently promoted (the new ready-only standard: an
    // automated bulk action must never mint a runnable suite from cases still pending
    // human review), and a `blocked` case can never be approved. Both are held back and
    // reported so the UI shows WHY. (An operator can still approve a specific
    // needs_review case deliberately via the single-case PUT endpoint.)
    const pending = await prisma.testCase.findMany({
      where: {
        projectId: project.id,
        status: 'pending',
        ...(currentGen ? { generationId: currentGen.id } : {}),
      },
    });
    const workbookContract = await loadProjectWorkbookContract(project.id);
    const approvableIds = [];
    const blocked = [];
    const notRunnable = [];
    for (const tc of pending) {
      const readiness = readinessCompiler.compileCaseReadiness(tc, { workbookContract });
      await prisma.testCase.update({ where: { id: tc.id }, data: readinessCompiler.readinessUpdateData(readiness) }).catch(() => null);
      const disposition = bulkApprovalDisposition(readiness);
      if (disposition === BULK_APPROVAL_DISPOSITION.APPROVE) {
        approvableIds.push(tc.id);
      } else if (disposition === BULK_APPROVAL_DISPOSITION.BLOCKED) {
        blocked.push(bulkApprovalReportEntry(tc, readiness));
      } else {
        notRunnable.push(bulkApprovalReportEntry(tc, readiness));
      }
    }
    let updated = 0;
    if (approvableIds.length) {
      const result = await prisma.testCase.updateMany({
        where: { projectId: project.id, id: { in: approvableIds } },
        data: { status: 'approved' },
      });
      updated = result.count;
    }
    res.json({ success: true, updated, blockedCount: blocked.length, blocked, notRunnableCount: notRunnable.length, notRunnable });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/bulk-update ──
// Replaces the previous "approve impacted" pattern that did one PUT per case
// (50 cases = 50 sequential round-trips + frozen UI + torn state on mid-loop
// failure). One request, one updateMany, atomic.
router.post('/bulk-update', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const { ids, status } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({
        success: false, code: 'MISSING_IDS',
        message: 'ids[] is required.',
      });
    }
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false, code: 'INVALID_STATUS',
        message: 'status must be one of pending, approved, rejected.',
      });
    }
    // Promotion gate — bulk approval auto-promotes ONLY `ready` cases. `needs_review`
    // is held back (not silently made runnable), `blocked` can never be approved. For
    // pending/rejected transitions there is nothing to gate (you can always un-approve).
    if (status === 'approved') {
      const rows = await prisma.testCase.findMany({ where: { projectId: project.id, id: { in: ids } } });
      const workbookContract = await loadProjectWorkbookContract(project.id);
      const approvableIds = [];
      const blocked = [];
      const notRunnable = [];
      for (const tc of rows) {
        const readiness = readinessCompiler.compileCaseReadiness(tc, { workbookContract });
        await prisma.testCase.update({ where: { id: tc.id }, data: readinessCompiler.readinessUpdateData(readiness) }).catch(() => null);
        const disposition = bulkApprovalDisposition(readiness);
        if (disposition === BULK_APPROVAL_DISPOSITION.APPROVE) {
          approvableIds.push(tc.id);
        } else if (disposition === BULK_APPROVAL_DISPOSITION.BLOCKED) {
          blocked.push(bulkApprovalReportEntry(tc, readiness));
        } else {
          notRunnable.push(bulkApprovalReportEntry(tc, readiness));
        }
      }
      let updated = 0;
      if (approvableIds.length) {
        const r = await prisma.testCase.updateMany({ where: { projectId: project.id, id: { in: approvableIds } }, data: { status: 'approved' } });
        updated = r.count;
      }
      return res.json({ success: true, updated, blockedCount: blocked.length, blocked, notRunnableCount: notRunnable.length, notRunnable });
    }
    const result = await prisma.testCase.updateMany({
      where: { projectId: project.id, id: { in: ids } },
      data: { status },
    });
    res.json({ success: true, updated: result.count });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/:tcId/refine ───────────────
// Case-scoped AI refinement. Unlike userGuidance (execution notes), this
// actually rewrites the case's steps/assertions/dataBinding for review.
router.post(
  '/:tcId/refine',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    const TAG = `[testCases.refine user=${req.user.id} tc=${req.params.tcId}]`;
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      const existing = await prisma.testCase.findFirst({
        where: { id: req.params.tcId, projectId: project.id },
        include: {
          scenario: true,
          generation: { select: { id: true, coveragePlanJson: true } },
        },
      });
      if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      const refineBlock = mutationBlockedPayload(existing.generation, 'refine one test case');
      if (refineBlock) return res.status(409).json(refineBlock);
      const rollbackSnapshot = testCaseRollbackPayload(existing);
      const authoringBase = {
        operationId: req.body?.operationId || `case:${existing.id}`,
        scope: 'case',
        action: 'refine',
        testCaseId: existing.id,
        testCaseName: existing.name,
        scenarioId: existing.scenarioId || null,
        scenarioName: existing.scenario?.name || null,
      };
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'context',
        progress: 5,
        message: 'Loading test case context and AI settings.',
      });

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        authoringProgress(req, {
          ...authoringBase,
          status: 'error',
          phase: 'credentials',
          progress: 100,
          message: `${provider} API key is not configured.`,
        });
        return res.status(400).json({
          success: false,
          code: 'AI_PROVIDER_NOT_CONFIGURED',
          message: `${provider} API key not configured. Visit Settings → ${provider === 'gemini' ? 'Gemini' : 'Claude'} API.`,
        });
      }

      let savedGuidance = await generationGuidance.loadGuidance(prisma, {
        projectId: project.id,
        guidanceId: req.body?.guidanceId,
      });
      if (!savedGuidance) {
        savedGuidance = await generationGuidance.createGuidance(prisma, {
          projectId: project.id,
          userId: req.user.id,
          sprintId: req.body?.sprintId || null,
          generationId: existing.generationId || null,
          scenarioId: existing.scenarioId || null,
          testCaseId: existing.id,
          scope: 'case',
          sourceSurface: req.body?.sourceSurface || 'case-row',
          instruction: req.body?.instruction || '',
          quickIntents: req.body?.quickIntents || [],
          subject: existing.name,
        });
      }
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'guidance',
        progress: 12,
        message: 'Applying your improvement guidance.',
      });

      const requirements = await prisma.requirement.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'asc' },
        take: 30,
        select: { title: true, category: true, content: true },
      });
      const moduleScope = existing.scenario?.module || existing.module || null;
      const testDataContext = require('../services/testDataContext');
      let testData = await testDataContext.loadTestDataContext(
        project.id,
        null,
        { approvedOnly: true, moduleScope },
      ).catch(() => null);
      if (!testData || !dataBindingsFor(testData).length) {
        testData = await testDataContext.loadTestDataContext(
          project.id,
          null,
          { moduleScope },
        ).catch(() => null);
      }
      let sliceAuthProfileId = null;
      if (existing.authProfile) {
        try {
          const ap = await prisma.authProfile.findFirst({
            where: { projectId: project.id, name: existing.authProfile },
            select: { id: true },
          });
          sliceAuthProfileId = ap?.id || null;
        } catch (_) { sliceAuthProfileId = null; }
      }
      const sliceOpts = moduleScope ? { module: moduleScope, authProfileId: sliceAuthProfileId } : {};
      let calibrationContext = null;
      let calibrationAtlas = null;
      try {
        const { getCalibrationContext, getCalibrationAtlas } = require('../services/agents/calibrator');
        calibrationContext = await getCalibrationContext(project.id, sliceOpts);
        calibrationAtlas = await getCalibrationAtlas(project.id, sliceOpts);
      } catch (_) { /* calibrator not yet run - no atlas */ }
      const atlasSummary = atlasSummaryForPrompt(calibrationAtlas);
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'context',
        progress: 24,
        message: 'Prepared requirements, test data, and site atlas context.',
      });

      const existingCase = {
        name: existing.name,
        type: existing.type,
        module: existing.module,
        confidence: existing.confidence,
        assertions: existing.assertions,
        steps: decodeJson(existing.steps, []) || [],
        declaredAssertions: decodeJson(existing.declaredAssertions, []) || [],
        dataBinding: decodeJson(existing.dataBindingJson, null),
        requirementRefs: decodeJson(existing.requirementRefs, []) || [],
        producesData: decodeJson(existing.producesData, []) || [],
        requiresData: decodeJson(existing.requiresData, []) || [],
        authProfile: existing.authProfile || null,
        automatability: existing.automatability,
        automatabilityReason: existing.automatabilityReason,
      };

      const dataSummary = testData && Array.isArray(testData.mapping?.bindings)
        ? testData.mapping.bindings.map((b) => ({
            sheet: b.sheet,
            purpose: b.purpose,
            module: b.module || b.moduleKey,
            columnToField: b.columnToField,
            expectedColumn: b.expectedColumn,
            rowClassColumn: b.rowClassColumn,
            placeholders: Object.keys(b.columnToField || {}).concat(b.expectedColumn ? ['expected'] : []),
          })).slice(0, 12)
        : [];
      const reqSummary = requirements.map((r, i) => ({
        id: `DOC-${i + 1}`,
        title: r.title,
        category: r.category,
        excerpt: String(r.content || '').replace(/\s+/g, ' ').slice(0, 900),
      }));

      const system = `You are QAAI's case refinement agent. Rewrite ONE existing test case according to the user's QA guidance.

Output ONLY one JSON object. No markdown, no prose.

Required object shape:
{
  "name": "string",
  "type": "functional|smoke|regression|security|boundary|integration",
  "confidence": 70-99,
  "assertions": "human-readable summary",
  "steps": [{ "order": 1, "action": "Navigate|Click|Fill|Select|Check|Uncheck|Wait|ExtractData|Assert", "element": "string", "value": "string optional", "operationCheck": { "kind": "input_accepted|control_state|menu_opened|style_changed|page_ready|url_reached|action_completed|visible_text_ready|state_ready", "expected": "string optional" }, "verificationPoint": false, "oracleRef": "declared assertion id optional", "expected": "legacy display string optional", "expectedKind": "input_state|control_state|page_state|url_state|visible_text|action_state|none optional", "locator_hint": "string optional" }],
  "declaredAssertions": [{ "type": "TEXT|URL|ROLE|DOWNLOAD|FORBIDDEN_TEXT|FORBIDDEN_ROLE|EVALUATE|PAGE", "criticality": "must|should|incidental", "provenance": "doc_quoted|atlas_reconciled|inferred", "requirementRefs": ["REQ-..."], "payload": {}, "targetUrl": "optional", "checkAt": "end|transient" }],
  "dataBinding": { "sheet": "optional", "rowSelector": "all|positive|negative optional" },
  "requirementRefs": ["REQ-..."],
  "producesData": [],
  "requiresData": [],
  "automatability": "automatable|manual",
  "automatabilityReason": "string only if manual"
}

Rules:
- Treat the Existing case JSON as the baseline. This is a refinement, not a blank regeneration.
- Preserve the case's original purpose unless the guidance explicitly asks to change it.
- Preserve existing steps, declaredAssertions, requirementRefs, and dataBinding unless the guidance directly asks to change them or they violate the deterministic contracts below.
- If the guidance asks to add/insert/include a step, keep the previous steps and insert the new step at the earliest logically valid position in the flow; then renumber step.order sequentially.
- If the guidance asks to add/use an assertion, preserve existing valid assertions and add the requested assertion as a declaredAssertion. If it validates an intermediate step, mark that step verificationPoint=true and set oracleRef to the declared assertion id.
- Improve concrete steps and assertions; do not merely rewrite wording.
- Step operation checks must be precise and are execution-health checks, not QA verdict assertions. For Fill/Type, use operationCheck { kind: "input_accepted", expected: "Username textbox accepts the provided value" } with expectedKind "input_state"; never use page-text wording like "Username entered" or "Password entered". For Select/Check/Uncheck, use operationCheck kind "control_state". For Click, operationCheck must describe the immediate observable state needed next, such as "Dashboard page ready", "Profile menu opens", or "Error message visible"; omit it if no observable state follows. Use expectedKind "visible_text" only when that text should literally appear on the page. Business verification belongs in declaredAssertions, with verificationPoint/oracleRef only for mid-flow checks.
- Use uploaded data placeholders like {{searchName}} only when a matching data binding exists.
- If uploaded test data is relevant, use the role placeholders listed in Available test data bindings. Use {{expected}} for row-specific expected outcomes.
- If the user names an uploaded sheet, role, or column, bind only to a matching item from Available test data bindings; set dataBinding.sheet/rowSelector/expectedColumn accordingly and use placeholders in steps and assertion payloads.
- Do not hardcode uploaded row values. If the existing case contains a literal value that belongs to an uploaded row, replace it with the correct {{role}} placeholder.
- Use the Verified Site Atlas only for HOW to interact: real page names, control labels, selector hints, and visible text that exists. Never use the atlas to weaken or rewrite the business outcome the case is supposed to prove.
- If a step references an element absent from the atlas, either choose the nearest verified atlas label for the same interaction or leave the locator_hint empty; do not invent selectors.
- Every automatable case needs at least one must declaredAssertion.
- Keep this as ONE case. If guidance asks for unrelated coverage, make the current case precise and mention only relevant additions.
- Never invent credentials, selectors, requirement IDs, data sheet names, or expected outcomes.`;

      const guidanceBlock = generationGuidance.guidancePromptBlock(savedGuidance, {
        scope: 'case',
        subject: existing.name,
      });
      const user = [
        guidanceBlock,
        '',
        `Scenario: ${existing.scenario?.name || '(none)'}`,
        `Scenario module: ${existing.scenario?.module || existing.module || '(none)'}`,
        '',
        'Existing case JSON:',
        JSON.stringify(existingCase, null, 2),
        '',
        'Available source documents:',
        JSON.stringify(reqSummary, null, 2),
        '',
        'Available test data bindings:',
        JSON.stringify(dataSummary, null, 2),
        '',
        'Verified Site Atlas for this case/module:',
        calibrationContext
          ? String(calibrationContext).slice(0, 22_000)
          : '(No site atlas slice is available. Do not invent selectors or visible labels.)',
        '',
        'Structured atlas capability summary:',
        atlasSummary ? JSON.stringify(atlasSummary, null, 2) : '(No structured atlas capabilities available.)',
        '',
        'Return the refined case JSON now.',
      ].join('\n');

      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'claude_request',
        progress: 38,
        message: `Sending case refinement request to ${provider}.`,
      });
      const resp = await getProvider(provider).complete({
        apiKey,
        model,
        system,
        messages: [{ role: 'user', content: user }],
        maxTokens: 6000,
      });
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'parsing',
        progress: 72,
        message: 'Claude returned refined case content. Parsing JSON.',
      });
      const raw = llmText(resp);
      const parsed = parseJsonResponse(raw, { type: 'object' });
      if (!parsed) {
        authoringProgress(req, {
          ...authoringBase,
          status: 'error',
          phase: 'parsing',
          progress: 100,
          message: 'Claude did not return valid refined test case JSON.',
        });
        return res.status(502).json({ success: false, code: 'INVALID_AI_OUTPUT', message: 'AI did not return a valid refined test case.' });
      }

      const literalRepair = repairDataLiteralsInCase(parsed, buildDataLiteralRepairs(testData, moduleScope));
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'normalizing',
        progress: 82,
        message: 'Normalizing refined steps, data bindings, and assertions.',
      });
      const parsedForBinding = literalRepair.value;
      const scenarioShell = [{ name: existing.scenario?.name || existing.module || 'Scenario', module: existing.module, cases: [parsedForBinding] }];
      try {
        const testDataAuthoring = require('../services/testDataAuthoring');
        testDataAuthoring.markDataAwareCases(scenarioShell, testData, { moduleScope });
      } catch (err) {
        console.warn(`${TAG} data-aware post-processing failed:`, err.message);
      }
      const refined = architect.normaliseCase(scenarioShell[0].cases[0]);
      const declared = declaredAssertionsLib.normalizeForCase(refined.declaredAssertions, {
        automatability: refined.automatability,
        caseName: refined.name,
      }).normalized;

      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'persisting',
        progress: 90,
        message: 'Saving the refined test case for review.',
      });
      const refinedData = {
        name: sanitizeTokenCorruptions(refined.name),
        type: refined.type,
        module: refined.module || existing.module,
        confidence: refined.confidence,
        assertions: sanitizeTokenCorruptions(refined.assertions),
        steps: encodeJson(sanitizeDeep(refined.steps || [])),
        declaredAssertions: encodeJson(sanitizeDeep(declared)),
        dataBindingJson: refined.dataBinding ? encodeJson(refined.dataBinding) : null,
        requirementRefs: Array.isArray(refined.requirementRefs) && refined.requirementRefs.length ? encodeJson(refined.requirementRefs) : existing.requirementRefs,
        producesData: Array.isArray(refined.producesData) && refined.producesData.length ? encodeJson(refined.producesData) : null,
        requiresData: Array.isArray(refined.requiresData) && refined.requiresData.length ? encodeJson(refined.requiresData) : null,
        automatability: refined.automatability === 'manual' ? 'manual' : 'automatable',
        automatabilityReason: refined.automatability === 'manual' ? (refined.automatabilityReason || 'Refined as manual by QAAI guidance') : null,
        userGuidance: savedGuidance.normalizedDirectives,
        status: 'pending',
      };
      let updated = null;
      let refinedReadiness = null;
      try {
        const workbookContract = await loadProjectWorkbookContract(project.id);
        const persistedRefine = await canonicalGenerationPipeline.persistRefinedCase({
          prisma,
          testCaseId: existing.id,
          data: refinedData,
          workbookContract,
        });
        updated = persistedRefine.testCase;
        refinedReadiness = persistedRefine.readiness;
      } catch (err) {
        console.warn(`${TAG} canonical refine persistence failed:`, err.message);
        throw err;
      }

      await generationGuidance.markApplied(prisma, savedGuidance.id, {
        appliedGenerationId: existing.generationId || null,
        appliedScenarioId: existing.scenarioId || null,
        appliedTestCaseId: existing.id,
      });
      await audit.log({
        userId: req.user.id,
        action: 'testCases.refine',
        target: existing.id,
        metadata: {
          projectId: project.id,
          guidanceId: savedGuidance.id,
          moduleScope,
          dataLiteralRepairs: literalRepair.count,
          atlasIncluded: !!calibrationContext,
          atlasCapabilities: Array.isArray(calibrationAtlas?.capabilities) ? calibrationAtlas.capabilities.length : 0,
          rollbackSnapshot,
        },
        req,
      });
      authoringProgress(req, {
        ...authoringBase,
        status: 'done',
        phase: 'complete',
        progress: 100,
        message: 'Saved refined test case. Review it before approving.',
        testCaseName: updated.name,
      });
      res.json({
        success: true,
        testCase: {
          ...updated,
          steps: refined.steps || [],
          readinessReasons: refinedReadiness?.readinessReasons || [],
          compiledReadiness: refinedReadiness ? readinessAsCompiledShape(refinedReadiness) : null,
        },
        guidanceId: savedGuidance.id,
      });
    } catch (err) {
      authoringProgress(req, {
        operationId: req.body?.operationId || `case:${req.params.tcId}`,
        scope: 'case',
        action: 'refine',
        testCaseId: req.params.tcId,
        status: 'error',
        phase: 'error',
        progress: 100,
        message: err.message || 'Case refinement failed.',
      });
      if (err.code === 'BREAKER_OPEN' || err.code === 'BUDGET_EXCEEDED') {
        return res.status(429).json({ success: false, code: err.code, message: err.message });
      }
      if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
      next(err);
    }
  },
);

// ── GET /api/projects/:projectId/test-cases/:tcId/history ──
// Compact per-test history across runs — powers the Reports detail pane's
// sparkline + flaky score. Read-only, no CSRF needed.
// Restores the exact pre-refine snapshot captured by the latest case improve.
router.post('/:tcId/restore-latest', requireCsrf, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const current = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
      select: {
        id: true,
        name: true,
        generation: { select: { id: true, coveragePlanJson: true } },
      },
    });
    if (!current) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const restoreBlock = mutationBlockedPayload(current.generation, 'restore a test-case snapshot');
    if (restoreBlock) return res.status(409).json(restoreBlock);

    const logs = await prisma.auditLog.findMany({
      where: {
        action: 'testCases.refine',
        target: req.params.tcId,
      },
      orderBy: { createdAt: 'desc' },
      take: 12,
    });
    const restoreLog = logs.find((row) => {
      const meta = parseAuditMetadata(row);
      return meta.projectId === project.id && meta.rollbackSnapshot?.id === req.params.tcId;
    });
    const snapshot = parseAuditMetadata(restoreLog)?.rollbackSnapshot;
    if (!snapshot) {
      return res.status(404).json({
        success: false,
        code: 'NO_RESTORE_POINT',
        message: 'No previous version is available for this test case yet.',
      });
    }

    const restored = await prisma.testCase.update({
      where: { id: req.params.tcId },
      data: testCaseRestoreData(snapshot, project.id),
    });
    await audit.log({
      userId: req.user.id,
      action: 'testCases.restore',
      target: restored.id,
      metadata: {
        projectId: project.id,
        restoredFromAuditLogId: restoreLog.id,
        restoredName: snapshot.name,
        replacedName: current.name,
      },
      req,
    });
    res.json({ success: true, testCase: { ...restored, steps: decodeJson(restored.steps, []) || [] } });
  } catch (err) {
    next(err);
  }
});

router.get('/:tcId/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit || '20', 10);
    const data = await runsService.getTestCaseHistory(
      req.user.id, req.params.projectId, req.params.tcId, limit
    );
    res.json({ success: true, ...data });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/:tcId/manual-guide ──
// Lazy-generates a step-by-step human-tester guide for a manual case. Cached
// on `TestCase.manualGuide` after first generation so subsequent reads cost
// zero AI tokens. Re-generation requested with `?regen=1` invalidates the
// cache. Only valid for cases classified `automatability='manual'`.
router.post('/:tcId/manual-guide', requireCsrf, rateLimit({ windowMs: 60_000, max: 30 }), async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const tc = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
      include: { scenario: { select: { name: true, module: true } } },
    });
    if (!tc) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (tc.automatability !== 'manual') {
      return res.status(400).json({
        success: false, code: 'NOT_MANUAL',
        message: 'This case is classified automatable. Generate a manual guide only after reclassifying it.',
      });
    }
    const regen = req.query.regen === '1';
    if (!regen && typeof tc.manualGuide === 'string' && tc.manualGuide.trim()) {
      return res.json({ success: true, guide: tc.manualGuide, cached: true });
    }

    const integration = await integrations.get(req.user.id, 'claude');
    const apiKey = await vault.get(req.user.id, 'claude.apiKey');
    if (!apiKey || integration?.status !== 'valid') {
      return res.status(400).json({
        success: false, code: 'CLAUDE_NOT_CONFIGURED',
        message: 'Claude API key not configured. Visit Settings → Claude API.',
      });
    }

    let steps = [];
    try { steps = JSON.parse(tc.steps || '[]'); } catch (_) { steps = []; }
    const stepsBlock = steps.length
      ? steps.map((s, i) => `${i + 1}. ${[s.action, s.target, s.value].filter(Boolean).join(' — ')}${s.expected ? ` → expect: ${s.expected}` : ''}`).join('\n')
      : '(No structured steps recorded — derive from the case name and assertions.)';

    const system = `You write step-by-step manual test scripts for human testers. Output ONLY Markdown — no preamble, no closing summary, no JSON, no code fences around the whole document.

Required structure, in this order:
1. A "**Why this is manual**" callout (1 line, italic) explaining the reason this can't be automated.
2. A "**Prerequisites**" bullet list — what the tester must have ready before starting (accounts, devices, sample data).
3. A numbered "**Steps**" list. Each step is one observable action. Where the tester is expected to verify something, write "**Verify:** …" on its own indented line beneath the step.
4. A "**Pass criteria**" bullet list — the explicit signals that mean this case passes.
5. A "**Fail / blocker triggers**" bullet list — what should make the tester mark this as failed or blocked.
6. A "**Reporting**" line at the end stating exactly what to capture (screenshot, console log, ticket number).

Tone: direct, second person ("Tap the …", "Confirm that …"). No tester anxiety, no hedging. Steps fit in a clipboard view.`;

    const userMsg = `Case: ${tc.name}
Scenario: ${tc.scenario?.name || '(none)'}
Module: ${tc.module || tc.scenario?.module || '(none)'}
Manual reason: ${tc.automatabilityReason || '(not specified)'}
Recorded steps:
${stepsBlock}

Assertions to verify:
${tc.assertions || '(none)'}

Generate the manual test guide now.`;

    const provider = require('../lib/llmProvider').getProvider(integration.config?.provider || 'claude');
    const resp = await provider.complete({
      apiKey,
      model: integration.config?.model || 'claude-sonnet-4-6',
      system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 1500,
    });
    const text = Array.isArray(resp?.content)
      ? resp.content.map((b) => (b && b.type === 'text' ? b.text : '')).join('').trim()
      : (typeof resp?.content === 'string' ? resp.content.trim() : '');
    if (!text) {
      return res.status(502).json({ success: false, code: 'EMPTY_RESPONSE', message: 'AI returned no content.' });
    }
    await prisma.testCase.update({
      where: { id: tc.id },
      data: { manualGuide: text.slice(0, 20_000) },
    });
    await audit.log({
      userId: req.user.id, action: 'testCases.manualGuide',
      target: tc.id,
      metadata: { projectId: project.id, regenerated: regen },
      req,
    });
    res.json({ success: true, guide: text, cached: false });
  } catch (err) {
    if (err.code === 'BREAKER_OPEN' || err.code === 'BUDGET_EXCEEDED') {
      return res.status(429).json({ success: false, code: err.code, message: err.message });
    }
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/:tcId/manual-complete ──
// Tester ticks "Mark complete" on a manual case. Sets the timestamp so the
// dependency expansion can treat this case as satisfied for any automatable
// case that depends on it. Idempotent.
router.post('/:tcId/manual-complete', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const tc = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
    });
    if (!tc) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (tc.automatability !== 'manual') {
      return res.status(400).json({
        success: false, code: 'NOT_MANUAL',
        message: 'Only manual cases can be marked complete by hand.',
      });
    }
    const completedAt = req.body?.undo ? null : new Date();
    const updated = await prisma.testCase.update({
      where: { id: tc.id },
      data: { manualCompletedAt: completedAt },
    });
    await audit.log({
      userId: req.user.id, action: 'testCases.manualComplete',
      target: tc.id, metadata: { projectId: project.id, completed: !!completedAt }, req,
    });
    res.json({ success: true, testCase: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/projects/:projectId/test-cases/:tcId/reclassify ──
// Operator overrides the Architect's automatability call. Body:
// `{ automatability: 'automatable' | 'manual', reason?: string }`.
// Clearing to automatable also clears the cached manual guide & timestamps.
router.post('/:tcId/reclassify', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const tc = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
    });
    if (!tc) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const next_ = req.body?.automatability === 'manual' ? 'manual' : 'automatable';
    const reasonText = next_ === 'manual'
      ? String(req.body?.reason || '').trim().slice(0, 120) || 'Manually reclassified by operator'
      : null;
    const updated = await prisma.testCase.update({
      where: { id: tc.id },
      data: {
        automatability: next_,
        automatabilityReason: reasonText,
        // Clear manual-only state when moving back to automatable so the
        // Manual tab doesn't keep displaying stale guide text.
        manualGuide: next_ === 'automatable' ? null : tc.manualGuide,
        manualCompletedAt: next_ === 'automatable' ? null : tc.manualCompletedAt,
      },
    });
    await audit.log({
      userId: req.user.id, action: 'testCases.reclassify',
      target: tc.id, metadata: { projectId: project.id, from: tc.automatability, to: next_ }, req,
    });
    res.json({ success: true, testCase: updated });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:projectId/test-cases/:tcId/assertions/:assertionId ──
// Removes a single declared assertion from a test case by ID.
// Used from the Verdict & Evidence tab to discard uncheckable or wrong assertions
// without re-running the Architect on the whole scenario.
router.post('/:tcId/assertions/:assertionId/repair-contract', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
      include: { generation: { select: { id: true, coveragePlanJson: true } } },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const repairBlock = mutationBlockedPayload(existing.generation, 'repair an assertion contract in place');
    if (repairBlock) return res.status(409).json(repairBlock);

    let current = [];
    try { current = existing.declaredAssertions ? JSON.parse(existing.declaredAssertions) : []; } catch (_) {}
    if (!Array.isArray(current)) current = [];

    const index = current.findIndex((a) => a?.id === req.params.assertionId);
    if (index < 0) {
      return res.status(404).json({ success: false, code: 'ASSERTION_NOT_FOUND' });
    }
    const original = current[index];
    if (!repairableLogoutAssertion(existing, original)) {
      return res.status(400).json({
        success: false,
        code: 'ASSERTION_REPAIR_UNSUPPORTED',
        message: 'This assertion is not a recognized logout-page assertion contract defect.',
      });
    }

    const repaired = repairedLogoutAssertion(existing, original);
    const nextAssertions = current.slice();
    nextAssertions[index] = repaired;
    const tc = await prisma.testCase.update({
      where: { id: existing.id },
      data: { declaredAssertions: JSON.stringify(nextAssertions) },
    });
    await audit.log({
      userId: req.user.id,
      action: 'testCases.repairAssertionContract',
      target: existing.id,
      metadata: {
        projectId: project.id,
        assertionId: req.params.assertionId,
        repairType: 'logout_page_assertion',
        repairStatus: 'assertion_contract_repaired_pending_rerun',
        originalAssertion: original,
        repairedAssertion: repaired,
      },
      req,
    });
    res.json({
      success: true,
      testCase: tc,
      repairedAssertion: repaired,
      repairStatus: 'assertion_contract_repaired_pending_rerun',
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:tcId/assertions/:assertionId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
      include: { generation: { select: { id: true, coveragePlanJson: true } } },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const assertionDeleteBlock = mutationBlockedPayload(existing.generation, 'delete a compiler-owned assertion');
    if (assertionDeleteBlock) return res.status(409).json(assertionDeleteBlock);

    let current = [];
    try { current = existing.declaredAssertions ? JSON.parse(existing.declaredAssertions) : []; } catch (_) {}
    if (!Array.isArray(current)) current = [];

    const filtered = current.filter((a) => a?.id !== req.params.assertionId);
    if (filtered.length === current.length) {
      return res.status(404).json({ success: false, code: 'ASSERTION_NOT_FOUND' });
    }

    const tc = await prisma.testCase.update({
      where: { id: existing.id },
      data: { declaredAssertions: JSON.stringify(filtered) },
    });
    res.json({ success: true, testCase: tc });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/projects/:projectId/test-cases/:tcId ──────
router.delete('/:tcId', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.testCase.findFirst({
      where: { id: req.params.tcId, projectId: project.id },
      include: { generation: { select: { id: true, coveragePlanJson: true } } },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const deleteBlock = mutationBlockedPayload(existing.generation, 'delete one test case');
    if (deleteBlock) return res.status(409).json(deleteBlock);
    await prisma.$transaction(async (tx) => {
      await tx.testCase.deleteMany({
        where: { id: req.params.tcId, projectId: project.id },
      });
      if (existing.generation?.id) {
        await syncScenarioGenerationCounts(tx, {
          projectId: project.id,
          generationId: existing.generation.id,
        });
      }
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
