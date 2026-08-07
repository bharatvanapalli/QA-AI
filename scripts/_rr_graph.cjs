const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rr = await prisma.runResult.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, actionGraphJson: true, stepResults: true, replayIrJson: true, error: true, blockedReason: true },
  });
  console.log('RR:', rr.id, '| status:', rr.status);
  console.log('actionGraphJson length:', (rr.actionGraphJson || '').length);
  console.log('actionGraphJson (first 3000 chars):');
  console.log((rr.actionGraphJson || '(null)').slice(0, 3000));
  console.log('\nstepResults (first 500):', (rr.stepResults || '(null)').slice(0, 500));
  if (rr.error) console.log('error:', rr.error.slice(0, 300));
  if (rr.blockedReason) console.log('blockedReason:', rr.blockedReason);
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
