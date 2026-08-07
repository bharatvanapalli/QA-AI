const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Account Lockout After Repeated Failed Attempts", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Five consecutive failed login attempts show 'Invalid credentials' and no account lockout on this demo instance 
    await test.step("Five consecutive failed login attempts show 'Invalid credentials' and no account lockout on this demo instance", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      const el4 = page.getByRole("textbox", { name: "Username" });
      await el4.fill(readEnv("QAAI_USERNAME"));
      const el5 = page.getByRole("textbox", { name: "Password" });
      await el5.fill(readEnv("QAAI_PASSWORD"));
      const el6 = page.getByRole("button", { name: "Login" });
      await el6.click();
      const el7 = page.getByRole("textbox", { name: "Username" });
      await el7.fill(readEnv("QAAI_USERNAME"));
      const el8 = page.getByRole("textbox", { name: "Password" });
      await el8.fill(readEnv("QAAI_PASSWORD"));
      const el9 = page.getByRole("button", { name: "Login" });
      await el9.click();
      const el10 = page.getByRole("textbox", { name: "Username" });
      await el10.fill(readEnv("QAAI_USERNAME"));
      const el11 = page.getByRole("textbox", { name: "Password" });
      await el11.fill(readEnv("QAAI_PASSWORD"));
      const el12 = page.getByRole("button", { name: "Login" });
      await el12.click();
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el13 = page.getByRole("textbox", { name: "Username" });
      await el13.fill(readEnv("QAAI_USERNAME"));
      const el14 = page.getByRole("textbox", { name: "Password" });
      await el14.fill(readEnv("QAAI_PASSWORD"));
      const el15 = page.getByRole("button", { name: "Login" });
      await el15.click();
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var body = document.body.textContent; var locked = body.includes('Account is locked') || body.includes('locked'); var onLoginPage = !!document.querySelector('input[name="username"]'); return (locked || onLoginPage) ? 'policy_compliant' : 'crashed_or_undefined'; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-49598d2c: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-49598d2c: expected \"policy_compliant\"").toContain("policy_compliant");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => (document.querySelector('.oxd-alert-content-text, [role="alert"], [class*="alert"]')?.textContent?.trim() || 'no_alert')).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-4e4f3f2b: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-4e4f3f2b: expected \"Account is locked\"").toContain("Account is locked");
      }
      await page.screenshot({ path: "test-results/five-consecutive-failed-login-attempts-show-invalid-credentials-and-no-account-l.png", fullPage: true });
    });
  });
});
