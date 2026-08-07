'use strict';
/**
 * Guard for the Enterprise evidence bundle. Pure: no DB writes, no browser.
 */

const fs = require('fs');
const path = require('path');
const E = require('../server/services/evidenceBundle');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m, d) => { console.log('  ✗ ' + m + (d ? ' — ' + d : '')); failures++; };
const assert = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function runFixture() {
  return {
    id: 'RUN-1',
    projectId: 'P1',
    sprintId: null,
    sprintName: 'PIM smoke',
    status: 'completed',
    passed: 1,
    failed: 1,
    blocked: 0,
    skipped: 0,
    needsHuman: 0,
    verdictMode: 'mechanical_v1',
    verifierMode: 'deterministic',
    generationId: 'GEN-1',
    startedAt: '2026-06-04T00:00:00.000Z',
    completedAt: '2026-06-04T00:01:00.000Z',
    results: [
      {
        id: 'RR-PASS',
        runId: 'RUN-1',
        testCaseId: 'TC-1',
        status: 'pass',
        blockedReason: null,
        replayIrJson: JSON.stringify({ complete: true, gaps: [], emitterVersion: 'p6-emitter-1', ir: { id: 'IR-1', steps: [] } }),
        dependencyPath: '[]',
        assertionCheckResults: '[{"assertionId":"A1","outcome":"matched"}]',
        dataRowIndex: 0,
        dataRowLabel: 'Row 1',
        dataSetName: 'Login',
        testCase: {
          id: 'TC-1',
          name: 'Valid login',
          module: 'PIM',
          requirementRefs: '["REQ-1"]',
          dataBindingJson: '{"testDataSetId":"TD1","mappingId":"MAP1","mappingVersion":1}',
          operationsJson: '{"status":"complete","operations":[],"dropped":[]}',
          authProfile: 'admin',
          declaredAssertions: '[{"id":"A1","type":"TEXT"}]',
          scenario: { id: 'S1', name: 'Admin login', module: 'PIM' },
        },
      },
    ],
  };
}

console.log('\n[1] framework parsing + redaction');
assert(E.parseFrameworks('all').join(',') === 'playwright-pom,replayir-bdd,selenium-pom,selenium-bdd-reference', 'all expands to the certified default frameworks');
assert(E.parseFrameworks('replayir-bdd,selenium-reference').join(',') === 'replayir-bdd,selenium-reference', 'comma framework list is preserved');
assert(E.parseFrameworks('selenium-java,selenium-bdd,playwright-bdd').join(',') === 'selenium-pom,selenium-bdd-reference,replayir-bdd', 'project framework aliases normalize to certified adapter ids');
assert(E.redact({ password: 'secret123', valueRef: 'env:SAFE', nested: { token: 'abc' } }).password === '<redacted>', 'secret-keyed literals are redacted');
assert(E.redact({ password: 'env:LOGIN_PASSWORD' }).password === 'env:LOGIN_PASSWORD', 'safe valueRefs remain visible');

console.log('\n[2] bundle files contain the audit chain');
{
  const files = E.assembleEvidenceFiles({
    project: { id: 'P1', name: 'OrangeHRM', environment: 'demo', framework: 'playwright-pom', targetUrl: 'https://example.test', aiProvider: 'claude', execMode: 'fast' },
    run: runFixture(),
    enterpriseOn: true,
    frameworks: ['replayir-bdd'],
    requirements: [{ id: 'REQ-1', sourceType: 'USER_STORY', behaviourText: 'Admin can login', excerpt: 'Admin can login', coverageDisposition: 'uncovered', createdAt: 'now' }],
    discrepancies: [{ id: 'D1', kind: 'requirement_uncovered', severity: 'warning', summary: 'x', detail: 'y', resolved: false, createdAt: 'now' }],
    testDataSets: [{ id: 'TD1', name: 'Login.xlsx', rowCount: 2, uploadedAt: 'now', sheetsJson: JSON.stringify({ sheets: [{ name: 'Login', headers: ['Username', 'Password'], rows: [{ Username: 'admin', Password: 'secret123' }] }] }), mappingJson: '{}' }],
    testDataMappings: [{ id: 'MAP1', testDataSetId: 'TD1', version: 1, status: 'approved', mappingJson: '{"bindings":[{"sheet":"Login","columnToField":{"username":"Username","password":"Password"},"sensitivity":{"password":"masked"}}]}', verificationJson: '{"findings":[]}', approvalNote: 'ok', approvedBy: 'lead', approvedAt: 'now', createdAt: 'now' }],
    calibrations: [{ id: 'CAL1', module: 'pim', authProfileId: 'AUTH1', version: 1, isCurrent: true, status: 'complete', pagesCount: 4, atlasFingerprint: 'abc', staleAt: null, completedAt: 'now' }],
    authProfiles: [{ id: 'AUTH1', name: 'admin', strategy: 'bypass_fixture', disposition: 'supported', authFixtureId: 'FIX1', credentialRef: 'vault:admin' }],
    parityReports: { 'replayir-bdd': { report: { framework: 'replayir-bdd', entries: [{ runResultId: 'RR-PASS', mcpVerdict: 'pass', runnerVerdict: 'pass', matched: true }] } } },
    exportEvidence: { 'replayir-bdd': { manifest: { exportValid: true }, assessment: { ok: true, findings: [] } } },
  });
  assert(!!files['README.md'], 'README is included');
  assert(!!files['evidence/summary.json'], 'summary evidence is included');
  assert(!!files['evidence/run_results.json'], 'run result evidence is included');
  assert(!!files['evidence/requirements_rtm.json'], 'requirements RTM is included');
  assert(!!files['evidence/test_data_mappings.json'], 'approved TestData mapping evidence is included');
  assert(!!files['replayir/RR-PASS.json'], 'pinned ReplayIR envelope is included per RunResult');
  assert(!!files['parity/replayir-bdd.json'], 'P8 parity report is included');
  assert(!!files['exports/replayir-bdd/EXPORT_MANIFEST.json'], 'export manifest is included');
  assert(!!files['exports/replayir-bdd/enterprise_assessment.json'], 'Enterprise assessment is included');
  assert(!files['evidence/test_data_mappings.json'].includes('secret123'), 'raw TestData row values are not included');
}

console.log('\n[3] route + UI wiring');
{
  const route = read('server/routes/outputFiles.js');
  const ui = read('src/pages/OutputFiles.jsx');
  assert(/evidenceBundle/.test(route) && /evidence\.zip/.test(route), 'output-files route exposes evidence.zip');
  assert(/output\.evidence\.download/.test(route), 'evidence downloads are audited');
  assert(/downloadEvidence/.test(ui) && /Evidence/.test(ui), 'Output Files UI exposes the Evidence button');
  assert(/ShieldCheck/.test(ui), 'Evidence button has a trust icon');
}

console.log(`\n${failures === 0 ? 'PASS — Enterprise evidence bundle: audit chain, redaction, parity/export evidence, route/UI wiring' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
