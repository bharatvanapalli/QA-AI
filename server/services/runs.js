'use strict';

/**
 * Real run engine.
 * - Persists Run / RunResult / BlockedItem / GovernancePR to Prisma.
 * - Streams progress to the OWNING user via WS broadcastToUser.
 * - Generates real Playwright spec files (test-generator.js) and runs them
 *   via playwright-worker.js — no mocks.
 */

const path = require('path');
const prisma = require('../prisma');
const vault = require('../services/vault');
const audit = require('../services/audit');
const { generateSpecFile, cleanTestsDir } = require('../test-generator');
const { runPlaywright, getArtifacts, PLAYWRIGHT_DIR } = require('../playwright-worker');
const lintGates = require('./lintGates');
const { encodeArray, decodeArray, encodeJson, decodeJson } = require('./jsonField');
const integrations = require('./integrations');

function toArtifactUrl(absPath) {
  if (!absPath) return null;
  return (
    '/artifacts/' +
    path
      .relative(path.join(PLAYWRIGHT_DIR, 'test-results'), absPath)
      .replace(/\\/g, '/')
  );
}

/**
 * Start a real run.
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.projectId
 * @param {string[]} opts.testCaseIds
 * @param {string?} opts.sprintName
 * @param {function} opts.send - (msg) => void: streams to the owning user
 * @returns {Promise<{run, testCases}>}
 */
// Phase E8 — `orgId` is the new tenancy gate. `userId` is still recorded
// on the resulting Run row (who triggered it) but is NOT the auth boundary
// anymore — any member of the org that owns the project can start runs
// on it.
async function startRun({ userId, orgId, projectId, testCaseIds, sprintName, sprintId, send }) {
  const project = await prisma.project.findFirst({
    where: orgId ? { id: projectId, orgId } : { id: projectId, userId },
  });
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  const testCases = await prisma.testCase.findMany({
    where: { projectId, id: { in: testCaseIds || [] } },
  });
  if (!testCases.length) {
    const err = new Error('No matching test cases');
    err.status = 400;
    err.code = 'NO_TEST_CASES';
    throw err;
  }

  const integration = await integrations.get(userId, 'claude');
  const claudeKey = await vault.get(userId, 'claude.apiKey'); // may be null — fallback works
  // No silent demo-URL fallback. If neither the project nor the env
  // declares a targetUrl, refuse the run — running tests against
  // `demo.playwright.dev/todomvc` in a multi-tenant prod deployment would
  // leak test traffic and silently produce garbage results.
  const targetUrl = project.targetUrl || process.env.QAAI_TARGET_URL;
  if (!targetUrl) {
    const err = new Error(
      'No target URL configured. Set the project\'s Target URL in Project Setup, ' +
      'or set QAAI_TARGET_URL in the server environment.'
    );
    err.status = 400;
    err.code = 'NO_TARGET_URL';
    throw err;
  }

  const run = await prisma.run.create({
    data: {
      userId,
      projectId,
      sprintId: sprintId || null,
      sprintName: sprintName || `Sprint ${new Date().toLocaleDateString()}`,
      status: 'running',
      config: encodeJson({ targetUrl, testCaseIds: testCaseIds || [] }),
    },
  });

  // Mark test cases as running
  await prisma.testCase.updateMany({
    where: { id: { in: testCases.map((t) => t.id) } },
    data: { status: 'running' },
  });

  // Phase B / B3: record which TCs ran in which sprint (sprint-comparison
  // queries + carry-forward use this). Upsert via createMany skipDuplicates
  // so re-running the same case in the same sprint doesn't error.
  if (sprintId) {
    await prisma.sprintTestCase.createMany({
      data: testCases.map((tc) => ({ sprintId, testCaseId: tc.id })),
      skipDuplicates: true,
    });
  }

  await audit.log({
    userId,
    action: 'run.start',
    target: run.id,
    metadata: { projectId, testCount: testCases.length, targetUrl },
  });

  // Background — never await; results stream via `send`
  (async () => {
    try {
      send({ type: 'log', message: `▶  Run ${run.id} · target: ${targetUrl}` });
      send({ type: 'run.started', runId: run.id, testCount: testCases.length });

      cleanTestsDir();
      const specFiles = [];
      const testCaseMap = {};
      for (const tc of testCases) {
        send({ type: 'log', message: `📝 Generating spec: ${tc.name}` });
        try {
          const { filePath, code } = await generateSpecFile(
            { id: tc.id, name: tc.name, module: tc.module, type: tc.type, assertions: tc.assertions, confidence: tc.confidence },
            targetUrl,
            claudeKey
          );
          specFiles.push(filePath);
          testCaseMap[tc.id] = tc;
          // Persist generated code on the test case
          await prisma.testCase.update({
            where: { id: tc.id },
            data: { specCode: code.slice(0, 60_000) },
          });
          send({ type: 'log', message: `  ✅ ${path.basename(filePath)}` });
        } catch (err) {
          send({ type: 'log', message: `  ⚠️ Spec gen failed for ${tc.name}: ${err.message}` });
        }
      }

      if (!specFiles.length) {
        await failRun(run.id, 'No spec files generated.');
        send({ type: 'run.complete', runId: run.id, summary: { passed: 0, failed: 0, blocked: testCases.length, skipped: 0 } });
        return;
      }

      send({ type: 'log', message: `🚀 Launching Playwright — ${specFiles.length} specs (chromium)` });

      const report = await runPlaywright({
        specFiles,
        testCaseMap,
        broadcast: send,
        runId: run.id,
      });

      // Persist per-test results
      let passed = 0;
      let failed = 0;
      let blocked = 0;
      let skipped = 0;
      for (const [tcId, result] of Object.entries(report.results)) {
        const arts = getArtifacts(tcId);
        const screenshots = arts.screenshots.map(toArtifactUrl).filter(Boolean);
        const video = toArtifactUrl(arts.video);

        await prisma.runResult.create({
          data: {
            runId: run.id,
            testCaseId: tcId,
            status: result.status,
            // Prefer the raw durationMs the worker emits — the prior
            // string-roundtrip via `parseFloat('0.0') * 1000` quietly
            // collapsed near-zero durations to null. Fallback only when
            // the worker actually has no number to report.
            durationMs: typeof result.durationMs === 'number'
              ? result.durationMs
              : (result.time && typeof result.time === 'string'
                  ? Math.round(parseFloat(result.time) * 1000) || null
                  : null),
            error: result.error || null,
            screenshots: encodeArray(screenshots),
            video,
            trace: result.trace || null,
          },
        });

        // Decouple TestCase.status from execution outcome (CRIT-6). Reset
        // to 'approved' after the run so the row reflects only the user's
        // approval decision — pass/fail/blocked/skipped live on RunResult.
        // Consumers that want the latest outcome should read RunResult.
        await prisma.testCase.update({
          where: { id: tcId },
          data: { status: 'approved' },
        });

        if (result.status === 'pass')         passed++;
        else if (result.status === 'fail')    failed++;
        else if (result.status === 'skipped') skipped++;
        else                                   blocked++;

        // Open a blocked item for failed assertions / missing locators.
        // Skip pure `skipped` results — those are engineer-chosen exclusions,
        // not blockers.
        if (result.status !== 'pass' && result.status !== 'skipped') {
          const reason = classifyError(result.error);
          const locator = extractLocator(result.error);
          await prisma.blockedItem.create({
            data: {
              projectId,
              runId: run.id,
              testCaseId: tcId,
              reason,
              locator,
              message: (result.error || 'Test failed').slice(0, 1000),
            },
          });

          // INT-14: if the failure is locator-classified and the locator
          // appears in our Knowledge Base, decrement its healthScore so the
          // KB page actually reflects which locators are degrading. The
          // existing healthScore was stored at create-time and never moved.
          if (reason === 'locator_missing' && locator) {
            const kb = await prisma.knowledgeBaseLocator.findFirst({
              where: { projectId, selector: locator },
              select: { id: true, healthScore: true },
            });
            if (kb) {
              const next = Math.max(0, (kb.healthScore || 100) - 10);
              await prisma.knowledgeBaseLocator.update({
                where: { id: kb.id },
                data: { healthScore: next },
              });
            }
          }
        }

        // For passed tests, create a Governance PR row with real lint check
        if (result.status === 'pass') {
          const tc = testCaseMap[tcId];
          if (tc) {
            const lint = lintGates.lint(tc.specCode || '');
            // Number is unique per project (schema @@unique). On a rare
            // race (two concurrent runs in the same project) the create
            // might conflict — retry once with a fresh count.
            const projectPrefix = projectId.slice(0, 4).toUpperCase();
            const writePr = async () => {
              const prCount = await prisma.governancePR.count({ where: { projectId } });
              const number = `${projectPrefix}-#${100 + prCount + 1}`;
              return prisma.governancePR.create({
                data: {
                  projectId,
                  runId: run.id,
                  testCaseId: tcId,
                  number,
                  filename: `${tcId.replace(/[^a-zA-Z0-9_-]/g, '_')}.spec.ts`,
                  requirement: tc.assertions.split(',')[0]?.trim() || tc.name,
                  specCode: tc.specCode || '',
                  lintPassed: lint.lintPassed,
                  lintFindings: encodeJson(lint.findings),
                  status: 'pending',
                },
              });
            };
            try {
              await writePr();
            } catch (err) {
              // Likely the @@unique([projectId, number]) constraint racing
              // with another run — recompute and try once more. Anything
              // else surfaces normally.
              if (err.code === 'P2002') {
                await writePr();
              } else {
                throw err;
              }
            }
            send({
              type: 'log',
              message: `  🔍 Lint: ${lint.errorCount} error · ${lint.warningCount} warning ${lint.lintPassed ? '✅' : '❌'}`,
            });
          }
        }
      }

      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: 'completed',
          passed,
          failed,
          blocked,
          skipped,
          completedAt: new Date(),
        },
      });

      const total = passed + failed + blocked + skipped;
      // Pass-rate denominator excludes pure skips — engineers chose those.
      // Blocked counts because the agent tried and failed to even reach
      // the assertion (environmental failure surfacing).
      const denom = passed + failed + blocked;
      const passRate = denom > 0 ? Math.round((passed / denom) * 100) : 0;
      send({
        type: 'run.complete',
        runId: run.id,
        summary: { passed, failed, blocked, skipped, total, passRate },
      });
      send({
        type: 'log',
        message: `SUITE COMPLETE — ${passed} pass · ${failed} fail · ${blocked} blocked · ${skipped} skipped (${passRate}%)`,
      });
    } catch (err) {
      console.error('[runs] fatal', err);
      await failRun(run.id, err.message);
      send({ type: 'log', message: `CRITICAL: ${err.message}` });
      send({
        type: 'run.complete',
        runId: run.id,
        summary: { passed: 0, failed: 0, blocked: testCases.length, skipped: 0 },
      });
    }
  })();

  return { run, testCases };
}

async function failRun(runId, message) {
  try {
    await prisma.run.update({
      where: { id: runId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        config: encodeJson({ error: message }),
      },
    });
  } catch (_) {}
}

function classifyError(msg) {
  if (!msg) return 'unknown';
  const s = msg.toLowerCase();
  if (s.includes('locator') || s.includes('selector') || s.includes('not found')) return 'locator_missing';
  if (s.includes('timeout') || s.includes('timed out')) return 'timeout';
  if (s.includes('expect') || s.includes('assert')) return 'assertion';
  if (s.includes('network') || s.includes('econnrefused') || s.includes('dns')) return 'network';
  return 'unknown';
}

function extractLocator(msg) {
  if (!msg) return null;
  const m = msg.match(/locator\(['"]([^'"]+)['"]\)|getBy(?:Role|TestId|Label|Text)\(['"]([^'"]+)['"]\)/i);
  return m ? m[1] || m[2] : null;
}

// Phase E8 — orgId is the new tenancy gate. When supplied, lists runs
// across all org members for the given project (or all org projects when
// projectId is omitted). userId is kept as a backwards-compatible fallback
// for callers that haven't migrated to the org context yet.
async function listRuns(userId, projectId, limit = 50, sprintId = null, orgId = null) {
  const rows = await prisma.run.findMany({
    where: {
      ...(orgId
        ? { project: { orgId } }
        : { userId }),
      ...(projectId ? { projectId } : {}),
      ...(sprintId ? { sprintId } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      projectId: true,
      sprintName: true,
      status: true,
      passed: true,
      failed: true,
      blocked: true,
      skipped: true,
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
  });
  // Flatten each row to a card-friendly shape: surface distinct scenario names
  // and test-case count so the UI can show "Login · Checkout · 5 tests" instead
  // of an opaque "Agent run · 9:18 PM".
  //
  // Also hide all-zero runs (passed/failed/blocked/skipped all 0) UNLESS the
  // run is still in flight — a `running` row legitimately has no counts yet
  // but is the most navigable thing on the list. Same logic as the dashboard
  // Recent Runs filter — keeps the Reports list focused on runs that actually
  // produced signal.
  return rows
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
        projectId: r.projectId,
        sprintName: r.sprintName,
        status: r.status,
        passed: r.passed,
        failed: r.failed,
        blocked: r.blocked,
        skipped: r.skipped,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        testCount: (r.results || []).length,
        scenarios: Array.from(seen.values()),
      };
    });
}

/**
 * Recompute Run.passed/failed/blocked/skipped from the actual RunResult
 * rows. Use this when a RunResult is added/deleted out of band (cleanup
 * scripts, manual db edits, future bulk operations) so the denormalised
 * counters never drift from the source of truth.
 */
async function recomputeRunCounters(runId) {
  const grouped = await prisma.runResult.groupBy({
    by: ['status'],
    where: { runId },
    _count: { status: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count.status]));
  await prisma.run.update({
    where: { id: runId },
    data: {
      passed:  byStatus.pass    || 0,
      failed:  byStatus.fail    || 0,
      blocked: byStatus.blocked || 0,
      skipped: byStatus.skipped || 0,
    },
  });
}

// Phase E8 — orgId is the auth gate; userId fallback for legacy callers.
async function getRun(userId, runId, orgId = null) {
  const run = await prisma.run.findFirst({
    where: orgId ? { id: runId, project: { orgId } } : { id: runId, userId },
    include: {
      results: {
        include: {
          testCase: {
            select: {
              id: true, name: true, module: true, type: true, confidence: true,
              userGuidance: true,
              scenarioId: true,
              scenario: { select: { id: true, name: true, module: true, priority: true, category: true } },
            },
          },
        },
      },
    },
  });
  if (!run) return null;

  // Pull BlockedItem rows for this run in a single query so the UI can show a
  // proper reason on BLOCKED cases (where result.error is often empty).
  const blockedRows = await prisma.blockedItem.findMany({
    where: { runId: run.id },
    select: { id: true, testCaseId: true, reason: true, locator: true, message: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const blockedByTc = new Map();
  for (const b of blockedRows) {
    if (!b.testCaseId) continue;
    if (!blockedByTc.has(b.testCaseId)) blockedByTc.set(b.testCaseId, b);
  }

  run.results = run.results.map((r) => ({
    ...r,
    screenshots: decodeArray(r.screenshots),
    networkLog: decodeJson(r.networkLog, []),
    domSnapshots: decodeJson(r.domSnapshots, []),
    chatHistory: decodeJson(r.chatHistory, []),
    // Phase E4 — visualDiffs is a JSON string on disk; decode for clients.
    visualDiffs: decodeJson(r.visualDiffs, []),
    blocked: blockedByTc.get(r.testCaseId) || null,
  }));
  return run;
}

/**
 * Compare two runs side by side. Returns:
 *   - per-run summaries (passed / failed / skipped / startedAt / sprintName)
 *   - a `diff` block grouping test cases by status transition between A and B
 *
 * "newFailures"  — passed in A but failed/blocked in B (regressions)
 * "fixedFailures" — failed/blocked in A but passed in B (wins)
 * "stillFailing" — failed in both (chronic, but at least not regressions)
 * "unchanged"    — same status in both
 * "onlyInA"      — test ran in A but not in B (or vice-versa via onlyInB)
 *
 * Both runs must belong to the requesting user. Test cases are matched by
 * `testCaseId`; the union is keyed on TC id so a TC that exists in one but
 * not the other lands in the right bucket.
 */
// Phase E8 — orgId supplants userId as the auth gate. Either side of the
// compare must belong to the requesting org.
async function compareRuns(userId, runIdA, runIdB, orgId = null) {
  const gate = orgId ? { project: { orgId } } : { userId };
  const [runA, runB] = await Promise.all([
    prisma.run.findFirst({
      where: { id: runIdA, ...gate },
      select: { id: true, sprintName: true, status: true, passed: true, failed: true, blocked: true, skipped: true, startedAt: true, completedAt: true },
    }),
    prisma.run.findFirst({
      where: { id: runIdB, ...gate },
      select: { id: true, sprintName: true, status: true, passed: true, failed: true, blocked: true, skipped: true, startedAt: true, completedAt: true },
    }),
  ]);
  if (!runA || !runB) {
    const err = new Error('One or both runs not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  // Pull both results sets in one go and decorate with test case name +
  // scenario so the UI can render meaningful labels without a second call.
  const [resultsA, resultsB] = await Promise.all([
    prisma.runResult.findMany({
      where: { runId: runA.id },
      select: {
        id: true, status: true, testCaseId: true, durationMs: true, error: true,
        testCase: { select: { id: true, name: true, module: true, scenario: { select: { id: true, name: true } } } },
      },
    }),
    prisma.runResult.findMany({
      where: { runId: runB.id },
      select: {
        id: true, status: true, testCaseId: true, durationMs: true, error: true,
        testCase: { select: { id: true, name: true, module: true, scenario: { select: { id: true, name: true } } } },
      },
    }),
  ]);

  const byTcA = new Map(resultsA.map((r) => [r.testCaseId, r]));
  const byTcB = new Map(resultsB.map((r) => [r.testCaseId, r]));
  const allTcIds = new Set([...byTcA.keys(), ...byTcB.keys()]);

  const newFailures = [];
  const fixedFailures = [];
  const stillFailing = [];
  const unchanged = [];
  const onlyInA = [];
  const onlyInB = [];

  const isFail = (s) => s === 'fail' || s === 'blocked';

  for (const tcId of allTcIds) {
    const a = byTcA.get(tcId) || null;
    const b = byTcB.get(tcId) || null;
    const tc = b?.testCase || a?.testCase || null;
    const entry = {
      testCaseId: tcId,
      testCase: tc ? { id: tc.id, name: tc.name, module: tc.module } : null,
      scenario: tc?.scenario || null,
      a: a ? { status: a.status, durationMs: a.durationMs } : null,
      b: b ? { status: b.status, durationMs: b.durationMs } : null,
    };
    if (a && !b) { onlyInA.push(entry); continue; }
    if (b && !a) { onlyInB.push(entry); continue; }
    // Both present
    if (a.status === b.status) {
      if (isFail(a.status)) stillFailing.push(entry);
      else unchanged.push(entry);
      continue;
    }
    if (!isFail(a.status) && isFail(b.status)) { newFailures.push(entry); continue; }
    if (isFail(a.status) && !isFail(b.status)) { fixedFailures.push(entry); continue; }
    // Any other transition (e.g. fail → blocked, blocked → fail) lands in
    // stillFailing — both sides are failures, just of a different flavour.
    if (isFail(a.status) && isFail(b.status)) { stillFailing.push(entry); continue; }
    unchanged.push(entry);
  }

  return {
    a: runA,
    b: runB,
    diff: { newFailures, fixedFailures, stillFailing, unchanged, onlyInA, onlyInB },
    totals: {
      newFailures: newFailures.length,
      fixedFailures: fixedFailures.length,
      stillFailing: stillFailing.length,
      unchanged: unchanged.length,
      onlyInA: onlyInA.length,
      onlyInB: onlyInB.length,
    },
  };
}

/**
 * Recent history of a single test case across runs. Used by the Reports
 * detail pane's mini "history sparkline + flaky score" panel.
 *
 * Returns rows ordered oldest → newest (so a sparkline reads left-to-right
 * chronologically) with just the fields the UI needs.
 */
async function getTestCaseHistory(userId, projectId, testCaseId, limit = 20, orgId = null) {
  // Cap limit defensively so a runaway query string can't pull thousands.
  const take = Math.max(1, Math.min(Number(limit) || 20, 100));

  // Authorise via the project before touching results. Phase E8 — prefer
  // orgId gate when supplied; fall back to userId for legacy callers.
  const project = await prisma.project.findFirst({
    where: orgId ? { id: projectId, orgId } : { id: projectId, userId },
    select: { id: true },
  });
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }

  const rows = await prisma.runResult.findMany({
    where: {
      testCaseId,
      run: { projectId: project.id, userId },
    },
    orderBy: { run: { startedAt: 'desc' } },
    take,
    select: {
      id: true,
      runId: true,
      status: true,
      durationMs: true,
      run: { select: { id: true, sprintName: true, startedAt: true } },
    },
  });

  // Flatten + reverse so callers can render left-to-right oldest → newest.
  const compact = rows.map((r) => ({
    runId: r.runId,
    status: r.status,
    durationMs: r.durationMs,
    sprintName: r.run?.sprintName || null,
    startedAt: r.run?.startedAt || null,
  })).reverse();

  // Stats: pass rate, flaky score (status transitions / max possible), last failure.
  const total = compact.length;
  const passed = compact.filter((r) => r.status === 'pass').length;
  let transitions = 0;
  for (let i = 1; i < compact.length; i++) {
    if (compact[i].status !== compact[i - 1].status) transitions++;
  }
  // Flaky score: 0 means stable, 100 means alternating every run.
  const flakyScore = total > 1 ? Math.round((transitions / (total - 1)) * 100) : 0;
  const lastFailure = [...compact].reverse().find((r) => r.status === 'fail' || r.status === 'blocked');
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  return {
    history: compact,
    stats: {
      total,
      passed,
      passRate,
      flakyScore,
      lastFailureAt: lastFailure?.startedAt || null,
      lastFailureRunId: lastFailure?.runId || null,
    },
  };
}

module.exports = {
  startRun,
  listRuns,
  getRun,
  compareRuns,
  getTestCaseHistory,
  recomputeRunCounters,
};
