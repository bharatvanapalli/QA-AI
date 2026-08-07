'use strict';

/**
 * One-shot post-mortem segregator.
 *
 * Reads the latest Run for a project (or the project given by --project=<id>)
 * and emits three buckets:
 *
 *   NEVER_RAN          — approved cases with no RunResult against this run
 *   RAN_AND_FAILED     — RunResult.status = 'fail'
 *   BLOCKED_DEPENDENT  — RunResult.status = 'blocked' AND blocked reason
 *                        relates to a parent case (dependsOnIds chain) that
 *                        itself failed/blocked. Other 'blocked' rows go to
 *                        BLOCKED_OTHER (env, locator, etc.).
 *
 * For each ran-and-failed / blocked case prints a concise post-mortem line
 * with: case name, scenario, first error excerpt, classification, and the
 * declared-assertion outcome rollup.
 *
 * Usage:
 *   node scripts/postmortem-segregate.js [--project=<projectId>] [--run=<runId>]
 *
 * Default: most recently started Run across all projects.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.+)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function ellipsis(s, n) {
  if (s == null) return '';
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

// Pull the first failing assertion + the first non-asserter error line out of
// the trace/error blob so the operator gets a SPECIFIC reason per case.
function summarizeFailure(rr) {
  const bits = [];
  const err = (rr.error || '').trim();
  if (err) {
    const firstLine = err.split(/\r?\n/).find((l) => l.trim()) || '';
    bits.push(`err: ${ellipsis(firstLine, 160)}`);
  }
  try {
    const tr = rr.trace ? JSON.parse(rr.trace) : null;
    if (tr && tr.assertions) {
      const fails = tr.assertions.filter((a) => a && a.outcome === 'not_matched');
      if (fails.length) {
        const f = fails[0];
        bits.push(`assertion[${f.assertionId || '?'}] not_matched (${f.reason || '—'})`);
      }
    }
  } catch (_) {}
  if (rr.mechanicalVerdictReason) {
    bits.push(`verdict: ${rr.mechanicalVerdictReason}`);
  }
  return bits.length ? bits.join(' · ') : '(no error text recorded)';
}

(async () => {
  const args = parseArgs();
  let projectId = args.project || null;
  let runId = args.run || null;

  // Locate the run.
  let run;
  if (runId) {
    run = await prisma.run.findUnique({ where: { id: runId } });
  } else {
    run = await prisma.run.findFirst({
      where: projectId ? { projectId } : {},
      orderBy: { startedAt: 'desc' },
    });
  }
  if (!run) {
    console.error('No run found.');
    process.exit(1);
  }
  projectId = run.projectId;

  const project = await prisma.project.findUnique({ where: { id: projectId } });

  console.log('━'.repeat(78));
  console.log(`Project : ${project?.name || projectId}`);
  console.log(`Run     : ${run.id}`);
  console.log(`Started : ${run.startedAt}`);
  console.log(`Ended   : ${run.endedAt || '(no endedAt — interrupted)'}`);
  console.log(`Status  : ${run.status}`);
  console.log(`Counters: passed=${run.passed} failed=${run.failed} blocked=${run.blocked} skipped=${run.skipped}`);
  console.log('━'.repeat(78));

  // All test cases for this project. We restrict to ones eligible for this
  // run (approved + automatable) so manual cases don't pollute the "never
  // ran" bucket.
  const allCases = await prisma.testCase.findMany({
    where: { projectId },
    include: { scenario: { select: { id: true, name: true } } },
    orderBy: [{ scenarioId: 'asc' }, { createdAt: 'asc' }],
  });
  const eligible = allCases.filter((tc) => {
    if (tc.automatability && tc.automatability !== 'automatable') return false;
    // status === 'approved' OR 'running' (interrupted while in-flight)
    return tc.status === 'approved' || tc.status === 'running' || tc.status === 'rejected';
  });

  const results = await prisma.runResult.findMany({
    where: { runId: run.id },
    orderBy: { createdAt: 'asc' },
  });
  const resultByTc = new Map(results.map((r) => [r.testCaseId, r]));

  const NEVER_RAN = [];
  const RAN_AND_FAILED = [];
  const BLOCKED_DEPENDENT = [];
  const BLOCKED_OTHER = [];
  const NEEDS_HUMAN = [];
  const PASSED = [];

  // Build a quick parent-status map: for each dependsOnId, what did the parent end up as?
  const parentResultStatus = (tc) => {
    const ids = Array.isArray(tc.dependsOnIds)
      ? tc.dependsOnIds
      : (tc.dependsOnIds ? (() => { try { return JSON.parse(tc.dependsOnIds); } catch { return []; } })() : []);
    const parentOutcomes = ids.map((pid) => resultByTc.get(pid)?.status || null);
    return { ids, parentOutcomes };
  };

  for (const tc of eligible) {
    const rr = resultByTc.get(tc.id);
    if (!rr) {
      NEVER_RAN.push(tc);
      continue;
    }
    if (rr.status === 'pass') { PASSED.push({ tc, rr }); continue; }
    if (rr.status === 'fail') { RAN_AND_FAILED.push({ tc, rr }); continue; }
    if (rr.status === 'blocked') {
      const { ids, parentOutcomes } = parentResultStatus(tc);
      const parentFailed = parentOutcomes.some((s) => s === 'fail' || s === 'blocked' || s === 'needs_human');
      if (ids.length && parentFailed) {
        BLOCKED_DEPENDENT.push({ tc, rr, parentIds: ids, parentOutcomes });
      } else {
        BLOCKED_OTHER.push({ tc, rr });
      }
      continue;
    }
    if (rr.status === 'needs_human') {
      // Assertion-uncheckable verdict — the agent ran the case but couldn't
      // verify the declared outcome. Distinct from blocked (agent gave up).
      NEEDS_HUMAN.push({ tc, rr });
      continue;
    }
    // skipped or anything else — catchall
    BLOCKED_OTHER.push({ tc, rr });
  }

  const fmtCase = (tc) => `${ellipsis(tc.scenario?.name || '?', 32)} → ${ellipsis(tc.name, 44)}`;

  console.log('');
  console.log(`╔═ NEVER RAN (${NEVER_RAN.length})  — interrupted before the conductor reached these cases`);
  console.log('╚' + '═'.repeat(76));
  for (const tc of NEVER_RAN) {
    console.log(`  · ${fmtCase(tc)}`);
  }
  if (!NEVER_RAN.length) console.log('  (none)');

  console.log('');
  console.log(`╔═ RAN AND FAILED (${RAN_AND_FAILED.length})  — agent reached these and the verdict was FAIL`);
  console.log('╚' + '═'.repeat(76));
  for (const { tc, rr } of RAN_AND_FAILED) {
    console.log(`  ✗ ${fmtCase(tc)}`);
    console.log(`      ${summarizeFailure(rr)}`);
    if (typeof rr.durationMs === 'number' && rr.durationMs > 0) {
      console.log(`      duration: ${Math.round(rr.durationMs / 100) / 10}s`);
    }
  }
  if (!RAN_AND_FAILED.length) console.log('  (none)');

  console.log('');
  console.log(`╔═ BLOCKED DUE TO DEPENDENCY (${BLOCKED_DEPENDENT.length})  — parent case in dependsOnIds failed/blocked`);
  console.log('╚' + '═'.repeat(76));
  for (const { tc, rr, parentIds, parentOutcomes } of BLOCKED_DEPENDENT) {
    console.log(`  ⊘ ${fmtCase(tc)}`);
    const parentDescs = parentIds.map((pid, i) => {
      const parent = allCases.find((c) => c.id === pid);
      const name = parent ? ellipsis(parent.name, 38) : ellipsis(pid, 38);
      return `${name} → ${parentOutcomes[i] || '∅'}`;
    });
    console.log(`      depends on: ${parentDescs.join(' · ')}`);
    if (rr.error) console.log(`      ${ellipsis(rr.error.split(/\r?\n/)[0], 160)}`);
  }
  if (!BLOCKED_DEPENDENT.length) console.log('  (none)');

  console.log('');
  console.log(`╔═ BLOCKED OTHER (${BLOCKED_OTHER.length})  — agent gave up: environmental / locator / consecutive_errors`);
  console.log('╚' + '═'.repeat(76));
  for (const { tc, rr } of BLOCKED_OTHER) {
    console.log(`  ⊘ ${fmtCase(tc)}`);
    console.log(`      ${summarizeFailure(rr)}`);
  }
  if (!BLOCKED_OTHER.length) console.log('  (none)');

  console.log('');
  console.log(`╔═ NEEDS HUMAN (${NEEDS_HUMAN.length})  — agent ran but assertions were uncheckable, parked for review`);
  console.log('╚' + '═'.repeat(76));
  for (const { tc, rr } of NEEDS_HUMAN) {
    console.log(`  ⚠ ${fmtCase(tc)}`);
    console.log(`      ${summarizeFailure(rr)}`);
  }
  if (!NEEDS_HUMAN.length) console.log('  (none)');

  console.log('');
  console.log('━'.repeat(78));
  console.log('SUMMARY');
  console.log(`  eligible cases ........ ${eligible.length}`);
  console.log(`  passed ................ ${PASSED.length}`);
  console.log(`  ran and failed ........ ${RAN_AND_FAILED.length}`);
  console.log(`  blocked (dependency) .. ${BLOCKED_DEPENDENT.length}`);
  console.log(`  blocked (other) ....... ${BLOCKED_OTHER.length}`);
  console.log(`  needs human ........... ${NEEDS_HUMAN.length}`);
  console.log(`  never ran ............. ${NEVER_RAN.length}`);
  console.log('━'.repeat(78));

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('Post-mortem failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
