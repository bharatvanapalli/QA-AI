'use strict';

const assert = require('node:assert/strict');
const contract = require('../server/services/browserTransactionContract');
const authority = require('../server/services/browserTransactionAuthority');
const operationContract = require('../server/services/operationContractV2');
const stateMachineModule = require('../server/services/browserTransactionStateMachine');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

verify('one minted controller authority owns execution capabilities', () => {
  const controllerAuthority = authority.createControllerAuthority();
  const authorization = authority.assertControllerAuthority(
    controllerAuthority,
    authority.CONTROLLER_CAPABILITY.AUTHORIZE_MUTATION,
  );
  assert.equal(authorization.owner, authority.CONTROLLER_OWNER);
  assert.throws(
    () => authority.assertControllerAuthority(
      { schemaVersion: authority.AUTHORITY_VERSION, owner: authority.CONTROLLER_OWNER },
      authority.CONTROLLER_CAPABILITY.AUTHORIZE_MUTATION,
    ),
    (error) => error?.code === 'BROWSER_TRANSACTION_CONTROLLER_AUTHORITY_REQUIRED',
  );
});

verify('observers and recovery agents cannot mutate stop or assign verdicts', () => {
  const healerProposal = authority.proposal(authority.OBSERVER_ROLE.HEALER, {
    target: { role: 'button', name: 'Sign in' },
  });
  assert.equal(healerProposal.mayMutateBrowser, false);
  assert.equal(healerProposal.mayStopExecution, false);
  assert.equal(healerProposal.mayChangeVerdict, false);
});

verify('canonical controller states contain no blocked outcome', () => {
  assert.equal(Object.values(contract.CONTROLLER_STATE).includes('BLOCKED'), false);
  assert.equal(Object.values(contract.CONTROLLER_STATE).includes('blocked'), false);
});

verify('assertion failure records failure and continues execution', () => {
  const decision = contract.createTerminalDecision({
    operationId: 'verify:email-page',
    actionOccurrenceId: 'assertion:email-page',
    state: contract.CONTROLLER_STATE.ASSERTION_FAILED,
  });
  assert.equal(decision.continuation.disposition, contract.CONTINUATION_DISPOSITION.CONTINUE);
  assert.equal(decision.continuation.skipDependents, false);
});

verify('execution error records uncertainty and keeps later authored work runnable', () => {
  const decision = contract.createTerminalDecision({
    operationId: 'submit:sign-in',
    actionOccurrenceId: 'action:submit:sign-in',
    state: contract.CONTROLLER_STATE.EXECUTION_ERROR,
  });
  assert.equal(decision.continuation.disposition, contract.CONTINUATION_DISPOSITION.CONTINUE);
  assert.equal(decision.continuation.continueIndependent, true);
  assert.equal(decision.continuation.skipDependents, false);
  assert.equal(decision.continuation.terminationReason, null);
});

verify('committed operations require an exact disposition', () => {
  assert.throws(
    () => contract.createTerminalDecision({
      operationId: 'fill:email',
      actionOccurrenceId: 'action:fill:email',
      state: contract.CONTROLLER_STATE.COMMITTED,
    }),
    (error) => error?.code === 'BROWSER_TRANSACTION_COMMIT_DISPOSITION_REQUIRED',
  );
});

verify('run termination is restricted to the explicit whitelist', () => {
  assert.throws(
    () => contract.createTerminalDecision({
      operationId: 'fill:email',
      actionOccurrenceId: 'action:fill:email',
      state: contract.CONTROLLER_STATE.EXECUTION_ERROR,
      terminationReason: 'EVIDENCE_MISSING',
    }),
    (error) => error?.code === 'BROWSER_TRANSACTION_TERMINATION_REASON_INVALID',
  );
});

verify('operation identity keeps actions and assertions in separate namespaces', () => {
  const compiled = operationContract.compileOperationContractV2({
    id: 'login',
    steps: [{
      id: 'email',
      type: 'Fill',
      targetIdentity: { label: 'Email address', role: 'textbox' },
      value: 'qa@example.test',
    }],
    assertions: [{
      id: 'email-visible',
      stepId: 'email',
      type: 'AssertVisible',
      targetIdentity: { label: 'Email address', role: 'textbox' },
      comparator: 'visible',
    }],
  });
  assert.equal(compiled.actions[0].operationId, 'action:login:email');
  assert.equal(compiled.assertions[0].operationId, 'assertion:login:email-visible');
  assert.equal(compiled.assertions[0].sourceStepRef, 'email');
});

verify('polluted authored operations fail before browser launch', () => {
  assert.throws(
    () => operationContract.compileOperationContractV2({
      id: 'timezone',
      steps: [{
        id: 'timezone-select',
        type: 'Select',
        targetIdentity: { label: 'Time Zone', role: 'combobox' },
        selectionCriteria: {
          kind: 'exact_text',
          text: 'Central, and verify that the order is ready',
        },
      }],
    }),
    (error) => error?.code === 'OPERATION_CONTRACT_INVALID'
      && error.findings.some((item) => item.code === 'selection_contains_assertion_prose'),
  );
});

verify('controller state transitions are capability-checked and append-only', () => {
  let tick = 0;
  const machine = stateMachineModule.createBrowserTransactionStateMachine({
    operation: {
      operationId: 'action:login:email',
      actionOccurrenceId: 'occurrence:action:login:email:1',
    },
    authority: authority.createControllerAuthority(),
    now: () => Date.parse('2026-07-23T10:00:00.000Z') + tick++,
  });
  machine.transition(contract.CONTROLLER_STATE.RESOLVING);
  machine.transition(contract.CONTROLLER_STATE.DISPATCHED, {
    dispatchAttemptId: 'dispatch:1',
    deliveryStatus: 'DELIVERED',
  });
  machine.transition(contract.CONTROLLER_STATE.RECONCILING, {
    deadlineAt: '2026-07-23T10:00:05.000Z',
  });
  machine.transition(contract.CONTROLLER_STATE.COMMITTED, {
    commitDisposition: contract.COMMIT_DISPOSITION.EXECUTED,
    factRefs: ['owner-readback:email'],
  });
  const snapshot = machine.snapshot();
  assert.equal(snapshot.events.length, 5);
  assert.equal(snapshot.terminalDecision.proofRefs[0], 'owner-readback:email');
  assert.throws(
    () => machine.transition(contract.CONTROLLER_STATE.RECONCILING, {
      deadlineAt: '2026-07-23T10:00:06.000Z',
    }),
    (error) => error?.code === 'BROWSER_TRANSACTION_TERMINAL_DECISION_IMMUTABLE',
  );
});

process.stdout.write(`OK ${passed} browser transaction contract invariants\n`);
