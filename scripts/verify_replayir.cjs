'use strict';
/**
 * Deterministic guard for Enterprise Mode P6 (mechanical ReplayIR emission). No LLM,
 * no DB, no browser. Emits from a representative recorded trail and runs it through
 * the REAL frozen contract (validateReplayIR) + the REAL Playwright reference adapter
 * (compileReplayIR) — proving acceptance steps 3-6 (validate / compile / verdict parity
 * / no-secret-leak) on emitted IR. The live-run/real-trace smoke is separate.
 *   node scripts/verify_replayir.cjs
 */
const emitter = require('../server/services/codegen/replayEmitter');
const contract = require('../server/services/codegen/adapters/frameworkAdapter');
const registry = require('../server/services/codegen/adapters');
const mcp = require('../server/services/mcp');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

// A representative login flow as MCP RECORDED it (toolResults shape). The password
// literal "admin123" + the masked row literal "secret123" must NEVER reach the IR.
const trail = [
  { tool: 'browser_navigate', args: { url: 'https://app.test/login' }, ok: true },
  { tool: 'browser_type', args: { element: 'Username textbox', text: 'Admin' }, ok: true },
  { tool: 'browser_type', args: { element: 'Password textbox', text: 'admin123' }, ok: true },
  { tool: 'browser_press_key', args: { key: 'Enter' }, ok: true },
  { tool: 'browser_click', args: { element: 'Login button' }, ok: true },
  { tool: 'assertion_check', args: {}, ok: true }, // non-scriptable → ignored
];
const baseInput = {
  caseId: 'TC-LOGIN',
  authProfile: { id: 'demo', strategy: 'bypass_fixture', storageStateRef: 'auth/demo.json' },
  trail,
  declaredAssertions: [{ id: 'ASSERT-DASH', type: 'TEXT', payload: { expectedText: 'Dashboard' }, checkAt: 'end' }],
  assertionOutcomes: [{ assertionId: 'ASSERT-DASH', outcome: 'matched', evidence: 'header shows Dashboard' }],
  verdictStatus: 'pass',
  knownPopups: [{ role: 'button', name: 'Accept' }],
  humanInputs: [{ field: 'approvalCode', disposition: 'test_hook', valueRef: 'env:QAAI_APPROVAL' }],
  dataRows: [
    { index: 0, label: 'Row 1 - mixed', fields: { searchTerm: 'Admin', password: 'secret123', email: 'admin@example.test' }, sensitivity: { searchTerm: 'synthetic', password: 'masked', email: 'restricted' } },
    { index: 1, label: 'Row 2 - legacy scalar', fields: { password: 'secret123' }, sensitivity: 'masked' },
  ],
  kbByElement: new Map([['Login button', { role: 'button', accessibleName: 'Login', selector: 'button[type=submit]' }]]),
};

console.log('\n[1] emit → validateReplayIR (round-trip the frozen contract)');
const { ir, findings } = emitter.buildReplayIR(baseInput);
const v = contract.validateReplayIR(ir);
assert(v.valid && v.findings.every((f) => f.severity !== 'error'), 'emitted IR passes validateReplayIR with zero errors');
const ops = new Set(ir.steps.map((s) => s.op));
assert(['handlePopup', 'resolve', 'act', 'assert', 'humanInput'].every((o) => ops.has(o)), 'IR contains resolve/act/assert/humanInput/handlePopup ops');

console.log('\n[2] resolved locator evidence + no inline values');
const resolves = ir.steps.filter((s) => s.op === 'resolve');
assert(resolves.length >= 1 && resolves.every((s) => Array.isArray(s.candidates) && s.candidates.length >= 1), 'every resolve step carries ≥1 locator candidate');
const acts = ir.steps.filter((s) => s.op === 'act');
assert(acts.every((s) => !('value' in s)), 'NO act step carries an inline value (valueRef only)');
assert(acts.filter((s) => s.action === 'fill').every((s) => /^(env|vault|fixture|masked):/i.test(s.valueRef || '')), 'fill act steps use a safe valueRef scheme');
assert(ir.steps.some((s) => s.op === 'resolve' && s.candidates.some((c) => c.strategy === 'css' && c.selector === 'button[type=submit]')), 'KB-resolved selector used as a candidate (real resolved evidence)');

console.log('\n[3] press preserved with focused-element fallback, assertion→contract mapping');
assert(acts.some((s) => s.action === 'press' && s.rawValue === 'Enter') && resolves.some((s) => s.candidates.some((c) => c.strategy === 'css' && c.selector === ':focus')) && findings.some((f) => f.code === 'qaai_guessed_locator'), 'standalone press_key is preserved with a warned focused-element locator');
const assertStep = ir.steps.find((s) => s.op === 'assert');
assert(assertStep && assertStep.contractRef === 'ASSERT-DASH' && assertStep.channel === 'UI_TEXT', 'declared assertion → assert step (contractRef=id, channel=UI_TEXT)');
assert(ir.verdict.perAssertionOutcomes.some((p) => p.contractRef === 'ASSERT-DASH' && p.status === 'pass'), 'verdict.perAssertionOutcomes maps the recorded matched outcome → pass');

console.log('\n[4] role-keyed dataRows + masked value becomes a ref (no test-data leak)');
assert(ir.dataRows[0].fields.searchTerm === 'Admin', 'synthetic row keeps its literal (role-keyed: searchTerm)');
assert(ir.dataRows[0].sensitivity.password === 'masked' && ir.dataRows[0].sensitivity.email === 'restricted', 'row sensitivity is role-keyed (password masked, email restricted)');
assert(/^env:/i.test(ir.dataRows[0].fields.password), 'masked role VALUE is an env ref, not the literal "secret123"');
assert(/^vault:/i.test(ir.dataRows[0].fields.email), 'restricted role VALUE is a vault ref, not the literal email');
assert(/^(env|vault):/i.test(ir.dataRows[1].fields.password), 'legacy scalar masked row still projects to a ref');
assert(!JSON.stringify(ir).includes('secret123') && !JSON.stringify(ir).includes('admin123'), 'no recorded secret literal anywhere in the IR');
{
  const badRow = JSON.parse(JSON.stringify(ir));
  badRow.dataRows[0].fields.password = 'secret123';
  const rowCheck = contract.validateReplayIR(badRow);
  assert(!rowCheck.valid && rowCheck.findings.some((f) => f.rule === 'replayir_data_row_sensitive_literal'), 'validator rejects masked/restricted data-row literals');
}

console.log('\n[5] verdict PRESERVED (a failed/blocked run cannot export green)');
assert(emitter.buildReplayIR({ ...baseInput, verdictStatus: 'fail' }).ir.verdict.status === 'fail', 'verdictStatus fail → ir.verdict.status fail');
assert(emitter.buildReplayIR({ ...baseInput, verdictStatus: 'blocked' }).ir.verdict.status === 'blocked', 'verdictStatus blocked → ir.verdict.status blocked');

console.log('\n[6] compile through the REAL Playwright reference adapter');
const adapter = registry.getAdapter('playwright-reference');
assert(!!adapter && registry.listAdapters().includes('playwright-reference'), 'playwright-reference adapter registered');
let compiled = null;
try { compiled = contract.compileReplayIR(adapter, ir); } catch (e) { bad('compileReplayIR threw: ' + e.message); }
if (compiled) {
  const content = compiled.files[compiled.layout.testFile || compiled.layout.primaryFile] || '';
  assert(content.length > 0, 'adapter produced a non-empty spec file');
  assert(!content.includes('admin123') && !content.includes('secret123'), 'compiled spec contains NO secret/test-data literal');
}

console.log('\n[7] diagnostic retention — malformed authored values remain visible without suppressing export');
const diagnosticIr = JSON.parse(JSON.stringify(ir));
const diagnosticFill = diagnosticIr.steps.find((s) => s.op === 'act' && s.action === 'fill');
delete diagnosticFill.valueRef; diagnosticFill.value = 'inline-authored-value';
const diagnosticValidation = contract.validateReplayIR(diagnosticIr);
assert(
  diagnosticValidation.valid
    && diagnosticValidation.findings.some((f) => f.rule === 'replayir_inline_value_forbidden' && f.severity === 'warn'),
  'untyped inline value → non-blocking ReplayIR diagnostic while authored operation remains exportable'
);
let diagnosticCompiled = null;
try { diagnosticCompiled = contract.compileReplayIR(adapter, diagnosticIr); } catch (e) { bad('compileReplayIR threw instead of retaining diagnostic output: ' + e.message); }
const diagnosticContent = diagnosticCompiled
  ? (diagnosticCompiled.files[diagnosticCompiled.layout.testFile || diagnosticCompiled.layout.primaryFile] || '')
  : '';
assert(
  diagnosticCompiled
    && diagnosticCompiled.authoredStepCount === diagnosticIr.steps.length
    && diagnosticCompiled.findings.some((f) => f.rule === 'replayir_inline_value_forbidden'),
  'compileReplayIR preserves every authored step and carries the validation diagnostic'
);
assert(diagnosticContent.length > 0, 'diagnostic ReplayIR still produces an explicit output file');

console.log('\n[8] completeness honesty — locator gaps are warned guesses; non-locator contract gaps stay explicit');
const fullEmit = emitter.buildReplayIR(baseInput);
assert(fullEmit.complete === true && fullEmit.gaps.length === 0, 'a fully-evidenced trace → complete:true, zero gaps');
const noLoc = emitter.buildReplayIR({ ...baseInput, trail: [{ tool: 'browser_click', args: {}, ok: true }], kbByElement: null, declaredAssertions: [], assertionOutcomes: [] });
assert(noLoc.complete === true && noLoc.gaps.length === 0 && noLoc.findings.some((f) => f.code === 'qaai_guessed_locator'), 'label-less action stays complete with an explicit guessed-locator warning');
assert(noLoc.ir.steps.some((s) => s.op === 'resolve' && s.guessedLocator === true && s.locatorProvenance?.kind === 'qaai_guessed_locator'), 'evidence-less action receives one editable guessed resolve instead of being dropped');
const noOutcome = emitter.buildReplayIR({ ...baseInput, assertionOutcomes: [] });
assert(noOutcome.complete === true && noOutcome.findings.some((f) => f.code === 'assertion_outcome_missing_but_preserved') && noOutcome.ir.steps.some((s) => s.op === 'assert' && s.contractRef === 'ASSERT-DASH'), 'declared assertion without a live outcome remains a hard authored assertion with a truth warning');
assert(noOutcome.ir.verdict.perAssertionOutcomes.every((p) => p.status === 'needs_human'), 'missing outcome → perAssertion status needs_human (never a fabricated pass)');

const noExpected = emitter.buildReplayIR({
  ...baseInput,
  declaredAssertions: [{ id: 'ASSERT-PAGE', type: 'PAGE', payload: {} }],
  assertionOutcomes: [{ assertionId: 'ASSERT-PAGE', outcome: 'matched' }],
});
const noExpectedCheck = contract.validateReplayIR(noExpected.ir);
assert(noExpected.complete === false && noExpected.gaps.some((g) => g.code === 'missing_assertion_expected'), 'PAGE assertion without expected value -> complete:false + missing_assertion_expected gap');
assert(noExpectedCheck.valid && !noExpected.ir.steps.some((s) => s.op === 'assert' && s.contractRef === 'ASSERT-PAGE'), 'expected-less PAGE oracle is not emitted; remaining executable steps stay structurally valid');

const pageSignals = emitter.buildReplayIR({
  ...baseInput,
  declaredAssertions: [{ id: 'ASSERT-PAGE-SIGNALS', type: 'PAGE', payload: { pageName: 'login_page', expectedSignals: { text: ['Username', 'Password'], role: [{ role: 'button', name: 'Login' }] } } }],
  assertionOutcomes: [{ assertionId: 'ASSERT-PAGE-SIGNALS', outcome: 'matched' }],
});
const pageSignalAssert = pageSignals.ir.steps.find((s) => s.contractRef === 'ASSERT-PAGE-SIGNALS');
assert(pageSignals.complete === true && pageSignalAssert && pageSignalAssert.expected === 'login_page' && pageSignalAssert.expectedSignals?.text?.includes('Username'), 'PAGE assertion preserves pageName as expected and retains structured expectedSignals');

console.log('\n[9] conductor persistence wiring (additive, pinned to RunResult, never breaks the run)');
{
  const fs = require('fs'); const path = require('path');
  const read = (...p) => { try { return fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8'); } catch (_) { return ''; } };
  const c = read('server', 'services', 'agents', 'conductor.js');
  assert(/require\(['"]\.\.\/codegen\/replayEmitter['"]\)/.test(c), 'conductor imports replayEmitter');
  assert(/require\(['"]\.\.\/codegen\/_replayContract['"]\)/.test(c), 'conductor imports replay contract metadata helper');
  assert(/buildEvidenceBuiltReplayIR\(/.test(c) && /replayInput:/.test(c), 'conductor builds evidence-backed ReplayIR per result');
  assert(c.includes('if (envelope.complete === false)'), 'conductor records incomplete ReplayIR evidence without deleting the envelope');
  assert(c.includes('replayIrJson: encodeJson(envelope)') && c.includes('STATE.INCOMPLETE_EVIDENCE') && !c.includes('replayIrJson: null'), 'incomplete ReplayIR is persisted with explicit evidence state instead of being cleared');
  assert(/replayIrJson:\s*encodeJson\(envelope\)/.test(c), 'complete ReplayIR persists the envelope to RunResult.replayIrJson');
  assert(c.includes('emittedAt: new Date().toISOString()') && c.includes('emitterVersion: replayEmitter.EMITTER_VERSION'), 'envelope carries emittedAt + emitterVersion');
  assert(/ReplayIR emission failed/.test(c), 'emission wrapped → never breaks the run (null + log on failure)');
  const schema = read('prisma', 'schema.prisma');
  assert(/replayIrJson\s+String\?/.test(schema), 'RunResult.replayIrJson String? (additive nullable)');
  const migDir = path.join(__dirname, '..', 'prisma', 'migrations');
  let mig = ''; try { for (const d of fs.readdirSync(migDir)) if (/replay_ir/i.test(d)) mig = fs.readFileSync(path.join(migDir, d, 'migration.sql'), 'utf8'); } catch (_) {}
  assert(/ADD COLUMN "replayIrJson"/.test(mig), 'migration adds replayIrJson (additive ALTER)');
}

console.log('\n[10] browser_fill_form — multi-field fill expanded faithfully (the live-activation fidelity fix)');
{
  // browser_fill_form fills many fields in ONE call (args.fields[]={name,type,target,value}).
  // The recorded password literal "admin123" must NEVER reach the IR; every field becomes its
  // own resolve+fill with a valueRef. (Before the fix the whole fill was dropped → complete:false.)
  const ffTrail = [
    { tool: 'browser_navigate', args: { url: 'https://app.test/login' }, ok: true },
    { tool: 'browser_fill_form', args: { fields: [
      { name: 'Username', type: 'textbox', target: 'e23', value: 'Admin' },
      { name: 'Password', type: 'textbox', target: 'e30', value: 'admin123' },
    ] }, ok: true },
    { tool: 'browser_click', args: { element: 'Login button' }, ok: true },
  ];
  const r = emitter.buildReplayIR({
    caseId: 'TC-FF', trail: ffTrail,
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Dashboard' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const ffFills = r.ir.steps.filter((s) => s.op === 'act' && s.action === 'fill');
  assert(ffFills.length === 2, 'fill_form expands to one fill act PER field (2)');
  assert(r.ir.steps.filter((s) => s.op === 'resolve').length >= 2, 'each filled field gets its own resolve step');
  assert(ffFills.every((s) => !('value' in s) && /^env:QAAI_/.test(s.valueRef || '')), 'each fill carries a valueRef, never the recorded literal');
  assert(ffFills.some((s) => s.valueRef === 'env:QAAI_USERNAME') && ffFills.some((s) => s.valueRef === 'env:QAAI_PASSWORD'), 'Username/Password fields map to the conventional credential refs');
  assert(r.ir.steps.some((s) => s.op === 'resolve' && s.candidates.some((c) => c.strategy === 'role' && c.role === 'textbox' && c.name === 'Username')), 'field.type drives a role candidate (role=textbox name=Username)');
  assert(r.ir.steps.some((s) => s.op === 'resolve' && s.candidates.some((c) => c.strategy === 'placeholder' && c.text === 'Username')), 'textbox field name also emits a placeholder fallback (OrangeHRM-style fields)');
  assert(r.ir.steps.some((s) => s.op === 'resolve' && s.candidates.some((c) => c.strategy === 'role' && c.role === 'button' && c.name === 'Login')), 'role-suffixed element label emits the semantic button name (Login button -> Login)');
  assert(r.ir.steps.some((s) => s.op === 'resolve' && s.candidates.some((c) => c.strategy === 'text' && c.text === 'Login')), 'role-suffixed element label also emits the semantic text fallback (Login)');
  assert(!JSON.stringify(r.ir).includes('admin123'), 'recorded password literal "admin123" is ABSENT from the IR');
  assert(r.complete === true && r.gaps.length === 0, 'a fully-named fill_form → complete:true (no missing_locator_evidence)');
  let ffCompiled = true; try { contract.compileReplayIR(registry.getAdapter('playwright-reference'), r.ir); } catch (e) { ffCompiled = false; bad('fill_form IR failed to compile: ' + e.message); }
  if (ffCompiled) ok('fill_form IR compiles through the reference adapter');
}

console.log(`\n${failures === 0 ? 'PASS — P6 mechanical ReplayIR emission (evidence-first, verdict-preserving, leak-free, validator-owned, gap-honest, fill_form-faithful, pinned-persistence)' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
console.log('\n[11] locator-faithfulness - weak KB selectors do not suppress replayable fallbacks');
{
  const weakKb = emitter.buildReplayIR({
    caseId: 'TC-WEAK-KB',
    trail: [{ tool: 'browser_click', args: { element: 'Login button' }, ok: true }],
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Dashboard' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
    kbByElement: new Map([['Login button', { selector: 'getByText("Login button")', role: null, accessibleName: null }]]),
  });
  const loginResolve = weakKb.ir.steps.find((s) => s.op === 'resolve');
  assert(loginResolve.candidates.some((c) => c.strategy === 'text' && c.text === 'Login button'), 'keeps the recorded weak KB candidate as evidence');
  assert(loginResolve.candidates.some((c) => c.strategy === 'role' && c.role === 'button' && c.name === 'Login'), 'adds replayable role fallback from the recorded label');
  assert(loginResolve.candidates.some((c) => c.strategy === 'text' && c.text === 'Login'), 'adds replayable text fallback from the recorded label');
  assert(weakKb.complete === true && weakKb.gaps.length === 0, 'weak KB plus recorded label remains complete without fabricating');
}

console.log('\n[12] initial-page evidence - observed first URL stays non-authored');
{
  const fromPageState = emitter.buildReplayIR({
    caseId: 'TC-START-PAGE',
    trail: [{ tool: 'browser_fill_form', pageUrl: 'https://app.test/login', args: { fields: [
      { name: 'Username', type: 'textbox', value: 'Admin' },
    ] }, ok: true }],
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Dashboard' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const observedStart = (fromPageState.ir.contextTransitions || []).find((transition) => transition.kind === 'observed_start_state');
  assert(!fromPageState.ir.steps.some((s) => s.op === 'act' && s.action === 'navigate'), 'observed first pageUrl does not invent an authored navigate operation');
  assert(observedStart && observedStart.observedUrl === 'https://app.test/login' && observedStart.authored === false, 'first recorded pageUrl is retained as non-authored context evidence');
  assert(fromPageState.ir.steps.some((s) => s.op === 'act' && s.action === 'fill'), 'the original fill remains executable');
  assert(fromPageState.complete === true && fromPageState.gaps.length === 0, 'initial-page evidence remains complete');
}

console.log('\n[13] locator precision - direct evidence and semantic KB lookup');
{
  const precise = emitter.buildReplayIR({
    caseId: 'TC-PRECISE-LOCATORS',
    trail: [
      { tool: 'browser_fill_form', args: { fields: [
        { name: 'Username', type: 'textbox', placeholder: 'Username', value: 'Admin' },
      ] }, ok: true },
      { tool: 'browser_click', args: { element: 'Login button' }, ok: true },
    ],
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Dashboard' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
    kbByElement: new Map([['Login', { role: 'button', accessibleName: 'Login', selector: 'button[type="submit"]' }]]),
  });
  const resolves = precise.ir.steps.filter((s) => s.op === 'resolve');
  const username = resolves.find((s) => s.candidates.some((c) => c.text === 'Username'));
  const login = resolves.find((s) => s.candidates.some((c) => c.role === 'button' || c.selector === 'button[type="submit"]'));
  assert(username && username.candidates[0].strategy === 'placeholder' && username.candidates[0].text === 'Username', 'field placeholder evidence is ranked first for textbox replay');
  assert(login && login.candidates.some((c) => c.strategy === 'css' && c.selector === 'button[type="submit"]'), 'semantic KB lookup resolves Login button -> Login selector evidence');
  assert(login && login.candidates.some((c) => c.strategy === 'role' && c.role === 'button' && c.name === 'Login'), 'button uses actual accessible name Login, not only the description Login button');
  assert(login && login.candidates.some((c) => c.strategy === 'text' && c.text === 'Login'), 'button keeps semantic text fallback Login');
  assert(precise.complete === true && precise.gaps.length === 0, 'direct evidence + semantic KB remains complete');
}

console.log('\n[14] action-time DOM facts become ReplayIR locator evidence');
{
  const snap = [
    '- heading "Login"',
    '- textbox "Username" [ref=e23] [placeholder="Username"] [testid="username-input"]',
    '- textbox "Password" [ref=e24] [placeholder="Password"]',
    '- button "Login" [ref=e25] [id="loginBtn"]',
  ].join('\n');
  const fillFacts = mcp.extractDomFactsForTool('browser_fill_form', {
    fields: [
      { name: 'Username', type: 'textbox', ref: 'e23', value: 'Admin' },
      { name: 'Password', type: 'textbox', ref: 'e24', value: 'admin123' },
    ],
  }, snap);
  const clickFacts = mcp.extractDomFactsForTool('browser_click', { element: 'Login button', ref: 'e25' }, snap);
  assert(fillFacts && fillFacts.fields.length === 2, 'MCP snapshot parser extracts per-field DOM facts for fill_form');
  assert(fillFacts.fields[0].facts.placeholder === 'Username' && fillFacts.fields[0].facts.testId === 'username-input', 'field DOM facts include placeholder + test id');
  assert(clickFacts && clickFacts.target.role === 'button' && clickFacts.target.accessibleName === 'Login' && clickFacts.target.selector === '#loginBtn', 'click DOM facts include role/name/id selector');

  const replay = emitter.buildReplayIR({
    caseId: 'TC-DOMFACTS',
    trail: [
      { tool: 'browser_fill_form', args: { fields: [
        { name: 'Username', type: 'textbox', ref: 'e23', value: 'Admin' },
      ] }, domFacts: fillFacts, ok: true },
      { tool: 'browser_click', args: { element: 'Login button', ref: 'e25' }, domFacts: clickFacts, ok: true },
    ],
    declaredAssertions: [{ id: 'A1', type: 'TEXT', payload: { expectedText: 'Dashboard' } }],
    assertionOutcomes: [{ assertionId: 'A1', outcome: 'matched' }],
    verdictStatus: 'pass',
  });
  const resolves = replay.ir.steps.filter((s) => s.op === 'resolve');
  assert(resolves.some((s) => s.candidates[0] && s.candidates[0].strategy === 'testId' && s.candidates[0].testId === 'username-input'), 'ReplayIR ranks recorded field testId before inferred candidates');
  assert(resolves.some((s) => s.candidates.some((c) => Array.isArray(c.contextText) && c.contextText.includes('Login'))), 'ReplayIR carries recorded nearbyText as candidate contextText for duplicate disambiguation');
  assert(resolves.some((s) => s.candidates.some((c) => c.strategy === 'css' && c.selector === '#loginBtn')), 'ReplayIR includes recorded click id selector');
  assert(resolves.some((s) => s.candidates.some((c) => c.strategy === 'role' && c.role === 'button' && c.name === 'Login')), 'ReplayIR includes recorded click role + accessible name');
  const compiled = contract.compileReplayIR(registry.getAdapter('playwright-reference'), replay.ir);
  const compiledText = Object.values(compiled.files)[0] || '';
  assert(/context narrowed to/.test(compiledText), 'compiled Playwright resolver uses contextText to narrow duplicate locator matches before blocking');
  assert(replay.complete === true && replay.gaps.length === 0, 'DOM-fact-backed replay is complete');
}

console.log('\n[15] wrong-credential detection — negative-path value inlined; real credential masked');
{
  // Wrong credential: value NOT in credentialValues → rawValue must be set so the exported
  // spec submits the actual wrong value instead of readEnv('QAAI_PASSWORD').
  const wrongCredTrail = [
    { tool: 'browser_navigate', args: { url: 'https://app.test/login' }, ok: true },
    { tool: 'browser_type', args: { element: 'Password textbox', text: 'WrongPass123' }, ok: true },
  ];
  const wrongResult = emitter.buildReplayIR({
    caseId: 'TC-WRONG-CRED',
    trail: wrongCredTrail,
    declaredAssertions: [],
    assertionOutcomes: [],
    verdictStatus: 'fail',
    credentialValues: new Set(['Admin', 'RealPass456']),
  });
  const wrongFill = wrongResult.ir.steps.find((s) => s.op === 'act' && s.action === 'fill');
  assert(wrongFill && wrongFill.rawValue === 'WrongPass123', 'wrong credential: rawValue is inlined with the actual wrong value');
  assert(wrongFill && wrongFill.valueRef === 'env:QAAI_PASSWORD', 'wrong credential: valueRef still present (schema compliance)');

  // Real credential: value IS in credentialValues → rawValue must NOT be set
  const realCredTrail = [
    { tool: 'browser_navigate', args: { url: 'https://app.test/login' }, ok: true },
    { tool: 'browser_type', args: { element: 'Password textbox', text: 'RealPass456' }, ok: true },
  ];
  const realResult = emitter.buildReplayIR({
    caseId: 'TC-REAL-CRED',
    trail: realCredTrail,
    declaredAssertions: [],
    assertionOutcomes: [],
    verdictStatus: 'pass',
    credentialValues: new Set(['Admin', 'RealPass456']),
  });
  const realFill = realResult.ir.steps.find((s) => s.op === 'act' && s.action === 'fill');
  assert(realFill && realFill.rawValue == null, 'real credential: rawValue absent (exported spec uses readEnv, not the literal)');
  assert(!JSON.stringify(realResult.ir).includes('RealPass456'), 'real credential literal absent from IR (no secret leak)');

  // Conductor wiring: env-var anchors are present in conductor source
  {
    const fs = require('fs'); const path = require('path');
    const c = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agents', 'conductor.js'), 'utf8');
    assert(/process\.env\.QAAI_USERNAME/.test(c) && /process\.env\.QAAI_PASSWORD/.test(c), 'conductor anchors credentialValues with env var fallback (wrong-cred detection when credProfile is empty)');
  }
}

console.log(`\nFINAL ${failures === 0 ? 'PASS' : 'FAIL - ' + failures + ' check(s) failed'} - P6 locator-faithful ReplayIR emission guard\n`);
process.exit(failures === 0 ? 0 : 1);
