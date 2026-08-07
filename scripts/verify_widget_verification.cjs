'use strict';
/*
 * Guard for widget completion verification — the B-2e false-step-advancement fix.
 * Replays the exact failures the reviewer found in the backend run:
 *  - Status dropdown OPEN, control still "-- Select --" → must NOT pass.
 *  - "Enabled" only visible in the OPEN menu → must NOT pass.
 *  - committed (menu closed, control shows the value) → passes.
 *  - autocomplete "No Records Found" → suggestion-pick step blocked.
 */
const { isSelectionCommitted, autocompleteHasNoResults, suggestionPanelOpen, isSuggestionPickStep, buildTestDataInvalidOutcome } = require('../server/lib/widgetVerification');

// Minimal snapshot-line parser stub (role + name) matching mcp.parseSnapshotLine shape.
const parse = (line) => {
  const m = /^\s*-?\s*([a-z]+)\s+"([^"]*)"/i.exec(line);
  if (m) return { role: m[1].toLowerCase(), name: m[2] };
  const m2 = /^\s*-?\s*([a-z]+)\b/i.exec(line);
  return m2 ? { role: m2[1].toLowerCase(), name: '' } : { role: '', name: '' };
};

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— dropdown: OPEN menu / placeholder still showing → NOT committed —');
{
  // The actual failure: Status trigger shows "-- Select --" and the menu is OPEN.
  const openMenu = [
    'combobox "Status" [ref=e1]: -- Select --',
    'listbox "Status options" [ref=e2]',
    'option "-- Select --" [ref=e3]',
    'option "Enabled" [ref=e4]',
    'option "Disabled" [ref=e5]',
  ].join('\n');
  ok('Status OPEN menu showing "Enabled" → NOT committed (the old false pass)', isSelectionCommitted(openMenu, 'Enabled', ['status'], parse) === false);

  // Custom role-less dropdown: trigger still "-- Select --", options as generic text.
  const customOpen = [
    'generic "Status" [ref=e1]: -- Select --',
    'generic "-- Select --" [ref=e2]',
    'generic "Enabled" [ref=e3]',
    'generic "Disabled" [ref=e4]',
  ].join('\n');
  ok('custom dropdown open (role-less options) → NOT committed', isSelectionCommitted(customOpen, 'Enabled', ['status'], parse) === false);
}

console.log('\n— dropdown: CLOSED control shows the value → committed —');
{
  const committed = [
    'combobox "User Role" [ref=e0]: ESS',
    'combobox "Status" [ref=e1]: Enabled',
    'textbox "Username" [ref=e6]',
  ].join('\n');
  ok('Status closed showing "Enabled" → committed', isSelectionCommitted(committed, 'Enabled', ['status'], parse) === true);
  // The OTHER dropdown still unselected must not block THIS one (scoped).
  const oneSelected = [
    'combobox "User Role" [ref=e0]: ESS',
    'combobox "Status" [ref=e1]: -- Select --',
  ].join('\n');
  ok('User Role committed even though Status still "-- Select --" (scoped)', isSelectionCommitted(oneSelected, 'ESS', ['user', 'role'], parse) === true);
  ok('Status NOT committed while it shows "-- Select --"', isSelectionCommitted(oneSelected, 'Enabled', ['status'], parse) === false);
}

console.log('\n— custom dropdown closed (role-less), value on trigger, no placeholder —');
{
  const customClosed = ['generic "trigger" [ref=e1]: Enabled', 'textbox "Username" [ref=e2]'].join('\n');
  ok('role-less closed trigger shows value, no placeholder → committed', isSelectionCommitted(customClosed, 'Enabled', [], parse) === true);
}

console.log('\n— autocomplete: No Records Found → suggestion pick blocked —');
{
  ok('detects "No Records Found"', autocompleteHasNoResults('textbox "Employee Name": Alice\nNo Records Found') === true);
  ok('clean suggestions → not no-results', autocompleteHasNoResults('option "Alice Smith"\noption "Alice Brown"') === false);
  ok('suggestion-pick step recognised (autocomplete)', isSuggestionPickStep({ action: 'click', element: 'Employee Name autocomplete suggestion' }) === true);
  ok('suggestion-pick step recognised ("Type for hints")', isSuggestionPickStep({ element: 'Type for hints...' }) === true);
  ok('a plain Login click is NOT a suggestion pick', isSuggestionPickStep({ action: 'click', element: 'Login button' }) === false);
}

console.log('\n— REGION-SCOPED: role-less OrangeHRM dropdowns (run 17a2e279 false-negative) —');
{
  // Real shape: User Role committed to ESS; Status still "-- Select --". The
  // sibling placeholder must NOT fail User Role (the persisted step-9-BLOCKED bug).
  const snap = [
    'User Role*',
    '  generic [cursor=pointer]',
    '    ESS',
    'Status*',
    '  generic [cursor=pointer]',
    '    -- Select --',
    'Username*',
    '  textbox',
  ].join('\n');
  ok('User Role committed to ESS → true (Status placeholder no longer fails it)', isSelectionCommitted(snap, 'ESS', ['user', 'role'], parse) === true, JSON.stringify(isSelectionCommitted(snap, 'ESS', ['user', 'role'], parse)));
  ok('Status still "-- Select --" → Enabled NOT committed → false', isSelectionCommitted(snap, 'Enabled', ['status'], parse) === false, JSON.stringify(isSelectionCommitted(snap, 'Enabled', ['status'], parse)));
  // And once Status is also selected, it must pass without affecting User Role.
  const snap2 = ['User Role*', '  generic [cursor=pointer]', '    ESS', 'Status*', '  generic [cursor=pointer]', '    Enabled'].join('\n');
  ok('both committed: User Role=ESS true', isSelectionCommitted(snap2, 'ESS', ['user', 'role'], parse) === true);
  ok('both committed: Status=Enabled true', isSelectionCommitted(snap2, 'Enabled', ['status'], parse) === true);
}

console.log('\n— autocomplete: suggestions visible but panel still OPEN → not committed —');
{
  const panelOpen = ['textbox "Employee Name": Ali', 'option "Alice Smith"', 'option "Alice Brown"'].join('\n');
  ok('suggestion panel open (options listed) → still open', suggestionPanelOpen(panelOpen, parse) === true);
  const panelClosed = ['textbox "Employee Name": Alice Smith'].join('\n');
  ok('panel closed (no option lines) → not open', suggestionPanelOpen(panelClosed, parse) === false);
}

console.log('\n— audit-ready test_data_invalid outcome (fake 20-step a306ab75-like flow) —');
{
  // 20 approved steps; step 11 (index 10) is "Fill Employee Name = Alice".
  const approvedSteps = Array.from({ length: 20 }, (_, i) => ({ order: i + 1, action: 'Verify', element: `step ${i + 1}` }));
  approvedSteps[10] = { order: 11, action: 'Fill', element: 'Employee Name autocomplete textbox', value: 'Alice', expected: 'autocomplete shows suggestions' };
  // before the stop: steps 1–11 had been marked pass (11 prematurely), 12–20 pending.
  const stepResults = Array.from({ length: 20 }, (_, i) => ({ status: i < 11 ? 'pass' : 'pending' }));
  const out = buildTestDataInvalidOutcome({ stepResults, approvedSteps, field: 'Employee Name autocomplete textbox', value: 'Alice', fallbackStepIndex: 12 });
  ok('found the Fill step that entered Alice = step 11 (not the fallback)', out.blockedStepIndex === 10, String(out.blockedStepIndex));
  ok('step 11 is BLOCKED (not the misleading PASS)', out.stepResults[10].status === 'blocked' && out.stepResults[10].reason === 'test_data_invalid');
  ok('step 11 evidence names value + No Records', /Alice/.test(out.stepResults[10].evidence) && /No Records Found/.test(out.stepResults[10].evidence));
  ok('step 11 carries a UI-consumable `error` field (Reports renders error)', typeof out.stepResults[10].error === 'string' && /Alice/.test(out.stepResults[10].error) && /No Records Found/.test(out.stepResults[10].error));
  ok('dependent steps also carry an `error` field', out.stepResults.slice(11).every((s) => typeof s.error === 'string' && s.error.length > 0));
  ok('steps 12–20 are blocked dependencies', out.stepResults.slice(11).every((s) => s.status === 'blocked' && s.reason === 'test_data_invalid_dependency'), JSON.stringify(out.stepResults.slice(11).map((s) => s.status)));
  ok('dependency wording is clear', /Blocked because the record for approved value "Alice"/.test(out.stepResults[12].evidence));
  ok('error is the HUMAN explanation, not mechanical_v1', /entered the approved value "Alice"/.test(out.error) && /No Records Found/.test(out.error) && !/mechanical_v1/.test(out.error));
  ok('dependentCount = 9 (steps 12–20)', out.dependentCount === 9, String(out.dependentCount));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — widget completion verification + audit-ready test_data_invalid outcome verified');
