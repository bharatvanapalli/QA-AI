import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_STATE,
  FAILURE_ATTRIBUTION,
} = require('../../server/services/browserTransactionContract');
const {
  FAILURE_CAUSE,
  classifyControllerFailure,
} = require('../../server/services/controllerFailureAttribution');

describe('controller failure attribution', () => {
  it('attributes wrong target and wrong value to QAAI execution', () => {
    expect(classifyControllerFailure({
      operationKind: 'action',
      wrongTargetActed: true,
    })).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      attribution: FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      cause: FAILURE_CAUSE.WRONG_TARGET_ACTED,
    });
    expect(classifyControllerFailure({
      operationKind: 'action',
      authoredMutationCorrect: false,
    })).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      cause: FAILURE_CAUSE.QAAI_SENT_WRONG_VALUE,
    });
  });

  it('attributes only a proven valid action rejection to the product', () => {
    expect(classifyControllerFailure({
      operationKind: 'action',
      targetVerified: true,
      deliveryStatus: 'DELIVERED',
      authoredMutationCorrect: true,
      proofChecked: true,
      proofStatus: 'MISMATCH',
      applicationRejected: true,
    })).toMatchObject({
      state: CONTROLLER_STATE.PRODUCT_FAILURE,
      attribution: FAILURE_ATTRIBUTION.PRODUCT,
      cause: FAILURE_CAUSE.APPLICATION_REJECTED_VALID_ACTION,
    });
  });

  it('never turns missing evidence into a product failure', () => {
    expect(classifyControllerFailure({
      operationKind: 'action',
      targetVerified: true,
      deliveryStatus: 'DELIVERED',
      authoredMutationCorrect: true,
      proofStatus: 'UNKNOWN',
      observationBudgetExhausted: true,
    })).toMatchObject({
      state: CONTROLLER_STATE.EXECUTION_ERROR,
      attribution: FAILURE_ATTRIBUTION.QAAI_EXECUTION,
      cause: FAILURE_CAUSE.EVIDENCE_BUDGET_EXHAUSTED,
    });
  });

  it('always classifies assertion mismatch as assertion failure', () => {
    expect(classifyControllerFailure({
      operationKind: 'assertion',
      proofStatus: 'MISMATCH',
    })).toMatchObject({
      state: CONTROLLER_STATE.ASSERTION_FAILED,
      attribution: FAILURE_ATTRIBUTION.FUNCTIONAL_ASSERTION,
      cause: FAILURE_CAUSE.ASSERTION_MISMATCH,
    });
  });
});
