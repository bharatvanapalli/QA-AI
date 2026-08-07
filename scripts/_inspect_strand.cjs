'use strict';
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
const NEEDLES = ['Empty username validation error','Empty password validation error','Submit empty password','ESS user sidebar shows','ESS dashboard displays','ESS user direct navigation','ESS login with valid'];
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: '707ba2ac' }, replayIrJson: { not: null } }, select: { status:true, testCase: { select: { name:true, scenarioId:true } }, replayIrJson:true } });
  for (const needle of NEEDLES) {
    const r = rr.find(x => (x.testCase&&x.testCase.name||'').includes(needle));
    if (!r) { console.log(`\n## "${needle}" NOT FOUND`); continue; }
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const steps = (ir.ir&&ir.ir.steps)||ir.steps||[];
    console.log(`\n## [${r.status}] sid=${(r.testCase.scenarioId||'').slice(0,6)} "${r.testCase.name}"`);
    steps.forEach((s,i)=>{
      if (s.op==='act') console.log(`   [${i}] act ${s.action} ${s.url?('url='+s.url):''} ${s.valueRef||''}`);
      else if (s.op==='assert') console.log(`   [${i}] assert ${s.channel} expected="${String(s.expected||'').slice(0,45)}" ${s.script?('script='+String(s.script).slice(0,45)):''}`);
      else if (s.op==='resolve') console.log(`   [${i}] resolve ${s.as}`);
      else console.log(`   [${i}] ${s.op}`);
    });
  }
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
