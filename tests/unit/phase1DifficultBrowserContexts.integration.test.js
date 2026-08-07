import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const mcp = require('../../server/services/mcp.js');
const resolver = require('../../server/services/actionLocatorResolver.js');

const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function markerClient(targetLocator) {
  return {
    async callTool(call) {
      if (call?.name !== 'browser_evaluate') {
        throw new Error(`Unexpected MCP tool ${call?.name}`);
      }
      const source = String(call.arguments?.function || '');
      const evaluateFunction = Function(`"use strict"; return (${source});`)();
      try {
        await targetLocator.evaluate(evaluateFunction, undefined, { timeout: 2_000 });
        return { isError: false, content: [{ type: 'text', text: 'true' }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: String(error?.message || error) }],
        };
      }
    },
  };
}

function sessionFor({ context, target, id, page, popupIdentity = null }) {
  return {
    id,
    currentUrl: page.url(),
    client: markerClient(target),
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

async function resolveBoundAction({ session, toolName, ref, element, contractStepId, actionOccurrenceId }) {
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

describe('Phase 1 difficult real-browser contexts', () => {
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

  it('retains exact popup ownership when later pages share the same URL', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const opener = await context.newPage();
    await opener.setContent('<main>Checkout</main>', { waitUntil: 'domcontentloaded' });
    const popupPromise = context.waitForEvent('page');
    await opener.evaluate(() => window.open('about:blank', 'payment-popup'));
    const popup = await popupPromise;
    await popup.setContent('<button data-testid="authorize-payment">Authorize payment</button>', {
      waitUntil: 'domcontentloaded',
    });
    const target = popup.getByTestId('authorize-payment');
    const session = sessionFor({
      context,
      target,
      id: 'phase1-exact-popup-owner',
      page: popup,
      popupIdentity: { id: 'payment-popup' },
    });
    const actionLocator = await resolveBoundAction({
      session,
      toolName: 'browser_click',
      ref: 'e-authorize-payment',
      element: 'Authorize payment',
      contractStepId: 'checkout:step:5',
      actionOccurrenceId: 'checkout:step:5:click:1',
    });
    const pre = actionLocator.context.authoritativeCdp.pre;
    const lateSameUrlPage = await context.newPage();
    await lateSameUrlPage.setContent('<button data-testid="decoy-authorize">Authorize payment</button>', {
      waitUntil: 'domcontentloaded',
    });

    const withPost = await mcp.captureAuthoritativePostAction(session, actionLocator, { pageUrl: popup.url() });
    const post = withPost.context.authoritativeCdp.post;
    expect(pre.pageIdentity).toMatchObject({
      pageId: expect.any(String),
      openerPageId: expect.any(String),
      popupIdentity: { id: 'payment-popup' },
    });
    expect(pre.pageIdentity.openerPageId).not.toBe(pre.pageIdentity.pageId);
    expect(post).toMatchObject({
      presentInSnapshot: true,
      sameBackendNode: true,
      pageIdentity: { pageId: pre.pageIdentity.pageId },
    });
  }, 120_000);

  it('rebinds a uniquely verified logical control after an action rerenders its DOM node', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent('<button data-testid="save-profile">Save profile</button>', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('save-profile').evaluate((button) => {
      button.addEventListener('click', () => button.replaceWith(button.cloneNode(true)));
    });
    const target = page.getByTestId('save-profile');
    const session = sessionFor({ context, target, id: 'phase1-rerender-replacement', page });
    const actionLocator = await resolveBoundAction({
      session,
      toolName: 'browser_click',
      ref: 'e-save-profile',
      element: 'Save profile',
      contractStepId: 'profile:step:8',
      actionOccurrenceId: 'profile:step:8:click:1',
    });
    const pre = actionLocator.context.authoritativeCdp.pre;

    await target.click();
    const withPost = await mcp.captureAuthoritativePostAction(session, actionLocator, { pageUrl: page.url() });
    const post = withPost.context.authoritativeCdp.post;
    expect(post).toMatchObject({
      presentInSnapshot: false,
      sameBackendNode: false,
      removed: false,
      replacement: {
        resolved: true,
        backendNodeId: expect.any(Number),
        count: 1,
        stable: true,
        logicalTargetPresent: true,
        proof: { count: 1, stable: true },
      },
    });
    expect(post.replacement.backendNodeId).not.toBe(pre.identity.backendNodeId);
  }, 120_000);

  it('reports true removal without falsely binding a replacement', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent('<button data-testid="dismiss-notice">Dismiss notice</button>', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('dismiss-notice').evaluate((button) => {
      button.addEventListener('click', () => button.remove());
    });
    const target = page.getByTestId('dismiss-notice');
    const session = sessionFor({ context, target, id: 'phase1-true-removal', page });
    const actionLocator = await resolveBoundAction({
      session,
      toolName: 'browser_click',
      ref: 'e-dismiss-notice',
      element: 'Dismiss notice',
      contractStepId: 'notice:step:2',
      actionOccurrenceId: 'notice:step:2:click:1',
    });

    await target.click();
    const withPost = await mcp.captureAuthoritativePostAction(session, actionLocator, { pageUrl: page.url() });
    expect(withPost.context.authoritativeCdp.post).toMatchObject({
      presentInSnapshot: false,
      sameBackendNode: false,
      removed: true,
      replacement: {
        resolved: false,
        backendNodeId: null,
        proof: { reason: 'replacement_candidate_not_unique_or_unavailable' },
      },
    });
  }, 120_000);

  it('does not cross-bind repeated controls that share the same accessible label', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <section aria-label="Primary account"><label>Email<input data-testid="primary-email" type="email"></label></section>
      <section aria-label="Secondary account"><label>Email<input data-testid="secondary-email" type="email"></label></section>
    `, { waitUntil: 'domcontentloaded' });
    const target = page.getByTestId('secondary-email');
    const session = sessionFor({ context, target, id: 'phase1-repeated-label', page });
    const actionLocator = await resolveBoundAction({
      session,
      toolName: 'browser_type',
      ref: 'e-secondary-email',
      element: 'Email',
      contractStepId: 'accounts:step:6',
      actionOccurrenceId: 'accounts:step:6:fill:1',
    });
    const pre = actionLocator.context.authoritativeCdp.pre;

    expect(resolver.isVerifiedActionLocator(actionLocator)).toBe(true);
    expect(pre.selectedCandidate).toMatchObject({ strategy: 'testid', value: 'secondary-email' });
    expect(actionLocator.expression).toContain('secondary-email');
    expect(pre.verifiedCandidates.every((candidate) => (
      candidate.proof.matchedBackendNodeId === pre.identity.backendNodeId
    ))).toBe(true);
  }, 120_000);

  it('captures a custom accessible control without replacing its computed role or name', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <billing-toggle data-testid="billing-toggle" role="switch" aria-label="Enable billing alerts"
        aria-checked="false" tabindex="0"
        style="display:inline-block;width:40px;height:24px">Billing alerts</billing-toggle>
    `, { waitUntil: 'domcontentloaded' });
    const target = page.getByTestId('billing-toggle');
    const session = sessionFor({ context, target, id: 'phase1-custom-control', page });
    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-billing-toggle',
      element: 'Enable billing alerts',
      pageUrl: page.url(),
      phase: 'pre_action',
      contractStepId: 'billing:step:3',
      actionOccurrenceId: 'billing:step:3:click:1',
    });

    expect(captured).toMatchObject({
      captured: true,
      authoritative: true,
      node: { nodeName: 'BILLING-TOGGLE' },
      accessibility: { role: 'switch', name: 'Enable billing alerts' },
      state: {
        connected: true,
        visible: true,
        enabled: true,
        disabled: false,
        actionableBy: { click: true, hover: true },
      },
    });
  }, 120_000);

  it('represents an absent optional dialog as a nonblocking absence, not a capture failure', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent('<main>No confirmation dialog is shown</main>', { waitUntil: 'domcontentloaded' });
    const missingDialog = page.getByRole('dialog', { name: 'Stay signed in' });
    const session = sessionFor({ context, target: missingDialog, id: 'phase1-optional-dialog', page });
    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-stay-signed-in-dialog',
      element: 'Stay signed in dialog',
      pageUrl: page.url(),
      phase: 'pre_action',
      contractStepId: 'login:step:10',
      actionOccurrenceId: 'login:step:10:dismiss:1',
      optional: true,
    });

    expect(captured).toMatchObject({
      available: true,
      captured: false,
      authoritative: false,
      optional: true,
      nonBlocking: true,
      reason: 'optional_target_absent',
    });
  }, 60_000);

  it('separates DOM-confirmed tooltip evidence from unavailable visual observation', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <button aria-describedby="save-tooltip">Save</button>
      <div id="save-tooltip" role="tooltip" aria-label="Save changes" style="display:none">Save changes</div>
    `, { waitUntil: 'domcontentloaded' });
    const tooltip = page.getByRole('tooltip', { name: 'Save changes', includeHidden: true });
    const session = sessionFor({ context, target: tooltip, id: 'phase1-tooltip-semantics', page });
    const captured = await mcp.captureAuthoritativeActionTarget(session, {
      ref: 'e-save-tooltip',
      element: 'Save changes tooltip',
      pageUrl: page.url(),
      phase: 'assertion_observation',
      contractStepId: 'editor:step:4:tooltip',
      actionOccurrenceId: 'editor:step:4:hover:1',
      observationKind: 'tooltip',
      expectedText: 'Save changes',
      visualObserved: false,
    });

    expect(captured).toMatchObject({
      captured: true,
      authoritative: true,
      layout: { visible: false },
      tooltipEvidence: {
        dom: { present: true, text: 'Save changes' },
        visual: { observed: false, text: null },
        semantics: 'dom_confirmed_visual_unavailable',
        nonBlocking: true,
      },
    });
  }, 120_000);

  it('normalizes disabled, read-only, and editable state with operation-specific actionability', async () => {
    const context = await browser.newContext();
    openContexts.add(context);
    const page = await context.newPage();
    await page.setContent(`
      <button data-testid="disabled-submit" disabled>Submit</button>
      <label>Account ID<input data-testid="readonly-account" readonly value="A-100"></label>
      <label>Display name<input data-testid="editable-name" value="Alex"></label>
    `, { waitUntil: 'domcontentloaded' });

    const capture = async (testId, ref, element) => {
      const target = page.getByTestId(testId);
      const session = sessionFor({ context, target, id: `phase1-state-${testId}`, page });
      return await mcp.captureAuthoritativeActionTarget(session, {
        ref,
        element,
        pageUrl: page.url(),
        phase: 'pre_action',
        contractStepId: `state:${testId}`,
        actionOccurrenceId: `state:${testId}:1`,
      });
    };

    const disabled = await capture('disabled-submit', 'e-disabled-submit', 'Submit');
    const readOnly = await capture('readonly-account', 'e-readonly-account', 'Account ID');
    const editable = await capture('editable-name', 'e-editable-name', 'Display name');

    expect(disabled.state).toMatchObject({
      connected: true,
      visible: true,
      enabled: false,
      disabled: true,
      editable: false,
      readOnly: false,
      actionableBy: { click: false, fill: false, hover: true },
    });
    expect(readOnly.state).toMatchObject({
      connected: true,
      visible: true,
      enabled: true,
      disabled: false,
      editable: false,
      readOnly: true,
      actionableBy: { click: true, fill: false, hover: true },
    });
    expect(editable.state).toMatchObject({
      connected: true,
      visible: true,
      enabled: true,
      disabled: false,
      editable: true,
      readOnly: false,
      actionableBy: { click: true, fill: true, hover: true },
    });
  }, 120_000);
});
