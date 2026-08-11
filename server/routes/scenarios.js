'use strict';

const express = require('express');
const prisma = require('../prisma');
const audit = require('../services/audit');
const { resolveAiCredentials } = require('../lib/resolveAiCredentials');
const architect = require('../services/agents/architect');
const cancelRegistry = require('../services/cancelRegistry');
const generationGuidance = require('../services/generationGuidance');
const coveragePlanner = require('../services/coveragePlanner');
const crawlPlanner = require('../lib/crawlPlanner');
const {
  coverageDefectsFromValidation,
  collectScenarioReliabilityArtifacts,
  collectScenarioReliabilityDefects,
  normalizeStepsInput,
  summarizeDefects,
} = require('../services/reliability/contracts');
const {
  createScenarioReliabilityReport,
} = require('../services/reliability/promotion');
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
  scenarioFloorForClauses,
} = require('../services/reliability/generationPromotionGuard');
const { floorFillScenarioSuite } = require('../services/reliability/scenarioFloorFill');
const { recordDegradation } = require('../lib/degradationSignal');
const { encodeJson, decodeJson } = require('../services/jsonField');
const {
  normalizeScenarioPersistenceBatch,
  buildScenarioCreateData,
} = require('../services/scenarioPersistenceContract');
const canonicalGenerationPipeline = require('../services/canonicalGenerationPipeline');
const {
  appendGenerationContractSnapshot,
  rollbackAppendedGenerationMutation,
} = require('../services/appendGenerationRollback');
const {
  countScenarioGenerationRelations,
  syncScenarioGenerationCounts,
} = require('../services/scenarioGenerationCounts');
const sourceGrounding = require('../services/sourceGrounding');
const {
  buildAppendScenarioRequest,
} = require('../services/appendScenarioRequest');
const {
  createAddScenarioExistingContext,
} = require('../services/addScenarioExistingContext');
// Phase H M3 — declared-assertion normalisation + stable ID stamping.
// Architect emits declaredAssertions natively as part of its JSON output;
// this helper validates the shape, assigns server-side IDs, and surfaces
// malformed records as parseFailed: true so M4 routes them to needs_human
// rather than silently passing or hard-rejecting the architect run.
const declaredAssertionsLib = require('../lib/declaredAssertions');
const { extractProceduralFlowContract } = require('../services/proceduralFlowContract');
const { ingestAuthoredFlow } = require('../services/authoredFlowIngestion');
const addScenarioSemanticPlanner = require('../services/addScenarioSemanticPlanner');
const {
  interpretAddScenario,
  refineAddScenarioInterpretation,
} = require('../services/addScenarioInterpretationPreview');
const {
  createSemanticPlanFromInterpretation,
} = require('../services/addScenarioInterpretationDraft');
const caseContractSemanticValidator = require('../services/caseContractSemanticValidator');
const { buildAddScenarioPreview } = require('../services/addScenarioPreview');
const { addScenarioDraftRegistry } = require('../services/addScenarioDraftRegistry');
const { approveRegisteredAddScenarioDraft } = require('../services/addScenarioApproval');
const { planAddScenarioRefinementIntent } = require('../services/addScenarioRefinementIntentPlanner');
const { refineAddScenarioPreview } = require('../services/addScenarioPreviewRefinement');
const { mutationBlockedPayload } = require('../services/testDesignLineageGuard');
const {
  findScenarioDeletionBlockers,
  scenarioDeletionBlockedError,
} = require('../services/scenarioDeletionPolicy');
const { normalizeRequirementDocument } = require('../services/requirementDocNormalizer');

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

function cleanAddScenarioRefinementValue(value, max = 20_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function buildAddScenarioRefinementCatalog(preview) {
  const scenarios = Array.isArray(preview && preview.scenarios) ? preview.scenarios : [];
  return scenarios.flatMap((scenario) => {
    const cases = Array.isArray(scenario && scenario.cases) ? scenario.cases : [];
    return cases.flatMap((caseRecord) => {
      const caseId = cleanAddScenarioRefinementValue(caseRecord && caseRecord.id, 500);
      const ordered = Array.isArray(caseRecord && caseRecord.orderedOperations)
        ? caseRecord.orderedOperations
        : null;
      if (ordered && ordered.length) {
        return ordered.map((operation, index) => ({
          operationId: operation && operation.id,
          caseId,
          kind: operation && operation.kind,
          ordinal: Number(operation && operation.ordinal) || index + 1,
          type: operation && operation.type,
          semanticTarget: operation && (operation.targetIdentity || operation.target),
          summary: operation && (operation.text || operation.description || operation.target),
        }));
      }
      const actions = Array.isArray(caseRecord && caseRecord.steps) ? caseRecord.steps : [];
      const assertions = Array.isArray(caseRecord && caseRecord.assertions) ? caseRecord.assertions : [];
      return [
        ...actions.map((operation, index) => ({
          operationId: operation && operation.id,
          caseId,
          kind: 'action',
          ordinal: Number(operation && operation.ordinal) || index + 1,
          type: operation && operation.type,
          semanticTarget: operation && (operation.targetIdentity || operation.target),
          summary: operation && (operation.text || operation.description || operation.target),
        })),
        ...assertions.map((operation, index) => ({
          operationId: operation && operation.id,
          caseId,
          kind: 'assertion',
          ordinal: Number(operation && operation.ordinal) || index + 1,
          type: operation && operation.type,
          semanticTarget: operation && (operation.targetIdentity || operation.target),
          summary: operation && (operation.text || operation.description || operation.target),
        })),
      ];
    });
  });
}

function decorateAddScenarioDraftPreview(preview, draft, generationId) {
  const projectId = draft && draft.projectId || null;
  const draftId = draft && draft.draftId || null;
  const approvalEndpoint = projectId && draftId
    ? `/projects/${encodeURIComponent(projectId)}/scenarios/drafts/${encodeURIComponent(draftId)}/approve`
    : null;
  return Object.freeze({
    ...preview,
    draftId,
    digest: preview && preview.source && preview.source.digest || null,
    generationId: generationId || null,
    currentGenerationUnchanged: true,
    approval: Object.freeze({
      enabled: Boolean(approvalEndpoint && preview && preview.approvalEligible === true),
      endpoint: approvalEndpoint,
      method: 'POST',
      requiredAuthority: Object.freeze(['revision', 'sourceDigest', 'generationId']),
    }),
  });
}
const { buildCaseNumbering } = require('../lib/caseNumbering');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { requireCsrf } = require('../middleware/csrf');
const { rateLimit } = require('../middleware/rateLimit');

// Extract a human-readable message from a raw Anthropic/Gemini SDK error
// string that wraps a JSON body: "400 {\"type\":\"error\",\"error\":{...}}"
function cleanAgentError(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  try {
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const msg = parsed?.error?.message || parsed?.message;
      if (msg && typeof msg === 'string') return msg;
    }
  } catch (_) {}
  return raw;
}

const router = express.Router({ mergeParams: true });
router.use(requireAuth);
router.use(requireOrg);

async function getProject(req) {
  return prisma.project.findFirst({
    where: { id: req.params.projectId, orgId: req.org.id },
  });
}

function inflateScenario(s) {
  if (!s) return s;
  const out = { ...s, dependencyOn: decodeJson(s.dependencyOn, []) || [] };
  if (Array.isArray(out.cases)) {
    out.cases = out.cases.map((c) => {
      const steps = normalizeStepsInput(c.steps, { allowSingletonObject: false });
      return { ...c, steps: steps.ok ? steps.steps : [] };
    });
  }
  return out;
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

function scenarioRollbackPayload(scenario) {
  if (!scenario) return null;
  return {
    id: scenario.id,
    projectId: scenario.projectId,
    generationId: scenario.generationId || null,
    name: scenario.name,
    module: scenario.module,
    priority: scenario.priority,
    category: scenario.category,
    rationale: scenario.rationale,
    dependencyOn: scenario.dependencyOn,
    source: scenario.source,
    impacted: scenario.impacted,
    impactReason: scenario.impactReason,
    cases: (scenario.cases || []).map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      module: c.module,
      confidence: c.confidence,
      status: c.status,
      assertions: c.assertions,
      steps: c.steps,
      specCode: c.specCode,
      userGuidance: c.userGuidance,
      dependsOnIds: c.dependsOnIds,
      producesData: c.producesData,
      requiresData: c.requiresData,
      dataBindingJson: c.dataBindingJson,
      requirementRefs: c.requirementRefs,
      operationsJson: c.operationsJson,
      authProfile: c.authProfile,
      automatability: c.automatability,
      automatabilityReason: c.automatabilityReason,
      manualGuide: c.manualGuide,
      manualCompletedAt: c.manualCompletedAt,
      declaredAssertions: c.declaredAssertions,
      businessRisk: c.businessRisk,
      generationId: c.generationId || null,
    })),
  };
}

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

function scenarioCoverageRefs(scenario) {
  const refs = new Set();
  for (const c of (Array.isArray(scenario && scenario.cases) ? scenario.cases : [])) {
    for (const ref of coveragePlanner.caseCoverageRefs(c)) refs.add(ref);
  }
  return Array.from(refs);
}

function normalizeDependencyIds(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  if (!value || typeof value !== 'string') return [];
  try {
    const decoded = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.map((v) => String(v || '').trim()).filter(Boolean) : [];
  } catch (_) {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
}

function mergeUniqueStrings(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const raw of (Array.isArray(group) ? group : [])) {
      const value = String(raw || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function normalizeStateContracts(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (!value || typeof value !== 'string') return [];
  try {
    const decoded = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.filter((item) => item && typeof item === 'object') : [];
  } catch (_) {
    return [];
  }
}

function applyAppendContinuationContract(scenarios, parentCase) {
  const parentId = parentCase && parentCase.id;
  if (!parentId || !Array.isArray(scenarios)) return scenarios;
  const requiredAuthState = {
    key: 'authenticated_session',
    type: 'auth_session',
    scope: 'generation',
    sourceCaseId: parentId,
    required: true,
  };
  return scenarios.map((scenario) => ({
    ...scenario,
    dependencyOn: mergeUniqueStrings(
      Array.isArray(scenario && scenario.dependencyOn) ? scenario.dependencyOn : [],
      [parentCase.scenario && parentCase.scenario.name].filter(Boolean),
    ),
    cases: (Array.isArray(scenario && scenario.cases) ? scenario.cases : []).map((testCase) => {
      const existingState = normalizeStateContracts(testCase && (testCase.requiresStateJson || testCase.requiresState));
      const hasAuthState = existingState.some((state) => (
        state
        && state.type === 'auth_session'
        && (state.sourceCaseId === parentId || state.key === 'authenticated_session')
      ));
      return {
        ...testCase,
        dependsOnIds: mergeUniqueStrings(normalizeDependencyIds(testCase && testCase.dependsOnIds), [parentId]),
        dependsOnNames: [],
        sessionMode: 'continue_from_dependency',
        failurePolicy: 'block_dependents',
        requiresStateJson: hasAuthState ? existingState : [...existingState, requiredAuthState],
      };
    }),
  }));
}

function guidanceRequestsContinuation(value) {
  const text = String(value || '').toLowerCase();
  return /\bcontinue(?:s|d)?\b/.test(text)
    && /\b(existing|previous|parent|tc[-\s]?\d+|test case|browser session|same session|dependent|depends?\s*on)\b/.test(text);
}

function simpleTextScore(a, b) {
  const words = (value) => String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const left = words(a);
  const right = new Set(words(b));
  if (!left.length || !right.size) return 0;
  return left.filter((w) => right.has(w)).length / Math.sqrt(left.length * right.size);
}

function sliceCoverageManifestForScenario(manifest, scenario) {
  if (!manifest || !Array.isArray(manifest.items)) return manifest;
  const refs = new Set(scenarioCoverageRefs(scenario));
  let mode = 'module';
  let items = manifest.items;
  if (refs.size) {
    const matched = manifest.items.filter((item) => refs.has(item.manifestItemId));
    if (matched.length) {
      mode = 'existing_coverageRefs';
      items = matched.map((item) => ({ ...item, required: true, advisory: false }));
    }
  } else {
    const scored = manifest.items
      .map((item) => ({
        item,
        score: simpleTextScore(`${item.storyRef && item.storyRef.title || ''} ${item.storyRef && item.storyRef.id || ''}`, scenario && scenario.name),
      }))
      .filter((entry) => entry.score > 0.16)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      mode = 'scenario_name_similarity';
      items = scored.slice(0, 5).map((entry) => ({ ...entry.item, required: entry.item.required !== false }));
    }
  }
  const required = items.filter((item) => item.required);
  const advisory = items.filter((item) => item.advisory);
  return {
    ...manifest,
    slice: { mode, scenarioId: scenario && scenario.id, scenarioName: scenario && scenario.name, refs: Array.from(refs) },
    itemCount: items.length,
    requiredCount: required.length,
    advisoryCount: advisory.length,
    items,
  };
}

function sliceCoverageManifestForAppend(manifest, { sessionGuidance = '', moduleScope = null, requirementIds = [] } = {}) {
  if (!manifest || !Array.isArray(manifest.items)) return manifest;
  const requestedReqs = new Set((Array.isArray(requirementIds) ? requirementIds : []).map(String).filter(Boolean));
  const guidance = String(sessionGuidance || '').trim();
  const scored = manifest.items
    .map((item) => {
      const story = item && item.storyRef ? item.storyRef : {};
      let score = 0;
      if (requestedReqs.size && requestedReqs.has(String(story.id))) score += 1;
      if (moduleScope) {
        const moduleText = `${story.moduleHint || ''} ${story.title || ''} ${item.manifestItemId || ''}`;
        score += simpleTextScore(moduleText, moduleScope) >= 0.18 ? 0.6 : 0;
      }
      if (guidance) {
        const dataText = item.dataSource ? `${item.dataSource.sheet || ''} ${(item.dataSource.placeholders || []).join(' ')}` : '';
        const itemText = `${story.id || ''} ${story.title || ''} ${item.strategy || ''} ${dataText}`;
        score += simpleTextScore(itemText, guidance);
      }
      return { item, score };
    })
    .filter((entry) => entry.score >= 0.18)
    .sort((a, b) => b.score - a.score);
  const selected = new Set(scored.slice(0, requestedReqs.size ? 20 : 8).map((entry) => entry.item.manifestItemId));
  const items = manifest.items.map((item) => {
    if (selected.has(item.manifestItemId)) {
      return { ...item, required: true, advisory: false, priority: Math.min(Number(item.priority || 2), 1) };
    }
    return { ...item, required: false };
  });
  const required = items.filter((item) => item.required);
  const advisory = items.filter((item) => item.advisory);
  return {
    ...manifest,
    slice: {
      mode: 'append_request',
      guidance: guidance.slice(0, 240),
      moduleScope: moduleScope || null,
      requirementIds: Array.from(requestedReqs),
      selectedManifestItemIds: Array.from(selected),
    },
    itemCount: items.length,
    requiredCount: required.length,
    advisoryCount: advisory.length,
    items,
  };
}

async function finalizeCoverage({
  manifest,
  scenarios,
  testData,
  onLog = null,
  collector = null,
  projectId = null,
  generationId = null,
  idempotencyKey = null,
  retryOfJobId = null,
  resumeFromStage = null,
  scenarioGenerationJob = null,
  calibrationAtlas = null,
  appCapabilityMap = null,
  targetUrl = null,
  authRole = null,
}) {
  const activeScenarioGenerationJob = scenarioGenerationJob || reliabilityJobs.createScenarioGenerationJob({
    projectId,
    generationId,
    idempotencyKey,
    retryOfJobId,
    resumeFromStage,
  });
  reliabilityJobs.updateScenarioGenerationJob(activeScenarioGenerationJob, {
    status: reliabilityJobs.JOB_STATUS.VALIDATING,
    stage: reliabilityJobs.JOB_STATUS.VALIDATING,
    progress: 35,
    reason: 'coverage_validation_started',
  });
  try {
  if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) {
    const empty = { summary: { required: 0, covered: 0, repaired: 0, needsReview: 0, missingCapability: 0 }, validation: null, repair: null };
    reliabilityJobs.completeScenarioGenerationJobFromReport(activeScenarioGenerationJob, { status: 'ready', unresolvedDefects: [] });
    return { scenarios, ...empty };
  }
  const first = coveragePlanner.validateCoveragePlan({ manifest, scenarios, testData });
  let working = Array.isArray(scenarios) ? [...scenarios] : [];
  const repair = {
    repaired: 0,
    synthesizedScenarioCount: 0,
    missingBefore: first.missingRequired.map((item) => item.manifestItemId),
    prompts: [],
  };
  // Synthesis removed — the Architect's output is authoritative. Coverage gaps are
  // quality hints, not a trigger to inject a blob scenario.
  const autoRepair = coveragePlanner.repairCoveragePlanScenarios({ manifest, scenarios: working, testData });
  working = autoRepair.scenarios;
  repair.autoRepair = autoRepair.repairs;
  repair.repaired += Object.values(autoRepair.repairs || {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  // Final validation runs against the REPAIRED scenarios; thread the degradation
  // sink so per-row under-coverage (#22) and untokenizable-clause (#24) signals
  // reach the operator log and the coverage findings collector.
  let finalValidation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: working, testData, onLog, collector });
  // Coverage gaps are quality warnings, not fatal errors. Only throw for structural failures.
  const fatalFindings = (finalValidation.findings || []).filter(
    (f) => f.severity === 'error' && f.code !== 'coverage_required_missing',
  );
  if (fatalFindings.length) {
    const err = new Error(`Coverage plan validation failed: ${fatalFindings.map((f) => f.code).join(', ')}`);
    err.code = 'COVERAGE_PLAN_VALIDATION_FAILED';
    err.status = 422;
    err.coverageValidation = finalValidation;
    throw err;
  }
  let summary = coveragePlanner.coverageSummary(finalValidation, repair);
  summary.ok = finalValidation.ok;
  summary.missingRequired = Array.isArray(finalValidation.missingRequired) ? finalValidation.missingRequired.length : 0;
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
    ...coverageDefectsFromValidation(finalValidation),
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
    reliabilityJobs.updateScenarioGenerationJob(activeScenarioGenerationJob, {
      status: reliabilityJobs.JOB_STATUS.REPAIRING,
      stage: reliabilityJobs.JOB_STATUS.REPAIRING,
      progress: 62,
      reason: 'repair_orchestrator_started',
    });
    const validateReliability = (nextScenarios) => {
      const validation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: nextScenarios, testData });
      return [
        ...coverageDefectsFromValidation(validation),
        ...collectScenarioReliabilityDefects(nextScenarios, reliabilityContext),
      ];
    };
    const repairResult = await runReliabilityRepairOrchestrator({
      scenarios: working,
      defects: reliabilityDefects,
      context: reliabilityContext,
      repairers: defaultReliabilityRepairers,
      validate: validateReliability,
      isCancelled: () => activeScenarioGenerationJob.cancelRequested,
    });
    working = repairResult.scenarios || working;
    reliabilityDefects = repairResult.defects || reliabilityDefects;
    finalValidation = coveragePlanner.validateCoveragePlan({ manifest, scenarios: working, testData });
    summary = coveragePlanner.coverageSummary(finalValidation, repair);
    summary.ok = finalValidation.ok;
    summary.missingRequired = Array.isArray(finalValidation.missingRequired) ? finalValidation.missingRequired.length : 0;
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
  if (activeScenarioGenerationJob.cancelRequested || repairStopReason === 'cancelled') {
    reliabilityJobs.failScenarioGenerationJob(activeScenarioGenerationJob, 'Reliability repair job was cancelled.');
  } else {
    reliabilityJobs.completeScenarioGenerationJobFromReport(activeScenarioGenerationJob, reliabilityReport);
  }
  reliabilityReport.scenarioGenerationJob = reliabilityJobs.serializeScenarioGenerationJob(activeScenarioGenerationJob);
  summary.reliabilityStatus = reliabilityReport.status;
  summary.unresolvedDefects = reliabilityReport.unresolvedDefects.length;
  return { scenarios: working, validation: finalValidation, repair, summary, reliabilityReport, appCapabilityMap: groundedCapabilityMap, appCapabilitySummary };
  } catch (err) {
    reliabilityJobs.failScenarioGenerationJob(activeScenarioGenerationJob, err && err.message ? err.message : 'Coverage finalization failed.');
    if (err && typeof err === 'object') {
      err.scenarioGenerationJob = reliabilityJobs.serializeScenarioGenerationJob(activeScenarioGenerationJob);
    }
    throw err;
  }
}

function generationCoverageData(coverage) {
  if (!coverage) return null;
  let validationOut = coverage.validation || null;
  if (Array.isArray(coverage.degradations) && coverage.degradations.length) {
    validationOut = { ...(validationOut || {}), degradations: coverage.degradations };
  }
  return {
    coveragePlanJson: coverage.manifest ? encodeJson(coverage.manifest) : null,
    coverageValidationJson: (validationOut || coverage.reliabilityReport) ? encodeJson({
      ...(validationOut || {}),
      ...(coverage.reliabilityReport ? { reliabilityReport: coverage.reliabilityReport } : {}),
    }) : null,
    coverageRepairJson: coverage.repair ? encodeJson(coverage.repair) : null,
  };
}

function mergeAppendCoverageManifest(existingValue, appendedValue) {
  const existing = decodeJson(existingValue, null);
  const appended = decodeJson(appendedValue, null);
  if (!existing || typeof existing !== 'object') return appended;
  if (!appended || typeof appended !== 'object') return existing;
  const dedupe = (rows, keyOf) => {
    const byKey = new Map();
    for (const row of rows.filter(Boolean)) {
      const key = keyOf(row) || encodeJson(row);
      byKey.set(key, row);
    }
    return Array.from(byKey.values());
  };
  const items = dedupe(
    [...(Array.isArray(existing.items) ? existing.items : []), ...(Array.isArray(appended.items) ? appended.items : [])],
    (item) => item.manifestItemId || item.coverageItemId || item.id,
  );
  const advisory = dedupe(
    [...(Array.isArray(existing.advisory) ? existing.advisory : []), ...(Array.isArray(appended.advisory) ? appended.advisory : [])],
    (item) => item.manifestItemId || item.coverageItemId || item.id,
  );
  const historyFor = (field) => dedupe([
    ...((existing.contractHistory && Array.isArray(existing.contractHistory[field])) ? existing.contractHistory[field] : []),
    existing[field],
    appended[field],
  ], (contract) => contract && (contract.contractId || contract.catalogId || contract.planId || contract.revision));
  return {
    ...existing,
    ...appended,
    items,
    advisory,
    contractHistory: {
      requirementUnderstandingV1: historyFor('requirementUnderstandingV1'),
      // DatasetCatalogV1 contains immutable IDs, revisions, mapping refs, and
      // hashes only (never raw cell values). Preserve every append-era catalog
      // so cases already in this generation keep a verifiable workbookHash.
      datasetCatalogV1: historyFor('datasetCatalogV1'),
      storyDataAlignmentPlanV1: historyFor('storyDataAlignmentPlanV1'),
      testDesignPlanV1: historyFor('testDesignPlanV1'),
    },
    appendBaseRevision: existing.revision || existing.manifestId || null,
  };
}

async function writeGenerationCoverage(prismaClient, generationId, coverage, { bestEffort = false } = {}) {
  if (!generationId || !coverage) return;
  // Fold any degradation signals (#22/#24/#30/#31) into the persisted validation
  // blob so the UI/RTM surface shows the honest "could not fully cover X" record
  // alongside the coverage numbers, instead of them living only in the run log.
  try {
    await prismaClient.scenarioGeneration.update({
      where: { id: generationId },
      data: generationCoverageData(coverage),
    });
  } catch (err) {
    if (!bestEffort) throw err;
    console.warn('[coveragePlanner] generation coverage evidence not persisted:', err.message);
  }
}

function scenarioMatchScore(candidate, existing) {
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && word.length > 2);
  const sourceWords = new Set(normalize(existing?.name));
  const candidateWords = normalize(candidate?.name);
  const shared = candidateWords.filter((word) => sourceWords.has(word)).length;
  const priorityMatch = candidate?.priority === existing?.priority ? 2 : 0;
  const categoryMatch = candidate?.category === existing?.category ? 1 : 0;
  return shared * 4 + priorityMatch + categoryMatch;
}

function parseAuditMetadata(row) {
  return decodeJson(row?.metadata, null) || {};
}

function scenarioRestoreData(snapshot, projectId) {
  return {
    projectId,
    generationId: snapshot.generationId || null,
    name: snapshot.name,
    module: snapshot.module,
    priority: snapshot.priority,
    category: snapshot.category,
    rationale: snapshot.rationale,
    dependencyOn: snapshot.dependencyOn || null,
    source: snapshot.source || 'agent',
    impacted: !!snapshot.impacted,
    impactReason: snapshot.impactReason || null,
  };
}

function testCaseRestoreData(snapshot, projectId, scenarioId) {
  return {
    projectId,
    scenarioId,
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

// Versioning — resolve which scenario generation a read should be scoped to:
// an explicit ?generationId (validated to belong to this project), else the
// project's CURRENT generation. Returns null only for a project that has
// never generated scenarios. Used by every page that reads scenarios so the
// selected generation re-skins Test Cases / Overview / Reports consistently.
// Short human label for a generation, derived from the generate config so the
// version dropdown reads "Deep · focus: checkout" instead of just "v3".
function buildGenerationLabel(sessionGuidance) {
  if (!sessionGuidance || typeof sessionGuidance !== 'string') return null;
  // Current format: "[GENERATION MODE — Smoke]: …" (em/en/hyphen tolerated).
  // Legacy fallback: "[DEPTH DIRECTIVE]: Generate a smoke …" (pre-modes guidance).
  const mode = sessionGuidance.match(/\[GENERATION MODE\s*[—–-]\s*([^\]]+)\]/i)
    || sessionGuidance.match(/\[DEPTH DIRECTIVE\]:\s*Generate a (\w+)/i);
  const focus = sessionGuidance.match(/\[FOCUS AREA\]:\s*Prioritize these flows above all others:\s*([^\n]+)/i);
  const parts = [];
  if (mode) {
    const m = mode[1].trim();
    parts.push(m.charAt(0).toUpperCase() + m.slice(1));
  }
  if (focus) {
    const f = focus[1].trim().slice(0, 40);
    // Avoid "Focus · focus: …" — for Focus mode the focus text IS the scope.
    parts.push(parts[0]?.toLowerCase() === 'focus' ? f : `focus: ${f}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

async function resolveGenerationId(projectId, req) {
  const q = req.query?.generationId;
  if (typeof q === 'string' && q) {
    const g = await prisma.scenarioGeneration.findFirst({
      where: { id: q, projectId }, select: { id: true },
    });
    if (g) return g.id;
  }
  const current = await prisma.scenarioGeneration.findFirst({
    where: { projectId, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  return current?.id || null;
}

// ── GET /api/projects/:projectId/scenario-generations ─────
// Lists every scenario generation for the project (newest first) so the UI
// can render a version selector (mirrors the Reports run-history dropdown).
router.get('/generations', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const generations = await prisma.scenarioGeneration.findMany({
      where: { projectId: project.id },
      orderBy: { version: 'desc' },
      select: {
        id: true, version: true, label: true, isCurrent: true,
        scenarioCount: true, caseCount: true, createdAt: true,
        _count: { select: { scenarios: true, cases: true } },
      },
    });
    res.json({
      success: true,
      generations: generations.map(({ _count, ...generation }) => ({
        ...generation,
        scenarioCount: _count.scenarios,
        caseCount: _count.cases,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/scenarios ────────────────
router.get('/', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    // Versioning — scope to the active generation (explicit ?generationId or
    // current). A project that has generated scenarios always has a generation
    // (backfilled); a brand-new project resolves null and returns [].
    const generationId = await resolveGenerationId(project.id, req);
    const scenarios = await prisma.testScenario.findMany({
      where: generationId
        ? { projectId: project.id, generationId }
        : { projectId: project.id, generationId: null },
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
    // Stable hierarchical numbering (S2 · C5) — same source of truth the
    // Reports/Blocked pages use, so a case shows the same label everywhere.
    const { scenarioNumberById, scenarioLabelById, caseNumberById, caseLabelById } = buildCaseNumbering(scenarios);
    const scenarioRestoreIds = new Set();
    const caseRestoreIds = new Set();
    if (scenarios.length || allCaseIds.length) {
      const restoreLogs = await prisma.auditLog.findMany({
        where: {
          OR: [
            { action: 'agents.architect.regenerate-one', target: project.id },
            ...(allCaseIds.length ? [{ action: 'testCases.refine', target: { in: allCaseIds } }] : []),
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      const currentScenarioIds = new Set(scenarios.map((s) => s.id));
      const currentCaseIds = new Set(allCaseIds);
      for (const row of restoreLogs) {
        const meta = parseAuditMetadata(row);
        if (row.action === 'agents.architect.regenerate-one' && meta.rollbackSnapshot) {
          const replacementIds = Array.isArray(meta.replacementScenarioIds) ? meta.replacementScenarioIds : [];
          for (const id of replacementIds) {
            if (currentScenarioIds.has(id)) scenarioRestoreIds.add(id);
          }
        }
        if (row.action === 'testCases.refine' && meta.rollbackSnapshot?.id && currentCaseIds.has(meta.rollbackSnapshot.id)) {
          caseRestoreIds.add(meta.rollbackSnapshot.id);
        }
      }
    }
    const inflated = scenarios.map(inflateScenario).map((s) => ({
      ...s,
      scenarioNumber: scenarioNumberById.get(s.id) ?? null,
      scenarioLabel: scenarioLabelById.get(s.id) ?? null,
      canRestorePrevious: scenarioRestoreIds.has(s.id),
      cases: s.cases.map((c) => ({
        ...c,
        latestResult: latestByTc.get(c.id) || null,
        caseNumber: caseNumberById.get(c.id) ?? null,
        caseLabel: caseLabelById.get(c.id) ?? null,
        canRestorePrevious: caseRestoreIds.has(c.id),
      })),
    }));
    res.json({ success: true, scenarios: inflated, generationId });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/projects/:projectId/scenarios/preview-matrix ──────
// Read-only pre-RUN projection: for the active generation, resolve each
// data-bound case's rows + per-row evidence contract (the SAME resolveCaseRows
// the live run uses) so the UI can show row -> intentClass -> requiredEvidence
// -> contractDelta BEFORE a browser step runs. No side-effects, no LLM, no run
// mutation — purely reshapes already-persisted scenarios/cases + the project's
// test data. Honest by construction: it can't diverge from the run because both
// go through resolveCaseRows.
router.get('/preview-matrix', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const generationId = await resolveGenerationId(project.id, req);
    const scenarios = await prisma.testScenario.findMany({
      where: generationId
        ? { projectId: project.id, generationId }
        : { projectId: project.id, generationId: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      include: { cases: true },
    });

    let testData = null;
    try {
      const bundle = await require('../services/testDataGenerationContract').loadGenerationTestDataContract({
        projectId: project.id,
        preferApproved: true,
      });
      testData = bundle && bundle.testData ? bundle.testData : null;
    } catch (_) {
      testData = null; // no test data -> every case previews as a single non-data-bound run
    }

    const scenariosById = {};
    const cases = [];
    for (const s of scenarios) {
      scenariosById[s.id] = { id: s.id, name: s.name, module: s.module };
      for (const c of (s.cases || [])) cases.push({ ...c, scenarioId: s.id });
    }

    const { buildPreviewMatrix } = require('../services/previewMatrix');
    const matrix = buildPreviewMatrix({ cases, scenariosById, testData });
    res.json({ success: true, generationId, ...matrix });
  } catch (err) {
    next(err);
  }
});

// Scenario reliability job controls for the generation pipeline.
function jobVisibleToProject(job, projectId) {
  return !!job && (!job.projectId || job.projectId === projectId);
}

async function persistReliabilityJobIfPossible(job) {
  if (!job || !job.generationId) return null;
  return reliabilityJobs.persistScenarioGenerationJobToGeneration(prisma, job, { generationId: job.generationId });
}

router.get('/reliability-jobs', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const jobs = reliabilityJobs.listScenarioGenerationJobs({ projectId: project.id })
      .map(reliabilityJobs.serializeScenarioGenerationJob);
    res.json({ success: true, jobs });
  } catch (err) {
    next(err);
  }
});

router.get('/reliability-jobs/:jobId', async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const job = reliabilityJobs.getScenarioGenerationJob(req.params.jobId);
    if (!jobVisibleToProject(job, project.id)) return res.status(404).json({ success: false, code: 'JOB_NOT_FOUND' });
    res.json({ success: true, job: reliabilityJobs.serializeScenarioGenerationJob(job) });
  } catch (err) {
    next(err);
  }
});

router.post('/reliability-jobs/:jobId/cancel', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const job = reliabilityJobs.getScenarioGenerationJob(req.params.jobId);
    if (!jobVisibleToProject(job, project.id)) return res.status(404).json({ success: false, code: 'JOB_NOT_FOUND' });
    const reason = req.body?.reason || 'user_cancelled';
    reliabilityJobs.requestScenarioGenerationJobCancel(job, reason);
    // The reliability job flag is durable observation state; the active
    // AbortController is the execution authority. Signal both so a crawler or
    // provider call stops before it can navigate/persist more work.
    const activeRunCancelled = cancelRegistry.cancel(req.user.id, reason);
    await persistReliabilityJobIfPossible(job);
    res.json({
      success: true,
      activeRunCancelled,
      job: reliabilityJobs.serializeScenarioGenerationJob(job),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reliability-jobs/:jobId/retry', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const job = reliabilityJobs.getScenarioGenerationJob(req.params.jobId);
    if (!jobVisibleToProject(job, project.id)) return res.status(404).json({ success: false, code: 'JOB_NOT_FOUND' });
    const retry = reliabilityJobs.retryScenarioGenerationJob(job, {
      projectId: project.id,
      generationId: req.body?.generationId || job.generationId || null,
      idempotencyKey: req.body?.idempotencyKey,
      resumeFromStage: req.body?.resumeFromStage,
      metadata: { requestedBy: req.user.id },
    });
    await persistReliabilityJobIfPossible(retry);
    res.json({ success: true, job: reliabilityJobs.serializeScenarioGenerationJob(retry) });
  } catch (err) {
    next(err);
  }
});

router.post('/reliability-jobs/:jobId/resume', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const job = reliabilityJobs.getScenarioGenerationJob(req.params.jobId);
    if (!jobVisibleToProject(job, project.id)) return res.status(404).json({ success: false, code: 'JOB_NOT_FOUND' });
    const resumed = await reliabilityJobs.resumeScenarioGenerationJob(
      job,
      req.body?.resumeFromStage || job.resumeFromStage || reliabilityJobs.JOB_STATUS.VALIDATING,
    );
    await persistReliabilityJobIfPossible(job);
    const recovery = resumed && resumed.metadata && resumed.metadata.recovery || {};
    if (recovery.resumeAccepted !== true) {
      return res.status(409).json({
        success: false,
        code: recovery.code || 'SCENARIO_GENERATION_RESUME_UNAVAILABLE',
        message: 'This scenario generation job has no executable recovery authority. Retry the generation instead.',
        job: reliabilityJobs.serializeScenarioGenerationJob(job),
      });
    }
    return res.json({ success: true, job: reliabilityJobs.serializeScenarioGenerationJob(job) });
  } catch (err) {
    next(err);
  }
});

// Development-safe interpretation probe. It uses the configured model to show
// how the pasted source is understood, but it cannot register a draft, compile,
// persist, approve, or invoke Conductor.
router.post(
  '/interpret-preview',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND', persisted: false });

      const sourceText = typeof req.body?.design === 'string'
        ? req.body.design
        : (typeof req.body?.sessionGuidance === 'string' ? req.body.sessionGuidance : '');
      if (!sourceText.trim()) {
        return res.status(400).json({
          success: false,
          code: 'ADD_SCENARIO_INTERPRETATION_SOURCE_REQUIRED',
          message: 'Paste a non-empty test design before requesting an interpretation preview.',
          persisted: false,
        });
      }

      const authoredFlow = ingestAuthoredFlow(sourceText);
      const deterministicPreview = {
        status: 'ready',
        blocking: false,
        sourcePreserved: authoredFlow.source.exactSourcePreserved,
        summary: authoredFlow.summary,
        story: {
          actors: authoredFlow.understanding.actors,
          goals: authoredFlow.understanding.goals,
          benefits: authoredFlow.understanding.benefits,
        },
        preconditions: authoredFlow.understanding.preconditions,
        logicalSteps: authoredFlow.understanding.logicalSteps,
        assertions: authoredFlow.understanding.assertions,
        testData: authoredFlow.understanding.testData,
        diagnostics: authoredFlow.diagnostics,
      };
      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.json({
          success: true,
          mode: 'deterministic_interpretation_preview',
          providerEnrichmentAvailable: false,
          providerMessage: `${provider} enrichment is unavailable; QAAI preserved and interpreted the flow deterministically.`,
          authoredFlow,
          interpretation: deterministicPreview,
          persisted: false,
        });
      }

      const predecessorCaseId = typeof req.body?.continuationParentCaseId === 'string'
        ? req.body.continuationParentCaseId.trim()
        : '';
      let predecessorCase = null;
      if (predecessorCaseId) {
        predecessorCase = await prisma.testCase.findFirst({
          where: { id: predecessorCaseId, projectId: project.id },
          select: { id: true, name: true, steps: true, generationId: true },
        });
        if (!predecessorCase) {
          return res.status(400).json({
            success: false,
            code: 'ADD_SCENARIO_INTERPRETATION_PARENT_NOT_FOUND',
            message: 'The selected continuation case does not belong to this project.',
            persisted: false,
          });
        }
      }

      let result;
      try {
        result = await interpretAddScenario({
          sourceText,
          provider,
          apiKey,
          model,
          continuationContext: {
            requested: Boolean(predecessorCaseId),
            predecessorCaseId: predecessorCase?.id || null,
            currentGenerationId: typeof req.body?.generationId === 'string' ? req.body.generationId.trim() : null,
            predecessorCase: predecessorCase ? {
              name: predecessorCase.name,
              steps: typeof predecessorCase.steps === 'string'
                ? predecessorCase.steps
                : JSON.stringify(predecessorCase.steps || []),
            } : null,
          },
        });
      } catch (enrichmentError) {
        return res.json({
          success: true,
          mode: 'deterministic_interpretation_preview',
          providerEnrichmentAvailable: false,
          providerMessage: 'Optional AI enrichment was unavailable. QAAI preserved the source and kept the deterministic interpretation.',
          authoredFlow,
          interpretation: deterministicPreview,
          deterministicInterpretation: deterministicPreview,
          enrichmentDiagnostic: {
            severity: 'info',
            blocking: false,
            code: enrichmentError?.code || 'OPTIONAL_ENRICHMENT_UNAVAILABLE',
            message: String(enrichmentError?.message || 'Optional enrichment was unavailable.').slice(0, 500),
          },
          persisted: false,
          conductorInvoked: false,
        });
      }
      return res.json({
        success: true,
        mode: 'interpretation_preview_only',
        authoredFlow,
        deterministicInterpretation: deterministicPreview,
        ...result,
      });
    } catch (err) {
      if (err && err.code && String(err.code).startsWith('ADD_SCENARIO_INTERPRETATION_')) {
        return res.status(Number(err.status) || 502).json({
          success: false,
          code: err.code,
          message: err.message,
          persisted: false,
          approvalEligible: false,
          conductorInvoked: false,
        });
      }
      return next(err);
    }
  },
);

router.post(
  '/interpret-preview/refine',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND', persisted: false });
      const sourceText = cleanAddScenarioRefinementValue(req.body?.design, 120_000);
      const guidance = cleanAddScenarioRefinementValue(req.body?.guidance, 20_000);
      const currentInterpretation = req.body?.interpretation;
      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        return res.status(400).json({ success: false, code: 'AI_PROVIDER_NOT_CONFIGURED', message: `${provider} API key is not configured or valid.`, persisted: false });
      }
      const result = await refineAddScenarioInterpretation({
        sourceText,
        guidance,
        currentInterpretation,
        provider,
        apiKey,
        model,
      });
      return res.json({ success: true, mode: 'interpretation_refinement_only', ...result });
    } catch (err) {
      if (err && err.code && String(err.code).startsWith('ADD_SCENARIO_INTERPRETATION_')) {
        return res.status(Number(err.status) || 502).json({
          success: false,
          code: err.code,
          message: err.message,
          findings: err.findings || [],
          persisted: false,
          conductorInvoked: false,
        });
      }
      return next(err);
    }
  },
);

router.post(
  '/interpret-preview/draft',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    try {
      const project = await getProject(req);
      if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND', persisted: false });
      const sourceText = cleanAddScenarioRefinementValue(req.body?.design, 120_000);
      const requestedGenerationId = cleanAddScenarioRefinementValue(req.body?.generationId, 500);
      const predecessorCaseId = cleanAddScenarioRefinementValue(req.body?.continuationParentCaseId, 500);
      const currentGeneration = await prisma.scenarioGeneration.findFirst({
        where: { projectId: project.id, isCurrent: true },
        orderBy: { version: 'desc' },
        select: { id: true },
      });
      if (!currentGeneration) {
        return res.status(409).json({
          success: false,
          code: 'ADD_SCENARIO_CURRENT_GENERATION_REQUIRED',
          message: 'A current generation is required before a reviewed scenario can be added.',
          persisted: false,
        });
      }
      if (predecessorCaseId) {
        const predecessor = await prisma.testCase.findFirst({
          where: { id: predecessorCaseId, projectId: project.id, generationId: currentGeneration.id },
          select: { id: true },
        });
        if (!predecessor) return res.status(400).json({
          success: false,
          code: 'ADD_SCENARIO_INTERPRETATION_PARENT_NOT_FOUND',
          message: 'The selected continuation case is not part of the current project generation.',
          persisted: false,
        });
      }
      const semanticPlan = createSemanticPlanFromInterpretation({
        sourceText,
        interpretation: req.body?.interpretation,
        predecessorCaseId: predecessorCaseId || null,
      });
      const preview = buildAddScenarioPreview({
        projectId: project.id,
        currentGenerationId: currentGeneration.id,
        sourceText,
        semanticPlan,
      });
      const registration = addScenarioDraftRegistry.put({
        userId: req.user.id,
        projectId: project.id,
        previewId: preview.previewId,
        revision: preview.revision,
        sourceDigest: preview.source && preview.source.digest,
        originalSource: sourceText,
        semanticPlan,
        preview,
        currentGenerationId: currentGeneration.id,
        allowSameOwnerRefresh: true,
      });
      if (!registration.ok) return res.status(Number(registration.status) || 500).json({
        success: false,
        code: registration.code,
        message: 'The reviewed interpretation could not be registered safely.',
        persisted: false,
      });
      return res.json({
        success: true,
        persisted: false,
        conductorInvoked: false,
        preview: decorateAddScenarioDraftPreview(
          registration.draft.preview,
          registration.draft,
          currentGeneration.id,
        ),
        diagnostics: requestedGenerationId && requestedGenerationId !== currentGeneration.id
          ? [{ code: 'ADD_SCENARIO_GENERATION_REBOUND', requestedGenerationId, currentGenerationId: currentGeneration.id }]
          : [],
      });
    } catch (err) {
      if (err && err.code && String(err.code).startsWith('ADD_SCENARIO_INTERPRETATION_')) {
        return res.status(Number(err.status) || 422).json({
          success: false,
          code: err.code,
          message: err.message,
          findings: err.findings || [],
          persisted: false,
          conductorInvoked: false,
        });
      }
      return next(err);
    }
  },
);

router.post(
  '/generate',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 10 }),
    async (req, res, next) => {
      const TAG = `[scenarios.generate user=${req.user.id} proj=${req.params.projectId}]`;
      let cancelToken = null;
      let scenarioGenerationJob = null;
      const failScenarioJob = (reason) => {
        if (!scenarioGenerationJob || reliabilityJobs.TERMINAL_STATUSES.has(scenarioGenerationJob.status)) return;
        reliabilityJobs.failScenarioGenerationJob(scenarioGenerationJob, reason);
      };
      console.log(`${TAG} request received`);
      try {
        const project = await getProject(req);
        if (!project) {
          console.log(`${TAG} project not found`);
        return res.status(404).json({ success: false, code: 'NOT_FOUND' });
      }

      const requestBody = req.body || {};
      const { requirementIds, replace = true, sessionGuidance, forceAtlasRefresh = false, guidanceId } = requestBody;
      const appendRequest = buildAppendScenarioRequest(project, requestBody);
      const sprintId = requestBody.sprintId ? String(requestBody.sprintId) : null;
      // "+ Add scenario" — APPEND a targeted, user-designed scenario to the CURRENT
      // generation instead of creating a new one (which would push the existing
      // cases into history). Reuses this whole pipeline (grounding, typed verify,
      // data binding); only the persistence TARGET and the directive change.
      const appendToCurrent = appendRequest.appendToCurrent;
      const refinementGuidance = cleanAddScenarioRefinementValue(requestBody.refinementGuidance);
      const refinementDraftId = cleanAddScenarioRefinementValue(requestBody.draftId || requestBody.previewId, 500);
      const refinementRevision = cleanAddScenarioRefinementValue(requestBody.draftRevision || requestBody.previewRevision, 500);
      const refinementDigest = cleanAddScenarioRefinementValue(requestBody.previewDigest || requestBody.sourceDigest, 500);
      const refinementRequested = Boolean(
        refinementGuidance
        || refinementDraftId
        || refinementRevision
        || refinementDigest
      );
      if (refinementRequested) {
        const draftAliases = [requestBody.draftId, requestBody.previewId]
          .map((value) => cleanAddScenarioRefinementValue(value, 500))
          .filter(Boolean);
        const revisionAliases = [requestBody.draftRevision, requestBody.previewRevision]
          .map((value) => cleanAddScenarioRefinementValue(value, 500))
          .filter(Boolean);
        if (!appendToCurrent
          || requestBody.previewOnly !== true
          || requestBody.persist !== false
          || !refinementGuidance
          || !refinementDraftId
          || !refinementRevision
          || new Set(draftAliases).size > 1
          || new Set(revisionAliases).size > 1) {
          return res.status(400).json({
            success: false,
            code: 'ADD_SCENARIO_REFINEMENT_REQUEST_INVALID',
            message: 'Refinement requires one current draft identity, one revision, non-empty guidance, previewOnly=true, and persist=false.',
            persisted: false,
          });
        }
      }
      const wantJourney = req.body?.journey === true;
      const continuationParentCaseId = typeof req.body?.continuationParentCaseId === 'string'
        ? req.body.continuationParentCaseId.trim()
        : '';
      const continuationRequestedByText = appendToCurrent && guidanceRequestsContinuation(sessionGuidance);
      let appendContinuationCurrentGeneration = null;
      let appendContinuationParentCase = null;
      if (appendToCurrent && (continuationParentCaseId || continuationRequestedByText)) {
        appendContinuationCurrentGeneration = await prisma.scenarioGeneration.findFirst({
          where: { projectId: project.id, isCurrent: true },
          orderBy: { version: 'desc' },
        });
        if (!appendContinuationCurrentGeneration && continuationParentCaseId) {
          return res.status(400).json({
            success: false,
            code: 'NO_CURRENT_GENERATION_FOR_CONTINUATION',
            message: 'Add scenario continuation requires a current generation with the parent case.',
          });
        }
        if (appendContinuationCurrentGeneration && continuationParentCaseId) {
          appendContinuationParentCase = await prisma.testCase.findFirst({
            where: { id: continuationParentCaseId, projectId: project.id },
            include: {
              scenario: {
                select: { id: true, name: true, generationId: true, projectId: true },
              },
            },
          });
        } else if (appendContinuationCurrentGeneration && continuationRequestedByText) {
          const currentCases = await prisma.testCase.findMany({
            where: { projectId: project.id, generationId: appendContinuationCurrentGeneration.id },
            include: {
              scenario: {
                select: { id: true, name: true, generationId: true, projectId: true },
              },
            },
          });
          if (currentCases.length === 1) {
            [appendContinuationParentCase] = currentCases;
          }
        }
        if (continuationParentCaseId && (!appendContinuationParentCase || appendContinuationParentCase.scenario?.generationId !== appendContinuationCurrentGeneration.id)) {
          return res.status(400).json({
            success: false,
            code: 'CONTINUATION_PARENT_NOT_CURRENT',
            message: 'The selected parent case must belong to the current generation before Add scenario can continue from it.',
          });
        }
      }
      scenarioGenerationJob = reliabilityJobs.createScenarioGenerationJob({
        projectId: project.id,
        idempotencyKey: req.body?.idempotencyKey || `scenario-generation:${project.id}:${Date.now()}`,
        metadata: {
          route: 'scenarios.generate',
          userId: req.user.id,
          appendToCurrent,
          continuationParentCaseId: appendContinuationParentCase?.id || null,
        },
      });
      reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {
        status: reliabilityJobs.JOB_STATUS.GROUNDING_APP,
        stage: reliabilityJobs.JOB_STATUS.GROUNDING_APP,
        progress: 3,
        reason: 'generation_request_started',
      });
      let effectiveGuidance = sessionGuidance;
      let appendDesignText = null;
      if (appendToCurrent) {
        const rawDesignText = appendRequest.sessionGuidance;
        if (!rawDesignText) {
          failScenarioJob('Add Scenario requires pasted test design text.');
          return res.status(400).json({
            success: false,
            code: 'ADD_SCENARIO_DESIGN_REQUIRED',
            message: 'Paste the target-app test design before adding a scenario.',
          });
        }
        const designText = await normalizeRequirementDocument(rawDesignText, {
          project,
          userId: req.user.id,
        });
        appendDesignText = designText;
        if (appendRequest.requirement) {
          appendRequest.requirement.content = designText;
          appendRequest.requirement.body = designText;
          appendRequest.requirement.text = designText;
        }
        if (appendRequest.requirementClause) {
          appendRequest.requirementClause.behaviourText = designText;
          appendRequest.requirementClause.text = designText;
          appendRequest.requirementClause.description = designText;
        }
        effectiveGuidance = [
          '[ADD TARGETED SCENARIO]: The user is ADDING specific coverage to an EXISTING suite. Author ONLY the scenario(s) described below — do NOT regenerate or duplicate existing coverage, and output a SHORT scenarios array (ideally one).',
          '[SEMANTIC ADD SCENARIO AUTHORING CONTRACT]: Treat the pasted text as a human-authored test design, even when it is noisy, repetitive, or only partly structured. Infer its intended browser flow before authoring candidate steps.',
          'Only concrete, affirmative browser interactions and observable product assertions become executable steps. Headings, inline-data dictionaries, session/initial/final-state declarations, generation instructions, notes, failure/continuation policy, and explanatory prose are authoring metadata; preserve their meaning in the case contract but NEVER turn them into browser actions.',
          'A prohibition or negative constraint such as "do not click", "do not navigate", or "leave the form open" restricts execution; it must never be inverted into the prohibited Click/Navigate action.',
          '[ADD SCENARIO LITERAL CONTRACT]: Never emit {{...}} placeholders in Add Scenario steps, assertions, values, or expected outcomes. Materialize user-authored non-sensitive inline values as exact literals in the applicable step and assertion. Represent password/token-like inputs with their compiler-owned credential or env: reference until the trusted execution projection resolves them. Short values must match whole authored values only and must never be substituted inside ordinary words.',
          'Preserve the user-authored action order, conditional behavior, assertions, and continuation intent. Do not invent actions from metadata and do not silently omit an authored executable action or validation.',
          wantJourney
            ? 'AUTHOR IT AS ONE COMPREHENSIVE END-TO-END JOURNEY CASE: many ordered steps in a SINGLE case (navigate, open forms, operate dropdowns/autocompletes, fill fields, save, verify, log out, re-login as needed). Do NOT decompose it into separate atomic cases. Use producesData/requiresData to chain data the flow creates and later consumes (e.g. a user it creates then logs in as).'
            : '',
          'Ground EVERY step against the verified Site Atlas and the uploaded test data — use real captured elements and real values, never invented ones.',
          appendContinuationParentCase
            ? [
              '[DEPENDENT CONTINUATION CONTRACT]: This Add Scenario output continues after an existing approved case in the same generation.',
              `Parent case id: ${appendContinuationParentCase.id}`,
              `Parent case name: ${appendContinuationParentCase.name}`,
              'Do NOT re-login or start from a fresh browser. Begin from the browser/application state left after the parent case completes.',
              'Persist the generated case(s) as sessionMode=continue_from_dependency, dependsOnIds including the parent case id, and failurePolicy=block_dependents.',
            ].join('\n')
            : '',
          '',
          'USER\'S REQUESTED TEST DESIGN:',
          designText || '(no design text provided)',
        ].filter((x) => x !== null && x !== undefined).join('\n');
      }
      const where = { projectId: project.id };
      if (sprintId) where.sprintId = sprintId;
      if (Array.isArray(requirementIds) && requirementIds.length) {
        where.id = { in: requirementIds };
      }
      const requirements = await prisma.requirement.findMany({ where });
      console.log(`${TAG} loaded ${requirements.length} requirement(s)`);
      const appendDesignRequirement = appendRequest.requirement;
      const appendDesignClause = appendRequest.requirementClause;
      const architectRequirements = appendDesignRequirement ? [appendDesignRequirement] : requirements;
      const selectedSourceDocumentIds = Array.isArray(requirementIds) && requirementIds.length
        ? Array.from(new Set(requirements
          .filter((requirement) => String(requirement.sourceType || '').toLowerCase() === 'upload')
          .map((requirement) => requirement.sourceIdentifier)
          .filter(Boolean))).sort()
        : null;
      if (!requirements.length && !appendDesignRequirement) {
        failScenarioJob('No requirements available. Upload documents or pull from ADO/Jira first.');
        return res.status(400).json({
          success: false,
          code: 'NO_REQUIREMENTS',
          message: 'No requirements available. Upload documents or pull from ADO/Jira first.',
        });
      }

      const { provider, apiKey, model, integration } = await resolveAiCredentials(req.user.id, project);
      if (!apiKey || integration?.status !== 'valid') {
        console.log(`${TAG} ${provider} not configured. status=${integration?.status} hasKey=${!!apiKey}`);
        failScenarioJob(`${provider} API key not configured.`);
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

      send('agent.phase.start', { phase: 'architect', label: 'Scenario Architect', projectId: project.id });
      const onLog = async (level, message) =>
        send('agent.phase.log', { phase: 'architect', level, message });
      const onRateLimit = (info) => send('claude.rate-limit', info);
      if (appendDesignRequirement) {
        await onLog('info', 'Add Scenario source grounding: using the pasted scenario text as the primary requirement for this append run; existing cases remain dependency/context only.');
      }
      if (continuationRequestedByText && !appendContinuationParentCase) {
        await onLog('warn', 'Add scenario text appears to describe a dependent continuation, but no single parent case could be inferred. Select "Continue from an existing case/session" to persist dependsOnIds/sessionMode.');
      }
      // Streaming progress — fed by architect.js's stream.on('text') handler.
      // Drives the Test Cases page's live circle "N of ~12 scenarios" without
      // the operator having to stare at an opaque spinner. Throttled inside
      // architect.js (only fires when the scenario count moves or every 4 KB
      // of new text), so this can broadcast straight through.
      const onProgress = (info) => send('architect.progress', { ...info, projectId: project.id });
      // Register the cancel token at the START of generation, not only before
      // the LLM call. Run Suite forces an atlas refresh first, and users click
      // Terminate while the calibrator is still crawling; without this token the
      // cancel endpoint had nothing to cancel until minutes later.
      cancelToken = cancelRegistry.create(req.user.id);
      reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {
        status: reliabilityJobs.JOB_STATUS.GENERATING,
        stage: reliabilityJobs.JOB_STATUS.GENERATING,
        progress: 12,
        reason: 'architect_generation_started',
      });
      const finishCancelled = () => {
        cancelRegistry.clear(req.user.id);
        send('agent.phase.complete', {
          phase: 'architect',
          error: 'cancelled',
          cancelled: true,
          projectId: project.id,
        });
        return res.status(499).json({
          success: false,
          code: 'CANCELLED',
          message: 'Generation cancelled by user.',
        });
      };
      const isGenerationCancelled = () => !!(cancelToken && (cancelToken.cancelled || cancelToken.signal?.aborted));

      // Project-wide AI guidance, if set. Also load calibration context if available.
      const projectRow = await prisma.project.findUnique({
        where: { id: project.id },
        select: { aiGuidance: true },
      });
      const savedGuidance = await generationGuidance.loadGuidance(prisma, { projectId: project.id, guidanceId });
      const guidanceBlock = generationGuidance.guidancePromptBlock(savedGuidance, { scope: 'suite' });

      // Module scope. When the request names a `module` (+ optional authProfileId),
      // the Architect is scoped to that module's ranked clauses + its (module,
      // authProfile) atlas slice. ABSENT → whole-project generation: the broad
      // clause set + newest atlas. NOTE (Step 2): the verified capability menu +
      // typed operations[] are now fed for BOTH module-scoped AND whole-project
      // generation (whenever the atlas has capabilities) — see the `capabilities`
      // argument to architect.run below.
      const moduleScope = (typeof req.body?.module === 'string' && req.body.module.trim()) ? req.body.module.trim() : null;
      // Focus mode names a functionality (free text) rather than a module key. It
      // must scope the CLAUSE set + RTM denominator (so the budget and coverage are
      // measured against the focused subset, not the whole BRD) WITHOUT engaging the
      // module-atlas/operations/auth slice machinery — that's keyed off `moduleScope`
      // only. `clauseScope` is the unified "which clauses are in scope" signal:
      // an explicit module wins; otherwise the focus area narrows it.
      const focusArea = (typeof req.body?.focusArea === 'string' && req.body.focusArea.trim()) ? req.body.focusArea.trim() : null;
      // Generation auto-crawl is bounded by default. A caller must explicitly
      // request crawlScope:"site" before global navigation becomes discoverable.
      const requestedCrawlScope = crawlPlanner.resolveCrawlScope(req.body?.crawlScope);
      const clauseScope = moduleScope || focusArea;
      const sliceAuthProfileId = (typeof req.body?.authProfileId === 'string' && req.body.authProfileId.trim()) ? req.body.authProfileId.trim() : null;
      const sliceOpts = moduleScope ? { module: moduleScope, authProfileId: sliceAuthProfileId } : {};
      // P4b — resolve the slice's AuthProfile → its NAME so generated cases record
      // the IDENTITY they run as (and ground only against that identity's atlas
      // slice). Inert: no authProfileId, no match, or pre-regen client → null →
      // generation behaviour byte-unchanged.
      let genAuthProfileName = null;
      if (sliceAuthProfileId) {
        try {
          const ap = await prisma.authProfile.findFirst({ where: { id: sliceAuthProfileId, projectId: project.id }, select: { name: true } });
          genAuthProfileName = ap ? ap.name : null;
        } catch (_) { genAuthProfileName = null; }
      }

      // ── Phase 0: Auto-crawl ──────────────────────────────────────────────────
      // If the project has a targetUrl and no recent calibration (< 24 h), run
      // the site crawler now so the Architect gets fresh atlas data.
      // Broadcasts progress on the same 'architect' phase stream so the
      // Test Cases ArchitectBanner shows it inline without extra UI work.
      // Never throws — a crawl failure is non-fatal; generation continues.
      const AUTO_CRAWL_STALE_MS = Number(process.env.QAAI_AUTO_CRAWL_STALE_MS || 7 * 24 * 60 * 60 * 1000); // default: 7 days
      try {
        const projectFull = await prisma.project.findUnique({
          where: { id: project.id },
          select: { targetUrl: true, testCredentials: true, defaultAuthFixtureId: true },
        });
        if (projectFull?.targetUrl) {
          // Crawl depth scales with the generation mode (smoke→shallow … complete→deep).
          // Prefer the STRUCTURED generationMode field; fall back to parsing the
          // prose label out of sessionGuidance only when the client didn't send it
          // (robust to label-copy changes).
          const bodyMode = (typeof req.body?.generationMode === 'string' && req.body.generationMode.trim())
            ? req.body.generationMode.trim().toLowerCase().split(/\s+/)[0]
            : null;
          const genModeMatch = (sessionGuidance || '').match(/\[GENERATION MODE\s*[—–-]\s*([^\]]+)\]/i)
            || (sessionGuidance || '').match(/\[DEPTH DIRECTIVE\]:\s*Generate a (\w+)/i);
          const generationMode = bodyMode || (genModeMatch ? genModeMatch[1].trim().toLowerCase().split(/\s+/)[0] : null);
          const crawlMode = crawlPlanner.crawlModeForGenerationMode(generationMode);

          // Reuse a recent atlas for THIS slice (module + authProfile) unless a
          // concrete reason justifies a recrawl (explicit rebuild, target/auth
          // change, deeper mode, staleness). The rich select is guarded so a
          // pre-regen client (no crawlMode column yet) still resolves.
          let latestCal = null;
          try {
            latestCal = await prisma.calibration.findFirst({
              where: { projectId: project.id, status: 'complete', module: moduleScope || null, authProfileId: sliceAuthProfileId || null },
              orderBy: { createdAt: 'desc' },
              select: { id: true, createdAt: true, completedAt: true, startUrl: true, authProfileId: true, crawlMode: true, coverageReportJson: true, sufficiency: true },
            });
          } catch (_) {
            try {
              latestCal = await prisma.calibration.findFirst({
                where: { projectId: project.id, status: 'complete', module: moduleScope || null, authProfileId: sliceAuthProfileId || null },
                orderBy: { createdAt: 'desc' },
                select: { id: true, createdAt: true, completedAt: true, startUrl: true, authProfileId: true },
              });
            } catch (_2) { latestCal = null; }
          }

          // LEGACY-ATLAS detection — an atlas produced BEFORE the crawl planner has no
          // crawlMode, no coverage report, no sufficiency verdict, and its pages carry
          // no stateKey (UI-state dedup) / tab-substate support. Such an atlas must NOT
          // be silently reused as if it were a planned crawl: crawlMode=null is "the
          // planner never ran", not "standard depth". Probe one page for stateKey so a
          // pre-planner atlas forces exactly ONE rebuild. Guarded (pre-migration client
          // lacks the columns → treated as legacy, which is correct).
          let legacyAtlas = false;
          if (latestCal) {
            let hasStateKey = false;
            try {
              const kp = await prisma.calibrationPage.findFirst({
                where: { calibrationId: latestCal.id, NOT: { stateKey: null } },
                select: { id: true },
              });
              hasStateKey = !!kp;
            } catch (_) { hasStateKey = false; }
            legacyAtlas = !latestCal.crawlMode || !latestCal.coverageReportJson || !latestCal.sufficiency || !hasStateKey;
            if (legacyAtlas) {
              await onLog('info', 'Existing site atlas predates the crawl planner (no crawlMode/coverage report/sufficiency/state-keys) — forcing one rebuild with the planned crawler.');
            }
          }

          const plannedRefreshDecision = crawlPlanner.decideAtlasRefresh({
            explicitRefresh: forceAtlasRefresh === true || String(forceAtlasRefresh).toLowerCase() === 'true',
            latestAtlas: latestCal ? {
              startUrl: latestCal.startUrl,
              authProfileId: latestCal.authProfileId,
              crawlMode: latestCal.crawlMode,
              sufficiency: latestCal.sufficiency,
              completedAt: latestCal.completedAt,
              createdAt: latestCal.createdAt,
            } : null,
            legacyAtlas,
            targetUrl: projectFull.targetUrl,
            authProfileId: sliceAuthProfileId || null,
            crawlMode,
            now: Date.now(),
            staleMs: AUTO_CRAWL_STALE_MS,
          });
          // Add Scenario is incremental authoring, not an implicit request to
          // remap the application. A fresh atlas for the same target + identity
          // remains valid grounding even when it predates newer crawl-depth
          // metadata or is shallower/partial. Explicit rebuild, staleness,
          // target/auth mismatch, known insufficiency, or no atlas still use the
          // normal refresh decision.
          const explicitAtlasRefresh = forceAtlasRefresh === true || String(forceAtlasRefresh).toLowerCase() === 'true';
          const atlasTimestamp = latestCal && (latestCal.completedAt || latestCal.createdAt);
          const atlasAgeMs = atlasTimestamp ? Date.now() - new Date(atlasTimestamp).getTime() : Infinity;
          const atlasTargetMatches = !!latestCal && (
            !projectFull.targetUrl
            || !latestCal.startUrl
            || crawlPlanner.normalizeUrlPath(latestCal.startUrl) === crawlPlanner.normalizeUrlPath(projectFull.targetUrl)
          );
          const atlasIdentityMatches = !!latestCal
            && (latestCal.authProfileId || null) === (sliceAuthProfileId || null);
          const atlasSufficiency = String(latestCal && latestCal.sufficiency || '').trim().toLowerCase();
          const reuseFreshAppendAtlas = appendToCurrent
            && !explicitAtlasRefresh
            && !!latestCal
            && atlasTargetMatches
            && atlasIdentityMatches
            && atlasSufficiency !== 'insufficient'
            && atlasAgeMs <= AUTO_CRAWL_STALE_MS;
          // Entry-page crawling has a finite content-linked boundary. A fresh,
          // sufficient atlas for the same target and identity already mapped
          // that boundary, so requesting a deeper generation mode alone must
          // not trigger an autonomous whole-site-style recrawl.
          const reuseFreshEntryPageAtlas = requestedCrawlScope === crawlPlanner.CRAWL_SCOPE_ENTRY_PAGE
            && !explicitAtlasRefresh
            && !!latestCal
            && !legacyAtlas
            && atlasTargetMatches
            && atlasIdentityMatches
            && atlasSufficiency === 'sufficient'
            && atlasAgeMs <= AUTO_CRAWL_STALE_MS;
          const reuseFreshCompatibleAtlas = reuseFreshAppendAtlas || reuseFreshEntryPageAtlas;
          const refreshDecision = reuseFreshCompatibleAtlas
            ? {
              refresh: false,
              reason: null,
              message: reuseFreshAppendAtlas
                ? 'Using the existing fresh compatible site atlas for incremental Add Scenario authoring'
                : 'Using the existing fresh sufficient entry-page atlas',
            }
            : plannedRefreshDecision;
          if (refreshDecision.refresh) {
            await onLog('info', `Refreshing site atlas because: ${refreshDecision.reason} (${crawlMode} crawl).`);
            // Detect whether the project has any login credentials. The calibrator
            // will attempt form-login automatically when credentials are present; without
            // them it can only map public (pre-login) pages. Surface this upfront so
            // the user knows to add credentials before the crawl wastes a browser session.
            let hasCreds = !!(projectFull.defaultAuthFixtureId);
            if (!hasCreds) {
              try {
                const tc = JSON.parse(projectFull.testCredentials || '[]');
                hasCreds = Array.isArray(tc) && tc.some((c) => c && (c.email || c.name) && c.password);
              } catch { hasCreds = false; }
            }
            if (!hasCreds) {
              send('agent.phase.log', { phase: 'architect', level: 'warn', message: `No login credentials configured for this project. If ${projectFull.targetUrl} requires authentication, the crawler will only map the login page. Add credentials in Project Settings → Credentials and re-generate to map the authenticated app.`, projectId: project.id });
            }

            await onLog('info', `Site crawl starting — ${projectFull.targetUrl}`);
            send('agent.phase.log', { phase: 'architect', level: 'info', message: `Crawling ${projectFull.targetUrl} for UI context…`, projectId: project.id });
            try {
              const { runCalibrator } = require('../services/agents/calibrator');
              // Create a calibration record so runCalibrator can persist pages
              let crawlCal = null;
              try {
                crawlCal = await prisma.calibration.create({
                  // Thread the resolved authProfileId so the crawl persists the (module, authProfile)
                  // slice the Architect later reads — a role-scoped generation must not ground against
                  // a null/foreign-role slice.
                  data: { projectId: project.id, startUrl: projectFull.targetUrl, status: 'running', module: moduleScope || null, authProfileId: sliceAuthProfileId || null },
                  select: { id: true },
                });
              } catch (_) {
                crawlCal = await prisma.calibration.create({
                  data: { projectId: project.id, startUrl: projectFull.targetUrl, status: 'running' },
                  select: { id: true },
                });
              }
              const crawlResult = await runCalibrator({
                projectId: project.id,
                userId: req.user.id,
                calibrationId: crawlCal.id,
                startUrl: projectFull.targetUrl,
                crawlMode,
                generationMode,
                module: moduleScope || null,
                moduleHint: moduleScope || null,
                focusModule: focusArea || moduleScope || null,
                crawlScope: requestedCrawlScope,
                authProfileId: sliceAuthProfileId || null,
                signal: cancelToken.signal,
                send: (e) => {
                  // Re-emit calibrator logs as architect phase logs so the banner catches them
                  if (e.type === 'agent.phase.log') {
                    broadcast && broadcast(req.user.id, { ...e, phase: 'architect', projectId: project.id });
                  }
                },
              });
              // Honest sufficiency verdict — never a silent "atlas ready". Surfaces
              // sufficient | partial | insufficient with concrete reasons so the
              // operator knows how far to trust the atlas. Generation CONTINUES
              // regardless (resilience over hard-blocking), but a partial/insufficient
              // crawl is loudly flagged rather than passed off as complete coverage.
              const suff = crawlResult && crawlResult.sufficiency;
              const cov = crawlResult && crawlResult.coverage;
              if (suff && suff.level === 'insufficient') {
                send('agent.phase.log', { phase: 'architect', level: 'warn', message: `Site atlas INSUFFICIENT — ${(suff.reasons || []).join('; ') || 'too little of the app was mapped'}.${!hasCreds ? ' Add login credentials in Project Settings → Credentials and re-generate.' : ''} Continuing, but behind-login scenarios are grounded from docs only (no live HOW/label verification).`, projectId: project.id });
              } else if (suff && suff.level === 'partial') {
                const detail = [...(suff.reasons || []), ...(suff.warnings || [])].join('; ');
                send('agent.phase.log', { phase: 'architect', level: 'warn', message: `Site atlas PARTIAL${suff.block ? ` and ${crawlMode} mode expects full coverage` : ''} — ${detail || 'some discovered modules were not mapped'}. Continuing with partial coverage${suff.block ? ' (narrow the scope or rebuild the atlas for complete coverage)' : ''}.`, projectId: project.id });
              } else {
                await onLog('info', `Site atlas sufficient — ${cov ? cov.pagesVisited : '?'} page(s), ${cov ? `${cov.modulesVisited}/${cov.modulesDiscovered}` : '?'} module(s)${cov && cov.tabsVisited ? `, ${cov.tabsVisited} tab substate(s)` : ''} mapped for ${crawlMode} generation.`);
              }
            } catch (crawlErr) {
              if (isGenerationCancelled() || /cancel/i.test(crawlErr.message || '')) {
                return finishCancelled();
              }
              await onLog('warn', `Site crawl failed (non-fatal): ${crawlErr.message}. Continuing with existing atlas.`);
            }
          } else {
            await onLog('info', `${refreshDecision.message} — skipping recrawl for this ${crawlMode} generation (no rebuild reason: target, identity, depth, and freshness all match).`);
          }
        }
      } catch (autoCrawlErr) {
        if (isGenerationCancelled() || /cancel/i.test(autoCrawlErr.message || '')) {
          return finishCancelled();
        }
        console.warn(`${TAG} auto-crawl phase error (non-fatal):`, autoCrawlErr.message);
      }
      if (isGenerationCancelled()) return finishCancelled();

      // E4 — attach calibration context (site atlas) if one exists for this project.
      // calibrationContext = prose for the LLM; calibrationAtlas = structured
      // per-page text for the deterministic grounding gate run after authoring.
      // P3d: slice-scoped when a module was named (its own (module,authProfile) atlas).
      // Note: loaded AFTER the auto-crawl above so we always get the freshest atlas.
      let calibrationContext = null;
      let calibrationAtlas = null;
      try {
        const { getCalibrationContext, getCalibrationAtlas } = require('../services/agents/calibrator');
        calibrationContext = await getCalibrationContext(project.id, sliceOpts);
        calibrationAtlas = await getCalibrationAtlas(project.id, sliceOpts);
      } catch (_) { /* calibrator not yet run — no atlas */ }

      // Enterprise Mode P2-integration — the Requirement Oracle. Extract verified
      // requirement clauses from the project's BRD/US/RN documents (honoring the
      // DLP egress gate), persist them, and decide the Architect context mode.
      // Hybrid (default once clauses exist) sends the model the data-minimized
      // clause index instead of full source bodies. Never throws — degrades to
      // the legacy path. Module vocabulary from prior generations aids retrieval.
      let clausePrep = { requirementClauses: [], contextMode: 'additive', knownModules: [], stats: { clauseCount: 0 } };
      try {
        const priorModules = await prisma.testScenario.findMany({
          where: { projectId: project.id }, select: { module: true }, distinct: ['module'], take: 50,
        });
        const knownModules = Array.from(new Set(priorModules.map((s) => s.module).filter(Boolean)));
        clausePrep = await require('../services/requirementOracle').prepareArchitectClauses({
          prisma, projectId: project.id, providerName: provider, apiKey, model, knownModules,
          sprintId,
          ...(selectedSourceDocumentIds ? { sourceDocumentIds: selectedSourceDocumentIds } : {}),
          send: (e) => broadcast && broadcast(req.user.id, e), log: console,
        });
        if (clausePrep.stats.clauseCount) {
          await onLog('info', `Requirement Oracle: ${clausePrep.stats.clauseCount} verified clause(s) from ${clausePrep.stats.docCount} doc(s) → ${clausePrep.contextMode.toUpperCase()} context.`);
        }
      } catch (e) { console.warn(`${TAG} requirement oracle prep failed (non-fatal):`, e.message); }
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
            await onLog('info', `Firecrawl live crawl skipped: ${live.reason}. Generation continues with uploaded requirements and existing app context.`);
          }
          if (Array.isArray(live.errors) && live.errors.length) {
            await onLog('warn', `Firecrawl live crawl had ${live.errors.length} non-blocking issue(s); generation continues.`);
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
            canonicalGenerationPipeline.recordPipelineSnapshot(reliabilityJobs, scenarioGenerationJob, {
              stage: canonicalGenerationPipeline.SNAPSHOT_STAGE.SOURCE_ARTIFACTS_COLLECTED,
              scenarios: [],
              metadata: {
                artifactCount: firecrawlSourceArtifacts.length,
                clauseCount: firecrawlClauses.length,
                source: 'firecrawl',
                confidence: 'discovered',
                verifiedByPlaywright: false,
              },
            });
            await onLog('info', `Firecrawl source grounding: ${firecrawlSourceArtifacts.length} artifact(s), ${firecrawlClauses.length} discovered clause(s) appended below uploaded requirements.`);
          }
        } catch (sourceErr) {
          console.warn(`${TAG} Firecrawl source intake failed (non-fatal):`, sourceErr.message);
        }
      }
      if (isGenerationCancelled()) return finishCancelled();

      // P3d — module-scope the clause set (the max_tokens fix). Whole-project
      // generation handed the Architect the project's full clause set (131 on
      // large apps -> truncation and uncovered requirements). Module-scoped: rank to the module
      // and cap tight so one pass fully covers ONE module. Absent module → unchanged.
      if (appendDesignClause) {
        clausePrep = {
          ...clausePrep,
          requirementClauses: [appendDesignClause],
          contextMode: 'additive',
          knownModules: [],
          stats: {
            ...((clausePrep && clausePrep.stats) || {}),
            clauseCount: 1,
            docCount: 1,
            appendDesignClauseCount: 1,
          },
        };
      }
      let scopedClauses = clausePrep.requirementClauses;
      let scopedKnownModules = clausePrep.knownModules;
      // Scope the clause set by EITHER an explicit module OR a Focus-mode focus
      // area (clauseScope). Without focus-scoping, a Focus run kept the WHOLE
      // project clause set — which (a) inflated the architect's budget (floor/
      // ceiling = ceil(C/8 .. C/5) over ALL clauses), (b) made the new coverage-
      // driven top-up loop chase OUT-OF-FOCUS clauses, fighting the focus
      // directive, and (c) measured the RTM against the whole BRD (huge false
      // "uncovered"). knownModules stays the explicit module when present;
      // for a free-text focus area we pass the detected modules so ranking still
      // respects module boundaries while scoring by similarity to the focus text.
      if (clauseScope && Array.isArray(clausePrep.requirementClauses) && clausePrep.requirementClauses.length) {
        try {
          const ranked = require('../services/requirementContext').rankClauses(
            clausePrep.requirementClauses, clauseScope,
            { maxClauses: 40, knownModules: moduleScope ? [moduleScope] : clausePrep.knownModules });
          scopedClauses = ranked.kept;
          if (moduleScope) scopedKnownModules = [moduleScope];
          await onLog('info', `${moduleScope ? `Module-scoped "${moduleScope}"` : `Focus-scoped "${String(clauseScope).slice(0, 60)}"`}: ${scopedClauses.length}/${clausePrep.requirementClauses.length} clause(s) in scope`
            + `${calibrationAtlas && Array.isArray(calibrationAtlas.capabilities) ? `, ${calibrationAtlas.capabilities.length} verified capabilities` : ''}`
            + `${calibrationAtlas && calibrationAtlas.degraded ? ` (atlas degraded: ${calibrationAtlas.degraded})` : ''}.`);
        } catch (e) { console.warn(`${TAG} clause-scoping failed (non-fatal):`, e.message); }
      }
      let planningRequirements = architectRequirements;
      if (!appendDesignRequirement && clauseScope && Array.isArray(scopedClauses) && scopedClauses.length) {
        const scopedRequirementRefs = new Set(scopedClauses.flatMap((clause) => [
          clause && clause.requirementId,
          clause && clause.storyId,
          clause && clause.sourceIdentifier,
          clause && clause.sourceDocId,
        ]).filter(Boolean).map(String));
        planningRequirements = architectRequirements.filter((requirement) => [
          requirement && requirement.id,
          requirement && requirement.sourceIdentifier,
          requirement && requirement.storyId,
          requirement && requirement.documentId,
        ].filter(Boolean).some((ref) => scopedRequirementRefs.has(String(ref))));
      }

      let appendCurrentGeneration = null;
      let appendExistingScenarios = [];
      let appendExistingCoverageRefs = [];
      if (appendToCurrent) {
        appendCurrentGeneration = appendContinuationCurrentGeneration || await prisma.scenarioGeneration.findFirst({
          where: { projectId: project.id, isCurrent: true },
          orderBy: { version: 'desc' },
        });
        if (appendCurrentGeneration && appendCurrentGeneration.id) {
          appendExistingScenarios = await prisma.testScenario.findMany({
            where: { projectId: project.id, generationId: appendCurrentGeneration.id },
            include: { cases: true },
          });
          appendExistingCoverageRefs = Array.from(new Set(appendExistingScenarios.flatMap(scenarioCoverageRefs)));
          await onLog('info', `Append mode: ${appendExistingCoverageRefs.length} existing coverage ref(s) count as already accepted; only the requested slice will be enforced.`);
        }
      }

      let result;
      let generationTestDataBundle = null;
      let coveragePlan = null;
      let coverageResult = null;
      let requirementUnderstandingV1 = null;
      let storyDataAlignmentPlanV1 = null;
      let testDesignPlanV1 = null;
      let plannedCaseContractPacks = [];
      let proceduralFlowContract = extractProceduralFlowContract(planningRequirements);
      let addScenarioSemanticPlanMetadata = null;
      // Degradation sink — honest signals (untokenizable clause #24, per-row
      // under-coverage #22, partial-generation persist #31) surface here so they
      // reach the operator log (onLog) AND persist with the generation's coverage
      // evidence for the UI/RTM. Never blocks generation.
      const coverageDegradations = [];
      try {
        const requirementUnderstanding = require('../services/requirementUnderstandingV1');
        requirementUnderstandingV1 = requirementUnderstanding.buildRequirementUnderstandingV1({
          projectId: project.id,
          sprintId,
          requirements: planningRequirements,
          requirementClauses: scopedClauses,
        });
        const requirementValidation = requirementUnderstanding.validateRequirementUnderstandingV1(requirementUnderstandingV1);
        if (!requirementValidation.ok) {
          const err = new Error('The selected requirements could not be compiled into a valid immutable understanding contract.');
          err.code = 'REQUIREMENT_UNDERSTANDING_INVALID';
          err.status = 422;
          err.findings = requirementValidation.errors;
          throw err;
        }
        if (requirementUnderstandingV1.status === 'degraded') {
          const err = new Error('The selected requirement sources do not contain a usable, scoped behavior contract.');
          err.code = 'REQUIREMENT_UNDERSTANDING_DEGRADED';
          err.status = 422;
          err.findings = requirementUnderstandingV1.issues || [];
          throw err;
        }
        if (requirementUnderstandingV1.status === 'needs_review') {
          await onLog('warn', `Requirement understanding needs review: ${requirementUnderstandingV1.issues.length} issue(s) are preserved in the immutable contract; only its scoped sources may drive planning.`);
        }
        const authoritativeRequirementIds = new Set(requirementUnderstandingV1.sourceSnapshot.requirementIds.map(String));
        const authoritativeClauseIds = new Set(requirementUnderstandingV1.clauseIds.map(String));
        const authoritativeRequirements = planningRequirements.filter((requirement) => authoritativeRequirementIds.has(String(requirement.id)));
        const authoritativeClauses = scopedClauses.filter((clause) => authoritativeClauseIds.has(String(clause.id)));
        const authoritativePlanningInputs = authoritativeClauses.length ? authoritativeClauses : authoritativeRequirements;
        // TestData M-C — mapped test data (null when none → Architect unchanged).
        // BUGFIX: was projectRow?.id — projectRow is selected with only { aiGuidance }
        // (no id), so this was ALWAYS undefined → loader returned null → the architect
        // never received the uploaded test data → 0 data binding on every generation.
        // Use project.id (the resolved project, which has the id).
        generationTestDataBundle = await require('../services/testDataGenerationContract').loadGenerationTestDataContract({
          projectId: project.id,
          sprintId,
          moduleScope,
          preferApproved: true,
          requireApproved: true,
          testDataSetIds: Array.isArray(req.body?.testDataSetIds) ? req.body.testDataSetIds : null,
          mappingPins: req.body?.testDataMappingPins && typeof req.body.testDataMappingPins === 'object'
            ? req.body.testDataMappingPins
            : null,
        });
        if (generationTestDataBundle.status === 'needs_approval' || generationTestDataBundle.status === 'blocked') {
          const err = new Error('Selected test data is not ready for deterministic planning. Approve every mapping and resolve its exact sheet references first.');
          err.code = 'TEST_DATA_APPROVAL_REQUIRED';
          err.status = 422;
          err.findings = generationTestDataBundle.blockers || [];
          throw err;
        }
        const testData = generationTestDataBundle.testData;
        const alignmentLib = require('../services/storyDataAlignmentPlanV1');
        storyDataAlignmentPlanV1 = alignmentLib.buildStoryDataAlignmentPlanV1({
          requirementRevision: requirementUnderstandingV1.contractId,
          clauses: authoritativeClauses,
          requirements: authoritativePlanningInputs,
          datasetCatalog: testData && testData.datasetCatalog,
        });
        const alignmentValidation = alignmentLib.validateStoryDataAlignmentPlanV1(storyDataAlignmentPlanV1);
        const blockingAlignments = (storyDataAlignmentPlanV1.alignments || [])
          .filter((alignment) => ['ambiguous', 'conflict'].includes(alignment.status));
        if (!alignmentValidation.ok || blockingAlignments.length || (storyDataAlignmentPlanV1.conflicts || []).length) {
          const err = new Error('Requirement-to-test-data alignment is ambiguous or conflicting; no sheet was selected by position or tie-break guess.');
          err.code = 'STORY_DATA_ALIGNMENT_REVIEW_REQUIRED';
          err.status = 422;
          err.findings = [
            ...(alignmentValidation.errors || []),
            ...blockingAlignments.map((alignment) => ({
              code: 'blocking_alignment',
              alignmentId: alignment.alignmentId,
              storyId: alignment.storyId,
              status: alignment.status,
              candidates: alignment.candidates,
            })),
            ...(storyDataAlignmentPlanV1.conflicts || []),
          ];
          throw err;
        }
        if (appendToCurrent && typeof appendDesignText === 'string' && appendDesignText.trim()) {
          if (refinementRequested) {
            const draftLookup = addScenarioDraftRegistry.get({
              userId: req.user.id,
              projectId: project.id,
              draftId: refinementDraftId,
            });
            if (!draftLookup.ok) {
              return res.status(draftLookup.status).json({
                success: false,
                code: draftLookup.code,
                message: draftLookup.message,
                persisted: false,
              });
            }
            const draft = draftLookup.draft;
            const currentGenerationId = appendCurrentGeneration && appendCurrentGeneration.id || null;
            if (draft.revision !== refinementRevision) {
              return res.status(409).json({
                success: false,
                code: 'ADD_SCENARIO_DRAFT_REVISION_STALE',
                message: 'The draft revision is stale. Review the current preview before refining it.',
                persisted: false,
                currentRevision: draft.revision,
              });
            }
            if (refinementDigest && draft.sourceDigest !== refinementDigest) {
              return res.status(409).json({
                success: false,
                code: 'ADD_SCENARIO_DRAFT_SOURCE_CONFLICT',
                message: 'The refinement source digest does not match the current draft.',
                persisted: false,
              });
            }
            if ((draft.currentGenerationId || null) !== currentGenerationId) {
              return res.status(409).json({
                success: false,
                code: 'ADD_SCENARIO_DRAFT_GENERATION_STALE',
                message: 'The project generation changed. Reopen Add Scenario before refining this draft.',
                persisted: false,
                generationId: currentGenerationId,
              });
            }

            let refinementIntent;
            try {
              refinementIntent = await planAddScenarioRefinementIntent({
                refinementGuidance,
                sourceDigest: draft.sourceDigest,
                revision: draft.revision,
                operationCatalog: buildAddScenarioRefinementCatalog(draft.preview),
                semanticPlanSummary: {
                  previewId: draft.previewId,
                  status: draft.preview && draft.preview.status,
                  scenarios: draft.preview && draft.preview.scenarios,
                },
                provider,
                apiKey,
                model,
                signal: cancelToken.signal,
                onRateLimit,
                onLog,
              });
            } catch (err) {
              if (err && err.code === 'CANCELLED' || isGenerationCancelled()) throw err;
              return res.status(Number(err && err.status) || 422).json({
                success: false,
                code: err && err.code || 'ADD_SCENARIO_REFINEMENT_FAILED',
                message: err && err.message || 'The requested refinement could not be interpreted safely.',
                persisted: false,
                preview: decorateAddScenarioDraftPreview(draft.preview, draft, currentGenerationId),
              });
            }
            if (!refinementIntent
              || refinementIntent.status !== 'ready'
              || !refinementIntent.refinementIntentV1) {
              return res.status(422).json({
                success: false,
                code: 'ADD_SCENARIO_REFINEMENT_NEEDS_REVIEW',
                message: 'The requested change did not uniquely identify a safe preview operation.',
                findings: refinementIntent && refinementIntent.findings || [],
                persisted: false,
                preview: decorateAddScenarioDraftPreview(draft.preview, draft, currentGenerationId),
              });
            }

            const refined = refineAddScenarioPreview({
              projectId: project.id,
              preview: draft.preview,
              semanticPlan: draft.semanticPlan,
              baseRevision: draft.revision,
              sourceDigest: draft.sourceDigest,
              guidance: refinementIntent.refinementIntentV1,
              refinementSourceText: refinementGuidance,
            });
            if (!refined.applied) {
              return res.status(422).json({
                success: false,
                code: 'ADD_SCENARIO_REFINEMENT_NEEDS_REVIEW',
                message: 'The current preview was preserved because the requested change was not uniquely safe.',
                findings: refined.clarifications || [],
                persisted: false,
                preview: decorateAddScenarioDraftPreview(draft.preview, draft, currentGenerationId),
              });
            }

            const draftUpdate = addScenarioDraftRegistry.update({
              userId: req.user.id,
              projectId: project.id,
              draftId: draft.draftId,
              expectedRevision: draft.revision,
              preview: refined.preview,
              semanticPlan: refined.semanticPlan,
              revision: refined.revision,
              sourceDigest: draft.sourceDigest,
            });
            if (!draftUpdate.ok) {
              return res.status(draftUpdate.status).json({
                success: false,
                code: draftUpdate.code,
                message: draftUpdate.message,
                persisted: false,
              });
            }
            const responsePreview = decorateAddScenarioDraftPreview(
              refined.preview,
              draftUpdate.draft,
              currentGenerationId,
            );
            const previewJobStatus = responsePreview.approvalEligible
              ? reliabilityJobs.JOB_STATUS.READY_WITH_USER_DECISIONS
              : reliabilityJobs.JOB_STATUS.AWAITING_USER_DECISION;
            reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
              stage: 'add_scenario_preview_refined',
              scenarios: [],
              metadata: {
                draftId: draftUpdate.draft.draftId,
                previewId: responsePreview.previewId,
                previewRevision: responsePreview.revision,
                previousRevision: draft.revision,
                appliedOperations: refined.appliedOperations,
                currentGenerationId,
                persistenceStatus: responsePreview.persistence.status,
              },
              reason: 'preview_refinement_applied',
            });
            reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {
              status: previewJobStatus,
              stage: previewJobStatus,
              progress: 100,
              reason: 'preview_refinement_applied',
            });
            cancelRegistry.clear(req.user.id);
            send('agent.phase.complete', {
              phase: 'architect_refinement',
              projectId: project.id,
              preview: responsePreview,
              output: {
                draftId: draftUpdate.draft.draftId,
                previewId: responsePreview.previewId,
                previewRevision: responsePreview.revision,
                appliedOperations: refined.appliedOperations,
                persisted: false,
              },
            });
            return res.json({
              success: true,
              mode: 'add_scenario_preview_refined',
              persisted: false,
              generationId: currentGenerationId,
              draftId: draftUpdate.draft.draftId,
              preview: responsePreview,
              appliedOperations: refined.appliedOperations,
              scenarioGenerationJob: reliabilityJobs.serializeScenarioGenerationJob(scenarioGenerationJob),
            });
          }
          const continuationRequested = continuationRequestedByText || Boolean(continuationParentCaseId);
          const resolvedContinuationParentCaseId = appendContinuationParentCase?.id || continuationParentCaseId || null;
          const existingScenarioContext = appendCurrentGeneration
            ? createAddScenarioExistingContext({
              project,
              generation: appendCurrentGeneration,
              scenarios: appendExistingScenarios,
              continuation: {
                requested: continuationRequested,
                mode: continuationRequested ? 'continue_from_dependency' : 'fresh',
                predecessorCaseId: resolvedContinuationParentCaseId,
                sameSession: continuationRequested,
              },
            })
            : null;
          const currentCases = existingScenarioContext
            ? existingScenarioContext.cases.map((caseRecord) => ({
              id: caseRecord.id,
              scenarioId: caseRecord.scenarioId,
              name: caseRecord.name || null,
              dependencyOn: caseRecord.dependsOnIds,
              initialState: caseRecord.initialState,
              expectedFinalState: caseRecord.expectedFinalState,
              sessionRequirement: caseRecord.sessionIntent,
            }))
            : [];
          let semanticPlan = null;
          let semanticPlanError = null;
          try {
            semanticPlan = await addScenarioSemanticPlanner.planAddScenario({
              sourceText: appendDesignText,
              provider,
              apiKey,
              model,
              continuationContext: {
                requested: continuationRequested,
                predecessorCaseId: resolvedContinuationParentCaseId,
                currentGenerationId: appendCurrentGeneration && appendCurrentGeneration.id || null,
              },
              currentCases,
              existingScenarioContext,
              approvedDataMetadata: {
                datasetCatalog: testData && testData.datasetCatalog || null,
                alignmentPlan: storyDataAlignmentPlanV1,
              },
              capabilities: calibrationAtlas && Array.isArray(calibrationAtlas.capabilities)
                ? calibrationAtlas.capabilities
                : [],
              guidance: effectiveGuidance || null,
              signal: cancelToken.signal,
              onRateLimit,
              onLog,
            }, {
              validator: (draft, context) => {
                const validation = caseContractSemanticValidator.validateSemanticCaseContract(draft, {
                  sourceText: context && context.sourceText || appendDesignText,
                  maxSteps: 100,
                });
                return {
                  ok: validation.ok,
                  envelope: validation.contract,
                  findings: validation.findings,
                };
              },
            });
          } catch (err) {
            if (err && err.code === 'CANCELLED' || isGenerationCancelled()) throw err;
            semanticPlanError = err;
          }

          const sourceCompleteness = semanticPlan && semanticPlan.sourceCompleteness;
          if (!semanticPlanError && (!sourceCompleteness || sourceCompleteness.complete !== true)) {
            semanticPlanError = new Error('Add Scenario source completeness needs review before approval.');
            semanticPlanError.code = 'ADD_SCENARIO_SOURCE_INCOMPLETE';
            semanticPlanError.findings = Array.isArray(sourceCompleteness && sourceCompleteness.findings)
              ? sourceCompleteness.findings
              : [];
            semanticPlanError.sourceCompleteness = sourceCompleteness || null;
          }
          const semanticEnvelope = semanticPlan && (semanticPlan.caseContractV1 || semanticPlan.envelope);
          const semanticCaseCount = Array.isArray(semanticEnvelope && semanticEnvelope.cases)
            ? semanticEnvelope.cases.length
            : 0;
          if (!semanticPlanError && !semanticCaseCount) {
            semanticPlanError = new Error('Add Scenario semantic planning needs clarification before it can produce an executable case.');
            semanticPlanError.code = 'ADD_SCENARIO_SEMANTIC_CASE_REQUIRED';
            semanticPlanError.findings = semanticEnvelope && semanticEnvelope.clarifications || [];
          }

          const preview = buildAddScenarioPreview({
            projectId: project.id,
            currentGenerationId: appendCurrentGeneration && appendCurrentGeneration.id || null,
            sourceText: appendDesignText,
            semanticPlan,
            error: semanticPlanError,
          });
          const currentGenerationId = appendCurrentGeneration && appendCurrentGeneration.id || null;
          let registeredDraft = null;
          let responsePreview = preview;
          if (semanticPlan && typeof semanticPlan === 'object' && !Array.isArray(semanticPlan)) {
            const draftRegistration = addScenarioDraftRegistry.put({
              userId: req.user.id,
              projectId: project.id,
              previewId: preview.previewId,
              revision: preview.revision,
              sourceDigest: preview.source && preview.source.digest,
              originalSource: appendDesignText,
              semanticPlan,
              preview,
              currentGenerationId,
              allowSameOwnerRefresh: true,
            });
            if (!draftRegistration.ok) {
              return res.status(draftRegistration.status >= 500 ? draftRegistration.status : 500).json({
                success: false,
                code: draftRegistration.code,
                message: 'The non-persisted Add Scenario preview could not be registered safely.',
                persisted: false,
              });
            }
            registeredDraft = draftRegistration.draft;
            responsePreview = decorateAddScenarioDraftPreview(preview, registeredDraft, currentGenerationId);
          }
          const previewJobStatus = responsePreview.approvalEligible
            ? reliabilityJobs.JOB_STATUS.READY_WITH_USER_DECISIONS
            : reliabilityJobs.JOB_STATUS.AWAITING_USER_DECISION;
          reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
            stage: 'add_scenario_preview',
            scenarios: [],
            metadata: {
              draftId: registeredDraft && registeredDraft.draftId || null,
              previewId: responsePreview.previewId,
              previewRevision: responsePreview.revision,
              previewStatus: responsePreview.status,
              approvalEligible: responsePreview.approvalEligible,
              currentGenerationId,
              persistenceStatus: responsePreview.persistence.status,
            },
            reason: responsePreview.approvalEligible ? 'preview_ready_for_review' : 'preview_needs_review',
          });
          reliabilityJobs.updateScenarioGenerationJob(scenarioGenerationJob, {
            status: previewJobStatus,
            stage: previewJobStatus,
            progress: 100,
            reason: responsePreview.approvalEligible ? 'preview_ready_for_review' : 'preview_needs_review',
          });
          cancelRegistry.clear(req.user.id);
          send('agent.phase.complete', {
            phase: 'architect',
            projectId: project.id,
            preview: responsePreview,
            output: {
              draftId: registeredDraft && registeredDraft.draftId || null,
              previewId: responsePreview.previewId,
              previewRevision: responsePreview.revision,
              previewStatus: responsePreview.status,
              approvalEligible: responsePreview.approvalEligible,
              scenarios: responsePreview.scenarios.length,
              cases: responsePreview.scenarios.reduce((count, scenario) => count + scenario.cases.length, 0),
              persisted: false,
            },
          });
          return res.json({
            success: true,
            mode: 'add_scenario_preview',
            persisted: false,
            generationId: currentGenerationId,
            draftId: registeredDraft && registeredDraft.draftId || null,
            preview: responsePreview,
            scenarioGenerationJob: reliabilityJobs.serializeScenarioGenerationJob(scenarioGenerationJob),
          });
        }
        coveragePlan = coveragePlanner.buildCoveragePlanManifest({
          requirements: authoritativeRequirements,
          requirementClauses: authoritativeClauses,
          testData,
          storyDataAlignmentPlan: storyDataAlignmentPlanV1,
          calibrationAtlas,
          moduleScope,
          existingCoverageRefs: appendExistingCoverageRefs,
          onLog,
          collector: coverageDegradations,
        });
        if (appendToCurrent) {
          coveragePlan = sliceCoverageManifestForAppend(coveragePlan, {
            sessionGuidance: appendDesignText || effectiveGuidance || '',
            moduleScope,
            requirementIds,
          });
        }
        const { buildCaseContractPacks } = require('../services/reliability/selfHealingPipeline');
        plannedCaseContractPacks = buildCaseContractPacks({
          manifest: coveragePlan,
          testData,
          appCapabilityMap: null,
          targetPackCount: proceduralFlowContract.singleBehavioralPartition ? 1 : null,
        });
        if (
          proceduralFlowContract.isProcedural
          && proceduralFlowContract.caseContractV1
          && Array.isArray(proceduralFlowContract.caseContractV1.cases)
          && proceduralFlowContract.caseContractV1.cases.length
        ) {
          const { buildCaseContractPlanningBridge } = require('../services/caseContractPlanningBridge');
          const bridgedPlanning = buildCaseContractPlanningBridge({
            proceduralFlowContract,
            coverageManifest: coveragePlan,
            caseContractPacks: plannedCaseContractPacks,
          });
          coveragePlan = bridgedPlanning.coverageManifest;
          plannedCaseContractPacks = bridgedPlanning.caseContractPacks;
          await onLog(
            'info',
            `Authored CaseContractV1 planning: ${plannedCaseContractPacks.length} explicit case(s) are authoritative; prior inferred coverage is retained as advisory context.`,
          );
        }
        if (proceduralFlowContract.singleBehavioralPartition && plannedCaseContractPacks.length > 1) {
          plannedCaseContractPacks = plannedCaseContractPacks.slice(0, 1);
        }
        if (appendContinuationParentCase) {
          plannedCaseContractPacks = plannedCaseContractPacks.map((pack) => ({
            ...pack,
            sessionRequirement: {
              required: true,
              mode: 'continue_from_case',
              predecessorCaseId: appendContinuationParentCase.id,
            },
            dependencies: [appendContinuationParentCase.id],
            failurePolicy: { default: 'block_dependents' },
          }));
        }
        const designAlignments = alignmentLib.toTestDesignAlignments(storyDataAlignmentPlanV1, {
          testData,
          coverageManifest: coveragePlan,
        });
        const designPlanner = require('../services/testDesignPlanV1');
        testDesignPlanV1 = designPlanner.buildTestDesignPlanV1({
          coverageManifest: coveragePlan,
          caseContractPacks: plannedCaseContractPacks,
          requirements: authoritativeRequirements,
          requirementClauses: authoritativeClauses,
          dataset: {
            ...generationTestDataBundle,
            workbookHash: testData && testData.datasetCatalog && testData.datasetCatalog.catalogId,
          },
          alignments: designAlignments,
          scope: {
            projectId: project.id,
            module: moduleScope,
            focusArea,
            requirementIds: Array.isArray(requirementIds) ? requirementIds : [],
            testDataSetIds: testData && testData.selectedTestDataSetIds || [],
          },
        });
        const planCaseByCoverageRef = new Map(testDesignPlanV1.scenarios
          .flatMap((scenario) => scenario.cases || [])
          .map((casePlan) => [casePlan.coverageRef, casePlan]));
        plannedCaseContractPacks = plannedCaseContractPacks.map((pack) => {
          const casePlan = planCaseByCoverageRef.get(pack.coverageRef);
          return casePlan ? { ...pack, planCaseId: casePlan.planCaseId } : pack;
        });
        coveragePlan = {
          ...coveragePlan,
          requirementUnderstandingV1,
          datasetCatalogV1: testData && testData.datasetCatalog || null,
          storyDataAlignmentPlanV1,
          testDesignPlanV1,
        };
        await onLog('info', `Pre-step planning: ${requirementUnderstandingV1.stats.verifiedClauseCount} verified clause(s), ${storyDataAlignmentPlanV1.stats.selectedRowGroupCount} selected row group(s), ${testDesignPlanV1.scenarios.length} frozen case contract(s).`);
        // ADO/text lane (Phase A) — best-effort structured grounding from
        // story-like requirement text via the SHARED helper (same one agents.js
        // uses, so the two routes can't drift). null/error -> generation unchanged;
        // CANCELLED propagates to the outer catch so Terminate still works.
        let behaviorGrounding = null;
        const hasAuthoritativeCaseContracts = plannedCaseContractPacks.length > 0
          && plannedCaseContractPacks.every((pack) => pack && pack.caseContractV1);
        if (appendToCurrent && addScenarioSemanticPlanMetadata && !hasAuthoritativeCaseContracts) {
          const err = new Error('The validated Add Scenario semantic contract could not be projected into the immutable test design.');
          err.code = 'ADD_SCENARIO_SEMANTIC_PROJECTION_FAILED';
          err.status = 422;
          throw err;
        }
        if (hasAuthoritativeCaseContracts) {
          const deterministicScenarios = plannedCaseContractPacks.map((pack) => (
            architect.deterministicScenarioFromPack(pack, 'authoritative_case_contract_v1')
          ));
          result = {
            scenarios: deterministicScenarios,
            raw: JSON.stringify(deterministicScenarios),
            tokens: null,
            stopReason: 'authoritative_case_contract_v1',
            degradations: [],
          };
          await onLog('info', appendToCurrent && addScenarioSemanticPlanMetadata
            ? 'The model-authored Add Scenario contract passed semantic validation and was projected from the frozen plan without reparsing its prose, actions, targets, values, assertions, or dependencies.'
            : 'Explicit authored cases were compiled deterministically from the frozen plan; their actions, order, and data bindings remain immutable.');
        } else {
          try {
            behaviorGrounding = await require('../services/agents/storyBehaviorExtractor').buildBehaviorGroundingFromRequirements({
              requirements: authoritativeRequirements, apiKey, model, provider,
              signal: cancelToken.signal, onRateLimit, onLog,
              isCancelled: () => cancelToken.cancelled,
            });
          } catch (bmErr) {
            if (bmErr && bmErr.code === 'CANCELLED') throw bmErr;
            console.warn('[scenarios.generate] behavior-model grounding failed (non-fatal):', bmErr && bmErr.message);
            behaviorGrounding = null;
          }
        }
        if (!result && appendDesignRequirement) {
          try {
            const deterministicAppendScenario = architect.deterministicScenarioFromPack({
              coverageRef: appendDesignRequirement.id,
              storyId: appendDesignRequirement.id,
              title: appendDesignRequirement.title,
              source: 'add_scenario',
              sourceText: appendDesignText,
              requiredActions: ['verify'],
            }, 'authoritative_pasted_add_scenario_procedure');
            await onLog('info', 'Add Scenario procedural authoring: compiled the pasted step-by-step design directly instead of asking the model to reinterpret it.');
            result = {
              scenarios: [deterministicAppendScenario],
              raw: JSON.stringify([deterministicAppendScenario]),
              tokens: null,
              stopReason: 'deterministic_append_procedure',
              degradations: [],
            };
          } catch (deterministicErr) {
            await onLog('warn', `Add Scenario procedural authoring could not compile the pasted text directly (${deterministicErr.message}); falling back to Architect provider generation.`);
          }
        }
        if (!result) {
          result = await architect.run({
          apiKey,
          model,
          provider,
          requirements: authoritativeRequirements,
          onLog,
          onProgress,
          onRateLimit,
          signal: cancelToken.signal,
          behaviorGrounding,
          extraGuidance: [projectRow?.aiGuidance, effectiveGuidance, guidanceBlock].filter(Boolean).join('\n\n') || null,
          siteContext: calibrationContext,
          testData,
          requirementClauses: authoritativeClauses,
          contextMode: clausePrep.contextMode,
          knownModules: scopedKnownModules,
          // Step 2 — hand the Architect the verified capability menu so it emits a
          // bound operations[] plan per automatable case, for WHOLE-PROJECT runs too
          // (not only module-scoped). The atlas capability inventory is the union of
          // the per-module/page slices from the live crawl; the Architect binds each
          // case's operations to a capabilityRef and Node (markCaseOperations) drops
          // any that don't resolve to a verified capability. Empty only when there is
          // no atlas (no crawl) → no menu, no operations[] (unchanged).
          capabilities: calibrationAtlas ? (calibrationAtlas.capabilities || []) : [],
          module: moduleScope,
          coveragePlan,
          testDesignPlan: testDesignPlanV1,
          caseContractPacks: plannedCaseContractPacks,
          projectId: project.id,
          calibrationAtlas,
          });
        }
        // CaseContractV1 output already contains compiler-owned data references
        // such as {{email}}. The legacy Add Scenario guard treats every token as
        // an unresolved template and would replace the authoritative case with
        // its older text parser, losing planCaseIds and authored topology.
        if (appendDesignRequirement && Array.isArray(result.scenarios) && !hasAuthoritativeCaseContracts) {
          const appendDefects = architect.appendScenarioOutputDefects(result.scenarios);
          if (appendDefects.length) {
            let fallbackScenario = null;
            try {
              fallbackScenario = architect.deterministicScenarioFromPack({
                coverageRef: appendDesignRequirement.id,
                storyId: appendDesignRequirement.id,
                title: appendDesignRequirement.title,
                source: 'add_scenario',
                sourceText: appendDesignText,
                requiredActions: ['verify'],
              }, 'invalid_provider_append_output');
            } catch (fallbackErr) {
              const err = new Error(
                `Add Scenario provider output was rejected (${appendDefects.slice(0, 5).join('; ')}), and the pasted design could not be converted into a safe deterministic scenario: ${fallbackErr.message}`,
              );
              err.code = 'ADD_SCENARIO_OUTPUT_INVALID';
              err.status = 422;
              throw err;
            }
            await onLog(
              'warn',
              `Add Scenario provider output rejected (${appendDefects.slice(0, 5).join('; ')}); rebuilt from the pasted test design instead of persisting placeholder steps.`,
            );
            result.scenarios = [fallbackScenario];
          }
        }
        if (firecrawlSourceArtifacts.length && Array.isArray(result.scenarios)) {
          result.scenarios = sourceGrounding.attachSourceArtifactsToCases(result.scenarios, firecrawlSourceArtifacts);
        }
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        send('agent.phase.complete', {
          phase: 'architect',
          error: cancelled ? 'cancelled' : cleanAgentError(err.message),
          cancelled,
        });
        if (cancelled) {
          failScenarioJob('Generation cancelled by user.');
          return res.status(499).json({
            success: false, code: 'CANCELLED',
            message: 'Generation cancelled by user.',
          });
        }
        failScenarioJob(err.message || 'Scenario Architect failed.');
        return res.status(err.status || 502).json({
          success: false,
          code: err.code || 'AGENT_FAILED',
          message: err.message,
          findings: err.findings || undefined,
        });
      }
      cancelRegistry.clear(req.user.id);

      reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
        stage: 'architect_parsed',
        scenarios: result.scenarios || [],
        metadata: {
          provider,
          model,
          requirementCount: requirementUnderstandingV1?.sourceSnapshot?.requirementCount || 0,
        },
        reason: 'architect_parsed',
      });

      if (testDesignPlanV1) {
        const validation = coveragePlanner.validateCoveragePlan({
          manifest: coveragePlan,
          scenarios: result.scenarios || [],
          testData: generationTestDataBundle && generationTestDataBundle.testData,
          onLog,
          collector: coverageDegradations,
        });
        coverageResult = {
          scenarios: result.scenarios || [],
          validation,
          repair: { mode: 'immutable_test_design_plan', repaired: 0 },
          summary: { ...coveragePlanner.coverageSummary(validation, { repaired: 0 }), ok: validation.ok },
          appCapabilityMap: null,
        };
      } else {
        coverageResult = await finalizeCoverage({
          manifest: coveragePlan,
          scenarios: result.scenarios || [],
          testData: generationTestDataBundle && generationTestDataBundle.testData,
          onLog,
          collector: coverageDegradations,
          projectId: project.id,
          idempotencyKey: `scenario-reliability:${project.id}:${Date.now()}`,
          scenarioGenerationJob,
          calibrationAtlas,
          targetUrl: project.targetUrl,
          authRole: genAuthProfileName,
        });
        result.scenarios = coverageResult.scenarios;
      }
      reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
        stage: 'coverage_repaired',
        scenarios: result.scenarios || [],
        metadata: {
          coverageSummary: coverageResult && coverageResult.summary,
        },
        reason: 'coverage_repaired',
      });

      if (!appendToCurrent && proceduralFlowContract.singleBehavioralPartition) {
        await onLog('info', 'route floor-fill: skipped because the uploaded procedural flow declares one scenario and one test case.');
      }
      if (!testDesignPlanV1 && !appendToCurrent && !proceduralFlowContract.singleBehavioralPartition) {
        const targetFloor = scenarioFloorForClauses(scopedClauses);
        const floorFill = floorFillScenarioSuite({
          scenarios: result.scenarios || [],
          coveragePlan,
          requirementClauses: authoritativeClauses,
          testData: generationTestDataBundle && generationTestDataBundle.testData,
          appCapabilityMap: coverageResult && coverageResult.appCapabilityMap,
          targetFloor,
          scenarioFactory: (pack, reason) => architect.deterministicScenarioFromPack(pack, reason),
          reason: 'route_pre_compiler_floor_fill',
        });
        if (floorFill.added > 0) {
          result.scenarios = floorFill.scenarios;
          coverageResult.scenarios = floorFill.scenarios;
          coverageResult.validation = coveragePlanner.validateCoveragePlan({
            manifest: coveragePlan,
            scenarios: result.scenarios,
            testData: generationTestDataBundle && generationTestDataBundle.testData,
            onLog,
            collector: coverageDegradations,
          });
          coverageResult.summary = coveragePlanner.coverageSummary(
            coverageResult.validation,
            coverageResult.repair || {},
          );
          coverageResult.summary.ok = coverageResult.validation.ok;
          coverageResult.summary.missingRequired = Array.isArray(coverageResult.validation.missingRequired)
            ? coverageResult.validation.missingRequired.length
            : 0;
          await onLog('warn', `route floor-fill: added ${floorFill.added} deterministic scenario(s) before compiler (${floorFill.scenarios.length}/${targetFloor}).`);
          reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
            stage: 'route_floor_filled',
            scenarios: result.scenarios || [],
            metadata: {
              added: floorFill.added,
              targetFloor,
              source: floorFill.source,
            },
            reason: 'route_floor_filled',
          });
        } else if (targetFloor && (result.scenarios || []).length < targetFloor) {
          await onLog('warn', `route floor-fill: no deterministic scenario could be added (${(result.scenarios || []).length}/${targetFloor}).`);
        }
      }

      // ── GENERATION COMPILER — REPAIR-FIRST READY ASSEMBLY ───────────────────────
      // The Architect's output is a CANDIDATE POOL. The compiler repairs each
      // contract-backed case as deterministically as possible (static → clear binding;
      // product-gap → keep data binding when it consumes row data; uniform outcome →
      // fixed oracle ok; varying outcome → synthesize {{expected}}; companion creds →
      // ready; story/citation conflict → rebound from CoverageItem/storyId). The
      // persisted generation is the repaired ready suite. Only a source-less impossible
      // artifact (no story/coverage/data source for its unresolved tokens) is withheld
      // internally; the user should not see a "needs_review" case as a generated test.
      let generationReadiness = null;
      if (!testDesignPlanV1) try {
        const generationCompiler = require('../services/generationCompiler');
        const gc = generationCompiler.compileGeneration({
          scenarios: result.scenarios,
          testData: generationTestDataBundle && generationTestDataBundle.testData ? generationTestDataBundle.testData : null,
          project: { name: project.name, targetUrl: project.targetUrl },
          authProfileName: genAuthProfileName,
          proceduralFlowContract,
          inlineSourceSurface: appendToCurrent ? 'add_scenario' : 'initial_upload',
          // The compiler applies one source-neutral boundary to initial uploads
          // and Add Scenario text: inline values stay authored literals unless
          // this exact case selected a sheet proven by both mapping and sheets.
          // Assembly judges EXECUTION readiness. `no_typed_operations` is a SOFT advisory
          // (the conductor runs from steps; typed ops matter for BDD export, not for
          // running the test) — passing atlasHasCapabilities:true here made caseCompiler
          // stamp that warning on ~every case → all dropped → 0 ready (v8 bug). The
          // typed-ops signal is still surfaced separately in the readiness route
          // (GET /test-cases). So the ready-only ASSEMBLY must NOT gate on it.
          atlasHasCapabilities: false,
        });
        const R = gc.report;
        const readyCount = gc.readyScenarios.reduce((a, s) => a + s.cases.length, 0);
        generationReadiness = { total: R.total, ready: R.ready, withheld: R.needsReview + R.blocked, byClass: R.byClass, withheldCandidates: R.notReady.slice(0, 50) };
        const notReadyCount = R.needsReview + R.blocked;
        const notReadyDetails = R.notReady.slice(0, 6).map((n) => `${(n.defects[0] && n.defects[0].code) || n.reasons[0] || n.state}@"${String(n.case).slice(0, 28)}"`).join('; ');
        await onLog(R.needsReview + R.blocked ? 'warn' : 'info',
          `generation-compiler: assembled ${R.ready}/${R.total} READY case(s)`
          + (notReadyCount
            ? (appendToCurrent
              ? `; carrying ${notReadyCount} not-ready append candidate(s) into persistence for review: ${notReadyDetails}`
              : `; withheld ${notReadyCount} source-less candidate(s) before persistence: ${notReadyDetails}`)
            : '')
          + ` (classes: ${Object.entries(R.byClass).map(([k, n]) => `${k}=${n}`).join(', ')})`);
        // Full generation keeps the strict ready-only promotion gate. Add Scenario is
        // an append/review action: preserve the authored candidate and let persisted
        // readiness explain whether it is runnable instead of dropping it completely.
        result.scenarios = appendToCurrent ? gc.scenarios : gc.readyScenarios;
        if (appendContinuationParentCase && Array.isArray(result.scenarios)) {
          result.scenarios = applyAppendContinuationContract(result.scenarios, appendContinuationParentCase);
          if (coverageResult) coverageResult.scenarios = result.scenarios;
        }
        if (appendToCurrent && readyCount === 0 && R.total > 0) {
          generationReadiness.appendDraftFallback = true;
          await onLog('warn', `append mode: ${R.total} candidate case(s) did not meet the ready-only compiler gate; persisting them for review with honest readiness instead of dropping the Add Scenario output.`);
        }
        reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
          stage: 'compiler_ready',
          scenarios: result.scenarios || [],
          metadata: {
            generationReadiness,
          },
          reason: 'compiler_ready',
        });
        if (readyCount === 0 && !appendToCurrent) {
          // No ready case could be assembled at all → do not persist; previous generation
          // stays current. This is the ONLY generation-failure the user ever sees, and
          // only when a ready suite genuinely cannot be built.
          cancelRegistry.clear(req.user.id);
          send('agent.phase.complete', { phase: 'architect', error: 'no_ready_cases', projectId: project.id });
          failScenarioJob('No ready-to-execute case could be assembled.');
          return res.status(422).json({
            success: false,
            code: 'NO_READY_CASES',
            message: `No ready-to-execute case could be assembled from ${R.total} candidate(s); nothing persisted, previous generation kept. Defects: ${R.defects.slice(0, 8).map((d) => d.code).join(', ')}.`,
            report: generationReadiness,
          });
        }

        // ── EXECUTION-READINESS (start-state contract) ──────────────────────────────
        // Data/oracle readiness is not enough: a case is ready only if it can EXECUTE
        // from the conductor's ACTUAL start state (a fresh, logged-OUT session for an
        // independent scenario). Inject a compiled, self-contained login prelude into
        // any case that operates on authenticated UI but does NOT already log itself in
        // (harvested from the generation's own proven login sequence), and attach the
        // credential binding so the injected {{username}}/{{password}} resolve per row.
        // A case that needs auth but has no login template/credentials is NOT
        // execution-ready and is dropped (never fabricate auth). Persist only cases that
        // pass BOTH data-readiness (above) AND execution-readiness.
        try {
          const executionReadinessCompiler = require('../services/executionReadinessCompiler');
          const er = executionReadinessCompiler.compileExecutionReadiness({ scenarios: result.scenarios });
          result.scenarios = er.scenarios;
          if (generationReadiness) {
            generationReadiness.executionReadiness = {
              injected: er.report.injected, selfAuth: er.report.selfAuth,
              noSetupNeeded: er.report.noSetupNeeded, dropped: er.report.dropped,
              loginTemplate: er.report.loginTemplateSource,
            };
          }
          await onLog(er.report.dropped.length ? 'warn' : 'info',
            `execution-readiness: login setup injected into ${er.report.injected} case(s); ${er.report.selfAuth} self-authenticate; ${er.report.noSetupNeeded} need none`
            + (er.report.dropped.length ? `; DROPPED ${er.report.dropped.length} not-executable (needs authenticated start state, no login/credentials): ${er.report.dropped.slice(0, 6).map((d) => `${d.reason}@"${String(d.case).slice(0, 28)}"`).join('; ')}` : ''));
          reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
            stage: 'execution_ready',
            scenarios: result.scenarios || [],
            metadata: {
              executionReadiness: er.report,
            },
            reason: 'execution_ready',
          });
          const executableCount = result.scenarios.reduce((a, s) => a + s.cases.length, 0);
          if (executableCount === 0) {
            cancelRegistry.clear(req.user.id);
            send('agent.phase.complete', { phase: 'architect', error: 'no_executable_cases', projectId: project.id });
            failScenarioJob('No case could be made execution-ready.');
            return res.status(422).json({
              success: false,
              code: 'NO_EXECUTABLE_CASES',
              message: `No case could be made execution-ready: every candidate needs an authenticated start state but no login setup/credentials could be compiled. Nothing persisted; previous generation kept.`,
              report: generationReadiness,
            });
          }
        } catch (erErr) {
          // FAIL-CLOSED. Execution-readiness is a persistence GATE, not an advisory.
          // If it throws we CANNOT prove the suite is executable, so we must NOT persist
          // a possibly-unrunnable generation. Keep the previous generation current and
          // surface the failure (same contract as NO_READY_CASES / NO_EXECUTABLE_CASES).
          console.error(`${TAG} execution-readiness compiler ERROR — refusing to persist (previous generation kept):`, erErr && (erErr.stack || erErr.message));
          cancelRegistry.clear(req.user.id);
          send('agent.phase.complete', { phase: 'architect', error: 'execution_readiness_error', projectId: project.id });
          failScenarioJob(`Execution-readiness compilation failed (${erErr.message}).`);
          return res.status(422).json({
            success: false,
            code: 'EXECUTION_READINESS_ERROR',
            message: `Execution-readiness compilation failed (${erErr.message}); refusing to persist an unverified suite. Previous generation kept current. Retry generation.`,
            report: generationReadiness,
          });
        }
      } catch (gcErr) {
        // FAIL-CLOSED for the same reason: if the readiness pipeline itself errored we
        // have no proof the assembled suite is ready/executable — do NOT persist it.
        console.error(`${TAG} generation-compiler ERROR — refusing to persist (previous generation kept):`, gcErr && (gcErr.stack || gcErr.message));
        cancelRegistry.clear(req.user.id);
        send('agent.phase.complete', { phase: 'architect', error: 'generation_compiler_error', projectId: project.id });
        failScenarioJob(`Generation readiness compilation failed (${gcErr.message}).`);
        return res.status(422).json({
          success: false,
          code: 'GENERATION_COMPILER_ERROR',
          message: `Generation readiness compilation failed (${gcErr.message}); refusing to persist an unverified suite. Previous generation kept current. Retry generation.`,
          report: generationReadiness,
        });
      } else {
        const plannedCount = testDesignPlanV1.scenarios.reduce((sum, scenario) => sum + (scenario.cases || []).length, 0);
        generationReadiness = {
          total: plannedCount,
          ready: 0,
          withheld: 0,
          mode: 'immutable_test_design_plan',
          planId: testDesignPlanV1.planId,
          revision: testDesignPlanV1.revision,
        };
      }

      if (!testDesignPlanV1) try {
        const selfHeal = await runGenerationSelfHealingPipeline({
          scenarios: result.scenarios || [],
          manifest: coveragePlan,
          testData: generationTestDataBundle && generationTestDataBundle.testData,
          context: {
            targetUrl: project.targetUrl,
            authRole: genAuthProfileName,
            appCapabilityMap: coverageResult && coverageResult.appCapabilityMap,
            capabilityGroundingRequired: capabilityGroundingEnabled(),
          },
          enableTargetedRepair: repairOrchestratorEnabled(),
        });
        result.scenarios = selfHeal.scenarios;
        if (firecrawlSourceArtifacts.length && Array.isArray(result.scenarios)) {
          result.scenarios = sourceGrounding.attachSourceArtifactsToCases(result.scenarios, firecrawlSourceArtifacts);
        }
        coverageResult = {
          ...(coverageResult || {}),
          scenarios: result.scenarios,
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
        if (generationReadiness) generationReadiness.selfHealingPipeline = selfHeal.summary;
        reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
          stage: 'self_healed',
          scenarios: result.scenarios || [],
          metadata: {
            selfHealingSummary: selfHeal.summary,
            unresolvedDefects: selfHeal.reliabilityReport?.unresolvedDefects?.length || 0,
          },
          reason: 'self_healed',
        });
        await onLog('info',
          `generation-self-healing: normalized ${selfHeal.rawDraftSummary.caseCount} draft case(s); `
          + `coverage linked=${selfHeal.deterministicRepairs.coverageLinked}, `
          + `row plans=${selfHeal.deterministicRepairs.rowPlansBuilt}, `
          + `oracles=${selfHeal.deterministicRepairs.oraclesCompiled}, `
          + `remaining defects=${selfHeal.reliabilityReport.unresolvedDefects.length}`);
      } catch (selfHealErr) {
        console.error(`${TAG} generation-self-healing ERROR - refusing to persist raw draft (previous generation kept):`, selfHealErr && (selfHealErr.stack || selfHealErr.message));
        cancelRegistry.clear(req.user.id);
        send('agent.phase.complete', { phase: 'architect', error: 'generation_self_healing_error', projectId: project.id });
        failScenarioJob(`Generation self-healing failed (${selfHealErr.message}).`);
        return res.status(selfHealErr.status || 500).json({
          success: false,
          code: selfHealErr.code || 'GENERATION_SELF_HEALING_ERROR',
          message: `Generation self-healing failed (${selfHealErr.message}); refusing to persist raw draft cases. Previous generation kept current.`,
          report: generationReadiness,
          invariantDefects: selfHealErr.invariantDefects || undefined,
        });
      }

      if (testDesignPlanV1) {
        try {
          const compiled = require('../services/testDesignStepCompiler').compileCandidateSuite({
            testDesignPlan: testDesignPlanV1,
            candidateScenarios: result.scenarios || [],
            authProfileName: genAuthProfileName,
            // Ephemeral source authority used only to restore authored inline
            // literals onto the final executable projection. The frozen plan
            // and matrix/workbook cases remain tokenized.
            proceduralFlowContract,
          });
          result.scenarios = compiled.scenarios;
          coverageResult = { ...(coverageResult || {}), scenarios: compiled.scenarios };
          generationReadiness = {
            ...(generationReadiness || {}),
            total: compiled.report.plannedCases,
            ready: compiled.report.compiledCases,
            compiledRevision: compiled.revision,
            compilerReport: compiled.report,
          };
          reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
            stage: 'test_design_compiled',
            scenarios: result.scenarios,
            metadata: { planId: compiled.planId, planRevision: compiled.planRevision, compiledRevision: compiled.revision },
            reason: 'immutable_test_design_plan_compiled',
          });
          await onLog('info', `TestDesignPlan compiler: ${compiled.report.compiledCases}/${compiled.report.plannedCases} planned case(s) compiled with exact requirement, data, session, and oracle lineage.`);
        } catch (compileErr) {
          if (hasAuthoritativeCaseContracts && Array.isArray(result.scenarios) && result.scenarios.length) {
            const preservedCaseCount = result.scenarios.reduce(
              (sum, scenario) => sum + (Array.isArray(scenario.cases) ? scenario.cases.length : 0),
              0,
            );
            generationReadiness = {
              ...(generationReadiness || {}),
              total: preservedCaseCount,
              ready: preservedCaseCount,
              mode: 'authoritative_case_contract_fallback',
              compilerWarning: {
                code: compileErr.code || 'TEST_DESIGN_STEP_COMPILATION_FAILED',
                message: compileErr.message,
                findings: compileErr.findings || [],
              },
            };
            coverageResult = { ...(coverageResult || {}), scenarios: result.scenarios };
            reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
              stage: 'test_design_compiled',
              scenarios: result.scenarios,
              metadata: {
                planId: testDesignPlanV1.planId,
                planRevision: testDesignPlanV1.revision,
                fallback: 'authoritative_case_contract_v1',
                compilerFindingCount: Array.isArray(compileErr.findings) ? compileErr.findings.length : 0,
              },
              reason: 'authoritative_case_contract_preserved_after_compiler_warning',
            });
            await onLog('warn', `TestDesignPlan compiler reported ${Array.isArray(compileErr.findings) ? compileErr.findings.length : 0} finding(s); preserving ${preservedCaseCount} source-authored case(s) with exact CaseContractV1 steps, values, assertions, and session topology.`);
          } else {
          cancelRegistry.clear(req.user.id);
          send('agent.phase.complete', { phase: 'architect', error: 'test_design_step_compilation_failed', projectId: project.id });
          failScenarioJob(`Test design step compilation failed (${compileErr.message}).`);
          return res.status(compileErr.status || 422).json({
            success: false,
            code: compileErr.code || 'TEST_DESIGN_STEP_COMPILATION_FAILED',
            message: `${compileErr.message} Nothing persisted; the previous generation remains current.`,
            findings: compileErr.findings || [],
            report: compileErr.report || generationReadiness,
          });
          }
        }
      }

      if (!testDesignPlanV1 && appendContinuationParentCase && Array.isArray(result && result.scenarios)) {
        result.scenarios = applyAppendContinuationContract(result.scenarios, appendContinuationParentCase);
        if (coverageResult) coverageResult.scenarios = result.scenarios;
        await onLog('info', `Append continuation: generated case(s) will continue from parent case "${appendContinuationParentCase.name}" (${appendContinuationParentCase.id}).`);
        reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
          stage: 'readiness_compiled',
          scenarios: result.scenarios || [],
          metadata: {
            continuationParentCaseId: appendContinuationParentCase.id,
            sessionMode: 'continue_from_dependency',
            failurePolicy: 'block_dependents',
          },
          reason: 'append_continuation_contract_applied',
        });
      }

      // Append mutates the current generation in place. Re-read it immediately
      // before persistence so rollback has an exact pre-append contract and a
      // generation that stopped being current cannot be mutated by a stale job.
      let appendGenerationSnapshot = null;
      if (appendToCurrent && appendCurrentGeneration) {
        const liveAppendGeneration = await prisma.scenarioGeneration.findUnique({
          where: { id: appendCurrentGeneration.id },
          select: {
            id: true,
            projectId: true,
            isCurrent: true,
            scenarioCount: true,
            caseCount: true,
            coveragePlanJson: true,
            coverageValidationJson: true,
            coverageRepairJson: true,
          },
        });
        if (!liveAppendGeneration
          || liveAppendGeneration.projectId !== project.id
          || liveAppendGeneration.isCurrent !== true) {
          const changedErr = new Error('The current generation changed while the append was compiling. Retry against the new current generation.');
          changedErr.code = 'APPEND_GENERATION_CHANGED';
          changedErr.status = 409;
          throw changedErr;
        }
        const liveRelationCounts = await countScenarioGenerationRelations(prisma, {
          projectId: project.id,
          generationId: liveAppendGeneration.id,
        });
        appendGenerationSnapshot = appendGenerationContractSnapshot({
          ...liveAppendGeneration,
          ...liveRelationCounts,
        });
        if (appendGenerationSnapshot.coveragePlanJson) {
          coveragePlan = mergeAppendCoverageManifest(appendGenerationSnapshot.coveragePlanJson, coveragePlan);
        }
      }

      // Persist scenarios + cases. VERSIONING (replaces destructive wipe):
      // every generate creates a NEW ScenarioGeneration and makes it current;
      // prior generations + their scenarios / cases / output-files are KEPT so
      // the user can browse and re-select past versions. The old
      // deleteMany-on-regenerate (and the on-disk artifact reap) is gone — that
      // is the whole point of generation history. The `replace` flag is now a
      // no-op for data retention.
      // APPEND mode ("+ Add scenario") reuses the CURRENT generation so existing
      // cases stay live; default mode creates a fresh generation (old → history).
      let generation = appendToCurrent ? appendCurrentGeneration : null;
      const appendedToExisting = !!generation;
      if (!generation) {
        const prevGen = await prisma.scenarioGeneration.findFirst({
          where: { projectId: project.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const nextVersion = (prevGen?.version || 0) + 1;
        generation = await prisma.scenarioGeneration.create({
          data: {
            projectId: project.id,
            version: nextVersion,
            label: buildGenerationLabel(effectiveGuidance) || `Generation ${nextVersion}`,
            isCurrent: false,
          },
        });
      }

      const enforceApprovedTestData = !!(generationTestDataBundle
        && generationTestDataBundle.source === 'approved'
        && generationTestDataBundle.contract
        && generationTestDataBundle.contract.strict);
      const created = [];
      const pendingDeps = [];
      const createdScenarioIds = [];
      const createdCaseIds = [];
      let addedCaseCount = 0;
      const allCasesWithRefs = []; // P2-integration — feeds the RTM (caseId → verified requirementRefs)
      // Bound only legacy model-authored append. Strict plan-backed output has
      // already passed exact cardinality/topology compilation and cannot be sliced
      // afterward without violating its immutable plan.
      const strictPlanBackedAppend = appendedToExisting && !!testDesignPlanV1;
      const scenariosToPersist = appendedToExisting && !strictPlanBackedAppend
        ? (result.scenarios || []).slice(0, 5)
        : result.scenarios;
      const scenarioPersistenceRows = normalizeScenarioPersistenceBatch(scenariosToPersist);
      const appendCommittedCoverageState = appendedToExisting
        ? generationCoverageData({
          manifest: coveragePlan,
          validation: coverageResult && coverageResult.validation,
          repair: coverageResult && coverageResult.repair,
          reliabilityReport: coverageResult && coverageResult.reliabilityReport,
          degradations: coverageDegradations,
        })
        : null;
      let persistTransactionCommitted = false;
      let persistedGenerationCounts = null;
      try {
        // #31 — ATOMIC generation persist. Previously each scenario+case write ran
        // in a bare loop with no transaction: a crash (or thrown error) mid-loop left
        // a HALF-POPULATED generation, and for a fresh generation the rollback was a
        // best-effort deleteMany in the catch. Wrap the whole scenario+case persist in
        // ONE interactive transaction so a partial run rolls back automatically and
        // never reaches the isCurrent flip below (which still runs only AFTER this
        // block fully succeeds — staged promotion). persistCases uses the client it is
        // handed, so threading `tx` keeps every write inside the transaction.
        // Generous timeout: persistCases is pure DB writes (grounding already done in
        // memory) but a large suite has many round-trips; the default 5 s is too tight.
        const txState = await prisma.$transaction(async (tx) => {
          const out = [];
          const pendingDeps = [];
          await writeGenerationCoverage(tx, generation.id, {
            manifest: coveragePlan,
            validation: coverageResult && coverageResult.validation,
            repair: coverageResult && coverageResult.repair,
            reliabilityReport: coverageResult && coverageResult.reliabilityReport,
            degradations: coverageDegradations,
          });
          for (const persistenceRow of scenarioPersistenceRows) {
            const s = persistenceRow.scenario;
            const scenario = await tx.testScenario.create({
              data: buildScenarioCreateData({
                scenario: s,
                metadata: persistenceRow.metadata,
                projectId: project.id,
                generationId: generation.id,
              }),
            });
            createdScenarioIds.push(scenario.id);
            // Enterprise Mode P1 — every entry path persists through the ONE
            // canonical contract writer: declaredAssertions normalize + grounding +
            // the FULL field set (incl. businessRisk / producesData / requiresData /
            // dataBindingJson). See server/services/testCaseContract.js. This is the
            // line that keeps the agents.js and scenarios.js paths from diverging.
            const persisted = await canonicalGenerationPipeline.persistCases({
              prisma: tx,
              projectId: project.id,
              scenarioId: scenario.id,
              generationId: generation.id,
              moduleName: persistenceRow.metadata.module,
              cases: s.cases,
              calibrationAtlas,
              approvedTestData: enforceApprovedTestData && generationTestDataBundle && generationTestDataBundle.testData ? generationTestDataBundle.testData : null,
              requireApprovedMapping: enforceApprovedTestData,
              enterpriseMode: enforceApprovedTestData,
              authProfileName: genAuthProfileName,
              log: console,
              tag: TAG,
            });
            for (const p of persisted) {
              if (p && p.tc && p.tc.id) createdCaseIds.push(p.tc.id);
              if (p.dependsOnNames && p.dependsOnNames.length) pendingDeps.push({ caseId: p.tc.id, dependsOnNames: p.dependsOnNames });
            }
            out.push({ scenario, persisted });
          }
          if (pendingDeps.length) {
            const depsByCaseId = new Map(pendingDeps.map((row) => [row.caseId, row.dependsOnNames]));
            const allCases = out.flatMap((row) => row.persisted.map((p) => {
              p.tc.dependsOnNames = depsByCaseId.get(p.tc.id) || [];
              return p.tc;
            }));
            await canonicalGenerationPipeline.resolveNamedDependenciesForCases({
              prisma: tx,
              projectId: project.id,
              cases: allCases,
            });
          }
          const generationCounts = await syncScenarioGenerationCounts(tx, {
            projectId: project.id,
            generationId: generation.id,
          });
          return { rows: out, generationCounts };
        }, { timeout: 120_000, maxWait: 15_000 });
        const txResults = txState.rows;
        persistedGenerationCounts = txState.generationCounts;
        persistTransactionCommitted = true;

        for (const { scenario, persisted } of txResults) {
          const cases = persisted.map((p) => ({ ...p.tc, steps: p.source.steps || [] }));
          for (const p of persisted) {
            allCasesWithRefs.push({ caseId: p.tc.id, requirementRefs: Array.isArray(p.source.requirementRefs) ? p.source.requirementRefs : [] });
          }
          created.push({ ...inflateScenario(scenario), cases });
        }
        addedCaseCount = created.reduce((a, s) => a + s.cases.length, 0);
        if (!created.length || addedCaseCount <= 0) {
          const emptyErr = new Error('Generation produced no persistable test cases; previous generation was left unchanged.');
          emptyErr.code = 'EMPTY_GENERATION';
          emptyErr.status = 502;
          throw emptyErr;
        }
      } catch (persistErr) {
        // The interactive transaction already rolled back every scenario/case row it
        // wrote, so createdScenarioIds may point at rows that no longer exist — the
        // deleteMany cleanups below are idempotent (no-op when nothing matches) and
        // remain as belt-and-suspenders for the EMPTY_GENERATION throw (which fires
        // AFTER the tx committed) and for any older partial state.
        recordDegradation({
          onLog,
          collector: coverageDegradations,
          stage: 'scenario-persist',
          severity: 'error',
          code: 'generation_persist_failed',
          reason: `Persisting the generation's scenarios/cases failed and was rolled back: ${persistErr.message}`,
          impact: appendedToExisting
            ? 'No new scenarios were added; the existing current generation is unchanged.'
            : 'The partial generation was discarded and NOT promoted to current; the previous generation remains active.',
        });
        // A rejected interactive transaction has already undone every write;
        // restoring its old snapshot would be redundant and could overwrite a
        // different append that committed meanwhile. Only failures after the
        // transaction returned need a scoped exact-state rollback.
        if (appendedToExisting && persistTransactionCommitted) {
          await rollbackAppendedGenerationMutation({
            prismaClient: prisma,
            projectId: project.id,
            generationId: generation.id,
            snapshot: appendGenerationSnapshot,
            scenarioIds: createdScenarioIds,
            caseIds: createdCaseIds,
            expectedState: {
              scenarioCount: persistedGenerationCounts.scenarioCount,
              caseCount: persistedGenerationCounts.caseCount,
              ...appendCommittedCoverageState,
            },
          });
        }
        if (!appendedToExisting && generation && generation.id) {
          await prisma.testScenario.deleteMany({ where: { generationId: generation.id, projectId: project.id } });
          await prisma.scenarioGeneration.deleteMany({ where: { id: generation.id, projectId: project.id } });
          const stillCurrent = await prisma.scenarioGeneration.findFirst({
            where: { projectId: project.id, isCurrent: true },
            select: { id: true },
          });
          const previousCurrent = stillCurrent || await prisma.scenarioGeneration.findFirst({
            where: { projectId: project.id, scenarios: { some: {} }, cases: { some: {} } },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          if (previousCurrent && previousCurrent.id) {
            await prisma.scenarioGeneration.update({ where: { id: previousCurrent.id }, data: { isCurrent: true } });
          }
        }
        throw persistErr;
      }

      // The insert transaction authoritatively recounted both denormalized fields
      // from TestScenario/TestCase rows. Rollback compares against that exact
      // committed relation state rather than incrementing a possibly stale cache.
      const rollbackAppendAtState = appendedToExisting
        ? (scenarioCount, caseCount) => rollbackAppendedGenerationMutation({
          prismaClient: prisma,
          projectId: project.id,
          generationId: generation.id,
          snapshot: appendGenerationSnapshot,
          scenarioIds: createdScenarioIds,
          caseIds: createdCaseIds,
          expectedState: {
            scenarioCount,
            caseCount,
            ...appendCommittedCoverageState,
          },
        })
        : null;
      const rollbackCommittedAppend = rollbackAppendAtState
        ? () => rollbackAppendAtState(
          persistedGenerationCounts.scenarioCount,
          persistedGenerationCounts.caseCount,
        )
        : null;
      let postPersistVerification = null;
      try {
        postPersistVerification = await verifyPersistedGenerationContract({ prisma, generationId: generation.id });
        if (coverageResult && coverageResult.reliabilityReport) {
          coverageResult.reliabilityReport.postPersistVerification = postPersistVerification;
        }
      } catch (verifyErr) {
        postPersistVerification = {
          ok: false,
          generationId: generation.id,
          checkedCases: 0,
          defects: [{
            code: 'post_persist_verification_failed',
            message: verifyErr.message,
          }],
        };
        if (coverageResult && coverageResult.reliabilityReport) {
          coverageResult.reliabilityReport.postPersistVerification = postPersistVerification;
        }
        console.warn(`${TAG} post-persist contract verification failed:`, verifyErr.message);
      }
      if (postPersistVerification && Array.isArray(postPersistVerification.defects) && postPersistVerification.defects.length) {
        console.warn(`${TAG} post-persist contract verification defect counts:`, JSON.stringify(countPostPersistDefects(postPersistVerification), null, 2));
      }
      canonicalGenerationPipeline.recordPipelineSnapshot(reliabilityJobs, scenarioGenerationJob, {
        stage: canonicalGenerationPipeline.SNAPSHOT_STAGE.POST_PERSIST_VERIFIED,
        scenarios: created,
        metadata: {
          generationId: generation.id,
          ok: !!(postPersistVerification && postPersistVerification.ok),
          checkedCases: postPersistVerification && postPersistVerification.checkedCases,
          defectCount: Array.isArray(postPersistVerification && postPersistVerification.defects)
            ? postPersistVerification.defects.length
            : 0,
        },
      });
      if (postPersistVerification && postPersistVerification.ok === false) {
        console.warn(`${TAG} post-persist contract verification defects:`, JSON.stringify(summarizePostPersistDefects(postPersistVerification), null, 2));
        if (coverageResult && coverageResult.reliabilityReport) {
          coverageResult.reliabilityReport.postPersistVerification = postPersistVerification;
        }
        if (appendedToExisting) {
          await rollbackCommittedAppend();
        } else {
          await writeGenerationCoverage(prisma, generation.id, {
            manifest: coveragePlan,
            validation: coverageResult && coverageResult.validation,
            repair: coverageResult && coverageResult.repair,
            reliabilityReport: coverageResult && coverageResult.reliabilityReport,
            degradations: coverageDegradations,
          }, { bestEffort: true });
          await prisma.testScenario.deleteMany({ where: { generationId: generation.id, projectId: project.id } });
          await prisma.scenarioGeneration.deleteMany({ where: { id: generation.id, projectId: project.id } });
        }
        const defectSummary = summarizePostPersistDefects(postPersistVerification, 6)
          .map((defect) => `${defect.code}${defect.caseId ? `@${defect.caseId}` : ''}`)
          .join(', ');
        const contractErr = new Error(`Post-persist contract verification failed for ${postPersistVerification.defects.length} issue(s): ${defectSummary}; the generated changes were rolled back and not promoted.`);
        contractErr.code = 'POST_PERSIST_CONTRACT_FAILED';
        contractErr.status = 422;
        contractErr.postPersistVerification = postPersistVerification;
        throw contractErr;
      }
      if (coverageResult && coverageResult.reliabilityReport) {
        coverageResult.reliabilityReport.generationId = generation.id;
        if (coverageResult.reliabilityReport.scenarioGenerationJob) {
          coverageResult.reliabilityReport.scenarioGenerationJob.generationId = generation.id;
          const liveJob = reliabilityJobs.getScenarioGenerationJob(coverageResult.reliabilityReport.scenarioGenerationJob.id);
          if (liveJob) {
            reliabilityJobs.updateScenarioGenerationJob(liveJob, {
              generationId: generation.id,
              reason: 'generation_id_attached',
            });
            coverageResult.reliabilityReport.scenarioGenerationJob = reliabilityJobs.serializeScenarioGenerationJob(liveJob);
          }
        }
      }
      const promotionIssues = promotionIssuesForGeneration({
        scenarios: created,
        coverageValidation: coverageResult && coverageResult.validation,
        requirementClauses: scopedClauses,
        options: {
          proceduralOneCase: !!(proceduralFlowContract && proceduralFlowContract.singleBehavioralPartition),
          authoritativeAuthoredCases: !!(
            testDesignPlanV1
            && proceduralFlowContract?.caseContractV1?.cases?.length
          ),
        },
      });
      if (promotionIssues.length) {
        console.warn(`${TAG} generation promotion blocked:`, JSON.stringify(promotionIssues, null, 2));
        if (coverageResult && coverageResult.reliabilityReport) {
          coverageResult.reliabilityReport.promotionVerification = {
            ok: false,
            issues: promotionIssues,
          };
        }
        if (appendedToExisting) {
          await rollbackCommittedAppend();
        } else {
          await writeGenerationCoverage(prisma, generation.id, {
            manifest: coveragePlan,
            validation: coverageResult && coverageResult.validation,
            repair: coverageResult && coverageResult.repair,
            reliabilityReport: coverageResult && coverageResult.reliabilityReport,
            degradations: coverageDegradations,
          }, { bestEffort: true });
          await prisma.testScenario.deleteMany({ where: { generationId: generation.id, projectId: project.id } });
          await prisma.scenarioGeneration.deleteMany({ where: { id: generation.id, projectId: project.id } });
          const stillCurrent = await prisma.scenarioGeneration.findFirst({
            where: { projectId: project.id, isCurrent: true },
            select: { id: true },
          });
          const previousCurrent = stillCurrent || await prisma.scenarioGeneration.findFirst({
            where: { projectId: project.id, scenarios: { some: {} }, cases: { some: {} } },
            orderBy: { version: 'desc' },
            select: { id: true },
          });
          if (previousCurrent && previousCurrent.id) {
            await prisma.scenarioGeneration.update({ where: { id: previousCurrent.id }, data: { isCurrent: true } });
          }
        }
        const issueSummary = promotionIssues.map((issue) => issue.code).join(', ');
        const promotionErr = new Error(`Generation promotion blocked: ${issueSummary}; previous generation kept current.`);
        promotionErr.code = 'GENERATION_PROMOTION_BLOCKED';
        promotionErr.status = 422;
        promotionErr.promotionIssues = promotionIssues;
        throw promotionErr;
      }
      try {
        await writeGenerationCoverage(prisma, generation.id, {
          manifest: coveragePlan,
          validation: coverageResult && coverageResult.validation,
          repair: coverageResult && coverageResult.repair,
          reliabilityReport: coverageResult && coverageResult.reliabilityReport,
          degradations: coverageDegradations,
        });
      } catch (coverageWriteErr) {
        if (rollbackCommittedAppend) await rollbackCommittedAppend();
        throw coverageWriteErr;
      }
      reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
        stage: 'persisted',
        scenarios: created,
        metadata: {
          generationId: generation.id,
          generationVersion: generation.version,
          scenarioCount: created.length,
          caseCount: created.reduce((a, s) => a + s.cases.length, 0),
        },
        reason: 'persisted',
      });
      if (!appendedToExisting) {
        await prisma.scenarioGeneration.updateMany({
          where: { projectId: project.id, isCurrent: true },
          data: { isCurrent: false },
        });
        await prisma.scenarioGeneration.update({
          where: { id: generation.id },
          data: { isCurrent: true },
        });
      }
      try {
        await generationGuidance.markApplied(prisma, savedGuidance?.id, { appliedGenerationId: generation.id });
      } catch (guidanceErr) {
        console.warn(`${TAG} guidance markApplied failed (non-fatal):`, guidanceErr.message);
      }

      // Enterprise Mode P2-integration — RTM. Now that cases are persisted with
      // their verified requirementRefs, build the traceability matrix and record
      // uncovered-requirement findings (Discrepancy rows). Findings-only / non-
      // blocking until P9. Skipped when the oracle produced no clauses.
      if (clausePrep.requirementClauses.length) {
        // #5 — MODULE-SCOPED RTM DENOMINATOR. The architect was handed `scopedClauses`
        // (a module-narrowed subset) but the RTM was scored against the FULL project
        // clause set, so every OUT-OF-MODULE clause falsely reported 'uncovered' —
        // exactly backwards for the "module is the unit of work" flow. Score the RTM
        // against the SAME clause set the architect saw. Absent module → unchanged
        // (scopedClauses === clausePrep.requirementClauses).
        let rtmDenominator = (clauseScope && Array.isArray(scopedClauses) && scopedClauses.length)
          ? scopedClauses
          : clausePrep.requirementClauses;
        // #5 (cont.) — exclude clauses the oracle flagged NON-testable (section
        // headings, ToC lines, bare story preambles) from the denominator: they are
        // structural noise that can't be "covered" by a test. Consume an explicit
        // `testable === false` flag if the oracle attached one; degrade gracefully
        // (keep the clause) when the field is absent on older clause rows.
        const beforeTestable = rtmDenominator.length;
        rtmDenominator = rtmDenominator.filter((c) => !(c && c.testable === false));
        const excludedNonTestable = beforeTestable - rtmDenominator.length;

        // #30 — requirementRefs DIVERGENCE. The RTM was fed from the IN-MEMORY source
        // object (p.source.requirementRefs), which can diverge from the persisted
        // `requirementRefs` column under a stale Prisma client (the column may be
        // dropped or coerced). Read the refs BACK from the DB for the cases we just
        // created so the RTM matches exactly what the UI/traceability surface reads.
        // On any read failure (stale/regen-pending client) fall back to the in-memory
        // refs and signal the degradation rather than silently using a divergent set.
        let casesWithRefs = allCasesWithRefs;
        const createdCaseIds = created.flatMap((s) => (Array.isArray(s.cases) ? s.cases : []).map((c) => c.id)).filter(Boolean);
        if (createdCaseIds.length) {
          try {
            const persistedRows = await prisma.testCase.findMany({
              where: { id: { in: createdCaseIds }, projectId: project.id },
              select: { id: true, requirementRefs: true },
            });
            const refsById = new Map(persistedRows.map((r) => [r.id, decodeJson(r.requirementRefs, []) || []]));
            casesWithRefs = createdCaseIds.map((id) => ({
              caseId: id,
              requirementRefs: Array.isArray(refsById.get(id)) ? refsById.get(id) : [],
            }));
          } catch (refReadErr) {
            recordDegradation({
              onLog,
              collector: coverageDegradations,
              stage: 'rtm',
              severity: 'warning',
              code: 'rtm_persisted_refs_unreadable',
              reason: `Could not read persisted requirementRefs back for the RTM (${refReadErr.message}); using in-memory refs.`,
              impact: 'The RTM is computed from in-memory refs which may diverge from the requirementRefs column the UI shows — verify traceability.',
            });
            casesWithRefs = allCasesWithRefs;
          }
        }
        if (excludedNonTestable > 0) {
          await onLog('info', `RTM denominator: ${rtmDenominator.length} testable clause(s) in scope (${excludedNonTestable} non-testable excluded${moduleScope ? `, module "${moduleScope}"` : (focusArea ? `, focus "${String(focusArea).slice(0, 40)}"` : '')}).`);
        }

        try {
          const rtm = await require('../services/requirementOracle').persistRtmFindings({
            prisma, projectId: project.id, requirements: rtmDenominator, casesWithRefs, log: console,
          });
          if (rtm.uncovered.length) {
            await onLog('warn', `RTM: ${rtm.uncovered.length}/${rtmDenominator.length} in-scope requirement clause(s) uncovered by any case — recorded as findings for review.`);
          } else {
            await onLog('info', `RTM: all ${rtmDenominator.length} in-scope requirement clause(s) covered by at least one case.`);
          }
        } catch (e) { console.warn(`${TAG} RTM build failed (non-fatal):`, e.message); }

        // P3c — RequirementSiteMismatch: surface requirements whose behaviour
        // implies a capability TYPE absent from the calibrated atlas for this
        // module (findings-only / non-blocking until P9). INERT until a
        // calibration has actually mapped capabilities — an empty inventory
        // yields ZERO findings (absence of crawl evidence ≠ a missing feature).
        if (calibrationAtlas && Array.isArray(calibrationAtlas.capabilities) && calibrationAtlas.capabilities.length) {
          try {
            const mismatch = await require('../services/requirementSiteReconcile').persistSiteMismatchFindings({
              prisma, projectId: project.id, requirements: clausePrep.requirementClauses,
              atlasCapabilities: calibrationAtlas.capabilities, pagesCrawled: (calibrationAtlas.pages || []).length, log: console,
            });
            if (mismatch.findingsCount) {
              await onLog('warn', `Site reconciliation: ${mismatch.findingsCount} requirement(s) imply a capability not seen in the atlas — recorded as findings (verify coverage).`);
            }
          } catch (e) { console.warn(`${TAG} site reconciliation failed (non-fatal):`, e.message); }
        }
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
          coverageSummary: coverageResult && coverageResult.summary,
        },
      });

      console.log(`${TAG} SUCCESS — ${created.length} scenarios, ${created.reduce((a, s) => a + s.cases.length, 0)} cases`);
      res.json({
        success: true,
        scenarios: created,
        generationId: generation.id,
        generationVersion: generation.version,
        stats: {
          scenarios: created.length,
          cases: created.reduce((a, s) => a + s.cases.length, 0),
        },
        coverageSummary: coverageResult && coverageResult.summary,
        reliabilityReport: coverageResult && coverageResult.reliabilityReport,
        // Readiness report from the GenerationCompiler — the suite persisted; this tells
        // the UI how many cases are ready vs. surfaced for review (with the specific
        // not-ready cases), so a residual imperfect case is visible, not discarded.
        scenarioGenerationJob: scenarioGenerationJob ? reliabilityJobs.serializeScenarioGenerationJob(scenarioGenerationJob) : undefined,
        readiness: generationReadiness || undefined,
        // Honest degradation signals (#22 per-row, #24 untokenizable, #30 ref read,
        // #31 persist) for the UI to surface — empty on the validated lane.
        coverageDegradations: coverageDegradations.length ? coverageDegradations : undefined,
      });
    } catch (err) {
      if (cancelToken) cancelRegistry.clear(req.user.id);
      const isSemanticPlanFailure = /^ADD_SCENARIO_SEMANTIC_/.test(String(err.code || ''));
      const safeSemanticFindings = isSemanticPlanFailure && Array.isArray(err.findings)
        ? err.findings.slice(0, 25).map((entry) => {
          const path = String(entry && entry.path || '$').slice(0, 240);
          const detail = String(entry && (entry.message || entry.detail) || 'Semantic plan validation failed.').slice(0, 500);
          return {
            code: String(entry && entry.code || 'semantic_plan_invalid').slice(0, 120),
            path,
            message: `${path} | ${detail}`,
            detail: `${path} | ${detail}`,
          };
        })
        : [];
      const rawSemanticDiagnostics = isSemanticPlanFailure && err.diagnostics && typeof err.diagnostics === 'object'
        ? err.diagnostics
        : {};
      const safeSemanticDiagnostics = {
        outputHash: String(rawSemanticDiagnostics.outputHash || '').slice(0, 80) || null,
        outputCharacters: Number.isFinite(Number(rawSemanticDiagnostics.outputCharacters))
          ? Math.max(0, Number(rawSemanticDiagnostics.outputCharacters)) : 0,
        parseable: typeof rawSemanticDiagnostics.parseable === 'boolean' ? rawSemanticDiagnostics.parseable : null,
        stopReason: String(rawSemanticDiagnostics.stopReason || '').slice(0, 120) || null,
        elapsedMs: Number.isFinite(Number(rawSemanticDiagnostics.elapsedMs))
          ? Math.max(0, Number(rawSemanticDiagnostics.elapsedMs)) : null,
      };
      if (scenarioGenerationJob && isSemanticPlanFailure) {
        try {
          await reliabilityJobs.recordScenarioGenerationJobSnapshot(scenarioGenerationJob, {
            stage: 'semantic_plan_failed',
            scenarios: [],
            metadata: {
              errorCode: String(err.code || 'ADD_SCENARIO_SEMANTIC_OUTPUT_INVALID').slice(0, 120),
              attempts: Number(err.attempts) || 1,
              diagnostics: safeSemanticDiagnostics,
              findings: safeSemanticFindings,
            },
            reason: 'semantic_plan_invalid',
          });
        } catch (diagnosticError) {
          console.warn(`${TAG} Could not persist semantic-plan diagnostics:`, diagnosticError.message);
        }
      }
      if (safeSemanticFindings.length) {
        console.error(`${TAG} semantic findings:`, JSON.stringify(safeSemanticFindings));
      }
      failScenarioJob(err.message || 'Scenario generation failed.');
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
          findings: safeSemanticFindings.length ? safeSemanticFindings : undefined,
          scenarioGenerationJob: err.scenarioGenerationJob
            || (scenarioGenerationJob ? reliabilityJobs.serializeScenarioGenerationJob(scenarioGenerationJob) : undefined),
        });
      }
      next(err);
    }
  }
);

// ── POST /api/projects/:projectId/scenarios/drafts/:draftId/approve ──
// Persists only the server-registered semantic draft. Client-authored cases,
// steps, assertions, and locators are deliberately outside this boundary.
router.post(
  '/drafts/:draftId/approve',
  requireCsrf,
  rateLimit({ windowMs: 60_000, max: 20 }),
  async (req, res, next) => {
    let project;
    try {
      project = await getProject(req);
    } catch (err) {
      return next(err);
    }
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND', persisted: false });

    const requestBody = req.body && typeof req.body === 'object' ? req.body : {};
    const revision = cleanAddScenarioRefinementValue(requestBody.revision, 500);
    const sourceDigest = cleanAddScenarioRefinementValue(
      requestBody.sourceDigest || requestBody.previewDigest || requestBody.digest,
      500,
    );
    const generationId = cleanAddScenarioRefinementValue(requestBody.generationId, 500);
    try {
      const result = await approveRegisteredAddScenarioDraft({
        userId: req.user.id,
        projectId: project.id,
        draftId: req.params.draftId,
        revision,
        sourceDigest,
        generationId,
      }, {
        prisma,
        registry: addScenarioDraftRegistry,
      });
      return res.json({
        ...result,
        success: true,
        mode: 'add_scenario_approved',
        persisted: true,
        authority: {
          draftId: req.params.draftId,
          revision,
          sourceDigest,
          generationId: result.generationId || generationId,
        },
      });
    } catch (err) {
      const status = Number(err && err.status);
      const safeStatus = status >= 400 && status <= 599 ? status : 422;
      const current = addScenarioDraftRegistry.get({
        userId: req.user.id,
        projectId: project.id,
        draftId: req.params.draftId,
      });
      const currentDraft = current.ok ? current.draft : null;
      const currentPreview = currentDraft
        ? decorateAddScenarioDraftPreview(
          currentDraft.preview,
          currentDraft,
          currentDraft.currentGenerationId,
        )
        : undefined;
      return res.status(safeStatus).json({
        success: false,
        code: err && err.code || 'ADD_SCENARIO_APPROVAL_FAILED',
        message: err && err.message || 'The Add Scenario draft could not be approved.',
        persisted: false,
        currentRevision: currentDraft && currentDraft.revision || err && err.currentRevision || null,
        preview: currentPreview,
      });
    }
  },
);

// ── DELETE /api/projects/:projectId/scenarios/:id ─────────
router.delete('/:id', requireCsrf, async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const existing = await prisma.testScenario.findFirst({
      where: { id: req.params.id, projectId: project.id },
      include: {
        cases: { select: { id: true } },
        generation: { select: { id: true, coveragePlanJson: true } },
      },
    });
    if (!existing) return res.status(404).json({ success: false, code: 'SCENARIO_NOT_FOUND' });
    const caseIds = existing.cases.map((item) => item.id);
    const deletion = await prisma.$transaction(async (tx) => {
      const generationScope = existing.generation?.id
        ? { generationId: existing.generation.id }
        : { generationId: null };
      const survivingCaseWhere = {
        projectId: project.id,
        ...generationScope,
      };
      if (caseIds.length) survivingCaseWhere.id = { notIn: caseIds };

      const [survivingScenarios, survivingCases] = await Promise.all([
        tx.testScenario.findMany({
          where: {
            projectId: project.id,
            ...generationScope,
            id: { not: existing.id },
          },
          select: { id: true, name: true, dependencyOn: true },
        }),
        tx.testCase.findMany({
          where: survivingCaseWhere,
          select: { id: true, name: true, scenarioId: true, dependsOnIds: true },
        }),
      ]);
      const blockers = findScenarioDeletionBlockers({
        scenarioId: existing.id,
        scenarioName: existing.name,
        caseIds,
        survivingScenarios,
        survivingCases,
      });
      if (blockers.blocked) throw scenarioDeletionBlockedError(blockers);

      const guidanceReferences = [
        { scenarioId: existing.id },
        { appliedScenarioId: existing.id },
      ];
      if (caseIds.length) {
        guidanceReferences.push(
          { testCaseId: { in: caseIds } },
          { appliedTestCaseId: { in: caseIds } },
        );
      }
      const deletedGuidance = await tx.generationGuidance.deleteMany({
        where: { projectId: project.id, OR: guidanceReferences },
      });
      if (caseIds.length) {
        await tx.projectActionMemory.deleteMany({
          where: { projectId: project.id, testCaseId: { in: caseIds } },
        });
      }
      await tx.projectActionMemory.deleteMany({
        where: { projectId: project.id, scenarioId: existing.id },
      });
      await tx.testCase.deleteMany({ where: { projectId: project.id, scenarioId: existing.id } });
      await tx.testScenario.delete({ where: { id: existing.id } });
      let generationCounts = null;
      if (existing.generation?.id) {
        generationCounts = await syncScenarioGenerationCounts(tx, {
          projectId: project.id,
          generationId: existing.generation.id,
        });
      }
      return {
        deletedGuidance: Number(deletedGuidance && deletedGuidance.count) || 0,
        generationCounts,
      };
    });

    try {
      await audit.log({
        userId: req.user.id,
        action: 'scenario.delete',
        target: existing.id,
        metadata: {
          projectId: project.id,
          generationId: existing.generation?.id || null,
          deletedCases: caseIds.length,
          deletedGuidance: deletion.deletedGuidance,
          generationCounts: deletion.generationCounts,
        },
        req,
      });
    } catch (auditErr) {
      console.warn(`${TAG} scenario deletion audit failed (non-fatal):`, auditErr.message);
    }

    return res.json({
      success: true,
      scenarioId: existing.id,
      deletedScenario: { id: existing.id, name: existing.name },
      deletedCases: caseIds.length,
      deletedGuidance: deletion.deletedGuidance,
      generationCounts: deletion.generationCounts,
    });
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
        include: {
          cases: true,
          generation: { select: { id: true, coveragePlanJson: true } },
        },
      });
      if (!existing) return res.status(404).json({ success: false, code: 'SCENARIO_NOT_FOUND' });
      const regenerateBlock = mutationBlockedPayload(existing.generation, 'regenerate one scenario');
      if (regenerateBlock) return res.status(409).json(regenerateBlock);
      const targetModule = existing.module;
      const rollbackSnapshot = scenarioRollbackPayload(existing);
      const { guidanceId, operationId } = req.body || {};
      const authoringBase = {
        operationId: operationId || `scenario:${existing.id}`,
        scope: 'scenario',
        action: guidanceId ? 'refine' : 'regenerate',
        scenarioId: existing.id,
        scenarioName: existing.name,
        scenarioLabel: req.body?.scenarioLabel || null,
        caseCount: Number(req.body?.caseCount || 0) || null,
      };
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'context',
        progress: 5,
        message: 'Loading scenario context and AI settings.',
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
        authoringProgress(req, {
          ...authoringBase,
          status: 'error',
          phase: 'requirements',
          progress: 100,
          message: 'No requirements are available for this scenario.',
        });
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
      const savedGuidance = await generationGuidance.loadGuidance(prisma, { projectId: project.id, guidanceId });
      const onProgress = (info = {}) => authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'claude_stream',
        progress: Math.min(72, 28 + Math.min(info.scenariosSoFar || 0, 6) * 6),
        message: info.scenariosSoFar
          ? `Claude is drafting replacement scenario content (${info.scenariosSoFar} candidate${info.scenariosSoFar === 1 ? '' : 's'} seen).`
          : 'Claude is drafting replacement scenario content.',
        scenariosSoFar: info.scenariosSoFar || 0,
        charsSoFar: info.charsSoFar || 0,
      });
      const guidanceBlock = generationGuidance.guidancePromptBlock(savedGuidance, {
        scope: 'scenario',
        subject: existing.name,
      });
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'context',
        progress: 16,
        message: savedGuidance ? 'Applying your refinement guidance.' : 'Preparing scoped requirements and site context.',
      });

      // Atlas (same as the full-generate path): prose context for the LLM +
      // structured atlas for the deterministic grounding gate below.
      let calibrationContext = null;
      let calibrationAtlas = null;
      try {
        const { getCalibrationContext, getCalibrationAtlas } = require('../services/agents/calibrator');
        calibrationContext = await getCalibrationContext(project.id);
        calibrationAtlas = await getCalibrationAtlas(project.id);
      } catch (_) { /* no atlas */ }

      // P2-integration — requirement clauses for traceability, scoped to the
      // target module. Refs are attached + validated; the project-wide RTM is
      // built only on full /generate (a single-scenario regen must not emit
      // whole-project "uncovered" findings).
      let clausePrep = { requirementClauses: [], contextMode: 'additive', knownModules: [targetModule] };
      try {
        clausePrep = await require('../services/requirementOracle').prepareArchitectClauses({
          prisma, projectId: project.id, providerName: provider, apiKey, model, knownModules: [targetModule],
          send: (e) => broadcast && broadcast(req.user.id, e), log: console,
        });
      } catch (e) { console.warn(`${TAG} requirement oracle prep failed (non-fatal):`, e.message); }

      const cancelToken = cancelRegistry.create(req.user.id);
      let result;
      let generationTestDataBundle = null;
      let coveragePlan = null;
      let coverageResult = null;
      try {
        // TestData M-C — mapped test data (null when none → Architect unchanged).
        generationTestDataBundle = await require('../services/testDataGenerationContract').loadGenerationTestDataContract({
          projectId: project.id,
          moduleScope: targetModule,
          preferApproved: true,
        });
        const testData = generationTestDataBundle.testData;
        coveragePlan = coveragePlanner.buildCoveragePlanManifest({
          requirements: requirementsForPrompt,
          requirementClauses: clausePrep.requirementClauses,
          testData,
          calibrationAtlas,
          moduleScope: targetModule,
        });
        coveragePlan = sliceCoverageManifestForScenario(coveragePlan, existing);
        authoringProgress(req, {
          ...authoringBase,
          status: 'running',
          phase: 'prompting',
          progress: 24,
          message: `Sending ${requirementsForPrompt.length} requirement source${requirementsForPrompt.length === 1 ? '' : 's'} to ${provider}.`,
        });
        result = await architect.run({
          apiKey,
          model,
          provider,
          requirements: requirementsForPrompt,
          onLog,
          onProgress,
          signal: cancelToken.signal,
          extraGuidance: guidanceBlock,
          siteContext: calibrationContext,
          testData,
          requirementClauses: clausePrep.requirementClauses,
          contextMode: clausePrep.contextMode,
          knownModules: clausePrep.knownModules,
          capabilities: calibrationAtlas ? (calibrationAtlas.capabilities || []) : [],
          module: targetModule,
          coveragePlan,
          projectId: project.id,
          calibrationAtlas,
          // Per-scenario regen keeps only ONE scenario (filtered below) — tell the
          // architect to draft a small set and skip the coverage top-up loop, so
          // this stays a fast single call instead of generating the whole module
          // (the ~360s "Update failed" cause).
          singleScenario: true,
        });
      } catch (err) {
        cancelRegistry.clear(req.user.id);
        const cancelled = err.code === 'CANCELLED' || cancelToken.cancelled;
        authoringProgress(req, {
          ...authoringBase,
          status: cancelled ? 'cancelled' : 'error',
          phase: cancelled ? 'cancelled' : 'claude_stream',
          progress: 100,
          message: cancelled ? 'Regeneration was cancelled.' : cleanAgentError(err.message),
        });
        send('agent.phase.complete', { phase: 'architect', error: cancelled ? 'cancelled' : cleanAgentError(err.message), cancelled, projectId: project.id });
        if (cancelled) return res.status(499).json({ success: false, code: 'CANCELLED', message: 'Regeneration cancelled by user.' });
        return res.status(err.status || 502).json({ success: false, code: err.code || 'AGENT_FAILED', message: err.message });
      }
      cancelRegistry.clear(req.user.id);

      // Keep only the scenario(s) whose module matches the target. Architect
      // returns up to 12 scenarios from the requirement set — for a scoped
      // regen we discard everything outside the target module so we replace
      // exactly one slot, not 12.
      const moduleScenarios = (result.scenarios || []).filter((s) => (s.module || '').toLowerCase() === moduleLower);
      const replacementPool = moduleScenarios.length ? moduleScenarios : (result.scenarios || []);
      const replacements = replacementPool
        .slice()
        .sort((a, b) => scenarioMatchScore(b, existing) - scenarioMatchScore(a, existing))
        .slice(0, 1);
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'parsing',
        progress: 78,
        message: `Parsed ${replacements.length} replacement scenario${replacements.length === 1 ? '' : 's'} for ${targetModule}.`,
      });
      if (!replacements.length) {
        authoringProgress(req, {
          ...authoringBase,
          status: 'error',
          phase: 'parsing',
          progress: 100,
          message: 'Claude returned no replacement scenarios for this module.',
        });
        return res.status(502).json({
          success: false, code: 'EMPTY_OUTPUT',
          message: 'Architect produced no scenarios for this module. Try regenerating the full suite or refining the BRD.',
        });
      }

      coverageResult = await finalizeCoverage({
        manifest: coveragePlan,
        scenarios: replacements,
        testData: generationTestDataBundle && generationTestDataBundle.testData,
        projectId: project.id,
        generationId: existing.generationId || null,
        idempotencyKey: `scenario-reliability:${project.id}:${existing.id}:regen:${Date.now()}`,
        calibrationAtlas,
        targetUrl: project.targetUrl,
        authRole: existing.authProfile || null,
      });
      {
        const selfHeal = await runGenerationSelfHealingPipeline({
          generationId: existing.generationId || null,
          scenarios: coverageResult.scenarios || replacements,
          manifest: coveragePlan,
          testData: generationTestDataBundle && generationTestDataBundle.testData,
          context: {
            targetUrl: project.targetUrl,
            authRole: existing.authProfile || null,
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
        replacements.splice(0, replacements.length, ...(selfHeal.scenarios || []));
      }

      // Replace the old scenario + its cases atomically.
      authoringProgress(req, {
        ...authoringBase,
        status: 'running',
        phase: 'persisting',
        progress: 84,
        message: 'Replacing the old scenario and saving regenerated test cases.',
      });
      const created = [];
      const pendingDeps = [];
      const enforceApprovedTestData = !!(generationTestDataBundle
        && generationTestDataBundle.source === 'approved'
        && generationTestDataBundle.contract
        && generationTestDataBundle.contract.strict);
      let postPersistVerification = null;
      const replacementPersistenceRows = normalizeScenarioPersistenceBatch(replacements);
      await prisma.$transaction(async (tx) => {
      await tx.testScenario.deleteMany({ where: { id: existing.id, projectId: project.id } });
      for (const persistenceRow of replacementPersistenceRows) {
        const s = persistenceRow.scenario;
        const scenario = await tx.testScenario.create({
          data: buildScenarioCreateData({
            scenario: s,
            metadata: persistenceRow.metadata,
            projectId: project.id,
            // In-place single-scenario regen stays in the SAME generation as
            // the scenario it replaces — it's an edit, not a new version.
            generationId: existing.generationId || null,
          }),
        });
        // Enterprise Mode P1 — canonical contract writer (same path as the full
        // generate). Keeps regenerate-one from drifting from the primary path.
        const persisted = await canonicalGenerationPipeline.persistCases({
          prisma: tx,
          projectId: project.id,
          scenarioId: scenario.id,
          generationId: existing.generationId || null,
          moduleName: persistenceRow.metadata.module,
          cases: s.cases,
          calibrationAtlas,
          approvedTestData: enforceApprovedTestData && generationTestDataBundle && generationTestDataBundle.testData ? generationTestDataBundle.testData : null,
          requireApprovedMapping: enforceApprovedTestData,
          enterpriseMode: enforceApprovedTestData,
          log: console,
          tag: TAG,
        });
        for (const p of persisted) {
          if (p.dependsOnNames && p.dependsOnNames.length) pendingDeps.push({ caseId: p.tc.id, dependsOnNames: p.dependsOnNames });
        }
        const cases = persisted.map((p) => ({ ...p.tc, steps: p.source.steps || [] }));
        created.push({ ...inflateScenario(scenario), cases });
      }
      if (pendingDeps.length) {
        const depsByCaseId = new Map(pendingDeps.map((row) => [row.caseId, row.dependsOnNames]));
        const allCases = created.flatMap((sc) => sc.cases || []);
        for (const tc of allCases) tc.dependsOnNames = depsByCaseId.get(tc.id) || [];
        await canonicalGenerationPipeline.resolveNamedDependenciesForCases({
          prisma: tx,
          projectId: project.id,
          cases: allCases,
        });
      }
      if (existing.generationId) {
        await syncScenarioGenerationCounts(tx, {
          projectId: project.id,
          generationId: existing.generationId,
        });
        try {
          postPersistVerification = await verifyPersistedGenerationContract({ prisma: tx, generationId: existing.generationId });
          if (coverageResult && coverageResult.reliabilityReport) {
            coverageResult.reliabilityReport.postPersistVerification = postPersistVerification;
          }
        } catch (verifyErr) {
          postPersistVerification = {
            ok: false,
            generationId: existing.generationId,
            defects: [{ code: 'post_persist_verification_failed', message: verifyErr.message }],
          };
          if (coverageResult && coverageResult.reliabilityReport) {
            coverageResult.reliabilityReport.postPersistVerification = postPersistVerification;
          }
          console.warn(`${TAG} post-persist contract verification failed:`, verifyErr.message);
        }
      }
      if (postPersistVerification && postPersistVerification.ok === false) {
        const defectSummary = summarizePostPersistDefects(postPersistVerification, 6)
          .map((defect) => `${defect.code}${defect.caseId ? `@${defect.caseId}` : ''}`)
          .join(', ');
        const contractErr = new Error(`Post-persist contract verification failed for targeted regeneration: ${defectSummary || 'unknown defect'}; original scenario was kept.`);
        contractErr.code = 'POST_PERSIST_CONTRACT_FAILED';
        contractErr.status = 422;
        contractErr.postPersistVerification = postPersistVerification;
        throw contractErr;
      }
      }, { timeout: 120_000, maxWait: 15_000 });
      await writeGenerationCoverage(prisma, existing.generationId, {
        manifest: coveragePlan,
        validation: coverageResult && coverageResult.validation,
        repair: coverageResult && coverageResult.repair,
        reliabilityReport: coverageResult && coverageResult.reliabilityReport,
      });

      authoringProgress(req, {
        ...authoringBase,
        status: 'done',
        phase: 'complete',
        progress: 100,
        message: `Saved ${created.length} scenario${created.length === 1 ? '' : 's'} with ${created.reduce((a, s) => a + s.cases.length, 0)} test case${created.reduce((a, s) => a + s.cases.length, 0) === 1 ? '' : 's'}.`,
        newScenarioIds: created.map((s) => s.id),
        scenarios: created.map((s) => ({
          id: s.id,
          name: s.name,
          scenarioLabel: s.scenarioLabel || null,
          caseCount: Array.isArray(s.cases) ? s.cases.length : 0,
        })),
      });

      send('agent.phase.complete', { phase: 'architect', output: { scenarios: created.length, cases: created.reduce((a, s) => a + s.cases.length, 0), scoped: targetModule, coverageSummary: coverageResult && coverageResult.summary }, projectId: project.id });
      await generationGuidance.markApplied(prisma, savedGuidance?.id, {
        appliedScenarioId: created[0]?.id || null,
        appliedGenerationId: existing.generationId || null,
      });

      await audit.log({
        userId: req.user.id, action: 'agents.architect.regenerate-one',
        target: project.id,
        metadata: {
          module: targetModule,
          replaced: existing.id,
          scenarios: created.length,
          replacementScenarioIds: created.map((s) => s.id),
          rollbackSnapshot,
        },
        req,
      });

      res.json({
        success: true,
        scenarios: created,
        scoped: targetModule,
        coverageSummary: coverageResult && coverageResult.summary,
        reliabilityReport: coverageResult && coverageResult.reliabilityReport,
      });
    } catch (err) {
      console.error(`${TAG} ERROR:`, err.message);
      authoringProgress(req, {
        operationId: req.body?.operationId || `scenario:${req.params.id}`,
        scope: 'scenario',
        action: req.body?.guidanceId ? 'refine' : 'regenerate',
        scenarioId: req.params.id,
        status: 'error',
        phase: 'error',
        progress: 100,
        message: err.message || 'Regeneration failed.',
      });
      if (!res.headersSent) {
        return res.status(err.status || 500).json({ success: false, code: err.code || 'REGEN_FAILED', message: err.message });
      }
      next(err);
    }
  }
);

// Restores the previous scenario version captured by the latest targeted
// regenerate/refine audit snapshot.
router.post('/:id/restore-latest', requireCsrf, rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
  try {
    const project = await getProject(req);
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const current = await prisma.testScenario.findFirst({
      where: { id: req.params.id, projectId: project.id },
      include: {
        cases: true,
        generation: { select: { id: true, coveragePlanJson: true } },
      },
    });
    if (!current) return res.status(404).json({ success: false, code: 'SCENARIO_NOT_FOUND' });
    const restoreBlock = mutationBlockedPayload(current.generation, 'restore a scenario snapshot');
    if (restoreBlock) return res.status(409).json(restoreBlock);

    const logs = await prisma.auditLog.findMany({
      where: { action: 'agents.architect.regenerate-one', target: project.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const restoreLog = logs.find((row) => {
      const meta = parseAuditMetadata(row);
      const replacementIds = Array.isArray(meta.replacementScenarioIds) ? meta.replacementScenarioIds : [];
      return meta.rollbackSnapshot && replacementIds.includes(req.params.id);
    });
    const meta = parseAuditMetadata(restoreLog);
    const snapshot = meta.rollbackSnapshot;
    if (!snapshot) {
      return res.status(404).json({
        success: false,
        code: 'NO_RESTORE_POINT',
        message: 'No previous version is available for this scenario yet.',
      });
    }

    const replacementIds = Array.isArray(meta.replacementScenarioIds) && meta.replacementScenarioIds.length
      ? meta.replacementScenarioIds
      : [req.params.id];
    const restored = await prisma.$transaction(async (tx) => {
      await tx.testCase.deleteMany({ where: { projectId: project.id, scenarioId: { in: replacementIds } } });
      await tx.testScenario.deleteMany({ where: { projectId: project.id, id: { in: replacementIds } } });
      const scenario = await tx.testScenario.upsert({
        where: { id: snapshot.id },
        update: scenarioRestoreData(snapshot, project.id),
        create: { id: snapshot.id, ...scenarioRestoreData(snapshot, project.id) },
      });
      const cases = [];
      for (const c of snapshot.cases || []) {
        const tc = await tx.testCase.upsert({
          where: { id: c.id },
          update: testCaseRestoreData(c, project.id, scenario.id),
          create: { id: c.id, ...testCaseRestoreData(c, project.id, scenario.id) },
        });
        cases.push({ ...tc, steps: decodeJson(tc.steps, []) || [] });
      }
      if (current.generation?.id) {
        await syncScenarioGenerationCounts(tx, {
          projectId: project.id,
          generationId: current.generation.id,
        });
      }
      return { ...inflateScenario(scenario), cases };
    });

    await audit.log({
      userId: req.user.id,
      action: 'agents.architect.restore-one',
      target: project.id,
      metadata: {
        restoredScenarioId: restored.id,
        restoredFromAuditLogId: restoreLog.id,
        replacedScenarioIds: replacementIds,
      },
      req,
    });
    res.json({ success: true, scenario: restored });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
