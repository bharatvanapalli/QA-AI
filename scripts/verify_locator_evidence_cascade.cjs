'use strict';
/*
 * Guard for B-2d.2c — Locator Evidence Cascade + export boundary.
 * Gold > Silver for export; Bronze (bbox/mark/coords/surrounding-text) is NEVER
 * exported and NEVER a coordinate fallback; bronze-only -> not export-ready.
 */
const { buildLocatorEvidence, selectExportLocator, isExportable, bronzeRepairHints } = require('../server/services/locatorEvidenceCascade');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— tiering —');
{
  const ev = buildLocatorEvidence({ role: 'button', name: 'Login', testId: 'loginBtn', idAttr: 'login', bbox: { x: 1, y: 2, w: 3, h: 4 }, surroundingText: 'Login form' });
  ok('gold has role+name and testId', ev.gold.length >= 2 && ev.gold.some((g) => g.strategy === 'role') && ev.gold.some((g) => g.strategy === 'testId'), JSON.stringify(ev.gold));
  ok('silver has id', ev.silver.some((s) => s.strategy === 'id'), JSON.stringify(ev.silver));
  ok('bronze has bbox + surrounding text', ev.bronze.some((b) => b.strategy === 'bounding_box') && ev.bronze.some((b) => b.strategy === 'surrounding_text'), JSON.stringify(ev.bronze));
  ok('tier gold', ev.tier === 'gold');
}

console.log('\n— export boundary: GOLD preferred —');
{
  const ev = buildLocatorEvidence({ role: 'button', name: 'Login', idAttr: 'login', bbox: { x: 0, y: 0, w: 1, h: 1 } });
  const exp = selectExportLocator(ev);
  ok('exports the gold role locator', exp && exp.tier === 'gold' && /getByRole/.test(exp.expression), JSON.stringify(exp));
}

console.log('\n— SILVER when no gold —');
{
  const ev = buildLocatorEvidence({ idAttr: 'username', bbox: { x: 0, y: 0, w: 1, h: 1 } });
  const exp = selectExportLocator(ev);
  ok('exports silver #id', exp && exp.tier === 'silver' && /#username/.test(exp.expression), JSON.stringify(exp));
  ok('tier silver', ev.tier === 'silver');
}

console.log('\n— BRONZE-only -> NOT exportable (no coordinate fallback) —');
{
  const ev = buildLocatorEvidence({ bbox: { x: 10, y: 20, w: 30, h: 40 }, coordinates: { x: 25, y: 40 }, markId: 7, surroundingText: 'Save' });
  ok('tier bronze', ev.tier === 'bronze');
  ok('selectExportLocator -> null (bronze never exported)', selectExportLocator(ev) === null);
  ok('isExportable false', isExportable(ev) === false);
  ok('coordinates present in bronze (telemetry) but never exported', ev.bronze.some((b) => b.strategy === 'coordinates') && selectExportLocator(ev) === null);
  ok('bronze available as repair hints', bronzeRepairHints(ev).length >= 1);
}

console.log('\n— no evidence -> tier none, not exportable —');
{
  const ev = buildLocatorEvidence({});
  ok('tier none', ev.tier === 'none');
  ok('not exportable', isExportable(ev) === false);
}

console.log('\n— frame/shadow context carried —');
{
  const ev = buildLocatorEvidence({ role: 'button', name: 'X', frame: 'iframe#app', shadow: 'open' });
  ok('frame carried', ev.frame === 'iframe#app');
  ok('shadow carried', ev.shadow === 'open');
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — locator evidence cascade + export boundary verified');
