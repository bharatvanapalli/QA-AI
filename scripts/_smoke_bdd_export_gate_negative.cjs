'use strict';
/**
 * NEGATIVE export-gate smoke (not a guard). Proves the HARD LINE end-to-end:
 *
 *   "BDD export must not silently ship partial flows when P3d drops invalid
 *    operations. It should fail/export-invalid loudly until the missing
 *    capability or data binding is resolved."
 *
 * The PIM live smoke produced 0 dropped / 0 incomplete, so the negative runtime
 * path never fired there. This drives it directly with a controlled incomplete
 * operationsJson and asserts:
 *
 *   1. conductor-side gate  (_bddExportGate.assessBddOperationsForExport):
 *        status:'incomplete' + dropped[]  → exportable:false, the right findings.
 *   2. file emission (real temp dir, conductor's exact write loop):
 *        a populated filesToWrite is CLEARED to {} → ZERO .feature/steps on disk,
 *        and the blocked-spec placeholder is recorded instead.
 *   3. invalid JSON → also exportable:false (parse-failure path).
 *   4. adapter/compiler-side (bddExportReadiness.assessBddExportReadiness):
 *        dropped operations → exportable:false, files:{} (defense in depth).
 *   5. positive control: a COMPLETE plan → exportable:true (gate isn't always-false).
 *   6. non-BDD framework control: gate returns early (exportable:true) — no over-block.
 *   7. GovernancePR linkage (real DB round-trip, then DELETED):
 *        a row built exactly as conductor.js does (lintPassed:false,
 *        lintFindings = the gate findings) round-trips and carries the gate rule.
 *
 * Read-only against the friend's BDD adapter modules (require, never edit).
 * The only DB write is one synthetic GovernancePR row that is deleted in finally.
 *
 *   node scripts/_smoke_bdd_export_gate_negative.cjs
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const gate = require('../server/services/codegen/_bddExportGate');
const readiness = require('../server/services/codegen/adapters/bddExportReadiness');

const PID_PREFERRED = '9675bfde-acb2-4eda-aaed-b6694b88f920'; // Orange HRM
const FRAMEWORK = 'playwright-bdd';

const results = [];
function check(label, cond, detail) {
  const ok = !!cond;
  results.push({ label, ok, detail: detail || '' });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail || ''}`}`);
}
function findingRules(findings) {
  return new Set((Array.isArray(findings) ? findings : []).map((f) => f && f.rule).filter(Boolean));
}
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

(async () => {
  console.log('\n=== NEGATIVE BDD export-gate smoke — the P3d hard line ===\n');

  // The controlled incomplete plan: one valid op + one Node-dropped op.
  const incompletePlan = {
    status: 'incomplete',
    operations: [
      { operation: 'fillField', capabilityRef: 'cap-0000000001', params: { field: 'username' } },
    ],
    dropped: [
      { operation: 'selectEntityWhere', reason: 'capability_not_in_atlas', detail: 'no list/collection capability on this slice' },
    ],
  };
  const incompleteCase = { name: 'PIM — bulk approve pending (incomplete)', operationsJson: JSON.stringify(incompletePlan) };

  // ── 1) conductor-side gate refuses an incomplete plan ──
  console.log('[1] conductor-side gate — incomplete status + dropped[]');
  const g1 = gate.assessBddOperationsForExport({ framework: FRAMEWORK, testCase: incompleteCase });
  const rules1 = findingRules(g1.findings);
  check('gate.exportable === false', g1.exportable === false, `got ${g1.exportable}`);
  check('finding: bdd_export_operation_status_incomplete', rules1.has('bdd_export_operation_status_incomplete'), [...rules1].join(','));
  check('finding: bdd_export_operation_dropped', rules1.has('bdd_export_operation_dropped'), [...rules1].join(','));
  check('every blocking finding is severity=error', (g1.findings || []).filter((f) => f.rule.startsWith('bdd_export')).every((f) => f.severity === 'error'), 'a gate finding was not an error');

  // ── 2) file emission: conductor clears a POPULATED filesToWrite to {} ──
  console.log('\n[2] file emission — populated split is cleared, nothing hits disk');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-neg-gate-'));
  try {
    // What the split WOULD have produced for a BDD case (faithful shape):
    let filesToWrite = {
      'features/pim/bulk-approve.feature': 'Feature: PIM bulk approve\n  Scenario: ...\n',
      'steps/pim.bulk-approve.steps.js': "const { Given } = require('@cucumber/cucumber');\n",
    };
    let effectiveCode = '/* spec body */';
    // ── conductor.js:5535-5542 exact decision ──
    if (!g1.exportable) {
      effectiveCode = gate.blockedSpecMessage({ framework: FRAMEWORK, testCase: incompleteCase, gate: g1 });
      filesToWrite = {};
    }
    // ── conductor.js:5550-5555 exact write loop ──
    for (const [relPath, content] of Object.entries(filesToWrite)) {
      if (!content) continue;
      const full = path.join(tmpRoot, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    const onDisk = walk(tmpRoot);
    const featureish = onDisk.filter((f) => /\.(feature|steps\.js|steps\.ts)$/.test(f) || /[\\/]steps[\\/]/.test(f) || /[\\/]features[\\/]/.test(f));
    check('filesToWrite cleared to {} when not exportable', Object.keys(filesToWrite).length === 0, `keys: ${Object.keys(filesToWrite).join(',')}`);
    check('ZERO .feature/steps files written to disk', featureish.length === 0, `found: ${featureish.join(', ')}`);
    check('blocked-spec placeholder replaces the spec body', /QAAI BDD EXPORT BLOCKED/.test(effectiveCode), effectiveCode.slice(0, 60));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ── 3) invalid operationsJson → still refused ──
  console.log('\n[3] invalid operationsJson — parse-failure path');
  const g3 = gate.assessBddOperationsForExport({ framework: FRAMEWORK, testCase: { name: 'busted', operationsJson: '{ not valid json' } });
  check('invalid JSON → exportable === false', g3.exportable === false, `got ${g3.exportable}`);

  // ── 4) adapter/compiler-side refuses dropped operations (defense in depth) ──
  console.log('\n[4] adapter-side (compiler) — dropped operations → no files');
  const g4 = readiness.assessBddExportReadiness({
    framework: FRAMEWORK,
    featureName: 'PIM bulk approve', scenarioName: 'bulk approve pending', moduleName: 'pim',
    operations: [{ operation: 'fillField', capabilityRef: 'cap-0000000001', params: { field: 'username' } }],
    droppedOperations: [{ operation: 'selectEntityWhere', reason: 'capability_not_in_atlas' }],
    capabilities: [],
  });
  const rules4 = findingRules(g4.findings);
  check('adapter.exportable === false', g4.exportable === false, `got ${g4.exportable}`);
  check('adapter emits no files (files == {})', g4.files && Object.keys(g4.files).length === 0, `keys: ${Object.keys(g4.files || {}).join(',')}`);
  check('finding: bdd_export_dropped_operations', rules4.has('bdd_export_dropped_operations'), [...rules4].join(','));

  // ── 5) positive control — a COMPLETE plan exports ──
  console.log('\n[5] positive control — complete plan is exportable');
  const completePlan = { status: 'complete', operations: [{ operation: 'fillField', capabilityRef: 'cap-abc1234567', params: { field: 'username' } }], dropped: [] };
  const g5 = gate.assessBddOperationsForExport({ framework: FRAMEWORK, testCase: { name: 'ok case', operationsJson: JSON.stringify(completePlan) } });
  check('complete plan → exportable === true', g5.exportable === true, `got ${g5.exportable}`);
  check('complete plan → no error findings', (g5.findings || []).every((f) => f.severity !== 'error'), `${(g5.findings || []).length} findings`);

  // ── 6) non-BDD framework control — gate must not over-block ──
  console.log('\n[6] non-BDD framework control — gate returns early');
  const g6 = gate.assessBddOperationsForExport({ framework: 'playwright-pom', testCase: incompleteCase });
  check('non-BDD framework → exportable === true (gate inert)', g6.exportable === true, `got ${g6.exportable}`);

  // ── 7) GovernancePR linkage — real DB round-trip (created then DELETED) ──
  console.log('\n[7] GovernancePR linkage — the gate finding survives persistence');
  let proj = await prisma.project.findUnique({ where: { id: PID_PREFERRED } });
  if (!proj) proj = await prisma.project.findFirst();
  let createdId = null;
  if (!proj) {
    check('a project exists to attach a GovernancePR to', false, 'no project in DB — skipping DB round-trip');
  } else {
    try {
      // Build the row EXACTLY as conductor.js:5621-5632 would for a blocked case.
      const lintFindings = g1.findings; // the conductor folds gate.findings into lint.findings
      const blockedMessage = gate.blockedSpecMessage({ framework: FRAMEWORK, testCase: incompleteCase, gate: g1 });
      const row = await prisma.governancePR.create({
        data: {
          projectId: proj.id, sprintId: null, runId: null, testCaseId: null,
          number: '#990001',
          filename: '_NEGATIVE_GATE_SMOKE.feature',
          requirement: 'negative-gate-smoke (synthetic)',
          specCode: blockedMessage,
          lintPassed: false,
          lintFindings: JSON.stringify(lintFindings),
          status: 'pending',
        },
      });
      createdId = row.id;
      const back = await prisma.governancePR.findUnique({ where: { id: createdId } });
      const persistedRules = findingRules(JSON.parse(back.lintFindings || '[]'));
      check('GovernancePR.lintPassed === false', back.lintPassed === false, `got ${back.lintPassed}`);
      check('GovernancePR.lintFindings carries bdd_export_operation_status_incomplete', persistedRules.has('bdd_export_operation_status_incomplete'), [...persistedRules].join(','));
      check('GovernancePR.specCode is the blocked placeholder', /QAAI BDD EXPORT BLOCKED/.test(back.specCode || ''), (back.specCode || '').slice(0, 40));
    } finally {
      if (createdId) { await prisma.governancePR.delete({ where: { id: createdId } }).catch(() => {}); console.log('       (cleaned up synthetic GovernancePR row)'); }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== ${failed.length ? 'FAIL' : 'PASS'} — ${results.length - failed.length}/${results.length} checks passed ===\n`);
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => { console.error('\nNEGATIVE SMOKE FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
