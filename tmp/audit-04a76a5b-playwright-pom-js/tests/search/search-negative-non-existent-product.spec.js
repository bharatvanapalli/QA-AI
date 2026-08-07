import { test, expect } from '@playwright/test';
import { assertScopedText, readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Search Negative — Non-Existent Product", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/search-non-existent-product-name-returns-empty-state.json");
  for (const row of _dataRows0) {
    test("Search non-existent product name returns empty state [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await expect(page.getByPlaceholder("Search Product")).toBeVisible({ timeout: 10000 });
      await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "No products found", 10000);
      await page.screenshot({ path: "test-results/search-non-existent-product-name-returns-empty-state.png", fullPage: true });
    });
  }
});
