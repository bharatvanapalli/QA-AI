'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ADAPTER_KIND,
  CLAIM,
  createTypedAdapterPlan,
} = require('../server/services/controllerTypedAdapterRegistry');

let passed = 0;

function verify(name, check) {
  check();
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
    targetIdentity: { accessibleName: 'Email address', role: 'textbox', controlType: 'email' },
    value: 'qa@example.test',
    ...overrides,
  };
}

function resolution(identity, ref = 'e1') {
  return { target: { ref, identity } };
}

verify('password proof is protected and contains no plaintext readback claim', () => {
  const plan = createTypedAdapterPlan({
    operation: operation({
      operationId: 'action:login:password',
      actionOccurrenceId: 'occurrence:action:login:password:1',
      targetIdentity: { accessibleName: 'Password', role: 'textbox', controlType: 'password' },
      value: null,
      valueRef: 'env:LOGIN_PASSWORD',
    }),
    resolution: resolution({
      accessibleName: 'Password',
      role: 'textbox',
      controlType: 'password',
    }, 'e2'),
    context: { resolveValueRef: () => 'runtime-only-secret' },
  });
  assert.equal(plan.adapterKind, ADAPTER_KIND.PASSWORD_INPUT);
  assert.equal(plan.proofMetadata.plaintextReadbackForbidden, true);
  assert.equal(JSON.stringify(plan.proofContract).includes('runtime-only-secret'), false);
  assert.equal(JSON.stringify(plan.proofContract).includes(CLAIM.SAME_OWNER_VALUE), false);
});

verify('button proof accepts authored destination or next required control', () => {
  const plan = createTypedAdapterPlan({
    operation: operation({
      operationId: 'action:login:sign-in',
      actionOccurrenceId: 'occurrence:action:login:sign-in:1',
      type: 'Click',
      value: null,
    }),
    resolution: resolution({ accessibleName: 'Sign in', role: 'button' }, 'e3'),
  });
  const alternatives = plan.proofContract.alternatives.map((alternative) => alternative.allOf[0]);
  assert.equal(alternatives.includes(CLAIM.AUTHORED_DESTINATION), true);
  assert.equal(alternatives.includes(CLAIM.NEXT_REQUIRED_CONTROL_ACTIONABLE), true);
});

verify('dropdown planner cannot commit from popup open alone', () => {
  const plan = createTypedAdapterPlan({
    operation: operation({
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:1',
      type: 'Select',
      value: null,
      selection: { kind: 'exact_text', value: 'Dry Van' },
    }),
    resolution: resolution({ accessibleName: 'Equipment', role: 'combobox' }, 'e4'),
  });
  assert.equal(plan.mutation, null);
  assert.equal(plan.proofMetadata.popupOpenAloneNeverCommits, true);
  assert.deepEqual(plan.phases.map((phaseValue) => phaseValue.phaseId), [
    'owner-ready',
    'select-option',
    'owner-readback',
  ]);
  assert.equal(plan.protocol.metadata.atomicVirtualizedSelection, true);
  assert.equal(plan.phases[1].mutation.toolName, 'browser_evaluate');
  assert.equal(plan.phases[1].mutation.args.target, 'e4');
  assert.match(plan.phases[1].mutation.args.function, /virtualized_selection_semantic_ambiguous/);
  assert.equal(plan.phases.at(-1).commitEligible, true);
});

verify('adapter registry contains no dispatch retry stop or verdict authority', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'controllerTypedAdapterRegistry.js'),
    'utf8',
  );
  assert.equal(/\bdispatch\s*\(/.test(source), false);
  assert.equal(/\bretry\b|\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
});

process.stdout.write(`OK ${passed} typed adapter invariants\n`);
