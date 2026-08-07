'use strict';
/* CLASS B PRE-FLIGHT (READ-ONLY). For the 3 EVALUATE-timing failures, dump the FULL raw step
 * sequence so we can see (1) whether the IR carries transition/postcondition data a settle/
 * waitForURL contract could anchor to (fields like urlAfter / causedNavigation / navigatedTo /
 * postcondition / settle / waitFor), and (2) the ordering around the failing EVALUATE — esp.
 * the password-masking case, to judge if the eval can be anchored to a page where the field
 * still existed. No mutations. */
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
const TARGETS = ['ASN-95450bc4','ASN-75543479','ASN-2ae5f676','ASN-ed2768fb'];
const TRANSITION_FIELDS = ['urlAfter','urlBefore','causedNavigation','navigatedTo','postcondition','settle','waitFor','navigation','pageAfter','afterUrl'];

(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: '707ba2ac' }, replayIrJson: { not: null } }, select: { status:true, testCase:{ select:{ name:true } }, replayIrJson:true } });
  const seen = new Set();
  for (const asn of TARGETS) {
    const r = rr.find(x => x.replayIrJson.includes(asn));
    if (!r || seen.has(r.testCase.name)) { if(!r) console.log(`\n### ${asn}: not found`); continue; }
    seen.add(r.testCase.name);
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const steps = (ir.ir&&ir.ir.steps)||ir.steps||[];
    console.log(`\n### [${r.status}] "${r.testCase.name}" (${steps.length} steps)`);
    // any transition fields present anywhere?
    const present = new Set();
    const scan = (o)=>{ if(!o||typeof o!=='object')return; for(const k of Object.keys(o)){ if(TRANSITION_FIELDS.includes(k))present.add(k); if(o[k]&&typeof o[k]==='object')scan(o[k]); } };
    steps.forEach(scan);
    console.log(`   transition fields present: ${present.size? [...present].join(', ') : 'NONE'}`);
    steps.forEach((s,i)=>{
      const tag = (s.op==='assert' && (s.contractRef===asn||s.id===asn)) ? '  <<< failing EVALUATE' : '';
      // compact full dump of each step's keys+values
      const compact = {}; for(const k of Object.keys(s)){ const v=s[k]; compact[k]= (typeof v==='string'&&v.length>70)?v.slice(0,70)+'…': (Array.isArray(v)?`[${v.length}]`:v); }
      console.log(`   [${i}] ${JSON.stringify(compact)}${tag}`);
    });
  }
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
