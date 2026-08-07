'use strict';
/*
 * STEP 3A — canonical WorkbookContract. Locks the deterministic data-oracle parse
 * that replaces the lossy heuristic mappers: no MAX_SHEETS truncation, structural
 * sheet purpose (auth_profiles requires REAL credential columns; profileKey and a
 * /auth/login URL are NOT auth), row-intent detection, multiple expected columns
 * by oracle type, storyId extraction, and findings instead of silent guesses.
 * Pure + generic — header word-shape only, never a site/sheet-name string.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'server', 'services', 'workbookContract'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const sheetByName = (c, n) => c.sheets.find((s) => s.name === n);

console.log('— no MAX_SHEETS truncation: every sheet survives —');
{
  const sheets = Array.from({ length: 21 }, (_, i) => ({ name: `Sheet${i + 1}`, headers: ['field'], rows: [{ field: 'x' }] }));
  const c = W.buildWorkbookContract({ sheets });
  ok('21 sheets in → 21 sheet manifests out (no truncation)', c.sheetCount === 21 && c.sheets.length === 21, `got ${c.sheetCount}`);
}

console.log('\n— structural sheet purpose (auth requires REAL credential columns) —');
{
  const authC = W.buildWorkbookContract({ sheets: [{ name: 'AuthProfiles', headers: ['storyId', 'username', 'password', 'expectedLandingPage'], rows: [{ storyId: 'US-1', username: 'admin', password: 'p', expectedLandingPage: '/dashboard' }] }] });
  const auth = sheetByName(authC, 'AuthProfiles');
  ok('username + password → auth_profiles', auth.purpose === 'auth_profiles' && !!auth.credentialColumns);

  const profileKeyC = W.buildWorkbookContract({ sheets: [{ name: 'Maintenance_Access', headers: ['profileKey', 'module', 'action'], rows: [{ profileKey: 'admin', module: 'Maintenance', action: 'purge candidates' }] }] });
  const maint = sheetByName(profileKeyC, 'Maintenance_Access');
  ok('profileKey column does NOT mean auth_profiles', maint.purpose !== 'auth_profiles', maint.purpose);

  const urlC = W.buildWorkbookContract({ sheets: [{ name: 'Menu_Navigation', headers: ['menuItem', 'url', 'scenarioType'], rows: [{ menuItem: 'Login', url: '/web/index.php/auth/login', scenarioType: 'navigation' }] }] });
  const nav = sheetByName(urlC, 'Menu_Navigation');
  ok('a /auth/login URL value does NOT mean auth_profiles', nav.purpose !== 'auth_profiles', nav.purpose);
  ok('navigation-intent sheet → navigation purpose', nav.purpose === 'navigation', nav.purpose);

  const userOnlyC = W.buildWorkbookContract({ sheets: [{ name: 'Users', headers: ['username', 'email', 'department'], rows: [{ username: 'a', email: 'a@x.com', department: 'HR' }] }] });
  ok('username WITHOUT password → NOT auth_profiles (needs both credential columns)', sheetByName(userOnlyC, 'Users').purpose !== 'auth_profiles', sheetByName(userOnlyC, 'Users').purpose);

  const negC = W.buildWorkbookContract({ sheets: [{ name: 'NegativeAuth', headers: ['username', 'password', 'caseIntent', 'expectedValidationMessage'], rows: [{ username: 'admin', password: '', caseIntent: 'invalid — empty password', expectedValidationMessage: 'Required' }] }] });
  ok('credentials + negative intent/validation → negative_validation (not auth_profiles)', sheetByName(negC, 'NegativeAuth').purpose === 'negative_validation', sheetByName(negC, 'NegativeAuth').purpose);
}

console.log('\n— row intent / outcome class detection —');
for (const hdr of ['caseIntent', 'intent', 'outcomeClass', 'scenarioType', 'validity', 'polarity']) {
  const c = W.buildWorkbookContract({ sheets: [{ name: 'S', headers: [hdr, 'field'], rows: [{ [hdr]: 'negative - invalid', field: 'x' }] }] });
  const s = sheetByName(c, 'S');
  ok(`intent header "${hdr}" detected + value classified negative`, s.intentColumn === hdr && s.rows[0].intentClass === 'negative', `${s.intentColumn}/${s.rows[0].intentClass}`);
}

console.log('\n— multiple expected columns preserved (by oracle type) —');
{
  const c = W.buildWorkbookContract({ sheets: [{ name: 'Recruitment', headers: ['storyId', 'name', 'expectedVisibleSignal', 'expectedValidationMessage', 'expectedUrl'], rows: [{ storyId: 'US-9', name: 'Jo', expectedVisibleSignal: 'Success', expectedValidationMessage: 'err', expectedUrl: '/done' }] }] });
  const s = sheetByName(c, 'Recruitment');
  const types = s.expectedColumns.map((e) => e.oracleType).sort();
  ok('all three expected columns kept (not collapsed to one)', s.expectedColumns.length === 3, JSON.stringify(s.expectedColumns));
  ok('expected columns typed by oracle (validation + visibleSignal + url)', types.includes('validation') && types.includes('visibleSignal') && types.includes('url'), types.join(','));
  ok('row preserves every non-empty expected oracle', s.rows[0].expected.length === 3);
}

console.log('\n— storyId extraction (primary join) —');
{
  const c = W.buildWorkbookContract({ sheets: [{ name: 'S', headers: ['Story ID', 'username', 'password'], rows: [{ 'Story ID': 'US-42', username: 'a', password: 'b' }, { 'Story ID': '', username: 'c', password: 'd' }] }] });
  const s = sheetByName(c, 'S');
  ok('storyId column detected ("Story ID")', s.storyIdColumn === 'Story ID');
  ok('row storyId extracted', s.rows[0].storyId === 'US-42');
  ok('missing storyId is a FINDING, not a silent guess', c.findings.some((f) => f.code === 'rows_missing_story_id'));
}

console.log('\n— declares findings instead of silent guessing —');
{
  const c = W.buildWorkbookContract({ sheets: [{ name: 'Mystery', headers: ['colA', 'colB'], rows: [{ colA: '1', colB: '2' }] }] });
  ok('sheet with no expected oracle → finding (not a silent pass)', c.findings.some((f) => f.code === 'sheet_no_expected_oracle' || f.code === 'sheet_purpose_unknown'));
  ok('contract carries certification + confidence', typeof c.certification === 'string' && typeof c.confidence === 'number');
  ok('contract is reproducible: stamps schemaVersion + a fileHash', c.schemaVersion === W.SCHEMA_VERSION && typeof c.fileHash === 'string' && c.fileHash.length > 0);
}

console.log('\n— Step 3C: CoverageItems (the unit the Architect binds to) —');
{
  const c = W.buildWorkbookContract({ sheets: [
    { name: 'PIM_Lifecycle', headers: ['storyId', 'username', 'expectedVisibleSignal', 'expectedValidationMessage'], rows: [
      { storyId: 'US-OHRM-004', username: 'a', expectedVisibleSignal: 'Saved' },
      { storyId: 'US-OHRM-004', username: 'b', expectedVisibleSignal: 'Saved' },
      { storyId: 'US-OHRM-007', username: 'c', expectedValidationMessage: 'Required' },
    ] },
    { name: 'Ref', headers: ['code', 'label'], rows: [{ code: '1', label: 'x' }] },
  ] });
  const items = W.buildCoverageItems(c);
  const pim4 = items.find((i) => i.sheet === 'PIM_Lifecycle' && i.storyId === 'US-OHRM-004');
  const pim7 = items.find((i) => i.sheet === 'PIM_Lifecycle' && i.storyId === 'US-OHRM-007');
  ok('one CoverageItem per (sheet, storyId) group', !!pim4 && !!pim7 && items.filter((i) => i.sheet === 'PIM_Lifecycle').length === 2, JSON.stringify(items.map((i) => i.id)));
  ok('CoverageItem carries storyId + sheet + a stable id', pim4.storyId === 'US-OHRM-004' && pim4.sheet === 'PIM_Lifecycle' && /^CI:/.test(pim4.id));
  ok('rowSelector is story:<id> (binds only that story\'s rows)', pim4.rowSelector === 'story:US-OHRM-004' && pim4.rowCount === 2);
  ok('carries required placeholders + expected columns by oracle role', Array.isArray(pim4.requiredPlaceholders) && pim4.requiredPlaceholders.includes('username') && pim4.expectedColumns.length >= 1);
  ok('oracleRoles reflect the story\'s rows (US-007 → validation)', pim7.oracleRoles.includes('validation'));
}

console.log('\n— Step 3C: MAX_SHEETS=12 truncation removed from the Architect prompt path —');
{
  const arch = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'architect.js'), 'utf8');
  ok('architect.js no longer caps the workbook summary at 12 sheets', !/MAX_SHEETS = 12\b/.test(arch) && /MAX_SHEETS = \d{2,}/.test(arch));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — WorkbookContract is the canonical data-oracle: every sheet preserved, structural purpose (auth needs real credentials; profileKey/URL are not auth), row intent + storyId extracted, multiple expected columns kept by oracle type, and problems are declared as findings.');
