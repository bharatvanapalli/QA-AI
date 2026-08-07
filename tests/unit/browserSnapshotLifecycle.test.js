import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SNAPSHOT_STATUS,
  SNAPSHOT_SOURCE,
  createBrowserSnapshotLifecycle,
} = require('../../server/services/browserSnapshotLifecycle');

function validSnapshot(overrides = {}) {
  return {
    snapshotId: 'snapshot:1',
    browserEpoch: 'epoch:1',
    capturedAtMs: 100,
    sources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
    snapshotText: 'textbox "Email address"',
    domNodeCount: 3,
    ...overrides,
  };
}

describe('BrowserSnapshotLifecycle', () => {
  it('retries a transient white page by recapturing observation only', async () => {
    const capture = vi.fn()
      .mockResolvedValueOnce({
        browserEpoch: 'epoch:1',
        capturedAtMs: 100,
        sources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
        snapshotText: '',
        domNodeCount: 0,
        axNodeCount: 0,
        screenshotUniformWhite: true,
      })
      .mockResolvedValueOnce(validSnapshot({ snapshotId: 'snapshot:2' }));
    const lifecycle = createBrowserSnapshotLifecycle({
      capture,
      now: () => 100,
      sleep: async () => {},
    });
    const result = await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: SNAPSHOT_STATUS.VALID,
      snapshotId: 'snapshot:2',
      attempts: 2,
    });
  });

  it('reuses a valid same-epoch snapshot with the required sources', async () => {
    const capture = vi.fn().mockResolvedValue(validSnapshot());
    const lifecycle = createBrowserSnapshotLifecycle({
      capture,
      now: () => 100,
    });
    await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    const cached = await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(cached).toMatchObject({ status: SNAPSHOT_STATUS.VALID, cacheHit: true, attempts: 0 });
  });

  it('does not retry confirmed session loss', async () => {
    const capture = vi.fn().mockResolvedValue({
      browserEpoch: 'epoch:1',
      browserAlive: false,
      sessionLost: true,
    });
    const lifecycle = createBrowserSnapshotLifecycle({ capture, now: () => 100 });
    const result = await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      deadlineAtMs: 500,
      maxAttempts: 5,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(SNAPSHOT_STATUS.SESSION_LOST);
  });

  it('invalidates cached evidence after a browser mutation', async () => {
    const capture = vi.fn().mockImplementation(async ({ browserEpoch }) => (
      validSnapshot({ browserEpoch })
    ));
    const lifecycle = createBrowserSnapshotLifecycle({ capture, now: () => 100 });
    await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    expect(lifecycle.invalidate({ browserEpoch: 'epoch:2' })).toMatchObject({ invalidated: true });
    await lifecycle.acquire({
      browserEpoch: 'epoch:2',
      requiredSources: [SNAPSHOT_SOURCE.DOM],
      deadlineAtMs: 500,
    });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('recaptures a URL/title-only SPA shell when the operation requires controls', async () => {
    const capture = vi.fn()
      .mockResolvedValueOnce(validSnapshot({
        snapshotId: 'snapshot:shell',
        snapshotText: '- Page URL: https://example.test/email\n- Page Title: Portal',
        domNodeCount: 0,
        axNodeCount: 0,
      }))
      .mockResolvedValueOnce(validSnapshot({ snapshotId: 'snapshot:interactive' }));
    const lifecycle = createBrowserSnapshotLifecycle({
      capture,
      now: () => 100,
      sleep: async () => {},
    });
    const result = await lifecycle.acquire({
      browserEpoch: 'epoch:1',
      requiredSources: [SNAPSHOT_SOURCE.BROWSER_SNAPSHOT, SNAPSHOT_SOURCE.DOM],
      minimumCandidateCount: 1,
      deadlineAtMs: 500,
    });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: SNAPSHOT_STATUS.VALID,
      snapshotId: 'snapshot:interactive',
      attempts: 2,
    });
  });
});
