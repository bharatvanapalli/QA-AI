'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CONTROLLER_STATE,
  COMMIT_DISPOSITION,
  createTerminalDecision,
} = require('../server/services/browserTransactionContract');
const { createControllerAuthority } = require('../server/services/browserTransactionAuthority');
const {
  SCHEDULE_STATE,
  createControllerExecutionScheduler,
} = require('../server/services/controllerExecutionScheduler');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function operation(operationId, kind, ordinal, dependencies = []) {
  return {
    operationId,
    actionOccurrenceId: `occurrence:${operationId}:1`,
    kind,
    ordinal,
    dependencies,
  };
}

function decision(operationId, state) {
  return createTerminalDecision({
    operationId,
    actionOccurrenceId: `occurrence:${operationId}:1`,
    state,
    ...(state === CONTROLLER_STATE.COMMITTED
      ? { commitDisposition: COMMIT_DISPOSITION.EXECUTED }
      : {}),
  });
}

verify('assertion failure releases the next dependent action', () => {
  const scheduler = createControllerExecutionScheduler({
    authority: createControllerAuthority(),
    operationContract: {
      schemaVersion: 'OperationContractV2',
      operations: [
        operation('assertion:email-visible', 'assertion', 1),
        operation('action:sign-in', 'action', 2, ['assertion:email-visible']),
      ],
    },
  });
  assert.equal(scheduler.claimNext().operationId, 'assertion:email-visible');
  scheduler.recordDecision(decision('assertion:email-visible', CONTROLLER_STATE.ASSERTION_FAILED));
  assert.equal(scheduler.claimNext().operationId, 'action:sign-in');
});

verify('execution error preserves run continuation without releasing explicit descendants', () => {
  const scheduler = createControllerExecutionScheduler({
    authority: createControllerAuthority(),
    operationContract: {
      schemaVersion: 'OperationContractV2',
      operations: [
        operation('action:email', 'action', 1),
        operation('action:sign-in', 'action', 2, ['action:email']),
        operation('assertion:branding', 'assertion', 3),
      ],
    },
  });
  scheduler.claimNext();
  scheduler.recordDecision(decision('action:email', CONTROLLER_STATE.EXECUTION_ERROR));
  assert.equal(scheduler.claimNext().operationId, 'assertion:branding');
  assert.equal(
    scheduler.snapshot().records.find((record) => record.operationId === 'action:sign-in').scheduleState,
    SCHEDULE_STATE.SKIPPED_DEPENDENCY,
  );
});

verify('scheduler contains no blocked stop-descendants or verdict authority', () => {
  assert.equal(Object.values(SCHEDULE_STATE).includes('BLOCKED'), false);
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'controllerExecutionScheduler.js'),
    'utf8',
  );
  assert.equal(/\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
});

process.stdout.write(`OK ${passed} assertion continuation invariants\n`);
