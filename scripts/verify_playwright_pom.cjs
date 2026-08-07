'use strict';
/**
 * Guard: Class G Phase 2 — playwright-pom adapter invariants.
 *
 * 1. emitJourneySpec returns { content, extraFiles } (not a plain string)
 * 2. extraFiles contains locators/<page>.locators.ts and pages/<Page>.ts
 * 3. Locator file contains the EXACT action-time expression from buildLocatorRepository (guardrail 1)
 * 4. Spec file has ZERO inline page.getByRole / page.locator / page.getBy* calls in the test body
 * 5. Page file imports from ../locators/<page>.locators
 * 6. Page file has the action method derived from methodNameFor (e.g. fillUsername)
 * 7. Conflict detection: same semantic name + different expression → not silently merged
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { emitJourneySpec, _buildAsMap, _methodNameFor, _pageClassName, _emitLocatorFile, _emitLocatorFileGenerated, _emitLocatorShim, _detectQualityIssues, _emitPageFile, _mergePomGraphs, _emitPomGraphFiles } = require(path.join(ROOT, 'server', 'services', 'codegen', 'adapters', 'playwrightPom'));
const { buildLocatorRepository } = require(path.join(ROOT, 'server', 'services', 'codegen', 'pageObjectRepository'));
const { buildOrChain } = require(path.join(ROOT, 'server', 'services', 'codegen', 'adapters', 'resiliencyRules'));

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } else { console.log('  ok:', msg); } };

function routeKeyFromUrl(url) {
  try { return new URL(String(url || '')).pathname || '/'; } catch (_) { return '/'; }
}

function verifiedActionLocator({ expression, strategy = 'role', facts = {}, pageUrl = 'https://example.com/products', selenium = null, toolName = 'browser_click' }) {
  const proof = {
    count: 1,
    sameElement: true,
    visible: true,
    enabled: true,
    source: 'verified_dom_inspection',
    verified: true,
  };
  const frameworkExpressions = {
    playwright: expression,
    ...(selenium ? { selenium } : {}),
  };
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    diagnosticOnly: false,
    expression,
    frameworkExpressions,
    strategy,
    pageUrl,
    targetFacts: facts,
    context: {},
    proof,
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: pageUrl,
      routeKey: routeKeyFromUrl(pageUrl),
      title: null,
      counts: { controls: 1 },
      controls: [{ expression, strategy, facts }],
      forms: [],
      tables: [],
      dialogs: [],
      landmarks: [],
      frames: [],
      shadowHosts: [],
      headings: [],
      verifiedActions: [{
        toolName,
        elementLabel: facts.accessibleName || facts.placeholder || expression,
        strategy,
        expression,
        frameworkExpressions,
        targetFacts: facts,
        context: {},
        proof,
      }],
    },
  };
}

// ── Fixture IR ───────────────────────────────────────────────────────────────
// A minimal journey: one navigate + one fill + one click + one assert
const LOGIN_IR = {
  title: 'Admin login',
  steps: [
    { op: 'act', action: 'navigate', url: 'https://example.com/auth/login' },
    { op: 'resolve', as: 'el1', candidates: [{ strategy: 'role', role: 'textbox', name: 'Username' }] },
    { op: 'resolve', as: 'el2', candidates: [{ strategy: 'role', role: 'textbox', name: 'Password' }] },
    { op: 'resolve', as: 'el3', candidates: [{ strategy: 'role', role: 'button', name: 'Login' }] },
    { op: 'act', action: 'fill', target: 'el1', valueRef: 'env:QAAI_USERNAME' },
    { op: 'act', action: 'fill', target: 'el2', valueRef: 'env:QAAI_PASSWORD' },
    { op: 'act', action: 'click', target: 'el3' },
    { op: 'resolve', as: 'el4', candidates: [{ strategy: 'role', role: 'link', name: 'Dashboard' }] },
    { op: 'assert', channel: 'UI_ROLE', target: 'el4', contractRef: 'ASN-1', expected: '' },
  ],
};

const CASES = [{ ir: LOGIN_IR, caseName: 'Admin login' }];

// ── 1. Return type ───────────────────────────────────────────────────────────
{
  const result = emitJourneySpec(CASES, { scenarioName: 'Authentication', scenarioId: 'scn-test' });
  ok(typeof result === 'object' && result !== null, 'emitJourneySpec returns object');
  ok(typeof result.content === 'string', 'result.content is a string');
  ok(typeof result.extraFiles === 'object' && result.extraFiles !== null, 'result.extraFiles is an object');
  ok(result.pomGraph && typeof result.pomGraph === 'object', 'result.pomGraph is emitted for merge-safe package assembly');

  // ── 2. extraFiles has locators/generated/ + shim + pages ──────────────────
  const keys = Object.keys(result.extraFiles);
  const hasGenerated = keys.some((k) => k.startsWith('locators/generated/') && k.endsWith('.locators.ts'));
  const hasShim = keys.some((k) => /^locators\/[^/]+\.locators\.ts$/.test(k)); // shim at locators/ (not generated/)
  const hasPage = keys.some((k) => k.startsWith('pages/') && k.endsWith('.ts'));
  ok(hasGenerated, `extraFiles has locators/generated/*.locators.ts: ${keys.join(', ')}`);
  ok(hasShim, `extraFiles has shim at locators/*.locators.ts: ${keys.join(', ')}`);
  ok(hasPage, `extraFiles has a pages/*.ts file: ${keys.join(', ')}`);

  // ── 3. Generated locator file has semantic OR-chain for each known element ──
  // emitLocatorEntry prefers buildOrChain(entry.candidates) over the raw selectStaticLocator expr —
  // so the file contains regex-based expressions (/username/i not "Username"). Derive the same form.
  const locatorKey = keys.find((k) => k.startsWith('locators/generated/'));
  const locatorContent = result.extraFiles[locatorKey] || '';
  const repo = buildLocatorRepository({ cases: CASES, pageRoleFor: null });
  for (const [fileName, entries] of Object.entries(repo.files)) {
    for (const [name, entry] of Object.entries(entries)) {
      // Mirror what emitLocatorEntry does: prefer buildOrChain(candidates), fall back to expr
      const chain = entry.candidates && buildOrChain(entry.candidates);
      const expected = chain || String(entry.expr || '');
      ok(locatorContent.includes(expected), `locator file contains semantic locator for ${name}: ${expected}`);
    }
  }

  // ── 4. Spec has zero inline getBy* calls in the test body ─────────────────
  const specContent = result.content;
  // strip import lines (they mention page object class names, not inline locators)
  const testBody = specContent.replace(/^import .+\n/gm, '');
  const inlineLocatorRe = /\bpage\.(getByRole|getByLabel|getByPlaceholder|getByText|getByTestId|locator)\s*\(/;
  ok(!inlineLocatorRe.test(testBody), 'spec body has no inline page.getBy*/page.locator calls');

  // ── 5. Spec imports page classes ──────────────────────────────────────────
  ok(specContent.includes(`from '../../pages/`), `spec imports from ../../pages/`);

  // ── 6. Page file imports from locators + has action methods ───────────────
  const pageKey2 = keys.find((k) => k.startsWith('pages/'));
  const pageContent = result.extraFiles[pageKey2] || '';
  ok(pageContent.includes(`from '../locators/`), `page file imports from ../locators/`);
  ok(pageContent.includes('safeClick') && pageContent.includes(`from '../tests/support/replayir`), 'page file imports safeClick for click actions');
  ok(pageContent.includes('fillUsername'), `page file has fillUsername method`);
  ok(pageContent.includes('fillPassword'), `page file has fillPassword method`);
  ok(pageContent.includes('clickLogin'), `page file has clickLogin method`);
  ok(/async clickLogin\(\)[\s\S]+safeClick\(this\.page/.test(pageContent), 'click page method uses safeClick retry/overlay protection');

  // ── 7. Spec uses page methods not inline locators ─────────────────────────
  ok(specContent.includes('fillUsername'), `spec calls loginPage.fillUsername`);
  ok(specContent.includes('fillPassword'), `spec calls loginPage.fillPassword`);
  ok(specContent.includes('clickLogin'), `spec calls loginPage.clickLogin`);
  ok(/test\(["']Admin login["']/.test(specContent) && !specContent.includes('test.step('), 'spec preserves the QAAI case as a top-level Playwright test');

  console.log('\n--- spec preview (first 25 lines) ---');
  specContent.split('\n').slice(0, 25).forEach((l) => console.log('  ' + l));
  console.log('  ...\n--- locator file ---');
  locatorContent.split('\n').slice(0, 12).forEach((l) => console.log('  ' + l));
  console.log('  ...\n--- page file (first 20 lines) ---');
  pageContent.split('\n').slice(0, 20).forEach((l) => console.log('  ' + l));
}

{
  const searchInput = {
    title: 'Search input',
    steps: [
      { op: 'act', action: 'navigate', url: 'https://automationexercise.com/products' },
      { op: 'resolve', as: 'searchBox', pageUrl: 'https://automationexercise.com/products', candidates: [{ strategy: 'placeholder', text: 'Search Product' }] },
      { op: 'act', action: 'fill', target: 'searchBox', rawValue: 'Printed' },
    ],
  };
  const searchSubmit = {
    title: 'Search submit',
    steps: [
      { op: 'act', action: 'navigate', url: 'https://automationexercise.com/products' },
      { op: 'resolve', as: 'searchButton', pageUrl: 'https://automationexercise.com/products', candidates: [{ strategy: 'role', role: 'button', name: 'Search' }] },
      { op: 'act', action: 'click', target: 'searchButton' },
    ],
  };
  const a = emitJourneySpec([{ ir: searchInput, caseName: 'Search input' }], { scenarioName: 'A', lang: 'js', moduleFormat: 'esm' });
  const b = emitJourneySpec([{ ir: searchSubmit, caseName: 'B' }], { scenarioName: 'B', lang: 'js', moduleFormat: 'esm' });
  const files = _emitPomGraphFiles(_mergePomGraphs([a.pomGraph, b.pomGraph], { lang: 'js', moduleFormat: 'esm' }));
  const page = files['pages/ProductsPage.js'] || '';
  ok(page.includes('async fillSearchProduct('), 'merged graph page file keeps fillSearchProduct from first journey');
  ok(page.includes('async clickSearch('), 'merged graph page file keeps clickSearch from second journey');
}

// ── 8. methodNameFor contract ────────────────────────────────────────────────
{
  ok(_methodNameFor('fill', 'usernameInput') === 'fillUsername', 'fill+usernameInput → fillUsername');
  ok(_methodNameFor('click', 'loginButton') === 'clickLogin', 'click+loginButton → clickLogin');
  ok(_methodNameFor('fill', 'passwordInput') === 'fillPassword', 'fill+passwordInput → fillPassword');
  ok(_methodNameFor('select', 'roleSelect') === 'selectRole', 'select+roleSelect → selectRole');
  ok(_methodNameFor('check', 'rememberMeCheckbox') === 'checkRememberMe', 'check+rememberMeCheckbox → checkRememberMe');
}

// ── 9. pageClassName contract ─────────────────────────────────────────────────
{
  ok(_pageClassName('loginPage') === 'LoginPage', 'loginPage → LoginPage');
  ok(_pageClassName('dashboardPage') === 'DashboardPage', 'dashboardPage → DashboardPage');
}

// ── 10. Fallback for weak/no-mapping resolve step ────────────────────────────
{
  const weakIr = {
    title: 'Weak locator case',
    steps: [
      { op: 'act', action: 'navigate', url: 'https://example.com/page' },
      // No candidates → weak locator, should not appear in POM map but should
      // fall back to inline in the spec
      { op: 'resolve', as: 'elWeak', candidates: [] },
      { op: 'act', action: 'click', target: 'elWeak' },
    ],
  };
  const weakResult = emitJourneySpec([{ ir: weakIr, caseName: 'Weak' }], { scenarioName: 'Weak' });
  // Spec should still be a string (content), not crash
  ok(typeof weakResult.content === 'string' && weakResult.content.length > 0, 'weak-locator case emits without crash');
}

// ── 11. Conflict does NOT silently merge ──────────────────────────────────────
{
  const conflictIr = {
    title: 'Conflict test',
    steps: [
      { op: 'act', action: 'navigate', url: 'https://example.com/auth/login' },
      { op: 'resolve', as: 'el1', candidates: [{ strategy: 'role', role: 'button', name: 'Save' }] },
      { op: 'resolve', as: 'el2', candidates: [{ strategy: 'role', role: 'button', name: 'save' }] },
    ],
  };
  const repo2 = buildLocatorRepository({ cases: [{ ir: conflictIr }], pageRoleFor: null });
  ok(repo2.conflicts.length > 0, 'conflicting names produce repo.conflicts (guardrail 2)');
}

// ── Phase 3: G.2 / G.7 / G.8 ────────────────────────────────────────────────

// ── 12. G.2 — shim re-exports from generated/ ────────────────────────────────
{
  const result = emitJourneySpec(CASES, { scenarioName: 'P3 Test' });
  const keys = Object.keys(result.extraFiles);
  const shimKey = keys.find((k) => /^locators\/[^/]+\.locators\.ts$/.test(k));
  const shimContent = result.extraFiles[shimKey] || '';
  ok(shimContent.includes("export * from './generated/"), 'shim re-exports from ./generated/');
  ok(!shimContent.includes('export const '), 'shim has no inline locator definitions (re-export only)');

  const genKey = keys.find((k) => k.startsWith('locators/generated/'));
  const genContent = result.extraFiles[genKey] || '';
  ok(genContent.includes('export const '), 'generated file has inline locator definitions');
  ok(genContent.includes('GENERATED'), 'generated file has GENERATED header marker');
}

// ── 13. G.8 — evidence/locator-manifest.json always present ──────────────────
{
  const result = emitJourneySpec(CASES, { scenarioName: 'P3 Manifest' });
  ok('evidence/locator-manifest.json' in result.extraFiles, 'evidence/locator-manifest.json always emitted');
  const manifest = JSON.parse(result.extraFiles['evidence/locator-manifest.json']);
  ok(Array.isArray(manifest), 'locator-manifest.json is a JSON array');
  ok(manifest.length > 0, `locator-manifest.json has entries (got ${manifest.length})`);
  const firstEntry = manifest.find((e) => e.file);
  ok(firstEntry && firstEntry.as && firstEntry.name && firstEntry.expr, 'manifest entries have as/name/expr');
}

// ── 14. G.8 — evidence/certification-report.json present + correct schema ────
{
  const result = emitJourneySpec(CASES, { scenarioName: 'P3 CertReport' });
  ok('evidence/certification-report.json' in result.extraFiles, 'evidence/certification-report.json emitted');
  const report = JSON.parse(result.extraFiles['evidence/certification-report.json']);
  ok(typeof report.fidelityPlan === 'string', 'cert report has fidelityPlan field');
  ok(report.spec && typeof report.spec.status === 'string', 'cert report has spec.status');
  ok(Array.isArray(report.spec.qualityIssues), 'cert report has spec.qualityIssues array');
  ok(typeof report.evidence === 'object', 'cert report has evidence section');
  ok(report.evidence['locator-manifest.json'] && report.evidence['locator-manifest.json'].status === 'present', 'cert report marks manifest as present');
  ok(typeof report.locators === 'object', 'cert report has locators section');
}

// ── 15. G.7 — quality gate: el-variable in spec → Draft downgrade ─────────────
{
  const elIr = {
    title: 'El-var case',
    steps: [
      { op: 'act', action: 'navigate', url: 'https://example.com/page' },
      // Weak candidate → falls back to inline el1 variable
      { op: 'resolve', as: 'el1', candidates: [] },
      { op: 'act', action: 'click', target: 'el1' },
    ],
  };
  const result = emitJourneySpec([{ ir: elIr, caseName: 'El-var' }], { scenarioName: 'El-var' });
  // el1. access in the spec body triggers el-variables flag
  const hasDraft = result.content.startsWith('// STATUS: DRAFT');
  const report = JSON.parse(result.extraFiles['evidence/certification-report.json']);
  ok(report.spec.status === 'draft' || !hasDraft, 'cert report status matches spec draft state');
  // Note: el1 without a dot (el1 itself, not el1.xxx) might not trigger depending on click fallback;
  // we just verify the quality gate runs and produces valid output.
  ok(typeof result.content === 'string', 'el-var case: spec content is a string');
}

// ── 16. G.7 — clean spec produces no Draft header ────────────────────────────
{
  const result = emitJourneySpec(CASES, { scenarioName: 'Clean Login' });
  ok(!result.content.startsWith('// STATUS: DRAFT'), 'clean POM spec has no DRAFT header');
  const report = JSON.parse(result.extraFiles['evidence/certification-report.json']);
  ok(report.spec.status === 'runnable', 'cert report marks clean spec as runnable');
  ok(report.spec.qualityIssues.length === 0, 'cert report has zero quality issues for clean spec');
}

// ── 17. _detectQualityIssues unit ────────────────────────────────────────────
{
  ok(typeof _detectQualityIssues === 'function', '_detectQualityIssues exported');
  const clean = `test('Login scenario', async ({ page }) => { await loginPage.fillUsername(readEnv('QAAI_USERNAME')); });`;
  ok(_detectQualityIssues(clean).length === 0, 'detectQualityIssues: clean POM spec has no issues');

  const withEl = `test('scenario', async ({ page }) => { const el1 = page.locator('x'); await el1.click(); });`;
  const elIssues = _detectQualityIssues(withEl);
  ok(elIssues.some((i) => i.code === 'el-variables'), 'detectQualityIssues: el1. triggers el-variables');

  const withAnnotation = `test('s', async ({ page }) => { test.info().annotations.push({ type: 'x' }); });`;
  const annIssues = _detectQualityIssues(withAnnotation);
  ok(annIssues.some((i) => i.code === 'telemetry-annotations'), 'detectQualityIssues: annotations.push triggers telemetry-annotations');

  const withFullJourney = `test('full journey', async ({ page }) => { await page.goto('/'); });`;
  const fjIssues = _detectQualityIssues(withFullJourney);
  ok(fjIssues.some((i) => i.code === 'generic-test-name'), 'detectQualityIssues: "full journey" triggers generic-test-name');
}

// ── 18. _emitLocatorShim unit ─────────────────────────────────────────────────
{
  ok(typeof _emitLocatorShim === 'function', '_emitLocatorShim exported');
  const shim = _emitLocatorShim('loginPage');
  ok(shim.includes("export * from './generated/loginPage.generated.locators'"), 'shim points at generated file');
  ok(shim.includes('overrides/loginPage.override'), 'shim mentions override path in comment');
}

// Action-time locator expressions are authoritative. If the live resolver captured
// frame/scoped context, the repository and POM emitter must not rebuild a weaker
// candidate-only locator.
{
  const ACTION_LOCATOR_IR = {
    title: 'Framed search',
    steps: [
      { op: 'act', action: 'navigate', url: 'https://example.com/products' },
      {
        op: 'resolve',
        as: 'el1',
        candidates: [
          { strategy: 'role', role: 'button', name: 'Search' },
          { strategy: 'css', selector: 'form[action="/products"] button[type="submit"]' },
        ],
        actionLocator: verifiedActionLocator({
          expression: 'frameLocator("iframe#catalog").getByRole("button", { name: "Search" })',
          selenium: 'By.cssSelector("form[action=\\"/products\\"] button[type=\\"submit\\"]")',
          strategy: 'role',
          facts: { role: 'button', accessibleName: 'Search' },
        }),
      },
      { op: 'act', action: 'click', target: 'el1' },
    ],
  };
  const repo = buildLocatorRepository({ cases: [{ ir: ACTION_LOCATOR_IR }] });
  const manifestEntry = repo.manifest.find((m) => m.as === 'el1');
  ok(manifestEntry && manifestEntry.source === 'actionLocator', 'repository marks action-time locator source');
  ok(manifestEntry && manifestEntry.expr === 'page.frameLocator("iframe#catalog").getByRole("button", { name: "Search" })', 'repository stores exact action-time expression');
  const result = emitJourneySpec([{ ir: ACTION_LOCATOR_IR, caseName: 'Framed search' }], { scenarioName: 'Catalog', scenarioId: 'scn-frame' });
  const locatorKey = Object.keys(result.extraFiles).find((k) => k.startsWith('locators/generated/'));
  const locatorContent = result.extraFiles[locatorKey] || '';
  ok(locatorContent.includes('page.frameLocator("iframe#catalog").getByRole("button", { name: "Search" })'), 'POM locator file emits exact action-time frame locator');
  ok(!locatorContent.includes('page.getByRole("button", { name: /search/i })'), 'POM locator file does not rebuild weaker unframed OR-chain for actionLocator source');
}

// Regression for the previous AutomationExercise ProductsPage fracture:
// tests called page methods like click6Polo()/fillSearchProduct(), but the
// generated ProductsPage class and productsPage locator file did not contain
// the corresponding machinery. Every action-time target must now produce:
// spec method call -> page method -> locator accessor -> generated locator entry.
{
  const productTargets = [
    { as: 'polo', action: 'click', name: '6 Polo', role: 'link', expectedMethod: 'click6Polo', expr: 'getByRole("link", { name: "6 Polo" })' },
    { as: 'men', action: 'click', name: 'Men', role: 'button', expectedMethod: 'clickMen', expr: 'getByRole("button", { name: "Men" })' },
    { as: 'kids', action: 'click', name: 'Kids', role: 'button', expectedMethod: 'clickKids', expr: 'getByRole("button", { name: "Kids" })' },
    { as: 'dress', action: 'click', name: 'Dress', role: 'link', expectedMethod: 'clickDress', expr: 'getByRole("link", { name: "Dress" })' },
    { as: 'tshirts', action: 'click', name: 'Tshirts', role: 'link', expectedMethod: 'clickTshirts', expr: 'getByRole("link", { name: "Tshirts" })' },
    { as: 'searchInput', action: 'fill', name: 'Search Product', role: 'textbox', expectedMethod: 'fillSearchProduct', expr: 'getByPlaceholder("Search Product")', strategy: 'placeholder' },
    { as: 'searchButton', action: 'click', name: 'Search', role: 'button', expectedMethod: 'clickSearch', expr: 'getByRole("button", { name: "Search" })' },
  ];
  const steps = [
    { op: 'act', action: 'navigate', url: 'https://automationexercise.com/products' },
  ];
  for (const target of productTargets) {
    steps.push({
      op: 'resolve',
      as: target.as,
      pageUrl: 'https://automationexercise.com/products',
      candidates: target.strategy === 'placeholder'
        ? [{ strategy: 'placeholder', text: target.name }, { strategy: 'role', role: target.role, name: target.name }]
        : [{ strategy: 'role', role: target.role, name: target.name }],
      actionLocator: verifiedActionLocator({
        expression: target.expr,
        strategy: target.strategy || 'role',
        facts: { role: target.role, accessibleName: target.name, placeholder: target.strategy === 'placeholder' ? target.name : null },
        pageUrl: 'https://automationexercise.com/products',
        toolName: target.action === 'fill' ? 'browser_fill' : 'browser_click',
      }),
    });
    steps.push(target.action === 'fill'
      ? { op: 'act', action: 'fill', target: target.as, rawValue: 'Printed' }
      : { op: 'act', action: 'click', target: target.as });
  }
  steps.push({ op: 'assert', channel: 'UI_ROLE', target: 'polo', liveOutcome: 'matched' });

  const result = emitJourneySpec([{ ir: { title: 'Products full ledger', steps }, caseName: 'Products full ledger' }], {
    scenarioName: 'Products full ledger',
    scenarioId: 'scn-products-ledger',
    lang: 'js',
    moduleFormat: 'esm',
  });
  const spec = result.content || '';
  const page = result.extraFiles['pages/ProductsPage.js'] || '';
  const locators = result.extraFiles['locators/generated/productsPage.generated.locators.js'] || '';
  const architectReplacedSpecCalls = new Set(['clickKids', 'clickDress', 'fillSearchProduct', 'clickSearch']);
  for (const target of productTargets) {
    if (!architectReplacedSpecCalls.has(target.expectedMethod)) {
      ok(spec.includes(`await productsPage.${target.expectedMethod}(`) || spec.includes(`await productsPage.${target.expectedMethod}();`), `spec calls ${target.expectedMethod}`);
    }
    ok(page.includes(`async ${target.expectedMethod}(`), `ProductsPage.js defines ${target.expectedMethod}`);
    const accessor = target.expectedMethod.replace(/^(click|fill)/, '');
    const semanticStem = accessor.charAt(0).toLowerCase() + accessor.slice(1);
    ok(page.includes(`${semanticStem}`), `ProductsPage.js references locator stem ${semanticStem}`);
  }
  ok(spec.includes('await productsPage.selectCategory("Kids", "Dress");'), 'spec collapses Kids + Dress to selectCategory');
  ok(spec.includes('await productsPage.searchForProduct("Printed");'), 'spec collapses search fill + submit to searchForProduct');
  ok(page.includes('async selectCategory('), 'ProductsPage.js defines selectCategory business method');
  ok(page.includes('async searchForProduct('), 'ProductsPage.js defines searchForProduct business method');
  for (const expectedLocatorName of ['6PoloLink', 'menButton', 'kidsButton', 'dressLink', 'tshirtsLink', 'searchProductInput', 'searchButton']) {
    const normalized = expectedLocatorName.charAt(0).toLowerCase() + expectedLocatorName.slice(1);
    ok(
      locators.includes(`${normalized}: (page) =>`) || locators.includes(`${JSON.stringify(normalized)}: (page) =>`),
      `products generated locators include ${normalized}`
    );
  }
  ok(spec.includes('productsPage["6PoloLink"]()'), 'numeric-leading locator assertions use bracket accessor syntax');
  ok(!spec.includes('productsPage.6PoloLink()'), 'numeric-leading locator assertions do not emit invalid dot syntax');
  ok(!spec.includes('QAAI_UNRESOLVED_LOCATOR'), 'Products ledger spec has no unresolved locator marker');
}

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_playwright_pom: all checks passed (Phase 2 + Phase 3)');
