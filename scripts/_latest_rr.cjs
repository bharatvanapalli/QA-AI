const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  // Get the 3 most recently created RunResults regardless of run
  const rrs = await prisma.runResult.findMany({
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, runId: true, status: true, createdAt: true, actionGraphJson: true, blockedReason: true, error: true },
  });
  for (const rr of rrs) {
    let nodes = [];
    try { const g = JSON.parse(rr.actionGraphJson || '{}'); nodes = g.nodes || []; } catch(_) {}
    console.log('RR:', rr.id, '| run:', rr.runId, '| status:', rr.status, '| nodes:', nodes.length, '| created:', rr.createdAt?.toISOString());
    const last3 = nodes.slice(-3);
    for (const n of last3) {
      const ok = n.ok === false ? 'ERR' : 'ok ';
      console.log('  ', ok, (n.tool || 'narrate').padEnd(25), '|', String(n.narration || n.args?.url || '').slice(0, 90));
    }
    if (rr.blockedReason) console.log('  blocked:', rr.blockedReason.slice(0, 150));
    if (rr.error) console.log('  error:', rr.error.slice(0, 150));
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
