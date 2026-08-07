'use strict';
/* READ-ONLY pre-flight for SELF-HEALING the 2 stranded cases. Verifies the healing premises
 * against the real IR before we build anything.
 *  (1) logout: is there ANY replayable logout mechanism in the run? Scan every case for a
 *      logout action — UI click (and its locator quality) OR a /logout URL navigation.
 *  (2) masking: dump step-2's full resolve candidates (el1/el2/el3) incl. every field, to see
 *      if a type/inputType signal exists for type-based recovery, and whether the ghost fields
 *      are really the single login Password field mis-named from data values. */
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const p = new PrismaClient();
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: '707ba2ac' }, replayIrJson: { not: null } }, select: { status:true, testCase:{select:{name:true}}, replayIrJson:true } });

  console.log('=== (1) LOGOUT mechanisms across the run ===');
  for (const r of rr) {
    let ir; try { ir = JSON.parse(r.replayIrJson); } catch { continue; }
    const steps = (ir.ir&&ir.ir.steps)||ir.steps||[];
    steps.forEach((s,i)=>{
      const blob = JSON.stringify(s).toLowerCase();
      const isLogoutNav = s.op==='act' && s.action==='navigate' && /logout/i.test(s.url||'');
      const isLogoutClick = (s.op==='resolve' || s.op==='act') && /log\s?out|sign\s?out/.test(blob);
      if (isLogoutNav) console.log(`  [${r.status}] "${r.testCase.name.slice(0,40)}" step${i}: NAV ${s.url}`);
      else if (isLogoutClick && s.op==='resolve') console.log(`  [${r.status}] "${r.testCase.name.slice(0,40)}" step${i}: RESOLVE candidates=${JSON.stringify(s.candidates)}`);
    });
  }

  console.log('\n=== (2) MASKING step-2 resolve candidates (full) ===');
  const m = rr.find(x => /Password masking persists/i.test(x.testCase.name));
  if (m) {
    let ir = JSON.parse(m.replayIrJson); const steps=(ir.ir&&ir.ir.steps)||ir.steps||[];
    steps.forEach((s,i)=>{
      if (s.op==='resolve') console.log(`  step${i} resolve as=${s.as}: ${JSON.stringify(s.candidates)}`);
      else if (s.op==='act') console.log(`  step${i} act ${s.action} target=${s.target||''} valueRef=${s.valueRef||''} rawValue=${s.rawValue!=null?JSON.stringify(s.rawValue):''} inputType=${s.inputType||s.type||'(none)'}`);
      else console.log(`  step${i} ${s.op} ${s.channel||''} ${s.script?String(s.script).slice(0,40):''}`);
    });
  } else console.log('  masking-persists case not found');
  await p.$disconnect();
})().catch(e=>{console.error(e.message);process.exit(1)});
