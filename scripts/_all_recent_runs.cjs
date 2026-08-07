const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const runs = await prisma.run.findMany({
    where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93' },
    orderBy: { startedAt: 'desc' },
    take: 5,
    select: { id: true, status: true, startedAt: true, completedAt: true, passed: true, failed: true, blocked: true },
  });
  for (const r of runs) {
    console.log(r.status.padEnd(10), r.startedAt?.toISOString(), 'p:', r.passed, 'f:', r.failed, 'b:', r.blocked, '|', r.id);
    const rrs = await prisma.runResult.findMany({ where: { runId: r.id }, select: { status: true, id: true }, take: 5 });
    for (const rr of rrs) console.log('  rr:', rr.status, rr.id);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
