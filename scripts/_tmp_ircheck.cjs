const { PrismaClient } = require('../server/node_modules/@prisma/client');
const prisma = new PrismaClient();
prisma.runResult.findMany({
  where: { runId: 'bc723b73-449b-40a5-bff5-8f4171d4034e' },
  select: {
    id: true, status: true, agentClaimedVerdict: true,
    assertionCheckResults: true,
    replayIrJson: true,
    testCase: {
      select: {
        id: true, name: true, module: true, type: true, declaredAssertions: true,
        scenario: { select: { id: true, name: true } }
      }
    }
  },
  orderBy: { id: 'asc' }
}).then(rs => {
  rs.forEach(r => {
    console.log(`\n--- ${r.testCase?.name} (${r.status}) ---`);
    console.log(`  module: ${r.testCase?.module}, type: ${r.testCase?.type}`);
    console.log(`  scenario: ${r.testCase?.scenario?.name}`);
    console.log(`  hasIR: ${!!r.replayIrJson}, IRlen: ${r.replayIrJson?.length ?? 0}`);
    if (r.assertionCheckResults) {
      try {
        const arr = JSON.parse(r.assertionCheckResults);
        console.log(`  assertions: ${arr.length}, outcomes: ${arr.map(a => a.outcome || a.result).join(', ')}`);
      } catch(e) { console.log(`  assertionCheckResults parse err: ${e.message}`); }
    }
  });
  return prisma.$disconnect();
}).catch(e => { console.error(e.message); return prisma.$disconnect(); });
