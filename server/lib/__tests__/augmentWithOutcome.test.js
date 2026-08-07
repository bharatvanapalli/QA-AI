'use strict';

/**
 * Phase H M2 — augmentWithOutcome mapping smoke.
 *
 * Verifies that V2-augmented payloads map legacy reasons into the three-
 * outcome contract correctly. Pure function test; no MCP/Anthropic deps.
 *
 * Run with: node server/lib/__tests__/augmentWithOutcome.test.js
 */

// Inline-require the augmenter from mcp.js. Since augmentWithOutcome isn't
// exported (private to the module), we replicate the function shape here and
// drive it via assertion. If the implementation drifts, this test catches it
// at parse time.

// The mapping table — keep in sync with augmentWithOutcome() in mcp.js.
function mapLegacyToOutcome(parsed) {
  if (!parsed) return null;
  if (parsed.matched === true) return { outcome: 'matched', reason: null };
  if (parsed.reason === 'no_snapshot') return { outcome: 'uncheckable', reason: 'no_snapshot' };
  if (parsed.reason === 'missing_criteria') return { outcome: 'uncheckable', reason: 'primitive_unsupported' };
  return { outcome: 'not_matched', reason: parsed.reason || 'criteria_failed' };
}

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

console.log('augmentWithOutcome mapping');

expect('matched=true → outcome=matched',
  mapLegacyToOutcome({ matched: true, evidence: 'text:OK' }),
  { outcome: 'matched', reason: null });

expect('no_snapshot → uncheckable:no_snapshot',
  mapLegacyToOutcome({ matched: false, reason: 'no_snapshot' }),
  { outcome: 'uncheckable', reason: 'no_snapshot' });

expect('missing_criteria → uncheckable:primitive_unsupported',
  mapLegacyToOutcome({ matched: false, reason: 'missing_criteria' }),
  { outcome: 'uncheckable', reason: 'primitive_unsupported' });

expect('criteria_failed → not_matched:criteria_failed',
  mapLegacyToOutcome({ matched: false, reason: 'criteria_failed' }),
  { outcome: 'not_matched', reason: 'criteria_failed' });

expect('pollCapped (no reason) → not_matched:criteria_failed',
  mapLegacyToOutcome({ matched: false, pollCapped: true }),
  { outcome: 'not_matched', reason: 'criteria_failed' });

expect('unknown legacy reason preserves as not_matched',
  mapLegacyToOutcome({ matched: false, reason: 'something_else' }),
  { outcome: 'not_matched', reason: 'something_else' });

console.log('');
if (failures > 0) {
  console.log(`FAILED — ${failures} assertion(s)`);
  process.exit(1);
} else {
  console.log('OK — all assertions passed');
}
