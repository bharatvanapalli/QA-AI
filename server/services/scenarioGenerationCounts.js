'use strict';

function requiredText(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  return text;
}

async function countScenarioGenerationRelations(prismaClient, { projectId, generationId } = {}) {
  if (!prismaClient) throw new TypeError('prismaClient is required');
  const scopedProjectId = requiredText(projectId, 'projectId');
  const scopedGenerationId = requiredText(generationId, 'generationId');
  const where = { projectId: scopedProjectId, generationId: scopedGenerationId };
  const scenarioCount = await prismaClient.testScenario.count({ where });
  const caseCount = await prismaClient.testCase.count({ where });
  return { scenarioCount, caseCount };
}

async function syncScenarioGenerationCounts(prismaClient, scope = {}) {
  if (!prismaClient) throw new TypeError('prismaClient is required');
  const projectId = requiredText(scope.projectId, 'projectId');
  const generationId = requiredText(scope.generationId, 'generationId');
  const counts = await countScenarioGenerationRelations(prismaClient, { projectId, generationId });
  const updated = await prismaClient.scenarioGeneration.updateMany({
    where: { id: generationId, projectId },
    data: counts,
  });
  if (Number(updated && updated.count) !== 1) {
    const error = new Error(`Scenario generation ${generationId} was not found in project ${projectId}.`);
    error.code = 'SCENARIO_GENERATION_NOT_FOUND';
    throw error;
  }
  return counts;
}

module.exports = {
  countScenarioGenerationRelations,
  syncScenarioGenerationCounts,
};
