'use strict';
/*
 * #5 UNIVERSAL SECRET REDACTION — a password typed into a password field (and any
 * secret-named key) must never appear in the persisted trace, the live Action
 * Trail WS event, or Reports. Drives the REAL redactArgs (server/lib) + asserts
 * the conductor applies it at both the persistence chokepoint (stringifyAction)
 * and the live browser.action send.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { redactArgs, redactRecord } = require(path.join(ROOT, 'server', 'lib', 'redactSecrets'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const has = (o, v) => JSON.stringify(o).includes(v);

console.log('— browser_type into a PASSWORD field: the typed value is redacted —');
{
  const r = redactArgs({ tool: 'browser_type', element: 'Password field', target: 'e30', text: 'admin123' });
  ok('text "admin123" is masked', !has(r, 'admin123') && r.text === '••••••', JSON.stringify(r));
}
{
  const r = redactArgs({ element: 'Password', locator_hint: "input[type='password']", value: 'TestUser@123' });
  ok('value into [type=password] is masked', !has(r, 'TestUser@123'), JSON.stringify(r));
}

console.log('\n— a non-secret field is NOT over-masked —');
{
  const r = redactArgs({ tool: 'browser_type', element: 'Username field', target: 'e23', text: 'Admin' });
  ok('username text "Admin" is preserved (not a password field)', r.text === 'Admin', JSON.stringify(r));
}

console.log('\n— secret-NAMED keys are masked regardless of field —');
for (const key of ['password', 'pwd', 'token', 'apiKey', 'api_key', 'secret', 'credential']) {
  const r = redactArgs({ [key]: 'sek-' + key });
  ok(`key "${key}" masked`, r[key] === '••••••', JSON.stringify(r));
}

console.log('\n— nested args are redacted recursively; non-objects pass through —');
{
  const r = redactArgs({ fields: [{ element: 'Password', text: 'admin123' }, { element: 'Username', text: 'Admin' }] });
  ok('nested password masked, username kept', !has(r, 'admin123') && has(r, 'Admin'), JSON.stringify(r));
  ok('redactArgs(null/string) is a no-op', redactArgs(null) === null && redactArgs('x') === 'x');
}

console.log('\n— redactRecord masks data-row inputs by key (+ MASKED sensitivity) —');
{
  const r = redactRecord({ username: 'Admin', password: 'admin123', scenario: 'emptyPassword' });
  ok('record password masked, username/scenario kept', r.password === '••••••' && r.username === 'Admin' && r.scenario === 'emptyPassword', JSON.stringify(r));
  const all = redactRecord({ username: 'Admin', password: 'admin123' }, { maskAll: true });
  ok('maskAll (sensitivityLevel=MASKED row) masks everything', all.username === '••••••' && all.password === '••••••', JSON.stringify(all));
}

console.log('\n— the conductor APPLIES redaction at persistence + live send —');
{
  const src = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'conductor.js'), 'utf8');
  ok('imports the central redactor', /require\('\.\.\/\.\.\/lib\/redactSecrets'\)/.test(src));
  ok('stringifyAction redacts args before persisting (covers the in-memory trail on persistence)', src.includes('a = { ...a, args: redactArgs(a.args) }'));
  ok('memory-replay browser.action send redacts resolvedArgs', src.includes('args: redactArgs(resolvedArgs)'));
  // The reviewer-found live leak: the PRE-DISPATCH send must redact block.input.
  ok('PRE-DISPATCH browser.action send redacts block.input', src.includes('args: redactArgs(block.input)'));
  ok('COMPLETION browser.action send redacts tu.input', src.includes('args: redactArgs(tu.input || trailEntry.args || {})'));
  ok('assertion_check send redacts tu.input', src.includes('args: redactArgs(tu.input || {})'));
  ok('operation/step-assertion sends redact assertionInput', src.includes('args: redactArgs(assertionInput)'));
  // Negative check: the OLD raw pre-dispatch send shape (args: block.input → narration → actionStatus → status:'running') is GONE.
  ok('the raw pre-dispatch send (args: block.input + status:running) is closed', !/args: block\.input,\s*\n\s*narration,\s*\n\s*actionStatus,\s*\n\s*status: 'running'/.test(src));
  ok('no raw JSON.stringify(a.args) without redaction in stringifyAction', !/JSON\.stringify\(a\.args\)/.test(src) || /redactArgs\(a\.args\)/.test(src));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — secrets are redacted centrally: a password typed into a password field, and any secret-named key, never reach the persisted trace, the live Action Trail, or Reports.');
