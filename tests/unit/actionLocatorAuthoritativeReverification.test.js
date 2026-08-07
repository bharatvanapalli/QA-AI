import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');
const authoritativeCdpCapture = require('../../server/services/authoritativeCdpCapture.js');
const resolver = require('../../server/services/actionLocatorResolver.js');

function identity(nodeId = 'node:target') {
  return { scheme: 'qaai-dom-node-v1', documentId: 'doc:target', nodeId, connected: true };
}

function legacyVerifiedLocator(expression = 'locator("[data-qa=\\"continue\\"]")') {
  const targetIdentity = identity();
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    evidenceSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    diagnosticOnly: false,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: 'css-attr',
    targetFacts: { role: 'button', accessibleName: 'Continue', selector: '[data-qa="continue"]' },
    targetIdentity,
    context: {
      framePath: [],
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e7' },
      targetIdentity,
    },
    proof: {
      source: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
      verified: true,
      sameElement: true,
      count: 1,
      visible: true,
      enabled: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
    },
    domAtlas: { verifiedActions: [{ expression }] },
  };
}

function authoritativeCapture(backendNodeId = 73) {
  return {
    captured: true,
    authoritative: true,
    source: 'chromium_cdp',
    identity: { backendNodeId, frameId: 'main', documentUrl: 'https://example.test/work' },
    node: { attributes: { 'data-qa': 'continue' }, localName: 'button' },
    accessibility: { role: 'button', name: 'Continue' },
    pageIdentity: { pageId: 'page:work', url: 'https://example.test/work' },
    framePath: [],
    framePathSelectors: [],
    framePathExportable: true,
    shadowPath: [],
    selectedCandidate: null,
  };
}

function fakePage() {
  const locator = {
    count: vi.fn(async () => 1),
    evaluate: vi.fn(async () => undefined),
  };
  return {
    locator: vi.fn(() => locator),
    waitForTimeout: vi.fn(async () => undefined),
    _locator: locator,
  };
}

function boundInspection(expression = 'locator("[data-qa=\\"continue\\"]")') {
  const targetIdentity = identity();
  const proof = {
    source: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    verified: true,
    sameElement: true,
    count: 1,
    visible: true,
    enabled: true,
    actionTimeResolved: true,
    resolutionMode: 'bound_mcp_ref',
    identityVerified: true,
    targetIdentity,
    matchedIdentity: { ...targetIdentity },
  };
  return {
    ok: true,
    captureBinding: { kind: 'mcp_bound_ref', ref: 'e7' },
    context: { framePath: [], targetIdentity },
    targetIdentity,
    facts: {
      tag: 'button',
      role: 'button',
      accessibleName: 'Continue',
      stableAttributes: { 'data-qa': 'continue' },
      testIds: { 'data-qa': 'continue' },
    },
    candidates: [{
      strategy: 'css-attr',
      expression,
      frameworkExpressions: { playwright: expression },
      candidate: { strategy: 'css', selector: '[data-qa="continue"]' },
      proof,
      score: 100,
    }],
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      controls: [],
      forms: [],
      tables: [],
      dialogs: [],
      landmarks: [],
      frames: [],
      shadowHosts: [],
      headings: [],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authoritative fallback candidate reverification', () => {
  it('selects a nested role candidate verified against the authoritative backend node without excavation fallback', async () => {
    const targetIdentity = {
      scheme: 'qaai-cdp-backend-node-v1',
      backendNodeId: 5,
      frameId: 'main',
      documentUrl: 'https://example.test/work',
      connected: true,
    };
    const expression = 'getByRole("textbox", { name: "Email Address", exact: true })';
    const capture = {
      ...authoritativeCapture(5),
      identity: targetIdentity,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e2' },
      node: { attributes: {}, localName: 'input' },
      accessibility: { role: 'textbox', name: 'Email Address' },
      stabilization: { stableAcrossSnapshots: true },
      selectedCandidate: {
        strategy: 'role',
        role: 'textbox',
        name: 'Email Address',
        expression,
        priority: 2,
        proof: {
          source: 'authoritative_chromium_cdp',
          verified: true,
          sameElement: true,
          count: 1,
          actionTimeResolved: true,
          resolutionMode: 'authoritative_cdp_backend_node',
          identityVerified: true,
          targetIdentity,
          matchedIdentity: { ...targetIdentity },
          authoritativeCdpVerified: true,
          backendNodeVerified: true,
          stableAcrossSnapshots: true,
        },
      },
    };
    vi.spyOn(mcp, 'captureAuthoritativeActionTarget').mockResolvedValue(capture);
    const callTool = vi.fn();

    const result = await resolver.resolveForTool({
      session: { id: 'session-1', client: { callTool } },
      toolName: 'browser_fill',
      args: { ref: 'e2', element: 'Email Address', value: 'user@example.test' },
      snapshotText: '- textbox "Email Address" [ref=e2]',
      pageUrl: 'https://example.test/work',
      elementLabel: 'Email Address',
      contractStepId: 'case-step-2',
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      verified: true,
      diagnosticOnly: false,
      expression,
      strategy: 'role',
      verificationSource: 'authoritative_chromium_cdp',
      proof: {
        authoritativeCdpVerified: true,
        backendNodeVerified: true,
        stableAcrossSnapshots: true,
      },
      candidates: [{ strategy: 'role', role: 'textbox', name: 'Email Address' }],
    });
    expect(result.actionLocatorGap).toBeUndefined();
    expect(result.proof?.reason).not.toBe('excavation_failed');
    expect(resolver.isVerifiedActionLocator(result)).toBe(true);
  });

  it.each(['data-test', 'data-qa', 'data-cy', 'data-pw'])(
    'preserves %s as exact CSS rather than converting it to getByTestId',
    (attribute) => {
      const value = `contract-${attribute}`;
      const selector = `[${attribute}="${value}"]`;
      const targetIdentity = {
        scheme: 'qaai-cdp-backend-node-v1',
        backendNodeId: 41,
        frameId: 'main',
        documentUrl: 'https://example.test/work',
        connected: true,
      };
      const capture = {
        ...authoritativeCapture(41),
        captureBinding: { kind: 'mcp_bound_ref', ref: 'e9' },
        node: { attributes: { [attribute]: value }, localName: 'button' },
        stabilization: { stableAcrossSnapshots: true },
        selectedCandidate: {
          strategy: 'testid',
          attribute,
          value,
          expression: `locator(${JSON.stringify(selector)})`,
          priority: 1,
          proof: {
            source: 'authoritative_chromium_cdp',
            verified: true,
            sameElement: true,
            count: 1,
            actionTimeResolved: true,
            resolutionMode: 'authoritative_cdp_backend_node',
            identityVerified: true,
            targetIdentity,
            matchedIdentity: { ...targetIdentity },
            authoritativeCdpVerified: true,
            backendNodeVerified: true,
            stableAcrossSnapshots: true,
          },
        },
      };
      const locator = resolver.buildActionLocatorFromAuthoritativeCapture({
        toolName: 'browser_click',
        args: { ref: 'e9', element: 'Save' },
        capture,
        pageUrl: 'https://example.test/work',
        elementLabel: 'Save',
      });

      expect(locator).toBeTruthy();
      expect(locator.expression).toBe(`locator(${JSON.stringify(selector)})`);
      expect(locator.candidates[0]).toMatchObject({ strategy: 'css', selector });
      expect(locator.candidates.some((candidate) => candidate.strategy === 'testId')).toBe(false);
    },
  );

  it('promotes a bound-ref DOM candidate only after two exact backend-node captures', async () => {
    const page = fakePage();
    const capture = authoritativeCapture(73);
    vi.spyOn(mcp, '_exactAuthoritativePageForIdentity').mockReturnValue({ page, reason: null, pageId: 'page:work' });
    const captureSpy = vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates')
      .mockResolvedValueOnce([{ captured: true, authoritative: true, identity: { backendNodeId: 73 } }])
      .mockResolvedValueOnce([{ captured: true, authoritative: true, identity: { backendNodeId: 73 } }]);

    const result = await resolver.reverifyCandidateAgainstAuthoritativeCapture({
      session: { id: 'session-1' },
      actionLocator: legacyVerifiedLocator(),
      capture,
    });

    expect(captureSpy).toHaveBeenCalledTimes(2);
    expect(page.locator).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      verified: true,
      diagnosticOnly: false,
      verificationSource: 'authoritative_chromium_cdp',
      proof: {
        authoritativeCdpVerified: true,
        backendNodeVerified: true,
        expectedBackendNodeId: 73,
        matchedBackendNodeId: 73,
        stableAcrossSnapshots: true,
        countBefore: 1,
        countAfter: 1,
      },
      context: {
        authoritativeCdp: {
          reverification: { exactPageId: 'page:work', backendNodeIdBefore: 73, backendNodeIdAfter: 73 },
        },
      },
    });
    expect(result.guess).toBeUndefined();
    expect(result.domAtlas?.verifiedActions).toHaveLength(1);
    expect(result.domAtlas?.verifiedActions[0]).toMatchObject({
      verificationSource: 'authoritative_chromium_cdp',
      proof: { backendNodeVerified: true, stableAcrossSnapshots: true },
    });
    expect(resolver.isVerifiedActionLocator(result)).toBe(true);
  });

  it('uses the exact reverified candidate in resolveForTool instead of returning a guessed fallback', async () => {
    const page = fakePage();
    const capture = authoritativeCapture(73);
    vi.spyOn(mcp, 'captureAuthoritativeActionTarget').mockResolvedValue(capture);
    vi.spyOn(mcp, '_exactAuthoritativePageForIdentity').mockReturnValue({ page, reason: null, pageId: 'page:work' });
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates')
      .mockResolvedValueOnce([{ captured: true, authoritative: true, identity: { backendNodeId: 73 } }])
      .mockResolvedValueOnce([{ captured: true, authoritative: true, identity: { backendNodeId: 73 } }]);
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: `Result: ${JSON.stringify(boundInspection())}` }],
    }));

    const result = await resolver.resolveForTool({
      session: { id: 'session-1', client: { callTool } },
      toolName: 'browser_click',
      args: { ref: 'e7', element: 'Continue' },
      snapshotText: '- button "Continue" [ref=e7]',
      pageUrl: 'https://example.test/work',
      elementLabel: 'Continue',
      contractStepId: 'case-step-7',
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      verified: true,
      diagnosticOnly: false,
      verificationSource: 'authoritative_chromium_cdp',
      proof: { backendNodeVerified: true, stableAcrossSnapshots: true },
    });
    expect(result.guess).toBeUndefined();
    expect(result.domAtlas?.verifiedActions).toHaveLength(1);
    expect(resolver.isVerifiedActionLocator(result)).toBe(true);
  });

  it('does not promote when either fresh capture resolves to a different backend node', async () => {
    const page = fakePage();
    vi.spyOn(mcp, '_exactAuthoritativePageForIdentity').mockReturnValue({ page, reason: null, pageId: 'page:work' });
    vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates')
      .mockResolvedValueOnce([{ captured: true, authoritative: true, identity: { backendNodeId: 73 } }])
      .mockResolvedValueOnce([{ captured: true, authoritative: true, identity: { backendNodeId: 74 } }]);

    await expect(resolver.reverifyCandidateAgainstAuthoritativeCapture({
      session: { id: 'session-1' },
      actionLocator: legacyVerifiedLocator(),
      capture: authoritativeCapture(73),
    })).resolves.toBeNull();
  });

  it('never executes or promotes syntax-only locator evidence', async () => {
    const page = fakePage();
    const pageSpy = vi.spyOn(mcp, '_exactAuthoritativePageForIdentity').mockReturnValue({ page, reason: null, pageId: 'page:work' });
    const captureSpy = vi.spyOn(authoritativeCdpCapture, 'captureMarkedCandidates');
    const syntaxOnly = {
      ...legacyVerifiedLocator(),
      verified: false,
      diagnosticOnly: true,
      proof: { source: 'snapshot_ref_fallback', verified: false, count: 1, sameElement: false },
      verificationSource: 'snapshot_ref_fallback',
      evidenceSource: 'snapshot_ref_fallback',
      domAtlas: { verifiedActions: [] },
    };

    await expect(resolver.reverifyCandidateAgainstAuthoritativeCapture({
      session: { id: 'session-1' },
      actionLocator: syntaxOnly,
      capture: authoritativeCapture(73),
    })).resolves.toBeNull();
    expect(pageSpy).not.toHaveBeenCalled();
    expect(captureSpy).not.toHaveBeenCalled();
    expect(page.locator).not.toHaveBeenCalled();
  });
});
