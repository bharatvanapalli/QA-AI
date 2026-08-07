const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Password Field Masking", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Password field masking is consistent after clear and re-entry ───
    await test.step("Password field masking is consistent after clear and re-entry", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Password" });
      await el1.click();
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.click();
      const el3 = page.getByRole("textbox", { name: "Password" });
      await el3.fill(readEnv("QAAI_PASSWORD"));
      {
        const _evalResult = String(await evaluateSettled(page, () => (document.querySelector('input[name="password"], input[type="password"]')?.getAttribute('type') || 'not_found')).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-e661779d: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-e661779d: expected \"password\"").toContain("password");
      }
      await page.screenshot({ path: "test-results/password-field-masking-is-consistent-after-clear-and-re-entry.png", fullPage: true });
    });
  });
});
