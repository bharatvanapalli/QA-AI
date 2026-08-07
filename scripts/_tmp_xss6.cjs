const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const rr = await p.runResult.findFirst({
    where: { runId: '2fda1038-bece-43f2-add9-0a7b0817dda3', testCaseId: 'f385a169-0416-4f7c-8655-68217404587a' },
    select: { assertionCheckResults: true }
  });
  const acr = JSON.parse(rr.assertionCheckResults || '[]');
  console.log('all ACR entries:');
  acr.forEach((a,i) => console.log(`  [${i}] ASN=${a.assertionId} outcome=${a.outcome} prim=${a.primitiveUsed} type=${a.type}`));
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
