'use strict';

const assert = require('node:assert/strict');
const {
  CONTROLLER_STATE,
  FAILURE_ATTRIBUTION,
} = require('../server/services/browserTransactionContract');
const {
  FAILURE_CAUSE,
  classifyControllerFailure,
} = require('../server/services/controllerFailureAttribution');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

verify('wrong owner or wrong authored value is a QAAI execution error', () => {
  const wrongOwner = classifyControllerFailure({
    operationKind: 'action',
    wrongTargetActed: true,
  });
  assert.equal(wrongOwner.state, CONTROLLER_STATE.EXECUTION_ERROR);
  assert.equal(wrongOwner.attribution, FAILURE_ATTRIBUTION.QAAI_EXECUTION);
  assert.equal(wrongOwner.cause, FAILURE_CAUSE.WRONG_TARGET_ACTED);
});

verify('verified valid action rejection is a product failure', () => {
  const product = classifyControllerFailure({
    operationKind: 'action',
    targetVerified: true,
    deliveryStatus: 'DELIVERED',
    authoredMutationCorrect: true,
    proofChecked: true,
    proofStatus: 'MISMATCH',
    applicationRejected: true,
  });
  assert.equal(product.state, CONTROLLER_STATE.PRODUCT_FAILURE);
  assert.equal(product.attribution, FAILURE_ATTRIBUTION.PRODUCT);
});

verify('missing evidence is never blamed on the product', () => {
  const unknown = classifyControllerFailure({
    operationKind: 'action',
    targetVerified: true,
    deliveryStatus: 'DELIVERED',
    authoredMutationCorrect: true,
    proofStatus: 'UNKNOWN',
    observationBudgetExhausted: true,
  });
  assert.equal(unknown.state, CONTROLLER_STATE.EXECUTION_ERROR);
  assert.equal(unknown.cause, FAILURE_CAUSE.EVIDENCE_BUDGET_EXHAUSTED);
});

verify('assertion mismatch is assertion failure and not execution termination', () => {
  const assertionFailure = classifyControllerFailure({
    operationKind: 'assertion',
    proofStatus: 'MISMATCH',
  });
  assert.equal(assertionFailure.state, CONTROLLER_STATE.ASSERTION_FAILED);
  assert.equal(assertionFailure.attribution, FAILURE_ATTRIBUTION.FUNCTIONAL_ASSERTION);
});

process.stdout.write(`OK ${passed} failure attribution invariants\n`);
