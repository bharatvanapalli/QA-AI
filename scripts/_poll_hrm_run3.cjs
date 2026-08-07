const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
const RUN_ID_PREFIX = '2fda1038';

async function poll() {
  let prevPass = -1;
  for (let i = 0; i < 300; i++) {
    const runs = await prisma.run.findMany({
      where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93' },
      orderBy: { startedAt: 'desc' },
      take: 1,
      select: { id: true, status: true, passed: true, failed: true, blocked: true, needsHuman: true, startedAt: true }
    });
    const latest = runs[0];
    if (!latest || !latest.id.startsWith(RUN_ID_PREFIX)) { await new Promise(r => setTimeout(r, 8000)); continue; }
    const elapsed = Math.round((Date.now() - new Date(latest.startedAt)) / 1000);
    if (latest.passed !== prevPass) {
      console.log(`  [${elapsed}s] status=${latest.status} pass=${latest.passed}/${24} fail=${latest.failed} blocked=${latest.blocked}`);
      prevPass = latest.passed;
    }
    if (latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled') {
      console.log('\nFINAL: run=' + latest.id);
      console.log('pass=' + latest.passed + ' fail=' + latest.failed + ' blocked=' + latest.blocked + ' nH=' + latest.needsHuman);
      break;
    }
    await new Promise(r => setTimeout(r, 12000));
  }
  await prisma.$disconnect();
}
poll().catch(e => { console.error(e.message); prisma.$disconnect(); process.exit(1); });
