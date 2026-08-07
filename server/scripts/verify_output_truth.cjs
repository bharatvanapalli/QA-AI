"use strict";

const assert = require("assert/strict");
const quality = require("../services/generatedOutputQuality");
const readiness = require("../services/outputReadiness");
const runner = require("../services/scriptValidationRunner");

async function main() {
  const scriptValidation = {
    bundleId: "bundle-current",
    packageHash: "hash-current",
    status: "certified",
    summary: { total: 1, passed: 1, failed: 0 },
    outputQuality: { ok: true },
    certification: { certified: true },
  };
  const base = {
    outputAvailable: true,
    exportValid: true,
    packagePassed: true,
    contractCertification: { packagePassed: true },
    files: {
      "evidence/locator-manifest.json": JSON.stringify([
        {
          verified: true,
          verificationStatus: "verified",
          proof: { count: 1, sameElement: true },
        },
      ]),
    },
    scriptValidation,
    currentBundleId: "bundle-current",
    currentPackageHash: "hash-current",
  };
  assert.equal(readiness.evaluateOutputReadiness(base).certified, true);
  let adversarialIndex = 0;
  for (const override of [
    { exportValid: false },
    { packagePassed: false },
    { contractCertification: { packagePassed: false } },
    { contractCertification: null },
    { currentBundleId: "bundle-stale" },
    { currentPackageHash: "hash-stale" },
    { scriptValidation: null },
    { scriptValidation: { ...scriptValidation, outputQuality: undefined } },
    {
      files: {
        "evidence/locator-manifest.json": JSON.stringify([
          { guessedLocator: true, verified: false },
        ]),
      },
    },
    {
      files: {
        "locators/generated/loginPage.generated.locators.js":
          "export const locators = { continueButton: (page) => page.getByRole('button', { name: 'Continue' }) };\n",
        "evidence/locator-manifest.json": JSON.stringify([
          { name: "unknownLocator" },
        ]),
        "evidence/locator-certification-report.json": JSON.stringify({
          summary: { total: 1, certified: 1 },
        }),
      },
    },
    {
      files: {
        "locators/generated/loginPage.generated.locators.js":
          "export const locators = { continueButton: (page) => page.getByRole('button', { name: 'Continue' }) };\n",
        "evidence/locator-certification-report.json": JSON.stringify({
          summary: { total: 1, certified: 1 },
          steps: [],
        }),
      },
    },
    {
      files: {
        "locators/loginPage.locators.js": "export const locators = {};\n",
      },
    },
  ]) {
    const result = readiness.evaluateOutputReadiness({ ...base, ...override });
    assert.equal(result.downloadable, true);
    assert.equal(
      result.certified,
      false,
      `adversarial readiness case ${adversarialIndex}: ${JSON.stringify(result)}`,
    );
    adversarialIndex += 1;
  }

  const workflow =
    "name: Existing\njobs:\n  test:\n    steps:\n      - run: npm ci\n";
  const input = {
    "package.json": "{}",
    "tests/env.js": "export const username = readEnv('QAAI_USERNAME');\n",
    ".github/workflows/existing.yml": workflow,
  };
  const hardened = runner.hardenPlaywrightPackageFiles(input, {
    framework: "playwright-pom-js",
  });
  assert.match(hardened[".github/workflows/existing.yml"], /run: npm install/);
  assert.match(
    hardened[".github/workflows/existing.yml"],
    /QAAI_USERNAME: \$\{\{ secrets\.QAAI_USERNAME \}\}/,
  );
  assert.equal(input[".github/workflows/existing.yml"], workflow);

  const validSource = `import { expect, test } from '@playwright/test';

test('dashboard', async ({ page }) => {
  await page.goto('https://example.test');
  await expect(page).toHaveURL('https://example.test/');
});
`;
  const validQuality = await quality.verifyGeneratedFileMap({
    "tests/dashboard.spec.js": validSource,
  });
  assert.equal(validQuality.ok, true, JSON.stringify(validQuality.issues));
  const invalidQuality = await quality.verifyGeneratedFileMap({
    "tests/broken.spec.js":
      "import { test } from '@playwright/test';\ntest.skip('x',async({page})=>{page.click('button')})\n",
  });
  assert.equal(invalidQuality.ok, false);
  assert.ok(invalidQuality.lintErrors > 0);
  assert.deepEqual(invalidQuality.unformatted, ["tests/broken.spec.js"]);

  console.log("Output truth verification: 3 sections passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
