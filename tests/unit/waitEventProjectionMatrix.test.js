import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter');
const { buildExecutedCaseAstV1 } = require('../../server/services/codegen/executedCaseAst');

function identity(caseId, contractStepId, operation, sequenceIndex = 1) {
  return {
    caseId,
    contractStepId,
    authoredActionId: `${contractStepId}-authored`,
    actionOccurrenceId: `${contractStepId}:${operation}:1`,
    occurrenceOrdinal: 1,
    occurrenceKey: `${caseId}:${contractStepId}:1:${operation}`,
    sequenceIndex,
    operation,
  };
}

function eventEvidence(eventKind, selectedEvent, expected = {}) {
  return {
    schema: 'qaai_browser_event_evidence_v1',
    eventKind,
    status: 'confirmed',
    matched: true,
    expected,
    selectedEvent,
    timing: { timeoutMs: 17_321 },
    trigger: { started: true, finished: true, threw: false },
    journal: { status: 'persisted', persisted: true, ref: 'journal:event:1' },
    certification: { runtimeStatus: 'confirmed', evidenceStatus: 'complete', certifiable: true },
  };
}

function verifiedTriggerLocator() {
  const backendNodeId = 'controlled:arbitrary-trigger';
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'controlled-document:event',
    nodeId: backendNodeId,
    connected: true,
  };
  const expression = 'page.getByRole("button", { name: "Arbitrary trigger", exact: true })';
  return {
    kind: 'playwright',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    pageUrl: 'https://example.test/event',
    captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId } },
    targetFacts: { role: 'button', accessibleName: 'Arbitrary trigger', backendNodeId },
    proof: {
      verified: true,
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
      actionTimeResolved: true,
      actedNodeBound: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      expectedBackendNodeId: backendNodeId,
      resolvedBackendNodeId: backendNodeId,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: 'https://example.test/event',
      verifiedActions: [{
        expression,
        count: 1,
        sameElement: true,
        backendNodeId,
        targetIdentity: identity,
        matchedIdentity: { ...identity },
      }],
    },
  };
}

describe('executed wait, navigation, and browser-event projection', () => {
  it.each([
    ['url', 'https://external.example.test/ready'],
    ['visible', 'results'],
    ['hidden', 'spinner'],
    ['enabled', 'submit'],
    ['disabled', 'locked field'],
    ['text', 'Ready'],
    ['title', 'Arbitrary workspace'],
    ['pageState', { effect: 'stable' }],
    ['loadState', 'networkidle'],
    ['duration', 1_337],
  ])('preserves the executed %s wait and immutable occurrence identity', (kind, expected) => {
    const caseId = `wait-${kind}`;
    const contractStepId = `wait-${kind}-step`;
    const actionIdentity = identity(caseId, contractStepId, 'waitFor');
    const waitContract = {
      kind,
      expected,
      timeoutMs: 24_619,
      pollIntervalMs: 317,
      stableObservations: 3,
      refreshAfterMs: 7_113,
      recovery: {
        action: 'reload',
        maxAttempts: 2,
        retryAfterMs: 2_711,
        timeoutMs: 5_111,
        waitUntil: 'domcontentloaded',
        sameSession: true,
      },
      ...(kind === 'duration' ? { durationMs: expected } : {}),
    };
    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [{
        tool: 'browser_wait_for',
        ok: true,
        contractStepId,
        actionIdentity,
        args: {},
        waitContract,
      }],
      verdictStatus: 'pass',
    });

    const wait = emitted.ir.steps.find((step) => step.op === 'waitFor');
    expect(wait).toMatchObject({
      contractStepId,
      actionOccurrenceId: actionIdentity.actionOccurrenceId,
      occurrenceKey: actionIdentity.occurrenceKey,
      condition: {
        kind,
        timeoutMs: 24_619,
        pollIntervalMs: 317,
        stableObservations: 3,
        refreshAfterMs: 7_113,
        recovery: {
          action: 'reload',
          maxAttempts: 2,
          retryAfterMs: 2_711,
          timeoutMs: 5_111,
          waitUntil: 'domcontentloaded',
          sameSession: true,
        },
      },
    });
    expect(wait.waitContract.kind).toBe(kind);
    if (kind === 'duration') expect(wait.waitContract.durationMs).toBe(1_337);

    const ast = buildExecutedCaseAstV1({
      testCaseId: caseId,
      replayEnvelope: { ir: emitted.ir },
    });
    expect(ast.nodes).toHaveLength(1);
    expect(ast.nodes[0]).toMatchObject({
      type: 'WaitForState',
      actionOccurrenceId: actionIdentity.actionOccurrenceId,
      occurrenceKey: actionIdentity.occurrenceKey,
      waitContract: {
        kind,
        timeoutMs: 24_619,
        pollIntervalMs: 317,
        stableObservations: 3,
      },
    });
  });

  it.each([
    ['browser_navigate', 'direct'],
    ['browser_navigate_back', 'back'],
    ['browser_navigate_forward', 'forward'],
    ['browser_reload', 'reload'],
  ])('preserves %s as a typed %s navigation without stripping cross-origin URLs', (tool, kind) => {
    const caseId = `navigation-${kind}`;
    const contractStepId = `navigation-${kind}-step`;
    const action = kind === 'direct' ? 'navigate' : kind === 'back' ? 'navigateBack' : kind === 'forward' ? 'navigateForward' : 'reload';
    const url = 'https://external.example.test/path?tenant=arbitrary#ready';
    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [{
        tool,
        ok: true,
        contractStepId,
        actionIdentity: identity(caseId, contractStepId, action),
        args: { ...(kind === 'direct' ? { url } : {}), timeoutMs: 18_731, waitUntil: 'domcontentloaded' },
      }],
      verdictStatus: 'pass',
    });
    const step = emitted.ir.steps.find((candidate) => candidate.op === 'act');
    expect(step.navigation).toMatchObject({ kind, timeoutMs: 18_731, waitUntil: 'domcontentloaded', sameSession: true });
    if (kind === 'direct') {
      expect(step.url).toBe(url);
      expect(step.navigation.url).toBe(url);
    }
    const ast = buildExecutedCaseAstV1({ testCaseId: caseId, replayEnvelope: { ir: emitted.ir } });
    expect(ast.nodes[0].navigation.kind).toBe(kind);
    if (kind === 'direct') expect(ast.nodes[0].navigation.url).toBe(url);
  });

  it('does not synthesize a navigation action timeout when execution supplied none', () => {
    const caseId = 'navigation-with-inherited-test-budget';
    const contractStepId = 'navigation-with-inherited-test-budget-step';
    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [{
        tool: 'browser_navigate',
        ok: true,
        contractStepId,
        actionIdentity: identity(caseId, contractStepId, 'navigate'),
        args: { url: 'https://app.example.test/start' },
      }],
      verdictStatus: 'pass',
    });
    const step = emitted.ir.steps.find((candidate) => candidate.op === 'act');
    expect(step.navigation).not.toHaveProperty('timeoutMs');
  });

  it.each([
    ['popup', { pageId: 'popup-page-1', tabIndex: 2, url: 'https://external.example.test/popup' }, { urlPattern: '/popup' }],
    ['download', { suggestedFilename: 'report.csv', sizeBytes: 4096, mimeType: 'text/csv', complete: true }, { filenamePattern: 'report\\.csv' }],
    ['dialog', { dialogType: 'confirm', message: 'Delete this record?' }, { dialogType: 'confirm', messagePattern: 'Delete this record' }],
    ['navigation', { url: 'https://external.example.test/complete', readiness: 'domcontentloaded', navigated: true }, { urlPattern: '/complete' }],
  ])('projects persisted %s evidence onto the exact trigger occurrence', (eventKind, selectedEvent, expected) => {
    const caseId = `event-${eventKind}`;
    const contractStepId = `event-${eventKind}-trigger`;
    const actionIdentity = identity(caseId, contractStepId, 'click');
    const emitted = replayEmitter.buildReplayIR({
      caseId,
      trail: [{
        tool: 'browser_click',
        ok: true,
        contractStepId,
        actionIdentity,
        args: { element: 'Arbitrary trigger', role: 'button' },
        actionLocator: verifiedTriggerLocator(),
        browserEventEvidence: eventEvidence(eventKind, selectedEvent, expected),
      }],
      verdictStatus: 'pass',
    });
    const action = emitted.ir.steps.find((step) => step.op === 'act');
    expect(action.browserEvent).toMatchObject({ kind: eventKind, status: 'confirmed', matched: true });
    expect(action.browserEventEvidence.selectedEvent).toMatchObject(selectedEvent);
    expect(action.actionOccurrenceId).toBe(actionIdentity.actionOccurrenceId);
    if (eventKind === 'popup') expect(action).toMatchObject({ opensPopup: true, popupExpectedUrl: selectedEvent.url });
    if (eventKind === 'download') expect(action.downloadEvidence.file).toMatchObject(selectedEvent);
    if (eventKind === 'dialog') expect(action).toMatchObject({ dialogType: 'confirm', expectedMessage: 'Delete this record?' });
    if (eventKind === 'navigation') expect(action.observedConsequenceUrl).toBe(selectedEvent.url);

    const ast = buildExecutedCaseAstV1({ testCaseId: caseId, replayEnvelope: { ir: emitted.ir } });
    const node = ast.nodes[0];
    expect(node.browserEventEvidence).toMatchObject({
      eventKind,
      occurrenceIdentity: {
        actionOccurrenceId: actionIdentity.actionOccurrenceId,
        occurrenceKey: actionIdentity.occurrenceKey,
      },
    });
    expect(node.actionOccurrenceId).toBe(actionIdentity.actionOccurrenceId);
  });

  it('never synthesizes a planned wait without an executed occurrence', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'planned-only-wait',
      plannedSteps: [{
        id: 'planned-wait',
        type: 'Wait',
        waitContract: { kind: 'visible', target: 'results', timeoutMs: 91_337 },
      }],
      trail: [],
      verdictStatus: 'fail',
    });
    expect(emitted.ir.steps.some((step) => step.op === 'waitFor')).toBe(false);
    expect(emitted.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'planned_step_not_executed', where: 'planned-wait' }),
    ]));
  });
});
