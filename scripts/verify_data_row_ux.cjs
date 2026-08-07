'use strict';
/*
 * Guard for the data-driven RUN PRESENTATION + pre-run contract validation.
 * Replays the reviewer's confusing transcript concerns:
 *  - repeated Step 1..N must group under a labelled, valued data-row boundary;
 *  - every per-row event must carry the data-row identity;
 *  - model narration / plans / internal ratification must NOT look like browser actions;
 *  - a self-contradictory data row is blocked BEFORE the browser opens.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const conductor = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'conductor.js'), 'utf8');
const runStream = fs.readFileSync(path.join(ROOT, 'src', 'store', 'runStream.jsx'), 'utf8');
const theater = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'Theater.jsx'), 'utf8');
const reports = fs.readFileSync(path.join(ROOT, 'src', 'pages', 'Reports.jsx'), 'utf8');
const { dataRowContractDefect } = require(path.join(ROOT, 'server', 'lib', 'dataRowContract'));
const { resolveCaseRows, inferCaseRowScope, classifyRowOutcomeClass } = require(path.join(ROOT, 'server', 'services', 'testDataMatrix'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
// Strict ordering: BOTH substrings must exist (indexOf >= 0) AND a precede b.
// A missing substring returns -1 and "-1 < x" would otherwise pass accidentally.
const before = (hay, a, b) => { const ia = hay.indexOf(a); const ib = hay.indexOf(b); return ia >= 0 && ib >= 0 && ia < ib; };

console.log('-- A0. case-intent row scoping prevents whole-sheet execution --');
{
  const scenario = { name: 'Form Validation - Empty Field Submission', module: 'Form Validation' };
  const tc = {
    name: 'Data-driven form validation matrix',
    module: 'Form Validation',
    assertions: 'Submitting empty/blank fields keeps the user on the login page and shows the required inline validation error.',
    dataBindingJson: JSON.stringify({ sheet: 'FormValidation', rowSelector: 'all' }),
  };
  const testData = {
    mapping: {
      bindings: [{
        sheet: 'FormValidation',
        scenarioName: scenario.name,
        module: 'Form Validation',
        columnToField: { scenario: 'scenario', username: 'username', password: 'password', shouldSubmit: 'shouldSubmit' },
        expectedColumn: 'expectedValidationError',
        rowClassColumn: 'scenario',
      }],
    },
    sheets: [{
      name: 'FormValidation',
      headers: ['scenario', 'username', 'password', 'expectedValidationError', 'expectedErrorLocation', 'shouldSubmit'],
      rows: [
        { scenario: 'emptyUsername', username: '', password: 'validPassword123', expectedValidationError: 'Username is required', expectedErrorLocation: 'Below username field', shouldSubmit: 'No' },
        { scenario: 'emptyPassword', username: 'Admin', password: '', expectedValidationError: 'Password is required', expectedErrorLocation: 'Below password field', shouldSubmit: 'No' },
        { scenario: 'bothFieldsEmpty', username: '', password: '', expectedValidationError: 'Username is required; Password is required', expectedErrorLocation: 'On both fields', shouldSubmit: 'No' },
        { scenario: 'validAdminInputs', username: 'Admin', password: 'admin123', expectedValidationError: '', expectedErrorLocation: '', shouldSubmit: 'Yes' },
        { scenario: 'validESSInputs', username: 'ess_user_01', password: 'TestUser@123', expectedValidationError: '', expectedErrorLocation: '', shouldSubmit: 'Yes' },
        { scenario: 'usernameWithSpaces', username: ' Admin ', password: 'admin123', expectedValidationError: '', expectedErrorLocation: '', shouldSubmit: 'Varies' },
        { scenario: 'passwordWithSpaces', username: 'Admin', password: ' admin123 ', expectedValidationError: '', expectedErrorLocation: '', shouldSubmit: 'Varies' },
        { scenario: 'overlyLongUsername', username: 'A'.repeat(80), password: 'admin123', expectedValidationError: '', expectedErrorLocation: '', shouldSubmit: 'No' },
        { scenario: 'overlyLongPassword', username: 'Admin', password: 'P'.repeat(80), expectedValidationError: '', expectedErrorLocation: '', shouldSubmit: 'No' },
      ],
    }],
  };
  const scope = inferCaseRowScope(tc, scenario);
  const rows = resolveCaseRows(tc, scenario, testData);
  ok('empty-field case is scoped as required_validation_case', scope && scope.reason === 'required_validation_case');
  ok('empty-field matrix resolves 3 rows, not the whole 9-row sheet', rows.length === 3, `got ${rows.length}`);
  ok('only empty-field rows execute', rows.map((r) => r.rowClass).join('|') === 'emptyUsername|emptyPassword|bothFieldsEmpty', rows.map((r) => r.rowClass).join('|'));
  ok('filtered row labels are renumbered to 1/3, 2/3, 3/3', rows[0] && rows[0].label.startsWith('Row 1') && rows[2] && rows[2].label.startsWith('Row 3'));
  const matrixMayEstablishAuthenticatedSession = (resolvedRows) => resolvedRows.some((candidateRow) => {
    const outcome = classifyRowOutcomeClass(candidateRow);
    return outcome && (outcome.class === 'success' || outcome.class === 'unknown');
  });
  ok('empty-field validation matrix does NOT trigger per-row browser relaunch', matrixMayEstablishAuthenticatedSession(rows) === false);
  const successRows = resolveCaseRows({
    name: 'Valid login data matrix',
    module: 'Authentication',
    assertions: 'Valid credentials redirect to the dashboard.',
    dataBindingJson: JSON.stringify({ sheet: 'AuthProfiles', rowSelector: 'all' }),
  }, { name: 'Authentication', module: 'Authentication' }, {
    mapping: {
      bindings: [{
        sheet: 'AuthProfiles',
        module: 'Authentication',
        purpose: 'auth_profiles',
        columnToField: { role: 'role', username: 'username', password: 'password' },
        expectedColumn: 'expectedLandingPage',
        rowClassColumn: 'role',
      }],
    },
    sheets: [{
      name: 'AuthProfiles',
      headers: ['role', 'username', 'password', 'expectedLandingPage'],
      rows: [
        { role: 'admin', username: 'Admin', password: 'admin123', expectedLandingPage: '/web/index.php/dashboard/index' },
        { role: 'ess', username: 'ess_user_01', password: 'TestUser@123', expectedLandingPage: '/web/index.php/dashboard/index' },
      ],
    }],
  });
  ok('success login matrix DOES trigger per-row browser relaunch', matrixMayEstablishAuthenticatedSession(successRows) === true);
}

console.log('— A. pre-run data-contract validation (structural, generic) —');
ok('emptyPassword class + non-empty password → DEFECT (reviewer\'s Admin/admin123 row)',
  !!dataRowContractDefect({ rowClass: 'emptyPassword', inputs: { username: 'admin', password: 'admin123' } }));
ok('emptyUsername class + non-empty username → DEFECT',
  !!dataRowContractDefect({ rowClass: 'emptyUsername', inputs: { username: 'admin', password: 'x' } }));
ok('emptyPassword class + EMPTY password → no defect (consistent)',
  !dataRowContractDefect({ rowClass: 'emptyPassword', inputs: { username: 'admin', password: '' } }));
ok('shouldSubmit=No + full credentials → DEFECT', !!dataRowContractDefect({ inputs: { username: 'admin', password: 'admin123', shouldSubmit: 'No' } }));
ok('invalid-password negative row (no class contradiction) → no defect (value-validity is run-time)',
  !dataRowContractDefect({ rowClass: 'invalidPassword', inputs: { username: 'admin', password: 'wrong' } }));
ok('plain row / null → no defect', !dataRowContractDefect(null) && !dataRowContractDefect({ inputs: { username: 'admin', password: 'admin123' } }));

console.log('\n— B. backend emits first-class data-row events + threads identity + blocks contradictions —');
ok('emits a data.row.start event with row index/total/MASKED inputs/expected',
  conductor.includes("type: 'data.row.start'") && conductor.includes('totalRows: executions.length')
  // inputs are MASKED at the source: secret-like keys are redacted into __safeInputs,
  // then a capped preview (__previewInputs, first N keys + "+M more") is what is sent —
  // never the raw row.inputs. Assert BOTH the redaction and the masked-preview emit.
  && conductor.includes("__safeInputs[k] = __SECRET_RE.test(k)")
  && conductor.includes('inputs: __previewInputs') && conductor.includes('expected: row.expected'));
ok('send wrapper injects dataRowIndex/Label/Set onto every per-row event',
  conductor.includes('out.dataRowIndex = __rowMeta.dataRowIndex') && conductor.includes('out.dataSetName = __rowMeta.dataSetName'));
ok('pre-run contract defect blocks the row BEFORE the browser (continue, no runOneCase)',
  conductor.includes("const __drc = require('../../lib/dataRowContract')")
  && conductor.includes('__drc.dataRowContractDefect(row, {')
  && conductor.includes('if (__rowDefect) {')
  && conductor.includes("blockedReason: 'test_data_invalid', error: __rowErr")
  && before(conductor, 'if (__rowDefect) {', 'caseResult = await runOneCase({'));
ok('data.row.start is emitted only after all pre-run blockers pass',
  conductor.includes('__emitDataRowStart = () => send({')
  && before(conductor, 'if (__rowDefect) {', '__emitDataRowStart();')
  && before(conductor, 'continue; // do not open the browser for a self-contradictory row', '__emitDataRowStart();')
  && before(conductor, 'findUnresolvedTokens(useTc)', '__emitDataRowStart();')
  && before(conductor, 'if (!row) {', '__emitDataRowStart();')
  && before(conductor, '__emitDataRowStart();', 'caseResult = await runOneCase({'));
ok('the contract block precedes the per-row session reset + runOneCase (strict, both present)',
  before(conductor, "dataRowContractDefect(row, {", 'PER-CASE SESSION RESET'));
ok('per-row browser relaunch is gated by matrixMayEstablishAuthenticatedSession, not just login/password steps',
  conductor.includes('matrixMayEstablishAuthenticatedSession')
  && conductor.includes('dataRows.some((candidateRow)')
  && conductor.includes('&& !dryRun && matrixMayEstablishAuthenticatedSession'));
ok('dirty non-pass row emits a recovery event before continuing later rows',
  conductor.includes("recoveryReason: 'dirty_row_state'")
  && conductor.includes("recoveryStrategy: 'fresh_session_before_next_data_row'")
  && conductor.includes('attempting fresh-session recovery before row'));
ok('live stream preserves deterministic-kernel metadata for report/trail rendering',
  runStream.includes('deterministicKernel: msg.deterministicKernel === true')
  && runStream.includes('kernelRecovery: msg.kernelRecovery || null'));
ok('Theater counts deterministic DOM actions as real browser execution, not internal chatter',
  theater.includes("a.tool === 'deterministic_dom_fill'")
  && theater.includes("a.tool === 'deterministic_dom_click'")
  && theater.includes("a.tool === 'deterministic_dom_fill_recovery'")
  && theater.includes("a.tool === 'deterministic_dom_click_recovery'"));
ok('Theater labels deterministic executor actions explicitly',
  theater.includes('action.deterministicKernel')
  && theater.includes('Engine'));
ok('Reports humanizes deterministic engine trace lines instead of showing raw backend text',
  reports.includes('^ENGINE:')
  && reports.includes('humanizeEngineTool')
  && reports.includes('Engine action:'));
ok('Reports does not auto-mark engine trace lines green without an explicit pass marker',
  reports.includes("kind: 'engine'")
  && reports.includes('verdict: verdict || null'));
ok('Reports humanizes terminal stop trace lines for dirty-row/no-run exits',
  reports.includes('^STOP:')
  && reports.includes('Stopped:')
  && reports.includes("kind: 'stop'"));

console.log('\n— C. internal/narration is separated from real browser actions —');
ok('assistant narration tagged agentNarration (not a real browser action)',
  conductor.includes("tool: 'agent_narration', agentNarration: true"));
ok('multi-step PLAN text collapsed to one commentary line (no fake N-action burst)',
  conductor.includes('isMultiStepPlan') && /Considered a \$\{planLines\.length\}-step plan/.test(conductor));
ok('runStream stores agentNarration + excludes it from the browser-action count',
  runStream.includes('agentNarration: msg.agentNarration === true') && runStream.includes("msg.tool === 'agent_narration'"));
ok('runStream handles data.row.start as a first-class entry', runStream.includes("case 'data.row.start'") && runStream.includes('dataRowStart: true'));

console.log('\n— D. Theater renders rows grouped + narration muted + final_verdict demoted —');
ok('Theater renders a rich data-row boundary header', theater.includes("action.tool === 'data_row_start'") && /Data row \{rowNo\}/.test(theater));
ok('Theater renders agent narration as muted commentary (not an action row)', theater.includes("action.tool === 'agent_narration'"));
ok('Theater demotes final_verdict to a human "checking assertions" line', /action\.tool === 'final_verdict'[\s\S]*?checking the required assertions/.test(theater));
ok('counter excludes data_row_start + agentNarration from browser actions',
  theater.includes("'data_row_start'") && /a\.dataRowStart \|\| a\.agentNarration/.test(theater));

console.log('\n— E. row-aware op-check dedup + pre-run block identity (post-validation fixes) —');
ok('sameOperationCheck requires the SAME dataRowIndex (row N\'s check can\'t replace row M\'s)',
  /\(row\.dataRowIndex != null \|\| msg\.dataRowIndex != null\) && row\.dataRowIndex !== msg\.dataRowIndex\) return false;/.test(runStream));
ok('step.operationCheck reducer entry stores dataRowIndex/Label/Set',
  /tool: 'operation_check'[\s\S]*?dataRowIndex: msg\.dataRowIndex/.test(runStream));
ok('unresolved-token pre-run block preserves row identity',
  /data_token_unresolved'[\s\S]*?\.\.\.__rowMeta/.test(conductor) && conductor.includes('const __rowMeta = row ? { dataRowIndex: row.index'));

console.log('\n— F. negative-row + KNOWN-VALID credentials → test_data_invalid (not product bug) —');
{
  const known = [{ username: 'Admin', password: 'admin123' }];
  ok('negative row using the VALID creds → defect (reviewer\'s "Invalid password — correct username" / Admin·admin123)',
    !!dataRowContractDefect({ rowClass: 'invalidPassword', label: 'Invalid password — correct username rejected', inputs: { username: 'Admin', password: 'admin123' } }, { knownValidCreds: known }));
  ok('negative row using a WRONG password → no defect (genuine negative test)',
    !dataRowContractDefect({ rowClass: 'invalidPassword', inputs: { username: 'Admin', password: 'WrongPass@1' } }, { knownValidCreds: known }));
  ok('POSITIVE (valid-login) row using the valid creds → no defect',
    !dataRowContractDefect({ rowClass: 'validLogin', label: 'successful login', inputs: { username: 'Admin', password: 'admin123' } }, { knownValidCreds: known }));
  ok('negative row but NO known-valid set supplied → no defect (can\'t assert validity)',
    !dataRowContractDefect({ rowClass: 'invalidPassword', inputs: { username: 'Admin', password: 'admin123' } }, {}));
  ok('conductor threads runCredProfile.users into the pre-run check',
    conductor.includes('knownValidCreds: (runCredProfile && Array.isArray(runCredProfile.users)) ? runCredProfile.users : []'));

  // COMPACT row classes (camelCase / underscore) with NO label text — the reviewer's
  // exact misses. Each, with the known-valid creds, must now block.
  const compactNegativeClasses = ['invalidPassword', 'wrongPassword', 'invalid_password', 'wrong_password', 'nonexistentUser', 'nonexistent_user', 'badCreds', 'incorrectPassword', 'unauthorizedUser', 'rejectedLogin'];
  for (const cls of compactNegativeClasses) {
    ok(`compact "${cls}" + known-valid creds (no label) → BLOCKS as test_data_invalid`,
      !!dataRowContractDefect({ rowClass: cls, inputs: { username: 'Admin', password: 'admin123' } }, { knownValidCreds: known }));
  }
  // Positive compact class with valid creds must still NOT block.
  ok('compact "validLogin" + valid creds → no defect', !dataRowContractDefect({ rowClass: 'validLogin', inputs: { username: 'Admin', password: 'admin123' } }, { knownValidCreds: known }));
  ok('compact "successfulLogin" + valid creds → no defect', !dataRowContractDefect({ rowClass: 'successfulLogin', inputs: { username: 'Admin', password: 'admin123' } }, { knownValidCreds: known }));
  // Compact negative class but WRONG password → genuine negative test, no defect.
  ok('compact "invalidPassword" + WRONG password → no defect (genuine negative test)',
    !dataRowContractDefect({ rowClass: 'invalidPassword', inputs: { username: 'Admin', password: 'NotTheRealOne!' } }, { knownValidCreds: known }));
}

console.log('\n— G. per-row LLM context isolation, SPLIT from navigation (audit #2 + post-review) —');
ok('runOneCase accepts forceFreshConversation', conductor.includes('forceFreshConversation = false,'));
ok('isFirstInScenario is GENUINE again (not overloaded by forceFreshConversation)',
  conductor.includes('const isFirstInScenario = !scenarioContext || scenarioContext.casesCompleted === 0;')
  && !/isFirstInScenario = forceFreshConversation/.test(conductor));
ok('freshConversationMessage = isFirstInScenario || forceFreshConversation (LLM framing)',
  conductor.includes('const freshConversationMessage = isFirstInScenario || forceFreshConversation === true;'));
ok('shouldPreNavigate is SEPARATE: genuine-first OR forced-fresh + session-establishing only',
  conductor.includes('const shouldPreNavigate = isFirstInScenario || (forceFreshConversation === true && __caseEstablishesSession);'));
ok('pre-navigation is gated by shouldPreNavigate (NOT the fresh-message flag) — authenticated rows keep their session',
  conductor.includes('if (shouldPreNavigate) {'));
ok('the per-case USER MESSAGE branch is gated by freshConversationMessage',
  conductor.includes('if (freshConversationMessage) {'));
ok('fresh-message branch IS the full first-start prompt (current snapshot), else IS the continuation framing',
  before(conductor, 'if (freshConversationMessage) {', '## Initial page snapshot')
  && before(conductor, '## Initial page snapshot', 'Continuation: we'));
ok('rows 2..N of a data-driven case force a fresh conversation', conductor.includes('forceFreshConversation: !!(__forceFreshCaseConversation || (row && ei > 0))'));
ok('completed data rows close out deterministically without another model turn',
  conductor.includes('Data-row planned steps are complete; closing out via deterministic row evidence without another model turn.')
  && conductor.includes('dataRow')
  && conductor.includes('currentStepIndex >= totalSteps')
  && before(conductor, 'currentStepIndex >= totalSteps', 'let resp;'));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — data-driven runs: row-grouped + per-row identity on every event (op-check dedup is row-aware), per-row fresh LLM framing (rows 2..N independent), narration/plan/final_verdict separated from real actions, contradictory rows (structural + valid-creds-in-negative) blocked before the browser.');
