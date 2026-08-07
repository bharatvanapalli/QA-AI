const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const run = await prisma.run.findFirst({ where: { id: { startsWith: 'ae36bfe8' } }, select: { id:true, passed:true, failed:true, blocked:true, skipped:true } });
  const rrs = await prisma.runResult.findMany({ where: { runId: run.id }, select: { status:true, testCase:{select:{name:true}} } });
  const byStatus = {};
  for (const r of rrs) byStatus[r.status] = (byStatus[r.status]||0)+1;
  console.log('run ae36bfe8 verdicts:', JSON.stringify(byStatus), '| total', rrs.length);
  console.log('counters: P'+run.passed+'/F'+run.failed+'/B'+run.blocked+'/S'+run.skipped);
  console.log('--- non-pass cases (these SHOULD be red in the export, faithfully) ---');
  for (const r of rrs.filter(r=>r.status!=='pass')) console.log('  ', r.status, '|', r.testCase?.name?.slice(0,64));
})().catch(e=>console.error(e.message)).finally(()=>prisma.$disconnect());
