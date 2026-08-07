import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import runner from '../../server/services/scriptValidationRunner.js';

describe('script validation runner', () => {
  const tmpRoots = [];

  afterEach(() => {
    delete process.env.QAAI_ROUND_TRIP_SCRIPT_VALIDATION_ENABLED;
    for (const dir of tmpRoots.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  function tempRoot(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpRoots.push(dir);
    return dir;
  }

  function runValidation(options = {}) {
    return runner.runScriptValidation({
      dependencyExecFileImpl: (_command, _args, _options, callback) =>
        callback(null, '', ''),
      resolveCliImpl: () => path.join(os.tmpdir(), 'qaai-test-playwright-cli.js'),
      ...options,
    });
  }

  const baseFiles = {
    'package.json': JSON.stringify(
      {
        name: 'qaai-export',
        private: true,
        scripts: { test: 'playwright test' },
        devDependencies: {
          '@playwright/test': '^1.40.0',
          '@axe-core/playwright': '^4.10.0',
        },
      },
      null,
      2,
    ),
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      "export default defineConfig({ testDir: './tests', use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' } });",
    ].join('\n'),
    'tests/smoke.spec.ts': [
      "import { test, expect } from '@playwright/test';",
      "test('smoke', async () => {",
      '  await expect.poll(() => 1).toBe(1);',
      '});',
    ].join('\n'),
  };

  function evidenceFiles({
    planned = 1,
    actions = 1,
    assertions = 0,
    finalAssertions = 0,
    missing = 0,
    replayActions = 1,
  } = {}) {
    const ledger = {
      runResultId: 'rr-smoke',
      testCaseId: 'tc-smoke',
      caseName: 'smoke',
      evidenceStatus: missing === 0 ? 'complete' : 'capture_failed',
      plannedExecutableStepCount: planned,
      actionEvidenceCount: actions,
      replayIrActionCount: replayActions,
      plannedAssertionCount: assertions,
      assertionEvidenceCount: assertions,
      finalAssertionEvidenceCount: finalAssertions,
      missingEvidenceCount: missing,
      manualGateCount: 0,
    };
    const irSteps = [{ op: 'act', action: 'navigate', url: 'https://example.test' }];
    for (let i = 0; i < Math.max(0, replayActions - 1); i += 1) {
      irSteps.push({
        op: 'assert',
        contractRef: `ASN-${i + 1}`,
        channel: 'UI_TEXT',
        expected: 'OK',
      });
    }
    return {
      'evidence/action-evidence.json': JSON.stringify({
        schema: 'qaai-capture-first-evidence/1',
        entries: [
          {
            runResultId: 'rr-smoke',
            testCaseId: 'tc-smoke',
            caseName: 'smoke',
            actionEvidences: Array.from({ length: actions }, (_, index) => ({
              id: `act-${index}`,
              actionKind: index === 0 ? 'navigate' : 'assert',
              exportable: true,
            })),
            locatorRecipes: [],
            assertionEvidences: Array.from({ length: assertions }, (_, index) => ({
              id: `asn-${index}`,
              assertionId: `ASN-${index}`,
              matched: true,
            })),
            navigationEvidences: [
              { requestedUrl: 'https://example.test', resolvedUrl: 'https://example.test' },
            ],
          },
        ],
      }),
      'evidence/replayir.json': JSON.stringify({
        schema: 'qaai-replayir-evidence/1',
        replayIr: [
          {
            runResultId: 'rr-smoke',
            testCaseId: 'tc-smoke',
            caseName: 'smoke',
            complete: missing === 0,
            gaps: missing === 0 ? [] : [{ code: 'missing_action_evidence' }],
            ir: { steps: irSteps },
          },
        ],
      }),
      'evidence/completeness-ledger.json': JSON.stringify({
        schema: 'qaai-evidence-completeness-ledger/1',
        ledgers: [{ runResultId: 'rr-smoke', testCaseId: 'tc-smoke', caseName: 'smoke', ledger }],
      }),
    };
  }

  const certifiedFiles = {
    ...baseFiles,
    ...evidenceFiles(),
  };

  function guessedLocatorEvidenceFiles() {
    const guessedResolve = {
      op: 'resolve',
      as: 'saveButton',
      guessedLocator: true,
      locatorConfidence: 'guessed',
      locatorProvenance: { kind: 'qaai_guessed_locator' },
      candidates: [
        { strategy: 'role', role: 'button', name: 'Save', provenance: 'qaai_guessed_locator' },
      ],
    };
    const ledger = {
      runResultId: 'rr-guessed',
      testCaseId: 'tc-guessed',
      caseName: 'guessed locator',
      evidenceStatus: 'capture_failed',
      plannedExecutableStepCount: 2,
      actionEvidenceCount: 2,
      replayIrActionCount: 2,
      plannedAssertionCount: 0,
      assertionEvidenceCount: 0,
      finalAssertionEvidenceCount: 0,
      missingEvidenceCount: 1,
      missingLocatorCount: 1,
      missingActionEvidenceCount: 0,
      missingAssertionCount: 0,
      parseFailedAssertionCount: 0,
      missingNavigationEvidenceCount: 0,
      missingAuthSetupCount: 0,
      manualGateCount: 0,
    };
    return {
      'evidence/action-evidence.json': JSON.stringify({
        entries: [
          {
            runResultId: 'rr-guessed',
            testCaseId: 'tc-guessed',
            caseName: 'guessed locator',
            actionEvidences: [
              { id: 'act-nav', actionKind: 'navigate', exportable: true },
              { id: 'act-click', actionKind: 'click', exportable: true },
            ],
            locatorRecipes: [],
            assertionEvidences: [],
            navigationEvidences: [
              { requestedUrl: 'https://example.test', resolvedUrl: 'https://example.test' },
            ],
          },
        ],
      }),
      'evidence/replayir.json': JSON.stringify({
        replayIr: [
          {
            runResultId: 'rr-guessed',
            testCaseId: 'tc-guessed',
            caseName: 'guessed locator',
            complete: true,
            gaps: [],
            ir: {
              steps: [
                { op: 'act', action: 'navigate', url: 'https://example.test' },
                guessedResolve,
                { op: 'act', action: 'click', target: 'saveButton', locatorConfidence: 'guessed' },
              ],
            },
          },
        ],
      }),
      'evidence/completeness-ledger.json': JSON.stringify({
        ledgers: [
          {
            runResultId: 'rr-guessed',
            testCaseId: 'tc-guessed',
            caseName: 'guessed locator',
            ledger,
          },
        ],
      }),
    };
  }

  it('hardens exported Playwright bundles with exact deps, video, and CI workflow', () => {
    const files = runner.hardenPlaywrightPackageFiles(baseFiles, {
      framework: 'playwright-reference',
    });
    const pkg = JSON.parse(files['package.json']);

    expect(pkg.devDependencies['@playwright/test']).not.toMatch(/^[~^]/);
    expect(pkg.devDependencies['@axe-core/playwright']).not.toMatch(/^[~^]/);
    expect(files['playwright.config.ts']).toContain("video: 'retain-on-failure'");
    expect(files['.github/workflows/qaai-run.yml']).toContain('npx playwright test');
    expect(files['.github/workflows/qaai-run.yml']).toContain('actions/upload-artifact@v4');
  });

  it('uses a lockfile-aware install command for every Playwright bundle', () => {
    const unlockedJs = runner.hardenPlaywrightPackageFiles(baseFiles, {
      framework: 'playwright-pom-js',
    });
    const unlockedWorkflow = unlockedJs['.github/workflows/qaai-run.yml'];
    expect(unlockedWorkflow).toContain('- run: npm install');
    expect(unlockedWorkflow).not.toContain('- run: npm ci');
    expect(unlockedWorkflow).not.toContain('cache: npm');

    const lockedJs = runner.hardenPlaywrightPackageFiles(
      {
        ...baseFiles,
        'package-lock.json': '{"lockfileVersion":3}\n',
      },
      { framework: 'playwright-pom-js' },
    );
    const lockedWorkflow = lockedJs['.github/workflows/qaai-run.yml'];
    expect(lockedWorkflow).toContain('- run: npm ci');
    expect(lockedWorkflow).toContain('cache: npm');

    const unlockedReference = runner.hardenPlaywrightPackageFiles(baseFiles, {
      framework: 'playwright-reference',
    });
    expect(unlockedReference['.github/workflows/qaai-run.yml']).toContain('- run: npm install');
    expect(unlockedReference['.github/workflows/qaai-run.yml']).not.toContain('cache: npm');
  });

  it('repairs existing workflows and wires the actual QAAI environment contract to GitHub secrets', () => {
    const originalWorkflow = [
      'name: Existing',
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: actions/setup-node@v4',
      '        with:',
      '          cache: npm',
      '      - run: npm ci',
      '      - run: npx playwright test',
      '',
    ].join('\n');
    const original = {
      ...baseFiles,
      'tests/support/env.js': [
        "export const username = readEnv('QAAI_USERNAME');",
        'export const targetUrl = process.env.QAAI_TARGET_URL;',
        '// QAAI_GUESSED_LOCATOR is diagnostic text, not an environment read.',
      ].join('\n'),
      '.github/workflows/existing.yml': originalWorkflow,
    };
    const files = runner.hardenPlaywrightPackageFiles(original, { framework: 'playwright-pom-js' });
    const workflow = files['.github/workflows/existing.yml'];

    expect(workflow).toContain('- run: npm install');
    expect(workflow).not.toContain('npm ci');
    expect(workflow).not.toContain('cache: npm');
    expect(workflow).toContain('QAAI_TARGET_URL: ${{ secrets.QAAI_TARGET_URL }}');
    expect(workflow).toContain('QAAI_USERNAME: ${{ secrets.QAAI_USERNAME }}');
    expect(workflow).not.toContain('secrets.QAAI_GUESSED_LOCATOR');
    expect(original['.github/workflows/existing.yml']).toBe(originalWorkflow);
  });

  it('fails quality-invalid in-memory JavaScript before launching Playwright and does not mutate it', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const source =
      "import { test } from '@playwright/test';\ntest.skip('x',async({page})=>{page.click('button')})\n";
    let launched = false;
    const report = await runValidation({
      projectId: 'project-quality',
      bundleId: 'run-quality',
      framework: 'playwright-pom-js',
      files: {
        ...baseFiles,
        'tests/quality.spec.js': source,
      },
      artifactRoot,
      execFileImpl: () => {
        launched = true;
      },
    });

    expect(launched).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.reason).toBe('generated_output_quality_failed');
    expect(report.outputQuality.ok).toBe(false);
    expect(report.outputQuality.lintErrors).toBeGreaterThan(0);
    expect(report.outputQuality.unformatted).toEqual([]);
    expect(report.certification.certified).toBe(false);
    expect(source).toContain("test.skip('x'");
  }, 20_000);

  it('formats valid generated JavaScript before execution without mutating the stored bundle', async () => {
    process.env.QAAI_ROUND_TRIP_SCRIPT_VALIDATION_ENABLED = '0';
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const source =
      "import { test,expect } from '@playwright/test';\ntest('formatted',async()=>{await expect.poll(()=>1).toBe(1)})\n";
    let writtenSource = '';
    const report = await runValidation({
      projectId: 'project-format',
      bundleId: 'run-format',
      framework: 'playwright-pom-js',
      files: {
        ...baseFiles,
        'tests/format.spec.js': source,
      },
      artifactRoot,
      execFileImpl: (_command, _args, options, callback) => {
        writtenSource = fs.readFileSync(path.join(options.cwd, 'tests/format.spec.js'), 'utf8');
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  { title: 'formatted', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
                ],
              },
            ],
          }),
          '',
        );
      },
    });

    expect(report.status).toBe('certified');
    expect(report.outputQuality).toMatchObject({ ok: true, unformatted: [] });
    expect(writtenSource).toContain('import { test, expect }');
    expect(writtenSource).toContain("test('formatted', async () => {");
    expect(source).toContain('test,expect');
  });

  it('strips platform environment and rejects private scoped env keys', () => {
    const env = runner.buildExecutionEnv({
      baseEnv: {
        PATH: 'C:/bin',
        DATABASE_URL: 'file:dev.db',
        JWT_SECRET: 'secret',
        QAAI_INTERNAL: 'nope',
      },
      scopedEnv: { TEST_USERNAME: 'Admin' },
    });

    expect(env.PATH).toBe('C:/bin');
    expect(env.TEST_USERNAME).toBe('Admin');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.JWT_SECRET).toBeUndefined();
    expect(env.QAAI_INTERNAL).toBeUndefined();
    expect(() => runner.buildExecutionEnv({ scopedEnv: { QAAI_PASSWORD: 'blocked' } })).toThrow(
      /script_validation_env_denied/,
    );
  });

  it('passes only declared external QAAI values so runtime data overrides bundled env safely', async () => {
    process.env.QAAI_ROUND_TRIP_SCRIPT_VALIDATION_ENABLED = '0';
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    let observedEnv = null;
    const report = await runValidation({
      projectId: 'project-env-override',
      bundleId: 'run-env-override',
      framework: 'playwright-pom-js',
      files: {
        ...baseFiles,
        '.env': 'QAAI_USERNAME=bundled-value\n',
        'tests/smoke.spec.ts': [
          "import { test, expect } from '@playwright/test';",
          "test('smoke', async () => {",
          "  await expect.poll(() => process.env.QAAI_USERNAME).toBe('runtime-value');",
          '});',
          '',
        ].join('\n'),
      },
      scopedEnv: { QAAI_USERNAME: 'runtime-value' },
      artifactRoot,
      execFileImpl: (_command, _args, options, callback) => {
        observedEnv = options.env;
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    ok: true,
                    tests: [
                      {
                        title: 'smoke',
                        outcome: 'expected',
                        results: [{ status: 'passed' }],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
      },
    });

    expect(report.status).toBe('certified');
    expect(observedEnv.QAAI_USERNAME).toBe('runtime-value');
    expect(observedEnv.QAAI_INTERNAL).toBeUndefined();
    expect(observedEnv.DATABASE_URL).toBeUndefined();
  });

  it('certifies a generated Playwright bundle only after a clean runner pass', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    let observed = null;
    const report = await runValidation({
      projectId: 'project-1',
      bundleId: 'run-1',
      framework: 'playwright-reference',
      files: certifiedFiles,
      artifactRoot,
      execFileImpl: (command, args, options, callback) => {
        observed = { command, args, options };
        fs.mkdirSync(path.join(options.cwd, 'test-results'), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, 'test-results', 'ok.json'), '{"ok":true}', 'utf8');
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    line: 2,
                    tests: [
                      { title: 'smoke', outcome: 'expected', results: [{ status: 'passed' }] },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
        return { on() {}, kill() {} };
      },
    });

    expect(observed.options.shell).toBe(false);
    expect(observed.options.env.DATABASE_URL).toBeUndefined();
    expect(observed.options.cwd).toContain('.qaai-script-validation-');
    expect(report.status).toBe('certified');
    expect(report.certification.certified).toBe(true);
    expect(report.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(report.artifacts.some((a) => a.relPath === 'validation-report.json')).toBe(true);
    expect(report.artifacts.some((a) => a.relPath === 'test-results/ok.json')).toBe(true);
  });

  it('does not turn a clean Playwright pass into failure for locator-only guessed evidence', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const report = await runValidation({
      projectId: 'project-1',
      bundleId: 'run-guessed-locator',
      framework: 'playwright-reference',
      files: { ...baseFiles, ...guessedLocatorEvidenceFiles() },
      artifactRoot,
      execFileImpl: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    tests: [
                      { title: 'smoke', outcome: 'expected', results: [{ status: 'passed' }] },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
        return { on() {}, kill() {} };
      },
    });

    expect(report.status).toBe('certified');
    expect(report.roundTripValidation.ok).toBe(true);
    expect(report.roundTripValidation.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: 'round_trip_locator_evidence_guessed',
          severity: 'warning',
          nonBlocking: true,
        }),
        expect.objectContaining({
          rule: 'round_trip_locator_identity_guessed',
          severity: 'warning',
          nonBlocking: true,
        }),
      ]),
    );
  });

  it('maps Playwright failures to exact output file and line evidence', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const report = await runValidation({
      projectId: 'project-1',
      bundleId: 'run-2',
      framework: 'playwright-reference',
      files: certifiedFiles,
      artifactRoot,
      execFileImpl: (_command, _args, options, callback) => {
        const err = new Error('playwright failed');
        err.code = 1;
        fs.mkdirSync(path.join(options.cwd, 'test-results', 'smoke'), { recursive: true });
        fs.writeFileSync(
          path.join(options.cwd, 'test-results', 'smoke', 'trace.zip'),
          'trace',
          'utf8',
        );
        callback(
          err,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    line: 2,
                    tests: [
                      {
                        title: 'smoke',
                        outcome: 'unexpected',
                        results: [
                          {
                            status: 'failed',
                            errors: [
                              {
                                message: 'Strict mode violation',
                                location: { file: 'tests/smoke.spec.ts', line: 3, column: 9 },
                              },
                            ],
                            attachments: [
                              {
                                name: 'trace',
                                path: 'test-results/smoke/trace.zip',
                                contentType: 'application/zip',
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
        return { on() {}, kill() {} };
      },
    });

    expect(report.status).toBe('failed');
    expect(report.certification.certified).toBe(false);
    expect(report.failures[0]).toMatchObject({
      file: 'tests/smoke.spec.ts',
      line: 3,
      code: '  await expect.poll(() => 1).toBe(1);',
      error: 'Strict mode violation',
      repairAvailable: true,
    });
    expect(report.failures[0].tracePath).toBe('test-results/smoke/trace.zip');
  });

  it('does not certify a passing script when capture-first evidence parity fails', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const report = await runValidation({
      projectId: 'project-1',
      bundleId: 'run-parity-fail',
      framework: 'playwright-reference',
      files: {
        ...baseFiles,
        ...evidenceFiles({
          planned: 29,
          actions: 16,
          replayActions: 7,
          assertions: 1,
          finalAssertions: 0,
          missing: 13,
        }),
      },
      artifactRoot,
      execFileImpl: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    tests: [
                      { title: 'smoke', outcome: 'expected', results: [{ status: 'passed' }] },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
        return { on() {}, kill() {} };
      },
    });

    expect(report.status).toBe('passed');
    expect(report.reason).toBe('playwright_run_passed_with_parity_diagnostics');
    expect(report.certification.scriptResult).toBe('Passed');
    expect(report.certification.certified).toBe(false);
    expect(report.certification.roundTripParityOk).toBe(false);
    expect(report.roundTripValidation.findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        'round_trip_evidence_incomplete',
        'round_trip_action_evidence_count_mismatch',
        'round_trip_final_assertion_missing',
        'round_trip_replay_action_count_mismatch',
      ]),
    );
  });

  it('records explicit rollout skip when round-trip validation is disabled', async () => {
    process.env.QAAI_ROUND_TRIP_SCRIPT_VALIDATION_ENABLED = '0';
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const report = await runValidation({
      projectId: 'project-1',
      bundleId: 'run-parity-disabled',
      framework: 'playwright-reference',
      files: {
        ...baseFiles,
        ...evidenceFiles({
          planned: 29,
          actions: 16,
          replayActions: 7,
          assertions: 1,
          finalAssertions: 0,
          missing: 13,
        }),
      },
      artifactRoot,
      execFileImpl: (_command, _args, _options, callback) => {
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    tests: [
                      { title: 'smoke', outcome: 'expected', results: [{ status: 'passed' }] },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
        return { on() {}, kill() {} };
      },
    });

    expect(report.status).toBe('certified');
    expect(report.roundTripValidation).toMatchObject({
      skipped: true,
      reason: 'round_trip_script_validation_disabled',
    });
    expect(report.certification.roundTripParityOk).toBe(true);
  });

  it('reruns only the failed test during repair rerun and reports healed on pass', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    let observed = null;
    const report = await runValidation({
      projectId: 'project-1',
      bundleId: 'run-3',
      framework: 'playwright-reference',
      files: certifiedFiles,
      artifactRoot,
      mode: 'repair_rerun',
      testFile: 'tests/smoke.spec.ts',
      testTitle: 'smoke',
      execFileImpl: (command, args, options, callback) => {
        observed = { command, args, options };
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  {
                    title: 'smoke',
                    file: 'tests/smoke.spec.ts',
                    tests: [
                      { title: 'smoke', outcome: 'expected', results: [{ status: 'passed' }] },
                    ],
                  },
                ],
              },
            ],
          }),
          '',
        );
        return { on() {}, kill() {} };
      },
    });

    expect(observed.args).toContain('tests/smoke.spec.ts');
    expect(observed.args).toContain('--grep');
    expect(observed.args).toContain('smoke');
    expect(report.status).toBe('healed');
    expect(report.reason).toBe('script_repair_rerun_passed');
    expect(report.certification.certified).toBe(true);
    expect(report.certification.scriptResult).toBe('Healed');
  });

  it('installs a generated lockfile with npm ci before resolving the workspace Playwright CLI', async () => {
    process.env.QAAI_ROUND_TRIP_SCRIPT_VALIDATION_ENABLED = '0';
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    const calls = [];
    let installed = false;
    const report = await runner.runScriptValidation({
      projectId: 'project-isolated-install',
      bundleId: 'run-isolated-install',
      framework: 'playwright-pom-js',
      files: {
        ...baseFiles,
        'package-lock.json': JSON.stringify({
          name: 'qaai-export',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': {
              name: 'qaai-export',
              devDependencies: {
                '@axe-core/playwright': '4.10.0',
                '@playwright/test': '1.40.0',
              },
            },
          },
        }),
      },
      artifactRoot,
      dependencyExecFileImpl: (command, args, options, callback) => {
        calls.push({ phase: 'install', command, args, cwd: options.cwd, shell: options.shell });
        installed = true;
        callback(null, 'dependencies installed', '');
      },
      resolveCliImpl: (name, binName, workspace) => {
        calls.push({ phase: 'resolve', name, binName, workspace, installed });
        return installed ? path.join(workspace, 'node_modules', '@playwright', 'test', 'cli.js') : null;
      },
      execFileImpl: (command, args, options, callback) => {
        calls.push({ phase: 'test', command, args, cwd: options.cwd });
        callback(
          null,
          JSON.stringify({
            suites: [
              {
                specs: [
                  { title: 'smoke', ok: true, tests: [{ results: [{ status: 'passed' }] }] },
                ],
              },
            ],
          }),
          '',
        );
      },
    });

    expect(calls.map((call) => call.phase)).toEqual(['install', 'resolve', 'test']);
    expect(calls[0].command).toBe(process.platform === 'win32' ? 'npm.cmd' : 'npm');
    expect(calls[0].args[0]).toBe('ci');
    expect(calls[0].shell).toBe(process.platform === 'win32');
    expect(calls[1]).toMatchObject({
      name: '@playwright/test',
      binName: 'playwright',
      installed: true,
    });
    expect(calls[1].workspace).toBe(calls[0].cwd);
    expect(calls[2].cwd).toBe(calls[0].cwd);
    expect(report.status).toBe('certified');
    expect(report.commands[0].cmd).toMatch(/^npm(?:\.cmd)? ci\b/);
  });

  it('returns truthful preview-only output when isolated dependency installation fails', async () => {
    const artifactRoot = tempRoot('qaai-script-artifacts-');
    let resolved = false;
    let launched = false;
    const report = await runner.runScriptValidation({
      projectId: 'project-install-failure',
      bundleId: 'run-install-failure',
      framework: 'playwright-pom-js',
      files: {
        ...baseFiles,
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': {
              devDependencies: {
                '@axe-core/playwright': '4.10.0',
                '@playwright/test': '1.40.0',
              },
            },
          },
        }),
      },
      artifactRoot,
      dependencyExecFileImpl: (_command, _args, _options, callback) => {
        const error = new Error('npm ci failed');
        error.code = 1;
        callback(error, '', 'registry unavailable');
      },
      resolveCliImpl: () => {
        resolved = true;
        return null;
      },
      execFileImpl: () => {
        launched = true;
      },
    });

    expect(resolved).toBe(false);
    expect(launched).toBe(false);
    expect(report.status).toBe('preview_only');
    expect(report.reason).toBe('dependency_install_failed');
    expect(report.summary).toEqual({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(report.logs.stderr).toContain('registry unavailable');
    expect(report.commands[0]).toMatchObject({ exitCode: 1, timedOut: false });
    expect(report.certification).toEqual({ scriptResult: 'Preview only', certified: false });
  });
});
