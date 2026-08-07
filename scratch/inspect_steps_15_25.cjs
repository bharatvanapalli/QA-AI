'use strict';
const prisma = require('../server/prisma.js');

async function main() {
  const rr = await prisma.runResult.findFirst({
    where: { runId: '72de1153-9342-4307-9c85-372cd917f4fd', testCase: { name: { contains: 'complex' } } },
    include: { testCase: true }
  });
  const steps = JSON.parse(rr.stepResults);
  console.log('Steps 15 to 25:');
  steps.slice(15, 25).forEach((s, idx) => console.log(idx + 15, s.action, '|', s.target, '|', s.kind, '|', s.plannedText, '|', s.verifiedLocator?.expression));
}

main().finally(() => prisma.$disconnect());
