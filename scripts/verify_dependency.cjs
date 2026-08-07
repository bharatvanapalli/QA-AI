'use strict';
/**
 * Deterministic guard for Enterprise Mode P5 (dependency topo + failed-prereq
 * gating + evidence inheritance). No LLM, no DB, no browser.
 *   node scripts/verify_dependency.cjs
 *
 * [1] buildGraph — explicit edges only; in-set vs out-of-scope; self-edge ignored.
 * [2] topoSort — linear order, stable tiebreak, cycle returns members (no throw).
 * [3] orderCases — stable subset order; cycle → original order unchanged.
 * [4] evaluateGate — the gate truth table + explicit-edges-only + evidence chain.
 * [5] conductor wiring — graph import, gate call, requireDependencyOrder guard,
 *     evidence-inheritance write (inert until P9).
 * [6] schema + additive migration (blockedBy* columns).
 * [7] read surfaces — getRun exposes blockedBy*; Reports has the failed_prereq label.
 */
const fs = require('fs');
const path = require('path');
const dg = require('../server/services/dependencyGraph');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));
const read = (...p) => { try { return fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'); } catch (_) { return ''; } };
const tc = (id, deps) => ({ id, name: id, dependsOnIds: deps || [] });

console.log('\n[1] buildGraph — explicit edges only');
{
  const g = dg.buildGraph([tc('A'), tc('B', ['A']), tc('C'), tc('X', ['ZZZ']), tc('S', ['S'])]);
  assert(g.deps.get('B').length === 1 && g.deps.get('B')[0] === 'A', 'edge B→A recorded (prereq in set)');
  assert(g.deps.get('C').length === 0, 'independent case C has no edges');
  assert((g.externalDeps.get('X') || []).includes('ZZZ') && (g.deps.get('X') || []).length === 0, 'out-of-scope prereq → externalDeps, NOT an edge (never fabricated)');
  assert(g.deps.get('S').length === 0, 'self-edge ignored');
}

console.log('\n[2] topoSort — order, stable tiebreak, cycle');
{
  const lin = dg.buildGraph([tc('A'), tc('B', ['A']), tc('C', ['B']), tc('D', ['C'])]);
  assert(dg.topoSort(lin).order.join(',') === 'A,B,C,D', 'linear chain → [A,B,C,D]');
  const ind = dg.buildGraph([tc('A'), tc('B'), tc('C')]);
  assert(dg.topoSort(ind, ['C', 'B', 'A']).order.join(',') === 'C,B,A', 'stable tiebreak follows priority (authoring order)');
  const cyc = dg.topoSort(dg.buildGraph([tc('A', ['B']), tc('B', ['A'])]));
  assert(cyc.cycle && cyc.cycle.length === 2, 'cycle → cycle members returned, no throw');
}

console.log('\n[3] orderCases — subset ordering, cycle safety');
{
  const r = dg.orderCases([tc('D', ['B']), tc('B', ['A']), tc('A'), tc('C')]);
  assert(r.cases.map((c) => c.id).join(',') === 'A,B,D,C', 'reordered so A<B<D, independent C keeps authoring position → [A,B,D,C]');
  assert(r.cycle === null, 'acyclic → no cycle');
  const rc = dg.orderCases([tc('A', ['B']), tc('B', ['A'])]);
  assert(rc.cases.map((c) => c.id).join(',') === 'A,B' && rc.cycle, 'cycle → ORIGINAL order unchanged + cycle reported (never reorder into a broken state)');
}

console.log('\n[4] evaluateGate — truth table + evidence inheritance');
{
  const g = dg.buildGraph([tc('A'), tc('B', ['A']), tc('C'), tc('D', ['B']), tc('X', ['ZZZ'])]);
  const out = (m) => new Map(Object.entries(m));
  assert(dg.evaluateGate(tc('C'), out({ A: { status: 'fail' } }), g).blocked === false, 'independent C never blocked even when A failed (EXPLICIT EDGES ONLY)');
  assert(dg.evaluateGate(tc('B', ['A']), out({ A: { status: 'pass' } }), g).blocked === false, 'prereq passed → not blocked');
  const blockingChild = { ...tc('B', ['A']), failurePolicy: 'block_dependents' };
  const blockingGrandchild = { ...tc('D', ['B']), failurePolicy: 'block_dependents' };
  for (const s of ['fail', 'blocked', 'needs_human']) {
    const d = dg.evaluateGate(blockingChild, out({ A: { status: s } }), g);
    assert(d.blocked && d.reason === 'failed_prereq' && d.blockedBy.testCaseId === 'A', `prereq ${s} → blocked / reason=failed_prereq / blockedBy=A`);
  }
  assert(dg.evaluateGate(tc('B', ['A']), out({ A: { status: 'skipped' } }), g).blocked === false, 'prereq skipped (engineer-excluded) → advisory, NOT blocked');
  const nr = dg.evaluateGate(tc('D', ['B']), out({}), g);
  assert(nr.blocked === false && nr.findings.some((f) => f.code === 'dependency_prereq_not_run'), 'prereq not yet run → advisory finding, not blocked');
  const xo = dg.evaluateGate(tc('X', ['ZZZ']), out({}), g);
  assert(xo.blocked === false && xo.findings.some((f) => f.code === 'dependency_prereq_out_of_scope'), 'out-of-scope prereq → advisory finding, not blocked');
  // evidence inheritance: runResultId carried; chain root-cause-first
  const ev = dg.evaluateGate(blockingChild, out({ A: { status: 'fail', runResultId: 'rr-A', blockedReason: null } }), g);
  assert(ev.blockedBy.runResultId === 'rr-A', 'blockedByRunResultId inherited from the failed prereq result');
  const chain = dg.evaluateGate(blockingGrandchild, out({ A: { status: 'fail' }, B: { status: 'blocked' } }), g);
  assert(chain.blocked && chain.blockedBy.testCaseId === 'B' && chain.path.map((p) => p.id).join(',') === 'A,B', 'A→B→D chain: blockedBy=B (direct), dependencyPath root-first=[A,B]');
}

console.log('\n[5] conductor wiring — gate + evidence write (inert until P9)');
{
  const c = read('server', 'services', 'agents', 'conductor.js');
  assert(/require\(['"]\.\.\/dependencyGraph['"]\)/.test(c), 'conductor imports dependencyGraph');
  assert(/evaluateGate\(/.test(c), 'conductor evaluates the dependency gate per case');
  assert(/requireDependencyOrder/.test(c), 'enforcement gated by requireDependencyOrder (default false → inert)');
  assert(/failed_prereq/.test(c), 'conductor writes blockedReason=failed_prereq on an enforced block');
  assert(/blockedByTestCaseId/.test(c) && /dependencyPath/.test(c), 'conductor writes evidence-inheritance fields');
  assert(/orderCases\(/.test(c), 'conductor topo-orders cases within a scenario (respects dependsOnIds)');
}

console.log('\n[5b] static continuity runtime - exact group lease or pre-execution block');
{
  const c = read('server', 'services', 'agents', 'conductor.js');
  assert(c.includes('dependencyGraph.continuityGroupId(tc.id, runGraph)'), 'continuity group derives from explicit dependency roots');
  assert(c.includes('continuityGroupId: tcContinuityGroupId'), 'session acquisition is bound to the derived continuity group');
  assert(c.includes("const blockedReason = 'session_continuity_unavailable';"), 'unavailable continuity persists a distinct terminal reason');
  assert(c.includes('await blockUnavailableContinuation({'), 'required continuation blocks before browser execution when no exact lease exists');
  assert(!c.includes('Execution will continue with the current live scenario session'), 'no fallback to an incidental scenario session');
  assert(!c.includes('Execution will continue in the current live session'), 'missing dependency metadata cannot silently reuse current state');
}

console.log('\n[6] schema + additive migration');
{
  const s = read('prisma', 'schema.prisma');
  for (const col of ['blockedByTestCaseId', 'blockedByRunResultId', 'blockedByReason', 'dependencyPath']) {
    assert(new RegExp(col + '\\s+String\\?').test(s), `RunResult.${col} String? (nullable, additive)`);
  }
  const migDir = path.join(__dirname, '..', 'prisma', 'migrations');
  let mig = '';
  try {
    for (const d of fs.readdirSync(migDir)) {
      if (/add_dependency_evidence|failed_prereq|dependency/i.test(d)) mig = fs.readFileSync(path.join(migDir, d, 'migration.sql'), 'utf8');
    }
  } catch (_) {}
  assert(/ADD COLUMN "blockedByTestCaseId"/.test(mig) && /ADD COLUMN "dependencyPath"/.test(mig), 'migration adds the 4 columns (additive ALTER)');
}

console.log('\n[7] read surfaces — Reports label + getRun fields');
{
  const reports = read('src', 'pages', 'Reports.jsx');
  assert(/failed_prereq\s*:/.test(reports), 'Reports BLOCKED_REASON_LABELS has a failed_prereq label');
  const runs = read('server', 'services', 'runs.js');
  assert(/blockedByTestCaseId/.test(runs) && /dependencyPath/.test(runs), 'getRun serializer exposes the evidence-inheritance fields');
}

console.log(`\n${failures === 0 ? 'PASS — P5 dependency topo + failed-prereq gating + evidence inheritance enforced (soft until P9)' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
