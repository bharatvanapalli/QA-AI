'use strict';

const crypto = require('crypto');
const runner = require('./scriptValidationRunner');
const replayExport = require('./codegen/replayExport');
const scriptBundleStore = require('./scriptBundleStore');
let prisma = null;
try { prisma = require('../prisma'); } catch (_) { prisma = null; }

const SCRIPT_VALIDATION_AGENT_SCHEMA = 'qaai-script-validation-agent/1';
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_JOBS = 100;

const jobs = new Map();
const queue = [];
let activeCount = 0;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value == null ? '' : String(value)).digest('hex');
}

async function persistReplayIrCertifications({ report = null, manifest = null, files = {}, prismaClient = prisma } = {}) {
  if (!prismaClient || !prismaClient.replayIRCertification) return { written: 0, skipped: true };
  const artifacts = Array.isArray(manifest && (manifest.scriptArtifacts || manifest.artifacts))
    ? (manifest.scriptArtifacts || manifest.artifacts)
    : [];
  const replayArtifacts = artifacts.filter((artifact) => artifact && artifact.source === 'replayir' && artifact.runResultId);
  if (!replayArtifacts.length) return { written: 0, skipped: false };
  const certified = !!(report && report.certification && report.certification.certified);
  const roundTrip = report && report.roundTripParity || report && report.roundTrip || null;
  const findings = [
    ...((Array.isArray(report?.failures) ? report.failures : []).map((failure) => ({ rule: 'script_validation_failure', ...failure }))),
    ...((Array.isArray(roundTrip?.findings) ? roundTrip.findings : [])),
  ];
  const replayHash = files['evidence/replayir.json'] ? sha256(files['evidence/replayir.json']) : null;
  const actionHash = files['evidence/action-evidence.json'] ? sha256(files['evidence/action-evidence.json']) : null;
  let written = 0;
  for (const artifact of replayArtifacts) {
    if (prismaClient.runResult && typeof prismaClient.runResult.findUnique === 'function') {
      const existingRunResult = await prismaClient.runResult.findUnique({
        where: { id: String(artifact.runResultId) },
        select: { id: true },
      });
      if (!existingRunResult) continue;
    }
    await prismaClient.replayIRCertification.create({
      data: {
        runResultId: String(artifact.runResultId),
        testCaseId: artifact.testCaseId ? String(artifact.testCaseId) : null,
        replayIrHash: replayHash,
        actionEvidenceHash: actionHash,
        certificationStatus: certified ? 'certified' : 'uncertified',
        certificationFindings: findings.length ? JSON.stringify(findings.slice(0, 50)) : null,
        certifiedAt: certified ? new Date() : null,
      },
    });
    written += 1;
  }
  return { written, skipped: false };
}

function cloneJob(job) {
  if (!job) return null;
  return {
    schema: SCRIPT_VALIDATION_AGENT_SCHEMA,
    id: job.id,
    projectId: job.projectId || null,
    bundleId: job.bundleId || null,
    runId: job.runId || null,
    framework: job.framework || null,
    mode: job.mode || 'auto_after_generation',
    status: job.status,
    reason: job.reason || null,
    queuedAt: job.queuedAt || null,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
    reportId: job.report?.id || null,
    summary: job.report?.summary || job.summary || null,
    failures: Array.isArray(job.report?.failures) ? job.report.failures : (job.failures || []),
    certification: job.report?.certification || null,
    manifest: job.manifest || null,
    error: job.error || null,
  };
}

function pruneJobs(maxJobs = DEFAULT_MAX_JOBS) {
  if (jobs.size <= maxJobs) return;
  const removable = [...jobs.values()]
    .filter((job) => ['certified', 'healed', 'failed', 'preview_only', 'cancelled'].includes(job.status))
    .sort((a, b) => String(a.completedAt || a.queuedAt).localeCompare(String(b.completedAt || b.queuedAt)));
  while (jobs.size > maxJobs && removable.length) {
    jobs.delete(removable.shift().id);
  }
}

function emit(job, event, payload = {}) {
  try {
    if (typeof job.onEvent === 'function') {
      job.onEvent({
        type: event,
        job: cloneJob(job),
        projectId: job.projectId || null,
        runId: job.runId || null,
        bundleId: job.bundleId || null,
        ...payload,
      });
    }
  } catch (_) {
    // Validation status broadcasting must never fail the job.
  }
}

async function execute(job) {
  activeCount += 1;
  job.status = 'running';
  job.startedAt = nowIso();
  emit(job, 'output.scriptValidationRunning');
  try {
    if (typeof job.resolveBundle === 'function') {
      const resolved = await job.resolveBundle(job);
      if (resolved && typeof resolved === 'object') {
        job.files = resolved.files || job.files || {};
        job.bundleId = runner.safeId(resolved.bundleId || job.bundleId, 'bundle');
        job.framework = resolved.framework || job.framework;
        job.manifest = resolved.manifest || job.manifest || null;
        job.reason = resolved.reason || job.reason || null;
      }
    }
    const runImpl = job.runScriptValidation || runner.runScriptValidation;
    const report = await runImpl({
      projectId: job.projectId,
      bundleId: job.bundleId,
      framework: job.framework,
      files: job.files || {},
      mode: job.mode,
      scopedEnv: job.scopedEnv || {},
      testFile: job.testFile || null,
      testTitle: job.testTitle || null,
      timeoutMs: job.timeoutMs,
      artifactRoot: job.artifactRoot,
      execFileImpl: job.execFileImpl,
    });
    if (report && typeof report === 'object') report.apiJobId = job.id;
    job.report = report;
    const updatedBundle = scriptBundleStore.applyValidationReport({
      projectId: job.projectId,
      bundleId: report?.bundleId || job.bundleId,
      framework: report?.framework || job.framework,
      report,
      ...(job.bundleStoreRoot ? { storeRoot: job.bundleStoreRoot } : {}),
    });
    job.manifest = updatedBundle && updatedBundle.metadata && updatedBundle.metadata.manifest
      || updatedBundle && updatedBundle.manifest
      || job.manifest
      || null;
    try {
      await persistReplayIrCertifications({
        report,
        manifest: job.manifest,
        files: job.files || {},
        prismaClient: job.prisma || prisma,
      });
    } catch (certErr) {
      job.certificationPersistenceError = String(certErr && certErr.message || certErr);
    }
    if (String(report?.status || '').toLowerCase() === 'certified'
      && updatedBundle
      && job.manifest
      && job.manifest.certified !== true) {
      job.status = 'validation_passed_uncertified';
      job.reason = job.manifest.certificationBlockedReason || 'strict_replayir_required';
    } else {
      job.status = report?.status || 'failed';
      job.reason = report?.reason || null;
    }
    job.completedAt = nowIso();
    emit(job, 'output.scriptValidationComplete', {
      status: job.status,
      summary: report?.summary || null,
      failures: report?.failures || [],
      jobId: report?.id || job.id,
      report,
    });
  } catch (err) {
    job.status = 'failed';
    job.reason = 'script_validation_agent_error';
    job.error = String(err && err.message || err);
    job.completedAt = nowIso();
    emit(job, 'output.scriptValidationComplete', {
      status: 'failed',
      summary: { total: 0, passed: 0, failed: 1, skipped: 0 },
      failures: [{
        id: crypto.createHash('sha1').update(job.error).digest('hex').slice(0, 16),
        testTitle: 'Script validation agent',
        file: null,
        line: 1,
        error: job.error,
        repairAvailable: false,
      }],
      jobId: job.id,
    });
  } finally {
    activeCount = Math.max(0, activeCount - 1);
    drain();
  }
}

function drain() {
  while (activeCount < DEFAULT_MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    setImmediate(() => execute(job));
  }
}

function enqueueScriptValidation(input = {}) {
  if (!input.projectId) {
    const err = new Error('script_validation_project_required');
    err.code = 'SCRIPT_VALIDATION_PROJECT_REQUIRED';
    throw err;
  }
  const job = {
    id: input.id || newId(),
    projectId: input.projectId,
    bundleId: runner.safeId(input.bundleId, 'bundle'),
    runId: input.runId || null,
    framework: input.framework || 'playwright-reference',
    files: input.files || {},
    mode: input.mode || 'auto_after_generation',
    scopedEnv: input.scopedEnv || {},
    testFile: input.testFile || null,
    testTitle: input.testTitle || null,
    timeoutMs: input.timeoutMs,
    artifactRoot: input.artifactRoot,
    bundleStoreRoot: input.bundleStoreRoot,
    prisma: input.prisma || null,
    execFileImpl: input.execFileImpl,
    runScriptValidation: input.runScriptValidation,
    resolveBundle: input.resolveBundle,
    onEvent: input.onEvent,
    status: 'queued',
    queuedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    reason: null,
    report: null,
    error: null,
  };
  jobs.set(job.id, job);
  queue.push(job);
  pruneJobs();
  emit(job, 'output.scriptValidationQueued');
  drain();
  return cloneJob(job);
}

function enqueueReplayIrRunValidation(input = {}) {
  if (!input.runId) {
    const err = new Error('script_validation_run_required');
    err.code = 'SCRIPT_VALIDATION_RUN_REQUIRED';
    throw err;
  }
  const requestedFramework = input.framework || 'playwright-reference';
  return enqueueScriptValidation({
    ...input,
    bundleId: input.bundleId || input.runId,
    framework: requestedFramework,
    mode: input.mode || 'auto_after_generation',
    resolveBundle: async () => {
      const result = await replayExport.buildReplayExport({
        projectId: input.projectId,
        runId: input.runId,
        framework: requestedFramework,
        validate: true,
        allowIncompletePreview: true,
      });
      const effectiveBundleId = runner.safeId(result.runId || input.runId, 'bundle');
      const effectiveFramework = result.adapterId || requestedFramework;
      const stored = scriptBundleStore.ensureBundle({
        projectId: input.projectId,
        bundleId: effectiveBundleId,
        framework: effectiveFramework,
        files: result.files || {},
        manifest: result.manifest || null,
      });
      return {
        files: stored.files || result.files || {},
        bundleId: effectiveBundleId,
        framework: effectiveFramework,
        manifest: result.manifest || null,
        reason: result.allBlocked ? 'replayir_export_preview_only' : null,
      };
    },
  });
}

function getJob(id) {
  return cloneJob(jobs.get(String(id || '')));
}

function listJobs(filter = {}) {
  return [...jobs.values()]
    .filter((job) => !filter.projectId || job.projectId === filter.projectId)
    .filter((job) => !filter.bundleId || job.bundleId === filter.bundleId)
    .map(cloneJob)
    .sort((a, b) => String(b.queuedAt || '').localeCompare(String(a.queuedAt || '')));
}

function resetForTests() {
  jobs.clear();
  queue.splice(0, queue.length);
  activeCount = 0;
}

module.exports = {
  SCRIPT_VALIDATION_AGENT_SCHEMA,
  enqueueScriptValidation,
  enqueueReplayIrRunValidation,
  getJob,
  listJobs,
  persistReplayIrCertifications,
  resetForTests,
};
