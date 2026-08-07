'use strict';
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const { reduceAssertionOutcomes } = require('../server/services/codegen/replayExport');
const p = new PrismaClient();
const REFS = process.argv.slice(3);
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: process.argv[2] || '707ba2ac' }, replayIrJson: { not: null } } });
  // index every assertion in every IR by ref -> {case, channel, criticality, expected, script}
  const byRef = {};
  for (const r of rr) {
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const outcomes = reduceAssertionOutcomes(r.assertionCheckResults);
    for (const s of (ir.ir && ir.ir.steps || ir.steps || [])) {
      if (s.op !== 'assert') continue;
      const ref = s.contractRef || s.id; if (!ref) continue;
      byRef[ref] = { case: r.testCaseId?.slice(0,8), status: r.status, channel: s.channel, criticality: s.criticality||s.tier||'?', expected: String(s.expected||'').slice(0,40), script: String(s.script||'').slice(0,60), liveOutcome: outcomes[ref] || 'ABSENT' };
    }
  }
  for (const ref of REFS) {
    console.log(`${ref}:`, byRef[ref] ? JSON.stringify(byRef[ref]) : 'NOT FOUND');
  }
  // also: count ABSENT vs recorded across ALL assertions
  let total=0, absent=0; const chDist={};
  for (const r of rr) {
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const outcomes = reduceAssertionOutcomes(r.assertionCheckResults);
    for (const s of (ir.ir && ir.ir.steps || ir.steps || [])) {
      if (s.op !== 'assert') continue; const ref=s.contractRef||s.id; if(!ref) continue;
      total++; const o = outcomes[ref]||'ABSENT'; if(o==='ABSENT') absent++;
      chDist[s.channel] = chDist[s.channel]||{}; chDist[s.channel][o]=(chDist[s.channel][o]||0)+1;
    }
  }
  console.log(`\nALL assert steps: total=${total} absent(no live outcome)=${absent}`);
  console.log('by channel x outcome:', JSON.stringify(chDist, null, 0));
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
