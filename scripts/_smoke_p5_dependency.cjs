'use strict';
/**
 * P5 live smoke (not a guard) — failed-prerequisite gating + EVIDENCE INHERITANCE
 * against the REAL DB + the REAL conductor record path (conductor._recordFailedPrereqBlock /
 * _recordCaseOutcome) + the REAL getRun serializer. Proves what verify_dependency.cjs
 * (pure) cannot: the migration applied, the columns accept the evidence, the conductor
 * helper writes it, and Reports' getRun decodes it.
 *
 * Additive + cleaned up ([[preserve-trial-data]]): seeds ONE scratch project
 * (cases A→B→D chain + independent C), exercises the gate, then DELETES the
 * project (cascade → generation/scenario/cases/run/results) in finally.
 *
 * Run AFTER migrate deploy + generate (client must know the blockedBy* columns):
 *   node scripts/_smoke_p5_dependency.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const dg = require('../server/services/dependencyGraph');
const conductor = require('../server/services/agents/conductor');
const runs = require('../server/services/runs');

const results = [];
const check = (label, cond, detail) => { const ok = !!cond; results.push({ ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  — ' + (detail || '')}`); };
const mkCase = (projectId, scenarioId, generationId, name, deps) => prisma.testCase.create({
  data: {
    projectId, scenarioId, generationId, name, type: 'functional', module: 'checkout',
    confidence: 90, assertions: 'reaches its assertion', status: 'approved',
    dependsOnIds: deps ? JSON.stringify(deps) : null,
  },
});

(async () => {
  const user = await prisma.user.findFirst({ where: { currentOrgId: { not: null } }, orderBy: { createdAt: 'asc' }, select: { id: true, email: true, currentOrgId: true } });
  if (!user) throw new Error('No user with a currentOrgId.');
  console.log(`\n=== P5 dependency / failed-prereq smoke · ${user.email} ===\n`);
  let projectId = null;
  try {
    const project = await prisma.project.create({ data: { userId: user.id, orgId: user.currentOrgId, name: '__P5_DEP_SMOKE', targetUrl: 'https://example.test', updatedAt: new Date() } });
    projectId = project.id;
    const gen = await prisma.scenarioGeneration.create({ data: { projectId, version: 999200, label: '_P5', isCurrent: false } });
    const scn = await prisma.testScenario.create({ data: { projectId, generationId: gen.id, name: '_p5', module: 'checkout', priority: 'high', category: 'functional', rationale: 'p5 smoke', source: 'agent' } });
    const A = await mkCase(projectId, scn.id, gen.id, 'Register user', null);
    const B = await mkCase(projectId, scn.id, gen.id, 'Add to cart', [A.id]);
    const D = await mkCase(projectId, scn.id, gen.id, 'Checkout', [B.id]);   // chain A→B→D
    const C = await mkCase(projectId, scn.id, gen.id, 'View homepage', null); // independent, same scenario/module
    const run = await prisma.run.create({ data: { userId: user.id, projectId, sprintName: '_P5_DEP', status: 'running', generationId: gen.id } });

    // A ran and FAILED (an app bug).
    const rrA = await prisma.runResult.create({ data: { runId: run.id, testCaseId: A.id, status: 'fail', error: 'Register form rejected a valid email (app bug)' } });

    const graph = dg.buildGraph([
      { id: A.id, name: A.name, dependsOnIds: null },
      { id: B.id, name: B.name, dependsOnIds: [A.id] },
      { id: D.id, name: D.name, dependsOnIds: [B.id] },
      { id: C.id, name: C.name, dependsOnIds: null },
    ]);

    // Build caseOutcomes via the REAL conductor helper (worst-wins DB read-back).
    const caseOutcomes = new Map();
    await conductor._recordCaseOutcome({ runId: run.id, tcId: A.id, caseOutcomes });
    check('_recordCaseOutcome read A=fail from the DB', caseOutcomes.get(A.id) && caseOutcomes.get(A.id).status === 'fail' && caseOutcomes.get(A.id).runResultId === rrA.id);

    console.log('\n[gate logic]');
    check('independent C NOT blocked though A failed (EXPLICIT EDGES ONLY)', dg.evaluateGate({ id: C.id, dependsOnIds: null }, caseOutcomes, graph).blocked === false);
    const gB = dg.evaluateGate({ id: B.id, dependsOnIds: [A.id] }, caseOutcomes, graph);
    check('B blocked / reason=failed_prereq / blockedBy=A / inherits A result id', gB.blocked && gB.reason === 'failed_prereq' && gB.blockedBy.testCaseId === A.id && gB.blockedBy.runResultId === rrA.id, JSON.stringify(gB.blockedBy));

    console.log('\n[soft inertness]');
    const bBefore = await prisma.runResult.count({ where: { runId: run.id, testCaseId: B.id } });
    check('SOFT mode wrote nothing for B (no failed_prereq row until enforced)', bBefore === 0);

    console.log('\n[hard enforce — real conductor record path + evidence inheritance]');
    await conductor._recordFailedPrereqBlock({ tc: { id: B.id, name: B.name }, runId: run.id, projectId, send: () => {}, gate: gB, caseOutcomes });
    const rrB = await prisma.runResult.findFirst({ where: { runId: run.id, testCaseId: B.id } });
    check('B RunResult written: blocked + blockedReason=failed_prereq', rrB && rrB.status === 'blocked' && rrB.blockedReason === 'failed_prereq');
    check('evidence: blockedByTestCaseId=A (migration applied, column accepts data)', rrB && rrB.blockedByTestCaseId === A.id, rrB && JSON.stringify({ a: rrB.blockedByTestCaseId }));
    check('evidence: blockedByRunResultId=A result', rrB && rrB.blockedByRunResultId === rrA.id);
    check('evidence: blockedByReason carries the root cause (fail)', rrB && /fail/.test(rrB.blockedByReason || ''));
    check('evidence: dependencyPath JSON = [A]', rrB && JSON.parse(rrB.dependencyPath || '[]').map((p) => p.id).join(',') === A.id);
    check('caseOutcomes now has B=blocked (cascades to D)', caseOutcomes.get(B.id) && caseOutcomes.get(B.id).status === 'blocked');

    console.log('\n[chain A→B→D]');
    const gD = dg.evaluateGate({ id: D.id, dependsOnIds: [B.id] }, caseOutcomes, graph);
    check('D blocked by direct prereq B; dependencyPath root-first = [A,B]', gD.blocked && gD.blockedBy.testCaseId === B.id && gD.path.map((p) => p.id).join(',') === [A.id, B.id].join(','), JSON.stringify(gD.path.map((p) => p.id)));

    console.log('\n[independent C untouched]');
    check('C has ZERO RunResults (gate never fabricated one)', (await prisma.runResult.count({ where: { runId: run.id, testCaseId: C.id } })) === 0);

    console.log('\n[cycle safety]');
    const cyc = dg.orderCases([{ id: 'x', name: 'x', dependsOnIds: ['y'] }, { id: 'y', name: 'y', dependsOnIds: ['x'] }]);
    check('cycle → original order + cycle reported, no throw', cyc.cases.map((c) => c.id).join(',') === 'x,y' && !!cyc.cycle);

    console.log('\n[getRun serializer — Reports honesty]');
    const gr = await runs.getRun(user.id, run.id, user.currentOrgId);
    const bRow = gr.results.find((r) => r.testCaseId === B.id);
    check('getRun exposes failed_prereq + blockedByTestCaseId + decoded dependencyPath', bRow && bRow.blockedReason === 'failed_prereq' && bRow.blockedByTestCaseId === A.id && Array.isArray(bRow.dependencyPath) && bRow.dependencyPath[0] && bRow.dependencyPath[0].id === A.id, JSON.stringify(bRow && { r: bRow.blockedReason, by: bRow.blockedByTestCaseId, path: bRow.dependencyPath }));

    const failed = results.filter((x) => !x.ok).length;
    console.log(`\n=== ${failed ? 'FAIL' : 'PASS'} — ${results.length - failed}/${results.length} checks passed ===\n`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (projectId) { await prisma.project.delete({ where: { id: projectId } }).catch((e) => console.log('  ! teardown:', e.message)); console.log('  (deleted scratch project + cascaded run/results/cases)'); }
    await prisma.$disconnect().catch(() => {});
  }
})().catch(async (e) => { console.error('\nP5 SMOKE ERROR:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
