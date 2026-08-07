import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ADAPTER_KIND,
  CLAIM,
  createTypedAdapterPlan,
} = require('../../server/services/controllerTypedAdapterRegistry');

function operation(overrides = {}) {
  return {
    schemaVersion: 'OperationContractV2',
    operationId: 'action:login:email',
    actionOccurrenceId: 'occurrence:action:login:email:1',
    kind: 'action',
    type: 'Fill',
    targetIdentity: { accessibleName: 'Email address', role: 'textbox', controlType: 'email' },
    value: 'qa@example.test',
    ...overrides,
  };
}

function resolution(overrides = {}) {
  return {
    target: {
      ref: 'e1',
      identity: { accessibleName: 'Email address', role: 'textbox', controlType: 'email' },
    },
    ...overrides,
  };
}

describe('controller typed adapter registry', () => {
  it('plans a normal text fill that can commit only from exact owner readback', () => {
    expect(createTypedAdapterPlan({
      operation: operation(),
      resolution: resolution(),
    })).toMatchObject({
      adapterKind: ADAPTER_KIND.TEXT_INPUT,
      preDispatchMutation: {
        toolName: 'browser_evaluate',
        phaseId: 'reveal-owner',
        args: {
          target: 'e1',
          element: 'Email address',
          function: expect.stringContaining('bound_text_input_owner_revealed_and_focused'),
        },
      },
      mutation: { toolName: 'browser_fill', args: { target: 'e1', text: 'qa@example.test' } },
      proofContract: {
        alternatives: [
          expect.objectContaining({ allOf: [CLAIM.SAME_OWNER_VALUE] }),
        ],
      },
      proofMetadata: {
        browserAcknowledgmentIsDeliveryOnly: true,
        exactOwnerRevealRequired: true,
      },
    });
  });

  it('never asks for password plaintext readback', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:login:password',
        actionOccurrenceId: 'occurrence:action:login:password:1',
        targetIdentity: { accessibleName: 'Password', role: 'textbox', controlType: 'password' },
        value: null,
        valueRef: 'env:LOGIN_PASSWORD',
      }),
      resolution: resolution({
        target: {
          ref: 'e2',
          identity: { accessibleName: 'Password', role: 'textbox', controlType: 'password' },
        },
      }),
      context: { resolveValueRef: () => 'runtime-only-secret' },
    });
    expect(plan).toMatchObject({
      adapterKind: ADAPTER_KIND.PASSWORD_INPUT,
      proofMetadata: { plaintextReadbackForbidden: true },
      privacy: { sensitive: true },
    });
    expect(JSON.stringify(plan.proofContract)).not.toContain('runtime-only-secret');
    expect(JSON.stringify(plan.proofContract)).not.toContain(CLAIM.SAME_OWNER_VALUE);
  });

  it('plans custom dropdown phases without dispatching them', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:order:equipment',
        actionOccurrenceId: 'occurrence:action:order:equipment:1',
        type: 'Select',
        targetIdentity: { accessibleName: 'Equipment', role: 'combobox' },
        value: null,
        selection: { kind: 'exact_text', value: 'Dry Van' },
      }),
      resolution: resolution({
        target: {
          ref: 'equipment-owner',
          interactionRef: 'equipment-trigger',
          identity: { accessibleName: 'Equipment', role: 'combobox' },
        },
      }),
    });
    expect(plan).toMatchObject({
      adapterKind: ADAPTER_KIND.CUSTOM_SELECT,
      mutation: null,
      phases: [
        expect.objectContaining({ phaseId: 'owner-ready', kind: 'OBSERVE' }),
        expect.objectContaining({
          phaseId: 'select-option',
          kind: 'MUTATION',
          skipWhenClaim: CLAIM.OWNER_STATE_COMMITTED,
        }),
        expect.objectContaining({ phaseId: 'owner-readback', kind: 'OBSERVE' }),
      ],
      proofMetadata: {
        popupOwnerCorrelationRequired: true,
        popupOpenAloneNeverCommits: true,
      },
    });
    expect(plan.proofContract.alternatives).toEqual([
      expect.objectContaining({
        allOf: [CLAIM.OWNER_SELECTED_VALUE, CLAIM.OWNER_STATE_COMMITTED],
      }),
      expect.objectContaining({
        allOf: [CLAIM.EXACT_OPTION_SELECTED, CLAIM.OWNER_STATE_COMMITTED],
      }),
    ]);
    expect(plan.protocol.phases.at(-1)).toMatchObject({
      phaseId: 'owner-readback',
      requiredClaim: CLAIM.OWNER_STATE_COMMITTED,
      final: true,
    });
    expect(plan.protocol.metadata.atomicVirtualizedSelection).toBe(true);
    expect(plan.protocol.phases[1].mutation).toMatchObject({
      toolName: 'browser_evaluate',
      args: { target: 'equipment-owner' },
    });
  });

  it('requires owner-correlated popup proof for menu-opening clicks', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:order:open-equipment',
        actionOccurrenceId: 'occurrence:action:order:open-equipment:1',
        type: 'Click',
        targetIdentity: { accessibleName: 'Equipment dropdown' },
        value: null,
        operationCheck: { kind: 'menu_opened' },
      }),
      resolution: resolution({
        target: {
          ref: 'equipment-owner',
          interactionRef: 'equipment-trigger',
          identity: { accessibleName: 'Equipment', role: 'combobox' },
        },
      }),
    });

    expect(plan).toMatchObject({
      mutation: {
        toolName: 'browser_click',
        args: { target: 'equipment-trigger' },
      },
      proofContract: {
        alternatives: [{
          allOf: [CLAIM.ASSOCIATED_POPUP_OPEN],
        }],
      },
    });
    expect(JSON.stringify(plan.proofContract)).not.toContain(CLAIM.AUTHORED_DESTINATION);
  });

  it('allows an exact next authored control to prove a navigation menu opened', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:navigation:open-orders',
        actionOccurrenceId: 'occurrence:action:navigation:open-orders:1',
        type: 'Click',
        targetIdentity: { accessibleName: 'Orders', role: 'button' },
        value: null,
        operationCheck: { kind: 'menu_opened' },
      }),
      resolution: resolution({
        target: {
          ref: 'orders-navigation-owner',
          identity: { accessibleName: 'Orders', role: 'button' },
        },
      }),
    });

    expect(plan.proofContract.alternatives).toEqual([
      expect.objectContaining({
        allOf: [CLAIM.ASSOCIATED_POPUP_OPEN],
      }),
      expect.objectContaining({
        allOf: [CLAIM.NEXT_AUTHORED_ACTION_CONTROL_ACTIONABLE],
      }),
    ]);
    expect(JSON.stringify(plan.proofContract)).not.toContain(CLAIM.AUTHORED_DESTINATION);
  });

  it('keeps an authored click as a click when stale resolved metadata claims a checkable role', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:planning:open-date',
        actionOccurrenceId: 'occurrence:action:planning:open-date:1',
        type: 'Click',
        targetIdentity: { accessibleName: 'Scheduled Date calendar' },
        value: null,
        operationCheck: { kind: 'menu_opened' },
      }),
      resolution: resolution({
        target: {
          ref: 'stale-owner',
          identity: { accessibleName: 'Appointment', role: 'checkbox' },
        },
      }),
    });

    expect(plan).toMatchObject({
      adapterKind: ADAPTER_KIND.BUTTON_OR_LINK,
      mutation: {
        toolName: 'browser_click',
        args: { target: 'stale-owner' },
      },
    });
    expect(plan.mutation.toolName).not.toBe('browser_check');
  });

  it('exposes one exact-owner activation recovery without replacing the normal click path', () => {
    const clickOperation = operation({
      operationId: 'action:orders:create',
      actionOccurrenceId: 'occurrence:action:orders:create:1',
      type: 'Click',
      targetIdentity: { accessibleName: 'Create Order', role: 'button' },
      value: null,
    });
    const clickResolution = resolution({
      target: {
        ref: 'create-order-owner',
        identity: { accessibleName: 'Create Order', role: 'button' },
      },
    });

    const normalPlan = createTypedAdapterPlan({
      operation: clickOperation,
      resolution: clickResolution,
    });
    expect(normalPlan).toMatchObject({
      mutation: {
        toolName: 'browser_click',
        args: { target: 'create-order-owner' },
      },
      recoveryMutation: {
        toolName: 'browser_evaluate',
        phaseId: 'recovery-activation',
        args: {
          target: 'create-order-owner',
          function: expect.stringContaining('bound_activation_recovery_dispatched'),
        },
      },
    });

    const recoveryPlan = createTypedAdapterPlan({
      operation: {
        ...clickOperation,
        actionOccurrenceId: `${clickOperation.actionOccurrenceId}:recovery:unchanged-activation:1`,
      },
      resolution: clickResolution,
      context: {
        controllerRecoveryDirective: 'ACTIVATE_PROVEN_UNCHANGED_TARGET',
      },
    });
    expect(recoveryPlan).toMatchObject({
      mutation: {
        toolName: 'browser_evaluate',
        phaseId: 'recovery-activation',
        args: { target: 'create-order-owner' },
      },
      recoveryMutation: null,
    });
  });

  it('plans assertions and waits as observation-only', () => {
    for (const candidate of [{
      kind: 'assertion',
      type: 'AssertVisible',
      operationId: 'assertion:login:email',
      actionOccurrenceId: 'occurrence:assertion:login:email:1',
    }, {
      kind: 'synchronization',
      type: 'WaitForState',
      operationId: 'action:login:wait',
      actionOccurrenceId: 'occurrence:action:login:wait:1',
    }]) {
      expect(createTypedAdapterPlan({
        operation: operation(candidate),
        resolution: resolution(),
      }).mutation).toBeNull();
    }
  });

  it('plans Scroll as a bounded semantic reveal rather than a generic click', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:order:reveal-references',
        actionOccurrenceId: 'occurrence:action:order:reveal-references:1',
        type: 'Scroll',
        targetIdentity: { accessibleName: 'References section', role: 'region' },
        value: null,
      }),
      resolution: {
        target: {
          ref: null,
          synthetic: true,
          identity: { accessibleName: 'References section', role: 'region' },
        },
      },
    });

    expect(plan).toMatchObject({
      adapterKind: ADAPTER_KIND.REVEAL,
      mutation: {
        toolName: 'browser_evaluate',
        args: { function: expect.stringContaining('scrollIntoView') },
      },
      proofMetadata: {
        observationFirst: true,
        utilityMutation: true,
      },
    });
    expect(plan.proofContract.alternatives).toEqual(expect.arrayContaining([
      expect.objectContaining({ allOf: [CLAIM.TARGET_VISIBLE] }),
      expect.objectContaining({ allOf: [CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE] }),
    ]));
  });

  it('keeps the resolved browser owner name throughout a calendar transaction', () => {
    const plan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:order:pickup-date',
        actionOccurrenceId: 'occurrence:action:order:pickup-date:1',
        type: 'Date',
        targetIdentity: {
          accessibleName: 'Early Pickup Date & Time calendar',
          role: 'combobox',
        },
        value: '2026-08-20',
      }),
      resolution: resolution({
        target: {
          ref: 'e46',
          identity: {
            accessibleName: 'Early Pickup Date and Time',
            role: 'combobox',
          },
        },
      }),
    });

    expect(plan.protocol.metadata.ownerAccessibleName).toBe('Early Pickup Date and Time');
    expect(plan.protocol.phases.find((phase) => phase.phaseId === 'commit-date'))
      .toMatchObject({
        mutation: {
          args: {
            function: expect.stringContaining('"accessibleName":"Early Pickup Date and Time"'),
          },
        },
      });
  });

  it('routes clock-valued Select operations to Time without capturing Time Zone', () => {
    const timePlan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:order:pickup-time',
        actionOccurrenceId: 'occurrence:action:order:pickup-time:1',
        type: 'Select',
        targetIdentity: {
          accessibleName: 'Early Pickup Time dropdown',
          role: 'combobox',
        },
        value: '09:00 AM',
      }),
      resolution: resolution({
        adapterKind: ADAPTER_KIND.CUSTOM_SELECT,
        target: {
          ref: 'time-owner',
          adapterKind: ADAPTER_KIND.CUSTOM_SELECT,
          identity: { accessibleName: '00:00', role: 'combobox' },
        },
      }),
    });
    const zonePlan = createTypedAdapterPlan({
      operation: operation({
        operationId: 'action:order:pickup-timezone',
        actionOccurrenceId: 'occurrence:action:order:pickup-timezone:1',
        type: 'Select',
        targetIdentity: {
          accessibleName: 'Early Pickup Time Zone dropdown',
          role: 'combobox',
        },
        value: 'Central',
      }),
      resolution: resolution({
        target: {
          ref: 'timezone-owner',
          identity: { accessibleName: 'Select Timezone', role: 'combobox' },
        },
      }),
    });

    expect(timePlan.adapterKind).toBe(ADAPTER_KIND.TIME);
    expect(timePlan.protocol.phases.map((phase) => phase.phaseId))
      .toContain('select-time-option');
    expect(zonePlan.adapterKind).toBe(ADAPTER_KIND.CUSTOM_SELECT);
  });

  it('drops a stale resolved adapter hint during controller-owned replanning', () => {
    const equipment = operation({
      operationId: 'action:order:equipment-recovery',
      actionOccurrenceId: 'occurrence:action:order:equipment-recovery:1',
      type: 'Select',
      targetIdentity: {
        accessibleName: 'Equipment dropdown',
        role: 'combobox',
      },
      value: 'LTL',
    });
    const staleResolution = resolution({
      adapterKind: ADAPTER_KIND.TIME,
      target: {
        ref: 'equipment-owner',
        adapterKind: ADAPTER_KIND.TIME,
        identity: { accessibleName: 'LTL', role: 'combobox' },
      },
    });

    expect(createTypedAdapterPlan({
      operation: equipment,
      resolution: staleResolution,
      context: { ignoreResolvedAdapterHint: true },
    }).adapterKind).toBe(ADAPTER_KIND.CUSTOM_SELECT);
  });
});
