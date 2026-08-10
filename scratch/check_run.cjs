const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const run = await p.run.findFirst({ orderBy: { startedAt: 'desc' }, include: { project: true } });
  console.log('run:', run.id, run.status, run.startedAt, run.completedAt, run.project.name);
  const result = await p.runResult.findFirst({ where: { runId: run.id } });
  console.log('testCaseId:', result.testCaseId);
  console.log('result.status (THIS is the real verdict):', result.status);
  const steps = JSON.parse(result.stepResults || '[]');
  steps.forEach(s => console.log(s.index, s.action, s.status, s.reason));
  await p.$disconnect();
})();
