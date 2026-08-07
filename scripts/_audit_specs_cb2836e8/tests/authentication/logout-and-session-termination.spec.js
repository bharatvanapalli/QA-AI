const { test, expect } = require('@playwright/test');
const { assertTextPresent, dismissKnownPopups, readEnv, resolveLocator, evaluateSettled } = require('../support/replayir');

// QAAI Journey Export — test steps share browser state.
// Run as a suite. Individual test.step blocks are not standalone tests.
test.describe("Logout and Session Termination", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test('full journey', async ({ page }) => {
    // ─── Direct navigation to /dashboard after logout redirects to login page 
    await test.step("Direct navigation to /dashboard after logout redirects to login page", async () => {
      await page.goto("https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index");
      await assertTextPresent(page, "Username", "ASN-a0b8147e", 10000);
      await page.screenshot({ path: "test-results/direct-navigation-to-dashboard-after-logout-redirects-to-login-page.png", fullPage: true });
    });
  });
});
