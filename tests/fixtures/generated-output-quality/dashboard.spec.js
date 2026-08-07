import { expect, test } from '@playwright/test';

test('opens the dashboard', async ({ page }) => {
  await page.goto('https://example.test/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
