'use strict';

const prisma = require('../server/prisma');
const { syncScenarioGenerationCounts } = require('../server/services/scenarioGenerationCounts');

const PROJECT_ID = 'f8168938-ac0a-42fe-9c30-2f820aaee9dd';
const GENERATION_ID = '9d952135-19af-4626-ae83-696c0796588e';
const OBSOLETE_SCENARIO_IDS = [
  '4767e288-f55b-45c0-8bb2-f3fd4e8e6ec1',
  '8e12c2cb-0e70-4b51-869c-6ee5bca1058c',
];
const REPLACEMENT_SCENARIO_ID = '1bca2ede-108a-4f00-9045-7cd51a5694c7';

(async () => {
  const [obsoleteRows, replacement] = await Promise.all([
    prisma.testScenario.findMany({
      where: { id: { in: OBSOLETE_SCENARIO_IDS } },
      select: { id: true, projectId: true, generationId: true, name: true },
    }),
    prisma.testScenario.findUnique({
      where: { id: REPLACEMENT_SCENARIO_ID },
      select: {
        id: true,
        projectId: true,
        generationId: true,
        name: true,
        cases: { select: { readinessStatus: true, runEligibility: true, steps: true } },
      },
    }),
  ]);
  if (obsoleteRows.length !== OBSOLETE_SCENARIO_IDS.length
    || obsoleteRows.some((row) => row.projectId !== PROJECT_ID
      || row.generationId !== GENERATION_ID
      || row.name !== 'Create an order and validate complex controls')) {
    throw new Error('Obsolete S2 identities did not match; no deletion performed.');
  }
  const replacementSteps = replacement && replacement.cases[0]
    ? JSON.parse(replacement.cases[0].steps || '[]')
    : [];
  if (!replacement
    || replacement.projectId !== PROJECT_ID
    || replacement.generationId !== GENERATION_ID
    || replacement.name !== 'Create an order and validate complex controls'
    || replacement.cases.length !== 1
    || replacement.cases[0].readinessStatus !== 'ready'
    || replacement.cases[0].runEligibility !== 'allowed'
    || !replacementSteps[0]
    || replacementSteps[0].action !== 'Click'
    || !replacementSteps[0].expected) {
    throw new Error('Verified replacement S2 is unavailable; no deletion performed.');
  }
  const result = await prisma.$transaction(async (tx) => {
    const deletedCases = await tx.testCase.deleteMany({
      where: {
        projectId: PROJECT_ID,
        generationId: GENERATION_ID,
        scenarioId: { in: OBSOLETE_SCENARIO_IDS },
      },
    });
    const deletedScenarios = await tx.testScenario.deleteMany({
      where: {
        id: { in: OBSOLETE_SCENARIO_IDS },
        projectId: PROJECT_ID,
        generationId: GENERATION_ID,
      },
    });
    const counts = await syncScenarioGenerationCounts(tx, {
      projectId: PROJECT_ID,
      generationId: GENERATION_ID,
    });
    return {
      deletedScenarioIds: OBSOLETE_SCENARIO_IDS,
      deletedScenarioCount: deletedScenarios.count,
      deletedCaseCount: deletedCases.count,
      replacementScenarioId: REPLACEMENT_SCENARIO_ID,
      counts,
    };
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
})()
  .finally(() => prisma.$disconnect());
