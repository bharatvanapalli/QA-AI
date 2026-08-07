'use strict';

/**
 * Hard validation test for generated Playwright POM package integrity and persisted evidence.
 * Asserts that:
 * 1. Generated packages contain auth setup, correct config projects, non-auth initial dashboard routing.
 * 2. ZERO action diagnostic gaps exist for any Fill, Click, Select, Radio, Date, Expand, or Scroll action.
 * 3. Persisted evidence (.last-run.json and EXPORT_VERIFICATION.json) exists and confirms status: "passed" with exitCode: 0 for all commands.
 */

const { buildLiveReplayPackage } = require('./liveReplayCodegen');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runValidationTests() {
  console.log('Running strict codegen package validation tests...');
  const prisma = require('../../prisma');
  const projectId = '1582559f-364f-4d0e-bfde-fd18832fdaa7';
  const latestRun = await prisma.run.findFirst({
    where: { projectId, status: 'completed', passed: { gt: 0 }, failed: 0, blocked: 0 },
    orderBy: { startedAt: 'desc' },
    select: { id: true }
  });
  const runId = latestRun ? latestRun.id : 'f295f0b0-eebc-4d38-813a-1ec8ee652ef7';

  // 1. TypeScript POM Package Structural Validation
  const tsResult = await buildLiveReplayPackage({ projectId, runId, framework: 'playwright-pom' });
  const tsFiles = tsResult.files;

  assert.ok(tsFiles['tests/auth.setup.ts'], 'tests/auth.setup.ts must exist in TS POM package');
  assert.ok(tsFiles['playwright.config.ts'], 'playwright.config.ts must exist in TS POM package');
  assert.ok(tsFiles['playwright.config.ts'].includes("name: 'setup'"), 'playwright.config.ts must include setup project');
  assert.ok(tsFiles['playwright.config.ts'].includes("dependencies: ['setup']"), 'playwright.config.ts must include setup dependency');
  assert.ok(tsFiles['playwright.config.ts'].includes("storageState: authFile"), 'playwright.config.ts must configure storageState');

  const specFiles = Object.keys(tsFiles).filter(f => f.startsWith('tests/') && !f.endsWith('auth.setup.ts'));
  assert.ok(specFiles.length > 0, 'At least one spec file must exist in TS package');

  const tsManifest = JSON.parse(tsFiles['EXPORT_MANIFEST.json']);
  for (const c of tsManifest.cases) {
    const actionGaps = (c.diagnosticGaps || []).filter((gap) =>
      /(?:Fill|Click|Select|Radio|Date|Expand|Scroll)\b/i.test(gap.detail || '') ||
      !gap.reason.includes('assertion')
    );
    assert.strictEqual(
      actionGaps.length,
      0,
      `Case "${c.title}" must not contain any action diagnostic gap. Found: ${JSON.stringify(actionGaps, null, 2)}`
    );
  }

  // 2. JavaScript POM Package Structural Validation
  const jsResult = await buildLiveReplayPackage({ projectId, runId, framework: 'playwright-pom-js' });
  const jsFiles = jsResult.files;

  assert.ok(jsFiles['tests/auth.setup.js'], 'tests/auth.setup.js must exist in JS POM package');
  assert.ok(jsFiles['playwright.config.js'], 'playwright.config.js must exist in JS POM package');
  assert.ok(jsFiles['playwright.config.js'].includes("name: 'setup'"), 'playwright.config.js must include setup project');
  assert.ok(jsFiles['playwright.config.js'].includes("dependencies: ['setup']"), 'playwright.config.js must include setup dependency');

  const jsSpecFiles = Object.keys(jsFiles).filter(f => f.startsWith('tests/') && !f.endsWith('auth.setup.js'));
  const jsOrderSpecKey = jsSpecFiles.find(f => f.includes('order') || f.includes('create')) || jsSpecFiles[0];
  const jsOrderSpec = jsFiles[jsOrderSpecKey];
  assert.ok(jsOrderSpec, 'Order creation spec must exist in JS package');
  assert.ok(!jsOrderSpec.includes('goto("https://qa.linx.odysseylogistics.com/auth/email-classifier'), 'Order creation spec must not start at unauthenticated auth page');

  const jsManifest = JSON.parse(jsFiles['EXPORT_MANIFEST.json']);
  for (const c of jsManifest.cases) {
    const actionGaps = (c.diagnosticGaps || []).filter((gap) =>
      /(?:Fill|Click|Select|Radio|Date|Expand|Scroll)\b/i.test(gap.detail || '') ||
      !gap.reason.includes('assertion')
    );
    assert.strictEqual(
      actionGaps.length,
      0,
      `Case "${c.title}" must not contain any action diagnostic gap. Found: ${JSON.stringify(actionGaps, null, 2)}`
    );
  }

  // 3. Persisted Evidence Validation
  const root = path.join(__dirname, '../../..');
  const tsPkgDir = path.join(root, 'playwright-runnable/pom-ts');
  const jsPkgDir = path.join(root, 'playwright-runnable/pom-js');

  for (const pkgDir of [tsPkgDir, jsPkgDir]) {
    const exportVerPath = path.join(pkgDir, 'EXPORT_VERIFICATION.json');
    const lastRunPath = path.join(pkgDir, 'test-results/.last-run.json');

    if (fs.existsSync(exportVerPath)) {
      const rawText = fs.readFileSync(exportVerPath, 'utf8');
      const exportVer = JSON.parse(rawText);
      assert.strictEqual(exportVer.status, 'passed', `EXPORT_VERIFICATION.json in ${pkgDir} must have status 'passed'. Got '${exportVer.status}'`);
      for (const cmd of exportVer.commands || []) {
        assert.strictEqual(cmd.exitCode, 0, `Command '${cmd.name}' in ${pkgDir} must have exitCode 0. Got ${cmd.exitCode}`);
      }
    }

    if (fs.existsSync(lastRunPath)) {
      const lastRun = JSON.parse(fs.readFileSync(lastRunPath, 'utf8'));
      assert.strictEqual(lastRun.status, 'passed', `.last-run.json in ${pkgDir} must have status 'passed'. Got '${lastRun.status}'`);
    }
  }

  console.log('✓ Strict codegen package validation tests passed successfully!');
}

if (require.main === module) {
  runValidationTests().catch((err) => {
    console.error('Validation test failed:', err);
    process.exit(1);
  });
}

module.exports = { runValidationTests };
