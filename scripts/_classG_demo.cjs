'use strict';
/* Prove the Class G core on REAL run data: build the locator repository from run 707ba2ac's
 * pinned IRs and print the generated per-page semantic locators, conflicts, and weak-evidence
 * entries. Read-only. */
const path = require('path');
try { require(path.join(__dirname,'..','server','node_modules','dotenv')).config({path:path.join(__dirname,'..','.env')}); } catch(_){}
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const { buildLocatorRepository } = require('../server/services/codegen/pageObjectRepository');
const p = new PrismaClient();
(async () => {
  const rr = await p.runResult.findMany({ where: { runId: { startsWith: process.argv[2] || '707ba2ac' }, replayIrJson: { not: null } } });
  const cases = [];
  for (const r of rr) { try { const ir = JSON.parse(r.replayIrJson); cases.push({ ir: ir.ir || ir }); } catch {} }
  const rep = buildLocatorRepository({ cases });
  console.log(`cases=${cases.length}  files=${Object.keys(rep.files).length}  conflicts=${rep.conflicts.length}\n`);
  for (const file of Object.keys(rep.files).sort()) {
    console.log(`locators/${file}.locators.ts`);
    for (const [name, v] of Object.entries(rep.files[file])) console.log(`    ${name.padEnd(22)} = ${v.expr}`);
    console.log('');
  }
  if (rep.conflicts.length) {
    console.log('CONFLICTS (would HARD-BLOCK, surfaced both):');
    for (const c of rep.conflicts) console.log(`  [${c.file}] ${c.name}: ${c.existing}  VS  ${c.incoming}`);
  }
  const weak = rep.manifest.filter((m) => m.status === 'weak');
  console.log(`\nweak-evidence resolves (no clean name/locator) = ${weak.length}`);
  for (const w of weak.slice(0, 8)) console.log(`  ${w.as}: ${w.reason}${w.expr ? ' :: ' + w.expr : ''}`);
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
