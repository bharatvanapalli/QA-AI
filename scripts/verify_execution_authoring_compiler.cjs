#!/usr/bin/env node
'use strict';

const assert = require('assert');
const compiler = require('../server/services/executionAuthoringCompiler');

function locator(expression = 'getByPlaceholder("Search Product")') {
  return {
    kind: 'playwright',
    expression,
    frameworkExpressions: {
      playwright: expression,
      selenium: 'By.cssSelector("input[placeholder=\\"Search Product\\"]")',
    },
    strategy: 'placeholder',
    verified: true,
    verificationSource: 'verified_dom_inspection',
    pageUrl: 'https://example.test/products',
    elementLabel: 'Search Product',
    targetFacts: {
      tag: 'input',
      role: 'textbox',
      accessibleName: 'Search Product',
      placeholder: 'Search Product',
      nameAttr: 'search',
    },
    context: {
      formSelector: 'form[action="/products"]',
      nearbyText: ['All Products', 'Search Product'],
    },
    proof: {
      verified: true,
      source: 'verified_dom_inspection',
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
    },
    domAtlas: {
      url: 'https://example.test/products',
      verifiedActions: [{ expression, strategy: 'placeholder' }],
    },
    candidates: [{ expression, strategy: 'placeholder', count: 1, sameElement: true }],
  };
}

const cleanRecipe = compiler.buildLocatorRecipe(locator());
assert(cleanRecipe, 'expected a locator recipe');
assert.equal(cleanRecipe.exportSafe, true, 'clean placeholder locator should be export-safe');
assert.equal(cleanRecipe.proof.sameElement, true, 'same-element proof should be preserved');

const glyphRecipe = compiler.buildLocatorRecipe(locator('getByRole("button", { name: "" })'));
assert(glyphRecipe, 'glyph locator still produces diagnostic recipe');
assert.equal(glyphRecipe.exportSafe, false, 'glyph locator must not be export-safe');

const hashA = compiler.buildStepIntentHash({
  toolName: 'browser_type',
  args: { text: 'Printed', element: 'Search Product textbox' },
  actionLocator: locator(),
  pageUrl: 'https://example.test/products',
  declaredStep: { id: 'step-1', action: 'Fill', element: 'Search Product textbox' },
});
const hashB = compiler.buildStepIntentHash({
  toolName: 'browser_type',
  args: { text: 'Different value', element: 'Search Product textbox' },
  actionLocator: locator(),
  pageUrl: 'https://example.test/products',
  declaredStep: { id: 'step-9', action: 'Fill', element: 'Search Product textbox' },
});
assert.equal(hashA.stepIntentHash, hashB.stepIntentHash, 'intent hash must ignore ordinal and volatile fill value');

const draft = compiler.createDraft({
  testCaseId: 'TC-1',
  plannedStepId: 'step-1',
  stepOrdinal: 7,
  businessIntent: 'Enter product search keyword',
  toolName: 'browser_type',
  args: { text: 'Printed', element: 'Search Product textbox' },
  pageUrl: 'https://example.test/products',
  declaredStep: { action: 'Fill', element: 'Search Product textbox' },
  actionLocator: locator(),
});
const record = compiler.commitAction({
  draft,
  actionLocator: locator(),
  result: { isError: false },
  beforeSnapshot: 'textbox "Search Product"',
  afterSnapshot: 'textbox "Search Product"\ntext "Printed"',
  beforeUrl: 'https://example.test/products',
  afterUrl: 'https://example.test/products',
  actualToolCalls: [{ toolName: 'browser_type', args: { text: 'Printed' }, ok: true }],
});
assert.equal(record.status, 'captured', 'successful verified action should commit as captured');
assert(record.locatorRecipe && record.locatorRecipe.id, 'record must keep locator recipe');
assert(record.transitionProof && record.transitionProof.snapshotChanged === true, 'record must keep transition proof');

const report = compiler.compileTrailAuthoringReport({
  trail: [
    { tool: 'browser_type', ok: true, stepAuthoring: record },
    { tool: 'browser_click', ok: true, args: { element: 'Search' } },
  ],
  plannedSteps: [{}, {}],
});
assert.equal(report.records.length, 1, 'report should include committed records');
assert.equal(report.gaps.length, 1, 'report should expose uncommitted mutating actions');

console.log('verify_execution_authoring_compiler: ok');
