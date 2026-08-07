const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Invalid Credentials Handling", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Login with invalid username and valid password shows Invalid credentials 
    await test.step("Login with invalid username and valid password shows Invalid credentials", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Username", "ASN-0ca0a7a7", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => (document.querySelector('.oxd-alert-content-text, .orangehrm-login-error, [class*="alert"], [role="alert"]')?.textContent?.trim() || '')).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-4982d27a: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-4982d27a: expected \"Invalid credentials\"").toContain("Invalid credentials");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var el = document.querySelector('.oxd-alert-content-text, .orangehrm-login-error, [class*="alert"], [role="alert"]'); return el === null || !el.textContent.includes('user not found'); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-da9f4490: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-da9f4490: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/login-with-invalid-username-and-valid-password-shows-invalid-credentials.png", fullPage: true });
    });

    // ─── Login with valid username and wrong password shows Invalid credentials 
    await test.step("Login with valid username and wrong password shows Invalid credentials", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Username", "ASN-fbf1e3c4", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => (document.querySelector('.oxd-alert-content-text, .orangehrm-login-error, [class*="alert"], [role="alert"]')?.textContent?.trim() || '')).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-75764f92: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-75764f92: expected \"Invalid credentials\"").toContain("Invalid credentials");
      }
      await page.screenshot({ path: "test-results/login-with-valid-username-and-wrong-password-shows-invalid-credentials.png", fullPage: true });
    });

    // ─── Login with non-existent username does not reveal account existence 
    await test.step("Login with non-existent username does not reveal account existence", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Username", "ASN-acd9b611", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var el = document.querySelector('.oxd-alert-content-text, .orangehrm-login-error, [class*="alert"], [role="alert"]'); if(el === null) return true; var t = el.textContent.toLowerCase(); return !t.includes('user not found') && !t.includes('does not exist') && !t.includes('no account'); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-18f68d23: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-18f68d23: expected \"true\"").toContain("true");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var body = document.body.textContent; return !body.includes('Traceback') && !body.includes('stack trace') && !body.includes('Exception') && !body.includes('SQL'); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-216d405a: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-216d405a: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/login-with-non-existent-username-does-not-reveal-account-existence.png", fullPage: true });
    });

    // ─── Multiple failed login attempts do not crash application ─────────
    await test.step("Multiple failed login attempts do not crash application", async () => {
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
      await assertTextPresent(page, "Username", "ASN-6fb17864", 10000);
      await page.screenshot({ path: "test-results/multiple-failed-login-attempts-do-not-crash-application.png", fullPage: true });
    });
  });
});
