#!/usr/bin/env node
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..');
const resolver = require(path.join(root, 'server/services/actionLocatorResolver'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

function proof() {
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'doc:resolver-verifier',
    nodeId: 'node:target',
    connected: true,
  };
  return {
    count: 1,
    sameElement: true,
    visible: true,
    enabled: true,
    verified: true,
    actionTimeResolved: true,
    resolutionMode: 'bound_mcp_ref',
    identityVerified: true,
    targetIdentity,
    matchedIdentity: { ...targetIdentity },
  };
}

function build(candidates, facts = {}) {
  return resolver.buildActionLocatorFromInspection({
    toolName: 'browser_click',
    args: {},
    pageUrl: 'https://example.test',
    elementLabel: facts.accessibleName || facts.placeholder || 'target',
    inspection: {
      ok: true,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-target' },
      targetIdentity: proof().targetIdentity,
      facts,
      context: { nearbyText: ['Products'] },
      domAtlas: {
        schemaVersion: 'qaai-dom-atlas-v1',
        url: 'https://example.test',
        routeKey: '/',
        title: 'Example',
        counts: { elements: 1, controls: 1, forms: 0, tables: 0, dialogs: 0, frames: 0, shadowHosts: 0 },
        controls: [],
        forms: [],
        tables: [],
        dialogs: [],
        landmarks: [],
        frames: [],
        shadowHosts: [],
        headings: [],
      },
      candidates,
    },
  });
}

{
  const locator = build([
    { strategy: 'role', role: 'textbox', name: 'Search Product', expression: 'getByRole("textbox", { name: "Search Product" })', frameworkExpressions: { playwright: 'getByRole("textbox", { name: "Search Product" })' }, candidate: { strategy: 'role', role: 'textbox', name: 'Search Product' }, proof: proof(), score: 760 },
    { strategy: 'placeholder', text: 'Search Product', expression: 'getByPlaceholder("Search Product")', frameworkExpressions: { playwright: 'getByPlaceholder("Search Product")' }, candidate: { strategy: 'placeholder', text: 'Search Product' }, proof: proof(), score: 880 },
  ], { tag: 'input', role: 'textbox', placeholder: 'Search Product' });
  assert(locator.expression === 'getByRole("textbox", { name: "Search Product" })', 'accessible named textbox prefers the Playwright role locator');
  assert(locator.candidates.some((c) => c.strategy === 'placeholder'), 'placeholder candidate is carried into ReplayIR');
}

{
  const locator = build([
    { strategy: 'role', role: 'button', name: 'Search', expression: 'getByRole("button", { name: "Search" })', frameworkExpressions: { playwright: 'getByRole("button", { name: "Search" })' }, candidate: { strategy: 'role', role: 'button', name: 'Search' }, proof: proof(), score: 950 },
    { strategy: 'css-structural', expression: 'locator("body > button:nth-of-type(1)")', frameworkExpressions: { playwright: 'locator("body > button:nth-of-type(1)")' }, candidate: { strategy: 'css', selector: 'body > button:nth-of-type(1)' }, proof: proof(), score: 610 },
  ], { tag: 'button', role: 'button', accessibleName: 'Search' });
  assert(locator.expression === 'getByRole("button", { name: "Search" })', 'named button prefers getByRole');
  assert(locator.candidates[0].strategy === 'role', 'selected role candidate is first in candidate ladder');
}

{
  assert(resolver.cleanAccessibleName(' Women') === 'Women', 'icon-font category names are normalized to human text');
  assert(resolver.cleanAccessibleName('') === '', 'glyph-only accessible names normalize to empty text');
  assert(resolver.containsGlyphContamination('getByRole("button", { name: "" })'), 'glyph-contaminated locator expressions are detectable');
}

{
  const locator = build([
    { strategy: 'role', role: 'button', name: '', expression: 'getByRole("button", { name: "" })', frameworkExpressions: { playwright: 'getByRole("button", { name: "" })' }, candidate: { strategy: 'role', role: 'button', name: '' }, proof: proof(), score: 950 },
    { strategy: 'css-id', expression: 'locator("#submit_search")', frameworkExpressions: { playwright: 'locator("#submit_search")' }, candidate: { strategy: 'css', selector: '#submit_search' }, selector: '#submit_search', proof: proof(), score: 720 },
  ], { tag: 'button', role: 'button', rawAccessibleName: '', normalizedAccessibleName: '' });
  assert(locator.expression === 'locator("#submit_search")', 'glyph-only role locator is rejected in favor of stable CSS/id evidence');
}

{
  const locator = build([
    { strategy: 'role', role: 'button', name: '', expression: 'getByRole("button")', frameworkExpressions: { playwright: 'getByRole("button")' }, candidate: { strategy: 'role', role: 'button' }, proof: proof(), score: 950 },
    { strategy: 'context-css', expression: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")', frameworkExpressions: { playwright: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")' }, candidate: { strategy: 'css', selector: 'form[action="/products"] button[type="submit"]' }, proof: proof(), score: 780 },
  ], { tag: 'button', role: 'button' });
  assert(locator.strategy === 'context-css', 'role-only candidate is rejected and form-scoped submit locator wins');
}

{
  const locator = build([
    { strategy: 'context-xpath', expression: 'locator("xpath=//tr[contains(., \\"ORD-1\\")]//button[2]")', frameworkExpressions: { playwright: 'locator("xpath=//tr[contains(., \\"ORD-1\\")]//button[2]")' }, candidate: { strategy: 'css', selector: 'xpath=//tr[contains(., "ORD-1")]//button[2]', contextText: ['ORD-1 Pending'] }, proof: proof(), score: 760 },
    { strategy: 'css-structural', expression: 'locator("table > tr:nth-of-type(4) > td:nth-of-type(5) > button:nth-of-type(2)")', frameworkExpressions: { playwright: 'locator("table > tr:nth-of-type(4) > td:nth-of-type(5) > button:nth-of-type(2)")' }, candidate: { strategy: 'css', selector: 'table > tr:nth-of-type(4) > td:nth-of-type(5) > button:nth-of-type(2)' }, proof: proof(), score: 610 },
  ], { tag: 'button', role: 'button' });
  assert(locator === null, 'v1 rejects XPath/structural-only candidates instead of exporting brittle locators');
}

{
  const locator = build([
    { strategy: 'role', role: 'textbox', name: '', expression: 'getByRole("textbox")', frameworkExpressions: { playwright: 'getByRole("textbox")' }, candidate: { strategy: 'role', role: 'textbox' }, proof: proof(), score: 950 },
    { strategy: 'xpath', expression: 'locator("xpath=/html/body/input[1]")', frameworkExpressions: { playwright: 'locator("xpath=/html/body/input[1]")' }, candidate: { strategy: 'css', selector: 'xpath=/html/body/input[1]' }, proof: proof(), score: 500 },
  ], { tag: 'input', role: 'textbox' });
  assert(locator === null, 'v1 does not use XPath as final fallback when semantic candidates are unsafe');
}

{
  const locator = build([
    { strategy: 'css-structural', expression: 'locator("main input:nth-of-type(1)")', frameworkExpressions: { playwright: 'locator("main input:nth-of-type(1)")', selenium: 'By.cssSelector("main input:nth-of-type(1)")' }, candidate: { strategy: 'css', selector: 'main input:nth-of-type(1)' }, proof: proof(), score: 610 },
  ], { tag: 'input' });
  assert(locator === null, 'structural CSS-only candidates are not promoted to KB in v1');
}

{
  const locator = resolver.buildActionLocatorFromInspection({
    toolName: 'browser_click',
    args: {},
    pageUrl: 'https://example.test',
    elementLabel: 'Search',
    inspection: {
      ok: true,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-target' },
      targetIdentity: proof().targetIdentity,
      facts: { tag: 'button', role: 'button', accessibleName: 'Search' },
      context: { frameSelector: 'iframe#catalog' },
      candidates: [
        { strategy: 'role', role: 'button', name: 'Search', expression: 'getByRole("button", { name: "Search" })', frameworkExpressions: { playwright: 'getByRole("button", { name: "Search" })' }, candidate: { strategy: 'role', role: 'button', name: 'Search' }, proof: proof(), score: 950 },
      ],
    },
  });
  assert(locator.expression === 'frameLocator("iframe#catalog").getByRole("button", { name: "Search" })', 'iframe targets preserve frameLocator context in the action-time expression');
}

{
  const locator = resolver.buildActionLocatorFromInspection({
    toolName: 'browser_click',
    args: {},
    pageUrl: 'https://example.test/products',
    elementLabel: 'Search',
    inspection: {
      ok: true,
      captureBinding: { kind: 'mcp_bound_ref', ref: 'e-target' },
      targetIdentity: proof().targetIdentity,
      facts: { tag: 'button', role: 'button', accessibleName: 'Search' },
      context: { nearbyText: ['All Products'] },
      domAtlas: {
        schemaVersion: 'qaai-dom-atlas-v1',
        url: 'https://example.test/products',
        routeKey: '/products',
        title: 'Products',
        counts: { elements: 12, controls: 2 },
        controls: [
          { selector: 'form[action="/products"] button[type="submit"]', tag: 'button', role: 'button', name: 'Search', visible: true, enabled: true },
        ],
        forms: [
          { selector: 'form[action="/products"]', action: '/products', method: 'get', controls: [] },
        ],
      },
      candidates: [
        { strategy: 'role', role: 'button', name: 'Search', expression: 'getByRole("button", { name: "Search" })', frameworkExpressions: { playwright: 'getByRole("button", { name: "Search" })' }, candidate: { strategy: 'role', role: 'button', name: 'Search' }, proof: proof(), score: 950 },
      ],
    },
  });
  assert(locator.domAtlas && locator.domAtlas.pages === undefined, 'action locator carries compact DOM Atlas page evidence');
  assert(locator.domAtlas.verifiedActions.length === 1, 'DOM Atlas records the verified action locator on the page');
  assert(resolver.domAtlasFromActionLocator(locator).routeKey === '/products', 'domAtlasFromActionLocator extracts atlas evidence from scalar actions');
}

{
  const locator = build([
    {
      strategy: 'css-attr',
      expression: 'locator("[data-qa=\\"submit-search\\"]")',
      frameworkExpressions: { playwright: 'locator("[data-qa=\\"submit-search\\"]")' },
      candidate: { strategy: 'css', selector: '[data-qa="submit-search"]' },
      proof: proof(),
      score: 990,
    },
  ], { tag: 'button', role: 'button', accessibleName: 'Search', stableAttributes: { 'data-qa': 'submit-search' } });
  assert(locator.expression === 'locator("[data-qa=\\"submit-search\\"]")', 'non-default data-qa uses CSS locator, not getByTestId');
}

(async () => {
  {
    let calls = 0;
    const snap = [
      '- generic [ref=e1]:',
      '  - button "Login" [ref=e30]',
    ].join('\n');
    const fast = await resolver.resolveVerifiedForTool({
      session: { client: { callTool: async () => { calls += 1; throw new Error('browser_evaluate should not run'); } } },
      toolName: 'browser_click',
      args: { target: 'e30', element: 'Login button' },
      snapshotText: snap,
      pageUrl: 'https://example.test/login',
      elementLabel: 'Login button',
    });
    assert(fast.ok === false && !resolver.isVerifiedActionLocator(fast.actionLocator), 'snapshot-only ref evidence never returns a verified locator');
    assert(calls > 0, 'strict resolver attempts live bound-node recertification before retaining snapshot evidence');
  }

  const strict = await resolver.resolveVerifiedForTool({
    toolName: 'browser_click',
    args: { selector: '#submit' },
    snapshotText: '',
    pageUrl: 'https://example.test',
    elementLabel: 'Submit',
  });
  assert(strict.ok === false, 'strict resolver rejects diagnostic-only fallback as executable evidence');
  assert(strict.diagnostic && strict.diagnostic.diagnosticOnly === true, 'strict resolver still returns diagnostic locator evidence for audit');
  assert(strict.gap && strict.gap.code === 'missing_verified_action_locator', 'strict resolver emits an explicit internal locator evidence gap');
  assert(strict.gap.reason === 'excavation_failed' && Array.isArray(strict.gap.strategiesTried), 'locator gap includes explicit excavation schema');

  if (process.exitCode) process.exit(process.exitCode);
  console.log('verify_action_locator_resolver: all checks passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
