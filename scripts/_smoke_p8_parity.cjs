'use strict';
/**
 * Enterprise Mode P8 — clean-env EXECUTION parity harness (one real pass / one real fail / one
 * real blocked path per framework; Selenium adds an unsupported-channel path). Proves the runner's
 * executed verdict matches the MCP verdict that produced the ReplayIR — NOT just that the
 * package compiles (that was P7).
 *
 *   node scripts/_smoke_p8_parity.cjs playwright   (or: bdd | selenium)
 *
 * - PASS  = the REAL recorded slice (run 2de0cb23, valid login, complete:true) executed live.
 * - FAIL  = a REAL captured failed RunResult re-emitted in memory from richTraceFile.
 * - BLOCKED = a REAL captured blocked RunResult re-emitted in memory from richTraceFile.
 * - UNSUPPORTED (selenium) = an API-channel assert → throwing stub → classified NOT parity-eligible.
 *
 * Exec env values come ONLY from approved refs (process.env / playwright/.qaai-exec-secrets.json),
 * never from Excel/test-data literals or the generated files. Reports source, never the value.
 * READ-ONLY over trial data ([[preserve-trial-data]]) — builds/runs in throwaway temp dirs.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');
const X = require('../server/services/codegen/replayExport');
const registry = require('../server/services/codegen/adapters');
const replayIrBdd = require('../server/services/codegen/adapters/replayIrBdd');
const seleniumReference = require('../server/services/codegen/adapters/seleniumReference');
const seleniumBddReference = require('../server/services/codegen/adapters/seleniumBddReference');
const P = require('../server/services/codegen/executionParity');
const enterpriseMode = require('../server/services/enterpriseMode');
const emitter = require('../server/services/codegen/replayEmitter');
const { reconstructTrail } = require('../server/services/codegen/_replayTrace');
const apr = require('../server/services/authProfileResolver');
const { decodeJson } = require('../server/services/jsonField');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server');
const PID = '4cc6772c-ea93-4c26-b478-48d779d1fccb';
const RUN = '4ca45538-4efc-426a-936a-88fa51bc6a98';
const PASS_RR = 'ff002ce0'; // real AutomationExercise pass, complete:true when re-emitted
const FAIL_RR = 'fb8df990'; // real AutomationExercise fail, complete:true when re-emitted
const BLOCKED_RR = 'fa5971bf'; // real AutomationExercise blocked, complete:true when re-emitted
const REPORT_DIR = path.join(REPO, 'playwright', 'p8-parity');
const DENY = ['admin123']; // a banned literal must never be in a generated FILE (it may be injected as runtime env)

const FRAMEWORK = (process.argv[2] || 'playwright').toLowerCase();
const ADAPTER_ID = {
  playwright: 'playwright-reference',
  'playwright-pom': 'playwright-pom',
  bdd: 'replayir-bdd',
  'playwright-bdd': 'replayir-bdd',
  selenium: 'selenium-reference',
  'selenium-reference': 'selenium-reference',
  'selenium-pom': 'selenium-pom',
  'selenium-java': 'selenium-pom',
  'selenium-bdd': 'selenium-bdd-reference',
  'selenium-bdd-reference': 'selenium-bdd-reference',
}[FRAMEWORK];
if (!ADAPTER_ID) { console.error('usage: _smoke_p8_parity.cjs playwright|playwright-pom|bdd|playwright-bdd|selenium|selenium-pom|selenium-bdd'); process.exit(2); }
const REPORT_STEM = enterpriseMode.reportNameForFramework(ADAPTER_ID);

let fails = 0;
const ok = (m) => console.log('  PASS  ' + m);
const bad = (m, d) => { console.log('  FAIL  ' + m + (d ? '  — ' + d : '')); fails++; };
const A = (c, m, d) => (c ? ok(m) : bad(m, d));

// ── approved-ref env resolution (never Excel literals) ─────────────────────────
function loadApprovedSecrets() {
  const p = path.join(REPO, 'playwright', '.qaai-exec-secrets.json');
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); delete j._comment; return j; } catch (_) { return {}; }
}
function safeEnvFor(envelopes, targetUrl = '') {
  const names = X.collectEnvVars(envelopes); // QAAI_TARGET_URL + every valueRef env-name
  const r = P.resolveSafeEnv(names, { env: process.env, secrets: loadApprovedSecrets() });
  const normalizedTarget = X.normalizeTargetOrigin(targetUrl);
  if (normalizedTarget) {
    r.resolved.QAAI_TARGET_URL = normalizedTarget;
    r.sources.QAAI_TARGET_URL = 'project';
    r.missing = r.missing.filter((name) => name !== 'QAAI_TARGET_URL');
  }
  const audit = P.auditInjectedEnv(r.resolved, r.sources, []); // injected creds are allowed at runtime; only flag wrong SOURCE
  return { ...r, audit };
}

async function loadAuthProfile(projectId, name) {
  if (!name) return { id: 'default', strategy: 'none', disposition: 'bypass_fixture' };
  try {
    const row = await prisma.authProfile.findFirst({ where: { projectId, name } });
    if (!row) return { id: name, strategy: 'none', disposition: 'bypass_fixture' };
    const r = apr.resolveAuthProfile(row);
    return {
      id: row.name,
      strategy: row.strategy,
      disposition: row.disposition,
      storageStateRef: r.storageStateRef || undefined,
      credentialRef: r.credentialRef || undefined,
    };
  } catch (_) {
    return { id: name, strategy: 'none', disposition: 'bypass_fixture' };
  }
}

async function reemitRunResultForParity(rrPrefix) {
  const rows = await prisma.runResult.findMany({
    where: rrPrefix && rrPrefix.length < 36 ? { id: { startsWith: rrPrefix } } : { id: rrPrefix },
    select: {
      id: true,
      runId: true,
      testCaseId: true,
      status: true,
      blockedReason: true,
      replayIrJson: true,
      richTraceFile: true,
      assertionCheckResults: true,
      dataRowIndex: true,
      dataRowLabel: true,
      testCase: {
        select: {
          id: true,
          name: true,
          projectId: true,
          declaredAssertions: true,
          authProfile: true,
        },
      },
    },
  });
  const rr = rows.find((r) => r.id === rrPrefix || r.id.startsWith(rrPrefix));
  if (!rr || !rr.testCase) return null;
  const trail = reconstructTrail(rr.richTraceFile);
  if (!trail.length) return null;
  const kbRows = await prisma.knowledgeBaseLocator.findMany({
    where: { projectId: rr.testCase.projectId },
    select: { element: true, role: true, accessibleName: true, selector: true },
  }).catch(() => []);
  const authProfile = await loadAuthProfile(rr.testCase.projectId, rr.testCase.authProfile);
  const dataRow = rr.dataRowIndex != null
    ? { index: rr.dataRowIndex, label: rr.dataRowLabel || `Row ${rr.dataRowIndex}`, sensitivity: 'synthetic', fields: {} }
    : null;
  const emit = emitter.buildReplayIR({
    caseId: rr.testCaseId,
    authProfile,
    trail,
    declaredAssertions: decodeJson(rr.testCase.declaredAssertions, []) || [],
    assertionOutcomes: decodeJson(rr.assertionCheckResults, []) || [],
    verdictStatus: rr.status,
    dataRow,
    kbByElement: new Map(kbRows.map((k) => [k.element, k])),
  });
  return {
    runResultId: rr.id,
    runId: rr.runId,
    testCaseId: rr.testCaseId,
    status: rr.status,
    blockedReason: rr.blockedReason,
    dataRowIndex: rr.dataRowIndex,
    dataRowLabel: rr.dataRowLabel,
    caseName: rr.testCase.name,
    envelope: {
      ir: emit.ir,
      complete: emit.complete,
      gaps: emit.gaps,
      findings: emit.findings,
      emittedAt: new Date().toISOString(),
      emitterVersion: emitter.EMITTER_VERSION,
      source: 'p8-in-memory-reemit',
    },
    storedEnvelope: decodeJson(rr.replayIrJson, null),
  };
}

// ── build the package files for a set of in-memory results (no DB, no validation) ──
function exportFiles(results, targetUrl = '') {
  const envelopes = results.map((r) => r.envelope).filter(Boolean);
  const envVars = X.collectEnvVars(envelopes);
  if (ADAPTER_ID === 'replayir-bdd') {
    const c = replayIrBdd.compileResults({ results });
    return { ...c, files: replayIrBdd.assemblePackage({ admitted: c.admitted, locators: c.locators, envVars, targetUrl }) };
  }
  if (ADAPTER_ID === 'selenium-bdd-reference') {
    const c = seleniumBddReference.compileResults({ results });
    return { ...c, files: seleniumBddReference.assemblePackage({ admitted: c.admitted, locators: c.locators, envVars, targetUrl }) };
  }
  const adapter = registry.getAdapter(ADAPTER_ID);
  const c = X.compileResults({ adapter, results });
  const files = ADAPTER_ID === 'selenium-reference'
    ? seleniumReference.assemblePackage({ admitted: c.admitted, envVars, targetUrl })
    : (ADAPTER_ID === 'selenium-pom' && adapter && typeof adapter.assemblePackage === 'function')
      ? adapter.assemblePackage({ admitted: c.admitted, envVars, targetUrl })
    : X.assemblePackage({ adapterId: ADAPTER_ID, admitted: c.admitted, envVars, targetUrl });
  return { ...c, files };
}

// ── runners (clean temp dir, inject approved env, parse verdict) ────────────────
function writePackage(baseDir, files) {
  const dir = fs.mkdtempSync(path.join(baseDir, '.qaai-p8-'));
  for (const [rel, content] of Object.entries(files)) { const full = path.join(dir, rel); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content, 'utf8'); }
  return dir;
}
function binFromPkg(name, binName) {
  const pkgPath = require.resolve(`${name}/package.json`, { paths: [SERVER, REPO] });
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && (pkg.bin[binName] || pkg.bin[name]));
  return bin ? path.join(path.dirname(pkgPath), bin) : null;
}
function runPlaywright(files, env, withBdd) {
  const dir = writePackage(SERVER, files); // under server/ so @playwright/test + playwright-bdd resolve
  const childEnv = { ...process.env, ...env, CI: '1' };
  try {
    if (withBdd) {
      const bddgen = binFromPkg('playwright-bdd', 'bddgen');
      const g = spawnSync(process.execPath, [bddgen], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 120000 });
      if (g.status !== 0) {
        const raw = [g.stdout || '', g.stderr || '', g.error ? `SPAWN_ERROR ${g.error.name}: ${g.error.message}` : ''].join('\n');
        return { verdict: 'error', raw, exitCode: g.status, dir, errorObj: g.error || null };
      }
    }
    const cli = binFromPkg('@playwright/test', 'playwright');
    const r = spawnSync(process.execPath, [cli, 'test', '--reporter=list'], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 180000 });
    const raw = [r.stdout || '', r.stderr || '', r.error ? `SPAWN_ERROR ${r.error.name}: ${r.error.message}` : ''].join('\n');
    return { ...P.parsePlaywrightVerdict(raw, r.status), raw, exitCode: r.status, dir, errorObj: r.error || null };
  } finally { /* leave dir until report written; cleaned by caller */ }
}
function runSelenium(files, env) {
  const dir = writePackage(os.tmpdir(), files);
  const childEnv = { ...process.env, ...env };
  const useShell = process.platform === 'win32';
  const r = useShell
    ? spawnSync('mvn.cmd -q test', { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 480000, shell: true })
    : spawnSync('mvn', ['-q', 'test'], { cwd: dir, env: childEnv, encoding: 'utf8', timeout: 480000 });
  const raw = [r.stdout || '', r.stderr || '', r.error ? `SPAWN_ERROR ${r.error.name}: ${r.error.message}` : ''].join('\n');
  const report = parseSurefireReports(dir);
  const parsed = report || P.parseSurefireVerdict(raw, r.status);
  const reportText = report && report.raw ? `\n\n--- surefire report ---\n${report.raw}` : '';
  return { ...parsed, raw: raw + reportText, exitCode: r.status, dir, errorObj: r.error };
}
function runFramework(files, env) {
  if (ADAPTER_ID === 'selenium-reference' || ADAPTER_ID === 'selenium-pom' || ADAPTER_ID === 'selenium-bdd-reference') return runSelenium(files, env);
  return runPlaywright(files, env, ADAPTER_ID === 'replayir-bdd');
}

function parseSurefireReports(dir) {
  const reportDir = path.join(dir, 'target', 'surefire-reports');
  if (!fs.existsSync(reportDir)) return null;
  const xmls = fs.readdirSync(reportDir).filter((f) => /^TEST-.+\.xml$/i.test(f)).sort();
  let total = 0; let failures = 0; let errors = 0; let skipped = 0; let raw = '';
  for (const f of xmls) {
    const text = fs.readFileSync(path.join(reportDir, f), 'utf8');
    raw += `\n[${f}]\n` + text.slice(0, 2000);
    const m = text.match(/<testsuite\b[^>]*\btests="(\d+)"[^>]*\berrors="(\d+)"[^>]*\bskipped="(\d+)"[^>]*\bfailures="(\d+)"/i)
      || text.match(/<testsuite\b[^>]*\btests="(\d+)"[^>]*\bfailures="(\d+)"[^>]*\berrors="(\d+)"[^>]*\bskipped="(\d+)"/i);
    if (!m) continue;
    // Support both attribute orders above.
    if (text.indexOf('errors=') < text.indexOf('failures=')) {
      total += Number(m[1]); errors += Number(m[2]); skipped += Number(m[3]); failures += Number(m[4]);
    } else {
      total += Number(m[1]); failures += Number(m[2]); errors += Number(m[3]); skipped += Number(m[4]);
    }
  }
  if (xmls.length) {
    let verdict = 'pass';
    if (failures > 0 || errors > 0) verdict = 'fail';
    else if (total === 0) verdict = 'not_run';
    else if (skipped >= total) verdict = 'skipped';
    return { verdict, run: total, failures, errors, skipped, raw };
  }
  const txts = fs.readdirSync(reportDir).filter((f) => /\.txt$/i.test(f)).sort();
  for (const f of txts) {
    const text = fs.readFileSync(path.join(reportDir, f), 'utf8');
    const parsed = P.parseSurefireVerdict(text, 0);
    if (parsed.run || /Tests run:/i.test(text)) return { ...parsed, raw: `\n[${f}]\n${text}` };
  }
  return null;
}

// ── unsupported-channel fixture (adapter-boundary control, not a product verdict) ──
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function unsupportedFixture(base) {
  const r = clone(base); r.runResultId = 'FIXTURE-UNSUPPORTED'; r.testCaseId = 'fixture-unsupported'; r.status = 'pass';
  r.envelope.ir.steps.push({ op: 'assert', contractRef: 'ASN-API', channel: 'API', expected: 'order created', evidence: { source: 'fixture' } });
  return r;
}

(async () => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const passReal = await reemitRunResultForParity(PASS_RR);
  if (!passReal) { console.error('could not re-emit the real PASS slice from richTrace', PASS_RR); process.exit(1); }
  A(passReal.envelope && passReal.envelope.complete === true, 'real PASS slice re-emitted complete:true from richTrace (DB replayIrJson not overwritten)', JSON.stringify(passReal.envelope && passReal.envelope.gaps));
  const failReal = await reemitRunResultForParity(FAIL_RR);
  if (!failReal) { console.error('could not re-emit the real FAIL slice from richTrace', FAIL_RR); process.exit(1); }
  A(failReal.envelope && failReal.envelope.complete === true, 'real FAIL slice re-emitted complete:true from richTrace (DB replayIrJson not overwritten)', JSON.stringify(failReal.envelope && failReal.envelope.gaps));
  const blockedReal = await reemitRunResultForParity(BLOCKED_RR);
  if (!blockedReal) { console.error('could not re-emit the real BLOCKED slice from richTrace', BLOCKED_RR); process.exit(1); }
  A(blockedReal.envelope && blockedReal.envelope.complete === true, 'real BLOCKED slice re-emitted complete:true from richTrace (DB replayIrJson not overwritten)', JSON.stringify(blockedReal.envelope && blockedReal.envelope.gaps));

  const project = await prisma.project.findUnique({
    where: { id: PID },
    select: { targetUrl: true },
  }).catch(() => null);
  const targetUrl = X.deriveTargetUrlFromResults([passReal, failReal, blockedReal], project && project.targetUrl);
  const env = safeEnvFor([passReal.envelope, failReal.envelope, blockedReal.envelope], targetUrl);
  console.log(`\n=== P8 execution parity — ${FRAMEWORK} (${ADAPTER_ID}) ===`);
  console.log(`approved exec env: resolved=[${Object.keys(env.resolved).join(', ')}] sources=${JSON.stringify(env.sources)} missing=[${env.missing.join(', ')}]`);
  A(env.audit.length === 0, 'injected env came only from approved sources (env/secrets), not Excel literals', JSON.stringify(env.audit));

  const paths = [
    { kind: 'pass', mcp: 'pass', provenance: 'real', results: [passReal], run: true },
    { kind: 'fail', mcp: 'fail', provenance: 'real', results: [failReal], run: true },
    { kind: 'blocked', mcp: 'blocked', provenance: 'real', results: [blockedReal], run: true },
  ];
  if (ADAPTER_ID === 'selenium-reference' || ADAPTER_ID === 'selenium-pom') {
    paths.push({ kind: 'unsupported', mcp: 'pass', provenance: 'fixture', results: [unsupportedFixture(passReal)], run: false });
  }

  const report = [];
  for (const pth of paths) {
    console.log(`\n[${pth.kind.toUpperCase()}] (${pth.provenance}; MCP verdict=${pth.mcp})`);
    const built = exportFiles(pth.results, targetUrl);
    // No generated FILE may contain a banned literal (creds are injected as env, never written).
    const leak = X.scanSecrets(built.files, DENY);
    A(leak.length === 0, 'no banned literal in the generated package files', JSON.stringify(leak.map((f) => f.rule)));

    // Eligibility: an unsupported-channel stub is NOT parity-eligible (never a product fail).
    const unsupported = (built.findings || []).filter((f) => /selenium_channel_unsupported/.test(f.rule));
    const noAdmittedReplay = !Array.isArray(built.admitted) || built.admitted.length === 0;
    const eligible = unsupported.length === 0 && env.missing.length === 0 && !noAdmittedReplay;

    let runnerVerdict = 'unsupported'; let raw = ''; let dir = null; let exitCode = null; let failingAssertion = null;
    if (!eligible) {
      const reason = unsupported.map((f) => f.rule).join(',')
        || (noAdmittedReplay ? `no admitted ReplayIR (${(built.blocked || []).map((b) => b.code).filter(Boolean).join(',') || 'blocked'})` : '')
        || 'missing approved env ' + env.missing.join(',');
      console.log(`  not parity-eligible: ${reason}`);
    } else if (pth.run) {
      const res = runFramework(built.files, env.resolved);
      runnerVerdict = res.verdict; raw = res.raw || ''; dir = res.dir; exitCode = res.exitCode;
      if (pth.kind === 'fail') { const m = raw.match(/QAAI_PARITY_FAIL_MARKER_ABSENT|ASN-PARITY-FAIL|Invalid credentials|Timed out|expect\(/i); failingAssertion = m ? m[0] : null; }
      console.log(`  runner: verdict=${runnerVerdict} exit=${exitCode}`);
    }

    const logsPath = path.join(REPORT_DIR, `${REPORT_STEM}-${pth.kind}.log`);
    if (raw) fs.writeFileSync(logsPath, raw, 'utf8');
    const entry = P.buildParityEntry({
      runResultId: pth.results[0].runResultId, framework: ADAPTER_ID, mcpVerdict: pth.mcp, runnerVerdict,
      eligible, provenance: pth.provenance, logsPath: raw ? logsPath : null, failingAssertion,
      irHash: X.hashReplayIr(pth.results[0].envelope && pth.results[0].envelope.ir),
      artifacts: [],
    });
    if (dir && entry.matched !== true) entry.artifacts = [path.relative(REPO, dir)];
    report.push(entry);
    console.log(`  → matched=${entry.matched} eligible=${entry.eligible} :: ${entry.reason}`);

    // Assertions per path:
    if (pth.kind === 'pass') A(entry.matched === true, 'PASS path: runner executed pass (parity holds)', entry.reason);
    if (pth.kind === 'fail') A(entry.matched === true, 'FAIL path: runner executed fail on the same assertion (parity holds)', entry.reason);
    if (pth.kind === 'blocked') A(entry.matched === true && runnerVerdict !== 'pass', 'BLOCKED path: ran as skipped/not-run, NEVER green', entry.reason);
    if (pth.kind === 'unsupported') A(entry.eligible === false, 'UNSUPPORTED path: classified not-parity-eligible (not a product fail)', entry.reason);

    if (dir && entry.matched === true) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    } else if (dir) {
      console.log(`  retained artifact dir: ${dir}`);
    }
  }

  const reportPath = path.join(REPORT_DIR, `${REPORT_STEM}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    framework: ADAPTER_ID,
    invokedAs: FRAMEWORK,
    reportName: REPORT_STEM,
    generatedAt: new Date().toISOString(),
    runId: RUN,
    sourceRunIds: [...new Set(paths.flatMap((p) => p.results.map((r) => r.runId)).filter(Boolean))],
    entries: report,
  }, null, 2) + '\n', 'utf8');
  console.log(`\nparity report → ${path.relative(REPO, reportPath)}`);
  console.table(report.map((e) => ({ path: e.runResultId, mcp: e.mcpVerdict, runner: e.runnerVerdict, matched: e.matched, eligible: e.eligible })));

  const includesUnsupportedLane = ADAPTER_ID === 'selenium-reference' || ADAPTER_ID === 'selenium-pom';
  console.log(`\n${fails === 0 ? `PASS — P8 ${FRAMEWORK} execution parity: pass→pass, fail→fail, blocked→never-green${includesUnsupportedLane ? ', unsupported→not-eligible' : ''} (clean-env run; approved-ref env only)` : 'FAIL — ' + fails + ' check(s) failed'}\n`);
  await prisma.$disconnect();
  process.exit(fails === 0 ? 0 : 1);
})().catch(async (e) => { console.error('P8 HARNESS ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
