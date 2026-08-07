'use strict';

/**
 * Tests for the tolerant URL-pattern matcher used by expectedUrlPattern /
 * unexpectedUrlPattern verification. Locks in the saucedemo regression
 * where the LLM over-escaped \. → \\. and produced a FALSE
 * agent_never_reached on a perfectly-correct /inventory.html page.
 *
 * Run with: node server/services/__tests__/matchUrlPattern.test.js
 */

const { matchUrlPattern } = require('../mcp');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

console.log('STAGE 1 — well-formed regex patterns (no rescue needed)');
{
  const r = matchUrlPattern('/inventory\\.html', 'https://www.saucedemo.com/inventory.html');
  expect('correct \\. pattern matches via regex_original', { matched: r.matched, stage: r.stage }, { matched: true, stage: 'regex_original' });
}
{
  const r = matchUrlPattern('/dashboard', 'https://example.com/dashboard');
  expect('plain path matches via regex_original', { matched: r.matched, stage: r.stage }, { matched: true, stage: 'regex_original' });
}
{
  const r = matchUrlPattern('(login|signup)', 'https://example.com/login');
  expect('alternation regex matches via regex_original', { matched: r.matched, stage: r.stage }, { matched: true, stage: 'regex_original' });
}

console.log('');
console.log('STAGE 1 — case-insensitive rescue');
{
  const r = matchUrlPattern('/Login', 'https://example.com/login');
  expect('case-mismatched path matches (regex_original, /i flag)', { matched: r.matched, stage: r.stage }, { matched: true, stage: 'regex_original' });
}
{
  const r = matchUrlPattern('/INVENTORY', 'https://example.com/inventory.html');
  expect('uppercase pattern, lowercase URL — match', { matched: r.matched, stage: r.stage }, { matched: true, stage: 'regex_original' });
}

console.log('');
console.log('STAGE 2 — LLM over-escape rescue (the saucedemo regression)');
{
  // This is what was actually corrupted on the live run: the LLM sent
  // \\. instead of \.; new RegExp built a pattern looking for literal
  // backslash + dot in the URL.
  const overEscaped = '/inventory\\\\.html'; // in-memory chars: /, i, n, v, e, n, t, o, r, y, \, \, ., h, t, m, l
  const url = 'https://www.saucedemo.com/inventory.html';
  const r = matchUrlPattern(overEscaped, url);
  expect('over-escaped pattern rescued via stage 2 OR stage 3', r.matched, true);
  // Either stage works for this input; the rescue tag tells QA which
  // stage saved the day. We accept both as "rescued, not original".
  expect('rescue stage is not regex_original', r.stage !== 'regex_original', true);
}
{
  const overEscaped = '/dashboard\\\\.html';
  const r = matchUrlPattern(overEscaped, 'https://app.example.com/dashboard.html');
  expect('over-escape on a different SUT still rescued', r.matched, true);
}

console.log('');
console.log('STAGE 3 — anchor-on-full-URL rescue');
{
  // ^/inventory$ never matches a full https://host/inventory URL
  // because the protocol prefix violates ^. Semantic path compare
  // strips the anchors and compares against URL's pathname.
  const anchored = '^/inventory\\.html$';
  const r = matchUrlPattern(anchored, 'https://www.saucedemo.com/inventory.html');
  expect('^path$ matches via path_exact', r.matched, true);
  expect('rescue stage is path_*', r.stage.startsWith('path_'), true);
}
{
  const r = matchUrlPattern('^/login$', 'https://idp.example.com/login');
  expect('^/login$ on full URL matches via path stage', r.matched, true);
}

console.log('');
console.log('STAGE 3 — purely-literal path (no regex escapes at all)');
{
  // Architect or LLM emitted a plain path with no regex escape on
  // the dot. Stage 1 actually matches via regex (the unescaped . in
  // the regex matches the literal . in the URL). So this lands in
  // stage 1; we test that it still works.
  const r = matchUrlPattern('/checkout.html', 'https://www.saucedemo.com/checkout.html');
  expect('plain dot pattern matches (stage 1)', r.matched, true);
}
{
  // Pattern is the URL pathname verbatim
  const r = matchUrlPattern('/cart.html', 'https://www.saucedemo.com/cart.html?foo=bar');
  expect('path matches URL with query string', r.matched, true);
}

console.log('');
console.log('NEGATIVE — patterns that should genuinely NOT match');
{
  const r = matchUrlPattern('/admin', 'https://example.com/login');
  expect('wrong-path pattern does not match', r.matched, false);
  expect('stage is no_match', r.stage, 'no_match');
}
{
  // Complex regex with brackets — semantic path-compare deliberately
  // skips this and trusts regex_original's verdict.
  const r = matchUrlPattern('[0-9]{5}', 'https://example.com/inventory');
  expect('regex-only pattern that does not match URL stays no_match', r.matched, false);
}
{
  // Stripped anchors must still preserve mismatch on wrong paths
  const r = matchUrlPattern('^/admin$', 'https://example.com/login');
  expect('^/admin$ does not match /login (path stage correctly rejects)', r.matched, false);
}

console.log('');
console.log('EDGE CASES — invalid inputs');
{
  expect('empty pattern',  matchUrlPattern('', 'https://example.com').matched, false);
  expect('empty url',      matchUrlPattern('/login', '').matched, false);
  expect('null pattern',   matchUrlPattern(null, 'https://example.com').matched, false);
  expect('undefined url',  matchUrlPattern('/login', undefined).matched, false);
}
{
  // Malformed regex — stage 1 throws and is skipped; stage 3 still
  // attempts semantic path compare on the literal text.
  const r = matchUrlPattern('[unclosed', 'https://example.com/[unclosed');
  // We don't assert truthiness here — what matters is the matcher
  // doesn't THROW. It either matches via path_contains or returns
  // no_match; both are acceptable.
  expect('malformed regex did not throw', typeof r.matched, 'boolean');
}

console.log('');
console.log('REGRESSION — the literal saucedemo trace');
{
  // From the trial run trace, exactly as the LLM produced it.
  const pattern = '/inventory\\\\.html'; // displayed in the trace as /inventory\\.html
  const url = 'https://www.saucedemo.com/inventory.html';
  const r = matchUrlPattern(pattern, url);
  expect('saucedemo inventory failure is now rescued', r.matched, true);
  expect('rescue is not regex_original (would have failed)', r.stage !== 'regex_original', true);
}

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
