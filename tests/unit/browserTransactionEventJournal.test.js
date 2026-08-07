import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CONTROLLER_CAPABILITY,
  OBSERVER_ROLE,
  createControllerAuthority,
  observation,
  proposal,
} = require('../../server/services/browserTransactionAuthority');
const {
  createMemoryStore,
  createBrowserTransactionEventJournal,
  verifyJournalIntegrity,
} = require('../../server/services/browserTransactionEventJournal');

describe('BrowserTransactionEventJournal', () => {
  it('appends hash-chained facts and controller decisions without update/delete APIs', async () => {
    const journal = createBrowserTransactionEventJournal();
    await journal.appendDispatchEvent({
      eventType: 'DISPATCH_STARTED',
      occurrenceKey: 'occurrence:email::action',
      operationId: 'action:login:email',
    });
    await journal.appendControllerEvent({
      authority: createControllerAuthority(),
      capability: CONTROLLER_CAPABILITY.COMMIT_OPERATION,
      event: {
        eventType: 'TERMINAL_DECISION',
        operationId: 'action:login:email',
        state: 'COMMITTED',
      },
    });

    const events = await journal.readAll();
    expect(events).toHaveLength(2);
    expect(await journal.verifyIntegrity()).toMatchObject({ valid: true, eventCount: 2 });
    expect(journal).not.toHaveProperty('update');
    expect(journal).not.toHaveProperty('delete');
    expect(journal).not.toHaveProperty('verdict');
  });

  it('redacts sensitive values before persistence', async () => {
    const store = createMemoryStore();
    const journal = createBrowserTransactionEventJournal({ store });
    await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
      operationId: 'action:login:password',
      password: 'NeverPersistThis!',
      detail: 'token=abc123',
    }));
    const serialized = JSON.stringify(store.snapshot());
    expect(serialized).not.toContain('NeverPersistThis!');
    expect(serialized).not.toContain('abc123');
    expect(serialized).toContain('[REDACTED]');
  });

  it('accepts only proposal-only Healer and Critic envelopes', async () => {
    const journal = createBrowserTransactionEventJournal();
    await expect(journal.appendProposal(proposal(OBSERVER_ROLE.HEALER, {
      target: { role: 'button', name: 'Sign in' },
    }))).resolves.toMatchObject({ persisted: true });
    await expect(journal.appendProposal({
      kind: 'proposal',
      role: OBSERVER_ROLE.HEALER,
      mayMutateBrowser: true,
    })).rejects.toMatchObject({
      code: 'BROWSER_TRANSACTION_PROPOSAL_ENVELOPE_REQUIRED',
    });
  });

  it('detects tampering during replay', async () => {
    const store = createMemoryStore();
    const journal = createBrowserTransactionEventJournal({ store });
    await journal.appendDispatchEvent({
      eventType: 'DISPATCH_STARTED',
      occurrenceKey: 'occurrence:email::action',
    });
    const tampered = store.snapshot().map((event) => ({ ...event, eventType: 'REWRITTEN' }));
    expect(verifyJournalIntegrity(tampered)).toMatchObject({
      valid: false,
      reason: 'journal_hash_chain_invalid',
    });
  });
});
