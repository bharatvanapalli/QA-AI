const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const start = Date.now();
  let runId = null;
  for (let i = 0; i < 100; i++) { // ~ up to 100*6s = 10min
    const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' }, select: { id:true, status:true, passed:true, failed:true, blocked:true, skipped:true, startedAt:true } });
    runId = run?.id;
    const results = await prisma.runResult.findMany({ where: { runId: run.id }, select: { status:true, testCase:{select:{name:true}} } });
    const elapsed = Math.round((Date.now()-start)/1000);
    process.stdout.write(`[${elapsed}s] run ${run.id.slice(0,8)} status=${run.status} P${run.passed}/F${run.failed}/B${run.blocked}/S${run.skipped} results=${results.length}\n`);
    if (['completed','failed','cancelled','complete'].includes(run.status)) {
      console.log('\n=== FINAL per-case ===');
      for (const r of results) console.log('  ', r.status.padEnd(8), r.testCase?.name?.slice(0,64));
      console.log('RUNDIR=playwright/runs/' + run.id);
      break;
    }
    await sleep(6000);
  }
})().catch(e=>console.error('ERR', e.message)).finally(()=>prisma.$disconnect());
