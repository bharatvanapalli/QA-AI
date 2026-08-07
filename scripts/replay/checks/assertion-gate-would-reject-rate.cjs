'use strict';

/**
 * Replay-harness check #3 — assertion-gate would-reject rate.
 *
 * Reads the persisted `assertionGateWouldReject` + `assertionGateReason`
 * fields across all RunResults in scope (a run, a date range, or all
 * time) and reports the data the flip-to-hard-reject decision rests on:
 *
 *   - Total pass-claim cases (status='pass')
 *   - Case-level would-reject rate (wouldReject=true / total passes)
 *     ← what flipping to case-level hard-reject would do
 *   - Per-assertion gap rate (reason set, wouldReject=false / total passes)
 *     ← what flipping to per-assertion hard-reject would catch
 *   - Sample reasons from each bucket so a human can sanity-check
 *
 * Usage:
 *   node scripts/replay/checks/assertion-gate-would-reject-rate.cjs                        # last 14 days
 *   node scripts/replay/checks/assertion-gate-would-reject-rate.cjs --since YYYY-MM-DD     # custom window
 *   node scripts/replay/checks/assertion-gate-would-reject-rate.cjs --run <runId>          # single run
 *
 * Decision thresholds (recommended; not pre-committed):
 *   < 5% case-level would-reject rate  → safe to flip to case-level hard-reject
 *   5%–15%                             → investigate sample reasons; consider per-assertion gate first
 *   > 15%                              → either prompt rule isn't landing OR the gate is too strict
 *
 * Exit codes: 0 = report produced cleanly, 2 = no data in scope.
 */

const args = process.argv.slice(2);
let mode = 'window';
let runId = null;
let since = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--run') { mode = 'run'; runId = args[i + 1]; i++; }
  else if (args[i] === '--since') { since = args[i + 1]; i++; }
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function pct(n, d) { return d > 0 ? (100 * n / d).toFixed(1) + '%' : '-'; }

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  let whereClause;
  if (mode === 'run') {
    if (!runId) { console.error('--run requires a runId'); process.exit(2); }
    whereClause = { runId };
  } else {
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 14 * 24 * 3600 * 1000);
    whereClause = { createdAt: { gte: sinceDate } };
  }

  const results = await prisma.runResult.findMany({
    where: whereClause,
    include: { testCase: { select: { name: true } }, run: { select: { id: true, startedAt: true } } },
    orderBy: { createdAt: 'desc' },
  });

  if (results.length === 0) {
    console.log('No RunResults in scope.');
    await prisma.$disconnect();
    process.exit(2);
  }

  console.log(`Assertion-gate observation report — ${mode === 'run' ? `run ${runId}` : `last 14 days (or --since)`}\n`);
  console.log(`Total RunResults in scope: ${results.length}`);

  const passes = results.filter((r) => r.status === 'pass');
  const caseLevelHits = passes.filter((r) => r.assertionGateWouldReject === true);
  const perAssertionGaps = passes.filter((r) => r.assertionGateWouldReject !== true && r.assertionGateReason);

  console.log(`Pass-claim cases:          ${passes.length}`);
  console.log(`Case-level would-reject:   ${caseLevelHits.length}  (${pct(caseLevelHits.length, passes.length)} of passes)`);
  console.log(`Per-assertion gap only:    ${perAssertionGaps.length}  (${pct(perAssertionGaps.length, passes.length)} of passes)`);
  console.log(`Clean passes (no gap):     ${passes.length - caseLevelHits.length - perAssertionGaps.length}  (${pct(passes.length - caseLevelHits.length - perAssertionGaps.length, passes.length)} of passes)`);

  // Recommendation
  const caseLevelRate = passes.length ? caseLevelHits.length / passes.length : 0;
  console.log();
  console.log('## Decision input');
  if (caseLevelRate < 0.05) {
    console.log(`  Case-level rate < 5% — safe to consider flipping to case-level hard-reject.`);
    console.log(`  Verify the ${caseLevelHits.length} sample(s) below are genuine misuse, then flip.`);
  } else if (caseLevelRate < 0.15) {
    console.log(`  Case-level rate ${(100 * caseLevelRate).toFixed(1)}% — investigate sample reasons.`);
    console.log(`  Consider per-assertion gate first; case-level may catch valid passes.`);
  } else {
    console.log(`  Case-level rate ${(100 * caseLevelRate).toFixed(1)}% — HIGH.`);
    console.log(`  Either the prompt rule (Stage 1.1) hasn't reshaped agent habit yet, or the gate is too strict.`);
    console.log(`  DO NOT flip until the rate drops.`);
  }

  if (passes.length < 20) {
    console.log();
    console.log(`  ⚠  Statistical caveat: ${passes.length} pass-claim case(s) is below the recommended n=20 threshold.`);
    console.log(`     Gather more soft-fail data before flipping. See PHASE_LOG Stage 1.5 — gate-flip discipline.`);
  }

  // Sample reasons
  if (caseLevelHits.length > 0) {
    console.log();
    console.log('## Sample case-level would-rejects (up to 5)');
    for (const r of caseLevelHits.slice(0, 5)) {
      console.log(`  [${r.run.id.slice(0, 8)}] ${pad(r.testCase?.name || '', 50)}`);
      console.log(`     ${r.assertionGateReason}`);
    }
  }
  if (perAssertionGaps.length > 0) {
    console.log();
    console.log('## Sample per-assertion gaps (up to 5)');
    for (const r of perAssertionGaps.slice(0, 5)) {
      console.log(`  [${r.run.id.slice(0, 8)}] ${pad(r.testCase?.name || '', 50)}`);
      console.log(`     ${r.assertionGateReason}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
