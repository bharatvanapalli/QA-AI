'use strict';
/**
 * Deterministic guard for Enterprise Mode P8 (execution-parity CORE). No spawn, no browser,
 * no DB. Pins the classification rules + runner-output parsing + safe-env resolution:
 *   pass→pass matched · fail→fail matched · fail→pass VIOLATION · blocked→skipped matched ·
 *   blocked→pass VIOLATION (never green) · unsupported→not-eligible · approved-refs-only env.
 *   node scripts/verify_executionparity.cjs
 */
const P = require('../server/services/codegen/executionParity');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

console.log('\n[1] pass MCP → must execute pass');
{
  assert(P.classifyParity({ mcpVerdict: 'pass', runnerVerdict: 'pass' }).matched === true, 'pass→pass = matched');
  const m = P.classifyParity({ mcpVerdict: 'pass', runnerVerdict: 'fail' });
  assert(m.matched === false && m.eligible === true, 'pass→fail = MISMATCH (export not faithful / site)');
}

console.log('\n[2] fail MCP → must execute fail (a fail that stops failing is a violation)');
{
  assert(P.classifyParity({ mcpVerdict: 'fail', runnerVerdict: 'fail', runnerReason: 'assert Dashboard' }).matched === true, 'fail→fail = matched');
  const m = P.classifyParity({ mcpVerdict: 'fail', runnerVerdict: 'pass' });
  assert(m.matched === false && /no longer fails/.test(m.reason), 'fail→pass = MISMATCH (the bug silently passing)');
}

console.log('\n[3] blocked/needs_human/skipped → never green');
{
  assert(P.classifyParity({ mcpVerdict: 'blocked', runnerVerdict: 'skipped' }).matched === true, 'blocked→skipped = matched (preserved)');
  assert(P.classifyParity({ mcpVerdict: 'needs_human', runnerVerdict: 'disabled' }).matched === true, 'needs_human→disabled = matched');
  assert(P.classifyParity({ mcpVerdict: 'blocked', runnerVerdict: 'not_run' }).matched === true, 'blocked→not_run = matched');
  const v = P.classifyParity({ mcpVerdict: 'blocked', runnerVerdict: 'pass' });
  assert(v.matched === false && /VIOLATION/.test(v.reason), 'blocked→pass = VIOLATION (reported green)');
}

console.log('\n[4] unsupported channel / not-eligible → never scored as a product fail');
{
  const e = P.classifyParity({ mcpVerdict: 'pass', runnerVerdict: 'unsupported' });
  assert(e.matched === null && e.eligible === false, 'runner=unsupported → matched=null, eligible=false');
  const ne = P.classifyParity({ mcpVerdict: 'fail', runnerVerdict: 'fail', eligible: false });
  assert(ne.matched === null && ne.eligible === false, 'eligible:false → not parity-eligible (not a fail)');
}

console.log('\n[5] Playwright runner output → verdict');
{
  assert(P.parsePlaywrightVerdict('  1 passed (4.2s)', 0).verdict === 'pass', '"1 passed" → pass');
  assert(P.parsePlaywrightVerdict('  1 failed\n  1 passed (9s)', 1).verdict === 'fail', 'any failed → fail');
  assert(P.parsePlaywrightVerdict('  1 skipped (1s)', 0).verdict === 'skipped', '"1 skipped" → skipped');
  assert(P.parsePlaywrightVerdict('Error: cannot find module', 1).verdict === 'error', 'exit!=0, nothing parsed → error (infra, not product fail)');
}

console.log('\n[6] Maven surefire output → verdict (disabled @Test = not_run, never pass)');
{
  assert(P.parseSurefireVerdict('Tests run: 1, Failures: 0, Errors: 0, Skipped: 0', 0).verdict === 'pass', 'run 1 / 0 fail → pass');
  assert(P.parseSurefireVerdict('Tests run: 1, Failures: 1, Errors: 0, Skipped: 0\nBUILD FAILURE', 1).verdict === 'fail', '1 failure → fail');
  assert(P.parseSurefireVerdict('Tests run: 0, Failures: 0, Errors: 0, Skipped: 0', 0).verdict === 'not_run', 'disabled @Test (run 0) → not_run (never green)');
  assert(P.parseSurefireVerdict('Tests run: 1, Failures: 0, Errors: 0, Skipped: 1', 0).verdict === 'skipped', 'skipped == run → skipped');
  assert(P.parseSurefireVerdict('COMPILATION ERROR', 1).verdict === 'error', 'no totals + exit!=0 → error (infra)');
  // multiple totals lines → take the build summary (last)
  assert(P.parseSurefireVerdict('Tests run: 1, Failures: 0, Errors: 0, Skipped: 0\n...\nResults:\nTests run: 1, Failures: 1, Errors: 0, Skipped: 0', 1).verdict === 'fail', 'takes the LAST totals line (build summary)');
}

console.log('\n[7] exec env comes from APPROVED refs only — never Excel literals');
{
  const r = P.resolveSafeEnv(['QAAI_TARGET_URL', 'QAAI_USERNAME', 'QAAI_MISSING'], { env: { QAAI_TARGET_URL: 'https://x' }, secrets: { QAAI_USERNAME: 'Admin' } });
  assert(r.resolved.QAAI_TARGET_URL === 'https://x' && r.sources.QAAI_TARGET_URL === 'env', 'env ref resolved from operator env');
  assert(r.resolved.QAAI_USERNAME === 'Admin' && r.sources.QAAI_USERNAME === 'secrets', 'secret ref resolved from approved secrets map');
  assert(r.missing.length === 1 && r.missing[0] === 'QAAI_MISSING', 'unresolved name → missing (caller marks not-eligible, never invents)');
  assert(P.isSafeRef('env:QAAI_USERNAME') && P.isSafeRef('masked:password') && !P.isSafeRef('Admin'), 'isSafeRef: only env/vault/fixture/masked refs, never a raw literal');
  const leak = P.auditInjectedEnv({ QAAI_PASSWORD: 'admin123' }, { QAAI_PASSWORD: 'env' }, ['admin123']);
  assert(leak.some((f) => f.rule === 'banned_literal_injected'), 'a banned literal in the injected env is caught');
  assert(P.auditInjectedEnv({ QAAI_TARGET_URL: 'https://x' }, { QAAI_TARGET_URL: 'env' }, ['admin123']).length === 0, 'clean approved env → no findings');
}

console.log('\n[8] parity report row carries the user-required schema');
{
  const e = P.buildParityEntry({ runResultId: 'RR1', framework: 'playwright-reference', irHash: 'IRHASH-1', mcpVerdict: 'pass', runnerVerdict: 'pass', provenance: 'real', logsPath: '/tmp/x.log', artifacts: ['trace.zip'] });
  for (const k of ['runResultId', 'framework', 'irHash', 'mcpVerdict', 'runnerVerdict', 'matched', 'reason', 'logs', 'artifacts']) assert(k in e, `entry has ${k}`);
  assert(e.matched === true && e.provenance === 'real' && e.eligible === true && e.irHash === 'IRHASH-1', 'classified + provenance/eligible + IR hash recorded');
}

console.log(`\n${failures === 0 ? 'PASS — P8 execution-parity core: pass→pass, fail→fail, blocked/needs_human→never-green, unsupported→not-eligible; runner-output parsing; approved-refs-only env (no Excel literals)' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
console.log('\n[9] Playwright no-tests output -> not_run');
assert(P.parsePlaywrightVerdict('Error: No tests found', 1).verdict === 'not_run', '"No tests found" -> not_run (blocked BDD skip, never green)');

console.log(`\nFINAL ${failures === 0 ? 'PASS' : 'FAIL - ' + failures + ' check(s) failed'} - P8 execution-parity core guard\n`);
process.exit(failures === 0 ? 0 : 1);
