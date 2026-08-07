'use strict';

const AUTHORITY_VERSION = 'qaai-browser-transaction-authority-v1';
const CONTROLLER_OWNER = 'BrowserTransactionController';

const CONTROLLER_CAPABILITY = Object.freeze({
  SCHEDULE_OPERATION: 'SCHEDULE_OPERATION',
  AUTHORIZE_MUTATION: 'AUTHORIZE_MUTATION',
  AUTHORIZE_REDISPATCH: 'AUTHORIZE_REDISPATCH',
  COMMIT_OPERATION: 'COMMIT_OPERATION',
  DECIDE_CONTINUATION: 'DECIDE_CONTINUATION',
  PAUSE_MANUAL_BOUNDARY: 'PAUSE_MANUAL_BOUNDARY',
  CANCEL_RUN: 'CANCEL_RUN',
  PROJECT_VERDICT: 'PROJECT_VERDICT',
});

const OBSERVER_ROLE = Object.freeze({
  RESOLVER: 'RESOLVER',
  ADAPTER: 'ADAPTER',
  EVIDENCE_READER: 'EVIDENCE_READER',
  SNAPSHOT_READER: 'SNAPSHOT_READER',
  HEALER: 'HEALER',
  CRITIC: 'CRITIC',
  WAIT_SYNCHRONIZER: 'WAIT_SYNCHRONIZER',
  PERSISTENCE_WRITER: 'PERSISTENCE_WRITER',
});

const CAPABILITY_VALUES = new Set(Object.values(CONTROLLER_CAPABILITY));
const mintedAuthorities = new WeakSet();

class BrowserTransactionAuthorityError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserTransactionAuthorityError';
    this.code = code;
    Object.assign(this, details);
  }
}

function createControllerAuthority() {
  const authority = Object.freeze({
    schemaVersion: AUTHORITY_VERSION,
    owner: CONTROLLER_OWNER,
  });
  mintedAuthorities.add(authority);
  return authority;
}

function assertControllerAuthority(authority, capability) {
  if (!mintedAuthorities.has(authority)
    || authority?.schemaVersion !== AUTHORITY_VERSION
    || authority?.owner !== CONTROLLER_OWNER) {
    throw new BrowserTransactionAuthorityError(
      'Only BrowserTransactionController may make execution decisions.',
      'BROWSER_TRANSACTION_CONTROLLER_AUTHORITY_REQUIRED',
      { capability: capability || null },
    );
  }
  if (!CAPABILITY_VALUES.has(capability)) {
    throw new BrowserTransactionAuthorityError(
      `Unknown controller capability: ${String(capability || '<empty>')}`,
      'BROWSER_TRANSACTION_CONTROLLER_CAPABILITY_INVALID',
      { capability: capability || null },
    );
  }
  return Object.freeze({
    schemaVersion: AUTHORITY_VERSION,
    owner: CONTROLLER_OWNER,
    capability,
  });
}

function observation(role, facts = {}) {
  if (!Object.values(OBSERVER_ROLE).includes(role)) {
    throw new BrowserTransactionAuthorityError(
      `Unknown observation role: ${String(role || '<empty>')}`,
      'BROWSER_TRANSACTION_OBSERVER_ROLE_INVALID',
      { role: role || null },
    );
  }
  return Object.freeze({
    schemaVersion: AUTHORITY_VERSION,
    role,
    kind: 'observation',
    facts: Object.freeze({ ...(facts || {}) }),
  });
}

function proposal(role, proposalValue = {}) {
  if (![OBSERVER_ROLE.HEALER, OBSERVER_ROLE.CRITIC].includes(role)) {
    throw new BrowserTransactionAuthorityError(
      'Only Healer and Critic may submit recovery proposals.',
      'BROWSER_TRANSACTION_PROPOSAL_ROLE_INVALID',
      { role: role || null },
    );
  }
  return Object.freeze({
    schemaVersion: AUTHORITY_VERSION,
    role,
    kind: 'proposal',
    proposal: Object.freeze({ ...(proposalValue || {}) }),
    mayMutateBrowser: false,
    mayChangeVerdict: false,
    mayStopExecution: false,
  });
}

module.exports = {
  AUTHORITY_VERSION,
  CONTROLLER_OWNER,
  CONTROLLER_CAPABILITY,
  OBSERVER_ROLE,
  BrowserTransactionAuthorityError,
  createControllerAuthority,
  assertControllerAuthority,
  observation,
  proposal,
};
