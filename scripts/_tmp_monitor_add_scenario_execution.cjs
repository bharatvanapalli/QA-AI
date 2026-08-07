const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const projectId = 'f8168938-ac0a-42fe-9c30-2f820aaee9dd';
const generationId = '9d952135-19af-4626-ae83-696c0796588e';

const compactError = (value) => {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
};

async function main() {
  const [agentRuns, runs, testCase] = await Promise.all([
    prisma.agentRun.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        phase: true,
        status: true,
        startedAt: true,
        completedAt: true,
        error: true,
      },
    }),
    prisma.run.findMany({
      where: { projectId, generationId },
      orderBy: { startedAt: 'desc' },
      take: 4,
      select: {
        id: true,
        status: true,
        passed: true,
        failed: true,
        blocked: true,
        skipped: true,
        needsHuman: true,
        startedAt: true,
        completedAt: true,
        results: {
          select: {
            id: true,
            testCaseId: true,
            status: true,
            durationMs: true,
            error: true,
            executionContractJson: true,
          },
        },
      },
    }),
    prisma.testCase.findUnique({
      where: { id: '6ab6e82a-9784-4654-bb37-90d1c787e36d' },
      select: {
        id: true,
        name: true,
        steps: true,
      },
    }),
  ]);

  const parse = (value) => {
    try { return value ? JSON.parse(value) : null; } catch (_) { return null; }
  };
  const storedSteps = parse(testCase?.steps);

  process.stdout.write(JSON.stringify({
    checkedAt: new Date().toISOString(),
    agentRuns: agentRuns.map((row) => ({ ...row, error: compactError(row.error) })),
    runs: runs.map((run) => ({
      ...run,
      results: run.results.map((row) => {
        const contract = parse(row.executionContractJson);
        return {
          ...row,
          error: compactError(row.error),
          executionContractJson: undefined,
          executionContract: contract ? {
            steps: Array.isArray(contract.steps) ? contract.steps.slice(0, 4) : contract.steps,
            plannedSteps: Array.isArray(contract.plannedSteps) ? contract.plannedSteps.slice(0, 4) : contract.plannedSteps,
          } : null,
        };
      }),
    })),
    testCase: testCase ? {
      id: testCase.id,
      name: testCase.name,
      steps: Array.isArray(storedSteps) ? storedSteps.slice(0, 4) : storedSteps,
    } : null,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
