#!/usr/bin/env node
'use strict';
/**
 * Regression guard for the declared-assertion CONTRACT across three layers:
 *   1. architect.js  ASSERTION_REQUIRED_FIELDS   (first authoring-side gate)
 *   2. declaredAssertions.js validateRecord       (persistence-side validator)
 *   3. mcp.js matchPageAssertion                  (runtime PAGE checker)
 *
 * The bug this guards against (shipped 2026-06-01): the three layers drifted on
 * payload field NAMES. The Architect schema tells the LLM to emit
 * FORBIDDEN_TEXT.unexpectedText / ROLE.expectedRole / FORBIDDEN_ROLE.unexpectedRole,
 * but ASSERTION_REQUIRED_FIELDS demanded `forbiddenText` / `role` / `role`, so
 * every correctly-formed negative assertion was stamped parseFailed and excluded
 * from the verdict. Separately, PAGE was absent from VALID_TYPES, so every PAGE
 * assertion (the strongest grounded check) was rejected unknown_type:PAGE.
 *
 * Generic rule encoded: for each assertion type, the architect's required field
 * name MUST be a field declaredAssertions.validateRecord accepts, AND a minimal
 * payload built from it must round-trip without parseFailed. PAGE must validate.
 *
 * Pure / deterministic. No DB, no LLM, no network. Exit 0 = pass.
 */
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { validateRecord, normalizeForCase } = require(path.join(ROOT, 'server/lib/declaredAssertions'));
const { markMalformedAssertionPayloads, ASSERTION_REQUIRED_FIELDS } = require(path.join(ROOT, 'server/services/agents/architect'));
const { computeVerdict } = require(path.join(ROOT, 'server/services/computeVerdict'));
const { buildReplayIR } = require(path.join(ROOT, 'server/services/codegen/replayEmitter'));

let pass = 0; const fail = [];
const ok = (name, cond) => { if (cond) { pass++; } else { fail.push(name); } };

// ── 1. Cross-layer field-name agreement ────────────────────────────────────
// Every field the architect requires must yield a record declaredAssertions
// ACCEPTS (ok:true, no parseFailed) when that field is the only one present.
for (const [type, rule] of Object.entries(ASSERTION_REQUIRED_FIELDS)) {
  const raw = { type, criticality: 'must', payload: { [rule.field]: 'sentinel-value' } };
  const v = validateRecord(raw);
  ok(`architect-required field "${rule.field}" is accepted by validateRecord for ${type}`,
     v.ok === true && v.normalized && v.normalized.type === type && !v.normalized.parseFailed);
}

// The phantom field names from the bug must NOT validate (proves we actually
// changed them — a regression that reintroduced `forbiddenText` would fail here
// because validateRecord rejects a FORBIDDEN_TEXT whose only key is forbiddenText).
ok('legacy phantom forbiddenText is NOT the required field anymore',
   ASSERTION_REQUIRED_FIELDS.FORBIDDEN_TEXT.field === 'unexpectedText');
ok('ROLE required field is expectedRole (not role)',
   ASSERTION_REQUIRED_FIELDS.ROLE.field === 'expectedRole');
ok('FORBIDDEN_ROLE required field is unexpectedRole (not role)',
   ASSERTION_REQUIRED_FIELDS.FORBIDDEN_ROLE.field === 'unexpectedRole');

// ── 2. The exact PIM shapes that were broken now round-trip clean ───────────
// (a) PAGE assertion as the Architect emitted it for S2·C1 (add-employee form).
const pageRaw = {
  type: 'PAGE', criticality: 'must', provenance: 'doc_quoted',
  note: 'BR-PIM-005 add employee form',
  payload: {
    pageName: 'add_employee_form',
    expectedSignals: {
      text: ['First Name', 'Middle Name', 'Last Name', 'Employee Id'],
      role: [{ role: 'button', name: 'Save' }],
      url: ['/pim/addEmployee'],
    },
    primaryIndicator: { text: 'First Name' },
  },
  targetUrl: '/web/index.php/pim/addEmployee', checkAt: 'end',
};
const pv = validateRecord(pageRaw);
ok('PAGE assertion validates (no longer unknown_type:PAGE)', pv.ok === true);
ok('PAGE assertion keeps type=PAGE (not coerced to TEXT)', pv.ok && pv.normalized.type === 'PAGE');
ok('PAGE assertion is NOT parseFailed', pv.ok && !pv.normalized.parseFailed);
ok('PAGE payload preserved verbatim (expectedSignals intact)',
   pv.ok && pv.normalized.payload && pv.normalized.payload.expectedSignals
   && Array.isArray(pv.normalized.payload.expectedSignals.text)
   && pv.normalized.payload.expectedSignals.text.includes('First Name'));
{
  const emitted = buildReplayIR({
    caseId: 'TC-page',
    declaredAssertions: [{ ...pageRaw, id: 'ASN-page' }],
    assertionOutcomes: [{ assertionId: 'ASN-page', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const pageStep = emitted.ir.steps.find((s) => s.contractRef === 'ASN-page');
  ok('ReplayIR PAGE assert preserves expectedSignals for codegen parity',
     pageStep && pageStep.channel === 'PAGE'
     && pageStep.expectedSignals
     && Array.isArray(pageStep.expectedSignals.role)
     && pageStep.expectedSignals.role[0].name === 'Save');
}

// An empty PAGE (no channels) must still be rejected — the defensive floor.
ok('empty PAGE (no signal channel) is rejected',
   validateRecord({ type: 'PAGE', payload: { pageName: 'x', expectedSignals: {} } }).ok === false);

// (b) FORBIDDEN_TEXT as the Architect emitted it for S3·C1.
const fbScenarios = [{ cases: [{ name: 'S3C1', declaredAssertions: [
  { type: 'FORBIDDEN_TEXT', criticality: 'should', payload: { unexpectedText: 'Confirm Password' } },
] }] }];
const marked = markMalformedAssertionPayloads(fbScenarios);
ok('FORBIDDEN_TEXT{unexpectedText} is NOT marked malformed (was missing_required_payload_field)',
   marked === 0 && !fbScenarios[0].cases[0].declaredAssertions[0].parseFailed);

// ── 3. End-to-end: a case of [PAGE must + FORBIDDEN_TEXT should] now produces a
//      real PASS instead of needs_human(no_assertions_declared) / masked must ──
const { normalized } = normalizeForCase([
  pageRaw,
  { type: 'FORBIDDEN_TEXT', criticality: 'should', payload: { unexpectedText: 'Confirm Password' } },
], { automatability: 'automatable', caseName: 'S3C1-e2e' });
ok('normalizeForCase keeps both records valid (none parseFailed)',
   normalized.length === 2 && normalized.every((n) => !n.parseFailed));
ok('normalizeForCase preserves a must-tier PAGE (case proves something)',
   normalized.some((n) => n.type === 'PAGE' && n.criticality === 'must'));

const verdict = computeVerdict({
  declared: normalized,
  recorded: normalized.map((n) => ({
    assertionId: n.id,
    outcome: 'matched',
    primitiveUsed: n.type === 'FORBIDDEN_TEXT' ? 'negative' : undefined,
  })),
  steps: [{ status: 'pass' }],
  reachedEndTurn: true,
});
ok(`computeVerdict → pass when PAGE+FORBIDDEN both matched (got ${verdict.status}:${verdict.reason})`,
   verdict.status === 'pass');

// And the masking direction still holds: a must PAGE that comes back not_matched
// must FAIL (not be silently excluded).
const failV = computeVerdict({
  declared: normalized,
  recorded: [
    { assertionId: normalized[0].id, outcome: 'not_matched' },              // PAGE must miss
    { assertionId: normalized[1].id, outcome: 'matched', primitiveUsed: 'negative' },
  ],
  steps: [{ status: 'pass' }],
  reachedEndTurn: true,
});
ok(`must PAGE miss → fail (not masked) (got ${failV.status})`, failV.status === 'fail');

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\nverify_assertion_fields: ${pass} passed, ${fail.length} failed`);
if (fail.length) { fail.forEach((f) => console.log(`  ✗ ${f}`)); process.exit(1); }
console.log('  ✓ all assertion-contract checks pass (PAGE whitelisted; field names aligned across all 3 layers)');
process.exit(0);
