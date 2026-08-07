import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const journalService = require('../../server/services/actionTransactionJournal');

function fixedClock(start = '2026-07-20T10:00:00.000Z') {
  let tick = 0;
  return () => Date.parse(start) + tick++;
}

function createJournal(overrides = {}) {
  return journalService.createActionTransactionJournal({
    runId: 'run-1',
    runResultId: 'result-1',
    caseId: 'case-1',
    ...overrides,
  }, { now: () => Date.parse('2026-07-20T09:00:00.000Z') });
}

function appendAttempt(journal, overrides = {}, options = {}) {
  return journalService.appendJournalEntry(journal, {
    actionOccurrenceId: 'action-1',
    stepId: 'step-1',
    sequenceIndex: 1,
    action: { kind: 'click', target: { role: 'button', name: 'Continue' } },
    replay: { kind: 'click', locator: "getByRole('button', { name: 'Continue' })" },
    preEvidenceRefs: ['evidence://pre/1'],
    ...overrides,
  }, options);
}

function latest(journal, actionOccurrenceId = 'action-1') {
  return journalService.latestEntryForOccurrence(journal, actionOccurrenceId);
}

function canonicalize(journal, actionOccurrenceId = 'action-1', patch = {}, options = {}) {
  const current = latest(journal, actionOccurrenceId);
  return journalService.appendReplacement(journal, current.journalEntryId, {
    attemptStatus: journalService.ATTEMPT_STATUS.CANONICAL,
    canonicalOutcome: { status: 'passed', matched: true, reason: 'postcondition_proven' },
    dispatch: {
      status: journalService.DISPATCH_STATUS.DELIVERED,
      markerPersistedAt: '2026-07-20T10:00:00.000Z',
      dispatchTimestamp: '2026-07-20T10:00:00.100Z',
      dispatchAttempt: 1,
    },
    actionEvidenceRefs: ['evidence://action/1'],
    postEvidenceRefs: ['evidence://post/1'],
    ...patch,
  }, options);
}

describe('actionTransactionJournal', () => {
  it('creates a stable RunResult-friendly JSON journal', () => {
    const first = createJournal();
    const second = createJournal();

    expect(first.journalId).toBe(second.journalId);
    expect(first).toMatchObject({
      schemaVersion: journalService.JOURNAL_SCHEMA_VERSION,
      runId: 'run-1',
      runResultId: 'result-1',
      caseId: 'case-1',
      revision: 0,
      entries: [],
    });
    expect(journalService.hydrateActionTransactionJournal(
      journalService.serializeActionTransactionJournal(first),
    )).toEqual(first);
  });

  it('appends attempt records without mutating old journal snapshots', () => {
    const original = createJournal();
    const next = appendAttempt(original, {
      attemptId: 'attempt-1',
      actionEvidenceId: 'action-evidence-1',
      assertionEvidenceId: 'assertion-evidence-1',
    }, { now: () => Date.parse('2026-07-20T10:00:00.000Z') });

    expect(original.entries).toEqual([]);
    expect(original.revision).toBe(0);
    expect(next.revision).toBe(1);
    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]).toMatchObject({
      recordType: journalService.RECORD_TYPE.ACTION_ATTEMPT,
      actionOccurrenceId: 'action-1',
      attemptId: 'attempt-1',
      attemptStatus: journalService.ATTEMPT_STATUS.ATTEMPTED,
      actionEvidenceId: 'action-evidence-1',
      assertionEvidenceId: 'assertion-evidence-1',
      dispatch: { status: journalService.DISPATCH_STATUS.NOT_DISPATCHED },
      preEvidenceRefs: ['evidence://pre/1'],
    });
  });

  it('persists an immutable dispatch marker before a browser dispatch timestamp exists', () => {
    const attempted = appendAttempt(createJournal());
    const attemptedEntry = latest(attempted);
    const marked = journalService.appendDispatchMarker(attempted, attemptedEntry.journalEntryId, {
      dispatchAttempt: 1,
    }, { now: () => Date.parse('2026-07-20T10:00:01.000Z') });

    expect(attempted.entries[0].dispatch.status).toBe(journalService.DISPATCH_STATUS.NOT_DISPATCHED);
    expect(marked.entries).toHaveLength(2);
    expect(latest(marked)).toMatchObject({
      recordType: journalService.RECORD_TYPE.DISPATCH_MARKER,
      replacesJournalEntryId: attemptedEntry.journalEntryId,
      dispatch: {
        status: journalService.DISPATCH_STATUS.DISPATCH_MARKED,
        markerPersistedAt: '2026-07-20T10:00:01.000Z',
        dispatchTimestamp: null,
        dispatchAttempt: 1,
      },
    });
  });

  it('keeps corrections append-only and projects only the latest canonical replacement', () => {
    const attempted = appendAttempt(createJournal());
    const originalEntry = attempted.entries[0];
    const corrected = canonicalize(attempted, 'action-1', {
      replay: { kind: 'click', locator: "getByTestId('continue')" },
    });

    expect(attempted.entries[0]).toEqual(originalEntry);
    expect(corrected.entries).toHaveLength(2);
    expect(corrected.entries[0].attemptStatus).toBe(journalService.ATTEMPT_STATUS.ATTEMPTED);
    expect(journalService.projectCanonicalReplay(corrected)).toEqual([
      expect.objectContaining({
        actionOccurrenceId: 'action-1',
        replay: { kind: 'click', locator: "getByTestId('continue')" },
        canonicalOutcome: expect.objectContaining({ status: 'passed' }),
      }),
    ]);
  });

  it('rejects branching corrections from an entry that already has a replacement', () => {
    const attempted = appendAttempt(createJournal());
    const originalId = attempted.entries[0].journalEntryId;
    const corrected = journalService.appendReplacement(attempted, originalId, {
      actionEvidenceRefs: ['evidence://action/corrected'],
    });

    expect(() => journalService.appendReplacement(corrected, originalId, {
      actionEvidenceRefs: ['evidence://action/branch'],
    })).toThrow(/not the latest immutable entry/);
  });

  it('retains retry history while canonical replay selects only the successful retry', () => {
    let journal = appendAttempt(createJournal(), { ledgerLineId: 'ledger-1' });
    journal = canonicalize(journal, 'action-1', {
      canonicalOutcome: { status: 'failed', matched: false, reason: 'first_attempt_failed' },
    });
    const prior = latest(journal);
    journal = journalService.appendRetryAttempt(journal, prior.journalEntryId, {
      actionOccurrenceId: 'action-1-retry-1',
      ledgerLineId: 'ledger-1',
    });
    journal = canonicalize(journal, 'action-1-retry-1', {
      canonicalOutcome: { status: 'passed', matched: true, reason: 'retry_proven' },
    });

    expect(journal.entries).toHaveLength(4);
    expect(journalService.projectCanonicalReplay(journal)).toEqual([
      expect.objectContaining({
        actionOccurrenceId: 'action-1-retry-1',
        retryOfActionOccurrenceId: 'action-1',
        canonicalOutcome: expect.objectContaining({ status: 'passed' }),
      }),
    ]);
  });

  it('saves and loads through pluggable repository callbacks using isolated snapshots', async () => {
    let stored = null;
    const repository = {
      save: vi.fn(async (snapshot) => {
        stored = JSON.stringify(snapshot);
        snapshot.entries.push({ callerMutation: true });
      }),
      load: vi.fn(async () => stored),
    };
    const journal = await journalService.appendAndPersist(createJournal(), {
      actionOccurrenceId: 'action-1',
      action: { kind: 'navigate', requestedUrl: 'https://example.test/' },
    }, { repository });
    const loaded = await journalService.loadActionTransactionJournal(repository, {
      runResultId: 'result-1',
    });

    expect(repository.save).toHaveBeenCalledOnce();
    expect(repository.load).toHaveBeenCalledWith({ runResultId: 'result-1' });
    expect(journal.entries).toHaveLength(1);
    expect(loaded).toEqual(journal);
  });

  it('reconciles a crash-after-dispatch marker without any redispatch capability', async () => {
    let journal = appendAttempt(createJournal(), {
      action: { kind: 'select', target: { role: 'combobox', name: 'Equipment' }, valueRef: 'data://equipment' },
    });
    journal = journalService.appendDispatchMarker(journal, latest(journal).journalEntryId, {}, {
      now: () => Date.parse('2026-07-20T10:00:02.000Z'),
    });
    const dispatch = vi.fn();
    const repository = vi.fn(async () => {});
    const observe = vi.fn(async () => ({
      postEvidenceRefs: ['evidence://post/equipment-ltl'],
      ownerValue: 'LTL',
    }));

    const result = await journalService.reconcileJournalOnResume(journal, 'action-1', {
      repository,
      dispatch,
      observe,
      provePostcondition: async ({ observation }) => ({
        matched: observation.ownerValue === 'LTL',
        checked: true,
        reason: 'owner_control_value_matched',
      }),
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    expect(repository).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      resumed: true,
      reconciled: true,
      redispatched: false,
      shouldRedispatch: false,
      outcome: { status: 'passed', matched: true },
    });
    expect(result.entry.postEvidenceRefs).toContain('evidence://post/equipment-ltl');
    expect(journalService.projectCanonicalReplay(result.journal)).toHaveLength(1);
  });

  it('keeps observing an unresolved resumed action and never asks for blind redispatch', async () => {
    let journal = appendAttempt(createJournal());
    journal = journalService.appendDispatchMarker(journal, latest(journal).journalEntryId);
    const observe = vi.fn(async ({ attempt }) => ({
      postEvidenceRefs: [`evidence://post/unavailable-${attempt}`],
    }));

    const result = await journalService.reconcileJournalOnResume(journal, 'action-1', {
      observe,
      provePostcondition: async () => ({
        matched: null,
        checked: false,
        terminal: false,
        reason: 'snapshot_temporarily_unavailable',
      }),
      maxObservationAttempts: 2,
    });

    expect(observe).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBeNull();
    expect(result.shouldRedispatch).toBe(false);
    expect(result.redispatched).toBe(false);
    expect(journalService.projectCanonicalReplay(result.journal)).toEqual([]);
    expect(result.entry.postEvidenceRefs).toEqual([
      'evidence://post/unavailable-0',
      'evidence://post/unavailable-1',
    ]);
  });

  it('returns an already canonical occurrence without observing or dispatching again', async () => {
    const journal = canonicalize(appendAttempt(createJournal()));
    const observe = vi.fn();
    const dispatch = vi.fn();
    const result = await journalService.reconcileJournalOnResume(journal, 'action-1', {
      observe,
      dispatch,
      provePostcondition: vi.fn(),
    });

    expect(observe).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reconciled: false,
      redispatched: false,
      shouldRedispatch: false,
      outcome: { status: 'passed' },
    });
  });

  it('removes raw secrets from journal JSON and repository snapshots', async () => {
    const rawPassword = 'Behavior-ticket-organize1*';
    const rawToken = 'top-secret-access-token';
    let journal = appendAttempt(createJournal(), {
      action: {
        kind: 'fill',
        target: { role: 'textbox', name: 'Password', inputType: 'password' },
        value: rawPassword,
        valueRef: 'env://LOGIN_PASSWORD',
        password: rawPassword,
      },
      preEvidenceRefs: [{ id: 'pre-1', actual: rawPassword, sensitive: true }],
    });
    journal = canonicalize(journal, 'action-1', {
      canonicalOutcome: {
        status: 'passed',
        reason: `authorization=Bearer ${rawToken}`,
        evidence: { password: rawPassword, accessToken: rawToken },
      },
    });
    let repositorySnapshot = '';
    await journalService.saveActionTransactionJournal((snapshot) => {
      repositorySnapshot = JSON.stringify(snapshot);
    }, journal);
    const serialized = journalService.serializeActionTransactionJournal(journal);

    for (const output of [serialized, repositorySnapshot]) {
      expect(output).not.toContain(rawPassword);
      expect(output).not.toContain(rawToken);
      expect(output).toContain('env://LOGIN_PASSWORD');
      expect(output).toContain('redacted://action-journal/');
    }
  });

  it('redacts sensitive readback aliases, nested outcomes, arrays, errors, and full snapshots', () => {
    const secret = 'Sensitive-Alias-Value-91!';
    const suppliedRef = 'vault://login/password';
    const legacy = {
      ...createJournal(),
      revision: 1,
      entries: [{
        schemaVersion: 1,
        journalEntryId: 'legacy-sensitive-entry',
        journalId: 'journal-1',
        ordinal: 0,
        recordType: 'action_attempt',
        actionOccurrenceId: 'action-sensitive',
        attemptId: 'attempt-sensitive',
        attemptIndex: 0,
        attemptStatus: 'canonical',
        mutating: true,
        action: {
          kind: 'fill',
          target: { role: 'textbox', name: 'Password', inputType: 'password' },
          password: secret,
          passwordRef: suppliedRef,
        },
        canonicalOutcome: {
          status: 'passed',
          evidence: {
            valueAfter: secret,
            ActualValue: secret,
            inputValue: secret,
            ownerValue: secret,
            selectedValues: [secret],
            note: secret,
          },
        },
        reconciliation: { error: new Error(secret) },
        preEvidenceRefs: [{
          observation: {
            fresh: true,
            url: `https://example.test/login?token=${secret}`,
            snapshotText: `<input value="${secret}">`,
          },
        }],
        actionEvidenceRefs: [],
        postEvidenceRefs: [],
        dispatch: { status: 'delivered', dispatchAttempt: 1 },
        recordedAt: '2026-07-21T00:00:00.000Z',
      }],
    };

    const hydrated = journalService.hydrateActionTransactionJournal(legacy);
    const serialized = journalService.serializeActionTransactionJournal(hydrated);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain(suppliedRef);
    expect(hydrated.entries[0]).toMatchObject({
      sensitive: true,
      canonicalOutcome: { status: 'passed' },
    });
    expect(hydrated.entries[0].preEvidenceRefs[0].observation).toMatchObject({
      fresh: true,
      usable: true,
    });
    expect(hydrated.entries[0].preEvidenceRefs[0].observation.snapshotText).toBeUndefined();
  });

  it('builds matching ledger, action, assertion, URL, and failure-boundary parity', () => {
    let journal = appendAttempt(createJournal(), {
      actionOccurrenceId: 'navigate-1',
      sequenceIndex: 1,
      ledgerLineId: 'ledger-1',
      action: { kind: 'navigate', requestedUrl: 'https://example.test/orders' },
    });
    journal = canonicalize(journal, 'navigate-1', {
      urlTransition: { requestedUrl: '/orders', resolvedUrl: '/orders' },
    });
    journal = appendAttempt(journal, {
      actionOccurrenceId: 'fill-1',
      sequenceIndex: 2,
      ledgerLineId: 'ledger-2',
      action: { kind: 'fill', target: { role: 'textbox', name: 'Order Number' }, valueRef: 'data://order-number' },
    });
    journal = canonicalize(journal, 'fill-1');
    journal = appendAttempt(journal, {
      actionOccurrenceId: 'assert-1',
      sequenceIndex: 3,
      ledgerLineId: 'ledger-3',
      action: { kind: 'assert_text', target: { role: 'heading', name: 'Create New Order' } },
      assertion: { kind: 'text', expected: 'Create New Order' },
    });
    journal = canonicalize(journal, 'assert-1', {
      canonicalOutcome: { status: 'failed', matched: false, reason: 'exact_text_mismatch' },
      failureBoundary: { stepId: 'step-1', assertionId: 'assertion-1' },
    });

    const summary = journalService.buildParitySummary(journal, {
      ledgerActionCount: 3,
      actionCount: 2,
      assertionCount: 1,
      urlTransitionCount: 1,
      failureBoundary: { stepId: 'step-1', assertionId: 'assertion-1' },
    });

    expect(summary.complete).toBe(true);
    expect(summary.drift).toEqual([]);
    expect(summary.actual).toEqual({
      ledgerActionCount: 3,
      actionCount: 2,
      assertionCount: 1,
      urlTransitionCount: 1,
      failureBoundary: { stepId: 'step-1', assertionId: 'assertion-1' },
    });
    expect(Object.values(summary.parity)).toEqual([true, true, true, true, true]);
  });

  it('reports precise parity drift without changing canonical history', () => {
    const journal = canonicalize(appendAttempt(createJournal(), {
      ledgerLineId: 'ledger-1',
    }));
    const snapshot = JSON.stringify(journal);
    const summary = journalService.buildParitySummary(journal, {
      expectedLedgerActionCount: 2,
      expectedActionCount: 2,
      expectedAssertionCount: 1,
      expectedUrlTransitionCount: 1,
      expectedFailureBoundary: { stepId: 'step-9' },
    });

    expect(summary.complete).toBe(false);
    expect(summary.drift.map((item) => item.dimension)).toEqual([
      'ledgerActionCount',
      'actionCount',
      'assertionCount',
      'urlTransitionCount',
      'failureBoundary',
    ]);
    expect(JSON.stringify(journal)).toBe(snapshot);
  });
});
