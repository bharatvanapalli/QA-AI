'use strict';
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();
const RUN_ID = process.argv[2] || '8c75ee05-b9f5-4415-8568-6e1e592e4199';

(async () => {
  const run = await db.run.findUnique({
    where: { id: RUN_ID },
    select: { id: true, status: true, passed: true, failed: true, blocked: true, completedAt: true }
  });
  console.log('Run:', JSON.stringify(run));

  const results = await db.runResult.findMany({
    where: { runId: RUN_ID },
    select: {
      id: true, testCaseId: true, status: true, replayIrJson: true, createdAt: true,
      testCase: { select: { name: true, module: true, scenarioId: true } }
    },
    orderBy: { createdAt: 'asc' }
  });
  console.log('RunResults count:', results.length);

  let completeTrue = 0, completeFalse = 0, noIr = 0;
  const incompleteRows = [];
  const stepCounts = [];
  results.forEach(r => {
    let envelope = null;
    try { envelope = r.replayIrJson ? JSON.parse(r.replayIrJson) : null; } catch (_) {}
    if (!envelope) {
      noIr++;
    } else if (envelope.complete === false) {
      completeFalse++;
      const stepCount = Array.isArray(envelope.ir && envelope.ir.steps) ? envelope.ir.steps.length : 0;
      incompleteRows.push({
        runResultId: r.id,
        testCaseId: r.testCaseId,
        status: r.status,
        caseName: r.testCase && r.testCase.name,
        module: r.testCase && r.testCase.module,
        irSteps: stepCount
      });
    } else {
      completeTrue++;
      const stepCount = Array.isArray(envelope.ir && envelope.ir.steps) ? envelope.ir.steps.length : 0;
      stepCounts.push(stepCount);
    }
  });
  console.log('IR complete=true:', completeTrue, ' complete=false:', completeFalse, ' no IR:', noIr);
  if (stepCounts.length) {
    const avg = (stepCounts.reduce((a,b)=>a+b,0)/stepCounts.length).toFixed(1);
    console.log('Complete IR avg steps:', avg, ' min:', Math.min(...stepCounts), ' max:', Math.max(...stepCounts));
  }

  if (incompleteRows.length > 0) {
    console.log('\nIncomplete RunResults:');
    incompleteRows.forEach(x => console.log(' ', JSON.stringify(x)));
  }

  const activeResults = results.filter(r => r.status === 'running' || r.status === 'pending');
  console.log('\nActive (running/pending) results:', activeResults.length);

  await db.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
