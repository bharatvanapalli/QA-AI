'use strict';
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: process.argv[2] || '707ba2ac' } } });
  const sample = rr[0] || {};
  console.log('RunResult fields:', Object.keys(sample).join(', '));
  console.log('');
  for (const r of rr) {
    let title = r.testCaseTitle || r.title || null;
    if (!title && r.testCaseId) { const tc = await p.testCase.findUnique({ where: { id: r.testCaseId }, select: { title: true } }).catch(()=>null); title = tc && tc.title; }
    const hasIR = r.replayIrJson != null;
    console.log(`${String(r.status||'?').padEnd(12)} ir=${hasIR?'Y':'n'}  ${title || r.testCaseId || r.id}`);
  }
  console.log(`\ntotal=${rr.length}`);
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
