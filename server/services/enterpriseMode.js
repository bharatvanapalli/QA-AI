'use strict';

/**
 * Enterprise Mode P9 — hard gates over already-built deterministic artifacts.
 *
 * This module does not generate, execute, or call an LLM. It verifies that an
 * export has the evidence Enterprise Mode claims: ReplayIR-only package,
 * package validation, no secret leak, and P8 execution-parity proof for every
 * admitted RunResult.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_PARITY_DIR = path.join(REPO_ROOT, 'playwright', 'p8-parity');

const FRAMEWORK_TO_REPORT = {
  'playwright-pom': 'playwright',
  'playwright-pom-js': 'playwright',
  'playwright-reference': 'playwright',
  'playwright-reference-js': 'playwright',
  'replayir-bdd': 'bdd',
  'selenium-reference': 'selenium-reference',
  'selenium-pom': 'selenium-pom',
  'selenium-bdd-reference': 'selenium-bdd',
};

function isEnterpriseMode(project) {
  return !!(project && project.enterpriseMode === true);
}

function boolFromDb(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function readProjectEnterpriseMode(prisma, projectId, fallbackProject = null) {
  if (fallbackProject && typeof fallbackProject.enterpriseMode === 'boolean') {
    return fallbackProject.enterpriseMode;
  }
  if (!prisma || !projectId || typeof prisma.$queryRawUnsafe !== 'function') {
    return false;
  }
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "enterpriseMode" AS "enterpriseMode" FROM "Project" WHERE "id" = ? LIMIT 1',
    projectId,
  );
  const value = Array.isArray(rows) && rows[0] ? rows[0].enterpriseMode : false;
  return boolFromDb(value);
}

async function writeProjectEnterpriseMode(prisma, projectId, enabled) {
  if (!prisma || !projectId || typeof prisma.$executeRawUnsafe !== 'function') {
    throw new Error('Prisma raw SQL is required to update Project.enterpriseMode');
  }
  await prisma.$executeRawUnsafe(
    'UPDATE "Project" SET "enterpriseMode" = ? WHERE "id" = ?',
    enabled ? 1 : 0,
    projectId,
  );
  return enabled === true;
}

async function attachProjectEnterpriseMode(prisma, project) {
  if (!project) return project;
  const enterpriseMode = await readProjectEnterpriseMode(prisma, project.id, project);
  return { ...project, enterpriseMode };
}

async function attachProjectsEnterpriseMode(prisma, projects) {
  if (!Array.isArray(projects) || !projects.length) return projects || [];
  return Promise.all(projects.map((project) => attachProjectEnterpriseMode(prisma, project)));
}

function error(rule, message, extra = {}) {
  return { rule, severity: 'error', message, ...extra };
}

function reportNameForFramework(framework) {
  return FRAMEWORK_TO_REPORT[framework] || String(framework || '').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function loadParityReport({ framework, parityDir = DEFAULT_PARITY_DIR }) {
  const name = reportNameForFramework(framework);
  const file = path.join(parityDir, `${name}.json`);
  const report = readJson(file);
  return { file, report };
}

function normalizeVerdict(v) {
  return String(v || '').toLowerCase();
}

function admittedEntries(result) {
  const out = [];
  for (const a of (result && result.admitted) || []) {
    out.push({
      runResultId: a.runResultId,
      testCaseId: a.testCaseId,
      expectedVerdict: normalizeVerdict(a.expectedVerdict || a.status),
      irHash: a.irHash || null,
      requirementRefs: Array.isArray(a.requirementRefs) ? a.requirementRefs : [],
      authProfile: a.authProfile || null,
      dataBinding: a.dataBinding || null,
      dataRowsUsed: a.dataRowsUsed === true,
      files: Array.isArray(a.files) ? a.files : (a.filePath ? [a.filePath] : []),
    });
  }
  return out;
}

function approvedDataBinding(binding) {
  return !!(binding
    && typeof binding === 'object'
    && binding.testDataSetId
    && binding.mappingId
    && (binding.mappingVersion || binding.mappingVersion === 0));
}

function assessReplayExport({ project, result, framework, parityDir = DEFAULT_PARITY_DIR, requireExecutionParity = true }) {
  const findings = [];
  const adapterId = (result && result.adapterId) || framework || null;
  const manifest = result && result.manifest;
  const admitted = admittedEntries(result);
  const evidence = {
    enterpriseMode: true,
    projectId: project && project.id || null,
    framework: adapterId,
    runId: result && result.runId || manifest && manifest.runId || null,
    admittedRunResultIds: admitted.map((e) => e.runResultId),
    parityReport: null,
    parityEntries: [],
  };

  if (!manifest) {
    findings.push(error('enterprise_manifest_missing', 'ReplayIR export did not produce EXPORT_MANIFEST evidence.'));
  } else {
    if (manifest.exportValid !== true) findings.push(error('enterprise_export_invalid', 'EXPORT_MANIFEST.exportValid is not true.', { exportValid: manifest.exportValid }));
    if (manifest.allBlocked) findings.push(error('enterprise_all_blocked', 'Every selected result was blocked; no enterprise ZIP may ship.'));
    const validation = manifest.validation || {};
    if (validation.checked !== true) findings.push(error('enterprise_package_validation_missing', 'Package validation was not executed in the export path.'));
    else if (validation.packagePassed !== true) findings.push(error('enterprise_package_validation_failed', 'Package validation did not pass.', { validation }));
    if (Array.isArray(manifest.secretFindings) && manifest.secretFindings.length) {
      findings.push(error('enterprise_secret_findings', 'Secret findings are present in the export manifest.', { secretFindings: manifest.secretFindings }));
    }
  }

  if (!admitted.length) {
    findings.push(error('enterprise_no_admitted_results', 'No RunResult was admitted into the ReplayIR export.'));
  }

  const blocked = Array.isArray(result && result.blocked) ? result.blocked : [];
  if (blocked.length) {
    findings.push(error(
      'enterprise_export_blocked_results',
      `${blocked.length} selected RunResult(s) were blocked by export; Enterprise Mode refuses partial ZIPs.`,
      { blocked: blocked.map((b) => ({ runResultId: b.runResultId, testCaseId: b.testCaseId, code: b.code, detail: b.detail })) }
    ));
  }

  for (const a of admitted) {
    if (!Array.isArray(a.requirementRefs) || a.requirementRefs.length === 0) {
      findings.push(error('enterprise_requirement_refs_missing', `RunResult ${a.runResultId} has no requirementRefs on its TestCase.`, { runResultId: a.runResultId, testCaseId: a.testCaseId }));
    }
    if (!a.authProfile) {
      findings.push(error('enterprise_auth_profile_missing', `RunResult ${a.runResultId} has no first-class AuthProfile on its TestCase.`, { runResultId: a.runResultId, testCaseId: a.testCaseId }));
    }
    if ((a.dataRowsUsed || a.dataBinding) && !approvedDataBinding(a.dataBinding)) {
      findings.push(error('enterprise_testdata_mapping_unapproved', `RunResult ${a.runResultId} uses TestData but is not pinned to an approved TestDataMapping version.`, { runResultId: a.runResultId, testCaseId: a.testCaseId, dataBinding: a.dataBinding || null, dataRowsUsed: a.dataRowsUsed }));
    }
  }

  if (requireExecutionParity) {
    const { file, report } = loadParityReport({ framework: adapterId, parityDir });
    evidence.parityReport = file;
    if (!report) {
      findings.push(error('enterprise_parity_report_missing', `No P8 execution-parity report found for ${adapterId}.`, { file }));
    } else {
      if (report.framework !== adapterId) findings.push(error('enterprise_parity_framework_mismatch', `P8 report framework '${report.framework}' does not match export '${adapterId}'.`, { file }));
      const byId = new Map(((report && report.entries) || []).map((e) => [e.runResultId, e]));
      for (const a of admitted) {
        const entry = byId.get(a.runResultId);
        if (!entry) {
          findings.push(error('enterprise_parity_entry_missing', `No P8 parity entry for RunResult ${a.runResultId}.`, { runResultId: a.runResultId, file }));
          continue;
        }
        evidence.parityEntries.push({
          runResultId: entry.runResultId,
          irHash: entry.irHash || null,
          mcpVerdict: entry.mcpVerdict,
          runnerVerdict: entry.runnerVerdict,
          matched: entry.matched,
          eligible: entry.eligible,
          provenance: entry.provenance,
        });
        if (entry.framework !== adapterId) findings.push(error('enterprise_parity_entry_framework_mismatch', `RunResult ${a.runResultId} parity entry framework does not match export.`, { runResultId: a.runResultId, entryFramework: entry.framework, adapterId }));
        if (!a.irHash) findings.push(error('enterprise_export_ir_hash_missing', `RunResult ${a.runResultId} export entry has no ReplayIR hash.`, { runResultId: a.runResultId }));
        if (!entry.irHash) findings.push(error('enterprise_parity_ir_hash_missing', `RunResult ${a.runResultId} parity entry has no ReplayIR hash.`, { runResultId: a.runResultId, file }));
        if (a.irHash && entry.irHash && entry.irHash !== a.irHash) findings.push(error('enterprise_parity_ir_hash_mismatch', `RunResult ${a.runResultId} parity proof is stale: ReplayIR hash changed after parity ran.`, { runResultId: a.runResultId, exportIrHash: a.irHash, parityIrHash: entry.irHash }));
        if (normalizeVerdict(entry.mcpVerdict) !== a.expectedVerdict) findings.push(error('enterprise_parity_verdict_mismatch', `RunResult ${a.runResultId} MCP verdict does not match export expected verdict.`, { runResultId: a.runResultId, reportVerdict: entry.mcpVerdict, expectedVerdict: a.expectedVerdict }));
        if (entry.eligible !== true) findings.push(error('enterprise_parity_not_eligible', `RunResult ${a.runResultId} is not parity-eligible.`, { runResultId: a.runResultId, reason: entry.reason }));
        if (entry.matched !== true) findings.push(error('enterprise_parity_not_matched', `RunResult ${a.runResultId} did not match MCP verdict in clean-env execution.`, { runResultId: a.runResultId, runnerVerdict: entry.runnerVerdict, reason: entry.reason }));
        if (entry.provenance !== 'real') findings.push(error('enterprise_parity_not_real', `RunResult ${a.runResultId} parity proof is not from a real captured trace.`, { runResultId: a.runResultId, provenance: entry.provenance }));
      }
    }
  }

  return {
    ok: findings.filter((f) => f.severity === 'error').length === 0,
    findings,
    evidence,
  };
}

module.exports = {
  DEFAULT_PARITY_DIR,
  FRAMEWORK_TO_REPORT,
  isEnterpriseMode,
  readProjectEnterpriseMode,
  writeProjectEnterpriseMode,
  attachProjectEnterpriseMode,
  attachProjectsEnterpriseMode,
  reportNameForFramework,
  loadParityReport,
  assessReplayExport,
  approvedDataBinding,
};
