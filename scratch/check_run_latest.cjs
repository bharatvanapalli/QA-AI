const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const run = await p.run.findFirst({ orderBy: { startedAt: 'desc' } });
  if (!run) { console.log('no run'); return p.$disconnect(); }
  console.log('RUN_ID:', run.id);
  console.log('run:', run.status, run.startedAt, run.completedAt);
  
  const results = await p.runResult.findMany({ where: { runId: run.id } });
  for (const result of results) {
    console.log('=========================');
    console.log('TEST_CASE_ID:', result.testCaseId);
    console.log('result.status (THIS is the real verdict):', result.status);
    const steps = JSON.parse(result.stepResults || '[]');
    steps.forEach(s => console.log(s.index, s.action, s.status, s.reason));
    console.log('Screenshots:', result.screenshots);
  }
  await p.$disconnect();
})();
