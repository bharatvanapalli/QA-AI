const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assemblePackage, combineSiblingPomExports } = require('../../server/services/codegen/replayExport');

function generatedPomPackage(adapterId, extension) {
  return assemblePackage({
    adapterId,
    admitted: [{
      filePath: `tests/example.spec.${extension}`,
      content: [
        "import { test, expect } from '@playwright/test';",
        "test('generated semantic check', async () => { expect(1).toBe(1); });",
        '',
      ].join('\n'),
    }],
    envVars: [],
    targetUrl: 'https://example.test',
  });
}

function resolveLocalTypeScriptCompiler() {
  for (const searchRoot of [
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../server'),
  ]) {
    try {
      return require.resolve('typescript/lib/tsc.js', { paths: [searchRoot] });
    } catch (_) {
      // The export declares TypeScript for consumers; this checkout may not have it installed.
    }
  }
  return null;
}

const localTypeScriptCompiler = resolveLocalTypeScriptCompiler();

function child(adapterId, extension, enabledTestCount = 2) {
  return {
    adapterId,
    runId: 'run-1',
    bundleId: `bundle-${extension}`,
    files: {
      [`tests/example.spec.${extension}`]: `// ${adapterId}\n`,
      'EXPORT_MANIFEST.json': '{}\n',
    },
    manifest: { exportValid: true, executedCaseAst: { enabledTestCount } },
    admitted: [{ runResultId: 'result-1' }],
    blocked: [],
    findings: [],
    allBlocked: false,
  };
}

describe('dual Playwright POM export', () => {
  it('packages JavaScript and TypeScript as immutable siblings with inventory parity', () => {
    const result = combineSiblingPomExports({
      javascript: child('playwright-pom-js', 'js'),
      typescript: child('playwright-pom', 'ts'),
    });

    expect(result.adapterId).toBe('playwright-pom-dual');
    expect(result.files['javascript/tests/example.spec.js']).toContain('playwright-pom-js');
    expect(result.files['typescript/tests/example.spec.ts']).toContain('playwright-pom');
    expect(result.manifest.testInventoryParity).toBe(true);
    expect(result.manifest.exportValid).toBe(true);
    expect(result.bundleId).toMatch(/^bundle_[a-f0-9]{24}$/);
    expect(result.manifest.renderers.javascript.root).toBe('javascript/');
    expect(result.manifest.renderers.typescript.root).toBe('typescript/');
  });

  it('ships a bounded semantic type-check contract only in the TypeScript sibling', () => {
    const javascriptFiles = generatedPomPackage('playwright-pom-js', 'js');
    const typescriptFiles = generatedPomPackage('playwright-pom', 'ts');
    const typescriptPackage = JSON.parse(typescriptFiles['package.json']);
    const tsconfig = JSON.parse(typescriptFiles['tsconfig.json']);

    expect(typescriptPackage.scripts.typecheck).toBe('tsc --noEmit -p tsconfig.json');
    expect(typescriptPackage.devDependencies.typescript).toBe('^5.4.0');
    expect(typescriptPackage.devDependencies['@types/node']).toBe('^20.0.0');
    expect(tsconfig.compilerOptions).toMatchObject({
      target: 'ES2022',
      module: 'commonjs',
      moduleResolution: 'node',
      strict: true,
      noEmit: true,
      types: ['node'],
    });
    expect(tsconfig.include).toEqual([
      'playwright.config.ts',
      'tests/**/*.ts',
      'pages/**/*.ts',
      'locators/**/*.ts',
      'fixtures/**/*.ts',
      'utils/**/*.ts',
    ]);
    expect(tsconfig.exclude).toEqual(['node_modules', 'test-results', 'playwright-report']);
    expect(javascriptFiles['tsconfig.json']).toBeUndefined();
    expect(JSON.parse(javascriptFiles['package.json']).scripts.typecheck).toBeUndefined();

    const result = combineSiblingPomExports({
      javascript: { ...child('playwright-pom-js', 'js'), files: javascriptFiles },
      typescript: { ...child('playwright-pom', 'ts'), files: typescriptFiles },
    });
    expect(result.files['typescript/tsconfig.json']).toBe(typescriptFiles['tsconfig.json']);
    expect(result.files['typescript/package.json']).toBe(typescriptFiles['package.json']);
    expect(result.files['javascript/tsconfig.json']).toBeUndefined();
  });

  it('keeps available sibling output visible when only one renderer reports blocked source evidence', () => {
    const result = combineSiblingPomExports({
      javascript: child('playwright-pom-js', 'js'),
      typescript: { ...child('playwright-pom', 'ts'), allBlocked: true },
    });

    expect(result.allBlocked).toBe(false);
    expect(result.files['javascript/tests/example.spec.js']).toContain('playwright-pom-js');
    expect(result.files['typescript/tests/example.spec.ts']).toContain('playwright-pom');
  });

  it.skipIf(!localTypeScriptCompiler)('passes TypeScript semantic checking when a local compiler is available', () => {
    const files = generatedPomPackage('playwright-pom', 'ts');
    // Keep the temp package under server/ so TypeScript can resolve the same
    // already-installed Playwright dependencies used by export validation.
    const dir = fs.mkdtempSync(path.resolve(__dirname, '../../server/.qaai-pom-ts-typecheck-'));
    try {
      for (const [relativePath, content] of Object.entries(files)) {
        const fullPath = path.join(dir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
      }
      const result = spawnSync(process.execPath, [localTypeScriptCompiler, '--project', 'tsconfig.json', '--pretty', 'false'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (result.status !== 0) {
        const diagnostics = `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(0, 4000);
        throw new Error(`Generated TypeScript package failed semantic checking (exit ${result.status}):\n${diagnostics}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks certification when sibling enabled-test counts differ', () => {
    const result = combineSiblingPomExports({
      javascript: child('playwright-pom-js', 'js', 2),
      typescript: child('playwright-pom', 'ts', 1),
    });

    expect(result.manifest.testInventoryParity).toBe(false);
    expect(result.manifest.exportValid).toBe(false);
    expect(result.findings.some((finding) => finding.rule === 'sibling_enabled_test_inventory_mismatch')).toBe(true);
  });
});
