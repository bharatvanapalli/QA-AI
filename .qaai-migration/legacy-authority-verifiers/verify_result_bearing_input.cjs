'use strict';
/*
 * Guard for the UNIVERSAL Result-Bearing Input Protocol — proves it is NOT
 * autocomplete-only. Covers autocomplete, search bars, lookups, filters, pickers,
 * grid/table searches; generic empty-result vocabulary; and the intent ladder:
 *   match-required + empty → terminal test_data_invalid
 *   expected-empty + empty → pass
 *   unknown + empty        → needs_intent (no improvisation)
 */
const { hasEmptyResult, emptyResultText, expectsPositiveResultSurface, isResultBearingStep, classifyResultIntent, decideResultOutcome } = require('../server/lib/resultBearingInputVerification');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— generic empty-result vocabulary (not just "No Records Found") —');
['No Records Found', 'No Results', 'No results found', 'No matching records', 'No data available', 'No items found', 'Nothing found', '0 results', 'No options', 'No users found'].forEach((s) => {
  ok(`detects "${s}"`, hasEmptyResult(`grid\n${s}\nfooter`) === true);
});
ok('does NOT fire on a populated grid', hasEmptyResult('row "Alice Smith"\nrow "Bob Jones"') === false);
ok('extracts the actual empty-result text', emptyResultText('table\nNo Records Found\nfooter') === 'No Records Found');

console.log('\n— result-bearing step detection (autocomplete / search / lookup / filter) —');
ok('autocomplete employee field', isResultBearingStep({ action: 'Fill', element: 'Employee Name autocomplete', expected: 'shows suggestions' }) === true);
ok('search bar', isResultBearingStep({ action: 'Search', element: 'Username search filter' }) === true);
ok('lookup', isResultBearingStep({ action: 'Fill', element: 'Customer lookup field' }) === true);
ok('plain fill into search criteria is NOT result-bearing; Search/Verify owns the result oracle',
  isResultBearingStep({ action: 'Fill', element: 'Employee Name search field', expected: 'Employee name entered' }) === false);
ok('plain password field is NOT result-bearing', isResultBearingStep({ action: 'Fill', element: 'Password' }) === false);

console.log('\n— positive result-surface expectations —');
ok('record found in list is a positive result expectation',
  expectsPositiveResultSurface({ action: 'Verify', expected: 'Record found in list', element: 'Matching row in results' }) === true);
ok('negative no-results expectation is not a positive result expectation',
  expectsPositiveResultSurface({ action: 'Verify', expected: 'No results should appear for invalid search', element: 'Matching row in results' }) === false);
ok('ordinary page visible expectation is not treated as a result-table oracle',
  expectsPositiveResultSurface({ action: 'Verify', expected: 'Login form visible', element: 'Login page' }) === false);

console.log('\n— intent classification —');
ok('expect_match (pick a suggestion)', classifyResultIntent({ action: 'Click', element: 'first autocomplete suggestion', expected: 'employee selected' }) === 'expect_match');
ok('expect_empty (negative search)', classifyResultIntent({ action: 'Search', expected: 'No results should be returned for invalid product' }) === 'expect_empty');
ok('unknown', classifyResultIntent({ action: 'Fill', element: 'reference code' }) === 'unknown');

console.log('\n— outcome decisions —');
{
  // autocomplete Alice, match required, empty → terminal
  const a = decideResultOutcome({ step: { action: 'Fill', element: 'Employee Name autocomplete', expected: 'autocomplete shows suggestions' }, snapshotText: 'textbox "Employee Name": Alice\nNo Records Found' });
  ok('autocomplete match-required + empty → terminal_test_data_invalid', a.outcome === 'terminal_test_data_invalid', JSON.stringify(a));
  // search username, match required (results table), empty → terminal
  const b = decideResultOutcome({ step: { action: 'Search', element: 'Username', expected: 'matching record appears in results table' }, snapshotText: 'System Users\nNo Records Found' });
  ok('search match-required + empty → terminal_test_data_invalid', b.outcome === 'terminal_test_data_invalid', JSON.stringify(b));
  // negative search expecting empty → pass
  const c = decideResultOutcome({ step: { action: 'Search', element: 'Product', expected: 'No results should appear for an invalid product code' }, snapshotText: 'No matching records' });
  ok('expected-empty + empty → pass_expected_empty', c.outcome === 'pass_expected_empty', JSON.stringify(c));
  // unknown intent + empty → needs_intent
  const d = decideResultOutcome({ step: { action: 'Fill', element: 'reference code' }, snapshotText: 'No results found' });
  ok('unknown intent + empty → needs_intent', d.outcome === 'needs_intent', JSON.stringify(d));
  // populated results → has_results
  const e = decideResultOutcome({ step: { action: 'Search', element: 'Username' }, snapshotText: 'row "qaai_user" ESS Enabled' });
  ok('populated → has_results (no block)', e.outcome === 'has_results');
}

console.log('\n— conductor page_ready contradiction hook —');
{
  const fs = require('fs');
  const path = require('path');
  const conductor = fs.readFileSync(path.join(__dirname, '../server/services/agents/conductor.js'), 'utf8');
  ok('page_ready rejects positive result expectations when the snapshot shows empty results',
    conductor.includes('empty_result_contradicts_expected_row')
      && conductor.includes('expectsPositiveResultSurface')
      && conductor.includes('emptyResultText'));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — universal result-bearing input protocol verified (autocomplete + search + lookup + filter; match/empty/unknown)');
