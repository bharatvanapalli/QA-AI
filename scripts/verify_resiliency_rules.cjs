#!/usr/bin/env node
'use strict';
/**
 * Guard: resiliencyRules.js — semantic regex + .or() chain contracts.
 *
 * Verifies:
 *   1. Non-ASCII glyph stripping: "ï§ PIM" → /pim/i
 *   2. Leading badge removal: "(6) Polo" → /polo/i
 *   3. Trailing badge removal: "Polo (6)" → /polo/i
 *   4. Bare number prefix removal: "1 Item" → /item/i
 *   5. Stop-word filtering: "Navigation Menu" → all stop words → falls back to cleaned phrase
 *   6. Multi-token join: "Confirm Password" → /confirm.*password/i
 *   7. buildOrChain with 3 strategies → .or() chain
 *   8. buildOrChain with 1 strategy → single expression (no .or())
 *   9. nameArg returns regex literal syntax /pattern/i, not a quoted string
 *  10. buildOrChain skips 'text' strategy when other strategies exist
 *  11. force:true patterns NOT present in emitted fill/click in playwrightReference emitStep
 *  12. networkidle NOT in evaluateSettled in the emitted support file templates
 */

const path = require('path');
const base = path.resolve(__dirname, '..');
const { semanticRegex, nameArg, buildOrChain, buildOrChainParts, STOP_WORDS } = require(path.join(base, 'server/services/codegen/adapters/resiliencyRules'));
const fs = require('fs');

let pass = 0;
let fail = 0;

function assert(desc, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${desc}`);
    pass++;
  } else {
    console.error(`  ✗ ${desc}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}
function assertMatch(desc, value, pattern) {
  if (pattern.test(value)) {
    console.log(`  ✓ ${desc}`);
    pass++;
  } else {
    console.error(`  ✗ ${desc}`);
    console.error(`    value: ${JSON.stringify(value)}`);
    console.error(`    pattern: ${pattern}`);
    fail++;
  }
}
function assertNotMatch(desc, value, pattern) {
  if (!pattern.test(value)) {
    console.log(`  ✓ ${desc}`);
    pass++;
  } else {
    console.error(`  ✗ ${desc}`);
    console.error(`    value contains pattern ${pattern} but should not`);
    fail++;
  }
}

console.log('\n── resiliencyRules.js contracts ──\n');

// 1. Non-ASCII glyph strip
const glyph = semanticRegex(' PIM');  // non-ASCII prefix
assert('glyph strip: regex source is "pim"', glyph && glyph.source, 'pim');
assert('glyph strip: regex flags include i', glyph && glyph.flags.includes('i'), true);

// 2. Leading badge removal
const leading = semanticRegex('(6) Polo');
assert('leading badge: regex source is "polo"', leading && leading.source, 'polo');

// 3. Trailing badge removal
const trailing = semanticRegex('Polo (6)');
assert('trailing badge: regex source is "polo"', trailing && trailing.source, 'polo');

// 4. Bare number prefix removal
const numbered = semanticRegex('1 Item');
assert('number prefix: regex source is "item"', numbered && numbered.source, 'item');

// 5. Stop-word fall-through (all tokens are stop words)
const stopOnly = semanticRegex('Navigation Menu');
// Should produce a regex from the cleaned phrase, not null
assert('stop-word fallback: returns a regex', stopOnly !== null, true);

// 6. Multi-token join
const confirm = semanticRegex('Confirm Password');
assert('multi-token: source contains confirm.*password', confirm && confirm.source, 'confirm.*password');

// 7. nameArg returns regex literal syntax
assert('nameArg: username → /username/i', nameArg('Username'), '/username/i');
assert('nameArg: pim → /pim/i', nameArg('PIM'), '/pim/i');

// 8. nameArg for glyph-prefixed name
const gArg = nameArg(' PIM');
assert('nameArg: glyph PIM → /pim/i', gArg, '/pim/i');

// 9. buildOrChain with 3 strategies
const cands3 = [
  { strategy: 'role', role: 'textbox', name: 'Username' },
  { strategy: 'label', text: 'Username' },
  { strategy: 'placeholder', text: 'Username' },
];
const chain3 = buildOrChain(cands3);
assertMatch('or-chain 3 strategies: contains getByRole', chain3, /getByRole/);
assertMatch('or-chain 3 strategies: contains getByLabel', chain3, /getByLabel/);
assertMatch('or-chain 3 strategies: contains getByPlaceholder', chain3, /getByPlaceholder/);
assertMatch('or-chain 3 strategies: contains .or(', chain3, /\.or\(/);
assertMatch('or-chain 3 strategies: uses regex /username/i not exact string', chain3, /\/username\/i/);
assertNotMatch('or-chain 3 strategies: no exact string "Username"', chain3, /"Username"/);

// 10. buildOrChain single strategy
const cands1 = [{ strategy: 'role', role: 'button', name: 'Login' }];
const chain1 = buildOrChain(cands1);
assertNotMatch('single strategy: no .or(', chain1, /\.or\(/);
assertMatch('single strategy: getByRole button', chain1, /getByRole.*button/);
assertMatch('single strategy: regex /login/i', chain1, /\/login\/i/);

// 11. buildOrChain skips 'text' strategy when role exists
const withText = [
  { strategy: 'role', role: 'link', name: 'Women' },
  { strategy: 'text', text: 'Women' },
];
const chainText = buildOrChain(withText);
assertNotMatch('skips text strategy when role exists', chainText, /getByText/);

// 12. { force: true } not in emitStep output
const refSrc = fs.readFileSync(path.join(base, 'server/services/codegen/adapters/playwrightReference.js'), 'utf8');
// Check in the emitStep function body (line range where fill/click are emitted)
const emitStepMatch = refSrc.match(/function emitStep[\s\S]*?^}/m);
if (emitStepMatch) {
  assertNotMatch('emitStep: no { force: true } on fill', emitStepMatch[0], /fill\([^)]*force:\s*true/);
  assertNotMatch('emitStep: no { force: true } on click', emitStepMatch[0], /click\(\s*\{\s*force:\s*true/);
} else {
  console.error('  ✗ emitStep function not found in playwrightReference.js');
  fail++;
}

// 13. evaluateSettled uses 'load' not 'networkidle' in waitForLoadState calls
// Check only the actual waitForLoadState call lines inside the evaluateSettled function bodies
// (not comments that say "not networkidle"). Pattern: waitForLoadState('networkidle' should be absent.
assertNotMatch('support templates: waitForLoadState uses no networkidle', refSrc, /waitForLoadState\(\s*'networkidle'/);

// 14. contextSwitchInferred: playwrightReference.js emitStep handles navigate+contextSwitchInferred
assertMatch('emitStep: handles contextSwitchInferred navigate', refSrc, /contextSwitchInferred/);
assertMatch('emitStep: contextSwitchInferred emits multi-tab comment', refSrc, /target.*_blank|browser tab switch/i);
assertMatch('emitStep: contextSwitchInferred includes Promise.all waitForEvent hint', refSrc, /Promise\.all.*waitForEvent.*page/);

// 15. playwrightPom.js pomEmitAct handles contextSwitchInferred navigate
const pomSrc = fs.readFileSync(path.join(base, 'server/services/codegen/adapters/playwrightPom.js'), 'utf8');
assertMatch('pomEmitAct: handles contextSwitchInferred navigate', pomSrc, /contextSwitchInferred/);
assertMatch('pomEmitAct: contextSwitchInferred includes Promise.all hint', pomSrc, /Promise\.all.*waitForEvent.*page/);

// 16. replayEmitter.js emits _emitContextSwitchIfNeeded helper
const emitterSrc = fs.readFileSync(path.join(base, 'server/services/codegen/replayEmitter.js'), 'utf8');
assertMatch('replayEmitter: _emitContextSwitchIfNeeded helper defined', emitterSrc, /_emitContextSwitchIfNeeded/);
assertMatch('replayEmitter: context_switch_inferred gap code used', emitterSrc, /context_switch_inferred/);
assertMatch('replayEmitter: contextSwitchInferred flag set on navigate step', emitterSrc, /contextSwitchInferred:\s*true/);
assertMatch('replayEmitter: activePageUrl tracked across navigate steps', emitterSrc, /activePageUrl/);

console.log(`\n── ${pass} passed, ${fail} failed ──\n`);
if (fail > 0) process.exit(1);
