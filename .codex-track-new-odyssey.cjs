require('dotenv').config();
const prisma = require('./server/prisma');

function stepSummary(raw) {
  let rows = [];
  try { rows = JSON.parse(raw || '[]'); } catch (_) {}
  const counts = rows.reduce((acc, row) => {
    const status = String(row?.status || row?.outcome || 'unknown').toLowerCase();
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const nonPass = rows
    .filter((row) => String(row?.status || row?.outcome || '').toLowerCase() !== 'pass')
    .map((row) => ({
      index: row.index || row.ordinal,
      status: row.status || row.outcome,
      actionType: row.actionType,
      plannedText: row.plannedText,
      continuationOutcome: row.continuationOutcome,
      failureImpact: row.failureImpact,
      reason: row.assertionResult?.reason
        || row.executionErrorReason
        || row.continuationReason
        || row.attempts?.at(-1)?.reason
        || row.error,
    }));
  return process.argv.includes('--compact')
    ? { total: rows.length, counts, nonPass }
    : { total: rows.length, counts, nonPass, last: rows.at(-1) || null };
}

(async () => {
  const run = await prisma.run.findFirst({
    where: {
      projectId: '1582559f-364f-4d0e-bfde-fd18832fdaa7',
      generationId: 'd486351a-6070-47d1-b8b5-2c8bc4156abb',
    },
    orderBy: { startedAt: 'desc' },
    include: {
      results: {
        orderBy: { createdAt: 'asc' },
        include: { testCase: { select: { name: true } } },
      },
    },
  });
  const agentRuns = await prisma.agentRun.findMany({
    where: { projectId: '1582559f-364f-4d0e-bfde-fd18832fdaa7', phase: 'conductor' },
    orderBy: { startedAt: 'desc' },
    take: 3,
  });
  console.log(JSON.stringify(run ? {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    counters: {
      passed: run.passed,
      failed: run.failed,
      blocked: run.blocked,
      skipped: run.skipped,
      needsHuman: run.needsHuman,
    },
    results: run.results.map((result) => ({
      id: result.id,
      testCaseId: result.testCaseId,
      name: result.testCase.name,
      status: result.status,
      blockedReason: result.blockedReason,
      error: result.error,
      richTraceFile: result.richTraceFile,
      steps: stepSummary(result.stepResults),
    })),
    conductorPhases: agentRuns.map((agentRun) => {
      let log = [];
      try { log = JSON.parse(agentRun.log || '[]'); } catch (_) {}
      return {
        id: agentRun.id,
        status: agentRun.status,
        startedAt: agentRun.startedAt,
        completedAt: agentRun.completedAt,
        error: agentRun.error,
        lastLog: log.slice(-5),
      };
    }),
  } : null, null, 2));
})().finally(() => prisma.$disconnect());
