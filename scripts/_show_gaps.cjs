'use strict';
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();
const RUN_ID = process.argv[2] || '8c75ee05-b9f5-4415-8568-6e1e592e4199';

(async () => {
  const results = await db.runResult.findMany({
    where: { runId: RUN_ID },
    select: { id: true, testCaseId: true, status: true, replayIrJson: true,
      testCase: { select: { name: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  let found = 0;
  for (const r of results) {
    let envelope = null;
    try { envelope = r.replayIrJson ? JSON.parse(r.replayIrJson) : null; } catch (_) {}
    if (!envelope || envelope.complete !== false) continue;
    found++;
    const caseName = r.testCase && r.testCase.name || '(no name)';
    const gaps = envelope.gaps || [];
    const steps = Array.isArray(envelope.ir && envelope.ir.steps) ? envelope.ir.steps.length : 0;
    console.log(`\n=== INCOMPLETE: "${caseName}" ===`);
    console.log(`  RunResult: ${r.id}  status: ${r.status}  IR steps: ${steps}`);
    console.log(`  Gaps (${gaps.length}):`);
    gaps.forEach(g => console.log(`    [${g.code}] ${g.where || ''}: ${(g.detail || '').slice(0, 120)}`));
  }
  if (found === 0) console.log('No incomplete IR RunResults found.');
  await db.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
