import { describe, expect, it } from 'vitest';
import { applyPipelineMessage, coalescePipelineMessages, deriveLiveActive } from '../../src/store/runStream.jsx';

const baseState = {
  currentRunId: null,
  phaseStatus: {},
  phaseOutput: {},
  phaseAttempt: {},
  logs: {},
  actionTrail: [],
  browserFrame: null,
  currentBrowserSessionId: null,
  nowTestingStep: null,
  agentWarning: null,
  runSummary: null,
  cancelling: false,
  architectProgress: null,
  actionCount: 0,
  tokensThisRun: null,
  _lastTokensRemaining: null,
};

const stepOperationCheck = {
  type: 'step.operationCheck',
  tcId: 'tc-1',
  stepIndex: 2,
  status: 'pass',
  matched: true,
  expected: 'Username textbox accepts the provided value',
  kind: 'input_accepted',
  evidence: 'browser_type completed successfully',
};

const browserOperationCheck = {
  type: 'browser.action',
  tool: 'operation_check',
  tcId: 'tc-1',
  syntheticOperationCheck: true,
  stepIndex: 2,
  status: 'pass',
  matched: true,
  expected: 'Username textbox accepts the provided value',
  narration: 'Step 2 operational check passed. input_accepted is ready: "Textbox Username shows value Admin".',
  evidence: 'browser_type completed successfully',
};

describe('applyPipelineMessage', () => {
  it('coalesces bursty browser frames while preserving action order', () => {
    const batch = coalescePipelineMessages([
      { type: 'browser.frame', frame: 'old' },
      { type: 'browser.action', tool: 'browser_click', narration: 'Clicked' },
      { type: 'browser.frame', frame: 'new' },
      { type: 'step.operationCheck', tcId: 'tc-1', stepIndex: 1 },
    ]);

    expect(batch).toEqual([
      { type: 'browser.action', tool: 'browser_click', narration: 'Clicked' },
      { type: 'browser.frame', frame: 'new' },
      { type: 'step.operationCheck', tcId: 'tc-1', stepIndex: 1 },
    ]);
  });

  it('deduplicates operation checks when browser.action arrives after step.operationCheck', () => {
    let state = applyPipelineMessage(baseState, stepOperationCheck);
    state = applyPipelineMessage(state, browserOperationCheck);

    expect(state.actionTrail).toHaveLength(1);
    expect(state.actionTrail[0]).toMatchObject({
      tool: 'operation_check',
      tcId: 'tc-1',
      stepIndex: 2,
      syntheticOperationCheck: true,
      status: 'pass',
    });
  });

  it('deduplicates operation checks when step.operationCheck arrives after browser.action', () => {
    let state = applyPipelineMessage(baseState, browserOperationCheck);
    state = applyPipelineMessage(state, stepOperationCheck);

    expect(state.actionTrail).toHaveLength(1);
    expect(state.actionTrail[0]).toMatchObject({
      tool: 'operation_check',
      tcId: 'tc-1',
      stepIndex: 2,
      syntheticOperationCheck: true,
      status: 'pass',
    });
  });

  it('does NOT deduplicate operation checks across DIFFERENT data rows (row-aware)', () => {
    // Audit fix: a data-driven case re-runs the same Step N per data row. Row 2's
    // identical "value is ready" check must NOT replace row 1's in the trail —
    // otherwise six rows collapse into one and the run looks like it lost its mind.
    const row0 = { ...stepOperationCheck, dataRowIndex: 0, dataRowLabel: 'wrong_password', dataSetName: 'AuthProfiles' };
    const row1 = { ...stepOperationCheck, dataRowIndex: 1, dataRowLabel: 'fake_user', dataSetName: 'AuthProfiles' };
    let state = applyPipelineMessage(baseState, row0);
    state = applyPipelineMessage(state, row1);
    const opChecks = state.actionTrail.filter((a) => a.tool === 'operation_check');
    expect(opChecks).toHaveLength(2);
    expect(opChecks.map((a) => a.dataRowIndex)).toEqual([0, 1]);
  });

  it('STILL deduplicates the same operation check WITHIN one data row', () => {
    const a = { ...stepOperationCheck, dataRowIndex: 2 };
    const b = { ...browserOperationCheck, dataRowIndex: 2 };
    let state = applyPipelineMessage(baseState, a);
    state = applyPipelineMessage(state, b);
    expect(state.actionTrail.filter((x) => x.tool === 'operation_check')).toHaveLength(1);
  });

  it('deduplicates equivalent operation checks for the same step even when wording differs', () => {
    let state = applyPipelineMessage(baseState, {
      ...browserOperationCheck,
      stepIndex: 3,
      expected: 'Password textbox accepts the provided value',
      narration: 'Step 3 operational check passed. input_accepted is ready: "Password textbox accepts the provided value".',
    });
    state = applyPipelineMessage(state, {
      ...stepOperationCheck,
      stepIndex: 3,
      expected: "Textbox 'Password' accepts value",
      kind: 'input_accepted',
    });

    expect(state.actionTrail).toHaveLength(1);
    expect(state.actionTrail[0]).toMatchObject({
      tool: 'operation_check',
      tcId: 'tc-1',
      stepIndex: 3,
      syntheticOperationCheck: true,
      status: 'pass',
    });
  });

  it('updates an attempted action in place when the tool succeeds or fails', () => {
    let state = applyPipelineMessage(baseState, {
      type: 'browser.action',
      toolUseId: 'tool-1',
      tool: 'browser_click',
      tcId: 'tc-1',
      narration: 'Clicked the Login button',
      actionStatus: 'attempted',
      status: 'running',
    });
    state = applyPipelineMessage(state, {
      type: 'browser.action',
      toolUseId: 'tool-1',
      tool: 'browser_click',
      tcId: 'tc-1',
      narration: 'Clicked the Login button',
      actionStatus: 'failed',
      status: 'fail',
      error: 'MCP request timed out',
    });

    expect(state.actionTrail).toHaveLength(1);
    expect(state.actionCount).toBe(1);
    expect(state.actionTrail[0]).toMatchObject({
      toolUseId: 'tool-1',
      actionStatus: 'failed',
      status: 'fail',
      error: 'MCP request timed out',
    });
  });

  it('keeps diagnostic helper traffic out of user action counts and updates it in place', () => {
    let state = applyPipelineMessage(baseState, {
      type: 'browser.action',
      toolUseId: 'tool-helper-1',
      tool: 'browser_evaluate',
      tcId: 'tc-1',
      narration: 'Read the current field value',
      actionStatus: 'diagnostic',
      status: 'running',
      helperTraffic: true,
      diagnostic: true,
    });
    state = applyPipelineMessage(state, {
      type: 'browser.action',
      toolUseId: 'tool-helper-1',
      tool: 'browser_evaluate',
      tcId: 'tc-1',
      narration: 'Read the current field value',
      actionStatus: 'diagnostic',
      status: 'warning',
      error: 'probe failed',
      helperTraffic: true,
      diagnostic: true,
    });

    expect(state.actionTrail).toHaveLength(1);
    expect(state.actionCount).toBe(0);
    expect(state.actionTrail[0]).toMatchObject({
      toolUseId: 'tool-helper-1',
      actionStatus: 'diagnostic',
      status: 'warning',
      error: 'probe failed',
      helperTraffic: true,
      diagnostic: true,
    });
  });

  it('does not clear the new browser frame when an old session ends', () => {
    let state = applyPipelineMessage(baseState, {
      type: 'browser.session',
      sessionId: 'new-session',
    });
    state = applyPipelineMessage(state, {
      type: 'browser.frame',
      sessionId: 'new-session',
      mediaType: 'image/jpeg',
      frame: 'abc123',
    });
    state = applyPipelineMessage(state, {
      type: 'browser.session.end',
      sessionId: 'old-session',
    });

    expect(state.currentBrowserSessionId).toBe('new-session');
    expect(state.browserFrame).toBe('data:image/jpeg;base64,abc123');
  });

  it('ignores stale frames from a previous browser session', () => {
    let state = applyPipelineMessage(baseState, {
      type: 'browser.session',
      sessionId: 'new-session',
    });
    state = applyPipelineMessage(state, {
      type: 'browser.frame',
      sessionId: 'old-session',
      mediaType: 'image/jpeg',
      frame: 'stale',
    });

    expect(state.currentBrowserSessionId).toBe('new-session');
    expect(state.browserFrame).toBeNull();
  });

  it('derives the live sidebar indicator from active run lifecycle only', () => {
    let state = applyPipelineMessage(baseState, { type: 'run.started', runId: 'run-1' });
    expect(deriveLiveActive({ running: true, pipelineState: state })).toBe(true);

    state = applyPipelineMessage(state, { type: 'agent.phase.start', phase: 'conductor' });
    expect(deriveLiveActive({ running: false, pipelineState: state })).toBe(true);

    state = applyPipelineMessage(state, { type: 'run.cancelling' });
    expect(deriveLiveActive({ running: true, pipelineState: state })).toBe(false);

    state = applyPipelineMessage(state, { type: 'run.complete', runId: 'run-1', summary: { passed: 1 } });
    expect(deriveLiveActive({ running: false, pipelineState: state })).toBe(false);
  });
});
