'use strict';
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const { loadResultsForExport } = require('../server/services/codegen/replayExport');
const prisma = new PrismaClient();
(async () => {
  const runId = '707ba2ac-fb5f-4fce-bc12-f5c8f0dfab2c';
  const { results } = await loadResultsForExport({ projectId: null, runId, runResultIds: null });
  console.log('results:', results.length);
  for (const r of results) {
    const steps = r.envelope && r.envelope.ir && r.envelope.ir.steps || [];
    const asserts = steps.filter(s => s.op === 'assert');
    const refs = asserts.map(s => ({ ref: s.contractRef || s.id, ch: s.channel, lo: s.liveOutcome }));
    const hit = refs.find(x => x.ref === 'ASN-2160ad0d');
    if (hit) {
      console.log(`case ${r.testCaseId?.slice(0,8)} status=${r.status} — FOUND ASN-2160ad0d:`, JSON.stringify(hit));
      console.log('  assert step keys sample:', JSON.stringify(Object.keys(asserts[0]||{})));
      console.log('  all assert refs/outcomes:', JSON.stringify(refs));
    }
  }
  await prisma.$disconnect();
})().catch(e=>{console.error(e.message, e.stack);process.exit(1)});
