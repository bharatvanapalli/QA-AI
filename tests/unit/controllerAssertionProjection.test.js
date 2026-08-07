import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  createTerminalDecision,
} = require('../../server/services/browserTransactionContract');
const {
  projectAssertionDecision,
} = require('../../server/services/controllerAssertionProjection');
const {
  createBrowserTransactionRuntime,
} = require('../../server/services/browserTransactionRuntime');
const {
  RESOLUTION_STATUS,
  DELIVERY_STATUS,
} = require('../../server/services/browserTransactionController');
const {
  PROOF_STATUS,
} = require('../../server/services/browserProofContract');

function action(overrides = {}) {
  return {
    schemaVersion: 'OperationContractV2',
    operationId: 'action:contact:step35',
    actionOccurrenceId: 'occurrence:action:contact:step35:1',
    kind: 'action',
    type: 'Fill',
    authoredStepId: 'step35',
    ordinal: 35,
    targetIdentity: {
      accessibleName: 'Contact Phone',
      role: 'textbox',
      section: 'Contact Details',
    },
    value: '+1-555-0102',
    ...overrides,
  };
}

function assertion(overrides = {}) {
  return {
    schemaVersion: 'OperationContractV2',
    operationId: 'assertion:contact:step36',
    actionOccurrenceId: 'occurrence:assertion:contact:step36:1',
    kind: 'assertion',
    type: 'AssertValue',
    assertionId: 'step36',
    ordinal: 36,
    targetIdentity: {
      accessibleName: 'Contact Phone',
      role: 'textbox',
      section: 'Contact Details',
    },
    expected: '+1-555-0102',
    dependencies: [],
    ...overrides,
  };
}

function decision(operation, state, options = {}) {
  return createTerminalDecision({
    operationId: operation.operationId,
    actionOccurrenceId: operation.actionOccurrenceId,
    operationKind: operation.kind,
    state,
    ...(state === CONTROLLER_STATE.COMMITTED
      ? { commitDisposition: COMMIT_DISPOSITION.EXECUTED }
      : {}),
    reason: options.reason || 'test_decision',
    proofRefs: options.proofRefs || [],
  });
}

function fixture({
  actionOverrides,
  assertionOverrides,
  actionProofRefs = ['fact:controller-dom-readback:text-input:phone'],
  assertionState = CONTROLLER_STATE.ASSERTION_FAILED,
} = {}) {
  const committedAction = action(actionOverrides);
  const validationAssertion = assertion(assertionOverrides);
  const actionDecision = decision(committedAction, CONTROLLER_STATE.COMMITTED, {
    proofRefs: actionProofRefs,
  });
  const assertionDecision = decision(validationAssertion, assertionState, {
    proofRefs: ['controller-snapshot:fresh-assertion'],
  });
  return {
    committedAction,
    validationAssertion,
    actionDecision,
    assertionDecision,
    operationContract: {
      operations: [committedAction, validationAssertion],
    },
    priorOperationResults: [{
      operationId: committedAction.operationId,
      terminalDecision: actionDecision,
    }],
  };
}

describe('controller assertion projection', () => {
  it('repairs an action-following field assertion from exact committed owner evidence', () => {
    const input = fixture();
    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: true,
      evidenceOperationId: input.committedAction.operationId,
      replacedFreshDecisionState: CONTROLLER_STATE.ASSERTION_FAILED,
      terminalDecision: {
        state: CONTROLLER_STATE.COMMITTED,
        commitDisposition: COMMIT_DISPOSITION.ALREADY_SATISFIED,
        reason: 'assertion_matched_by_exact_committed_action_evidence',
        continuation: {
          continueIndependent: true,
          skipDependents: false,
        },
      },
    });
    expect(projected.terminalDecision.proofRefs)
      .toEqual(['fact:controller-dom-readback:text-input:phone']);
  });

  it('uses an explicit source-step link when the matching action is not immediately previous', () => {
    const input = fixture({
      assertionOverrides: { sourceStepRef: 'step35', ordinal: 38 },
    });
    const unrelated = action({
      operationId: 'action:contact:step37',
      actionOccurrenceId: 'occurrence:action:contact:step37:1',
      authoredStepId: 'step37',
      ordinal: 37,
      targetIdentity: {
        accessibleName: 'Notes',
        role: 'textbox',
        section: 'Contact Details',
      },
      value: 'Call after 5 PM',
    });
    input.operationContract.operations = [
      input.committedAction,
      unrelated,
      input.validationAssertion,
    ];

    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: true,
      evidenceOperationId: input.committedAction.operationId,
    });
  });

  it('repairs a linked AssertText from exact authored verify text and committed owner readback', () => {
    const input = fixture({
      actionOverrides: {
        authoredStepId: 'step.035',
        operationCheck: {
          condition: { value: '+1-555-0102' },
        },
      },
      assertionOverrides: {
        type: 'AssertText',
        expected: 'Verify Contact Phone equals +1-555-0102.',
        verify: { kind: 'text', text: '+1-555-0102' },
        dependencies: ['step.035'],
      },
    });
    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: true,
      evidenceOperationId: input.committedAction.operationId,
      terminalDecision: {
        state: CONTROLLER_STATE.COMMITTED,
        reason: 'assertion_matched_by_exact_committed_action_evidence',
      },
    });
  });

  it('repairs a protected password assertion without reading or projecting plaintext', () => {
    const secret = 'never-log-this-secret';
    const input = fixture({
      actionOverrides: {
        targetIdentity: {
          accessibleName: 'Password',
          role: 'textbox',
          controlType: 'password',
          section: 'Authentication',
        },
        value: secret,
        valueRef: 'secret:auth.password',
      },
      assertionOverrides: {
        type: 'AssertText',
        targetIdentity: {
          accessibleName: 'Password',
          role: 'textbox',
          controlType: 'password',
          section: 'Authentication',
        },
        expected: { state: 'populated' },
        verify: { kind: 'text', text: secret },
      },
      actionProofRefs: ['controller-snapshot:password-owner'],
    });
    input.actionDecision = decision(input.committedAction, CONTROLLER_STATE.COMMITTED, {
      reason: 'matched:protected-ack',
      proofRefs: ['controller-snapshot:password-owner'],
    });
    input.priorOperationResults[0] = {
      operationId: input.committedAction.operationId,
      terminalDecision: input.actionDecision,
    };

    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: true,
      terminalDecision: {
        state: CONTROLLER_STATE.COMMITTED,
        reason: 'assertion_matched_by_exact_committed_action_evidence',
      },
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it('accepts the live-shaped password readback description only through an explicit dependency', () => {
    const secret = 'another-secret-that-must-not-project';
    const input = fixture({
      actionOverrides: {
        authoredStepId: 'step.014',
        targetIdentity: {
          accessibleName: 'Microsoft password field',
          role: 'textbox',
          controlType: 'password',
        },
        value: secret,
        valueRef: 'secret:microsoft.password',
      },
      assertionOverrides: {
        type: 'AssertText',
        targetIdentity: {
          accessibleName: 'through secure input readback that the Microsoft password field',
          role: 'textbox',
        },
        expected: { state: 'populated' },
        verify: { kind: 'text', text: secret },
        dependencies: ['step.014'],
      },
      actionProofRefs: ['controller-snapshot:password-owner'],
    });
    input.actionDecision = decision(input.committedAction, CONTROLLER_STATE.COMMITTED, {
      reason: 'matched:protected-input-event',
      proofRefs: ['controller-snapshot:password-owner'],
    });
    input.priorOperationResults[0] = {
      operationId: input.committedAction.operationId,
      terminalDecision: input.actionDecision,
    };

    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: true,
      evidenceOperationId: input.committedAction.operationId,
      terminalDecision: {
        state: CONTROLLER_STATE.COMMITTED,
        reason: 'assertion_matched_by_exact_committed_action_evidence',
      },
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it('does not loosen password target descriptions without an explicit link', () => {
    const input = fixture({
      actionOverrides: {
        targetIdentity: {
          accessibleName: 'Microsoft password field',
          role: 'textbox',
          controlType: 'password',
        },
        valueRef: 'secret:microsoft.password',
      },
      assertionOverrides: {
        type: 'AssertText',
        targetIdentity: {
          accessibleName: 'through secure input readback that the Microsoft password field',
          role: 'textbox',
        },
        expected: { state: 'populated' },
        dependencies: [],
      },
      actionProofRefs: ['controller-snapshot:password-owner'],
    });
    input.actionDecision = decision(input.committedAction, CONTROLLER_STATE.COMMITTED, {
      reason: 'matched:protected-ack',
      proofRefs: ['controller-snapshot:password-owner'],
    });
    input.priorOperationResults[0] = {
      operationId: input.committedAction.operationId,
      terminalDecision: input.actionDecision,
    };

    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: false,
      reason: 'no_exact_committed_action_evidence',
    });
  });

  it('keeps descriptive comparison AssertText on fresh browser truth', () => {
    const input = fixture({
      actionOverrides: {
        authoredStepId: 'step.083',
        value: 'Create Order',
        operationCheck: { condition: { value: 'Create Order' } },
      },
      assertionOverrides: {
        type: 'AssertText',
        verify: {
          kind: 'text',
          text: 'Verify the pickup date occurs before the delivery date.',
        },
        dependencies: ['step.083'],
      },
    });
    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: false,
      reason: 'no_exact_committed_action_evidence',
      terminalDecision: input.assertionDecision,
    });
  });

  it.each([
    ['different expected value', {
      assertionOverrides: { expected: '+1-555-9999' },
    }],
    ['different semantic target', {
      assertionOverrides: {
        targetIdentity: {
          accessibleName: 'Delivery Phone',
          role: 'textbox',
          section: 'Delivery',
        },
      },
    }],
    ['missing exact owner proof', {
      actionProofRefs: ['controller-snapshot:fresh-action'],
    }],
    ['unsupported visibility inference', {
      assertionOverrides: { type: 'AssertVisible', expected: true },
    }],
  ])('does not fabricate pass for %s', (_label, overrides) => {
    const input = fixture(overrides);
    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toMatchObject({
      projected: false,
      reason: 'no_exact_committed_action_evidence',
      terminalDecision: input.assertionDecision,
    });
  });

  it('preserves a fresh browser match without replacing its evidence', () => {
    const input = fixture({ assertionState: CONTROLLER_STATE.COMMITTED });
    const projected = projectAssertionDecision({
      assertion: input.validationAssertion,
      decision: input.assertionDecision,
      operationContract: input.operationContract,
      priorOperationResults: input.priorOperationResults,
    });

    expect(projected).toEqual({
      projected: false,
      reason: 'fresh_browser_assertion_already_matched',
      terminalDecision: input.assertionDecision,
    });
  });

  it('applies the repair before the controller runtime journals and projects the verdict', async () => {
    const input = fixture();
    const runtime = createBrowserTransactionRuntime({
      controllerOptions: {
        resolver: async ({ operation }) => ({
          status: RESOLUTION_STATUS.RESOLVED,
          target: {
            ref: `ref:${operation.operationId}`,
            identity: operation.targetIdentity,
          },
          factRefs: [`resolution:${operation.operationId}`],
        }),
        planner: async ({ operation }) => ({
          proofContract: {
            id: `proof:${operation.operationId}`,
            alternatives: [{ id: 'exact', allOf: ['exact'] }],
          },
          mutation: operation.kind === 'action'
            ? { toolName: 'browser_fill', args: { target: 'phone', text: operation.value } }
            : null,
        }),
        observer: async ({ operation, phase }) => {
          if (operation.kind === 'action') {
            return {
              proof: phase === 'post_dispatch'
                ? {
                    status: PROOF_STATUS.MATCHED,
                    reason: 'same_owner_exact_value_committed',
                    factRefs: ['fact:controller-dom-readback:text-input:phone'],
                  }
                : {
                    status: PROOF_STATUS.UNKNOWN,
                    reason: 'action_not_yet_dispatched',
                    factRefs: ['controller-snapshot:pre-action'],
                  },
            };
          }
          return {
            proof: {
              status: PROOF_STATUS.MISMATCH,
              reason: 'transient_snapshot_value_omission',
              factRefs: ['controller-snapshot:fresh-assertion'],
            },
          };
        },
        gateway: {
          dispatch: async () => ({
            deliveryStatus: DELIVERY_STATUS.DELIVERED,
            dispatchAttemptId: 'dispatch:phone:1',
            factRefs: ['dispatch:phone:delivered'],
          }),
        },
        defaultDeadlineMs: 1_000,
        defaultObservationAttempts: 1,
        defaultResolutionAttempts: 1,
      },
    });

    const outcome = await runtime.runCase({
      operationContract: {
        schemaVersion: 'OperationContractV2',
        operations: [input.committedAction, input.validationAssertion],
      },
      scopeId: 'projection-runtime-case',
    });

    expect(outcome.operationResults.map((result) => result.terminalDecision))
      .toEqual([
        expect.objectContaining({
          operationId: input.committedAction.operationId,
          state: CONTROLLER_STATE.COMMITTED,
        }),
        expect.objectContaining({
          operationId: input.validationAssertion.operationId,
          state: CONTROLLER_STATE.COMMITTED,
          commitDisposition: COMMIT_DISPOSITION.ALREADY_SATISFIED,
          reason: 'assertion_matched_by_exact_committed_action_evidence',
        }),
      ]);
    expect(outcome.verdict).toMatchObject({
      verdict: 'PASS',
      counts: {
        assertionFailed: 0,
        committed: 2,
      },
    });
  });
});
