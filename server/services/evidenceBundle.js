'use strict';

/**
 * Enterprise evidence bundle.
 *
 * This is the stakeholder/auditor artifact: requirement refs, approved data
 * mapping versions, auth profile, dependency evidence, pinned ReplayIR,
 * export manifests, and P8 parity reports in one ZIP-ready file map.
 *
 * Deliberately no LLM and no browser. Export manifests are rebuilt through the
 * same ReplayIR export service so the bundle mirrors the actual script gate.
 */

const path = require('path');
const enterpriseMode = require('./enterpriseMode');
const replayExport = require('./codegen/replayExport');
const { decodeJson } = require('./jsonField');
const { clauseCoverageDisposition } = require('./requirementOracle');

const DEFAULT_FRAMEWORKS = ['playwright-pom', 'replayir-bdd', 'selenium-pom', 'selenium-bdd-reference'];
const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|api[_-]?key|otp|mfa|pin|credential|cvv|card)/i;
const FRAMEWORK_ALIASES = {
  'playwright-js': 'playwright-pom-js',
  'playwright-bdd': 'replayir-bdd',
  'cucumber-playwright': 'replayir-bdd',
  'selenium-java': 'selenium-pom',
  'selenium-bdd': 'selenium-bdd-reference',
};

function parseFrameworks(value) {
  if (!value || value === 'all') return [...DEFAULT_FRAMEWORKS];
  const out = String(value)
    .split(',')
    .map((s) => s.trim())
    .map((s) => FRAMEWORK_ALIASES[s] || s)
    .filter(Boolean);
  return out.length ? [...new Set(out)] : [...DEFAULT_FRAMEWORKS];
}

function safeJson(value, fallback) {
  return decodeJson(value, fallback);
}

function redact(value, key = '') {
  if (value == null) return value;
  if (value instanceof Date) return value.toISOString();
  if (SECRET_KEY_RE.test(String(key || ''))) {
    if (typeof value === 'string' && /^(env|vault|fixture|masked):/i.test(value)) return value;
    return '<redacted>';
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, key));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(redact(value), null, 2) + '\n';
}

function addJson(files, rel, value) {
  files[rel] = stableJson(value);
}

function summarizeProject(project, enterpriseOn) {
  return {
    id: project.id,
    name: project.name,
    environment: project.environment,
    framework: project.framework,
    targetUrl: project.targetUrl,
    aiProvider: project.aiProvider,
    execMode: project.execMode,
    enterpriseMode: !!enterpriseOn,
  };
}

function summarizeRun(run) {
  return {
    id: run.id,
    projectId: run.projectId,
    sprintId: run.sprintId,
    sprintName: run.sprintName,
    status: run.status,
    counts: {
      passed: run.passed,
      failed: run.failed,
      blocked: run.blocked,
      skipped: run.skipped,
      needsHuman: run.needsHuman,
    },
    verdictMode: run.verdictMode,
    verifierMode: run.verifierMode,
    generationId: run.generationId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function summarizeResult(result) {
  const tc = result.testCase || {};
  return {
    id: result.id,
    runId: result.runId,
    testCaseId: result.testCaseId,
    testCaseName: tc.name || null,
    scenarioName: tc.scenario && tc.scenario.name || null,
    module: tc.module || null,
    status: result.status,
    blockedReason: result.blockedReason,
    blockedByTestCaseId: result.blockedByTestCaseId,
    blockedByRunResultId: result.blockedByRunResultId,
    blockedByReason: result.blockedByReason,
    dependencyPath: safeJson(result.dependencyPath, []),
    mechanicalVerdictReason: result.mechanicalVerdictReason,
    assertionGateWouldReject: result.assertionGateWouldReject,
    assertionGateReason: result.assertionGateReason,
    dataRowIndex: result.dataRowIndex,
    dataRowLabel: result.dataRowLabel,
    dataSetName: result.dataSetName,
    replayIr: {
      present: !!result.replayIrJson,
      complete: !!(safeJson(result.replayIrJson, null) || {}).complete,
      gaps: (safeJson(result.replayIrJson, null) || {}).gaps || [],
      emitterVersion: (safeJson(result.replayIrJson, null) || {}).emitterVersion || null,
    },
    assertions: safeJson(tc.declaredAssertions, []),
    assertionOutcomes: safeJson(result.assertionCheckResults, []),
    requirementRefs: safeJson(tc.requirementRefs, []),
    dataBinding: safeJson(tc.dataBindingJson, null),
    operations: safeJson(tc.operationsJson, null),
    authProfile: tc.authProfile || null,
  };
}

function summarizeRequirements(requirements, coveredIds) {
  return (requirements || []).map((r) => ({
    id: r.id,
    sourceType: r.sourceType,
    sourceDocId: r.sourceDocId,
    behaviourText: r.behaviourText,
    excerpt: r.excerpt,
    // Step 6 — single authority. Coverage is DERIVED from live run refs (coveredIds);
    // the stored coverageDisposition is honoured ONLY for explicit human dispositions.
    // Previously this fell back to r.coverageDisposition, so a stale stored 'covered'
    // on an uncovered clause leaked into the auditor RTM as a false 'covered'.
    coverageDisposition: clauseCoverageDisposition(r, coveredIds.has(r.id)),
    dispositionReason: r.dispositionReason,
    createdAt: r.createdAt,
  }));
}

function summarizeTestDataSet(set, mappingsBySet) {
  return {
    id: set.id,
    name: set.name,
    sprintId: set.sprintId,
    rowCount: set.rowCount,
    uploadedAt: set.uploadedAt,
    sheets: (safeJson(set.sheetsJson, { sheets: [] }).sheets || []).map((s) => ({
      name: s.name,
      headers: s.headers || [],
      rowCount: Array.isArray(s.rows) ? s.rows.length : 0,
    })),
    draftMappingPresent: !!set.mappingJson,
    mappings: (mappingsBySet.get(set.id) || []).map((m) => ({
      id: m.id,
      version: m.version,
      status: m.status,
      mapping: safeJson(m.mappingJson, null),
      verification: safeJson(m.verificationJson, null),
      approvalNote: m.approvalNote,
      approvedBy: m.approvedBy,
      approvedAt: m.approvedAt,
      rejectedReason: m.rejectedReason,
      createdAt: m.createdAt,
    })),
  };
}

function filterParityReport(report, runResultIds) {
  if (!report) return null;
  const ids = new Set(runResultIds);
  return {
    ...report,
    entries: (report.entries || []).filter((entry) => ids.has(entry.runResultId)),
  };
}

function addReplayIrFiles(files, results) {
  for (const r of results || []) {
    const env = safeJson(r.replayIrJson, null);
    if (env) addJson(files, `replayir/${r.id}.json`, env);
  }
}

function buildReadme({ project, run, frameworks, enterpriseOn }) {
  return `# QAAI Evidence Bundle

Project: ${project.name}
Run: ${run.id}
Generated: ${new Date().toISOString()}
Enterprise Mode: ${enterpriseOn ? 'enabled' : 'disabled'}
Framework evidence: ${frameworks.join(', ')}

This bundle proves the chain from requirement and approved data to MCP result,
pinned ReplayIR, export manifest, and P8 execution parity report. It does not
contain credential literals or raw TestData row values.

Key files:
- evidence/summary.json
- evidence/run_results.json
- evidence/requirements_rtm.json
- evidence/test_data_mappings.json
- replayir/<runResultId>.json
- exports/<framework>/EXPORT_MANIFEST.json
- exports/<framework>/enterprise_assessment.json
- parity/<framework>.json
`;
}

function assembleEvidenceFiles({
  project,
  run,
  enterpriseOn,
  frameworks,
  requirements = [],
  discrepancies = [],
  testDataSets = [],
  testDataMappings = [],
  calibrations = [],
  authProfiles = [],
  parityReports = {},
  exportEvidence = {},
}) {
  const files = {};
  const results = run.results || [];
  const runResultIds = results.map((r) => r.id);
  const coveredIds = new Set();
  for (const r of results) {
    const refs = safeJson(r.testCase && r.testCase.requirementRefs, []);
    if (Array.isArray(refs)) refs.forEach((id) => coveredIds.add(id));
  }
  const mappingsBySet = new Map();
  for (const m of testDataMappings || []) {
    if (!mappingsBySet.has(m.testDataSetId)) mappingsBySet.set(m.testDataSetId, []);
    mappingsBySet.get(m.testDataSetId).push(m);
  }

  files['README.md'] = buildReadme({ project, run, frameworks, enterpriseOn });
  addJson(files, 'evidence/summary.json', {
    generatedAt: new Date().toISOString(),
    project: summarizeProject(project, enterpriseOn),
    run: summarizeRun(run),
    frameworks,
    resultCount: results.length,
    replayIrCount: results.filter((r) => !!r.replayIrJson).length,
    requirementCount: requirements.length,
    coveredRequirementCount: coveredIds.size,
    testDataSetCount: testDataSets.length,
    authProfileCount: authProfiles.length,
    calibrationCount: calibrations.length,
  });
  addJson(files, 'evidence/run.json', summarizeRun(run));
  addJson(files, 'evidence/run_results.json', results.map(summarizeResult));
  addJson(files, 'evidence/requirements_rtm.json', summarizeRequirements(requirements, coveredIds));
  addJson(files, 'evidence/findings.json', discrepancies.map((d) => ({
    id: d.id,
    kind: d.kind,
    severity: d.severity,
    summary: d.summary,
    detail: d.detail,
    resolved: d.resolved,
    createdAt: d.createdAt,
  })));
  addJson(files, 'evidence/test_data_mappings.json', testDataSets.map((set) => summarizeTestDataSet(set, mappingsBySet)));
  addJson(files, 'evidence/auth_profiles.json', authProfiles.map((p) => ({
    id: p.id,
    name: p.name,
    strategy: p.strategy,
    disposition: p.disposition,
    authFixtureId: p.authFixtureId,
    credentialRef: p.credentialRef,
  })));
  addJson(files, 'evidence/atlas_slices.json', calibrations.map((c) => ({
    id: c.id,
    module: c.module,
    authProfileId: c.authProfileId,
    version: c.version,
    isCurrent: c.isCurrent,
    status: c.status,
    pagesCount: c.pagesCount,
    atlasFingerprint: c.atlasFingerprint,
    staleAt: c.staleAt,
    completedAt: c.completedAt,
  })));
  addReplayIrFiles(files, results);

  for (const framework of frameworks) {
    const parity = filterParityReport(parityReports[framework] && parityReports[framework].report, runResultIds);
    if (parity) addJson(files, `parity/${framework}.json`, parity);
    if (exportEvidence[framework]) {
      if (exportEvidence[framework].manifest) addJson(files, `exports/${framework}/EXPORT_MANIFEST.json`, exportEvidence[framework].manifest);
      if (exportEvidence[framework].assessment) addJson(files, `exports/${framework}/enterprise_assessment.json`, exportEvidence[framework].assessment);
      if (exportEvidence[framework].error) addJson(files, `exports/${framework}/error.json`, exportEvidence[framework].error);
    }
  }

  return files;
}

async function safeFind(fn, fallback = []) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function resolveRun(prisma, projectId, runId) {
  const id = runId || (await prisma.run.findFirst({
    where: { projectId },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  }))?.id;
  if (!id) return null;
  return prisma.run.findFirst({
    where: { id, projectId },
    include: {
      results: {
        orderBy: { createdAt: 'asc' },
        include: {
          testCase: {
            select: {
              id: true,
              name: true,
              module: true,
              requirementRefs: true,
              dataBindingJson: true,
              operationsJson: true,
              authProfile: true,
              declaredAssertions: true,
              scenario: { select: { id: true, name: true, module: true } },
            },
          },
        },
      },
    },
  });
}

async function buildEvidenceBundle({ prisma, project, runId = null, frameworks = DEFAULT_FRAMEWORKS, parityDir = enterpriseMode.DEFAULT_PARITY_DIR, includeExportManifests = true }) {
  const run = await resolveRun(prisma, project.id, runId);
  if (!run) {
    const err = new Error('No run found for evidence bundle.');
    err.status = 404;
    err.code = 'NO_RUN';
    throw err;
  }
  const enterpriseOn = await enterpriseMode.readProjectEnterpriseMode(prisma, project.id, project);
  const projectWithMode = { ...project, enterpriseMode: enterpriseOn };
  const runResultIds = new Set((run.results || []).map((r) => r.id));

  const [requirements, discrepancies, testDataSets, testDataMappings, calibrations, authProfiles] = await Promise.all([
    safeFind(() => prisma.requirementClause.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } })),
    safeFind(() => prisma.discrepancy.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } })),
    safeFind(() => prisma.testDataSet.findMany({ where: { projectId: project.id }, orderBy: { uploadedAt: 'asc' } })),
    safeFind(() => prisma.testDataMapping.findMany({ where: { projectId: project.id }, orderBy: [{ testDataSetId: 'asc' }, { version: 'asc' }] })),
    safeFind(() => prisma.calibration.findMany({ where: { projectId: project.id }, orderBy: [{ module: 'asc' }, { version: 'desc' }] })),
    safeFind(() => prisma.authProfile.findMany({ where: { projectId: project.id }, orderBy: { name: 'asc' } })),
  ]);

  const parityReports = {};
  for (const framework of frameworks) {
    parityReports[framework] = enterpriseMode.loadParityReport({ framework, parityDir });
  }

  const exportEvidence = {};
  if (includeExportManifests) {
    for (const framework of frameworks) {
      try {
        const result = await replayExport.buildReplayExport({ projectId: project.id, runId: run.id, framework, validate: true });
        const assessment = enterpriseMode.assessReplayExport({ project: projectWithMode, result, framework, parityDir });
        exportEvidence[framework] = {
          manifest: result.manifest,
          assessment: { ok: assessment.ok, findings: assessment.findings, evidence: assessment.evidence },
        };
      } catch (err) {
        exportEvidence[framework] = {
          error: { code: err.code || 'EXPORT_EVIDENCE_FAILED', message: err.message || String(err) },
        };
      }
    }
  }

  const files = assembleEvidenceFiles({
    project: projectWithMode,
    run,
    enterpriseOn,
    frameworks,
    requirements,
    discrepancies,
    testDataSets,
    testDataMappings,
    calibrations,
    authProfiles,
    parityReports,
    exportEvidence,
  });
  return {
    run,
    files,
    filename: `${String(project.name || 'qaai-project').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'qaai-project'}-evidence-${String(run.id).slice(0, 8)}.zip`,
    fileCount: Object.keys(files).length,
    frameworks,
  };
}

module.exports = {
  DEFAULT_FRAMEWORKS,
  parseFrameworks,
  redact,
  assembleEvidenceFiles,
  buildEvidenceBundle,
  summarizeRequirements, // exported for the RTM single-source guard
};
