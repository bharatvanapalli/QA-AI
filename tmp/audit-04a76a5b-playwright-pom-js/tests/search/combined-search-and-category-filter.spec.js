import { test } from '@playwright/test';
import { assertProductNamesContain, assertProductCategory, readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Combined Search and Category Filter", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/search-printed-on-women-dress-category-page-returns-intersection.json");
  for (const row of _dataRows0) {
    test("Search 'Printed' on Women Dress category page returns intersection [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await assertProductNamesContain(page, readData(row, "searchProduct"), 10000);
      await assertProductCategory(page, "Women - Dress Products", 10000);
      await page.screenshot({ path: "test-results/search-printed-on-women-dress-category-page-returns-intersection.png", fullPage: true });
    });
  }
});
