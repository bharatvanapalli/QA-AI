'use strict';
// Guard for the ADO extractor's DETERMINISTIC half: normaliseBehaviorModel
// (validation/coercion/drop) + the end-to-end raw-JSON -> normalise -> generate
// pipeline. The LLM extraction itself needs a real generation to validate.
const { normaliseBehaviorModel } = require('../server/services/agents/storyBehaviorExtractor');
const { generateScenariosFromBehaviorModel } = require('../server/services/storyBehaviorModel');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

// Raw JSON as the LLM would emit for the LINX story (note: maxLength as a STRING
// and a junk rule kind, to prove coercion + dropping).
const rawLLM = {
  actor: 'LINX User Management Admin',
  feature: 'User profile Notes',
  preconditions: ['Admin is logged in', ''],
  actions: ['add note', 'edit note', 'delete note'],
  fields: [
    { name: 'Note', role: 'noteText', optional: true, maxLength: '200', counterRequired: true },
    { name: 'Email', role: 'email', format: 'email', example: 'John.Doe@odysseylogistics.com' },
    { name: 'Subsidiary', role: 'select' },
    { name: '', role: 'text' },                 // unnamed -> must be DROPPED
    { role: 'text', maxLength: 'abc' },          // no name + junk maxLength -> DROPPED
  ],
  businessRules: [
    { kind: 'max_count', entity: 'Notes', max: '5', control: 'Add Note', message: 'Please delete any of the existing note(s) to add a new note' },
    { kind: 'confirmation_required', action: 'delete note', message: 'Please confirm if you wish to proceed with deleting this note.' },
    { kind: 'ordering', order: 'newest_first' },
    { kind: 'edit_moves_to_top' },
    { kind: 'totally_made_up_rule', max: 9 },     // invalid kind -> DROPPED
  ],
};

console.log('— normaliseBehaviorModel: coercion + validation + drop —');
{
  const m = normaliseBehaviorModel(rawLLM);
  ok('returns a model', !!m);
  ok('3 valid fields (unnamed dropped)', m && m.fields.length === 3, m && m.fields.length);
  const note = m && m.fields.find((f) => f.name === 'Note');
  ok('Note.maxLength coerced "200" -> 200 (number)', note && note.maxLength === 200, note && JSON.stringify(note));
  ok('Note.optional + counterRequired preserved', note && note.optional === true && note.counterRequired === true);
  ok('4 valid business rules (junk kind dropped)', m && m.businessRules.length === 4, m && m.businessRules.length);
  const mc = m && m.businessRules.find((r) => r.kind === 'max_count');
  ok('max_count.max coerced "5" -> 5', mc && mc.max === 5, mc && JSON.stringify(mc));
  ok('blank precondition dropped', m && m.preconditions.length === 1);
}

console.log('\n— degenerate / over-claim safety —');
ok('null -> null', normaliseBehaviorModel(null) === null);
ok('non-object -> null', normaliseBehaviorModel('nope') === null);
ok('empty object (no structure) -> null', normaliseBehaviorModel({}) === null);
ok('fields-only model is valid', !!normaliseBehaviorModel({ fields: [{ name: 'X', maxLength: 10 }] }));
ok('rules-only model is valid', !!normaliseBehaviorModel({ businessRules: [{ kind: 'ordering', order: 'newest_first' }] }));
ok('only-junk model -> null (no testable structure)', normaliseBehaviorModel({ fields: [{ role: 'x' }], businessRules: [{ kind: 'bogus' }] }) === null);

console.log('\n— END-TO-END: raw LLM JSON -> normalise -> generate scenarios —');
{
  const m = normaliseBehaviorModel(rawLLM);
  const scns = generateScenariosFromBehaviorModel(m);
  const findScn = (re) => scns.find((x) => re.test(x.name));
  const has = (s, pred) => s && s.requiredEvidence.some(pred);
  ok('generated scenarios from the normalised model', scns.length >= 10, scns.length);
  ok('200-char scenario with counter_shows 200/200', has(findScn(/accepts exactly 200/i), (e) => e.kind === 'counter_shows' && e.expected === '200/200'));
  ok('over-200 rejected', has(findScn(/rejects\/prevents more than 200/i), (e) => e.kind === 'value_rejected'));
  ok('max-5 control_disabled', has(findScn(/Max 5 Notes/i), (e) => e.kind === 'control_disabled' && e.control === 'Add Note'));
  ok('delete confirmation Yes/No present', !!findScn(/choosing "Yes"/i) && !!findScn(/choosing "No"/i));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — extractor normaliser + extract->generate pipeline verified');
