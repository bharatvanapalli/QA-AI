'use strict';

const assert = require('node:assert/strict');
const {
  CONTROLLER_CAPABILITY,
  OBSERVER_ROLE,
  createControllerAuthority,
  observation,
} = require('../server/services/browserTransactionAuthority');
const {
  createMemoryStore,
  createBrowserTransactionEventJournal,
  verifyJournalIntegrity,
} = require('../server/services/browserTransactionEventJournal');

let passed = 0;

async function verify(name, check) {
  await check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

(async () => {
  await verify('journal is append-only and hash chained', async () => {
    const journal = createBrowserTransactionEventJournal();
    await journal.appendDispatchEvent({
      eventType: 'DISPATCH_INTENT_PERSISTED',
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
    assert.deepEqual(await journal.verifyIntegrity(), {
      valid: true,
      eventCount: 2,
      headHash: (await journal.readAll())[1].eventHash,
    });
    assert.equal(Object.hasOwn(journal, 'update'), false);
    assert.equal(Object.hasOwn(journal, 'delete'), false);
  });

  await verify('journal redacts secrets before persistence', async () => {
    const store = createMemoryStore();
    const journal = createBrowserTransactionEventJournal({ store });
    await journal.appendObservation(observation(OBSERVER_ROLE.EVIDENCE_READER, {
      operationId: 'action:login:password',
      password: 'NeverPersistThis!',
      note: 'token=abc123',
    }));
    const source = JSON.stringify(store.snapshot());
    assert.equal(source.includes('NeverPersistThis!'), false);
    assert.equal(source.includes('abc123'), false);
  });

  await verify('hash replay detects rewritten history', async () => {
    const journal = createBrowserTransactionEventJournal();
    await journal.appendDispatchEvent({ eventType: 'DISPATCH_STARTED', occurrenceKey: 'x' });
    const rewritten = (await journal.readAll()).map((event) => ({ ...event, eventType: 'REWRITTEN' }));
    assert.equal(verifyJournalIntegrity(rewritten).valid, false);
  });

  process.stdout.write(`OK ${passed} append-only journal invariants\n`);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
