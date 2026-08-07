#!/usr/bin/env node
/**
 * GUARD: PO↔spec bijection (TIER 2.4). Two DISTINCT elements on one page whose
 * semantic names collapse to the same method name under methodNameFor()
 * (e.g. a "Login" button + a "Login" link → both "clickLogin") must each get
 * their OWN page-object method, and EVERY method the spec calls must be DEFINED
 * on the page object — no silent drop, no wrong-element binding.
 *
 *   node scripts/verify_pom_bijection.cjs
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const pom = require('../server/services/codegen/adapters/playwrightPom');

let failures = 0;
const ok = (c, m) => { if (!c) { console.error('  ✗ ' + m); failures++; } else { console.log('  ✓ ' + m); } };

const cases = [{
  runResultId: 'r1', testCaseId: 'tc1', caseName: 'Collision flow',
  ir: {
    caseId: 'tc1', title: 'Collision flow', version: 1, verdict: { status: 'pass' },
    steps: [
      { op: 'act', action: 'navigate', url: 'https://app.test/login' },
      { op: 'resolve', as: 'el1', candidates: [{ strategy: 'role', role: 'button', name: 'Login' }], elementLabel: 'Login button' },
      { op: 'act', target: 'el1', action: 'click' },
      { op: 'resolve', as: 'el2', candidates: [{ strategy: 'role', role: 'link', name: 'Login' }], elementLabel: 'Login link' },
      { op: 'act', target: 'el2', action: 'click' },
    ],
  },
}];

const out = pom.emitJourneySpec(cases, { lang: 'js', moduleFormat: 'cjs' });
const spec = out.content || '';
const pageFiles = Object.entries(out.extraFiles || {}).filter(([p]) => /^pages\//.test(p) && /\.(js|ts)$/.test(p));

// Declared methods across all page files (async methods + locator accessors).
const declared = new Set();
for (const [, content] of pageFiles) {
  for (const m of content.matchAll(/\basync\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]);
  for (const m of content.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\(\)\s*\{\s*return this\./gm)) declared.add(m[1]);
}

// Action-method calls in the spec: await <pageVar>.<method>(
const ACTION_VERBS = /^(fill|click|select|check|uncheck|press|hover|upload|doubleClick|tripleClick)/;
const calledActionMethods = [];
for (const m of spec.matchAll(/\bawait\s+[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)\s*\(/g)) {
  if (ACTION_VERBS.test(m[1])) calledActionMethods.push(m[1]);
}

console.log('declared methods:', [...declared].filter((d) => ACTION_VERBS.test(d)).join(', ') || '(none)');
console.log('called action methods:', calledActionMethods.join(', ') || '(none)');

ok(pageFiles.length >= 1, `at least one page file emitted (${pageFiles.length})`);
ok(calledActionMethods.length === 2, `both distinct clicks produced a call (got ${calledActionMethods.length}, expected 2 — no collapse/drop)`);
const distinctCalls = new Set(calledActionMethods);
ok(distinctCalls.size === 2, `the two clicks call DISTINCT methods (got ${distinctCalls.size} distinct: ${[...distinctCalls].join(', ')}) — collision disambiguated, not collapsed onto one`);

// THE bijection invariant: every called action method is DEFINED on a page object.
const undefinedCalls = calledActionMethods.filter((m) => !declared.has(m));
ok(undefinedCalls.length === 0, `every called method is declared on a page object (undeclared: ${undefinedCalls.join(', ') || 'none'})`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
