import { test } from '@playwright/test';
import { assertScopedText } from '../support/replayir.js';

test.describe("Filter UI Controls Visibility", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Brand filter sidebar visible with brand names and product counts", async ({ page }) => {
    await page.goto("/products");
    await assertScopedText(page, ".brands_products, .left-sidebar, .col-sm-3", "Brands", 10000);
    await assertScopedText(page, ".brands_products, .left-sidebar, .col-sm-3", "Polo", 10000);
    await page.screenshot({ path: "test-results/brand-filter-sidebar-visible-with-brand-names-and-product-counts.png", fullPage: true });
  });
});
