const { PrismaClient } = require('@prisma/client');
const fs = require('fs'); const zlib = require('zlib');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  const run = await prisma.run.findFirst({ where:{projectId:PROJECT}, orderBy:{startedAt:'desc'}, select:{id:true} });
  const sample = await prisma.runResult.findFirst({ where:{runId:run.id, status:'pass'}, select:{ richTraceFile:true, testCase:{select:{name:true}} } });
  const buf = zlib.gunzipSync(fs.readFileSync(sample.richTraceFile));
  const j = JSON.parse(buf.toString('utf8'));
  console.log('case:', sample.testCase.name);
  console.log('top-level keys:', Object.keys(j).join(', '));
  // find an array of actions/turns
  for (const k of Object.keys(j)) {
    if (Array.isArray(j[k])) console.log(`  ${k}: array[${j[k].length}]  sampleKeys=${j[k][0]?Object.keys(j[k][0]).join('/'):''}`);
  }
  // try to print tool+args from the likely turns array
  const turns = j.turns || j.actionTrail || j.trail || [];
  console.log('\nfirst turns (tool/args):');
  for (const t of turns.slice(0,10)) {
    const acts = t.toolCalls || t.actions || (t.tool ? [t] : []);
    for (const a of acts) console.log('  ', JSON.stringify({tool:a.tool||a.name, args:a.args||a.input}).slice(0,180));
  }
})().catch(e=>console.error('ERR', e.message)).finally(()=>prisma.$disconnect());
