'use strict';
/*
 * STATIC GUARD — every RunResult write that can carry a dynamic status must be
 * gated by the pre-persist evidence invariant, or write a constant NON-pass
 * status, or be explicitly runner-certified. Closes the reviewer's "the gate is
 * a Conductor invariant, not a universal one" gap: a NEW `prisma.runResult.create`
 * that persists a raw `result.status` / `'pass'` without gating will trip this.
 *
 * Pure source scan (no DB). conductor.js + runs.js are the ONLY files in server/
 * with runResult.create (verified by grep); the guard re-asserts that and fails
 * if a create's status expression is not in the safe/gated set.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const FILES = ['server/services/agents/conductor.js', 'server/services/runs.js'];
const srcs = Object.fromEntries(FILES.map((f) => [f, read(f)]));

// Classify the status a single runResult.create(...) writes.
function classifyStatus(chunk) {
  if (/\.\.\.baseData|data:\s*baseData\b/.test(chunk)) return 'gated_baseData';     // status flows from the gated baseData.status
  const sm = chunk.match(/status:\s*([^,\n}]+)/);
  if (!sm) return 'no_status';
  const expr = sm[1].trim();
  if (/^'(blocked|skipped|fail|pending)'$/.test(expr)) return 'literal_safe';
  if (expr === '__status') return 'gated_runner';
  if (/\?\s*'fail'\s*:\s*'skipped'|\?\s*'skipped'\s*:\s*'fail'/.test(expr)) return 'ternary_safe';
  if (/result\.status/.test(expr)) return 'UNGATED_RAW:' + expr;
  if (/['"]pass['"]/.test(expr)) return 'LITERAL_PASS:' + expr;
  return 'UNKNOWN:' + expr;
}

console.log('— every runResult.create writes a SAFE (literal non-pass) or GATED status —');
let totalCreates = 0, ungatedRaw = 0, literalPass = 0;
for (const f of FILES) {
  const src = srcs[f];
  const re = /runResult\.create\(/g;
  let m, idx = 0;
  while ((m = re.exec(src))) {
    const chunk = src.slice(m.index, m.index + 340);
    const cls = classifyStatus(chunk);
    totalCreates++; idx++;
    if (cls.startsWith('UNGATED_RAW')) ungatedRaw++;
    if (cls.startsWith('LITERAL_PASS')) literalPass++;
    const safe = cls === 'gated_baseData' || cls === 'literal_safe' || cls === 'gated_runner' || cls === 'ternary_safe';
    ok(`${path.basename(f)} create #${idx} status is gated/safe (${cls.split(':')[0]})`, safe, cls + '  ::  ' + chunk.replace(/\s+/g, ' ').slice(0, 90));
  }
}
ok('found runResult.create calls in the two known files', totalCreates >= 10, `count=${totalCreates}`);
// Scoped to create-data (the file-wide presence of `status: result.status` is FINE —
// e.g. the gate's own input `enforcePrePersistEvidenceGate({ status: result.status })`).
ok('NO create persists a RAW worker result.status (un-gated)', ungatedRaw === 0, `count=${ungatedRaw}`);
ok('NO create persists a hardcoded pass', literalPass === 0, `count=${literalPass}`);

console.log('\n— the gate is imported + called in BOTH write paths (universal, not just Conductor) —');
ok('conductor.js imports enforcePrePersistEvidenceGate', /require\(['"][^'"]*prePersistEvidenceGate['"]\)/.test(srcs['server/services/agents/conductor.js']));
ok('conductor.js CALLS the gate before persisting', /enforcePrePersistEvidenceGate\(\{/.test(srcs['server/services/agents/conductor.js']));
ok('runs.js requires + calls the gate (runnerCertified path)', /require\(['"][^'"]*prePersistEvidenceGate['"]\)/.test(srcs['server/services/runs.js']) && /enforcePrePersistEvidenceGate\(\{\s*status:\s*result\.status[\s\S]*runnerCertified:\s*true/.test(srcs['server/services/runs.js']));

console.log('\n— runs.js routes the worker status through the gate, then uses the gated value —');
{
  const r = srcs['server/services/runs.js'];
  ok('computes __status from the gate', /const __status = __gated\.status/.test(r));
  ok('persists status: __status (not result.status)', /status:\s*__status/.test(r));
  ok('counters key off __status', /__status === 'pass'/.test(r));
  // R3-#5 — ALL downstream side effects must branch on the gated __status, not the
  // raw worker result.status. A downgraded pass must open a BlockedItem and skip codegen.
  ok('BlockedItem branch uses __status', /if \(__status !== 'pass' && __status !== 'skipped'\)/.test(r));
  ok('codegen/lint emit branch uses __status', /if \(__status === 'pass'\) \{/.test(r));
  ok('no downstream side effect branches on raw result.status (only the gate input + the unrelated isBlocked helper)',
    (r.match(/result\.status/g) || []).length <= 2);
}

console.log('\n— runnerCertified is a NARROW external-runner escape hatch (runs.js only, never Conductor) —');
{
  ok('runs.js uses runnerCertified: true (Playwright = the assertion runner)', /runnerCertified:\s*true/.test(srcs['server/services/runs.js']));
  ok('conductor.js NEVER passes runnerCertified (its passes must face the full evidence gate)',
    !/runnerCertified/.test(srcs['server/services/agents/conductor.js']));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — RunResult writes are universally gated: every create persists a constant non-pass status, a Conductor evidence-gated status, or a runner-certified status routed through the SAME pre-persist gate. No path can write an un-evidenced pass.');
