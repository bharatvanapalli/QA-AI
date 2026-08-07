'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const runner = require('./scriptValidationRunner');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BUNDLE_ROOT = path.join(REPO_ROOT, 'playwright', 'output-bundles');
const BUNDLE_SCHEMA = 'qaai-script-bundle/1';
const REPAIR_JOURNAL_SCHEMA = 'qaai-script-repair-journal/1';

function nowIso() {
  return new Date().toISOString();
}

function bundleDir({ storeRoot = DEFAULT_BUNDLE_ROOT, projectId, bundleId, framework }) {
  return path.join(
    storeRoot,
    runner.safeId(projectId, 'project'),
    runner.safeId(bundleId, 'bundle'),
    runner.safeId(framework || 'framework', 'framework')
  );
}

function filesDir(params) {
  return path.join(bundleDir(params), 'files');
}

function metadataPath(params) {
  return path.join(bundleDir(params), 'bundle-manifest.json');
}

function journalPath(params) {
  return path.join(bundleDir(params), 'repair-journal.json');
}

function readJsonSafe(full, fallback = null) {
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(full, value) {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function safeFull(root, rel) {
  const clean = runner.safeRelPath(rel);
  if (!clean) return null;
  const full = path.join(root, clean);
  const resolved = path.resolve(full);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return { clean, full: resolved };
}

function writeFileMap(root, files = {}) {
  fs.mkdirSync(root, { recursive: true });
  const written = [];
  for (const [rel, content] of Object.entries(files || {})) {
    const target = safeFull(root, rel);
    if (!target) continue;
    fs.mkdirSync(path.dirname(target.full), { recursive: true });
    fs.writeFileSync(target.full, Buffer.isBuffer(content) ? content : String(content || ''), Buffer.isBuffer(content) ? undefined : 'utf8');
    written.push(target.clean);
  }
  return written;
}

function isBinaryRel(rel) {
  return /\.(?:xlsx|png|jpe?g|zip|webm|mp4|pdf)$/i.test(String(rel || ''));
}

function readFileMap(root) {
  const files = {};
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    let entries;
    const cur = stack.pop();
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      files[rel] = isBinaryRel(rel) ? fs.readFileSync(full) : fs.readFileSync(full, 'utf8');
    }
  }
  return files;
}

function readJournal(params) {
  return readJsonSafe(journalPath(params), {
    schema: REPAIR_JOURNAL_SCHEMA,
    projectId: params.projectId || null,
    bundleId: params.bundleId || null,
    framework: params.framework || null,
    repairs: [],
  });
}

function writeJournal(params, journal) {
  writeJson(journalPath(params), {
    schema: REPAIR_JOURNAL_SCHEMA,
    projectId: params.projectId || null,
    bundleId: params.bundleId || null,
    framework: params.framework || null,
    repairs: Array.isArray(journal && journal.repairs) ? journal.repairs : [],
  });
}

function readBundle(params) {
  const meta = readJsonSafe(metadataPath(params), null);
  if (!meta) return null;
  const files = readFileMap(filesDir(params));
  const journal = readJournal(params);
  if (journal.repairs.length) {
    files['evidence/script-repair-journal.json'] = JSON.stringify(journal, null, 2) + '\n';
  }
  return {
    schema: BUNDLE_SCHEMA,
    metadata: meta,
    files,
    journal,
    fileCount: Object.keys(files).length,
    currentHash: runner.hashFiles(files),
  };
}

function resetBundle(params, files, metadata) {
  const dir = bundleDir(params);
  const root = filesDir(params);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const written = writeFileMap(root, files);
  writeJson(metadataPath(params), metadata);
  writeJournal(params, { repairs: [] });
  return written;
}

function ensureBundle({ projectId, bundleId, framework, files = {}, manifest = null, storeRoot = DEFAULT_BUNDLE_ROOT } = {}) {
  const params = { projectId, bundleId: runner.safeId(bundleId, 'bundle'), framework, storeRoot };
  const sourceHash = runner.hashFiles(files);
  const existing = readBundle(params);
  if (existing && existing.metadata && existing.metadata.sourceHash === sourceHash) {
    return { ...existing, created: false };
  }
  if (existing && existing.journal && existing.journal.repairs && existing.journal.repairs.length > 0) {
    return {
      ...existing,
      created: false,
      staleSource: existing.metadata.sourceHash !== sourceHash,
      sourceHash,
    };
  }

  const metadata = {
    schema: BUNDLE_SCHEMA,
    projectId: projectId || null,
    bundleId: params.bundleId,
    framework: framework || null,
    sourceHash,
    currentHash: sourceHash,
    manifest: manifest || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    repairCount: 0,
  };
  resetBundle(params, files, metadata);
  const bundle = readBundle(params);
  return { ...bundle, created: true };
}

function findFailure(report, failureId) {
  const failures = Array.isArray(report && report.failures) ? report.failures : [];
  return failures.find((f) => String(f.id || '') === String(failureId || '')) || null;
}

function repairEntryHash(entry) {
  return crypto.createHash('sha256')
    .update([entry.file, entry.line, entry.beforeHash, entry.afterHash, entry.reason].join('\0'))
    .digest('hex');
}

function patchBundleFile({
  projectId,
  bundleId,
  framework,
  file,
  line = null,
  after,
  expectedBefore = null,
  reason = 'script repair',
  failure = null,
  repairedBy = 'qaai_script_repair',
  storeRoot = DEFAULT_BUNDLE_ROOT,
} = {}) {
  const params = { projectId, bundleId: runner.safeId(bundleId, 'bundle'), framework, storeRoot };
  const bundle = readBundle(params);
  if (!bundle) {
    const err = new Error('script_bundle_not_found');
    err.code = 'SCRIPT_BUNDLE_NOT_FOUND';
    throw err;
  }
  const root = filesDir(params);
  const target = safeFull(root, file);
  if (!target) {
    const err = new Error('script_bundle_path_denied');
    err.code = 'SCRIPT_BUNDLE_PATH_DENIED';
    throw err;
  }
  if (!fs.existsSync(target.full)) {
    const err = new Error('script_bundle_file_not_found');
    err.code = 'SCRIPT_BUNDLE_FILE_NOT_FOUND';
    throw err;
  }
  if (after == null || typeof after !== 'string') {
    const err = new Error('script_repair_after_required');
    err.code = 'SCRIPT_REPAIR_AFTER_REQUIRED';
    throw err;
  }
  const before = fs.readFileSync(target.full, 'utf8');
  if (expectedBefore != null && String(expectedBefore) !== before) {
    const err = new Error('script_repair_stale_file');
    err.code = 'SCRIPT_REPAIR_STALE_FILE';
    throw err;
  }
  fs.writeFileSync(target.full, after, 'utf8');

  const repairedFiles = readFileMap(root);
  const journal = readJournal(params);
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    file: target.clean,
    line: line == null ? null : Number(line),
    beforeHash: runner.hashFiles({ [target.clean]: before }),
    afterHash: runner.hashFiles({ [target.clean]: after }),
    reason,
    repairedBy,
    failureId: failure && failure.id || null,
    failureError: failure && failure.error || null,
    testTitle: failure && failure.testTitle || null,
    repairedAt: nowIso(),
  };
  entry.hash = repairEntryHash(entry);
  journal.repairs = [...(journal.repairs || []), entry];
  writeJournal(params, journal);

  const meta = readJsonSafe(metadataPath(params), {});
  meta.updatedAt = nowIso();
  meta.currentHash = runner.hashFiles(repairedFiles);
  meta.repairCount = journal.repairs.length;
  meta.lastRepairAt = entry.repairedAt;
  writeJson(metadataPath(params), meta);

  repairedFiles['evidence/script-repair-journal.json'] = JSON.stringify(journal, null, 2) + '\n';
  return {
    bundle: readBundle(params),
    repair: entry,
    before,
    after,
    journal,
  };
}

function createBundleFile({
  projectId,
  bundleId,
  framework,
  file,
  content,
  reason = 'assistant created generated output file',
  repairedBy = 'qaai_output_assistant_create_file',
  overwrite = false,
  storeRoot = DEFAULT_BUNDLE_ROOT,
} = {}) {
  const params = { projectId, bundleId: runner.safeId(bundleId, 'bundle'), framework, storeRoot };
  const bundle = readBundle(params);
  if (!bundle) {
    const err = new Error('script_bundle_not_found');
    err.code = 'SCRIPT_BUNDLE_NOT_FOUND';
    throw err;
  }
  const root = filesDir(params);
  const target = safeFull(root, file);
  if (!target) {
    const err = new Error('script_bundle_path_denied');
    err.code = 'SCRIPT_BUNDLE_PATH_DENIED';
    throw err;
  }
  if (fs.existsSync(target.full) && !overwrite) {
    const err = new Error('script_bundle_file_exists');
    err.code = 'SCRIPT_BUNDLE_FILE_EXISTS';
    throw err;
  }
  if (content == null || typeof content !== 'string' || !content.trim()) {
    const err = new Error('script_create_content_required');
    err.code = 'SCRIPT_CREATE_CONTENT_REQUIRED';
    throw err;
  }
  fs.mkdirSync(path.dirname(target.full), { recursive: true });
  const before = fs.existsSync(target.full) ? fs.readFileSync(target.full, 'utf8') : '';
  fs.writeFileSync(target.full, content, 'utf8');

  const repairedFiles = readFileMap(root);
  const journal = readJournal(params);
  const entry = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    file: target.clean,
    line: null,
    beforeHash: before ? runner.hashFiles({ [target.clean]: before }) : null,
    afterHash: runner.hashFiles({ [target.clean]: content }),
    reason,
    repairedBy,
    failureId: null,
    failureError: null,
    testTitle: null,
    repairedAt: nowIso(),
  };
  entry.hash = repairEntryHash(entry);
  journal.repairs = [...(journal.repairs || []), entry];
  writeJournal(params, journal);

  const meta = readJsonSafe(metadataPath(params), {});
  meta.updatedAt = nowIso();
  meta.currentHash = runner.hashFiles(repairedFiles);
  meta.repairCount = journal.repairs.length;
  meta.lastRepairAt = entry.repairedAt;
  writeJson(metadataPath(params), meta);

  repairedFiles['evidence/script-repair-journal.json'] = JSON.stringify(journal, null, 2) + '\n';
  return {
    bundle: readBundle(params),
    repair: entry,
    before,
    after: content,
    journal,
  };
}

function validationStatus(report) {
  const status = String(report && report.status || '').toLowerCase();
  const certified = !!(report && report.certification && report.certification.certified)
    || status === 'certified'
    || status === 'healed';
  if (certified) return { scriptRunStatus: 'passed', certificationStatus: 'certified' };
  if (status === 'passed') return { scriptRunStatus: 'passed', certificationStatus: 'uncertified' };
  if (status === 'failed') return { scriptRunStatus: 'failed', certificationStatus: 'uncertified' };
  if (status === 'preview_only') return { scriptRunStatus: 'skipped', certificationStatus: 'uncertified' };
  return { scriptRunStatus: 'not_run', certificationStatus: 'uncertified' };
}

function artifactIsStrictReplayArtifact(artifact) {
  return !!artifact
    && artifact.source === 'replayir'
    && artifact.scriptGenerationStatus === 'generated';
}

function strictReplayArtifactFindings(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  if (!list.length) {
    return [{
      rule: 'strict_export_no_script_artifacts',
      severity: 'error',
      message: 'Certification requires at least one script artifact sourced from complete browser-captured ReplayIR.',
    }];
  }
  return list
    .filter((artifact) => !artifactIsStrictReplayArtifact(artifact))
    .map((artifact) => ({
      rule: 'strict_export_non_replayir_artifact',
      severity: 'error',
      testCaseId: artifact && artifact.testCaseId || null,
      runResultId: artifact && artifact.runResultId || null,
      file: artifact && artifact.file || null,
      source: artifact && artifact.source || null,
      scriptGenerationStatus: artifact && artifact.scriptGenerationStatus || null,
      message: 'Certification requires generated artifacts sourced from complete browser-captured ReplayIR. Draft, partial, TestCase-contract, helper, and skeleton artifacts remain visible but uncertified.',
    }));
}

function reportFailureFiles(report) {
  const out = new Set();
  for (const failure of Array.isArray(report && report.failures) ? report.failures : []) {
    const file = failure && (failure.file || failure.path || failure.relPath);
    if (file) out.add(String(file).replace(/\\/g, '/'));
  }
  return out;
}

function artifactIsFailed(artifact, failureFiles) {
  if (!artifact || !failureFiles || !failureFiles.size) return false;
  const file = String(artifact.file || '').replace(/\\/g, '/');
  if (file && failureFiles.has(file)) return true;
  const related = Array.isArray(artifact.files) ? artifact.files : [];
  return related.some((rel) => failureFiles.has(String(rel || '').replace(/\\/g, '/')));
}

function updateStatusJson(root, rel, updater) {
  const target = safeFull(root, rel);
  if (!target) return;
  const current = readJsonSafe(target.full, {});
  const next = updater(current && typeof current === 'object' ? current : {});
  fs.mkdirSync(path.dirname(target.full), { recursive: true });
  fs.writeFileSync(target.full, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function readStoredManifest(root, meta) {
  const metaManifest = meta && meta.manifest && typeof meta.manifest === 'object' ? meta.manifest : null;
  const exportManifestTarget = safeFull(root, 'EXPORT_MANIFEST.json');
  const exportManifest = exportManifestTarget ? readJsonSafe(exportManifestTarget.full, null) : null;
  const liveStatusTarget = safeFull(root, 'evidence/live-output-status.json');
  const liveStatus = liveStatusTarget ? readJsonSafe(liveStatusTarget.full, null) : null;
  return {
    ...(exportManifest && typeof exportManifest === 'object' ? exportManifest : {}),
    ...(liveStatus && typeof liveStatus === 'object' && Array.isArray(liveStatus.artifacts) && !Array.isArray(exportManifest && exportManifest.artifacts)
      ? { artifacts: liveStatus.artifacts, scriptArtifacts: liveStatus.artifacts }
      : {}),
    ...(metaManifest || {}),
  };
}

function applyValidationReport({
  projectId,
  bundleId,
  framework,
  report,
  storeRoot = DEFAULT_BUNDLE_ROOT,
} = {}) {
  const params = { projectId, bundleId: runner.safeId(bundleId, 'bundle'), framework, storeRoot };
  const bundle = readBundle(params);
  if (!bundle) return null;

  const root = filesDir(params);
  const meta = readJsonSafe(metadataPath(params), {}) || {};
  const manifest = readStoredManifest(root, meta);
  const existingArtifacts = Array.isArray(manifest.artifacts)
    ? manifest.artifacts
    : (Array.isArray(manifest.scriptArtifacts) ? manifest.scriptArtifacts : []);
  const status = validationStatus(report);
  const failedFiles = reportFailureFiles(report);
  const strictFindings = strictReplayArtifactFindings(existingArtifacts);
  const packageStrictReplayEligible = status.certificationStatus === 'certified' && strictFindings.length === 0;
  const certifiedAt = packageStrictReplayEligible ? nowIso() : null;
  const reportSummary = report && report.summary && typeof report.summary === 'object'
    ? report.summary
    : {};
  const packagePassed =
    status.scriptRunStatus === 'passed' &&
    Number(reportSummary.total || 0) > 0 &&
    Number(reportSummary.failed || 0) === 0;
  const artifacts = existingArtifacts.map((artifact) => {
    const failed = artifactIsFailed(artifact, failedFiles);
    const artifactCertified = packageStrictReplayEligible && !failed;
    return {
      ...artifact,
      scriptRunStatus: failed ? 'failed' : status.scriptRunStatus,
      certificationStatus: artifactCertified ? 'certified' : 'uncertified',
      ...(certifiedAt && artifactCertified ? { certifiedAt } : {}),
      ...(failed && report && report.id ? { lastValidationReportId: report.id } : {}),
    };
  });
  const hasArtifactFailures = artifacts.some((artifact) => artifact && artifact.scriptRunStatus === 'failed');
  const exportCertified = packageStrictReplayEligible && !hasArtifactFailures;

  manifest.artifacts = artifacts;
  manifest.scriptArtifacts = artifacts;
  manifest.strictExport = {
    required: false,
    diagnosticsOnly: true,
    ok: strictFindings.length === 0,
    findingCount: strictFindings.length,
    rules: [...new Set(strictFindings.map((finding) => finding.rule).filter(Boolean))],
  };
  manifest.strictExportFindings = strictFindings;
  manifest.scriptValidation = {
    id: report && report.id || null,
    apiJobId: report && report.apiJobId || null,
    status: report && report.status || null,
    reason: report && report.reason || null,
    summary: report && report.summary || null,
    roundTripValidation: report && report.roundTripValidation || null,
    certification: report && report.certification || null,
    completedAt: report && report.completedAt || nowIso(),
  };
  manifest.outputAvailable = true;
  manifest.downloadable = true;
  manifest.packagePassed = packagePassed;
  manifest.exportValid = packagePassed;
  manifest.runnable = packagePassed;
  manifest.verified = packagePassed;
  manifest.certified = exportCertified;
  manifest.scriptRunStatus = status.scriptRunStatus;
  manifest.packageValidationStatus = packagePassed
    ? 'passed'
    : status.scriptRunStatus === 'failed'
      ? 'failed'
      : status.scriptRunStatus;
  if (exportCertified) {
    manifest.certifiedAt = certifiedAt;
  } else if (status.certificationStatus === 'certified') {
    manifest.certificationBlockedReason = 'strict_replayir_required';
  }
  const priorReadiness = manifest.readiness && typeof manifest.readiness === 'object'
    ? manifest.readiness
    : {};
  const priorScriptReadiness = priorReadiness.script && typeof priorReadiness.script === 'object'
    ? priorReadiness.script
    : {};
  const ran = ['passed', 'failed'].includes(status.scriptRunStatus);
  const resolvedRuntimeGaps = new Set([
    'export_not_validated',
    'package_not_passed',
    'script_not_run',
    'script_run_failed',
  ]);
  manifest.readiness = {
    ...priorReadiness,
    available: true,
    downloadable: true,
    generated: true,
    verified: packagePassed,
    runnable: packagePassed,
    certified: exportCertified,
    script: {
      ...priorScriptReadiness,
      status: status.scriptRunStatus,
      total: Number(reportSummary.total || 0),
      failed: Number(reportSummary.failed || 0),
      ran,
      runPassed: packagePassed,
      passed: packagePassed,
      certified: exportCertified,
      bundleMatches: ran,
      packageHashMatches: ran,
      current: ran,
      qualityPassed: packagePassed,
    },
    gaps: (Array.isArray(priorReadiness.gaps) ? priorReadiness.gaps : []).filter(
      (gap) => !(packagePassed && resolvedRuntimeGaps.has(String(gap))),
    ),
  };

  updateStatusJson(root, 'EXPORT_MANIFEST.json', (current) => ({
    ...current,
    ...manifest,
  }));
  updateStatusJson(root, 'evidence/live-output-status.json', (current) => ({
    ...current,
    outputAvailable: true,
    downloadable: true,
    exportValid: packagePassed,
    packagePassed,
    packageValidationStatus: manifest.packageValidationStatus,
    runnable: packagePassed,
    verified: packagePassed,
    certified: exportCertified,
    readiness: manifest.readiness,
    artifacts,
    scriptArtifacts: artifacts,
    scriptValidation: manifest.scriptValidation,
    status: exportCertified
      ? 'certified'
      : (packagePassed
        ? 'validation_passed_uncertified'
        : report && report.status === 'failed'
        ? 'validation_failed'
        : (status.certificationStatus === 'certified' ? 'validation_passed_uncertified' : current.status || 'generated_draft')),
    certificationStatus: exportCertified ? 'certified' : 'uncertified',
    scriptRunStatus: status.scriptRunStatus,
    certifiedAt: certifiedAt || current.certifiedAt || null,
    roundTripValidation: report && report.roundTripValidation || current.roundTripValidation || null,
    strictExport: manifest.strictExport,
    strictExportFindings: strictFindings,
  }));

  const files = readFileMap(root);
  meta.manifest = manifest;
  meta.updatedAt = nowIso();
  meta.currentHash = runner.hashFiles(files);
  writeJson(metadataPath(params), meta);
  return readBundle(params);
}

module.exports = {
  BUNDLE_SCHEMA,
  REPAIR_JOURNAL_SCHEMA,
  DEFAULT_BUNDLE_ROOT,
  bundleDir,
  filesDir,
  metadataPath,
  journalPath,
  readBundle,
  ensureBundle,
  applyValidationReport,
  patchBundleFile,
  createBundleFile,
  findFailure,
  readJournal,
};
