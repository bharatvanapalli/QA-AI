'use strict';

/**
 * Replay-harness corpus capture (Stage 2).
 *
 * Snapshots the current SQLite DB's Run + RunResult identity rows into a
 * pinned JSON baseline at scripts/replay/corpus/baseline.json. The runner
 * reads that JSON to know what to replay — checks themselves still read
 * the live richTraceFile / DB rows for the named runIds, so capture only
 * commits the ENVELOPE (which runIds are part of the corpus + what each
 * one is "supposed to" represent), not the run payload.
 *
 * Why a captured envelope rather than just "the live DB":
 *   - The DB grows. The baseline is supposed to be stable across N pre-/
 *     post-change comparisons; new runs that land between captures should
 *     not silently inflate the corpus.
 *   - Per-run classification (known-pass / known-fail / known-blocked /
 *     edge-case) is what makes a corpus useful — and it lives in the
 *     baseline file, not in the DB.
 *
 * Run:
 *   node scripts/replay/corpus/capture.cjs           # capture into baseline.json
 *   node scripts/replay/corpus/capture.cjs --merge   # extend, don't overwrite
 *
 * Exit codes
 *   0 = baseline written
 *   1 = no completed runs found (nothing to capture)
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../../../server/prisma');

const BASELINE_PATH = path.join(__dirname, 'baseline.json');

function classify(run, results) {
  const total = results.length;
  if (total === 0) return 'empty';
  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const blocked = results.filter((r) => r.status === 'blocked').length;
  const needsHuman = results.filter((r) => r.status === 'needs_human').length;
  if (pass === total) return 'all-pass';
  if (fail === total) return 'all-fail';
  if (blocked === total) return 'all-blocked';
  if (needsHuman > 0) return 'needs-human-mixed';
  if (fail > 0 && pass > 0) return 'mixed-pass-fail';
  return 'mixed';
}

async function main() {
  const merge = process.argv.includes('--merge');
  const runs = await prisma.run.findMany({
    where: { status: { in: ['completed', 'cancelled'] } },
    include: {
      results: {
        select: { id: true, testCaseId: true, status: true },
      },
    },
    orderBy: { startedAt: 'asc' },
  });

  if (runs.length === 0) {
    console.error('No completed/cancelled runs found in DB. Nothing to capture.');
    process.exit(1);
  }

  const entries = runs.map((r) => ({
    runId: r.id,
    projectId: r.projectId,
    startedAt: r.startedAt?.toISOString() || null,
    completedAt: r.completedAt?.toISOString() || null,
    verdictMode: r.verdictMode || 'legacy',
    sprintName: r.sprintName || null,
    counts: {
      total: r.results.length,
      pass: r.results.filter((x) => x.status === 'pass').length,
      fail: r.results.filter((x) => x.status === 'fail').length,
      blocked: r.results.filter((x) => x.status === 'blocked').length,
      skipped: r.results.filter((x) => x.status === 'skipped').length,
      needsHuman: r.results.filter((x) => x.status === 'needs_human').length,
    },
    classification: classify(r, r.results),
  }));

  let output = { capturedAt: new Date().toISOString(), runs: entries };
  if (merge && fs.existsSync(BASELINE_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
      const known = new Set(entries.map((e) => e.runId));
      for (const r of (prev.runs || [])) {
        if (!known.has(r.runId)) entries.unshift(r);
      }
      output.runs = entries;
    } catch (err) {
      console.warn('[corpus] merge fallback to overwrite — prior baseline unreadable:', err.message);
    }
  }

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(output, null, 2));
  const summary = {};
  for (const e of entries) {
    summary[e.classification] = (summary[e.classification] || 0) + 1;
  }
  console.log(`Captured ${entries.length} runs → ${BASELINE_PATH}`);
  console.log('Classification:', summary);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
