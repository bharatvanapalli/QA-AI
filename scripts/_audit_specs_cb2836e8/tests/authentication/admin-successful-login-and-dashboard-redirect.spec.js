const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Admin Successful Login and Dashboard Redirect", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Admin login with valid credentials redirects to dashboard ───────
    await test.step("Admin login with valid credentials redirects to dashboard", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      await assertTextPresent(page, "Dashboard", "ASN-7d103389", 10000);
      {
        const _evalResult = String(await evaluateSettled(page, () => (!!document.querySelector('[role="navigation"] a, .oxd-nav-item')?.closest('nav')?.textContent?.includes('Admin') || !!Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === 'Admin'))).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-53369b06: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-53369b06: expected \"true\"").toContain("true");
      }
      {
        const _evalResult = String(await evaluateSettled(page, () => (!!document.querySelector('.oxd-userdropdown-name, .oxd-topbar-header-userinfo, [class*="userdropdown"]')?.textContent?.trim())).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-de64d66e: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-de64d66e: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/admin-login-with-valid-credentials-redirects-to-dashboard.png", fullPage: true });
    });

    // ─── Admin dashboard displays admin-specific widgets ─────────────────
    await test.step("Admin dashboard displays admin-specific widgets", async () => {
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var links = Array.from(document.querySelectorAll('a, [role="menuitem"]')).map(el => el.textContent.trim()); return ['Admin','PIM','Recruitment'].every(m => links.includes(m)); })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-fe890459: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-fe890459: expected \"true\"").toContain("true");
      }
      await page.screenshot({ path: "test-results/admin-dashboard-displays-admin-specific-widgets.png", fullPage: true });
    });
  });
});
