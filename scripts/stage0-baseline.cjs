'use strict';

/**
 * Phase H — Stage 0 baseline capture.
 *
 * Reads the last 14 days of runs + every RunResult and aggregates:
 *   - total runs / cases / trace bytes
 *   - per-execMode breakdown (pass / fail / blocked / skipped, avg duration, avg trace bytes)
 *   - per-project top-5
 *   - identification of high-traffic fixtures (the registration race etc.)
 *   - the run with the highest trace volume — proxy for the "3.5M token suite"
 *
 * Output: prints to stdout AND writes baseline.json + Stage-0 fixture list
 *         to scripts/stage0-output/ so subsequent stages have a frozen ref.
 *
 * Token cost is approximated from trace bytes — trace is what gets shipped
 * back to Claude on every turn (modulo cache hits), so trace size correlates
 * with input-token cost per turn. We don't have direct per-call token
 * accounting in the DB (yet — that's a Stage 0 sibling task) so this is the
 * best proxy until UserDailyUsage rows can be joined per-project.
 */

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const OUT_DIR = path.join(__dirname, 'stage0-output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const runs = await prisma.run.findMany({
    where: { startedAt: { gte: since } },
    include: {
      results: {
        select: {
          id: true,
          status: true,
          durationMs: true,
          error: true,
          trace: true,
          testCaseId: true,
          testCase: { select: { name: true, module: true } },
        },
      },
      project: { select: { id: true, name: true, execMode: true } },
    },
    orderBy: { startedAt: 'desc' },
  });

  const byMode = {
    fast: { runs: 0, cases: 0, pass: 0, fail: 0, blocked: 0, skipped: 0, durTotal: 0, traceBytes: 0 },
    thorough: { runs: 0, cases: 0, pass: 0, fail: 0, blocked: 0, skipped: 0, durTotal: 0, traceBytes: 0 },
  };
  let totalTraceBytes = 0;
  let totalCases = 0;
  const byProject = new Map();
  let heaviestRun = { id: null, projectName: null, cases: 0, traceBytes: 0 };

  for (const r of runs) {
    const mode = r.project?.execMode || 'fast';
    const bucket = byMode[mode] || byMode.fast;
    bucket.runs += 1;
    bucket.cases += r.results.length;
    let runTraceBytes = 0;
    for (const res of r.results) {
      bucket[res.status] = (bucket[res.status] || 0) + 1;
      if (res.durationMs) bucket.durTotal += res.durationMs;
      const len = (res.trace || '').length;
      bucket.traceBytes += len;
      runTraceBytes += len;
      totalTraceBytes += len;
      totalCases += 1;
    }
    if (runTraceBytes > heaviestRun.traceBytes) {
      heaviestRun = { id: r.id, projectName: r.project?.name, cases: r.results.length, traceBytes: runTraceBytes, startedAt: r.startedAt };
    }
    const proj = byProject.get(r.projectId) || { name: r.project?.name, runs: 0, cases: 0, totalTraceBytes: 0 };
    proj.runs += 1;
    proj.cases += r.results.length;
    proj.totalTraceBytes += runTraceBytes;
    byProject.set(r.projectId, proj);
  }

  const summary = {
    capturedAt: new Date().toISOString(),
    windowDays: 14,
    since: since.toISOString(),
    totals: { runs: runs.length, cases: totalCases, traceBytes: totalTraceBytes },
    byExecMode: {},
    topProjects: [],
    heaviestRun,
  };
  for (const [mode, b] of Object.entries(byMode)) {
    if (b.runs === 0) continue;
    summary.byExecMode[mode] = {
      runs: b.runs,
      cases: b.cases,
      pass: b.pass || 0,
      fail: b.fail || 0,
      blocked: b.blocked || 0,
      skipped: b.skipped || 0,
      passRatePct: b.cases ? +(100 * (b.pass || 0) / b.cases).toFixed(1) : null,
      avgDurationMs: b.cases ? Math.round(b.durTotal / b.cases) : null,
      avgTraceBytesPerCase: b.cases ? Math.round(b.traceBytes / b.cases) : null,
    };
  }
  const topProjects = Array.from(byProject.entries())
    .sort((a, b) => b[1].cases - a[1].cases)
    .slice(0, 5)
    .map(([id, p]) => ({
      projectId: id,
      name: p.name,
      runs: p.runs,
      cases: p.cases,
      avgTraceBytesPerCase: p.cases ? Math.round(p.totalTraceBytes / p.cases) : null,
    }));
  summary.topProjects = topProjects;

  console.log('=== Stage-0 baseline ===');
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(path.join(OUT_DIR, 'baseline.json'), JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${path.join(OUT_DIR, 'baseline.json')}`);

  // Pin fixture-quality result IDs: registration race / valid-credentials early-assertion
  // / logout session termination — the three failures the Phase G work was responding to.
  const FIXTURE_CASE_PATTERNS = [
    /register.*unique/i,
    /valid.credentials/i,
    /logout.*session/i,
    /edit.*note/i,
    /validate.*note.*priv/i,
    /xss/i,
  ];
  const fixtures = [];
  for (const r of runs) {
    for (const res of r.results) {
      const name = res.testCase?.name || '';
      if (FIXTURE_CASE_PATTERNS.some((rx) => rx.test(name))) {
        fixtures.push({
          runResultId: res.id,
          runId: r.id,
          startedAt: r.startedAt,
          projectName: r.project?.name,
          testCaseName: name,
          status: res.status,
          errorPreview: (res.error || '').slice(0, 240),
          traceBytes: (res.trace || '').length,
        });
      }
    }
  }
  // Keep most recent two of each test case name so we have both pass + fail
  // examples where available.
  const byName = new Map();
  fixtures.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  for (const f of fixtures) {
    const key = f.testCaseName.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    if (byName.get(key).length < 2) byName.get(key).push(f);
  }
  const pinned = Array.from(byName.values()).flat();
  fs.writeFileSync(path.join(OUT_DIR, 'fixtures.json'), JSON.stringify(pinned, null, 2));
  console.log(`\nPinned ${pinned.length} fixture(s) → ${path.join(OUT_DIR, 'fixtures.json')}`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
