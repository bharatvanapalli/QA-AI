'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const adapter = require(path.join(ROOT, 'server', 'services', 'codegen', 'adapters', 'playwrightPom'));

function verifiedActionLocator(expression, strategy, facts = {}) {
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    diagnosticOnly: false,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy,
    pageUrl: 'https://automationexercise.com/products',
    targetFacts: facts,
    context: {},
    proof: { count: 1, sameElement: true, visible: true, enabled: true, source: 'verified_dom_inspection', verified: true },
  };
}

function resolveStep(as, candidate, actionLocator) {
  return {
    op: 'resolve',
    as,
    pageUrl: 'https://automationexercise.com/products',
    candidates: [candidate],
    actionLocator,
  };
}

function productCase(caseName, steps, dataRows = null) {
  return {
    caseName,
    scenarioName: 'AutomationExercise Product Suite',
    ir: {
      title: caseName,
      steps: [
        { op: 'act', action: 'navigate', url: 'https://automationexercise.com/products' },
        ...steps,
      ],
      ...(dataRows ? { dataRows } : {}),
    },
  };
}

const cases = [
  productCase('Search Printed returns matching products', [
    resolveStep('searchBox', { strategy: 'placeholder', text: 'Search Product' }, verifiedActionLocator('getByPlaceholder("Search Product")', 'placeholder', { tag: 'input', role: 'textbox', placeholder: 'Search Product' })),
    { op: 'act', action: 'fill', target: 'searchBox', rawValue: 'Printed', dataRole: 'searchName' },
    resolveStep('searchSubmit', { strategy: 'role', role: 'button', name: 'Search' }, verifiedActionLocator('locator("#submit_search")', 'css', { tag: 'button', role: 'button' })),
    { op: 'act', action: 'click', target: 'searchSubmit' },
  ], [{ index: 0, label: 'TC-FILTER-01', fields: { searchName: 'Printed' } }]),
  productCase('Brand filter shows only Polo products', [
    resolveStep('polo', { strategy: 'role', role: 'link', name: '6 Polo' }, verifiedActionLocator('getByRole("link", { name: /polo/i })', 'role', { tag: 'a', role: 'link', accessibleName: '6 Polo' })),
    { op: 'act', action: 'click', target: 'polo' },
  ]),
  productCase('Selecting Women > Dress category shows only dress products', [
    resolveStep('women', { strategy: 'role', role: 'link', name: 'Women' }, verifiedActionLocator('getByRole("link", { name: /women/i })', 'role', { tag: 'a', role: 'link', accessibleName: 'Women' })),
    { op: 'act', action: 'click', target: 'women' },
    resolveStep('dress', { strategy: 'role', role: 'link', name: 'Dress' }, verifiedActionLocator('getByRole("link", { name: /dress/i })', 'role', { tag: 'a', role: 'link', accessibleName: 'Dress' })),
    { op: 'act', action: 'click', target: 'dress' },
  ]),
];

const result = adapter.emitJourneySpec(cases, {
  scenarioName: 'AutomationExercise Product Suite',
  scenarioId: 'automationexercise-products',
  specDir: 'tests/products',
  lang: 'js',
  moduleFormat: 'esm',
});

const spec = result.content;
const page = result.extraFiles['pages/ProductsPage.js'] || '';
const report = JSON.parse(result.extraFiles['evidence/pom-architect-report.json'] || '{}');

assert.ok(spec.includes('productsPage.searchForProduct(readData(row, "searchName"))'), spec);
assert.ok(spec.includes('productsPage.selectBrand("Polo")'), spec);
assert.ok(spec.includes('productsPage.selectCategory("Women", "Dress")'), spec);
assert.ok(!spec.includes('productsPage.fillSearchProduct('), spec);
assert.ok(!spec.includes('productsPage.clickSearch('), spec);
assert.ok(page.includes('async searchForProduct(productName)'), page);
assert.ok(page.includes('async selectBrand(brandName)'), page);
assert.ok(page.includes('async selectCategory(category, subCategory)'), page);
assert.ok(/this\._searchProduct(?:Input|Element) = productsPageLocators\.searchProduct(?:Input|Element)\(page\);/.test(page), page);
assert.ok(page.includes('const brandLocators = {'), page);
assert.ok(page.includes('"polo": () => this["6PoloLink"]()') || page.includes('"polo": () => this.poloLink()'), page);
assert.ok(report.pages && report.pages.productsPage, JSON.stringify(report, null, 2));
assert.ok((report.pages.productsPage.architectMethods || []).some((m) => m.name === 'searchForProduct'), JSON.stringify(report, null, 2));
assert.ok((report.pages.productsPage.architectMethods || []).some((m) => m.name === 'selectBrand'), JSON.stringify(report, null, 2));
assert.ok((report.pages.productsPage.architectMethods || []).some((m) => m.name === 'selectCategory'), JSON.stringify(report, null, 2));

const mergedFiles = adapter._emitPomGraphFiles(adapter._mergePomGraphs([result.pomGraph], { lang: 'js', moduleFormat: 'esm' }));
assert.ok((mergedFiles['evidence/pom-architect-report.json'] || '').includes('selectCategory'), mergedFiles['evidence/pom-architect-report.json']);

console.log('verify_pom_architect: all checks passed');
