const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const runs = await prisma.run.findMany({ where: { status: 'running' }, select: { id: true, startedAt: true } });
  console.log('Stuck runs:', runs.length);
  for (const r of runs) {
    await prisma.run.update({ where: { id: r.id }, data: { status: 'cancelled', completedAt: new Date() } });
    await prisma.runResult.updateMany({ where: { runId: r.id, status: 'running' }, data: { status: 'blocked', blockedReason: 'Server restart — run was frozen' } });
    console.log('Cancelled:', r.id);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
