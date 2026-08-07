'use strict';
/*
 * Guard for the Locator Promotion Engine (Bulletproof Synthesizer) — upgraded.
 * Covers: role normalization (never getByRole('input')), safe CSS/attr escaping,
 * dynamic-id rejection, text-exact + ancestor-hasText forging, icon-only ancestor
 * structural child, frame wrapping, NO-eval structured factory, and the proof
 * contract / ProvenLocatorPassport. GENERATION offline; PROOF live at B-2e.
 */
const E = require('../server/services/locatorPromotionEngine');
const { promoteLocators, buildPassport, proveCandidate, selectProvenPrimary, buildProvenPassport, needsPromotion, normalizeRole, cssEscape, isDynamicToken, classifyLocatorContext, scoreCandidate, isDataRecord, PASSPORT_FACTORY_SRC } = E;
const idx = (c, s) => c.findIndex((x) => x.strategy === s);

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const has = (c, s) => c.find((x) => x.strategy === s);

console.log('— role normalization (never getByRole(\'input\')) —');
{
  ok('input[text] -> textbox', normalizeRole('input', { type: 'text' }) === 'textbox');
  ok('input[password] -> textbox', normalizeRole('input', { type: 'password' }) === 'textbox');
  ok('input[checkbox] -> checkbox', normalizeRole('input', { type: 'checkbox' }) === 'checkbox');
  ok('a -> link', normalizeRole('a') === 'link');
  ok('select -> combobox', normalizeRole('select') === 'combobox');
  ok('unknown tag div -> null (no invalid role emitted)', normalizeRole('div') === null);
  const c = promoteLocators({ role: 'input', inputType: 'text', name: 'Username' });
  ok('promote uses textbox, never role "input"', has(c, 'role') && /getByRole\('textbox'/.test(has(c, 'role').expression) && !/getByRole\('input'/.test(JSON.stringify(c)), JSON.stringify(c.map((x) => x.expression)));
}

console.log('\n— safe CSS / attr escaping —');
{
  ok('cssEscape escapes : . space', /\\:/.test(cssEscape('a:b')) && /\\\./.test(cssEscape('a.b')));
  const c = promoteLocators({ idAttr: 'user:name.x' });
  ok('id with : and . is escaped in the selector', has(c, 'id') && /#user\\:name\\.x/.test(has(c, 'id').expression), JSON.stringify(has(c, 'id')));
}

console.log('\n— dynamic id/attr rejected —');
{
  ok('isDynamicToken ember123 true', isDynamicToken('ember1234') === true);
  ok('isDynamicToken :r3: true', isDynamicToken(':r3:') === true);
  ok('isDynamicToken stable "login" false', isDynamicToken('login') === false);
  ok('promote rejects a dynamic id (no silver id)', !has(promoteLocators({ idAttr: 'cdk-overlay-732' }), 'id'));
  ok('promote keeps a stable id', !!has(promoteLocators({ idAttr: 'login' }), 'id'));
}

console.log('\n— Gold semantic + ranking —');
{
  const c = promoteLocators({ role: 'button', name: 'Login', testId: 'loginBtn', idAttr: 'login' });
  ok('primary gold role+name', c[0].tier === 'gold' && c[0].strategy === 'role');
  ok('gold before silver', c.findIndex((x) => x.tier === 'gold') < c.findIndex((x) => x.tier === 'silver'));
  ok('every candidate has structured build steps', c.every((x) => Array.isArray(x.build) && x.build.length >= 1));
}

console.log('\n— ancestor role-chain (icon action with a named child) —');
{
  const c = promoteLocators({ role: 'button', name: 'Delete', ancestors: [{ role: 'row', name: 'John', testId: 'row-7' }] });
  const chain = has(c, 'ancestor_role_chain');
  ok('forged ancestor_role_chain', chain && /getByTestId\('row-7'\)\.getByRole\('button', \{ name: 'Delete' \}\)/.test(chain.expression), chain && chain.expression);
  ok('chain build has 2 structured steps', chain && chain.build.length === 2);
}

console.log('\n— icon-only (no name/text) -> ancestor structural child (silver) —');
{
  const c = promoteLocators({ role: 'button', name: '', ancestors: [{ role: 'row', name: 'John', testId: 'row-7' }], childTag: 'button.delete-icon' });
  const sc = has(c, 'ancestor_structural_child');
  ok('forged ancestor_structural_child', sc && /getByTestId\('row-7'\)\.locator\('button.delete-icon'\)/.test(sc.expression), JSON.stringify(c.map((x) => x.strategy)));
}

console.log('\n— text forging: exact visible + ancestor hasText —');
{
  const c = promoteLocators({ role: 'link', text: 'View report', textUnique: true, ancestors: [{ role: 'row', name: 'R', testId: 'r1' }] });
  const tx = has(c, 'text_exact');
  ok('text_exact uses getByText(..,{exact:true}).filter({visible:true})', tx && /getByText\('View report', \{ exact: true \}\)\.filter\(\{ visible: true \}\)/.test(tx.expression), tx && tx.expression);
  ok('no invalid visible=true syntax', !/visible=true/.test(JSON.stringify(c)));
  ok('ancestor_hasText_role forged', !!has(c, 'ancestor_hasText_role'));
  ok('non-unique text -> no text candidates', !has(promoteLocators({ role: 'link', text: 'Edit', textUnique: false }), 'text_exact'));
}

console.log('\n— label-region anchored (role-less custom control; label derived by subtraction) —');
{
  // role-less div dropdown, ancestor text = label + control text.
  const c = promoteLocators({ role: 'div', name: '-- Select --', ancestors: [{ role: 'group', name: 'User Role-- Select --' }] });
  const lrAll = c.filter((x) => x.strategy === 'label_region');
  ok('forged label_region for role-less control', lrAll.length >= 1, JSON.stringify(c.map((x) => x.strategy)));
  ok('forged MULTIPLE anchor variants (proof picks count===1)', lrAll.length === 3, String(lrAll.length));
  ok('all variants derive label "User Role" by subtracting control text', lrAll.every((x) => /getByText\('User Role', \{ exact: true \}\)/.test(x.expression)), JSON.stringify(lrAll.map((x) => x.expression)));
  ok('includes the sibling parent (..) relationship', lrAll.some((x) => /\.locator\('\.\.'\)\.locator\('\[tabindex\]/.test(x.expression)), JSON.stringify(lrAll.map((x) => x.expression)));
  ok('includes ancestor-with-interactive + following-focusable variants', lrAll.some((x) => /ancestor::/.test(x.expression)) && lrAll.some((x) => /following::/.test(x.expression)));
  // a control WITH a gold role does not need label_region
  ok('gold role control does NOT add label_region', !has(promoteLocators({ role: 'button', name: 'Save' }), 'label_region'));
}

console.log('\n— record/row action anchoring (table / grid / list / card) —');
{
  // NAMED action child inside a role=row record → Gold, scoped by unique row text.
  const named = promoteLocators({ role: 'button', name: 'Edit', record: { rowText: 'Ada Lovelace ada@x.io Admin', recordSelector: '[role="row"]', containerRole: 'row' } });
  const ra = has(named, 'record_action');
  ok('forged record_action (named) as gold', ra && ra.tier === 'gold', JSON.stringify(named.map((x) => x.strategy)));
  ok('record_action scopes by UNIQUE row text via filter(hasText)', ra && /getByRole\('row'\)\.filter\(\{ hasText: 'Ada Lovelace ada@x.io Admin' \}\)\.getByRole\('button', \{ name: 'Edit' \}\)/.test(ra.expression), ra && ra.expression);
  ok('record_action build is 3 structured steps (no eval)', ra && ra.build.length === 3 && ra.build[1][0] === 'filter');
  ok('record_action NEVER uses .first() as the answer', !/\.first\(/.test(JSON.stringify(named)));

  // ICON-ONLY nameless action → Silver via the stable in-record action selector.
  const icon = promoteLocators({ role: 'button', name: '', actionSelector: 'button:has(.bi-trash)', record: { rowText: 'Ada Lovelace ada@x.io Admin', recordSelector: 'div.oxd-table-row' } });
  const ri = has(icon, 'record_action');
  ok('icon-only record_action via actionSelector (silver)', ri && ri.tier === 'silver' && /div\.oxd-table-row.*filter.*hasText.*\.locator\('button:has\(\.bi-trash\)'\)/.test(ri.expression), ri && ri.expression);
  ok('div-grid record base is the derived structural selector, NOT blind div/li/tr', ri && /locator\('div\.oxd-table-row'\)/.test(ri.expression) && !/locator\('div, li, tr'\)/.test(ri.expression));

  // testId record container preferred when present.
  const byTid = promoteLocators({ role: 'button', name: 'Delete', record: { rowText: 'row 7', containerTestId: 'user-row-7' } });
  ok('record container prefers testId base', has(byTid, 'record_action') && /getByTestId\('user-row-7'\)\.filter/.test(has(byTid, 'record_action').expression));

  // NO clean record selector → no blind record_action emitted (fail-closed).
  const blind = promoteLocators({ role: 'button', name: 'Edit', record: { rowText: 'x', recordSelector: null, containerRole: null, containerTestId: null } });
  ok('no record selector -> NO record_action (never blind base)', !has(blind, 'record_action'));
}

console.log('\n— CONTEXT-AWARE strategy ranking (Scorecard) —');
{
  // (1) role-less dropdown near a label, sitting inside a repeated FORM grid →
  //     must choose label_region BEFORE record_action (record_action is a fallback).
  const dd = promoteLocators({
    role: 'div', name: '-- Select --', actionSelector: 'div.oxd-select-text-input',
    ancestors: [{ role: 'group', name: 'User Role-- Select --' }],
    record: { rowText: 'User Role-- Select --', recordSelector: 'div.oxd-grid-item', containerRole: null, siblingCount: 6, cellTexts: ['User Role', '-- Select --'] },
  });
  ok('dropdown context = form_control', classifyLocatorContext({ role: 'div', name: '-- Select --', ancestors: [{ role: 'group', name: 'User Role-- Select --' }] }) === 'form_control');
  ok('dropdown PRIMARY is label_region (NOT record_action)', dd[0] && dd[0].strategy === 'label_region', dd[0] && dd[0].strategy + ' score=' + (dd[0] && dd[0].score));
  ok('label_region ranks ABOVE record_action for a form control', idx(dd, 'label_region') !== -1 && idx(dd, 'record_action') !== -1 && idx(dd, 'label_region') < idx(dd, 'record_action'), JSON.stringify(dd.map((x) => x.strategy)));

  // (2) nameless row icon inside a real data record → must choose record_action.
  const rowIcon = promoteLocators({
    role: 'button', name: '', actionSelector: 'button:has(.bi-trash)',
    ancestors: [{ role: 'row', name: 'Ada admin' }],
    record: { rowText: 'Ada admin@x.io Admin Enabled', recordSelector: '[role="row"]', containerRole: 'row', containerTag: 'div', siblingCount: 20, cellTexts: ['Ada', 'admin@x.io', 'Admin', 'Enabled'] },
  });
  ok('row-icon context = record_action', classifyLocatorContext({ role: 'button', name: '', record: { containerRole: 'row', recordSelector: '[role="row"]' } }) === 'record_action');
  ok('row-icon PRIMARY is record_action', rowIcon[0] && rowIcon[0].strategy === 'record_action', rowIcon[0] && rowIcon[0].strategy + ' score=' + (rowIcon[0] && rowIcon[0].score));

  // (3) a form field group is NOT a data record (1 control + label, 2 cells).
  ok('form-field grid-item is NOT a data record', isDataRecord({ recordSelector: 'div.oxd-grid-item', siblingCount: 6, cellTexts: ['User Role', '-- Select --'] }) === false);
  ok('role=row container IS a data record', isDataRecord({ containerRole: 'row', recordSelector: '[role="row"]' }) === true);

  // (4) CSS-class-derived selector must NOT outrank a clean semantic locator.
  const labelRegionCand = { tier: 'silver', strategy: 'label_region', build: [['getByText', 'X', { exact: true }], ['locator', 'xpath=ancestor::*[1]']], expression: '' };
  const cssRecordCand = { tier: 'silver', strategy: 'record_action', build: [['locator', 'div.oxd-grid-item'], ['filter', { hasText: 'X' }], ['locator', 'div.oxd-select-text-input']], expression: '' };
  const sLR = scoreCandidate(labelRegionCand, { context: 'form_control' }).score;
  const sCSS = scoreCandidate(cssRecordCand, { context: 'form_control' }).score;
  ok('form_control: label_region scores ABOVE css-derived record_action', sLR > sCSS, `label_region=${sLR} css_record=${sCSS}`);

  // (5) dialog control prefers a dialog-scoped role.
  const inModal = promoteLocators({ role: 'button', name: 'Save', ancestors: [{ role: 'dialog', name: 'Edit User Save Cancel' }] });
  ok('modal context = dialog_control', classifyLocatorContext({ role: 'button', name: 'Save', ancestors: [{ role: 'dialog', name: 'x' }] }) === 'dialog_control');
  ok('modal PRIMARY is dialog_scoped_role', inModal[0] && inModal[0].strategy === 'dialog_scoped_role', inModal[0] && inModal[0].strategy);

  // (6) proof folds into the score: an unobscured proven candidate beats an obscured one.
  const base = { tier: 'gold', strategy: 'role', build: [['getByRole', 'button', { name: 'X' }]], expression: '' };
  const clean = scoreCandidate(base, { context: 'generic', proof: { proven: true, actionable: true, obscured: false, survivesRerender: true } }).score;
  const covered = scoreCandidate(base, { context: 'generic', proof: { proven: true, actionable: true, obscured: true, survivesRerender: true } }).score;
  ok('unobscured proof scores above obscured', clean > covered, `clean=${clean} covered=${covered}`);
}

console.log('\n— obscured-target rejection (overlay/modal/spinner over the action point) —');
{
  const cn = { tier: 'gold', strategy: 'record_action', build: [['getByRole', 'row']], expression: "getByRole('row')" };
  ok('unique+actionable but OBSCURED -> not proven', proveCandidate(cn, { count: 1, sameTarget: true, actionable: true, obscured: true }).proven === false);
  ok('reason names obscured', /obscured=true/.test(proveCandidate(cn, { count: 1, sameTarget: true, actionable: true, obscured: true }).reason));
  ok('unobscured -> proven', proveCandidate(cn, { count: 1, sameTarget: true, actionable: true, obscured: false }).proven === true);
}

console.log('\n— frame wrapping wraps build + expression —');
{
  const c = promoteLocators({ role: 'button', name: 'Save', frame: 'iframe[name="app"]' });
  ok('expression wrapped in frameLocator', /^frameLocator\('iframe\[name="app"\]'\)\./.test(c[0].expression));
  ok('build starts with frameLocator step', c[0].build[0][0] === 'frameLocator' && c[0].build[0][1] === 'iframe[name="app"]');
}

console.log('\n— passport + bronzeOnly —');
{
  const p = buildPassport({ role: 'button', name: 'Login', idAttr: 'login' });
  ok('CandidateLocatorPassport primary gold + alternates', p.kind === 'CandidateLocatorPassport' && p.primary.tier === 'gold' && p.alternates.length >= 1);
  ok('nothing forgeable -> bronzeOnly', buildPassport({ bbox: { x: 1, y: 1, w: 1, h: 1 } }).bronzeOnly === true);
}

console.log('\n— PROOF contract + ProvenLocatorPassport —');
{
  const cn = { tier: 'gold', strategy: 'role', build: [['getByRole', 'button', { name: 'X' }]], expression: "getByRole('button',{name:'X'})" };
  ok('proven: unique+sameTarget+actionable', proveCandidate(cn, { count: 1, sameTarget: true, actionable: true }).proven === true);
  ok('not proven: ambiguous count', proveCandidate(cn, { count: 2, sameTarget: true, actionable: true }).proven === false);
  ok('not proven: re-render fails', proveCandidate(cn, { count: 1, sameTarget: true, actionable: true, survivesRerender: false }).proven === false);
  return (async () => {
    const cp = buildPassport({ role: 'button', name: 'Login', idAttr: 'login' });
    const provenPP = await buildProvenPassport(cp, async (c) => ({ count: c.tier === 'gold' ? 1 : 2, sameTarget: true, actionable: true }));
    ok('ProvenLocatorPassport proves the gold primary', provenPP.kind === 'ProvenLocatorPassport' && provenPP.proven === true && provenPP.primary.tier === 'gold', JSON.stringify(provenPP.primary && provenPP.primary.strategy));
    const noneProven = await buildProvenPassport(cp, async () => ({ count: 3, sameTarget: true, actionable: true }));
    ok('no candidate proves -> repairRequired (never export)', noneProven.proven === false && noneProven.repairRequired === true);

    console.log('\n— codegen factory: NO eval, structured build, count()===1 —');
    ok('factory has qaaiBuildLocator', /function qaaiBuildLocator/.test(PASSPORT_FACTORY_SRC));
    ok('factory does NOT use eval', !/eval\(/.test(PASSPORT_FACTORY_SRC));
    ok('factory confirms count()===1', /count\(\)\s*===\s*1/.test(PASSPORT_FACTORY_SRC));
    ok('factory has no blind .or(', !/\.or\(/.test(PASSPORT_FACTORY_SRC));

    console.log('\n— Bronze-never-rests —');
    ok('bronze-only evidence -> needsPromotion', needsPromotion({ gold: [], silver: [], bronze: [{ strategy: 'bounding_box' }] }) === true);
    ok('has gold -> no promotion', needsPromotion({ gold: [{ strategy: 'role' }], silver: [] }) === false);

    console.log('');
    if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
    console.log('OK — Locator Promotion Engine (upgraded) verified; PROOF live at B-2e');
  })();
}
