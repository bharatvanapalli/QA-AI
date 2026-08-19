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
const { buildCaseNumbering } = require('../lib/caseNumbering');
const { computeRunCounters } = require('../lib/runCounters');
const vault = require('../services/vault');
const audit = require('../services/audit');
const { generateSpecFile, cleanTestsDir } = require('../test-generator');
const { runPlaywright, getArtifacts, PLAYWRIGHT_DIR } = require('../playwright-worker');
const lintGates = require('./lintGates');
const { encodeArray, decodeArray, encodeJson, decodeJson } = require('./jsonField');
const integrations = require('./integrations');
const pomEmitter = require('./pomEmitter');
const readinessCompiler = require('./readinessCompiler');
const certificationKernel = require('./certificationKernel');
const scriptValidationRunner = require('./scriptValidationRunner');
const scriptBundleStore = require('./scriptBundleStore');
const executionJournal = require('./executionJournal');

function toArtifactUrl(absPath) {
  if (!absPath) return null;
  return (
    '/artifacts/' +
    path
      .relative(path.join(PLAYWRIGHT_DIR, 'test-results'), absPath)
      .replace(/\\/g, '/')
  );
}

const REPORT_ORDER_MAX = Number.MAX_SAFE_INTEGER;

function parseCaseLabelOrder(label) {
  const match = String(label || '').match(/\bS(\d+)\s*(?:[^\d]+)\s*C(\d+)\b/i);
  return {
    scenario: match ? Number(match[1]) : REPORT_ORDER_MAX,
    case: match ? Number(match[2]) : REPORT_ORDER_MAX,
  };
}

function dataRowOrderValue(result) {
  if (result?.dataRowIndex === null || result?.dataRowIndex === undefined || result?.dataRowIndex === '') {
    return -1;
  }
  const n = Number(result.dataRowIndex);
  return Number.isFinite(n) ? n : REPORT_ORDER_MAX;
}

function dateOrderValue(value) {
  const ms = new Date(value || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compareRunResultsForReport(a, b) {
  const ao = parseCaseLabelOrder(a?.caseLabel);
  const bo = parseCaseLabelOrder(b?.caseLabel);
  return (ao.scenario - bo.scenario)
    || (ao.case - bo.case)
    || (dataRowOrderValue(a) - dataRowOrderValue(b))
    || (dateOrderValue(a?.createdAt) - dateOrderValue(b?.createdAt))
    || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function parseObjectJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function recordedOutcomeIsMatched(outcome) {
  const raw = String(outcome?.effective || outcome?.outcome || outcome?.status || '').toLowerCase();
  return raw === 'matched' || raw === 'pass' || raw === 'passed';
}

function hasCompleteMatchedAssertionEvidence(assertionOutcomes, declaredAssertions) {
  const outcomes = Array.isArray(assertionOutcomes) ? assertionOutcomes.filter(Boolean) : [];
  if (!outcomes.length) return false;
  if (!outcomes.every(recordedOutcomeIsMatched)) return false;

  const declared = Array.isArray(declaredAssertions)
    ? declaredAssertions.filter((d) => d && d.id && d.parseFailed !== true)
    : [];
  if (!declared.length) return true;

  const matchedIds = new Set(
    outcomes
      .filter(recordedOutcomeIsMatched)
      .map((o) => o.assertionId || o.id)
      .filter(Boolean)
  );
  return declared.every((d) => matchedIds.has(d.id));
}

function shouldDisplayLegacyCloseoutAsPass(result, assertionOutcomes, declaredAssertions) {
  if (!result || result.status !== 'blocked') return false;
  if (!hasCompleteMatchedAssertionEvidence(assertionOutcomes, declaredAssertions)) return false;

  const text = [
    result.blockedReason,
    result.error,
    result.mechanicalVerdictReason,
    result.failureExplanation,
    result.blocked?.message,
  ].filter(Boolean).join(' ').toLowerCase();

  return text.includes('turn_ceiling')
    || text.includes('no_end_turn')
    || (text.includes('agent_loop') && text.includes('mechanical_v1'));
}

function exportGapCode(gap) {
  return certificationKernel.gapCode(gap);
}

function exportGapMessage(code, gap) {
  return certificationKernel.gapMessage(code, gap);
}

function buildExportPreflight(results = []) {
  const cases = Array.isArray(results) ? results : [];
  const blockedCases = [];
  const reasonCounts = {};
  let exportable = 0;

  for (const r of cases) {
    const meta = parseObjectJson(r.exportMeta);
    const replayEnvelope = parseObjectJson(r.replayIrJson);
    let held = null;

    if (meta && ['not_exportable', 'repairing', 'incomplete_evidence'].includes(String(meta.state || ''))) {
      const gaps = (Array.isArray(meta.gaps) ? meta.gaps : []).map((g) => certificationKernel.normalizeGap(g));
      const firstGap = gaps[0] || { type: meta.state };
      const code = exportGapCode(firstGap);
      held = {
        state: meta.state,
        reason: code,
        message: exportGapMessage(code, firstGap),
        gaps,
      };
    } else if (!r.replayIrJson) {
      const gap = certificationKernel.normalizeGap({ type: 'replayir_missing' });
      held = {
        state: 'not_exportable',
        reason: 'replayir_missing',
        message: gap.description,
        gaps: [gap],
      };
    } else if (!replayEnvelope) {
      const gap = certificationKernel.normalizeGap({ type: 'replayir_invalid' });
      held = {
        state: 'not_exportable',
        reason: 'replayir_invalid',
        message: gap.description,
        gaps: [gap],
      };
    } else if (replayEnvelope.complete === false) {
      const gaps = (Array.isArray(replayEnvelope.gaps) ? replayEnvelope.gaps : []).map((g) => certificationKernel.normalizeGap(g, { layer: 'replayir' }));
      const firstGap = gaps[0] || { code: 'replayir_incomplete' };
      const code = exportGapCode(firstGap);
      held = {
        state: 'not_exportable',
        reason: code,
        message: exportGapMessage(code, firstGap),
        gaps,
      };
    }

    if (held) {
      reasonCounts[held.reason] = (reasonCounts[held.reason] || 0) + 1;
      blockedCases.push({
        runResultId: r.id,
        testCaseId: r.testCaseId,
        caseName: r.testCase?.name || r.caseName || 'Untitled case',
        status: r.status,
        reason: held.reason,
        message: held.message,
        state: held.state,
        gaps: held.gaps,
      });
    } else {
      exportable++;
    }
  }

  return {
    total: cases.length,
    exportable,
    held: blockedCases.length,
    certified: cases.length > 0 && blockedCases.length === 0,
    reasonCounts,
    blockedCases,
  };
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
async function startRun({ userId, orgId, projectId, testCaseIds, sprintName, sprintId, generationId = null, send }) {
  const project = await prisma.project.findFirst({
    where: orgId ? { id: projectId, orgId } : { id: projectId, userId },
  });
  if (!project) {
    const err = new Error('Project not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  // Expand dependsOnIds transitively then topo-sort. Caller passes the
  // cases they want; we auto-include prerequisites so a "Rerun this case"
  // on a stateful flow (Login → Checkout) actually rebuilds prior state in
  // the fresh browser instead of failing cold. Rejected prerequisites are
  // a hard stop — the user explicitly opted out of that case.
  const { testCases, autoIncluded } = await expandDependenciesAndTopoSort({
    projectId,
    requestedIds: testCaseIds || [],
  });
  if (!testCases.length) {
    const err = new Error('No matching test cases');
    err.status = 400;
    err.code = 'NO_TEST_CASES';
    throw err;
  }

  const projectGenerationCount = await prisma.scenarioGeneration.count({ where: { projectId } }).catch(() => 0);
  if (projectGenerationCount > 0 && !generationId) {
    const err = new Error('generationId is required for execution so the selected revision cannot drift.');
    err.status = 400;
    err.code = 'GENERATION_ID_REQUIRED';
    throw err;
  }
  if (generationId) {
    const generation = await prisma.scenarioGeneration.findFirst({
      where: { id: generationId, projectId },
      select: { id: true },
    });
    const mismatched = testCases.filter((tc) => tc.generationId !== generationId);
    if (!generation || mismatched.length) {
      const err = new Error('One or more selected cases do not belong to the requested scenario generation.');
      err.status = 409;
      err.code = 'GENERATION_MISMATCH';
      throw err;
    }
  }

  // ── Promotion gate (closes the /api/runs bypass) ───────────────────────────
  // The main conductor path filters status:'approved', but this deterministic
  // engine did not — so a `blocked` or never-approved case could run here. The
  // CaseCompiler is the single promotion authority: a case that compiles to
  // `blocked` (unresolved/unmapped tokens, malformed must-assertions, broken
  // binding, placeholder URL) can NEVER run, anywhere; and a REQUESTED case that
  // isn't approved is refused. needs_review stays runnable (flagged, not broken).
  // Recomputed from the stored contract so it holds without a schema column.
  {
    const ids = testCases.map((t) => t.id);
    const gateRows = await prisma.testCase.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, status: true, automatability: true, module: true,
        assertions: true, steps: true, declaredAssertions: true, dataBindingJson: true,
        operationsJson: true, requirementRefs: true, storyId: true, qualityContractJson: true,
        dependsOnIds: true, producesData: true, requiresData: true,
        readinessStatus: true, readinessContractVersion: true, readinessComputedAt: true,
        sessionMode: true,
      },
    });
    const blockedCases = [];
    const notApproved = [];
    for (const tc of gateRows) {
      const readiness = readinessCompiler.compileCaseReadiness(tc);
      await prisma.testCase.update({ where: { id: tc.id }, data: readinessCompiler.readinessUpdateData(readiness) }).catch(() => null);
      if (readiness.runEligibility !== readinessCompiler.RUN_ELIGIBILITY.ALLOWED) {
        blockedCases.push(`"${tc.name}" (${readiness.readinessStatus}: ${readiness.readinessReasons.map((r) => r.code).join(', ') || 'not_ready'})`);
      }
      // EVERY case in the dependency closure must be approved (or mid-run) — not
      // only the directly-requested ones. An auto-included PENDING prerequisite
      // must not slip into the run unapproved (the closure bypass).
      if (tc.status !== 'approved' && tc.status !== 'running') {
        notApproved.push(`"${tc.name}" [${tc.status}]`);
      }
    }
    if (blockedCases.length) {
      console.warn(
        `[runs] Proceeding with ${blockedCases.length} approved not-run-ready case${blockedCases.length === 1 ? '' : 's'} by user choice: ${blockedCases.join(', ')}`,
      );
    }
    if (notApproved.length) {
      const err = new Error(
        `Cannot run unapproved case${notApproved.length === 1 ? '' : 's'}: ${notApproved.join(', ')}. Approve ${notApproved.length === 1 ? 'it' : 'them'} first.`,
      );
      err.code = 'CASE_NOT_APPROVED';
      err.status = 422;
      throw err;
    }
  }

  const integration = await integrations.get(userId, 'claude');
  const claudeKey = await vault.get(userId, 'claude.apiKey'); // may be null — fallback works
  const geminiKey = await vault.get(userId, 'gemini.apiKey'); // for Gemini projects
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
      config: encodeJson({ targetUrl, testCaseIds: testCaseIds || [], generationId: generationId || null }),
      ...(generationId ? { generationId } : {}),
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
      // Phase D — surface the prerequisite expansion so the user sees
      // exactly which cases the engine pulled in beyond their selection.
      if (autoIncluded.length) {
        const names = autoIncluded.map((tc) => `"${tc.name}"`).join(', ');
        send({
          type: 'log',
          message: `📎 Auto-included ${autoIncluded.length} prerequisite${autoIncluded.length === 1 ? '' : 's'} so prior state is rebuilt: ${names}`,
        });
      }

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
      const { enforcePrePersistEvidenceGate } = require('../lib/prePersistEvidenceGate');
      for (const [tcId, result] of Object.entries(report.results)) {
        const arts = getArtifacts(tcId);
        const screenshots = arts.screenshots.map(toArtifactUrl).filter(Boolean);
        const video = toArtifactUrl(arts.video);

        // UNIVERSAL no-fake-pass invariant: route this worker-reported status
        // through the SAME pre-persist gate the Conductor uses, so no RunResult
        // write can persist an un-evidenced pass. Playwright is a real assertion
        // runner — its `pass` means expect() ran — so it is runner-certified and
        // the gate passes it through unchanged; this still centralises the
        // invariant (and is what the static guard verifies).
        const __gated = enforcePrePersistEvidenceGate({ status: result.status, screenshots, runnerCertified: true });
        const __status = __gated.status;

        await prisma.runResult.create({
          data: {
            runId: run.id,
            testCaseId: tcId,
            status: __status,
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

        if (__status === 'pass')         passed++;
        else if (__status === 'fail')    failed++;
        else if (__status === 'skipped') skipped++;
        else                              blocked++;

        // Open a blocked item for failed assertions / missing locators.
        // Skip pure `skipped` results — those are engineer-chosen exclusions,
        // not blockers. Branch on the GATED __status, not the raw worker status,
        // so a downgraded pass (no-evidence) correctly opens a blocked item.
        if (__status !== 'pass' && __status !== 'skipped') {
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

        // For passed tests, emit POM-structured artifacts (Page Object + spec)
        // into playwright/pages/ + playwright/tests/. The Conductor's
        // MCP-derived locators are the trust surface — we no longer queue
        // a human-review GovernancePR row. Lint findings are surfaced as a
        // log line for visibility only (not gating). Gate on the GATED __status
        // so a downgraded pass never emits codegen from un-evidenced execution.
        if (__status === 'pass') {
          const tc = testCaseMap[tcId];
          if (tc) {
            const lint = lintGates.lint(tc.specCode || '');
            send({
              type: 'log',
              message: `  🔍 Lint: ${lint.errorCount} error · ${lint.warningCount} warning ${lint.lintPassed ? '✅' : '⚠️'}`,
            });
            try {
              // model defaults inside the provider abstraction when null —
              // typically Sonnet 4.6 for Claude, 2.5 Pro for Gemini.
              const pomProvider = project.aiProvider || 'claude';
              const pomApiKey = pomProvider === 'gemini' ? geminiKey : claudeKey;
              const emit = await pomEmitter.emitForCase({
                apiKey: pomApiKey,
                model: null,
                provider: pomProvider,
                project: { name: project.name, targetUrl },
                testCase: { id: tc.id, name: tc.name, module: tc.module, type: tc.type, assertions: tc.assertions, steps: tc.steps },
                scenario: tc.scenario || null,
                runId: run.id,
              });
              if (emit.written?.length) {
                for (const f of emit.written) {
                  send({ type: 'log', message: `  📂 Wrote ${f.path}` });
                }
              } else if (emit.skipped) {
                send({ type: 'log', message: `  ⚠️ POM emit skipped: ${emit.skipped}` });
              }
            } catch (err) {
              // POM emit failures must NOT fail the run — it's an artifact
              // produced after the test already passed. Log and continue.
              console.error('[runs] pomEmitter error', err);
              send({ type: 'log', message: `  ⚠️ POM emit failed: ${err.message}` });
            }
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
  })().catch((err) => {
    // Last-resort guard: a throw inside the catch block above (e.g. failRun
    // itself failing because the DB is unreachable) would otherwise become an
    // unhandled rejection and crash the process. Swallow + log — the run is
    // already lost at this point; keeping the server alive matters more.
    console.error('[runs] unhandled background rejection', err);
  });

  return { run, testCases };
}

/**
 * Walk TestCase.dependsOnIds transitively from the caller's selection and
 * topo-sort the union so prerequisites always run before their dependents.
 *
 * Behaviour:
 *  - Cases the caller listed AND every prerequisite reachable via
 *    dependsOnIds are returned in dependency order (Kahn's algorithm).
 *  - Prerequisites the caller didn't list are auto-included and exposed
 *    via the `autoIncluded` array so the run can announce them in the log.
 *  - Any prerequisite with status='rejected' is a hard refusal — the user
 *    explicitly opted out of that case, so silently auto-including it
 *    would betray their intent. Surface a clear error.
 *  - Cycles (A → B → A) are detected and rejected up-front with a useful
 *    list of cases involved, so an Architect mistake fails loudly instead
 *    of looping forever.
 *  - Unresolvable prerequisite IDs (deleted cases) fail closed before the
 *    browser run starts.
 *
 * Returns `{ testCases: TestCase[] in run order, autoIncluded: TestCase[] }`.
 */
async function expandDependenciesAndTopoSort({ projectId, requestedIds }) {
  const requested = Array.from(new Set((requestedIds || []).filter(Boolean)));
  if (!requested.length) return { testCases: [], autoIncluded: [] };

  // BFS over dependsOnIds, fetching each frontier in one query so a deep
  // chain doesn't pay one round-trip per hop.
  const byId = new Map();
  let frontier = requested;
  const seenQueries = new Set();
  while (frontier.length) {
    const toFetch = frontier.filter((id) => !byId.has(id) && !seenQueries.has(id));
    toFetch.forEach((id) => seenQueries.add(id));
    if (!toFetch.length) break;
    const rows = await prisma.testCase.findMany({
      where: { projectId, id: { in: toFetch } },
      select: {
        id: true, name: true, projectId: true, scenarioId: true,
        type: true, module: true, confidence: true, assertions: true,
        steps: true, specCode: true, status: true, userGuidance: true,
        dependsOnIds: true, generationId: true, createdAt: true, updatedAt: true,
        automatability: true, automatabilityReason: true,
        declaredAssertions: true, dataBindingJson: true, operationsJson: true,
        qualityContractJson: true, rowExecutionPlanJson: true,
        rowCoverageStatus: true, skippedRowsJson: true,
        sessionMode: true, failurePolicy: true, authProfile: true,
        requirementRefs: true, producesData: true, requiresData: true,
        producesStateJson: true, requiresStateJson: true,
        scenario: { select: { id: true, name: true } },
      },
    });
    const fetchedIds = new Set(rows.map((row) => row.id));
    const missingIds = toFetch.filter((id) => !fetchedIds.has(id));
    if (missingIds.length) {
      const err = new Error(`Required prerequisite case(s) could not be loaded: ${missingIds.join(', ')}.`);
      err.code = 'PREREQUISITE_MISSING';
      err.status = 409;
      err.missingIds = missingIds;
      throw err;
    }
    for (const r of rows) byId.set(r.id, r);
    // Next frontier = every dependsOnId we haven't fetched yet.
    const nextFrontier = new Set();
    for (const r of rows) {
      const deps = decodeJson(r.dependsOnIds, []) || [];
      for (const depId of deps) {
        if (!byId.has(depId) && !seenQueries.has(depId)) nextFrontier.add(depId);
      }
    }
    frontier = Array.from(nextFrontier);
  }

  // Now we have every case in the dependency closure. Refuse on rejected
  // prerequisites — but only for prerequisites the caller did NOT request
  // explicitly. If the caller explicitly listed a rejected case, that's
  // their choice and we'll honor it.
  for (const tc of byId.values()) {
    if (requested.includes(tc.id)) continue;
    if (tc.status === 'rejected') {
      const err = new Error(
        `Prerequisite "${tc.name}" is in rejected state. Approve it or remove the dependency, then retry.`,
      );
      err.code = 'PREREQUISITE_REJECTED';
      err.status = 400;
      throw err;
    }
  }
  // Refuse the run if ANY case in the closure (requested or auto-included)
  // was classified manual. Manual cases live on the Manual tab and are
  // executed by a human tester — driving Playwright against them would
  // produce a guaranteed false-fail. Surface every offender at once so the
  // user can clear them in a single pass.
  const manuals = Array.from(byId.values()).filter((tc) => tc.automatability === 'manual');
  if (manuals.length) {
    const lines = manuals.map((tc) => `"${tc.name}"${tc.automatabilityReason ? ` (${tc.automatabilityReason})` : ''}`);
    const err = new Error(
      `Cannot include manual case${manuals.length === 1 ? '' : 's'} in an automated run: ${lines.join(', ')}. ` +
      `Either complete ${manuals.length === 1 ? 'it' : 'them'} on the Manual tab, or override the classification on the case.`,
    );
    err.code = 'MANUAL_IN_RUN';
    err.status = 400;
    err.manualCases = manuals.map((tc) => ({ id: tc.id, name: tc.name, reason: tc.automatabilityReason }));
    throw err;
  }

  // Kahn's topo sort. Edges: dep → tc (prerequisite must precede dependent).
  const indeg = new Map();
  const adj = new Map();
  for (const id of byId.keys()) { indeg.set(id, 0); adj.set(id, []); }
  for (const tc of byId.values()) {
    const deps = decodeJson(tc.dependsOnIds, []) || [];
    for (const depId of deps) {
      if (!byId.has(depId)) {
        const err = new Error(`Required prerequisite case could not be loaded: ${depId}.`);
        err.code = 'PREREQUISITE_MISSING';
        err.status = 409;
        err.missingIds = [depId];
        throw err;
      }
      adj.get(depId).push(tc.id);
      indeg.set(tc.id, (indeg.get(tc.id) || 0) + 1);
    }
  }
  const queue = [];
  for (const [id, deg] of indeg.entries()) if (deg === 0) queue.push(id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id) || []) {
      const left = (indeg.get(next) || 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (order.length !== byId.size) {
    const unresolved = Array.from(byId.values())
      .filter((tc) => !order.includes(tc.id))
      .map((tc) => `"${tc.name}"`);
    const err = new Error(
      `Dependency cycle detected among cases: ${unresolved.join(', ')}. Break the cycle in the case editor before running.`,
    );
    err.code = 'DEPENDENCY_CYCLE';
    err.status = 400;
    throw err;
  }

  const testCases = order.map((id) => byId.get(id));
  const requestedSet = new Set(requested);
  const autoIncluded = testCases.filter((tc) => !requestedSet.has(tc.id));
  return { testCases, autoIncluded };
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

// P0-11 — canonical classifier lives in server/lib/errorClassify.js; both
// runs.js and conductor.js import it so BlockedItem.reason is consistent
// regardless of which code path wrote the row.
const { classifyError, extractLocator } = require('../lib/errorClassify');

function latestDate(...values) {
  let latest = null;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function runActivityFields(run) {
  const latestResultAt = Array.isArray(run?.results)
    ? run.results.reduce((latest, result) => latestDate(latest, result?.createdAt), null)
    : null;
  const lastActivityAt = latestDate(latestResultAt, run?.completedAt, run?.startedAt);
  return { latestResultAt, lastActivityAt };
}

// Phase E8 - orgId is the new tenancy gate. When supplied, lists runs
// across all org members for the given project (or all org projects when
// projectId is omitted). userId is kept as a backwards-compatible fallback
// for callers that haven't migrated to the org context yet.
async function listRuns(userId, projectId, limit = 50, sprintId = null, orgId = null, generationId = null) {
  const rows = await prisma.run.findMany({
    where: {
      ...(orgId
        ? { project: { orgId } }
        : { userId }),
      ...(projectId ? { projectId } : {}),
      ...(sprintId ? { sprintId } : {}),
      // Versioning — when a generation is selected, only show runs executed
      // against it (Run.generationId stamped at run-start).
      ...(generationId ? { generationId } : {}),
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
      needsHuman: true,
      startedAt: true,
      completedAt: true,
      results: {
        select: {
          createdAt: true,
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
      // needs_human is a SEPARATE signal column (no longer folded into failed),
      // but it still counts as "this run produced signal" for the empty filter.
      const empty = (r.passed || 0) === 0
                 && ((r.failed || 0) + (r.needsHuman || 0)) === 0
                 && (r.blocked || 0) === 0
                 && (r.skipped || 0) === 0;
      return !empty || r.status === 'running';
    })
    .map((r) => {
      const activity = runActivityFields(r);
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
        failed: r.failed,             // confirmed product failures ONLY
        needsHuman: r.needsHuman || 0, // "not judged" — surfaced separately, never folded into failed
        blocked: r.blocked,
        skipped: r.skipped,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        latestResultAt: activity.latestResultAt,
        lastActivityAt: activity.lastActivityAt,
        testCount: (r.results || []).length,
        scenarios: Array.from(seen.values()),
      };
    })
    .sort((a, b) => (b.lastActivityAt?.getTime?.() || 0) - (a.lastActivityAt?.getTime?.() || 0));
}

/**
 * Recompute Run.passed/failed/blocked/skipped from the actual RunResult
 * rows. Use this when a RunResult is added/deleted out of band (cleanup
 * scripts, manual db edits, future bulk operations) so the denormalised
 * counters never drift from the source of truth.
 *
 * Returns the fresh counter map so callers (e.g. the conductor's per-case
 * loop) can broadcast it over WS without a second round-trip.
 */
async function recomputeRunCounters(runId) {
  const grouped = await prisma.runResult.groupBy({
    by: ['status'],
    where: { runId },
    _count: { status: true },
  });
  const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count.status]));
  const counters = computeRunCounters(byStatus);
  await prisma.run.update({
    where: { id: runId },
    data: counters,
  });
  return counters;
}

/**
 * Restore approval state for any TestCases left at status='running' under a
 * given run. Used on cancel / failure so a half-executed suite doesn't leave
 * orphaned cases that the conductor's `where: { status: 'approved' }` filter
 * would skip on the next rerun. CRIT-6: 'running' is a permitted transient
 * sub-state of 'approved' — we just snap it back to the stable value.
 *
 * Scope is intentionally tied to a runId via RunResult join: we only touch
 * cases the conductor itself put into the running state for THIS run, not
 * unrelated running cases from a different operator's concurrent run.
 */
async function resetRunningApprovals(runId) {
  // Find TestCases that belong to scenarios in this run's project AND are
  // currently 'running'. We use a project-scoped reset rather than a per-TC
  // join because the running state was set per-case at runOneCase entry, not
  // recorded against the run. Project scoping is the closest safe boundary.
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { projectId: true },
  });
  if (!run) return { reset: 0 };
  const updated = await prisma.testCase.updateMany({
    where: { scenario: { projectId: run.projectId }, status: 'running' },
    data: { status: 'approved' },
  });
  return { reset: updated.count };
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
              steps: true,
              userGuidance: true, dependsOnIds: true,
              // Reports "Verdict & Evidence" tab — the structured declared
              // assertions (type, criticality, provenance, note) so the UI can
              // correlate each declared assertion with its recorded outcome.
              declaredAssertions: true,
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

  // Stable hierarchical case labels (S2 · C5) — built from this run's scenario
  // generation so Reports shows the SAME number as Test Cases and Blocked.
  // Best-effort: a label is a nicety and must never break getRun.
  let caseLabelByTc = new Map();
  try {
    const genScenarios = await prisma.testScenario.findMany({
      where: run.generationId
        ? { projectId: run.projectId, generationId: run.generationId }
        : { projectId: run.projectId },
      select: { id: true, generationId: true, priority: true, createdAt: true, cases: { select: { id: true, createdAt: true } } },
    });
    caseLabelByTc = buildCaseNumbering(genScenarios).caseLabelById;
  } catch (_) { /* leave labels empty on any failure */ }

  run.results = run.results.map((r) => {
    const assertionCheckResults = decodeJson(r.assertionCheckResults, []);
    const stepResults = decodeJson(r.stepResults, []);
    const journalSummary = Array.isArray(stepResults) && stepResults.length > 0
      ? executionJournal.projectExecutionJournal(stepResults)
      : null;
    const testCase = r.testCase
      ? {
          ...r.testCase,
          steps: decodeJson(r.testCase.steps, []),
          declaredAssertions: decodeJson(r.testCase.declaredAssertions, []),
        }
      : r.testCase;
    const blocked = blockedByTc.get(r.testCaseId) || null;
    const legacyCloseoutPass = shouldDisplayLegacyCloseoutAsPass(
      { ...r, blocked },
      assertionCheckResults,
      testCase?.declaredAssertions
    );

    return {
      ...r,
      status: legacyCloseoutPass ? 'pass' : r.status,
      blockedReason: legacyCloseoutPass ? null : r.blockedReason,
      error: legacyCloseoutPass ? null : r.error,
      mechanicalVerdictReason: legacyCloseoutPass ? null : r.mechanicalVerdictReason,
      failureExplanation: legacyCloseoutPass ? null : (r.error || null),
      statusCorrection: legacyCloseoutPass
        ? {
            reason: 'legacy_closeout_after_complete_assertion_evidence',
            originalStatus: r.status,
            originalBlockedReason: r.blockedReason,
            originalError: r.error,
          }
        : null,
      caseLabel: caseLabelByTc.get(r.testCaseId) || null,
      screenshots: decodeArray(r.screenshots),
      networkLog: decodeJson(r.networkLog, []),
      domSnapshots: decodeJson(r.domSnapshots, []),
      chatHistory: decodeJson(r.chatHistory, []),
      stepResults,
      // The execution journal is the single authority for report counters.
      // Older rows without a journal deliberately return null so the client can
      // use its legacy compatibility projection without inventing passed steps.
      journalSummary,
    // Phase E4 — visualDiffs is a JSON string on disk; decode for clients.
      visualDiffs: decodeJson(r.visualDiffs, []),
    // Reports "Verdict & Evidence" tab — decode the V2 assertion outcomes
    // ({ assertionId, outcome, reason, source, evidence }) and the case's
    // declared assertions so the UI can correlate declared → outcome without
    // re-parsing JSON strings client-side.
      assertionCheckResults,
    // Enterprise Mode P5 — failed_prereq EVIDENCE INHERITANCE. blockedByTestCaseId /
    // blockedByRunResultId / blockedByReason flow through verbatim via `...r`
    // (include returns all scalars); decode the dependencyPath chain so Reports can
    // render "blocked by <prereq> (failed) → root cause" without re-parsing. This is
    // the AUTHORITATIVE causal claim for conductor-gated cases — the derived
    // prereqFailures block below stays as a fallback for non-gated blocked/failed.
      dependencyPath: decodeJson(r.dependencyPath, []),
      testCase,
      blocked: legacyCloseoutPass ? null : blocked,
    };
  });
  run.passed = run.results.filter((r) => r.status === 'pass').length;
  run.failed = run.results.filter((r) => r.status === 'fail').length;
  run.blocked = run.results.filter((r) => r.status === 'blocked').length;
  run.skipped = run.results.filter((r) => r.status === 'skipped').length;
  Object.assign(run, runActivityFields(run));
  run.results.sort(compareRunResultsForReport);
  run.exportPreflight = buildExportPreflight(run.results);
  try {
    const scriptValidation = scriptValidationRunner.readLatestValidationReport({
      projectId: run.projectId,
      bundleId: run.id,
    });
    if (scriptValidation) {
      const scriptBundle = scriptBundleStore.readBundle({
        projectId: run.projectId,
        bundleId: run.id,
        framework: scriptValidation.framework || 'playwright-reference',
      });
      if (scriptBundle?.journal?.repairs?.length) {
        scriptValidation.repairJournal = scriptBundle.journal;
      }
      run.scriptValidation = scriptValidation;
    } else {
      run.scriptValidation = null;
    }
  } catch (_) {
    run.scriptValidation = null;
  }

  // Dependency context: for each blocked/failed case, surface which of its
  // prerequisite cases did NOT pass in THIS run, so the UI can say
  // "blocked because prerequisite '<name>' failed — run it first". Derived
  // from real results (faithful), not a stored causal claim. Prerequisites
  // are normally present because startRun auto-includes them via topo-sort.
  const statusByTc = new Map(run.results.map((r) => [r.testCaseId, r.status]));
  const nameByTc = new Map(run.results.map((r) => [r.testCaseId, r.testCase?.name || null]));
  for (const r of run.results) {
    if (r.status !== 'blocked' && r.status !== 'fail') { r.prereqFailures = []; continue; }
    const deps = decodeJson(r.testCase?.dependsOnIds, []) || [];
    r.prereqFailures = deps
      .filter((id) => { const s = statusByTc.get(id); return s && s !== 'pass'; })
      .map((id) => ({ id, name: nameByTc.get(id) || null, status: statusByTc.get(id) }));
  }
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
      select: { id: true, sprintName: true, status: true, passed: true, failed: true, needsHuman: true, blocked: true, skipped: true, startedAt: true, completedAt: true },
    }),
    prisma.run.findFirst({
      where: { id: runIdB, ...gate },
      select: { id: true, sprintName: true, status: true, passed: true, failed: true, needsHuman: true, blocked: true, skipped: true, startedAt: true, completedAt: true },
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

  // P0-2: org-scoped callers must NOT filter by userId — co-org teammates
  // legitimately query each other's runs. Direct violation of E8 invariant:
  // "Project queries filter by orgId, NOT by userId — sharing a project
  // across an org breaks otherwise." Project authorisation above already
  // gated on orgId; the inner run query just scopes to this project.
  const rows = await prisma.runResult.findMany({
    where: {
      testCaseId,
      run: orgId ? { project: { orgId } } : { projectId: project.id, userId },
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

/**
 * User-initiated deletion of a Run. Used by the Reports run-chip strip
 * when an operator wants to clean up stray or noisy runs.
 *
 * Org-scoped: the run must belong to a project in the caller's org.
 * `RunResult` rows cascade via the FK definition in schema.prisma.
 * BlockedItem.runId and GovernancePR.runId are soft references (no FK)
 * and are intentionally left untouched — they keep historical context.
 *
 * Returns `{ deleted: true }` on success, `{ deleted: false, code }` if
 * the run wasn't found or is outside the caller's org.
 */
async function deleteRun(userId, runId, orgId = null) {
  // First confirm visibility under the same org-scope rules as getRun
  // so we don't leak "this id exists in another org".
  const run = await prisma.run.findFirst({
    where: orgId ? { id: runId, project: { orgId } } : { id: runId, userId },
    select: { id: true, status: true },
  });
  if (!run) return { deleted: false, code: 'NOT_FOUND' };
  // Block deleting an in-flight run — the conductor still has open
  // handles to the row, and partial RunResults will land mid-tx. Force
  // the operator to cancel first.
  if (run.status === 'running') {
    return { deleted: false, code: 'RUN_IN_PROGRESS' };
  }
  await prisma.run.delete({ where: { id: runId } });
  return { deleted: true };
}

module.exports = {
  startRun,
  listRuns,
  getRun,
  compareRuns,
  getTestCaseHistory,
  recomputeRunCounters,
  resetRunningApprovals,
  deleteRun,
  buildExportPreflight,
};
