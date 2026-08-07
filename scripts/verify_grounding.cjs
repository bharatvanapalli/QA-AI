// Proves the assertion-grounding cure deterministically — NO live run, NO
// credits. Covers:
//  (1) groundCaseAssertions demote/keep decisions,
//  (2) the MASKING GUARD (architect review #2): a 'must' is NEVER demoted, so a
//      genuinely-missing BRD-mandated text surfaces as a FAIL, not an auto-pass,
//  (3) the money shot: properly-tiered S4·C1 inputs go needs_human → pass.
const { groundCaseAssertions, textPresent, pageMatchesTarget } = require('../server/lib/groundAssertions');
const { computeVerdict } = require('../server/services/computeVerdict');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

// ── Synthetic atlas: what an AUTHENTICATED OrangeHRM crawl would capture ──
const atlas = {
  pages: [
    { url: 'https://x/web/index.php/auth/login', normalizedUrl: 'https://x/web/index.php/auth/login',
      pageRole: 'login page', textCorpus: ['Username', 'Password', 'Login', 'OrangeHRM'], elementLabels: [] },
    { url: 'https://x/web/index.php/pim/viewEmployeeList', normalizedUrl: 'https://x/web/index.php/pim/viewemployeelist',
      pageRole: 'employee list', textCorpus: ['Employee Information', 'Employee Name', 'Employee Id', 'Employment Status', 'Add', 'Search'], elementLabels: [] },
    { url: 'https://x/web/index.php/pim/addEmployee', normalizedUrl: 'https://x/web/index.php/pim/addemployee',
      pageRole: 'add employee form', textCorpus: ['Add Employee', 'First Name', 'Middle Name', 'Last Name', 'Employee Id', 'Create Login Details'], elementLabels: [] },
  ],
  allText: [],
};
atlas.allText = [...new Set(atlas.pages.flatMap((p) => p.textCorpus.map((t) => t.toLowerCase())))];

// criticality defaults to 'incidental' here so the demotion tests exercise the
// SOFT tier; the masking-guard tests pass criticality:'must' explicitly.
const A = (id, expectedText, targetUrl, criticality = 'incidental', provenance = 'inferred') =>
  ({ id, type: 'TEXT', criticality, provenance, payload: { expectedText }, targetUrl: targetUrl || null });

// ── (1) decision tests — SOFT tier (demotable) ──
console.log('groundCaseAssertions — soft-tier decisions');
{
  const a = A('ASN-1', 'Employee Name', '/pim/addEmployee');          // wrong page (it's a list-page label), incidental
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(a.parseFailed === true && a.parseFailedReason === 'text_ungrounded', 'incidental "Employee Name" on /pim/addEmployee → demoted (text_ungrounded)');
}
{
  const a = A('ASN-2', 'First Name', '/pim/addEmployee');
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(!a.parseFailed, 'incidental "First Name" on /pim/addEmployee → kept (grounded)');
}
{
  const a = A('ASN-4', 'Add to Wishlist');                            // no targetUrl, on NO page → fabrication
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(a.parseFailed === true, 'incidental "Add to Wishlist" (no page shows it) → demoted (fabrication)');
}
{
  const a = A('ASN-5', 'Employee Name');                              // no targetUrl, exists on list page
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(!a.parseFailed, 'incidental "Employee Name" no targetUrl → kept (exists on list page; not a fabrication)');
}
{
  const thin = { pages: [atlas.pages[0]], allText: atlas.pages[0].textCorpus.map((t) => t.toLowerCase()) };
  const a = A('ASN-6', 'Some Label');
  groundCaseAssertions([a], [], thin, { caseName: 't' });
  ok(!a.parseFailed, 'thin atlas (1 page) + no targetUrl → kept (insufficient evidence)');
}

// ── (2) MASKING GUARD — a 'must' is NEVER demoted (architect review #2) ──
console.log('\nmasking guard — must-tier is never demoted');
{
  const a = A('ASN-M1', 'Employee Name', '/pim/addEmployee', 'must'); // same wrong-page text, but MUST
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(!a.parseFailed, 'must "Employee Name" on /pim/addEmployee → NOT demoted (flows to verdict)');
}
{
  const a = A('ASN-M2', 'Confidential HR Data', '/pim/addEmployee', 'must', 'doc_quoted'); // BRD-mandated, app missing it
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(!a.parseFailed, 'must+doc_quoted "Confidential HR Data" absent from app → NOT demoted (real defect must surface)');
}
{
  const a = A('ASN-M3', 'Add to Wishlist', null, 'must'); // pure fabrication BUT must
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(!a.parseFailed, 'must fabrication → NOT demoted (a wrong must fails loudly, never silently masked)');
}
{
  const a = { id: 'ASN-7', type: 'TEXT', criticality: 'incidental', payload: { unexpectedText: 'Error' }, targetUrl: '/pim/addEmployee' };
  groundCaseAssertions([a], [], atlas, { caseName: 't' });
  ok(!a.parseFailed, 'FORBIDDEN/unexpectedText → never demoted (absence is the point)');
}
{
  const a = A('ASN-8', 'First Name', '/pim/addEmployee');
  groundCaseAssertions([a], [], null, { caseName: 't' });
  ok(!a.parseFailed, 'no atlas → no-op (kept)');
}

// helper sanity
ok(textPresent('first name', ['First Name', 'Last Name']) === true, 'textPresent forward-contains');
ok(textPresent('employee name', ['First Name', 'Middle Name']) === false, 'textPresent rejects absent label');
ok(pageMatchesTarget(atlas.pages[2], '/pim/addEmployee') === true, 'pageMatchesTarget by path suffix');

// ── (3) END-TO-END verdicts ──
console.log('\ncomputeVerdict — before/after grounding + masking-guard defect surfacing');
const steps5 = [{ status: 'pass' }, { status: 'pass' }, { status: 'pass' }, { status: 'pass' }, { status: 'pass' }];
const term = { userCancelled: false, sessionDied: false, consecutiveErrorsExceeded: false, hitTurnCeiling: false, reachedEndTurn: true };

// BEFORE: untiered (default must) "Employee Name" came back uncheckable → needs_human.
{
  const declared = [
    { id: 'U', type: 'URL', criticality: 'must', payload: { expectedUrlPattern: '/pim/viewEmployeeList' } },
    { id: 'EN', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Employee Name' } },
    { id: 'EI', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Employee Id' } },
    { id: 'FN', type: 'TEXT', criticality: 'must', payload: { expectedText: 'First Name' } },
    { id: 'CL', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Create Login Details' } },
  ];
  const recorded = [
    { assertionId: 'U', outcome: 'matched' }, { assertionId: 'EN', outcome: 'uncheckable' },
    { assertionId: 'EI', outcome: 'matched' }, { assertionId: 'FN', outcome: 'matched' }, { assertionId: 'CL', outcome: 'matched' },
  ];
  const v = computeVerdict({ declared, recorded, steps: steps5, ...term });
  ok(v.status === 'needs_human', `BEFORE (untiered must) → ${v.status}(${v.reason})  [reproduces the bug]`);
}

// AFTER (proper authoring): atlas + tiering doctrine make the field-label check
// 'incidental' with the add-form targetUrl → the gate demotes it → excluded.
{
  const declared = [
    { id: 'U', type: 'URL', criticality: 'must', payload: { expectedUrlPattern: '/pim/viewEmployeeList' } },
    { id: 'EN', type: 'TEXT', criticality: 'incidental', payload: { expectedText: 'Employee Name' }, targetUrl: '/pim/addEmployee' },
    { id: 'EI', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Employee Id' } },
    { id: 'FN', type: 'TEXT', criticality: 'must', payload: { expectedText: 'First Name' } },
    { id: 'CL', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Create Login Details' } },
  ];
  const g = groundCaseAssertions(declared, [], atlas, { caseName: 'S4·C1' });
  ok(g.demoted.length === 1 && g.demoted[0].expected === 'Employee Name', 'gate demoted exactly the incidental "Employee Name"');
  const recorded = [
    { assertionId: 'U', outcome: 'matched' },
    { assertionId: 'EI', outcome: 'matched' }, { assertionId: 'FN', outcome: 'matched' }, { assertionId: 'CL', outcome: 'matched' },
  ];
  const v = computeVerdict({ declared, recorded, steps: steps5, ...term });
  ok(v.status === 'pass', `AFTER (tiered + gate) → ${v.status}(${v.reason})  [cure: no false escalation]`);
}

// MASKING GUARD end-to-end: a must BRD requirement the app is MISSING must FAIL,
// not be silently demoted to a pass.
{
  const declared = [
    { id: 'CONF', type: 'TEXT', criticality: 'must', provenance: 'doc_quoted', payload: { expectedText: 'Confidential HR Data' }, targetUrl: '/pim/addEmployee' },
  ];
  groundCaseAssertions(declared, [], atlas, { caseName: 'compliance' });
  ok(!declared[0].parseFailed, 'gate left the must BRD requirement intact (not masked)');
  const recorded = [{ assertionId: 'CONF', outcome: 'not_matched' }];
  const v = computeVerdict({ declared, recorded, steps: steps5, ...term });
  ok(v.status === 'fail', `missing BRD-mandated must → ${v.status}(${v.reason})  [real defect SURFACED, not masked]`);
}

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
