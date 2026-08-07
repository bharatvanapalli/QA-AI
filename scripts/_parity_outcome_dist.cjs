'use strict';
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: process.argv[2] || '707ba2ac' }, replayIrJson: { not: null } }, select: { testCaseId:true, status:true, assertionCheckResults:true } });
  const dist = {};            // outcome -> count (effective, one per assertionId per case)
  const rawDist = {};         // raw observation outcomes
  let casesWithUncheckable = 0;
  for (const r of rr) {
    if (!r.assertionCheckResults) continue;
    let acr; try { acr = JSON.parse(r.assertionCheckResults); } catch { continue; }
    const arr = Array.isArray(acr) ? acr : Object.values(acr);
    const byId = {};
    for (const a of arr) {
      const id = a.assertionId || a.id; const o = a.outcome || a.result;
      if (!id) continue;
      rawDist[o] = (rawDist[o]||0)+1;
      // reduce: not_matched dominates > matched > uncheckable
      const cur = byId[id];
      if (o === 'not_matched') byId[id] = 'not_matched';
      else if (o === 'matched' && cur !== 'not_matched') byId[id] = 'matched';
      else if (!cur) byId[id] = o;
    }
    let hadUnc = false;
    for (const id of Object.keys(byId)) { dist[byId[id]] = (dist[byId[id]]||0)+1; if (byId[id]==='uncheckable') hadUnc = true; }
    if (hadUnc) casesWithUncheckable++;
  }
  console.log('EFFECTIVE per-assertion (reduced):', JSON.stringify(dist));
  console.log('RAW observation outcomes        :', JSON.stringify(rawDist));
  console.log('cases with >=1 uncheckable assertion:', casesWithUncheckable, '/', rr.length);
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
