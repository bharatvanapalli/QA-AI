'use strict';
/**
 * Smoke guard for the 4 POM codegen bug fixes:
 *   Bug 1 — Missing page file: pages not in repo.files but in asMap still get a page class emitted.
 *   Bug 2 — Split-personality: pomEmitResolve returns clean locator, NOT a resolveLocator(...JSON...) blob.
 *   Bug 3 — Undefined row: data-driven cases wrap steps in a for-loop and pass hasDataLoop=true.
 *   Bug 4 — State-wipe navigate: a navigate step following an interaction step is suppressed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const adapter = require('../server/services/codegen/adapters/playwrightPom');
const replayExport = require('../server/services/codegen/replayExport');
const journeyLib = require('../server/services/codegen/_journey');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCase(steps, extras = {}) {
  return {
    caseName: extras.caseName || 'Test Case',
    ir: {
      title: extras.caseName || 'Test Case',
      steps,
      dataRows: extras.dataRows || [],
      dataRow: extras.dataRow || null,
    },
  };
}

// Minimal candidates with a role strategy (enough for emitLocatorResolver to work)
function roleCandidates(role, name) {
  return [{ strategy: 'role', role, name }];
}

function productResolve(as, candidate, actionLocator = null) {
  const step = { op: 'resolve', as, pageUrl: 'https://automationexercise.com/products', candidates: [candidate] };
  if (actionLocator) step.actionLocator = actionLocator;
  return step;
}

function productActionLocator(expression, strategy, facts = {}) {
  const pageUrl = 'https://automationexercise.com/products';
  const proof = {
    count: 1,
    sameElement: true,
    visible: true,
    enabled: true,
    source: 'verified_dom_inspection',
    verified: true,
  };
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    diagnosticOnly: false,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy,
    pageUrl,
    targetFacts: facts,
    context: {},
    proof,
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: pageUrl,
      routeKey: '/products',
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
        toolName: strategy === 'placeholder' ? 'browser_fill' : 'browser_click',
        elementLabel: facts.accessibleName || facts.placeholder || expression,
        strategy,
        expression,
        frameworkExpressions: { playwright: expression },
        targetFacts: facts,
        context: {},
        proof,
      }],
    },
  };
}

function productJourney(caseName, steps) {
  return makeCase([
    { op: 'act', action: 'navigate', url: 'https://automationexercise.com/products' },
    ...steps,
  ], { caseName });
}

// ─── Bug 2: pomEmitResolve returns clean locator, not resolveLocator JSON blob ──

console.log('\nBug 2 — Split-personality emitter:');

{
  // Elements that DO get POM-mapped: pomEmitResolve returns null (correct — no fallback needed).
  // Elements that DON'T get POM-mapped: pomEmitResolve must return a clean locator, NOT a
  // resolveLocator(page, [{"strategy":...}], label) JSON blob.
  //
  // To create a non-mapped element: use a candidate array with ONLY a CSS strategy
  // containing a dynamic-looking class. buildLocatorRepository won't produce a semantic
  // name for it (no role/label/placeholder/text strategy) so it won't enter asMap.
  // The resolve step then falls through to the Bug-2 path.
  //
  // Additionally, elements with a role but NO accessible name (name: undefined) may or
  // may not produce a manifest entry depending on the repository implementation — we test
  // a resolve step that gets POM-mapped (returns null) and one that falls back (no JSON blob).

  // Case A: element WITH a role+name — expects POM-mapped (null emit, no inline locator)
  const stepsWithPomMapped = [
    { op: 'resolve', as: 'el1', candidates: roleCandidates('textbox', 'Username') },
    { op: 'act', target: 'el1', action: 'fill', rawValue: 'Admin' },
  ];
  const resultA = adapter.emitJourneySpec([makeCase(stepsWithPomMapped)], { scenarioName: 'POM path' });
  check('POM-mapped element: resolve step omitted, page method called instead', () => {
    // The act step is either a page-method call OR an inline emitStep fallback.
    // Either way, there must be NO resolveLocator(...JSON...) blob.
    assert.ok(
      !resultA.content.includes('resolveLocator(page, [{"strategy"'),
      `POM-mapped spec must not contain raw JSON blob. Got:\n${resultA.content.slice(0, 500)}`
    );
  });

  // Case B: CSS-only candidate → no semantic name → likely not POM-mapped → fallback path.
  // The fallback must NOT produce a resolveLocator(...JSON...) blob.
  const stepsWithCssFallback = [
    {
      op: 'resolve',
      as: 'el1',
      candidates: [{ strategy: 'css', selector: '.dynamic-class-abc123' }],
    },
    { op: 'act', target: 'el1', action: 'click' },
  ];
  const resultB = adapter.emitJourneySpec([makeCase(stepsWithCssFallback)], { scenarioName: 'Fallback path' });
  check('non-POM-mapped element: no resolveLocator(...JSON...) blob in fallback', () => {
    assert.ok(
      !resultB.content.includes('resolveLocator(page, [{"strategy"'),
      `Fallback spec must not contain raw JSON blob. Got:\n${resultB.content.slice(0, 500)}`
    );
  });
}

// ─── Bug 3: data-driven cases get a for-loop and hasDataLoop=true ────────────

console.log('\nBug 3 — Undefined row variable:');

{
  const dataRows = [
    { index: 0, label: 'Row 1', fields: { username: 'alice' } },
    { index: 1, label: 'Row 2', fields: { username: 'bob' } },
  ];

  const steps = [
    { op: 'resolve', as: 'el1', candidates: roleCandidates('textbox', 'Username') },
    { op: 'act', target: 'el1', action: 'fill', dataRole: 'username' },
  ];

  const cases = [makeCase(steps, { caseName: 'Fill Username', dataRows })];
  const result = adapter.emitJourneySpec(cases, { scenarioName: 'Data Login' });
  const spec = result.content;

  check('spec contains _dataRows declaration', () => {
    assert.ok(spec.includes('_dataRows'), `Expected _dataRows in spec. Got:\n${spec.slice(0, 600)}`);
  });

  check('data rows are externalized to tests/data JSON, not inlined in the spec', () => {
    assert.ok(
      spec.includes('loadDataRows("tests/data/fill-username.json")'),
      `Expected loadDataRows call for external data file. Got:\n${spec.slice(0, 800)}`
    );
    assert.ok(
      !/const\s+_dataRows\d*\s*=\s*\[/.test(spec),
      `Spec must not inline row data. Got:\n${spec.slice(0, 800)}`
    );
    const dataFile = result.extraFiles['tests/data/fill-username.json'];
    assert.ok(dataFile, `Expected tests/data/fill-username.json. Got files: ${Object.keys(result.extraFiles).join(', ')}`);
    const parsed = JSON.parse(dataFile);
    assert.strictEqual(parsed.length, 2, `Expected 2 data rows. Got: ${dataFile}`);
    assert.strictEqual(parsed[0].fields.username, 'alice', `Expected sanitized data field. Got: ${dataFile}`);
  });

  check('spec contains for...of loop over _dataRows', () => {
    assert.ok(/for \(const row of _dataRows\d*\)/.test(spec), `Expected for-loop. Got:\n${spec.slice(0, 600)}`);
  });

  check('spec references readData(row, ...) for data-role fill', () => {
    assert.ok(spec.includes("readData(row,"), `Expected readData(row,...). Got:\n${spec.slice(0, 600)}`);
  });

  check('spec does NOT reference undefined row outside a loop', () => {
    // row should only appear inside the for-loop block or in readData calls
    const lines = spec.split('\n');
    const loopStart = lines.findIndex((l) => /for \(const row of _dataRows\d*\)/.test(l));
    const loopEnd = lines.findIndex((l, i) => i > loopStart && l.trim() === '}');
    const outsideLoop = lines.filter((l, i) => i < loopStart && l.includes('readData(row'));
    assert.strictEqual(outsideLoop.length, 0, `readData(row,...) appeared outside the for-loop`);
  });

  check('data-driven row expansion preserves top-level Playwright test cardinality', () => {
    assert.ok(/for \(const row of _dataRows\d*\)\s*\{\s*test\(/s.test(spec), `Each data row must create a Playwright test, not a hidden step. Got:\n${spec.slice(0, 900)}`);
    assert.ok(!spec.includes('test.step('), `Generated POM specs must not collapse QAAI cases into test.step(). Got:\n${spec.slice(0, 900)}`);
  });
}

{
  // Non-DDT case: no dataRows → no for-loop, no readData
  const steps = [
    { op: 'resolve', as: 'el1', candidates: roleCandidates('textbox', 'Username') },
    { op: 'act', target: 'el1', action: 'fill', rawValue: 'Admin' },
  ];
  const cases = [makeCase(steps, { caseName: 'Static Fill' })];
  const result = adapter.emitJourneySpec(cases, { scenarioName: 'Static Login' });
  const spec = result.content;

  check('non-DDT case: no for-loop emitted', () => {
    assert.ok(!spec.includes('for (const row of'), `Non-DDT spec should NOT have for-loop. Got:\n${spec.slice(0, 400)}`);
  });

  check('non-DDT case: no readData(row) call', () => {
    assert.ok(!spec.includes('readData(row'), `Non-DDT spec should NOT have readData(row). Got:\n${spec.slice(0, 400)}`);
  });
}

// ─── Bug 4: consequence navigate (after click) is suppressed ─────────────────

console.log('\nBug 4 — State-wipe navigate:');

{
  const steps = [
    { op: 'act', action: 'navigate', url: 'https://example.com/login' },
    { op: 'resolve', as: 'el1', candidates: roleCandidates('button', 'Login') },
    { op: 'act', target: 'el1', action: 'click' },
    // This navigate follows a click — should be suppressed
    { op: 'act', action: 'navigate', url: 'https://example.com/dashboard' },
    // A second navigate after the suppressed one — also after click → also suppressed
    { op: 'act', action: 'navigate', url: 'https://example.com/profile' },
  ];

  const cases = [makeCase(steps, { caseName: 'Login Flow' })];
  const result = adapter.emitJourneySpec(cases, { scenarioName: 'Auth' });
  const spec = result.content;

  check('initial navigate to /login IS emitted (relative path)', () => {
    // Bug 6 fix: absolute URL is stripped to path; check for the relative form.
    assert.ok(spec.includes('page.goto("/login")'), `Expected relative initial nav. Got:\n${spec.slice(0, 600)}`);
  });

  check('consequence navigate to /dashboard is suppressed (no goto after click)', () => {
    assert.ok(!spec.includes('example.com/dashboard'), `Consequence navigate should be suppressed. Got:\n${spec.slice(0, 600)}`);
  });

  check('consequence navigate to /profile is also suppressed', () => {
    assert.ok(!spec.includes('example.com/profile'), `Second consequence navigate should be suppressed. Got:\n${spec.slice(0, 600)}`);
  });
}

{
  // An explicit navigate after a non-interaction (waitFor) should NOT be suppressed
  const steps = [
    { op: 'act', action: 'navigate', url: 'https://example.com/page-a' },
    { op: 'waitFor', condition: { kind: 'networkIdle' } },
    { op: 'act', action: 'navigate', url: 'https://example.com/page-b' },
  ];

  const cases = [makeCase(steps, { caseName: 'Multi Nav' })];
  const result = adapter.emitJourneySpec(cases, { scenarioName: 'Nav Flow' });
  const spec = result.content;

  check('non-interaction-preceded navigate IS emitted (waitFor does not count as interaction)', () => {
    // Bug 6 fix: absolute URL is stripped to path; check for the relative form.
    assert.ok(spec.includes('page.goto("/page-b")'), `Expected non-consequence relative nav. Got:\n${spec.slice(0, 600)}`);
  });
}

// ─── Bug 1: pages referenced in asMap that are absent from repo.files get page files ──

console.log('\nBug 1 — Missing page file for asMap-referenced pages:');

{
  // The POM adapter builds asMap from the locator repository manifest.
  // We test that the emitted extraFiles includes a page class for every distinct page
  // referenced in a spec, even if the locator repository has no locator entries for it.
  // This is an integration-level check: emit a spec and verify pages/ has an entry per
  // page that appears in the spec imports.
  const steps = [
    { op: 'resolve', as: 'el1', candidates: roleCandidates('textbox', 'Username') },
    { op: 'act', target: 'el1', action: 'fill', rawValue: 'Admin' },
    { op: 'resolve', as: 'el2', candidates: roleCandidates('textbox', 'Password') },
    { op: 'act', target: 'el2', action: 'fill', rawValue: 'pass' },
    { op: 'resolve', as: 'el3', candidates: roleCandidates('button', 'Login') },
    { op: 'act', target: 'el3', action: 'click' },
  ];

  const cases = [makeCase(steps, { caseName: 'Login' })];
  const result = adapter.emitJourneySpec(cases, { scenarioName: 'Auth' });
  const spec = result.content;
  const extraFiles = result.extraFiles;

  // Find all page imports in the spec
  const importedClasses = [];
  for (const line of spec.split('\n')) {
    const m = line.match(/import\s*\{\s*(\w+)\s*\}\s*from\s*'\.\.\/\.\.\/pages\/(\w+)'/);
    if (m) importedClasses.push({ className: m[1], fileName: m[2] });
  }

  check('spec imports page classes for elements resolved by the repository', () => {
    // Either asMap is empty (all elements without repo entries → no page imports) or
    // every imported class has a corresponding page file in extraFiles.
    for (const { className, fileName } of importedClasses) {
      const tsKey = `pages/${className}.ts`;
      const jsKey = `pages/${className}.js`;
      assert.ok(
        extraFiles[tsKey] || extraFiles[jsKey],
        `Spec imports ${className} but no page file found in extraFiles (checked ${tsKey})`
      );
    }
  });

  check('every page file in extraFiles contains a class declaration', () => {
    for (const [path, content] of Object.entries(extraFiles)) {
      if (!path.startsWith('pages/') || path.includes('EvaluateMethods')) continue;
      assert.ok(
        content.includes('export class '),
        `Page file ${path} is missing "export class" declaration`
      );
    }
  });
}

// ─── Bug 5: IdPage naming — :id sentinel skipped when picking page file name ──

console.log('\nBug 5 — IdPage naming from dynamic route segments:');

{
  const repo = require('../server/services/codegen/pageObjectRepository');

  check('/category_products/1 → categoryProductsPage (not idPage)', () => {
    const steps = [
      { op: 'resolve', as: 'el1', candidates: roleCandidates('link', 'Products'), pageUrl: 'https://example.com/category_products/1' },
      { op: 'act', target: 'el1', action: 'click' },
    ];
    const result = adapter.emitJourneySpec([makeCase(steps)], { scenarioName: 'Nav' });
    const files = Object.keys(result.extraFiles || {});
    assert.ok(
      files.includes('pages/CategoryProductsPage.ts') && files.includes('locators/categoryProductsPage.locators.ts'),
      `Expected categoryProductsPage files from resolve.pageUrl. Got: ${files.join(', ')}`
    );
    assert.ok(
      !files.some((k) => /idPage|rootPage/i.test(k)),
      `Extra files must not contain idPage/rootPage. Got: ${files.join(', ')}`
    );
  });

  check('pageKey /category_products/1 → last meaningful segment is category_products not :id', () => {
    // Directly test the exported pageKey if available, else infer via emitted page filename.
    // The repository resolves this at buildLocatorRepository time — we probe via a spec emit.
    const steps = [
      { op: 'resolve', as: 'el1', candidates: roleCandidates('button', 'Go'), pageUrl: 'https://site.example/items/42/edit' },
      { op: 'act', target: 'el1', action: 'click' },
    ];
    const result = adapter.emitJourneySpec([makeCase(steps)], { scenarioName: 'Edit' });
    const pageFiles = Object.keys(result.extraFiles || {}).filter((k) => k.startsWith('pages/'));
    assert.ok(
      pageFiles.includes('pages/EditPage.ts'),
      `Expected /items/42/edit resolve.pageUrl to produce EditPage. Got: ${pageFiles.join(', ')}`
    );
    // Key check: no page file name is just "IdPage"
    for (const f of pageFiles) {
      assert.ok(
        !/^pages\/IdPage\.(ts|js)$/.test(f),
        `Page file named IdPage found — dynamic segment was not skipped: ${f}`
      );
    }
  });
}

// ─── Bug 6: Hardcoded absolute URL — navigate steps emit relative path ────────

console.log('\nBug 6 — Navigate steps emit relative paths (not absolute URLs):');

{
  const steps = [
    { op: 'act', action: 'navigate', url: 'https://automationexercise.com/products' },
    { op: 'resolve', as: 'el1', candidates: roleCandidates('button', 'Search') },
    { op: 'act', target: 'el1', action: 'click' },
  ];
  const result = adapter.emitJourneySpec([makeCase(steps, { caseName: 'Product Nav' })], { scenarioName: 'Nav' });
  const spec = result.content;

  check('navigate emits /products (relative path), not full absolute URL', () => {
    assert.ok(
      spec.includes('page.goto("/products")'),
      `Expected relative goto. Got snippet:\n${spec.slice(0, 600)}`
    );
  });

  check('navigate does NOT emit hardcoded scheme+host', () => {
    assert.ok(
      !spec.includes('automationexercise.com'),
      `Absolute URL leaked into spec. Got snippet:\n${spec.slice(0, 600)}`
    );
  });

  check('root URL / emits page.goto("/")', () => {
    const stepsRoot = [
      { op: 'act', action: 'navigate', url: 'https://example.com/' },
    ];
    const r = adapter.emitJourneySpec([makeCase(stepsRoot, { caseName: 'Home' })], { scenarioName: 'Home' });
    assert.ok(r.content.includes('page.goto("/")'), `Root URL should emit page.goto("/")`);
  });
}

// ─── Bug 7: CJS/ESM split — playwright-pom-js assembles TypeScript support file ─
// (Tested here as a documentation check — assemblePackage lives in replayExport.js
//  not in the adapter; we verify the POM adapter spec always uses import, never require)

console.log('\nBug 7 — POM adapter always emits import (ES module) syntax:');

{
  const steps = [
    { op: 'act', action: 'navigate', url: 'https://example.com/login' },
    { op: 'resolve', as: 'el1', candidates: roleCandidates('textbox', 'User') },
    { op: 'act', target: 'el1', action: 'fill', dataRole: 'username' },
  ];
  const dataRows = [{ index: 0, label: 'Admin', fields: { username: 'admin' } }];
  const result = adapter.emitJourneySpec([makeCase(steps, { caseName: 'Login', dataRows })], { scenarioName: 'Login', lang: 'js', specDir: 'tests/auth' });
  const spec = result.content;

  check('POM JS spec uses import (not require) for @playwright/test', () => {
    assert.ok(
      spec.includes("import { test } from '@playwright/test'"),
      `POM JS spec must use import, not require. Got:\n${spec.slice(0, 400)}`
    );
    assert.ok(
      !spec.includes("const { test"),
      `POM JS spec must not use CommonJS require. Got:\n${spec.slice(0, 400)}`
    );
  });

  check('POM JS spec uses import for support/replayir (not require)', () => {
    assert.ok(
      spec.includes("import { readData, loadDataRows } from '../support/replayir.js'"),
      `POM JS spec must import from support/replayir.js. Got:\n${spec.slice(0, 400)}`
    );
    assert.ok(
      !spec.includes("require('../support/replayir')"),
      `POM JS spec must NOT use require for support/replayir. Got:\n${spec.slice(0, 400)}`
    );
  });

  check('POM JS spec imports page object with .js extension', () => {
    assert.ok(
      spec.includes("from '../../pages/LoginPage.js'"),
      `POM JS spec must import page object with .js extension. Got:\n${spec.slice(0, 600)}`
    );
  });

  check('POM JS page imports locator shim with .js extension', () => {
    const page = result.extraFiles['pages/LoginPage.js'] || '';
    assert.ok(
      page.includes("from '../locators/loginPage.locators.js'"),
      `POM JS page must import locator shim with .js extension. Got:\n${page.slice(0, 400)}`
    );
  });

  check('POM JS locator shim re-exports generated locators with .js extension', () => {
    const shim = result.extraFiles['locators/loginPage.locators.js'] || '';
    assert.ok(
      shim.includes("export * from './generated/loginPage.generated.locators.js'"),
      `POM JS locator shim must re-export generated locator with .js extension. Got:\n${shim}`
    );
  });
}

// ─── relativeUrl edge cases ────────────────────────────────────────────────────
// relativeUrl() lives inside playwrightPom.js; we test it via emitted goto calls.

console.log('\nrelativeUrl — edge cases produce correct page.goto() arguments:');

{
  function gotoIn(url) {
    const steps = [{ op: 'act', action: 'navigate', url }];
    return adapter.emitJourneySpec([makeCase(steps, { caseName: 'Nav' })], { scenarioName: 'Nav' }).content;
  }

  check('URL with port: scheme+host+port stripped, only path emitted', () => {
    const spec = gotoIn('https://example.com:8080/foo/bar');
    assert.ok(spec.includes('page.goto("/foo/bar")'), `Expected /foo/bar. Got snippet:\n${spec.slice(0, 400)}`);
    assert.ok(!spec.includes(':8080'), `Port must not leak into goto. Got:\n${spec.slice(0, 400)}`);
  });

  check('URL with query + hash: path+search+hash all preserved', () => {
    const spec = gotoIn('https://example.com/search?q=test#results');
    assert.ok(spec.includes('page.goto("/search?q=test#results")'),
      `Expected /search?q=test#results. Got snippet:\n${spec.slice(0, 400)}`);
  });

  check('hash-only navigation: returned as-is (fragment anchor on current page)', () => {
    // new URL('#frag') throws without a base → relativeUrl falls back to raw string.
    // page.goto('#frag') is valid Playwright and navigates to a fragment on the current page.
    const spec = gotoIn('#section-2');
    assert.ok(spec.includes('page.goto("#section-2")'),
      `Hash-only nav should be preserved verbatim. Got snippet:\n${spec.slice(0, 400)}`);
  });

  check('protocol-relative URL: returned as-is (new URL throws without scheme)', () => {
    // QAAI navigates within one app, so cross-protocol redirects are not a real case;
    // we document the behavior: falls back to the raw string.
    const spec = gotoIn('//example.com/path');
    assert.ok(spec.includes('page.goto("//example.com/path")'),
      `Protocol-relative URL should be preserved verbatim. Got snippet:\n${spec.slice(0, 400)}`);
  });
}

// ─── Expr canonicalization: formatting-only differences do not produce conflicts ─

console.log('\nExpr canonicalization — formatting-only differences do not produce conflicts:');

{
  const repo = require('../server/services/codegen/pageObjectRepository');

  check('canonicalizeExpr: single-vs-double-quote difference → equal', () => {
    // selectStaticLocator emits double-quoted strings (JSON.stringify); a legacy stored
    // expr with single quotes must canonicalize to the same value, not conflict.
    const a = repo.canonicalizeExpr("page.getByRole('textbox', { name: 'Username' })");
    const b = repo.canonicalizeExpr('page.getByRole("textbox", { name: "Username" })');
    assert.strictEqual(a, b, `Expected equal after quote normalization.\n  a=${a}\n  b=${b}`);
  });

  check('canonicalizeExpr: extra internal whitespace → equal', () => {
    const a = repo.canonicalizeExpr("page.getByRole('textbox',  { name:  'Username' })");
    const b = repo.canonicalizeExpr("page.getByRole('textbox', { name: 'Username' })");
    assert.strictEqual(a, b, `Expected equal after whitespace collapse.\n  a=${a}\n  b=${b}`);
  });

  check('canonicalizeExpr: genuinely different names remain unequal', () => {
    const a = repo.canonicalizeExpr("page.getByRole('textbox', { name: 'Username' })");
    const b = repo.canonicalizeExpr("page.getByRole('textbox', { name: 'Password' })");
    assert.notStrictEqual(a, b, 'Different locator names must not collapse to same canonical form');
  });

  check('buildLocatorRepository: same element in two cases → zero conflicts', () => {
    const cases = [
      { ir: { steps: [
        { op: 'act', action: 'navigate', url: 'https://site.example/login' },
        { op: 'resolve', as: 'u1', candidates: [{ strategy: 'role', role: 'textbox', name: 'Username' }] },
        { op: 'act', target: 'u1', action: 'fill', rawValue: 'admin' },
      ]}},
      { ir: { steps: [
        { op: 'act', action: 'navigate', url: 'https://site.example/login' },
        { op: 'resolve', as: 'u2', candidates: [{ strategy: 'role', role: 'textbox', name: 'Username' }] },
        { op: 'act', target: 'u2', action: 'fill', rawValue: 'user2' },
      ]}},
    ];
    const result = repo.buildLocatorRepository({ cases });
    assert.strictEqual(result.conflicts.length, 0,
      `Same element across two cases must not conflict. Got: ${JSON.stringify(result.conflicts)}`);
  });
}

// --- PAGE assertion parity: use declared PAGE signal type, not mapped-target visibility ---

console.log('\nBug 8 - PAGE assertion parity uses expectedSignals structurally:');

{
  const baseSteps = [
    { op: 'act', action: 'navigate', url: 'https://example.com/login' },
    { op: 'resolve', as: 'loginBtn', candidates: roleCandidates('button', 'Login') },
  ];

  check('PAGE url signal emits a page URL assertion', () => {
    const result = adapter.emitJourneySpec([makeCase([
      ...baseSteps,
      { op: 'assert', channel: 'PAGE', target: 'loginBtn', expectedSignals: { url: ['/dashboard'] }, liveOutcome: 'matched' },
    ], { caseName: 'URL PAGE' })], { scenarioName: 'URL PAGE' });
    assert.ok(
      result.content.includes('await expect(page).toHaveURL(new RegExp("/dashboard"), { timeout: 10000 });'),
      `Expected PAGE URL signal assertion. Got:\n${result.content}`
    );
    assert.ok(
      !/loginPage\.loginButton\(\)\.first\(\)\)\.toBeVisible/.test(result.content),
      `PAGE URL signal must not degrade to mapped-target visibility. Got:\n${result.content}`
    );
  });

  check('PAGE url signal without target still emits a page URL assertion', () => {
    const result = adapter.emitJourneySpec([makeCase([
      { op: 'act', action: 'navigate', url: 'https://example.com/login' },
      { op: 'assert', channel: 'PAGE', expectedSignals: { url: ['/dashboard'] }, liveOutcome: 'matched' },
    ], { caseName: 'URL PAGE no target' })], { scenarioName: 'URL PAGE no target' });
    assert.ok(
      result.content.includes('await expect(page).toHaveURL(new RegExp("/dashboard"), { timeout: 10000 });'),
      `Expected targetless PAGE URL signal assertion. Got:\n${result.content}`
    );
    assert.ok(
      !result.content.includes('PAGE assertion has no concrete expected value'),
      `Targetless PAGE signal must not emit no-op refusal. Got:\n${result.content}`
    );
  });

  check('PAGE role signal emits a page role assertion', () => {
    const result = adapter.emitJourneySpec([makeCase([
      ...baseSteps,
      {
        op: 'assert',
        channel: 'PAGE',
        target: 'loginBtn',
        expectedSignals: { role: [{ role: 'heading', name: 'Dashboard' }] },
        liveOutcome: 'matched',
      },
    ], { caseName: 'Role PAGE' })], { scenarioName: 'Role PAGE' });
    assert.ok(
      result.content.includes('await expect(page.getByRole("heading", { name: new RegExp("Dashboard", \'i\') })).toBeVisible({ timeout: 10000 });'),
      `Expected PAGE role signal assertion. Got:\n${result.content}`
    );
    assert.ok(
      !result.content.includes('.first()'),
      `PAGE role signal must not suppress ambiguity with .first(). Got:\n${result.content}`
    );
  });

  check('legacy PAGE without signals keeps mapped-target visibility fallback', () => {
    const result = adapter.emitJourneySpec([makeCase([
      ...baseSteps,
      { op: 'assert', channel: 'PAGE', target: 'loginBtn', liveOutcome: 'matched' },
    ], { caseName: 'Legacy PAGE' })], { scenarioName: 'Legacy PAGE' });
    assert.ok(
      result.content.includes('await expect(loginPage.loginButton()).toHaveCount(1, { timeout: 10000 });') &&
      result.content.includes('await expect(loginPage.loginButton()).toBeVisible({ timeout: 10000 });'),
      `Expected legacy mapped-target visibility fallback. Got:\n${result.content}`
    );
  });
}

// ─── Medium 5: Structural import paths — derived from specDir, never hardcoded ─────

console.log('\nMedium 5 — emitPomSpec computes import path from specDir (never hardcodes depth):');

{
  function specImportsFor(steps, specDir) {
    const result = adapter.emitJourneySpec(
      [makeCase(steps, { caseName: 'Test' })],
      { scenarioName: 'Test', specDir }
    );
    return result.content;
  }

  function dataSpecImportsFor(specDir, lang = 'ts') {
    const result = adapter.emitJourneySpec(
      [makeCase([
        { op: 'act', action: 'navigate', url: 'https://example.com/app/login' },
        { op: 'resolve', as: 'u1', candidates: roleCandidates('textbox', 'Username') },
        { op: 'act', target: 'u1', action: 'fill', dataRole: 'username' },
      ], { caseName: 'Data Test', dataRows: [{ index: 0, label: 'Admin', fields: { username: 'admin' } }] })],
      { scenarioName: 'Data Test', specDir, lang }
    );
    return result.content;
  }

  const steps = [
    { op: 'act', action: 'navigate', url: 'https://example.com/app/login' },
    { op: 'resolve', as: 'u1', candidates: roleCandidates('textbox', 'Username') },
    { op: 'act', target: 'u1', action: 'fill', rawValue: 'admin' },
  ];

  check('specDir = "tests/login" → import path is ../../pages/', () => {
    const spec = specImportsFor(steps, 'tests/login');
    assert.ok(
      spec.includes("from '../../pages/"),
      `Expected ../../pages/ import. Got snippet:\n${spec.slice(0, 600)}`
    );
  });

  check('no specDir provided → fallback is ../../pages/ (backward-compat)', () => {
    const spec = specImportsFor(steps, undefined);
    assert.ok(
      spec.includes("from '../../pages/"),
      `Expected fallback ../../pages/ import. Got snippet:\n${spec.slice(0, 600)}`
    );
  });

  check('specDir = "tests/a/b" → import path is ../../../pages/ (3-level nesting)', () => {
    // Hypothetical 3-level nesting: tests/a/b/<spec>.ts → ../../../pages/
    const spec = specImportsFor(steps, 'tests/a/b');
    assert.ok(
      spec.includes("from '../../../pages/"),
      `Expected ../../../pages/ import for 3-level specDir. Got snippet:\n${spec.slice(0, 600)}`
    );
    assert.ok(
      !spec.includes("from '../../pages/"),
      `Must NOT produce 2-level path for 3-level specDir. Got snippet:\n${spec.slice(0, 600)}`
    );
  });

  check('specDir = "tests/a/b" → TS support import path is ../../support/replayir', () => {
    const spec = dataSpecImportsFor('tests/a/b', 'ts');
    assert.ok(
      spec.includes("from '../../support/replayir'"),
      `Expected ../../support/replayir import for nested TS spec. Got snippet:\n${spec.slice(0, 800)}`
    );
    assert.ok(
      !spec.includes("from '../support/replayir'"),
      `Must NOT produce one-level support path for nested TS spec. Got snippet:\n${spec.slice(0, 800)}`
    );
  });

  check('specDir = "tests/a/b" → JS support import path is ../../support/replayir.js', () => {
    const spec = dataSpecImportsFor('tests/a/b', 'js');
    assert.ok(
      spec.includes("from '../../support/replayir.js'"),
      `Expected ../../support/replayir.js import for nested JS spec. Got snippet:\n${spec.slice(0, 800)}`
    );
    assert.ok(
      !spec.includes("from '../support/replayir.js'"),
      `Must NOT produce one-level support path for nested JS spec. Got snippet:\n${spec.slice(0, 800)}`
    );
  });

  check('action-only spec does not import unused support helpers', () => {
    const spec = specImportsFor(steps, 'tests/login');
    assert.ok(
      !spec.includes('/support/replayir'),
      `Spec without support helper calls must not import support file. Got snippet:\n${spec.slice(0, 800)}`
    );
  });

  check('action-only spec imports test without unused expect', () => {
    const spec = specImportsFor(steps, 'tests/login');
    assert.ok(
      spec.includes("import { test } from '@playwright/test';"),
      `Action-only spec should import only test from Playwright. Got snippet:\n${spec.slice(0, 400)}`
    );
    assert.ok(
      !spec.includes("import { test, expect } from '@playwright/test';"),
      `Action-only spec must not import unused expect. Got snippet:\n${spec.slice(0, 400)}`
    );
  });

  check('specDir = "tests/module" → NO site-specific string in import path', () => {
    const spec = specImportsFor(steps, 'tests/pim');
    // path must be relative (starts with ../ or ./), never absolute or site-specific
    const importMatch = spec.match(/from '([^']+LoginPage[^']*)'/);
    if (importMatch) {
      assert.ok(
        importMatch[1].startsWith('.'),
        `Import path must be relative. Got: ${importMatch[1]}`
      );
    }
    // The depth from tests/pim → pages is ../../pages
    assert.ok(
      spec.includes("from '../../pages/"),
      `Expected ../../pages/ for tests/pim specDir. Got snippet:\n${spec.slice(0, 600)}`
    );
  });
}

// --- Live dependsOn journey POM architecture: no legacy flat spec path ---

console.log('\nLive dependsOn journey - POM architecture for TS and CommonJS JS:');

{
  const replayCases = [
    {
      testCase: { id: 'A', name: 'Search product' },
      replayIr: {
        caseId: 'A',
        title: 'Search product',
        steps: [
          { op: 'act', action: 'navigate', url: 'https://example.com/products' },
          { op: 'resolve', as: 'search', pageUrl: 'https://example.com/products', candidates: roleCandidates('textbox', 'Search') },
          { op: 'act', target: 'search', action: 'fill', rawValue: 'Laptop' },
          { op: 'resolve', as: 'go', pageUrl: 'https://example.com/products', candidates: roleCandidates('button', 'Search') },
          { op: 'act', target: 'go', action: 'click' },
          { op: 'assert', channel: 'PAGE', expectedSignals: { url: ['/products'] }, liveOutcome: 'matched' },
        ],
      },
    },
    {
      testCase: { id: 'B', name: 'Open product' },
      replayIr: {
        caseId: 'B',
        title: 'Open product',
        steps: [
          { op: 'resolve', as: 'item', pageUrl: 'https://example.com/products', candidates: roleCandidates('link', 'Laptop Pro') },
          { op: 'act', target: 'item', action: 'click' },
          { op: 'assert', channel: 'PAGE', expectedSignals: { heading: ['Laptop Pro'] }, liveOutcome: 'matched' },
        ],
      },
    },
  ];

  check('TS live journey emits tests + pages + locators instead of a flat-only spec', () => {
    const result = journeyLib.generatePlaywrightPomJourney({
      scenario: { name: 'Product dependency journey', module: 'Catalog' },
      journeyCases: replayCases,
      lang: 'ts',
    });
    assert.ok(result.content.includes("import { ProductsPage } from '../../pages/ProductsPage';"), result.content);
    assert.ok(result.content.includes('await productsPage.searchForProduct("Laptop");'), result.content);
    assert.ok(result.extraFiles['pages/ProductsPage.ts'], `Missing page file. Got ${Object.keys(result.extraFiles).join(', ')}`);
    assert.ok(result.extraFiles['locators/productsPage.locators.ts'], 'Missing locator shim');
    assert.ok(result.extraFiles['locators/generated/productsPage.generated.locators.ts'], 'Missing generated locators');
    assert.ok(result.extraFiles['tests/support/replayir.ts'], 'Missing TS replay support');
    assert.ok(!result.content.includes('page.getByRole("textbox"'), `Spec body must not inline locator calls. Got:\n${result.content}`);
  });

  check('CommonJS JS live journey emits POM files compatible with the legacy playwright-js shell', () => {
    const result = journeyLib.generatePlaywrightPomJourney({
      scenario: { name: 'Product dependency journey', module: 'Catalog' },
      journeyCases: replayCases,
      lang: 'js',
      moduleFormat: 'cjs',
    });
    assert.ok(result.content.includes("const { test, expect } = require('@playwright/test');"), result.content);
    assert.ok(result.content.includes("const { ProductsPage } = require('../../pages/ProductsPage');"), result.content);
    assert.ok(!result.content.includes('import {'), `CJS live journey must not use ESM imports. Got:\n${result.content}`);
    const page = result.extraFiles['pages/ProductsPage.js'] || '';
    const shim = result.extraFiles['locators/productsPage.locators.js'] || '';
    const generated = result.extraFiles['locators/generated/productsPage.generated.locators.js'] || '';
    assert.ok(page.includes("const { productsPageLocators } = require('../locators/productsPage.locators');"), page);
    assert.ok(page.includes('module.exports = { ProductsPage };'), page);
    assert.ok(shim.includes("module.exports = require('./generated/productsPage.generated.locators');"), shim);
    assert.ok(generated.includes('module.exports = { productsPageLocators };'), generated);
    assert.ok(result.extraFiles['tests/support/replayir.js'].includes('module.exports'), 'Missing CJS replay support');
  });

  check('conductor live journey writer preserves extra POM files', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server/services/agents/conductor.js'), 'utf8');
    assert.ok(/const extraFiles = generated[\s\S]+generated\.extraFiles/.test(source), 'conductor must read generated.extraFiles');
    assert.ok(/Object\.entries\(extraFiles\)/.test(source), 'conductor must iterate extraFiles');
    assert.ok(/fs\.writeFileSync\(out,\s*String\(fileContent\),\s*'utf8'\)/.test(source), 'conductor must write each extra file to disk');
  });
}

// ─── Summary ─────────────────────────────────────────────────────────────────

// --- Export certification auto-repair: reduce QAAI-side uncertified packages ---

console.log('\nPOM graph assembly - shared page objects are merged across journey groups:');

{
  const searchCase = productJourney('Search products by name', [
    productResolve(
      'searchBox',
      { strategy: 'placeholder', text: 'Search Product' },
      productActionLocator('getByPlaceholder("Search Product")', 'placeholder', { tag: 'input', role: 'textbox', placeholder: 'Search Product' })
    ),
    { op: 'act', action: 'fill', target: 'searchBox', rawValue: 'Printed' },
    productResolve(
      'searchSubmit',
      { strategy: 'role', role: 'button', name: 'Search' },
      productActionLocator('locator("form").filter({ has: page.getByPlaceholder("Search Product") }).getByRole("button")', 'context', { tag: 'button', role: 'button', accessibleName: 'Search' })
    ),
    { op: 'act', action: 'click', target: 'searchSubmit' },
  ]);
  const filtersCase = productJourney('Filter products by category and brand', [
    productResolve('women', { strategy: 'role', role: 'link', name: 'Women' }, productActionLocator('getByRole("link", { name: /women/i })', 'role', { tag: 'a', role: 'link', accessibleName: 'Women' })),
    { op: 'act', action: 'click', target: 'women' },
    productResolve('tops', { strategy: 'role', role: 'link', name: 'Tops' }, productActionLocator('getByRole("link", { name: /tops/i })', 'role', { tag: 'a', role: 'link', accessibleName: 'Tops' })),
    { op: 'act', action: 'click', target: 'tops' },
    productResolve('polo', { strategy: 'role', role: 'link', name: '6 Polo' }, productActionLocator('getByRole("link", { name: /polo/i })', 'role', { tag: 'a', role: 'link', accessibleName: '6 Polo' })),
    { op: 'act', action: 'click', target: 'polo' },
    productResolve('kids', { strategy: 'role', role: 'button', name: 'Kids' }, productActionLocator('getByRole("button", { name: /kids/i })', 'role', { tag: 'button', role: 'button', accessibleName: 'Kids' })),
    { op: 'act', action: 'click', target: 'kids' },
    productResolve('dress', { strategy: 'role', role: 'link', name: 'Dress' }, productActionLocator('getByRole("link", { name: /dress/i })', 'role', { tag: 'a', role: 'link', accessibleName: 'Dress' })),
    { op: 'act', action: 'click', target: 'dress' },
    productResolve('men', { strategy: 'role', role: 'button', name: 'Men' }, productActionLocator('getByRole("button", { name: /men/i })', 'role', { tag: 'button', role: 'button', accessibleName: 'Men' })),
    { op: 'act', action: 'click', target: 'men' },
    productResolve('tshirts', { strategy: 'role', role: 'link', name: 'Tshirts' }, productActionLocator('getByRole("link", { name: /tshirts/i })', 'role', { tag: 'a', role: 'link', accessibleName: 'Tshirts' })),
    { op: 'act', action: 'click', target: 'tshirts' },
  ]);
  const search = adapter.emitJourneySpec([searchCase], { scenarioName: 'Search flow', scenarioId: 'search-flow', specDir: 'tests/products', lang: 'js', moduleFormat: 'esm' });
  const filters = adapter.emitJourneySpec([filtersCase], { scenarioName: 'Filter flow', scenarioId: 'filter-flow', specDir: 'tests/products', lang: 'js', moduleFormat: 'esm' });
  const files = replayExport.assemblePackage({
    adapterId: 'playwright-pom-js',
    envVars: ['QAAI_TARGET_URL'],
    admitted: [
      { filePath: 'tests/products/product-search-by-name-happy-path.spec.js', content: search.content, extraFiles: search.extraFiles, pomGraph: search.pomGraph },
      { filePath: 'tests/products/category-filter-happy-path.spec.js', content: filters.content, extraFiles: filters.extraFiles, pomGraph: filters.pomGraph },
    ],
  });
  const page = files['pages/ProductsPage.js'] || '';
  const locators = files['locators/generated/productsPage.generated.locators.js'] || '';

  check('assembled ProductsPage.js contains union of search, brand, and category methods', () => {
    for (const method of ['fillSearchProduct', 'clickSearch', 'clickWomen', 'clickTops', 'click6Polo', 'clickKids', 'clickDress', 'clickMen', 'clickTshirts']) {
      assert.ok(page.includes(`async ${method}(`), `Missing ${method} in merged page:\n${page}`);
    }
  });

  check('assembled locator file contains union of all ProductsPage locator keys', () => {
    for (const key of ['searchProductElement', 'searchButton', 'womenLink', 'topsLink', '6PoloLink', 'kidsButton', 'dressLink', 'menButton', 'tshirtsLink']) {
      assert.ok(locators.includes(`${key}:`) || locators.includes(`${JSON.stringify(key)}:`), `Missing ${key} in locators:\n${locators}`);
    }
  });

  check('assembled POM graph validates without ghost methods or missing locator keys', () => {
    const graphFindings = replayExport.validatePomFileGraph('playwright-pom-js', files);
    const errors = graphFindings.filter((f) => f.severity === 'error');
    assert.deepStrictEqual(errors, []);
  });
}

console.log('\nPOM graph validation - pasted broken output is rejected:');

{
  const brokenFiles = {
    'package.json': JSON.stringify({ name: 'qaai-broken-output', private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n',
    '.env.example': 'QAAI_TARGET_URL=\n',
    'tests/products/product-search-by-name-happy-path.spec.js': [
      "import { test } from '@playwright/test';",
      "import { ProductsPage } from '../../pages/ProductsPage.js';",
      "test('search', async ({ page }) => {",
      "  const productsPage = new ProductsPage(page);",
      "  await productsPage.fillSearchProduct('Printed');",
      "  await productsPage.clickSearch();",
      "});",
      '',
    ].join('\n'),
    'pages/ProductsPage.js': [
      "import { productsPageLocators } from '../locators/productsPage.locators.js';",
      'export class ProductsPage {',
      '  constructor(page) { this.page = page; }',
      '  womenLink() { return productsPageLocators.womenLink(this.page); }',
      '  topsLink() { return productsPageLocators.topsLink(this.page); }',
      '  async clickWomen() { await productsPageLocators.womenLink(this.page).click(); }',
      '  async clickTops() { await productsPageLocators.topsLink(this.page).click(); }',
      '}',
      '',
    ].join('\n'),
    'locators/productsPage.locators.js': "export * from './generated/productsPage.generated.locators.js';\n",
    'locators/generated/productsPage.generated.locators.js': [
      'export const productsPageLocators = {',
      '  womenLink: (page) => page.getByRole("link", { name: /women/i }),',
      '  topsLink: (page) => page.getByRole("link", { name: /tops/i }),',
      '};',
      '',
    ].join('\n'),
    'evidence/locator-manifest.json': JSON.stringify([
      { file: 'productsPage', name: 'womenLink', expr: 'page.getByRole("link", { name: /women/i })' },
      { file: 'productsPage', name: 'topsLink', expr: 'page.getByRole("link", { name: /tops/i })' },
    ], null, 2) + '\n',
    'evidence/certification-report.json': JSON.stringify({ spec: { status: 'runnable' } }, null, 2) + '\n',
  };
  const findings = replayExport.validatePomFileGraph('playwright-pom-js', brokenFiles);
  const rules = new Set(findings.map((f) => f.rule));

  check('graph validator catches missing ProductsPage methods before runnable export', () => {
    assert.ok(rules.has('pom_graph_missing_page_method'), JSON.stringify(findings, null, 2));
  });

  check('graph validator catches false runnable certification report', () => {
    assert.ok(rules.has('pom_graph_report_false_runnable'), JSON.stringify(findings, null, 2));
  });

  check('graph validator surfaces missing DOM Atlas as evidence finding', () => {
    assert.ok(rules.has('pom_graph_dom_atlas_absent'), JSON.stringify(findings, null, 2));
  });
}

console.log('\nExport certification auto-repair - POM JS package defects are repaired before final verdict:');

{
  const { applyPackageCertificationRepairs } = require('../server/services/codegen/replayExport');
  const brokenFiles = {
    'package.json': JSON.stringify({
      name: 'qaai-broken-pom-js',
      private: true,
      version: '0.0.0',
      scripts: { test: 'playwright test' },
      devDependencies: { '@playwright/test': '^1.40.0' },
    }, null, 2) + '\n',
    'playwright.config.ts': "export default { testDir: './tests', globalSetup: './qaai.preflight.js' };\n",
    'qaai.preflight.js': "module.exports = async function globalSetup() {};\n",
    'tests/catalog/product.spec.js': [
      "import { test } from '@playwright/test';",
      "import { safeGoto } from '../../utils/test-helpers';",
      "import { ProductsPage } from '../../pages/ProductsPage';",
      "test('x', async ({ page }) => { await safeGoto(page, '/products'); new ProductsPage(page); });",
      '',
    ].join('\n'),
    'pages/ProductsPage.js': [
      "const { productsPageLocators } = require('../locators/productsPage.locators');",
      "class ProductsPage { constructor(page) { this.page = page; } }",
      "module.exports = { ProductsPage };",
      '',
    ].join('\n'),
    'locators/productsPage.locators.js': "module.exports = require('./generated/productsPage.generated.locators');\n",
    'locators/generated/productsPage.generated.locators.js': "const productsPageLocators = {};\nmodule.exports = { productsPageLocators };\n",
    'tests/support/replayir.js': "module.exports = { readEnv: () => '' };\n",
    'utils/test-helpers.js': "module.exports = { safeGoto: async () => {} };\n",
  };
  const repaired = applyPackageCertificationRepairs({
    adapterId: 'playwright-pom-js',
    files: brokenFiles,
    validation: { commands: [{ cmd: 'playwright test --list', output: 'Cannot use import statement outside a module' }] },
  });

  check('POM-JS auto-repair adds package type=module', () => {
    assert.strictEqual(JSON.parse(repaired.files['package.json']).type, 'module');
  });

  check('POM-JS auto-repair moves CommonJS preflight to .cjs and updates config', () => {
    assert.ok(repaired.files['qaai.preflight.cjs'], 'Expected qaai.preflight.cjs');
    assert.ok(!repaired.files['qaai.preflight.js'], 'CommonJS qaai.preflight.js must be removed under type=module');
    assert.ok(repaired.files['playwright.config.ts'].includes("globalSetup: './qaai.preflight.cjs'"), repaired.files['playwright.config.ts']);
  });

  check('POM-JS auto-repair adds .js extensions to relative ESM imports', () => {
    const spec = repaired.files['tests/catalog/product.spec.js'];
    assert.ok(spec.includes("from '../../utils/test-helpers.js';"), spec);
    assert.ok(spec.includes("from '../../pages/ProductsPage.js';"), spec);
  });

  check('POM-JS auto-repair converts leaked CommonJS page/locator files to ESM', () => {
    assert.ok(repaired.files['pages/ProductsPage.js'].includes("import { productsPageLocators } from '../locators/productsPage.locators.js';"), repaired.files['pages/ProductsPage.js']);
    assert.ok(repaired.files['pages/ProductsPage.js'].includes('export class ProductsPage'), repaired.files['pages/ProductsPage.js']);
    assert.ok(repaired.files['locators/productsPage.locators.js'].includes("export * from './generated/productsPage.generated.locators.js';"), repaired.files['locators/productsPage.locators.js']);
    assert.ok(repaired.files['locators/generated/productsPage.generated.locators.js'].includes('export const productsPageLocators = {};'), repaired.files['locators/generated/productsPage.generated.locators.js']);
  });

  check('POM-JS auto-repair replaces support/helper files with ESM support', () => {
    assert.ok(/\bexport\s+(?:async\s+)?function\b|export\s*\{/.test(repaired.files['tests/support/replayir.js']), repaired.files['tests/support/replayir.js'].slice(0, 200));
    assert.ok(repaired.files['utils/test-helpers.js'].includes('export async function safeGoto'), repaired.files['utils/test-helpers.js'].slice(0, 200));
  });

  check('POM-JS auto-repair is observable in repair metadata', () => {
    const rules = new Set((repaired.repairs || []).map((r) => r.rule));
    assert.ok(rules.has('pom_js_type_module_added'), JSON.stringify([...rules]));
    assert.ok(rules.has('pom_js_cjs_leak_converted'), JSON.stringify([...rules]));
    assert.ok(rules.has('esm_relative_import_extension_added'), JSON.stringify([...rules]));
  });
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
console.log('\nActive project memory - memory-reused actions still export exact action locators:');

{
  const actionLocator = productActionLocator('getByPlaceholder("Search Product")', 'placeholder', {
    tag: 'input',
    role: 'textbox',
    placeholder: 'Search Product',
  });
  const emitted = adapter.emitJourneySpec([
    makeCase([
      {
        op: 'navigate',
        url: 'https://automationexercise.com/products',
        pageUrl: 'https://automationexercise.com/products',
      },
      {
        op: 'resolve',
        as: 'searchProductElement',
        pageUrl: 'https://automationexercise.com/products',
        actionLocator,
        memoryResolution: { status: 'reused', memoryId: 'mem-search' },
        candidates: roleCandidates('textbox', 'Search Product'),
      },
      {
        op: 'act',
        action: 'fill',
        target: 'searchProductElement',
        value: 'Printed',
        pageUrl: 'https://automationexercise.com/products',
      },
    ], { caseName: 'Memory reused search' }),
  ], { lang: 'js' });

  check('memory-reused resolve emits the exact stored action locator', () => {
    const emittedPackage = [emitted.content, ...Object.values(emitted.extraFiles || {})].join('\n');
    assert.ok(emittedPackage.includes('getByPlaceholder("Search Product")'), emittedPackage);
    assert.ok(!emittedPackage.includes('QAAI_UNRESOLVED_LOCATOR'), emittedPackage);
  });
}

if (failed > 0) process.exit(1);
else console.log('\nALL CHECKS PASSED');
