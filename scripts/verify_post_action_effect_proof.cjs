'use strict';
/*
 * Guard for B-2e POST-ACTION EFFECT PROOF. "Tool dispatched" ≠ "worked": every
 * action class must prove its TYPED effect — fill→value readback, select→
 * displayed change, checkbox→checked change, click→nav/toast/modal/row/network.
 * An action with no observable effect is NOT proven. EFFECT_PROBE_FN is valid JS
 * and generic (role + class-substring, no site classes).
 */
const { proveEffect, classifyExpectedEffect, actionVerb, EFFECT_PROBE_FN } = require('../server/services/postActionEffectProof');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— expected-effect classification —');
ok('fill -> value_set', classifyExpectedEffect({ verb: 'fill' }) === 'value_set');
ok('select/combobox -> selection_changed', classifyExpectedEffect({ verb: 'select' }) === 'selection_changed' && classifyExpectedEffect({ verb: 'click', targetRole: 'combobox' }) === 'selection_changed');
ok('checkbox -> checked_changed', classifyExpectedEffect({ verb: 'click', targetRole: 'checkbox' }) === 'checked_changed');
ok('click -> command_effect', classifyExpectedEffect({ verb: 'click', targetRole: 'button' }) === 'command_effect');

console.log('\n— fill: value readback —');
ok('value matches intended -> proven', proveEffect({ toolName: 'browser_type', intendedValue: 'Admin', valueAfter: 'Admin' }).proven === true);
ok('value differs -> NOT proven', proveEffect({ toolName: 'browser_type', intendedValue: 'Admin', valueAfter: '' }).proven === false);
ok('value via active-element fingerprint', proveEffect({ toolName: 'browser_type', intendedValue: 'abc', after: { activeValue: 'abc' } }).proven === true);

console.log('\n— select / dropdown: displayed value changed —');
ok('selection to intended -> proven', proveEffect({ toolName: 'browser_select_option', targetRole: 'combobox', intendedValue: 'Admin', valueAfter: 'Admin' }).proven === true);
ok('no change -> NOT proven', proveEffect({ toolName: 'browser_select_option', targetRole: 'combobox', before: { activeValue: 'x' }, after: { activeValue: 'x' } }).proven === false);

console.log('\n— checkbox / radio: checked state changed —');
ok('checked flips -> proven', proveEffect({ toolName: 'browser_click', targetRole: 'checkbox', checkedBefore: false, checkedAfter: true }).proven === true);
ok('checked unchanged -> NOT proven', proveEffect({ toolName: 'browser_click', targetRole: 'checkbox', checkedBefore: true, checkedAfter: true }).proven === false);

console.log('\n— click (command): nav / toast / modal / row / network —');
ok('navigation proves', proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a/login' }, after: { url: 'a/dashboard' } }).proven === true);
ok('toast proves (save)', proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a', toast: '' }, after: { url: 'a', toast: 'Successfully Saved' } }).kind === 'toast');
ok('row removed proves (delete)', (() => { const r = proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a', rowCount: 20 }, after: { url: 'a', rowCount: 19 } }); return r.proven && r.signals.includes('row_removed'); })());
ok('modal opened proves', proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a', dialogOpen: 0 }, after: { url: 'a', dialogOpen: 1 } }).signals.includes('modal_opened'));
ok('network response proves', proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a' }, after: { url: 'a' }, networkOk: true }).proven === true);
ok('NO observable effect -> NOT proven (tool clicked != worked)', proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a', rowCount: 20, dialogOpen: 0, toast: '' }, after: { url: 'a', rowCount: 20, dialogOpen: 0, toast: '' } }).proven === false);
ok('validation error is surfaced as a signal', proveEffect({ toolName: 'browser_click', targetRole: 'button', before: { url: 'a', errorCount: 0 }, after: { url: 'a', errorCount: 1 } }).signals.includes('validation_error_shown'));

console.log('\n— EFFECT_PROBE_FN is valid + generic —');
{
  let fn = null; try { fn = eval('(' + EFFECT_PROBE_FN + ')'); } catch (_) {}
  ok('EFFECT_PROBE_FN parses to a function', typeof fn === 'function');
  ok('captures url/dialogOpen/toast/rowCount/checkedCount/errorCount', /url:/.test(EFFECT_PROBE_FN) && /dialogOpen/.test(EFFECT_PROBE_FN) && /toast/.test(EFFECT_PROBE_FN) && /rowCount/.test(EFFECT_PROBE_FN) && /checkedCount/.test(EFFECT_PROBE_FN) && /errorCount/.test(EFFECT_PROBE_FN));
  ok('generic: role + class-substring, no hardcoded site classes', /role="alert"/.test(EFFECT_PROBE_FN) && /class\*="toast"/.test(EFFECT_PROBE_FN) && !/oxd-|ant-|mat-/.test(EFFECT_PROBE_FN));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — Post-action effect proof verified (deterministic; live capture proven at B-2e)');
