import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bundleStore from '../../server/services/scriptBundleStore.js';
import repairAgent from '../../server/services/scriptRepairAgent.js';
import { verifiedActionLocator } from '../fixtures/playwrightPomJsPrecisionAcceptance.fixture.js';

describe('script bundle store and repair agent', () => {
  const tmpRoots = [];

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  function tempRoot() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-bundle-store-'));
    tmpRoots.push(dir);
    return dir;
  }

  const files = {
    'package.json': '{"name":"qaai-export"}\n',
    'tests/pim.spec.ts': [
      "import { test } from '@playwright/test';",
      "test('save employee', async ({ page }) => {",
      "  await page.getByText('Save').click();",
      '});',
    ].join('\n'),
  };

  it('persists a generated bundle snapshot and overlays repair journal files', () => {
    const storeRoot = tempRoot();
    const bundle = bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-1',
      framework: 'playwright-reference',
      files,
      manifest: { exportValid: true },
    });

    expect(bundle.created).toBe(true);
    expect(bundle.files['tests/pim.spec.ts']).toContain("getByText('Save')");

    const failure = {
      id: 'failure-1',
      file: 'tests/pim.spec.ts',
      line: 3,
      error: 'Strict mode violation',
      testTitle: 'save employee',
    };
    const unsafeProposal = repairAgent.proposeRepair({ files: bundle.files, failure });
    expect(unsafeProposal).toMatchObject({
      status: 'unresolved_non_blocking',
      reason: 'no_verified_action_locator_repair_available',
      nonBlocking: true,
    });
    expect(unsafeProposal.after).toBeUndefined();

    const proposal = repairAgent.proposeRepair({
      files: bundle.files,
      failure: {
        ...failure,
        verifiedActionLocator: verifiedActionLocator(
          "page.getByRole('button', { name: 'Save', exact: true })",
          { role: 'button', accessibleName: 'Save' },
        ),
      },
    });
    expect(proposal.status).toBe('patched');
    expect(proposal.after).toContain("getByRole('button'");

    const patched = bundleStore.patchBundleFile({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-1',
      framework: 'playwright-reference',
      file: failure.file,
      line: failure.line,
      after: proposal.after,
      expectedBefore: proposal.before,
      reason: proposal.reason,
      repairedBy: proposal.repairedBy,
      failure,
    });

    expect(patched.repair.file).toBe('tests/pim.spec.ts');
    expect(patched.bundle.files['tests/pim.spec.ts']).toContain("getByRole('button'");
    expect(patched.bundle.files['evidence/script-repair-journal.json']).toContain('failure-1');
    expect(patched.journal.repairs).toHaveLength(1);
  });

  it('rejects repair paths outside the stored bundle', () => {
    const storeRoot = tempRoot();
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-1',
      framework: 'playwright-reference',
      files,
    });

    expect(() => bundleStore.patchBundleFile({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-1',
      framework: 'playwright-reference',
      file: '../../server/index.js',
      after: 'bad',
    })).toThrow(/script_bundle_path_denied/);
  });

  it('preserves binary workbook files while keeping script files editable text', () => {
    const storeRoot = tempRoot();
    const workbook = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-binary',
      framework: 'playwright-reference',
      files: {
        ...files,
        'tests/data/master.xlsx': workbook,
      },
    });

    const stored = bundleStore.readBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-binary',
      framework: 'playwright-reference',
    });

    expect(typeof stored.files['tests/pim.spec.ts']).toBe('string');
    expect(Buffer.isBuffer(stored.files['tests/data/master.xlsx'])).toBe(true);
    expect(stored.files['tests/data/master.xlsx']).toEqual(workbook);
  });

  it('persists draft preview specs, manifest, and evidence as the editable bundle source', () => {
    const storeRoot = tempRoot();
    const previewFiles = {
      'tests/preview/authentication/login.preview.spec.js': [
        "const { test } = require('@playwright/test');",
        "test.describe.skip('PREVIEW ONLY', () => {",
        "  test('login draft', async ({ page }) => {",
        "    test.fixme(true, 'needs_auth_setup');",
        "    await page.getByLabel('Email Address').fill(process.env.LOGIN_EMAIL || '');",
        '  });',
        '});',
      ].join('\n'),
      'EXPORT_MANIFEST.json': JSON.stringify({ exportValid: false, allBlocked: true }),
      'evidence/live-output-status.json': JSON.stringify({ status: 'draft_generated' }),
      'README.md': '# QAAI draft output bundle\n',
    };

    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-preview',
      framework: 'playwright-pom-js',
      files: previewFiles,
      manifest: { exportValid: false, allBlocked: true },
    });

    const stored = bundleStore.readBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-preview',
      framework: 'playwright-pom-js',
    });

    expect(stored.files['tests/preview/authentication/login.preview.spec.js']).toContain("getByLabel('Email Address').fill");
    expect(stored.files['EXPORT_MANIFEST.json']).toContain('"exportValid":false');
    expect(stored.files['evidence/live-output-status.json']).toContain('draft_generated');
  });

  it('promotes runtime metadata after a successful validation without inventing certification', () => {
    const storeRoot = tempRoot();
    const replayFiles = {
      'tests/authentication/login.spec.js': [
        "const { test } = require('@playwright/test');",
        "test('login replay', async ({ page }) => { await page.goto('about:blank'); });",
      ].join('\n'),
      'EXPORT_MANIFEST.json': JSON.stringify({
        exportValid: true,
        artifacts: [{
          testCaseId: 'tc-1',
          runResultId: 'rr-1',
          file: 'tests/authentication/login.spec.js',
          source: 'replayir',
          scriptGenerationStatus: 'generated',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
      }),
      'evidence/live-output-status.json': JSON.stringify({
        status: 'generated_not_run',
        artifacts: [{
          testCaseId: 'tc-1',
          runResultId: 'rr-1',
          file: 'tests/authentication/login.spec.js',
          source: 'replayir',
          scriptGenerationStatus: 'generated',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
        scriptArtifacts: [{
          testCaseId: 'tc-1',
          runResultId: 'rr-1',
          file: 'tests/authentication/login.spec.js',
          source: 'replayir',
          scriptGenerationStatus: 'generated',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
      }),
    };
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-certified',
      framework: 'playwright-pom-js',
      files: replayFiles,
      manifest: JSON.parse(replayFiles['EXPORT_MANIFEST.json']),
    });

    const updated = bundleStore.applyValidationReport({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-certified',
      framework: 'playwright-pom-js',
      report: {
        id: 'validation-1',
        bundleId: 'run-certified',
        framework: 'playwright-pom-js',
        status: 'passed',
        reason: 'playwright_run_passed',
        completedAt: '2026-07-08T00:00:00.000Z',
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        failures: [],
        certification: { certified: false, scriptResult: 'Passed' },
      },
    });

    const manifest = JSON.parse(updated.files['EXPORT_MANIFEST.json']);
    const status = JSON.parse(updated.files['evidence/live-output-status.json']);
    expect(manifest.exportValid).toBe(true);
    expect(manifest.artifacts[0]).toMatchObject({
      scriptRunStatus: 'passed',
      certificationStatus: 'uncertified',
    });
    expect(status).toMatchObject({
      status: 'validation_passed_uncertified',
      scriptRunStatus: 'passed',
      certificationStatus: 'uncertified',
    });
    expect(status.artifacts).toEqual(status.scriptArtifacts);
    expect(status.scriptArtifacts[0]).toMatchObject({
      scriptRunStatus: 'passed',
      certificationStatus: 'uncertified',
    });

    const reread = bundleStore.readBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-certified',
      framework: 'playwright-pom-js',
    });
    expect(JSON.parse(reread.files['EXPORT_MANIFEST.json'])).toMatchObject({
      scriptRunStatus: 'passed',
    });
    expect(JSON.parse(reread.files['evidence/live-output-status.json'])).toMatchObject({
      scriptRunStatus: 'passed',
    });

    const regenerated = bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-certified',
      framework: 'playwright-pom-js',
      files: replayFiles,
      manifest: JSON.parse(replayFiles['EXPORT_MANIFEST.json']),
    });
    expect(regenerated.created).toBe(false);
    expect(JSON.parse(regenerated.files['EXPORT_MANIFEST.json'])).toMatchObject({
      scriptRunStatus: 'passed',
    });
  });

  it('keeps draft artifacts uncertified even when script validation passes', () => {
    const storeRoot = tempRoot();
    const previewFiles = {
      'tests/preview/authentication/login.preview.spec.js': [
        "const { test } = require('@playwright/test');",
        "test('login draft', async ({ page }) => { await page.goto('about:blank'); });",
      ].join('\n'),
      'EXPORT_MANIFEST.json': JSON.stringify({
        exportValid: false,
        artifacts: [{
          testCaseId: 'tc-draft',
          file: 'tests/preview/authentication/login.preview.spec.js',
          source: 'testcase_contract',
          scriptGenerationStatus: 'generated_with_repairs_needed',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
      }),
      'evidence/live-output-status.json': JSON.stringify({
        status: 'generated_draft',
        artifacts: [{
          testCaseId: 'tc-draft',
          file: 'tests/preview/authentication/login.preview.spec.js',
          source: 'testcase_contract',
          scriptGenerationStatus: 'generated_with_repairs_needed',
          scriptRunStatus: 'not_run',
          certificationStatus: 'uncertified',
        }],
      }),
    };
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-draft-validation',
      framework: 'playwright-pom-js',
      files: previewFiles,
      manifest: JSON.parse(previewFiles['EXPORT_MANIFEST.json']),
    });

    const updated = bundleStore.applyValidationReport({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-draft-validation',
      framework: 'playwright-pom-js',
      report: {
        id: 'validation-draft',
        bundleId: 'run-draft-validation',
        framework: 'playwright-pom-js',
        status: 'certified',
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        failures: [],
        certification: { certified: true, scriptResult: 'Certified' },
      },
    });

    const manifest = JSON.parse(updated.files['EXPORT_MANIFEST.json']);
    const status = JSON.parse(updated.files['evidence/live-output-status.json']);
    expect(manifest.exportValid).toBe(true);
    expect(manifest.packagePassed).toBe(true);
    expect(manifest.runnable).toBe(true);
    expect(manifest.strictExport.ok).toBe(false);
    expect(manifest.artifacts[0]).toMatchObject({
      scriptRunStatus: 'passed',
      certificationStatus: 'uncertified',
    });
    expect(status).toMatchObject({
      status: 'validation_passed_uncertified',
      scriptRunStatus: 'passed',
      certificationStatus: 'uncertified',
      packagePassed: true,
      runnable: true,
    });
  });

  it('recovers artifacts from stored EXPORT_MANIFEST when bundle metadata is missing them', () => {
    const storeRoot = tempRoot();
    const manifest = {
      exportValid: false,
      artifacts: [{
        testCaseId: 'tc-2',
        runResultId: 'rr-2',
        file: 'tests/recovered.spec.ts',
        source: 'replayir',
        scriptGenerationStatus: 'generated',
        scriptRunStatus: 'not_run',
        certificationStatus: 'uncertified',
      }],
    };
    bundleStore.ensureBundle({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-recover',
      framework: 'playwright-reference',
      files: {
        'tests/recovered.spec.ts': "import { test } from '@playwright/test';\ntest('x', async () => {});\n",
        'EXPORT_MANIFEST.json': JSON.stringify(manifest),
        'evidence/live-output-status.json': JSON.stringify({ status: 'draft_generated', artifacts: manifest.artifacts }),
      },
      manifest: null,
    });

    const updated = bundleStore.applyValidationReport({
      storeRoot,
      projectId: 'project-1',
      bundleId: 'run-recover',
      framework: 'playwright-reference',
      report: {
        id: 'validation-recovered',
        bundleId: 'run-recover',
        framework: 'playwright-reference',
        status: 'certified',
        summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        failures: [],
        certification: { certified: true, scriptResult: 'Certified' },
      },
    });

    const updatedManifest = JSON.parse(updated.files['EXPORT_MANIFEST.json']);
    expect(updatedManifest.artifacts[0]).toMatchObject({
      testCaseId: 'tc-2',
      scriptRunStatus: 'passed',
      certificationStatus: 'certified',
    });
  });

  it('keeps failures without a safe deterministic repair unresolved and non-blocking', () => {
    const result = repairAgent.proposeRepair({
      files,
      failure: {
        id: 'failure-2',
        file: 'tests/pim.spec.ts',
        line: 2,
        error: 'syntax error',
      },
    });

    expect(result).toMatchObject({
      status: 'unresolved_non_blocking',
      reason: 'no_verified_action_locator_repair_available',
      nonBlocking: true,
    });
    expect(result.after).toBeUndefined();
  });

  it('keeps stale explicit patch previews unresolved and non-blocking', () => {
    const result = repairAgent.proposeRepair({
      files,
      failure: {
        id: 'failure-3',
        file: 'tests/pim.spec.ts',
        line: 3,
        error: 'Strict mode violation',
      },
      patch: {
        file: 'tests/pim.spec.ts',
        expectedBefore: files['tests/pim.spec.ts'].replace('Save', 'Changed'),
        after: files['tests/pim.spec.ts'].replace("getByText('Save')", "getByRole('button', { name: /^Save$/ })"),
      },
    });

    expect(result).toMatchObject({
      status: 'unresolved_non_blocking',
      reason: 'script_repair_stale_preview',
      nonBlocking: true,
    });
    expect(result.after).toBeUndefined();
  });
});
