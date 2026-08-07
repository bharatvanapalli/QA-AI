import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const resolver = require('../../server/services/actionLocatorResolver.js');

function fabricatedLocator(overrides = {}) {
  const expression = 'getByRole("button", { name: "Continue" })';
  return {
    kind: 'playwright',
    verified: true,
    diagnosticOnly: false,
    verificationSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    evidenceSource: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: 'role',
    pageUrl: 'https://example.test/login',
    proof: { count: 1, sameElement: true, verified: true },
    domAtlas: { verifiedActions: [{ expression }] },
    ...overrides,
  };
}

describe('action-time locator proof integrity', () => {
  it('never certifies legacy count/sameElement booleans without exact acted-node identities', () => {
    const locator = fabricatedLocator();

    expect(resolver.isVerifiedActionLocator(locator)).toBe(false);
    const evidence = resolver.buildLocatorEvidenceRecord({ actionLocator: locator, contractStepId: 'step-1' });
    expect(evidence).toMatchObject({
      verified: false,
      uniqueness: { sameElement: false, unique: false },
      guess: { isGuess: true, reviewRequired: true },
    });
    expect(evidence.locator.guess.annotation).toContain('QAAI-GUESSED');
  });

  it('rejects mismatched acted-node identities even when all legacy booleans claim success', () => {
    const targetIdentity = { scheme: 'qaai-dom-node-v1', documentId: 'doc:1', nodeId: 'node:1', connected: true };
    const locator = fabricatedLocator({
      context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e1' } },
      proof: {
        count: 1,
        sameElement: true,
        verified: true,
        actionTimeResolved: true,
        resolutionMode: 'bound_mcp_ref',
        identityVerified: true,
        targetIdentity,
        matchedIdentity: { ...targetIdentity, nodeId: 'node:2' },
      },
    });

    expect(resolver.isVerifiedActionLocator(locator)).toBe(false);
  });

  it('requires a trusted capture binding and connected qaai DOM-node identities', () => {
    const targetIdentity = {
      scheme: 'qaai-dom-node-v1',
      documentId: 'doc:binding',
      nodeId: 'node:binding',
      connected: true,
    };
    const proof = {
      count: 1,
      sameElement: true,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      source: resolver.VERIFIED_DOM_INSPECTION_SOURCE,
    };

    expect(resolver.isVerifiedActionLocator(fabricatedLocator({ proof }))).toBe(false);
    expect(resolver.isVerifiedActionLocator(fabricatedLocator({
      context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e-binding' } },
      proof: {
        ...proof,
        matchedIdentity: { ...targetIdentity, connected: false },
      },
    }))).toBe(false);
  });

  it('accepts only complete persisted pre/post CDP proof for the same acted backend node', () => {
    const expression = 'getByRole("button", { name: "Continue", exact: true })';
    const authoritativeCdpSource = 'authoritative_chromium_cdp';
    const persisted = fabricatedLocator({
      verificationSource: authoritativeCdpSource,
      evidenceSource: authoritativeCdpSource,
      expression,
      frameworkExpressions: { playwright: expression },
      context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e-continue' } },
      captureEvidence: {
        targetRef: 'e-continue',
        pre: {
          captured: true,
          authoritative: true,
          source: 'chromium_cdp',
          backendNodeId: 742,
        },
        post: {
          captured: true,
          authoritative: true,
          source: 'chromium_cdp',
          backendNodeId: 742,
        },
      },
      proof: {
        count: 1,
        sameElement: true,
        verified: true,
        actionTimeResolved: true,
        identityVerified: true,
        stableAcrossSnapshots: true,
        targetIdentity: { backendNodeId: 742 },
        matchedIdentity: { backendNodeId: 742 },
      },
      domAtlas: null,
    });

    expect(resolver.isVerifiedActionLocator(persisted)).toBe(true);
    const atlas = resolver.normalizeDomAtlasForAction({
      url: 'https://example.test/login',
      controls: [],
    }, { action: persisted });
    expect(atlas.verifiedActions).toHaveLength(1);
    expect(atlas.verifiedActions[0].verificationSource).toBe(authoritativeCdpSource);
    expect(resolver.isVerifiedActionLocator({
      ...persisted,
      captureEvidence: { ...persisted.captureEvidence, post: null },
    })).toBe(false);
    expect(resolver.isVerifiedActionLocator({
      ...persisted,
      captureEvidence: {
        ...persisted.captureEvidence,
        post: { ...persisted.captureEvidence.post, backendNodeId: 743 },
      },
    })).toBe(false);
  });

  it('keeps snapshot and Knowledge Base locators unverified until live recertification', () => {
    const snapshot = resolver.buildVerifiedFromSnapshotRef({
      toolName: 'browser_click',
      args: { ref: 'e1', element: 'Continue' },
      snapshotText: '- button "Continue" [ref=e1]',
      pageUrl: 'https://example.test/login',
      elementLabel: 'Continue',
    });
    const kb = resolver.buildVerifiedFromKbEntry({
      kbEntry: {
        selector: 'getByRole("button", { name: "Continue" })',
        role: 'button',
        accessibleName: 'Continue',
        strategy: 'role',
      },
      toolName: 'browser_click',
      pageUrl: 'https://example.test/login',
      elementLabel: 'Continue',
    });

    expect(snapshot).toMatchObject({ verified: false, diagnosticOnly: true, guess: { isGuess: true } });
    expect(snapshot.proof).toMatchObject({ count: null, sameElement: false, verified: false, actionTimeResolved: false });
    expect(resolver.isVerifiedActionLocator(snapshot)).toBe(false);
    expect(kb).toMatchObject({
      verified: false,
      diagnosticOnly: true,
      verificationSource: resolver.KNOWLEDGE_BASE_CANDIDATE_SOURCE,
      guess: { isGuess: true },
    });
    expect(kb.proof).toMatchObject({ count: null, sameElement: false, verified: false, actionTimeResolved: false });
    expect(resolver.isVerifiedActionLocator(kb)).toBe(false);
  });

  it('uses bound live-node inspection before snapshot candidates and preserves full context provenance', async () => {
    const targetIdentity = { scheme: 'qaai-dom-node-v1', documentId: 'doc:live', nodeId: 'node:7', connected: true, tag: 'button' };
    const expression = 'getByRole("button", { name: "Continue" })';
    const scopedExpression = 'frameLocator("iframe[name=\\"auth\\"]").getByRole("button", { name: "Continue" })';
    const inspection = {
      ok: true,
      facts: {
        tag: 'button',
        role: 'button',
        accessibleName: 'Continue',
        stableAttributes: { name: 'continue' },
      },
      context: {
        framePath: ['iframe[name="auth"]'],
        shadowPath: ['auth-shell', 'sign-in-panel'],
        rowSelector: '[data-row-key="auth-primary"]',
      },
      targetIdentity,
      targetFingerprint: {
        tag: 'button',
        role: 'button',
        accessibleName: 'Continue',
        stableAttributes: { name: 'continue' },
        framePath: ['iframe[name="auth"]'],
        shadowPath: ['auth-shell', 'sign-in-panel'],
      },
      candidates: [{
        strategy: 'role',
        role: 'button',
        name: 'Continue',
        expression,
        frameworkExpressions: { playwright: expression },
        candidate: { strategy: 'role', role: 'button', name: 'Continue' },
        proof: {
          count: 1,
          sameElement: true,
          visible: true,
          enabled: true,
          actionTimeResolved: true,
          resolutionMode: 'bound_mcp_ref',
          identityVerified: true,
          targetIdentity,
          matchedIdentity: { ...targetIdentity },
        },
      }],
      domAtlas: { schemaVersion: 'qaai-dom-atlas-v1', controls: [], forms: [], tables: [], dialogs: [], landmarks: [], frames: [], shadowHosts: [], headings: [] },
    };
    const callTool = vi.fn(async (call) => {
      expect(call.name).toBe('browser_evaluate');
      expect(call.arguments.target).toBe('e7');
      return { content: [{ type: 'text', text: `Result: ${JSON.stringify(inspection)}` }] };
    });
    const session = {
      client: { callTool },
      activePageAlias: 'sign-in-page',
      activeTabAlias: 'auth-tab',
      activePopupIdentity: { id: 'microsoft-popup', alias: 'microsoft-sign-in' },
    };

    const locator = await resolver.resolveForTool({
      session,
      toolName: 'browser_click',
      args: { ref: 'e7', element: 'Continue' },
      snapshotText: '- button "Wrong snapshot candidate" [ref=e7]',
      pageUrl: 'https://login.example.test/authorize?request=private',
      elementLabel: 'Continue',
      contractStepId: 'login-step-2',
    });

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(locator).toMatchObject({
      verified: true,
      expression: scopedExpression,
      contractStepId: 'login-step-2',
      pageAlias: 'sign-in-page',
      tabAlias: 'auth-tab',
      popupIdentity: { id: 'microsoft-popup' },
      framePath: ['iframe[name="auth"]'],
      shadowHostPath: ['auth-shell', 'sign-in-panel'],
      uniqueness: { count: 1, sameElement: true, unique: true, identityVerified: true },
      targetIdentity: { documentId: 'doc:live', nodeId: 'node:7' },
    });
    expect(locator.actedNodeFingerprint.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(locator.pageIdentity).toMatchObject({ documentId: 'doc:live', pageAlias: 'sign-in-page', tabAlias: 'auth-tab' });
    expect(locator.guess).toBeUndefined();
  });

  it('rejects volatile ids/classes while retaining explicit stable test contracts', () => {
    expect(resolver.locatorExpressionIsExportSafe('locator("#550e8400-e29b-41d4-a716-446655440000")')).toBe(false);
    expect(resolver.locatorExpressionIsExportSafe('locator("#123456789")')).toBe(false);
    expect(resolver.locatorExpressionIsExportSafe('page.locator("#react-control-781346923")')).toBe(false);
    expect(resolver.locatorExpressionIsExportSafe('locator("button.MuiButton-root.css-a1b2c3d4")')).toBe(false);
    expect(resolver.locatorExpressionIsExportSafe('locator("main > section:nth-child(2) > button")')).toBe(false);
    expect(resolver.locatorExpressionIsExportSafe('getByTestId("550e8400-e29b-41d4-a716-446655440000")')).toBe(true);
    expect(resolver.locatorExpressionIsExportSafe('locator("[data-qaai-id=\\"123456789\\"]")')).toBe(true);
  });

  it('allows a volatile selector only with explicit before/after stability proof', () => {
    const evidence = {
      proof: {
        stableAcrossSnapshots: true,
        countBefore: 1,
        countAfter: 1,
        fingerprintBefore: 'same-node-fingerprint',
        fingerprintAfter: 'same-node-fingerprint',
      },
    };
    expect(resolver.locatorExpressionIsExportSafe('locator("#123456789")', evidence)).toBe(true);
  });
});
