import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const agentModule = await import('../../server/services/scriptValidationAgent.js');
const agent = agentModule.default || agentModule;
const bundleStoreModule = await import('../../server/services/scriptBundleStore.js');
const bundleStore = bundleStoreModule.default || bundleStoreModule;

function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (err) {
        return reject(err);
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('scriptValidationAgent', () => {
  const tmpRoots = [];

  function tempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-agent-bundle-'));
    tmpRoots.push(dir);
    return dir;
  }

  beforeEach(() => {
    agent.resetForTests();
  });

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('queues generated-bundle validation without blocking the caller', async () => {
    const events = [];
    const job = agent.enqueueScriptValidation({
      projectId: 'project-1',
      runId: 'run-1',
      bundleId: 'run-1',
      framework: 'playwright-reference',
      files: { 'tests/example.spec.ts': 'test("example", async () => {});' },
      mode: 'auto_after_generation',
      onEvent: (event) => events.push(event),
      runScriptValidation: async (input) => {
        expect(input.projectId).toBe('project-1');
        expect(input.bundleId).toBe('run-1');
        expect(input.mode).toBe('auto_after_generation');
        return {
          id: 'validation-report-1',
          bundleId: input.bundleId,
          framework: input.framework,
          status: 'certified',
          reason: 'playwright_run_passed',
          summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
          failures: [],
          certification: { certified: true, scriptResult: 'Certified' },
        };
      },
    });

    expect(job.status).toBe('queued');
    expect(agent.getJob(job.id).status).toMatch(/queued|running/);

    const completed = await waitFor(() => agent.getJob(job.id)?.status === 'certified' && agent.getJob(job.id));
    expect(completed.summary).toMatchObject({ total: 1, passed: 1 });
    expect(events.map((event) => event.type)).toEqual([
      'output.scriptValidationQueued',
      'output.scriptValidationRunning',
      'output.scriptValidationComplete',
    ]);
  });

  it('resolves a ReplayIR bundle lazily before validation runs', async () => {
    const job = agent.enqueueScriptValidation({
      projectId: 'project-2',
      runId: 'run-2',
      bundleId: 'run-2',
      framework: 'playwright-pom',
      resolveBundle: async () => ({
        bundleId: 'resolved-run-2',
        framework: 'playwright-reference',
        files: {
          'package.json': JSON.stringify({ devDependencies: { '@playwright/test': '1.0.0' } }),
          'tests/resolved.spec.ts': 'test("resolved", async () => {});',
        },
        manifest: { exportValid: true },
      }),
      runScriptValidation: async (input) => {
        expect(input.bundleId).toBe('resolved-run-2');
        expect(input.framework).toBe('playwright-reference');
        expect(Object.keys(input.files)).toContain('tests/resolved.spec.ts');
        return {
          id: 'validation-report-2',
          bundleId: input.bundleId,
          framework: input.framework,
          status: 'certified',
          reason: 'playwright_run_passed',
          summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
          failures: [],
          certification: { certified: true, scriptResult: 'Certified' },
        };
      },
    });

    const completed = await waitFor(() => agent.getJob(job.id)?.status === 'certified' && agent.getJob(job.id));
    expect(completed.bundleId).toBe('resolved-run-2');
    expect(completed.framework).toBe('playwright-reference');
    expect(completed.manifest).toMatchObject({ exportValid: true });
  });

  it('persists async validation certification into the stored bundle manifest', async () => {
    const storeRoot = tempRoot();
    const files = {
      'tests/example.spec.ts': "import { test } from '@playwright/test';\ntest('example', async () => {});\n",
      'EXPORT_MANIFEST.json': JSON.stringify({
        exportValid: true,
        artifacts: [{
          testCaseId: 'tc-agent',
          runResultId: 'rr-agent',
          file: 'tests/example.spec.ts',
          source: 'replayir',
          scriptGenerationStatus: 'generated',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
      }),
      'evidence/live-output-status.json': JSON.stringify({ status: 'generated_not_run' }),
    };
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-agent',
      bundleId: 'bundle-agent',
      framework: 'playwright-reference',
      files,
      manifest: JSON.parse(files['EXPORT_MANIFEST.json']),
    });

    const job = agent.enqueueScriptValidation({
      projectId: 'project-agent',
      bundleId: 'bundle-agent',
      framework: 'playwright-reference',
      files,
      bundleStoreRoot: storeRoot,
      runScriptValidation: async (input) => ({
        id: 'validation-agent',
        bundleId: input.bundleId,
        framework: input.framework,
        status: 'certified',
        reason: 'playwright_run_passed',
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        failures: [],
        certification: { certified: true, scriptResult: 'Certified' },
      }),
    });

    await waitFor(() => agent.getJob(job.id)?.status === 'certified' && agent.getJob(job.id));
    const stored = bundleStore.readBundle({
      storeRoot,
      projectId: 'project-agent',
      bundleId: 'bundle-agent',
      framework: 'playwright-reference',
    });
    const manifest = JSON.parse(stored.files['EXPORT_MANIFEST.json']);
    expect(manifest.artifacts[0]).toMatchObject({
      scriptRunStatus: 'passed',
      certificationStatus: 'certified',
    });
  });

  it('does not certify stored draft bundles after async validation passes', async () => {
    const storeRoot = tempRoot();
    const files = {
      'tests/preview/example.preview.spec.ts': "import { test } from '@playwright/test';\ntest('example', async () => {});\n",
      'EXPORT_MANIFEST.json': JSON.stringify({
        exportValid: false,
        artifacts: [{
          testCaseId: 'tc-agent-draft',
          file: 'tests/preview/example.preview.spec.ts',
          source: 'testcase_contract',
          scriptGenerationStatus: 'generated_with_repairs_needed',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
      }),
      'evidence/live-output-status.json': JSON.stringify({ status: 'generated_draft' }),
    };
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-agent',
      bundleId: 'bundle-agent-draft',
      framework: 'playwright-reference',
      files,
      manifest: JSON.parse(files['EXPORT_MANIFEST.json']),
    });

    const job = agent.enqueueScriptValidation({
      projectId: 'project-agent',
      bundleId: 'bundle-agent-draft',
      framework: 'playwright-reference',
      files,
      bundleStoreRoot: storeRoot,
      runScriptValidation: async (input) => ({
        id: 'validation-agent-draft',
        bundleId: input.bundleId,
        framework: input.framework,
        status: 'certified',
        reason: 'playwright_run_passed',
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        failures: [],
        certification: { certified: true, scriptResult: 'Certified' },
      }),
    });

    const completed = await waitFor(() => agent.getJob(job.id)?.status === 'validation_passed_uncertified' && agent.getJob(job.id));
    expect(completed.reason).toBe('strict_replayir_required');
    const stored = bundleStore.readBundle({
      storeRoot,
      projectId: 'project-agent',
      bundleId: 'bundle-agent-draft',
      framework: 'playwright-reference',
    });
    const manifest = JSON.parse(stored.files['EXPORT_MANIFEST.json']);
    expect(manifest.exportValid).toBe(true);
    expect(manifest.runnable).toBe(true);
    expect(manifest.certified).toBe(false);
    expect(manifest.artifacts[0]).toMatchObject({
      scriptRunStatus: 'passed',
      certificationStatus: 'uncertified',
    });
  });

  it('persists ReplayIRCertification rows for certified replay artifacts', async () => {
    const created = [];
    const prisma = {
      replayIRCertification: {
        async create(payload) {
          created.push(payload.data);
          return payload.data;
        },
      },
    };
    const result = await agent.persistReplayIrCertifications({
      prismaClient: prisma,
      files: {
        'evidence/replayir.json': JSON.stringify({ replayIr: [{ runResultId: 'rr-cert' }] }),
        'evidence/action-evidence.json': JSON.stringify({ entries: [{ runResultId: 'rr-cert' }] }),
      },
      manifest: {
        artifacts: [{
          runResultId: 'rr-cert',
          testCaseId: 'tc-cert',
          file: 'tests/example.spec.ts',
          source: 'replayir',
          scriptGenerationStatus: 'generated',
        }],
      },
      report: {
        status: 'certified',
        failures: [],
        certification: { certified: true },
        roundTripParity: { findings: [] },
      },
    });

    expect(result).toMatchObject({ written: 1, skipped: false });
    expect(created[0]).toMatchObject({
      runResultId: 'rr-cert',
      testCaseId: 'tc-cert',
      certificationStatus: 'certified',
    });
    expect(created[0].replayIrHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created[0].actionEvidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created[0].certifiedAt).toBeInstanceOf(Date);
  });
});
