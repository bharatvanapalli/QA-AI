'use strict';
// Guard for the ADO/text lane (Phase A) — deterministic scenario+evidence
// generation from a behavior model, proven on the REAL LINX "Add Note" story.
const { generateScenariosFromBehaviorModel, behaviorModelToGroundingBlock } = require('../server/services/storyBehaviorModel');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// Behavior model as the extractor would produce from the LINX ADO story.
const linx = {
  actor: 'LINX User Management Admin',
  feature: 'User profile Notes',
  preconditions: ['Admin is logged in'],
  actions: ['add internal user', 'update profile', 'add note', 'edit note', 'delete note'],
  fields: [
    { name: 'Note', role: 'noteText', optional: true, maxLength: 200, counterRequired: true },
    { name: 'Email', role: 'email', format: 'email', example: 'John.Doe@odysseylogistics.com' },
    { name: 'Subsidiary', role: 'select' },
  ],
  businessRules: [
    { kind: 'max_count', entity: 'Notes', max: 5, control: 'Add Note', message: 'Please delete any of the existing note(s) to add a new note' },
    { kind: 'confirmation_required', action: 'delete note', message: 'Please confirm if you wish to proceed with deleting this note.' },
    { kind: 'ordering', order: 'newest_first' },
    { kind: 'edit_moves_to_top' },
  ],
};

const scns = generateScenariosFromBehaviorModel(linx);
const ev = (name) => { const s = scns.find((x) => x.name === name); return s ? s.requiredEvidence : []; };
const has = (list, pred) => list.some(pred);
const findScn = (re) => scns.find((s) => re.test(s.name));

console.log(`Generated ${scns.length} scenarios from the LINX story:`);
scns.forEach((s) => console.log(`   • [${s.intentClass}] ${s.name}`));
console.log('');

ok('blank optional Note accepted', !!findScn(/optional left blank/i));
{
  const s = findScn(/accepts exactly 200/i);
  ok('Note accepts exactly 200 chars', !!s);
  ok('  -> value is exactly 200 chars', s && s.inputs.Note && s.inputs.Note.length === 200, s && (s.inputs.Note || '').length);
  ok('  -> requires counter_shows 200/200', s && has(s.requiredEvidence, (e) => e.kind === 'counter_shows' && e.expected === '200/200'));
}
{
  const s = findScn(/rejects\/prevents more than 200/i);
  ok('Note over-200 is prevented/rejected', !!s);
  ok('  -> value is 201 chars', s && s.inputs.Note && s.inputs.Note.length === 201, s && (s.inputs.Note || '').length);
  ok('  -> requires value_rejected (over_max_length)', s && has(s.requiredEvidence, (e) => e.kind === 'value_rejected' && e.reason === 'over_max_length'));
}
{
  const s = findScn(/Max 5 Notes/i);
  ok('max-5-notes scenario exists', !!s);
  ok('  -> requires control_disabled "Add Note"', s && has(s.requiredEvidence, (e) => e.kind === 'control_disabled' && e.control === 'Add Note'));
  ok('  -> requires item_count 5', s && has(s.requiredEvidence, (e) => e.kind === 'item_count' && e.expected === 5));
  ok('  -> requires the disabled message visible', s && has(s.requiredEvidence, (e) => e.kind === 'message_visible' && /delete any of the existing/i.test(e.textHint || '')));
}
{
  const yes = findScn(/choosing "Yes"/i);
  const no = findScn(/choosing "No"/i);
  ok('delete confirmation: Yes scenario', !!yes && has(yes.requiredEvidence, (e) => e.kind === 'confirmation_visible') && has(yes.requiredEvidence, (e) => e.kind === 'choice_outcome' && e.choice === 'Yes' && e.result === 'element_absent'));
  ok('delete confirmation: No scenario (item remains)', !!no && has(no.requiredEvidence, (e) => e.kind === 'choice_outcome' && e.choice === 'No' && e.result === 'element_present'));
}
{
  const valid = findScn(/Email: valid email/i);
  const invalid = findScn(/Email: invalid email/i);
  ok('Email valid-format scenario', !!valid);
  ok('Email invalid-format scenario -> format_rejected', !!invalid && has(invalid.requiredEvidence, (e) => e.kind === 'format_rejected' && e.field === 'Email'));
}
ok('ordering newest-first scenario', !!findScn(/newest-first|newest_first/i));
ok('edit-moves-to-top scenario', !!findScn(/editing an older entry moves it to the top/i));

// Anti-fake: every generated scenario carries at least one requiredEvidence item.
ok('every generated scenario has requiredEvidence (no vague/empty oracle)', scns.every((s) => Array.isArray(s.requiredEvidence) && s.requiredEvidence.length > 0));
// qa_standard provenance is tagged where the platform ADDED a check the doc didn't list (over-max, invalid format, blank-optional).
ok('AI-added checks tagged provenance qa_standard', scns.some((s) => s.provenance === 'qa_standard') && scns.some((s) => s.provenance === 'doc_quoted'));

// Degenerate input safety.
ok('null model -> [] (no crash)', Array.isArray(generateScenariosFromBehaviorModel(null)) && generateScenariosFromBehaviorModel(null).length === 0);
ok('empty model -> [] (no crash)', generateScenariosFromBehaviorModel({}).length === 0);

console.log('\n— Architect grounding block (the ADO bridge) —');
{
  const block = behaviorModelToGroundingBlock(linx);
  ok('names actor + feature', /LINX User Management Admin/.test(block) && /User profile Notes/i.test(block));
  ok('states Note: max 200 chars + character counter', /max 200 chars/i.test(block) && /character counter/i.test(block));
  ok('lists max_count rule (max=5, control "Add Note")', /max_count/.test(block) && /max=5/.test(block) && /Add Note/.test(block));
  ok('lists REQUIRED SCENARIO CLASSES with required evidence', /REQUIRED SCENARIO CLASSES/.test(block) && /required evidence:/.test(block));
  ok('surfaces counter_shows + control_disabled evidence to the architect', /counter_shows\(/.test(block) && /control_disabled\(/.test(block));
  ok('compacts the 200-char data value', /<200-char value>/.test(block));
  ok('empty model -> empty block (no crash)', behaviorModelToGroundingBlock(null) === '');
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — ADO behavior-model scenario generation + architect grounding bridge verified');
