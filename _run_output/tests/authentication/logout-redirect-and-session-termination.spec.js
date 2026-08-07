// STATUS: DRAFT — quality flags (spec is runnable; review recommended): telemetry-annotations
import { test, expect } from '@playwright/test';
import { assertProductNamesContain, readData, loadDataRows } from '../support/replayir.js';
import { DashboardPage } from '../../pages/DashboardPage.js';
import { LoginPage } from '../../pages/LoginPage.js';

test.describe.skip("Logout — Redirect and Session Termination", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/admin-logout-redirects-to-auth-login-page.json");
  for (const row of _dataRows0) {
    test("Admin logout redirects to /auth/login page [" + row.label + ']', async ({ page }) => {
      const dashboardPage = new DashboardPage(page);
      const loginPage = new LoginPage(page);
      await page.goto("/");
      await page.goto("/web/index.php/auth/login");
      await loginPage.fillUsername(readData(row, "username"));
      await loginPage.fillPassword(readData(row, "password"));
      await loginPage.clickLogin();
      await page.waitForURL("**/auth/login", { timeout: 10000 });
      await dashboardPage.clickLogout();
      await page.waitForURL("**/auth/login", { timeout: 10000 });
      await expect(page).toHaveURL(new RegExp("/web/index.php/dashboard/index"), { timeout: 10000 });
      await loginPage.expectProductGridToContain(readData(row, "expectedLandingPage"));
      await page.screenshot({ path: "test-results/admin-logout-redirects-to-auth-login-page.png", fullPage: true });
    });
  }

  const _dataRows1 = loadDataRows("tests/data/post-logout-direct-navigation-to-dashboard-redirects-to-login.json");
  for (const row of _dataRows1) {
    test("Post-logout direct navigation to /dashboard redirects to login [" + row.label + ']', async ({ page }) => {
      const dashboardPage = new DashboardPage(page);
      const loginPage = new LoginPage(page);
      await page.goto("/web/index.php/dashboard/index");
      await page.waitForURL("**/auth/login", { timeout: 10000 });
      test.info().annotations.push({ type: 'qaai-uncheckable', description: "URL: uncheckable in live run - not asserted (export will not invent a gate the live run never resolved)." });
      await assertProductNamesContain(page, readData(row, "expectedLandingPage"), 10000);
      await page.screenshot({ path: "test-results/post-logout-direct-navigation-to-dashboard-redirects-to-login.png", fullPage: true });
    });
  }
});
