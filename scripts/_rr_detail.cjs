const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // Full detail on the latest RunResult
  const rr = await prisma.runResult.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { testCase: { select: { id: true, name: true, status: true } }, run: { select: { id: true, status: true } } },
  });
  if (!rr) { console.log('No RunResults'); return; }
  console.log('RR id:', rr.id);
  console.log('Run:', rr.run?.id, '| run status:', rr.run?.status);
  console.log('TestCase:', rr.testCase?.id, '|', rr.testCase?.name);
  console.log('TC status:', rr.testCase?.status);
  console.log('RR status:', rr.status, '| created:', rr.createdAt?.toISOString());
  let nodes = [];
  try { const g = JSON.parse(rr.actionGraphJson || '{}'); nodes = g.nodes || []; } catch(_) {}
  console.log('nodes:', nodes.length);
  if (rr.blockedReason) console.log('blockedReason:', rr.blockedReason);
  if (rr.error) console.log('error:', rr.error);
  // Also check run status
  const run = await prisma.run.findUnique({ where: { id: rr.runId }, select: { id: true, status: true, passed: true, failed: true, blocked: true } });
  console.log('\nRun counters:', JSON.stringify(run));
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
