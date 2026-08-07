import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { verifyGeneratedOutput } from '../../scripts/verify-generated-output.mjs';
import generatedOutputQuality from '../../server/services/generatedOutputQuality.js';

const tempDirectories = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, {
        force: true,
        recursive: true,
      }),
    ),
  );
});

async function makeOutput(source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qaai-generated-quality-'));
  tempDirectories.push(directory);
  const file = path.join(directory, 'example.spec.js');
  await fs.writeFile(file, source, 'utf8');
  return { directory, file };
}

describe('generated output quality verifier', () => {
  it('lints the actual emitted CommonJS preflight with its runtime globals', async () => {
    const emitterSource = await fs.readFile(
      path.resolve('server/services/codegen/replayExport.js'),
      'utf8',
    );
    const match = /const QAAI_PREFLIGHT_JS = `([\s\S]*?)`;/.exec(emitterSource);
    expect(match).not.toBeNull();
    const emittedPreflight = vm.runInNewContext(`\`${match[1]}\``);

    const result = await generatedOutputQuality.verifyGeneratedFileMap(
      { 'qaai.preflight.cjs': emittedPreflight },
      { format: false },
    );

    expect(result.files).toEqual(['qaai.preflight.cjs']);
    expect(result.lintErrors).toBe(0);
    expect(result.issues).toEqual([]);

    const missingTargetWarnings = [];
    const missingTargetSandbox = {
      module: { exports: {} },
      process: { env: {} },
      console: { warn: (message) => missingTargetWarnings.push(String(message)) },
    };
    vm.runInNewContext(emittedPreflight, missingTargetSandbox);
    await expect(missingTargetSandbox.module.exports()).resolves.toBeUndefined();
    expect(missingTargetWarnings).toHaveLength(1);

    const fetchWarnings = [];
    const fetchFailureSandbox = {
      module: { exports: {} },
      process: { env: { QAAI_TARGET_URL: 'https://example.test' } },
      console: { warn: (message) => fetchWarnings.push(String(message)) },
      fetch: async () => {
        throw new Error('corporate proxy rejected Node fetch');
      },
      AbortSignal: { timeout: () => undefined },
    };
    vm.runInNewContext(emittedPreflight, fetchFailureSandbox);
    await expect(fetchFailureSandbox.module.exports()).resolves.toBeUndefined();
    expect(fetchWarnings).toHaveLength(1);
  }, 20_000);

  it('uses only the bounded committed generated-output fixture by default', async () => {
    const result = await verifyGeneratedOutput();

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatch(
      /tests[\\/]fixtures[\\/]generated-output-quality[\\/]dashboard\.spec\.js$/,
    );
    expect(result.lintErrors).toBe(0);
    expect(result.unformatted).toEqual([]);
  });

  it('accepts formatted Playwright code with awaited operations and assertions', async () => {
    const { directory } = await makeOutput(`import { test, expect } from '@playwright/test';

test('opens the dashboard', async ({ page }) => {
  await page.goto('https://example.test');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
`);
    const result = await verifyGeneratedOutput({ roots: [directory] });

    expect(result.files).toHaveLength(1);
    expect(result.lintErrors).toBe(0);
    expect(result.unformatted).toEqual([]);
  });

  it('recognizes generated POM assert methods as Playwright test assertions', async () => {
    const { directory } = await makeOutput(`import { test } from '@playwright/test';

test('validates the dashboard through its page object', async ({ page }) => {
  const dashboardPage = {
    async assertWelcomeMessage() {
      await page.getByText('Welcome OdysseyOne').waitFor();
    },
  };
  await dashboardPage.assertWelcomeMessage();
});
`);
    const result = await verifyGeneratedOutput({ roots: [directory] });

    expect(result.issues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ rule: 'playwright/expect-expect' })]),
    );
  });

  it('reports malformed generated patterns without mutating the file', async () => {
    const source =
      "import { test } from '@playwright/test';\ntest.skip('x',async({page})=>{page.click('button')})\n";
    const { directory, file } = await makeOutput(source);
    const result = await verifyGeneratedOutput({ roots: [directory] });

    expect(result.lintErrors).toBeGreaterThan(0);
    expect(result.unformatted).toEqual([file]);
    expect(await fs.readFile(file, 'utf8')).toBe(source);
  });

  it('enforces the configured traversal limit', async () => {
    const { directory } = await makeOutput(`import { test } from '@playwright/test';\n`);
    await fs.writeFile(path.join(directory, 'second.js'), 'export const value = 1;\n', 'utf8');

    await expect(verifyGeneratedOutput({ roots: [directory], maxFiles: 1 })).rejects.toThrow(
      'exceeded the 1-file safety limit',
    );
  });

  it('validates and formats generated TypeScript, JSON, and workflow YAML', async () => {
    const files = {
      'playwright.config.ts': "export default { use: { trace: 'retain-on-failure' } };\n",
      'package.json': '{"name":"generated-suite","private":true}\n',
      'package-lock.json': '{"name":"generated-suite","lockfileVersion":3}\n',
      '.github/workflows/qaai-run.yml': 'name: QAAI\non:\n  workflow_dispatch:\njobs: {}\n',
    };

    const formatted = await generatedOutputQuality.formatGeneratedFileMap(files);
    const result = await generatedOutputQuality.verifyGeneratedFileMap(formatted);

    expect(result.ok).toBe(true);
    expect(result.files).toEqual(Object.keys(files).sort());
    expect(result.unformatted).toEqual([]);
  });

  it('reports the exact non-JavaScript file when generated syntax is malformed', async () => {
    const files = {
      'playwright.config.ts': 'export default { use: );\n',
      'package.json': '{"name":}\n',
    };

    const formatted = await generatedOutputQuality.formatGeneratedFileMap(files);
    const result = await generatedOutputQuality.verifyGeneratedFileMap(formatted);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'package.json', rule: 'prettier-parse' }),
        expect.objectContaining({ file: 'playwright.config.ts', rule: 'prettier-parse' }),
      ]),
    );
  });
});
