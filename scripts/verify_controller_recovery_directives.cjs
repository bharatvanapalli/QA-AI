'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createControllerAuthority } = require('../server/services/browserTransactionAuthority');
const recovery = require('../server/services/controllerRecoveryDirectives');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const operation = {
  operationId: 'action:login:sign-in',
  actionOccurrenceId: 'occurrence:action:login:sign-in:1',
};

verify('delivery uncertainty authorizes observation only and never redispatch', () => {
  const directive = recovery.createRecoveryDirective({
    operation,
    issue: recovery.RECOVERY_ISSUE.DELIVERY_UNCERTAIN,
  });
  const authorized = recovery.authorizeRecoveryDirective({
    authority: createControllerAuthority(),
    directive,
  });
  assert.equal(authorized.directive, recovery.RECOVERY_DIRECTIVE.OBSERVE_ONLY);
  assert.equal(authorized.mayMutateBrowser, false);
  assert.equal(authorized.recoveryOccurrenceId, null);
  assert.equal(authorized.mayRedispatchOriginalOccurrence, false);
});

verify('recovery mutation receives a distinct single-use occurrence', () => {
  const directive = recovery.createRecoveryDirective({
    operation,
    issue: recovery.RECOVERY_ISSUE.PREREQUISITE_ERASED,
  });
  const authorized = recovery.authorizeRecoveryDirective({
    authority: createControllerAuthority(),
    directive,
  });
  assert.notEqual(authorized.recoveryOccurrenceId, operation.actionOccurrenceId);
  assert.throws(
    () => recovery.authorizeRecoveryDirective({
      authority: createControllerAuthority(),
      directive,
    }),
    (error) => error?.code === 'CONTROLLER_RECOVERY_DIRECTIVE_REUSED',
  );
});

verify('positive nondelivery does not create an automatic retry directive', () => {
  const directive = recovery.createRecoveryDirective({
    operation,
    issue: recovery.RECOVERY_ISSUE.POSITIVE_NON_DELIVERY,
  });
  assert.equal(directive.directive, recovery.RECOVERY_DIRECTIVE.TERMINATE_REQUIRED_MUTATION);
  assert.equal(directive.mayMutateBrowser, false);
});

verify('recovery module authorizes directives but performs no transport mutation', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'controllerRecoveryDirectives.js'),
    'utf8',
  );
  assert.equal(/\bdispatch\s*\(|require\(['"]\.\/(?:controllerActionExecutionGateway|mcp)/.test(source), false);
  assert.equal(/\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
});

process.stdout.write(`OK ${passed} recovery directive invariants\n`);
