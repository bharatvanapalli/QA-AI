'use strict';
/**
 * Surgical patch for RunResults where complete:false was caused SOLELY by context_switch_inferred gaps.
 * The emitter fix (findings not gaps) now handles this in new runs. This script backfills existing data.
 *
 * For each affected RunResult:
 *   - Moves context_switch_inferred entries from gaps[] to findings[]
 *   - Sets complete: true if no other gaps remain
 */
const path = require('path');
const { PrismaClient } = require(path.join(__dirname, '..', 'server', 'node_modules', '@prisma', 'client'));
const db = new PrismaClient();
const RUN_ID = process.argv[2] || '8c75ee05-b9f5-4415-8568-6e1e592e4199';
const DRY_RUN = process.argv[3] === '--dry';

(async () => {
  const results = await db.runResult.findMany({
    where: { runId: RUN_ID },
    select: { id: true, testCaseId: true, replayIrJson: true,
      testCase: { select: { name: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  let patched = 0, skipped = 0, alreadyComplete = 0;

  for (const r of results) {
    let envelope = null;
    try { envelope = r.replayIrJson ? JSON.parse(r.replayIrJson) : null; } catch (_) {}
    if (!envelope || envelope.complete !== false) { alreadyComplete++; continue; }

    const gaps = Array.isArray(envelope.gaps) ? envelope.gaps : [];
    const switchGaps = gaps.filter(g => g.code === 'context_switch_inferred');
    const otherGaps = gaps.filter(g => g.code !== 'context_switch_inferred');

    if (switchGaps.length === 0) {
      // Incomplete for other reasons — skip
      skipped++;
      const caseName = r.testCase && r.testCase.name || '(no name)';
      console.log(`SKIP (other gaps): "${caseName}" — ${gaps.map(g=>g.code).join(', ')}`);
      continue;
    }

    // Move switch gaps → findings, keep other gaps
    const existingFindings = Array.isArray(envelope.findings) ? envelope.findings : [];
    const newEnvelope = {
      ...envelope,
      complete: otherGaps.length === 0,  // true if context_switch was the only blocker
      gaps: otherGaps,
      findings: [...existingFindings, ...switchGaps],
    };

    const caseName = r.testCase && r.testCase.name || '(no name)';
    const action = otherGaps.length === 0 ? 'PATCH → complete:true' : `PARTIAL (${otherGaps.length} other gaps remain)`;
    console.log(`${DRY_RUN ? '[DRY] ' : ''}${action}: "${caseName}" (${switchGaps.length} switch gaps moved)`);

    if (!DRY_RUN) {
      await db.runResult.update({
        where: { id: r.id },
        data: { replayIrJson: JSON.stringify(newEnvelope) }
      });
      patched++;
    } else {
      patched++;
    }
  }

  console.log(`\nDone. Patched: ${patched}  Skipped (other gaps): ${skipped}  Already complete: ${alreadyComplete}`);
  if (DRY_RUN) console.log('(dry run — no DB writes)');
  await db.$disconnect();
})().catch(e => { console.error(String(e)); process.exit(1); });
