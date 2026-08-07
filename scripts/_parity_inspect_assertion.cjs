'use strict';
/* For run 707ba2ac, find the case whose IR contains a given assertion ref and print
 * that assertion's declared criticality + expected value, plus what the LIVE run
 * actually observed (assertionCheckResults). This tells us whether a runtime mismatch
 * is the EXPORT being stricter than live (tier issue) or a real execution-context gap. */
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
const REF = process.argv[3] || 'ASN-2160ad0d';
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: process.argv[2] || '707ba2ac' } } });
  for (const r of rr) {
    if (!r.replayIrJson) continue;
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const blob = JSON.stringify(ir);
    if (!blob.includes(REF)) continue;
    console.log(`=== case ${r.testCaseId?.slice(0,8)} status=${r.status} ===`);
    // walk IR for the declaredAssertion with this id
    const findAssert = (obj, hits=[]) => {
      if (!obj || typeof obj !== 'object') return hits;
      if (Array.isArray(obj)) { obj.forEach(o => findAssert(o, hits)); return hits; }
      if ((obj.id === REF || obj.contractRef === REF) && (obj.channel || obj.type || obj.criticality || obj.script)) hits.push(obj);
      for (const k of Object.keys(obj)) findAssert(obj[k], hits);
      return hits;
    };
    const hits = findAssert(ir);
    for (const h of hits) console.log('  IR assertion:', JSON.stringify({ id:h.id||h.contractRef, channel:h.channel, type:h.type, criticality:h.criticality, expected:h.expected||h.expectedReturn, script:(h.script||h.payload&&h.payload.script||'').slice(0,80) }));
    // what live observed
    if (r.assertionCheckResults) {
      let acr; try { acr = JSON.parse(r.assertionCheckResults); } catch {}
      if (acr) { const m = (Array.isArray(acr)?acr:Object.values(acr)).filter(a => JSON.stringify(a).includes(REF)); console.log('  LIVE observed:', JSON.stringify(m).slice(0,500)); }
    }
    break;
  }
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
