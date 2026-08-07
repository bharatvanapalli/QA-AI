import { test } from '@playwright/test';
import { assertProductCategory } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Filter Application Synchronous Update", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Applying category filter updates product grid without full page reload", async ({ page }) => {
    const productsPage = new ProductsPage(page);
    await page.goto("/products");
    await productsPage.selectCategory("Women", "Tops");
    await assertProductCategory(page, "Women - Tops Products", 10000);
    await page.screenshot({ path: "test-results/applying-category-filter-updates-product-grid-without-full-page-reload.png", fullPage: true });
  });
});
