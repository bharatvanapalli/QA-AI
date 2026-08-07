import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  CONTINUATION_DISPOSITION,
} = require('../../server/services/browserTransactionContract');
const {
  PROOF_STATUS,
  EVIDENCE_TIER,
  createProofContract,
} = require('../../server/services/browserProofContract');
const {
  RESOLUTION_STATUS,
  DELIVERY_STATUS,
  dispatchWindow,
  createBrowserTransactionController,
} = require('../../server/services/browserTransactionController');

function action(overrides = {}) {
  return {
    schemaVersion: 'OperationContractV2',
    operationId: 'action:login:email',
    actionOccurrenceId: 'occurrence:action:login:email:1',
    kind: 'action',
    type: 'Fill',
    targetIdentity: { role: 'textbox', accessibleName: 'Email address' },
    required: true,
    ...overrides,
  };
}

function proofContract(id, claimId) {
  return createProofContract({
    id,
    alternatives: [{ id: 'exact-browser-truth', allOf: [claimId] }],
  });
}

function baseDependencies(overrides = {}) {
  return {
    resolver: vi.fn().mockResolvedValue({
      status: RESOLUTION_STATUS.RESOLVED,
      target: { role: 'textbox', accessibleName: 'Email address' },
      factRefs: ['resolution:email'],
    }),
    planner: vi.fn().mockReturnValue({
      mutation: { toolName: 'browser_fill', args: { target: 'e1', text: 'qa@example.test' } },
      proofContract: proofContract('fill-email', 'email_owner_value'),
    }),
    gateway: {
      dispatch: vi.fn().mockResolvedValue({
        dispatchAttemptId: 'dispatch:email:1',
        deliveryStatus: DELIVERY_STATUS.DELIVERED,
        factRefs: ['dispatch:email:1'],
      }),
    },
    observer: vi.fn()
      .mockResolvedValueOnce({ claims: [], factRefs: ['snapshot:before'] })
      .mockResolvedValueOnce({
        claims: [{
          claimId: 'email_owner_value',
          status: PROOF_STATUS.MATCHED,
          tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
          source: 'live_owner',
          factRef: 'owner-readback:email',
        }],
      }),
    ...overrides,
  };
}

describe('BrowserTransactionController', () => {
  it('refreshes and re-resolves the same target before dispatch when the first snapshot is ambiguous', async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce({
        status: RESOLUTION_STATUS.AMBIGUOUS,
        reason: 'multiple_semantic_snapshot_targets',
        factRefs: ['snapshot:ambiguous'],
      })
      .mockResolvedValueOnce({
        status: RESOLUTION_STATUS.RESOLVED,
        target: { role: 'textbox', accessibleName: 'Email address' },
        factRefs: ['snapshot:fresh', 'resolution:email'],
      });
    const dependencies = baseDependencies({ resolver });
    const controller = createBrowserTransactionController({
      ...dependencies,
      defaultResolutionAttempts: 3,
    });
    const result = await controller.execute(action());

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(2, expect.objectContaining({
      context: expect.objectContaining({
        resolutionAttempt: 2,
        forceFreshSnapshot: true,
      }),
    }));
    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
  });

  it('fills email once and commits from exact owner readback', async () => {
    const dependencies = baseDependencies();
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action());

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
      proofRefs: expect.arrayContaining(['owner-readback:email']),
    });
  });

  it('reveals and focuses the exact text owner before one fill, then re-resolves after reveal', async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce({
        status: RESOLUTION_STATUS.RESOLVED,
        target: { ref: 'email-before-reveal', role: 'textbox', accessibleName: 'Email address' },
        factRefs: ['resolution:email:before-reveal'],
      })
      .mockResolvedValueOnce({
        status: RESOLUTION_STATUS.RESOLVED,
        target: { ref: 'email-after-reveal', role: 'textbox', accessibleName: 'Email address' },
        factRefs: ['resolution:email:after-reveal'],
      });
    const planner = vi.fn().mockImplementation(({ resolution }) => ({
      preDispatchMutation: {
        toolName: 'browser_evaluate',
        phaseId: 'reveal-owner',
        args: {
          target: resolution.target.ref,
          function: 'exact-owner-reveal',
        },
      },
      mutation: {
        toolName: 'browser_fill',
        args: { target: resolution.target.ref, text: 'qa@example.test' },
      },
      proofContract: proofContract('fill-email', 'email_owner_value'),
    }));
    const gateway = {
      dispatch: vi.fn()
        .mockResolvedValueOnce({
          dispatchAttemptId: 'dispatch:email:reveal-owner:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERED,
          browserAcknowledged: true,
          acknowledgmentKind: 'browser_evaluate_semantic_acknowledgment',
          factRefs: ['delivery:email:reveal-owner'],
        })
        .mockResolvedValueOnce({
          dispatchAttemptId: 'dispatch:email:action:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERED,
          browserAcknowledged: true,
          acknowledgmentKind: 'browser_fill_returned',
          factRefs: ['delivery:email:action'],
        }),
    };
    const observer = vi.fn()
      .mockResolvedValueOnce({ claims: [], factRefs: ['snapshot:before'] })
      .mockResolvedValueOnce({
        claims: [{
          claimId: 'email_owner_value',
          status: PROOF_STATUS.MATCHED,
          tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
          source: 'live_owner',
          factRef: 'owner-readback:email',
        }],
      });
    const controller = createBrowserTransactionController({
      ...baseDependencies(),
      resolver,
      planner,
      gateway,
      observer,
      defaultDeadlineMs: 8_000,
    });
    const result = await controller.execute(action());

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenNthCalledWith(2, expect.objectContaining({
      context: expect.objectContaining({
        forceFreshSnapshot: true,
        recoveryDirective: 'RERESOLVE_SAME_TARGET_AFTER_REVEAL',
      }),
    }));
    expect(gateway.dispatch).toHaveBeenCalledTimes(2);
    expect(gateway.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      plan: expect.objectContaining({
        mutation: expect.objectContaining({
          toolName: 'browser_evaluate',
          phaseId: 'reveal-owner',
          args: expect.objectContaining({ target: 'email-before-reveal' }),
        }),
      }),
    }));
    expect(gateway.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      plan: expect.objectContaining({
        mutation: expect.objectContaining({
          toolName: 'browser_fill',
          args: expect.objectContaining({ target: 'email-after-reveal' }),
        }),
      }),
    }));
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      proofRefs: expect.arrayContaining([
        'delivery:email:reveal-owner',
        'delivery:email:action',
        'owner-readback:email',
      ]),
    });
  });

  it('does not fill when exact owner reveal is unproven and does not terminate the run', async () => {
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        preDispatchMutation: {
          toolName: 'browser_evaluate',
          phaseId: 'reveal-owner',
          args: { target: 'e1', function: 'exact-owner-reveal' },
        },
        mutation: { toolName: 'browser_fill', args: { target: 'e1', text: 'qa@example.test' } },
        proofContract: proofContract('fill-email', 'email_owner_value'),
      }),
      gateway: {
        dispatch: vi.fn().mockResolvedValue({
          dispatchAttemptId: 'dispatch:email:reveal-owner:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
          browserAcknowledged: false,
          reason: 'exact_owner_reveal_unproven',
          factRefs: ['delivery:email:reveal-owner:uncertain'],
        }),
      },
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action());

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      reason: 'exact_owner_reveal_unproven',
      continuation: {
        disposition: CONTINUATION_DISPOSITION.CONTINUE,
        skipDependents: false,
        terminationReason: null,
      },
    });
  });

  it('does not repeat an already-attempted owner reveal before the undispatched fill', async () => {
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        preDispatchMutation: {
          toolName: 'browser_evaluate',
          phaseId: 'reveal-owner',
          args: { target: 'e1', function: 'exact-owner-reveal' },
        },
        mutation: { toolName: 'browser_fill', args: { target: 'e1', text: 'qa@example.test' } },
        proofContract: proofContract('fill-email', 'email_owner_value'),
      }),
      gateway: {
        dispatch: vi.fn().mockResolvedValue({
          dispatchAttemptId: 'dispatch:email:action:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERED,
          browserAcknowledged: true,
          acknowledgmentKind: 'browser_fill_returned',
          factRefs: ['delivery:email:action'],
        }),
      },
      observer: vi.fn()
        .mockResolvedValueOnce({ claims: [], factRefs: ['snapshot:before'] })
        .mockResolvedValueOnce({
          claims: [{
            claimId: 'email_owner_value',
            status: PROOF_STATUS.MATCHED,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            factRef: 'owner-readback:email',
          }],
        }),
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action(), {
      autonomousRecoveryCycle: 1,
      autonomousRecoveryReason: 'BROWSER_TRANSACTION_EXACT_OWNER_REVEAL_DEADLINE',
      forceFreshSnapshot: true,
      preDispatchMutationAlreadyAttempted: true,
    });

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(dependencies.gateway.dispatch.mock.calls[0][0].plan.mutation).toMatchObject({
      toolName: 'browser_fill',
      args: { target: 'e1', text: 'qa@example.test' },
    });
    expect(result.terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
  });

  it('does not terminate descendants for a recoverable utility non-delivery', async () => {
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        mutation: {
          toolName: 'browser_evaluate',
          args: { function: 'reveal authored section' },
        },
        proofContract: proofContract('reveal-section', 'target_visible'),
      }),
      gateway: {
        dispatch: vi.fn().mockResolvedValue({
          dispatchAttemptId: 'dispatch:reveal:1',
          deliveryStatus: DELIVERY_STATUS.NOT_DELIVERED,
          reason: 'semantic_target_not_found',
          recoverable: true,
          factRefs: ['delivery:reveal:not-found'],
        }),
      },
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action({
      operationId: 'action:order:reveal-references',
      actionOccurrenceId: 'occurrence:action:order:reveal-references:1',
      type: 'Scroll',
      targetIdentity: { role: 'region', accessibleName: 'References' },
    }));

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      reason: 'semantic_target_not_found',
      continuation: {
        disposition: CONTINUATION_DISPOSITION.CONTINUE,
        continueIndependent: true,
        skipDependents: false,
        terminationReason: null,
      },
    });
  });

  it('keeps observing an exact owner mismatch without redispatching the fill', async () => {
    const mismatch = {
      claims: [{
        claimId: 'email_owner_value',
        status: PROOF_STATUS.MISMATCH,
        tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
        source: 'live_owner',
        factRef: 'owner-readback:empty',
        reason: 'text_input_owner_value_not_committed',
      }],
    };
    const dependencies = baseDependencies({
      observer: vi.fn()
        .mockResolvedValueOnce({ claims: [], factRefs: ['snapshot:before'] })
        .mockResolvedValueOnce(mismatch)
        .mockResolvedValueOnce(mismatch)
        .mockResolvedValueOnce({
          claims: [{
            claimId: 'email_owner_value',
            status: PROOF_STATUS.MATCHED,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            source: 'live_owner',
            factRef: 'owner-readback:committed',
          }],
        }),
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action());

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(dependencies.observer).toHaveBeenCalledTimes(4);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      proofRefs: expect.arrayContaining(['owner-readback:committed']),
    });
  });

  it('passes the exact delivery fact only to post-dispatch observation', async () => {
    const observer = vi.fn()
      .mockResolvedValueOnce({ claims: [], factRefs: ['snapshot:before'] })
      .mockImplementationOnce(({ delivery }) => ({
        claims: [{
          claimId: 'email_fill_acknowledged',
          status: delivery?.browserAcknowledged === true
            ? PROOF_STATUS.MATCHED
            : PROOF_STATUS.UNKNOWN,
          tier: EVIDENCE_TIER.BROWSER_EVENT,
          source: 'browser_fill_acknowledgment',
          factRef: delivery?.factRefs?.[0],
        }],
      }));
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        mutation: { toolName: 'browser_fill', args: { target: 'e1', text: 'qa@example.test' } },
        proofContract: proofContract('fill-email-ack', 'email_fill_acknowledged'),
      }),
      gateway: {
        dispatch: vi.fn().mockResolvedValue({
          dispatchAttemptId: 'dispatch:email:ack:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERED,
          browserAcknowledged: true,
          acknowledgmentKind: 'browser_fill_returned',
          factRefs: ['delivery:email:ack'],
        }),
      },
      observer,
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action());

    expect(observer).toHaveBeenNthCalledWith(1, expect.objectContaining({ delivery: null }));
    expect(observer).toHaveBeenNthCalledWith(2, expect.objectContaining({
      delivery: expect.objectContaining({
        browserAcknowledged: true,
        acknowledgmentKind: 'browser_fill_returned',
      }),
    }));
    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
      proofRefs: expect.arrayContaining(['delivery:email:ack']),
    });
  });

  it('continues after Sign in when the next password control is actionable', async () => {
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        mutation: { toolName: 'browser_click', args: { target: 'e2' } },
        proofContract: createProofContract({
          id: 'click-sign-in',
          alternatives: [
            { id: 'destination', allOf: ['auth_destination'] },
            { id: 'next-control', allOf: ['password_actionable'] },
          ],
        }),
      }),
      observer: vi.fn()
        .mockResolvedValueOnce({ claims: [] })
        .mockResolvedValueOnce({
          claims: [{
            claimId: 'password_actionable',
            status: PROOF_STATUS.MATCHED,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            source: 'playwright_locator',
            factRef: 'control:password',
          }, {
            claimId: 'password_actionable',
            status: PROOF_STATUS.MISMATCH,
            tier: EVIDENCE_TIER.BROWSER_EVENT,
            source: 'navigation_event_recorder',
            factRef: 'event:navigation-missing',
          }],
        }),
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action({
      operationId: 'action:login:sign-in',
      actionOccurrenceId: 'occurrence:action:login:sign-in:1',
      type: 'Click',
      targetIdentity: { role: 'button', accessibleName: 'Sign in' },
    }));

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
    });
  });

  it('passes later authored operations to post-dispatch evidence reconciliation', async () => {
    const laterOperations = [{
      operationId: 'action:login:password',
      type: 'Fill',
      targetIdentity: { role: 'textbox', accessibleName: 'Password' },
    }];
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        mutation: { toolName: 'browser_click', args: { target: 'e2' } },
        proofContract: proofContract('click-next', 'next_required_control_actionable'),
      }),
      observer: vi.fn()
        .mockResolvedValueOnce({ claims: [] })
        .mockImplementationOnce(({ context }) => ({
          claims: [{
            claimId: 'next_required_control_actionable',
            status: context.laterOperations === laterOperations
              ? PROOF_STATUS.MATCHED
              : PROOF_STATUS.UNKNOWN,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            source: 'next_required_control',
            factRef: 'control:password',
          }],
        })),
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action({
      operationId: 'action:login:next',
      actionOccurrenceId: 'occurrence:action:login:next:1',
      type: 'Click',
    }), { laterOperations });

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
    });
  });

  it('reconciles uncertain delivery without redispatching', async () => {
    const dispatch = vi.fn().mockRejectedValue(Object.assign(
      new Error('transport response lost'),
      { code: 'TRANSPORT_RESPONSE_LOST' },
    ));
    const dependencies = baseDependencies({ gateway: { dispatch } });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
    expect(result.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toState: CONTROLLER_STATE.DISPATCHED,
        deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
      }),
    ]));
  });

  it('reserves post-dispatch observation time when the gateway reply never arrives', async () => {
    const dispatch = vi.fn(() => new Promise(() => {}));
    const heartbeat = vi.fn();
    const dependencies = baseDependencies({ gateway: { dispatch } });
    const controller = createBrowserTransactionController({
      ...dependencies,
      heartbeat,
      defaultDeadlineMs: 120,
      defaultObservationAttempts: 1,
    });

    const result = await controller.execute(action());

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      remainingMs: expect.any(Number),
    }));
    expect(dispatch.mock.calls[0][0].remainingMs).toBeLessThan(120);
    expect(dependencies.observer).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'dispatch_budget_reserved_for_reconciliation',
      dispatchBudgetMs: expect.any(Number),
      reconciliationReserveMs: expect.any(Number),
    }));
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.EXECUTED,
    });
    expect(result.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toState: CONTROLLER_STATE.DISPATCHED,
        deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
      }),
    ]));
  });

  it('always retains a reconciliation reserve while more than one millisecond remains', () => {
    expect(dispatchWindow(10_000, 10_000)).toEqual({
      dispatchBudgetMs: 7_000,
      reconciliationReserveMs: 3_000,
    });
    expect(dispatchWindow(120, 120)).toEqual({
      dispatchBudgetMs: 60,
      reconciliationReserveMs: 60,
    });
    expect(dispatchWindow(1, 1)).toEqual({
      dispatchBudgetMs: 1,
      reconciliationReserveMs: 0,
    });
  });

  it('reconciles persisted dispatch state before any gateway call after restart', async () => {
    const dependencies = baseDependencies();
    const controller = createBrowserTransactionController({
      ...dependencies,
      resumeReconciler: vi.fn().mockResolvedValue({
        mustReconcile: true,
        mayDispatch: false,
        reason: 'persisted_dispatch_reconcile',
        delivery: {
          dispatchAttemptId: 'persisted-dispatch:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
          factRefs: ['journal:dispatch-started'],
        },
      }),
    });
    const result = await controller.execute(action());

    expect(dependencies.gateway.dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      resumed: true,
      terminalDecision: {
        state: CONTROLLER_STATE.COMMITTED,
        commitDisposition: COMMIT_DISPOSITION.RECOVERED,
      },
    });
  });

  it('exhausts unknown action evidence without repeating or cancelling later operations', async () => {
    const dependencies = baseDependencies({
      observer: vi.fn().mockResolvedValue({ claims: [], factRefs: ['snapshot:empty'] }),
    });
    const controller = createBrowserTransactionController({
      ...dependencies,
      defaultObservationAttempts: 2,
    });
    const result = await controller.execute(action());

    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      continuation: {
        disposition: CONTINUATION_DISPOSITION.CONTINUE,
        skipDependents: false,
      },
    });
  });

  it('uses a verified recovery target before declaring resolution failure', async () => {
    const resolver = vi.fn().mockResolvedValue({
      status: RESOLUTION_STATUS.NOT_FOUND,
      reason: 'semantic_snapshot_target_not_found',
      factRefs: ['snapshot:unresolved'],
    });
    const recoveryCoordinator = {
      recoverResolution: vi.fn().mockResolvedValue({
        status: 'RECOVERED_TARGET',
        resolution: {
          status: RESOLUTION_STATUS.RESOLVED,
          target: {
            ref: 'e-healed-email',
            identity: { role: 'textbox', accessibleName: 'Email address' },
          },
          factRefs: ['snapshot:fresh', 'healer:verified'],
        },
      }),
    };
    const dependencies = baseDependencies({ resolver });
    const controller = createBrowserTransactionController({
      ...dependencies,
      recoveryCoordinator,
      defaultResolutionAttempts: 2,
    });

    const result = await controller.execute(action());

    expect(recoveryCoordinator.recoverResolution).toHaveBeenCalledTimes(1);
    expect(dependencies.planner).toHaveBeenCalledWith(expect.objectContaining({
      resolution: expect.objectContaining({
        target: expect.objectContaining({ ref: 'e-healed-email' }),
      }),
    }));
    expect(dependencies.gateway.dispatch).toHaveBeenCalledTimes(1);
    expect(result.terminalDecision.state).toBe(CONTROLLER_STATE.COMMITTED);
  });

  it('records assertion failure and continues without dispatch', async () => {
    const dependencies = baseDependencies({
      planner: vi.fn().mockReturnValue({
        proofContract: proofContract('assert-email-page', 'email_visible'),
      }),
      observer: vi.fn()
        .mockResolvedValueOnce({
          claims: [{
            claimId: 'email_visible',
            status: PROOF_STATUS.MISMATCH,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            source: 'live_owner',
          }],
        })
        .mockResolvedValueOnce({
          claims: [{
            claimId: 'email_visible',
            status: PROOF_STATUS.MISMATCH,
            tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            source: 'live_owner',
          }],
        }),
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action({
      operationId: 'assertion:login:email-page',
      actionOccurrenceId: 'occurrence:assertion:login:email-page:1',
      kind: 'assertion',
      type: 'AssertVisible',
    }));

    expect(dependencies.gateway.dispatch).not.toHaveBeenCalled();
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.ASSERTION_FAILED,
      continuation: {
        disposition: CONTINUATION_DISPOSITION.CONTINUE,
        skipDependents: false,
      },
    });
  });

  it('commits an absent optional prompt as no action required', async () => {
    const dependencies = baseDependencies({
      resolver: vi.fn().mockResolvedValue({
        status: RESOLUTION_STATUS.OPTIONAL_ABSENT,
        reason: 'stay_signed_in_not_present',
        factRefs: ['snapshot:prompt-absent'],
      }),
    });
    const controller = createBrowserTransactionController(dependencies);
    const result = await controller.execute(action({
      operationId: 'action:login:stay-signed-in',
      actionOccurrenceId: 'occurrence:action:login:stay-signed-in:1',
      type: 'Click',
      optional: true,
      required: false,
    }));

    expect(dependencies.gateway.dispatch).not.toHaveBeenCalled();
    expect(result.terminalDecision).toMatchObject({
      state: CONTROLLER_STATE.COMMITTED,
      commitDisposition: COMMIT_DISPOSITION.OPTIONAL_ABSENT,
    });
  });
});
