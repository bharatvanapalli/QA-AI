import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp');

function activeObservation(overrides = {}) {
  return {
    transitionId: 'transition-1',
    armedAt: 0,
    toolName: 'browser_click',
    events: [],
    cleanupFns: [],
    cleaned: false,
    baseline: {
      url: 'https://source.example/start',
      origin: 'https://source.example',
      fingerprint: 'heading|Start\nbutton|Continue',
      pages: [],
      tabIndexes: [0],
      currentTabIndex: 0,
    },
    ...overrides,
  };
}

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms) => { time += ms; },
  };
}

describe('generic MCP page transition observer', () => {
  it('arms transition observation before raw browser action dispatch', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'server/services/mcp.js'), 'utf8');
    const armIndex = source.indexOf('transitionObservation = await armPageTransitionObservation');
    const authorizationIndex = source.indexOf('const sdkRequestOptions = options._gatewaySdkAuthorization', armIndex);
    const dispatchIndex = source.indexOf('const sdkCall = session.client.callTool(', armIndex);
    expect(armIndex).toBeGreaterThan(-1);
    expect(authorizationIndex).toBeGreaterThan(armIndex);
    expect(dispatchIndex).toBeGreaterThan(authorizationIndex);
  });

  it.each([
    ['url_changed', 'https://destination.example/home'],
    ['active_page_changed', 'https://source.example/start'],
    ['fingerprint_changed', 'https://source.example/start'],
  ])('confirms two stable %s observations without product-specific text', async (signal, currentUrl) => {
    const clock = fakeClock();
    const session = {
      activeTransitionObservation: activeObservation(),
      visitedUrls: new Set(),
      currentUrl: 'https://source.example/start',
    };

    const result = await mcp.awaitPageTransitionObservation(session, {
      timeoutMs: 2_000,
      pollIntervalMs: 250,
      stableObservations: 2,
      qaaiNow: clock.now,
      qaaiSleep: clock.sleep,
      qaaiObserve: async () => ({
        currentUrl,
        fingerprint: signal === 'fingerprint_changed'
          ? 'heading|Destination\nmain|Workspace'
          : 'heading|Stable destination',
        signals: [signal],
        usableSnapshot: true,
      }),
    });

    expect(result).toMatchObject({
      status: 'confirmed',
      matched: true,
      qaaiEvidenceError: false,
      signals: [signal],
      stableObservations: 2,
    });
  });

  it('returns typed QAAI uncertainty after bounded inconclusive evidence', async () => {
    const clock = fakeClock();
    const session = {
      activeTransitionObservation: activeObservation(),
      visitedUrls: new Set(),
      currentUrl: 'https://source.example/start',
    };

    const result = await mcp.awaitPageTransitionObservation(session, {
      timeoutMs: 500,
      pollIntervalMs: 250,
      stableObservations: 2,
      qaaiNow: clock.now,
      qaaiSleep: clock.sleep,
      qaaiObserve: async () => ({
        currentUrl: 'https://source.example/start',
        fingerprint: 'heading|Start\nbutton|Continue',
        signals: [],
        usableSnapshot: true,
      }),
    });

    expect(result).toMatchObject({
      status: 'inconclusive',
      matched: null,
      qaaiEvidenceError: true,
      retryable: true,
      retryExhausted: true,
      failureType: 'qaai_transition_evidence_inconclusive',
      reason: 'qaai_transition_evidence_inconclusive',
    });
  });

  it('parses generic MCP tab inventory for deterministic popup selection', () => {
    const tabs = mcp._parseBrowserTabList({
      content: [{
        type: 'text',
        text: '### Open tabs\n- 0: (current) [Source](https://source.example/start)\n- 1: [Destination](https://destination.example/login)',
      }],
    });

    expect(tabs).toEqual([
      expect.objectContaining({ index: 0, current: true, url: 'https://source.example/start' }),
      expect.objectContaining({ index: 1, current: false, url: 'https://destination.example/login' }),
    ]);
  });

  it('uses structural change rather than narrative words', () => {
    expect(mcp._fingerprintMateriallyChanged(
      'heading|Start\nbutton|Continue',
      'heading|Destination\ntextbox|Account\nbutton|Next',
    )).toBe(true);
    expect(mcp._fingerprintMateriallyChanged(
      'heading|Start\nbutton|Continue',
      'heading|Start\nbutton|Continue',
    )).toBe(false);
  });
});
