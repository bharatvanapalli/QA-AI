'use strict';
// Why no output files on a clean pass? Empirical: latest run → passed cases →
// ReplayIR completeness + exportMeta gaps + GovernancePR rows + codegen-failures evidence.
const path = require('path'); const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });
const fs = require('fs');
// Use the SERVER's prisma client — the root one is stale (missing TestCase.specCode). See memory: prisma-dual-client-server-stale.
const { PrismaClient } = require(path.join(ROOT, 'server', 'node_modules', '@prisma', 'client'));
const p = new PrismaClient();
const PID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

(async () => {
  const run = await p.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' },
    select: { id: true, status: true, passed: true, failed: true, blocked: true, startedAt: true } });
  console.log(`LATEST RUN ${run.id} status=${run.status} pass=${run.passed} fail=${run.failed} blocked=${run.blocked} @ ${run.startedAt.toISOString()}`);

  const results = await p.runResult.findMany({ where: { runId: run.id },
    select: { id: true, testCaseId: true, status: true, replayIrJson: true, exportMeta: true, blockedReason: true } });
  const passed = results.filter((r) => /^pass/.test(String(r.status)));
  console.log(`\nRunResults: ${results.length} total, ${passed.length} pass`);

  // Per passed case: IR completeness + usable-locator count + export decision
  for (const r of passed) {
    const ir = parse(r.replayIrJson);
    const meta = parse(r.exportMeta);
    const tc = await p.testCase.findUnique({ where: { id: r.testCaseId }, select: { name: true, specCode: true } });
    const title = (tc?.name || r.testCaseId).slice(0, 50);
    if (!ir) { console.log(`  ✗ ${title} — NO replayIrJson (IR never built)`); continue; }
    const acts = Array.isArray(ir.actions) ? ir.actions : (Array.isArray(ir.steps) ? ir.steps : []);
    const withLoc = acts.filter((a) => a && (a.locator || a.usableLocator || a.codegenLocator || (a.locatorDiagnostic && a.locatorDiagnostic.expr))).length;
    const inert = acts.filter((a) => a && (a.legacy_inert || a.dropped || a.status === 'legacy_inert')).length;
    const specLen = (tc?.specCode || '').length;
    const STUB = /could not certify|evidence is incomplete|internal evidence|not a confirmed/i.test(tc?.specCode || '');
    console.log(`  • ${title}`);
    console.log(`      IR complete=${ir.complete} actions=${acts.length} withLocator=${withLoc} inert=${inert}`);
    console.log(`      exportMeta=${meta ? JSON.stringify(meta).slice(0, 300) : 'null'}`);
    console.log(`      TestCase.specCode: ${specLen}b ${STUB ? '(STUB/blocked)' : specLen > 200 ? '(real spec ✓)' : '(empty)'}`);
  }

  const prs = await p.governancePR.findMany({ where: { runId: run.id }, select: { filename: true, specCode: true, lintPassed: true } });
  console.log(`\nGovernancePR rows for this run: ${prs.length}`);
  for (const pr of prs) {
    const code = pr.specCode || '';
    const STUB = /could not certify|evidence is incomplete|internal evidence|not a confirmed/i.test(code);
    console.log(`  • ${pr.filename} len=${code.length} ${!code.trim() ? 'EMPTY' : STUB ? 'STUB' : 'REAL ✓'}`);
  }

  for (const f of [path.join(ROOT, 'evidence', 'codegen-failures.json'), path.join(ROOT, 'server', 'evidence', 'codegen-failures.json')]) {
    if (fs.existsSync(f)) {
      console.log(`\n=== ${f.replace(ROOT, '.')} (mtime ${fs.statSync(f).mtime.toISOString()}) ===`);
      console.log(JSON.stringify(parse(fs.readFileSync(f, 'utf8')), null, 2).slice(0, 3500));
    }
  }
  await p.$disconnect();
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
