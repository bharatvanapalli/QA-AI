'use strict';
// Guard for the Evidence Vocabulary Registry (friend checkpoint #1).
// ENFORCES: every requiredEvidence kind that ANY generator emits is registered.
// Add a new kind to a generator without registering it -> this guard fails.
const reg = require('../server/services/evidenceRegistry');
const { buildRowEvidenceContract } = require('../server/services/testDataMatrix');
const { generateScenariosFromBehaviorModel } = require('../server/services/storyBehaviorModel');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const mkRow = (o) => ({ index: 0, setName: 'S', sheet: 'S', inputs: {}, raw: {}, expected: null, rowClass: null, expectedColumn: null, rowClassColumn: null, label: 'Row 1', ...o });

// 1) Every kind the data-contract builder can emit (across the row classes).
const contractRows = [
  mkRow({ inputs: { username: '', password: 'x' }, label: 'Row 1 · emptyUsername' }),                              // required_validation
  mkRow({ inputs: { username: 'Admin', password: 'admin123' }, expected: '/web/index.php/dashboard/index', expectedColumn: 'expectedLandingPage' }), // success + page_present
  mkRow({ inputs: { username: 'wrong', password: 'wrong' }, label: 'Row · invalidCredentials' }),                  // auth_rejection
  mkRow({ inputs: { searchName: 'zzz' }, expected: '0', expectedColumn: 'expectedResultCount' }),                  // boundary / empty_result
  mkRow({ inputs: {} }),                                                                                            // unknown -> page_settled
  mkRow({ inputs: { username: 'Admin', password: 'admin123' }, raw: { username: 'Admin', password: 'admin123', expectedVisibleMenuItems: 'Dashboard', expectedHiddenMenuItems: 'Admin', expectedLandingPage: '/x/dashboard' }, expected: '/x/dashboard', expectedColumn: 'expectedLandingPage' }), // element_present/absent
];
const contractKinds = new Set();
for (const r of contractRows) for (const e of buildRowEvidenceContract(r).requiredEvidence) contractKinds.add(e.kind);

// 2) Every kind the ADO generator can emit (LINX story).
const linx = {
  actor: 'Admin', feature: 'Notes',
  fields: [{ name: 'Note', role: 'noteText', optional: true, maxLength: 200, counterRequired: true }, { name: 'Email', role: 'email', format: 'email' }],
  businessRules: [
    { kind: 'max_count', entity: 'Notes', max: 5, control: 'Add Note', message: 'Please delete an existing note' },
    { kind: 'confirmation_required', action: 'delete note', message: 'Confirm delete?' },
    { kind: 'ordering', order: 'newest_first' },
    { kind: 'edit_moves_to_top' },
  ],
};
const adoKinds = new Set();
for (const s of generateScenariosFromBehaviorModel(linx)) for (const e of s.requiredEvidence) adoKinds.add(e.kind);

const allEmitted = [...new Set([...contractKinds, ...adoKinds])];
console.log('Kinds emitted by generators:', allEmitted.sort().join(', '), '\n');

console.log('— closed vocabulary: every emitted kind is registered —');
{
  const items = allEmitted.map((k) => ({ kind: k }));
  const r = reg.assertKindsRegistered(items);
  ok('all data-contract + ADO kinds are registered', r.ok, 'unregistered: ' + r.unregistered.join(','));
}

console.log('\n— a rogue/typo kind is caught —');
ok('unregistered kind flagged', reg.assertKindsRegistered([{ kind: 'totally_made_up' }]).ok === false);
ok('isRegistered("counter_shows") true', reg.isRegistered('counter_shows'));
ok('isRegistered("nope") false', reg.isRegistered('nope') === false);

console.log('\n— partition: the wired Phase-B-slice checkers GATE; everything else stays advisory —');
{
  // The login/slice checkers wired in evidenceCheckers.js (login_form_present is the
  // negative-login composite's 4th signal — audit #4 — also wired + gating).
  const WIRED = ['page_present', 'destination_absent', 'field_error', 'error_present', 'page_settled', 'login_form_present'];
  const items = allEmitted.map((k) => ({ kind: k }));
  const p = reg.partitionByCheckability(items);
  const checkableEmitted = allEmitted.filter((k) => reg.isCheckable(k));
  const advisoryEmitted = allEmitted.filter((k) => reg.isRegistered(k) && !reg.isCheckable(k));

  ok('nothing unregistered', p.unregistered.length === 0);
  ok('required (gating) is non-empty — slice checkers are wired', p.required.length > 0, 'required=' + p.required.map((x) => x.kind).join(','));
  ok('every gating kind is one of the wired B-slice checkers', p.required.every((x) => WIRED.includes(x.kind)), p.required.map((x) => x.kind).join(','));
  ok('gating set == checkable emitted kinds', p.required.length === checkableEmitted.length, `${p.required.length} vs ${checkableEmitted.length}`);
  ok('advisory = the not-yet-checkable emitted kinds (carry advisoryReason)', p.advisory.length === advisoryEmitted.length && p.advisory.every((x) => x.advisoryReason === 'no_deterministic_checker_yet'), `advisory=${p.advisory.map((x) => x.kind).join(',')}`);
  ok('checkableKinds() == exactly the wired kinds', reg.checkableKinds().slice().sort().join(',') === WIRED.slice().sort().join(','), reg.checkableKinds().join(','));
  ok('uncheckedKinds() == registered minus the wired', reg.uncheckedKinds().length === reg.registeredKinds().length - WIRED.length);
  // The role-access + ADO kinds emitted by the generators must NOT gate yet.
  ok('element_present stays advisory (no checker yet)', reg.isCheckable('element_present') === false);
  ok('empty_result stays advisory (no checker yet)', reg.isCheckable('empty_result') === false);
}

console.log('\nRemaining checker backlog (registered kinds still awaiting a deterministic checker):');
reg.uncheckedKinds().forEach((k) => console.log(`   - ${k} [${reg.EVIDENCE_KINDS[k].phase}]`));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — evidence registry closed-vocabulary enforcement verified');
