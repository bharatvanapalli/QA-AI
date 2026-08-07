'use strict';

/**
 * Replay-harness check #2 — STEP_VERDICT emissions (Stage 1.4).
 *
 * Reads the rich-trace telemetry for a given runId and reports the
 * STEP_VERDICT emission profile that Stage 1.4 needs to verify:
 *
 *   - loose count   : matches /STEP_VERDICT/i in assistant text
 *   - strict count  : matches the conductor's exact parser regex
 *   - parser gap    : loose - strict (= markers silently dropped by the parser)
 *   - per-case      : breakdown so a regression on one case stands out
 *
 * Stage 1.4 EXPECTS the loose count to drop materially after the prompt
 * change ("emit only when your judgment differs from the tool result").
 * The KEY thing this script protects against is the PARSER GAP — markers
 * the agent intended but that get silently dropped because the format
 * drifted (smart quotes, unicode brackets, paraphrasing). A non-zero gap
 * means the agent is emitting markers we're not catching — silent
 * correctness loss.
 *
 * Usage:
 *   node scripts/replay/checks/step-verdict-emissions.cjs <runId>
 *
 * Compare against baseline:
 *   node scripts/replay/checks/step-verdict-emissions.cjs <newRunId> --vs <baselineRunId>
 *
 * Exit codes
 *   0 = clean (no parser-gap regressions)
 *   1 = parser gap detected — investigate
 *
 * Stage 2 will fold this into the structured-check API. Standalone for now.
 */

const fs = require('fs');
const zlib = require('zlib');

// The CONDUCTOR's strict parser regex (kept in sync with conductor.js line ~1939).
// Any drift here means we're measuring something different from what the
// platform sees — if you change one, change the other.
const STRICT = /\[STEP_VERDICT\s+step=(\d+)\s+status=(pass|fail|blocked|skipped)(?:\s+reason=([^\]]*))?\]/gi;
// A liberal regex catching anything the agent could plausibly INTEND as a
// STEP_VERDICT marker — paraphrased keys, missing fields, alt brackets.
const LOOSE = /STEP[_\s]*VERDICT/gi;

function countMatches(text, regex) {
  if (!text) return 0;
  const re = new RegExp(regex.source, regex.flags);
  let n = 0;
  while (re.exec(text) !== null) n += 1;
  return n;
}

function profileRecord(parsed) {
  let looseTotal = 0;
  let strictTotal = 0;
  let perTurnLoose = [];
  let perTurnStrict = [];
  for (const t of parsed.turns || []) {
    const text = t.assistantText || '';
    const looseN = countMatches(text, LOOSE);
    const strictN = countMatches(text, STRICT);
    looseTotal += looseN;
    strictTotal += strictN;
    if (looseN || strictN) {
      perTurnLoose.push({ turn: t.index, loose: looseN, strict: strictN, snippet: text.slice(0, 200) });
    }
  }
  return {
    loose: looseTotal,
    strict: strictTotal,
    gap: looseTotal - strictTotal,
    turnsWithEmissions: perTurnLoose,
  };
}

async function loadTelemetry(prisma, runId) {
  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: { results: { include: { testCase: { select: { name: true } } } } },
  });
  if (!run) throw new Error(`Run ${runId} not found`);
  const out = [];
  for (const rr of run.results) {
    if (!rr.richTraceFile || !fs.existsSync(rr.richTraceFile)) {
      out.push({ rr, parsed: null });
      continue;
    }
    try {
      const buf = fs.readFileSync(rr.richTraceFile);
      const parsed = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
      out.push({ rr, parsed });
    } catch (err) {
      out.push({ rr, parsed: null, err: err.message });
    }
  }
  return out;
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/replay/checks/step-verdict-emissions.cjs <runId> [--vs <baselineRunId>]');
    process.exit(2);
  }
  const runId = args[0];
  const vsIdx = args.indexOf('--vs');
  const baselineId = vsIdx >= 0 ? args[vsIdx + 1] : null;

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const target = await loadTelemetry(prisma, runId);
  const baseline = baselineId ? await loadTelemetry(prisma, baselineId) : null;

  console.log(`\nSTEP_VERDICT emission profile — run ${runId}`);
  if (baselineId) console.log(`Baseline run: ${baselineId}`);
  console.log('═'.repeat(80));

  let totalLoose = 0, totalStrict = 0, totalGap = 0;
  let anyGap = false;
  const perCase = [];
  for (const { rr, parsed } of target) {
    if (!parsed) {
      console.log(`SKIP ${rr.testCase?.name} — no telemetry`);
      continue;
    }
    const p = profileRecord(parsed);
    totalLoose += p.loose; totalStrict += p.strict; totalGap += p.gap;
    if (p.gap !== 0) anyGap = true;
    perCase.push({ name: rr.testCase?.name, status: rr.status, p });
  }

  console.log(`${pad('Status', 9)}${pad('Case', 50)}${pad('Loose', 7)}${pad('Strict', 8)}Gap`);
  console.log('-'.repeat(80));
  for (const c of perCase) {
    const flag = c.p.gap !== 0 ? ' ⚠ GAP' : '';
    console.log(`${pad(c.status, 9)}${pad((c.name || '').slice(0, 48), 50)}${pad(c.p.loose, 7)}${pad(c.p.strict, 8)}${pad(c.p.gap, 4)}${flag}`);
  }
  console.log('-'.repeat(80));
  console.log(`${pad('TOTAL', 59)}${pad(totalLoose, 7)}${pad(totalStrict, 8)}${totalGap}`);

  if (anyGap) {
    console.log('\n⚠  PARSER GAP DETECTED');
    console.log('   At least one case has loose > strict — the agent is emitting markers');
    console.log('   the conductor\'s strict regex is silently dropping. Sample offending');
    console.log('   turns:');
    for (const c of perCase) {
      for (const t of c.p.turnsWithEmissions) {
        if (t.loose > t.strict) {
          console.log(`\n   ${c.name}, turn ${t.turn}: loose=${t.loose}, strict=${t.strict}`);
          console.log(`     snippet: ${t.snippet.replace(/\s+/g, ' ').slice(0, 160)}`);
        }
      }
    }
    console.log('\n   Action: tighten the prompt format example OR relax the parser.');
    console.log('   DO NOT ship with silent skip.');
  } else {
    console.log('\n✓ No parser gap — every emitted marker is captured by the parser.');
  }

  if (baseline) {
    let bLoose = 0, bStrict = 0;
    for (const { parsed } of baseline) {
      if (!parsed) continue;
      const p = profileRecord(parsed);
      bLoose += p.loose; bStrict += p.strict;
    }
    console.log('\n## vs baseline');
    const reduce = (after, before) => {
      if (before === 0) return '(baseline=0)';
      return `${(100 * (before - after) / before).toFixed(1)}% reduction`;
    };
    console.log(`  Loose emissions:  baseline=${bLoose}  this=${totalLoose}  ${reduce(totalLoose, bLoose)}`);
    console.log(`  Strict captured:  baseline=${bStrict}  this=${totalStrict}  ${reduce(totalStrict, bStrict)}`);
    console.log(`\n  Read me:`);
    console.log(`    - Strict count dropping to 0:        agent over-corrected — semantic-override path dead.`);
    console.log(`    - Strict count unchanged:           agent didn't internalize the new prompt rule.`);
    console.log(`    - Strict count significantly down + at least one preserved: sweet spot.`);
  }

  await prisma.$disconnect();
  process.exit(anyGap ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
