import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');
const authoritativeCdpCapture = require('../../server/services/authoritativeCdpCapture.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authoritative MCP candidate verification', () => {
  it('does not starve a verified lower-tier candidate after 24 failures', async () => {
    const descriptors = Array.from({ length: 25 }, (_, index) => ({
      strategy: 'generated_css',
      selector: `#candidate-${index + 1}`,
      priority: 7,
    }));
    const scope = {
      locator(selector) {
        return {
          count: async () => selector === '#candidate-25' ? 1 : 0,
          evaluate: async () => true,
        };
      },
    };
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates').mockImplementation(async ({ markers }) => (
      markers.map((marker) => ({
        id: marker.id,
        captured: true,
        identity: { backendNodeId: 4242, connected: true },
      }))
    ));

    const verified = await mcp._verifyAuthoritativeCandidateBatch({
      session: { id: 'candidate-session' },
      page: {},
      scope,
      capture: {
        captured: true,
        identity: { backendNodeId: 4242, connected: true },
      },
      descriptors,
      phase: 'candidate_starvation_regression',
      requireBackendMatch: true,
    });

    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({
      strategy: 'generated_css',
      selector: '#candidate-25',
      count: 1,
      backendNodeVerified: true,
      verified: true,
    });
    expect(verified[0].proof).toMatchObject({
      candidateUnique: true,
      expectedBackendNodeId: 4242,
      matchedBackendNodeId: 4242,
      backendNodeVerified: true,
    });
  });
});
