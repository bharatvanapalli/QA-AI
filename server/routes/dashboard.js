'use strict';

const express = require('express');
const prisma = require('../prisma');
const { requireAuth } = require('../middleware/auth');
const { requireOrg } = require('../middleware/org');
const { aggregateVerdictDisagreement } = require('../services/verdictDashboard');

const router = express.Router();
router.use(requireAuth);
router.use(requireOrg);

/**
 * GET /api/dashboard/:projectId
 * Real aggregated metrics — no fake numbers, only what's actually in DB.
 *
 * Important post-CRIT-6 semantics:
 *   - TestCase.status holds only approval lifecycle (pending|approved|rejected|running).
 *     Execution results live on RunResult — derive pass/fail/blocked from there.
 *   - Pass-rate denominator is `passed + failed + blocked` (executed cases).
 *     Pure `skipped` (test.skip/--grep) is excluded — engineer chose to skip.
 *     Unrun TCs ("not yet measured") are also excluded.
 *   - "pending" execution backlog = pending + running (NOT approved — that's
 *     a user decision, the case may never enter a run).
 *   - "blocked" tile is scoped to the latest run by default, matching the
 *     Blocked Items page default, so the two numbers always agree.
 */
router.get('/:projectId', async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    // Versioning — scope the whole dashboard to the active scenario generation
    // (explicit ?generationId or the project's current). Both Run and TestCase
    // carry generationId, so `genWhere` applies uniformly. Default = current
    // generation; since the backfill put all pre-existing data in Generation 1
    // (which is current for single-generation projects), this is a no-op for
    // them and only diverges once a 2nd generation exists. Null = pre-versioning
    // project → genWhere is empty and the dashboard behaves exactly as before.
    let generationId = null;
    {
      const q = req.query?.generationId;
      if (typeof q === 'string' && q) {
        const g = await prisma.scenarioGeneration.findFirst({ where: { id: q, projectId }, select: { id: true } });
        if (g) generationId = g.id;
      }
      if (!generationId) {
        const cur = await prisma.scenarioGeneration.findFirst({
          where: { projectId, isCurrent: true }, orderBy: { version: 'desc' }, select: { id: true },
        });
        generationId = cur?.id || null;
      }
    }
    const genWhere = generationId ? { generationId } : {};

    // Discover the latest run id once so the BlockedItem scope and the
    // module-health "latest result" lookups agree on which run "now" means.
    const latestRunRow = await prisma.run.findFirst({
      where: { projectId, ...genWhere },
      orderBy: { startedAt: 'desc' },
      select: { id: true },
    });
    const latestRunId = latestRunRow?.id || null;

    const [latestRun, totals, recentRunRows, distinctBlockedTcs, prCount, testCases, latestResults] =
      await Promise.all([
        prisma.run.findFirst({
          where: { projectId, ...genWhere },
          orderBy: { startedAt: 'desc' },
        }),
        prisma.testCase.groupBy({
          by: ['status'],
          where: { projectId, ...genWhere },
          _count: { status: true },
        }),
        prisma.run.findMany({
          where: { projectId, ...genWhere },
          orderBy: { startedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            sprintName: true,
            status: true,
            passed: true,
            failed: true,
            blocked: true,
            skipped: true,
            needsHuman: true,
            startedAt: true,
            completedAt: true,
            results: {
              select: {
                testCase: {
                  select: {
                    scenarioId: true,
                    scenario: { select: { name: true, module: true } },
                  },
                },
              },
            },
          },
        }),
        // Latest-run blockers only. The Blocked Items page defaults to the
        // same scope, so the two numbers always agree. Distinct test cases
        // (groupBy testCaseId) — raw row count was inflated by retry rows.
        latestRunId
          ? prisma.blockedItem.groupBy({
              by: ['testCaseId'],
              where: {
                projectId,
                resolved: false,
                runId: latestRunId,
                NOT: { testCaseId: null },
                // Defensive: only count blockers whose TC still exists.
                // The new FK will SetNull on TC delete going forward, but
                // this filter is belt-and-braces against any legacy data
                // that slipped through before the migration ran.
                testCase: { is: {} },
              },
            })
          : Promise.resolve([]),
        // Only PRs whose source TC still exists — orphan PRs from
        // regenerated test suites are no longer actionable, so don't
        // contribute to the "PRs pending" tile.
        prisma.governancePR.count({
          where: { projectId, status: 'pending', testCase: generationId ? { generationId } : { is: {} } },
        }),
        prisma.testCase.findMany({
          where: { projectId, ...genWhere },
          select: { id: true, name: true, module: true, status: true, businessRisk: true },
        }),
        // Latest RunResult per test case in this project — drives the
        // pass/fail/blocked counts so we never read pass/fail off
        // TestCase.status (which no longer holds those values post-CRIT-6).
        prisma.runResult.findMany({
          where: { testCase: { projectId, ...genWhere } },
          orderBy: [{ run: { startedAt: 'desc' } }],
          select: { testCaseId: true, status: true, runId: true, blockedReason: true },
        }),
      ]);

    // Build latest-result-per-TC map. The findMany above is sorted by run
    // startedAt desc, so the first occurrence per TC is the latest.
    const latestByTc = new Map();
    for (const r of latestResults) {
      if (!latestByTc.has(r.testCaseId)) latestByTc.set(r.testCaseId, r);
    }

    // Module-level health derives from latest RunResult per test case.
    // This handles the prior "module flips with retry ordering" bug where
    // a TC could be counted in `fail` (via TC.status) but actually had a
    // later passing retry.
    const blockedTcIds = new Set(distinctBlockedTcs.map((r) => r.testCaseId));
    const moduleMap = {};
    for (const tc of testCases) {
      const m = moduleMap[tc.module] || { module: tc.module, total: 0, pass: 0, fail: 0, blocked: 0, pending: 0 };
      m.total++;
      const last = latestByTc.get(tc.id);
      if (last?.status === 'pass')               m.pass++;
      else if (last?.status === 'fail')          m.fail++;
      else if (last?.status === 'blocked'
            || blockedTcIds.has(tc.id))          m.blocked++;
      else if (last?.status === 'skipped')       m.pending++;
      else                                        m.pending++;
      moduleMap[tc.module] = m;
    }
    const modules = Object.values(moduleMap)
      .map((m) => ({
        ...m,
        passRate: m.total ? Math.round((m.pass / m.total) * 100) : 0,
      }))
      // Sort by total desc, with a localeCompare tiebreaker so equal-total
      // modules render in a deterministic order across reloads.
      .sort((a, b) => (b.total - a.total) || a.module.localeCompare(b.module));

    // Top-level KPI tiles — all derived from latest RunResult, not TC.status.
    let passed = 0;
    let failed = 0;
    let notJudged = 0;
    let blockedFromResults = 0;
    let skippedFromResults = 0;
    for (const r of latestByTc.values()) {
      if (r.status === 'pass')                                passed++;
      else if (r.status === 'fail')                           failed++;     // confirmed product failures ONLY
      else if (r.status === 'needs_human')                    notJudged++;  // "not judged" — never folded into failed
      else if (r.status === 'blocked')                        blockedFromResults++;
      else if (r.status === 'skipped')                        skippedFromResults++;
    }
    // For the "blocked" tile, prefer the latest-run BlockedItem set (matches
    // the Blocked Items page UI). Fall back to result-derived blocked if we
    // have results but no BlockedItem rows.
    const blocked = blockedTcIds.size || blockedFromResults;

    const totalByStatus = Object.fromEntries(totals.map((t) => [t.status, t._count.status]));
    // "pending execution" backlog excludes `approved` — approved is a user
    // decision; the case may never enter an actual run. Surface approved
    // separately for any consumer that wants it.
    const pendingExecution = (totalByStatus.pending || 0) + (totalByStatus.running || 0);
    const approvedReady = totalByStatus.approved || 0;
    const tcTotal = testCases.length;

    // Stability denominator: executed cases only (pass + fail + blocked).
    // Unrun cases ("not yet measured") and pure skips are excluded.
    // notJudged stays in the executed denominator (a not-judged case DID run, it
    // just couldn't be verified) so it never inflates the pass rate — but it is NOT
    // counted as a product failure.
    const executed = passed + failed + blockedFromResults + notJudged;
    const stability = executed > 0
      ? Math.round((passed / executed) * 1000) / 10
      : null;
    // Coverage: what fraction of the approved-or-ready suite has actually
    // been measured. GO must be gated on this — 100% pass on 4 of 25 cases
    // (the screenshot bug) shouldn't read as "ready to ship".
    const COVERAGE_GO_THRESHOLD = 0.5;   // 50% of the suite must be executed
    const STABILITY_GO_THRESHOLD = 80;   // 80% of executed cases must pass
    const coverage = tcTotal > 0 ? executed / tcTotal : 0;
    const coveragePercent = Math.round(coverage * 100);

    // Recommendation reasoning — pick copy that matches the data so users
    // don't see "investigate failing modules" when there are zero failures.
    let recommendation = 'NO_GO';
    let recommendationReason = '';
    if (tcTotal === 0) {
      recommendation = 'NO_DATA';
      recommendationReason = 'No test cases generated yet. Pull requirements and ask Claude to plan a test suite to see a recommendation.';
    } else if (executed === 0) {
      recommendation = 'NO_DATA';
      recommendationReason = `${tcTotal} test cases generated. Run them at least once to see a release recommendation.`;
    } else if (coverage < COVERAGE_GO_THRESHOLD) {
      // Coverage gate — refuse to recommend on a tiny slice of the suite
      // even if every executed case passed. Stability alone is misleading
      // when most of the suite has never been measured.
      recommendation = 'LOW_COVERAGE';
      const goalExecuted = Math.ceil(tcTotal * COVERAGE_GO_THRESHOLD);
      recommendationReason = `${coveragePercent}% coverage — only ${executed} of ${tcTotal} cases have been run. Run at least ${goalExecuted} (${Math.round(COVERAGE_GO_THRESHOLD * 100)}%) before a release call can be made.`;
    } else if (stability !== null && stability >= STABILITY_GO_THRESHOLD) {
      recommendation = 'GO';
      recommendationReason = `${stability}% of ${executed} executed cases passed (${coveragePercent}% coverage). Suite is stable and ready to ship.`;
    } else {
      recommendation = 'NO_GO';
      const fragments = [`${stability}% pass rate across ${executed} executed cases (${coveragePercent}% coverage)`];
      if (blocked > 0 && failed === 0) {
        fragments.push(`${blocked} blocked before any assertions could run — most cases never reached the system under test`);
      } else if (blocked > 0 && failed > 0) {
        fragments.push(`${failed} hard failure${failed === 1 ? '' : 's'} and ${blocked} blocked case${blocked === 1 ? '' : 's'} need triage`);
      } else if (failed > 0) {
        fragments.push(`${failed} hard failure${failed === 1 ? '' : 's'} — investigate failing assertions`);
      } else {
        fragments.push(`stability below the ${STABILITY_GO_THRESHOLD}% release threshold`);
      }
      recommendationReason = fragments.join('. ') + '.';
    }

    // E3 — P0 risk gate. Pure, unit-tested helper (see applyP0RiskGate below)
    // decides the override so the semantics are verifiable without a live run.
    const gated = applyP0RiskGate(recommendation, recommendationReason, latestByTc, testCases);
    recommendation = gated.recommendation;
    recommendationReason = gated.recommendationReason;
    const holdDetails = gated.holdDetails;

    // Enrich recent runs with distinct scenarios + test count for the cards.
    //
    // Hide all-zero runs (passed/failed/blocked/skipped all 0) UNLESS the run
    // is still in flight — a `running` run legitimately has no counts yet but
    // is the most informative thing the user might want to navigate to.
    // All-zero `completed` / `failed` / `cancelled` runs are noise (reaped
    // mid-startup, cancelled before any test executed) and crowd out useful
    // history from the 4-card grid.
    const recentRuns = recentRunRows
      .filter((r) => {
        const empty = (r.passed || 0) === 0
                   && (r.failed || 0) === 0
                   && (r.blocked || 0) === 0
                   && (r.skipped || 0) === 0;
        return !empty || r.status === 'running';
      })
      .map((r) => {
        const seen = new Map();
        for (const result of r.results || []) {
          const sc = result.testCase?.scenario;
          const id = result.testCase?.scenarioId;
          if (!sc || !id || seen.has(id)) continue;
          seen.set(id, { id, name: sc.name, module: sc.module });
        }
        return {
          id: r.id,
          sprintName: r.sprintName,
          status: r.status,
          passed: r.passed,
          failed: r.failed,             // confirmed product failures ONLY
          needsHuman: r.needsHuman || 0, // "not judged" — never folded into failed
          blocked: r.blocked,
          skipped: r.skipped,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          testCount: (r.results || []).length,
          scenarios: Array.from(seen.values()),
        };
      });

    res.json({
      success: true,
      stats: {
        testCases: tcTotal,
        passed,
        failed,
        notJudged, // "not judged" (needs_human) — surfaced separately, never inside failed
        blocked,
        skipped: skippedFromResults,
        // Backwards-compatible aliases for older clients that have not
        // re-deployed against the post-CRIT split. New consumers should
        // read the explicit fields above.
        pending: pendingExecution,
        approvedReady,
        blockedItems: blocked,
        blockedScope: 'latest', // Tells the UI we counted only the latest run
        latestRunId,
        pendingPRs: prCount,
        stabilityPercent: stability,
        executed,
        coverage,
        coveragePercent,
        recommendation,
        recommendationReason,
        holdDetails,
      },
      latestRun,
      recentRuns,
      modules,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dashboard/:projectId/verdict-disagreement?days=7
 *
 * Phase H M5 — the observable proof that "the report has stopped lying".
 * Compares the AGENT-claimed verdict against the MECHANICAL verdict for
 * every RunResult in a rolling N-day window, broken down by verdictVersion
 * (legacy vs mechanical_v1) so the two ladders can be evaluated side by
 * side without averaging across them.
 *
 * Per-direction columns (read [[verdict-layer-implementation-spec]]
 * §flipDirection enum):
 *   rescuedFalseFails      = FAIL_TO_PASS         (the win story)
 *   surfacedUncheckables   = FAIL_TO_NEEDS_HUMAN  (also a win — was hidden as fail)
 *   caughtOverclaimedPasses= PASS_TO_FAIL         (integrity story)
 *   suspiciousPasses       = PASS_TO_NEEDS_HUMAN  (surfaces over-claim on uncheckables)
 *
 * Default window 7 days, configurable via ?days=N (clamped 1..90).
 *
 * Returns the empty-but-typed shape when no rows match — the UI hides the
 * card on empty, but consumers still see a stable schema.
 */
router.get('/:projectId/verdict-disagreement', async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    // Project ownership / org-scope check — same pattern as the main
    // dashboard endpoint. Forged projectId in a different org returns 404.
    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId: req.org.id },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ success: false, code: 'NOT_FOUND' });

    const daysRaw = Number(req.query.days);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(90, Math.floor(daysRaw)) : 7;
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const since = new Date(sinceMs);

    // Pull every RunResult in the window for this project. Project-scope
    // via the Run side because RunResult doesn't have a direct projectId.
    // SELECT is intentionally narrow — we only need the verdict columns.
    const rows = await prisma.runResult.findMany({
      where: {
        createdAt: { gte: since },
        run: { projectId },
      },
      select: {
        verdictVersion: true,
        verdictMode: true,
        status: true,
        flipDirection: true,
        agentClaimedVerdict: true,
      },
    });

    const { verdictVersions, headline } = aggregateVerdictDisagreement(rows, { windowDays: days });
    res.json({
      success: true,
      windowDays: days,
      since: since.toISOString(),
      verdictVersions,
      headline,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * E3 — P0 risk gate (pure, unit-tested). Decides the release override from the
 * latest result per case + each case's businessRisk.
 *
 * Semantics (refined after seeing real cancelled-run data):
 *   - P0 latest === 'fail'  → HARD NO_GO. The case ran and the app is broken.
 *   - P0 latest is anything-else-not-pass (blocked / skipped / needs_human) →
 *     HOLD (LOW_COVERAGE). We could NOT confirm the P0 path this run; "we don't
 *     know" must never ship as GO, but it isn't a proven failure either.
 *   - P0 latest === 'pass' → no effect.
 * The override only ever DOWNGRADES from GO (never upgrades), so a base NO_GO /
 * LOW_COVERAGE stands. holdDetails is always returned for the Overview panel.
 *
 * @param {string} recommendation        base recommendation
 * @param {string} recommendationReason   base reason
 * @param {Map<string,{status:string,blockedReason?:string}>} latestByTc
 * @param {Array<{id:string,name:string,module?:string,businessRisk?:string}>} testCases
 * @returns {{recommendation:string, recommendationReason:string, holdDetails:{p0Failures:Array,p0Uncheckable:Array}}}
 */
function applyP0RiskGate(recommendation, recommendationReason, latestByTc, testCases) {
  const holdDetails = { p0Failures: [], p0Uncheckable: [] };
  if (recommendation === 'GO' || recommendation === 'LOW_COVERAGE' || recommendation === 'NO_GO') {
    const tcRiskMap = new Map(testCases.map((tc) => [tc.id, { name: tc.name, risk: tc.businessRisk || 'P1', module: tc.module }]));
    for (const [tcId, result] of latestByTc) {
      const tcInfo = tcRiskMap.get(tcId);
      if (!tcInfo || tcInfo.risk !== 'P0') continue;
      if (result.status === 'pass') continue;
      const item = { caseId: tcId, caseName: tcInfo.name, module: tcInfo.module, status: result.status, blockedReason: result.blockedReason || null };
      // Only a genuine FAIL is a hard NO_GO; everything else we couldn't
      // confirm (blocked / did-not-run / needs-human) is a HOLD, not a failure.
      if (result.status === 'fail') holdDetails.p0Failures.push(item);
      else holdDetails.p0Uncheckable.push(item);
    }
    if (holdDetails.p0Failures.length > 0 && recommendation === 'GO') {
      recommendation = 'NO_GO';
      const names = holdDetails.p0Failures.slice(0, 2).map((f) => `"${f.caseName}"`).join(', ');
      recommendationReason = `P0 failure${holdDetails.p0Failures.length > 1 ? 's' : ''} in ${names}${holdDetails.p0Failures.length > 2 ? ` (+${holdDetails.p0Failures.length - 2} more)` : ''} — unconditional NO_GO regardless of overall pass rate.`;
    }
    // P0 coverage incomplete: a P0 case we could NOT verify must not ship as GO.
    if (holdDetails.p0Uncheckable.length > 0 && recommendation === 'GO') {
      recommendation = 'LOW_COVERAGE';
      const names = holdDetails.p0Uncheckable.slice(0, 2).map((f) => `"${f.caseName}"`).join(', ');
      recommendationReason = `P0 coverage incomplete — ${holdDetails.p0Uncheckable.length} P0 case${holdDetails.p0Uncheckable.length > 1 ? 's' : ''} (${names}${holdDetails.p0Uncheckable.length > 2 ? ', …' : ''}) could not be verified this run. Resolve before making a release call.`;
    }
  }
  return { recommendation, recommendationReason, holdDetails };
}

module.exports = router;
module.exports.applyP0RiskGate = applyP0RiskGate;
