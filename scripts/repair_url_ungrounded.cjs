'use strict';
/**
 * Repair script: clear url_ungrounded on checkAt='end' URL assertions.
 *
 * markUngroundedUrl in architect.js incorrectly demoted redirect-destination
 * URL assertions (checkAt='end') by validating them against the case's
 * starting targetUrl instead of the destination. This script repairs all
 * existing TestCase rows in the DB.
 *
 * Usage: node scripts/repair_url_ungrounded.cjs [--dry-run]
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const cases = await prisma.testCase.findMany({
    where: { declaredAssertions: { not: null } },
    select: { id: true, name: true, declaredAssertions: true },
  });

  let repaired = 0;
  let skipped = 0;

  for (const tc of cases) {
    let assertions;
    try { assertions = JSON.parse(tc.declaredAssertions); } catch { skipped++; continue; }
    if (!Array.isArray(assertions)) { skipped++; continue; }

    let changed = false;
    for (const a of assertions) {
      if (
        a &&
        String(a.type || '').toUpperCase() === 'URL' &&
        a.parseFailed === true &&
        a.parseFailedReason === 'url_ungrounded' &&
        a.checkAt === 'end'
      ) {
        delete a.parseFailed;
        delete a.parseFailedReason;
        changed = true;
      }
    }

    if (!changed) { skipped++; continue; }

    repaired++;
    console.log(`[${DRY_RUN ? 'DRY' : 'FIX'}] ${tc.id} — "${tc.name}"`);
    if (!DRY_RUN) {
      await prisma.testCase.update({
        where: { id: tc.id },
        data: { declaredAssertions: JSON.stringify(assertions) },
      });
    }
  }

  console.log(`\nDone. Repaired: ${repaired}, unchanged: ${skipped}${DRY_RUN ? ' (dry run — no writes)' : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
