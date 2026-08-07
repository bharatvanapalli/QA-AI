import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nativeLane from '../../server/services/nativePlaywrightLane.js';

describe('native Playwright lane', () => {
  const tmpRoots = [];

  afterEach(() => {
    for (const dir of tmpRoots.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  it('builds a QAAI Markdown spec for the Playwright agent loop', () => {
    const spec = nativeLane.buildMarkdownSpec({
      project: { name: 'OrangeHRM', targetUrl: 'https://opensource-demo.orangehrmlive.com/' },
      testCase: {
        id: 'TC-1',
        name: 'Add employee',
        module: 'PIM',
        steps: [
          { action: 'Fill', element: 'First Name', value: 'QAAI' },
          { action: 'Click', element: 'Save button' },
        ],
        declaredAssertions: [{ id: 'ASN-1', text: 'Personal Details page opens' }],
      },
      authProfile: { name: 'ADMIN_DEFAULT', strategy: 'form_login' },
    });

    expect(spec).toContain('**QAAI Runtime Mode:** native_playwright_agent');
    expect(spec).toContain('**File:** tests/pim/add-employee.spec.ts');
    expect(spec).toContain('**Seed:** seed/seed.spec.ts');
    expect(spec).toContain('## Business Goal');
    expect(spec).toContain('## Role And Auth');
    expect(spec).toContain('## Failure Conditions');
    expect(spec).toContain('## Evidence Requirements');
    expect(spec).toContain('Personal Details page opens');
  });

  it('keeps planner, generator, healer, and reviewer agent files under the native lane contract', () => {
    const validation = nativeLane.validateAgentFiles(nativeLane.AGENT_FILES);

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(Object.keys(nativeLane.AGENT_FILES)).toContain('.github/agents/playwright-test-planner.agent.md');
    expect(Object.keys(nativeLane.AGENT_FILES)).toContain('.github/agents/playwright-test-generator.agent.md');
    expect(Object.keys(nativeLane.AGENT_FILES)).toContain('.github/agents/playwright-test-healer.agent.md');
    expect(Object.keys(nativeLane.AGENT_FILES)).toContain('.github/agents/playwright-test-reviewer.agent.md');
  });

  it('requires generated tests to run in a locked child-worker sandbox', () => {
    const policy = nativeLane.buildSandboxPolicy({
      workspaceRoot: 'C:/repo/qaai',
      runWorkspace: 'C:/repo/qaai/tmp/native-runs/run-1',
    });

    expect(policy.noPlatformEnv).toBe(true);
    expect(policy.denyEnvPatterns).toContain('DATABASE_URL');
    expect(policy.denyPathFragments).toContain('.env');
    expect(policy.denyPathFragments).toContain('prisma/dev.db');
    expect(nativeLane.assertSandboxPolicy(policy)).toBe(true);
  });

  it('rejects running generated tests directly at repo root', () => {
    const policy = nativeLane.buildSandboxPolicy({
      workspaceRoot: 'C:/repo/qaai',
      runWorkspace: 'C:/repo/qaai',
    });

    expect(() => nativeLane.assertSandboxPolicy(policy)).toThrow(/must_not_equal_repo_root/);
  });

  it('prepares a run workspace with spec, agent files, seed, package, config, and manifest', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-native-root-'));
    tmpRoots.push(root);
    const prepared = nativeLane.prepareNativeLaneWorkspace({
      workspaceRoot: root,
      runId: 'run-1',
      project: { name: 'OrangeHRM', targetUrl: 'https://opensource-demo.orangehrmlive.com/' },
      testCase: {
        id: 'TC-1',
        name: 'Add employee',
        module: 'PIM',
        steps: [{ action: 'Click', element: 'Save button' }],
        declaredAssertions: [{ text: 'Personal Details' }],
      },
      authProfile: { name: 'ADMIN_DEFAULT', strategy: 'form_login' },
      dataRows: [{ firstName: '{{data.firstName}}' }],
    });

    expect(prepared.runWorkspace).toBe(path.join(root, 'tmp', 'native-runs', 'run-1'));
    expect(fs.existsSync(path.join(prepared.runWorkspace, prepared.specRel))).toBe(true);
    expect(fs.existsSync(path.join(prepared.runWorkspace, prepared.outputRel))).toBe(true);
    expect(fs.existsSync(path.join(prepared.runWorkspace, prepared.seedRel))).toBe(true);
    expect(fs.existsSync(path.join(prepared.runWorkspace, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(prepared.runWorkspace, 'playwright.config.ts'))).toBe(true);
    expect(fs.existsSync(path.join(prepared.runWorkspace, '.github/agents/playwright-test-healer.agent.md'))).toBe(true);
    expect(fs.existsSync(path.join(prepared.runWorkspace, '.github/agents/playwright-test-reviewer.agent.md'))).toBe(true);
    const fallbackCode = fs.readFileSync(path.join(prepared.runWorkspace, prepared.outputRel), 'utf8');
    expect(fallbackCode).not.toContain('test.fixme');
    expect(fallbackCode).toContain('QAAI_GUESSED_LOCATOR');
    expect(fallbackCode).toContain('Save button');
    expect(fallbackCode).toContain('.click()');
    expect(JSON.parse(fs.readFileSync(path.join(prepared.runWorkspace, 'native-lane-manifest.json'), 'utf8')).schema)
      .toBe(nativeLane.NATIVE_MANIFEST_SCHEMA);
  });

  it('strips platform secrets and rejects unsafe scoped env/path access', () => {
    const policy = nativeLane.buildSandboxPolicy({
      workspaceRoot: 'C:/repo/qaai',
      runWorkspace: 'C:/repo/qaai/tmp/native-runs/run-1',
    });
    const env = nativeLane.buildSandboxEnv({
      policy,
      baseEnv: {
        PATH: 'C:/bin',
        DATABASE_URL: 'file:prisma/dev.db',
        JWT_SECRET: 'secret',
        QAAI_INTERNAL: 'nope',
        PRISMA_QUERY_ENGINE_BINARY: 'nope',
      },
      scopedTestEnv: {
        TEST_USERNAME: 'Admin',
        TEST_PASSWORD: 'scoped',
      },
    });

    expect(env.PATH).toBe('C:/bin');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.QAAI_INTERNAL).toBeUndefined();
    expect(env.PRISMA_QUERY_ENGINE_BINARY).toBeUndefined();
    expect(env.TEST_USERNAME).toBe('Admin');
    expect(() => nativeLane.buildSandboxEnv({ policy, scopedTestEnv: { QAAI_PASSWORD: 'blocked' } }))
      .toThrow(/scoped_env_key_denied/);
    expect(() => nativeLane.assertSandboxPath(policy, '../../.env', 'read'))
      .toThrow(/outside_run_workspace|denied/);
    expect(() => nativeLane.assertSandboxPath(policy, 'prisma/dev.db', 'read'))
      .toThrow(/denied/);
  });

  it('runs generated tests only through the sandboxed worker workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qaai-native-root-'));
    tmpRoots.push(root);
    const prepared = nativeLane.prepareNativeLaneWorkspace({
      workspaceRoot: root,
      runId: 'run-worker',
      project: { name: 'TodoMVC', targetUrl: 'https://example.test/' },
      testCase: { id: 'TC-2', name: 'Open app', module: 'Smoke' },
      generatedSpec: "import { test, expect } from '@playwright/test';\ntest('Open app', async ({ page }) => { expect(1).toBe(1); });\n",
    });

    let observed = null;
    const result = await nativeLane.runSandboxedNativeTest({
      policy: prepared.policy,
      scopedTestEnv: { TEST_USERNAME: 'Admin' },
      execFileImpl: (command, args, options, callback) => {
        observed = { command, args, options };
        fs.mkdirSync(path.join(options.cwd, 'native-lane-results'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'native-lane-results', 'results.json'), '{"ok":true}', 'utf8');
        callback(null, JSON.stringify({ suites: [{ specs: [{ tests: [{ outcome: 'expected' }] }] }] }), '');
        return { kill() {} };
      },
    });

    expect(observed.options.cwd).toBe(prepared.runWorkspace);
    expect(observed.options.cwd).not.toBe(root);
    expect(observed.options.env.DATABASE_URL).toBeUndefined();
    expect(observed.options.env.TEST_USERNAME).toBe('Admin');
    expect(result.status).toBe('passed');
    expect(result.parsedSummary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(result.artifacts.some((artifact) => artifact.relPath === 'native-lane-results/results.json')).toBe(true);
  });

  it('imports native lane results as experimental preview evidence for QAAI', () => {
    const policy = nativeLane.buildSandboxPolicy({
      workspaceRoot: 'C:/repo/qaai',
      runWorkspace: 'C:/repo/qaai/tmp/native-runs/run-1',
    });
    const envelope = nativeLane.buildQaaIImportEnvelope({
      policy,
      workspace: { specRel: 'specs/app/tc-1.md', outputRel: 'tests/app/tc-1.spec.ts', seedRel: 'seed/seed.spec.ts' },
      runResult: {
        status: 'passed',
        exitCode: 0,
        parsedSummary: { total: 1, passed: 1, failed: 0, skipped: 0 },
        artifacts: [{ type: 'result', relPath: 'native-lane-results/results.json' }],
      },
    });

    expect(envelope.schema).toBe(nativeLane.NATIVE_IMPORT_SCHEMA);
    expect(envelope.runtimeMode).toBe('native_playwright_agent');
    expect(envelope.certificationStatus).toBe('preview_not_certified');
    expect(envelope.experimental).toBe(true);
    expect(envelope.workspace.runWorkspace).toBe('tmp/native-runs/run-1');
    expect(envelope.artifacts).toEqual([{ type: 'result', relPath: 'native-lane-results/results.json' }]);
  });
});
