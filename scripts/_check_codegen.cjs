const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const RUN_ID = 'e5171b83-1535-4af2-ba06-28823c26b33b';

  // Check ExportCertification
  const certs = await prisma.exportCertification.findMany({
    where: { runId: RUN_ID },
    select: { id: true, status: true, journeySlug: true, gaps: true, artifacts: true, parityMatched: true, mcpVerdict: true, runnerVerdict: true, kbMissCount: true },
  });
  console.log('ExportCertification rows:', certs.length);
  for (const c of certs) {
    console.log('  status:', c.status, '| journeySlug:', c.journeySlug, '| parityMatched:', c.parityMatched);
    console.log('  mcpVerdict:', c.mcpVerdict, '| runnerVerdict:', c.runnerVerdict);
    console.log('  gaps:', (c.gaps || '(null)').slice(0, 400));
    console.log('  artifacts:', (c.artifacts || '(null)').slice(0, 300));
  }

  // Check RunResult fields related to codegen
  const rr = await prisma.runResult.findFirst({
    where: { runId: RUN_ID },
    select: { id: true, status: true, exportMeta: true, executionContractJson: true, replayIrJson: true },
  });
  console.log('\nRunResult:', rr?.id, '| status:', rr?.status);
  console.log('exportMeta:', (rr?.exportMeta || '(null)').slice(0, 800));
  console.log('replayIrJson length:', (rr?.replayIrJson || '').length);
  console.log('executionContractJson length:', (rr?.executionContractJson || '').length);

  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
