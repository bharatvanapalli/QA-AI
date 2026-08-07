import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const mcp = require('../../server/services/mcp.js');
const resolver = require('../../server/services/actionLocatorResolver.js');

function markerClient(targetLocator) {
  return {
    async callTool(call) {
      if (call?.name !== 'browser_evaluate') throw new Error(`Unexpected MCP tool ${call?.name}`);
      const source = String(call.arguments?.function || '');
      const evaluateFunction = Function(`"use strict"; return (${source});`)();
      await targetLocator.evaluate(evaluateFunction);
      return { isError: false, content: [{ type: 'text', text: 'true' }] };
    },
  };
}

describe('authoritative live locator production pipeline', () => {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    });
  }, 60_000);

  afterAll(async () => {
    if (!browser) return;
    try {
      const browserCdp = await browser.newBrowserCDPSession();
      await browserCdp.send('Browser.close');
    } catch (_) {
      await browser.close();
    }
  }, 30_000);

  it('carries a real iframe and open-shadow target through CDP proof, package analysis, rerender verification and authored identity', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<iframe id="profile-frame" title="Profile editor"></iframe>');
    const childFrame = page.frames().find((frame) => frame !== page.mainFrame());
    await childFrame.setContent('<profile-shell id="profile-shell"></profile-shell>');
    await childFrame.evaluate(() => {
      const host = document.querySelector('#profile-shell');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button data-testid="save-profile" type="button">Save profile</button>';
      let sawCandidateMarker = false;
      let replaced = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (!String(record.attributeName || '').startsWith('data-qaai-cdp-candidate-')) continue;
          if (record.target.hasAttribute(record.attributeName)) sawCandidateMarker = true;
          if (sawCandidateMarker && !record.target.hasAttribute(record.attributeName) && !replaced) {
            replaced = true;
            record.target.replaceWith(record.target.cloneNode(true));
          }
        }
      });
      observer.observe(shadow, { attributes: true, subtree: true });
    });
    const target = childFrame.getByTestId('save-profile');
    const session = {
      id: 'real-authoritative-frame-shadow',
      currentUrl: page.url(),
      client: markerClient(target),
      liveCdp: { context },
      activePageAlias: 'profile-editor',
    };

    const actionLocator = await resolver.resolveForTool({
      session,
      toolName: 'browser_click',
      args: { ref: 'e-save', element: 'Save profile' },
      pageUrl: page.url(),
      elementLabel: 'Save profile',
      contractStepId: 'profile-step-save',
    });

    expect(
      resolver.isVerifiedActionLocator(actionLocator),
      JSON.stringify({
        verified: actionLocator?.verified,
        verificationStatus: actionLocator?.verificationStatus,
        verificationSource: actionLocator?.verificationSource,
        diagnosticOnly: actionLocator?.diagnosticOnly,
        proof: actionLocator?.proof,
        authoritative: actionLocator?.context?.authoritativeCdp?.pre && {
          reason: actionLocator.context.authoritativeCdp.pre.reason,
          framePathExportable: actionLocator.context.authoritativeCdp.pre.framePathExportable,
          stabilization: actionLocator.context.authoritativeCdp.pre.stabilization,
          selectedCandidate: actionLocator.context.authoritativeCdp.pre.selectedCandidate,
        },
      }, null, 2),
    ).toBe(true);
    expect(actionLocator).toMatchObject({
      contractStepId: 'profile-step-save',
      persistable: true,
      verificationSource: 'authoritative_chromium_cdp',
      strategy: 'testid',
    });
    const pre = actionLocator.context.authoritativeCdp.pre;
    expect(pre.identity.backendNodeId).toBeGreaterThan(0);
    expect(pre.framePathExportable).toBe(true);
    expect(pre.framePathSelectors).toEqual(['#profile-frame']);
    expect(pre.candidateAnalysis.libraries).toMatchObject({ cssSelectorGenerator: true, testingLibraryDom: true });
    expect(pre.candidateDescriptors.some((candidate) => candidate.strategy === 'generated_css'
      && candidate.generatedBy === 'css-selector-generator')).toBe(true);
    expect(pre.selectedCandidate.proof).toMatchObject({
      backendNodeVerified: true,
      authoritativeCdpVerified: true,
      countBefore: 1,
      countAfter: 1,
      stableAcrossSnapshots: true,
      logicalReplacement: true,
    });
    expect(actionLocator.expression).toContain('frameLocator("#profile-frame")');
    expect(actionLocator.expression).toContain('getByTestId("save-profile")');
    await context.close();
  }, 120_000);

  it('binds the marker to the exact popup page when two live pages have the same URL', async () => {
    const context = await browser.newContext();
    const first = await context.newPage();
    const popup = await context.newPage();
    await first.setContent('<button data-testid="decoy">Continue</button>');
    await popup.setContent('<button data-testid="popup-target">Continue</button>');
    const target = popup.getByTestId('popup-target');
    const session = {
      id: 'real-authoritative-popup',
      currentUrl: popup.url(),
      client: markerClient(target),
      liveCdp: { context },
      activePopupIdentity: { id: 'auth-popup' },
    };

    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-popup',
      element: 'Continue',
      pageUrl: popup.url(),
    });

    expect(captured.captured).toBe(true);
    expect(captured.pageIdentity.pageId).toBeTruthy();
    expect(captured.selectedCandidate).toMatchObject({ strategy: 'testid', value: 'popup-target' });
    expect(captured.verifiedCandidates.every((candidate) => candidate.proof.matchedBackendNodeId === captured.identity.backendNodeId)).toBe(true);
    await context.close();
  }, 120_000);
});
