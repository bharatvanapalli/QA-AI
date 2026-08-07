const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Admin Session Persistence Across Page Navigations", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Admin session persists across navigation to PIM and back to dashboard 
    await test.step("Admin session persists across navigation to PIM and back to dashboard", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/auth/login");
      const el1 = page.getByRole("textbox", { name: "Username" });
      await el1.fill(readEnv("QAAI_USERNAME"));
      const el2 = page.getByRole("textbox", { name: "Password" });
      await el2.fill(readEnv("QAAI_PASSWORD"));
      const el3 = page.getByRole("button", { name: "Login" });
      await el3.click();
      const el4 = page.getByRole("link", { name: "PIM nav" });
      await el4.click();
      const el5 = page.getByRole("link", { name: "Dashboard nav" });
      await el5.click();
      await assertTextPresent(page, "Dashboard", "ASN-55f11a42", 10000);
      await page.screenshot({ path: "test-results/admin-session-persists-across-navigation-to-pim-and-back-to-dashboard.png", fullPage: true });
    });
  });
});
