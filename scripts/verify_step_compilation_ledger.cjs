#!/usr/bin/env node
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..');
const resolver = require(path.join(root, 'server/services/actionLocatorResolver'));
const replayEmitter = require(path.join(root, 'server/services/codegen/replayEmitter'));
const ledger = require(path.join(root, 'server/services/codegen/stepCompilationLedger'));

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
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
    counts: { elements: 10, controls: 2, forms: 1, tables: 0, dialogs: 0, frames: 0, shadowHosts: 0 },
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
      frameworkExpressions: {
        playwright: 'locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")',
        selenium: 'By.cssSelector("form[action=\\"/products\\"] button[type=\\"submit\\"]")',
      },
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

const emit = replayEmitter.buildReplayIR({
  caseId: 'tc-search',
  title: 'Search product',
  trail: [
    {
      tool: 'browser_click',
      ok: true,
      args: { element: 'Search submit button', ref: 'e7' },
      pageUrl: 'https://automationexercise.com/products',
      actionLocator,
    },
    {
      tool: 'browser_click',
      ok: true,
      args: { element: 'Search submit button', ref: 'e7' },
      pageUrl: 'https://automationexercise.com/products',
      actionLocator,
    },
    {
      tool: 'browser_double_click',
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

const clickActs = emit.ir.steps.filter((step) => step.op === 'act' && step.action === 'click');
const doubleClickActs = emit.ir.steps.filter((step) => step.op === 'act' && step.action === 'doubleClick');
assert(emit.complete === true, 'ReplayIR remains complete with verified action locators');
assert(clickActs.length === 2, 'repeated recorded clicks are preserved one-for-one in ReplayIR');
assert(doubleClickActs.length === 1, 'intentional double-click action is preserved');
assert((emit.findings || []).some((f) => f.code === 'duplicate_action_preserved'), 'repeated click is recorded as preserved-action evidence');

const files = {
  'tests/products/search.spec.js': [
    "await page.goto('/products');",
    'await productsPage.clickSearch();',
    'await productsPage.clickSearch();',
    'await productsPage.doubleClickSearch();',
  ].join('\n'),
  'evidence/locator-manifest.json': JSON.stringify([
    { as: 'el1', file: 'productsPage', name: 'searchButton', source: 'actionLocator' },
    { as: 'el2', file: 'productsPage', name: 'searchButton', source: 'actionLocator' },
    { as: 'el3', file: 'productsPage', name: 'searchButton', source: 'actionLocator' },
  ], null, 2),
};

const report = ledger.buildStepCompilationLedger({
  adapterId: 'playwright-pom-js',
  files,
  admitted: [{ testCaseId: 'tc-search', testCaseIds: ['tc-search'], filePath: 'tests/products/search.spec.js' }],
  blocked: [],
  results: [{
    testCaseId: 'tc-search',
    runResultId: 'rr-search',
    caseName: 'Search product',
    scenarioId: 'sc-products',
    scenarioName: 'Products',
    declaredSteps: ['Open products page', 'Click Search', 'Double-click Search when the planned step requires multi-click'],
    envelope: { ir: emit.ir, findings: emit.findings || [] },
  }],
});

const rows = report.cases[0].ledger;
assert(report.summary.totalPlannedSteps === 3, 'ledger counts architect planned steps');
assert(report.summary.duplicateActionsPruned === 0, 'ledger confirms no repeated action was pruned from ReplayIR');
assert(rows.some((row) => row.exportedPageMethod === 'clickSearch' && row.exportStatus === 'exported'), 'ledger links click step to generated page method');
assert(rows.some((row) => row.exportedPageMethod === 'doubleClickSearch' && row.exportStatus === 'exported'), 'ledger links intentional double-click to generated page method');
assert(report.summary.blockedInternal === 0, 'fully linked package has no internal parity gaps');

if (failures) {
  console.error(`\nverify_step_compilation_ledger failed: ${failures} issue(s)`);
  process.exit(1);
}
console.log('\nverify_step_compilation_ledger passed');
