'use strict';
/*
 * FIX 2 (token-aware grounding) + FIX 3/4 (provisional needs_review, not blocked).
 *
 *  • groundAssertions must NOT demote a tokenized expectedText ({{expected}}) — it
 *    resolves per-row at run time; grounding runs pre-substitution. A literal string
 *    genuinely absent from the atlas is still demoted (control).
 *  • The CaseCompiler treats a PROVISIONAL binding (story_id_conflict, or
 *    data_binding_sheet_exists_only) as needs_review — surfaced, not a hard token block
 *    — because the correct sheet is pending human resolution. A COMMITTED binding with
 *    a genuinely unmapped token still BLOCKS (core invariant intact).
 *
 * Pure fixtures, generic.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { groundCaseAssertions } = require(path.join(ROOT, 'server', 'lib', 'groundAssertions'));
const caseCompiler = require(path.join(ROOT, 'server', 'services', 'caseCompiler'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— Fix 2: grounding skips tokenized data-oracle expectedText, still demotes fabricated literals —');
{
  const atlas = {
    pages: [
      { url: 'https://x/a', textCorpus: ['Dashboard', 'Assign Leave'] },
      { url: 'https://x/b', textCorpus: ['Admin', 'System Users'] },
      { url: 'https://x/c', textCorpus: ['PIM', 'Employee List'] },
    ],
    allText: ['Dashboard', 'Assign Leave', 'Admin', 'System Users', 'PIM', 'Employee List'],
    structuralNames: [],
  };
  const assertions = [
    { id: 't1', type: 'TEXT', criticality: 'should', payload: { expectedText: '{{expected}}' } },
    { id: 't2', type: 'TEXT', criticality: 'should', payload: { expectedText: '{{expectedVisibleSignal}}' } },
    { id: 't3', type: 'TEXT', criticality: 'should', payload: { expectedText: 'Totally Fabricated Zzz Text' } },
    { id: 't4', type: 'TEXT', criticality: 'should', payload: { expectedText: 'Dashboard' } },
  ];
  groundCaseAssertions(assertions, [], atlas, { caseName: 'c' });
  ok('{{expected}} token NOT demoted (resolves per-row at runtime)', assertions[0].parseFailed !== true, JSON.stringify(assertions[0]));
  ok('{{expectedVisibleSignal}} token NOT demoted', assertions[1].parseFailed !== true);
  ok('a genuinely fabricated literal IS still demoted (control)', assertions[2].parseFailed === true && assertions[2].parseFailedReason === 'text_ungrounded');
  ok('a grounded literal ("Dashboard") is left alone', assertions[3].parseFailed !== true);
}

console.log('\n— Fix 3/4: provisional needs_review bindings are needs_review, NOT hard-blocked —');
const must = [{ type: 'TEXT', criticality: 'must', payload: { expectedText: 'Saved' } }];
{
  // story_id_conflict — unbound (sheet:null) + tokens. Must be needs_review, not blocked.
  const v = caseCompiler.compileCase({
    name: 'story conflict case', automatability: 'automatable',
    steps: [{ action: 'Fill', element: 'First Name', value: '{{firstName}}' }],
    declaredAssertions: must,
    dataBinding: { sheet: null, matchKind: 'needs_review', needsReview: true, source: 'story_id_conflict', findings: [{ code: 'story_id_conflict', severity: 'warning', detail: 'x' }] },
  });
  ok('story_id_conflict + tokens → needs_review (not blocked)', v.state === 'needs_review' && !v.blockers.some((b) => /unresolved_tokens|unmapped/.test(b.code)) && v.warnings.some((w) => w.code === 'tokens_pending_binding_review'), JSON.stringify({ st: v.state, bl: v.blockers.map((b) => b.code), w: v.warnings.map((w) => w.code) }));
}
{
  // sheet-exists-only — bound by name, no proof, no status:'incomplete'. Unmapped token
  // present. Must be needs_review, not blocked on data_binding_incomplete or unmapped_tokens.
  const v = caseCompiler.compileCase({
    name: 'sheet exists only case', automatability: 'automatable',
    steps: [{ action: 'Fill', element: 'F', value: '{{someField}}' }],
    declaredAssertions: must,
    dataBinding: { sheet: 'Admin_UserSearch', matchKind: 'needs_review', needsReview: true, repairedBy: 'coverage_planner_sheet_exists', findings: [{ code: 'data_binding_sheet_exists_only', severity: 'warning', detail: 'x' }, { code: 'data_placeholder_not_in_mapping', severity: 'warning', token: 'someField' }] },
  });
  ok('sheet_exists_only → needs_review (not data_binding_incomplete / unmapped_tokens block)', v.state === 'needs_review' && v.blockers.length === 0, JSON.stringify({ st: v.state, bl: v.blockers.map((b) => b.code) }));
}
{
  // STALE status:'incomplete' on a PROVISIONAL binding (legacy/partially-repaired row)
  // must NOT hard-block — the reviewer's exact gap. needs_review, not data_binding_incomplete.
  const v = caseCompiler.compileCase({
    name: 'stale incomplete sheet-exists', automatability: 'automatable',
    steps: [], declaredAssertions: must,
    dataBinding: { sheet: 'Admin_UserSearch', status: 'incomplete', matchKind: 'needs_review', needsReview: true, findings: [{ code: 'data_binding_sheet_exists_only', severity: 'warning', detail: 'x' }] },
  });
  ok('provisional binding with STALE status:incomplete → needs_review (not data_binding_incomplete)', v.state === 'needs_review' && !v.blockers.some((b) => b.code === 'data_binding_incomplete'), JSON.stringify({ st: v.state, bl: v.blockers.map((b) => b.code) }));
}
{
  // A REAL structural error ALWAYS blocks, even on a provisional binding.
  const v = caseCompiler.compileCase({
    name: 'provisional but structurally broken', automatability: 'automatable',
    steps: [], declaredAssertions: must,
    dataBinding: { sheet: 'Ghost_Sheet', status: 'incomplete', matchKind: 'needs_review', findings: [{ code: 'data_binding_sheet_exists_only', severity: 'warning' }, { code: 'data_binding_sheet_not_found', severity: 'error', sheet: 'Ghost_Sheet' }] },
  });
  ok('provisional + REAL structural error → still BLOCKED (data_binding_incomplete)', v.state === 'blocked' && v.blockers.some((b) => b.code === 'data_binding_incomplete'), JSON.stringify({ st: v.state, bl: v.blockers.map((b) => b.code) }));
}
{
  // CONTROL — a COMMITTED binding (no provisional finding) with a genuinely unmapped
  // token still HARD-BLOCKS. The core invariant is intact.
  const v = caseCompiler.compileCase({
    name: 'committed unmapped', automatability: 'automatable',
    steps: [{ action: 'Fill', element: 'F', value: '{{ghostField}}' }],
    declaredAssertions: must,
    dataBinding: { sheet: 'Admin_UserSearch', matchKind: 'storyId', status: 'complete', findings: [{ code: 'data_placeholder_not_in_mapping', severity: 'warning', token: 'ghostField' }] },
  });
  ok('committed binding + unmapped token → BLOCKED (invariant intact)', v.state === 'blocked' && v.blockers.some((b) => b.code === 'unmapped_tokens'), JSON.stringify({ st: v.state, bl: v.blockers.map((b) => b.code) }));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — grounding is token-aware (data-oracle placeholders survive), and provisional needs_review bindings (story_id_conflict / sheet_exists_only) surface as needs_review while a committed binding with an unmapped token still hard-blocks.');
