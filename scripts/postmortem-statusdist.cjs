'use strict';
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const run = await prisma.run.findFirst({ orderBy: { startedAt: 'desc' } });
  const groups = await prisma.runResult.groupBy({
    by: ['status'], where: { runId: run.id }, _count: { _all: true },
  });
  console.log('Run:', run.id);
  for (const g of groups) console.log(`  ${g.status.padEnd(14)} ${g._count._all}`);
  // Drill the cases whose status is something other than pass/fail/blocked.
  const odd = await prisma.runResult.findMany({
    where: { runId: run.id, NOT: { status: { in: ['pass', 'fail', 'blocked'] } } },
    include: { testCase: { select: { name: true, module: true } } },
  });
  if (odd.length) {
    console.log('\nNon-standard statuses:');
    for (const o of odd) {
      console.log(`  [${o.status}] ${o.testCase?.name || o.testCaseId}`);
      console.log(`     verdictReason: ${o.mechanicalVerdictReason || '—'}`);
      console.log(`     error first line: ${(o.error || '').split(/\r?\n/)[0].slice(0, 160)}`);
    }
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
