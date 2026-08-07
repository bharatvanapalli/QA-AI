const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const RR_ID = '34f914c9-1786-44f5-b240-ab9f491e0707';
  // Reset exportMeta to 'draft' so the Repair button can re-run codegen
  const resetMeta = JSON.stringify({
    state: 'draft',
    gaps: [],
    contractAt: new Date().toISOString(),
    repairRound: 0,
    certifiedAt: null,
    parityReport: null,
    artifacts: [],
    pipelineTraceId: null,
  });
  await prisma.runResult.update({
    where: { id: RR_ID },
    data: { exportMeta: resetMeta },
  });
  console.log('Reset exportMeta to draft for RunResult', RR_ID);
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
