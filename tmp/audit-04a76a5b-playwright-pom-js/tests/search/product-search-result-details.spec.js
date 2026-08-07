import { test } from '@playwright/test';
import { assertScopedText, assertProductNamesContain, readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Product Search Result Details", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/search-result-cards-display-product-name-and-price.json");
  for (const row of _dataRows0) {
    test("Search result cards display product name and price [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await assertProductNamesContain(page, readData(row, "searchProduct"), 10000);
      await assertScopedText(page, ".features_items, .productinfo, .single-products, .product-image-wrapper, [class*=\"product\"], [id*=\"product\"]", "Rs.", 10000);
      await page.screenshot({ path: "test-results/search-result-cards-display-product-name-and-price.png", fullPage: true });
    });
  }
});
