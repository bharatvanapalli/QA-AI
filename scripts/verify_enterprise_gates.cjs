'use strict';
/**
 * Deterministic guard for Enterprise Mode P9. No browser, no DB writes.
 *
 * Proves the hard export gate:
 * - Enterprise toggle is schema-backed and route-surfaced.
 * - Enterprise export requires ReplayIR route.
 * - ReplayIR export must have package validation + P8 execution-parity evidence.
 * - P8 evidence must match every admitted RunResult and be real, eligible, matched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const P9 = require('../server/services/enterpriseMode');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { console.log('  ✗ ' + m + (d ? ' — ' + d : '')); failures++; };
const assert = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function writeReport(dir, framework, entries) {
  fs.mkdirSync(dir, { recursive: true });
  const name = P9.reportNameForFramework(framework);
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({
    framework,
    generatedAt: new Date().toISOString(),
    runId: 'RUN-1',
    entries,
  }, null, 2), 'utf8');
}

function result(over = {}) {
  return {
    adapterId: 'replayir-bdd',
    runId: 'RUN-1',
    admitted: [
      { runResultId: 'RR-PASS', testCaseId: 'TC-1', status: 'pass', expectedVerdict: 'pass', irHash: 'IRHASH-PASS', requirementRefs: ['REQ-abc'], authProfile: 'Admin', dataBinding: null, dataRowsUsed: false, files: ['features/a.feature'] },
      { runResultId: 'RR-FAIL', testCaseId: 'TC-2', status: 'fail', expectedVerdict: 'fail', irHash: 'IRHASH-FAIL', requirementRefs: ['REQ-def'], authProfile: 'Admin', dataBinding: null, dataRowsUsed: false, files: ['features/b.feature'] },
    ],
    blocked: [],
    manifest: {
      exportValid: true,
      allBlocked: false,
      validation: { checked: true, packagePassed: true, findings: [], errorCount: 0, warningCount: 0 },
      secretFindings: [],
      entries: [],
    },
    ...over,
  };
}

function entries(extra = {}) {
  return [
    { runResultId: 'RR-PASS', framework: 'replayir-bdd', irHash: 'IRHASH-PASS', mcpVerdict: 'pass', runnerVerdict: 'pass', matched: true, eligible: true, provenance: 'real', reason: 'pass executed pass', ...extra },
    { runResultId: 'RR-FAIL', framework: 'replayir-bdd', irHash: 'IRHASH-FAIL', mcpVerdict: 'fail', runnerVerdict: 'fail', matched: true, eligible: true, provenance: 'real', reason: 'fail executed fail' },
  ];
}

console.log('\n[1] enterpriseMode toggle helpers');
assert(P9.isEnterpriseMode({ enterpriseMode: true }) === true, 'project.enterpriseMode true activates P9');
assert(P9.isEnterpriseMode({ enterpriseMode: false }) === false, 'project.enterpriseMode false leaves legacy behavior available');
assert(P9.reportNameForFramework('playwright-reference') === 'playwright', 'Playwright adapter maps to P8 playwright report');
assert(P9.reportNameForFramework('replayir-bdd') === 'bdd', 'BDD adapter maps to P8 bdd report');
assert(P9.reportNameForFramework('selenium-reference') === 'selenium-reference', 'Selenium reference maps to its own P8 report');
assert(P9.reportNameForFramework('selenium-pom') === 'selenium-pom', 'Selenium POM maps to its own P8 report');
assert(P9.reportNameForFramework('selenium-bdd-reference') === 'selenium-bdd', 'Selenium BDD maps to its P8 BDD report');

console.log('\n[2] happy path — package validation + real P8 parity evidence');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p9-'));
  writeReport(dir, 'replayir-bdd', entries());
  const a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(a.ok, 'valid manifest + matching real parity report passes P9');
  assert(a.evidence.parityEntries.length === 2, 'evidence records one P8 entry per admitted RunResult');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[3] hard failures — no report / no entry / mismatch / not eligible / fixture proof');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p9-'));
  let a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_report_missing'), 'missing P8 report blocks enterprise export');

  writeReport(dir, 'replayir-bdd', [entries()[0]]);
  a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_entry_missing'), 'missing RunResult parity row blocks enterprise export');

  writeReport(dir, 'replayir-bdd', entries({ matched: false, runnerVerdict: 'fail' }));
  a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_not_matched'), 'matched:false blocks enterprise export');

  writeReport(dir, 'replayir-bdd', entries({ eligible: false }));
  a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_not_eligible'), 'eligible:false blocks enterprise export');

  writeReport(dir, 'replayir-bdd', entries({ provenance: 'fixture' }));
  a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_not_real'), 'fixture-only parity proof blocks enterprise export');

  writeReport(dir, 'replayir-bdd', entries({ irHash: null }));
  a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_ir_hash_missing'), 'missing P8 ReplayIR hash blocks enterprise export');

  writeReport(dir, 'replayir-bdd', entries({ irHash: 'STALE-HASH' }));
  a = P9.assessReplayExport({ project: { id: 'P1', enterpriseMode: true }, result: result(), framework: 'replayir-bdd', parityDir: dir });
  assert(!a.ok && a.findings.some((f) => f.rule === 'enterprise_parity_ir_hash_mismatch'), 'stale P8 ReplayIR hash blocks enterprise export');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[4] hard failures — package validation / secret / all-blocked / no admitted result');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p9-'));
  writeReport(dir, 'replayir-bdd', entries());
  assert(!P9.assessReplayExport({ project: {}, result: result({ manifest: { ...result().manifest, exportValid: false } }), framework: 'replayir-bdd', parityDir: dir }).ok, 'manifest.exportValid false blocks');
  assert(!P9.assessReplayExport({ project: {}, result: result({ manifest: { ...result().manifest, validation: { checked: false, packagePassed: null } } }), framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_package_validation_failed'), 'unchecked validation does not masquerade as package failure');
  assert(P9.assessReplayExport({ project: {}, result: result({ manifest: { ...result().manifest, validation: { checked: false, packagePassed: null } } }), framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_package_validation_missing'), 'missing package validation blocks');
  assert(P9.assessReplayExport({ project: {}, result: result({ manifest: { ...result().manifest, secretFindings: [{ rule: 'known_secret_literal' }] } }), framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_secret_findings'), 'secret findings block');
  assert(P9.assessReplayExport({ project: {}, result: result({ admitted: [], manifest: { ...result().manifest, allBlocked: true } }), framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_no_admitted_results'), 'no admitted RunResults blocks');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[5] hard failures — traceability / auth / TestData approval / partial export');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-p9-'));
  writeReport(dir, 'replayir-bdd', entries());
  let base = result();
  base.admitted[0] = { ...base.admitted[0], requirementRefs: [] };
  assert(P9.assessReplayExport({ project: {}, result: base, framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_requirement_refs_missing'), 'missing requirementRefs block enterprise export');

  base = result();
  base.admitted[0] = { ...base.admitted[0], authProfile: null };
  assert(P9.assessReplayExport({ project: {}, result: base, framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_auth_profile_missing'), 'missing AuthProfile blocks enterprise export');

  base = result();
  base.admitted[0] = { ...base.admitted[0], dataRowsUsed: true, dataBinding: { sheet: 'LoginData' } };
  assert(P9.assessReplayExport({ project: {}, result: base, framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_testdata_mapping_unapproved'), 'data rows without approved mapping pin block enterprise export');

  base = result();
  base.admitted[0] = { ...base.admitted[0], dataRowsUsed: true, dataBinding: { testDataSetId: 'tds-1', mappingId: 'map-1', mappingVersion: 2 } };
  assert(P9.assessReplayExport({ project: {}, result: base, framework: 'replayir-bdd', parityDir: dir }).findings.every((f) => f.rule !== 'enterprise_testdata_mapping_unapproved'), 'approved TestData mapping pin is accepted');

  base = result({ blocked: [{ runResultId: 'RR-BLOCKED-EXPORT', testCaseId: 'TC-3', code: 'replayir_incomplete', detail: 'missing locator evidence' }] });
  assert(P9.assessReplayExport({ project: {}, result: base, framework: 'replayir-bdd', parityDir: dir }).findings.some((f) => f.rule === 'enterprise_export_blocked_results'), 'partial export with blocked selected results is refused');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n[6] route + schema wiring');
{
  const schema = read('prisma/schema.prisma');
  const migration = read('prisma/migrations/20260616000000_add_enterprise_mode/migration.sql');
  const projects = read('server/routes/projects.js');
  const output = read('server/routes/outputFiles.js');
  assert(/enterpriseMode\s+Boolean\s+@default\(false\)/.test(schema), 'Project.enterpriseMode Boolean @default(false)');
  assert(/ADD COLUMN "enterpriseMode" BOOLEAN NOT NULL DEFAULT false/.test(migration), 'migration adds enterpriseMode default false');
  assert(/attachProjectsEnterpriseMode/.test(projects), 'project list exposes enterpriseMode through the raw-SQL fallback');
  assert(/writeProjectEnterpriseMode/.test(projects), 'project create/update can toggle enterpriseMode without generated-client support');
  assert(/typeof enterpriseMode === 'boolean'/.test(projects), 'project update accepts explicit enterpriseMode boolean');
  assert(/readProjectEnterpriseMode\(prisma, project\.id, project\)/.test(output), 'output export reads enterpriseMode without generated-client support');
  assert(/ENTERPRISE_REQUIRES_REPLAYIR/.test(output), 'legacy ZIP is blocked when Enterprise Mode is enabled');
  assert(/assessReplayExport/.test(output) && /ENTERPRISE_GATE_FAILED/.test(output), 'ReplayIR ZIP is checked by the P9 assessment before shipping');
  assert(/output\.export\.enterprise\.approved/.test(output) && /output\.export\.enterprise\.blocked/.test(output), 'enterprise approval/block decisions are audited');
  const p9 = read('server/services/enterpriseMode.js');
  assert(/enterprise_export_blocked_results/.test(p9), 'P9 refuses partial exports with any selected export-blocked result');
  assert(/enterprise_requirement_refs_missing/.test(p9), 'P9 requires requirementRefs in the export evidence');
  assert(/enterprise_auth_profile_missing/.test(p9), 'P9 requires first-class AuthProfile evidence');
  assert(/enterprise_testdata_mapping_unapproved/.test(p9), 'P9 requires approved TestData mapping pins when data rows are exported');
}

console.log(`\n${failures === 0 ? 'PASS — P9 Enterprise Mode export hard-gate: ReplayIR-only, package-validated, parity-proven, audited' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
