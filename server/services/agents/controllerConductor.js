'use strict';

const path = require('path');
const prisma = require('../../prisma');
const mcp = require('../mcp');
const sessionRegistry = require('../sessionRegistry');
const { encodeJson, decodeJson } = require('../jsonField');
const { recomputeRunCounters } = require('../runs');
const {
  compileOperationContractV2,
} = require('../operationContractV2');
const {
  createBrowserTransactionRuntime,
} = require('../browserTransactionRuntime');
const {
  createControllerActionExecutionGateway,
} = require('../controllerActionExecutionGateway');
const {
  createTypedAdapterPlan,
} = require('../controllerTypedAdapterRegistry');
const {
  createControllerCompositeExecutor,
} = require('../controllerCompositeExecutor');
const {
  createControllerRecoveryCoordinator,
} = require('../controllerRecoveryCoordinator');
const {
  createControllerMcpRuntimeAdapter,
} = require('../controllerMcpRuntimeAdapter');
const {
  createFileBrowserTransactionEventJournal,
} = require('../browserTransactionEventJournal');
const {
  CASE_VERDICT,
  createFileVerdictRepository,
} = require('../controllerVerdictProjector');

const CONTROLLER_CONDUCTOR_VERSION = 'qaai-controller-conductor-v1';

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function allCases(scenarios) {
  return (Array.isArray(scenarios) ? scenarios : [])
    .flatMap((scenario) => (
      Array.isArray(scenario?.cases)
        ? scenario.cases.map((testCase) => ({ scenario, testCase }))
        : []
    ));
}

function dependencyIds(testCase) {
  const decoded = decodeJson(testCase?.dependsOnIds, null)
    || decodeJson(testCase?.dependsOn, null)
    || [];
  return Array.isArray(decoded) ? decoded.filter(Boolean) : [];
}

// A case's browser session is only worth keeping alive post-run if some
// OTHER case in this same run actually declares it as a dependency (the
// authenticated-session-reuse path, via sessionRegistry.leaseContinuation).
// Without this check — and without an explicit stop otherwise — every
// independent case that merely finishes cleanly parks its session alive
// with no teardown until the run's very end `finally` block, so two wholly
// unrelated cases (e.g. "Edit Fields" and "Click Actions", neither
// depending on the other) end up with TWO live browser sessions running
// concurrently for the run's remaining duration, and their live-transcript
// events interleave in the UI (reproduced live repeatedly: TC-1's session
// kept running while TC-2's fresh session was already executing).
function hasFutureDependent(testCaseId, cases) {
  const id = String(testCaseId);
  return cases.some(({ testCase: other }) => (
    String(other.id) !== id
      && dependencyIds(other).map(String).includes(id)
  ));
}

function rootCaseId(testCaseId, casesById, seen = new Set()) {
  if (seen.has(testCaseId)) return testCaseId;
  seen.add(testCaseId);
  const testCase = casesById.get(testCaseId);
  const dependencies = dependencyIds(testCase);
  return dependencies.length
    ? rootCaseId(String(dependencies[0]), casesById, seen)
    : testCaseId;
}

// Confirmed live on LetCode's Dialog Flow test case (2026-08-12): a native
// alert()/confirm()/prompt() dialog gets resolved by a competing party (not
// us) within under a second of opening — reproduced directly via
// diagnostic logging showing "No dialog is showing" on our OWN explicit
// accept()/dismiss() call, every time, regardless of how many intervening
// steps separate the triggering Click from that explicit step. Holding a
// dialog open for a LATER step to resolve is fundamentally unreliable here.
// The fix: since the compiled operation list already declares every
// AcceptAlert/DismissAlert/TypeAlert intent up front, build one ordered
// queue of resolutions per test case and let the dialog-open handler
// (mcp.js#setupDialogListener) resolve synchronously, in the same tick the
// dialog opens — no round trip, no race. Generic by construction: it reads
// only the canonical AcceptAlert/DismissAlert/TypeAlert operation types
// already used platform-wide, not any site-specific text/selector.
function buildDialogResolutionQueue(operations) {
  const queue = [];
  if (!Array.isArray(operations)) return queue;
  for (const op of operations) {
    const type = op?.type;
    if (type === 'TypeAlert') {
      const promptVal = op.value ?? op.targetIdentity?.value ?? null;
      queue.push({
        action: 'accept',
        promptText: promptVal != null ? String(promptVal) : null,
        sourceOperationId: op.operationId || null,
      });
    } else if (type === 'AcceptAlert') {
      queue.push({ action: 'accept', promptText: null, sourceOperationId: op.operationId || null });
    } else if (type === 'DismissAlert') {
      queue.push({ action: 'dismiss', promptText: null, sourceOperationId: op.operationId || null });
    }
  }
  return queue;
}

function databaseStatus(verdict) {
  if (verdict === CASE_VERDICT.PASS) return 'pass';
  if (verdict === CASE_VERDICT.FAIL || verdict === CASE_VERDICT.EXECUTION_ERROR) return 'fail';
  if (verdict === CASE_VERDICT.CANCELLED) return 'skipped';
  if (verdict === CASE_VERDICT.MANUAL_BOUNDARY) return 'needs_human';
  return 'fail';
}

function stepStatus(terminalState) {
  if (terminalState === 'COMMITTED') return 'pass';
  if (terminalState === 'ASSERTION_FAILED'
    || terminalState === 'PRODUCT_FAILURE'
    || terminalState === 'EXECUTION_ERROR') return 'fail';
  if (terminalState === 'CANCELLED') return 'skipped';
  if (terminalState === 'MANUAL_BOUNDARY') return 'needs_human';
  return 'fail';
}

// Phase 29.2 — a slow-but-working real site exhausting a hardcoded deadline is
// a false termination, not a real failure. QAAI_OPERATION_TIMING_MULTIPLIER
// scales every deadline/attempt budget below uniformly (default 1 = unchanged
// behavior). A per-project column is the eventual right home for this (see
// Project's Phase E10.5 context* columns for the established pattern), but a
// global env multiplier needs no migration and covers the real failure mode:
// termination must only ever be reached through genuine exhaustion, never a
// budget mismatched to a real site's actual speed.
function timingMultiplier() {
  const raw = Number(process.env.QAAI_OPERATION_TIMING_MULTIPLIER);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function scaledMs(ms) {
  return Math.round(ms * timingMultiplier());
}

function scaledAttempts(count) {
  return Math.max(1, Math.round(count * timingMultiplier()));
}

function deadlineForOperation(operation) {
  switch (operation.type) {
    case 'Navigate':
      return scaledMs(20_000);
    case 'Date':
    case 'DateTime':
      return scaledMs(20_000);
    case 'Select':
    case 'Time':
      return scaledMs(12_000);
    case 'Click':
    case 'Submit':
      // There's no way to know in advance whether a given click triggers a
      // full page load (e.g. clicking a nav link), so give every click the
      // same generous budget Navigate itself gets — a click's own MCP round
      // trip alone can eat several seconds, and a page_ready-flagged-only
      // 10s budget starves post-click snapshot/reconciliation on any real
      // page (reproduced live: LetCode's "Goto Home" link click used 3.4s
      // just for the browser_click round trip, leaving too little of the
      // 10s default for the destination page to load and verify).
      return scaledMs(30_000);
    case 'WaitForState':
      return scaledMs(20_000);
    case 'Fill':
    case 'Type':
    case 'Clear':
    case 'PressKey':
    case 'Hover':
    case 'Focus':
      return scaledMs(20_000);
    default:
      return scaledMs(15_000);
  }
}

function observationAttemptsForOperation(operation) {
  if (operation.type === 'WaitForState') return scaledAttempts(18);
  if (['Click', 'Submit'].includes(operation.type)) return scaledAttempts(10);
  return scaledAttempts(6);
}

function resolutionAttemptsForOperation(operation) {
  if (operation.type === 'WaitForState') return scaledAttempts(2);
  if (operation.type === 'Fill') return scaledAttempts(6);
  if (['Date', 'DateTime', 'Select', 'Time'].includes(operation.type)) return scaledAttempts(4);
  return scaledAttempts(3);
}

function valueResolver(valueRef) {
  const ref = clean(valueRef);
  if (!ref) return undefined;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)];
  return undefined;
}

function verdictError(outcome, contract) {
  if (outcome?.paused) return 'Execution paused at an explicit manual boundary.';
  const failedOps = (Array.isArray(outcome?.operationResults) ? outcome.operationResults : [])
    .map((res) => ({
      result: res,
      decision: res.terminalDecision,
      op: contract?.operations?.find((o) => o.operationId === res.operationId) || null,
    }))
    .filter(({ decision }) => decision && decision.state !== 'COMMITTED');

  if (!failedOps.length) return null;

  const summaries = failedOps.map(({ decision, op }, i) => {
    const stepNum = op ? (contract.operations.indexOf(op) + 1) : (i + 1);
    const action = op?.type || 'Action';
    const target = clean(
      op?.targetIdentity?.accessibleName
        || op?.targetIdentity?.label
        || op?.target
        || (op?.type === 'Navigate' ? (op?.value || op?.plannedText || op?.destination || op?.valueRef) : ''),
    ) || '';
    const rawReason = String(decision?.reason || decision?.state || '');

    let humanReason = rawReason;
    if (rawReason.includes('exact_proof_unavailable') || rawReason.includes('all_exact_alternatives_mismatched')) {
      if (action === 'Navigate') {
        humanReason = `Navigation to "${target}" could not be confirmed — the destination page did not load or URL did not match.`;
      } else if (action === 'Click') {
        humanReason = `Could not locate or click "${target}" on the page.`;
      } else if (action === 'Type' || action === 'Fill') {
        humanReason = `Could not find input field "${target}" to enter text.`;
      } else if (action.startsWith('Assert')) {
        humanReason = `Assertion on "${target}" did not match expected value.`;
      } else {
        humanReason = `Action "${action}" on "${target}" could not be verified on the page.`;
      }
    } else if (rawReason.includes('timeout') || rawReason.includes('DEADLINE')) {
      humanReason = `Operation timed out waiting for "${target}" to respond.`;
    } else if (rawReason.includes('element_not_found') || rawReason.includes('unresolved')) {
      humanReason = `Element "${target}" was not found on the page.`;
    }

    return `Step ${stepNum} (${action}${target ? ` "${target}"` : ''}): ${humanReason}`;
  });

  return summaries.join('\n');
}

function outcomeAllowsContinuation(outcome) {
  const decisions = (Array.isArray(outcome?.operationResults) ? outcome.operationResults : [])
    .map((result) => result?.terminalDecision)
    .filter(Boolean);
  const records = Array.isArray(outcome?.schedulerSnapshot?.records)
    ? outcome.schedulerSnapshot.records
    : [];
  if (!decisions.length
    || outcome?.paused === true
    || outcome?.schedulerSnapshot?.paused === true
    || outcome?.schedulerSnapshot?.cancelled === true) return false;
  if (records.some((record) => record.scheduleState === 'SKIPPED_DEPENDENCY')) return false;
  return decisions.every((decision) => (
    decision.state !== 'MANUAL_BOUNDARY'
      && decision.state !== 'CANCELLED'
      && !decision.continuation?.terminationReason
  ));
}

function operationRows(contract, outcome, recoveryEvents = [], verifiedLocators = new Map()) {
  const decisions = new Map(
    outcome.operationResults.map((result) => [result.operationId, result.terminalDecision]),
  );
  const scheduler = new Map(
    outcome.schedulerSnapshot.records.map((record) => [record.operationId, record]),
  );
  const recoveryByOperation = new Map();
  for (const event of (Array.isArray(recoveryEvents) ? recoveryEvents : [])) {
    if (!event.operationId) continue;
    if (!recoveryByOperation.has(event.operationId)) recoveryByOperation.set(event.operationId, []);
    recoveryByOperation.get(event.operationId).push(event);
  }
  return contract.operations.map((operation, index) => {
    const decision = decisions.get(operation.operationId);
    const schedule = scheduler.get(operation.operationId);
    const terminalState = decision?.state || (
      schedule?.scheduleState === 'SKIPPED_DEPENDENCY' ? 'SKIPPED_DEPENDENCY' : null
    );
    const recoveryTrail = recoveryByOperation.get(operation.operationId) || [];
    const target = clean(
      operation?.targetIdentity?.accessibleName
        || operation?.targetIdentity?.label
        || operation?.target
        || (operation?.type === 'Navigate' ? (operation?.value || operation?.plannedText || operation?.destination || operation?.valueRef) : ''),
    ) || null;
    const plannedValue = operation?.selection?.value
      ?? operation?.selection?.text
      ?? operation?.selection?.label
      ?? operation?.value
      ?? null;
    const reason = decision?.reason || schedule?.skipReason || null;
    return {
      index: index + 1,
      operationId: operation.operationId,
      authoredStepId: operation.authoredStepId,
      assertionId: operation.assertionId,
      kind: operation.kind,
      action: operation.type,
      target,
      controlTarget: target,
      plannedText: plannedValue == null ? null : String(plannedValue),
      operationCheck: operation.operationCheck || null,
      status: terminalState === 'SKIPPED_DEPENDENCY' ? 'skipped' : stepStatus(terminalState),
      terminalState,
      reason,
      executionError: terminalState === 'EXECUTION_ERROR' ? reason : null,
      attribution: decision?.attribution || null,
      commitDisposition: decision?.commitDisposition || null,
      // Phase 29.3 — empty for the common case (no self-correction needed).
      // When non-empty it is the real, ordered sequence of what the controller
      // tried before committing (or before exhausting) this operation — the
      // "proper reasoning" a blocked/needs_human step needs in Reports.
      recoveryTrail: recoveryTrail.length ? recoveryTrail : null,
      // Phase 30.0 — null unless independently re-verified via a real,
      // authoritative browser_evaluate capture against the exact acted-upon
      // element. Never a guess: absence means Output Files must show this
      // step's locator as unverified, not invent one.
      verifiedLocator: verifiedLocators.get(operation.operationId) || null,
      actionTransaction: {
        actionOccurrenceId: operation.actionOccurrenceId,
        canonicalOutcome: terminalState,
        reason,
        attribution: decision?.attribution || null,
        commitDisposition: decision?.commitDisposition || null,
        proofRefs: decision?.proofRefs || [],
      },
    };
  });
}

// Phase 30.1/30.2 — passive, post-case-only projection. Called strictly after
// runtime.runCase() has already resolved a verdict; it only reshapes data the
// case has already produced (contract, steps, assertions, independently
// re-verified locators) into a durable evidence envelope. It cannot affect
// verdict, retry, or continuation, and it never touches the browser.
//
// NOTE on scope: this is a NEW, explicitly-versioned envelope
// ('qaai-controller-replay-v1'), not the legacy ReplayIR schema that
// server/services/codegen/_replayContract.js validates and
// server/services/codegen/replayExport.js compiles into a downloadable
// package today. That legacy schema was built for the old conductor's
// browser_click-style actionTrail (auth/credential/table/download gap
// taxonomy, dataRow binding) and bridging this envelope into it is a
// separate, larger effort — tracked, not silently assumed done here.
// What this DOES give Output Files today: the first time replayIrJson is
// populated at all from a live controller run, with real per-operation
// target identity and (when independently verified) real Playwright locator
// expressions — not guesses, not empty.
function projectControllerReplayIr(contract, outcome, steps, assertions) {
  return {
    schemaVersion: 'qaai-controller-replay-v1',
    runtimeVersion: CONTROLLER_CONDUCTOR_VERSION,
    complete: !outcome.paused && outcome.verdict?.verdict === CASE_VERDICT.PASS,
    generatedAt: new Date().toISOString(),
    operations: steps.map((step) => ({
      operationId: step.operationId,
      authoredStepId: step.authoredStepId,
      kind: step.kind,
      action: step.action,
      status: step.status,
      target: step.target,
      plannedText: step.plannedText,
      actionOccurrenceId: step.actionTransaction?.actionOccurrenceId || null,
      locatorStatus: step.verifiedLocator?.verified === true ? 'verified' : 'unverified',
      verifiedLocator: step.verifiedLocator ? {
        verified: step.verifiedLocator.verified === true,
        diagnosticOnly: step.verifiedLocator.diagnosticOnly !== false,
        expression: step.verifiedLocator.expression || null,
        strategy: step.verifiedLocator.strategy || null,
        frameworkExpressions: step.verifiedLocator.frameworkExpressions || null,
        context: step.verifiedLocator.context || null,
        proof: step.verifiedLocator.proof || null,
      } : null,
      recoveryTrail: step.recoveryTrail || null,
    })),
    assertions: assertions.map((assertion) => ({ ...assertion })),
  };
}

function assertionRows(contract, outcome) {
  const decisions = new Map(
    outcome.operationResults.map((result) => [result.operationId, result.terminalDecision]),
  );
  return contract.assertions.map((assertion) => {
    const decision = decisions.get(assertion.operationId);
    return {
      assertionId: assertion.assertionId,
      operationId: assertion.operationId,
      outcome: decision?.state === 'COMMITTED'
        ? 'matched'
        : decision?.state === 'ASSERTION_FAILED'
          ? 'not_matched'
          : 'uncheckable',
      reason: decision?.reason || 'assertion_not_executed',
      source: 'browser_transaction_controller',
      factRefs: decision?.proofRefs || [],
    };
  });
}

async function createOrResumeRun({
  userId,
  projectId,
  sprintId,
  targetUrl,
  framework,
  generationId,
  existingRunId,
  resumeMode,
  cases,
}) {
  if (existingRunId) {
    const existing = await prisma.run.findUnique({ where: { id: existingRunId } });
    if (!existing) throw new Error(`Controller Conductor run ${existingRunId} was not found.`);
    if (generationId && existing.generationId && generationId !== existing.generationId) {
      const error = new Error('Selected execution generation does not match the existing run.');
      error.code = 'GENERATION_MISMATCH';
      throw error;
    }
    const caseIds = cases.map(({ testCase }) => testCase.id).filter(Boolean);
    if (!resumeMode && caseIds.length) {
      await prisma.runResult.deleteMany({
        where: { runId: existingRunId, testCaseId: { in: caseIds } },
      });
    }
    await prisma.run.update({
      where: { id: existingRunId },
      data: { status: 'running', completedAt: null },
    });
    return existing;
  }
  return prisma.run.create({
    data: {
      userId,
      projectId,
      sprintId: sprintId || null,
      sprintName: `Controller run - ${new Date().toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}`,
      status: 'running',
      verdictMode: 'mechanical_v1',
      verifierMode: 'deterministic',
      generationId: generationId || null,
      config: encodeJson({
        runtimeVersion: CONTROLLER_CONDUCTOR_VERSION,
        targetUrl,
        framework,
        authority: 'BrowserTransactionController',
      }),
    },
  });
}

async function run({
  userId,
  projectId,
  sprintId = null,
  scenarios = [],
  framework = 'playwright-pom',
  targetUrl = null,
  send = () => {},
  cancelToken = null,
  projectConfig = null,
  existingRunId = null,
  resumeMode = false,
  generationId = null,
} = {}) {
  if (!userId || !projectId) throw new TypeError('Controller Conductor requires userId and projectId.');
  const cases = allCases(scenarios);
  if (!cases.length) throw new Error('Controller Conductor received no approved cases.');
  const generationIds = [...new Set(
    cases.map(({ testCase }) => clean(testCase.generationId)).filter(Boolean),
  )];
  if (generationIds.length > 1) {
    const error = new Error('Controller Conductor refuses mixed scenario generations.');
    error.code = 'GENERATION_MIXED_EXECUTION';
    throw error;
  }
  const executionGenerationId = generationId || generationIds[0] || null;
  const runRow = await createOrResumeRun({
    userId,
    projectId,
    sprintId,
    targetUrl,
    framework,
    generationId: executionGenerationId,
    existingRunId,
    resumeMode,
    cases,
  });
  send({ type: 'run.started', runId: runRow.id, testCount: cases.length });

  if (!resumeMode) {
    await sessionRegistry.closeForUser(userId).catch(() => {});
  }

  // Phase E1/E10: Pre-fetch project's known locators to inject into the mechanical
  // execution engine context so the healer has ground truth for fallback resolution.
  const knownLocatorsList = await prisma.knowledgeBaseLocator.findMany({
    where: { projectId, healthScore: { gte: 30 } },
    orderBy: [
      { healthScore: 'desc' },
      { occurrences: 'desc' },
    ],
    take: 50,
  });
  // Map them by target element name (lowercased/trimmed) so adapter can easily cross-reference
  const knownLocators = new Map();
  for (const loc of knownLocatorsList) {
    const key = String(loc.element || '').trim().toLowerCase();
    if (key && !knownLocators.has(key)) {
      knownLocators.set(key, loc);
    }
  }

  const journalRoot = path.resolve(process.cwd(), 'playwright', 'controller-journal', runRow.id);
  const journal = createFileBrowserTransactionEventJournal({
    rootDir: journalRoot,
    journalId: runRow.id,
  });
  const verdictRepository = createFileVerdictRepository({
    rootDir: path.join(journalRoot, 'verdicts'),
  });
  const casesById = new Map(cases.map(({ testCase }) => [testCase.id, testCase]));
  const caseOutcomes = new Map();
  const activeSessions = new Set();
  const history = [];
  let paused = false;

  try {
    for (const { scenario, testCase } of cases) {
      if (cancelToken?.cancelled || cancelToken?.signal?.aborted) break;
      const dependencies = dependencyIds(testCase).map(String);
      const unavailableDependency = dependencies.find((id) => {
        const prior = caseOutcomes.get(id);
        return prior && prior.continuationSafe !== true;
      });
      if (unavailableDependency) {
        const error = `Explicit dependency ${unavailableDependency} did not produce a safe continuation state.`;
        await prisma.runResult.create({
          data: {
            runId: runRow.id,
            testCaseId: testCase.id,
            status: 'skipped',
            error,
            blockedReason: null,
            stepResults: encodeJson([]),
            verdictVersion: 'controller_v1',
            verdictMode: 'mechanical_v1',
            mechanicalVerdictReason: 'explicit_dependency_unavailable',
          },
        });
        const skipped = { verdict: CASE_VERDICT.EXECUTION_ERROR, status: 'skipped', error };
        caseOutcomes.set(testCase.id, skipped);
        history.push({ testCaseId: testCase.id, ...skipped });
        continue;
      }

      const continuityGroupId = rootCaseId(testCase.id, casesById);
      let browserSession = null;
      let casePaused = false;
      try {
      if (dependencies.length) {
        const lease = sessionRegistry.leaseContinuation({
          userId,
          projectId,
          runId: runRow.id,
          caseId: testCase.id,
          dependsOnCaseIds: dependencies,
          continuityGroupId,
        });
        browserSession = lease.session;
        if (!browserSession) {
          const error = `Authenticated dependency session unavailable: ${lease.reason}`;
          await prisma.runResult.create({
            data: {
              runId: runRow.id,
              testCaseId: testCase.id,
              status: 'fail',
              error,
              blockedReason: null,
              stepResults: encodeJson([]),
              verdictVersion: 'controller_v1',
              verdictMode: 'mechanical_v1',
              mechanicalVerdictReason: 'controller_session_continuity_unavailable',
            },
          });
          const failed = { verdict: CASE_VERDICT.EXECUTION_ERROR, status: 'fail', error };
          caseOutcomes.set(testCase.id, failed);
          history.push({ testCaseId: testCase.id, ...failed });
          continue;
        }
        send({
          type: 'agent.phase.log',
          phase: 'conductor',
          level: 'info',
          message: `Controller reused the exact authenticated browser context for "${testCase.name}".`,
        });
      } else {
        const initialTargetUrl = targetUrl || projectConfig?.targetUrl || process.env.QAAI_TARGET_URL || null;
        browserSession = await mcp.startMcpSession({
          userId,
          targetUrl: initialTargetUrl,
          broadcast: send,
          project: projectConfig || {},
          authorityMode: 'browser_transaction_controller',
        });
        activeSessions.add(browserSession);
      }
      
      // Update the broadcast function on the session so that CDP frames
      // and logs are routed to the new test case, even if the session was leased.
      browserSession.broadcast = send;

      send({
        type: 'browser.session',
        sessionId: browserSession?.id,
        runId: runRow.id,
        tcId: testCase.id,
      });

      const contract = compileOperationContractV2({
        ...testCase,
        steps: decodeJson(testCase.steps, []) || [],
        assertions: decodeJson(testCase.assertions, []) || [],
      });
      if (browserSession.liveCdp) {
        browserSession.liveCdp.dialogResolutionQueue = buildDialogResolutionQueue(contract.operations);
      }
      send({
        type: 'step.start',
        runId: runRow.id,
        tcId: testCase.id,
        totalSteps: contract.operations.length,
        tcName: testCase.name || '',
        scenarioName: scenario?.name || '',
      });
      const adapter = createControllerMcpRuntimeAdapter({
        session: browserSession,
        operations: contract.operations,
        cancelToken,
        journal,
        knownLocators,
        send: (event) => send({
          runId: runRow.id,
          tcId: testCase.id,
          ...event,
          tcId: event?.tcId || testCase.id,
        }),
      });
      const gateway = createControllerActionExecutionGateway({
        transport: adapter.transport,
        journal,
      });
      const compositeExecutor = createControllerCompositeExecutor({
        observer: adapter.observer,
        gateway,
      });
      // Phase 29.3 — the recovery/degradation narrative already broadcasts live
      // over WS (controller.recovery / controller.progress heartbeats) but was
      // never persisted, so Reports could not explain a self-correction or a
      // genuine exhaustion after the fact. Collect every heartbeat that carries
      // a `phase` (recovery cycles, evidence-write degradation, exhaustion) —
      // the plain per-decision progress heartbeat never sets `phase`, so this
      // filter isolates the narrative-worthy events without extra plumbing.
      const recoveryEvents = [];
      const recordRecoveryEvent = (event) => {
        if (event && event.phase) {
          recoveryEvents.push({
            operationId: event.operationId || null,
            actionOccurrenceId: event.actionOccurrenceId || null,
            phase: event.phase,
            reason: event.reason || null,
            recoveryCycle: event.recoveryCycle || null,
            evidenceDegraded: event.evidenceDegraded === true,
            at: new Date().toISOString(),
          });
        }
      };
      const recoveryCoordinator = createControllerRecoveryCoordinator({
        acquireSnapshot: adapter.acquireSnapshot,
        currentEpoch: adapter.currentEpoch,
        healerPropose: adapter.proposeTargetRecovery,
        gateway,
        heartbeat: (event) => {
          recordRecoveryEvent(event);
          send({
            type: 'controller.recovery',
            runId: runRow.id,
            tcId: testCase.id,
            ...event,
          });
        },
      });
      const operationIndex = new Map(
        contract.operations.map((operation, index) => [operation.operationId, index + 1]),
      );
      // Lets the heartbeat below attach the human-readable target/action a
      // WS consumer (Action Trail) needs — the state machine's own event
      // only carries operationId, not what the operation actually is.
      const operationsById = new Map(
        contract.operations.map((operation) => [operation.operationId, operation]),
      );
      const runtime = createBrowserTransactionRuntime({
        journal,
        verdictRepository,
        controllerOptions: {
          resolver: adapter.resolver,
          planner: createTypedAdapterPlan,
          observer: adapter.observer,
          gateway,
          compositeExecutor,
          recoveryCoordinator,
          defaultDeadlineMs: 7_000,
          defaultObservationAttempts: 6,
          defaultResolutionAttempts: 3,
        },
        heartbeat: (event) => {
          recordRecoveryEvent(event);
          send({
            type: 'controller.progress',
            runId: runRow.id,
            tcId: testCase.id,
            ...event,
          });
        },
        // Phase 30.0.1 — must run immediately after each action commits, not
        // in a post-case batch: MCP snapshot refs get reused across later
        // page states, so verifying a ref after the case has moved on to
        // later pages can silently bind to a DIFFERENT element (confirmed
        // live — see PHASE_LOG). Bounded by the adapter's own timeout.
        captureLocatorEvidence: (operationId, committedCandidate) => (
          adapter.captureVerifiedLocator(operationId, { committedCandidate })
        ),
      });
      const startedAt = Date.now();
      const outcome = await runtime.runCase({
        operationContract: contract,
        scopeId: `${runRow.id}:${testCase.id}`,
        context: {
          session: browserSession,
          cancelToken,
          isCancelled: () => Boolean(cancelToken?.cancelled || cancelToken?.signal?.aborted),
          resolveValueRef: valueResolver,
          deadlineForOperation,
          observationAttemptsForOperation,
          resolutionAttemptsForOperation,
          knownLocators,
        },
      });
      // Phase 30.0.1 — captured per-operation, immediately on commit, inside
      // runtime.runCase() itself (see browserTransactionRuntime.js). This
      // only ATTACHES codegen-grade locator evidence to steps that already
      // committed; it never affects status, and a capture miss just leaves
      // that one step's locator unverified — visible as such in Output
      // Files, never guessed or invented.
      const verifiedLocators = outcome.verifiedLocators || new Map();
      const steps = operationRows(contract, outcome, recoveryEvents, verifiedLocators);
      const assertions = assertionRows(contract, outcome);
      const status = outcome.paused ? 'needs_human' : databaseStatus(outcome.verdict.verdict);
      const error = outcome.paused
        ? 'Execution paused at an explicit manual boundary.'
        : verdictError(outcome, contract);
      const replayIr = projectControllerReplayIr(contract, outcome, steps, assertions);
      const existingTc = await prisma.testCase.findUnique({ where: { id: testCase.id }, select: { id: true } });
      const validTcId = existingTc ? testCase.id : null;
      if (validTcId) {
        const failedStep = steps.find((s) => s.status === 'fail' || s.status === 'blocked');
        const failureAnalysis = error ? {
          rootCause: error,
          failedStepIndex: failedStep?.index || null,
          failedAction: failedStep?.action || null,
          failedTarget: failedStep?.target || null,
        } : null;
        await prisma.runResult.create({
          data: {
            runId: runRow.id,
            testCaseId: validTcId,
            status,
            durationMs: Math.max(0, Date.now() - startedAt),
            error,
            blockedReason: status === 'blocked' ? error : null,
            screenshots: encodeJson(
              Array.isArray(browserSession?.screenshots)
                ? browserSession.screenshots
                    .map((s, idx) => ({
                      url: s.path || s.artifactRef || (typeof s === 'string' ? s : s.url),
                      stepIndex: Number.isFinite(Number(s.stepIndex)) ? Number(s.stepIndex) : (idx + 1),
                      action: s.action || s.label || 'Action evidence',
                      target: s.target || null,
                      ts: s.capturedAt || s.ts || Date.now(),
                    }))
                    .filter((s) => s.url)
                    .sort((a, b) => a.stepIndex - b.stepIndex)
                : []
            ),
            stepResults: encodeJson(steps),
            assertionCheckResults: encodeJson(assertions),
            executionContractJson: encodeJson(contract),
            replayIrJson: encodeJson(replayIr),
            verdictVersion: 'controller_v1',
            verdictMode: 'mechanical_v1',
            mechanicalVerdictReason: outcome.paused
              ? 'controller_manual_boundary'
              : (outcome.verdict?.reason || 'none'),
          },
        }).catch((e) => console.error('[Conductor error saving runResult]', e));
        await recomputeRunCounters(runRow.id).catch((e) => console.error('[Conductor error recomputing counters]', e));
      }
      for (const step of steps) {
        send({
          type: 'step.complete',
          runId: runRow.id,
          tcId: testCase.id,
          stepIndex: step.index,
          status: step.status,
          error: step.reason,
          controllerState: step.terminalState,
        });
      }
      const caseOutcome = {
        verdict: outcome.paused ? CASE_VERDICT.MANUAL_BOUNDARY : outcome.verdict.verdict,
        status,
        error,
        continuationSafe: outcomeAllowsContinuation(outcome),
      };
      caseOutcomes.set(testCase.id, caseOutcome);
      history.push({ testCaseId: testCase.id, ...caseOutcome });

      if (sessionRegistry.sessionIsUsable(browserSession)
        && caseOutcome.continuationSafe
        && hasFutureDependent(testCase.id, cases)) {
        sessionRegistry.setScoped({
          userId,
          projectId,
          runId: runRow.id,
          caseId: testCase.id,
          continuityGroupId,
        }, browserSession);
      } else if (browserSession) {
        // Do NOT set browserSession.closed = true here — stopMcpSession's
        // own first line is `if (!session || session.closed) return;`, an
        // idempotency guard meant to skip a session some OTHER caller
        // already tore down. Setting the flag before calling it makes
        // every call think that's already true, so it returns immediately
        // without ever running context.close(), the taskkill fallback, or
        // profile-dir cleanup — the browser just stays open for the rest
        // of the run with zero error anywhere.
        await mcp.stopMcpSession(browserSession).catch((error) => (
          console.error(`[controllerConductor] stopMcpSession threw for case ${testCase.id}:`, error)
        ));
        activeSessions.delete(browserSession);
      }
      if (outcome.paused) casePaused = true;
      } catch (caseError) {
        // A single case's internal fault (contract compile, controller invariant
        // violation, session launch, etc.) must never take down the rest of the
        // run — that both wastes every remaining case's tokens and leaves the Run
        // row stuck at status:'running' forever. Genuine assertion/execution
        // failures never reach this catch — they already flow through the normal
        // decision/verdict path above untouched. Anything caught here is a
        // platform-side fault, not a website problem, so it is labelled and scoped
        // to this one case only; the run continues to the next case.
        if (cancelToken?.cancelled || cancelToken?.signal?.aborted) break;
        const message = caseError?.message || String(caseError);
        const diagnosticError = `Controller hit an internal fault executing this case — a platform issue, not a website assertion failure: ${message}`;
        await prisma.runResult.create({
          data: {
            runId: runRow.id,
            testCaseId: testCase.id,
            status: 'blocked',
            error: diagnosticError,
            blockedReason: 'controller_internal_error',
            screenshots: encodeJson(
              Array.isArray(browserSession?.screenshots)
                ? browserSession.screenshots.map((s, idx) => ({
                    url: s.path || s.artifactRef || (typeof s === 'string' ? s : s.url),
                    stepIndex: s.stepIndex ?? (idx + 1),
                    action: s.action || s.label || 'Action evidence',
                    ts: s.capturedAt || s.ts || Date.now(),
                  })).filter((s) => s.url)
                : []
            ),
            stepResults: encodeJson([]),
            verdictVersion: 'controller_v1',
            verdictMode: 'mechanical_v1',
            mechanicalVerdictReason: 'controller_unhandled_case_exception',
          },
        });
        send({
          type: 'agent.phase.log',
          phase: 'conductor',
          level: 'error',
          message: `"${testCase.name}" was marked blocked so the run could continue — ${diagnosticError}`,
        });
        const caughtCaseOutcome = {
          verdict: CASE_VERDICT.EXECUTION_ERROR,
          status: 'blocked',
          error: diagnosticError,
          continuationSafe: false,
        };
        caseOutcomes.set(testCase.id, caughtCaseOutcome);
        history.push({ testCaseId: testCase.id, ...caughtCaseOutcome });
      }
      const counters = await recomputeRunCounters(runRow.id);
      send({ type: 'run.counters', runId: runRow.id, projectId, ...counters });
      if (casePaused) {
        paused = true;
        break;
      }
    }

    const cancelled = Boolean(cancelToken?.cancelled || cancelToken?.signal?.aborted);
    await prisma.run.update({
      where: { id: runRow.id },
      data: cancelled
        ? { status: 'cancelled', completedAt: new Date() }
        : paused
          ? { status: 'running', completedAt: null }
          : { status: 'completed', completedAt: new Date() },
    });
    const counters = await recomputeRunCounters(runRow.id);
    const total = counters.passed + counters.failed + counters.blocked
      + counters.skipped + counters.needsHuman;
    const summary = {
      ...counters,
      total,
      passRate: total ? Math.round((counters.passed / total) * 100) : 0,
      cancelled,
      paused,
      runtimeVersion: CONTROLLER_CONDUCTOR_VERSION,
    };
    send({ type: 'run.counters', runId: runRow.id, projectId, ...counters });
    if (!paused) send({ type: 'run.complete', runId: runRow.id, summary, cancelled });
    return {
      runId: runRow.id,
      summary,
      history,
      systemic: false,
      cancelled,
      paused,
      dependencyFindings: [],
      suiteAbortReason: null,
    };
  } finally {
    if (!paused) {
      for (const browserSession of activeSessions) {
        try {
          await mcp.stopMcpSession(browserSession);
        } catch (_) {}
      }
    }
  }
}

module.exports = {
  CONTROLLER_CONDUCTOR_VERSION,
  allCases,
  dependencyIds,
  rootCaseId,
  databaseStatus,
  stepStatus,
  deadlineForOperation,
  observationAttemptsForOperation,
  outcomeAllowsContinuation,
  run,
};
