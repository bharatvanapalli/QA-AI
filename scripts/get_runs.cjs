const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const runs = await p.run.findMany({
    orderBy: { startedAt: 'desc' },
    take: 3,
    select: {
      id: true,
      projectId: true,
      status: true,
      startedAt: true,
      passed: true,
      failed: true,
      blocked: true,
    },
  });
  console.log('=== LATEST 3 RUNS ===');
  console.log(JSON.stringify(runs, null, 2));

  if (runs.length > 0) {
    const latestRunId = runs[0].id;
    const results = await p.runResult.findMany({
      where: { runId: latestRunId },
      select: {
        id: true,
        testCaseId: true,
        status: true,
        error: true,
        durationMs: true,
        stepResults: true,
      },
    });
    console.log('\n=== RUN RESULTS FOR LATEST RUN (' + latestRunId + ') ===');
    for (const r of results) {
      console.log('\nTestCase: ' + r.testCaseId + ' | Status: ' + r.status + ' | Duration: ' + r.durationMs + 'ms');
      console.log('Error: ' + (r.error || '(none)'));
      let steps;
      try {
        steps = typeof r.stepResults === 'string' ? JSON.parse(r.stepResults) : r.stepResults;
      } catch { steps = null; }
      if (Array.isArray(steps)) {
        for (const s of steps) {
          console.log('  Step ' + s.index + ': [' + s.status + '] ' + (s.action || s.type || '?') + ' => ' + (s.reason || '(ok)'));
        }
      }
    }
  }

  await p.$disconnect();
})();
