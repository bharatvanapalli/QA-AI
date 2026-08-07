const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Login Form Empty Field Validation", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Submit login with empty password shows Password is required error 
    await test.step("Submit login with empty password shows Password is required error", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.click();
      const el2 = page.getByRole("textbox", { name: "Username" });
      await el2.fill(readEnv("QAAI_USERNAME"));
      const el3 = page.getByRole("textbox", { name: "Password" });
      await el3.click();
      const el4 = page.getByRole("button", { name: "Login" });
      await el4.click();
      await assertTextPresent(page, "Username", "ASN-bd299fc2", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => (Array.from(document.querySelectorAll('.oxd-input-field-error-message, .oxd-text--span, [class*="error-message"]')).map(el => el.textContent.trim()).join(' '))).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-78cc44af: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-78cc44af: expected \"Required\"").toContain("Required");
      }
      await page.screenshot({ path: "test-results/submit-login-with-empty-password-shows-password-is-required-error.png", fullPage: true });
    });

    // ─── Submit login with both fields empty shows errors on both fields simultaneously 
    await test.step("Submit login with both fields empty shows errors on both fields simultaneously", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.click();
      const el2 = page.getByRole("button", { name: "Login" });
      await el2.click();
      await assertTextPresent(page, "Username", "ASN-3026918a", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var msgs = Array.from(document.querySelectorAll('.oxd-input-field-error-message, .oxd-text--span, [class*="error-message"]')).map(el => el.textContent.trim()).join(' '); return msgs.includes('Required') ? 'two_errors' : 'none'; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-6f123056: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-6f123056: expected \"two_errors\"").toContain("two_errors");
      }
      await page.screenshot({ path: "test-results/submit-login-with-both-fields-empty-shows-errors-on-both-fields-simultaneously.png", fullPage: true });
    });

    // ─── Validation errors appear inline below fields not as generic alert 
    await test.step("Validation errors appear inline below fields not as generic alert", async () => {
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var errorEls = document.querySelectorAll('.oxd-input-field-error-message, .oxd-text--span, [class*="error-message"]'); return errorEls.length >= 2 ? 'inline_errors_present' : 'not_found'; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-09465b3e: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-09465b3e: expected \"inline_errors_present\"").toContain("inline_errors_present");
      }
      await page.screenshot({ path: "test-results/validation-errors-appear-inline-below-fields-not-as-generic-alert.png", fullPage: true });
    });
  });
});
