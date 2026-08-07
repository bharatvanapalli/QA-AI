'use strict';
/*
 * Guard for B-2d.2b — Vision-DOM fusion runtime mapping.
 * Proves: distinct markIds for visible candidates; markId maps back to
 * DOM/ref/role/box + cascade evidence; the selected target carries its markId;
 * bronze-only visual marks are NOT exportable; markId/coords never exported.
 */
const { buildMarkRegistry, findMarkForTarget, fuseSelectedMark } = require('../server/services/visionDomFusion');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

const atlas = [
  { role: 'button', name: 'Login', idAttr: 'loginBtn', bbox: { x: 10, y: 100, w: 80, h: 30 } },
  { role: 'button', name: 'Cancel', bbox: { x: 100, y: 100, w: 80, h: 30 } }, // no durable attr -> bronze
  { role: 'textbox', name: 'Username', idAttr: 'user', bbox: { x: 10, y: 50, w: 200, h: 30 } },
];

console.log('— distinct markIds + back-mapping to DOM/role/box/evidence —');
{
  const marks = buildMarkRegistry(atlas);
  ok('3 marks with distinct ids m1/m2/m3', marks.length === 3 && new Set(marks.map((m) => m.markId)).size === 3, JSON.stringify(marks.map((m) => m.markId)));
  ok('mark carries role/name/bbox', marks[0].role === 'button' && marks[0].name === 'Login' && !!marks[0].bbox);
  ok('Login mark exportLocator is GOLD (role+name)', marks[0].exportLocator && marks[0].exportLocator.tier === 'gold', JSON.stringify(marks[0].exportLocator));
  ok('Username mark exportLocator gold (role+name) or silver (#id)', !!marks[2].exportLocator);
  ok('Cancel (no durable attr, has role+name) -> gold via role+name', marks[1].exportLocator && marks[1].exportLocator.tier === 'gold');
}

console.log('\n— bronze-only candidate (no role/name/attrs, only a box) -> NOT exportable —');
{
  const marks = buildMarkRegistry([{ role: 'generic', name: '', bbox: { x: 5, y: 5, w: 10, h: 10 }, surroundingText: 'mystery' }]);
  ok('bronze-only mark exportLocator null', marks[0].exportLocator === null, JSON.stringify(marks[0]));
  ok('mark still has a markId + bbox telemetry', marks[0].markId === 'm1' && !!marks[0].bbox);
}

console.log('\n— findMarkForTarget: id > role+name > unique name > bbox overlap —');
{
  const marks = buildMarkRegistry(atlas);
  ok('by id', findMarkForTarget(marks, { idAttr: 'user' }).markId === 'm3');
  ok('by role+name', findMarkForTarget(marks, { role: 'button', name: 'Login' }).markId === 'm1');
  ok('by unique name', findMarkForTarget(marks, { name: 'Cancel' }).markId === 'm2');
  ok('by bbox overlap (visual fallback)', findMarkForTarget(marks, { bbox: { x: 12, y: 102, w: 5, h: 5 } }).markId === 'm1', 'overlap with Login box');
  ok('no match -> null', findMarkForTarget(marks, { name: 'Nonexistent' }) === null);
}

console.log('\n— selected target carries its markId; telemetry only —');
{
  const marks = buildMarkRegistry(atlas);
  const fused = fuseSelectedMark(marks, { role: 'button', name: 'Login' });
  ok('selected mark id m1', fused.markId === 'm1');
  ok('allMarks is telemetry (markId+box), no exported coordinates as code', fused.allMarks.length === 3 && fused.allMarks.every((m) => 'markId' in m && 'bbox' in m));
  // The export locator still comes from the cascade (gold), NOT the markId/box.
  ok('selected mark exportLocator is gold (durable), not the markId/box', fused.mark.exportLocator.tier === 'gold' && !/m1|bbox|coordinate/i.test(fused.mark.exportLocator.expression));
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — Vision-DOM fusion runtime mapping verified (markId<->DOM; bronze non-exportable)');
