'use strict';
/* CLASS E PRE-FLIGHT (READ-ONLY). Three questions, no mutations, no codegen:
 *  (1) Evidence trail: do the run's TestCases carry an authProfile? what values?
 *  (2) AuthProfile inventory: what profiles exist for the project (names/handles + whether
 *      they carry usable credential refs / storage state) — VALUES MASKED.
 *  (3) Login locator schema: extract the reusable login step block from the IR of the
 *      case(s) that actually performed a login (goto + fill user/pass + click), so we know
 *      what a composed precondition would look like.
 *  (4) Credential reality: which QAAI_* env KEYS are configured (names only, never values).
 */
const path = require('path');
const fs = require('fs');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
const RUN = process.argv[2] || '707ba2ac';
const mask = (v) => v == null ? null : (typeof v === 'string' ? `<${v.length} chars>` : typeof v);

(async () => {
  // resolve run + project
  const anyRR = await p.runResult.findFirst({ where: { runId: { startsWith: RUN } }, select: { runId: true } });
  const run = anyRR ? await p.run.findUnique({ where: { id: anyRR.runId }, select: { projectId: true, id: true } }) : null;
  const projectId = run && run.projectId;
  console.log(`=== run ${RUN} project ${projectId} ===\n`);

  // (1) Evidence trail: authProfile across the run's cases
  const rrs = await p.runResult.findMany({ where: { runId: { startsWith: RUN } }, select: { testCaseId: true, status: true, testCase: { select: { name: true, authProfile: true, module: true, scenarioId: true, dependsOnIds: true } } } });
  const profCount = {};
  for (const r of rrs) { const ap = (r.testCase && r.testCase.authProfile) || '(none)'; profCount[ap] = (profCount[ap]||0)+1; }
  console.log('(1) TestCase.authProfile distribution across run cases:');
  for (const [k,v] of Object.entries(profCount)) console.log(`     ${k}: ${v} case(s)`);

  // (2) AuthProfile inventory for the project
  console.log('\n(2) AuthProfile rows for project:');
  let profiles = [];
  try { profiles = await p.authProfile.findMany({ where: { projectId } }); } catch (e) { console.log('   authProfile query failed:', e.message); }
  if (!profiles.length) console.log('   (none)');
  for (const pr of profiles) {
    const keys = Object.keys(pr);
    const safe = {};
    for (const k of keys) { safe[k] = /pass|secret|token|cred|value/i.test(k) ? mask(pr[k]) : pr[k]; }
    console.log('   -', JSON.stringify(safe).slice(0, 400));
  }
  // authFixture (storage state) inventory
  try {
    const fx = await p.authFixture.findMany({ where: { projectId }, select: { id: true, name: true, profileName: true, createdAt: true } }).catch(()=>[]);
    console.log(`\n   authFixture rows: ${fx.length}`);
    for (const f of fx) console.log('     -', JSON.stringify(f).slice(0,200));
  } catch(_){}

  // (3) Login locator schema from the IR of a login-performing case
  console.log('\n(3) Login step block (from a case whose IR fills username/password):');
  const withIr = await p.runResult.findMany({ where: { runId: { startsWith: RUN }, replayIrJson: { not: null } }, select: { testCaseId: true, replayIrJson: true, testCase: { select: { name: true, authProfile: true } } } });
  let shown = 0;
  for (const r of withIr) {
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const steps = (ir.ir && ir.ir.steps) || ir.steps || [];
    const fills = steps.filter(s => s.op === 'act' && /fill|type/i.test(s.action||''));
    const hasGoto = steps.some(s => s.op === 'act' && /goto|navigate/i.test(s.action||'') || s.op === 'navigate');
    if (fills.length >= 2 && hasGoto) {
      console.log(`   case "${r.testCase && r.testCase.name}" authProfile=${r.testCase && r.testCase.authProfile}:`);
      steps.slice(0, 10).forEach((s, i) => {
        if (s.op === 'resolve') console.log(`     [${i}] resolve as=${s.as} candidates=${JSON.stringify(s.candidates)}`);
        else if (s.op === 'act') console.log(`     [${i}] act ${s.action} target=${s.target||''} valueRef=${s.valueRef||''} value=${s.value!=null?JSON.stringify(s.value):''}`);
        else if (s.op === 'navigate' || (s.op==='act' && /goto/i.test(s.action||''))) console.log(`     [${i}] ${s.op} ${s.url||s.value||''}`);
      });
      if (++shown >= 1) break;
    }
  }
  if (!shown) console.log('   (no login-performing IR found)');

  // (4) Credential reality — env KEY names only
  console.log('\n(4) QAAI_* / credential env KEYS configured (names only):');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const keys = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).map(l=>l.trim()).filter(l=>l && !l.startsWith('#') && l.includes('=')).map(l=>l.slice(0,l.indexOf('=')));
    const credKeys = keys.filter(k => /QAAI|USER|PASS|CRED|ESS|ADMIN|LOGIN|SECRET|TOKEN/i.test(k));
    console.log('   ', credKeys.length ? credKeys.join(', ') : '(none matched)');
    console.log(`   (total env keys: ${keys.length})`);
  } else console.log('   .env not found at', envPath);

  await p.$disconnect();
})().catch(e => { console.error('PREFLIGHT FAILED:', e.message); process.exit(1); });
