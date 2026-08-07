'use strict';
/*
 * STEP 2 — whole-project operations[]. The verified capability menu + typed
 * operation-plan disposition was previously fed ONLY to module-scoped generation;
 * whole-project suites got 0 typed operations (CaseCompiler → needs_review:
 * no_typed_operations on every automatable case). This locks:
 *   - operationPlan disposes a whole-project-style scenario set: valid ops →
 *     operationStatus 'complete'; foreign/unavailable/bad ops → 'incomplete' with
 *     a dropped REASON (never silently accepted),
 *   - scenarios.js feeds atlas capabilities to the Architect for whole-project
 *     (no longer gated on moduleScope),
 *   - architect.js builds the capability menu + runs markCaseOperations whenever
 *     the atlas has capabilities (not gated on module).
 * Pure where possible; source-level for the wiring. Generic across any site.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OP = require(path.join(ROOT, 'server', 'services', 'agents', 'operationPlan'));

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };

console.log('— operation-plan disposition on a WHOLE-PROJECT-style scenario set (no module) —');
// Atlas capability inventory = the union of per-module slices from the crawl.
const caps = [
  { capabilityId: 'pim.form.addEmp', type: 'form', name: 'Add Employee', operations: ['fillField', 'submitForm'], evidence: { fields: [{ label: 'firstName' }] } },
  { capabilityId: 'admin.list.users', type: 'entity_collection', name: 'System Users', operations: ['selectEntityWhere'], evidence: { columns: [{ name: 'Username' }] } },
];
const scenarios = [
  { name: 'Whole project', module: null, cases: [
    // global ops take no capabilityRef → always resolvable → complete
    { name: 'login flow', operations: [{ operation: 'authenticateAs', params: { role: 'admin' } }, { operation: 'assertVisibleText', params: { text: 'Dashboard' } }] },
    // references a capability NOT in the atlas → dropped capability_not_in_atlas → incomplete
    { name: 'foreign ref', operations: [{ operation: 'fillField', capabilityRef: 'does.not.exist', params: { field: 'x', value: 'y' } }] },
    // not a real operation → dropped operation_not_in_vocabulary → incomplete
    { name: 'bogus op', operations: [{ operation: 'frobnicate', params: {} }] },
  ] },
];
const stats = OP.markCaseOperations(scenarios, caps, []);
const byName = {};
for (const c of scenarios[0].cases) byName[c.name] = c;

ok('valid (global) ops → operationStatus complete', byName['login flow'].operationStatus === 'complete' && (byName['login flow'].operationsDropped || []).length === 0);
ok('foreign capabilityRef → incomplete + dropped capability_not_in_atlas (not silently accepted)',
  byName['foreign ref'].operationStatus === 'incomplete' && (byName['foreign ref'].operationsDropped || []).some((d) => d.reason === 'capability_not_in_atlas'));
ok('unknown operation → incomplete + dropped operation_not_in_vocabulary',
  byName['bogus op'].operationStatus === 'incomplete' && (byName['bogus op'].operationsDropped || []).some((d) => d.reason === 'operation_not_in_vocabulary'));
ok('markCaseOperations disposed every case-with-ops + counted incompletes', stats.casesWithOps === 3 && stats.incompleteCases === 2);
ok('drops always carry a machine reason (never silent)', scenarios[0].cases.every((c) => (c.operationsDropped || []).every((d) => typeof d.reason === 'string' && d.reason)));

console.log('\n— WIRING: whole-project generation feeds capabilities + disposes operations —');
const scenSrc = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'scenarios.js'), 'utf8');
ok('scenarios.js feeds capabilities to the Architect UN-gated by moduleScope', /capabilities: calibrationAtlas \? \(calibrationAtlas\.capabilities \|\| \[\]\) : \[\]/.test(scenSrc));
ok('scenarios.js no longer restricts capabilities to module-scoped runs', !/capabilities: moduleScope && calibrationAtlas/.test(scenSrc));

const archSrc = fs.readFileSync(path.join(ROOT, 'server', 'services', 'agents', 'architect.js'), 'utf8');
ok('buildCapabilityMenu is gated on capabilities, not module (builds for whole-project)', /function buildCapabilityMenu[\s\S]{0,120}if \(!caps\.length\) return null;/.test(archSrc));
ok('architect runs markCaseOperations whenever the atlas has capabilities', archSrc.includes('operationPlan.markCaseOperations(parsed, capabilities') && /Array\.isArray\(capabilities\) && capabilities\.length/.test(archSrc));
ok('the capability menu prose is no longer hardcoded "module-scoped run"', !archSrc.includes('in this module-scoped run'));

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — whole-project generation now receives the verified capability menu and produces typed operations[]: valid ops → complete, foreign/unknown ops → incomplete with a reason (never silent). Real-suite no_typed_operations clears on the NEXT generation (regenerate to populate operationsJson).');
