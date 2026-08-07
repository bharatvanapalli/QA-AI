const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Login Form Security — No Sensitive Information Exposure", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Login form does not display password hints or username suggestions 
    await test.step("Login form does not display password hints or username suggestions", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var hints = Array.from(document.querySelectorAll('[placeholder], .password-hint, .username-hint, [data-hint]')).map(el => el.getAttribute('placeholder') || el.textContent).join(' ').toLowerCase(); return !hints.includes('your password is') && !hints.includes('hint:') && !hints.includes('default password'); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-20a68191: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-20a68191: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/login-form-does-not-display-password-hints-or-username-suggestions.png", fullPage: true });
    });

    // ─── Error messages after failed login are user-friendly and contain no stack trace 
    await test.step("Error messages after failed login are user-friendly and contain no stack trace", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var body = document.body.textContent; return !body.includes('Traceback') && !body.includes('Exception in') && !body.includes('at line') && !body.includes('stack:') && !body.includes('PDOException'); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-41ec3bbc: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-41ec3bbc: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/error-messages-after-failed-login-are-user-friendly-and-contain-no-stack-trace.png", fullPage: true });
    });
  });
});
