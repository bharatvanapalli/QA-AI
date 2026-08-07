import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const capture = require('../../server/services/authoritativeCdpCapture.js');
const mcp = require('../../server/services/mcp.js');
const resolver = require('../../server/services/actionLocatorResolver.js');

function snapshotFixture({ markerValue = 'token-1', includeTarget = true, duplicateMarker = false } = {}) {
  const strings = [
    '', 'frame-main', 'https://example.test/main', 'text/html', 'UTF-8',
    '#document', 'HTML', 'BODY', 'IFRAME', 'id', 'profile-frame',
    'frame-child', 'https://example.test/profile', 'CUSTOM-ELEMENT',
    '#document-fragment', 'open', 'BUTTON', 'data-qaai-cdp-action-target',
    markerValue, 'data-testid', 'save-profile', 'display', 'block', 'visibility',
    'visible', 'opacity', '1', 'pointer-events', 'auto',
  ];
  const parentDocument = {
    frameId: 1,
    documentURL: 2,
    baseURL: 2,
    contentLanguage: 0,
    encodingName: 4,
    nodes: {
      nodeType: [9, 1, 1, 1],
      nodeName: [5, 6, 7, 8],
      nodeValue: [0, 0, 0, 0],
      backendNodeId: [10, 11, 12, 13],
      parentIndex: [-1, 0, 1, 2],
      attributes: [[], [], [], [9, 10]],
      shadowRootType: { index: [], value: [] },
      contentDocumentIndex: { index: [3], value: [1] },
    },
    layout: { nodeIndex: [1, 2, 3], bounds: [[0, 0, 1200, 900], [0, 0, 1200, 900], [20, 40, 800, 600]], styles: [[], [], []] },
  };
  const attributes = includeTarget
    ? [17, 18, 19, 20]
    : [19, 20];
  const childDocument = {
    frameId: 11,
    documentURL: 12,
    baseURL: 12,
    contentLanguage: 0,
    encodingName: 4,
    nodes: {
      nodeType: [9, 1, 1, 11, 1],
      nodeName: [5, 6, 13, 14, 16],
      nodeValue: [0, 0, 0, 0, 0],
      backendNodeId: [20, 21, 22, 23, includeTarget ? 4242 : 4342],
      parentIndex: [-1, 0, 1, 2, 3],
      attributes: [[], [], [9, 10], [], attributes],
      shadowRootType: { index: [3], value: [15] },
      contentDocumentIndex: { index: [], value: [] },
    },
    layout: {
      nodeIndex: includeTarget ? [1, 2, 4] : [1, 2],
      bounds: includeTarget ? [[0, 0, 800, 600], [0, 0, 800, 600], [10, 20, 100, 32]] : [[0, 0, 800, 600], [0, 0, 800, 600]],
      styles: includeTarget ? [[], [], [22, 24, 26, 28]] : [[], []],
    },
  };
  if (duplicateMarker) {
    childDocument.nodes.nodeType.push(1);
    childDocument.nodes.nodeName.push(16);
    childDocument.nodes.nodeValue.push(0);
    childDocument.nodes.backendNodeId.push(4343);
    childDocument.nodes.parentIndex.push(3);
    childDocument.nodes.attributes.push([17, 18]);
  }
  return { documents: [parentDocument, childDocument], strings };
}

function fakePage(snapshots, { url = 'https://example.test/profile', axBackendNodeId = 4242, cdpFailure = null, newSessionFailure = null } = {}) {
  const sent = [];
  let snapshotIndex = 0;
  const cdp = {
    send: async (method, params) => {
      sent.push({ method, params });
      if (cdpFailure && method === cdpFailure.method) throw new Error(cdpFailure.message || 'CDP capture failed');
      if (method === 'DOMSnapshot.captureSnapshot') {
        const next = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
        return typeof next === 'function' ? next() : next;
      }
      if (method === 'Accessibility.getPartialAXTree') {
        return {
          nodes: [{
            nodeId: 'ax-4242',
            backendDOMNodeId: axBackendNodeId,
            ignored: false,
            role: { value: 'button' },
            name: { value: 'Save profile' },
            properties: [{ name: 'focusable', value: { value: true } }],
          }],
        };
      }
      if (method === 'DOM.describeNode') {
        return { node: { backendNodeId: params.backendNodeId, localName: 'button', nodeName: 'BUTTON', nodeValue: '' } };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { width: 100, height: 32, content: [10, 20, 110, 20, 110, 52, 10, 52] } };
      }
      return {};
    },
    detach: async () => { sent.push({ method: 'detach' }); },
  };
  const page = {
    url: () => url,
    isClosed: () => false,
    context: () => ({
      newCDPSession: async () => {
        if (newSessionFailure) throw new Error(newSessionFailure);
        return cdp;
      },
    }),
  };
  return { page, sent };
}

describe('authoritative Chromium CDP capture', () => {
  it('captures the exact marked backend node with frame, shadow, AX and layout evidence', async () => {
    const { page, sent } = fakePage([snapshotFixture()]);
    const result = await capture.captureMarkedTarget({
      page,
      markerAttribute: 'data-qaai-cdp-action-target',
      markerValue: 'token-1',
    });

    expect(result).toMatchObject({
      available: true,
      captured: true,
      authoritative: true,
      identity: {
        scheme: 'qaai-cdp-backend-node-v1',
        backendNodeId: 4242,
        frameId: 'frame-child',
        documentUrl: 'https://example.test/profile',
        connected: true,
      },
      accessibility: { role: 'button', name: 'Save profile', ignored: false },
      layout: { visible: true, bounds: { x: 10, y: 20, width: 100, height: 32 } },
    });
    expect(result.framePath).toHaveLength(1);
    expect(result.framePath[0]).toMatchObject({ backendNodeId: 13, attributes: { id: 'profile-frame' } });
    expect(result.shadowPath).toHaveLength(1);
    expect(result.shadowPath[0]).toMatchObject({ backendNodeId: 22, nodeName: 'CUSTOM-ELEMENT' });
    expect(sent.map((entry) => entry.method)).toEqual(expect.arrayContaining([
      'DOM.enable',
      'Accessibility.enable',
      'DOMSnapshot.captureSnapshot',
      'Accessibility.getPartialAXTree',
      'DOM.describeNode',
      'DOM.getBoxModel',
      'detach',
    ]));
  });

  it('rejects an ambiguous marker instead of selecting an arbitrary node', async () => {
    const { page } = fakePage([snapshotFixture({ duplicateMarker: true })]);
    const result = await capture.captureMarkedTarget({
      page,
      markerAttribute: 'data-qaai-cdp-action-target',
      markerValue: 'token-1',
    });
    expect(result).toMatchObject({ captured: false, authoritative: false, reason: 'marker_ambiguous', matchCount: 2 });
  });

  it('does not borrow accessibility facts when AX has no exact backend-node match', async () => {
    const { page } = fakePage([snapshotFixture()], { axBackendNodeId: 9999 });
    const result = await capture.captureMarkedTarget({
      page,
      markerAttribute: 'data-qaai-cdp-action-target',
      markerValue: 'token-1',
    });
    expect(result.captured).toBe(true);
    expect(result.identity.backendNodeId).toBe(4242);
    expect(result.accessibility).toMatchObject({
      role: null,
      name: null,
      description: null,
      ignored: null,
      properties: {},
    });
  });

  it('records when the original backend node disappears after the action', async () => {
    const { page } = fakePage([snapshotFixture(), snapshotFixture({ includeTarget: false })], {
      url: 'https://example.test/after-save',
    });
    const pre = await capture.captureMarkedTarget({
      page,
      markerAttribute: 'data-qaai-cdp-action-target',
      markerValue: 'token-1',
    });
    const [post] = await capture.captureBackendNodeStates({ page, previousCaptures: [pre] });
    expect(post).toMatchObject({
      captured: true,
      authoritative: true,
      presentInSnapshot: false,
      pageTransitioned: true,
      identity: { backendNodeId: 4242, connected: false },
    });
  });

  it('marks and removes only the MCP-bound target around the real CDP capture', async () => {
    let markerValue = null;
    const { page } = fakePage([() => snapshotFixture({ markerValue })]);
    const calls = [];
    const session = {
      id: 'session-1',
      currentUrl: 'https://example.test/profile',
      liveCdp: { context: { pages: () => [page] } },
      client: {
        callTool: async (call) => {
          calls.push(call);
          if (call.arguments.function.includes('setAttribute')) {
            const match = call.arguments.function.match(/setAttribute\([^,]+,\s*("(?:\\.|[^"])*")\)/);
            markerValue = match ? JSON.parse(match[1]) : null;
          }
          return { content: [{ type: 'text', text: 'true' }] };
        },
      },
    };
    const result = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e42',
      element: 'Save profile',
      pageUrl: 'https://example.test/profile',
    });
    expect(result).toMatchObject({
      captured: true,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e42' },
      identity: { backendNodeId: 4242 },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.name === 'browser_evaluate' && call.arguments.target === 'e42')).toBe(true);
    expect(calls[0].arguments.function).toContain('setAttribute');
    expect(calls[1].arguments.function).toContain('removeAttribute');
  });

  it('removes the bound marker and detaches the CDP session when snapshot capture throws', async () => {
    let markerValue = null;
    const { page, sent } = fakePage([() => snapshotFixture({ markerValue })], {
      cdpFailure: { method: 'DOMSnapshot.captureSnapshot', message: 'snapshot transport failed' },
    });
    const calls = [];
    const result = await mcp.captureAuthoritativeActionTarget({
      id: 'session-failure',
      currentUrl: 'https://example.test/profile',
      liveCdp: { context: { pages: () => [page] } },
      client: {
        callTool: async (call) => {
          calls.push(call);
          if (call.arguments.function.includes('setAttribute')) {
            const match = call.arguments.function.match(/setAttribute\([^,]+,\s*("(?:\\.|[^"])*")\)/);
            markerValue = match ? JSON.parse(match[1]) : null;
          }
          return { content: [{ type: 'text', text: 'true' }] };
        },
      },
    }, { ref: 'e42', element: 'Save profile' });

    expect(result).toMatchObject({ captured: false, authoritative: false, reason: 'cdp_capture_failed' });
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments.function).toContain('setAttribute');
    expect(calls[1].arguments.function).toContain('removeAttribute');
    expect(sent.map((entry) => entry.method)).toContain('detach');
  });

  it('rejects non-Chromium CDP sessions without inventing capture evidence', async () => {
    const { page } = fakePage([snapshotFixture()], {
      newSessionFailure: 'browserContext.newCDPSession: CDP session is only supported on Chromium',
    });
    const result = await capture.captureMarkedTarget({
      page,
      markerAttribute: 'data-qaai-cdp-action-target',
      markerValue: 'token-1',
    });
    expect(result).toMatchObject({
      available: false,
      captured: false,
      authoritative: false,
      reason: 'chromium_cdp_unavailable',
    });
  });

  it('never promotes an unverified locator merely because CDP captured a backend node', () => {
    const locator = {
      kind: 'playwright',
      verified: false,
      expression: 'getByRole("button", { name: "Save profile" })',
      frameworkExpressions: { playwright: 'getByRole("button", { name: "Save profile" })' },
      targetFacts: { role: 'button', accessibleName: 'Save profile' },
      context: {},
      proof: { count: 1, sameElement: false, actionTimeResolved: false },
    };
    const enriched = resolver.attachAuthoritativeCdpEvidence(locator, {
      captured: true,
      identity: { backendNodeId: 4242, frameId: 'frame-child', documentUrl: 'https://example.test/profile' },
      accessibility: { role: 'button', name: 'Save profile' },
      framePath: [],
      shadowPath: [],
    });
    expect(enriched.proof).toMatchObject({ authoritativeCdpCaptured: true, backendNodeId: 4242 });
    expect(resolver.isVerifiedActionLocator(enriched)).toBe(false);
  });

  it('attaches post-action state to the same captured backend identity', async () => {
    const { page } = fakePage([snapshotFixture({ includeTarget: false })], {
      url: 'https://example.test/after-save',
    });
    const pre = {
      captured: true,
      identity: {
        scheme: 'qaai-cdp-backend-node-v1',
        backendNodeId: 4242,
        documentUrl: 'https://example.test/profile',
        connected: true,
      },
    };
    const locator = {
      kind: 'playwright',
      expression: 'getByRole("button", { name: "Save profile" })',
      frameworkExpressions: { playwright: 'getByRole("button", { name: "Save profile" })' },
      context: { authoritativeCdp: { pre } },
      authoritativeCdp: { pre },
    };
    const updated = await mcp.captureAuthoritativePostAction({
      currentUrl: 'https://example.test/after-save',
      liveCdp: { context: { pages: () => [page] } },
    }, locator);
    expect(updated.context.authoritativeCdp).toMatchObject({
      pre: { identity: { backendNodeId: 4242, connected: true } },
      post: { identity: { backendNodeId: 4242, connected: false }, presentInSnapshot: false },
    });
  });

  it('degrades a stalled CDP post-capture instead of holding the browser action open', async () => {
    let detached = false;
    const cdp = {
      send: async () => await new Promise(() => {}),
      detach: async () => { detached = true; },
    };
    const page = {
      url: () => 'https://example.test/profile',
      context: () => ({ newCDPSession: async () => cdp }),
    };
    const startedAt = Date.now();
    const [post] = await capture.captureBackendNodeStates({
      page,
      timeoutMs: 35,
      previousCaptures: [{
        captured: true,
        identity: { backendNodeId: 4242, documentUrl: 'https://example.test/profile' },
      }],
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(detached).toBe(true);
    expect(post).toMatchObject({
      captured: false,
      authoritative: false,
      reason: 'cdp_post_capture_failed',
      backendNodeId: 4242,
    });
    expect(post.detail).toContain('exceeded 35ms');
  });
});
