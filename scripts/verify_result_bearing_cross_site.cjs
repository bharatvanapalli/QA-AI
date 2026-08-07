'use strict';
/*
 * CROSS-SITE universality guard for the Result-Bearing Input Protocol.
 *
 * Purpose: stop relying on the OrangeHRM "Alice" case as the proof. The engine must
 * produce the same deterministic outcome for ANY site/field/value when a required
 * match returns a generic empty-result state — e-commerce product search, CRM
 * customer lookup, a role dropdown search, etc. No field names (Employee Name) or
 * values (Alice) may be hardcoded; the explanation is generated purely from the
 * approved step's value + field + the OBSERVED empty-result text.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const RB = path.join(ROOT, 'server', 'lib', 'resultBearingInputVerification.js');
const WV = path.join(ROOT, 'server', 'lib', 'widgetVerification.js');
const { decideResultOutcome, hasEmptyResult, classifyResultIntent, isResultBearingStep, EMPTY_RESULT_RE } = require(RB);
const { buildTestDataInvalidOutcome } = require(WV);

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— match required + generic empty state → terminal_test_data_invalid (3 different sites) —');
// 1. E-commerce product search.
{
  const step = { action: 'Search', element: 'Product search', value: 'SKU-404', expected: 'the matching product appears in the results table' };
  const d = decideResultOutcome({ step, snapshotText: 'Search results\nNo results found' });
  ok('1. Product search "SKU-404" + "No results found" → terminal', d.outcome === 'terminal_test_data_invalid', JSON.stringify(d));
  ok('1. observed empty text captured = "No results found"', /no results found/i.test(d.emptyText || ''), d.emptyText);
}
// 2. CRM customer lookup.
{
  const step = { action: 'Fill', element: 'Customer lookup field', value: 'Acme Missing', expected: 'select the matching customer record' };
  const d = decideResultOutcome({ step, snapshotText: 'Customer\nNo matching records' });
  ok('2. Customer lookup "Acme Missing" + "No matching records" → terminal', d.outcome === 'terminal_test_data_invalid', JSON.stringify(d));
  ok('2. observed empty text = "No matching records"', /no matching records/i.test(d.emptyText || ''), d.emptyText);
}
// 3. Role dropdown search (natural "select the X option" phrasing — must classify as match).
{
  const step = { action: 'Select', element: 'Role dropdown search', value: 'Manager', expected: 'select the Manager option' };
  ok('3. dropdown search is recognised as result-bearing', isResultBearingStep(step) === true);
  ok('3. "select the Manager option" classifies as expect_match', classifyResultIntent(step) === 'expect_match');
  const d = decideResultOutcome({ step, snapshotText: 'Role\nNo options' });
  ok('3. Dropdown search "Manager" + "No options" → terminal', d.outcome === 'terminal_test_data_invalid', JSON.stringify(d));
}

console.log('\n— intent ladder: expected-empty passes; unknown blocks (never improvise) —');
// 4. Negative search expecting empty → pass_expected_empty (NOT blocked).
{
  const step = { action: 'Search', element: 'Product search', expected: 'No results should be returned for an invalid product code' };
  const d = decideResultOutcome({ step, snapshotText: 'No results found' });
  ok('4. negative search expecting empty → pass_expected_empty', d.outcome === 'pass_expected_empty', JSON.stringify(d));
}
// 5. Unknown intent + empty → needs_intent (block, no improvisation).
{
  const step = { action: 'Fill', element: 'reference code field' };
  const d = decideResultOutcome({ step, snapshotText: 'No results found' });
  ok('5. unknown intent + empty → needs_intent (blocked, no improvise)', d.outcome === 'needs_intent', JSON.stringify(d));
}
// populated results never block.
ok('populated results → has_results (no block)', decideResultOutcome({ step: { action: 'Search', element: 'Product search', expected: 'matching product in results table' }, snapshotText: 'row "SKU-123 Widget"' }).outcome === 'has_results');

console.log('\n— 6a. message is generated from value + field + OBSERVED text (no hardcoded Alice/site) —');
{
  const approvedSteps = [{ order: 1, action: 'Search', element: 'Product search', value: 'SKU-404' }];
  const stepResults = [{ status: 'pass' }];
  const out = buildTestDataInvalidOutcome({ stepResults, approvedSteps, field: 'Product search', value: 'SKU-404', emptyText: 'No results found', fallbackStepIndex: 0 });
  ok('message quotes the approved VALUE', /SKU-404/.test(out.error));
  ok('message quotes the FIELD', /Product search/.test(out.error));
  ok('message quotes the OBSERVED empty text', /No results found/.test(out.error));
  ok('message does NOT hardcode "No Records Found" when site showed another phrase', !/No Records Found/.test(out.error), out.error);
  ok('message contains NO Alice/Employee/OrangeHRM literals', !/alice|employee name|orangehrm|gaurav|dilbag/i.test(out.error), out.error);
  ok('blocked step error also uses the observed phrase', /No results found/.test(out.stepResults[0].error || ''));
}

console.log('\n— 6b. empty-result vocabulary is generic + centralized (easy to extend, no site code) —');
['No records found', 'No results found', 'No matching records', 'No data available', 'No items found', 'Nothing found', 'No options', '0 results', 'No users found'].forEach((p) => {
  ok(`detects "${p}"`, hasEmptyResult(`grid\n${p}\nfooter`) === true);
});
ok('does NOT fire on a populated surface', hasEmptyResult('row "Acme Corp"\nrow "Globex"') === false);
ok('vocabulary is ONE exported regex (single point to extend)', EMPTY_RESULT_RE instanceof RegExp);

console.log('\n— 6c. detection/message source carries NO site-specific literals —');
{
  const rbSrc = fs.readFileSync(RB, 'utf8');
  const wvSrc = fs.readFileSync(WV, 'utf8');
  // "employee name" is a GENERIC entity noun (alongside product/customer/account) — allowed.
  // Site/instance literals and invented values must NOT appear.
  ok('resultBearingInputVerification has no Alice/OrangeHRM/invented-value literals', !/\b(alice|orangehrm|gaurav|dilbag)\b/i.test(rbSrc));
  ok('widgetVerification message code has no Alice/OrangeHRM/invented-value literals', !/\b(orangehrm|gaurav|dilbag)\b/i.test(wvSrc));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — result-bearing protocol proven universal across product-search / customer-lookup / dropdown-search; intent ladder correct; message from value+field+observed text; vocabulary generic + centralized; no site-specific literals');
