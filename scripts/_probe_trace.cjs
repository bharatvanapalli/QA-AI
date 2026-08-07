const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const prisma = new PrismaClient();
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
(async () => {
  const run = await prisma.run.findFirst({ where:{projectId:PROJECT}, orderBy:{startedAt:'desc'}, select:{id:true} });
  const rrs = await prisma.runResult.findMany({ where:{runId:run.id}, select:{ id:true, status:true, richTraceFile:true, testCase:{select:{name:true}} } });
  console.log('run', run.id.slice(0,8), '·', rrs.length, 'results');
  let withTrace = 0;
  for (const r of rrs) { if (r.richTraceFile && fs.existsSync(r.richTraceFile)) withTrace++; }
  console.log('results with an existing richTraceFile on disk:', withTrace, '/', rrs.length);
  const sample = rrs.find(r=>r.richTraceFile && fs.existsSync(r.richTraceFile));
  if (sample) {
    console.log('\nsample trace path:', sample.richTraceFile);
    let j; try { j = JSON.parse(fs.readFileSync(sample.richTraceFile,'utf8')); } catch(e){ console.log('parse err', e.message); }
    const trail = Array.isArray(j) ? j : (j?.actionTrail || j?.trail || j?.actions || []);
    console.log('trail entries:', Array.isArray(trail)?trail.length:'(shape:'+Object.keys(j||{}).join(',')+')');
    if (Array.isArray(trail)) for (const a of trail.slice(0,12)) console.log(JSON.stringify({tool:a.tool, args:a.args}).slice(0,200));
  } else {
    console.log('\nNo richTraceFile on disk. Falling back: specCode in DB is the only recoverable artifact.');
  }
})().catch(e=>console.error(e.message)).finally(()=>prisma.$disconnect());
