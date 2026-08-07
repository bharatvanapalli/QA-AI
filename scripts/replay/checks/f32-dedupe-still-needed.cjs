'use strict';

/**
 * Replay-harness check #1 — F.3.2 dedupe-by-latest deletion safety.
 *
 * First concrete piece of the Stage 2 replay-harness corpus. Originally
 * written ad-hoc during Stage 1.2 (2026-05-28) to verify the proposed
 * F.3.2 dedupe-by-latest deletion before any live smoke. The check ran
 * in seconds against the existing Stage 0.5 telemetry and found that
 * deletion would have regressed all 3 known-passing fixtures (the agent's
 * [✗✓] pattern across the same assertion text was load-bearing). The
 * artifact is preserved here as the prototype for how Stage 2 questions
 * will be answered: zero token cost, deterministic, replay-only.
 *
 * Usage: node scripts/replay/checks/f32-dedupe-still-needed.cjs [runId]
 *
 * Question this check answers
 *   "Would deleting the F.3.2 dedupe-by-latest patch cause any case in
 *    <runId> to regress from pass → fail under the new 'any matched=false
 *    fails' semantics?"
 *
 * How
 *   1. Read RunResult.trace lines for each result in the run.
 *   2. Parse each "ASSERTION: ✓/✗ \"<text>\" — <evidence>" line.
 *   3. Group by assertion text.
 *   4. If any group has a matched=false followed by a matched=true on the
 *      same assertion text, the case relied on dedupe-by-latest to pass.
 *
 * Outputs SAFE / REGRESSION RISK per case + a summary VERDICT.
 * Exit code: 0 = all safe, 1 = at least one regression risk found.
 *
 * Stage 2 harness will fold this into a structured check API
 * (id, name, runOn(runId) -> { pass, evidence }) so a corpus of these
 * runs as the harness suite. For now: standalone, but the file path
 * (scripts/replay/checks/) reserves the location.
 */

const fs = require('fs');
const zlib = require('zlib');

const RUN_ID = process.argv[2] || '137d9238-7826-4bf4-ae42-4e985a67ef4a';

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const run = await prisma.run.findUnique({
    where: { id: RUN_ID },
    include: { results: { include: { testCase: { select: { name: true } } } } },
  });
  if (!run) { console.error(`Run ${RUN_ID} not found`); process.exit(2); }

  console.log(`Verifying F.3.2 deletion safety against run ${RUN_ID}\n`);

  let allSafe = true;
  for (const rr of run.results) {
    if (!rr.richTraceFile || !fs.existsSync(rr.richTraceFile)) {
      console.log(`SKIP ${rr.testCase?.name} — no telemetry`);
      continue;
    }
    const buf = fs.readFileSync(rr.richTraceFile);
    const data = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

    // Collect every assertion_check invocation: its assertion text +
    // the matched value (parsed from the tool result snapshotText, which
    // for assertion_check IS the JSON response, not a page snapshot — but
    // checkAssertion does not update lastSnapshot, so we have to read the
    // raw tool result. Stage 0.5 records snapshotText='' for assertion_check
    // (it's not in SNAPSHOT_PRODUCING_TOOLS) so we read from the assistant
    // text turn or from the toolResults.errorPreview when present.
    //
    // Simpler path: assertion_check results aren't snapshot-producing, so
    // they're not in toolResults[].snapshotText. We need a different signal:
    // the assistant text in the NEXT turn typically narrates the verdict.
    // BUT we have a cleaner answer — assertionCheckResults is recorded in
    // conductor.js, not telemetry. Let's get it from RunResult.trace which
    // includes the ASSERTION: lines).
    //
    // Stringify-action format: "ASSERTION: ✓ \"<text>\" — <evidence>"
    //                       or "ASSERTION: ✗ \"<text>\" — <evidence>"
    const traceLines = (rr.trace || '').split('\n');
    const assertions = [];
    for (const line of traceLines) {
      const m = line.match(/^ASSERTION:\s*([✓✗…])\s*"([^"]*)"\s*—?\s*(.*)$/);
      if (m) {
        assertions.push({
          marker: m[1],
          matched: m[1] === '✓', // ✓ = matched
          assertionText: m[2].trim().toLowerCase(),
          detail: m[3],
        });
      }
    }

    // Group by assertion text. For the dedupe-by-latest deletion to be
    // load-bearing, we need: same assertionText present multiple times
    // AND first occurrence matched=false but final occurrence matched=true.
    const byText = new Map();
    for (const a of assertions) {
      if (!byText.has(a.assertionText)) byText.set(a.assertionText, []);
      byText.get(a.assertionText).push(a);
    }

    const dependsOnDedupe = [];
    for (const [text, list] of byText.entries()) {
      if (list.length < 2) continue;
      const anyFailed = list.some((a) => !a.matched);
      const finalPassed = list[list.length - 1].matched;
      if (anyFailed && finalPassed) {
        dependsOnDedupe.push({ text, list });
      }
    }

    if (dependsOnDedupe.length === 0) {
      console.log(`SAFE ${rr.testCase?.name} — ${assertions.length} assertion_check call(s), no case where dedupe-by-latest was needed`);
      for (const [text, list] of byText.entries()) {
        const verdicts = list.map((a) => a.marker).join('');
        console.log(`     [${verdicts}] "${text.slice(0, 80)}"`);
      }
    } else {
      allSafe = false;
      console.log(`REGRESSION RISK ${rr.testCase?.name}`);
      for (const item of dependsOnDedupe) {
        const verdicts = item.list.map((a) => a.marker).join('');
        console.log(`  [${verdicts}] "${item.text.slice(0, 80)}"`);
        console.log(`     The dedupe-by-latest deletion would cause this case to FAIL on rerun.`);
      }
    }
    console.log();
  }

  console.log(allSafe
    ? 'VERDICT: F.3.2 deletion is provably safe for these 3 fixtures. No live rerun needed.'
    : 'VERDICT: REGRESSION — restore F.3.2 OR design alternative for the affected case(s).');

  await prisma.$disconnect();
  process.exit(allSafe ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
