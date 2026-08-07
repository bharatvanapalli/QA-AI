const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // Finalize any run that is 'running' but all its RunResults are terminal
  const runs = await prisma.run.findMany({ where: { status: 'running' }, select: { id: true, passed: true, failed: true, blocked: true, skipped: true } });
  for (const run of runs) {
    const inProgress = await prisma.runResult.count({ where: { runId: run.id, status: { in: ['running'] } } });
    if (inProgress > 0) { console.log('Run', run.id, 'still has in-progress results — skipping'); continue; }
    const total = run.passed + run.failed + run.blocked + run.skipped;
    const status = run.failed > 0 ? 'failed' : run.blocked > 0 ? 'blocked' : 'completed';
    await prisma.run.update({ where: { id: run.id }, data: { status, completedAt: new Date() } });
    console.log('Finalized run', run.id, '→', status, `(p:${run.passed} f:${run.failed} b:${run.blocked} total:${total})`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
