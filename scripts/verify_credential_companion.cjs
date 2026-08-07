'use strict';
/*
 * GUARD: credential/identity COMPANION resolution + credential-token aliasing.
 *
 * Root cause it locks down (live run e8307486, v8): a login/gateway case bound to a
 * FUNCTIONAL sheet (which carries only a profileKey foreign key, not credentials)
 * left {{username}}/{{loginpassword}} unresolved → the execution-time token gate
 * BLOCKED the row before the browser did anything → nothing logged in → "browser
 * opens and closes before the conductor starts". The Architect DID emit the correct
 * `companions` join to the shared profiles sheet, but:
 *   1. hydrateBinding rebuilt the binding and DROPPED `companions`;
 *   2. resolveCaseRows never applied companions;
 *   3. buildTokenMap had no credential aliasing ({{username}} vs a loginUsername col).
 *
 * This guard proves the runtime now resolves credentials from a companion profiles
 * sheet (joined by profileKey) AND via credential aliasing on a directly-bound
 * profiles sheet — with purely synthetic, generic data (no site strings, no DB).
 */
const path = require('path');
const tdm = require(path.join(__dirname, '..', 'server', 'services', 'testDataMatrix.js'));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { console.log('PASS ' + msg); pass++; } else { console.log('FAIL ' + msg); fail++; } };

// ── Synthetic workbook: a functional sheet with a profileKey FK + a shared
//    profiles sheet holding the credentials (the generic "one credentials sheet,
//    functional sheets reference it by key" design). ──────────────────────────
const testData = {
  sheets: [
    {
      name: 'Feature_Matrix',
      headers: ['caseId', 'profileKey', 'widgetLabel', 'expectedSignal'],
      rows: [
        { caseId: 'F-01', profileKey: 'ADMIN_DEFAULT', widgetLabel: 'Alpha', expectedSignal: 'Alpha visible' },
        { caseId: 'F-02', profileKey: 'STAFF_USER',    widgetLabel: 'Beta',  expectedSignal: 'Beta visible' },
      ],
    },
    {
      name: 'Profiles',
      headers: ['profileKey', 'loginUsername', 'loginPassword'],
      rows: [
        { profileKey: 'ADMIN_DEFAULT', loginUsername: 'adminuser', loginPassword: 'adminpass' },
        { profileKey: 'STAFF_USER',    loginUsername: 'staffuser', loginPassword: 'staffpass' },
      ],
    },
  ],
};

// Case bound to the FUNCTIONAL sheet, carrying the Architect's credential companion.
const companionCase = {
  id: 'tc-companion',
  name: 'Login and verify widget',
  steps: JSON.stringify([
    { order: 1, action: 'Navigate', target: 'login page', value: 'http://x/login' },
    { order: 2, action: 'Fill', target: 'Username field', value: '{{username}}' },
    { order: 3, action: 'Fill', target: 'Password field', value: '{{loginpassword}}' },
    { order: 4, action: 'Click', target: 'Login button' },
    { order: 5, action: 'Verify', target: 'widget', value: '{{widgetlabel}}' },
  ]),
  dataBindingJson: JSON.stringify({
    sheet: 'Feature_Matrix',
    rowSelector: 'all',
    columnToField: { caseid: 'caseId', role: 'profileKey', widgetlabel: 'widgetLabel' },
    expectedColumn: 'expectedSignal',
    companions: [{ sheet: 'Profiles', columnToField: { username: 'loginUsername', loginpassword: 'loginPassword' }, source: 'credential_companion' }],
  }),
};

const rows = tdm.resolveCaseRows(companionCase, { name: 'S' }, testData, {});
ok(rows.length === 2, `companion case fans out to both rows (got ${rows.length})`);

// Per-row: the companion must resolve the RIGHT identity by profileKey (not row[0]).
const r0 = rows.find((r) => r.raw && r.raw.caseId === 'F-01');
const r1 = rows.find((r) => r.raw && r.raw.caseId === 'F-02');
ok(r0 && r0.inputs.username === 'adminuser' && r0.inputs.loginpassword === 'adminpass',
  `row F-01 joins ADMIN_DEFAULT credentials (${r0 && r0.inputs.username}/${r0 && r0.inputs.loginpassword})`);
ok(r1 && r1.inputs.username === 'staffuser' && r1.inputs.loginpassword === 'staffpass',
  `row F-02 joins STAFF_USER credentials by profileKey, NOT the first row (${r1 && r1.inputs.username})`);

for (const r of rows) {
  const useTc = tdm.substituteCase(companionCase, r);
  const unresolved = tdm.findUnresolvedTokens(useTc);
  ok(unresolved.length === 0, `row ${r.raw.caseId} has no unresolved tokens after substitution (${unresolved.join(',') || 'none'})`);
  const steps = JSON.parse(useTc.steps);
  const uname = steps.find((s) => /Username/i.test(s.target || '')).value;
  ok(uname && !/\{\{/.test(uname), `row ${r.raw.caseId} username field is a literal value, not a token (${uname})`);
}

// ── Credential aliasing: a case bound DIRECTLY to the profiles sheet, no companion,
//    no columnToField. {{username}} must alias to the loginUsername column. ──────
const directCase = {
  id: 'tc-direct',
  name: 'Login using profiles sheet directly',
  steps: JSON.stringify([
    { order: 1, action: 'Fill', target: 'Username field', value: '{{username}}' },
    { order: 2, action: 'Fill', target: 'Password field', value: '{{loginpassword}}' },
  ]),
  dataBindingJson: JSON.stringify({ sheet: 'Profiles', rowSelector: 'all' }),
};
const dRows = tdm.resolveCaseRows(directCase, { name: 'S' }, testData, {});
ok(dRows.length >= 1, `direct-profiles case resolves rows (got ${dRows.length})`);
if (dRows.length) {
  const useTc = tdm.substituteCase(directCase, dRows[0]);
  const unresolved = tdm.findUnresolvedTokens(useTc);
  ok(unresolved.length === 0, `direct-profiles case: {{username}} aliases to loginUsername, no unresolved tokens (${unresolved.join(',') || 'none'})`);
}

// ── Aliasing must NOT overwrite an explicit username the row already supplied. ──
const explicitCase = {
  id: 'tc-explicit',
  name: 'explicit username wins',
  steps: JSON.stringify([{ order: 1, action: 'Fill', target: 'Username field', value: '{{username}}' }]),
  dataBindingJson: JSON.stringify({ sheet: 'Feature_Matrix', rowSelector: 'all', columnToField: { username: 'widgetLabel' } }),
};
const eRows = tdm.resolveCaseRows(explicitCase, { name: 'S' }, testData, {});
ok(eRows.length >= 1 && eRows[0].inputs.username === 'Alpha',
  `explicit username mapping is preserved, alias does not clobber it (${eRows[0] && eRows[0].inputs.username})`);

// ── RUN-ONCE: a credential-only case collapses to a single execution ───────────
// "Login and verify dashboard" bound to a functional sheet consumes ONLY
// {{username}}/{{loginpassword}} — it must run once, not once per row.
const loginOnlyCase = {
  id: 'tc-login-only', name: 'Login and verify dashboard',
  steps: JSON.stringify([
    { order: 1, action: 'Fill', target: 'Username field', value: '{{username}}' },
    { order: 2, action: 'Fill', target: 'Password field', value: '{{loginpassword}}' },
    { order: 3, action: 'Click', target: 'Login button' },
    { order: 4, action: 'Verify', target: 'Dashboard' },
  ]),
  dataBindingJson: JSON.stringify({ sheet: 'Feature_Matrix', rowSelector: 'all', columnToField: { role: 'profileKey' }, companions: [{ sheet: 'Profiles', columnToField: { username: 'loginUsername', loginpassword: 'loginPassword' }, source: 'credential_companion' }] }),
};
ok(tdm.caseConsumesOnlyCredentials(loginOnlyCase) === true, `caseConsumesOnlyCredentials true for a credentials-only login case`);
const loginOnlyRows = tdm.resolveCaseRows(loginOnlyCase, { name: 'S' }, testData, {});
ok(loginOnlyRows.length === 1, `credential-only case runs ONCE, not once per row (got ${loginOnlyRows.length}, sheet has 2 rows)`);

// A case that ALSO consumes a distinguishing field still fans out over every row.
const funcCase = {
  id: 'tc-func', name: 'Verify widget per row',
  steps: JSON.stringify([
    { order: 1, action: 'Fill', target: 'Username field', value: '{{username}}' },
    { order: 2, action: 'Click', target: 'Widget', value: '{{widgetlabel}}' },
  ]),
  dataBindingJson: JSON.stringify({ sheet: 'Feature_Matrix', rowSelector: 'all', columnToField: { role: 'profileKey', widgetlabel: 'widgetLabel' }, companions: [{ sheet: 'Profiles', columnToField: { username: 'loginUsername', loginpassword: 'loginPassword' }, source: 'credential_companion' }] }),
};
ok(tdm.caseConsumesOnlyCredentials(funcCase) === false, `caseConsumesOnlyCredentials false when a distinguishing field ({{widgetlabel}}) is consumed`);
ok(tdm.resolveCaseRows(funcCase, { name: 'S' }, testData, {}).length === 2, `case consuming a distinguishing field still fans out over all rows`);

console.log('───────────────────────────────────────────────');
if (fail) { console.log(`RESULT: RED — ${fail} assertion(s) failed, ${pass} passed.`); process.exit(1); }
console.log(`RESULT: GREEN — ${pass} assertions passed (credential companion + aliasing resolve login tokens).`);
