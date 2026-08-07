const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
async function go() {
  const tc = await p.testCase.findFirst({
    where: { id: 'f385a169-0416-4f7c-8655-68217404587a' },
    select: { name: true, declaredAssertions: true }
  });
  console.log('TC name:', tc.name);
  const da = JSON.parse(tc.declaredAssertions || '[]');
  da.forEach(a => console.log(`  ASN=${a.id} type=${a.type} prim=${a.primitive} text="${a.text?.slice(0,60)}" desc="${a.description?.slice(0,80)}"`));
  await p.$disconnect();
}
go().catch(e => { console.error(e.message); p.$disconnect(); });
