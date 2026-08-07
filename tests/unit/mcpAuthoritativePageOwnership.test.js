import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');
const authoritativeCdpCapture = require('../../server/services/authoritativeCdpCapture.js');
const locatorCaptureAnalysis = require('../../server/services/locatorCaptureAnalysis.js');

function createContext() {
  const pages = [];
  return {
    pages: () => pages.slice(),
    pagesForTest: pages,
    async newCDPSession(page) {
      return {
        async send(method) {
          if (method === 'Target.getTargetInfo') {
            return { targetInfo: { targetId: page.targetIdForTest } };
          }
          return {};
        },
        async detach() {},
      };
    },
  };
}

function createPage(context, {
  url = 'https://example.test/workspace',
  targetId = 'target-1',
  opener = null,
} = {}) {
  let closed = false;
  const page = {
    targetIdForTest: targetId,
    url: () => url,
    context: () => context,
    opener: async () => opener,
    isClosed: () => closed,
    closeForTest: () => { closed = true; },
  };
  context.pagesForTest.push(page);
  return page;
}

function actionLocatorFor(pre) {
  return {
    kind: 'playwright',
    expression: pre.selectedCandidate?.expression || 'getByTestId("save")',
    context: { authoritativeCdp: { pre } },
    authoritativeCdp: { pre },
  };
}

function capturedPre(pageIdentity, overrides = {}) {
  return {
    schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
    available: true,
    captured: true,
    authoritative: true,
    source: 'chromium_cdp',
    phase: 'pre_action',
    identity: {
      backendNodeId: 101,
      documentUrl: 'https://example.test/workspace',
      connected: true,
    },
    pageIdentity,
    framePath: [],
    framePathSelectors: [],
    framePathExportable: true,
    node: { nodeName: 'BUTTON', attributes: { 'data-testid': 'save' } },
    accessibility: { role: 'button', name: 'Save' },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP authoritative page ownership and post-action context', () => {
  it('retains target, popup, and opener identity for the exact Playwright Page', async () => {
    const context = createContext();
    const opener = createPage(context, { targetId: 'target-opener' });
    const popup = createPage(context, { targetId: 'target-popup', opener });
    const session = { id: 'session-popup', liveCdp: { context } };

    const identity = await mcp._authoritativePageIdentity(session, popup, {
      popupIdentity: { id: 'popup-payment' },
    });

    expect(identity).toMatchObject({
      url: 'https://example.test/workspace',
      targetId: 'target-popup',
      isPopup: true,
      popupIdentity: { id: 'popup-payment' },
    });
    expect(identity.pageId).toBeTruthy();
    expect(identity.openerPageId).toBeTruthy();
    expect(identity.openerPageId).not.toBe(identity.pageId);
    expect(mcp._exactAuthoritativePageForIdentity(session, identity)).toMatchObject({
      page: popup,
      pageId: identity.pageId,
      reason: null,
    });
  });

  it('captures post state only from the exact pre-action page when sibling URLs are identical', async () => {
    const context = createContext();
    const source = createPage(context, { targetId: 'target-source' });
    createPage(context, { targetId: 'target-sibling' });
    const session = { id: 'session-exact-page', liveCdp: { context } };
    const pageIdentity = await mcp._authoritativePageIdentity(session, source);
    const pre = capturedPre(pageIdentity);
    const capture = vi.spyOn(authoritativeCdpCapture, 'captureBackendNodeStates')
      .mockImplementation(async ({ page, previousCaptures }) => {
        expect(page).toBe(source);
        return previousCaptures.map((previous) => ({
          schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
          available: true,
          captured: true,
          authoritative: true,
          source: 'chromium_cdp',
          phase: 'post_action',
          identity: { ...previous.identity, connected: true },
          presentInSnapshot: true,
          sameBackendNode: true,
        }));
      });

    const updated = await mcp.captureAuthoritativePostAction(
      session,
      actionLocatorFor(pre),
      { pageUrl: 'https://example.test/workspace' },
    );

    expect(capture).toHaveBeenCalledTimes(1);
    expect(updated.context.authoritativeCdp.post).toMatchObject({
      pageIdentity: { pageId: pageIdentity.pageId, targetId: 'target-source' },
      presentInSnapshot: true,
      sameBackendNode: true,
      replacement: null,
      removed: false,
    });
  });

  it('returns an explicit nonblocking page_closed post gap without scanning another page', async () => {
    const context = createContext();
    const source = createPage(context, { targetId: 'target-closed' });
    createPage(context, { targetId: 'target-live-sibling' });
    const session = { id: 'session-page-closed', liveCdp: { context } };
    const pageIdentity = await mcp._authoritativePageIdentity(session, source);
    const pre = capturedPre(pageIdentity);
    source.closeForTest();
    const capture = vi.spyOn(authoritativeCdpCapture, 'captureBackendNodeStates');

    const updated = await mcp.captureAuthoritativePostAction(session, actionLocatorFor(pre));

    expect(capture).not.toHaveBeenCalled();
    expect(updated.context.authoritativeCdp.post).toMatchObject({
      captured: false,
      authoritative: false,
      reason: 'page_closed',
      nonBlocking: true,
      presentInSnapshot: false,
      sameBackendNode: false,
      replacement: null,
      removed: false,
      gap: { code: 'authoritative_post_page_closed', nonBlocking: true },
    });
  });

  it('reacquires a rerendered node only through the exact stabilized candidate recipe', async () => {
    const context = createContext();
    const source = createPage(context, { targetId: 'target-rerender' });
    const candidateLocator = {
      count: async () => 1,
      evaluate: async () => true,
    };
    source.getByTestId = () => candidateLocator;
    const session = { id: 'session-rerender', liveCdp: { context } };
    const pageIdentity = await mcp._authoritativePageIdentity(session, source);
    const selectedCandidate = {
      strategy: 'testid',
      attribute: 'data-testid',
      value: 'save',
      expression: 'getByTestId("save")',
      framePath: [],
      proof: { authoritativeCdpVerified: true, backendNodeVerified: true },
    };
    const pre = capturedPre(pageIdentity, {
      selectedCandidate,
      stabilization: { stableAcrossSnapshots: true },
    });
    vi.spyOn(authoritativeCdpCapture, 'captureBackendNodeStates').mockResolvedValue([{
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: true,
      captured: true,
      authoritative: true,
      source: 'chromium_cdp',
      phase: 'post_action',
      identity: { ...pre.identity, connected: false },
      presentInSnapshot: false,
    }]);
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates').mockImplementation(async ({ markers }) => markers.map((marker) => ({
      id: marker.id,
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: true,
      captured: true,
      authoritative: true,
      source: 'chromium_cdp',
      phase: 'post_action_replacement_verification',
      identity: { backendNodeId: 202, documentUrl: pre.identity.documentUrl, connected: true },
      node: { nodeName: 'BUTTON', attributes: { 'data-testid': 'save' } },
      accessibility: { role: 'button', name: 'Save' },
    })));

    const updated = await mcp.captureAuthoritativePostAction(session, actionLocatorFor(pre));

    expect(updated.context.authoritativeCdp.post).toMatchObject({
      identity: { backendNodeId: 101, connected: false },
      presentInSnapshot: false,
      sameBackendNode: false,
      replacement: {
        resolved: true,
        backendNodeId: 202,
        count: 1,
        stable: true,
        logicalTargetPresent: true,
        proof: {
          unique: true,
          logicalAgreement: true,
          stableAttributeAgreement: true,
          stable: true,
          logicalTargetPresent: true,
          pageId: pageIdentity.pageId,
        },
      },
      removed: false,
    });
  });

  it('does not promote a positional replacement without strong identity agreement', async () => {
    const context = createContext();
    const source = createPage(context, { targetId: 'target-structural-replacement' });
    source.locator = () => ({ count: async () => 1, evaluate: async () => true });
    const session = { id: 'session-structural-replacement', liveCdp: { context } };
    const pageIdentity = await mcp._authoritativePageIdentity(session, source);
    const pre = capturedPre(pageIdentity, {
      node: { nodeName: 'BUTTON', attributes: {} },
      selectedCandidate: {
        strategy: 'generated_css',
        selector: 'button:nth-child(2)',
        expression: 'locator("button:nth-child(2)")',
        framePath: [],
        proof: { authoritativeCdpVerified: true, backendNodeVerified: true },
      },
      stabilization: { stableAcrossSnapshots: true },
    });
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates').mockImplementation(async ({ markers }) => markers.map((marker) => ({
      id: marker.id,
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      captured: true,
      authoritative: true,
      identity: { backendNodeId: 303, documentUrl: pre.identity.documentUrl, connected: true },
      node: { nodeName: 'BUTTON', attributes: {} },
      accessibility: { role: 'button', name: 'Save' },
    })));

    const result = await mcp._reacquireAuthoritativeReplacement(session, source, pre);

    expect(result).toMatchObject({
      sameBackendNode: false,
      replacement: {
        resolved: false,
        backendNodeId: 303,
        count: 1,
        stable: false,
        logicalTargetPresent: false,
        proof: {
          logicalAgreement: true,
          stableAttributeAgreement: false,
          structuralSelector: true,
          reason: 'replacement_identity_not_strong_enough',
        },
      },
    });
  });

  it('records an explicitly absent optional target as a nonblocking binding attempt', async () => {
    const context = createContext();
    createPage(context, { targetId: 'target-optional-dialog' });
    const session = {
      id: 'session-optional-dialog',
      liveCdp: { context },
      captureRuntime: mcp.captureRuntimeDescriptor({
        sessionId: 'session-optional-dialog',
        liveCdpEnabled: true,
        runBindings: [],
        bindingAttempts: [],
      }),
      client: {
        callTool: vi.fn().mockResolvedValue({
          isError: true,
          content: [{ type: 'text', text: 'Element ref e-optional-dialog not found in the current snapshot' }],
        }),
      },
    };

    const result = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-optional-dialog',
      element: 'Optional confirmation dialog',
      phase: 'pre_action',
      optional: true,
    });

    expect(result).toMatchObject({
      available: true,
      captured: false,
      authoritative: false,
      optional: true,
      nonBlocking: true,
      reason: 'optional_target_absent',
      originalReason: 'mcp_target_marker_failed',
      captureBinding: { status: 'not_bound', reason: 'optional_target_absent' },
    });
    expect(session.captureRuntime.runBindings).toEqual([]);
    expect(session.captureRuntime.bindingAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'not_bound', reason: 'optional_target_absent' }),
    ]));
  });

  it('treats an exact Playwright locator resolution wait as proven optional absence', async () => {
    const context = createContext();
    createPage(context, { targetId: 'target-optional-locator-wait' });
    const session = {
      id: 'session-optional-locator-wait',
      liveCdp: { context },
      client: {
        callTool: vi.fn().mockResolvedValue({
          isError: true,
          content: [{
            type: 'text',
            text: "locator.evaluate: Timeout 2000ms exceeded.\nCall log:\n  - waiting for getByRole('dialog', { name: 'Stay signed in' })",
          }],
        }),
      },
    };

    const result = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-stay-signed-in-dialog',
      element: 'Stay signed in dialog',
      phase: 'pre_action',
      optional: true,
    });

    expect(result).toMatchObject({
      available: true,
      captured: false,
      authoritative: false,
      optional: true,
      nonBlocking: true,
      reason: 'optional_target_absent',
      originalReason: 'mcp_target_marker_failed',
      captureBinding: { status: 'not_bound', reason: 'optional_target_absent' },
    });
  });

  it('does not misclassify optional marker evaluation or missing-ref failures as target absence', async () => {
    const context = createContext();
    createPage(context, { targetId: 'target-optional-failure' });
    const session = {
      id: 'session-optional-failure',
      liveCdp: { context },
      client: {
        callTool: vi.fn()
          .mockResolvedValueOnce({
            isError: true,
            content: [{ type: 'text', text: 'Browser evaluation request timed out after 5000ms' }],
          })
          .mockResolvedValueOnce({
            isError: true,
            content: [{ type: 'text', text: 'Browser transport closed before evaluation completed' }],
          }),
      },
    };

    const evaluationFailure = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-optional-timeout',
      element: 'Optional dialog',
      optional: true,
    });
    const transportFailure = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-optional-transport',
      element: 'Optional dialog',
      optional: true,
    });
    const missingRef = await mcp.captureAuthoritativeActionTarget(session, {
      element: 'Optional dialog',
      optional: true,
    });

    expect(evaluationFailure).toMatchObject({
      captured: false,
      reason: 'mcp_target_marker_failed',
    });
    expect(evaluationFailure.optional).not.toBe(true);
    expect(evaluationFailure.nonBlocking).not.toBe(true);
    expect(transportFailure).toMatchObject({
      captured: false,
      reason: 'mcp_target_marker_failed',
    });
    expect(transportFailure.optional).not.toBe(true);
    expect(transportFailure.nonBlocking).not.toBe(true);
    expect(missingRef).toMatchObject({ captured: false, reason: 'mcp_bound_ref_missing' });
    expect(missingRef.optional).not.toBe(true);
  });

  it('keeps DOM-confirmed tooltip evidence separate from unavailable visual evidence', async () => {
    const context = createContext();
    const page = createPage(context, { targetId: 'target-tooltip' });
    const targetLocator = {
      count: async () => 1,
      evaluate: async () => ({ role: 'tooltip', values: ['Account settings'] }),
    };
    const frame = {
      locator: () => targetLocator,
      url: () => page.url(),
      name: () => '',
    };
    page.frames = () => [frame];
    page.mainFrame = () => frame;
    const session = {
      id: 'session-tooltip',
      liveCdp: { context },
      client: { callTool: vi.fn().mockResolvedValue({ isError: false, content: [] }) },
    };
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedTarget').mockResolvedValue({
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: true,
      captured: true,
      authoritative: true,
      source: 'chromium_cdp',
      phase: 'pre_action',
      capturedAt: new Date().toISOString(),
      identity: { backendNodeId: 404, documentUrl: page.url(), connected: true },
      node: { nodeName: 'DIV', attributes: { role: 'tooltip' } },
      accessibility: { role: 'tooltip', name: 'Account settings' },
      framePath: [],
      shadowPath: [],
    });
    vi.spyOn(locatorCaptureAnalysis, 'analyzeLiveTarget').mockResolvedValue({
      schema: locatorCaptureAnalysis.LIVE_ANALYSIS_SCHEMA,
      ok: false,
      reason: 'not_needed_for_tooltip_test',
    });

    const result = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-tooltip',
      element: 'Account settings tooltip',
      phase: 'pre_action',
      observationKind: 'tooltip',
      expectedText: 'Account settings',
      visualObserved: false,
    });

    expect(result.tooltipEvidence).toMatchObject({
      dom: { present: true, text: 'Account settings' },
      visual: { observed: false, text: null },
      semantics: 'dom_confirmed_visual_unavailable',
      nonBlocking: true,
    });
    expect(result.tooltipEvidence.explanation).toContain('flow may continue without blocking');
  });

  it('reports visual-only tooltip evidence without inventing DOM confirmation', async () => {
    const evidence = await mcp._captureTooltipEvidence({
      observationKind: 'tooltip',
      expectedText: 'Saved',
      visualObservation: { observed: true, text: 'Saved', source: 'app_tooltip_visible' },
    }, { captured: false }, null);

    expect(evidence).toEqual({
      dom: { present: false, text: null },
      visual: { observed: true, text: 'Saved' },
      semantics: 'visual_only',
      nonBlocking: true,
      explanation: null,
    });
  });

  it('does not treat ordinary trigger text or mismatched tooltip text as DOM confirmation', async () => {
    const ordinaryTrigger = await mcp._captureTooltipEvidence({
      observationKind: 'tooltip',
      visualObserved: false,
    }, {
      captured: true,
      node: { attributes: {} },
      accessibility: { role: 'button', name: 'Account settings' },
    }, {
      evaluate: async () => ({
        role: 'button',
        values: ['Account settings'],
        semanticValues: [],
        semanticRelationship: false,
      }),
    });
    const mismatch = await mcp._captureTooltipEvidence({
      observationKind: 'tooltip',
      expectedText: 'Expected tooltip',
      visualObserved: false,
    }, {
      captured: true,
      node: { attributes: { role: 'tooltip' } },
      accessibility: { role: 'tooltip', name: 'Different tooltip' },
    }, null);

    expect(ordinaryTrigger).toMatchObject({
      dom: { present: false, text: null },
      semantics: 'not_observed',
    });
    expect(mismatch).toMatchObject({
      dom: { present: false, text: 'Different tooltip' },
      semantics: 'not_observed',
    });
  });

  it('prunes closed Page wrappers while retaining a bounded page_closed identity', async () => {
    const context = createContext();
    const session = { id: 'session-page-churn', liveCdp: { context } };
    const closedIdentities = [];
    for (let index = 0; index < 6; index += 1) {
      const page = createPage(context, { targetId: `closed-target-${index}` });
      closedIdentities.push(await mcp._authoritativePageIdentity(session, page));
      page.closeForTest();
    }
    const livePage = createPage(context, { targetId: 'live-target' });
    await mcp._authoritativePageIdentity(session, livePage);

    expect(mcp._authoritativePageRegistryStats(session)).toEqual({
      livePages: 1,
      closedPageIds: 6,
    });
    expect(mcp._exactAuthoritativePageForIdentity(session, closedIdentities[0])).toMatchObject({
      page: null,
      reason: 'page_closed',
      pageId: closedIdentities[0].pageId,
    });
  });

  it('does not cross-bind a newly unique same-name semantic control after rerender', async () => {
    const context = createContext();
    const source = createPage(context, { targetId: 'target-semantic-cross-bind' });
    source.getByRole = () => ({ count: async () => 1, evaluate: async () => true });
    const session = { id: 'session-semantic-cross-bind', liveCdp: { context } };
    const pageIdentity = await mcp._authoritativePageIdentity(session, source);
    const pre = capturedPre(pageIdentity, {
      node: { nodeName: 'BUTTON', attributes: {} },
      selectedCandidate: {
        strategy: 'role',
        role: 'button',
        name: 'Continue',
        exact: true,
        expression: 'getByRole("button", { name: "Continue", exact: true })',
        framePath: [],
        proof: { authoritativeCdpVerified: true, backendNodeVerified: true },
      },
      stabilization: { stableAcrossSnapshots: true },
      accessibility: { role: 'button', name: 'Continue' },
      ancestry: [{ backendNodeId: 501, nodeName: 'DIV', attributes: {} }],
      layout: { bounds: { x: 10, y: 10, width: 100, height: 30 } },
    });
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates').mockImplementation(async ({ markers }) => markers.map((marker) => ({
      id: marker.id,
      captured: true,
      authoritative: true,
      identity: { backendNodeId: 505, documentUrl: pre.identity.documentUrl, connected: true },
      node: { nodeName: 'BUTTON', attributes: {} },
      accessibility: { role: 'button', name: 'Continue' },
      ancestry: [{ backendNodeId: 777, nodeName: 'DIV', attributes: {} }],
      layout: { bounds: { x: 300, y: 10, width: 100, height: 30 } },
      framePath: [],
      shadowPath: [],
    })));

    const result = await mcp._reacquireAuthoritativeReplacement(session, source, pre);

    expect(result.replacement).toMatchObject({
      resolved: false,
      stable: false,
      logicalTargetPresent: false,
      proof: {
        logicalAgreement: true,
        stableAttributeAgreement: false,
        strongContextAgreement: { strong: false },
        reason: 'replacement_identity_not_strong_enough',
      },
    });
  });

  it('uses the unique CDP marker capture when locator scanning cannot pierce a closed shadow root', async () => {
    const context = createContext();
    const page = createPage(context, { targetId: 'target-closed-shadow' });
    page.frames = () => [{ locator: () => ({ count: async () => 0 }) }];
    const session = {
      id: 'session-closed-shadow',
      liveCdp: { context },
      client: { callTool: vi.fn().mockResolvedValue({ isError: false, content: [] }) },
    };
    const capture = vi.spyOn(authoritativeCdpCapture, 'captureMarkedTarget').mockResolvedValue({
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: true,
      captured: true,
      authoritative: true,
      source: 'chromium_cdp',
      phase: 'pre_action',
      capturedAt: new Date().toISOString(),
      identity: { backendNodeId: 606, documentUrl: page.url(), connected: true },
      node: { nodeName: 'BUTTON', attributes: {} },
      accessibility: { role: 'button', name: 'Closed shadow action' },
      framePath: [],
      shadowPath: [],
      shadowContext: {
        available: false,
        reason: 'closed_shadow_root',
        gaps: [{ reason: 'closed_shadow_root', rootType: 'closed' }],
      },
    });

    const result = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-closed-shadow',
      element: 'Closed shadow action',
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      captured: true,
      authoritative: true,
      identity: { backendNodeId: 606 },
      shadowContext: { available: false, reason: 'closed_shadow_root' },
      captureBinding: { status: 'bound', backendNodeId: 606 },
      candidateAnalysis: { reason: 'playwright_locator_scan_unavailable' },
      selectedCandidate: null,
    });
  });

  it('keeps multiple CDP marker captures ambiguous and unbound', async () => {
    const context = createContext();
    const first = createPage(context, { targetId: 'target-closed-shadow-1' });
    const second = createPage(context, { targetId: 'target-closed-shadow-2' });
    first.frames = () => [{ locator: () => ({ count: async () => 0 }) }];
    second.frames = () => [{ locator: () => ({ count: async () => 0 }) }];
    const session = {
      id: 'session-closed-shadow-ambiguous',
      liveCdp: { context },
      client: { callTool: vi.fn().mockResolvedValue({ isError: false, content: [] }) },
    };
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedTarget').mockImplementation(async ({ page }) => ({
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      captured: true,
      authoritative: true,
      identity: {
        backendNodeId: page === first ? 701 : 702,
        documentUrl: page.url(),
        connected: true,
      },
    }));

    const result = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-closed-shadow-ambiguous',
      element: 'Ambiguous closed shadow action',
    });

    expect(result).toMatchObject({
      captured: false,
      authoritative: false,
      reason: 'candidate_marker_ambiguous',
      matchCount: 2,
      captureBinding: { status: 'not_bound', backendNodeId: null },
    });
  });

  it('acquires visual tooltip observation through the real browser-evaluate path', async () => {
    const session = {
      id: 'session-tooltip-visual',
      client: {
        callTool: vi.fn().mockResolvedValue({
          isError: false,
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              rendered: true,
              source: 'app_tooltip_visible',
              text: 'Account settings',
            }),
          }],
        }),
      },
    };

    const observation = await mcp.acquireTooltipVisualObservation(session, {
      expectedText: 'Account settings',
    });

    expect(session.client.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'browser_evaluate' }),
      undefined,
      expect.any(Object),
    );
    expect(observation).toMatchObject({
      observed: true,
      text: 'Account settings',
      source: 'app_tooltip_visible',
      available: true,
      reason: null,
    });
  });
});
