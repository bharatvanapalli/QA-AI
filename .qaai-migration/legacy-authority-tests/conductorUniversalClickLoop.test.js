import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const genericClickExecution = require('../../server/services/genericClickExecution');
const executionJournal = require('../../server/services/executionJournal');

const conductorSource = readFileSync(
  resolve(process.cwd(), 'server/services/agents/conductor.js'),
  'utf8',
);
const transformedConductorSource = conductorSource;

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

function authoritativeClickResolution(ref = 'current-sign-in-ref', backendNodeId = 701, overrides = {}) {
  const identity = {
    scheme: 'qaai-cdp-backend-node-v1',
    backendNodeId,
    connected: true,
  };
  return {
    ok: true,
    ref,
    candidates: [],
    actionLocator: {
      kind: 'playwright',
      verified: true,
      diagnosticOnly: false,
      verificationSource: 'authoritative_chromium_cdp',
      expression: 'getByRole("button", { name: "Sign in" })',
      frameworkExpressions: { playwright: 'getByRole("button", { name: "Sign in" })' },
      captureBinding: { kind: 'mcp_bound_ref', ref },
      targetFacts: { cdpBackendNodeId: backendNodeId },
      context: {
        captureBinding: { kind: 'mcp_bound_ref', ref },
        authoritativeCdp: {
          pre: { identity: { backendNodeId }, stabilization: { backendNodeIdAfter: backendNodeId } },
          reverification: { backendNodeIdBefore: backendNodeId, backendNodeIdAfter: backendNodeId },
        },
      },
      proof: {
        verified: true,
        sameElement: true,
        count: 1,
        authoritativeCdpVerified: true,
        backendNodeVerified: true,
        stableAcrossSnapshots: true,
        expectedBackendNodeId: backendNodeId,
        matchedBackendNodeId: backendNodeId,
        backendNodeIdBefore: backendNodeId,
        backendNodeIdAfter: backendNodeId,
        targetIdentity: identity,
        matchedIdentity: { ...identity },
        source: 'authoritative_chromium_cdp',
        ...(overrides.proof || {}),
      },
      ...overrides.locator,
    },
  };
}

describe('Conductor universal Click loop regressions', () => {
  it('uses a same-backend-node authoritative current ref when semantic resolution has zero candidates', async () => {
    const resolveAuthoritative = vi.fn(async () => authoritativeClickResolution());
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Sign in',
      observe: queuedObserver([
        {
          snapshotText: '- main "Microsoft sign in"',
          url: 'https://login.example.test/',
          title: 'Sign in',
          fresh: true,
        },
        destinationObservation(),
      ]),
      resolveAuthoritative,
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, terminal: false });
    expect(resolveAuthoritative).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      resolution: {
        ref: 'current-sign-in-ref',
        authoritativeVerified: true,
        expectedBackendNodeId: 701,
      },
    });
    expect(result.diagnostics.resolutions).toContainEqual(expect.objectContaining({
      phase: 'initial',
      ok: true,
      authoritative: true,
    }));
  });

  it('never bypasses an ambiguous semantic click target with authoritative fallback', async () => {
    const resolveAuthoritative = vi.fn(async () => authoritativeClickResolution());
    const dispatch = vi.fn();
    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Continue',
      observe: queuedObserver([{
        snapshotText: [
          '- main "Sign in"',
          '  - button "Continue" [ref=continue-one]',
          '  - button "Continue" [ref=continue-two]',
        ].join('\n'),
        url: 'https://login.example.test/',
        title: 'Sign in',
        fresh: true,
      }]),
      resolveAuthoritative,
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, reason: 'ambiguous_clickable_control' });
    expect(resolveAuthoritative).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('satisfies an absent presence-conditional click without dispatching or blocking', async () => {
    const dispatch = vi.fn();
    const sealed = [];
    const result = await genericClickExecution.executeGenericClick({
      step: {
        id: 'optional-prompt-action',
        action: 'Click',
        target: 'option that continues to the application',
        condition: {
          kind: 'authored_predicate',
          predicate: 'the optional prompt is visible',
          onFalse: 'skip',
        },
      },
      target: 'option that continues to the application',
      observe: queuedObserver([destinationObservation()]),
      dispatch,
      seal: async (outcome) => {
        sealed.push(outcome);
        return {};
      },
    });

    expect(result).toMatchObject({
      handled: true,
      terminal: false,
      reason: 'optional_target_absent',
      record: { matched: true, required: false, optionalAbsent: true },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ status: 'pass', internalOperationCompletion: true });
  });

  it('rejects an authoritative fallback whose backend-node proof disagrees', async () => {
    const resolveAuthoritative = vi.fn(async () => authoritativeClickResolution(
      'current-sign-in-ref',
      701,
      { proof: { matchedBackendNodeId: 702 } },
    ));
    const dispatch = vi.fn();
    const result = await genericClickExecution.executeGenericClick({
      step: transitionStep,
      target: 'Sign in',
      observe: queuedObserver([{
        snapshotText: '- main "Microsoft sign in"',
        url: 'https://login.example.test/',
        title: 'Sign in',
        fresh: true,
      }]),
      resolveAuthoritative,
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({ handled: true, reason: 'no_clickable_control' });
    expect(resolveAuthoritative).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('accepts one successful dispatch with a stable fingerprint change when the next authored step verifies it', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const result = await genericClickExecution.executeGenericClick({
      step: {
        id: 'sign-in',
        action: 'Click',
        description: 'Submit credentials',
      },
      target: 'Sign in',
      transitionSteps: [
        { id: 'sign-in', action: 'Click', description: 'Submit credentials' },
        { id: 'verify-home', action: 'Verify', description: 'Confirm the authenticated home page' },
      ],
      observe: queuedObserver([
        {
          snapshotText: '- button "Sign in" [ref=sign-in-ref]',
          url: 'https://login.example.test/',
          title: 'Sign in',
          fresh: true,
        },
        {
          snapshotText: '- main "Authenticated home"\n  - heading "Welcome"',
          url: 'https://app.example.test/home',
          title: 'Home',
          fresh: true,
        },
      ]),
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      handled: true,
      terminal: false,
      reason: 'click_dispatched_fingerprint_changed_next_verify',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.diagnostics.final).toMatchObject({ status: 'pass', retried: false });
  });

  it('accepts one successful dispatch when fingerprint change is the explicit authored operation check', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const result = await genericClickExecution.executeGenericClick({
      step: {
        id: 'open-details',
        action: 'Click',
        operationCheck: { kind: 'fingerprint_change' },
      },
      target: 'Submit request',
      observe: queuedObserver([
        formObservation('open-details-ref'),
        destinationObservation(),
      ]),
      dispatch,
      seal: async () => ({}),
    });

    expect(result).toMatchObject({
      handled: true,
      terminal: false,
      reason: 'authored_fingerprint_change_observed',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.diagnostics.final).toMatchObject({ status: 'pass', retried: false });
  });

  it('does not accept dispatch success plus a next Verify when the fingerprint did not change', async () => {
    const unchanged = formObservation('sign-in-ref');
    const dispatch = vi.fn(async () => ({ ok: true, result: { isError: false } }));
    const result = await genericClickExecution.executeGenericClick({
      step: { id: 'sign-in', action: 'Click' },
      target: 'Submit request',
      transitionSteps: [
        { id: 'sign-in', action: 'Click' },
        { id: 'verify-home', action: 'Verify' },
      ],
      observe: async () => unchanged,
      dispatch,
      seal: async () => ({}),
      sleep: async () => {},
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'click_execution_blocked',
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(result.diagnostics.final).toMatchObject({ status: 'blocked', retried: false });
  });

  it('wires current-ref authoritative resolution and immutable locator attachment into the runtime adapter', () => {
    expect(transformedConductorSource).toContain('step.locatorEvidenceV2?.actionLocator');
    expect(transformedConductorSource).toContain('mcp.buildRefRoleMap(observation.snapshotText).has(boundRef)');
    expect(transformedConductorSource).toContain('mcp.resolveActionRefByDescription(');
    expect(transformedConductorSource).toContain('actionLocatorResolver.resolveVerifiedForTool({');
    expect(transformedConductorSource).toContain("source: 'generic_click_authoritative_zero_candidate_resolution'");
    expect(transformedConductorSource).toContain('trailEntry.actionLocator = authoritativeActionLocator;');
  });

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
      phase: 'reconcile',
      satisfied: true,
    }));
  });

  it('reconciles a changed ref through observation without redispatching', async () => {
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
        return { ok: false, result: { isError: true } };
      },
      seal: async () => ({}),
      sleep: async () => {},
    });

    expect(result).toMatchObject({ handled: true, terminal: false });
    expect(dispatches).toHaveLength(1);
    expect(dispatches.map((attempt) => ({
      attempt: attempt.attempt,
      retry: attempt.retry,
      ref: attempt.resolution.ref,
    }))).toEqual([
      { attempt: 1, retry: false, ref: 'old-ref' },
    ]);
    expect(result.diagnostics.dispatches.filter((attempt) => attempt.retry)).toHaveLength(0);
    expect(result.diagnostics.resolutions).toEqual([
      expect.objectContaining({ phase: 'initial', ok: true }),
    ]);
    expect(result.diagnostics.transitions).toContainEqual(expect.objectContaining({
      phase: 'reconcile',
      satisfied: true,
    }));
  });

  it('stops failed Click descendants but continues independent journal work', async () => {
    let rows = executionJournal.initializeExecutionJournal({
      approvedSteps: [
        transitionStep,
        { id: 'dependent-proof', action: 'Verify', dependsOnStepIds: ['submit'] },
        { id: 'independent-proof', action: 'Screenshot', independent: true },
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

    expect(dispatches).toHaveLength(1);
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
      failureType: 'qaai_execution_uncertainty',
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
    expect(diagnostics.observations).toHaveLength(6);
    expect(diagnostics.observations.every((item) => item.fresh && item.usable)).toBe(true);
    expect(diagnostics.observations.every((item) => item.fingerprint?.structuralHash)).toBe(true);
    expect(diagnostics.resolutions).toEqual([
      expect.objectContaining({ phase: 'initial', reason: 'clickable_control_resolved' }),
    ]);
    expect(diagnostics.dispatches).toEqual([
      expect.objectContaining({ attempt: 1, retry: false, ok: false }),
    ]);
    expect(diagnostics.transitions.length).toBeGreaterThanOrEqual(3);
    expect(diagnostics.transitions.every((item) => typeof item.satisfied === 'boolean')).toBe(true);
    expect(diagnostics.final).toMatchObject({
      status: 'blocked',
      retried: false,
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
      reason: 'click_effect_failed',
    });
    expect(sealedOutcome).not.toBeNull();
    expect(JSON.stringify(sealedOutcome)).not.toContain(secret);
    expect(sealedOutcome.diagnostics.observations).toHaveLength(6);
    expect(sealedOutcome.diagnostics.observations[0].source).toBe('fresh_pre_dispatch_observation');
    expect(sealedOutcome.diagnostics.observations.slice(1).every((item) => (
      ['fresh_reconcile_observation', 'fresh_post_dispatch_observation'].includes(item.source)
    ))).toBe(true);
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
