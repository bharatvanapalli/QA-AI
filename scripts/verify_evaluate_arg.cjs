'use strict';
/* Guard: a recorded browser_evaluate script must be wrapped so Playwright runs it IN
 * THE BROWSER, never eagerly in Node. Locks the generic shape-based rule (no site strings).
 * Regression: run 707ba2ac emitted `page.evaluate(document.cookie.length > 0)` → Node
 * ReferenceError, a crash absent from the live run. */
const path = require('path');
const { evaluateArg, emitAssertion } = require(path.join(__dirname, '..', 'server', 'services', 'codegen', 'adapters', 'playwrightReference'));

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } else { console.log('  ok:', msg); } };

// 1. bare expression (the real regression) → arrow-wrapped expression, no bare document in Node position
{
  const out = evaluateArg('document.cookie.length > 0');
  ok(out === '() => (document.cookie.length > 0)', `bare expr wrapped: ${out}`);
}
// 2. statements with return → block-bodied arrow
{
  const out = evaluateArg('const x = document.title; return x.length > 0;');
  ok(/^\(\) => \{ .*return .* \}$/.test(out), `return-statements wrapped in block arrow: ${out}`);
}
// 2b. IIFE / parenthesized expression — return its VALUE, never run-and-discard (regression:
//     run bc723b73 emitted () => { (function(){…return…})() } → "undefined" → false failure).
{
  const iife = '(function(){ var b = document.body.textContent; return !b.includes("SQL"); })()';
  const out = evaluateArg(iife);
  ok(out === `() => (${iife})`, `IIFE wrapped to return its value: ${out}`);
  ok(!/=>\s*\{/.test(out), 'IIFE NOT wrapped as run-and-discard block');
}
{
  const arrowIife = '(() => { return document.querySelectorAll(".err").length; })()';
  ok(evaluateArg(arrowIife) === `() => (${arrowIife})`, 'arrow-IIFE wrapped as expression');
}
// 3. already an arrow function → passed through unchanged
{
  const src = '() => document.cookie.length > 0';
  ok(evaluateArg(src) === src, `arrow fn passthrough: ${evaluateArg(src)}`);
}
// 4. already an async arrow → passthrough
{
  const src = 'async () => { return await fetch("/x").then(r => r.ok); }';
  ok(evaluateArg(src) === src, `async arrow passthrough`);
}
// 5. classic function literal → passthrough
{
  const src = 'function () { return window.scrollY; }';
  ok(evaluateArg(src) === src, `function literal passthrough`);
}
// 6. empty/nullish → safe no-op fn, never crashes
{
  ok(evaluateArg('') === '() => undefined', `empty → () => undefined`);
  ok(evaluateArg(null) === '() => undefined', `null → () => undefined`);
}
// 7. END-TO-END through emitAssertion: the emitted spec line must NOT contain a bare
//    `page.evaluate(document` (eager Node eval) and MUST contain the wrapped form.
{
  const line = emitAssertion({ op: 'assert', channel: 'EVALUATE', contractRef: 'ASN-x', script: 'document.cookie.length > 0', expected: 'true' });
  ok(!/\.evaluate\(document/.test(line), 'emitAssertion: no bare .evaluate(document');
  ok(/evaluateSettled\(page, \(\) => \(document\.cookie\.length > 0\)\)/.test(line), 'emitAssertion: wrapped browser fn via evaluateSettled');
}

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_evaluate_arg: all checks passed');
