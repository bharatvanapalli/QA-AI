'use strict';
/*
 * Guard for the label-region LIVE ref resolver — turns the static-click BLOCK
 * into a REPAIR. Replays the a306ab75 stall: "User Role dropdown" mis-resolved to
 * a non-interactive heading; the resolver must find the real interactive control
 * (custom role-less trigger or combobox) near the "User Role" label instead.
 */
const { resolveInteractiveRefNearLabel } = require('../server/lib/labelRegionResolver');

// Snapshot-line parser stub: "role \"name\" [ref=eNN]".
const parse = (line) => {
  const m = /^\s*-?\s*([a-z]+)\s+"([^"]*)"/i.exec(line);
  return m ? { role: m[1].toLowerCase(), name: m[2] } : { role: (/^\s*-?\s*([a-z]+)/i.exec(line) || [])[1] || '', name: '' };
};

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— custom role-less dropdown near a label (the a306ab75 stall) —');
{
  // The heading "Add User" (e158) is what the loose resolver picked; the REAL
  // User Role control is a role-less generic trigger showing "-- Select --".
  const snap = [
    'heading "Add User" [ref=e158]',
    'text "User Role" [ref=e160]',
    'generic "-- Select --" [ref=e162]',
    'text "Employee Name" [ref=e170]',
    'textbox "Type for hints..." [ref=e172]',
  ].join('\n');
  ok('does NOT return the heading', resolveInteractiveRefNearLabel(snap, 'User Role dropdown', parse) !== 'e158');
  ok('returns the role-less custom trigger e162', resolveInteractiveRefNearLabel(snap, 'User Role dropdown', parse) === 'e162', JSON.stringify(resolveInteractiveRefNearLabel(snap, 'User Role dropdown', parse)));
}

console.log('— native combobox by label —');
{
  const snap = ['text "Status" [ref=e1]', 'combobox "Status" [ref=e2]'].join('\n');
  ok('returns the combobox ref', resolveInteractiveRefNearLabel(snap, 'Status dropdown', parse) === 'e2');
}

console.log('— autocomplete textbox by label —');
{
  const snap = ['text "Employee Name" [ref=e10]', 'textbox "Type for hints..." [ref=e11]'].join('\n');
  ok('returns the textbox ref near Employee Name', resolveInteractiveRefNearLabel(snap, 'Employee Name', parse) === 'e11');
}

console.log('— never returns a static element when nothing interactive is near —');
{
  const snap = ['heading "Add User" [ref=e158]', 'paragraph "some help text" [ref=e159]'].join('\n');
  ok('no interactive control near → null (then conductor blocks honestly)', resolveInteractiveRefNearLabel(snap, 'User Role', parse) === null, JSON.stringify(resolveInteractiveRefNearLabel(snap, 'User Role', parse)));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — label-region resolver: finds the real interactive control near the label, never a static heading');
