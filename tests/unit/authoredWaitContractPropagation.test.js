import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const waits = require('../../server/services/waitContract');
const { WAIT_SCHEMA, buildExecutedCaseAstV1 } = require('../../server/services/codegen/executedCaseAst');
const replayEmitter = require('../../server/services/codegen/replayEmitter');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference');
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');
const seleniumPom = require('../../server/services/codegen/adapters/seleniumPom');

function executedWait({ caseId, contractStepId, sequenceIndex, waitContract, sourceStepId = null }) {
  return {
    tool: 'browser_wait_for',
    ok: true,
    contractStepId,
    sourceStepId,
    actionIdentity: {
      caseId,
      contractStepId,
      authoredActionId: `${contractStepId}-action`,
      actionOccurrenceId: `${contractStepId}:waitFor:1`,
      occurrenceOrdinal: 1,
      occurrenceKey: `${caseId}:${contractStepId}:1:waitFor`,
      sequenceIndex,
      operation: 'waitFor',
    },
    args: {},
    waitContract,
  };
}

describe('authored wait contract propagation', () => {
  it('uses explicit wait timing and inherits missing recovery fields from the operation check', () => {
    const contract = waits.buildWaitContract({
      action: 'Wait',
      element: 'arbitrary page content',
      operationCheck: {
        kind: 'page_ready',
        timeoutMs: 23_871,
        refreshAfterMs: 6_123,
        recovery: {
          action: 'reload',
          maxAttempts: 1,
          waitUntil: 'domcontentloaded',
          reason: 'authored recovery metadata survives',
        },
      },
      waitContract: {
        kind: 'stabilization',
        expected: { effect: 'page_ready', text: 'Arbitrary page' },
        timeoutMs: 19_457,
        pollIntervalMs: 377,
        stableObservations: 3,
      },
    });

    expect(contract).toMatchObject({
      kind: 'stabilization',
      timeoutMs: 19_457,
      refreshAfterMs: 6_123,
      pollIntervalMs: 377,
      stableObservations: 3,
      recovery: {
        action: 'reload',
        maxAttempts: 1,
        waitUntil: 'domcontentloaded',
        reason: 'authored recovery metadata survives',
      },
    });
  });

  it('runs recovery at the authored threshold without resetting the original maximum budget', async () => {
    const contract = waits.buildWaitContract({
      action: 'Verify',
      waitContract: {
        kind: 'assertion',
        expected: { effect: 'matched' },
        timeoutMs: 17_891,
        refreshAfterMs: 4_327,
        pollIntervalMs: 1_000,
        stableObservations: 2,
        recovery: { action: 'reload', maxAttempts: 1 },
      },
    });
    let clock = 0;
    let recovered = false;
    const recoverCalls = [];
    const recoveredResult = await waits.pollUntilStable({
      contract,
      observe: async () => ({ matched: recovered }),
      recover: async (context) => {
        recoverCalls.push(context);
        recovered = true;
        return { reloaded: true };
      },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    expect(recoverCalls).toHaveLength(1);
    expect(recoverCalls[0]).toMatchObject({
      attempt: 1,
      elapsedMs: 4_327,
      remainingMs: 13_564,
      recovery: { action: 'reload', maxAttempts: 1 },
    });
    expect(recoveredResult).toMatchObject({
      matched: true,
      timedOut: false,
      recoveryAttempts: 1,
      durationMs: 5_327,
    });

    clock = 0;
    const timedOutResult = await waits.pollUntilStable({
      contract,
      observe: async () => ({ matched: false }),
      recover: async () => ({ reloaded: true }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(timedOutResult).toMatchObject({
      matched: false,
      timedOut: true,
      recoveryAttempts: 1,
      durationMs: 17_891,
    });
  });

  it('adapts authored reload recovery to a same-session conductor callback with remaining budget', async () => {
    const contract = waits.buildWaitContract({
      action: 'Verify',
      waitContract: {
        kind: 'assertion',
        timeoutMs: 18_503,
        refreshAfterMs: 4_939,
        pollIntervalMs: 1_300,
        stableObservations: 1,
        recovery: { action: 'reload', maxAttempts: 1, waitUntil: 'domcontentloaded' },
      },
    });
    let clock = 0;
    let matched = false;
    const reloadRequests = [];
    const phases = [];
    const result = await waits.pollWithAuthoredRecovery({
      contract,
      observe: async () => ({ matched }),
      reloadCurrentPage: async (request) => {
        reloadRequests.push(request);
        matched = true;
        return { currentUrlReloaded: true };
      },
      onRecovery: async (event) => phases.push(event.phase),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    expect(reloadRequests).toHaveLength(1);
    expect(reloadRequests[0]).toMatchObject({
      action: 'reload',
      attempt: 1,
      timeoutMs: 13_564,
      waitUntil: 'domcontentloaded',
      sameSession: true,
    });
    expect(phases).toEqual(['before', 'after']);
    expect(result).toMatchObject({ matched: true, timedOut: false, recoveryAttempts: 1, durationMs: 4_939 });
  });

  it('merges runtime and ReplayIR wait evidence without dropping authored recovery in the AST', () => {
    const ast = buildExecutedCaseAstV1({
      executionContract: {
        contractId: 'contract-arbitrary-wait',
        nodes: [{
          contractStepId: 'wait-step',
          stepOrdinal: 1,
          kind: 'action',
          actionType: 'wait',
          plannedText: 'Wait for arbitrary page state',
          operationCheck: {
            kind: 'page_ready',
            condition: { text: 'Arbitrary page' },
          },
          waitContract: {
            kind: 'stabilization',
            expected: { effect: 'page_ready' },
            timeoutMs: 26_543,
            refreshAfterMs: 7_219,
            pollIntervalMs: 419,
            stableObservations: 4,
            recovery: {
              action: 'reload',
              maxAttempts: 1,
              waitUntil: 'domcontentloaded',
              source: 'authored',
            },
          },
        }],
      },
      replayEnvelope: {
        ir: {
          steps: [{
            op: 'act',
            action: 'waitForState',
            contractRef: 'wait-step',
            waitContract: {
              kind: 'dom_state',
              expected: { effect: 'page_ready', text: 'Arbitrary page' },
            },
          }],
        },
      },
    });

    expect(ast.nodes[0].waitContract).toEqual({
      schema: WAIT_SCHEMA,
      kind: 'pageState',
      expected: { effect: 'page_ready', text: 'Arbitrary page' },
      timeoutMs: 26_543,
      pollMs: 419,
      pollIntervalMs: 419,
      stableObservations: 4,
      armBeforeAction: false,
      refreshAfterMs: 7_219,
      recovery: {
        action: 'reload',
        maxAttempts: 1,
        waitUntil: 'domcontentloaded',
        source: 'authored',
      },
      condition: { text: 'Arbitrary page' },
    });
    expect(ast.validation.valid).toBe(true);
  });

  it('lowers rich authored waits into ReplayIR even when CaseContractV1 owns the stable step IDs', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-authored-wait-bridge',
      title: 'Arbitrary authored wait',
      trail: [executedWait({
        caseId: 'case-authored-wait-bridge',
        contractStepId: 'wait-stable-id',
        sourceStepId: 'draft-rich-wait-id',
        sequenceIndex: 1,
        waitContract: {
          kind: 'visible',
          expected: { effect: 'page_ready' },
          timeoutMs: 31_429,
          refreshAfterMs: 8_237,
          pollIntervalMs: 463,
          stableObservations: 3,
          recovery: {
            action: 'reload',
            maxAttempts: 1,
            waitUntil: 'domcontentloaded',
            provenance: 'inline-authored',
          },
        },
      })],
      caseContractV1: {
        steps: [{
          id: 'wait-stable-id',
          ordinal: 1,
          type: 'Wait',
          text: 'Wait for arbitrary results table',
          dependsOn: [],
        }],
      },
      plannedSteps: [{
        id: 'draft-rich-wait-id',
        type: 'Wait',
        target: 'arbitrary results table',
        operationCheck: {
          kind: 'page_ready',
          refreshAfterMs: 8_237,
          recovery: {
            action: 'reload',
            maxAttempts: 1,
            waitUntil: 'domcontentloaded',
            provenance: 'inline-authored',
          },
        },
        waitContract: {
          kind: 'stabilization',
          expected: { effect: 'page_ready' },
          timeoutMs: 31_429,
          pollIntervalMs: 463,
          stableObservations: 3,
        },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    const replayWait = emitted.ir.steps.find((step) => step.op === 'waitFor');
    expect(replayWait).toMatchObject({
      contractStepId: 'wait-stable-id',
      condition: {
        kind: 'visible',
        timeoutMs: 31_429,
        refreshAfterMs: 8_237,
        pollIntervalMs: 463,
        stableObservations: 3,
        recovery: {
          action: 'reload',
          maxAttempts: 1,
          waitUntil: 'domcontentloaded',
          provenance: 'inline-authored',
        },
      },
    });
    expect(replayWait.condition.timeoutMs).not.toBe(10_000);
    expect(replayWait.contractStepId).toBe('wait-stable-id');
    expect(replayWait.contractStepId).not.toBe('draft-rich-wait-id');

    const trailEmitted = replayEmitter.buildReplayIR({
      caseId: 'case-live-wait-bridge',
      title: 'Live arbitrary wait evidence',
      trail: [{
        tool: 'browser_click',
        ok: true,
        args: { element: 'Arbitrary menu', role: 'button' },
        operationCheck: {
          kind: 'dropdown_visible',
          expected: 'Arbitrary menu is visible',
        },
        waitContract: {
          timeoutMs: 22_907,
          refreshAfterMs: 6_419,
          recovery: { action: 'reload', maxAttempts: 1, source: 'runtime-contract' },
        },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });
    const trailWait = trailEmitted.ir.steps.find((step) => step.op === 'waitFor');
    expect(trailWait.condition).toMatchObject({
      kind: 'visible',
      timeoutMs: 22_907,
      refreshAfterMs: 6_419,
      recovery: { action: 'reload', maxAttempts: 1, source: 'runtime-contract' },
    });
  });

  it('never swaps wait metadata between adjacent stable contract steps', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'case-adjacent-authored-waits',
      title: 'Adjacent authored waits',
      trail: [
        executedWait({
          caseId: 'case-adjacent-authored-waits',
          contractStepId: 'stable-wait-one',
          sourceStepId: 'draft-wait-one',
          sequenceIndex: 1,
          waitContract: { kind: 'pageState', timeoutMs: 11_137, recovery: { action: 'reload', maxAttempts: 1, source: 'first-wait' } },
        }),
        executedWait({
          caseId: 'case-adjacent-authored-waits',
          contractStepId: 'stable-wait-two',
          sourceStepId: 'draft-wait-two',
          sequenceIndex: 2,
          waitContract: { kind: 'pageState', timeoutMs: 22_271, recovery: { action: 'reload', maxAttempts: 2, source: 'second-wait' } },
        }),
      ],
      caseContractV1: {
        steps: [
          { id: 'stable-wait-one', ordinal: 1, type: 'Wait', text: 'Wait for first arbitrary region', dependsOn: [] },
          { id: 'stable-wait-two', ordinal: 2, type: 'Wait', text: 'Wait for second arbitrary region', dependsOn: ['stable-wait-one'] },
        ],
      },
      plannedSteps: [
        { id: 'draft-wait-one', ordinal: 1, type: 'Wait', waitContract: { timeoutMs: 11_137 }, operationCheck: { recovery: { action: 'reload', maxAttempts: 1, source: 'first-wait' } } },
        { id: 'draft-wait-two', ordinal: 2, type: 'Wait', waitContract: { timeoutMs: 22_271 }, operationCheck: { recovery: { action: 'reload', maxAttempts: 2, source: 'second-wait' } } },
      ],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });

    const first = emitted.ir.steps.find((step) => step.op === 'waitFor' && step.contractStepId === 'stable-wait-one');
    const second = emitted.ir.steps.find((step) => step.op === 'waitFor' && step.contractStepId === 'stable-wait-two');
    expect(first.condition).toMatchObject({ timeoutMs: 11_137, recovery: { source: 'first-wait', maxAttempts: 1 } });
    expect(second.condition).toMatchObject({ timeoutMs: 22_271, recovery: { source: 'second-wait', maxAttempts: 2 } });
    expect(first.sourceStepId).toBe('draft-wait-one');
    expect(second.sourceStepId).toBe('draft-wait-two');

    const ordinalConflict = replayEmitter.buildReplayIR({
      caseId: 'case-conflicting-wait-ordinal',
      title: 'Conflicting wait ordinal',
      trail: [],
      caseContractV1: { steps: [{ id: 'stable-conflict', ordinal: 1, type: 'Wait', text: 'Wait for arbitrary region', dependsOn: [] }] },
      plannedSteps: [{ id: 'draft-conflict', ordinal: 2, type: 'Wait', waitContract: { timeoutMs: 44_409 } }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'fail',
    });
    const conflictingWait = ordinalConflict.ir.steps.find((step) => step.op === 'waitFor' && step.contractStepId === 'stable-conflict');
    expect(conflictingWait).toBeUndefined();
    expect(ordinalConflict.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'stable-conflict' }),
    ]));
  });

  it('emits one fixed Playwright deadline and reloads inside the authored budget', () => {
    const condition = {
      kind: 'visible',
      target: 'records',
      timeoutMs: 28_743,
      refreshAfterMs: 7_911,
      recovery: {
        action: 'reload',
        maxAttempts: 1,
        waitUntil: 'domcontentloaded',
      },
    };
    const referenceCode = playwrightReference.emitWait(condition, { records: 'recordsTable' });
    const pomCode = playwrightPom._emitPomWait(
      condition,
      new Map([['records', { file: 'usersPage', name: 'recordsTable' }]]),
      new Map(),
    );

    for (const code of [referenceCode, pomCode]) {
      expect(code.match(/Date\.now\(\) \+ 28743/g)).toHaveLength(1);
      expect(code).toContain('const _qaaiInitialRecoveryAfterMs = 7911;');
      expect(code).toContain('const _qaaiRecoveryLimit = 1;');
      expect(code).toContain("await page.reload({ timeout: _qaaiReloadBudget, waitUntil: \"domcontentloaded\" });");
      expect(code).toContain('const _qaaiRemainingBudget = _qaaiWaitDeadline - Date.now();');
      expect(code).toContain('timeout: _qaaiWaitBudget');
      expect(code).not.toContain('waitForTimeout');
      expect(code).not.toContain('timeout: 10000');
      expect(code).not.toContain('timeout: 5000');
    }
    expect(referenceCode).toContain("await recordsTable.waitFor({ state: 'visible', timeout: _qaaiWaitBudget });");
    expect(pomCode).toContain("await usersPage.recordsTable().waitFor({ state: 'visible', timeout: _qaaiWaitBudget });");
    expect(playwrightPom._isImmediatePostClickWait({ condition }, 'records')).toBe(false);
    expect(playwrightPom._isImmediatePostClickWait({ condition: { kind: 'visible', target: 'records' } }, 'records')).toBe(true);
  });

  it('keeps authored recovery timing and the current page through ReplayIR and continuation POM output', () => {
    const declaredWait = {
      id: 'wait-results-ready',
      ordinal: 1,
      type: 'Wait',
      target: 'arbitrary results table',
      waitContract: {
        kind: 'visible',
        target: 'resultsStatus',
        timeoutMs: 27_311,
        refreshAfterMs: 6_877,
        pollIntervalMs: 431,
        stableObservations: 2,
        recovery: {
          action: 'reload',
          maxAttempts: 1,
          retryAfterMs: 5_239,
          waitUntil: 'domcontentloaded',
        },
      },
    };
    const replay = replayEmitter.buildReplayIR({
      caseId: 'case-continuation-wait',
      title: 'Continue in the current arbitrary session',
      trail: [executedWait({
        caseId: 'case-continuation-wait',
        contractStepId: 'wait-results-ready',
        sequenceIndex: 1,
        waitContract: declaredWait.waitContract,
      })],
      caseContractV1: {
        steps: [{
          id: 'wait-results-ready',
          ordinal: 1,
          type: 'Wait',
          text: 'Wait for arbitrary results',
          dependsOn: [],
        }],
      },
      plannedSteps: [declaredWait],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });
    const sourceCase = {
      caseName: 'Continue in the current arbitrary session',
      testCaseId: 'case-continuation-wait',
      sessionMode: 'continue_from_dependency',
      dependsOnIds: ['arbitrary-prerequisite'],
      failurePolicy: 'block_dependents',
      declaredSteps: [declaredWait],
      ir: replay.ir,
    };

    const prepared = playwrightPomJs._prepareCasesForStandardOutput([sourceCase])[0];
    const preparedWait = prepared.ir.steps.find((step) => step.op === 'waitFor');
    expect(preparedWait).toMatchObject({
      contractStepId: 'wait-results-ready',
      condition: {
        kind: 'visible',
        target: 'resultsStatus',
        timeoutMs: 27_311,
        refreshAfterMs: 6_877,
        pollIntervalMs: 431,
        stableObservations: 2,
        recovery: {
          action: 'reload',
          maxAttempts: 1,
          retryAfterMs: 5_239,
          waitUntil: 'domcontentloaded',
        },
      },
    });

    const prerequisiteCase = {
      caseName: 'Establish arbitrary prerequisite session',
      testCaseId: 'arbitrary-prerequisite',
      failurePolicy: 'block_dependents',
      declaredSteps: [],
      ir: {
        caseId: 'arbitrary-prerequisite',
        steps: [{
          op: 'assert',
          channel: 'PAGE',
          expected: '/ready',
          authored: true,
          contractStepId: 'confirm-prerequisite-state',
        }],
      },
    };
    // Reversed input proves dependency metadata, not array position, owns journey order.
    const output = playwrightPomJs.emitJourneySpec([sourceCase, prerequisiteCase], {
      scenarioName: 'Website-neutral continuation wait',
      moduleFormat: 'esm',
    });
    expect(output.content).toContain('Date.now() + 27311');
    expect(output.content).toContain('const _qaaiInitialRecoveryAfterMs = 6877;');
    expect(output.content).toContain('const _qaaiRetryAfterMs = 5239;');
    expect(output.content).toContain('const _qaaiRecoveryLimit = 1;');
    expect(output.content).toContain(
      'await page.reload({ timeout: _qaaiReloadBudget, waitUntil: "domcontentloaded" });',
    );
    expect(output.content).toContain(
      'Session contract - sessionMode: continue_from_dependency; dependsOn: arbitrary-prerequisite; failurePolicy: block_dependents.',
    );
    expect(output.content).not.toMatch(/\b(?:browser|context)\.newPage\s*\(/);
    expect(output.content).not.toMatch(/\bpage\.context\(\)\.newPage\s*\(/);
    expect(output.content).not.toContain('page.goto(');
    expect(output.content).toContain('waitForStableObservations(page, {');
    expect(output.content).toContain('observations: 2');
    expect(output.content).toContain('pollIntervalMs: 431');
    expect(output.content).not.toContain('_qaaiStableDeadline');
    expect(output.extraFiles['tests/support/replayir.js']).toContain(
      'async function waitForStableObservations(page, options, observe)',
    );
    expect(output.extraFiles['tests/support/replayir.js']).toContain(
      'Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))',
    );
    expect(output.extraFiles['tests/support/replayir.js']).toContain(
      'await new Promise((resolve) => setTimeout(resolve, delayMs))',
    );
    expect(output.extraFiles['tests/support/replayir.js']).not.toContain(
      'page.waitForTimeout(',
    );
  });

  it('emits bounded reload recovery in Selenium reference and POM waits with fresh locators', () => {
    const condition = {
      kind: 'visible',
      target: 'records',
      timeoutMs: 34_619,
      refreshAfterMs: 9_113,
      recovery: {
        action: 'reload',
        maxAttempts: 2,
        retryAfterMs: 7_307,
      },
    };
    const resolve = {
      op: 'resolve',
      as: 'records',
      candidates: [{ strategy: 'role', role: 'table', name: 'Arbitrary records' }],
    };
    const ir = { caseId: 'selenium-authored-wait', steps: [resolve] };
    const referenceFindings = [];
    const referenceCode = seleniumReference.emitWait(condition, { op: 'waitFor', condition }, ir, { adapterFindings: referenceFindings });

    const pomOptions = { className: 'ArbitraryWaitTest', adapterFindings: [] };
    seleniumPom.emitSetup(ir, pomOptions);
    seleniumPom.emitLocatorResolver(resolve.candidates, resolve, ir, pomOptions);
    const pomCode = seleniumPom.emitWait(condition, { op: 'waitFor', condition }, ir, pomOptions);

    for (const code of [referenceCode, pomCode]) {
      expect(code.match(/System\.currentTimeMillis\(\) \+ 34619L/g)).toHaveLength(1);
      expect(code).toContain('final long qaaiInitialRecoveryAfterMs = 9113L;');
      expect(code).toContain('final long qaaiRetryAfterMs = 7307L;');
      expect(code).toContain('final int qaaiRecoveryLimit = 2;');
      expect(code).toContain('Duration.ofMillis(qaaiWaitBudget)');
      expect(code).toContain('driver.navigate().refresh();');
      expect(code).toContain('pageLoadTimeout(Duration.ofMillis(qaaiReloadBudget))');
      expect(code).not.toContain('Thread.sleep');
      expect(code).not.toContain('Duration.ofMillis(10000)');
      expect(code).not.toContain('Duration.ofMillis(5000)');
    }
    expect(referenceCode).toContain('LocatorResolver.resolve(d, new LocatorCandidate[]{');
    expect(pomCode).toContain('ExpectedConditions.visibilityOf(page.arbitraryRecordsElement())');
    expect(referenceFindings).toEqual([]);
    expect(pomOptions.adapterFindings).toEqual([
      expect.objectContaining({
        rule: 'selenium_pom_locator_semantic_fallback',
        severity: 'warning',
      }),
    ]);
  });
});
