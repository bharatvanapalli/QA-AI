'use strict';

/**
 * Per-case post-mortem detail.
 *
 * Reads the latest cancelled Run for a project and prints a deep dive for
 * every case that ended in 'fail' or 'blocked'. Output is plain text, one
 * block per case, with the fields a QA Lead actually needs:
 *
 *   - case name + scenario + duration + verdict reason
 *   - first user error line + first failing assertion record
 *   - declared assertions and their per-assertion outcomes (matched /
 *     not_matched / uncheckable)
 *   - the LAST 5 tool calls before the verdict (from trace.actionTrail)
 *   - the conductor's RCA, when reporter ran (rcaWhat / rcaWhy / rcaFix)
 *
 * Usage:
 *   node scripts/postmortem-detail.cjs [--run=<runId>] [--project=<id>]
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

function safeJson(s) {
  if (s == null) return null;
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch (_) { return null; }
}

function summarizeAssertions(rr) {
  // assertionCheckResults is V2 outcomes; trace may also embed legacy data.
  const v2 = safeJson(rr.assertionCheckResults);
  if (Array.isArray(v2) && v2.length) {
    return v2.map((r) => ({
      id: r.assertionId,
      outcome: r.outcome,
      reason: r.reason || '',
      source: r.source || '',
      evidence: typeof r.evidence === 'string' ? ellipsis(r.evidence, 160) : '',
    }));
  }
  // fallback: trace.assertions
  const tr = safeJson(rr.trace);
  if (tr && Array.isArray(tr.assertions)) {
    return tr.assertions.map((a) => ({
      id: a.assertionId || a.assertion || '?',
      outcome: a.outcome || (a.matched ? 'matched' : 'not_matched'),
      reason: a.reason || '',
      source: a.source || '',
      evidence: '',
    }));
  }
  return [];
}

function tailToolCalls(rr, n = 5) {
  const tr = safeJson(rr.trace);
  if (!tr) return [];
  // Common shapes we've seen across phases: actionTrail, toolCalls, log.
  const trail = Array.isArray(tr.actionTrail) ? tr.actionTrail
    : Array.isArray(tr.toolCalls) ? tr.toolCalls
    : Array.isArray(tr.log) ? tr.log.filter((e) => e && (e.tool || e.name))
    : [];
  return trail.slice(-n).map((e) => ({
    tool: e.tool || e.name || '?',
    args: typeof e.args === 'object' ? JSON.stringify(e.args).slice(0, 160) : (e.args || ''),
    narration: e.narration || '',
    isError: !!e.isError,
  }));
}

(async () => {
  const args = parseArgs();
  let projectId = args.project || null;
  let runId = args.run || null;

  let run;
  if (runId) {
    run = await prisma.run.findUnique({ where: { id: runId } });
  } else {
    run = await prisma.run.findFirst({
      where: projectId ? { projectId } : {},
      orderBy: { startedAt: 'desc' },
    });
  }
  if (!run) { console.error('No run found.'); process.exit(1); }
  projectId = run.projectId;
  const project = await prisma.project.findUnique({ where: { id: projectId } });

  const results = await prisma.runResult.findMany({
    where: {
      runId: run.id,
      // pass = nothing to dissect; everything else gets the drill
      NOT: { status: 'pass' },
    },
    include: { testCase: { include: { scenario: { select: { name: true } } } } },
    orderBy: { createdAt: 'asc' },
  });

  console.log('═'.repeat(78));
  console.log(`PROJECT  ${project?.name || projectId}`);
  console.log(`RUN      ${run.id}  (${run.status})`);
  console.log(`STARTED  ${run.startedAt}`);
  console.log(`DRILL    ${results.length} non-pass case(s)`);
  console.log('═'.repeat(78));

  let idx = 0;
  for (const rr of results) {
    idx += 1;
    const tc = rr.testCase;
    const verdict = rr.status.toUpperCase();
    const reason = rr.mechanicalVerdictReason || '—';
    const cls = rr.rcaClass || '';
    const conf = typeof rr.rcaConfidence === 'number' ? `${rr.rcaConfidence}%` : '';
    const durS = typeof rr.durationMs === 'number' ? `${Math.round(rr.durationMs / 100) / 10}s` : '—';

    console.log('');
    console.log('─'.repeat(78));
    console.log(`[${idx}/${results.length}]  ${verdict}  ·  ${durS}  ·  verdict: ${reason}`);
    console.log(`  Scenario: ${tc.scenario?.name || '—'}`);
    console.log(`  Case    : ${tc.name}`);
    console.log(`  Module  : ${tc.module || '—'}      Type: ${tc.type || '—'}`);
    if (cls) console.log(`  RCA cls : ${cls}  ${conf}`);
    console.log('');

    // Error excerpt — first 6 non-empty lines.
    if (rr.error && rr.error.trim()) {
      const lines = rr.error.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6);
      console.log('  ── error ──');
      for (const l of lines) console.log(`    ${ellipsis(l, 160)}`);
    }

    // Declared assertions and outcomes.
    const assertions = summarizeAssertions(rr);
    if (assertions.length) {
      console.log('');
      console.log('  ── declared assertions ──');
      for (const a of assertions) {
        const marker = a.outcome === 'matched' ? '✓'
          : a.outcome === 'not_matched' ? '✗'
          : '?';
        const tag = `${a.outcome}${a.reason ? `:${a.reason}` : ''}`;
        const src = a.source ? `  [${a.source}]` : '';
        console.log(`    ${marker} ${ellipsis(a.id, 40).padEnd(40)} ${tag}${src}`);
        if (a.evidence) console.log(`        ↳ ${a.evidence}`);
      }
    }

    // RCA from reporter (if it ran).
    if (rr.rcaWhat || rr.rcaWhy || rr.rcaFix) {
      console.log('');
      console.log('  ── reporter RCA ──');
      if (rr.rcaWhat) console.log(`    what : ${ellipsis(rr.rcaWhat, 220)}`);
      if (rr.rcaWhy)  console.log(`    why  : ${ellipsis(rr.rcaWhy, 220)}`);
      if (rr.rcaFix)  console.log(`    fix  : ${ellipsis(rr.rcaFix, 220)}`);
    }

    // Last 5 tool calls before verdict.
    const tail = tailToolCalls(rr, 5);
    if (tail.length) {
      console.log('');
      console.log('  ── last 5 tool calls ──');
      for (const t of tail) {
        const flag = t.isError ? '⚠' : ' ';
        const line = t.narration ? `${t.tool}  ·  ${ellipsis(t.narration, 100)}` : `${t.tool}(${ellipsis(t.args, 100)})`;
        console.log(`    ${flag} ${line}`);
      }
    }
  }

  console.log('');
  console.log('═'.repeat(78));
  console.log(`Done — ${results.length} case(s) drilled.`);
  console.log('═'.repeat(78));

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('Detail dump failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
