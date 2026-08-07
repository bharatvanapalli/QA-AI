'use strict';

const assert = require('node:assert/strict');
const capture = require('../services/authoritativeCdpCapture');
const mcp = require('../services/mcp');
const resolver = require('../services/actionLocatorResolver');

function snapshotFixture({ markerValue = 'token-1', includeTarget = true, duplicateMarker = false } = {}) {
  const strings = [
    '', 'frame-main', 'https://example.test/main', 'text/html', 'UTF-8', '#document', 'HTML', 'BODY',
    'IFRAME', 'id', 'profile-frame', 'frame-child', 'https://example.test/profile', 'CUSTOM-ELEMENT',
    '#document-fragment', 'open', 'BUTTON', 'data-qaai-cdp-action-target', markerValue, 'data-testid',
    'save-profile', 'display', 'block', 'visibility', 'visible', 'opacity', '1', 'pointer-events', 'auto',
  ];
  const parent = {
    frameId: 1, documentURL: 2, baseURL: 2, contentLanguage: 0, encodingName: 4,
    nodes: {
      nodeType: [9, 1, 1, 1], nodeName: [5, 6, 7, 8], nodeValue: [0, 0, 0, 0],
      backendNodeId: [10, 11, 12, 13], parentIndex: [-1, 0, 1, 2], attributes: [[], [], [], [9, 10]],
      shadowRootType: { index: [], value: [] }, contentDocumentIndex: { index: [3], value: [1] },
    },
    layout: { nodeIndex: [1, 2, 3], bounds: [[0, 0, 1200, 900], [0, 0, 1200, 900], [20, 40, 800, 600]], styles: [[], [], []] },
  };
  const child = {
    frameId: 11, documentURL: 12, baseURL: 12, contentLanguage: 0, encodingName: 4,
    nodes: {
      nodeType: [9, 1, 1, 11, 1], nodeName: [5, 6, 13, 14, 16], nodeValue: [0, 0, 0, 0, 0],
      backendNodeId: [20, 21, 22, 23, includeTarget ? 4242 : 4342], parentIndex: [-1, 0, 1, 2, 3],
      attributes: [[], [], [9, 10], [], includeTarget ? [17, 18, 19, 20] : [19, 20]],
      shadowRootType: { index: [3], value: [15] }, contentDocumentIndex: { index: [], value: [] },
    },
    layout: {
      nodeIndex: includeTarget ? [1, 2, 4] : [1, 2],
      bounds: includeTarget ? [[0, 0, 800, 600], [0, 0, 800, 600], [10, 20, 100, 32]] : [[0, 0, 800, 600], [0, 0, 800, 600]],
      styles: includeTarget ? [[], [], [22, 24, 26, 28]] : [[], []],
    },
  };
  if (duplicateMarker) {
    child.nodes.nodeType.push(1); child.nodes.nodeName.push(16); child.nodes.nodeValue.push(0);
    child.nodes.backendNodeId.push(4343); child.nodes.parentIndex.push(3); child.nodes.attributes.push([17, 18]);
  }
  return { documents: [parent, child], strings };
}

function fakePage(snapshots, url = 'https://example.test/profile') {
  const sent = [];
  let snapshotIndex = 0;
  const cdp = {
    async send(method, params) {
      sent.push(method);
      if (method === 'DOMSnapshot.captureSnapshot') {
        const next = snapshots[Math.min(snapshotIndex++, snapshots.length - 1)];
        return typeof next === 'function' ? next() : next;
      }
      if (method === 'Accessibility.getPartialAXTree') {
        return { nodes: [{ nodeId: 'ax-4242', backendDOMNodeId: 4242, ignored: false, role: { value: 'button' }, name: { value: 'Save profile' }, properties: [] }] };
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: params.backendNodeId, localName: 'button', nodeName: 'BUTTON' } };
      if (method === 'DOM.getBoxModel') return { model: { width: 100, height: 32 } };
      return {};
    },
    async detach() { sent.push('detach'); },
  };
  const page = { url: () => url, isClosed: () => false, context: () => ({ newCDPSession: async () => cdp }) };
  return { page, sent };
}

async function main() {
  const first = fakePage([snapshotFixture()]);
  const pre = await capture.captureMarkedTarget({ page: first.page, markerAttribute: 'data-qaai-cdp-action-target', markerValue: 'token-1' });
  assert.equal(pre.captured, true);
  assert.equal(pre.identity.backendNodeId, 4242);
  assert.equal(pre.identity.frameId, 'frame-child');
  assert.equal(pre.accessibility.role, 'button');
  assert.equal(pre.accessibility.name, 'Save profile');
  assert.equal(pre.layout.visible, true);
  assert.equal(pre.framePath[0].backendNodeId, 13);
  assert.equal(pre.shadowPath[0].backendNodeId, 22);
  assert.ok(first.sent.includes('DOMSnapshot.captureSnapshot'));
  assert.ok(first.sent.includes('Accessibility.getPartialAXTree'));

  const ambiguousPage = fakePage([snapshotFixture({ duplicateMarker: true })]).page;
  const ambiguous = await capture.captureMarkedTarget({ page: ambiguousPage, markerAttribute: 'data-qaai-cdp-action-target', markerValue: 'token-1' });
  assert.equal(ambiguous.reason, 'marker_ambiguous');
  assert.equal(ambiguous.matchCount, 2);

  const postPage = fakePage([snapshotFixture(), snapshotFixture({ includeTarget: false })], 'https://example.test/after-save').page;
  const postPre = await capture.captureMarkedTarget({ page: postPage, markerAttribute: 'data-qaai-cdp-action-target', markerValue: 'token-1' });
  const [post] = await capture.captureBackendNodeStates({ page: postPage, previousCaptures: [postPre] });
  assert.equal(post.identity.connected, false);
  assert.equal(post.presentInSnapshot, false);
  assert.equal(post.pageTransitioned, true);

  let markerValue = null;
  const bridge = fakePage([() => snapshotFixture({ markerValue })]);
  const calls = [];
  const session = {
    id: 'session-1', currentUrl: 'https://example.test/profile', liveCdp: { context: { pages: () => [bridge.page] } },
    client: { async callTool(call) {
      calls.push(call);
      if (call.arguments.function.includes('setAttribute')) {
        const match = call.arguments.function.match(/setAttribute\([^,]+,\s*("(?:\\.|[^"])*")\)/);
        markerValue = match ? JSON.parse(match[1]) : null;
      }
      return { content: [{ type: 'text', text: 'true' }] };
    } },
  };
  const bridged = await mcp.captureAuthoritativeActionTarget(session, { ref: 'e42', element: 'Save profile', pageUrl: session.currentUrl });
  assert.equal(bridged.captured, true);
  assert.equal(bridged.captureBinding.ref, 'e42');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].arguments.function.includes('setAttribute'));
  assert.ok(calls[1].arguments.function.includes('removeAttribute'));

  const postAttachPage = fakePage([snapshotFixture({ includeTarget: false })], 'https://example.test/after-save').page;
  const locatorWithPre = {
    kind: 'playwright', expression: 'getByRole("button", { name: "Save profile" })',
    frameworkExpressions: { playwright: 'getByRole("button", { name: "Save profile" })' },
    context: { authoritativeCdp: { pre } }, authoritativeCdp: { pre },
  };
  const withPost = await mcp.captureAuthoritativePostAction({
    currentUrl: 'https://example.test/after-save', liveCdp: { context: { pages: () => [postAttachPage] } },
  }, locatorWithPre);
  assert.equal(withPost.context.authoritativeCdp.post.identity.connected, false);
  assert.equal(withPost.context.authoritativeCdp.post.presentInSnapshot, false);

  const unverified = {
    kind: 'playwright', verified: false,
    expression: 'getByRole("button", { name: "Save profile" })',
    frameworkExpressions: { playwright: 'getByRole("button", { name: "Save profile" })' },
    targetFacts: { role: 'button', accessibleName: 'Save profile' }, context: {},
    proof: { count: 1, sameElement: false, actionTimeResolved: false },
  };
  const enriched = resolver.attachAuthoritativeCdpEvidence(unverified, pre);
  assert.equal(enriched.proof.backendNodeId, 4242);
  assert.equal(resolver.isVerifiedActionLocator(enriched), false);

  console.log('PASS authoritative CDP capture: 6 scenarios');
}

main().catch((error) => { console.error(error); process.exit(1); });
