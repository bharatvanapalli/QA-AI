import { test, expect } from '@playwright/test';
import { assertScopedText } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Category Filter — Empty Category State", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  test("Kids Dress category page loads with products and does not crash", async ({ page }) => {
    const productsPage = new ProductsPage(page);
    await page.goto("/products");
    await productsPage.selectCategory("Kids", "Dress");
    await expect(page.getByText("Category", { exact: false })).toBeVisible({ timeout: 10000 });
    await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "No products found", 10000);
    await page.screenshot({ path: "test-results/kids-dress-category-page-loads-with-products-and-does-not-crash.png", fullPage: true });
  });
});
