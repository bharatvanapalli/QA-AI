import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const genericClickExecution = require('../../server/services/genericClickExecution');
const executionJournal = require('../../server/services/executionJournal');
const { transformConductorSource } = require('../../server/services/agents/conductorRuntimeLoader');

const conductorSource = readFileSync(
  resolve(process.cwd(), 'server/services/agents/conductor.js'),
  'utf8',
);
const transformedConductorSource = transformConductorSource(conductorSource);

const transitionStep = {
  id: 'submit',
  action: 'Click',
  description: 'Submit request',
  operationCheck: {
    kind: 'page_ready',
    expectedState: {
      urlPattern: '/done',
      titleIncludes: 'Complete',
      visibleText: 'Request complete',
      control: { role: 'button', name: 'Close' },
    },
  },
};

function formObservation(ref = 'submit-ref', overrides = {}) {
  return {
    snapshotText: [
      '- main "Request form"',
      '  - heading "Review request"',
      `  - button "Submit request" [ref=${ref}]`,
      ...(overrides.extraLines || []),
    ].join('\n'),
    url: overrides.url || 'https://app.example.test/form',
    title: overrides.title || 'Request form',
    source: overrides.source || 'test_fresh_form',
    fresh: overrides.fresh !== false,
  };
}

function destinationObservation(overrides = {}) {
  return {
    snapshotText: [
      '- main "Request complete"',
      '  - heading "Request complete"',
      '  - button "Close" [ref=close-ref]',
    ].join('\n'),
    url: overrides.url || 'https://app.example.test/done',
    title: overrides.title || 'Complete',
    source: overrides.source || 'test_fresh_destination',
    fresh: overrides.fresh !== false,
  };
}

function queuedObserver(observations, calls = []) {
  const queue = [...observations];
  return async (request) => {
    calls.push(request);
    if (!queue.length) throw new Error(`Unexpected observation: ${request.phase}`);
    return queue.shift();
  };
}

describe('Conductor universal Click loop regressions', () => {
  it('routes Click through a fresh observation after a preceding mutation', async () => {
    const observationCalls = [];
    const staleCachedSnapshot = formObservation('stale-before-fill-ref', {
      source: 'cached_before_fill',
      fresh: false,
    });
    const freshAfterFill = formObservation('live-after-fill-ref', {
      source: 'fresh_after_fill',
    });
    const observations = [freshAfterFill, destinationObservation()];
    let observedIndex = 0;
    const dispatchedRefs = [];

    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Submit request',
      observe: async (request) => {
        observationCalls.push(request);
        if (request.requireFresh !== true) return staleCachedSnapshot;
        return observations[observedIndex++];
      },
      dispatch: async ({ resolution }) => {
        dispatchedRefs.push(resolution.ref);
        return { ok: true, result: { isError: false } };
      },
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, terminal: false });
    expect(observationCalls.length).toBeGreaterThanOrEqual(2);
    expect(observationCalls.every((call) => call.requireFresh === true)).toBe(true);
    expect(dispatchedRefs).toEqual(['live-after-fill-ref']);
    expect(dispatchedRefs).not.toContain('stale-before-fill-ref');

    const kernelStart = transformedConductorSource.indexOf('const runDeterministicKernelStep');
    const genericRoute = transformedConductorSource.indexOf(
      'if (isClick) return runGenericClickKernelStep({ idx, step });',
      kernelStart,
    );
    const cachedSnapshotPath = transformedConductorSource.indexOf(
      'let snapshotBefore = mcp.getLastSnapshot',
      kernelStart,
    );
    expect(transformedConductorSource).toContain('genericClickExecution.executeGenericClick({');
    expect(genericRoute).toBeGreaterThan(kernelStart);
    expect(genericRoute).toBeLessThan(cachedSnapshotPath);
  });

  it('proves transition after dispatch error before considering a retry', async () => {
    const dispatches = [];
    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Submit request',
      observe: queuedObserver([
        formObservation('initial-ref'),
        destinationObservation({ source: 'fresh_after_dispatch_error' }),
      ]),
      dispatch: async (attempt) => {
        dispatches.push(attempt);
        return { ok: false, result: { isError: true } };
      },
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      handled: true,
      terminal: false,
      reason: 'declared_transition_already_satisfied',
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toMatchObject({ attempt: 1, retry: false });
    expect(result.diagnostics.dispatches).toHaveLength(1);
    expect(result.diagnostics.final).toMatchObject({ status: 'pass', retried: false });
    expect(result.diagnostics.transitions).toContainEqual(expect.objectContaining({
      phase: 'post_dispatch',
      satisfied: true,
    }));
  });

  it('semantically re-resolves a changed ref and retries exactly once', async () => {
    const dispatches = [];
    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Submit request',
      observe: queuedObserver([
        formObservation('old-ref', { source: 'fresh_initial' }),
        formObservation('new-ref', { source: 'fresh_after_failed_dispatch' }),
        formObservation('new-ref', { source: 'fresh_reconcile' }),
        destinationObservation({ source: 'fresh_after_retry' }),
      ]),
      dispatch: async (attempt) => {
        dispatches.push(attempt);
        return attempt.attempt === 1
          ? { ok: false, result: { isError: true } }
          : { ok: true, result: { isError: false } };
      },
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, terminal: false });
    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((attempt) => ({
      attempt: attempt.attempt,
      retry: attempt.retry,
      ref: attempt.resolution.ref,
    }))).toEqual([
      { attempt: 1, retry: false, ref: 'old-ref' },
      { attempt: 2, retry: true, ref: 'new-ref' },
    ]);
    expect(result.diagnostics.dispatches.filter((attempt) => attempt.retry)).toHaveLength(1);
    expect(result.diagnostics.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'initial', ok: true }),
      expect.objectContaining({ phase: 'retry', ok: true }),
    ]));
  });

  it('stops failed Click descendants but continues independent journal work', async () => {
    let rows = executionJournal.initializeExecutionJournal({
      approvedSteps: [
        transitionStep,
        { id: 'dependent-proof', action: 'Verify', dependsOnStepIds: ['submit'] },
        { id: 'independent-proof', action: 'Screenshot', dependencies: [] },
      ],
    });
    const dispatches = [];

    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Submit request',
      observe: queuedObserver([
        formObservation('first-ref'),
        formObservation('second-ref'),
        formObservation('second-ref'),
        formObservation('second-ref'),
      ]),
      dispatch: async (attempt) => {
        dispatches.push(attempt);
        return { ok: false, result: { isError: true } };
      },
      seal: async (outcome) => {
        rows = executionJournal.recordAttempt(rows, 'submit', {
          tool: 'browser_click',
          clickAttemptDiagnostics: outcome.diagnostics,
        });
        rows = executionJournal.recordActionOutcome(rows, 'submit', {
          outcome: 'failed',
          executionError: true,
          required: true,
          continuationOutcome: outcome.requestedContinuation || 'stop_descendants',
          failureType: 'click_retry_exhausted',
          reason: outcome.reason,
          evidence: { clickAttemptDiagnostics: outcome.diagnostics },
        });
        return {
          sealed: rows[0],
          hasRunnableStep: executionJournal.selectNextRunnableStep(rows) != null,
        };
      },
    });

    expect(dispatches).toHaveLength(2);
    expect(result).toMatchObject({
      handled: true,
      terminal: false,
      continuation: {
        outcome: 'stop_descendants',
        reason: 'independent_runnable_step_available',
      },
    });
    expect(rows[0]).toMatchObject({
      actionOutcome: 'failed',
      continuationOutcome: 'stop_descendants',
      failureType: 'click_retry_exhausted',
      status: 'blocked',
    });
    expect(rows[1]).toMatchObject({
      actionOutcome: 'not_executed',
      dependencySkipped: true,
    });
    expect(rows[2].actionOutcome).toBeNull();
    expect(executionJournal.selectNextRunnableStep(rows)?.stepId).toBe('independent-proof');
  });

  it('persists sanitized freshness, resolver, attempt, and transition diagnostics', async () => {
    const secret = 'NeverPersistThisSecret-9137';
    const secretRef = 'secret-bearing-ref';
    let persistedRow = null;
    let rows = executionJournal.initializeExecutionJournal({
      approvedSteps: [transitionStep],
    });
    const unsafeObservation = formObservation(secretRef, {
      url: `https://app.example.test/form?token=${secret}`,
      extraLines: [`  - text "password=${secret}"`],
    });

    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Submit request',
      observe: queuedObserver([
        unsafeObservation,
        unsafeObservation,
        unsafeObservation,
        unsafeObservation,
      ]),
      dispatch: async () => ({
        ok: false,
        result: { isError: true, message: `dispatch rejected ${secret}` },
      }),
      seal: async (outcome) => {
        rows = executionJournal.recordAttempt(rows, 'submit', {
          tool: 'browser_click',
          clickAttemptDiagnostics: outcome.diagnostics,
        });
        rows = executionJournal.recordActionOutcome(rows, 'submit', {
          outcome: 'failed',
          executionError: true,
          continuationOutcome: 'stop_descendants',
          failureType: 'click_retry_exhausted',
          reason: outcome.reason,
          evidence: { clickAttemptDiagnostics: outcome.diagnostics },
        });
        [persistedRow] = rows;
        return { sealed: persistedRow, hasRunnableStep: false };
      },
    });

    expect(result.terminal).toBe(true);
    expect(persistedRow).not.toBeNull();
    const serialized = JSON.stringify(persistedRow);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(secretRef);
    expect(serialized).not.toContain('password=');
    expect(serialized).not.toContain('?token=');

    const diagnostics = persistedRow.evidence.clickAttemptDiagnostics;
    expect(diagnostics.schema).toBe('generic_click_attempt_v1');
    expect(diagnostics.observations).toHaveLength(4);
    expect(diagnostics.observations.every((item) => item.fresh && item.usable)).toBe(true);
    expect(diagnostics.observations.every((item) => item.fingerprint?.structuralHash)).toBe(true);
    expect(diagnostics.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'initial', reason: 'clickable_control_resolved' }),
      expect.objectContaining({ phase: 'retry', reason: 'clickable_control_resolved' }),
    ]));
    expect(diagnostics.dispatches).toEqual([
      expect.objectContaining({ attempt: 1, retry: false, ok: false }),
      expect.objectContaining({ attempt: 2, retry: true, ok: false }),
    ]);
    expect(diagnostics.transitions.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.transitions.every((item) => typeof item.satisfied === 'boolean')).toBe(true);
    expect(diagnostics.final).toMatchObject({
      status: 'blocked',
      retried: true,
    });

    expect(transformedConductorSource).toContain('clickAttemptDiagnostics: outcome.diagnostics');
    expect(transformedConductorSource).toContain('executionJournal.recordAttempt(stepResults, stepRef');
  });

  it('allowlists callback-provided diagnostic strings before journal sealing', async () => {
    const secret = 'ArbitraryCallbackSecret-4481';
    let sealedOutcome = null;

    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Submit request',
      observe: queuedObserver([
        formObservation('first-ref', { source: secret }),
        formObservation('second-ref', { source: secret }),
        formObservation('second-ref', { source: secret }),
        formObservation('second-ref', { source: secret }),
      ]),
      dispatch: async () => ({ ok: false, result: { isError: true, message: secret } }),
      proveEffect: async () => ({
        matched: false,
        checked: true,
        status: secret,
        kind: secret,
        reason: secret,
        evidence: secret,
      }),
      seal: async (outcome) => {
        sealedOutcome = outcome;
        return { sealed: { continuationOutcome: 'stop_descendants' }, hasRunnableStep: false };
      },
    });

    expect(result).toMatchObject({
      handled: true,
      terminal: true,
      reason: 'click_execution_blocked',
    });
    expect(sealedOutcome).not.toBeNull();
    expect(JSON.stringify(sealedOutcome)).not.toContain(secret);
    expect(sealedOutcome.diagnostics.observations.map((item) => item.source)).toEqual([
      'fresh_pre_dispatch_observation',
      'fresh_post_dispatch_observation',
      'fresh_reconcile_observation',
      'fresh_post_retry_observation',
    ]);
    expect(sealedOutcome.diagnostics.effectProofs.every((item) => (
      item.status === 'not_matched'
      && item.kind === 'effect_check'
      && item.reason === 'effect_not_matched'
    ))).toBe(true);
    expect(sealedOutcome.record).toMatchObject({
      status: 'not_matched',
      kind: 'effect_check',
      reason: 'effect_not_matched',
      evidence: 'effect_not_matched',
    });
  });
});
