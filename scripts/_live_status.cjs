const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const run = await prisma.run.findFirst({ where: { status: 'running' }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, startedAt: true } });
  if (!run) { console.log('No running run'); return; }
  const rr = await prisma.runResult.findFirst({ where: { runId: run.id }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, actionGraphJson: true, blockedReason: true, error: true } });
  if (!rr) { console.log('Run', run.id, 'has no results yet'); return; }
  let nodes = [];
  try { const g = JSON.parse(rr.actionGraphJson || '{}'); nodes = g.nodes || []; } catch(_) {}
  console.log('Run:', run.id, '| RR status:', rr.status, '| nodes:', nodes.length);
  const last8 = nodes.slice(-8);
  for (const n of last8) {
    const ok = n.ok === false ? 'ERR' : 'ok ';
    console.log(' ', ok, (n.tool || 'narrate').padEnd(25), '|', String(n.narration || n.args?.url || '').slice(0, 100));
  }
  if (rr.blockedReason) console.log('blockedReason:', rr.blockedReason.slice(0, 200));
  if (rr.error) console.log('error:', rr.error.slice(0, 200));
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
