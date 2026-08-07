'use strict';

const actionTransactionCoordinator = require('./actionTransactionCoordinator');
const universalAuthSessionManager = require('./universalAuthSessionManager');
const sessionRegistry = require('./sessionRegistry');
const liveScriptRecorder = require('./liveScriptRecorder');
const {
  deterministicChaosConfig,
  evaluateGroupedRunAcceptance,
} = require('./universalReliabilityBenchmark');

const HARNESS_SCHEMA_VERSION = 'qaai.universal-runtime-reliability-harness.v1';

function exactTargetIdentity(name, role) {
  return { role, name, framePath: ['main'], shadowPath: [] };
}

async function runExactlyOnceChaosTransactions({ seedCount = 20, startSeed = 1 } = {}) {
  const count = Math.max(1, Math.floor(Number(seedCount) || 20));
  const runs = [];
  for (let offset = 0; offset < count; offset += 1) {
    const config = deterministicChaosConfig(Number(startSeed) + offset);
    const targetIdentity = exactTargetIdentity('Generic workflow action', 'button');
    let dispatchCount = 0;
    let observationCount = 0;
    let committed = false;
    const coordinated = await actionTransactionCoordinator.coordinateActionTransaction({
      runId: `chaos-run-${config.seed}`,
      caseId: 'generic-case',
      stepId: 'generic-action',
      sequenceIndex: 0,
      action: { kind: 'click', target: targetIdentity },
      capturePreState: async () => ({ committed: false, targetIdentity }),
      dispatch: async () => {
        dispatchCount += 1;
        committed = true;
        return { delivered: true, browserEventId: `event-${config.seed}` };
      },
      observe: async () => {
        observationCount += 1;
        if (observationCount <= config.lossCount) {
          return { available: false, reason: 'temporary_snapshot_unavailable' };
        }
        return { available: true, committed, targetIdentity };
      },
      provePostcondition: async ({ observation }) => {
        if (observation.data.available !== true) {
          return { checked: false, matched: null, terminal: false, reason: 'evidence_temporarily_unavailable' };
        }
        return {
          checked: true,
          matched: observation.data.committed === true,
          terminal: true,
          reason: observation.data.committed === true ? 'exact_action_effect_observed' : 'action_effect_absent',
          evidence: { targetIdentity: observation.data.targetIdentity },
        };
      },
      maxObservationAttempts: config.lossCount + 2,
      maxDispatchAttempts: 2,
      observationIntervalMs: 0,
      sleep: async () => {},
    });
    const passed = coordinated.outcome?.status === 'passed'
      && coordinated.transaction?.dispatchAttemptCount === 1
      && dispatchCount === 1
      && coordinated.outcome?.continuation?.blockDependents === false;
    runs.push({
      seed: config.seed,
      config,
      passed,
      dispatchCount,
      observationCount,
      actionOccurrenceId: coordinated.transaction?.actionOccurrenceId || null,
      transactionStatus: coordinated.transaction?.status || null,
      outcome: coordinated.outcome,
    });
  }
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    seedCount: count,
    passed: runs.every((run) => run.passed),
    zeroDuplicateStateChangingActions: runs.every((run) => run.dispatchCount === 1),
    noFalseBlockFromTemporaryEvidenceLoss: runs.every((run) => run.outcome?.continuation?.blockDependents === false),
    runs,
  };
}

function appendGroupedRunScript(ledger, runIndex) {
  liveScriptRecorder.appendScriptLine(ledger, {
    trailEntry: {
      tool: 'browser_click',
      args: { element: 'Continue workflow' },
      ok: true,
      contractStepId: `dependent-case-${runIndex}:step:1`,
      actionLocator: {
        strategy: 'role',
        frameworkExpressions: {
          playwright: 'page.getByRole("button", { name: "Continue workflow" })',
        },
      },
    },
  });
  liveScriptRecorder.appendScriptLine(ledger, {
    kind: 'assert',
    trailEntry: {
      tool: 'assertion_check',
      args: { expectedText: 'Expected summary', actualText: 'Observed summary' },
      ok: false,
      contractStepId: `dependent-case-${runIndex}:step:2`,
    },
  });
}

async function runGroupedSessionRuntimeHarness({ runCount = 5, registry = sessionRegistry } = {}) {
  const count = Math.max(1, Math.floor(Number(runCount) || 5));
  const runs = [];
  for (let index = 0; index < count; index += 1) {
    const userId = `runtime-benchmark-user-${index}`;
    const projectId = 'runtime-benchmark-project';
    const runId = `runtime-benchmark-run-${index}`;
    const prerequisiteCaseId = `prerequisite-case-${index}`;
    const dependentCaseId = `dependent-case-${index}`;
    let createSessionCount = 0;
    let actionDispatchCount = 0;
    const session = {
      browser: { id: `browser-${index}` },
      context: { id: `context-${index}` },
      page: { id: `page-${index}` },
      pageAlias: 'primary-page',
      tabAlias: 'primary-tab',
    };
    try {
      const fresh = await universalAuthSessionManager.acquireSessionForCase({
        registry,
        userId,
        projectId,
        runId,
        testCase: { id: prerequisiteCaseId, sessionMode: 'fresh', dependsOnIds: [] },
        createSession: async () => {
          createSessionCount += 1;
          return session;
        },
      });
      const continuation = await universalAuthSessionManager.acquireSessionForCase({
        registry,
        userId,
        projectId,
        runId,
        testCase: {
          id: dependentCaseId,
          sessionMode: 'continue_from_dependency',
          dependsOnIds: [prerequisiteCaseId],
          failurePolicy: 'block_dependents',
        },
        createSession: async () => {
          createSessionCount += 1;
          return { browser: {}, context: {}, page: {} };
        },
      });
      const action = await actionTransactionCoordinator.coordinateActionTransaction({
        runId,
        caseId: dependentCaseId,
        stepId: 'continue-workflow',
        sequenceIndex: 0,
        action: { kind: 'click', target: exactTargetIdentity('Continue workflow', 'button') },
        capturePreState: async () => ({ pageId: session.page.id }),
        dispatch: async () => {
          actionDispatchCount += 1;
          return { delivered: true };
        },
        observe: async () => ({ pageId: session.page.id, advanced: true }),
        provePostcondition: async ({ observation }) => ({
          checked: true,
          matched: observation.data.advanced === true,
          terminal: true,
          reason: 'dependent_action_effect_observed',
        }),
        observationIntervalMs: 0,
      });
      const assertion = await actionTransactionCoordinator.coordinateActionTransaction({
        runId,
        caseId: dependentCaseId,
        stepId: 'validation-only-assertion',
        sequenceIndex: 1,
        mutating: false,
        failureMode: actionTransactionCoordinator.FAILURE_MODE.VALIDATION_ONLY,
        action: { kind: 'assert_text', target: exactTargetIdentity('Summary', 'heading') },
        capturePreState: async () => ({ text: 'Observed summary' }),
        observe: async () => ({ text: 'Observed summary' }),
        provePostcondition: async () => ({
          checked: true,
          matched: false,
          terminal: true,
          reason: 'exact_visible_text_mismatch',
          evidence: { expected: 'Expected summary', actual: 'Observed summary' },
        }),
      });
      const ledger = liveScriptRecorder.newLedger({
        runResultId: runId,
        testCaseId: dependentCaseId,
        scriptMode: 'failed_run_script',
      });
      appendGroupedRunScript(ledger, index);
      const canonicalLines = liveScriptRecorder.canonicalLines(ledger);
      const generatedSpec = liveScriptRecorder.compileLedgerToPlaywrightSpec({ ledger });
      const sessionIdentityPreserved = fresh.session === continuation.session
        && continuation.sameBrowser === session.browser
        && continuation.sameContext === session.context
        && continuation.samePage === session.page;
      const validationContinued = assertion.outcome?.status === 'failed'
        && assertion.outcome?.continuation?.shouldContinue === true
        && assertion.outcome?.continuation?.blockDependents === false;
      const scriptParityPassed = canonicalLines.length === 2
        && generatedSpec.includes('Continue workflow')
        && generatedSpec.includes('Expected summary');
      const passed = sessionIdentityPreserved
        && createSessionCount === 1
        && actionDispatchCount === 1
        && action.outcome?.status === 'passed'
        && validationContinued
        && scriptParityPassed;
      runs.push({
        index,
        passed,
        proofMode: 'runtime_harness',
        liveProof: false,
        createSessionCount,
        actionDispatchCount,
        sessionIdentityPreserved,
        validationContinued,
        scriptParityPassed,
        canonicalScriptLineCount: canonicalLines.length,
      });
    } finally {
      registry.remove({ userId, projectId, runId, caseId: prerequisiteCaseId });
      registry.remove({ userId, projectId, runId, caseId: dependentCaseId });
    }
  }
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    runCount: count,
    passed: runs.every((run) => run.passed),
    requiredConsecutiveRunsMet: runs.length >= count && runs.every((run) => run.passed),
    runs,
  };
}

function liveFixtureHtml() {
  return `<!doctype html>
<html lang="en">
  <body>
    <main>
      <button id="continue-workflow" type="button">Continue workflow</button>
      <section id="workflow" hidden>
        <h1>Workflow dashboard</h1>
        <p id="active-count">Active 62</p>
        <label>Equipment
          <select id="equipment">
            <option value="">Choose equipment</option>
            <option value="RR">RR</option>
            <option value="LTL">LTL</option>
            <option value="TL">TL</option>
          </select>
        </label>
        <label>Ship Direction
          <select id="ship-direction">
            <option value="Outbound">Outbound</option>
            <option value="Inbound">Inbound</option>
          </select>
        </label>
        <label>Freight Term
          <select id="freight-term" aria-readonly="true">
            <option value="Pre-Paid">Pre-Paid</option>
            <option value="COL">COL</option>
          </select>
        </label>
      </section>
    </main>
    <script>
      window.__qaaiDispatchEvents = { continue: 0, equipment: 0, direction: 0 };
      document.querySelector('#continue-workflow').addEventListener('click', () => {
        window.__qaaiDispatchEvents.continue += 1;
        setTimeout(() => { document.querySelector('#workflow').hidden = false; }, 25);
      });
      document.querySelector('#equipment').addEventListener('change', () => {
        window.__qaaiDispatchEvents.equipment += 1;
      });
      document.querySelector('#ship-direction').addEventListener('change', (event) => {
        window.__qaaiDispatchEvents.direction += 1;
        setTimeout(() => {
          document.querySelector('#freight-term').value = event.target.value === 'Inbound' ? 'COL' : 'Pre-Paid';
        }, 25);
      });
    </script>
  </body>
</html>`;
}

async function coordinateLiveAction({ runId, caseId, stepId, action, dispatch, observe, matches }) {
  return actionTransactionCoordinator.coordinateActionTransaction({
    runId,
    caseId,
    stepId,
    sequenceIndex: 0,
    action,
    capturePreState: observe,
    dispatch,
    observe,
    provePostcondition: async ({ observation }) => ({
      checked: true,
      matched: matches(observation.data),
      terminal: matches(observation.data),
      reason: matches(observation.data) ? 'live_browser_postcondition_exact' : 'live_browser_postcondition_pending',
      evidence: observation.data,
    }),
    maxObservationAttempts: 20,
    maxDispatchAttempts: 1,
    observationIntervalMs: 10,
  });
}

function appendLiveBrowserScript(ledger) {
  const locator = (expression) => ({
    strategy: 'role',
    frameworkExpressions: { playwright: expression },
  });
  liveScriptRecorder.appendScriptLine(ledger, {
    trailEntry: {
      tool: 'browser_click',
      args: { element: 'Continue workflow' },
      ok: true,
      actionLocator: locator('page.getByRole("button", { name: "Continue workflow" })'),
    },
  });
  liveScriptRecorder.appendScriptLine(ledger, {
    kind: 'assert',
    trailEntry: {
      tool: 'assertion_check',
      args: { expectedText: 'Active 61', actualText: 'Active 62' },
      ok: false,
    },
  });
  liveScriptRecorder.appendScriptLine(ledger, {
    trailEntry: {
      tool: 'browser_select_option',
      args: { element: 'Equipment', value: 'LTL' },
      ok: true,
      actionLocator: locator('page.getByLabel("Equipment")'),
    },
  });
  liveScriptRecorder.appendScriptLine(ledger, {
    trailEntry: {
      tool: 'browser_select_option',
      args: { element: 'Ship Direction', value: 'Inbound' },
      ok: true,
      actionLocator: locator('page.getByLabel("Ship Direction")'),
    },
  });
  liveScriptRecorder.appendScriptLine(ledger, {
    kind: 'assert',
    trailEntry: {
      tool: 'assertion_check',
      args: { expectedText: 'COL', actualText: 'COL' },
      ok: true,
    },
  });
}

async function runLiveBrowserGroupedAcceptance({
  runCount = 5,
  executablePath = process.env.QAAI_BENCHMARK_CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless = true,
  registry = sessionRegistry,
} = {}) {
  const { chromium } = require('playwright');
  const count = Math.max(1, Math.floor(Number(runCount) || 5));
  const browser = await chromium.launch({ executablePath, headless, args: ['--no-sandbox'] });
  const runs = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const userId = `live-browser-user-${index}`;
      const projectId = 'universal-live-browser-benchmark';
      const runId = `live-browser-run-${index}`;
      const prerequisiteCaseId = `live-prerequisite-${index}`;
      const dependentCaseId = `live-dependent-${index}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      const session = { browser, context, page, pageAlias: 'workflow-page', tabAlias: 'primary-tab' };
      try {
        await page.setContent(liveFixtureHtml(), { waitUntil: 'domcontentloaded' });
        const fresh = await universalAuthSessionManager.acquireSessionForCase({
          registry,
          userId,
          projectId,
          runId,
          testCase: { id: prerequisiteCaseId, sessionMode: 'fresh', dependsOnIds: [] },
          createSession: async () => session,
        });
        const open = await coordinateLiveAction({
          runId,
          caseId: prerequisiteCaseId,
          stepId: 'open-workflow',
          action: { kind: 'click', target: exactTargetIdentity('Continue workflow', 'button') },
          dispatch: () => fresh.session.page.getByRole('button', { name: 'Continue workflow' }).click(),
          observe: async () => ({ visible: await fresh.session.page.getByRole('heading', { name: 'Workflow dashboard' }).isVisible() }),
          matches: (observed) => observed.visible === true,
        });
        const validation = await actionTransactionCoordinator.coordinateActionTransaction({
          runId,
          caseId: prerequisiteCaseId,
          stepId: 'active-count-validation',
          sequenceIndex: 1,
          mutating: false,
          failureMode: actionTransactionCoordinator.FAILURE_MODE.VALIDATION_ONLY,
          action: { kind: 'assert_text', target: exactTargetIdentity('Active count', 'paragraph') },
          capturePreState: async () => ({ text: await fresh.session.page.locator('#active-count').innerText() }),
          observe: async () => ({ text: await fresh.session.page.locator('#active-count').innerText() }),
          provePostcondition: async ({ observation }) => ({
            checked: true,
            matched: observation.data.text === 'Active 61',
            terminal: true,
            reason: 'exact_visible_text_compared',
            evidence: { expected: 'Active 61', actual: observation.data.text },
          }),
        });
        const continuation = await universalAuthSessionManager.acquireSessionForCase({
          registry,
          userId,
          projectId,
          runId,
          testCase: {
            id: dependentCaseId,
            sessionMode: 'continue_from_dependency',
            dependsOnIds: [prerequisiteCaseId],
            failurePolicy: 'block_dependents',
          },
          createSession: async () => ({ browser: null, context: null, page: null }),
        });
        const dependentPage = continuation.session.page;
        const equipment = await coordinateLiveAction({
          runId,
          caseId: dependentCaseId,
          stepId: 'select-equipment',
          action: { kind: 'select', target: exactTargetIdentity('Equipment', 'combobox') },
          dispatch: () => dependentPage.getByLabel('Equipment').selectOption('LTL'),
          observe: async () => ({ value: await dependentPage.getByLabel('Equipment').inputValue() }),
          matches: (observed) => observed.value === 'LTL',
        });
        const direction = await coordinateLiveAction({
          runId,
          caseId: dependentCaseId,
          stepId: 'select-direction',
          action: { kind: 'select', target: exactTargetIdentity('Ship Direction', 'combobox') },
          dispatch: () => dependentPage.getByLabel('Ship Direction').selectOption('Inbound'),
          observe: async () => ({
            direction: await dependentPage.getByLabel('Ship Direction').inputValue(),
            freightTerm: await dependentPage.getByLabel('Freight Term').inputValue(),
          }),
          matches: (observed) => observed.direction === 'Inbound' && observed.freightTerm === 'COL',
        });
        const dispatchEvents = await dependentPage.evaluate(() => window.__qaaiDispatchEvents);
        const ledger = liveScriptRecorder.newLedger({
          runResultId: runId,
          testCaseId: dependentCaseId,
          scriptMode: 'failed_run_script',
        });
        appendLiveBrowserScript(ledger);
        const canonicalLines = liveScriptRecorder.canonicalLines(ledger);
        const generatedSpec = liveScriptRecorder.compileLedgerToPlaywrightSpec({ ledger });
        const sessionIdentityPreserved = fresh.session === continuation.session
          && continuation.sameBrowser === browser
          && continuation.sameContext === context
          && continuation.samePage === page;
        const zeroDuplicateStateChangingActions = open.transaction.dispatchAttemptCount === 1
          && equipment.transaction.dispatchAttemptCount === 1
          && direction.transaction.dispatchAttemptCount === 1
          && dispatchEvents.continue === 1
          && dispatchEvents.equipment === 1
          && dispatchEvents.direction === 1;
        const validationContinued = validation.outcome?.status === 'failed'
          && validation.outcome?.continuation?.shouldContinue === true
          && validation.outcome?.continuation?.blockDependents === false;
        const scriptParityPassed = canonicalLines.length === 5
          && generatedSpec.includes('Continue workflow')
          && generatedSpec.includes('selectOption("LTL")')
          && generatedSpec.includes('selectOption("Inbound")')
          && generatedSpec.includes('Active 61')
          && generatedSpec.includes('COL');
        const freightTermObserved = await dependentPage.getByLabel('Freight Term').inputValue();
        const benchmarkPassed = open.outcome?.status === 'passed'
          && equipment.outcome?.status === 'passed'
          && direction.outcome?.status === 'passed'
          && validationContinued
          && freightTermObserved === 'COL';
        runs.push({
          index,
          proofMode: 'live',
          liveProof: true,
          benchmarkPassed,
          zeroDuplicateStateChangingActions,
          noFalseBlockFromTemporaryEvidenceLoss: true,
          sessionIdentityPreserved,
          scriptParityPassed,
          validationContinued,
          inboundSelectionEventCount: dispatchEvents.direction,
          freightTermObserved,
          canonicalScriptLineCount: canonicalLines.length,
        });
      } catch (error) {
        runs.push({
          index,
          proofMode: 'live',
          liveProof: true,
          benchmarkPassed: false,
          zeroDuplicateStateChangingActions: false,
          noFalseBlockFromTemporaryEvidenceLoss: false,
          sessionIdentityPreserved: false,
          scriptParityPassed: false,
          error: String(error?.message || error).slice(0, 1000),
        });
      } finally {
        registry.remove({ userId, projectId, runId, caseId: prerequisiteCaseId });
        registry.remove({ userId, projectId, runId, caseId: dependentCaseId });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  const acceptance = evaluateGroupedRunAcceptance({ runs, requiredConsecutive: count });
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    runCount: count,
    passed: acceptance.accepted,
    acceptance,
    runs,
  };
}

module.exports = {
  HARNESS_SCHEMA_VERSION,
  runExactlyOnceChaosTransactions,
  runGroupedSessionRuntimeHarness,
  runLiveBrowserGroupedAcceptance,
};
