'use strict';

/**
 * Stage-1.3 telemetry analyser.
 *
 * Usage: node scripts/stage13-analyse.cjs <runId>
 *
 * Reads every richTraceFile for the given runId and produces the capture
 * checklist Stage 1.3's PHASE_LOG entry needs:
 *
 *   - Stability-iteration distribution (counts of iter=1 / 2 / 3 / cap-hit)
 *   - Cap-hit downgrade count + the cases that fired it
 *   - Per-case wall-clock + turn count + token totals
 *   - Telemetry-pipeline integrity: every RunResult has richTraceFile,
 *     file is readable, gzip+JSON valid, all promised fields present
 *   - Per-case final URL (for registration verification)
 *   - Per-case status (pass/fail/blocked) + Stage 0 baseline comparison
 *
 * Designed to be re-runnable. No DB writes — pure analysis.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: node scripts/stage13-analyse.cjs <runId>');
  process.exit(2);
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }
function pct(n, d) { return d > 0 ? (100 * n / d).toFixed(1) + '%' : '-'; }

async function main() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const run = await prisma.run.findUnique({
    where: { id: runId },
    include: {
      results: {
        include: { testCase: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      },
      project: { select: { name: true, execMode: true } },
    },
  });
  if (!run) {
    console.error(`Run ${runId} not found.`);
    process.exit(2);
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Stage 1.3 telemetry analysis — run ${runId}`);
  console.log(`Project: ${run.project?.name || '-'}   execMode: ${run.project?.execMode || '-'}`);
  console.log(`Started: ${run.startedAt.toISOString()}   Cases: ${run.results.length}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Telemetry-pipeline integrity check ─────────────────────────────────
  const pipelineFindings = [];
  const records = [];
  for (const rr of run.results) {
    const issue = { resultId: rr.id, testCase: rr.testCase?.name, status: rr.status };
    if (!rr.richTraceFile) {
      issue.problem = 'no richTraceFile path on RunResult';
      pipelineFindings.push(issue);
      continue;
    }
    if (!fs.existsSync(rr.richTraceFile)) {
      issue.problem = `richTraceFile path set but file missing: ${rr.richTraceFile}`;
      pipelineFindings.push(issue);
      continue;
    }
    let parsed;
    try {
      const buf = fs.readFileSync(rr.richTraceFile);
      const inflated = zlib.gunzipSync(buf).toString('utf8');
      parsed = JSON.parse(inflated);
    } catch (err) {
      issue.problem = `gzip/JSON parse failed: ${err.message}`;
      pipelineFindings.push(issue);
      continue;
    }
    const required = ['schemaVersion', 'runId', 'runResultId', 'turns', 'stabilityCapHits', 'stabilityDowngraded'];
    const missing = required.filter((k) => !(k in parsed));
    if (missing.length) {
      issue.problem = `missing required fields: ${missing.join(', ')}`;
      pipelineFindings.push(issue);
      continue;
    }
    records.push({ rr, parsed });
  }

  console.log('## Pipeline integrity');
  if (pipelineFindings.length === 0) {
    console.log(`  ✓ All ${run.results.length} RunResult(s) have a richTraceFile, gzip-readable, JSON-parseable, all required fields present.`);
  } else {
    console.log(`  ✗ ${pipelineFindings.length} of ${run.results.length} had a problem:`);
    for (const p of pipelineFindings) console.log(`    - [${p.status}] ${p.testCase}: ${p.problem}`);
  }
  console.log();

  if (records.length === 0) {
    console.log('No usable telemetry — cannot continue analysis.');
    await prisma.$disconnect();
    process.exit(1);
  }

  // Stability iteration distribution ───────────────────────────────────
  const iterHist = { 1: 0, 2: 0, 3: 0, capped: 0 };
  let totalStabilityCalls = 0;
  let totalStabilityMs = 0;
  const downgradedCases = [];
  for (const { rr, parsed } of records) {
    if (parsed.stabilityDowngraded) downgradedCases.push({ testCase: rr.testCase?.name, capHits: parsed.stabilityCapHits });
    for (const t of parsed.turns || []) {
      for (const tr of t.toolResults || []) {
        if (!tr.stability) continue;
        totalStabilityCalls += 1;
        totalStabilityMs += tr.stability.elapsedMs || 0;
        if (tr.stability.capped) {
          iterHist.capped += 1;
        } else {
          const it = tr.stability.iterations || 0;
          if (it <= 1) iterHist[1] += 1;
          else if (it === 2) iterHist[2] += 1;
          else iterHist[3] += 1;
        }
      }
    }
  }

  console.log('## Stability iteration distribution');
  console.log(`  Total state-changing tool calls measured: ${totalStabilityCalls}`);
  if (totalStabilityCalls > 0) {
    console.log(`  iter=1 (settled fast):    ${pad(iterHist[1], 4)}  ${pct(iterHist[1], totalStabilityCalls)}`);
    console.log(`  iter=2 (one re-snap):     ${pad(iterHist[2], 4)}  ${pct(iterHist[2], totalStabilityCalls)}`);
    console.log(`  iter=3 (two re-snaps):    ${pad(iterHist[3], 4)}  ${pct(iterHist[3], totalStabilityCalls)}`);
    console.log(`  cap-hits (never settled): ${pad(iterHist.capped, 4)}  ${pct(iterHist.capped, totalStabilityCalls)}`);
    console.log(`  Avg stabilisation time:   ${(totalStabilityMs / totalStabilityCalls).toFixed(0)}ms`);
  }
  console.log();

  console.log('## Escape-hatch fires');
  if (downgradedCases.length === 0) {
    console.log('  No cases downgraded (good — escape hatch armed but never tripped).');
  } else {
    console.log(`  ${downgradedCases.length} case(s) downgraded to single-snapshot mode:`);
    for (const d of downgradedCases) console.log(`    - ${d.testCase} (capHits=${d.capHits})`);
  }
  console.log();

  // Per-case summary ────────────────────────────────────────────────────
  console.log('## Per-case summary');
  console.log(`  ${pad('Status', 9)}${pad('Case', 50)}${pad('Turns', 7)}${pad('InTok', 9)}${pad('OutTok', 8)}${pad('CacheR', 9)}${pad('Wall(s)', 9)}Final URL`);
  console.log(`  ${'-'.repeat(120)}`);
  let totalIn = 0, totalOut = 0, totalCacheR = 0, totalWallMs = 0;
  for (const { rr, parsed } of records) {
    const turnCount = (parsed.turns || []).length;
    let inTok = 0, outTok = 0, cacheRTok = 0;
    let lastSnapshotText = '';
    for (const t of parsed.turns || []) {
      inTok += t.usage?.inputTokens || 0;
      outTok += t.usage?.outputTokens || 0;
      cacheRTok += t.usage?.cacheReadTokens || 0;
      for (const tr of t.toolResults || []) {
        if (tr.snapshotText) lastSnapshotText = tr.snapshotText;
      }
    }
    totalIn += inTok; totalOut += outTok; totalCacheR += cacheRTok;
    totalWallMs += parsed.totalElapsedMs || 0;
    // Extract Page URL from last snapshot (MCP snapshots have "Page URL: ..." header)
    const urlMatch = (lastSnapshotText || '').match(/Page URL:\s*([^\n]+)/);
    const finalUrl = urlMatch ? urlMatch[1].trim().slice(0, 45) : '(unknown)';
    console.log(
      `  ${pad(rr.status, 9)}${pad((rr.testCase?.name || '').slice(0, 48), 50)}${pad(turnCount, 7)}${pad(inTok, 9)}${pad(outTok, 8)}${pad(cacheRTok, 9)}${pad(((parsed.totalElapsedMs || 0) / 1000).toFixed(1), 9)}${finalUrl}`,
    );
  }
  console.log(`  ${'-'.repeat(120)}`);
  console.log(`  TOTALS                                                    ${pad('-', 7)}${pad(totalIn, 9)}${pad(totalOut, 8)}${pad(totalCacheR, 9)}${pad((totalWallMs / 1000).toFixed(1), 9)}`);
  console.log();

  // Stage 0 baseline comparison ─────────────────────────────────────────
  const baselinePath = path.join(__dirname, 'stage0-output', 'baseline.json');
  if (fs.existsSync(baselinePath)) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const fast = baseline.byExecMode?.fast || {};
    console.log('## vs Stage 0 baseline (last 14 days, all fast mode)');
    console.log(`  Baseline pass rate:       ${pct(fast.pass, fast.cases)}  (${fast.pass}/${fast.cases})`);
    console.log(`  Baseline blocked rate:    ${pct(fast.blocked, fast.cases)}  (${fast.blocked}/${fast.cases})`);
    const passN = records.filter((r) => r.rr.status === 'pass').length;
    const failN = records.filter((r) => r.rr.status === 'fail').length;
    const blockedN = records.filter((r) => r.rr.status === 'blocked').length;
    console.log(`  This run pass rate:       ${pct(passN, records.length)}  (${passN}/${records.length})`);
    console.log(`  This run blocked rate:    ${pct(blockedN, records.length)}  (${blockedN}/${records.length})`);
    console.log(`  This run fail rate:       ${pct(failN, records.length)}  (${failN}/${records.length})`);
    console.log(`  NOTE: this is a 3-case rerun of the previously-failing fixtures, not a fresh suite.`);
    console.log(`        Stage 1.3 alone is expected to make MODEST gains; 1.2 is where blocked-rate should fall.`);
  }
  console.log();

  // Tuning recommendation for Stage 1.2 polling interval ────────────────
  console.log('## Stage 1.2 tuning recommendation');
  if (totalStabilityCalls === 0) {
    console.log('  Insufficient data — no state-changing calls in this run. Default 500ms × 5s for assertion_check.');
  } else {
    const p1 = (iterHist[1] / totalStabilityCalls);
    const p2 = (iterHist[2] / totalStabilityCalls);
    const pCap = (iterHist.capped / totalStabilityCalls);
    if (p1 > 0.7) {
      console.log('  Most actions settled on iter=1. Pages settle FAST on this SUT.');
      console.log('  Recommend assertion_check: 250ms × 4s (8 iterations). Tight loop, low latency.');
    } else if (p2 > 0.5) {
      console.log('  Most actions settled on iter=2. Pages settle in 200-400ms.');
      console.log('  Recommend assertion_check: 500ms × 5s (10 iterations) — the original intuition.');
    } else if (pCap > 0.3) {
      console.log('  Many actions hit the cap. Either the interval is too coarse or the SUT is genuinely flaky.');
      console.log('  Recommend assertion_check: 250ms × 8s (32 iterations) — tighter polling, longer ceiling.');
      console.log('  Also: lower STABILITY_INTERVAL_MS from 200 to 150 and re-test.');
    } else {
      console.log('  Mixed distribution. Default 500ms × 5s is safe.');
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
