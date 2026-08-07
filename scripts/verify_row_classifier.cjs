'use strict';
// Guard for Phase A1 — per-row outcome classifier (testDataMatrix.classifyRowOutcomeClass).
// Rows mirror the EXACT shape resolveCaseRows() emits:
//   { index, setName, sheet, inputs:{role:val}, raw:{header:val}, expected,
//     rowClass, expectedColumn, rowClassColumn, label }
const { classifyRowOutcomeClass } = require('../server/services/testDataMatrix');

let fail = 0;
function check(label, row, wantClass, wantConfidence) {
  const r = classifyRowOutcomeClass(row);
  const okClass = r.class === wantClass;
  const okConf = wantConfidence == null || r.confidence === wantConfidence;
  const pass = okClass && okConf;
  if (!pass) fail++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}  -> ${r.class}/${r.confidence} (basis:${r.basis})${pass ? '' : `  WANT ${wantClass}${wantConfidence ? '/' + wantConfidence : ''}`}`);
}

const mk = (o) => ({ index: 0, setName: 'S', sheet: 'S', inputs: {}, raw: {}, expected: null, rowClass: null, expectedColumn: null, rowClassColumn: null, label: 'Row 1', ...o });

console.log('— Real AuthProfiles shape (no class column; expectedLandingPage destination) —');
check('admin valid login -> success', mk({
  inputs: { username: 'Admin', password: 'admin123' },
  raw: { authRole: 'admin', expectedLandingPage: '/web/index.php/dashboard/index' },
  expected: '/web/index.php/dashboard/index', expectedColumn: 'expectedLandingPage', label: 'Row 1 · admin',
}), 'success', 'high');

console.log('\n— Login negative/positive rows (the run-90002e1c matrix) —');
check('emptyUsername (blank input)', mk({ inputs: { username: '', password: 'admin123' }, label: 'Row 1' }), 'required_validation', 'high');
check('emptyUsername (rowClass signal; inputs non-blank)', mk({ inputs: { username: 'x', password: 'y' }, rowClass: 'emptyUsername', rowClassColumn: 'scenarioType', label: 'Row 1 · emptyUsername · x' }), 'required_validation', 'high');
check('emptyPassword (blank input)', mk({ inputs: { username: 'Admin', password: '' }, label: 'Row 2' }), 'required_validation', 'high');
check('bothFieldsEmpty', mk({ inputs: { username: '', password: '' }, label: 'Row 3' }), 'required_validation', 'high');
check('validAdminInputs (rowClass)', mk({ inputs: { username: 'Admin', password: 'admin123' }, rowClass: 'validAdminInputs', rowClassColumn: 'scenarioType', label: 'Row 4 · validAdminInputs · Admin' }), 'success', 'high');
check('validESSInputs (rowClass)', mk({ inputs: { username: 'ess', password: 'pass' }, rowClass: 'validESSInputs', rowClassColumn: 'scenarioType', label: 'Row 5 · validESSInputs · ess' }), 'success', 'high');
check('invalidCredentials (rowClass) -> rejection NOT success', mk({ inputs: { username: 'wrong', password: 'wrong' }, rowClass: 'invalidCredentials', rowClassColumn: 'scenarioType', label: 'Row 6 · invalidCredentials · wrong' }), 'auth_rejection', 'high');
check('overlong username (oversized input)', mk({ inputs: { username: 'a'.repeat(70), password: 'x' }, label: 'Row 7' }), 'auth_rejection', 'medium');

console.log('\n— Expected-outcome column semantics —');
check('expectedError "Required" -> validation', mk({ inputs: { username: '', password: 'x' }, expected: 'Required', expectedColumn: 'expectedError' }), 'required_validation', 'high');
check('expectedError "Invalid credentials" -> rejection', mk({ inputs: { username: 'a', password: 'b' }, expected: 'Invalid credentials', expectedColumn: 'expectedError' }), 'auth_rejection', 'high');
check('expectedLandingPage=/auth/login -> STAY (rejection, not success)', mk({ inputs: { username: 'a', password: 'b' }, expected: '/web/index.php/auth/login', expectedColumn: 'expectedLandingPage' }), 'auth_rejection', 'medium');
check('expectedResultCount=0 -> boundary', mk({ inputs: { searchName: 'zzzz' }, expected: '0', expectedColumn: 'expectedResultCount' }), 'boundary', 'high');
check('scenarioType="Negative access" (raw class col)', mk({ inputs: { username: 'a', password: 'b' }, raw: { scenarioType: 'Negative access' } }), 'auth_rejection', 'high');

console.log('\n— NO-FAKE / control-char-fix proofs —');
check('value with SPACE not garbage ("admin user")', mk({ inputs: { username: 'admin user', password: 'pass word' }, label: 'Row 1' }), 'success', 'medium');
check('value with HYPHEN not garbage ("user-1")', mk({ inputs: { username: 'user-1', password: 'pass-123' }, label: 'Row 1' }), 'success', 'medium');
check('pure-symbol value IS garbage ("@@@@@@")', mk({ inputs: { username: '@@@@@@', password: 'x' }, label: 'Row 1' }), 'auth_rejection', 'medium');
check('well-formed-WRONG creds, no label -> success/medium (honest defer to live evidence)', mk({ inputs: { username: 'wrong', password: 'wrongpass' }, label: 'Row 1' }), 'success', 'medium');

console.log('\n— Degenerate / edge inputs (no crash, honest unknown) —');
check('null row -> unknown', null, 'unknown', 'low');
check('empty inputs {} -> unknown (Conductor resolves live)', mk({ inputs: {} }), 'unknown', 'low');
check('whitespace-only input -> validation (treated as blank)', mk({ inputs: { username: '   ', password: 'x' } }), 'required_validation', 'high');

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — row classifier verified on real-shaped rows + edge cases');
