import { test } from '@playwright/test';
import { assertProductNamesContain, readData, loadDataRows } from '../support/replayir.js';
import { ProductsPage } from '../../pages/ProductsPage.js';

test.describe("Product Search by Name — Happy Path", () => {
  test.describe.configure({ mode: 'serial', retries: 1 });

  const _dataRows0 = loadDataRows("tests/data/search-printed-returns-products-containing-printed-in-name.json");
  for (const row of _dataRows0) {
    test("Search 'Printed' returns products containing 'Printed' in name [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await assertProductNamesContain(page, readData(row, "searchProduct"), 10000);
      await page.screenshot({ path: "test-results/search-printed-returns-products-containing-printed-in-name.png", fullPage: true });
    });
  }

  const _dataRows1 = loadDataRows("tests/data/each-product-in-search-results-for-printed-contains-the-term-in-its-name.json");
  for (const row of _dataRows1) {
    test("Each product in search results for 'Printed' contains the term in its name [" + row.label + ']', async ({ page }) => {
      const productsPage = new ProductsPage(page);
      await page.goto("/products");
      await productsPage.searchForProduct(readData(row, "searchProduct"));
      await assertProductNamesContain(page, readData(row, "searchProduct"), 10000);
      await page.screenshot({ path: "test-results/each-product-in-search-results-for-printed-contains-the-term-in-its-name.png", fullPage: true });
    });
  }
});
