import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayExport = require('../../server/services/codegen/replayExport');
const packageValidate = require('../../server/services/codegen/_packageValidate');
const playwrightPomJs = require('../../server/services/codegen/adapters/playwrightPomJs');

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const templateRoot = path.join(
  repoRoot,
  'server',
  'services',
  'codegen',
  'templates',
  'playwright-pom-js',
);

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
}

function emittedPackage() {
  return replayExport.assemblePackage({
    adapterId: 'playwright-pom-js',
    admitted: [],
    envVars: ['QAAI_TARGET_URL'],
    targetUrl: 'https://app.example.test',
  });
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.resolve(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function verifiedActionLocator(expression, accessibleName) {
  const nodeId = String(accessibleName || 'target').toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'target';
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'document-generated-package-execution',
    nodeId,
    connected: true,
  };
  return {
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    captureBinding: { kind: 'mcp_bound_ref', ref: nodeId },
    proof: {
      verified: true,
      sameElement: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      actedNodeBound: true,
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      count: 1,
      visible: true,
      enabled: true,
      source: 'verified_dom_inspection',
    },
    domAtlas: { verifiedActions: [{ nodeId }] },
    targetFacts: { role: 'button', accessibleName },
  };
}

describe('Playwright POM JavaScript package contract', () => {
  it('emits the committed package template as the authoritative package source', () => {
    const files = emittedPackage();
    const templatePackage = fs.readFileSync(path.join(templateRoot, 'package.json'), 'utf8');
    const templateLock = fs.readFileSync(path.join(templateRoot, 'package-lock.json'), 'utf8');

    expect(files['package.json']).toBe(
      templatePackage.endsWith('\n') ? templatePackage : `${templatePackage}\n`,
    );
    expect(files['package-lock.json']).toBe(
      templateLock.endsWith('\n') ? templateLock : `${templateLock}\n`,
    );
  });

  it('repairs package.json and package-lock.json together from the authoritative template', () => {
    const expected = emittedPackage();
    const damaged = {
      ...expected,
      'package.json': JSON.stringify({
        name: 'qaai-replayir-export',
        version: '0.0.0',
        private: true,
        type: 'module',
        devDependencies: { '@playwright/test': '^1.61.1' },
      }),
      'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
    };

    const repaired = replayExport.applyPackageCertificationRepairs({
      adapterId: 'playwright-pom-js',
      files: damaged,
    });

    expect(repaired.repairs.map((repair) => repair.rule)).toContain(
      'pom_js_package_contract_restored',
    );
    expect(repaired.files['package.json']).toBe(expected['package.json']);
    expect(repaired.files['package-lock.json']).toBe(expected['package-lock.json']);
  });

  it('omits test helpers when no generated source imports them', () => {
    const files = emittedPackage();

    expect(files['utils/test-helpers.js']).toBeUndefined();
    expect(files['utils/test-helpers.ts']).toBeUndefined();
  });

  it('restores the ESM test helper only when a generated source imports it', () => {
    const repaired = replayExport.applyPackageCertificationRepairs({
      adapterId: 'playwright-pom-js',
      files: {
        ...emittedPackage(),
        'tests/orders/create-order.spec.js': [
          "import { test } from '@playwright/test';",
          "import { safeGoto } from '../../utils/test-helpers.js';",
          "test('create order', async ({ page }) => { await safeGoto(page, '/orders'); });",
        ].join('\n'),
      },
    });

    expect(repaired.files['utils/test-helpers.js']).toContain('export async function safeGoto');
    expect(repaired.files['utils/test-helpers.js']).not.toContain('module.exports');
    expect(repaired.repairs).toContainEqual(
      expect.objectContaining({
        rule: 'playwright_test_helper_repaired',
        path: 'utils/test-helpers.js',
      }),
    );
  });

  it('binds a uniquely matched fixture literal and leaves ambiguous repeated values isolated', () => {
    const files = {
      ...emittedPackage(),
      'tests/orders/create-order.spec.js': [
        "import { test } from '@playwright/test';",
        "import { loadDataRows, readData } from '../support/replayir.js';",
        "const _dataRows = loadDataRows('tests/data/create-order.json');",
        "test('create order', async ({ page }) => {",
        '  for (const row of _dataRows) {',
        "    await createOrderPage.assertOwningOrganizationValue('*SIGROUP-EUR SOURCE SYSTEM 01');",
        "    await createOrderPage.assertRepeatedValue('same-value');",
        '  }',
        '});',
      ].join('\n'),
      'tests/data/create-order.json': `${JSON.stringify(
        [
          {
            index: 1,
            label: 'Row 1',
            fields: {
              owning_organization_selection: '*SIGROUP-EUR SOURCE SYSTEM 01',
              first_repeated_column: 'same-value',
              second_repeated_column: 'same-value',
            },
          },
        ],
        null,
        2,
      )}\n`,
    };

    const repaired = replayExport.applyPackageCertificationRepairs({
      adapterId: 'playwright-pom-js',
      files,
    });
    const spec = repaired.files['tests/orders/create-order.spec.js'];

    expect(spec).toContain(
      'await createOrderPage.assertOwningOrganizationValue(readData(row, "owning_organization_selection"));',
    );
    expect(spec).toContain("await createOrderPage.assertRepeatedValue('same-value');");
    expect(repaired.repairs.map((repair) => repair.rule)).toContain(
      'pom_graph_hardcoded_data_value_bound',
    );
  });

  it('removes an unreferenced auth setup file and retains a configured setup project', () => {
    const setupSource = "import { test } from '@playwright/test';\ntest('authenticate', async () => {});\n";
    const orphaned = replayExport.applyPackageCertificationRepairs({
      adapterId: 'playwright-pom-js',
      files: {
        ...emittedPackage(),
        'fixtures/auth/auth.setup.ts': setupSource,
        'playwright.config.ts': "import { defineConfig } from '@playwright/test';\nexport default defineConfig({ projects: [{ name: 'chromium' }] });\n",
      },
    });
    expect(orphaned.files['fixtures/auth/auth.setup.ts']).toBeUndefined();
    expect(orphaned.repairs.map((repair) => repair.rule)).toContain(
      'pom_graph_unreferenced_auth_setup_removed',
    );

    const configured = replayExport.applyPackageCertificationRepairs({
      adapterId: 'playwright-pom-js',
      files: {
        ...emittedPackage(),
        'fixtures/auth/auth.setup.ts': setupSource,
        'playwright.config.ts': [
          "import { defineConfig } from '@playwright/test';",
          "export default defineConfig({ projects: [{ name: 'setup', testMatch: /auth\\.setup\\.ts/ }, { name: 'chromium', dependencies: ['setup'] }] });",
        ].join('\n'),
      },
    });
    expect(configured.files['fixtures/auth/auth.setup.ts']).toBe(setupSource);
  });

  it('checks full root dependency parity plus exact direct versions and integrity', () => {
    const files = emittedPackage();
    const goodRoot = tempDir('qaai-pom-js-manifest-good-');
    const badRoot = tempDir('qaai-pom-js-manifest-bad-');
    try {
      writeFiles(goodRoot, {
        'package.json': files['package.json'],
        'package-lock.json': files['package-lock.json'],
      });
      expect(packageValidate.collectNpmManifestFindings(goodRoot)).toEqual([]);

      const badPackage = JSON.parse(files['package.json']);
      badPackage.devDependencies['@playwright/test'] = '^1.61.1';
      const badLock = JSON.parse(files['package-lock.json']);
      delete badLock.packages['node_modules/@axe-core/playwright'].integrity;
      writeFiles(badRoot, {
        'package.json': `${JSON.stringify(badPackage, null, 2)}\n`,
        'package-lock.json': `${JSON.stringify(badLock, null, 2)}\n`,
      });
      const rules = packageValidate
        .collectNpmManifestFindings(badRoot)
        .map((finding) => finding.rule);
      expect(rules).toContain('package_lock_root_dependency_mismatch');
      expect(rules).toContain('package_dependency_not_exact');
      expect(rules).toContain('package_dependency_lock_integrity_missing');
    } finally {
      fs.rmSync(goodRoot, { recursive: true, force: true });
      fs.rmSync(badRoot, { recursive: true, force: true });
    }
  });

  it('finds missing relative imports, extensionless ESM imports, and undeclared bare packages', () => {
    const files = emittedPackage();
    const root = tempDir('qaai-pom-js-closure-bad-');
    try {
      writeFiles(root, {
        'package.json': files['package.json'],
        'pages/ExistingPage.js': 'export class ExistingPage {}\n',
        'tests/example.spec.js': [
          "import { test } from '@playwright/test';",
          "import { ExistingPage } from '../pages/ExistingPage';",
          "import { MissingPage } from '../pages/MissingPage.js';",
          "import leftPad from 'left-pad';",
          "test('closure', async () => { void ExistingPage; void MissingPage; void leftPad; });",
        ].join('\n'),
      });
      const rules = packageValidate
        .collectModuleClosureFindings(root)
        .map((finding) => finding.rule);
      expect(rules).toContain('package_esm_import_extension_missing');
      expect(rules).toContain('package_relative_import_missing');
      expect(rules).toContain('package_bare_import_undeclared');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a complete ESM import/dependency closure', () => {
    const files = emittedPackage();
    const root = tempDir('qaai-pom-js-closure-good-');
    try {
      writeFiles(root, {
        'package.json': files['package.json'],
        'pages/ExistingPage.js': 'export class ExistingPage {}\n',
        'tests/example.spec.js': [
          "import fs from 'node:fs';",
          "import { test } from '@playwright/test';",
          "import { ExistingPage } from '../pages/ExistingPage.js';",
          "test('closure', async () => { void fs; void ExistingPage; });",
        ].join('\n'),
      });
      expect(packageValidate.collectModuleClosureFindings(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores import-like override instructions that appear only in comments', () => {
    const files = emittedPackage();
    const root = tempDir('qaai-pom-js-comment-import-');
    try {
      writeFiles(root, {
        'package.json': files['package.json'],
        'locators/generated/example.generated.locators.js': [
          '// To override: re-export from \'../overrides/example.override.js\'.',
          '/* import { missing } from "../overrides/missing.js"; */',
          'export const exampleLocators = {};',
        ].join('\n'),
      });
      expect(packageValidate.collectModuleClosureFindings(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('installs an emitted package cleanly with npm ci --ignore-scripts', () => {
    const cli = npmCliPath();
    expect(cli, 'npm CLI must be available for clean-install acceptance').toBeTruthy();
    const files = emittedPackage();
    const root = tempDir('qaai-pom-js-clean-install-');
    try {
      writeFiles(root, {
        'package.json': files['package.json'],
        'package-lock.json': files['package-lock.json'],
      });
      const result = spawnSync(
        process.execPath,
        [cli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, CI: '1' },
        },
      );
      expect(result.error, result.error && result.error.message).toBeUndefined();
      expect(result.status, `${result.stdout || ''}\n${result.stderr || ''}`).toBe(0);
      expect(
        fs.existsSync(path.join(root, 'node_modules', '@playwright', 'test', 'package.json')),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, 'node_modules', '@axe-core', 'playwright', 'package.json')),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 130_000);

  it('executes an assembled generated POM package with its verified locator and assertion', () => {
    const npmCli = npmCliPath();
    expect(npmCli, 'npm CLI must be available for generated-package execution').toBeTruthy();
    const html = [
      '<!doctype html>',
      '<button aria-label="Run check" onclick="document.getElementById(\'status\').textContent=\'Done\'">Run check</button>',
      '<div id="status" role="status"></div>',
    ].join('');
    const pageUrl = `data:text/html,${encodeURIComponent(html)}`;
    const locator = verifiedActionLocator(
      'getByRole("button", { name: "Run check", exact: true })',
      'Run check',
    );
    const occurrence = {
      caseId: 'controlled-generated-package',
      contractStepId: 'click-run-check',
      actionOccurrenceId: 'controlled-generated-package:click-run-check:1',
      authoredActionId: 'click-run-check',
      occurrenceKey: 'controlled-generated-package:click-run-check:1',
      sequenceIndex: 2,
      authoredSequenceIndex: 2,
      occurrenceOrdinal: 1,
      operation: 'click',
    };
    const emitted = playwrightPomJs.emitJourneySpec(
      [
        {
          caseId: 'controlled-generated-package',
          caseName: 'Controlled generated package execution',
          status: 'pass',
          ir: {
            version: 1,
            caseId: 'controlled-generated-package',
            title: 'Controlled generated package execution',
            steps: [
              {
                op: 'act',
                action: 'navigate',
                url: pageUrl,
                contractStepId: 'open-controlled-page',
                authored: true,
                canonicalExecution: true,
                success: true,
                executionStatus: 'passed',
                origin: 'runtime_evidence',
              },
              {
                op: 'resolve',
                as: 'runCheckButton',
                elementLabel: 'Run check',
                actionLocator: locator,
                ...occurrence,
              },
              {
                op: 'act',
                action: 'click',
                target: 'runCheckButton',
                targetLabel: 'Run check',
                actionLocator: locator,
                authored: true,
                canonicalExecution: true,
                success: true,
                executionStatus: 'passed',
                origin: 'runtime_evidence',
                ...occurrence,
              },
              {
                op: 'assert',
                channel: 'UI_TEXT',
                expected: 'Done',
                contractRef: 'assert-done',
              },
            ],
            verdict: { status: 'pass', perAssertionOutcomes: [] },
          },
        },
      ],
      { scenarioName: 'Controlled package' },
    );
    const emittedSource = JSON.stringify(emitted);
    expect(emittedSource).toContain('InlineDocumentPage');
    expect(emittedSource).toContain('openInlineDocument');
    expect(emittedSource).not.toMatch(/html3c|doctype20html|run20check/i);
    const files = replayExport.assemblePackage({
      adapterId: 'playwright-pom-js',
      admitted: [
        {
          ...emitted,
          filePath: 'tests/controlled/generated-package.spec.js',
        },
      ],
      envVars: [],
      targetUrl: '',
    });
    const root = tempDir('qaai-pom-js-execution-');
    try {
      writeFiles(root, files);
      const install = spawnSync(
        process.execPath,
        [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, CI: '1' },
        },
      );
      expect(install.error, install.error && install.error.message).toBeUndefined();
      expect(install.status, `${install.stdout || ''}\n${install.stderr || ''}`).toBe(0);

      const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
      expect(fs.existsSync(playwrightCli)).toBe(true);
      const execution = spawnSync(
        process.execPath,
        [playwrightCli, 'test', 'tests/controlled/generated-package.spec.js', '--reporter=line', '--workers=1'],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 120_000,
          env: { ...process.env, CI: '1', QAAI_TARGET_URL: '' },
        },
      );
      expect(execution.error, execution.error && execution.error.message).toBeUndefined();
      expect(execution.status, `${execution.stdout || ''}\n${execution.stderr || ''}`).toBe(0);
      expect(`${execution.stdout || ''}\n${execution.stderr || ''}`).toMatch(/1 passed/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 250_000);
});
