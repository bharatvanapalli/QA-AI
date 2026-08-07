import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const gatewayModule = require('../../server/services/actionExecutionGateway');
const mcp = require('../../server/services/mcp');

const verifiedTargetAuthorization = Object.freeze({
  schemaVersion: 'qaai-live-target-authorization-v1',
  status: 'verified',
  liveMutationAllowed: true,
  diagnosticOnly: false,
  isGuess: false,
  reason: 'verified_test_target',
});
const withVerifiedTarget = (options = {}) => ({
  ...options,
  targetAuthorization: verifiedTargetAuthorization,
});

describe('ActionExecutionGateway', () => {
  it('classifies browser mutations and keeps read-only evaluation permit-free', () => {
    expect(gatewayModule.isMutatingTool('browser_click', {})).toBe(true);
    expect(gatewayModule.isMutatingTool('browser_navigate', { url: 'https://example.test' })).toBe(true);
    expect(gatewayModule.isMutatingTool('browser_execute_cdp_command', {
      command: 'Network.setCookies', params: { cookies: [] },
    })).toBe(true);
    expect(gatewayModule.isMutatingTool('browser_snapshot', {})).toBe(false);
    expect(gatewayModule.isMutatingTool('browser_evaluate', { function: '() => document.title' })).toBe(false);
    expect(gatewayModule.isMutatingTool('browser_evaluate', { function: '() => document.querySelector("button").click()' })).toBe(true);
    expect(gatewayModule.isMutatingTool('browser_evaluate', { function: '() => localStorage.clear()' })).toBe(true);
    expect(gatewayModule.isMutatingTool('browser_click_xy', { x: 10, y: 20 })).toBe(true);
    expect(gatewayModule.requiresVerifiedSemanticTarget('browser_click', { target: 'e1' })).toBe(true);
    expect(gatewayModule.requiresVerifiedSemanticTarget('browser_navigate', { url: 'https://example.test' })).toBe(false);
    expect(gatewayModule.requiresVerifiedSemanticTarget('browser_press_key', { key: 'Escape' })).toBe(false);
    expect(gatewayModule.requiresVerifiedSemanticTarget('browser_press_key', { key: 'Enter', target: 'e1' })).toBe(true);
  });

  it('requires a one-use permit for direct CDP commands', () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {};
    const args = { command: 'Network.setCookies', params: { cookies: [] } };
    expect(() => gateway.authorizeMcpCall({
      session, toolName: 'browser_execute_cdp_command', args,
    })).toThrowError(expect.objectContaining({ code: 'ACTION_EXECUTION_PERMIT_REQUIRED' }));
    const permit = gateway.issueExecutionPermit({
      session,
      toolName: 'browser_execute_cdp_command',
      args,
      actionOccurrenceId: 'auth-fixture-cookies',
    });
    expect(gateway.authorizeMcpCall({
      session, toolName: 'browser_execute_cdp_command', args, permit,
    })).toMatchObject({ mutating: true, permit: { actionOccurrenceId: 'auth-fixture-cookies' } });
  });

  it('issues a one-use permit bound to session, tool, arguments, and occurrence', () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {};
    const args = { element: 'Save', target: 'e1' };
    const permit = gateway.issueExecutionPermit({
      session,
      toolName: 'browser_click',
      args,
      actionOccurrenceId: 'occurrence-1',
      transactionId: 'transaction-1',
      operationId: 'operation-1',
      origin: 'gateway_unit_test',
      phase: 'dispatch',
      attempt: 2,
    });
    expect(gateway.authorizeMcpCall({ session, toolName: 'browser_click', args, permit })).toMatchObject({
      authorized: true,
      mutating: true,
      permit: {
        actionOccurrenceId: 'occurrence-1',
        transactionId: 'transaction-1',
        operationId: 'operation-1',
        origin: 'gateway_unit_test',
        phase: 'dispatch',
        attempt: 2,
        toolName: 'browser_click',
      },
    });
    expect(() => gateway.authorizeMcpCall({ session, toolName: 'browser_click', args, permit })).toThrowError(expect.objectContaining({ code: 'ACTION_EXECUTION_PERMIT_REUSED' }));
  });

  it('rejects missing, wrong-tool, wrong-args, and wrong-session permits', () => {
    const cases = [
      [{}, 'browser_type', { element: 'Save', target: 'e1', text: 'x' }, 'ACTION_EXECUTION_PERMIT_TOOL_MISMATCH'],
      [{}, 'browser_click', { element: 'Other', target: 'e2' }, 'ACTION_EXECUTION_PERMIT_ARGS_MISMATCH'],
    ];
    for (const [sessionOverride, toolName, callArgs, code] of cases) {
      const gateway = gatewayModule.createActionExecutionGateway();
      const session = {};
      const args = { element: 'Save', target: 'e1' };
      const permit = gateway.issueExecutionPermit({ session, toolName: 'browser_click', args, actionOccurrenceId: `occurrence-${code}` });
      expect(() => gateway.authorizeMcpCall({ session: Object.keys(sessionOverride).length ? sessionOverride : session, toolName, args: callArgs, permit }))
        .toThrowError(expect.objectContaining({ code }));
    }
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {};
    const args = { element: 'Save', target: 'e1' };
    const permit = gateway.issueExecutionPermit({ session, toolName: 'browser_click', args, actionOccurrenceId: 'occurrence-session' });
    expect(() => gateway.authorizeMcpCall({ session: {}, toolName: 'browser_click', args, permit }))
      .toThrowError(expect.objectContaining({ code: 'ACTION_EXECUTION_PERMIT_SESSION_MISMATCH' }));
    expect(() => gateway.authorizeMcpCall({ session, toolName: 'browser_click', args, permit: null }))
      .toThrowError(expect.objectContaining({ code: 'ACTION_EXECUTION_PERMIT_REQUIRED' }));
  });

  it('owns MCP mutation dispatch while leaving observations unchanged', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {};
    const callTool = vi.fn(async (_session, toolName, _args, options) => {
      gateway.authorizeMcpCall({ session, toolName, args: _args, permit: options.executionPermit });
      return { ok: true };
    });
    await gateway.dispatchMcpTool({
      callTool, session, toolName: 'browser_click', args: { element: 'Save', target: 'e1' }, options: withVerifiedTarget(), actionOccurrenceId: 'occurrence-dispatch',
    });
    expect(callTool.mock.calls[0][3].executionPermit).toMatchObject({ version: gatewayModule.PERMIT_VERSION });

    await gateway.dispatchMcpTool({ callTool, session, toolName: 'browser_snapshot', args: {} });
    expect(callTool.mock.calls[1][3].executionPermit).toBeUndefined();
  });

  it('derives a landing oracle from the next exact authored state and skips generic page waits', () => {
    const oracle = gatewayModule.deriveLandingOracle({
      authoredNextStates: [
        { id: 'wait-page', action: 'WaitForState', target: 'destination page' },
        {
          id: 'fill-email',
          action: 'Fill',
          target: 'Email Address',
          targetIdentity: { role: 'textbox', accessibleName: 'Email Address' },
        },
      ],
    });
    expect(oracle).toEqual({
      schema: gatewayModule.LANDING_ORACLE_SCHEMA,
      kind: 'control_actionable',
      target: 'Email Address',
      role: 'textbox',
      sourceStepId: 'fill-email',
      source: 'authored_next_state',
    });
    expect(gatewayModule.deriveLandingOracle({
      authoredNextState: { id: 'generic-only', action: 'WaitForState', target: 'destination page' },
    })).toBeNull();
  });

  it('retries authored landing observation without redispatch and strips internal options from transport', async () => {
    let time = 0;
    const gateway = gatewayModule.createActionExecutionGateway({
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });
    const session = { id: 'targeted-wait-session' };
    const observeLandingOracle = vi.fn(async () => ({
      fresh: true,
      matched: observeLandingOracle.mock.calls.length >= 2,
      reason: 'email_not_actionable_yet',
    }));
    const callTool = vi.fn(async (_session, toolName, args, options) => {
      gateway.authorizeMcpCall({ session, toolName, args, permit: options.executionPermit });
      expect(options).not.toHaveProperty('authoredNextStates');
      expect(options).not.toHaveProperty('observeLandingOracle');
      expect(options).not.toHaveProperty('waitForLandingOracle');
      expect(options).not.toHaveProperty('targetAuthorization');
      expect(options).not.toHaveProperty('transactionId');
      expect(options).not.toHaveProperty('operationId');
      return { isError: false };
    });

    const result = await gateway.dispatchMcpTool({
      callTool,
      session,
      toolName: 'browser_click',
      args: { element: 'Sign in', target: 'e1' },
      actionOccurrenceId: 'sign-in-click-1',
      options: withVerifiedTarget({
        enforceExactlyOnce: true,
        mutationPhaseId: 'submit',
        waitForLandingOracle: true,
        authoredNextStates: [{
          id: 'fill-email', action: 'Fill', target: 'Email Address', role: 'textbox',
        }],
        observeLandingOracle,
        landingOracleTimeoutMs: 1_000,
        landingOraclePollIntervalMs: 100,
      }),
    });

    expect(callTool).toHaveBeenCalledOnce();
    expect(observeLandingOracle).toHaveBeenCalledTimes(2);
    expect(result.qaaiLandingOracleEvidence).toMatchObject({
      matched: true,
      kind: 'control_actionable',
      sourceStepId: 'fill-email',
      attempts: 2,
      reason: 'authored_next_control_actionable',
    });
    expect(result.qaaiLandingOracleEvidence).not.toHaveProperty('target');
    expect(session.actionExecutionOccurrenceState['sign-in-click-1::submit']).toMatchObject({
      status: 'dispatched',
      dispatchAttemptCount: 1,
      landingOracleMatched: true,
      landingOracleKind: 'control_actionable',
      landingOracleTargetDigest: expect.any(String),
    });
  });

  it('matches an authored URL directly without accepting generic page fingerprints', () => {
    const oracle = gatewayModule.deriveLandingOracle({
      authoredNextState: { id: 'dashboard', action: 'WaitForState', expectedUrl: '/dashboard' },
    });
    expect(gatewayModule.evaluateLandingOracleObservation({
      oracle,
      observation: { fresh: true, url: 'https://example.test/dashboard?from=login' },
    })).toEqual({ matched: true, reason: 'authored_url_reached' });
    expect(gatewayModule.evaluateLandingOracleObservation({
      oracle: { kind: 'control_actionable', target: 'Email Address' },
      observation: { fresh: true, fingerprintStable: true },
    })).toEqual({ matched: false, reason: 'authored_next_control_not_actionable' });
  });

  it('requires every exact fill target to be visible and editable', () => {
    const requirements = gatewayModule.targetActionabilityRequirements('browser_fill_form', {
      fields: [
        { name: 'Email', target: 'e1' },
        { name: 'Company', target: 'e2' },
      ],
    });
    expect(requirements).toMatchObject({
      required: true,
      editable: true,
      refs: ['e1', 'e2'],
    });
    expect(gatewayModule.evaluateTargetActionabilitySnapshot({
      requirements,
      snapshotText: '- textbox "Email" [ref=e1]\n- textbox "Company" [ref=e2]',
    })).toEqual({ matched: true, fresh: true, reason: 'exact_target_editable' });
    expect(gatewayModule.evaluateTargetActionabilitySnapshot({
      requirements,
      snapshotText: '- textbox "Email" [ref=e1]\n- textbox "Company" [ref=e2] [readonly]',
    })).toEqual({ matched: false, fresh: true, reason: 'exact_target_not_editable' });
    expect(gatewayModule.evaluateTargetActionabilitySnapshot({
      requirements: gatewayModule.targetActionabilityRequirements('browser_click', { target: 'e3' }),
      snapshotText: '- button "Continue" [ref=e3] [disabled]',
    })).toEqual({ matched: false, fresh: true, reason: 'exact_target_not_actionable' });
  });

  it('polls exact target readiness before issuing one mutation permit', async () => {
    let time = 0;
    const order = [];
    const gateway = gatewayModule.createActionExecutionGateway({
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });
    const session = { id: 'pre-dispatch-readiness' };
    const observeTargetActionability = vi.fn(async () => {
      order.push('observe');
      return observeTargetActionability.mock.calls.length >= 2
        ? { matched: true, reason: 'exact_target_actionable' }
        : { matched: false, reason: 'exact_target_ref_not_visible' };
    });
    const callTool = vi.fn(async (_session, toolName, args, options) => {
      order.push('dispatch');
      gateway.authorizeMcpCall({ session, toolName, args, permit: options.executionPermit });
      expect(options).not.toHaveProperty('observeTargetActionability');
      expect(options).not.toHaveProperty('requireActionableTarget');
      return { isError: false };
    });
    const result = await gateway.dispatchMcpTool({
      callTool,
      session,
      toolName: 'browser_click',
      args: { element: 'Continue', target: 'e3' },
      actionOccurrenceId: 'continue-ready-1',
      options: withVerifiedTarget({
        enforceExactlyOnce: true,
        mutationPhaseId: 'click',
        requireActionableTarget: true,
        observeTargetActionability,
        targetActionabilityTimeoutMs: 1_000,
        targetActionabilityPollIntervalMs: 100,
      }),
    });
    expect(order).toEqual(['observe', 'observe', 'dispatch']);
    expect(callTool).toHaveBeenCalledOnce();
    expect(result.qaaiTargetActionabilityEvidence).toMatchObject({
      matched: true,
      editable: false,
      attempts: 2,
      reason: 'exact_target_actionable',
    });
    expect(result.qaaiTargetActionabilityEvidence).not.toHaveProperty('refs');
    expect(session.actionExecutionOccurrenceState['continue-ready-1::click']).toMatchObject({
      dispatchAttemptCount: 1,
      targetActionabilityMatched: true,
      targetActionabilityTargetDigest: expect.any(String),
    });
  });

  it('fails closed before permit issuance when the exact target never becomes actionable', async () => {
    let time = 0;
    const gateway = gatewayModule.createActionExecutionGateway({
      now: () => time,
      sleep: async (milliseconds) => { time += milliseconds; },
    });
    const session = { id: 'pre-dispatch-timeout' };
    const callTool = vi.fn();
    await expect(gateway.dispatchMcpTool({
      callTool,
      session,
      toolName: 'browser_type',
      args: { element: 'Email', target: 'e1', text: 'user@example.test' },
      actionOccurrenceId: 'email-not-ready-1',
      options: withVerifiedTarget({
        requireActionableTarget: true,
        observeTargetActionability: async () => ({ matched: false, reason: 'exact_target_not_editable' }),
        targetActionabilityTimeoutMs: 200,
        targetActionabilityPollIntervalMs: 100,
      }),
    })).rejects.toMatchObject({
      code: 'ACTION_EXECUTION_TARGET_NOT_ACTIONABLE',
      targetReason: 'timeout:exact_target_not_editable',
      editableRequired: true,
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(gateway.pendingPermitCount()).toBe(0);
    expect(session.actionExecutionOccurrenceState).toBeUndefined();
  });

  it('rejects weak or guessed live targets without relying on an opt-in flag', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {};
    const callTool = vi.fn();
    await expect(gateway.dispatchMcpTool({
      callTool,
      session,
      toolName: 'browser_click',
      args: { element: 'Save', target: 'e1' },
      options: {
        targetAuthorization: {
          status: 'unverified',
          liveMutationAllowed: false,
          isGuess: true,
          reason: 'snapshot_ref_fallback',
        },
      },
      actionOccurrenceId: 'weak-target-click',
    })).rejects.toMatchObject({ code: 'ACTION_EXECUTION_TARGET_UNVERIFIED' });
    expect(callTool).not.toHaveBeenCalled();
    expect(gateway.pendingPermitCount()).toBe(0);
  });

  it('persists intent and dispatch start before one browser call, then blocks duplicate dispatch', async () => {
    let time = 0;
    const gateway = gatewayModule.createActionExecutionGateway({ now: () => ++time });
    const order = [];
    const session = {
      id: 'exactly-once-session',
      persistActionExecutionOccurrence: vi.fn(async (state) => order.push(`persist:${state.status}`)),
    };
    const args = { element: 'Save', target: 'e1' };
    const callTool = vi.fn(async (_session, toolName, callArgs, options) => {
      order.push('dispatch');
      gateway.authorizeMcpCall({ session, toolName, args: callArgs, permit: options.executionPermit });
      return { isError: false, browserEventEvidence: { eventId: 'event-1' } };
    });
    const request = {
      callTool,
      session,
      toolName: 'browser_click',
      args,
      options: withVerifiedTarget({ enforceExactlyOnce: true, mutationPhaseId: 'submit' }),
      actionOccurrenceId: 'save-click-1',
      source: 'exactly_once_test',
    };

    await gateway.dispatchMcpTool(request);
    expect(order).toEqual([
      'persist:intent_persisted',
      'persist:dispatch_started',
      'dispatch',
      'persist:dispatched',
    ]);
    expect(callTool).toHaveBeenCalledOnce();
    const state = session.actionExecutionOccurrenceState['save-click-1::submit'];
    expect(state).toMatchObject({
      status: 'dispatched',
      dispatchAttemptCount: 1,
      browserEventObservedAt: expect.any(Number),
    });
    expect(state).not.toHaveProperty('args');
    await expect(gateway.dispatchMcpTool(request))
      .rejects.toMatchObject({ code: 'ACTION_EXECUTION_DUPLICATE_DISPATCH_BLOCKED' });
    expect(callTool).toHaveBeenCalledOnce();

    await gateway.recordOccurrencePostcondition({
      session,
      actionOccurrenceId: 'save-click-1',
      mutationPhaseId: 'submit',
      proof: { matched: true, reason: 'save_confirmation_visible' },
    });
    const committed = await gateway.commitOccurrence({
      session,
      actionOccurrenceId: 'save-click-1',
      mutationPhaseId: 'submit',
    });
    expect(committed).toMatchObject({
      status: 'committed',
      postconditionMatched: true,
      postconditionReason: 'save_confirmation_visible',
      committedAt: expect.any(Number),
    });
  });

  it('fails closed before browser dispatch when durable occurrence persistence is refused', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {
      persistActionExecutionOccurrence: vi.fn(async () => ({ persisted: false, reason: 'durable_store_unavailable' })),
    };
    const callTool = vi.fn();
    await expect(gateway.dispatchMcpTool({
      callTool,
      session,
      toolName: 'browser_click',
      args: { element: 'Save', target: 'e1' },
      options: withVerifiedTarget({ enforceExactlyOnce: true }),
      actionOccurrenceId: 'persistence-required',
    })).rejects.toMatchObject({ code: 'ACTION_EXECUTION_PERSISTENCE_REQUIRED' });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('classifies scrollIntoView evaluation as a once-per-phase mutation', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = {};
    const args = { function: '() => document.querySelector("#target").scrollIntoView({ block: "center" })' };
    expect(gatewayModule.isMutatingBrowserEvaluate('browser_evaluate', args)).toBe(true);
    const callTool = vi.fn(async (_session, toolName, callArgs, options) => {
      gateway.authorizeMcpCall({ session, toolName, args: callArgs, permit: options.executionPermit });
      return { isError: false };
    });
    const request = {
      callTool,
      session,
      toolName: 'browser_evaluate',
      args,
      options: withVerifiedTarget({ enforceExactlyOnce: true, mutationPhaseId: 'semantic-reveal:scroll-content' }),
      actionOccurrenceId: 'reveal-target-1',
    };
    await gateway.dispatchMcpTool(request);
    await expect(gateway.dispatchMcpTool(request))
      .rejects.toMatchObject({ code: 'ACTION_EXECUTION_DUPLICATE_DISPATCH_BLOCKED' });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it('allows a replacement dispatch only after positive non-delivery proof', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const session = { id: 'non-delivery-session' };
    const args = { element: 'Continue', target: 'e2' };
    const callTool = vi.fn(async (_session, toolName, callArgs, options) => {
      gateway.authorizeMcpCall({ session, toolName, args: callArgs, permit: options.executionPermit });
      return callTool.mock.calls.length === 1
        ? { delivered: false, positivelyNotDelivered: true }
        : { delivered: true };
    });
    const base = {
      callTool,
      session,
      toolName: 'browser_click',
      args,
      actionOccurrenceId: 'continue-click-1',
      source: 'non_delivery_test',
    };
    await gateway.dispatchMcpTool({
      ...base, options: withVerifiedTarget({ enforceExactlyOnce: true, mutationPhaseId: 'continue' }),
    });
    expect(session.actionExecutionOccurrenceState['continue-click-1::continue'].status).toBe('not_delivered');
    await gateway.dispatchMcpTool({
      ...base,
      options: withVerifiedTarget({
        enforceExactlyOnce: true,
        mutationPhaseId: 'continue',
        positiveNonDeliveryProof: { proven: true, reason: 'transport_rejected_before_send' },
      }),
    });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(session.actionExecutionOccurrenceState['continue-click-1::continue']).toMatchObject({
      status: 'dispatched',
      dispatchAttemptCount: 2,
    });
  });

  it('loads a durable occurrence after restart and blocks duplicate dispatch before the browser call', async () => {
    const persisted = new Map();
    const args = { element: 'Save', target: 'e1' };
    const firstGateway = gatewayModule.createActionExecutionGateway();
    const firstSession = {
      persistActionExecutionOccurrence: vi.fn(async (state) => persisted.set(state.occurrenceKey, { ...state })),
    };
    const firstCall = vi.fn(async (_session, toolName, callArgs, options) => {
      firstGateway.authorizeMcpCall({ session: firstSession, toolName, args: callArgs, permit: options.executionPermit });
      return { delivered: true };
    });
    await firstGateway.dispatchMcpTool({
      callTool: firstCall,
      session: firstSession,
      toolName: 'browser_click',
      args,
      options: withVerifiedTarget({ enforceExactlyOnce: true, mutationPhaseId: 'submit' }),
      actionOccurrenceId: 'restart-save',
    });

    const restartedGateway = gatewayModule.createActionExecutionGateway();
    const restartedSession = {
      loadActionExecutionOccurrence: vi.fn(async ({ occurrenceKey }) => persisted.get(occurrenceKey) || null),
      persistActionExecutionOccurrence: vi.fn(async (state) => persisted.set(state.occurrenceKey, { ...state })),
    };
    const restartedCall = vi.fn();
    await expect(restartedGateway.dispatchMcpTool({
      callTool: restartedCall,
      session: restartedSession,
      toolName: 'browser_click',
      args,
      options: withVerifiedTarget({ enforceExactlyOnce: true, mutationPhaseId: 'submit' }),
      actionOccurrenceId: 'restart-save',
    })).rejects.toMatchObject({ code: 'ACTION_EXECUTION_DUPLICATE_DISPATCH_BLOCKED' });
    expect(restartedSession.loadActionExecutionOccurrence).toHaveBeenCalledOnce();
    expect(restartedCall).not.toHaveBeenCalled();
  });

  it('reconciles an interrupted dispatch by observation and commits without redispatch', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const persistedState = {
      schemaVersion: 'qaai-action-execution-occurrence-v1',
      occurrenceKey: 'resume-save::submit',
      actionOccurrenceId: 'resume-save',
      mutationPhaseId: 'submit',
      toolName: 'browser_click',
      argsDigest: 'not-used-by-this-reconciliation-probe',
      status: 'dispatch_started',
      dispatchAttemptCount: 1,
    };
    // Let the gateway validate only the stable occurrence identity here; the
    // duplicate-dispatch test above covers tool/args digest matching.
    const states = new Map([['resume-save::submit', persistedState]]);
    const session = {
      loadActionExecutionOccurrence: vi.fn(async ({ occurrenceKey }) => states.get(occurrenceKey) || null),
      persistActionExecutionOccurrence: vi.fn(async (state) => states.set(state.occurrenceKey, { ...state })),
    };
    const observe = vi.fn(async () => ({ matched: true, checked: true, reason: 'save_confirmation_visible' }));
    const result = await gateway.reconcileOccurrenceOnResume({
      session,
      actionOccurrenceId: 'resume-save',
      mutationPhaseId: 'submit',
      observe,
    });
    expect(result).toMatchObject({ reconciled: true, committed: true, shouldRedispatch: false });
    expect(result.state).toMatchObject({ status: 'committed', postconditionMatched: true, dispatchAttemptCount: 1 });
    expect(observe).toHaveBeenCalledOnce();
  });

  it('keeps uncertain resumed delivery observation-only until positive non-delivery is proven', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const states = new Map([['resume-next::action', {
      schemaVersion: 'qaai-action-execution-occurrence-v1',
      occurrenceKey: 'resume-next::action',
      actionOccurrenceId: 'resume-next',
      mutationPhaseId: 'action',
      toolName: 'browser_click',
      argsDigest: 'digest-not-validated-in-this-probe',
      status: 'delivery_uncertain',
      dispatchAttemptCount: 1,
    }]]);
    const session = {
      loadActionExecutionOccurrence: vi.fn(async ({ occurrenceKey }) => states.get(occurrenceKey) || null),
      persistActionExecutionOccurrence: vi.fn(async (state) => states.set(state.occurrenceKey, { ...state })),
    };
    const uncertain = await gateway.reconcileOccurrenceOnResume({
      session,
      actionOccurrenceId: 'resume-next',
      observe: vi.fn(async () => ({ matched: null, checked: false, reason: 'snapshot_delayed' })),
      maxObservationAttempts: 2,
    });
    expect(uncertain).toMatchObject({ reconciled: true, committed: false, shouldRedispatch: false });
    expect(uncertain.state).toMatchObject({ status: 'reconciliation_pending', dispatchAttemptCount: 1, reconciliationAttemptCount: 2 });

    const notDelivered = await gateway.reconcileOccurrenceOnResume({
      session,
      actionOccurrenceId: 'resume-next',
      observe: vi.fn(async () => ({ delivered: false, proven: true, positivelyNotDelivered: true })),
    });
    expect(notDelivered).toMatchObject({ reconciled: true, shouldRedispatch: true, reason: 'positive_non_delivery_proven' });
    expect(notDelivered.state.status).toBe('not_delivered');
  });

  it('blocks raw SDK mutations that do not carry coordinator authorization', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const rawCallTool = vi.fn(async () => ({ ok: true }));
    const session = { id: 'raw-session', client: { callTool: rawCallTool } };
    gateway.protectMcpSessionClient(session, { source: 'raw_sdk_test' });

    await session.client.callTool({ name: 'browser_snapshot', arguments: {} });
    expect(session.actionExecutionGatewayTrail).toBeUndefined();
    await expect(session.client.callTool({
      name: 'browser_click', arguments: { element: 'Save', target: 'e1' },
    })).rejects.toMatchObject({ code: 'ACTION_EXECUTION_GATEWAY_BYPASS' });
    expect(rawCallTool).toHaveBeenCalledTimes(1);
    expect(session.actionExecutionGatewayTrail).toEqual([
      expect.objectContaining({
        bypassAttemptId: 'raw-sdk:raw-session:browser_click:1',
        toolName: 'browser_click',
        source: 'raw_sdk_test',
        rawSdkCaller: true,
        blocked: true,
      }),
    ]);
    expect(session.actionExecutionGatewayTrail[0]).not.toHaveProperty('args');
  });

  it('accepts an exact consumed-permit SDK marker only once', async () => {
    const gateway = gatewayModule.createActionExecutionGateway();
    const rawCallTool = vi.fn(async () => ({ ok: true }));
    const session = { id: 'marked-session', client: { callTool: rawCallTool } };
    gateway.protectMcpSessionClient(session);
    const args = { element: 'Save', target: 'e1' };
    const permit = gateway.issueExecutionPermit({
      session, toolName: 'browser_click', args, actionOccurrenceId: 'marked-occurrence',
    });
    const authorization = gateway.consumeExecutionPermit({
      session, toolName: 'browser_click', args, permit,
    });
    const requestOptions = gateway.markSdkCallAuthorized({}, { session, authorization });

    await session.client.callTool({ name: 'browser_click', arguments: args }, undefined, requestOptions);
    expect(session.actionExecutionGatewayTrail).toBeUndefined();
    await expect(session.client.callTool({ name: 'browser_click', arguments: args }, undefined, requestOptions))
      .rejects.toMatchObject({ code: 'ACTION_EXECUTION_GATEWAY_BYPASS' });
    expect(session.actionExecutionGatewayTrail).toHaveLength(1);
    expect(session.actionExecutionGatewayTrail[0]).toMatchObject({ rawSdkCaller: true, blocked: true });
  });

  it('dispatches a direct Playwright mutation once with lifecycle evidence', async () => {
    let time = 100;
    const gateway = gatewayModule.createActionExecutionGateway({ now: () => ++time });
    const session = { id: 'playwright-session' };
    const dispatch = vi.fn(async () => 'navigated');
    await expect(gateway.dispatchBrowserMutation({
      session,
      mutationName: 'playwright_page_goto',
      args: { url: 'https://example.test' },
      actionOccurrenceId: 'playwright-goto-1',
      source: 'bootstrap_test',
      dispatch,
    })).resolves.toBe('navigated');
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(session.actionExecutionGatewayTrail).toEqual([
      expect.objectContaining({
        actionOccurrenceId: 'playwright-goto-1',
        toolName: 'playwright_page_goto',
        source: 'bootstrap_test',
        browserAdapter: true,
      }),
    ]);
    expect(session.actionExecutionGatewayTrail[0].dispatchCompletedAt)
      .toBeGreaterThan(session.actionExecutionGatewayTrail[0].dispatchStartedAt);
    expect(session.actionExecutionGatewayTrail[0]).not.toHaveProperty('args');
    expect(session.actionExecutionGatewayTrail[0]).toMatchObject({
      transactionId: 'transaction:playwright-goto-1',
      operationId: 'playwright-goto-1:playwright_page_goto',
      phase: 'playwright_page_goto',
      attempt: 1,
    });
    expect(session.actionExecutionOccurrenceState['playwright-goto-1::playwright_page_goto']).toMatchObject({
      status: 'dispatched',
      transactionId: 'transaction:playwright-goto-1',
      operationId: 'playwright-goto-1:playwright_page_goto',
      dispatchAttemptCount: 1,
    });
  });

  it('integrates with the MCP boundary for opted-in sessions', () => {
    const session = { executionGatewayRequired: true };
    expect(() => mcp._authorizeExecutionGatewayCall(session, 'browser_click', { target: 'e1' }))
      .toThrowError(expect.objectContaining({ code: 'ACTION_EXECUTION_PERMIT_REQUIRED' }));
    expect(mcp._authorizeExecutionGatewayCall(session, 'browser_snapshot', {})).toMatchObject({ mutating: false });
  });
});
