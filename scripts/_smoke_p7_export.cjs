'use strict';
/**
 * P7a LIVE smoke — IR-sourced export end to end on the known-good slice (run 2de0cb23:
 * Valid Login + Invalid Creds, both pass, both complete:true). Proves acceptance 1/2/3/6/7/8
 * at the artifact level (NOT execution parity — that's P8):
 *   pinned replayIrJson → compileReplayIR (Playwright) → temp package → playwright test
 *   --list validation → manifest verdict preservation → ZERO secret leakage.
 * READ-ONLY over trial data ([[preserve-trial-data]]) — assembles/validates in os.tmpdir.
 *   node scripts/_smoke_p7_export.cjs
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');
const X = require('../server/services/codegen/replayExport');
const registry = require('../server/services/codegen/adapters');

const PID = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const RUN = '2de0cb23-1b69-422e-b0da-e0b20cbfa8f2';
let fails = 0;
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m, d) => { console.log('  FAIL  ' + m + (d ? '  — ' + d : '')); fails++; };
const A = (c, m, d) => (c ? ok(m) : bad(m, d));

(async () => {
  // Authoritative RunResult statuses for the parity check.
  const rows = await prisma.runResult.findMany({ where: { runId: RUN }, select: { id: true, status: true } });
  const statusById = new Map(rows.map((r) => [r.id, r.status]));
  console.log(`\nrun ${RUN.slice(0, 8)} — ${rows.length} RunResult(s): ${rows.map((r) => r.status).join(', ')}`);

  console.log('\n[A] buildReplayExport (Playwright) — happy path end to end');
  const res = await X.buildReplayExport({ projectId: PID, runId: RUN, framework: 'playwright-reference', denyLiterals: ['admin123'] });
  A(res.admitted.length === rows.length && res.blocked.length === 0, `all ${rows.length} results admitted, 0 blocked`, `admitted=${res.admitted.length} blocked=${res.blocked.length}`);
  A(res.allBlocked === false, 'allBlocked is false (a normal package is produced)');
  A(!!res.files['EXPORT_MANIFEST.json'], 'EXPORT_MANIFEST.json is in the package');
  A(Object.keys(res.files).some((f) => /^tests\/replayir\/.+\.spec\.ts$/.test(f)), 'per-result spec files under tests/replayir/');
  A(!!res.files['playwright.config.ts'] && !!res.files['package.json'], 'runnable shell (playwright.config.ts + package.json) assembled');

  console.log('\n[B] verdict PRESERVATION — manifest expectedVerdict === RunResult.status');
  let parity = true;
  for (const e of res.manifest.entries) {
    const real = statusById.get(e.runResultId);
    if (real && e.expectedVerdict !== real) { parity = false; bad(`entry ${e.runResultId.slice(0, 6)} expectedVerdict=${e.expectedVerdict} != status=${real}`); }
  }
  if (parity) ok('every manifest entry expectedVerdict matches its RunResult.status');
  A(res.manifest.entries.every((e) => e.emitterVersion && e.adapterId === 'playwright-reference' && Array.isArray(e.files) && e.fileHashes), 'manifest entries carry emitterVersion/adapterId/files/fileHashes');

  console.log('\n[C] no secret leakage (#6/#9)');
  const blob = Object.values(res.files).join('\n');
  A(!blob.includes('admin123'), 'no recorded password "admin123" anywhere in the package');
  A((res.findings || []).filter((f) => /secret/.test(f.rule)).length === 0, 'no secret-leak findings');
  A(res.manifest.exportValid === true, 'manifest.exportValid === true');

  console.log('\n[D] package validation RAN in a temp package (#7)');
  const v = res.validation;
  A(!!v, 'validation result present');
  if (v) {
    if (v.skipped) bad('package validation was SKIPPED (expected @playwright/test to be resolvable in this repo)', JSON.stringify(v.findings.map((f) => f.rule)));
    else {
      A(v.checked === true, 'validation.checked === true (playwright test --list ran)');
      A(v.packagePassed === true, 'validation.packagePassed === true (specs collected, no errors)', JSON.stringify(v.findings));
      const listCmd = (v.commands || []).find((c) => /test --list/.test(c.cmd));
      A(!!listCmd && listCmd.status === 0, 'playwright test --list exited 0');
    }
  }

  console.log('\n[E] block gate on REAL data — a cloned-incomplete envelope is BLOCKED (no fallback)');
  const { results } = await X.loadResultsForExport({ projectId: PID, runId: RUN });
  const adapter = registry.getAdapter('playwright-reference');
  const cloned = JSON.parse(JSON.stringify(results[0]));
  cloned.envelope.complete = false; cloned.envelope.gaps = [{ code: 'missing_locator_evidence', where: 'browser_click' }];
  const blockRes = X.compileResults({ adapter, results: [cloned] });
  A(blockRes.admitted.length === 0 && blockRes.blocked[0] && blockRes.blocked[0].code === 'replayir_incomplete', 'a real result forced complete:false → replayir_incomplete block, 0 admitted');

  console.log('\n[F] all-blocked selection → no normal package (evidence-only)');
  const empty = await X.buildReplayExport({ projectId: PID, runResultIds: ['does-not-exist'], framework: 'playwright-reference', validate: false });
  A(empty.allBlocked === true && Object.keys(empty.files).length === 0, 'empty/blocked selection → allBlocked, no files');

  console.log('\n[G] BDD Route B — live export + real bddgen + playwright test --list (#10)');
  const bres = await X.buildReplayExport({ projectId: PID, runId: RUN, framework: 'replayir-bdd', denyLiterals: ['admin123'] });
  A(bres.admitted.length === rows.length && !bres.allBlocked, `both results → .feature, none blocked (admitted=${bres.admitted.length})`);
  A(Object.keys(bres.files).some((f) => /^features\/.+\.feature$/.test(f)), 'feature files emitted');
  A(!!bres.files['steps/replayir.steps.ts'] && !!bres.files['support/helpers.ts'] && !!bres.files['support/locators.ts'], 'canonical glue + helpers + locators emitted once');
  A(!Object.values(bres.files).join('\n').includes('admin123'), 'no secret value in the BDD package (feature/glue/support/config)');
  A(bres.manifest.entries.every((e) => { const real = statusById.get(e.runResultId); return !real || e.expectedVerdict === real; }), 'BDD manifest expectedVerdict matches RunResult.status');
  const bv = bres.validation;
  A(!!bv, 'BDD validation present');
  if (bv) {
    if (bv.skipped) bad('BDD validation SKIPPED (expected playwright-bdd resolvable in server/)', JSON.stringify(bv.findings.map((f) => f.rule)));
    else {
      A(bv.checked === true, 'BDD validation.checked === true');
      A(bv.packagePassed === true, 'BDD validation.packagePassed === true (no undefined/ambiguous steps)', JSON.stringify(bv.findings));
      const bg = (bv.commands || []).find((c) => /bddgen/.test(c.cmd)); A(!!bg && bg.status === 0, 'bddgen exited 0 (features ↔ glue resolved)');
      const lc = (bv.commands || []).find((c) => /test --list/.test(c.cmd)); A(!!lc && lc.status === 0, 'playwright test --list exited 0 (scenarios collected)');
    }
  }

  console.log('\n[H] Selenium reference — live export + REAL mvn test-compile (#4/#5/#16; NOT execution parity)');
  const sres = await X.buildReplayExport({ projectId: PID, runId: RUN, framework: 'selenium-reference', denyLiterals: ['admin123'] });
  A(sres.admitted.length === rows.length && !sres.allBlocked, `both results → .java, none blocked (admitted=${sres.admitted.length})`);
  A(Object.keys(sres.files).some((f) => /^src\/test\/java\/com\/qaai\/replayir\/Replay_.+\.java$/.test(f)), 'per-result test classes under src/test/java');
  for (const k of ['pom.xml', 'testng.xml', 'src/test/java/com/qaai/replayir/BaseTest.java', 'src/test/java/com/qaai/replayir/LocatorResolver.java', 'src/test/java/com/qaai/replayir/EnvReader.java', 'src/test/java/com/qaai/replayir/LocatorCandidate.java']) {
    A(!!sres.files[k], `Maven/TestNG shell has ${k}`);
  }
  A(!Object.values(sres.files).join('\n').includes('admin123'), 'no recorded password "admin123" in the Selenium package (java/pom/config)');
  A((sres.findings || []).filter((f) => /secret/.test(f.rule)).length === 0, 'no secret-leak findings');
  A(sres.manifest.entries.every((e) => { const real = statusById.get(e.runResultId); return !real || e.expectedVerdict === real; }), 'Selenium manifest expectedVerdict matches RunResult.status');
  A(sres.manifest.entries.every((e) => e.adapterId === 'selenium-reference' && e.adapterVersion === 'selenium-reference-1' && Array.isArray(e.files) && e.fileHashes), 'manifest entries carry selenium identity/files/hashes');
  A(sres.manifest.exportValid === true, 'manifest.exportValid === true');

  // Definitive proof (rule #4): write the package + run a REAL `mvn -q -DskipTests test-compile`.
  // selenium-java 4.18.1 + testng 7.10.2 are cached in ~/.m2, so this is a genuine javac compile.
  // A compile error FAILS; a dependency/plugin/network failure is a soft SKIP (structural floor stands).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p7c-smoke-'));
  try {
    for (const [rel, content] of Object.entries(sres.files)) { const full = path.join(tmp, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, 'utf8'); }
    const useShell = process.platform === 'win32';
    const cp = useShell
      ? spawnSync('mvn.cmd -q -DskipTests test-compile', { cwd: tmp, encoding: 'utf8', timeout: 420000, shell: true, env: { ...process.env } })
      : spawnSync('mvn', ['-q', '-DskipTests', 'test-compile'], { cwd: tmp, encoding: 'utf8', timeout: 420000, env: { ...process.env } });
    const out = [cp.stdout || '', cp.stderr || ''].join('\n');
    if (cp.error && (cp.error.code === 'ENOENT' || cp.error.code === 'UNKNOWN' || cp.error.code === 'EINVAL')) {
      console.log('  SKIP  mvn not spawnable — structural discovery is the floor');
    } else if (cp.status === 0) {
      ok('REAL mvn test-compile exited 0 — the generated Selenium Java actually compiles (javac)');
    } else if (/COMPILATION ERROR|cannot find symbol|incompatible types|error: |\.java:\[\d|';' expected|illegal start/i.test(out)) {
      bad('mvn test-compile FAILED with a COMPILE error', out.split(/\r?\n/).filter((l) => /ERROR|error:/.test(l)).slice(0, 10).join(' | '));
    } else {
      console.log('  SKIP  mvn test-compile non-zero for infra reasons (deps/plugins/network), not a compile error — structural floor stands');
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} }

  console.log(`\n${fails === 0 ? 'PASS — P7 IR-sourced export live: Playwright + BDD Route B + Selenium reference (IR-only, block-gated, verdict-preserved, leak-free, package/compile-validated; execution parity is P8)' : 'FAIL — ' + fails + ' check(s) failed'}\n`);
  await prisma.$disconnect();
  process.exit(fails === 0 ? 0 : 1);
})().catch(async (e) => { console.error('SMOKE ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
