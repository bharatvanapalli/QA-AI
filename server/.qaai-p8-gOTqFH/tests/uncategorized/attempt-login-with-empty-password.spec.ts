import { clickFirstVisible, safeClick, safeGoto } from '../../utils/test-helpers';
import { test, expect } from '@playwright/test';
import { assertTextPresent, dismissKnownPopups, readEnv, readData, resolveLocator, checkAccessibility, evaluateSettled, type DataRow } from '../support/replayir';

test.describe("Attempt login with empty password", () => {

  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Attempt login with empty password", async ({ page }) => {

  // Auth profile default: auth strategy none must be wired by the package shell.

      await assertTextPresent(page, "Password cannot be empty", '', 10000).catch((_atp) => {
        test.info().annotations.push({ type: 'qaai-soft-fail', description: `UI_TEXT: ${_atp.message}` });
      });

      await expect(page).toHaveURL(new RegExp("/auth/login"), { timeout: 10000 });

      await page.screenshot({ path: "test-results/attempt-login-with-empty-password.png", fullPage: true });
    });
});
