const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const tc = await prisma.testCase.findFirst({ where: { name: { contains: 'filter fields and Add button' } }, select: { name:true, declaredAssertions:true } });
  console.log('CASE:', tc.name);
  const d = JSON.parse(tc.declaredAssertions||'[]');
  for (const a of d) console.log('  ', a.type, '|', a.criticality, '| expected:', JSON.stringify(a.payload), '| @', a.targetUrl);
})().catch(e=>console.error(e.message)).finally(()=>prisma.$disconnect());
