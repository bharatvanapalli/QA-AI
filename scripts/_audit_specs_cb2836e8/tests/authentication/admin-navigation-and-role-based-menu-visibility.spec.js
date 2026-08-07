const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Admin Navigation and Role-Based Menu Visibility", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Admin login reveals full module navigation including Admin and PIM 
    await test.step("Admin login reveals full module navigation including Admin and PIM", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      {
        const _evalResult = String(await evaluateSettled(page, () => { (function(){ var links = Array.from(document.querySelectorAll('a, [role="menuitem"]')).map(el => el.textContent.trim()); return ['Admin','PIM','Leave','Time','Recruitment'].every(m => links.includes(m)) ? 'all_visible' : 'missing_modules'; })() }).catch((e) => `EVALUATE_ERROR:${e.message}`));
        test.info().annotations.push({ type: 'evaluate-result', description: `ASN-ff0d4613: ${_evalResult}` });
        expect(_evalResult, "EVALUATE ASN-ff0d4613: expected \"all_visible\"").toContain("all_visible");
      }
      await assertTextPresent(page, "Admin", "ASN-abac6eb4", 10000);
      await page.screenshot({ path: "test-results/admin-login-reveals-full-module-navigation-including-admin-and-pim.png", fullPage: true });
    });
  });
});
