const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const RUN = 'b044ef5c-babd-4611-bcd6-8a7cc4870f61';
(async () => {
  try {
    const rrs = await p.runResult.findMany({ where: { runId: RUN }, select: { status: true, blockedReason: true, testCase: { select: { name: true } } } });
    console.log('RESULTS so far:', rrs.length);
    for (const r of rrs) console.log(`  [${r.status}] ${(r.testCase?.name || '').slice(0, 45)} :: ${String(r.blockedReason || '').slice(0, 160)}`);
  } catch (e) { console.log('ERR', e.message); } finally { await p.$disconnect(); }
})();
