'use strict';
/*
 * Guard for B-2c.2 — memory/live-ref re-certification through the kernel.
 * A remembered ref is reused ONLY if it still resolves to the same interactive
 * target on the CURRENT page; otherwise it re-resolves (certified) or blocks —
 * never blindly dispatches a stale ref. Uses the REAL certified resolver
 * (mcp.resolveActionRefByDescription) injected. SYNTHETIC fixtures, not live.
 */
const { recertifyRememberedTarget } = require('../server/services/precisionActionKernel');
const mcp = require('../server/services/mcp');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const recert = (o) => recertifyRememberedTarget({ toolName: 'browser_click', resolveByDescription: mcp.resolveActionRefByDescription, ...o });

console.log('— remembered ref still valid -> REUSE —');
{
  const snap = ['- button "Save" [ref=e5]'].join('\n');
  const r = recert({ rememberedRef: 'e5', intendedLabel: 'Save', snapshotBefore: snap });
  ok('decision reuse', r.decision === 'reuse', r.decision);
  ok('uses the remembered ref e5', r.ref === 'e5', r.ref);
  ok('record certification not static', r.record.target.role === 'button', JSON.stringify(r.record.target));
}

console.log('\n— ref reassigned to a STATIC element after re-render -> RE-RESOLVE to the real control —');
{
  const snap = ['- heading "Save" [ref=e5]', '- button "Save" [ref=e9]'].join('\n');
  const r = recert({ rememberedRef: 'e5', intendedLabel: 'Save', snapshotBefore: snap });
  ok('decision reresolve (not reuse of the heading)', r.decision === 'reresolve', `${r.decision}: ${r.reason}`);
  ok('re-resolved to the button e9', r.ref === 'e9', r.ref);
}

console.log('\n— remembered ref GONE from snapshot -> RE-RESOLVE if a certified match exists —');
{
  const snap = ['- button "Save" [ref=e9]'].join('\n');
  const r = recert({ rememberedRef: 'e5', intendedLabel: 'Save', snapshotBefore: snap });
  ok('decision reresolve', r.decision === 'reresolve', `${r.decision}: ${r.reason}`);
  ok('uses fresh ref e9', r.ref === 'e9', r.ref);
}

console.log('\n— ref gone + no matching control -> BLOCK (never dispatch a stale/guessed ref) —');
{
  const snap = ['- button "Cancel" [ref=e9]'].join('\n');
  const r = recert({ rememberedRef: 'e5', intendedLabel: 'Save', snapshotBefore: snap });
  ok('decision block', r.decision === 'block', `${r.decision}: ${r.reason}`);
  ok('no ref to use', r.ref === null, String(r.ref));
}

console.log('\n— ref now points to a DIFFERENT-named control -> do NOT reuse it —');
{
  // e5 is interactive (button) but its name is now "Submit", we wanted "Save", and no "Save" exists -> block.
  const snap = ['- button "Submit" [ref=e5]'].join('\n');
  const r = recert({ rememberedRef: 'e5', intendedLabel: 'Save', snapshotBefore: snap });
  ok('decision NOT reuse (name drift)', r.decision !== 'reuse', `${r.decision}: ${r.reason}`);
  ok('blocks (no certified Save on page)', r.decision === 'block', r.decision);
}

console.log('\n— live-ref drift to a different control that DOES exist -> re-resolve to the intended one —');
{
  const snap = ['- button "Submit" [ref=e5]', '- button "Save" [ref=e8]'].join('\n');
  const r = recert({ rememberedRef: 'e5', intendedLabel: 'Save', snapshotBefore: snap, source: 'live_ref' });
  ok('reresolve to e8 (the real Save)', r.decision === 'reresolve' && r.ref === 'e8', `${r.decision}/${r.ref}`);
  ok('record source preserved (live_ref)', r.record.source === 'live_ref', r.record.source);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — memory/live-ref re-certification verified (SYNTHETIC fixtures; dispatch wiring lands in B-2d)');
