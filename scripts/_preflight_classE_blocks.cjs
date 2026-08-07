'use strict';
/* READ-ONLY: confirm the stranding mechanism — list admitted vs blocked cases for the run,
 * so we verify the ESS-login (session-establishing) case is BLOCKED while the dependent
 * RBAC/ESS-dashboard/ESS-sidebar cases are ADMITTED (hence stranded without a session). */
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const { buildReplayExport } = require('../server/services/codegen/replayExport');
const p = new PrismaClient();
(async () => {
  const RUN = process.argv[2] || '707ba2ac';
  const anyRR = await p.runResult.findFirst({ where: { runId: { startsWith: RUN } }, select: { runId: true } });
  const run = await p.run.findUnique({ where: { id: anyRR.runId }, select: { projectId: true, id: true } });
  const exp = await buildReplayExport({ projectId: run.projectId, runId: run.id, framework: 'playwright-reference', validate: false });
  const nameOf = async (tcid) => { const tc = await p.testCase.findUnique({ where: { id: tcid }, select: { name: true } }).catch(()=>null); return tc && tc.name; };
  console.log('=== BLOCKED ===');
  for (const b of exp.blocked || []) console.log(`  [${b.code}] ${await nameOf(b.testCaseId)}`);
  console.log('\n=== ADMITTED (journey files) ===');
  for (const a of exp.admitted || []) {
    const names = [];
    for (const tcid of (a.testCaseIds || [a.testCaseId]).filter(Boolean)) names.push(await nameOf(tcid));
    console.log(`  ${a.filePath}`);
    for (const n of names) console.log(`       - ${n}`);
  }
  await p.$disconnect();
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1)});
