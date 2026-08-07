import { test } from '@playwright/test';
import { assertProductCategory } from '../support/replayir.js';
import { CategoryProductsPage } from '../../pages/CategoryProductsPage.js';

test.describe("Category Filter — Clear Restores Full Grid", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Navigating back to All Products after category filter restores full grid", async ({ page }) => {
    const categoryProductsPage = new CategoryProductsPage(page);
    await page.goto("/category_products/1");
    await categoryProductsPage.clickProducts();
    await assertProductCategory(page, "All Products", 10000);
    await page.screenshot({ path: "test-results/navigating-back-to-all-products-after-category-filter-restores-full-grid.png", fullPage: true });
  });
});
