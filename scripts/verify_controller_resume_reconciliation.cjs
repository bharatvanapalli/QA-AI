'use strict';

const assert = require('node:assert/strict');
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
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
const {
  createBrowserTransactionEventJournal,
} = require('../server/services/browserTransactionEventJournal');
const {
  RESUME_STATUS,
  createControllerResumeReconciler,
} = require('../server/services/controllerResumeReconciler');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const operation = {
  schemaVersion: 'OperationContractV2',
  operationId: 'action:login:sign-in',
  actionOccurrenceId: 'occurrence:action:login:sign-in:1',
  kind: 'action',
  type: 'Click',
  required: true,
  targetIdentity: { role: 'button', accessibleName: 'Sign in' },
};

(async () => {
  await verify('dispatch-started crash state reconciles before any redispatch', async () => {
    const journal = createBrowserTransactionEventJournal();
    await journal.appendDispatchEvent({
      eventType: 'DISPATCH_STARTED',
      occurrenceKey: `${operation.actionOccurrenceId}::action`,
      operationId: operation.operationId,
      actionOccurrenceId: operation.actionOccurrenceId,
      dispatchAttemptId: 'dispatch:1',
    });
    const result = await createControllerResumeReconciler({ journal }).reconcile({
      operation,
      plan: { mutation: { phaseId: 'action' } },
    });
    assert.equal(result.status, RESUME_STATUS.RECONCILE_BEFORE_ANY_DISPATCH);
    assert.equal(result.mayDispatch, false);
  });

  await verify('controller restart observes persisted dispatch and never calls gateway', async () => {
    let gatewayCalls = 0;
    let observations = 0;
    const result = await createBrowserTransactionController({
      resolver: async () => ({ status: RESOLUTION_STATUS.RESOLVED, target: { ref: 'e1' } }),
      planner: async () => ({
        mutation: { toolName: 'browser_click', args: { target: 'e1' }, phaseId: 'action' },
        proofContract: createProofContract({
          id: 'sign-in',
          alternatives: [{ id: 'password', allOf: ['password_actionable'] }],
        }),
      }),
      observer: async () => (++observations === 1 ? { claims: [] } : {
        claims: [{
          claimId: 'password_actionable',
          status: PROOF_STATUS.MATCHED,
          tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
          factRef: 'control:password',
        }],
      }),
      gateway: {
        dispatch: async () => {
          gatewayCalls += 1;
          return { deliveryStatus: DELIVERY_STATUS.DELIVERED };
        },
      },
      resumeReconciler: async () => ({
        mustReconcile: true,
        mayDispatch: false,
        delivery: {
          dispatchAttemptId: 'persisted:dispatch:1',
          deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
          factRefs: ['journal:dispatch-started'],
        },
      }),
    }).execute(operation);
    assert.equal(gatewayCalls, 0);
    assert.equal(result.terminalDecision.state, CONTROLLER_STATE.COMMITTED);
    assert.equal(result.terminalDecision.commitDisposition, COMMIT_DISPOSITION.RECOVERED);
  });

  process.stdout.write(`OK ${passed} crash-safe resume invariants\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
