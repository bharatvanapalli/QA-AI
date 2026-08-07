import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SOURCE_STATUS,
  SNAPSHOT_SOURCE,
  createControllerEvidenceReader,
} = require('../../server/services/controllerEvidenceReader');

describe('controller evidence reader', () => {
  it('starts independent source reads concurrently', async () => {
    const started = [];
    const release = [];
    const deferred = () => new Promise((resolve) => release.push(resolve));
    const reader = createControllerEvidenceReader({
      readers: {
        [SNAPSHOT_SOURCE.DOM]: async () => {
          started.push('dom');
          await deferred();
          return { factRef: 'dom:1' };
        },
        [SNAPSHOT_SOURCE.ACCESSIBILITY]: async () => {
          started.push('ax');
          await deferred();
          return { factRef: 'ax:1' };
        },
      },
      perSourceDeadlineMs: 1_000,
    });
    const pending = reader.capture({
      requiredSources: [SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.ACCESSIBILITY],
      remainingMs: 1_000,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(started.sort()).toEqual(['ax', 'dom']);
    release.splice(0).forEach((resolve) => resolve({}));
    await pending;
  });

  it('bounds a stalled reader without losing a fast source result', async () => {
    const reader = createControllerEvidenceReader({
      readers: {
        [SNAPSHOT_SOURCE.DOM]: async () => ({
          claims: [{ claimId: 'email_value', status: 'MATCHED', tier: 500 }],
          factRef: 'dom:email',
        }),
        [SNAPSHOT_SOURCE.EVENT]: async () => new Promise(() => {}),
      },
      perSourceDeadlineMs: 20,
    });
    const result = await reader.capture({
      requiredSources: [SNAPSHOT_SOURCE.DOM, SNAPSHOT_SOURCE.EVENT],
      remainingMs: 100,
    });
    expect(result.claims).toHaveLength(1);
    expect(result.factRefs).toContain('dom:email');
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: SNAPSHOT_SOURCE.EVENT,
        status: SOURCE_STATUS.UNAVAILABLE,
        reason: 'CONTROLLER_EVIDENCE_SOURCE_DEADLINE',
      }),
    ]));
  });

  it('reports a missing reader as unavailable instead of throwing', async () => {
    const reader = createControllerEvidenceReader();
    await expect(reader.capture({
      requiredSources: [SNAPSHOT_SOURCE.CDP],
      remainingMs: 50,
    })).resolves.toMatchObject({
      unavailableSources: [SNAPSHOT_SOURCE.CDP],
    });
  });
});
