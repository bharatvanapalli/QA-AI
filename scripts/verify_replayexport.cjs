'use strict';
/**
 * Deterministic guard for Enterprise Mode P7 (IR-sourced export). No DB, no browser,
 * no live run. Exercises replayExport's PURE core against emitter-built envelopes through
 * the REAL playwright-reference adapter, proving every P7 invariant:
 *   block missing/incomplete/invalid IR · pass compiles · fail keeps its HARD assertion
 *   (no test.fail) · blocked→describe.skip (no green) · no secret leak · data-row identity
 *   · stable manifest fields.   node scripts/verify_replayexport.cjs
 */
const emitter = require('../server/services/codegen/replayEmitter');
const resolver = require('../server/services/actionLocatorResolver');
const registry = require('../server/services/codegen/adapters');
const X = require('../server/services/codegen/replayExport');
const bdd = require('../server/services/codegen/adapters/replayIrBdd');
const sel = require('../server/services/codegen/adapters/seleniumReference');
const regressionCorpus = require('../server/services/codegen/adapters/regressionCorpus');
const contract = require('../server/services/codegen/adapters/frameworkAdapter');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

const adapter = registry.getAdapter('playwright-reference');

function verifiedLocator({ toolName, label, role, expression, selector, pageUrl = 'https://app.test/login' }) {
  const proof = { count: 1, sameElement: true, visible: true, enabled: true };
  return resolver.buildActionLocatorFromInspection({
    toolName,
    args: { element: label, role },
    inspection: {
      ok: true,
      facts: { tag: role === 'button' ? 'button' : 'input', role, accessibleName: label, visible: true, enabled: true },
      context: { nearbyText: [label] },
      domAtlas: {
        schemaVersion: 'qaai-dom-atlas-v1',
        url: pageUrl,
        routeKey: '/login',
        title: 'Login',
        counts: { elements: 3, controls: 3, forms: 1, tables: 0, dialogs: 0, frames: 0, shadowHosts: 0 },
        controls: [{ selector, tag: role === 'button' ? 'button' : 'input', role, name: label, visible: true, enabled: true }],
        forms: [{ selector: 'form', action: '/login', method: 'post', controls: [{ selector, role, name: label }] }],
        headings: ['Login'],
      },
      candidates: [{
        strategy: role === 'button' ? 'role' : 'label',
        ...(role === 'button' ? { name: label } : {}),
        expression,
        frameworkExpressions: { playwright: expression, selenium: `By.cssSelector("${selector}")` },
        candidate: { strategy: 'css', selector },
        proof,
        score: 900,
      }],
    },
    pageUrl,
    elementLabel: label,
  });
}

// A login flow as MCP recorded it (browser_fill_form multi-field; password literal must
// never reach the IR or the compiled spec).
const usernameLocator = verifiedLocator({ toolName: 'browser_fill', label: 'Username', role: 'textbox', expression: 'getByRole("textbox", { name: /username/i })', selector: 'input[name="username"]' });
const passwordLocator = verifiedLocator({ toolName: 'browser_fill', label: 'Password', role: 'textbox', expression: 'getByRole("textbox", { name: /password/i })', selector: 'input[name="password"]' });
const loginLocator = verifiedLocator({ toolName: 'browser_click', label: 'Login button', role: 'button', expression: 'getByRole("button", { name: /login/i })', selector: 'button[type="submit"]' });
const trail = [
  { tool: 'browser_navigate', args: { url: 'https://app.test/login' }, ok: true },
  { tool: 'browser_fill', args: { element: 'Username', role: 'textbox', text: 'Admin' }, ok: true, pageUrl: 'https://app.test/login', actionLocator: usernameLocator },
  { tool: 'browser_fill', args: { element: 'Password', role: 'textbox', text: 'admin123' }, ok: true, pageUrl: 'https://app.test/login', actionLocator: passwordLocator },
  { tool: 'browser_click', args: { element: 'Login button' }, ok: true, pageUrl: 'https://app.test/login', actionLocator: loginLocator },
];
function envelopeFor(verdictStatus, outcome = 'matched') {
  const e = emitter.buildReplayIR({
    caseId: 'TC-LOGIN', trail,
    declaredAssertions: [{ id: 'ASN-1', type: 'TEXT', payload: { expectedText: 'Dashboard' } }],
    assertionOutcomes: [{ assertionId: 'ASN-1', outcome }],
    verdictStatus,
  });
  return { ir: e.ir, complete: e.complete, gaps: e.gaps, emittedAt: new Date().toISOString(), emitterVersion: emitter.EMITTER_VERSION };
}
const mkResult = (over) => ({ runId: 'RUN-1', runResultId: 'RR-' + Math.random().toString(36).slice(2, 8), testCaseId: 'TC-LOGIN', status: 'pass', dataRowIndex: null, dataRowLabel: null, caseName: 'Valid Login', envelope: envelopeFor('pass'), ...over });

console.log('\n[1] PASS result → admitted, compiles, faithful (no skip/fail wrapper)');
{
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'pass' })] });
  assert(r.admitted.length === 1 && r.blocked.length === 0, 'pass result admitted, not blocked');
  const c = r.admitted[0].content;
  assert(/await\s+\w+\.fill\(/.test(c) && /assertTextPresent|toContainText|toBeVisible/.test(c), 'spec contains the fill + assertion');
  assert(!c.includes('test.describe.skip(') && !c.includes('test.fail('), 'pass spec is NOT skipped and uses no test.fail');
  assert(r.admitted[0].filePath.endsWith('.spec.ts'), 'admitted spec has a .spec.ts path');
}

console.log('\n[2] missing replayIrJson → BLOCKED (no fallback)');
{
  const r = X.compileResults({ adapter, results: [mkResult({ envelope: null })] });
  assert(r.admitted.length === 0 && r.blocked[0] && r.blocked[0].code === 'replayir_missing', 'null envelope → replayir_missing block');
}

console.log('\n[3] complete:false → BLOCKED with gaps surfaced');
{
  const env = envelopeFor('pass'); env.complete = false; env.gaps = [{ code: 'missing_locator_evidence', where: 'browser_click' }];
  const r = X.compileResults({ adapter, results: [mkResult({ envelope: env })] });
  assert(r.admitted.length === 0 && r.blocked[0].code === 'replayir_incomplete', 'incomplete IR → replayir_incomplete block');
  assert(Array.isArray(r.blocked[0].gaps) && r.blocked[0].gaps.length === 1, 'gaps are surfaced on the block');
}

console.log('\n[4] invalid IR (inline value) → compileReplayIR throws → BLOCKED replayir_invalid');
{
  const env = envelopeFor('pass');
  const fill = env.ir.steps.find((s) => s.op === 'act' && s.action === 'fill' && /password/i.test(String(s.valueRef || s.target || '')));
  delete fill.valueRef; fill.value = 'super-secret';
  const r = X.compileResults({ adapter, results: [mkResult({ envelope: env })] });
  assert(r.admitted.length === 0 && r.blocked[0].code === 'replayir_invalid', 'inline-value IR → replayir_invalid (export stops for that case)');
}

console.log('\n[5] FAIL result → admitted, keeps the HARD failing assertion, NO test.fail');
{
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'fail', envelope: envelopeFor('fail', 'not_matched') })] });
  assert(r.admitted.length === 1, 'fail result is admitted (faithful, not dropped)');
  const c = r.admitted[0].content;
  assert(/assertTextPresent|toContainText|toBeVisible|toHaveURL/.test(c), 'fail spec still CONTAINS the assertion that failed (contractRef present)');
  assert(!c.includes('test.fail(') && !c.includes('test.describe.skip('), 'fail spec uses NO test.fail / describe.skip — it must hard-fail on replay');
  assert(r.manifestEntries.find((m) => m.status === 'fail').expectedVerdict === 'fail', 'manifest expectedVerdict=fail');
}

console.log('\n[6] BLOCKED result → admitted but describe.skip (cannot report green) + manifest blocked');
{
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'blocked', envelope: envelopeFor('blocked') })] });
  assert(r.admitted.length === 1 && r.admitted[0].content.includes('test.describe.skip('), 'blocked spec is wrapped describe.skip (not a green pass)');
  assert(/verdict-preservation/.test(r.admitted[0].content), 'blocked spec carries the verdict-preservation note');
  assert(r.manifestEntries.find((m) => m.expectedVerdict === 'blocked'), 'manifest records expectedVerdict=blocked');
}

console.log('\n[7] secret scan — secret-keyed literal flagged; synthetic non-secret allowed');
{
  const leak = X.scanSecrets({ 'a.ts': 'const x = { password: "admin123" };' }, ['admin123']);
  assert(leak.some((f) => f.rule === 'secret_literal_in_output'), 'password literal → secret_literal_in_output');
  assert(leak.some((f) => f.rule === 'known_secret_literal'), 'denylist literal "admin123" → known_secret_literal');
  const clean = X.scanSecrets({ 'b.ts': 'const x = { searchTerm: "Admin", value: readEnv("QAAI_PASSWORD") };' }, ['admin123']);
  assert(clean.length === 0, 'synthetic non-secret literal + readEnv password → NO finding');
}

console.log('\n[8] compiled PASS spec contains NO secret literal (valueRef→readEnv)');
{
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'pass' })] });
  const files = X.assemblePackage({ adapterId: 'playwright-reference', admitted: r.admitted, envVars: X.collectEnvVars([envelopeFor('pass')]) });
  const blob = Object.values(files).join('\n');
  assert(!blob.includes('admin123'), 'no recorded password "admin123" anywhere in the assembled package');
  assert(X.scanSecrets(files, ['admin123']).length === 0, 'assembled package passes the secret scan');
  assert(/QAAI_USERNAME/.test(files['.env.example']) && /QAAI_PASSWORD/.test(files['.env.example']), '.env.example enumerates the credential env vars');
}

console.log('\n[9] masked refs + role-keyed dataRows stay env/vault-bound through export');
{
  const env = envelopeFor('pass');
  const fill = env.ir.steps.find((s) => s.op === 'act' && s.action === 'fill');
  fill.valueRef = 'masked:password';
  env.ir.dataRows = [{
    index: 0,
    label: 'Row 1',
    fields: { password: 'env:QAAI_TD_PASSWORD', email: 'vault:email', searchTerm: 'Admin' },
    sensitivity: { password: 'masked', email: 'restricted', searchTerm: 'synthetic' },
  }];
  const valid = contract.validateReplayIR(env.ir);
  assert(valid.valid, 'role-keyed dataRows pass validateReplayIR');
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'pass', envelope: env })] });
  const files = X.assemblePackage({ adapterId: 'playwright-reference', admitted: r.admitted, envVars: X.collectEnvVars([env]) });
  const blob = Object.values(files).join('\n');
  assert(/QAAI_MASKED_PASSWORD/.test(blob), 'masked:valueRef compiles to an env key');
  assert(!blob.includes('"masked:password"') && !blob.includes('secret123'), 'masked:valueRef is never emitted as a literal filler');
  const b = bdd.compileResults({ results: [mkResult({ status: 'pass', envelope: env })] });
  assert(/QAAI_MASKED_PASSWORD/.test(b.admitted[0].featureContent), 'BDD feature carries masked env name, not a literal value');

  const badEnv = JSON.parse(JSON.stringify(env));
  badEnv.ir.dataRows[0].fields.password = 'secret123';
  const invalid = contract.validateReplayIR(badEnv.ir);
  assert(!invalid.valid && invalid.findings.some((f) => f.rule === 'replayir_data_row_sensitive_literal'), 'role-keyed masked literal is rejected before export');
}

console.log('\n[10] data-row identity — same case, different rows never collapse');
{
  const results = [
    mkResult({ status: 'pass', dataRowIndex: 0, dataRowLabel: 'Row 0' }),
    mkResult({ status: 'pass', dataRowIndex: 1, dataRowLabel: 'Row 1' }),
  ];
  const r = X.compileResults({ adapter, results });
  const paths = new Set(r.admitted.map((a) => a.filePath));
  assert(r.admitted.length === 2 && paths.size === 2, 'two data rows of the same case → two DISTINCT spec files');
}

console.log('\n[11] all-blocked → zero admitted (service emits no normal ZIP)');
{
  const r = X.compileResults({ adapter, results: [mkResult({ envelope: null }), mkResult({ envelope: (() => { const e = envelopeFor('pass'); e.complete = false; e.gaps = []; return e; })() })] });
  assert(r.admitted.length === 0 && r.blocked.length === 2, 'all selected cases blocked → admitted=0');
}

console.log('\n[12] stable manifest — every required field present per entry');
{
  const env = envelopeFor('pass');
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'pass', dataRowIndex: 2, dataRowLabel: 'R2', envelope: env })] });
  const e = r.manifestEntries[0];
  const required = ['runId', 'runResultId', 'testCaseId', 'dataRowIndex', 'dataRowLabel', 'adapterId', 'adapterVersion', 'emitterVersion', 'irHash', 'expectedVerdict', 'complete', 'gaps', 'files', 'validationFindings', 'fileHashes'];
  const missing = required.filter((k) => !(k in e));
  assert(missing.length === 0, 'manifest entry has all required fields' + (missing.length ? ' — missing: ' + missing.join(',') : ''));
  assert(e.fileHashes[e.files[0]] && /^[0-9a-f]{64}$/.test(e.fileHashes[e.files[0]]), 'manifest carries a sha256 hash per emitted file');
  assert(e.irHash === X.hashReplayIr(env.ir) && /^[0-9a-f]{64}$/.test(e.irHash), 'manifest carries a sha256 hash of the pinned ReplayIR');
  assert(e.emitterVersion === emitter.EMITTER_VERSION, 'manifest emitterVersion comes from the pinned envelope');
}

console.log('\n[13] verdict mismatch is caught (envelope verdict must match RunResult.status)');
{
  const env = envelopeFor('pass'); // ir.verdict.status = pass
  const r = X.compileResults({ adapter, results: [mkResult({ status: 'fail', envelope: env })] }); // RunResult says fail
  assert(r.findings.some((f) => f.rule === 'verdict_mismatch' && f.severity === 'error'), 'ir.verdict.status != RunResult.status → verdict_mismatch error');
}

console.log('\n[14] BDD Route B — pass result → faithful .feature from the IR (env names, no values)');
{
  const c = bdd.compileResults({ results: [mkResult({ status: 'pass' })] });
  assert(c.admitted.length === 1 && c.blocked.length === 0, 'BDD pass admitted, not blocked');
  const f = c.admitted[0].featureContent;
  assert(/^Feature: /m.test(f) && /Scenario: /.test(f), 'feature has Feature + Scenario');
  assert(/When I fill "Username" with "QAAI_USERNAME"/.test(f) && /(When|And) I fill "Password" with "QAAI_PASSWORD"/.test(f), 'fill steps use label + ENV name');
  assert(/Then I should see "Dashboard"/.test(f), 'assertion → Then I should see {expected}');
  assert(/@qaai-replayir/.test(f) && /@verdict-pass/.test(f) && /@rr-/.test(f) && /@tc-/.test(f) && !/@skip/.test(f), 'traceability+verdict tags present, not skipped');
  assert(/# QAAI source: RunResult/.test(f) && /# expected verdict: pass/.test(f), 'feature carries source and expected-verdict comments');
  assert(c.manifestEntries[0].bdd && c.manifestEntries[0].bdd.exportable === true && c.manifestEntries[0].bdd.stepCount >= 1, 'manifest carries BDD feature metadata');
  assert(/^[0-9a-f]{64}$/.test(c.manifestEntries[0].irHash || ''), 'BDD manifest carries the ReplayIR hash');
  assert(!f.includes('admin123'), 'no credential value in the .feature');
}

console.log('\n[15] BDD canonical registry — every glue pattern unique + defined exactly once');
{
  const patterns = bdd.stepPatterns();
  assert(new Set(patterns).size === patterns.length, 'registry step patterns are unique (no duplicate)');
  const glue = bdd.emitGlue();
  let allOnce = true;
  for (const p of patterns) { const occ = glue.split(`'${p}'`).length - 1; if (occ !== 1) { allOnce = false; bad(`glue defines "${p}" ${occ}x (want 1)`); } }
  if (allOnce) ok('glue defines each canonical pattern exactly once (no undefined/ambiguous)');
  const c = bdd.compileResults({ results: [mkResult({ status: 'pass' })] });
  assert(c.admitted[0].usedStepKeys.every((k) => bdd.STEP_LIBRARY.some((s) => s.key === k)), 'every used feature step is a registry entry');
}

console.log('\n[16] BDD fail → keeps the HARD assertion, @verdict-fail, NOT @skip');
{
  const f = bdd.compileResults({ results: [mkResult({ status: 'fail', envelope: envelopeFor('fail', 'not_matched') })] }).admitted[0].featureContent;
  assert(/Then I should see "Dashboard"/.test(f), 'fail keeps the failing Then (hard assertion)');
  assert(/@verdict-fail/.test(f) && !/@skip/.test(f), 'fail tagged @verdict-fail, not skipped (must hard-fail on replay)');
}

console.log('\n[17] BDD blocked → @skip + verdict comment (cannot report green)');
{
  const c = bdd.compileResults({ results: [mkResult({ status: 'blocked', blockedReason: 'failed_prereq', envelope: envelopeFor('blocked') })] });
  const f = c.admitted[0].featureContent;
  assert(/@skip/.test(f) && /@blocked-reason-failed-prereq/.test(f) && /# verdict: blocked/.test(f), 'blocked scenario is @skip + reason tag + carries the verdict comment');
  assert(c.manifestEntries[0].bdd && c.manifestEntries[0].bdd.tags.includes('@blocked-reason-failed-prereq'), 'blocked reason is also recorded in BDD manifest metadata');
}

console.log('\n[18] BDD unsupported channel → BLOCKED with exact finding (no vague BDD)');
{
  const env = envelopeFor('pass');
  env.ir.steps.push({ op: 'assert', contractRef: 'ASN-API', channel: 'API', expected: 'x', evidence: {} });
  const c = bdd.compileResults({ results: [mkResult({ envelope: env })] });
  assert(c.admitted.length === 0 && c.blocked[0] && c.blocked[0].code === 'bdd_channel_unsupported', 'API-channel assert → bdd_channel_unsupported block');
  assert(c.manifestEntries[0].bdd && c.manifestEntries[0].bdd.blockReason === 'bdd_channel_unsupported', 'unsupported channel block is recorded in BDD manifest metadata');
}

console.log('\n[19] BDD block gate (missing/incomplete/invalid) + candidate normalization + package shape');
{
  assert(bdd.compileResults({ results: [mkResult({ envelope: null })] }).blocked[0].code === 'replayir_missing', 'missing → replayir_missing');
  const inc = envelopeFor('pass'); inc.complete = false;
  assert(bdd.compileResults({ results: [mkResult({ envelope: inc })] }).blocked[0].code === 'replayir_incomplete', 'incomplete → replayir_incomplete');
  const inv = envelopeFor('pass'); const fillS = inv.ir.steps.find((s) => s.op === 'act' && s.action === 'fill'); delete fillS.valueRef; fillS.value = 'x';
  assert(bdd.compileResults({ results: [mkResult({ envelope: inv })] }).blocked[0].code === 'replayir_invalid', 'invalid → replayir_invalid');
  const norm = bdd.normalizeCandidate({ strategy: 'css', selector: 'getByText("X")' });
  assert(norm.strategy === 'text' && norm.text === 'X', 'plain getByText("X") css → text candidate (lossless)');
  const buttonNorm = bdd.normalizeCandidate({ strategy: 'css', selector: 'getByText("Login button")' });
  assert(buttonNorm.strategy === 'role' && buttonNorm.role === 'button' && buttonNorm.name === 'Login', 'descriptor getByText("Login button") → role button named Login');
  const c = bdd.compileResults({ results: [mkResult({ status: 'pass' })] });
  const files = bdd.assemblePackage({ admitted: c.admitted, locators: c.locators, envVars: ['QAAI_USERNAME', 'QAAI_PASSWORD'] });
  for (const k of ['package.json', 'playwright.config.ts', 'steps/replayir.steps.ts', 'support/helpers.ts', 'support/locators.ts']) assert(!!files[k], `BDD package has ${k}`);
  assert(/defineBddConfig/.test(files['playwright.config.ts']), 'config uses defineBddConfig');
  assert(!Object.values(files).join('\n').includes('admin123'), 'no secret literal anywhere in the BDD package (feature+glue+support+config)');
}

// ─────────────────────────── P7c — Selenium reference ───────────────────────────
console.log('\n[19b] certified BDD export uses operation-backed table/download plans when present');
{
  const productCap = {
    capabilityId: 'cap-products',
    type: 'entity_collection',
    name: 'Product table',
    operations: ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'],
    evidence: {
      root: { selector: '[data-testid="products"]' },
      rowSelector: { selector: '[data-testid="product-row"]' },
      columns: [
        { name: 'name', selector: '[data-col="name"]' },
        { name: 'color', selector: '[data-col="color"]' },
        { name: 'price', selector: '[data-col="price"]' },
      ],
    },
  };
  const fileCap = {
    capabilityId: 'cap-downloads',
    type: 'file',
    name: 'Invoice download',
    operations: ['downloadFile'],
    evidence: {
      control: { selector: '[data-testid="download-invoice"]' },
    },
  };
  const operationPlan = {
    status: 'complete',
    operations: [
      { operation: 'selectEntityWhere', capabilityRef: 'cap-products', params: { entity: 'product', criteria: [{ field: 'name', operator: 'contains', value: '{{product}}' }, { field: 'color', operator: 'equals', value: '{{color}}' }] } },
      { operation: 'rankByMin', capabilityRef: 'cap-products', params: { field: 'price' } },
      { operation: 'chooseSelected', capabilityRef: 'cap-products', params: {} },
      { operation: 'assertTableContains', capabilityRef: 'cap-products', params: { criteria: [{ field: 'color', operator: 'equals', value: '{{color}}' }] } },
      { operation: 'downloadFile', capabilityRef: 'cap-downloads', params: { target: 'invoice' } },
    ],
    dropped: [],
  };
  const env = envelopeFor('pass');
  env.ir.dataRows = [
    { index: 0, label: 'black iPhone', fields: { product: 'iPhone 17', color: 'black' }, sensitivity: { product: 'synthetic', color: 'synthetic' } },
    { index: 1, label: 'pink iPhone', fields: { product: 'iPhone 17', color: 'pink' }, sensitivity: { product: 'synthetic', color: 'synthetic' } },
  ];
  const result = bdd.compileResults({
    results: [mkResult({ status: 'pass', caseName: 'Pick least visible product', moduleName: 'Shop', envelope: env, operationPlan, capabilities: [productCap, fileCap] })],
  });
  assert(result.admitted.length === 1 && result.blocked.length === 0, 'operation-backed table plan is admitted through the certified BDD adapter');
  assert(result.admitted[0].bdd.operationBacked === true, 'manifest metadata marks the feature operationBacked=true');
  const feature = result.admitted[0].featureContent;
  assert(/@bdd-operation-backed/.test(feature), 'feature carries the operation-backed tag');
  assert(/I select "product" entities where:/.test(feature) && /I choose the selected entity with minimum "price"/.test(feature) && /I download the "invoice" file/.test(feature), 'feature contains canonical table/ranking/download operation steps');
  assert(/\| name \| contains \| <product> \|/.test(feature) && /\| color \| equals \| <color> \|/.test(feature), '{{role}} operation params become Scenario Outline placeholders');
  assert(/Examples:[\s\S]*\| product \| color \|[\s\S]*\| iPhone 17 \| black \|[\s\S]*\| iPhone 17 \| pink \|/.test(feature), 'dataRows become Scenario Outline Examples for each approved row');
  const files = bdd.assemblePackage({ admitted: result.admitted, locators: result.locators, envVars: [], operationFiles: result.operationFiles });
  assert(!!files['steps/capability.steps.ts'] && !!files['support/capabilityOperations.ts'], 'official package includes operation glue/support files');
  assert(/doRankByMin/.test(files['support/capabilityOperations.ts']) && /doDownloadFile/.test(files['support/capabilityOperations.ts']), 'operation support carries first-class table ranking + download helpers');

  const incomplete = bdd.compileResults({
    results: [mkResult({ envelope: env, operationPlan: { status: 'incomplete', operations: operationPlan.operations, dropped: [{ operation: 'downloadFile', reason: 'capability_not_in_atlas' }] }, capabilities: [productCap, fileCap] })],
  });
  assert(incomplete.admitted.length === 0 && incomplete.blocked[0].code === 'bdd_operation_plan_incomplete', 'incomplete operationsJson blocks certified BDD instead of falling back to low-level ReplayIR');

  const pwResult = X.compileResults({
    adapter,
    results: [mkResult({ status: 'pass', caseName: 'Pick least visible product', moduleName: 'Shop', envelope: env, operationPlan, capabilities: [productCap, fileCap] })],
  });
  assert(pwResult.admitted.length === 1 && pwResult.blocked.length === 0, 'Playwright reference admits the same verified operation-backed plan');
  assert(pwResult.manifestEntries[0].operationBacked === true, 'Playwright manifest marks operationBacked=true');
  assert(/createQaaOperationRunner/.test(pwResult.admitted[0].content) && /await qaaOps\("selectEntityWhere"/.test(pwResult.admitted[0].content) && /await qaaOps\("downloadFile"/.test(pwResult.admitted[0].content), 'Playwright spec contains first-class table/ranking/download operation calls');
  assert(/readData\(row, "product"\)/.test(pwResult.admitted[0].content) && /readData\(row, "color"\)/.test(pwResult.admitted[0].content), 'Playwright operation params use role-keyed data rows');

  const seleniumAdapterForOps = registry.getAdapter('selenium-reference');
  const selResult = X.compileResults({
    adapter: seleniumAdapterForOps,
    results: [mkResult({ status: 'pass', caseName: 'Pick least visible product', moduleName: 'Shop', envelope: env, operationPlan, capabilities: [productCap, fileCap] })],
  });
  assert(selResult.admitted.length === 1 && selResult.blocked.length === 0, 'Selenium reference admits the same verified operation-backed plan');
  assert(selResult.manifestEntries[0].operationBacked === true, 'Selenium manifest marks operationBacked=true');
  assert(/runQaaOperation\("selectEntityWhere"/.test(selResult.admitted[0].content) && /runQaaOperation\("downloadFile"/.test(selResult.admitted[0].content), 'Selenium class contains first-class table/ranking/download operation calls');
  assert(/rowValue\(row, "product"\)/.test(selResult.admitted[0].content) && /rowValue\(row, "color"\)/.test(selResult.admitted[0].content), 'Selenium operation params use role-keyed data rows');
  assert(/cap\.controlSelector/.test(selResult.admitted[0].content), 'Selenium download helper reads verified file-control selector evidence');

  const pwIncomplete = X.compileResults({
    adapter,
    results: [mkResult({ envelope: env, operationPlan: { status: 'incomplete', operations: operationPlan.operations, dropped: [{ operation: 'downloadFile', reason: 'capability_not_in_atlas' }] }, capabilities: [productCap, fileCap] })],
  });
  const selIncomplete = X.compileResults({
    adapter: seleniumAdapterForOps,
    results: [mkResult({ envelope: env, operationPlan: { status: 'incomplete', operations: operationPlan.operations, dropped: [{ operation: 'downloadFile', reason: 'capability_not_in_atlas' }] }, capabilities: [productCap, fileCap] })],
  });
  assert(pwIncomplete.admitted.length === 0 && pwIncomplete.blocked[0].code === 'operation_plan_incomplete', 'incomplete operationsJson blocks certified Playwright instead of falling back');
  assert(selIncomplete.admitted.length === 0 && selIncomplete.blocked[0].code === 'operation_plan_incomplete', 'incomplete operationsJson blocks certified Selenium instead of falling back');
}

const selAdapter = registry.getAdapter('selenium-reference');

console.log('\n[20] Selenium adapter satisfies the FROZEN contract + its regression corpus compiles');
{
  assert(!!selAdapter && registry.listAdapters().includes('selenium-reference'), 'selenium-reference is registered');
  const av = contract.validateAdapter(selAdapter);
  assert(av.valid && av.findings.filter((f) => f.severity === 'error').length === 0, 'selenium-reference implements all 15 REQUIRED_METHODS + regressionCorpus');
  const corpus = regressionCorpus.forAdapter('selenium-reference')[0];
  assert(!!corpus, 'a selenium-reference regression corpus case exists');
  const compiled = contract.compileReplayIR(selAdapter, corpus.replayIR);
  assert(compiled.layout.testFile === 'src/test/java/com/qaai/replayir/Replay_TC_LOGIN_VALID_ROW_1.java', 'layout path is src/test/java/<pkg>/<Class>.java');
  assert(compiled.compileCommand.cmd === 'mvn' && compiled.runCommand.cmd === 'mvn', 'compile/run commands are Maven');
  const content = compiled.files[compiled.layout.testFile];
  let allFrags = true;
  for (const frag of corpus.expectedFragments) { if (!content.includes(frag)) { allFrags = false; bad('missing Java fragment: ' + frag); } }
  if (allFrags) ok('every frozen Java fragment is present (env-bound values, ARIA locators, faithful oracle)');
}

console.log('\n[21] PASS result → admitted, compiles a TestNG class, env-bound (no inline secret), faithful');
{
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ status: 'pass' })] });
  assert(r.admitted.length === 1 && r.blocked.length === 0, 'pass result admitted, not blocked');
  const c = r.admitted[0].content;
  assert(/public class \w+ extends BaseTest \{/.test(c) && /@Test\b/.test(c) && /public void replay\(\) throws Exception/.test(c), 'emits a TestNG @Test class extending BaseTest');
  assert(/EnvReader\.read\("QAAI_USERNAME"\)/.test(c) && /EnvReader\.read\("QAAI_PASSWORD"\)/.test(c), 'credentials resolve via EnvReader (System.getenv), never inline');
  assert(/Assert\.assertTrue\(seesText\(/.test(c), 'UI_TEXT oracle uses the Selenium visible-text presence helper');
  assert(!c.includes('@Test(enabled = false)') && !c.includes('admin123'), 'pass test is NOT disabled and carries no credential literal');
  assert(r.admitted[0].filePath.startsWith('src/test/java/com/qaai/replayir/') && r.admitted[0].filePath.endsWith('.java'), 'test lands under src/test/java/<pkg>/');
}

console.log('\n[22] Selenium block gates — missing / incomplete / invalid IR → BLOCKED (no fallback)');
{
  assert(X.compileResults({ adapter: selAdapter, results: [mkResult({ envelope: null })] }).blocked[0].code === 'replayir_missing', 'missing → replayir_missing');
  const inc = envelopeFor('pass'); inc.complete = false;
  assert(X.compileResults({ adapter: selAdapter, results: [mkResult({ envelope: inc })] }).blocked[0].code === 'replayir_incomplete', 'incomplete → replayir_incomplete');
  const inv = envelopeFor('pass'); const f = inv.ir.steps.find((s) => s.op === 'act' && s.action === 'fill'); delete f.valueRef; f.value = 'x';
  assert(X.compileResults({ adapter: selAdapter, results: [mkResult({ envelope: inv })] }).blocked[0].code === 'replayir_invalid', 'invalid (inline value) → replayir_invalid');
}

console.log('\n[23] FAIL result → keeps the HARD assertion, NOT @Test(enabled=false)');
{
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ status: 'fail', envelope: envelopeFor('fail', 'not_matched') })] });
  assert(r.admitted.length === 1, 'fail result is admitted (faithful, not dropped)');
  const c = r.admitted[0].content;
  assert(/Assert\.assert(True|False)\(/.test(c), 'fail spec still CONTAINS the hard assertion that failed');
  assert(!c.includes('@Test(enabled = false)'), 'fail spec is NOT disabled — it must hard-fail on replay if the bug persists');
  assert(r.manifestEntries.find((m) => m.status === 'fail').expectedVerdict === 'fail', 'manifest expectedVerdict=fail');
}

console.log('\n[24] BLOCKED result → @Test(enabled = false) + verdict note (cannot report green)');
{
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ status: 'blocked', envelope: envelopeFor('blocked') })] });
  assert(r.admitted.length === 1 && r.admitted[0].content.includes('@Test(enabled = false)'), 'blocked test disabled via @Test(enabled = false)');
  assert(/verdict-preservation/.test(r.admitted[0].content), 'blocked test carries the verdict-preservation note');
  assert(r.manifestEntries.find((m) => m.expectedVerdict === 'blocked'), 'manifest records expectedVerdict=blocked');
}

console.log('\n[25] unsupported assert channel → throwing STUB + exact finding (package still valid)');
{
  const env = envelopeFor('pass');
  env.ir.steps.push({ op: 'assert', contractRef: 'ASN-API', channel: 'API', expected: 'x', evidence: {} });
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ envelope: env })] });
  assert(r.admitted.length === 1, 'unsupported channel does NOT block (Selenium emits a throwing stub, unlike BDD)');
  const c = r.admitted[0].content;
  assert(c.includes('selenium_channel_unsupported:API'), 'emits a throwing stub naming the unsupported channel');
  assert(r.findings.some((f) => f.rule === 'selenium_channel_unsupported:API' && f.severity === 'warning'), 'exact finding surfaced as a warning (not an error → export stays valid)');
}

console.log('\n[26] unmappable locator → BLOCKED selenium_locator_unmappable (no invented selector)');
{
  const env = envelopeFor('pass');
  const res = env.ir.steps.find((s) => s.op === 'resolve');
  res.candidates = [{ strategy: 'altText', name: 'mystery' }];
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ envelope: env })] });
  assert(r.admitted.length === 0 && r.blocked[0] && r.blocked[0].code === 'selenium_locator_unmappable', 'no candidate maps → selenium_locator_unmappable block (refuses to fabricate a By)');
}

console.log('\n[27] assembled Selenium package — Maven/TestNG shape + no secret leak + env listing');
{
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ status: 'pass' })] });
  const files = sel.assemblePackage({ admitted: r.admitted, envVars: X.collectEnvVars([envelopeFor('pass')]) });
  for (const k of ['pom.xml', 'testng.xml', 'src/test/java/com/qaai/replayir/BaseTest.java', 'src/test/java/com/qaai/replayir/LocatorResolver.java', 'src/test/java/com/qaai/replayir/LocatorCandidate.java', 'src/test/java/com/qaai/replayir/EnvReader.java']) {
    assert(!!files[k], `package has ${k}`);
  }
  assert(/<artifactId>selenium-java<\/artifactId>/.test(files['pom.xml']) && /<artifactId>testng<\/artifactId>/.test(files['pom.xml']), 'pom declares selenium-java + testng');
  assert(/<package name="com.qaai.replayir"\/>/.test(files['testng.xml']), 'testng.xml discovers the generated package');
  const blob = Object.values(files).join('\n');
  assert(!blob.includes('admin123'), 'no recorded password "admin123" anywhere in the Selenium package');
  assert(X.scanSecrets(files, ['admin123']).length === 0, 'assembled package passes the secret scan (System.getenv is not a leak)');
  assert(/QAAI_USERNAME/.test(files['.env.example']) && /QAAI_PASSWORD/.test(files['.env.example']), '.env.example enumerates the credential env vars');
}

console.log('\n[28] data-row identity — same case, different rows → DISTINCT Java classes (no collapse)');
{
  const results = [
    mkResult({ status: 'pass', dataRowIndex: 0, dataRowLabel: 'Row 0' }),
    mkResult({ status: 'pass', dataRowIndex: 1, dataRowLabel: 'Row 1' }),
  ];
  const r = X.compileResults({ adapter: selAdapter, results });
  const paths = new Set(r.admitted.map((a) => a.filePath));
  assert(r.admitted.length === 2 && paths.size === 2, 'two data rows → two DISTINCT .java files');
  let classMatchesFile = true;
  for (const a of r.admitted) {
    const cls = a.filePath.split('/').pop().replace(/\.java$/, '');
    if (!a.content.includes(`public class ${cls} extends BaseTest`)) { classMatchesFile = false; bad(`class name != filename for ${a.filePath}`); }
  }
  if (classMatchesFile) ok('each file declares a public class matching its filename (Java invariant)');
}

console.log('\n[29] Selenium manifest — stable fields + adapter identity + masked refs stay env-bound');
{
  const env = envelopeFor('pass');
  const fill = env.ir.steps.find((s) => s.op === 'act' && s.action === 'fill');
  fill.valueRef = 'masked:password';
  const r = X.compileResults({ adapter: selAdapter, results: [mkResult({ status: 'pass', dataRowIndex: 3, dataRowLabel: 'R3', envelope: env })] });
  const e = r.manifestEntries[0];
  const required = ['runId', 'runResultId', 'testCaseId', 'dataRowIndex', 'dataRowLabel', 'adapterId', 'adapterVersion', 'emitterVersion', 'irHash', 'expectedVerdict', 'complete', 'gaps', 'files', 'validationFindings', 'fileHashes'];
  assert(required.every((k) => k in e), 'manifest entry has all required fields');
  assert(e.adapterId === 'selenium-reference' && e.adapterVersion === 'selenium-reference-1', 'manifest carries the selenium adapter identity + version');
  assert(e.fileHashes[e.files[0]] && /^[0-9a-f]{64}$/.test(e.fileHashes[e.files[0]]), 'sha256 hash per emitted file');
  assert(/^[0-9a-f]{64}$/.test(e.irHash || ''), 'selenium manifest carries the ReplayIR hash');
  assert(/EnvReader\.read\("QAAI_MASKED_PASSWORD"\)/.test(r.admitted[0].content) && !r.admitted[0].content.includes('masked:password'), 'masked:valueRef → env key, never a literal');
}

console.log('\n[30] strict oracle + locator ambiguity gates');
{
  const env = envelopeFor('pass');
  const assertion = env.ir.steps.find((s) => s.op === 'assert');
  delete assertion.expected;
  assert(X.compileResults({ adapter, results: [mkResult({ envelope: env })] }).blocked[0].code === 'replayir_invalid', 'Playwright export blocks expected-less assertions');
  assert(bdd.compileResults({ results: [mkResult({ envelope: env })] }).blocked[0].code === 'replayir_invalid', 'BDD export blocks expected-less assertions');
  assert(X.compileResults({ adapter: selAdapter, results: [mkResult({ envelope: env })] }).blocked[0].code === 'replayir_invalid', 'Selenium export blocks expected-less assertions');

  const pwCompiled = contract.compileReplayIR(adapter, envelopeFor('pass').ir);
  const pwSpec = Object.values(pwCompiled.files).join('\n');
  const assembled = { files: X.assemblePackage({ adapterId: 'playwright-reference', admitted: [], envVars: [] }) };
  const pwSupport = assembled.files['tests/support/replayir.ts'] || pwSpec;
  assert(/candidate ambiguous: matched/.test(pwSupport) && !/count > 1[\s\S]{0,120}return first/.test(pwSupport), 'Playwright resolver errors on ambiguous matches instead of returning first');
  const bddHelpers = bdd.emitHelpers();
  assert(/ambiguous match count=/.test(bddHelpers) && !/count >= 1\) return loc\.first/.test(bddHelpers), 'BDD resolver errors on ambiguous matches instead of returning first');
  const seleniumShell = sel.assemblePackage({ admitted: [], envVars: [] });
  assert(/ambiguous visible match count=/.test(seleniumShell['src/test/java/com/qaai/replayir/LocatorResolver.java']), 'Selenium resolver errors on ambiguous visible matches');
}

console.log('\n[31] standalone AuthProfile storageState package wiring');
{
  const state = { cookies: [{ name: 'sid', value: 'opaque-session', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] };
  const authState = {
    storageStateRel: '.auth/state.json',
    files: { '.auth/state.json': X.normalizeStorageStateFile(state) },
  };
  assert(!!authState.files['.auth/state.json'] && authState.files['.auth/state.json'].includes('"cookies"'), 'usable storageState is normalized into a package file');

  const pw = X.assemblePackage({ adapterId: 'playwright-reference', admitted: [], envVars: [], authState });
  assert(!!pw['.auth/state.json'], 'Playwright package includes .auth/state.json');
  assert(/storageState:\s*"\.auth\/state\.json"/.test(pw['playwright.config.ts']), 'Playwright config wires use.storageState');
  assert(!pw['playwright.config.ts'].includes('opaque-session'), 'Playwright config references the auth file, not the cookie value');

  const bd = bdd.assemblePackage({ admitted: [], locators: {}, envVars: [], authState });
  assert(!!bd['.auth/state.json'], 'BDD package includes .auth/state.json');
  assert(/storageState:\s*"\.auth\/state\.json"/.test(bd['playwright.config.ts']), 'BDD config wires use.storageState');
  assert(!Object.entries(bd).filter(([k]) => k !== '.auth/state.json').map(([, v]) => v).join('\n').includes('opaque-session'), 'BDD feature/glue/config never contain the cookie value');

  const env = envelopeFor('pass');
  env.ir.authProfile = { id: 'admin', strategy: 'sso', disposition: 'bypass_fixture', storageStateRef: 'fixture:auth-fixture-1' };
  assert(X.collectAuthStateRefs([env]).join(',') === 'fixture:auth-fixture-1', 'AuthProfile storageStateRef is discovered from the ReplayIR envelope');
  assert(X.normalizeStorageStateFile({ cookies: [], origins: [] }) === null, 'empty storageState is rejected');
}

console.log(`\n${failures === 0 ? 'PASS - P7 IR-sourced export core: Playwright + BDD Route B + Selenium reference (IR-only, block-gated, verdict-preserving, leak-free, identity-safe, manifest-stable; no invented locators, unsupported channels stubbed with exact reason)' : 'FAIL - ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
