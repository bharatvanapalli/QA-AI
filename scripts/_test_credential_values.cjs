'use strict';
const emitter = require('../server/services/codegen/replayEmitter');

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS', m); pass++; };
const bad = (m) => { console.error('  FAIL', m); fail++; };
const assert = (c, m, detail) => c ? ok(m) : bad(m + (detail ? ` — ${detail}` : ''));

function verifiedLocator(label, index = 0) {
  const expression = `getByPlaceholder(${JSON.stringify(label)})`;
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: 'verified_mcp_accessibility_snapshot',
    evidenceSource: 'verified_mcp_accessibility_snapshot',
    diagnosticOnly: false,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: 'placeholder',
    toolName: 'browser_fill_form',
    elementLabel: label,
    targetFacts: { role: 'textbox', accessibleName: label, placeholder: label },
    proof: { count: 1, sameElement: true, source: 'verified_mcp_accessibility_snapshot', verified: true },
    domAtlas: { verifiedActions: [{ toolName: 'browser_fill_form', elementLabel: label, expression }] },
    candidates: [{ strategy: 'placeholder', text: label, expression, frameworkExpressions: { playwright: expression }, proof: { count: 1, sameElement: true } }],
    allCandidates: [{ strategy: 'placeholder', expression, proof: { count: 1, sameElement: true }, score: 100 }],
    context: { source: 'verified_mcp_accessibility_snapshot', ref: `e${index + 1}` },
  };
}

function formLocator(labels) {
  return {
    kind: 'multi',
    toolName: 'browser_fill_form',
    fields: labels.map((label, index) => ({
      index,
      ref: `e${index + 1}`,
      name: label,
      actionLocator: verifiedLocator(label, index),
    })),
  };
}

const credTrail = [
  { tool: 'browser_fill_form', args: { fields: [
    { name: 'Username', type: 'textbox', value: 'Admin' },
    { name: 'Password', type: 'textbox', value: 'admin123' },
  ] }, actionLocator: formLocator(['Username', 'Password']), ok: true },
  { tool: 'browser_click', args: { element: 'Login' }, ok: true },
];

// ─── Test 1: credentialValues=null → all credential fills masked (old behavior preserved) ───
{
  const r = emitter.buildReplayIR({ caseId: 'TC1', trail: credTrail, verdictStatus: 'pass', credentialValues: null });
  const fills = r.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
  assert(fills.length >= 2, 'two fill steps emitted');
  assert(fills.every(s => s.valueRef && !s.rawValue), 'credentialValues=null → all fills masked as valueRef');
}

// ─── Test 2: real creds in set → real username NOT inlined, wrong password inlined ───
// The adapter prefers rawValue over valueRef when both are present (line 73 playwrightReference.js),
// so the behavioural check is: wrong fill has rawValue set; real fill does NOT have rawValue.
{
  const realCreds = new Set(['Admin', 'RealPass123']);
  const negTrail = [
    { tool: 'browser_fill_form', args: { fields: [
      { name: 'Username', type: 'textbox', value: 'Admin' },
      { name: 'Password', type: 'textbox', value: 'WrongPass!' },
    ] }, actionLocator: formLocator(['Username', 'Password']), ok: true },
  ];
  const r = emitter.buildReplayIR({ caseId: 'TC2', trail: negTrail, verdictStatus: 'fail', credentialValues: realCreds });
  const fills = r.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
  // Index 0 = Username (el1), Index 1 = Password (el2) — order preserved from fields array
  const userFill = fills[0];
  const pwFill   = fills[1];
  assert(userFill && !userFill.rawValue, 'real username (Admin ∈ set) → no rawValue (adapter will use env ref)', JSON.stringify(userFill));
  assert(pwFill  && pwFill.rawValue === 'WrongPass!', 'wrong password (not ∈ set) → rawValue inlined', JSON.stringify(pwFill));
}

// ─── Test 3: empty credentialValues set → safety gate, no rawValue on credential fills ───
{
  const empty = new Set();
  const negTrail = [
    { tool: 'browser_fill_form', args: { fields: [
      { name: 'Password', type: 'textbox', value: 'WrongPass!' },
    ] }, actionLocator: formLocator(['Password']), ok: true },
  ];
  const r = emitter.buildReplayIR({ caseId: 'TC3', trail: negTrail, verdictStatus: 'fail', credentialValues: empty });
  const fills = r.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
  assert(fills.length > 0 && fills.every(s => !s.rawValue), 'empty set → no rawValue (safety gate: nothing to compare against)', JSON.stringify(fills));
}

// ─── Test 4: browser_fill scalar path emits a fill when action locator exists ───
{
  const realCreds = new Set(['Admin', 'RealPass123']);
  const scalarTrail = [
    { tool: 'browser_fill', args: { element: 'Password', value: 'WrongScalar!', ref: 'e1' }, actionLocator: verifiedLocator('Password'), ok: true },
  ];
  const r = emitter.buildReplayIR({ caseId: 'TC4', trail: scalarTrail, verdictStatus: 'fail', credentialValues: realCreds });
  const fills = r.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
  assert(fills.length === 1, 'browser_fill scalar path emits one fill step');
  assert(fills[0] && fills[0].rawValue === 'WrongScalar!', 'wrong scalar credential value is preserved as rawValue', JSON.stringify(fills));
}

// ─── Test 5: real password in fill_form → no rawValue ───
{
  const realCreds = new Set(['Admin', 'RealPass123']);
  const trail5 = [
    { tool: 'browser_fill_form', args: { fields: [
      { name: 'Password', type: 'textbox', value: 'RealPass123' },
    ] }, actionLocator: formLocator(['Password']), ok: true },
  ];
  const r = emitter.buildReplayIR({ caseId: 'TC5', trail: trail5, verdictStatus: 'pass', credentialValues: realCreds });
  const fills = r.ir.steps.filter(s => s.op === 'act' && s.action === 'fill');
  assert(fills.length > 0 && fills.every(s => !s.rawValue), 'real password (∈ set) → no rawValue (stays as env ref)', JSON.stringify(fills));
}

console.log(`\n[credentialValues] ${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
