import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jobs from '../../server/services/reliability/jobs.js';

const storeFile = path.join(os.tmpdir(), `qaai-reliability-jobs-${process.pid}.json`);

describe('scenario generation reliability jobs', () => {
  beforeEach(() => {
    try { fs.rmSync(storeFile, { force: true }); } catch (_) {}
    jobs.configureScenarioGenerationJobStore({ filePath: storeFile, persist: true });
    jobs.clearScenarioGenerationJobsForTest();
  });

  it('supports queued to validating to repairing to ready lifecycle', () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-1',
      idempotencyKey: 'job-key-1',
    });

    expect(job.status).toBe('queued');
    expect(job.cancelRequested).toBe(false);

    jobs.updateScenarioGenerationJob(job, {
      status: jobs.JOB_STATUS.VALIDATING,
      progress: 35,
      reason: 'validation_started',
    });
    jobs.updateScenarioGenerationJob(job, {
      status: jobs.JOB_STATUS.REPAIRING,
      progress: 65,
      reason: 'repair_started',
    });
    jobs.completeScenarioGenerationJobFromReport(job, {
      status: 'ready',
      unresolvedDefects: [],
      repairRoundsUsed: 2,
    });

    expect(job.status).toBe('ready');
    expect(job.progress).toBe(100);
    expect(job.completedAt).toBeTruthy();
    expect(job.metadata.repairRoundsUsed).toBe(2);
    expect(job.history.map((entry) => entry.status)).toEqual(expect.arrayContaining(['queued', 'validating', 'repairing', 'ready']));
  });

  it('maps unresolved reliability reports to needs_repair or awaiting_user_decision', () => {
    const repairJob = jobs.createScenarioGenerationJob({ projectId: 'project-1', idempotencyKey: 'needs-repair' });
    jobs.completeScenarioGenerationJobFromReport(repairJob, {
      status: 'needs_repair',
      unresolvedDefects: [{ code: 'weak_oracle' }],
    });
    expect(repairJob.status).toBe('needs_repair');
    expect(repairJob.metadata.unresolvedDefects).toBe(1);

    const decisionJob = jobs.createScenarioGenerationJob({ projectId: 'project-1', idempotencyKey: 'needs-decision' });
    jobs.completeScenarioGenerationJobFromReport(decisionJob, {
      status: 'needs_user_decision',
      unresolvedDefects: [{ code: 'proposed_data_mapping' }],
    });
    expect(decisionJob.status).toBe('awaiting_user_decision');
  });

  it('uses idempotency keys to return the same active job', () => {
    const first = jobs.createScenarioGenerationJob({ projectId: 'project-1', idempotencyKey: 'same-key' });
    const second = jobs.createScenarioGenerationJob({ projectId: 'project-1', idempotencyKey: 'same-key' });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('supports cancel and deterministic retry while rejecting metadata-only resume', () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-1',
      idempotencyKey: 'cancel-retry-resume',
      resumeFromStage: jobs.JOB_STATUS.VALIDATING,
    });
    jobs.requestScenarioGenerationJobCancel(job, 'user_cancelled');

    expect(job.cancelRequested).toBe(true);
    expect(job.history.at(-1).reason).toBe('user_cancelled');

    const retry = jobs.retryScenarioGenerationJob(job, { resumeFromStage: jobs.JOB_STATUS.REPAIRING });
    const replayedRetry = jobs.retryScenarioGenerationJob(job, { resumeFromStage: jobs.JOB_STATUS.REPAIRING });

    expect(retry.retryOfJobId).toBe(job.id);
    expect(retry.resumeFromStage).toBe(jobs.JOB_STATUS.REPAIRING);
    expect(replayedRetry.id).toBe(retry.id);

    jobs.resumeScenarioGenerationJob(retry, retry.resumeFromStage);
    expect(retry.status).toBe(jobs.JOB_STATUS.QUEUED);
    expect(retry.metadata.recovery).toEqual(expect.objectContaining({
      code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_UNAVAILABLE',
      executableResumeAvailable: false,
      requestedStage: jobs.JOB_STATUS.REPAIRING,
      resumeAccepted: false,
    }));
    expect(retry.history.at(-1).reason).toBe('resume_rejected_no_executor');
  });

  it('passes the inherited resume stage into a retry when no override is supplied', () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-inherited-stage',
      idempotencyKey: 'inherited-stage-source',
      resumeFromStage: jobs.JOB_STATUS.VALIDATING,
    });

    const retry = jobs.retryScenarioGenerationJob(job);

    expect(retry.resumeFromStage).toBe(jobs.JOB_STATUS.VALIDATING);
    expect(retry.idempotencyKey).toBe(`${job.id}:retry:${jobs.JOB_STATUS.VALIDATING}`);
  });

  it('awaits an executable resume exactly once and advances only after successful execution', async () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-executable-resume',
      idempotencyKey: 'executable-resume-success',
    });
    const execute = vi.fn(async () => ({ ok: true }));

    const resumed = await jobs.resumeScenarioGenerationJob(job, {
      executable: true,
      resumeFromStage: jobs.JOB_STATUS.REPAIRING,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      job,
      resumeFromStage: jobs.JOB_STATUS.REPAIRING,
    }));
    expect(resumed.status).toBe(jobs.JOB_STATUS.REPAIRING);
    expect(resumed.metadata.recovery).toEqual(expect.objectContaining({
      code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_ACCEPTED',
      resumeAccepted: true,
      executorCompleted: true,
    }));

    const failedJob = jobs.createScenarioGenerationJob({
      projectId: 'project-executable-resume',
      idempotencyKey: 'executable-resume-failure',
    });
    const failedExecute = vi.fn(async () => {
      throw Object.assign(new Error('runner unavailable'), { code: 'RUNNER_DOWN' });
    });

    await expect(jobs.resumeScenarioGenerationJob(failedJob, {
      executable: true,
      resumeFromStage: jobs.JOB_STATUS.REPAIRING,
      execute: failedExecute,
    })).rejects.toMatchObject({
      code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_FAILED',
    });
    expect(failedExecute).toHaveBeenCalledTimes(1);
    expect(failedJob.status).toBe(jobs.JOB_STATUS.QUEUED);
    expect(failedJob.metadata.recovery).toEqual(expect.objectContaining({
      code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_FAILED',
      resumeAccepted: false,
      errorCode: 'RUNNER_DOWN',
    }));
    expect(failedJob.history.at(-1).reason).toBe('resume_executor_failed');
  });

  it('rolls back create and update when the atomic job-store write fails', () => {
    const blockedCreatePath = `${storeFile}.blocked-create`;
    fs.rmSync(blockedCreatePath, { recursive: true, force: true });
    fs.mkdirSync(blockedCreatePath, { recursive: true });
    try {
      jobs.configureScenarioGenerationJobStore({ filePath: blockedCreatePath, persist: true });
      expect(() => jobs.createScenarioGenerationJob({
        projectId: 'project-write-failure',
        idempotencyKey: 'create-write-failure',
      })).toThrow(expect.objectContaining({
        code: 'SCENARIO_GENERATION_JOB_STORE_WRITE_FAILED',
      }));
      expect(jobs.listScenarioGenerationJobs()).toEqual([]);
    } finally {
      fs.rmSync(blockedCreatePath, { recursive: true, force: true });
    }

    jobs.configureScenarioGenerationJobStore({ filePath: storeFile, persist: true });
    jobs.clearScenarioGenerationJobsForTest();
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-write-failure',
      idempotencyKey: 'update-write-failure',
    });
    const before = JSON.parse(JSON.stringify(job));
    fs.rmSync(storeFile, { force: true });
    fs.mkdirSync(storeFile);
    try {
      expect(() => jobs.updateScenarioGenerationJob(job, {
        status: jobs.JOB_STATUS.REPAIRING,
        progress: 65,
        reason: 'must_not_leak',
      })).toThrow(expect.objectContaining({
        code: 'SCENARIO_GENERATION_JOB_STORE_WRITE_FAILED',
      }));
      expect(job).toEqual(before);
    } finally {
      fs.rmSync(storeFile, { recursive: true, force: true });
    }
  });

  it('records failure reason on failed jobs', () => {
    const job = jobs.createScenarioGenerationJob({ projectId: 'project-1', idempotencyKey: 'failed-job' });
    jobs.failScenarioGenerationJob(job, 'repair runner crashed');

    expect(job.status).toBe('failed');
    expect(job.failureReason).toBe('repair runner crashed');
    expect(job.completedAt).toBeTruthy();
  });

  it('persists and reloads job snapshots by idempotency key', () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-1',
      idempotencyKey: 'persisted-key',
    });
    jobs.updateScenarioGenerationJob(job, {
      status: jobs.JOB_STATUS.REPAIRING,
      progress: 55,
      reason: 'persist_me',
    });

    jobs.configureScenarioGenerationJobStore({ filePath: storeFile, persist: true });
    const loaded = jobs.getScenarioGenerationJob(job.id);
    const listed = jobs.listScenarioGenerationJobs({ projectId: 'project-1' });

    expect(loaded.id).toBe(job.id);
    expect(loaded.status).toBe(jobs.JOB_STATUS.REPAIRING);
    expect(listed.map((item) => item.id)).toContain(job.id);
  });

  it('marks an in-flight job deterministically failed after restart and never claims resumability', () => {
    jobs.configureScenarioGenerationJobStore({
      filePath: storeFile,
      persist: true,
      markStaleOnLoad: false,
    });
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-restart',
      idempotencyKey: 'restart-in-flight',
    });
    jobs.updateScenarioGenerationJob(job, {
      status: jobs.JOB_STATUS.GENERATING,
      stage: jobs.JOB_STATUS.GENERATING,
      progress: 45,
      reason: 'provider_streaming',
    });

    jobs.configureScenarioGenerationJobStore({
      filePath: storeFile,
      persist: true,
      markStaleOnLoad: true,
    });
    const loaded = jobs.getScenarioGenerationJob(job.id);
    expect(loaded).toEqual(expect.objectContaining({
      status: jobs.JOB_STATUS.FAILED,
      stage: jobs.JOB_STATUS.FAILED,
      progress: 100,
      failureReason: 'Server restarted before this scenario generation job completed.',
      resumeFromStage: null,
    }));
    expect(loaded.metadata.recovery).toEqual({
      code: 'SCENARIO_GENERATION_INTERRUPTED_BY_RESTART',
      executableResumeAvailable: false,
      previousStatus: jobs.JOB_STATUS.GENERATING,
      previousStage: jobs.JOB_STATUS.GENERATING,
    });
    expect(loaded.history.at(-1).reason).toBe('stale_after_server_restart');

    jobs.resumeScenarioGenerationJob(loaded, jobs.JOB_STATUS.GENERATING);
    expect(loaded.status).toBe(jobs.JOB_STATUS.FAILED);
    expect(loaded.metadata.recovery).toEqual(expect.objectContaining({
      code: 'SCENARIO_GENERATION_RESUME_EXECUTOR_UNAVAILABLE',
      resumeAccepted: false,
    }));
  });

  it('prunes terminal jobs older than the configured retention window on reload', () => {
    let timestamp = 1_000;
    jobs.configureScenarioGenerationJobStore({
      filePath: storeFile,
      persist: true,
      markStaleOnLoad: false,
      retention: 100,
      now: () => timestamp,
    });
    const job = jobs.createScenarioGenerationJob({ projectId: 'project-old', idempotencyKey: 'old-terminal' });
    jobs.failScenarioGenerationJob(job, 'finished long ago');
    timestamp = 1_101;
    jobs.configureScenarioGenerationJobStore({
      filePath: storeFile,
      persist: true,
      markStaleOnLoad: false,
      retention: 100,
      now: () => timestamp,
    });
    expect(jobs.listScenarioGenerationJobs({ projectId: 'project-old' })).toEqual([]);
    expect(jobs.getScenarioGenerationJobStoreStatus()).toEqual(expect.objectContaining({
      ok: true,
      removedExpired: 1,
    }));
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).jobs).toEqual([]);
  });

  it('surfaces exact local store write and read failures', () => {
    const directoryAsStore = path.dirname(storeFile);
    jobs.configureScenarioGenerationJobStore({ filePath: directoryAsStore, persist: true });
    jobs.clearScenarioGenerationJobsForTest();
    expect(jobs.getScenarioGenerationJobStoreStatus()).toEqual(expect.objectContaining({
      ok: false,
      status: 'write_failed',
      code: 'SCENARIO_GENERATION_JOB_STORE_WRITE_FAILED',
    }));

    fs.writeFileSync(storeFile, '{not valid json', 'utf8');
    jobs.configureScenarioGenerationJobStore({ filePath: storeFile, persist: true });
    expect(jobs.listScenarioGenerationJobs()).toEqual([]);
    expect(jobs.getScenarioGenerationJobStoreStatus()).toEqual(expect.objectContaining({
      ok: false,
      status: 'read_failed',
      code: 'SCENARIO_GENERATION_JOB_STORE_READ_FAILED',
    }));
  });

  it('records durable generation snapshots with scenario and case counts', () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-1',
      idempotencyKey: 'snapshot-key',
    });

    jobs.recordScenarioGenerationJobSnapshot(job, {
      stage: 'architect_parsed',
      scenarios: [
        { name: 'Admin Search', cases: [{ name: 'Search by role' }, { name: 'Search by status' }] },
        { name: 'Claim Validation', cases: [{ name: 'Required fields' }] },
      ],
      metadata: { source: 'unit-test' },
    });

    expect(job.snapshots).toHaveLength(1);
    expect(job.snapshots[0].stage).toBe('architect_parsed');
    expect(job.snapshots[0].summary).toEqual({ scenarioCount: 2, caseCount: 3 });
    expect(job.metadata.latestSnapshotStage).toBe('architect_parsed');

    jobs.configureScenarioGenerationJobStore({ filePath: storeFile, persist: true });
    const loaded = jobs.getScenarioGenerationJob(job.id);
    expect(loaded.snapshots[0].summary.caseCount).toBe(3);
  });

  it('redacts inline credentials from snapshot storage and exposure without changing executable input', async () => {
    const safeEmail = 'inline.user@example.test';
    const rawPassword = 'Inline-Credential-For-Test-9!';
    const secondRawPassword = 'Second-Inline-Credential-For-Test-10!';
    const scenarios = [{
      name: 'Inline login',
      cases: [{
        name: 'Sign in with inline values',
        caseContractV1: {
          dataBindings: [
            { id: 'data.email', name: 'email', classification: 'normal' },
            { id: 'data.password', name: 'password', classification: 'sensitive' },
          ],
        },
        steps: [
          { action: 'Fill', target: 'Email', value: safeEmail, dataRefs: ['data.email'] },
          { action: 'Fill', target: 'Password', value: rawPassword, dataRefs: ['data.password'] },
        ],
        assertions: `The login for ${safeEmail} must not expose ${rawPassword}`,
        rowExecutionPlan: {
          mode: 'inline',
          instances: [
            {
              rowId: 'row-001',
              inputs: { email: safeEmail, password: rawPassword },
              publicBindings: { password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD_ROW_1' } },
              executableProjection: {
                steps: [{ action: 'Fill', target: 'Password', value: rawPassword, dataRefs: ['data.password'] }],
              },
            },
            {
              rowId: 'row-002',
              inputs: { email: 'second.inline@example.test', password: secondRawPassword },
              publicBindings: { password: { kind: 'environment', name: 'QAAI_INLINE_PASSWORD_ROW_2' } },
              executableProjection: {
                steps: [{ action: 'Fill', target: 'Password', value: secondRawPassword, dataRefs: ['data.password'] }],
              },
            },
          ],
        },
      }],
    }];
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-inline',
      generationId: 'generation-inline',
      idempotencyKey: 'snapshot-inline-secret',
    });

    jobs.recordScenarioGenerationJobSnapshot(job, {
      stage: 'test_design_compiled',
      scenarios,
    });

    // Snapshot redaction must not mutate the executable case handed to the
    // canonical TestCase persistence path.
    expect(scenarios[0].cases[0].steps[1].value).toBe(rawPassword);
    expect(scenarios[0].cases[0].rowExecutionPlan.instances[1].inputs.password).toBe(secondRawPassword);

    const serialized = jobs.serializeScenarioGenerationJob(job);
    const serializedText = JSON.stringify(serialized);
    expect(serializedText).not.toContain(rawPassword);
    expect(serializedText).not.toContain(secondRawPassword);
    expect(serializedText).toContain(safeEmail);
    expect(serialized.snapshots[0].scenarios[0].cases[0].steps[1].value).not.toBe(rawPassword);

    const storeText = fs.readFileSync(storeFile, 'utf8');
    expect(storeText).not.toContain(rawPassword);
    expect(storeText).not.toContain(secondRawPassword);
    expect(storeText).toContain(safeEmail);

    let written = null;
    const prisma = {
      scenarioGeneration: {
        findUnique: async () => ({ id: 'generation-inline', coverageValidationJson: '{}' }),
        update: async ({ data }) => {
          written = data.coverageValidationJson;
          return {};
        },
      },
    };
    await jobs.persistScenarioGenerationJobToGeneration(prisma, job);
    expect(written).not.toContain(rawPassword);
    expect(written).not.toContain(secondRawPassword);
    expect(written).toContain(safeEmail);
  });

  it('attaches job snapshot into persisted generation coverage evidence', async () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-1',
      generationId: 'generation-1',
      idempotencyKey: 'db-persist-key',
    });
    jobs.completeScenarioGenerationJobFromReport(job, {
      status: 'needs_repair',
      unresolvedDefects: [{ code: 'weak_oracle' }],
    });
    let written = null;
    const prisma = {
      scenarioGeneration: {
        findUnique: async () => ({
          id: 'generation-1',
          coverageValidationJson: JSON.stringify({ reliabilityReport: { status: 'needs_repair' } }),
        }),
        update: async ({ data }) => {
          written = JSON.parse(data.coverageValidationJson);
          return {};
        },
      },
    };

    const attached = await jobs.persistScenarioGenerationJobToGeneration(prisma, job);

    expect(attached.id).toBe(job.id);
    expect(attached.persistence).toEqual(expect.objectContaining({
      ok: true,
      status: 'generation_evidence_persisted',
      generationId: 'generation-1',
    }));
    expect(written.reliabilityReport.scenarioGenerationJob.id).toBe(job.id);
    expect(written.reliabilityReport.scenarioGenerationJob.status).toBe('needs_repair');
  });

  it('returns typed generation-evidence persistence failures', async () => {
    const job = jobs.createScenarioGenerationJob({
      projectId: 'project-1',
      generationId: 'generation-missing',
      idempotencyKey: 'db-persist-failure',
    });
    const notFound = await jobs.persistScenarioGenerationJobToGeneration({
      scenarioGeneration: {
        findUnique: async () => null,
      },
    }, job);
    expect(notFound).toEqual(expect.objectContaining({
      ok: false,
      status: 'generation_not_found',
      code: 'SCENARIO_GENERATION_JOB_GENERATION_NOT_FOUND',
      generationId: 'generation-missing',
    }));

    const writeFailure = await jobs.persistScenarioGenerationJobToGeneration({
      scenarioGeneration: {
        findUnique: async () => ({ id: 'generation-missing', coverageValidationJson: '{}' }),
        update: async () => { throw Object.assign(new Error('database unavailable'), { code: 'DB_DOWN' }); },
      },
    }, job);
    expect(writeFailure).toEqual(expect.objectContaining({
      ok: false,
      status: 'generation_evidence_write_failed',
      code: 'SCENARIO_GENERATION_JOB_GENERATION_PERSIST_FAILED',
      errorCode: 'DB_DOWN',
    }));
  });
});
