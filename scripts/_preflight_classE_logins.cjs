'use strict';
/* CLASS E PRE-FLIGHT cont. (READ-ONLY): enumerate EVERY login-performing case in the run —
 * its scenario, the credential refs it fills, and whether a DISTINCT ESS login (different
 * creds) exists. This is the credential-reality check: it decides whether ESS-session cases
 * can be composed from a real ESS login block, or must honestly BLOCK_MISSING_PROFILE_CREDENTIALS. */
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
const RUN = process.argv[2] || '707ba2ac';
(async () => {
  const rrs = await p.runResult.findMany({ where: { runId: { startsWith: RUN }, replayIrJson: { not: null } }, select: { testCaseId: true, status: true, replayIrJson: true, testCase: { select: { name: true, scenarioId: true } } } });
  // scenario name map
  const sids = [...new Set(rrs.map(r=>r.testCase&&r.testCase.scenarioId).filter(Boolean))];
  const snames = {}; if (sids.length) for (const s of await p.testScenario.findMany({where:{id:{in:sids}},select:{id:true,name:true}})) snames[s.id]=s.name;

  const logins = [];           // cases that fill user+pass
  const sessionScenarios = {}; // scenarioId -> has a login case
  const allBySid = {};         // scenarioId -> [{name,hasLogin}]
  for (const r of rrs) {
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const steps = (ir.ir && ir.ir.steps) || ir.steps || [];
    const fills = steps.filter(s => s.op==='act' && /fill|type/i.test(s.action||''));
    const credRefs = fills.map(s => s.valueRef || (s.value!=null?`literal:${String(s.value).slice(0,20)}`:'?'));
    const isLogin = fills.length >= 2 && fills.some(s => /pass/i.test(s.valueRef||s.target||''));
    const sid = r.testCase && r.testCase.scenarioId;
    allBySid[sid] = allBySid[sid] || [];
    allBySid[sid].push({ name: r.testCase && r.testCase.name, isLogin });
    if (isLogin) { logins.push({ name: r.testCase&&r.testCase.name, sid, sname: snames[sid], credRefs }); sessionScenarios[sid]=true; }
  }
  console.log(`=== login-performing cases in ${RUN} ===`);
  for (const l of logins) console.log(`  [${l.sname||l.sid}] "${l.name}" credRefs=${JSON.stringify(l.credRefs)}`);
  console.log(`\ndistinct credential refs used across all logins:`);
  const allRefs = [...new Set(logins.flatMap(l=>l.credRefs))];
  console.log('  ', JSON.stringify(allRefs));

  console.log(`\n=== scenarios & whether they contain a login case ===`);
  for (const sid of Object.keys(allBySid)) {
    const cases = allBySid[sid]; const hasLogin = cases.some(c=>c.isLogin);
    console.log(`  [${snames[sid]||sid}] login=${hasLogin?'YES':'NO '} cases=${cases.length}`);
    if (!hasLogin) for (const c of cases) console.log(`       (needs composed precondition) "${c.name}"`);
  }
  await p.$disconnect();
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1)});
