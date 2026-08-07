'use strict';
/* READ-ONLY audit. Proves, on REAL runs, two things before we change anything:
 *  (1) Provenance/asymmetry — does the Output Files TAB (validate:false) render
 *      files that the ZIP (validate:true) would refuse (exportValid=false)?
 *  (2) Locator-precision gap — how many emitted actions hit QAAI_UNRESOLVED_LOCATOR
 *      (no approvable locator) or fall to the runtime resolver (weak), i.e. the
 *      nameless/ambiguous element cases item 1.5 (action-time identity enrichment) targets.
 * No disk writes, no DB mutations: buildReplayExport returns an in-memory file map.
 */
const path = require('path');
try { require(path.join(__dirname, '..', 'server', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

(async () => {
  const { PrismaClient } = require('../server/node_modules/@prisma/client');
  const prisma = new PrismaClient();
  let buildReplayExport;
  try { ({ buildReplayExport } = require('../server/services/codegen/replayExport')); }
  catch (e) { console.error('cannot load replayExport:', e.message); process.exit(1); }

  let rows = [];
  try { rows = await prisma.runResult.findMany({ where: { replayIrJson: { not: null } }, select: { runId: true, createdAt: true } }); }
  catch (e1) {
    try { rows = await prisma.runResult.findMany({ where: { replayIrJson: { not: null } }, select: { runId: true } }); }
    catch (e2) { console.error('RunResult.replayIrJson query failed:', e2.message); }
  }
  if (!rows.length) {
    const total = await prisma.runResult.count().catch(() => '?');
    console.log(`NO RunResult has replayIrJson (total RunResults=${total}).`);
    console.log('=> These runs CANNOT use the certified ReplayIR path. If the tab still shows scripts for them, they came from a NON-ReplayIR/legacy path — a prime suspect for the broken code you saw.');
    await prisma.$disconnect(); return;
  }
  const seen = new Map();
  for (const r of rows) { const t = r.createdAt ? +new Date(r.createdAt) : 0; if (!seen.has(r.runId) || t > seen.get(r.runId)) seen.set(r.runId, t); }
  const runIds = [...seen.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 6);
  console.log(`Found ${seen.size} run(s) with ReplayIR evidence; auditing ${runIds.length} most recent (framework=playwright-reference, validate:false = the TAB view).\n`);

  for (const runId of runIds) {
    const run = await prisma.run.findUnique({ where: { id: runId }, select: { projectId: true } }).catch(() => null);
    if (!run) { console.log(`run ${String(runId).slice(0, 8)}: project lookup failed`); continue; }
    let exp;
    try { exp = await buildReplayExport({ projectId: run.projectId, runId, framework: 'playwright-reference', validate: false }); }
    catch (e) { console.log(`run ${String(runId).slice(0, 8)}: buildReplayExport threw: ${e.message}`); continue; }
    const files = exp.files || {};
    const specNames = Object.keys(files).filter((n) => /\.(spec\.[jt]s|feature|java)$/.test(n));
    const errF = (exp.findings || []).filter((f) => f.severity === 'error');
    let unresolved = 0, runtimeFb = 0, firstC = 0;
    for (const n of specNames) { const c = files[n] || ''; unresolved += (c.match(/QAAI_UNRESOLVED_LOCATOR/g) || []).length; runtimeFb += (c.match(/resolveLocator\(/g) || []).length; firstC += (c.match(/\.first\(\)/g) || []).length; }
    const asym = exp.manifest && exp.manifest.exportValid === false && specNames.length > 0;
    console.log(`run ${String(runId).slice(0, 8)} | specs=${specNames.length} admitted=${(exp.admitted || []).length} blocked=${(exp.blocked || []).length} | exportValid=${exp.manifest ? exp.manifest.exportValid : '?'} errFindings=${errF.length} | unresolvedLoc=${unresolved} runtimeFallback=${runtimeFb} first()=${firstC}${asym ? '  <-- TAB shows files the ZIP refuses' : ''}`);
    if (errF.length) console.log(`         err rules: ${[...new Set(errF.map((f) => f.rule))].slice(0, 6).join(', ')}`);
    if ((exp.blocked || []).length) console.log(`         block reasons: ${[...new Set(exp.blocked.map((b) => b.code))].join(', ')}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error('AUDIT FAILED:', e); process.exit(1); });
