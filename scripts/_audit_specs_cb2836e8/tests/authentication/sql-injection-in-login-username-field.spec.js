const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("SQL Injection in Login Username Field", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── SQL injection payload in username is safely rejected with Invalid credentials 
    await test.step("SQL injection payload in username is safely rejected with Invalid credentials", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill("admin' OR '1'='1");
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Username", "ASN-235b89a4", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var body = document.body.textContent; return !body.includes('SQL') && !body.includes('syntax error') && !body.includes('Traceback') && !body.includes('PDOException') && !body.includes('mysql_fetch'); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-8672ce53: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-8672ce53: expected \"true\"").toContain("true");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => (document.querySelector('.oxd-alert-content-text, .orangehrm-login-error, [class*="alert"], [role="alert"]')?.textContent?.trim() || '')).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-3cea33d8: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-3cea33d8: expected \"Invalid credentials\"").toContain("Invalid credentials");
      }
      await page.screenshot({ path: "test-results/sql-injection-payload-in-username-is-safely-rejected-with-invalid-credentials.png", fullPage: true });
    });

    // ─── SQL injection payload does not grant authenticated access to dashboard 
    await test.step("SQL injection payload does not grant authenticated access to dashboard", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill("' OR 1=1--");
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      {
        const _evalResult = String(await evaluateSettled(page, () => (!window.location.href.includes('/dashboard'))).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-c98882d8: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-c98882d8: expected \"true\"").toContain("true");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var links = Array.from(document.querySelectorAll('a')).map(el => el.textContent.trim()); return !links.includes('Admin') || document.querySelector('input[name="username"]') !== null; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-f39ad6a1: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-f39ad6a1: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/sql-injection-payload-does-not-grant-authenticated-access-to-dashboard.png", fullPage: true });
    });
  });
});
