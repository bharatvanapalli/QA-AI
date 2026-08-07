import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DRAFT_VERSION,
  createAddScenarioDraftRegistry,
} = require('../../server/services/addScenarioDraftRegistry');

function clock(initial = 1_000) {
  let value = initial;
  return {
    now: () => value,
    set: (next) => { value = next; },
    advance: (amount) => { value += amount; },
  };
}

function preview({
  previewId = 'preview-1',
  revision = 'sha256-revision-1',
  sourceDigest = 'sha256-source-1',
  currentGenerationId = 'generation-5',
  persisted = false,
} = {}) {
  return {
    version: 'AddScenarioPreviewV1',
    previewId,
    revision,
    source: {
      digest: sourceDigest,
      text: 'Fill the approved field with inline data.',
    },
    persistence: {
      status: persisted ? 'persisted' : 'not_persisted',
      currentGenerationId,
      scenarioCountCreated: persisted ? 1 : 0,
      caseCountCreated: persisted ? 1 : 0,
    },
    scenarios: [],
  };
}

function semanticPlan(label = 'Order Number') {
  return {
    sourceCompleteness: { complete: true, findings: [] },
    caseContractV1: {
      version: 'CaseContractV1',
      sourceCoverage: [{ sourceRef: 'source.1', operationId: 'step.1' }],
      cases: [{
        id: 'case.1',
        sessionRequirement: { mode: 'continue_from_case', predecessorCaseId: 'case.login' },
        steps: [{ id: 'step.1', ordinal: 1, type: 'Fill', targetIdentity: { label } }],
        assertions: [],
      }],
    },
  };
}

function draftInput(overrides = {}) {
  const snapshot = overrides.preview || preview({
    previewId: overrides.previewId || 'preview-1',
    revision: overrides.revision || 'sha256-revision-1',
    sourceDigest: overrides.sourceDigest || 'sha256-source-1',
    currentGenerationId: overrides.currentGenerationId || 'generation-5',
  });
  return {
    userId: 'user-a',
    projectId: 'project-a',
    draftId: 'draft-a',
    previewId: snapshot.previewId,
    originalSource: 'Email=test@example.com\nPassword=inline-test-secret',
    semanticPlan: semanticPlan(),
    preview: snapshot,
    currentGenerationId: snapshot.persistence.currentGenerationId,
    revision: snapshot.revision,
    sourceDigest: snapshot.source.digest,
    ...overrides,
  };
}

describe('addScenarioDraftRegistry', () => {
  it('stores immutable authority and reads it by draft ID or preview ID', () => {
    const time = clock();
    const registry = createAddScenarioDraftRegistry({ ttlMs: 500, maxEntries: 10, now: time.now });
    const input = draftInput();
    const created = registry.put(input);

    expect(created.ok).toBe(true);
    expect(created.status).toBe(201);
    expect(created.created).toBe(true);
    expect(created.draft).toEqual(expect.objectContaining({
      version: DRAFT_VERSION,
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      previewId: 'preview-1',
      currentGenerationId: 'generation-5',
      revision: 'sha256-revision-1',
      sourceDigest: 'sha256-source-1',
      createdAt: 1_000,
      updatedAt: 1_000,
      lastAccess: 1_000,
      expiresAt: 1_500,
    }));
    expect(Object.isFrozen(created.draft)).toBe(true);
    expect(Object.isFrozen(created.draft.semanticPlan)).toBe(true);
    expect(Object.isFrozen(created.draft.preview)).toBe(true);

    input.semanticPlan.caseContractV1.cases[0].steps[0].targetIdentity.label = 'MUTATED';
    input.preview.revision = 'MUTATED';
    time.advance(100);
    const byPreview = registry.get({
      userId: 'user-a',
      projectId: 'project-a',
      previewId: 'preview-1',
    });
    expect(byPreview.ok).toBe(true);
    expect(byPreview.draft.semanticPlan.caseContractV1.cases[0].steps[0].targetIdentity.label)
      .toBe('Order Number');
    expect(byPreview.draft.preview.revision).toBe('sha256-revision-1');
    expect(byPreview.draft.lastAccess).toBe(1_100);
    expect(byPreview.draft.expiresAt).toBe(1_600);

    const byDraft = registry.get({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
    });
    expect(byDraft.ok).toBe(true);
    expect(byDraft.draft.previewId).toBe('preview-1');
  });

  it('updates only the same preview through expected-revision compare-and-swap', () => {
    const time = clock();
    const registry = createAddScenarioDraftRegistry({ ttlMs: 500, now: time.now });
    const created = registry.put(draftInput()).draft;
    time.advance(50);
    const nextPreview = preview({ revision: 'sha256-revision-2' });
    const nextPlan = semanticPlan('Reviewed Order Number');
    const updated = registry.update({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      revision: 'sha256-revision-2',
      sourceDigest: 'sha256-source-1',
      semanticPlan: nextPlan,
      preview: nextPreview,
    });

    expect(updated.ok).toBe(true);
    expect(updated.status).toBe(200);
    expect(updated.previousRevision).toBe('sha256-revision-1');
    expect(updated.draft.revision).toBe('sha256-revision-2');
    expect(updated.draft.previewId).toBe(created.previewId);
    expect(updated.draft.originalSource).toBe(created.originalSource);
    expect(updated.draft.currentGenerationId).toBe(created.currentGenerationId);
    expect(updated.draft.createdAt).toBe(created.createdAt);
    expect(updated.draft.updatedAt).toBe(1_050);
    expect(updated.draft.lastAccess).toBe(1_050);
    expect(updated.draft.semanticPlan.caseContractV1.cases[0].steps[0].targetIdentity.label)
      .toBe('Reviewed Order Number');
    expect(updated.draft.preview.persistence.status).toBe('not_persisted');
    expect(Object.isFrozen(updated.draft)).toBe(true);
  });

  it('refreshes a same-owner ready preview instead of blocking an explicitly reviewed interpretation', () => {
    const registry = createAddScenarioDraftRegistry();
    expect(registry.put(draftInput()).ok).toBe(true);
    const refreshedPreview = preview({ revision: 'sha256-revision-2' });
    const refreshed = registry.put(draftInput({
      revision: 'sha256-revision-2',
      preview: refreshedPreview,
      semanticPlan: semanticPlan('Reviewed Order Number'),
      allowSameOwnerRefresh: true,
    }));

    expect(refreshed).toMatchObject({ ok: true, status: 201, created: true });
    expect(refreshed.draft.revision).toBe('sha256-revision-2');
    expect(refreshed.draft.semanticPlan.caseContractV1.cases[0].steps[0].targetIdentity.label)
      .toBe('Reviewed Order Number');
    expect(registry.size()).toBe(1);
  });

  it('reuses an active or completed same-owner approval instead of overwriting it', () => {
    const registry = createAddScenarioDraftRegistry();
    const created = registry.put(draftInput()).draft;
    const claim = registry.beginApproval({
      userId: 'user-a', projectId: 'project-a', draftId: created.draftId,
      expectedRevision: created.revision, expectedGenerationId: created.currentGenerationId,
    });
    const replacement = registry.put(draftInput({
      revision: 'sha256-revision-2',
      preview: preview({ revision: 'sha256-revision-2' }),
      semanticPlan: semanticPlan('Must Not Replace Active Approval'),
      allowSameOwnerRefresh: true,
    }));

    expect(replacement).toMatchObject({
      ok: true,
      created: false,
      reused: true,
      approvalStatus: 'approving',
    });
    expect(replacement.draft.revision).toBe(created.revision);
    expect(replacement.draft.approval.token).toBe(claim.approvalToken);
  });

  it('returns a stale 409 without mutating content or revision', () => {
    const time = clock();
    const registry = createAddScenarioDraftRegistry({ now: time.now });
    const created = registry.put(draftInput()).draft;
    const attemptedPreview = preview({ revision: 'sha256-revision-2' });
    const stale = registry.update({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-stale',
      revision: 'sha256-revision-2',
      sourceDigest: 'sha256-source-1',
      semanticPlan: semanticPlan('Should Not Apply'),
      preview: attemptedPreview,
    });

    expect(stale).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'ADD_SCENARIO_DRAFT_REVISION_STALE',
      expectedRevision: 'sha256-stale',
      currentRevision: 'sha256-revision-1',
    }));

    const valid = registry.update({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: created.revision,
      revision: 'sha256-revision-2',
      sourceDigest: created.sourceDigest,
      semanticPlan: semanticPlan('Applied After Stale Attempt'),
      preview: attemptedPreview,
    });
    expect(valid.ok).toBe(true);
    expect(valid.draft.originalSource).toBe(created.originalSource);
    expect(valid.draft.semanticPlan.caseContractV1.cases[0].steps[0].targetIdentity.label)
      .toBe('Applied After Stale Attempt');
  });

  it('does not reveal drafts across user or project boundaries', () => {
    const registry = createAddScenarioDraftRegistry();
    expect(registry.put(draftInput()).ok).toBe(true);

    for (const identity of [
      { userId: 'user-b', projectId: 'project-a', draftId: 'draft-a' },
      { userId: 'user-a', projectId: 'project-b', draftId: 'draft-a' },
      { userId: 'user-b', projectId: 'project-a', previewId: 'preview-1' },
      { userId: 'user-a', projectId: 'project-b', previewId: 'preview-1' },
      { userId: 'user-a', projectId: 'project-a', draftId: 'unknown' },
    ]) {
      expect(registry.get(identity)).toEqual(expect.objectContaining({
        ok: false,
        status: 404,
        code: 'ADD_SCENARIO_DRAFT_NOT_FOUND',
      }));
    }

    const isolated = registry.put(draftInput({
      userId: 'user-b',
      projectId: 'project-a',
      draftId: 'draft-a',
    }));
    expect(isolated.ok).toBe(true);
    expect(registry.size()).toBe(2);
  });

  it('uses a sliding TTL and removes expired drafts', () => {
    const time = clock(0);
    const registry = createAddScenarioDraftRegistry({ ttlMs: 100, now: time.now });
    registry.put(draftInput());

    time.set(90);
    expect(registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' }).ok)
      .toBe(true);
    time.set(189);
    expect(registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' }).ok)
      .toBe(true);
    time.set(290);
    const expired = registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' });
    expect(expired.status).toBe(404);
    expect(registry.size()).toBe(0);
  });

  it('evicts the least recently accessed draft when the registry is full', () => {
    const time = clock(0);
    const registry = createAddScenarioDraftRegistry({ ttlMs: 10_000, maxEntries: 2, now: time.now });
    registry.put(draftInput({ draftId: 'draft-a', previewId: 'preview-a', preview: preview({ previewId: 'preview-a' }) }));
    time.set(1);
    registry.put(draftInput({ draftId: 'draft-b', previewId: 'preview-b', preview: preview({ previewId: 'preview-b' }) }));
    time.set(2);
    registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' });
    time.set(3);
    registry.put(draftInput({ draftId: 'draft-c', previewId: 'preview-c', preview: preview({ previewId: 'preview-c' }) }));

    expect(registry.size()).toBe(2);
    expect(registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-b' }).status).toBe(404);
    expect(registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' }).ok).toBe(true);
    expect(registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-c' }).ok).toBe(true);
  });

  it('rejects persisted previews and source-changing updates', () => {
    const registry = createAddScenarioDraftRegistry();
    const persisted = preview({ persisted: true });
    const rejectedPut = registry.put(draftInput({ preview: persisted }));
    expect(rejectedPut).toEqual(expect.objectContaining({
      ok: false,
      status: 400,
      code: 'ADD_SCENARIO_DRAFT_ALREADY_PERSISTED',
    }));

    expect(registry.put(draftInput()).ok).toBe(true);
    const sourceChangedPreview = preview({
      revision: 'sha256-revision-2',
      sourceDigest: 'sha256-source-2',
    });
    const rejectedUpdate = registry.update({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      revision: 'sha256-revision-2',
      sourceDigest: 'sha256-source-2',
      semanticPlan: semanticPlan('Changed Source'),
      preview: sourceChangedPreview,
    });
    expect(rejectedUpdate).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'ADD_SCENARIO_DRAFT_SOURCE_CONFLICT',
    }));
  });

  it('claims approval once and replays the first immutable completed result', () => {
    const time = clock();
    const registry = createAddScenarioDraftRegistry({ now: time.now });
    expect(registry.put(draftInput()).ok).toBe(true);
    const authority = {
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      expectedGenerationId: 'generation-5',
    };

    const claimed = registry.beginApproval(authority);
    expect(claimed).toEqual(expect.objectContaining({
      ok: true,
      status: 202,
      mode: 'acquired',
    }));
    expect(claimed.approvalToken).toEqual(expect.any(String));
    expect(claimed.draft.approval).toEqual(expect.objectContaining({
      status: 'approving',
      attempts: 1,
      token: claimed.approvalToken,
    }));
    expect(Object.isFrozen(claimed.draft)).toBe(true);
    expect(Object.isFrozen(claimed.draft.approval)).toBe(true);

    const concurrent = registry.beginApproval(authority);
    expect(concurrent).toEqual(expect.objectContaining({
      ok: true,
      status: 202,
      mode: 'in_progress',
      approvalToken: claimed.approvalToken,
    }));
    expect(concurrent.draft.approval.attempts).toBe(1);

    time.advance(1);
    const authoritativeResult = {
      generationId: 'generation-5',
      scenarioIds: ['scenario-1'],
      caseIds: ['case-1'],
    };
    const completed = registry.completeApproval({
      ...authority,
      approvalToken: claimed.approvalToken,
      approvalResult: authoritativeResult,
    });
    expect(completed).toEqual(expect.objectContaining({
      ok: true,
      status: 200,
      mode: 'completed',
      approvalResult: authoritativeResult,
    }));
    expect(completed.draft.approval.status).toBe('completed');
    expect(Object.isFrozen(completed.draft.approval.result)).toBe(true);

    authoritativeResult.scenarioIds.push('scenario-mutated');
    const replayedBegin = registry.beginApproval(authority);
    expect(replayedBegin).toEqual(expect.objectContaining({
      ok: true,
      mode: 'replay',
      approvalResult: {
        generationId: 'generation-5',
        scenarioIds: ['scenario-1'],
        caseIds: ['case-1'],
      },
    }));
    const replayedComplete = registry.completeApproval({
      ...authority,
      approvalToken: 'different-token',
      approvalResult: { generationId: 'different-generation' },
    });
    expect(replayedComplete.mode).toBe('replay');
    expect(replayedComplete.approvalResult).toEqual(replayedBegin.approvalResult);
    expect(replayedComplete.draft.approval.attempts).toBe(1);
  });

  it('rejects wrong ownership, revision, and generation without claiming approval', () => {
    const registry = createAddScenarioDraftRegistry();
    expect(registry.put(draftInput()).ok).toBe(true);
    const base = {
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      expectedGenerationId: 'generation-5',
    };

    expect(registry.beginApproval({
      ...base,
      userId: 'user-b',
      projectId: 'project-a',
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 404,
      code: 'ADD_SCENARIO_DRAFT_NOT_FOUND',
    }));
    expect(registry.beginApproval({
      ...base,
      userId: 'user-a',
      projectId: 'project-b',
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 404,
      code: 'ADD_SCENARIO_DRAFT_NOT_FOUND',
    }));
    expect(registry.beginApproval({
      ...base,
      userId: 'user-a',
      projectId: 'project-a',
      expectedRevision: 'sha256-stale',
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'ADD_SCENARIO_DRAFT_REVISION_STALE',
    }));
    expect(registry.beginApproval({
      ...base,
      userId: 'user-a',
      projectId: 'project-a',
      expectedGenerationId: 'generation-stale',
    })).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'ADD_SCENARIO_DRAFT_GENERATION_STALE',
    }));

    const valid = registry.beginApproval({
      ...base,
      userId: 'user-a',
      projectId: 'project-a',
    });
    expect(valid.mode).toBe('acquired');
    expect(valid.draft.approval.attempts).toBe(1);
  });

  it('releases a failed claim to ready and permits one clean retry', () => {
    const time = clock();
    const registry = createAddScenarioDraftRegistry({ now: time.now });
    expect(registry.put(draftInput()).ok).toBe(true);
    const authority = {
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      expectedGenerationId: 'generation-5',
    };
    const first = registry.beginApproval(authority);

    const staleFailure = registry.failApproval({
      ...authority,
      approvalToken: 'stale-token',
    });
    expect(staleFailure).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'ADD_SCENARIO_DRAFT_APPROVAL_TOKEN_STALE',
    }));
    expect(registry.beginApproval(authority).approvalToken).toBe(first.approvalToken);

    time.advance(1);
    const released = registry.failApproval({
      ...authority,
      approvalToken: first.approvalToken,
    });
    expect(released).toEqual(expect.objectContaining({
      ok: true,
      mode: 'released',
      approvalToken: null,
    }));
    expect(released.draft.approval).toEqual(expect.objectContaining({
      status: 'ready',
      attempts: 1,
      token: null,
      result: null,
    }));

    time.advance(1);
    const retry = registry.beginApproval(authority);
    expect(retry.mode).toBe('acquired');
    expect(retry.approvalToken).not.toBe(first.approvalToken);
    expect(retry.draft.approval.attempts).toBe(2);
  });

  it('prevents refinement while an approval claim is active', () => {
    const registry = createAddScenarioDraftRegistry();
    expect(registry.put(draftInput()).ok).toBe(true);
    const authority = {
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      expectedGenerationId: 'generation-5',
    };
    const claimed = registry.beginApproval(authority);
    expect(claimed.mode).toBe('acquired');

    const revisedPreview = preview({ revision: 'sha256-revision-2' });
    const locked = registry.update({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
      expectedRevision: 'sha256-revision-1',
      revision: 'sha256-revision-2',
      sourceDigest: 'sha256-source-1',
      semanticPlan: semanticPlan('Updated Order Number'),
      preview: revisedPreview,
    });
    expect(locked).toEqual(expect.objectContaining({
      ok: false,
      status: 409,
      code: 'ADD_SCENARIO_DRAFT_APPROVAL_LOCKED',
    }));
    expect(registry.get({
      userId: 'user-a',
      projectId: 'project-a',
      draftId: 'draft-a',
    }).draft.revision).toBe('sha256-revision-1');
  });

  it('reloads a non-persisted draft after restart without exposing inline source in the store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qaai-add-scenario-drafts-'));
    const storePath = join(directory, 'drafts.json');
    const encryptionKey = Buffer.alloc(32, 7);
    const time = clock(1_000);
    try {
      const first = createAddScenarioDraftRegistry({
        ttlMs: 500,
        maxEntries: 10,
        now: time.now,
        persist: true,
        storePath,
        encryptionKey,
      });
      const created = first.put(draftInput());
      expect(created.ok).toBe(true);
      expect(created.persistence).toEqual(expect.objectContaining({ ok: true, durable: true }));

      const storedText = readFileSync(storePath, 'utf8');
      expect(storedText).toContain('"redacted": true');
      expect(storedText).not.toContain('inline-test-secret');
      expect(storedText).not.toContain('Fill the approved field with inline data.');

      time.advance(100);
      const restarted = createAddScenarioDraftRegistry({
        ttlMs: 500,
        maxEntries: 10,
        now: time.now,
        persist: true,
        storePath,
        encryptionKey,
      });
      const loaded = restarted.get({
        userId: 'user-a',
        projectId: 'project-a',
        draftId: 'draft-a',
      });
      expect(loaded.ok).toBe(true);
      expect(loaded.draft.originalSource).toContain('inline-test-secret');
      expect(loaded.draft.revision).toBe('sha256-revision-1');

      const replay = restarted.put(draftInput());
      expect(replay).toEqual(expect.objectContaining({ ok: true, created: false }));
      expect(restarted.size()).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes expired durable drafts during restart hydration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qaai-add-scenario-expiry-'));
    const storePath = join(directory, 'drafts.json');
    const encryptionKey = Buffer.alloc(32, 9);
    const time = clock(1_000);
    try {
      const first = createAddScenarioDraftRegistry({
        ttlMs: 100,
        now: time.now,
        persist: true,
        storePath,
        encryptionKey,
      });
      expect(first.put(draftInput()).ok).toBe(true);
      time.set(1_101);
      const restarted = createAddScenarioDraftRegistry({
        ttlMs: 100,
        now: time.now,
        persist: true,
        storePath,
        encryptionKey,
      });
      expect(restarted.size()).toBe(0);
      expect(restarted.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' }))
        .toEqual(expect.objectContaining({ ok: false, code: 'ADD_SCENARIO_DRAFT_NOT_FOUND' }));
      expect(JSON.parse(readFileSync(storePath, 'utf8')).recordCount).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('releases an interrupted approval claim on restart and preserves retry idempotency', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qaai-add-scenario-approval-recovery-'));
    const storePath = join(directory, 'drafts.json');
    const encryptionKey = Buffer.alloc(32, 11);
    try {
      const first = createAddScenarioDraftRegistry({ persist: true, storePath, encryptionKey });
      expect(first.put(draftInput()).ok).toBe(true);
      const authority = {
        userId: 'user-a', projectId: 'project-a', draftId: 'draft-a',
        expectedRevision: 'sha256-revision-1', expectedGenerationId: 'generation-5',
      };
      const interrupted = first.beginApproval(authority);
      expect(interrupted.mode).toBe('acquired');

      const restarted = createAddScenarioDraftRegistry({ persist: true, storePath, encryptionKey });
      const recovered = restarted.get(authority);
      expect(recovered.draft.approval).toEqual(expect.objectContaining({
        status: 'ready',
        token: null,
        attempts: 1,
        recoveredAfterRestart: true,
      }));
      const retried = restarted.beginApproval(authority);
      expect(retried.mode).toBe('acquired');
      expect(retried.draft.approval.attempts).toBe(2);
      expect(restarted.beginApproval(authority).approvalToken).toBe(retried.approvalToken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rolls back a draft mutation and reports the durable write failure to its caller', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qaai-add-scenario-write-failure-'));
    const storePath = join(directory, 'blocked-store');
    mkdirSync(storePath);
    try {
      const registry = createAddScenarioDraftRegistry({
        persist: true,
        storePath,
        encryptionKey: Buffer.alloc(32, 13),
      });

      const failed = registry.put(draftInput());

      expect(failed).toEqual(expect.objectContaining({
        ok: false,
        status: 503,
        code: 'ADD_SCENARIO_DRAFT_STORE_WRITE_FAILED',
        persistence: expect.objectContaining({ ok: false, durable: false }),
      }));
      expect(registry.size()).toBe(0);
      expect(registry.get({ userId: 'user-a', projectId: 'project-a', draftId: 'draft-a' }))
        .toEqual(expect.objectContaining({ ok: false, code: 'ADD_SCENARIO_DRAFT_NOT_FOUND' }));

      rmSync(storePath, { recursive: true, force: true });
      const retried = registry.put(draftInput());
      expect(retried).toEqual(expect.objectContaining({ ok: true, created: true }));
      expect(registry.size()).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('has no logging or database persistence dependency', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'server/services/addScenarioDraftRegistry.js'),
      'utf8',
    );
    expect(source).not.toMatch(/console\s*\./);
    const dependencies = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map((match) => match[1]);
    expect(dependencies).toEqual(['node:crypto', 'node:fs', 'node:path']);
  });
});
