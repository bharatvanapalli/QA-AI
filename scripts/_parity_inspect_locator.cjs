'use strict';
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
const NEEDLE = process.argv[3] || 'User profile dropdown';
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: process.argv[2] || '707ba2ac' }, replayIrJson: { not: null } } });
  for (const r of rr) {
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const steps = (ir.ir && ir.ir.steps) || ir.steps || [];
    const blob = JSON.stringify(steps);
    if (!blob.includes(NEEDLE)) continue;
    console.log(`=== case ${r.testCaseId?.slice(0,8)} status=${r.status} ===`);
    steps.forEach((s, i) => {
      if (JSON.stringify(s).includes(NEEDLE)) {
        console.log(`step[${i}] op=${s.op} action=${s.action||s.kind||''}`);
        console.log('  ', JSON.stringify(s).slice(0, 700));
      }
    });
    break;
  }
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
