'use strict';

/**
 * One-time repair for Bug A (approval count regression).
 *
 * Before the Batch 1 fix, the conductor + supervisor wrote execution
 * outcomes (pass / fail / blocked / skipped) directly into
 * `TestCase.status`, violating CRIT-6 which reserves that column for the
 * approval lifecycle only (pending | approved | rejected | running).
 *
 * Result: every test case that was ever executed had its approval state
 * silently overwritten, so the Test Cases page showed "9 approved" when
 * the user had originally approved 17.
 *
 * This script does NOT delete any rows. It restores the approval state on
 * TestCase rows that the bug corrupted, by setting `status = 'approved'`
 * on rows where:
 *   - status is one of pass | fail | blocked | skipped (impossible legit
 *     values under CRIT-6 — must be bug debris), OR
 *   - status is 'running' AND the row has at least one RunResult (i.e.
 *     it was actually executed but never got snapped back).
 *
 * Execution outcome itself is preserved on `RunResult.status` and on
 * `case.latestResult` — nothing is lost.
 *
 * Run with:
 *   node server/scripts/repair-testcase-approval-status.js
 *   node server/scripts/repair-testcase-approval-status.js --dry-run
 */

const prisma = require('../prisma');

const DRY = process.argv.includes('--dry-run');

async function main() {
  const corruptedStatuses = ['pass', 'fail', 'blocked', 'skipped'];

  const bad = await prisma.testCase.findMany({
    where: { status: { in: corruptedStatuses } },
    select: { id: true, name: true, status: true, scenarioId: true },
  });

  const stuckRunning = await prisma.testCase.findMany({
    where: { status: 'running', results: { some: {} } },
    select: { id: true, name: true, status: true },
  });

  console.log(`Found ${bad.length} TestCase row(s) with corrupted execution-status:`);
  const byStatus = bad.reduce((acc, t) => ((acc[t.status] = (acc[t.status] || 0) + 1), acc), {});
  for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s}: ${n}`);

  console.log(`Found ${stuckRunning.length} TestCase row(s) stuck at status='running' with at least one RunResult.`);

  if (DRY) {
    console.log('\nDry-run mode — no writes performed. Re-run without --dry-run to apply.');
    return;
  }

  const ids = [...bad.map((t) => t.id), ...stuckRunning.map((t) => t.id)];
  if (ids.length === 0) {
    console.log('\nNothing to repair.');
    return;
  }

  const result = await prisma.testCase.updateMany({
    where: { id: { in: ids } },
    data: { status: 'approved' },
  });

  console.log(`\nRepaired ${result.count} row(s). All approval states restored to 'approved'.`);
  console.log('Execution outcomes (RunResult.status) were not touched.');
}

main()
  .catch((err) => {
    console.error('Repair failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
