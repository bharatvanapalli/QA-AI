'use strict';

function uniqueIds(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value == null ? '' : value).trim())
    .filter(Boolean)));
}

function appendGenerationContractSnapshot(generation) {
  if (!generation || !generation.id) return null;
  return {
    id: generation.id,
    projectId: generation.projectId || null,
    isCurrent: generation.isCurrent === true,
    scenarioCount: Number(generation.scenarioCount || 0),
    caseCount: Number(generation.caseCount || 0),
    coveragePlanJson: generation.coveragePlanJson == null ? null : generation.coveragePlanJson,
    coverageValidationJson: generation.coverageValidationJson == null ? null : generation.coverageValidationJson,
    coverageRepairJson: generation.coverageRepairJson == null ? null : generation.coverageRepairJson,
  };
}

async function rollbackAppendedGenerationMutation({
  prismaClient,
  projectId,
  generationId,
  snapshot,
  scenarioIds = [],
  caseIds = [],
  expectedState = null,
} = {}) {
  if (!prismaClient || !snapshot || snapshot.id !== generationId || snapshot.projectId !== projectId) {
    const error = new Error('Cannot safely roll back append without the exact pre-append generation snapshot.');
    error.code = 'APPEND_ROLLBACK_SNAPSHOT_MISSING';
    throw error;
  }
  const createdScenarioIds = uniqueIds(scenarioIds);
  const createdCaseIds = uniqueIds(caseIds);
  await prismaClient.$transaction(async (tx) => {
    let generationRestored = false;
    if (expectedState && typeof expectedState === 'object') {
      const expectedScenarioCount = Number(expectedState.scenarioCount);
      const expectedCaseCount = Number(expectedState.caseCount);
      if (!Number.isFinite(expectedScenarioCount) || !Number.isFinite(expectedCaseCount)
        || !tx.scenarioGeneration || typeof tx.scenarioGeneration.updateMany !== 'function') {
        const error = new Error('Cannot safely roll back append without an exact committed generation state.');
        error.code = 'APPEND_ROLLBACK_EXPECTED_STATE_INVALID';
        throw error;
      }
      const where = {
        id: generationId,
        projectId,
        scenarioCount: expectedScenarioCount,
        caseCount: expectedCaseCount,
      };
      for (const field of ['coveragePlanJson', 'coverageValidationJson', 'coverageRepairJson']) {
        if (Object.prototype.hasOwnProperty.call(expectedState, field)) where[field] = expectedState[field];
      }
      const claimed = await tx.scenarioGeneration.updateMany({
        where,
        data: {
          scenarioCount: snapshot.scenarioCount,
          caseCount: snapshot.caseCount,
          coveragePlanJson: snapshot.coveragePlanJson,
          coverageValidationJson: snapshot.coverageValidationJson,
          coverageRepairJson: snapshot.coverageRepairJson,
        },
      });
      if (!claimed || claimed.count !== 1) {
        const error = new Error('Append rollback refused because the generation changed after this append committed.');
        error.code = 'APPEND_ROLLBACK_CONCURRENT_MUTATION';
        throw error;
      }
      generationRestored = true;
    }
    // TestCase.scenario uses onDelete:SetNull. Delete the appended cases first so
    // removing their scenarios cannot leave generated orphan rows behind.
    if (createdCaseIds.length) {
      await tx.testCase.deleteMany({
        where: { id: { in: createdCaseIds }, projectId, generationId },
      });
    }
    if (createdScenarioIds.length) {
      await tx.testScenario.deleteMany({
        where: { id: { in: createdScenarioIds }, projectId, generationId },
      });
    }
    if (!generationRestored) {
      await tx.scenarioGeneration.update({
        where: { id: generationId },
        data: {
          scenarioCount: snapshot.scenarioCount,
          caseCount: snapshot.caseCount,
          coveragePlanJson: snapshot.coveragePlanJson,
          coverageValidationJson: snapshot.coverageValidationJson,
          coverageRepairJson: snapshot.coverageRepairJson,
        },
      });
    }
  }, { timeout: 60_000, maxWait: 15_000 });
}

module.exports = {
  appendGenerationContractSnapshot,
  rollbackAppendedGenerationMutation,
  _private: { uniqueIds },
};
