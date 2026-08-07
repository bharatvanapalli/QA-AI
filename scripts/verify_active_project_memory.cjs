#!/usr/bin/env node
'use strict';

const path = require('path');
const root = path.resolve(__dirname, '..');
const memory = require(path.join(root, 'server/services/projectActionMemory'));

let failures = 0;
function assert(condition, message) {
  if (!condition) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`OK: ${message}`);
  }
}

function sampleActionLocator(expression, targetFacts = {}, context = {}) {
  return {
    kind: 'playwright',
    expression,
    frameworkExpressions: { playwright: expression, selenium: 'By.cssSelector("input[placeholder=\\"Search Product\\"]")' },
    strategy: 'placeholder',
    targetFacts,
    context,
    proof: { count: 1, sameElement: true, visible: true, enabled: true },
  };
}

const searchFacts = {
  tag: 'input',
  role: 'textbox',
  placeholder: 'Search Product',
  nameAttr: 'search',
};
const searchContext = {
  formSelector: 'form[action="/products"]',
  formAction: '/products',
  nearbyText: ['All Products', 'Search Product'],
};
const searchLocator = sampleActionLocator('getByPlaceholder("Search Product")', searchFacts, searchContext);

const baseHash = memory.buildStepIntentHash({
  toolName: 'browser_fill',
  args: { element: 'Search Product textbox', text: 'Printed', ref: 'old-ref' },
  actionLocator: searchLocator,
  pageUrl: 'https://automationexercise.com/products?cache=1',
  declaredStep: { action: 'fill', element: 'Search Product textbox', value: 'Printed' },
});
const reorderedHash = memory.buildStepIntentHash({
  toolName: 'browser_fill',
  args: { element: 'Search Product textbox', text: 'Blue Top', ref: 'new-ref' },
  actionLocator: searchLocator,
  pageUrl: 'https://automationexercise.com/products#top',
  declaredStep: { action: 'fill', element: 'Search Product textbox', value: 'Blue Top' },
});

assert(baseHash.version === 'qaai-step-intent-v1', 'step intent hashing is explicitly versioned');
assert(baseHash.hash === reorderedHash.hash, 'same semantic action keeps the same hash despite reordered/raw value changes');
assert(!baseHash.canonical.includes('Printed') && !reorderedHash.canonical.includes('Blue Top'), 'raw fill values are excluded from intent hash parts');
assert(!baseHash.canonical.includes('old-ref') && !reorderedHash.canonical.includes('new-ref'), 'runtime refs are excluded from intent hash parts');
assert(baseHash.parts.context.formSelector === 'form[action="/products"]', 'search input hash includes stable form context');
assert(baseHash.routeKey === '/products', 'route key ignores query and hash fragments');

const iconButtonHash = memory.buildStepIntentHash({
  toolName: 'browser_click',
  args: { element: 'Search submit button' },
  actionLocator: sampleActionLocator('locator("form[action=\\"/products\\"] button[type=\\"submit\\"]")', {
    tag: 'button',
    role: 'button',
    type: 'submit',
  }, searchContext),
  pageUrl: 'https://automationexercise.com/products',
  declaredStep: { action: 'click', element: 'Search submit button' },
});
assert(iconButtonHash.parts.context.formSelector === 'form[action="/products"]', 'icon-only submit button intent is anchored to its form');
assert(iconButtonHash.parts.semantic.type === 'submit', 'icon-only submit button intent keeps button type');

const womenHash = memory.buildStepIntentHash({
  toolName: 'browser_click',
  args: { element: 'Women link' },
  actionLocator: sampleActionLocator('getByRole("link", { name: "Women" })', { role: 'link', accessibleName: 'Women' }),
  pageUrl: 'https://automationexercise.com/products',
  declaredStep: { action: 'click', element: 'Women link' },
});
const menHash = memory.buildStepIntentHash({
  toolName: 'browser_click',
  args: { element: 'Men link' },
  actionLocator: sampleActionLocator('getByRole("link", { name: "Men" })', { role: 'link', accessibleName: 'Men' }),
  pageUrl: 'https://automationexercise.com/products',
  declaredStep: { action: 'click', element: 'Men link' },
});
assert(womenHash.hash !== menHash.hash, 'different targets with same action type do not collide');

const snapshot = [
  '- textbox "Search Product" [ref=e-search-new] [placeholder="Search Product"]',
  '- button "Search" [ref=e-submit-new]',
  '- link "Women" [ref=e-women]',
].join('\n');

const memoryRow = {
  id: 'mem-search',
  projectId: 'project-1',
  testCaseId: 'case-1',
  routeKey: '/products',
  actionType: 'fill',
  stepIntentHash: baseHash.hash,
  stepIntentPartsJson: JSON.stringify(baseHash.parts),
  frameworkExpressionsJson: JSON.stringify({ playwright: 'getByPlaceholder("Search Product")' }),
  selectorExpression: 'getByPlaceholder("Search Product")',
  actionLocatorJson: JSON.stringify(searchLocator),
  targetFactsJson: JSON.stringify(searchFacts),
  contextJson: JSON.stringify(searchContext),
  elementKey: baseHash.elementKey,
  elementLabel: 'Search Product',
  successCount: 4,
  healthScore: 100,
  trustState: 'trusted',
};

(async () => {
  const reused = await memory.resolveActionMemory({
    memories: [memoryRow],
    snapshotText: snapshot,
    pageUrl: 'https://automationexercise.com/products',
    currentArgs: { element: 'Search Product textbox', text: 'Printed' },
    toolName: 'browser_fill',
    declaredStep: { action: 'fill', element: 'Search Product textbox' },
    testCaseId: 'case-1',
  });
  assert(reused.status === 'reused' && reused.ref === 'e-search-new', 'trusted memory resolves to the current snapshot ref');

  const driftedRow = { ...memoryRow, stepIntentHash: 'old-hash', successCount: 7 };
  const drifted = await memory.resolveActionMemory({
    memories: [driftedRow],
    snapshotText: snapshot,
    pageUrl: 'https://automationexercise.com/products',
    currentArgs: { element: 'Search Product textbox', text: 'Printed' },
    toolName: 'browser_fill',
    declaredStep: { action: 'fill', element: 'Search Product textbox' },
    testCaseId: 'case-1',
  });
  assert(drifted.status === 'drift_repaired' && drifted.ref === 'e-search-new', 'drifted memory can be repaired through current DOM facts');

  const quarantined = await memory.resolveActionMemory({
    memories: [{ ...memoryRow, trustState: 'quarantined', healthScore: 0 }],
    snapshotText: snapshot,
    pageUrl: 'https://automationexercise.com/products',
    currentArgs: { element: 'Search Product textbox' },
    toolName: 'browser_fill',
    declaredStep: { action: 'fill', element: 'Search Product textbox' },
    testCaseId: 'case-1',
  });
  assert(quarantined.status === 'not_found', 'quarantined memory is skipped');

  const otherCase = await memory.resolveActionMemory({
    memories: [{ ...memoryRow, testCaseId: 'case-2' }],
    snapshotText: snapshot,
    pageUrl: 'https://automationexercise.com/products',
    currentArgs: { element: 'Search Product textbox' },
    toolName: 'browser_fill',
    declaredStep: { action: 'fill', element: 'Search Product textbox' },
    testCaseId: 'case-1',
  });
  assert(otherCase.status === 'not_found', 'memory from a different case is not reused automatically');

  if (failures) {
    console.error(`verify_active_project_memory: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('verify_active_project_memory: all checks passed');
})();
