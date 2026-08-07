'use strict';
// Deterministic unit test for P2 locator replay — no LLM, no credits.
const L = require('../server/services/codegen/_locators');
const assert = require('assert');

// Fake KB rows as recordSuccessfulLocator would have written them.
const kbRows = [
  { element: 'Search', role: 'button', accessibleName: 'Search', selector: 'getByRole("button", { name: "Search" })', strategy: 'role', healthScore: 100, occurrences: 4, pageUrl: '/pim' },
  { element: 'Username', role: 'textbox', accessibleName: 'Username', selector: 'getByRole("textbox", { name: "Username" })', strategy: 'role', healthScore: 100, occurrences: 9, pageUrl: '/auth/login' },
  { element: 'Quarantined thing', role: 'button', accessibleName: 'Flaky', selector: 'getByText("Flaky")', strategy: 'text', healthScore: 12, occurrences: 1, pageUrl: '/x' },
];

// elementLabelFromArgs stand-in: pull a human label off the args.
const labelOf = (a) => a.args && (a.args.element || a.args.label) || null;

const actions = [
  { tool: 'browser_navigate', args: { url: '/auth/login' } },
  { tool: 'browser_type', args: { element: 'Username', text: 'Admin' } },
  { tool: 'browser_click', args: { element: 'Search' } },
  { tool: 'browser_click', args: { element: 'Quarantined thing' } }, // below MIN_HEALTH → not bound
  { tool: 'browser_click', args: { element: 'No Such Element' } },    // no KB row → not bound
];

// --- Playwright binding ---
const pw = L.buildManifest({ actions, kbRows, labelOf, lang: 'ts' });
assert.equal(pw.actions[0].locator, undefined, 'navigate has no element → no locator');
assert.equal(pw.actions[1].locator.expression, 'getByRole("textbox", { name: "Username" })', 'username bound to recorded role+name');
assert.equal(pw.actions[2].locator.expression, 'getByRole("button", { name: "Search" })', 'search bound to recorded role+name');
assert.equal(pw.actions[3].locator, undefined, 'quarantined KB row (health<30) is NOT replayed');
assert.equal(pw.actions[4].locator, undefined, 'unknown element gets no locator (model derives)');
assert.equal(pw.manifest.length, 2, 'manifest deduped to the 2 healthy bound elements');

// --- Selenium binding (java) ---
const jv = L.buildManifest({ actions, kbRows, labelOf, lang: 'java' });
assert.ok(/^By\.xpath\(/.test(jv.actions[2].locator.expression), 'java emits a By.xpath grounded in the accessible name');
assert.ok(jv.actions[2].locator.expression.includes('Search'), 'java By carries the recorded name');

// --- Prompt blocks present and language-correct ---
assert.ok(L.locatorPromptBlock({ lang: 'ts' }).includes('page.<expression>'), 'ts prompt shows page.<expression>');
assert.ok(L.locatorPromptBlock({ lang: 'java' }).includes('driver.findElement'), 'java prompt shows driver.findElement');
assert.ok(/GROUND TRUTH/.test(L.locatorPromptBlock({ lang: 'ts' })), 'prompt frames locators as ground truth');

// --- Digest ---
const dg = L.manifestDigest(pw.manifest);
assert.ok(dg.includes('"Search" → getByRole'), 'digest renders intent → expression');

console.log('PASS — locator replay binds deterministically:');
console.log('  username →', pw.actions[1].locator.expression);
console.log('  search   →', pw.actions[2].locator.expression);
console.log('  java     →', jv.actions[2].locator.expression);
console.log('  manifest entries:', pw.manifest.length, '| quarantined+unknown correctly skipped');
