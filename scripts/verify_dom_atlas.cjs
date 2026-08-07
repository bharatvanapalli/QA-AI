#!/usr/bin/env node
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..');
const resolver = require(path.join(root, 'server/services/actionLocatorResolver'));
const pageAtlas = require(path.join(root, 'server/services/pageAtlas'));
const projectActionMemory = require(path.join(root, 'server/services/projectActionMemory'));
const replayEmitter = require(path.join(root, 'server/services/codegen/replayEmitter'));
const playwrightPom = require(path.join(root, 'server/services/codegen/adapters/playwrightPom'));

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`OK: ${message}`);
  }
}

const proof = { count: 1, sameElement: true, visible: true, enabled: true };
const inspection = {
  ok: true,
  facts: { tag: 'button', role: 'button', accessibleName: 'Search submit button' },
  context: { formSelector: 'form[action="/products"]', nearbyText: ['All Products', 'Search Product'] },
  domAtlas: {
    schemaVersion: 'qaai-dom-atlas-v1',
    url: 'https://automationexercise.com/products',
    routeKey: '/products',
    title: 'Automation Exercise - Products',
    counts: { elements: 64, controls: 8, forms: 1, tables: 0, dialogs: 0, frames: 0, shadowHosts: 0 },
    controls: [
      { selector: 'input[placeholder="Search Product"]', tag: 'input', role: 'textbox', placeholder: 'Search Product', visible: true, enabled: true },
      { selector: 'form[action="/products"] button[type="submit"]', tag: 'button', role: 'button', name: 'Search submit button', visible: true, enabled: true },
    ],
    forms: [
      { selector: 'form[action="/products"]', action: '/products', method: 'get', controls: [
        { selector: 'input[placeholder="Search Product"]', tag: 'input', role: 'textbox', placeholder: 'Search Product' },
        { selector: 'form[action="/products"] button[type="submit"]', tag: 'button', role: 'button', name: 'Search submit button' },
      ] },
    ],
    headings: ['All Products'],
  },
  candidates: [
    {
      strategy: 'context-css',
      expression: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")',
      frameworkExpressions: { playwright: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")', selenium: 'By.cssSelector("form[action=\\"/products\\"] button[type=\\"submit\\"]")' },
      candidate: { strategy: 'css', selector: 'form[action="/products"] button[type="submit"]' },
      proof,
      score: 780,
    },
  ],
};

const actionLocator = resolver.buildActionLocatorFromInspection({
  toolName: 'browser_click',
  args: { element: 'Search submit button' },
  inspection,
  pageUrl: 'https://automationexercise.com/products',
  elementLabel: 'Search submit button',
});

assert(actionLocator && actionLocator.domAtlas, 'resolver emits DOM Atlas with action locator');
assert(actionLocator.domAtlas.verifiedActions[0].expression.includes('form[action='), 'DOM Atlas stores the exact verified framework expression');

const merged = pageAtlas.mergeDomAtlas({}, actionLocator.domAtlas);
const bucket = merged[pageAtlas.DOM_ATLAS_KEY];
assert(bucket && bucket.pages['/products'], 'pageAtlas.mergeDomAtlas stores the page under the route key');
assert(bucket.pages['/products'].controls.length === 2, 'pageAtlas stores compact controls without dropping form/search controls');

const irResult = replayEmitter.buildReplayIR({
  caseId: 'case-products-search',
  title: 'Search products',
  trail: [
    {
      tool: 'browser_click',
      ok: true,
      args: { element: 'Search submit button', ref: 'e7' },
      pageUrl: 'https://automationexercise.com/products',
      actionLocator,
    },
  ],
  declaredAssertions: [],
  assertionOutcomes: [],
  verdictStatus: 'pass',
});
assert(irResult.complete === true, 'ReplayIR remains complete for an action with action-time locator evidence');
assert(irResult.ir.domAtlas && irResult.ir.domAtlas.pages['/products'], 'ReplayIR carries DOM Atlas evidence');

const emitted = playwrightPom.emitJourneySpec([{ ir: irResult.ir, title: 'Search products' }], { lang: 'js' });
assert(emitted.extraFiles['evidence/dom-atlas.json'], 'Playwright POM export includes evidence/dom-atlas.json');
const exportedAtlas = JSON.parse(emitted.extraFiles['evidence/dom-atlas.json']);
assert(exportedAtlas.pages['/products'].verifiedActions.length === 1, 'POM DOM Atlas evidence includes verified action locators');
assert(!emitted.content.includes('QAAI_UNRESOLVED_LOCATOR'), 'POM spec does not fall back to unresolved locator placeholders');

const intent = projectActionMemory.buildStepIntentHash({
  toolName: 'browser_click',
  args: { element: 'Search submit button' },
  actionLocator,
  pageUrl: 'https://automationexercise.com/products',
  declaredStep: { action: 'click', element: 'Search submit button' },
});
const memoryRow = {
  id: 'memory-submit',
  testCaseId: 'case-products',
  routeKey: '/products',
  actionType: 'click',
  stepIntentHash: 'previous-hash',
  stepIntentPartsJson: JSON.stringify(intent.parts),
  selectorExpression: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")',
  frameworkExpressionsJson: JSON.stringify({ playwright: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")' }),
  actionLocatorJson: JSON.stringify(actionLocator),
  targetFactsJson: JSON.stringify(actionLocator.targetFacts),
  contextJson: JSON.stringify(actionLocator.context),
  domAtlasPageJson: JSON.stringify(exportedAtlas.pages['/products']),
  elementKey: intent.elementKey,
  elementLabel: intent.elementLabel,
  successCount: 4,
  healthScore: 100,
  trustState: 'trusted',
};

projectActionMemory.resolveActionMemory({
  memories: [memoryRow],
  snapshotText: '- button "Search submit button" [ref=e-submit-now]\n- textbox "Search Product" [ref=e-search] [placeholder="Search Product"]',
  pageUrl: 'https://automationexercise.com/products',
  currentArgs: { element: 'Search submit button' },
  toolName: 'browser_click',
  declaredStep: { action: 'click', element: 'Search submit button' },
  testCaseId: 'case-products',
}).then((resolved) => {
  assert(resolved.status === 'drift_repaired' && resolved.ref === 'e-submit-now', 'DOM Atlas-backed memory can repair a drifted remembered locator to the current ref');

  if (process.exitCode) process.exit(process.exitCode);
  console.log('verify_dom_atlas: all checks passed');
});
