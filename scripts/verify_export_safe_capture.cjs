#!/usr/bin/env node
/**
 * GUARD: export-safe locator capture & emission (TIER 1 spine).
 *
 * Proves the architectural separation that fixes the "passed run → empty/legacy_inert
 * output" class:
 *   1. isExportSafeActionLocator accepts a faithful ARIA-derived (snapshot_ref_fallback)
 *      getByRole locator that the stricter isVerifiedActionLocator (GOLD) rejects.
 *   2. buildReplayIR EMITS a resolve+act step for a click whose only evidence is an
 *      export-safe codegen locator (the Login/Save smoking gun) — it is NOT dropped
 *      as legacy_inert, and the run is complete.
 *   3. The emitted step is honestly flagged locatorConfidence:'unverified'.
 *   4. A genuinely nameless element receives an explicitly guessed resolve whose
 *      provenance retains the diagnosable source gap (strategiesTried/ref).
 *
 * Run: node scripts/verify_export_safe_capture.cjs
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const resolver = require('../server/services/actionLocatorResolver');
const { buildReplayIR } = require('../server/services/codegen/replayEmitter');

let failures = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); failures++; } else { console.log('  ✓ ' + msg); } };

// A faithful ARIA-snapshot-derived locator, NON-gold (no count=1 proof, no verifiedActions atlas).
function snapshotRefLocator(expr) {
  return {
    kind: 'playwright',
    verified: false,
    diagnosticOnly: true,
    verificationSource: 'snapshot_ref_fallback',
    evidenceSource: 'snapshot_ref_fallback',
    expression: expr,
    frameworkExpressions: { playwright: expr },
    strategy: 'snapshot_ref_fallback',
    proof: { source: 'snapshot_ref_fallback' },
    guess: {
      isGuess: true,
      reviewRequired: true,
      source: 'snapshot_ref_fallback',
      annotation: 'QAAI-GUESSED: snapshot-ref candidate; review before relying on it.',
    },
  };
}

console.log('1) Two-bar separation (export-safe vs gold):');
const login = snapshotRefLocator('getByRole("button", { name: "Login" })');
ok(resolver.isExportSafeActionLocator(login) === true, 'isExportSafeActionLocator ACCEPTS snapshot-ref getByRole({name:Login})');
ok(resolver.isVerifiedActionLocator(login) === false, 'isVerifiedActionLocator (GOLD) REJECTS the same locator (no count=1/atlas)');
ok(resolver.isExportSafeActionLocator(snapshotRefLocator('getByRole("button")')) === false, 'export-safe REJECTS a bare nameless getByRole (not export-safe expr)');
ok(resolver.isExportSafeActionLocator({ verificationSource: 'args', frameworkExpressions: { playwright: 'getByText("x")' } }) === false, 'export-safe REJECTS a non-snapshot source (args)');

console.log('\n2) Emit a click whose ONLY evidence is an export-safe codegen locator:');
const r1 = buildReplayIR({
  caseId: 'TC-test',
  title: 'export-safe capture',
  verdictStatus: 'pass',
  trail: [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/login' }, pageUrl: 'https://example.com/login' },
    {
      tool: 'browser_click', ok: true,
      args: { element: 'Login button', ref: 'e20' },
      pageUrl: 'https://example.com/login',
      // No gold actionLocator; ONLY a snapshot-ref codegen locator (as the conductor now captures at dispatch).
      codegenLocator: snapshotRefLocator('getByRole("button", { name: "Login" })'),
    },
  ],
});
const steps1 = (r1.ir && r1.ir.steps) || [];
const actSteps1 = steps1.filter((s) => s.op === 'act' && s.action === 'click');
const resolveSteps1 = steps1.filter((s) => s.op === 'resolve');
ok(actSteps1.length === 1, `click step EMITTED (got ${actSteps1.length} click act step(s), expected 1)`);
ok(resolveSteps1.length === 1, `resolve step EMITTED (got ${resolveSteps1.length}, expected 1)`);
ok(r1.complete === true, `IR complete:true (no gaps) — got complete=${r1.complete}, gaps=${JSON.stringify((r1.ir && r1.ir.gaps) || [])}`);
ok(resolveSteps1[0] && resolveSteps1[0].locatorConfidence === 'unverified', 'resolve step honestly flagged locatorConfidence:unverified');
const cand = resolveSteps1[0] && (resolveSteps1[0].candidates || []);
const hasRoleCand = Array.isArray(cand) && cand.some((c) => c && (c.strategy === 'role' && /login/i.test(String(c.name || '')) || /getByRole/.test(String(c.selector || c.expression || ''))));
ok(hasRoleCand, 'emitted resolve step carries the real getByRole candidate (the captured locator, not a guess)');

console.log('\n3) Genuinely nameless element receives a DIAGNOSABLE annotated guess:');
const r2 = buildReplayIR({
  caseId: 'TC-test2',
  title: 'nameless widget',
  verdictStatus: 'pass',
  trail: [
    { tool: 'browser_navigate', ok: true, args: { url: 'https://example.com/form' }, pageUrl: 'https://example.com/form' },
    {
      tool: 'browser_click', ok: true,
      args: { element: 'User Role dropdown', ref: 'e169' },
      pageUrl: 'https://example.com/form',
      // No locator anywhere, but the conductor stamped a precise gap (the new behavior).
      actionLocatorGap: { code: 'missing_verified_action_locator', reason: 'excavation_failed', where: 'browser_click', ref: 'e169', elementLabel: 'User Role dropdown', strategiesTried: ['snapshot_ref', 'snapshot_ref_fallback', 'targeted_ref_excavation'], detail: 'nameless custom element; recapture required' },
    },
  ],
});
const resolve2 = ((r2.ir && r2.ir.steps) || []).find((step) => step && step.op === 'resolve' && step.guessedLocator === true);
const sourceGap2 = resolve2 && resolve2.locatorProvenance && resolve2.locatorProvenance.sourceGap;
ok(!!resolve2, 'nameless click receives an explicit guessed resolve');
ok(resolve2 && resolve2.locatorConfidence === 'guessed', 'guess confidence is visible to downstream codegen');
ok(sourceGap2 && sourceGap2.code === 'missing_verified_action_locator', `guess retains DIAGNOSABLE source gap (code=${sourceGap2 && sourceGap2.code})`);
ok(sourceGap2 && Array.isArray(sourceGap2.strategiesTried) && sourceGap2.strategiesTried.length > 0, 'guess provenance carries strategiesTried for diagnosis');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
