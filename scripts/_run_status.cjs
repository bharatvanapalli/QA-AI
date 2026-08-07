'use strict';
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const prisma = new PrismaClient();
const RUN_ID = '30637d3e-e147-452f-b94f-3bc3c306043e';
(async () => {
  const r = await prisma.run.findUnique({
    where: { id: RUN_ID },
    select: {
      status: true, passed: true, failed: true, blocked: true, needsHuman: true,
      results: {
        select: { status: true, replayIrJson: true, testCase: { select: { name: true } } },
        orderBy: { createdAt: 'asc' }
      }
    }
  });
  console.log('status:', r.status, '| pass:', r.passed, '| fail:', r.failed, '| blocked:', r.blocked, '| total:', r.results.length);
  r.results.forEach(x => {
    const has = x.replayIrJson ? '[IR]' : '[no-IR]';
    console.log(' ', x.status.padEnd(8), has, x.testCase ? x.testCase.name : '?');
  });
  await prisma.$disconnect();
})().catch(async e => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
