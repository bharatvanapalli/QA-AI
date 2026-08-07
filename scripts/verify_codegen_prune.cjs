'use strict';
/**
 * Guard tests for codegen correctness improvements:
 *  [A] Descriptor stripping — "Products nav"→"Products", "Women category"→"Women", "Login badge"→"Login"
 *  [B] Same-page reload prune — browser_type at /X then navigate(/X) → navigate is dead
 *  [C] Click-navigate overridden — click(navigated) then explicit navigate → click is dead (Pattern 2)
 *  [D] Navigate→navigate dead (Pattern 1) — navigate(/A) then navigate(/B) → /A is dead
 *  [E] expectedRef binding — fill "Printed" → assert expectedText "Printed" → step.expectedRef set
 *  [F] No prune when passed assertion between actions — assert(matched) between actions guards them
 *  [G] All three frameworks emit expectedRef — Playwright readEnv, Selenium EnvReader, BDD seeEnvText
 *
 *   node scripts/verify_codegen_prune.cjs
 */
const { buildReplayIR } = require('../server/services/codegen/replayEmitter');
const { semanticNameForRole, normalizeCandidates } = require('../server/services/codegen/adapters/_candidateNormalize');
const pwRef = require('../server/services/codegen/adapters/playwrightReference');
const selenium = require('../server/services/codegen/adapters/seleniumReference');
const { getAdapter } = require('../server/services/codegen/adapters');
const { compileReplayIR } = require('../server/services/codegen/adapters/frameworkAdapter');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

// ─── [A] Descriptor stripping ──────────────────────────────────────────────
console.log('\n[A] Descriptor stripping');

assert(semanticNameForRole('link', 'Products nav') === 'Products',
  'semanticNameForRole strips "nav" suffix from link → "Products"');
assert(semanticNameForRole('link', 'Women category') === 'Women',
  'semanticNameForRole strips "category" suffix from link → "Women"');
assert(semanticNameForRole('button', 'Login badge') === 'Login',
  'semanticNameForRole strips "badge" suffix from button → "Login"');
assert(semanticNameForRole('button', 'Submit chip') === 'Submit',
  'semanticNameForRole strips "chip" suffix from button → "Submit"');
assert(semanticNameForRole('link', 'Home navigation') === 'Home',
  'semanticNameForRole strips "navigation" suffix from link → "Home"');
// Names without descriptor suffixes must be preserved
assert(semanticNameForRole('link', 'Women') === 'Women',
  'clean name "Women" not modified');
assert(semanticNameForRole('button', 'Search') === 'Search',
  'clean name "Search" not modified');

// Through the normalizeCandidates pipeline (how the adapter actually calls it)
const navCandidates = normalizeCandidates([
  { strategy: 'role', role: 'link', name: 'Products nav' },
  { strategy: 'role', role: 'link', name: 'Women category' },
  { strategy: 'role', role: 'button', name: 'Search button' },
]);
assert(navCandidates[0]?.name === 'Products',
  'normalizeCandidates pipeline: "Products nav" → "Products"');
assert(navCandidates[1]?.name === 'Women',
  'normalizeCandidates pipeline: "Women category" → "Women"');
assert(navCandidates[2]?.name === 'Search',
  'normalizeCandidates pipeline: "Search button" → "Search"');

// Through full IR → emitLocatorResolver
{
  const ir = buildReplayIR({
    caseId: 'TC-NAV',
    trail: [
      { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' } },
      { tool: 'browser_click', ok: true, args: { element: 'Products nav', role: 'link' } },
      { tool: 'browser_click', ok: true, args: { element: 'Women category', role: 'link' } },
    ],
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Women' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  }).ir;
  const spec = pwRef.emitJourneySpec([{ ir, caseName: 'Nav test' }], { scenarioName: 'Nav' });
  assert(spec.includes('name: "Products"') && !spec.includes('"Products nav"'),
    'emitted spec uses "Products" not "Products nav"');
  assert(spec.includes('name: "Women"') && !spec.includes('"Women category"'),
    'emitted spec uses "Women" not "Women category"');
}

// ─── [B] Same-page reload prune (Pattern 3) ────────────────────────────────
console.log('\n[B] Same-page reload prune after browser_type');

{
  const trail = [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' } },
    { tool: 'browser_type', ok: true, args: { element: 'Search Product searchbox', text: 'Printed' }, pageUrl: 'https://example.com/products' },
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' }, pageUrl: 'https://example.com/products' },
    { tool: 'browser_click', ok: true, args: { element: 'Search button' } },
  ];
  const { ir } = buildReplayIR({
    caseId: 'TC-RELOAD', trail,
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Printed' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const navSteps = ir.steps.filter(s => s.op === 'act' && s.action === 'navigate');
  assert(navSteps.length === 1,
    'only the initial navigate survives; same-URL reload after fill is pruned');
  assert(navSteps[0].url === 'https://example.com/products',
    'surviving navigate is the initial page load, not the redundant reload');
  const fillStep = ir.steps.find(s => s.op === 'act' && s.action === 'fill');
  const clickStep = ir.steps.find(s => s.op === 'act' && s.action === 'click');
  assert(!!fillStep && !!clickStep,
    'fill and click are both preserved after pruning the same-URL reload');
  // In the emitted spec there must be no page.goto between fill and click
  const spec = pwRef.emitJourneySpec([{ ir, caseName: 'Search' }], { scenarioName: 'S' });
  const lines = spec.split('\n');
  const fillIdx = lines.findIndex(l => l.includes('.fill('));
  const clickIdx = lines.findIndex(l => l.includes('.click()'));
  const gotosBetween = lines.slice(fillIdx + 1, clickIdx).filter(l => l.includes('page.goto'));
  assert(gotosBetween.length === 0,
    'no page.goto() between fill and click in emitted spec');
}

// browser_fill_form variant
{
  const trail = [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' } },
    { tool: 'browser_fill_form', ok: true, args: { fields: [{ name: 'Search', type: 'searchbox', value: 'Printed' }] }, pageUrl: 'https://example.com/products' },
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' }, pageUrl: 'https://example.com/products' },
    { tool: 'browser_click', ok: true, args: { element: 'Search button' } },
  ];
  const { ir } = buildReplayIR({
    caseId: 'TC-RELOAD-FF', trail,
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Printed' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const navCount = ir.steps.filter(s => s.op === 'act' && s.action === 'navigate').length;
  assert(navCount === 1,
    'browser_fill_form variant: same-URL reload after fill_form also pruned');
}

// ─── [C] Click-navigate overridden (Pattern 2) ────────────────────────────
console.log('\n[C] Click that navigated, immediately overridden by explicit navigate');

{
  const trail = [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' } },
    { tool: 'browser_click', ok: true, args: { element: 'Women category link' }, pageUrl: 'https://example.com/products', pageUrlAfter: 'https://example.com/women' },
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/search' } },
  ];
  const { ir } = buildReplayIR({
    caseId: 'TC-CLICK-NAV', trail,
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Search' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  // Only the explicit navigate to /search should survive; the click to /women is dead
  const navSteps = ir.steps.filter(s => s.op === 'act' && s.action === 'navigate');
  const clickSteps = ir.steps.filter(s => s.op === 'act' && s.action === 'click');
  assert(navSteps.some(s => s.url === 'https://example.com/search'),
    'explicit navigate to /search is preserved');
  // The pruner is single-pass: it marks the click dead because click→navigate fires Pattern 2.
  // The initial navigate(/products) is NOT re-evaluated after the click is removed — it remains.
  // This is correct: "start at /products" is the setup context, not a redundant navigation.
  assert(navSteps.some(s => s.url === 'https://example.com/products'),
    'initial navigate to /products preserved (pruner is single-pass; setup context kept)');
  assert(clickSteps.length === 0,
    'click that navigated to /women is pruned (overridden by explicit /search navigate)');
}

// ─── [D] Navigate→navigate dead (Pattern 1) ────────────────────────────────
console.log('\n[D] Navigate→navigate — first is dead when no passed assertion between');

{
  const trail = [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/a' } },
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/b' } },
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/c' } },
  ];
  const { ir } = buildReplayIR({
    caseId: 'TC-DEAD-NAV', trail,
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Page C' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const navUrls = ir.steps.filter(s => s.op === 'act' && s.action === 'navigate').map(s => s.url);
  // /a and /b are dead; only /c (the final destination) survives
  // Note: consecutive-same-URL dedup also applies so /b→/c prunes /b
  assert(!navUrls.includes('https://example.com/a'),
    'first dead navigate (/a) pruned');
  assert(navUrls.includes('https://example.com/c'),
    'final navigate (/c) preserved');
}

// ─── [E] expectedRef binding ───────────────────────────────────────────────
console.log('\n[E] expectedRef binding — fill literal matches assertion expected');

{
  const trail = [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/products' } },
    { tool: 'browser_type', ok: true, args: { element: 'Search Product searchbox', text: 'Printed' }, pageUrl: 'https://example.com/products' },
    { tool: 'browser_click', ok: true, args: { element: 'Search button' } },
  ];
  const { ir } = buildReplayIR({
    caseId: 'TC-EXPREF', trail,
    declaredAssertions: [
      { id: 'A1', type: 'TEXT', payload: { expectedText: 'Printed' } },   // matches fill → gets expectedRef
      { id: 'A2', type: 'TEXT', payload: { expectedText: 'Products' } },  // no fill match → no expectedRef
    ],
    assertionOutcomes: [
      { assertionId: 'A1', outcome: 'matched' },
      { assertionId: 'A2', outcome: 'matched' },
    ],
    verdictStatus: 'pass',
  });
  const a1 = ir.steps.find(s => s.op === 'assert' && s.contractRef === 'A1');
  const a2 = ir.steps.find(s => s.op === 'assert' && s.contractRef === 'A2');
  assert(a1 && a1.expectedRef && /^env:/i.test(a1.expectedRef),
    'A1: assertion whose expected value was filled gets expectedRef (env: scheme)');
  assert(a2 && !a2.expectedRef,
    'A2: assertion with unrelated expected value has no expectedRef');

  // Playwright emits readEnv() for expectedRef
  const spec = pwRef.emitJourneySpec([{ ir, caseName: 'Search' }], { scenarioName: 'S' });
  // The fill step inlines rawValue: await el.fill("Printed") — that's correct for test fidelity.
  // The ASSERTION line must use readEnv() — fill and assertion share the same runtime source.
  // Match only the await call lines, not the import statement that also names assertTextPresent
  const assertLine = spec.split('\n').find(l => l.includes('await') && (l.includes('assertTextPresent(') || l.includes('toContainText(')));
  assert(assertLine && assertLine.includes('readEnv('),
    'Playwright: assertion line uses readEnv() for the data-bound check (fill inlines raw value)');
}

// ─── [F] No prune when passed assertion between actions ────────────────────
console.log('\n[F] No pruning when passed assertion_check exists between actions');

{
  const trail = [
    // navigate to /a, then assertion passes (page state matters), then navigate to /b
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/a' } },
    { tool: 'assertion_check', ok: true, tool: 'assertion_check', matched: true },  // passed assertion: /a state matters
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/b' } },
  ];
  const { ir } = buildReplayIR({
    caseId: 'TC-GUARD', trail,
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'B page' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const navUrls = ir.steps.filter(s => s.op === 'act' && s.action === 'navigate').map(s => s.url);
  // /a must NOT be pruned because a passed assertion happened before /b
  assert(navUrls.includes('https://example.com/a'),
    'navigate to /a preserved — passed assertion between /a and /b guards it from pruning');
  assert(navUrls.includes('https://example.com/b'),
    'navigate to /b also preserved');
}

// ─── [G] All three frameworks consume expectedRef ─────────────────────────
console.log('\n[G] expectedRef consumed by Playwright, Selenium, and BDD');

{
  // Minimal IR with an expectedRef assert step
  const irWithRef = {
    version: 1, caseId: 'TC-REF',
    authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
    steps: [
      { op: 'act', action: 'navigate', url: 'https://example.com' },
      { op: 'resolve', as: 'el1', candidates: [{ strategy: 'role', role: 'searchbox', name: 'Search' }] },
      { op: 'act', target: 'el1', action: 'fill', valueRef: 'env:QAAI_SEARCH_TERM', rawValue: 'Printed' },
      { op: 'assert', contractRef: 'A1', channel: 'UI_TEXT', expected: 'Printed', expectedRef: 'env:QAAI_SEARCH_TERM', evidence: { source: 'MCP', outcome: 'matched' } },
    ],
    verdict: { status: 'pass', perAssertionOutcomes: [{ contractRef: 'A1', status: 'pass' }] },
  };

  // Playwright TS — assertion line must use readEnv; fill line may still inline rawValue
  const pwAdapter = getAdapter('playwright-reference');
  const pwCompiled = compileReplayIR(pwAdapter, irWithRef);
  const pwSpec = Object.values(pwCompiled.files).find(f => f.includes('test('));
  const pwAssertLine = (pwSpec || '').split('\n').find(l => l.includes('await') && (l.includes('assertTextPresent(') || l.includes('toContainText(')));
  assert(pwAssertLine && pwAssertLine.includes('readEnv("QAAI_SEARCH_TERM")'),
    'Playwright TS: assertion line uses readEnv("QAAI_SEARCH_TERM")');

  // Playwright JS journey — emitJourneySpecJs is on the nested playwrightReferenceJs object
  const jsJourney = pwRef.playwrightReferenceJs.emitJourneySpec([{ ir: irWithRef, caseName: 'Search' }], { scenarioName: 'S' });
  const jsAssertLine = jsJourney.split('\n').find(l => l.includes('await') && (l.includes('assertTextPresent(') || l.includes('toContainText(')));
  assert(jsAssertLine && jsAssertLine.includes('readEnv("QAAI_SEARCH_TERM")'),
    'Playwright JS journey: assertion line uses readEnv("QAAI_SEARCH_TERM")');

  // Selenium — adapter ID is 'selenium-reference'; assertion must use EnvReader.read
  const seleniumAdapter = getAdapter('selenium-reference');
  let seSpec = '';
  try {
    const seCompiled = compileReplayIR(seleniumAdapter, irWithRef);
    seSpec = Object.values(seCompiled.files).find(f => f.includes('Assert')) || '';
  } catch (e) { bad('Selenium compile threw: ' + e.message); }
  const seAssertLine = seSpec.split('\n').find(l => l.includes('Assert.assertTrue') || l.includes('seesText'));
  assert(seAssertLine && seAssertLine.includes('EnvReader.read("QAAI_SEARCH_TERM")'),
    'Selenium: assertion uses EnvReader.read("QAAI_SEARCH_TERM")');

  // BDD — replayIrBdd is not in the adapter registry; call renderIr directly
  const replayIrBdd = require('../server/services/codegen/adapters/replayIrBdd');
  const bddResult = replayIrBdd.renderIr(irWithRef);
  const bddLines = (bddResult.lines || []).map(l => l.text);
  assert(bddLines.some(t => t.includes('env text "QAAI_SEARCH_TERM"')),
    'BDD renderIr: step includes "I should see env text \\"QAAI_SEARCH_TERM\\""');
}

// ─── Final result ──────────────────────────────────────────────────────────
console.log(`\n${failures === 0
  ? 'PASS — descriptor-strip, prune-patterns-1/2/3, guard-no-prune, expectedRef-all-frameworks'
  : `FAIL — ${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
