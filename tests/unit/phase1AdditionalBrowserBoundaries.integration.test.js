import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const mcp = require('../../server/services/mcp.js');
const resolver = require('../../server/services/actionLocatorResolver.js');

const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function evaluateFunction(source) {
  return Function(`"use strict"; return (${String(source || '')});`)();
}

function targetClient(target) {
  return {
    async callTool(call) {
      if (call?.name !== 'browser_evaluate') throw new Error(`Unexpected MCP tool ${call?.name}`);
      try {
        const value = await target.evaluate(evaluateFunction(call.arguments?.function), undefined, { timeout: 3_000 });
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
      }
    },
  };
}

function pageAndTargetClient(page, target) {
  return {
    async callTool(call) {
      if (call?.name !== 'browser_evaluate') throw new Error(`Unexpected MCP tool ${call?.name}`);
      const fn = evaluateFunction(call.arguments?.function);
      try {
        const value = call.arguments?.target
          ? await target.evaluate(fn, undefined, { timeout: 3_000 })
          : await page.evaluate(fn);
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message || error) }] };
      }
    },
  };
}

function sessionFor({ context, target, page, id, popupIdentity = null, client = null }) {
  return {
    id,
    currentUrl: page.url(),
    client: client || targetClient(target),
    liveCdp: { context },
    activePopupIdentity: popupIdentity,
    activePageAlias: popupIdentity?.id || 'primary-page',
    captureRuntime: mcp.captureRuntimeDescriptor({
      sessionId: id,
      sessionStartedAt: new Date().toISOString(),
      liveCdpEnabled: true,
      runBindings: [],
    }),
  };
}

async function resolveAction({ session, toolName, ref, element, contractStepId, actionOccurrenceId }) {
  return await resolver.resolveForTool({
    session,
    toolName,
    args: { ref, element },
    pageUrl: session.currentUrl,
    elementLabel: element,
    contractStepId,
    actionOccurrenceId,
  });
}

describe('Phase 1 additional real-browser boundaries', () => {
  let browser;
  const openContexts = new Set();

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(existsSync(SYSTEM_CHROME) ? { executablePath: SYSTEM_CHROME } : {}),
    });
  }, 60_000);

  afterEach(async () => {
    const contexts = Array.from(openContexts);
    openContexts.clear();
    await Promise.allSettled(contexts.map((context) => context.close()));
  }, 30_000);

  afterAll(async () => {
    if (!browser) return;
    try {
      const browserCdp = await browser.newBrowserCDPSession();
      await browserCdp.send('Browser.close');
    } catch (_) {
      await browser.close();
    }
  }, 30_000);

  it('preserves an exact ordered frame path deeper than one iframe', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent('<iframe id="application-shell" title="Application shell"></iframe>', {
      waitUntil: 'domcontentloaded',
    });
    const outerFrame = page.frames().find((frame) => frame !== page.mainFrame());
    await outerFrame.setContent('<iframe id="payment-provider" title="Payment provider"></iframe>');
    const innerFrame = page.frames().find((frame) => frame !== page.mainFrame() && frame !== outerFrame);
    await innerFrame.setContent('<button data-testid="confirm-order">Confirm order</button>');
    const target = innerFrame.getByTestId('confirm-order');
    const session = sessionFor({ context, target, page, id: 'phase1-nested-frame-depth-two' });

    const actionLocator = await resolveAction({
      session,
      toolName: 'browser_click',
      ref: 'e-confirm-order',
      element: 'Confirm order',
      contractStepId: 'order:step:9',
      actionOccurrenceId: 'order:step:9:click:1',
    });
    const pre = actionLocator.context.authoritativeCdp.pre;

    expect(resolver.isVerifiedActionLocator(actionLocator)).toBe(true);
    expect(pre.framePath).toHaveLength(2);
    expect(pre.framePathSelectors).toEqual(['#application-shell', '#payment-provider']);
    expect(pre.framePath.map((entry) => entry.attributes.id)).toEqual([
      'application-shell',
      'payment-provider',
    ]);
    expect(actionLocator.expression.indexOf('frameLocator("#application-shell")')).toBeLessThan(
      actionLocator.expression.indexOf('frameLocator("#payment-provider")'),
    );
  }, 120_000);

  it('captures a bound closed-shadow node exactly and records an explicit non-guessable shadow gap', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent('<secure-shell id="secure-shell"></secure-shell>', { waitUntil: 'domcontentloaded' });
    const closedTarget = await page.evaluateHandle(() => {
      const host = document.querySelector('#secure-shell');
      const root = host.attachShadow({ mode: 'closed' });
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Approve secure action';
      root.appendChild(button);
      return button;
    });
    const session = sessionFor({
      context,
      target: closedTarget,
      page,
      id: 'phase1-closed-shadow-target',
    });

    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-secure-approve',
      element: 'Approve secure action',
      pageUrl: page.url(),
      phase: 'pre_action',
      contractStepId: 'secure:step:3',
      actionOccurrenceId: 'secure:step:3:click:1',
    });

    expect(captured).toMatchObject({
      captured: true,
      authoritative: true,
      identity: { backendNodeId: expect.any(Number) },
      node: { nodeName: 'BUTTON' },
      accessibility: { role: 'button', name: 'Approve secure action' },
      shadowPath: [],
      shadowContext: {
        available: false,
        reason: 'closed_shadow_root',
        gaps: [expect.objectContaining({ reason: 'closed_shadow_root', rootType: 'closed' })],
      },
    });
    expect(captured.selectedCandidate ?? null).toBeNull();
    expect(captured.verifiedCandidates || []).toHaveLength(0);
    expect(captured.guess).toBeUndefined();
    await closedTarget.dispose();
  }, 120_000);

  it('captures and dispatches a present optional dialog action normally', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <dialog open aria-label="Stay signed in">
        <p>Stay signed in?</p>
        <button data-testid="dismiss-stay-signed-in">No</button>
      </dialog>
    `, { waitUntil: 'domcontentloaded' });
    const target = page.getByTestId('dismiss-stay-signed-in');
    await target.evaluate((button) => {
      button.addEventListener('click', () => button.closest('dialog').close());
    });
    const session = sessionFor({ context, target, page, id: 'phase1-present-optional-dialog' });

    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-dismiss-stay-signed-in',
      element: 'No',
      pageUrl: page.url(),
      phase: 'pre_action',
      contractStepId: 'login:step:10',
      actionOccurrenceId: 'login:step:10:dismiss:1',
      optional: true,
    });

    expect(captured).toMatchObject({
      captured: true,
      authoritative: true,
      captureBinding: { status: 'bound' },
      selectedCandidate: { verified: true },
      state: { actionableBy: { click: true } },
    });
    expect(captured.optionalAbsence).toBeUndefined();
    await target.click();
    expect(await page.locator('dialog[aria-label="Stay signed in"]').evaluate((dialog) => dialog.open)).toBe(false);
  }, 120_000);

  it('preserves source-page post state and exact new-page opener identity after a popup transition', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const source = await context.newPage();
    await source.setContent('<button data-testid="open-receipt">Open receipt</button>', {
      waitUntil: 'domcontentloaded',
    });
    const sourceTarget = source.getByTestId('open-receipt');
    await sourceTarget.evaluate((button) => {
      button.addEventListener('click', () => window.open('about:blank', 'receipt-popup'));
    });
    const session = sessionFor({ context, target: sourceTarget, page: source, id: 'phase1-new-page-transition' });
    const sourceLocator = await resolveAction({
      session,
      toolName: 'browser_click',
      ref: 'e-open-receipt',
      element: 'Open receipt',
      contractStepId: 'receipt:step:1',
      actionOccurrenceId: 'receipt:step:1:click:1',
    });
    const sourcePre = sourceLocator.context.authoritativeCdp.pre;

    const popupPromise = context.waitForEvent('page');
    await sourceTarget.click();
    const popup = await popupPromise;
    await popup.setContent('<h1 data-testid="receipt-title">Receipt</h1>', { waitUntil: 'domcontentloaded' });
    const lateDecoy = await context.newPage();
    await lateDecoy.setContent('<h1 data-testid="decoy-title">Receipt</h1>', { waitUntil: 'domcontentloaded' });

    const sourceWithPost = await mcp.captureAuthoritativePostAction(session, sourceLocator, {
      pageUrl: source.url(),
    });
    expect(sourceWithPost.context.authoritativeCdp.post).toMatchObject({
      presentInSnapshot: true,
      sameBackendNode: true,
      pageIdentity: { pageId: sourcePre.pageIdentity.pageId },
    });

    const popupTarget = popup.getByTestId('receipt-title');
    session.client = targetClient(popupTarget);
    session.currentUrl = popup.url();
    session.activePopupIdentity = { id: 'receipt-popup' };
    const popupCapture = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-receipt-title',
      element: 'Receipt',
      pageUrl: popup.url(),
      phase: 'post_transition_target',
      contractStepId: 'receipt:step:2',
      actionOccurrenceId: 'receipt:step:2:assert:1',
      popupIdentity: { id: 'receipt-popup' },
    });
    expect(popupCapture).toMatchObject({
      captured: true,
      authoritative: true,
      pageIdentity: {
        pageId: expect.any(String),
        openerPageId: sourcePre.pageIdentity.pageId,
        popupIdentity: { id: 'receipt-popup' },
      },
      node: { attributes: { 'data-testid': 'receipt-title' } },
    });
    expect(popupCapture.pageIdentity.pageId).not.toBe(sourcePre.pageIdentity.pageId);
    expect(popupCapture.node.attributes['data-testid']).not.toBe('decoy-title');
  }, 120_000);

  it('acquires visual tooltip observation from the live page before semantic enrichment', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <button data-testid="save-button" aria-describedby="save-tooltip">Save</button>
      <div id="save-tooltip" role="tooltip" style="display:none">Save changes</div>
      <script>
        const button = document.querySelector('[data-testid="save-button"]');
        const tooltip = document.querySelector('#save-tooltip');
        button.addEventListener('mouseenter', () => { tooltip.style.display = 'block'; });
        button.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
      </script>
    `, { waitUntil: 'domcontentloaded' });
    const trigger = page.getByTestId('save-button');
    await trigger.hover();
    const session = sessionFor({
      context,
      target: trigger,
      page,
      id: 'phase1-tooltip-visual-acquisition',
      client: pageAndTargetClient(page, trigger),
    });

    expect(
      typeof mcp.acquireTooltipVisualObservation,
      'Missing public controlled-page hook: paintHoverVisualPreview is private inside callTool, so visual evidence acquisition cannot be verified independently or passed to authoritative tooltip capture.',
    ).toBe('function');
    const visualObservation = await mcp.acquireTooltipVisualObservation(session, {
      expectedText: 'Save changes',
      element: 'Save',
      ref: 'e-save-button',
    });
    expect(visualObservation).toMatchObject({
      observed: true,
      available: true,
      source: 'app_tooltip_visible',
      text: expect.stringContaining('Save changes'),
    });

    const tooltip = page.getByRole('tooltip', { name: 'Save changes' });
    session.client = targetClient(tooltip);
    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-save-tooltip',
      element: 'Save changes tooltip',
      pageUrl: page.url(),
      phase: 'assertion_observation',
      contractStepId: 'editor:step:4:tooltip',
      actionOccurrenceId: 'editor:step:4:hover:1',
      observationKind: 'tooltip',
      expectedText: 'Save changes',
      visualObservation,
    });
    expect(captured.tooltipEvidence).toMatchObject({
      dom: { present: true, text: 'Save changes' },
      visual: { observed: true, text: expect.stringContaining('Save changes') },
      semantics: 'dom_and_visual_confirmed',
      nonBlocking: true,
    });
  }, 120_000);
});
