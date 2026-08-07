import { test, expect } from '@playwright/test';
import { readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Product Search — Numeric and Special-Value Inputs", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/search-with-numeric-value-returns-matching-products.json");
  for (const row of _dataRows0) {
    test("Search with numeric value returns matching products [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await expect(page.getByPlaceholder("Search Product")).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: "test-results/search-with-numeric-value-returns-matching-products.png", fullPage: true });
    });
  }
});
