'use strict';

const assert = require('node:assert/strict');
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  CONTINUATION_DISPOSITION,
} = require('../server/services/browserTransactionContract');
const {
  PROOF_STATUS,
  EVIDENCE_TIER,
  createProofContract,
} = require('../server/services/browserProofContract');
const {
  RESOLUTION_STATUS,
  DELIVERY_STATUS,
  createBrowserTransactionController,
} = require('../server/services/browserTransactionController');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function operation(overrides = {}) {
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

function contract(id, alternatives) {
  return createProofContract({ id, alternatives });
}

function dependencies({ observer, planner, dispatch } = {}) {
  let dispatchCount = 0;
  return {
    dispatchCount: () => dispatchCount,
    options: {
      resolver: async () => ({
        status: RESOLUTION_STATUS.RESOLVED,
        target: { role: 'textbox', accessibleName: 'Email address' },
        factRefs: ['resolution:email'],
      }),
      planner: planner || (async () => ({
        mutation: { toolName: 'browser_fill', args: { target: 'e1' } },
        proofContract: contract('fill-email', [{
          id: 'owner-readback',
          allOf: ['email_owner_value'],
        }]),
      })),
      observer,
      gateway: {
        dispatch: dispatch || (async () => {
          dispatchCount += 1;
          return {
            dispatchAttemptId: 'dispatch:1',
            deliveryStatus: DELIVERY_STATUS.DELIVERED,
          };
        }),
      },
    },
  };
}

(async () => {
  await verify('email fill dispatches once and commits exact owner truth', async () => {
    let observation = 0;
    const fixture = dependencies({
      observer: async () => (++observation === 1 ? { claims: [] } : {
        claims: [{
          claimId: 'email_owner_value',
          status: PROOF_STATUS.MATCHED,
          tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
          source: 'live_owner',
          factRef: 'owner-readback:email',
        }],
      }),
    });
    const result = await createBrowserTransactionController(fixture.options).execute(operation());
    assert.equal(fixture.dispatchCount(), 1);
    assert.equal(result.terminalDecision.state, CONTROLLER_STATE.COMMITTED);
    assert.equal(result.terminalDecision.commitDisposition, COMMIT_DISPOSITION.EXECUTED);
  });

  await verify('next password control proves Sign in despite missing event evidence', async () => {
    let observation = 0;
    const fixture = dependencies({
      planner: async () => ({
        mutation: { toolName: 'browser_click', args: { target: 'e2' } },
        proofContract: contract('click-sign-in', [
          { id: 'destination', allOf: ['auth_destination'] },
          { id: 'next-control', allOf: ['password_actionable'] },
        ]),
      }),
      observer: async () => (++observation === 1 ? { claims: [] } : {
        claims: [{
          claimId: 'password_actionable',
          status: PROOF_STATUS.MATCHED,
          tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
          source: 'live_owner',
          factRef: 'control:password',
        }, {
          claimId: 'password_actionable',
          status: PROOF_STATUS.MISMATCH,
          tier: EVIDENCE_TIER.BROWSER_EVENT,
          source: 'event_recorder',
        }],
      }),
    });
    const result = await createBrowserTransactionController(fixture.options).execute(operation({
      operationId: 'action:login:sign-in',
      actionOccurrenceId: 'occurrence:action:login:sign-in:1',
      type: 'Click',
    }));
    assert.equal(fixture.dispatchCount(), 1);
    assert.equal(result.terminalDecision.state, CONTROLLER_STATE.COMMITTED);
  });

  await verify('unknown evidence never repeats a delivered mutation', async () => {
    const fixture = dependencies({ observer: async () => ({ claims: [] }) });
    const result = await createBrowserTransactionController({
      ...fixture.options,
      defaultObservationAttempts: 2,
    }).execute(operation());
    assert.equal(fixture.dispatchCount(), 1);
    assert.equal(result.terminalDecision.state, CONTROLLER_STATE.EXECUTION_ERROR);
    assert.equal(
      result.terminalDecision.continuation.disposition,
      CONTINUATION_DISPOSITION.CONTINUE,
    );
    assert.equal(result.terminalDecision.continuation.skipDependents, false);
    assert.equal(result.terminalDecision.continuation.terminationReason, null);
  });

  process.stdout.write(`OK ${passed} browser transaction controller scenarios\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
