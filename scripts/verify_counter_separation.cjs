'use strict';
/*
 * #6 COUNTER SEPARATION — needs_human ("not judged") must NOT inflate the product
 * FAILED metric. test_data_invalid / no_execution are status='blocked' (separate
 * bucket). Drives the REAL computeRunCounters + asserts the wiring (recompute, list
 * view, statusMeta, Reports wording) keeps the honesty states distinct from FAIL.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { computeRunCounters } = require(path.join(ROOT, 'server', 'lib', 'runCounters'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— computeRunCounters keeps needs_human OUT of failed —');
{
  const c = computeRunCounters({ pass: 2, fail: 1, needs_human: 3, blocked: 4, skipped: 5 });
  ok('failed counts ONLY real fails (1), NOT fail+needs_human (4)', c.failed === 1, JSON.stringify(c));
  ok('needsHuman has its own count (3)', c.needsHuman === 3, JSON.stringify(c));
  ok('passed/blocked/skipped unchanged', c.passed === 2 && c.blocked === 4 && c.skipped === 5, JSON.stringify(c));
}
{
  const c = computeRunCounters({ needs_human: 9 });
  ok('a run of ONLY needs_human shows failed=0', c.failed === 0, JSON.stringify(c));
  ok('…and needsHuman=9', c.needsHuman === 9, JSON.stringify(c));
}
{
  // test_data_invalid / no_execution are status='blocked' — they land in blocked, never failed.
  const c = computeRunCounters({ blocked: 4 });
  ok('test_data_invalid/no_execution (status=blocked) → blocked, not failed', c.failed === 0 && c.blocked === 4, JSON.stringify(c));
}

console.log('\n— the wiring uses the pure helper + does not re-fold —');
{
  const runs = fs.readFileSync(path.join(ROOT, 'server', 'services', 'runs.js'), 'utf8');
  ok('recomputeRunCounters uses computeRunCounters (no inline fold)', runs.includes('const counters = computeRunCounters(byStatus)'));
  ok('no `failed: (byStatus.fail || 0) + (byStatus.needs_human' , !/failed:\s*\(byStatus\.fail \|\| 0\) \+ \(byStatus\.needs_human/.test(runs));
  ok('list view does NOT re-fold needsHuman into failed', !/failed: \(r\.failed \|\| 0\) \+ \(r\.needsHuman \|\| 0\)/.test(runs));
  ok('list view surfaces needsHuman as its own field', /needsHuman: r\.needsHuman \|\| 0/.test(runs));
  ok('list select includes needsHuman', /select: \{ id: true,[^}]*needsHuman: true/.test(runs));
}

console.log('\n— Reports/statusMeta keep needs_human distinct from product FAIL —');
{
  const reports = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'Reports.jsx'), 'utf8');
  ok('no "platform issue" wording', !/platform issue/i.test(reports));
  ok('needs_human → "Not judged" category wording', /Not judged/.test(reports));
  ok('no_execution → "Browser session unavailable"', /Browser session unavailable/.test(reports));
  ok('test_data_invalid → "Invalid generated test data"', /Invalid generated test data/.test(reports));
  const statusMeta = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'statusMeta.js'), 'utf8');
  ok('statusMeta does NOT map needs_human to the fail bucket', !/needs_human[\s\S]{0,40}STATUS_META\.fail/.test(statusMeta));
}

console.log('\n— the DASHBOARD/Overview route also keeps needs_human out of failed (reviewer-found fold) —');
{
  const dash = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'dashboard.js'), 'utf8');
  ok('KPI loop does NOT fold needs_human into failed', !/r\.status === 'fail' \|\| r\.status === 'needs_human'/.test(dash));
  ok('KPI loop counts needs_human as notJudged', /r\.status === 'needs_human'\)\s*notJudged\+\+/.test(dash) || /notJudged\+\+/.test(dash));
  ok('stats KPI surfaces notJudged', /\bnotJudged,/.test(dash));
  ok('recent-run shape does NOT re-fold needsHuman into failed', !/failed: \(r\.failed \|\| 0\) \+ \(r\.needsHuman \|\| 0\)/.test(dash));
  ok('recent-run shape surfaces needsHuman separately', /needsHuman: r\.needsHuman \|\| 0/.test(dash));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — counter separation enforced: needs_human ("not judged") never inflates the product FAILED metric; it has its own count, and test_data_invalid/no_execution stay in the blocked bucket. Reports wording keeps the categories distinct.');
