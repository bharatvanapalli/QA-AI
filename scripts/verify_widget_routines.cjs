'use strict';
/*
 * Guard for B-2c.3 — widget routines feeding the Precision Action Kernel.
 * Proves the dropdown TWO-STEP (open -> exact option visible -> panel closes ->
 * value reflected), form readback, toggle state, and modal outcome certify what
 * ACTUALLY happened — never "clicked something with similar text".
 * SYNTHETIC accessibility-tree fixtures, not live proof.
 */
const { certifyDropdownSelection, certifyFieldReadback, certifyToggleState, certifyModalOutcome } = require('../server/services/widgetRoutines');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const CLOSED = ['- combobox "User Role" [ref=e1]'].join('\n');
const OPEN = ['- combobox "User Role" [ref=e1]', '- listbox:', '  - option "Admin" [ref=e2]', '  - option "ESS" [ref=e3]'].join('\n');
const SELECTED = ['- combobox "User Role" [ref=e1]: ESS'].join('\n');

console.log('— dropdown two-step: opened + exact option + panel closed + value reflected -> certified —');
{
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: OPEN, snapshotAfterSelect: SELECTED });
  ok('certified', r.certified === true, JSON.stringify(r));
  ok('panelOpened', r.panelOpened === true);
  ok('optionMatched', r.optionMatched === true);
  ok('panelClosed', r.panelClosed === true);
  ok('valueReflected', r.valueReflected === true);
}

console.log('\n— dropdown: panel never opened (clicked the wrong trigger) -> NOT certified —');
{
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: CLOSED, snapshotAfterSelect: SELECTED });
  ok('not certified (panel did not open)', r.certified === false && r.panelOpened === false, r.reason);
}

console.log('\n— dropdown: exact option absent (only a similar one) -> NOT certified —');
{
  const openOther = ['- combobox "User Role" [ref=e1]', '- listbox:', '  - option "Administrator" [ref=e2]'].join('\n');
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: openOther, snapshotAfterSelect: SELECTED });
  ok('not certified (exact "ESS" option not in panel)', r.certified === false && r.optionMatched === false, r.reason);
}

console.log('\n— dropdown: value not reflected after select -> NOT certified —');
{
  const notReflected = ['- combobox "User Role" [ref=e1]'].join('\n'); // back to placeholder, no value
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: OPEN, snapshotAfterSelect: notReflected });
  ok('not certified (value not reflected)', r.certified === false && r.valueReflected === false, r.reason);
}

console.log('\n— (B-2c.3a) EXACT option match: "ESS" must NOT match "ESS Admin" / "ESSENTIAL" —');
{
  const openSimilar = ['- combobox "User Role" [ref=e1]', '- listbox:', '  - option "ESS Admin" [ref=e2]', '  - option "ESSENTIAL" [ref=e3]'].join('\n');
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: openSimilar, snapshotAfterSelect: SELECTED });
  ok('exact "ESS" does NOT match "ESS Admin"/"ESSENTIAL"', r.optionMatched === false && r.certified === false, r.reason);
  // but an exact option present still matches
  const r2 = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: OPEN, snapshotAfterSelect: SELECTED });
  ok('exact "ESS" matches the "ESS" option', r2.optionMatched === true);
  // explicit opt-in allows partial
  ok('allowPartialOption lets "ESS" match "ESS Admin"', certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: openSimilar, snapshotAfterSelect: SELECTED, allowPartialOption: true }).optionMatched === true);
}

console.log('\n— (B-2c.3a) SCOPED value reflection: value elsewhere on page (not in the control) -> NOT certified —');
{
  // panel opened + exact option, but after select the value shows in an unrelated
  // place (a toast/heading), NOT on the control -> valueReflected must be false.
  const valueElsewhere = ['- combobox "User Role" [ref=e1]', '- heading "ESS users updated" [ref=e9]'].join('\n');
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: OPEN, snapshotAfterSelect: valueElsewhere });
  ok('value present elsewhere but not on control -> valueReflected false', r.valueReflected === false && r.certified === false, r.reason);
}

console.log('\n— (B-2c.3a) overlapping labels: "User" must not shadow "User Role" —');
{
  const sel = ['- textbox "User" [ref=e1]: bob', '- combobox "User Role" [ref=e2]: ESS'].join('\n');
  const r = certifyDropdownSelection({ controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: OPEN, snapshotAfterSelect: sel });
  ok('control "User Role" resolved exactly (not the "User" textbox)', r.valueReflected === true, r.reason);
}

console.log('\n— form field readback —');
{
  const after = ['- textbox "Username" [ref=e3]: Admin'].join('\n');
  const r = certifyFieldReadback({ fieldLabel: 'Username', intendedValue: 'Admin', snapshotAfter: after });
  ok('certified when field holds the value', r.certified === true && r.observedValue === 'Admin', JSON.stringify(r));
  const wrong = ['- textbox "Username" [ref=e3]: Adfin'].join('\n');
  ok('mismatch flagged', certifyFieldReadback({ fieldLabel: 'Username', intendedValue: 'Admin', snapshotAfter: wrong }).valueConfirmed === false);
  // masked password: value not readable -> null (not a false mismatch)
  const masked = ['- textbox "Password" [ref=e5]'].join('\n');
  const rp = certifyFieldReadback({ fieldLabel: 'Password', intendedValue: 'secret', snapshotAfter: masked });
  ok('masked/unreadable field -> valueConfirmed null (not false)', rp.valueConfirmed === null, JSON.stringify(rp));
}

console.log('\n— toggle state —');
{
  const checkedSnap = ['- checkbox "Remember me" [checked] [ref=e1]'].join('\n');
  ok('checked toggle matches intendedChecked=true', certifyToggleState({ controlLabel: 'Remember me', intendedChecked: true, snapshotAfter: checkedSnap }).certified === true);
  const uncheckedSnap = ['- checkbox "Remember me" [ref=e1]'].join('\n');
  ok('unchecked toggle vs intendedChecked=true -> not certified', certifyToggleState({ controlLabel: 'Remember me', intendedChecked: true, snapshotAfter: uncheckedSnap }).certified === false);
}

console.log('\n— modal outcome —');
{
  const withDialog = ['- dialog "Confirm Delete":', '  - button "Yes" [ref=e2]'].join('\n');
  const noDialog = ['- heading "Users" [ref=e1]'].join('\n');
  ok('dialog dismissed certified', certifyModalOutcome({ snapshotBefore: withDialog, snapshotAfter: noDialog, expect: 'dismissed' }).certified === true);
  ok('dialog still present -> not dismissed', certifyModalOutcome({ snapshotBefore: withDialog, snapshotAfter: withDialog, expect: 'dismissed' }).certified === false);
  ok('dialog appeared certified', certifyModalOutcome({ snapshotBefore: noDialog, snapshotAfter: withDialog, expect: 'appeared' }).certified === true);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — widget routines verified (SYNTHETIC fixtures; wired into kernel at B-2d, proven at B-2e)');
