const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  const gen = await prisma.scenarioGeneration.findFirst({ where: { projectId: PROJECT, isCurrent: true }, select: { id:true, label:true } });
  console.log('current gen:', gen?.id, '|', gen?.label);
  const scns = await prisma.testScenario.findMany({ where: { projectId: PROJECT, generationId: gen.id }, include: { cases: { select: { id:true, name:true, automatability:true, status:true } } } });
  const cases = scns.flatMap(s => s.cases).filter(c => (c.automatability||'automatable')==='automatable');
  console.log('automatable cases in current gen:', cases.length);
  for (const c of cases) console.log('  -', c.status.padEnd(9), c.name.slice(0,70), '·', c.id.slice(0,8));
})().catch(e=>console.error(e.message)).finally(()=>prisma.$disconnect());
