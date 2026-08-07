'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const proposals = require('../server/services/controllerRecoveryProposals');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

const operation = {
  operationId: 'action:login:sign-in',
  actionOccurrenceId: 'occurrence:action:login:sign-in:1',
  type: 'Click',
  targetIdentity: { role: 'button', accessibleName: 'Sign in' },
};

verify('Healer target proposal remains non-mutating and is semantically verified', () => {
  const typed = proposals.normalizeHealerProposal({
    targetIdentity: { role: 'button', accessibleName: 'Sign in' },
    actionType: 'Click',
    supportingFactRefs: ['snapshot:auth-form'],
  }, {
    operation,
    browserEpoch: 'epoch:1',
    now: 100,
  });
  assert.equal(typed.mayMutateBrowser, false);
  assert.equal(typed.mayChangeVerdict, false);
  assert.equal(typed.mayStopExecution, false);
  const verified = proposals.verifyRecoveryProposal({
    proposal: typed,
    operation,
    browserEpoch: 'epoch:1',
    now: 101,
    evidenceFactRefs: ['snapshot:auth-form'],
    candidates: [{
      source: 'ax',
      browserEpoch: 'epoch:1',
      ref: 'e79',
      identity: { role: 'button', accessibleName: 'Sign in', backendNodeId: 79 },
      connected: true,
      actionable: true,
      factRef: 'ax:79',
    }],
  });
  assert.equal(verified.status, proposals.PROPOSAL_STATUS.VERIFIED);
  assert.equal(verified.targetResolution.target.ref, 'e79');
});

verify('stale Critic proposal cannot become a recovery directive', () => {
  const typed = proposals.normalizeCriticProposal({
    targetIdentity: { role: 'button', accessibleName: 'Dismiss' },
    supportingFactRefs: ['snapshot:dialog'],
  }, {
    operation,
    browserEpoch: 'epoch:1',
    now: 100,
  });
  const verified = proposals.verifyRecoveryProposal({
    proposal: typed,
    operation,
    browserEpoch: 'epoch:2',
    now: 101,
  });
  assert.equal(verified.status, proposals.PROPOSAL_STATUS.STALE);
  assert.throws(
    () => proposals.recoveryDirectiveFromVerifiedProposal({ verifiedProposal: verified, operation }),
    (error) => error?.code === 'CONTROLLER_RECOVERY_PROPOSAL_NOT_VERIFIED',
  );
});

verify('proposal bridge owns no dispatch stop or verdict', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'controllerRecoveryProposals.js'),
    'utf8',
  );
  assert.equal(/\bdispatch\s*\(|require\(['"]\.\/(?:controllerActionExecutionGateway|mcp)/.test(source), false);
  assert.equal(/\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
});

process.stdout.write(`OK ${passed} recovery proposal invariants\n`);
