import { test } from '@playwright/test';
import { assertProductCategory } from '../support/replayir.js';
import { RootPage } from '../../pages/RootPage.js';

test.describe("Homepage Product Browsing", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Homepage shows featured products with prices and navigation to Products page works", async ({ page }) => {
    const rootPage = new RootPage(page);
    await page.goto("/");
    await rootPage.clickProducts();
    await assertProductCategory(page, "Features Items", 10000);
    await assertProductCategory(page, "All Products", 10000);
    await page.screenshot({ path: "test-results/homepage-shows-featured-products-with-prices-and-navigation-to-products-page-wor.png", fullPage: true });
  });
});
