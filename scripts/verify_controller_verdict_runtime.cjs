'use strict';

const assert = require('node:assert/strict');
const {
  CONTROLLER_STATE,
} = require('../server/services/browserTransactionContract');
const {
  PROOF_STATUS,
  EVIDENCE_TIER,
  createProofContract,
} = require('../server/services/browserProofContract');
const {
  RESOLUTION_STATUS,
  DELIVERY_STATUS,
} = require('../server/services/browserTransactionController');
const {
  CASE_VERDICT,
  createInMemoryVerdictRepository,
  projectControllerVerdict,
  persistControllerVerdict,
} = require('../server/services/controllerVerdictProjector');
const {
  SCHEDULE_STATE,
} = require('../server/services/controllerExecutionScheduler');
const {
  createControllerAuthority,
} = require('../server/services/browserTransactionAuthority');
const {
  createBrowserTransactionRuntime,
} = require('../server/services/browserTransactionRuntime');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

(async () => {
  await verify('assertion failure records FAIL only after later action executes', async () => {
    let gatewayCalls = 0;
    const heartbeats = [];
    const observations = new Map();
    const operationContract = {
      schemaVersion: 'OperationContractV2',
      operations: [{
        schemaVersion: 'OperationContractV2',
        operationId: 'assertion:login:email-visible',
        actionOccurrenceId: 'occurrence:assertion:login:email-visible:1',
        kind: 'assertion',
        type: 'AssertVisible',
        ordinal: 1,
        dependencies: [],
      }, {
        schemaVersion: 'OperationContractV2',
        operationId: 'action:login:sign-in',
        actionOccurrenceId: 'occurrence:action:login:sign-in:1',
        kind: 'action',
        type: 'Click',
        ordinal: 2,
        dependencies: ['assertion:login:email-visible'],
        required: true,
      }],
    };
    const runtime = createBrowserTransactionRuntime({
      heartbeat: (event) => heartbeats.push(event),
      controllerOptions: {
        resolver: async () => ({ status: RESOLUTION_STATUS.RESOLVED, target: { ref: 'e1' } }),
        planner: async ({ operation }) => ({
          mutation: operation.kind === 'action'
            ? { toolName: 'browser_click', args: { target: 'e1' } }
            : null,
          proofContract: createProofContract({
            id: `${operation.operationId}:proof`,
            alternatives: [{ id: 'exact', allOf: ['operation_truth'] }],
          }),
        }),
        observer: async ({ operation }) => {
          const count = (observations.get(operation.operationId) || 0) + 1;
          observations.set(operation.operationId, count);
          if (operation.kind === 'assertion') {
            return {
              claims: [{
                claimId: 'operation_truth',
                status: PROOF_STATUS.MISMATCH,
                tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
              }],
            };
          }
          return count === 1 ? { claims: [] } : {
            claims: [{
              claimId: 'operation_truth',
              status: PROOF_STATUS.MATCHED,
              tier: EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION,
            }],
          };
        },
        gateway: {
          dispatch: async () => {
            gatewayCalls += 1;
            return {
              dispatchAttemptId: 'dispatch:1',
              deliveryStatus: DELIVERY_STATUS.DELIVERED,
            };
          },
        },
      },
    });
    const result = await runtime.runCase({
      operationContract,
      scopeId: 'case:login',
    });
    assert.equal(gatewayCalls, 1);
    assert.equal(result.operationResults.length, 2);
    assert.equal(result.operationResults[0].terminalDecision.state, CONTROLLER_STATE.ASSERTION_FAILED);
    assert.equal(result.operationResults[1].terminalDecision.state, CONTROLLER_STATE.COMMITTED);
    assert.equal(result.verdict.verdict, CASE_VERDICT.FAIL);
    const terminalHeartbeat = heartbeats.find((event) => (
      event.operationId === 'action:login:sign-in'
      && event.state === CONTROLLER_STATE.COMMITTED
      && Object.hasOwn(event, 'continuationDisposition')
    ));
    assert.ok(terminalHeartbeat);
    assert.equal(terminalHeartbeat.actionOccurrenceId, 'occurrence:action:login:sign-in:1');
    assert.equal(terminalHeartbeat.reason, result.operationResults[1].terminalDecision.reason);
    assert.ok(Array.isArray(terminalHeartbeat.proofRefs));
  });

  await verify('write-once verdict rejects later reinterpretation', async () => {
    const repository = createInMemoryVerdictRepository();
    const authority = createControllerAuthority();
    const pass = projectControllerVerdict({
      scopeId: 'case:write-once',
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{
          operationId: 'action:1',
          scheduleState: SCHEDULE_STATE.TERMINAL,
          terminalState: CONTROLLER_STATE.COMMITTED,
        }],
      },
    });
    await persistControllerVerdict({ authority, projection: pass, repository });
    const fail = projectControllerVerdict({
      scopeId: 'case:write-once',
      schedulerSnapshot: {
        paused: false,
        cancelled: false,
        records: [{
          operationId: 'assertion:1',
          scheduleState: SCHEDULE_STATE.TERMINAL,
          terminalState: CONTROLLER_STATE.ASSERTION_FAILED,
        }],
      },
    });
    await assert.rejects(
      () => persistControllerVerdict({ authority, projection: fail, repository }),
      (error) => error?.code === 'CONTROLLER_VERDICT_WRITE_ONCE_VIOLATION',
    );
  });

  process.stdout.write(`OK ${passed} sole verdict runtime invariants\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
