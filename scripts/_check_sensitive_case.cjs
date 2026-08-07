'use strict';
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();

(async () => {
  const CASE_ID = '57b5394e-2a55-4f03-a256-f610f351afcd';
  const RUN_ID = process.argv[2] || '8c75ee05-b9f5-4415-8568-6e1e592e4199';

  // Get the run result and its IR fill steps
  const rr = await db.runResult.findFirst({
    where: { testCaseId: CASE_ID, runId: RUN_ID },
    select: { id: true, status: true, replayIrJson: true }
  });

  if (rr && rr.replayIrJson) {
    const env = JSON.parse(rr.replayIrJson);
    console.log('complete:', env.complete);
    console.log('gaps:', JSON.stringify(env.gaps));
    console.log('\nAll act steps with valueRef:');
    (env.ir && env.ir.steps || []).forEach((s, i) => {
      if (s.op === 'act' && s.valueRef) {
        console.log(`  [${i}] target=${s.target} valueRef=${s.valueRef} rawValue=${JSON.stringify(s.rawValue)}`);
      }
    });
    // Show the resolve steps too (to see what element was being filled)
    console.log('\nResolve steps:');
    const resolveMap = {};
    (env.ir && env.ir.steps || []).forEach((s, i) => {
      if (s.op === 'resolve') resolveMap[s.as] = { index: i, candidates: s.candidates };
    });
    (env.ir && env.ir.steps || []).filter(s => s.op === 'act' && s.valueRef).forEach(s => {
      const r = resolveMap[s.target];
      if (r) console.log(`  ${s.target} (el at idx ${r.index}): candidates=${JSON.stringify((r.candidates||[]).map(c=>c.text||c.name||c.label||'?').slice(0,3))}`);
    });
  } else {
    console.log('No run result found for this case in run', RUN_ID);
  }

  // Check if there are DataSets with invalid credentials
  const datasets = await db.dataSet.findMany({
    select: { id: true, name: true, rows: { select: { id: true, label: true, fields: true }, take: 3 } }
  }).catch(() => []);
  console.log('\nDataSets:', datasets.length);
  datasets.forEach(ds => {
    console.log(`  DS: "${ds.name}"`);
    ds.rows.forEach(row => console.log(`    row: "${row.label}" fields=${JSON.stringify(row.fields).slice(0, 100)}`));
  });

  await db.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
