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

const RUNS = 20;

function operation(index) {
  return Object.freeze({
    schemaVersion: 'OperationContractV2',
    operationId: `action:chaos:${index}`,
    actionOccurrenceId: `occurrence:action:chaos:${index}:1`,
    kind: 'action',
    type: index % 2 === 0 ? 'Fill' : 'Click',
    targetIdentity: Object.freeze({
      role: index % 2 === 0 ? 'textbox' : 'button',
      accessibleName: index % 2 === 0 ? 'Email address' : 'Sign in',
    }),
    required: true,
  });
}

function matched(claimId, factRef, tier = EVIDENCE_TIER.EXACT_LIVE_OWNER_OR_DESTINATION) {
  return Object.freeze({
    claimId,
    status: PROOF_STATUS.MATCHED,
    tier,
    source: 'chaos_browser_truth',
    factRef,
  });
}

function mismatch(claimId, factRef, tier = EVIDENCE_TIER.BROWSER_EVENT) {
  return Object.freeze({
    claimId,
    status: PROOF_STATUS.MISMATCH,
    tier,
    source: 'chaos_missing_event',
    factRef,
  });
}

async function executeChaosRun(index) {
  const scenario = index % 5;
  let observations = 0;
  let dispatches = 0;
  const claimId = scenario === 1 ? 'next_control_actionable' : 'owner_or_destination';
  const proofContract = createProofContract({
    id: `chaos-proof:${index}`,
    alternatives: [{ id: 'exact-browser-truth', allOf: [claimId] }],
  });

  const observer = async ({ phase }) => {
    observations += 1;
    if (phase === 'pre_dispatch') return { claims: [], reason: 'stale_or_white_pre_state' };
    if (scenario === 0) {
      if (observations < 4) return { claims: [], reason: 'delayed_snapshot_commit' };
      return { claims: [matched(claimId, `owner:${index}`)] };
    }
    if (scenario === 1) {
      return {
        claims: [
          matched(claimId, `destination:${index}`),
          mismatch(claimId, `event-missed:${index}`),
        ],
      };
    }
    if (scenario === 2) return { claims: [], reason: 'all_instrumentation_unknown' };
    if (scenario === 3) return { claims: [matched(claimId, `destination:${index}`)] };
    return { claims: [matched(claimId, `resume-owner:${index}`)] };
  };

  const gateway = {
    dispatch: async () => {
      dispatches += 1;
      return {
        dispatchAttemptId: `dispatch:${index}:1`,
        deliveryStatus: scenario === 3
          ? DELIVERY_STATUS.DELIVERY_UNCERTAIN
          : DELIVERY_STATUS.DELIVERED,
        factRefs: [`delivery:${index}`],
      };
    },
  };
  const resumeReconciler = scenario === 4
    ? async () => ({
      mustReconcile: true,
      reason: 'persisted_dispatch_requires_observation',
      delivery: {
        dispatchAttemptId: `dispatch:${index}:persisted`,
        deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
        factRefs: [`persisted-delivery:${index}`],
      },
    })
    : null;

  const result = await createBrowserTransactionController({
    resolver: async () => ({
      status: RESOLUTION_STATUS.RESOLVED,
      target: { ref: `e${index}`, identity: operation(index).targetIdentity },
      factRefs: [`resolution:${index}`],
    }),
    planner: async () => ({
      mutation: {
        toolName: operation(index).type === 'Fill' ? 'browser_fill' : 'browser_click',
        args: { target: `e${index}` },
      },
      proofContract,
    }),
    observer,
    gateway,
    resumeReconciler,
    defaultDeadlineMs: 2_000,
    defaultObservationAttempts: 3,
  }).execute(operation(index));

  if (scenario === 2) {
    assert.equal(result.terminalDecision.state, CONTROLLER_STATE.EXECUTION_ERROR);
    assert.equal(dispatches, 1);
    return { scenario, dispatches, terminal: CONTROLLER_STATE.EXECUTION_ERROR };
  }
  assert.equal(result.terminalDecision.state, CONTROLLER_STATE.COMMITTED);
  assert.equal(dispatches, scenario === 4 ? 0 : 1);
  if (scenario === 4) {
    assert.equal(result.terminalDecision.commitDisposition, COMMIT_DISPOSITION.RECOVERED);
    assert.equal(result.resumed, true);
  }
  return { scenario, dispatches, terminal: CONTROLLER_STATE.COMMITTED };
}

async function main() {
  const results = [];
  for (let index = 0; index < RUNS; index += 1) {
    results.push(await executeChaosRun(index));
  }
  const totalDispatches = results.reduce((sum, result) => sum + result.dispatches, 0);
  const recoveredWithoutDispatch = results.filter((result) => result.scenario === 4 && result.dispatches === 0).length;
  const boundedUnknowns = results.filter((result) => result.scenario === 2 && result.terminal === CONTROLLER_STATE.EXECUTION_ERROR).length;
  assert.equal(results.length, RUNS);
  assert.equal(totalDispatches, 16);
  assert.equal(recoveredWithoutDispatch, 4);
  assert.equal(boundedUnknowns, 4);
  process.stdout.write(
    `PASS ${RUNS}/${RUNS} chaos runs; mutations=${totalDispatches}; duplicateMutations=0; `
    + `resumeRedispatches=0; boundedUnknowns=${boundedUnknowns}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
