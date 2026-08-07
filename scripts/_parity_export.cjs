'use strict';
/* CHAIN STEP 1 (read-only export to disk): take run 707ba2ac, walk the REAL chain
 *   replayIrJson -> buildReplayExport -> file map -> write to a scratch dir
 * and print the manifest + one full spec so we can SEE the chain is wired before we
 * try to actually run it. No DB writes. Scratch dir is outside the repo tree.
 */
const path = require('path');
const fs = require('fs');
try { require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

const RUN_PREFIX = process.argv[2] || '707ba2ac';
const OUT = process.argv[3] || path.join(__dirname, '..', '..', '_parity', RUN_PREFIX);

(async () => {
  const { PrismaClient } = require('../server/node_modules/@prisma/client');
  const prisma = new PrismaClient();
  const { buildReplayExport } = require('../server/services/codegen/replayExport');

  // resolve the full runId from the prefix
  const rows = await prisma.runResult.findMany({ where: { replayIrJson: { not: null } }, select: { runId: true, createdAt: true } });
  const match = rows.map(r => r.runId).find(id => String(id).startsWith(RUN_PREFIX));
  if (!match) { console.log(`no run with replayIrJson starting ${RUN_PREFIX}. available: ${[...new Set(rows.map(r=>String(r.runId).slice(0,8)))].join(', ')}`); await prisma.$disconnect(); return; }
  const runId = match;
  const run = await prisma.run.findUnique({ where: { id: runId }, select: { projectId: true } });
  console.log(`runId=${runId}\nprojectId=${run.projectId}`);

  const exp = await buildReplayExport({ projectId: run.projectId, runId, framework: 'playwright-reference', validate: false });
  const files = exp.files || {};
  const names = Object.keys(files);
  console.log(`\nfiles=${names.length} admitted=${(exp.admitted||[]).length} blocked=${(exp.blocked||[]).length} exportValid=${exp.manifest ? exp.manifest.exportValid : '?'}`);
  if ((exp.blocked||[]).length) console.log(`block reasons: ${[...new Set(exp.blocked.map(b=>b.code))].join(', ')}`);

  // write all files to scratch. Overwrite in place — preserve node_modules/.env/results
  // (locked + expensive to reinstall). Clean only the tests/ subtree so removed specs
  // don't linger as stale files.
  fs.mkdirSync(OUT, { recursive: true });
  try { fs.rmSync(path.join(OUT, 'tests'), { recursive: true, force: true }); } catch (_) {}
  for (const n of names) {
    const dest = path.join(OUT, n);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[n] == null ? '' : String(files[n]));
  }
  console.log(`\nwrote ${names.length} files -> ${OUT}\n`);
  console.log('--- TREE ---');
  for (const n of names.sort()) console.log(`  ${n}  (${String(files[n]||'').length}b)`);

  // print the first spec in full so we can eyeball the chain
  const firstSpec = names.filter(n => /\.spec\.[jt]s$/.test(n)).sort()[0];
  if (firstSpec) {
    console.log(`\n--- FULL: ${firstSpec} ---\n`);
    console.log(files[firstSpec]);
  }
  await prisma.$disconnect();
})().catch(e => { console.error('EXPORT FAILED:', e); process.exit(1); });
