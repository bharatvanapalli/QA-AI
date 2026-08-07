'use strict';
/**
 * Deterministic guard for the TestData feature (Round A). No LLM, no credits.
 *   node scripts/verify_testdata.cjs
 *
 * [1] dataMapper (M-B) — header→role, special-column detection, sheet→scenario
 *     fuzzy match, full deterministic map, no-provider degradation, and the
 *     LLM-residue merge with its safety filter (unknown roles rejected).
 * [2] testData parser (F-A) — activates once server/services/testData.js lands
 *     (PENDING skip until then, so this guard is green during parallel work).
 */
const path = require('path');
const dm = require('../server/services/agents/dataMapper');
const tdm = require('../server/services/testDataMatrix');
const fs = require('fs');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));

console.log('\n[1] dataMapper — deterministic column/sheet binding');

// header → canonical role
assert(dm.headerToRole('Username') === 'username', 'header "Username" → username');
assert(dm.headerToRole('First Name') === 'firstName', 'header "First Name" → firstName (not generic name)');
assert(dm.headerToRole('Email Address') === 'email', 'header "Email Address" → email');
assert(dm.headerToRole('Password') === 'password', 'header "Password" → password');
assert(dm.headerToRole('Favorite Flavor') === null, 'unknown header → null (left for LLM/user)');
assert(dm.rawHeaderRole('Favorite Flavor') === 'favoriteFlavor', 'unknown-but-safe header → raw role fallback for output data binding');
assert(dm.headerToRole('Expected Result') === null, 'an expected-result column is NOT an input role');

// special-column detectors
assert(dm.isExpectedHeader('Expected Result') && dm.isExpectedHeader('Expected Outcome'), 'expected-column detector');
assert(dm.isErrorHeader('Error Message') && !dm.isErrorHeader('First Name'), 'error-column detector');
assert(dm.isRowClassHeader('Type') && dm.isRowClassHeader('Validity') && !dm.isRowClassHeader('City'), 'row-class detector');
assert(dm.isMetadataHeader('testCaseID') && dm.isMetadataHeader('Notes'), 'metadata-column detector');

// sheet → scenario fuzzy match
const scenarios = [
  { name: 'User Login', module: 'Authentication' },
  { name: 'Create Employee', module: 'PIM' },
];
const m = dm.fuzzyScenarioForSheet('Login Data', scenarios);
assert(m && m.scenarioName === 'User Login', 'sheet "Login Data" fuzzy-matches scenario "User Login"');
assert(dm.fuzzyScenarioForSheet('Totally Unrelated', scenarios) === null, 'a sheet with no shared token → no match');

// full deterministic map
const sheets = [{
  name: 'Login',
  headers: ['Username', 'Password', 'Expected Result', 'Type', 'Favorite Flavor'],
  rows: [
    { Username: 'Admin', Password: 'admin123', 'Expected Result': 'dashboard', Type: 'positive', 'Favorite Flavor': 'x' },
    { Username: '', Password: 'x', 'Expected Result': 'Required', Type: 'negative', 'Favorite Flavor': 'y' },
  ],
}];
const det = dm.deterministicMap({ sheets, scenarios });
const b0 = det.bindings[0];
assert(b0.columnToField.username === 'Username' && b0.columnToField.password === 'Password', 'deterministicMap binds username + password columns');
assert(b0.columnToField.favoriteFlavor === 'Favorite Flavor', 'deterministicMap preserves safe unknown columns as raw data roles');
assert(b0.expectedColumn === 'Expected Result', 'deterministicMap finds the expected column');
assert(b0.rowClassColumn === 'Type', 'deterministicMap finds the row-class column');
assert(b0.scenarioName === 'User Login' && b0.confidence === 'high', 'deterministicMap binds the sheet to a scenario (high confidence)');
assert(!det.unmapped.some((u) => u.header === 'Favorite Flavor'), 'safe unknown columns are no longer dropped from deterministic binding');
const withReadme = dm.deterministicMap({
  sheets: sheets.concat([{ name: 'README', headers: ['Field', 'Description'], rows: [{ Field: 'username', Description: 'documentation only' }] }]),
  scenarios,
});
assert(withReadme.bindings.length === 1 && withReadme.ignoredSheets.some((x) => x.sheet === 'README'), 'README/instruction sheets are ignored by deterministicMap');

console.log('\n[1b] dataMapper — provider degradation + LLM residue merge');

// no provider → deterministic-only, never throws
(async () => {
  const noLlm = await dm.mapTestData({ sheets, scenarios });
  assert(noLlm.version === 1 && Array.isArray(noLlm.bindings) && noLlm.bindings.length === 1, 'no-provider path returns deterministic-only mapping');
  assert(noLlm.bindings[0].columnToField.favoriteFlavor === 'Favorite Flavor', 'no-provider path keeps safe unknown columns data-bindable');

  // mock provider resolves the ambiguous column to a KNOWN role; an UNKNOWN role is rejected.
  const llmSheets = [{
    name: 'Login',
    headers: ['Username', '123 ???'],
    rows: [{ Username: 'Admin', '123 ???': 'x' }],
  }];
  const mockProvider = {
    complete: async () => ({ content: [{ text: JSON.stringify({
      columnFields: { Login: { '123 ???': 'comment' } },
      sheetScenario: {},
    }) }] }),
  };
  const withLlm = await dm.mapTestData({ sheets: llmSheets, scenarios, provider: mockProvider, apiKey: 'x', model: 'mid' });
  const lb = withLlm.bindings[0];
  assert(lb.columnToField.comment === '123 ???', 'LLM residue: ambiguous column mapped to a known role (comment)');
  assert(!withLlm.unmapped.some((u) => u.header === '123 ???'), 'LLM residue: resolved column removed from unmapped');

  const badProvider = {
    complete: async () => ({ content: [{ text: JSON.stringify({
      columnFields: { Login: { '123 ???': 'banana' } }, // not a real role
      sheetScenario: {},
    }) }] }),
  };
  const rejected = await dm.mapTestData({ sheets: llmSheets, scenarios, provider: badProvider, apiKey: 'x', model: 'mid' });
  assert(!rejected.bindings[0].columnToField.banana && rejected.unmapped.some((u) => u.header === '123 ???'),
    'LLM residue: an UNKNOWN role is rejected (safety filter), column stays unmapped');

  console.log('\n[2] testData parser (F-A)');
  let parser = null;
  try { parser = require('../server/services/testData'); } catch (_) { parser = null; }
  if (!parser || typeof parser.parseWorkbook !== 'function') {
    console.log('  ⧖ pending — server/services/testData.js not landed yet; parser checks activate on merge (NOT a failure)');
  } else {
    const csv = 'username,password,Expected Result\nAdmin,admin123,dashboard\nbad,bad,error';
    const out = await parser.parseWorkbook({ content: csv, name: 'login.csv', mimeType: 'text/csv' });
    assert(out && Array.isArray(out.sheets) && out.sheets.length >= 1, 'parser returns a sheets array');
    const s = out.sheets[0];
    assert(Array.isArray(s.headers) && s.headers.includes('username'), 'parser extracts headers from row 1');
    assert(Array.isArray(s.rows) && s.rows.length === 2 && s.rows[0].username === 'Admin', 'parser keys each row by header');
    assert(typeof out.rowCount === 'number' && out.rowCount === 2, 'parser reports rowCount');
  }

  console.log('\n[3] Architect data-aware block (M-C) — buildTestDataBlock');
  const architect = require('../server/services/agents/architect');
  assert(architect.buildTestDataBlock(null) === null, 'no test data → null (Architect prompt byte-identical to before)');
  assert(architect.buildTestDataBlock({ sheets: [], mapping: { bindings: [] } }) === null, 'empty sheets/bindings → null');
  const mapping = { version: 1, bindings: [{ sheet: 'Login', scenarioName: 'User Login', module: 'Authentication', columnToField: { username: 'Username', password: 'Password' }, expectedColumn: 'Expected Result', rowClassColumn: 'Type' }], unmapped: [{ sheet: 'Login', header: 'Favorite Flavor' }] };
  const block = architect.buildTestDataBlock({ sheets, mapping });
  assert(typeof block === 'string' && /AVAILABLE TEST DATA/.test(block), 'data block renders a DATA CONTEXT header');
  assert(/Sheet "Login" → scenario "User Login"/.test(block), 'block binds the sheet to its scenario');
  assert(/username←"Username"/.test(block) && /password←"Password"/.test(block), 'block lists column→field inputs');
  assert(/Admin/.test(block) && /admin123/.test(block), 'block includes REAL sample row values (not invented)');
  assert(/HOW TO USE THE TEST DATA/.test(block) && /NEVER invent/.test(block), 'block carries the data-aware authoring instructions');
  assert(/UNMAPPED COLUMNS/.test(block) && /Favorite Flavor/.test(block), 'block surfaces unmapped columns as context-only');
  const strictBlock = architect.buildTestDataBlock({
    sheets,
    mapping,
    generationContract: {
      strict: true,
      allowedTokens: ['expected', 'password', 'rowclass', 'username'],
      executableSheetNames: ['Login'],
    },
  });
  assert(/GENERATION DATA CONTRACT \(STRICT\)/.test(strictBlock), 'strict generation contract is rendered into the Architect prompt');
  assert(/username=\{\{username\}\}/.test(strictBlock) && /password=\{\{password\}\}/.test(strictBlock), 'strict prompt renders data rows as canonical tokens');
  assert(!/admin123/.test(strictBlock), 'strict prompt does not expose uploaded password literals for the model to copy');
  // Every architect.run() call site threads testData (wiring guard).
  const scn = require('fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'scenarios.js'), 'utf8');
  const agt = require('fs').readFileSync(path.join(__dirname, '..', 'server', 'routes', 'agents.js'), 'utf8');
  assert((scn.match(/testData,/g) || []).length >= 2, 'scenarios.js threads testData into both architect.run calls');
  assert(/loadGenerationTestDataContract/.test(agt) && /priorContext[\s\S]{0,240}testData/.test(agt), 'agents.js threads generation-contracted testData into architect.run');

  console.log('\n[3b] testDataContext — module-scoped sheets plus shared auth only');
  const tdc = require('../server/services/testDataContext');
  const scopedCtx = {
    sheets: [
      { name: 'LoginData', headers: ['Username', 'Password', 'Expected Result'], rows: [{ Username: 'Admin', Password: 'x' }] },
      { name: 'EmployeeData', headers: ['First Name', 'Last Name', 'Employee Id'], rows: [{ 'First Name': 'Asha' }] },
      { name: 'LeaveData', headers: ['Leave Type', 'From Date', 'To Date'], rows: [{ 'Leave Type': 'Annual' }] },
      { name: 'AdminUsers', headers: ['User Role', 'Employee Name'], rows: [{ 'User Role': 'ESS' }] },
      { name: 'README', headers: ['Field', 'Description'], rows: [{ Field: 'Username', Description: 'Documentation only' }] },
    ],
    mapping: {
      version: 1,
      bindings: [
        { sheet: 'LoginData', module: 'Authentication', scenarioName: 'User Login', columnToField: { username: 'Username', password: 'Password' } },
        { sheet: 'EmployeeData', module: 'PIM', scenarioName: 'Create Employee', columnToField: { firstName: 'First Name', lastName: 'Last Name' } },
        { sheet: 'LeaveData', module: 'Leave', scenarioName: 'Apply Leave', columnToField: { leaveType: 'Leave Type' } },
        { sheet: 'AdminUsers', module: 'Admin', scenarioName: 'Create User', columnToField: { role: 'User Role' } },
        { sheet: 'README', module: 'Authentication', scenarioName: 'Documentation', columnToField: { username: 'Field' } },
      ],
      unmapped: [
        { sheet: 'EmployeeData', header: 'Nickname' },
        { sheet: 'LeaveData', header: 'Comment' },
      ],
    },
  };
  const pimCtx = tdc.filterTestDataContextForModule(scopedCtx, 'PIM');
  assert(pimCtx.sheets.map((s) => s.name).sort().join(',') === 'EmployeeData,LoginData', 'PIM scope keeps PIM sheet plus shared LoginData only');
  assert(pimCtx.mapping.bindings.map((b) => b.sheet).sort().join(',') === 'EmployeeData,LoginData', 'PIM scope keeps only matching/shared bindings');
  assert(pimCtx.mapping.unmapped.length === 1 && pimCtx.mapping.unmapped[0].sheet === 'EmployeeData', 'PIM scope keeps only unmapped columns for kept sheets');
  assert(pimCtx.mapping.filteredFrom.sheetCount === 4 && pimCtx.mapping.filteredFrom.keptSheetCount === 2, 'PIM scope reports filteredFrom counts after removing README');
  const leaveCtx = tdc.filterTestDataContextForModule(scopedCtx, 'Leave');
  assert(leaveCtx.sheets.map((s) => s.name).sort().join(',') === 'LeaveData,LoginData', 'Leave scope keeps Leave sheet plus shared LoginData only');
  assert(tdc.filterTestDataContextForModule(scopedCtx, null) === scopedCtx, 'no moduleScope returns the same context object (legacy path unchanged)');
  assert(/loadGenerationTestDataContract/.test(scn) && /moduleScope/.test(scn), 'scenarios.js passes moduleScope into the generation data contract loader');

  console.log('\n[3c] testDataGenerationContract — strict generation contract and route wiring');
  const genContract = require('../server/services/testDataGenerationContract');
  const contract = genContract.buildGenerationDataContract({ sheets, mapping }, { moduleScope: 'Authentication', source: 'draft' });
  assert(contract.status === 'ready' && contract.strict === true, 'contract is ready/strict when executable bindings exist');
  assert(contract.executableSheetNames.join(',') === 'Login', 'contract lists executable sheets only');
  assert(contract.allowedTokens.includes('username') && contract.allowedTokens.includes('password') && contract.allowedTokens.includes('expected'), 'contract exposes canonical role tokens');
  assert(contract.forbiddenLiterals.includes('Admin') && contract.forbiddenLiterals.includes('admin123'), 'contract records uploaded row literals as forbidden authoring literals');
  assert(/loadGenerationTestDataContract/.test(scn) && /generationTestDataBundle\.source === 'approved'/.test(scn) && /requireApprovedMapping: enforceApprovedTestData/.test(scn), 'scenarios.js uses mapped test data for prompting, but hard-gates persistence only for approved mappings');
  assert(/createdScenarioIds/.test(scn) && /scenarioGeneration\.deleteMany/.test(scn), 'scenarios.js cleans up a failed generation shell if case persistence fails');
  assert(/loadGenerationTestDataContract/.test(agt) && /generationTestDataBundle\.source === 'approved'/.test(agt) && /requireApprovedMapping: enforceApprovedTestData/.test(agt), 'agents.js all-in-one path uses the same approved-only hard gate');

  // ─── ROUND B — per-row (matrix) execution ──────────────────────────────────
  console.log('\n[4] testDataMatrix — resolveCaseRows (EXPLICIT-binding fan-out only)');
  const tdSheets = [{
    name: 'Login',
    headers: ['Username', 'Password', 'Expected Result', 'Type'],
    rows: [
      { Username: 'Admin', Password: 'admin123', 'Expected Result': 'Dashboard', Type: 'positive' },
      { Username: '', Password: 'x', 'Expected Result': 'Required', Type: 'negative' },
      { Username: 'bad', Password: 'bad', 'Expected Result': 'Invalid credentials', Type: 'negative' },
    ],
  }];
  const tdMapping = { version: 1, bindings: [{ sheet: 'Login', scenarioName: 'User Login', module: 'Authentication', columnToField: { username: 'Username', password: 'Password' }, expectedColumn: 'Expected Result', rowClassColumn: 'Type' }], unmapped: [] };
  const tdData = { sheets: tdSheets, mapping: tdMapping };
  const scnB = { name: 'User Login', module: 'Authentication' };

  assert(tdm.resolveCaseRows({ id: 'c1', dataBindingJson: JSON.stringify({ sheet: 'Login' }) }, scnB, null).length === 0, 'no test data → not data-driven (case runs once)');
  assert(tdm.resolveCaseRows({ id: 'c2', name: 'Empty password', dataBindingJson: null }, scnB, tdData).length === 0, 'case WITHOUT a binding → NOT fanned out (scenario match alone never fans — no explosion)');
  const rowsB = tdm.resolveCaseRows({ id: 'c3', dataBindingJson: JSON.stringify({ sheet: 'Login' }) }, scnB, tdData);
  assert(rowsB.length === 3, 'explicit bare { sheet } binding → one execution per sheet row (3)');
  assert(rowsB[0].inputs.username === 'Admin' && rowsB[0].inputs.password === 'admin123', 'row inputs resolved via mapping columnToField (bare binding hydrated)');
  assert(rowsB[0].expected === 'Dashboard' && rowsB[1].expected === 'Required', 'per-row expected resolved from the expected column');
  assert(rowsB[0].rowClass === 'positive' && rowsB[1].rowClass === 'negative', 'per-row class resolved from the row-class column');
  assert(/Row 1/.test(rowsB[0].label) && /Admin/.test(rowsB[0].label), 'row label carries index + a lead input value');
  assert(tdm.resolveCaseRows({ id: 'c4', dataBindingJson: JSON.stringify({ sheet: 'Login' }) }, scnB, tdData, { isJourneyMember: true }).length === 3, 'journey-chain member resolves the same explicit data rows instead of bypassing its binding');
  const negRows = tdm.resolveCaseRows({ id: 'c5', dataBindingJson: JSON.stringify({ sheet: 'Login', rowSelector: 'negative' }) }, scnB, tdData);
  assert(negRows.length === 2 && negRows.every((r) => r.rowClass === 'negative'), 'rowSelector "negative" → only the negative rows');

  console.log('\n[5] testDataMatrix — substituteCase (token fill + guidance, no mutation)');
  const tcTemplate = {
    id: 'c3', name: 'Login with data',
    steps: JSON.stringify([
      { order: 1, action: 'Type', element: 'Username field', value: '{{username}}' },
      { order: 2, action: 'Type', element: 'Password field', value: '{{password}}' },
    ]),
    assertions: 'User sees {{expected}}',
    declaredAssertions: JSON.stringify([{ type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' } }]),
  };
  const row0 = rowsB[0];
  const subbed = tdm.substituteCase(tcTemplate, row0);
  const subSteps = JSON.parse(subbed.steps);
  assert(subSteps[0].value === 'Admin' && subSteps[1].value === 'admin123', 'substituteCase fills {{tokens}} in step values');
  assert(/User sees Dashboard/.test(subbed.assertions), 'substituteCase fills {{expected}} in the assertions prose');
  assert(JSON.parse(subbed.declaredAssertions)[0].payload.expectedText === 'Dashboard', 'substituteCase fills {{expected}} INSIDE the declaredAssertions payload');
  assert(/DATA-DRIVEN ITERATION/.test(subbed.assertions) && /username = "Admin"/.test(subbed.assertions), 'substituteCase appends a DATA ROW guidance block with the concrete inputs');
  assert(JSON.parse(tcTemplate.steps)[0].value === '{{username}}' && tcTemplate.assertions === 'User sees {{expected}}', 'substituteCase does NOT mutate the original case (pure clone)');
  const uTok = tdm.substituteCase({ id: 'x', steps: JSON.stringify([{ order: 1, action: 'Type', value: '{{nope}}' }]), assertions: '', declaredAssertions: '[]' }, row0);
  assert(JSON.parse(uTok.steps)[0].value === '{{nope}}', 'unknown {{token}} left verbatim (never blanked out)');

  console.log('\n[5b] testDataRuntimeLock — runtime values cannot drift from the selected row');
  const runtimeLock = require('../server/services/testDataRuntimeLock');
  const lockedType = runtimeLock.lockToolInputToDataRow({
    toolName: 'browser_type',
    args: { element: 'Username textbox', text: 'Alice' },
    declaredStep: { value: 'Admin', element: 'Username textbox' },
    dataRow: { fields: { username: 'Admin', password: 'admin123' } },
  });
  assert(lockedType.changed === false && lockedType.args.text === 'Alice' && lockedType.reason === 'not_data_bound', 'browser_type preserves a literal that has no explicit token/field binding');
  const lockedForm = runtimeLock.lockToolInputToDataRow({
    toolName: 'browser_fill_form',
    args: { fields: [{ name: 'Username', value: 'Wrong' }, { name: 'Password', value: 'Wrong2' }] },
    dataRow: { fields: { username: 'Admin', password: 'admin123' } },
  });
  assert(lockedForm.changed === false && lockedForm.args.fields[0].value === 'Wrong' && lockedForm.args.fields[1].value === 'Wrong2', 'browser_fill_form preserves literal fields instead of guessing roles from their labels');
  const lockedInputsShape = runtimeLock.lockToolInputToDataRow({
    toolName: 'browser_type',
    args: { element: 'Username textbox', text: 'Alice' },
    declaredStep: { value: '{{username}}', element: 'Username textbox' },
    dataRow: { inputs: { username: 'Admin', password: 'admin123' } },
  });
  assert(lockedInputsShape.changed === true && lockedInputsShape.args.text === 'Admin', 'runtime lock accepts execution data rows shaped as inputs:{role:value}');

  console.log('\n[6] Conductor — per-row fan-out wiring');
  const cond = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agents', 'conductor.js'), 'utf8');
  assert(/require\('\.\.\/testDataMatrix'\)/.test(cond) && /loadTestDataContext\(projectId, sprintId\)/.test(cond), 'conductor loads testData + requires testDataMatrix at run start');
  assert(/testDataRuntimeLock/.test(cond) && /lockToolInputToDataRow/.test(cond), 'conductor invokes the runtime data-value lock before MCP dispatch');
  assert(/resolveCaseRows\(runtimeBaseTc, scenario, runTestData/.test(cond), 'conductor validates/materializes the runtime case before resolving its exact rows');
  assert(/substituteCase\(runtimeBaseTc, row\)/.test(cond), 'conductor substitutes the row into the validated per-row case clone');
  assert(/isJourneyMember\s*\|\|\s*\(row && ei > 0\)/.test(cond), 'codegen deferred for journey members AND non-first data rows (no spec clobber)');
  assert(/dataRow:\s*row \?/.test(cond), 'conductor threads a per-row tag into runOneCase');
  assert((cond.match(/preAuthState, dataRow,/g) || []).length >= 2, 'dataRow threaded into BOTH persistResultAndCodegen call sites');
  assert((cond.match(/dataRowIndex: dataRow \? dataRow\.index : null/g) || []).length >= 2, 'dataRowIndex written to BOTH the RunResult create and the live WS result event');
  assert(/dataRowLabel: dataRow \? dataRow\.label/.test(cond) && /dataSetName: dataRow \? dataRow\.setName/.test(cond), 'rich RunResult create writes dataRowLabel + dataSetName');

  console.log('\n[7] Schema + migration (additive — preserves trial data)');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  assert(/dataBindingJson\s+String\?/.test(schema), 'TestCase.dataBindingJson column added (nullable)');
  assert(/dataRowIndex\s+Int\?/.test(schema) && /dataRowLabel\s+String\?/.test(schema) && /dataSetName\s+String\?/.test(schema), 'RunResult.dataRow* columns added (nullable)');
  const migPath = path.join(__dirname, '..', 'prisma', 'migrations', '20260608000000_add_data_driven_round_b', 'migration.sql');
  const migSql = fs.existsSync(migPath) ? fs.readFileSync(migPath, 'utf8') : '';
  assert(/ADD COLUMN "dataBindingJson"/.test(migSql) && /ADD COLUMN "dataRowIndex"/.test(migSql), 'migration adds the columns (additive ALTER TABLE)');

  console.log('\n[7b] replayExport — data matrix export coverage');
  const replayExport = require('../server/services/codegen/replayExport');
  const coverageSets = [{
    id: 'td1',
    name: 'Auth data',
    sheetsJson: JSON.stringify({ sheets: tdSheets }),
  }];
  const oneRowCoverage = replayExport.buildDataMatrixCoverageReport({
    testDataSets: coverageSets,
    results: [{ runResultId: 'rr1', testCaseId: 'tc-login', caseName: 'Login matrix', dataRowIndex: 0, dataBinding: { sheet: 'Login', rowSelector: 'all', rowClassColumn: 'Type' } }],
  });
  assert(oneRowCoverage.ok === false && oneRowCoverage.findings.some((f) => f.rule === 'data_matrix_export_incomplete'), 'export coverage flags data-bound cases missing row iterations');
  const allRowsCoverage = replayExport.buildDataMatrixCoverageReport({
    testDataSets: coverageSets,
    results: [0, 1, 2].map((i) => ({ runResultId: `rr${i}`, testCaseId: 'tc-login', caseName: 'Login matrix', dataRowIndex: i, dataBinding: { sheet: 'Login', rowSelector: 'all', rowClassColumn: 'Type' } })),
  });
  assert(allRowsCoverage.ok === true && allRowsCoverage.cases[0].exportedRows === 3, 'export coverage passes when every selected row has a result');
  const directSheetCoverage = replayExport.buildDataMatrixCoverageReport({
    testDataSets: [{ id: 'td-direct', name: 'Auth data', sheets: tdSheets }],
    results: [{ runResultId: 'rr-direct', testCaseId: 'tc-login', caseName: 'Login matrix', dataRowIndex: 0, dataBinding: { sheet: 'Login', rowSelector: 'all', rowClassColumn: 'Type' } }],
  });
  assert(directSheetCoverage.ok === false && directSheetCoverage.cases[0].expectedRows === 3, 'export coverage also reads in-memory testDataSets[].sheets');
  const replayExportSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'codegen', 'replayExport.js'), 'utf8');
  assert(/data-matrix-coverage\.json/.test(replayExportSrc) && /buildDataMatrixCoverageReport/.test(replayExportSrc), 'replayExport writes evidence/data-matrix-coverage.json during package assembly');

  console.log('\n[8] Architect — data-driven emission + persistence');
  const arch = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'agents', 'architect.js'), 'utf8');
  assert(/businessRisk,\s*dataBinding\b/.test(arch), 'normaliseCase returns dataBinding');
  assert(/\{\{username\}\}/.test(arch) && /Attach a "dataBinding" object/.test(arch), 'buildTestDataBlock guidance teaches {{placeholders}} + a dataBinding');
  assert(/Never paste the row values as literals/.test(arch) || /Do NOT paste cell values as literals/.test(arch), 'buildTestDataBlock guidance forbids hardcoded uploaded row values');
  // P1 centralized all case persistence into the canonical writer, so
  // dataBindingJson is now written there (not inline in the routes). The routes
  // feed c.dataBinding through persistCases.
  const tccSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'testCaseContract.js'), 'utf8');
  assert(/dataBindingJson: dataBindingForCase \? enc\(dataBindingForCase\) : null/.test(tccSrc), 'canonical writer (testCaseContract) persists dataBindingJson (P4a: the approved-mapping-pinned binding)');
  assert(/persistCases\(/.test(scn) && /persistCases\(/.test(agt), 'both routes persist via the canonical writer, so dataBinding flows through P1');

  console.log('\n[8b] testDataAuthoring — hardcoded uploaded row values are blocked');
  const tdauth = require('../server/services/testDataAuthoring');
  const leakScenarios = [{
    name: 'Product search',
    module: 'Products',
    cases: [{
      id: 'TC-LEAK',
      name: 'Search for Printed products',
      steps: JSON.stringify([{ action: 'fill', target: 'Search Product textbox', value: 'Printed' }]),
      assertions: 'Results show Printed products visible',
      declaredAssertions: JSON.stringify([{ type: 'TEXT', payload: { expectedText: 'Printed products visible' } }]),
    }],
  }];
  const leakData = {
    sheets: [{
      name: 'SearchData',
      headers: ['Search Name', 'Expected Result'],
      rows: [{ 'Search Name': 'Printed', 'Expected Result': 'Printed products visible' }],
    }],
    mapping: {
      version: 1,
      bindings: [{
        sheet: 'SearchData',
        scenarioName: 'Product search',
        module: 'Products',
        columnToField: { searchName: 'Search Name' },
        expectedColumn: 'Expected Result',
        confidence: 'high',
      }],
      unmapped: [],
    },
  };
  const leakStats = tdauth.markDataAwareCases(leakScenarios, leakData, { moduleScope: 'Products' });
  const leakBinding = leakScenarios[0].cases[0].dataBinding || {};
  const repairedSteps = JSON.parse(leakScenarios[0].cases[0].steps);
  const repairedAssertions = JSON.parse(leakScenarios[0].cases[0].declaredAssertions);
  assert(leakStats.incomplete === 1 && leakBinding.needsReview === true && leakBinding.sheet == null, 'literal row overlap without lineage is left unbound for review');
  assert(repairedSteps[0].value === 'Printed' && repairedAssertions[0].payload.expectedText === 'Printed products visible', 'post-hoc authoring does not rewrite literals into inferred data tokens');
  assert((leakBinding.findings || []).some((f) => f.code === 'data_literal_without_binding'), 'unproven literal overlap is recorded as a review finding instead of an inferred binding');
  const contractForLeak = require('../server/services/testCaseContract');
  const incompleteContract = contractForLeak.assertContractComplete({
    automatability: 'automatable',
    declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'BRD' }],
    dataBinding: { ...leakBinding, status: 'incomplete' },
  });
  assert(incompleteContract.violations.includes('data_binding_incomplete'), 'incomplete dataBinding blocks canonical case contract');

  // ─── P4a — TestData APPROVAL gate (Enterprise Mode Stage 2) ────────────────
  console.log('\n[9] testDataApproval.verifyMapping — exists (error) / typed (warn) / unclear (warn)');
  const tda = require('../server/services/testDataApproval');
  const vSheets = [{
    name: 'Login',
    headers: ['Username', 'Password', 'Email Address', 'Expected Result'],
    rows: [
      { Username: 'Admin', Password: 'admin123', 'Email Address': 'a@b.com', 'Expected Result': 'Dashboard' },
      { Username: 'x', Password: 'y', 'Email Address': 'not-an-email', 'Expected Result': 'Required' },
    ],
  }];
  const vClean = tda.verifyMapping({ mapping: { bindings: [{ sheet: 'Login', columnToField: { username: 'Username', password: 'Password' }, expectedColumn: 'Expected Result', confidence: 'high' }], unmapped: [] }, sheets: vSheets });
  assert(vClean.ok === true && vClean.findings.length === 0, 'clean mapping (all columns exist) → ok, no findings');
  const vBad = tda.verifyMapping({ mapping: { bindings: [{ sheet: 'Login', columnToField: { username: 'Uzername' }, confidence: 'high' }], unmapped: [] }, sheets: vSheets });
  assert(vBad.ok === false && vBad.findings.some((f) => f.code === 'column_not_in_sheet' && f.severity === 'error'), 'a bound column not in the sheet → column_not_in_sheet ERROR (blocks approval)');
  assert((vBad.findings.find((f) => f.code === 'column_not_in_sheet') || {}).header === 'Uzername', 'finding preserves the ORIGINAL header text (not normalized)');
  const vTypeSheets = [{ name: 'Amounts', headers: ['Price'], rows: [{ Price: 'free' }, { Price: 'N/A' }, { Price: '9.99' }] }];
  const vType = tda.verifyMapping({ mapping: { bindings: [{ sheet: 'Amounts', columnToField: { amount: 'Price' }, confidence: 'high' }], unmapped: [] }, sheets: vTypeSheets });
  assert(vType.ok === true && vType.findings.some((f) => f.code === 'column_type_mismatch' && f.severity === 'warning'), 'a type-mismatched column (2/3 non-numeric "amount") → warning, NOT blocking (ok stays true)');
  const vUnclear = tda.verifyMapping({ mapping: { bindings: [{ sheet: 'Login', columnToField: { username: 'Username' }, confidence: 'high' }], unmapped: [{ sheet: 'Login', header: 'Mystery' }] }, sheets: vSheets });
  assert(vUnclear.findings.some((f) => f.code === 'mapping_unclear'), 'an unmapped column → mapping_unclear warning (human-approval signal)');
  const vCase = tda.verifyMapping({ mapping: { bindings: [{ sheet: 'Login', columnToField: { username: '  username ' }, confidence: 'high' }], unmapped: [] }, sheets: vSheets });
  assert(vCase.ok === true, 'header match normalizes trim+case ("  username " resolves to "Username")');

  console.log('\n[10] testDataApproval.resolvePlaceholders — tokens resolve against the APPROVED mapping');
  const apprMap = { bindings: [{ sheet: 'Login', columnToField: { username: 'Username', password: 'Password' }, expectedColumn: 'Expected Result' }] };
  const caseGood = { id: 'g', steps: JSON.stringify([{ order: 1, action: 'Type', value: '{{username}}' }, { order: 2, action: 'Type', value: '{{password}}' }]), assertions: 'see {{expected}}', declaredAssertions: '[]' };
  const rGood = tda.resolvePlaceholders({ cases: [caseGood], approvedMapping: apprMap });
  assert(rGood.ok === true && rGood.unresolved.length === 0, 'username/password/expected all resolve against the approved mapping');
  const caseBad = { id: 'b', steps: JSON.stringify([{ order: 1, action: 'Type', value: '{{ssn}}' }]), assertions: '', declaredAssertions: '[]' };
  const rBad = tda.resolvePlaceholders({ cases: [caseBad], approvedMapping: apprMap });
  assert(rBad.ok === false && rBad.unresolved.some((u) => u.token === 'ssn'), 'an unmapped token ({{ssn}}) → unresolved');
  assert(tda.placeholdersInCase(caseGood).sort().join(',') === 'expected,password,username', 'placeholdersInCase extracts every {{token}} from steps + assertions');
  const caseOps = { id: 'o', steps: '[]', assertions: '', declaredAssertions: '[]', operationsJson: JSON.stringify({ status: 'complete', operations: [{ operation: 'fillField', params: { field: 'username', value: '{{username}}' } }] }) };
  assert(tda.placeholdersInCase(caseOps).includes('username'), 'placeholdersInCase scans operationsJson params too');
  assert(tda.mappingRoles(apprMap).includes('username') && tda.mappingRoles(apprMap).includes('expected'), 'mappingRoles lists column roles + the expected token');

  console.log('\n[11] assertContractComplete — requireApprovedMapping (inert until P9)');
  const tccGate = require('../server/services/testCaseContract');
  const baseView = { automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'BRD' }] };
  const inert = tccGate.assertContractComplete({ ...baseView, requireApprovedMapping: false, dataPlaceholders: ['ssn'], approvedDataRoles: [] });
  assert(!inert.violations.includes('placeholder_unresolved'), 'requireApprovedMapping:false → no placeholder violation (INERT — current generations unaffected)');
  const active = tccGate.assertContractComplete({ ...baseView, requireApprovedMapping: true, dataPlaceholders: ['ssn'], approvedDataRoles: ['username', 'password'] });
  assert(active.violations.includes('placeholder_unresolved'), 'requireApprovedMapping:true + unmapped token → placeholder_unresolved violation');
  const ok11 = tccGate.assertContractComplete({ ...baseView, requireApprovedMapping: true, dataPlaceholders: ['username'], approvedDataRoles: ['username', 'password'] });
  assert(!ok11.violations.includes('placeholder_unresolved'), 'requireApprovedMapping:true + resolved token → no placeholder violation');

  console.log('\n[12] Schema + migration — TestDataMapping (additive, immutable ledger)');
  let createCalled = false;
  let strictBlocked = false;
  try {
    await tccGate.persistCases({
      prisma: { testCase: { create: async () => { createCalled = true; return { id: 'should-not-save' }; } } },
      projectId: 'p',
      scenarioId: 's',
      moduleName: 'Auth',
      enterpriseMode: true,
      requireApprovedMapping: true,
      approvedTestData: { mapping: apprMap },
      cases: [{
        name: 'Bad data case',
        steps: JSON.stringify([{ action: 'Type', value: '{{ssn}}' }]),
        declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'BRD', payload: { expectedText: 'x' } }],
        dataBinding: { sheet: 'Login', status: 'incomplete' },
      }],
      log: { warn: () => {} },
    });
  } catch (err) {
    strictBlocked = err && err.code === 'TEST_DATA_CONTRACT_INCOMPLETE';
  }
  assert(strictBlocked && !createCalled, 'persistCases hard-blocks incomplete data contracts before creating a TestCase');

  const schemaP4 = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  assert(/model TestDataMapping \{/.test(schemaP4), 'schema defines model TestDataMapping');
  assert(/@@unique\(\[testDataSetId, version\]\)/.test(schemaP4), 'TestDataMapping has @@unique([testDataSetId, version]) (race-safe versioning)');
  assert(/approvalNote\s+String\?/.test(schemaP4) && /verificationJson\s+String\?/.test(schemaP4), 'TestDataMapping carries approvalNote + verificationJson');
  assert(/IMMUTABLE/.test(schemaP4), 'the model documents the immutability invariant');
  const p4mig = path.join(__dirname, '..', 'prisma', 'migrations', '20260612000000_add_testdata_mapping', 'migration.sql');
  const p4sql = fs.existsSync(p4mig) ? fs.readFileSync(p4mig, 'utf8') : '';
  assert(/CREATE TABLE "TestDataMapping"/.test(p4sql), 'migration creates the TestDataMapping table');
  assert(/CREATE UNIQUE INDEX "TestDataMapping_testDataSetId_version_key"/.test(p4sql), 'migration creates the unique (testDataSetId, version) index');

  console.log('\n[13] Route + context wiring (transactional approve, provenance pin, org-scope)');
  const td = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'testData.js'), 'utf8');
  assert(/\/:tdId\/approve/.test(td) && /\/:tdId\/reject/.test(td) && /\/:tdId\/mappings/.test(td), 'testData.js exposes approve / reject / mappings routes');
  assert(/prisma\.\$transaction/.test(td) && /P2002/.test(td), 'approve is transactional + retries the version race (P2002)');
  assert(/APPROVAL_NOTE_REQUIRED/.test(td), 'a warning finding requires an approvalNote (else 422)');
  assert(/MAPPING_VERIFICATION_FAILED/.test(td), 'an exists-error blocks approval (422)');
  assert(/approvedMapping:/.test(td) && /mappingState:/.test(td), 'serializeTestDataSet surfaces approvedMapping + mappingState');
  assert((td.match(/getProject\(req\)/g) || []).length >= 5, 'new routes are project+org-scoped via getProject (never raw projectId)');
  const ctx = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'testDataContext.js'), 'utf8');
  assert(/approvedOnly/.test(ctx) && /loadApprovedMappingById/.test(ctx), 'testDataContext supports approvedOnly + the pinned-mapping resolver');
  const tccSrc2 = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'testCaseContract.js'), 'utf8');
  assert(/mappingId: src\.mappingId/.test(tccSrc2), 'persistCases pins dataBindingJson to the approved mappingId (A1 provenance)');

  console.log('\n[14] TestCases UI - data-binding transparency');
  const testCasesUi = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'TestCases.jsx'), 'utf8');
  assert(/parseCaseDataBinding/.test(testCasesUi) && /dataBindingBadge/.test(testCasesUi), 'TestCases UI parses dataBindingJson and builds a binding badge');
  assert(/Data incomplete:/.test(testCasesUi) && /Data:/.test(testCasesUi), 'TestCases UI distinguishes complete vs incomplete data binding');
  assert(/bindingBadge\.label/.test(testCasesUi), 'CaseRow renders the data-binding badge in the case chip rail');

  console.log(`\n${failures === 0 ? 'PASS — all TestData checks green' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.stack || e); process.exit(1); });
