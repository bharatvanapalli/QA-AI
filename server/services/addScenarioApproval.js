'use strict';

const crypto = require('node:crypto');
const { buildAppendScenarioRequest } = require('./appendScenarioRequest');
const { buildCaseContractPlanningBridge } = require('./caseContractPlanningBridge');
const testDesignPlanV1 = require('./testDesignPlanV1');
const testDesignStepCompiler = require('./testDesignStepCompiler');
const caseContractSemanticValidator = require('./caseContractSemanticValidator');
const architect = require('./agents/architect');
const canonicalGenerationPipeline = require('./canonicalGenerationPipeline');
const {
  normalizeScenarioPersistenceBatch,
  buildScenarioCreateData,
} = require('./scenarioPersistenceContract');
const { syncScenarioGenerationCounts } = require('./scenarioGenerationCounts');
const { encodeJson, decodeJson } = require('./jsonField');

const APPROVAL_LEDGER_VERSION = 'AddScenarioApprovalLedgerV1';
const MAX_TRANSACTION_ATTEMPTS = 2;
const APPROVAL_RECONCILIATION_TIMEOUT_MS = 3_000;
const APPROVAL_RECONCILIATION_POLL_MS = 25;

class AddScenarioApprovalError extends Error {
  constructor(message, { code = 'ADD_SCENARIO_APPROVAL_FAILED', status = 422, details = {} } = {}) {
    super(message);
    this.name = 'AddScenarioApprovalError';
    this.code = code;
    this.status = status;
    Object.assign(this, details);
  }
}

function clean(value, max = 1_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

function approvalKey({ projectId, draftId, revision }) {
  return `approval.${digest({ projectId, draftId, revision }).slice(0, 32)}`;
}

function error(message, code, status, details = {}) {
  return new AddScenarioApprovalError(message, { code, status, details });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reconcileConcurrentApproval({ registry, userId, projectId, draftId }) {
  const deadline = Date.now() + APPROVAL_RECONCILIATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await delay(APPROVAL_RECONCILIATION_POLL_MS);
    const lookup = registry.get({ userId, projectId, draftId });
    if (!lookup.ok) throw error(lookup.message, lookup.code, lookup.status, lookup);
    const approval = lookup.draft && lookup.draft.approval;
    if (approval && approval.status === 'completed' && approval.result) return clone(approval.result);
    if (!approval || approval.status !== 'approving') break;
  }
  throw error(
    'The same draft is still being approved. Retry this approval request.',
    'ADD_SCENARIO_DRAFT_APPROVAL_IN_PROGRESS',
    409,
    { retryable: true },
  );
}

function semanticEnvelope(draft) {
  const plan = draft && draft.semanticPlan;
  return plan && (plan.caseContractV1 || plan.envelope) || null;
}

function dedupeContracts(rows) {
  const output = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const key = clean(row.planId || row.revision || row.contractId || row.catalogId) || digest(row);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clone(row));
  }
  return output;
}

function mergeApprovalManifest(existingManifest, appendManifest, plan, ledger) {
  const existing = existingManifest && typeof existingManifest === 'object' ? existingManifest : {};
  const appended = appendManifest && typeof appendManifest === 'object' ? appendManifest : {};
  const history = existing.contractHistory && typeof existing.contractHistory === 'object'
    ? existing.contractHistory : {};
  return {
    ...clone(existing),
    ...clone(appended),
    testDesignPlanV1: clone(plan),
    contractHistory: {
      ...clone(history),
      testDesignPlanV1: dedupeContracts([
        ...(Array.isArray(history.testDesignPlanV1) ? history.testDesignPlanV1 : []),
        existing.testDesignPlanV1,
        plan,
      ]),
    },
    addScenarioApprovalLedger: clone(ledger),
    appendBaseRevision: existing.revision || existing.manifestId || null,
  };
}

function ledgerOf(manifest) {
  const current = manifest && manifest.addScenarioApprovalLedger;
  return {
    version: APPROVAL_LEDGER_VERSION,
    entries: current && current.entries && typeof current.entries === 'object'
      ? clone(current.entries) : {},
  };
}

function authoritativeSourceOfDraft(draft) {
  return draft && draft.semanticPlan && typeof draft.semanticPlan.authoritativeSourceText === 'string'
    && draft.semanticPlan.authoritativeSourceText.trim()
    ? draft.semanticPlan.authoritativeSourceText
    : draft && draft.originalSource || '';
}

function blockingApprovalDiagnostics(draft) {
  const diagnostics = draft && draft.semanticPlan && Array.isArray(draft.semanticPlan.approvalDiagnostics)
    ? draft.semanticPlan.approvalDiagnostics
    : [];
  return diagnostics.filter((finding) => {
    const severity = clean(finding && finding.severity, 50).toLowerCase();
    return ['error', 'blocking', 'fatal'].includes(severity)
      || finding && finding.blocking === true
      || finding && finding.requiresClarification === true;
  });
}

function validateApprovalEnvelope(envelope, authoritativeSource) {
  const validation = caseContractSemanticValidator.validateSemanticCaseContract(envelope, {
    sourceText: authoritativeSource,
    maxSteps: 100,
  });
  if (validation.ok !== true || !validation.contract) {
    throw error(
      'The approved semantic contract is structurally invalid.',
      'ADD_SCENARIO_APPROVAL_CONTRACT_INVALID',
      422,
      { findings: clone(validation.findings || []) },
    );
  }
  return validation.contract;
}

function compileStrict({ plan, candidateScenarios, envelope, authoritativeSource }) {
  const compiled = testDesignStepCompiler.compileCandidateSuite({
    testDesignPlan: plan,
    candidateScenarios,
    proceduralFlowContract: {
      isProcedural: true,
      caseContractV1: envelope,
      sourceText: authoritativeSource,
    },
  });
  if (!compiled || !Array.isArray(compiled.scenarios) || compiled.scenarios.length === 0) {
    throw new testDesignStepCompiler.TestDesignStepCompilationError(
      'Strict compilation produced no executable scenarios.',
      [{ code: 'test_design_compilation_empty', severity: 'error' }],
    );
  }
  return compiled;
}

function buildPlanAuthorityRepairScenarios(plan) {
  const validation = testDesignPlanV1.validateTestDesignPlanV1(plan);
  if (validation.ok !== true) {
    throw error(
      'The immutable plan cannot authorize deterministic repair.',
      'ADD_SCENARIO_APPROVAL_REPAIR_INVALID',
      422,
      { repairFindings: clone(validation.findings || []) },
    );
  }

  return plan.scenarios.map((scenarioPlan) => ({
    planScenarioId: scenarioPlan.planScenarioId,
    name: scenarioPlan.intent || 'Approved Add Scenario',
    intent: scenarioPlan.intent,
    module: scenarioPlan.module,
    requirementRefs: clone(scenarioPlan.requirementRefs || []),
    cases: (Array.isArray(scenarioPlan.cases) ? scenarioPlan.cases : []).map((casePlan) => {
      const authority = casePlan.caseContractV1;
      if (!authority || !Array.isArray(authority.steps) || !authority.steps.length) {
        throw error(
          'A planned case has no CaseContractV1 execution authority.',
          'ADD_SCENARIO_APPROVAL_REPAIR_INVALID',
          422,
          {
            planCaseId: casePlan.planCaseId,
            repairFindings: [{ code: 'test_design_case_contract_missing', severity: 'error' }],
          },
        );
      }
      return {
        id: authority.id || casePlan.planCaseId,
        planCaseId: casePlan.planCaseId,
        name: authority.name || casePlan.intent,
        module: casePlan.module,
        caseContractV1: clone(authority),
        steps: clone(authority.steps),
        oracles: clone(casePlan.oracles || []),
      };
    }),
  }));
}

function compileApprovedDraft({ projectId, draft, existingManifest }) {
  const approvalDiagnostics = blockingApprovalDiagnostics(draft);
  if (approvalDiagnostics.length) {
    throw error(
      'The reviewed interpretation still contains blocking approval diagnostics.',
      'ADD_SCENARIO_APPROVAL_DIAGNOSTICS_INVALID',
      422,
      { findings: clone(approvalDiagnostics) },
    );
  }
  const registeredEnvelope = semanticEnvelope(draft);
  const authoritativeSource = authoritativeSourceOfDraft(draft);
  const envelope = validateApprovalEnvelope(registeredEnvelope, authoritativeSource);
  if (!envelope || !Array.isArray(envelope.cases) || envelope.cases.length === 0) {
    throw error('The registered draft has no executable CaseContractV1 cases.', 'ADD_SCENARIO_APPROVAL_CONTRACT_INVALID', 422);
  }
  const appendRequest = buildAppendScenarioRequest(
    { id: projectId },
    { appendToCurrent: true, sessionGuidance: authoritativeSource },
  );
  if (!appendRequest.requirement || !appendRequest.requirementClause) {
    throw error('The registered draft source could not be reconstructed.', 'ADD_SCENARIO_APPROVAL_SOURCE_INVALID', 422);
  }
  const buildArtifacts = (caseContractEnvelope, reason) => {
    const bridged = buildCaseContractPlanningBridge({
      caseContractEnvelope,
      coverageManifest: existingManifest || {},
      caseContractPacks: [],
    });
    const plan = testDesignPlanV1.buildTestDesignPlanV1({
      coverageManifest: bridged.coverageManifest,
      caseContractPacks: bridged.caseContractPacks,
      requirements: [appendRequest.requirement],
      requirementClauses: [appendRequest.requirementClause],
      scope: { projectId, requirementIds: [appendRequest.requirement.id] },
    });
    const casePlanByCoverageRef = new Map(plan.scenarios
      .flatMap((scenario) => Array.isArray(scenario.cases) ? scenario.cases : [])
      .map((casePlan) => [casePlan.coverageRef, casePlan]));
    const scenarios = bridged.caseContractPacks.map((pack) => {
      const casePlan = casePlanByCoverageRef.get(pack.coverageRef);
      if (!casePlan) {
        throw error('The immutable plan did not retain an authored case.', 'ADD_SCENARIO_APPROVAL_PLAN_CASE_MISSING', 422, {
          coverageRef: pack.coverageRef,
        });
      }
      return architect.deterministicScenarioFromPack({
        ...pack,
        planCaseId: casePlan.planCaseId,
      }, reason);
    }).filter((scenario) => scenario && Array.isArray(scenario.cases) && scenario.cases.length > 0);
    if (!scenarios.length) {
      throw error('The approved draft contains no executable scenarios.', 'ADD_SCENARIO_APPROVAL_EMPTY', 422);
    }
    return { caseContractEnvelope, bridged, plan, scenarios };
  };

  const artifacts = buildArtifacts(envelope, 'approved_add_scenario_preview');
  let compiled;
  try {
    compiled = compileStrict({
      plan: artifacts.plan,
      candidateScenarios: artifacts.scenarios,
      envelope: artifacts.caseContractEnvelope,
      authoritativeSource,
    });
  } catch (compilerError) {
    if (!compilerError || compilerError.code !== testDesignStepCompiler.COMPILATION_ERROR_CODE) {
      throw compilerError;
    }
    const originalFindings = clone(
      compilerError && compilerError.findings
      || compilerError && compilerError.report && compilerError.report.findings
      || [],
    );
    try {
      compiled = compileStrict({
        plan: artifacts.plan,
        candidateScenarios: buildPlanAuthorityRepairScenarios(artifacts.plan),
        envelope: artifacts.caseContractEnvelope,
        authoritativeSource,
      });
      compiled.report = {
        ...(compiled.report || {}),
        repairedBeforePersistence: true,
        repairSource: 'immutable_test_design_plan_case_contract_v1',
        originalFindings,
      };
    } catch (repairError) {
      if (repairError instanceof AddScenarioApprovalError) throw repairError;
      throw error(
        'The approved case remains structurally invalid after deterministic repair.',
        'ADD_SCENARIO_APPROVAL_REPAIR_FAILED',
        422,
        {
          originalFindings,
          repairCode: clean(repairError && repairError.code, 200) || 'TEST_DESIGN_STEP_COMPILATION_FAILED',
          repairMessage: clean(repairError && repairError.message, 2_000) || 'Strict recompilation failed.',
          repairFindings: clone(
            repairError && repairError.findings
            || repairError && repairError.report && repairError.report.findings
            || [],
          ),
        },
      );
    }
  }
  return {
    plan: artifacts.plan,
    scenarios: compiled.scenarios,
    coverageManifest: artifacts.bridged.coverageManifest,
    compilerReport: compiled.report,
  };
}

function validateDraftAuthority(draft, input) {
  if (!draft || draft.revision !== input.revision) {
    throw error('The Add Scenario draft revision is stale.', 'ADD_SCENARIO_DRAFT_REVISION_STALE', 409, {
      currentRevision: draft && draft.revision || null,
    });
  }
  if (draft.sourceDigest !== input.sourceDigest) {
    throw error('The Add Scenario source digest changed.', 'ADD_SCENARIO_DRAFT_SOURCE_CONFLICT', 409);
  }
  if ((draft.currentGenerationId || null) !== (input.generationId || null)) {
    throw error('The current generation changed before approval.', 'ADD_SCENARIO_DRAFT_GENERATION_STALE', 409);
  }
  const preview = draft.preview;
  const blockingQuestions = preview && preview.clarifications && Array.isArray(preview.clarifications.questions)
    ? preview.clarifications.questions : [];
  const blockingFindings = preview && preview.clarifications && Array.isArray(preview.clarifications.findings)
    ? preview.clarifications.findings : [];
  if (!preview || preview.approvalEligible !== true || blockingQuestions.length || blockingFindings.length) {
    throw error('The draft still has blocking review items.', 'ADD_SCENARIO_APPROVAL_NOT_ELIGIBLE', 422);
  }
}

function replayResult(entry) {
  return {
    success: true,
    persisted: true,
    replayed: true,
    draftId: entry.draftId,
    revision: entry.revision,
    sourceDigest: entry.sourceDigest,
    generationId: entry.generationId,
    scenarioIds: clone(entry.scenarioIds || []),
    caseIds: clone(entry.caseIds || []),
    scenarioCountCreated: Number(entry.scenarioCountCreated) || 0,
    caseCountCreated: Number(entry.caseCountCreated) || 0,
  };
}

async function loadDurableApprovalReplay({ prisma, projectId, draftId, revision, sourceDigest }) {
  if (!prisma.scenarioGeneration || typeof prisma.scenarioGeneration.findFirst !== 'function') return null;
  const generation = await prisma.scenarioGeneration.findFirst({
    where: { projectId, isCurrent: true },
    orderBy: { version: 'desc' },
    select: { id: true, coveragePlanJson: true },
  });
  if (!generation) return null;
  const manifest = decodeJson(generation.coveragePlanJson, {}) || {};
  const entry = ledgerOf(manifest).entries[approvalKey({ projectId, draftId, revision })];
  if (!entry || entry.status !== 'persisted') return null;
  if (entry.draftId !== draftId
    || entry.revision !== revision
    || entry.sourceDigest !== sourceDigest
    || entry.generationId !== generation.id) {
    throw error('The persisted approval authority does not match this request.', 'ADD_SCENARIO_DRAFT_AUTHORITY_MISMATCH', 409);
  }
  return replayResult(entry);
}

async function persistApprovalTransaction({ prisma, projectId, draft, input, dependencies }) {
  const approvalId = approvalKey({ projectId, draftId: draft.draftId, revision: draft.revision });
  return prisma.$transaction(async (tx) => {
    const generation = await tx.scenarioGeneration.findFirst({
      where: { projectId, isCurrent: true },
      orderBy: { version: 'desc' },
      select: { id: true, projectId: true, isCurrent: true, coveragePlanJson: true },
    });
    if (!generation) {
      throw error('The current generation changed before approval.', 'ADD_SCENARIO_DRAFT_GENERATION_STALE', 409);
    }
    const originalCoverage = generation.coveragePlanJson;
    const existingManifest = decodeJson(originalCoverage, {}) || {};
    const currentLedger = ledgerOf(existingManifest);
    const completed = currentLedger.entries[approvalId];
    if (completed && completed.status === 'persisted') return replayResult(completed);

    const compiled = dependencies.compileApprovedDraft({ projectId, draft, existingManifest });
    const rows = normalizeScenarioPersistenceBatch(compiled.scenarios, { source: 'add_scenario' });
    const pendingEntry = {
      approvalId,
      draftId: draft.draftId,
      previewId: draft.previewId,
      revision: draft.revision,
      sourceDigest: draft.sourceDigest,
      generationId: generation.id,
      status: 'persisting',
      compilerDiagnostics: clone(compiled.compilerReport || null),
    };
    const pendingLedger = {
      ...currentLedger,
      entries: { ...currentLedger.entries, [approvalId]: pendingEntry },
    };
    const pendingManifest = mergeApprovalManifest(
      existingManifest,
      compiled.coverageManifest,
      compiled.plan,
      pendingLedger,
    );
    const pendingCoverage = encodeJson(pendingManifest);
    const claim = await tx.scenarioGeneration.updateMany({
      where: { id: generation.id, projectId, isCurrent: true, coveragePlanJson: originalCoverage },
      data: { coveragePlanJson: pendingCoverage },
    });
    if (Number(claim && claim.count) !== 1) {
      throw error('Another approval changed this generation.', 'ADD_SCENARIO_APPROVAL_CAS_CONFLICT', 409);
    }

    const scenarioIds = [];
    const caseIds = [];
    const persistedRows = [];
    for (const row of rows) {
      const scenario = await tx.testScenario.create({
        data: buildScenarioCreateData({
          scenario: row.scenario,
          metadata: row.metadata,
          projectId,
          generationId: generation.id,
          source: 'add_scenario',
        }),
      });
      scenarioIds.push(scenario.id);
      const persisted = await dependencies.persistCases({
        prisma: tx,
        projectId,
        scenarioId: scenario.id,
        generationId: generation.id,
        testDesignPlanAuthority: compiled.plan,
        allowExplicitApprovalLineageOverride: false,
        moduleName: row.metadata.module,
        cases: row.scenario.cases,
        calibrationAtlas: null,
        approvedTestData: null,
        requireApprovedMapping: false,
        enterpriseMode: false,
        authProfileName: null,
        log: console,
        tag: '[add-scenario-approval]',
      });
      for (const persistedCase of persisted) {
        if (persistedCase && persistedCase.tc && persistedCase.tc.id) caseIds.push(persistedCase.tc.id);
      }
      persistedRows.push(...persisted);
    }
    if (!scenarioIds.length || !caseIds.length) {
      throw error('Approval produced no persisted cases.', 'ADD_SCENARIO_APPROVAL_EMPTY', 422);
    }
    const pendingDependencies = persistedRows.filter((row) => Array.isArray(row && row.dependsOnNames) && row.dependsOnNames.length);
    if (pendingDependencies.length) {
      await dependencies.resolveNamedDependenciesForCases({
        prisma: tx,
        projectId,
        cases: persistedRows.map((row) => row.tc),
      });
    }
    const counts = await dependencies.syncScenarioGenerationCounts(tx, {
      projectId,
      generationId: generation.id,
    });
    const completedEntry = {
      ...pendingEntry,
      status: 'persisted',
      scenarioIds,
      caseIds,
      scenarioCountCreated: scenarioIds.length,
      caseCountCreated: caseIds.length,
      generationScenarioCount: counts.scenarioCount,
      generationCaseCount: counts.caseCount,
    };
    const completedLedger = {
      ...pendingLedger,
      entries: { ...pendingLedger.entries, [approvalId]: completedEntry },
    };
    const completedManifest = mergeApprovalManifest(
      pendingManifest,
      compiled.coverageManifest,
      compiled.plan,
      completedLedger,
    );
    const finalized = await tx.scenarioGeneration.updateMany({
      where: { id: generation.id, projectId, isCurrent: true, coveragePlanJson: pendingCoverage },
      data: { coveragePlanJson: encodeJson(completedManifest) },
    });
    if (Number(finalized && finalized.count) !== 1) {
      throw error('The approval ledger could not be finalized.', 'ADD_SCENARIO_APPROVAL_CAS_CONFLICT', 409);
    }
    return replayResult(completedEntry);
  }, { timeout: 120_000, maxWait: 15_000 });
}

async function approveRegisteredAddScenarioDraft(input = {}, dependencies = {}) {
  const prisma = dependencies.prisma;
  const registry = dependencies.registry;
  const userId = clean(input.userId, 500);
  const projectId = clean(input.projectId, 500);
  const draftId = clean(input.draftId, 500);
  const revision = clean(input.revision, 500);
  const sourceDigest = clean(input.sourceDigest || input.previewDigest, 500);
  if (!prisma || !registry || !userId || !projectId || !draftId || !revision || !sourceDigest) {
    throw error('Authenticated draft, revision, and digest identities are required.', 'ADD_SCENARIO_APPROVAL_REQUEST_INVALID', 400);
  }
  const lookup = registry.get({ userId, projectId, draftId });
  if (!lookup.ok) {
    const durableReplay = await loadDurableApprovalReplay({
      prisma,
      projectId,
      draftId,
      revision,
      sourceDigest,
    });
    if (durableReplay) return durableReplay;
    throw error(lookup.message, lookup.code, lookup.status);
  }
  const draft = lookup.draft;
  validateDraftAuthority(draft, {
    revision,
    sourceDigest,
    generationId: draft.currentGenerationId,
  });

  const begin = typeof registry.beginApproval === 'function'
    ? registry.beginApproval({
      userId,
      projectId,
      draftId,
      expectedRevision: revision,
      expectedGenerationId: draft.currentGenerationId,
    })
    : { ok: true, status: 200, draft };
  if (!begin.ok) throw error(begin.message, begin.code, begin.status, begin);
  if (begin.mode === 'replay' && begin.approvalResult) return clone(begin.approvalResult);
  if (begin.mode === 'in_progress') {
    return reconcileConcurrentApproval({ registry, userId, projectId, draftId });
  }
  const approvalToken = begin.approvalToken || null;

  const resolvedDependencies = {
    compileApprovedDraft: dependencies.compileApprovedDraft || compileApprovedDraft,
    persistCases: dependencies.persistCases || canonicalGenerationPipeline.persistCases,
    resolveNamedDependenciesForCases: dependencies.resolveNamedDependenciesForCases
      || canonicalGenerationPipeline.resolveNamedDependenciesForCases,
    syncScenarioGenerationCounts: dependencies.syncScenarioGenerationCounts || syncScenarioGenerationCounts,
  };
  let lastError = null;
  try {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        const result = await persistApprovalTransaction({
          prisma,
          projectId,
          draft,
          input: { revision, sourceDigest },
          dependencies: resolvedDependencies,
        });
        if (typeof registry.completeApproval === 'function') {
          const completed = registry.completeApproval({
            userId,
            projectId,
            draftId,
            expectedRevision: revision,
            expectedGenerationId: draft.currentGenerationId,
            approvalToken,
            approvalResult: result,
          });
          if (!completed.ok) throw error(completed.message, completed.code, completed.status, completed);
        }
        return result;
      } catch (caught) {
        lastError = caught;
        if (caught && caught.code === 'ADD_SCENARIO_APPROVAL_CAS_CONFLICT' && attempt < MAX_TRANSACTION_ATTEMPTS) continue;
        throw caught;
      }
    }
    throw lastError;
  } catch (caught) {
    if (typeof registry.failApproval === 'function') {
      registry.failApproval({
        userId,
        projectId,
        draftId,
        expectedRevision: revision,
        expectedGenerationId: draft.currentGenerationId,
        approvalToken,
      });
    }
    throw caught;
  }
}

module.exports = {
  APPROVAL_LEDGER_VERSION,
  AddScenarioApprovalError,
  approveRegisteredAddScenarioDraft,
  _private: {
    approvalKey,
    authoritativeSourceOfDraft,
    blockingApprovalDiagnostics,
    compileApprovedDraft,
    ledgerOf,
    loadDurableApprovalReplay,
    mergeApprovalManifest,
    persistApprovalTransaction,
    reconcileConcurrentApproval,
    validateDraftAuthority,
  },
};
