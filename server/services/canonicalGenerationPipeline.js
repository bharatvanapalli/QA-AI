'use strict';

const testCaseContract = require('./testCaseContract');
const readinessCompiler = require('./readinessCompiler');
const { encodeJson, decodeJson } = require('./jsonField');
const { verifyPersistedGenerationContract } = require('./reliability/postPersistVerification');
const { immutablePlanOf, caseLineageOf } = require('./testDesignLineageGuard');
const testDesignStepCompiler = require('./testDesignStepCompiler');

const SNAPSHOT_STAGE = Object.freeze({
  SOURCE_ARTIFACTS_COLLECTED: 'source_artifacts_collected',
  COVERAGE_MANIFEST_BUILT: 'coverage_manifest_built',
  CONTRACT_PACKS_BUILT: 'contract_packs_built',
  DRAFT_GENERATED: 'draft_generated',
  SELF_HEALED: 'self_healed',
  READINESS_COMPILED: 'readiness_compiled',
  PERSISTED: 'persisted',
  POST_PERSIST_VERIFIED: 'post_persist_verified',
});

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function compactArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const decoded = decodeJson(value, null);
  return Array.isArray(decoded) ? decoded.filter(Boolean) : [];
}

function planCaseMap(plan) {
  return new Map((Array.isArray(plan && plan.scenarios) ? plan.scenarios : [])
    .flatMap((scenario) => Array.isArray(scenario && scenario.cases) ? scenario.cases : [])
    .filter((casePlan) => casePlan && casePlan.planCaseId)
    .map((casePlan) => [casePlan.planCaseId, casePlan]));
}

function assertImmutablePlanLineage(plan, cases) {
  if (!plan || !Array.isArray(plan.scenarios) || plan.scenarios.length === 0) return;
  const planned = planCaseMap(plan);
  if (planned.size === 0) return;
  const findings = [];
  for (const candidate of Array.isArray(cases) ? cases : []) {
    const lineage = caseLineageOf(candidate && candidate.qualityContract)
      || (candidate && candidate.testDesignPlanRef)
      || null;
    if (!lineage) continue;
    const casePlan = planned.get(lineage.planCaseId);
    if (casePlan) {
      for (const [field, expected] of [
        ['planId', plan.planId],
        ['revision', plan.revision],
        ['caseRevision', casePlan.caseRevision],
      ]) {
        if (lineage[field] !== expected) {
          findings.push({
            code: 'test_design_lineage_mismatch',
            caseName: candidate && candidate.name || null,
            planCaseId: lineage.planCaseId || null,
            field,
            expected: expected || null,
            actual: lineage[field] || null,
          });
        }
      }
    }
    const stampedRevision = lineage && lineage.compiledCaseRevision;
    const topLevelRevision = candidate && candidate.compiledCaseRevision;
    if (!stampedRevision || !topLevelRevision || stampedRevision !== topLevelRevision) {
      findings.push({
        code: 'test_design_compiled_case_revision_missing',
        caseName: candidate && candidate.name || null,
        planCaseId: lineage && lineage.planCaseId || null,
        expected: stampedRevision || null,
        actual: topLevelRevision || null,
      });
      continue;
    }
    const actualRevision = testDesignStepCompiler.compiledCaseRevision(candidate);
    if (actualRevision !== stampedRevision) {
      findings.push({
        code: 'test_design_compiled_case_projection_mismatch',
        caseName: candidate && candidate.name || null,
        planCaseId: lineage && lineage.planCaseId || null,
        expected: stampedRevision,
        actual: actualRevision,
      });
    }
  }
  if (findings.length) {
    const err = new Error('Refusing to persist cases whose immutable TestDesignPlan lineage is missing or stale.');
    err.code = 'TEST_DESIGN_LINEAGE_INVALID';
    err.status = 422;
    err.findings = findings;
    throw err;
  }
}

function persistencePlanAuthority(options, generation) {
  const hasExplicitAuthority = !!(options && Object.prototype.hasOwnProperty.call(options, 'testDesignPlanAuthority'));
  if (!hasExplicitAuthority) return immutablePlanOf(generation);
  const plan = options.testDesignPlanAuthority;
  if (!plan || typeof plan !== 'object' || !plan.planId || !plan.revision || !Array.isArray(plan.scenarios)) {
    const err = new Error('The explicit TestDesignPlan persistence authority is invalid.');
    err.code = 'TEST_DESIGN_LINEAGE_AUTHORITY_INVALID';
    err.status = 422;
    throw err;
  }
  return plan;
}

async function persistCases(options) {
  const client = options && options.prisma;
  const generationId = options && options.generationId;
  if (client && generationId && client.scenarioGeneration && typeof client.scenarioGeneration.findUnique === 'function') {
    const generation = await client.scenarioGeneration.findUnique({
      where: { id: generationId },
      select: { id: true, coveragePlanJson: true },
    });
    // Normal generation persists against the plan already frozen on the
    // generation. A reviewed Add Scenario append is different: its new cases
    // were compiled against the server-built append plan that is committed by
    // the same transaction. The caller may supply that exact plan as the
    // persistence authority; the lineage checks themselves remain unchanged.
    const plan = persistencePlanAuthority(options, generation);
    const explicitApprovalOverride = options && options.allowExplicitApprovalLineageOverride === true;
    if (explicitApprovalOverride && !Object.prototype.hasOwnProperty.call(options, 'testDesignPlanAuthority')) {
      const err = new Error('An explicit approval lineage override requires a server-built TestDesignPlan authority.');
      err.code = 'TEST_DESIGN_LINEAGE_AUTHORITY_INVALID';
      err.status = 422;
      throw err;
    }
    if (plan && !explicitApprovalOverride) assertImmutablePlanLineage(plan, options.cases);
  }
  return testCaseContract.persistCases(options);
}

async function resolveNamedDependenciesForCases({ prisma, projectId, cases, workbookContract = null } = {}) {
  if (!prisma) throw new Error('resolveNamedDependenciesForCases requires prisma');
  const rows = (Array.isArray(cases) ? cases : []).filter((tc) => tc && tc.id);
  if (!rows.length) return { updated: 0, unresolved: [] };

  const knownRows = await prisma.testCase.findMany({
    where: {
      projectId,
      id: { in: rows.map((tc) => tc.id) },
    },
  });
  const byName = new Map();
  for (const tc of knownRows) {
    const key = normalizeName(tc.name);
    if (key && !byName.has(key)) byName.set(key, tc.id);
  }

  let updated = 0;
  const unresolved = [];
  for (const tc of rows) {
    const names = compactArray(tc.dependsOnNames);
    if (!names.length) {
      const compiled = readinessCompiler.compileCaseReadiness(tc, { workbookContract });
      await prisma.testCase.update({
        where: { id: tc.id },
        data: readinessCompiler.readinessUpdateData(compiled),
      }).catch(() => null);
      updated += 1;
      continue;
    }

    const ids = names.map((name) => byName.get(normalizeName(name))).filter(Boolean);
    if (ids.length !== names.length) {
      unresolved.push({
        id: tc.id,
        name: tc.name,
        dependsOnNames: names,
        resolvedIds: ids,
      });
    }
    const nextCase = { ...tc, dependsOnIds: encodeJson(ids) };
    const compiled = readinessCompiler.compileCaseReadiness(nextCase, { workbookContract });
    await prisma.testCase.update({
      where: { id: tc.id },
      data: {
        dependsOnIds: encodeJson(ids),
        ...readinessCompiler.readinessUpdateData(compiled),
      },
    });
    Object.assign(tc, { dependsOnIds: encodeJson(ids) }, readinessCompiler.readinessUpdateData(compiled));
    updated += 1;
  }
  return { updated, unresolved };
}

function ensureArrayJson(value, field) {
  const decoded = Array.isArray(value) ? value : decodeJson(value, null);
  if (!Array.isArray(decoded)) {
    const err = new Error(`Refined case ${field} must be a JSON array.`);
    err.code = 'REFINED_CASE_CONTRACT_INVALID';
    err.status = 422;
    throw err;
  }
  return encodeJson(decoded);
}

function ensureObjectJson(value, field) {
  if (value == null || value === '') return null;
  const decoded = (value && typeof value === 'object' && !Array.isArray(value)) ? value : decodeJson(value, null);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    const err = new Error(`Refined case ${field} must be a JSON object.`);
    err.code = 'REFINED_CASE_CONTRACT_INVALID';
    err.status = 422;
    throw err;
  }
  return encodeJson(decoded);
}

function normalizeRefinedCaseData(data = {}) {
  const out = { ...data };
  if (Object.prototype.hasOwnProperty.call(out, 'steps')) {
    out.steps = ensureArrayJson(out.steps, 'steps');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'declaredAssertions')) {
    out.declaredAssertions = ensureArrayJson(out.declaredAssertions, 'declaredAssertions');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'dependsOnIds')) {
    out.dependsOnIds = ensureArrayJson(out.dependsOnIds, 'dependsOnIds');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'producesData')) {
    out.producesData = out.producesData == null ? null : ensureArrayJson(out.producesData, 'producesData');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'requiresData')) {
    out.requiresData = out.requiresData == null ? null : ensureArrayJson(out.requiresData, 'requiresData');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'producesStateJson')) {
    out.producesStateJson = out.producesStateJson == null ? null : ensureArrayJson(out.producesStateJson, 'producesStateJson');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'requiresStateJson')) {
    out.requiresStateJson = out.requiresStateJson == null ? null : ensureArrayJson(out.requiresStateJson, 'requiresStateJson');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'dataBindingJson')) {
    out.dataBindingJson = ensureObjectJson(out.dataBindingJson, 'dataBindingJson');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'qualityContractJson')) {
    out.qualityContractJson = ensureObjectJson(out.qualityContractJson, 'qualityContractJson');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'rowExecutionPlanJson')) {
    out.rowExecutionPlanJson = ensureObjectJson(out.rowExecutionPlanJson, 'rowExecutionPlanJson');
  }
  if (Object.prototype.hasOwnProperty.call(out, 'skippedRowsJson')) {
    out.skippedRowsJson = out.skippedRowsJson == null ? null : ensureArrayJson(out.skippedRowsJson, 'skippedRowsJson');
  }
  return out;
}

async function persistRefinedCase({ prisma, testCaseId, data, workbookContract = null } = {}) {
  if (!prisma) throw new Error('persistRefinedCase requires prisma');
  if (!testCaseId) throw new Error('persistRefinedCase requires testCaseId');
  const persistOnce = async (client) => {
    const existing = typeof client.testCase.findUnique === 'function'
      ? await client.testCase.findUnique({ where: { id: testCaseId } })
      : null;
    if (!existing && typeof client.testCase.findUnique === 'function') {
      const err = new Error(`Test case not found: ${testCaseId}`);
      err.code = 'TEST_CASE_NOT_FOUND';
      err.status = 404;
      throw err;
    }
    if (caseLineageOf(existing)) {
      const err = new Error('Refusing to refine a case in place because it is pinned to an immutable TestDesignPlan. Create a new plan revision through full generation.');
      err.code = 'IMMUTABLE_TEST_DESIGN_REPLAN_REQUIRED';
      err.status = 409;
      throw err;
    }
    const updateData = normalizeRefinedCaseData(data);
    const candidate = { ...(existing || { id: testCaseId }), ...updateData };
    const compiled = readinessCompiler.compileCaseReadiness(candidate, { workbookContract });
    const readinessData = readinessCompiler.readinessUpdateData(compiled);
    const finalRow = await client.testCase.update({
      where: { id: testCaseId },
      data: { ...updateData, ...readinessData },
    });
    let postPersistVerification = null;
    if (finalRow && finalRow.generationId) {
      postPersistVerification = await verifyPersistedGenerationContract({
        prisma: client,
        generationId: finalRow.generationId,
      });
      if (postPersistVerification && postPersistVerification.ok === false) {
        const err = new Error('Post-persist contract verification failed for refined case; refined changes were not saved.');
        err.code = 'POST_PERSIST_CONTRACT_FAILED';
        err.status = 422;
        err.postPersistVerification = postPersistVerification;
        throw err;
      }
    }
    return {
      testCase: finalRow,
      readiness: compiled,
      postPersistVerification,
    };
  };

  if (typeof prisma.$transaction === 'function') {
    return prisma.$transaction((tx) => persistOnce(tx), { timeout: 60_000, maxWait: 15_000 });
  }
  return persistOnce(prisma);
}

async function compileAndPersistReadiness({ prisma, testCase, workbookContract = null, sourceArtifacts = null, dependencies = null } = {}) {
  if (!prisma) throw new Error('compileAndPersistReadiness requires prisma');
  const compiled = readinessCompiler.compileCaseReadiness(testCase, {
    workbookContract,
    ...(sourceArtifacts ? { sourceArtifacts } : {}),
  }, null, dependencies || {});
  if (testCase && testCase.id) {
    await prisma.testCase.update({
      where: { id: testCase.id },
      data: readinessCompiler.readinessUpdateData(compiled),
    });
  }
  return compiled;
}

function recordPipelineSnapshot(reliabilityJobs, job, { stage, scenarios = [], metadata = {}, reason = undefined } = {}) {
  if (!reliabilityJobs || !job || typeof reliabilityJobs.recordScenarioGenerationJobSnapshot !== 'function') return null;
  const snapshotStage = stage || SNAPSHOT_STAGE.DRAFT_GENERATED;
  return reliabilityJobs.recordScenarioGenerationJobSnapshot(job, {
    stage: snapshotStage,
    scenarios,
    metadata,
    reason: reason || snapshotStage,
  });
}

module.exports = {
  SNAPSHOT_STAGE,
  persistCases,
  resolveNamedDependenciesForCases,
  persistRefinedCase,
  compileAndPersistReadiness,
  recordPipelineSnapshot,
  _private: { planCaseMap, assertImmutablePlanLineage, persistencePlanAuthority },
};
