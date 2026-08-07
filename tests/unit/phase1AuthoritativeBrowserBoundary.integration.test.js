import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const mcp = require('../../server/services/mcp.js');
const resolver = require('../../server/services/actionLocatorResolver.js');
const recorder = require('../../server/services/actionEvidenceRecorder.js');

const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function markerClient(targetLocator) {
  return {
    async callTool(call) {
      if (call?.name !== 'browser_evaluate') {
        throw new Error(`Unexpected MCP tool ${call?.name}`);
      }
      const source = String(call.arguments?.function || '');
      const evaluateFunction = Function(`"use strict"; return (${source});`)();
      await targetLocator.evaluate(evaluateFunction);
      return { isError: false, content: [{ type: 'text', text: 'true' }] };
    },
  };
}

function runtimeFor(sessionId, liveCdpEnabled) {
  return mcp.captureRuntimeDescriptor({
    sessionId,
    sessionStartedAt: new Date().toISOString(),
    liveCdpEnabled,
    runBindings: [],
  });
}

describe('Phase 1 real Playwright/CDP browser boundary', () => {
  let browser;
  const openContexts = new Set();

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(SYSTEM_CHROME) ? { executablePath: SYSTEM_CHROME } : {}),
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

  afterEach(async () => {
    vi.restoreAllMocks();
    const contexts = Array.from(openContexts);
    openContexts.clear();
    await Promise.allSettled(contexts.map((context) => context.close()));
  }, 30_000);

  it('binds the exact popup/frame/shadow action to a real CDP node and preserves pre/post/run identity', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    await context.newPage();
    const popupPage = await context.newPage();
    await popupPage.setContent('<iframe id="payment-frame" title="Payment"></iframe>', {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    const paymentFrame = popupPage.frames().find((frame) => frame !== popupPage.mainFrame());
    await paymentFrame.setContent('<payment-shell id="payment-shell"></payment-shell>');
    await paymentFrame.evaluate(() => {
      const host = document.querySelector('#payment-shell');
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button data-testid="confirm-payment" type="button">Confirm payment</button>';
      shadow.querySelector('button').addEventListener('click', (event) => {
        event.currentTarget.setAttribute('data-clicked', 'true');
      });
    });

    const target = paymentFrame.getByTestId('confirm-payment');
    const sessionId = 'phase1-real-browser-boundary';
    const contractStepId = 'payment-case:step:4';
    const actionOccurrenceId = 'payment-case:step:4:click:1';
    const newCdpSession = vi.spyOn(context, 'newCDPSession');
    const session = {
      id: sessionId,
      currentUrl: popupPage.url(),
      client: markerClient(target),
      liveCdp: { context },
      activePopupIdentity: { id: 'payment-popup' },
      activePageAlias: 'payment-popup',
      captureRuntime: runtimeFor(sessionId, true),
    };

    const actionLocator = await resolver.resolveForTool({
      session,
      toolName: 'browser_click',
      args: { ref: 'e-confirm-payment', element: 'Confirm payment' },
      pageUrl: popupPage.url(),
      elementLabel: 'Confirm payment',
      contractStepId,
      actionOccurrenceId,
    });

    expect(resolver.isVerifiedActionLocator(actionLocator)).toBe(true);
    expect(newCdpSession).toHaveBeenCalled();
    const pre = actionLocator.context.authoritativeCdp.pre;
    expect(pre).toMatchObject({
      captured: true,
      authoritative: true,
      source: 'chromium_cdp',
      phase: 'pre_action',
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-confirm-payment' },
      accessibility: { role: 'button', name: 'Confirm payment' },
    });
    expect(pre.identity.backendNodeId).toBeGreaterThan(0);
    expect(pre.pageIdentity.pageId).toBeTruthy();
    expect(pre.framePath).toHaveLength(1);
    expect.soft(pre.shadowPath).toHaveLength(1);

    await target.click();
    const actionLocatorWithPost = await mcp.captureAuthoritativePostAction(session, actionLocator, {
      pageUrl: popupPage.url(),
    });
    const post = actionLocatorWithPost.context.authoritativeCdp.post;
    expect(post).toMatchObject({
      captured: true,
      authoritative: true,
      phase: 'post_action',
      presentInSnapshot: true,
      sameBackendNode: true,
      identity: { backendNodeId: pre.identity.backendNodeId, connected: true },
    });

    const runtimeEvidence = mcp.captureRuntimeEvidence(session);
    expect(runtimeEvidence).toMatchObject({
      current: true,
      liveCdpEnabled: true,
      sessionId,
    });
    expect.soft(runtimeEvidence.runBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId,
        phase: 'pre_action',
        ref: 'e-confirm-payment',
        pageId: pre.pageIdentity.pageId,
        backendNodeId: pre.identity.backendNodeId,
        contractStepId,
        actionOccurrenceId,
      }),
    ]));

    const result = {
      qaaiActionLocator: actionLocatorWithPost,
      qaaiCaptureRuntime: runtimeEvidence,
      qaaiActionEvidence: {
        status: 'verified_pre_dispatch',
        captureRuntime: runtimeEvidence,
      },
    };
    const trailEntry = {
      tool: 'browser_click',
      toolUseId: 'tool-use-confirm-payment',
      contractStepId,
      actionOccurrenceId,
      args: { ref: 'e-confirm-payment', element: 'Confirm payment' },
      pageUrl: popupPage.url(),
    };
    const built = recorder.recordExecutableAction({
      runResultId: 'run-result-phase1-real-boundary',
      testCase: { id: 'payment-case', name: 'Confirm payment in popup' },
      status: 'pass',
      trailEntry,
      result,
    });

    expect(built.locatorRecipes).toHaveLength(1);
    expect(built.actionEvidences).toHaveLength(1);
    expect(built.actionEvidences[0]).toMatchObject({ contractStepId, locatorRecipeId: built.locatorRecipes[0].id });
    const persistedEvidence = JSON.parse(built.actionEvidences[0].evidenceJson);
    expect.soft(persistedEvidence.captureRuntime.runBindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ contractStepId, actionOccurrenceId, backendNodeId: pre.identity.backendNodeId }),
    ]));
    const persistedCapture = built.locatorRecipes[0]._recipe.captureEvidence;
    expect.soft(persistedCapture).toMatchObject({
      backendNodeId: pre.identity.backendNodeId,
      pre: { phase: 'pre_action' },
      post: { phase: 'post_action' },
      popupIdentity: { id: 'payment-popup' },
    });

    newCdpSession.mockRestore();
  }, 120_000);

  it('preserves an authored action with an explicit nonblocking capture gap when a live page is unavailable', async () => {
    const sessionId = 'phase1-unavailable-browser-boundary';
    const contractStepId = 'fallback-case:step:2';
    const actionOccurrenceId = 'fallback-case:step:2:click:1';
    const session = {
      id: sessionId,
      currentUrl: 'https://example.test/login',
      captureRuntime: runtimeFor(sessionId, false),
    };

    const directCapture = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-continue',
      element: 'Continue',
      pageUrl: session.currentUrl,
      phase: 'pre_action',
      contractStepId,
      actionOccurrenceId,
    });
    expect(directCapture).toMatchObject({
      available: false,
      captured: false,
      authoritative: false,
      reason: 'playwright_page_unavailable',
    });

    const fulfilled = await resolver.fulfillForTool({
      session,
      toolName: 'browser_click',
      args: { ref: 'e-continue', element: 'Continue' },
      pageUrl: session.currentUrl,
      elementLabel: 'Continue',
      contractStepId,
      actionOccurrenceId,
    });
    expect(fulfilled.ok).toBe(false);
    expect(fulfilled.gap).toMatchObject({
      code: 'missing_verified_action_locator',
      nonBlocking: true,
      toolName: 'browser_click',
      ref: 'e-continue',
    });

    const runtimeEvidence = mcp.captureRuntimeEvidence(session);
    const result = {
      actionLocatorGap: fulfilled.gap,
      qaaiCaptureRuntime: runtimeEvidence,
      qaaiActionEvidence: {
        status: 'locator_capture_gap',
        gap: fulfilled.gap,
        captureRuntime: runtimeEvidence,
      },
    };
    const liveScriptLedger = recorder.createLiveScriptLedger({
      runResultId: 'run-result-phase1-gap',
      testCase: { id: 'fallback-case', name: 'Continue despite locator capture gap' },
      status: 'blocked',
    });
    const trailEntry = {
      tool: 'browser_click',
      toolUseId: 'tool-use-continue',
      contractStepId,
      actionOccurrenceId,
      args: { ref: 'e-continue', element: 'Continue' },
      pageUrl: session.currentUrl,
    };
    const built = recorder.recordExecutableAction({
      runResultId: 'run-result-phase1-gap',
      testCase: { id: 'fallback-case', name: 'Continue despite locator capture gap' },
      status: 'blocked',
      trailEntry,
      result,
      liveScriptLedger,
    });

    expect(trailEntry.captureFirst).toMatchObject({ recorded: true, exportable: true });
    expect(built.actionEvidences).toHaveLength(1);
    expect(built.locatorRecipes).toHaveLength(0);
    expect(built.liveScriptLedger.lines).toHaveLength(1);
    const persistedEvidence = JSON.parse(built.actionEvidences[0].evidenceJson);
    expect(persistedEvidence.actionLocatorGap).toMatchObject({
      code: 'missing_verified_action_locator',
      nonBlocking: true,
    });
  }, 60_000);
});
