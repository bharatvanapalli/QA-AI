const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();

async function poll() {
  for (let i = 0; i < 200; i++) {
    const runs = await prisma.run.findMany({
      where: { projectId: '465f2d08-c8b5-469a-af41-9c0ba2a2ce93' },
      orderBy: { startedAt: 'desc' },
      take: 1,
      select: { id: true, status: true, passed: true, failed: true, blocked: true, needsHuman: true, startedAt: true }
    });
    const latest = runs[0];
    if (!latest) { await new Promise(r => setTimeout(r, 5000)); continue; }
    const elapsed = Math.round((Date.now() - new Date(latest.startedAt)) / 1000);
    process.stdout.write(`\r  [${elapsed}s] run=${latest.id.slice(0,8)} status=${latest.status} pass=${latest.passed} fail=${latest.failed} blocked=${latest.blocked} nH=${latest.needsHuman}   `);
    if (latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled') {
      console.log('\n\nDONE run=' + latest.id);
      console.log('pass=' + latest.passed + ' fail=' + latest.failed + ' blocked=' + latest.blocked + ' nH=' + latest.needsHuman);
      break;
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  await prisma.$disconnect();
}
poll().catch(e => { console.error(e.message); prisma.$disconnect(); process.exit(1); });
