'use strict';
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const RID = run.id;
  console.log('RUN', RID);

  // ---- A) Drill the REAL nested IR for admin-login ----
  const rr = await p.runResult.findFirst({ where: { runId: RID, testCase: { name: { contains: 'valid credentials' } } }, select: { replayIrJson: true } });
  const outer = parse(rr?.replayIrJson);
  const ir = outer?.ir || outer; // actions nest under .ir
  const acts = Array.isArray(ir?.actions) ? ir.actions : (Array.isArray(ir?.steps) ? ir.steps : []);
  console.log(`\n=== admin-login IR: ${acts.length} actions ===`);
  acts.forEach((a, i) => {
    const loc = a.locator || a.usableLocator || a.codegenLocator || (a.locatorDiagnostic && a.locatorDiagnostic.expr) || null;
    const db = a.dataBinding || a.binding || null;
    console.log(`  [${i}] tool=${a.tool || a.action || a.type} label="${(a.elementLabel || a.target || '').toString().slice(0,40)}"`);
    console.log(`       locator=${loc ? JSON.stringify(loc).slice(0,120) : 'NONE'}  confidence=${a.locatorConfidence || a.confidence || '-'}  dataBinding=${db ? JSON.stringify(db).slice(0,80) : 'none'}`);
    if (a.locatorDiagnostic) console.log(`       diag=${JSON.stringify(a.locatorDiagnostic).slice(0,160)}`);
  });

  // ---- B) Reproduce buildReplayExport (no validate to skip npm/pw dep check) ----
  const { buildReplayExport } = require(path.join(ROOT, 'server', 'services', 'codegen', 'replayExport'));
  console.log('\n=== buildReplayExport({validate:false}) ===');
  let out;
  try { out = await buildReplayExport({ projectId: PID, runId: RID, validate: false }); }
  catch (e) { console.log('THREW:', e.message); await p.$disconnect(); process.exit(1); }
  console.log(`allBlocked=${out.allBlocked}  admitted=${out.admitted?.length}  blocked=${out.blocked?.length}`);
  console.log(`files emitted: ${Object.keys(out.files || {}).length}`);
  Object.keys(out.files || {}).filter((f) => /\.(spec\.)?(js|ts|feature)$/.test(f)).slice(0, 20).forEach((f) => console.log(`   spec: ${f} (${out.files[f].length}b)`));
  console.log('\n--- blocked reasons ---');
  (out.blocked || []).forEach((b) => {
    console.log(`  • ${b.testCaseId || b.caseId || b.name || '?'} :: ${b.reason || b.code || ''} ${b.gaps ? '| gaps=' + JSON.stringify((b.gaps || []).map((g) => g.type || g.code)).slice(0,200) : ''}`);
  });
  console.log('\n--- error-severity findings ---');
  (out.findings || []).filter((f) => f.severity === 'error').slice(0, 20).forEach((f) => console.log(`  [${f.rule || f.type}] ${(f.message || '').slice(0, 180)}`));

  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
