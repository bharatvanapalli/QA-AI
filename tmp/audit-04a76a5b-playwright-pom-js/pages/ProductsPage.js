import { productsPageLocators } from '../locators/productsPage.locators.js';
import { safeClick } from '../tests/support/replayir.js';

function normalizePomKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export class ProductsPage {
  constructor(page) {
    this.page = page;
    this._searchProductInput = productsPageLocators.searchProductInput(page);
    this._searchButton = productsPageLocators.searchButton(page);
    this._womenCategoryHeadingLink = productsPageLocators.womenCategoryHeadingLink(page);
    this._dressLink = productsPageLocators.dressLink(page);
    this._menCategoryHeadingLink = productsPageLocators.menCategoryHeadingLink(page);
    this._tshirtsLink = productsPageLocators.tshirtsLink(page);
    this._6PoloLink = productsPageLocators["6PoloLink"](page);
    this._kidsLink = productsPageLocators.kidsLink(page);
    this._womenLink = productsPageLocators.womenLink(page);
    this._topsLink = productsPageLocators.topsLink(page);
  }

  // ─── Locator accessors (for assertions and direct locator use) ────────────
  searchProductInput() { return this._searchProductInput; }
  searchButton() { return this._searchButton; }
  womenCategoryHeadingLink() { return this._womenCategoryHeadingLink; }
  dressLink() { return this._dressLink; }
  menCategoryHeadingLink() { return this._menCategoryHeadingLink; }
  tshirtsLink() { return this._tshirtsLink; }
  "6PoloLink"() { return this._6PoloLink; }
  kidsLink() { return this._kidsLink; }
  womenLink() { return this._womenLink; }
  topsLink() { return this._topsLink; }

  // Business methods - parameterized POM Architect layer
  async searchForProduct(productName) {
    await this.searchProductInput().fill(productName);
    await safeClick(this.page, this.searchButton());
  }
  async selectBrand(brandName) {
    const brandLocators = {
      "polo": () => this["6PoloLink"](),
    };
    const locatorFactory = brandLocators[normalizePomKey(brandName)];
    if (!locatorFactory) throw new Error(`Unsupported brand: ${brandName}`);
    await safeClick(this.page, locatorFactory());
  }
  async selectCategory(category, subCategory) {
    const categoryLocators = {
      "kids": () => this.kidsLink(),
      "women": () => this.womenLink(),
    };
    const subCategoryLocators = {
      "dress": () => this.dressLink(),
      "tops": () => this.topsLink(),
    };
    const categoryLocator = categoryLocators[normalizePomKey(category)];
    if (!categoryLocator) throw new Error(`Unsupported category: ${category}`);
    await safeClick(this.page, categoryLocator());
    const subCategoryLocator = subCategoryLocators[normalizePomKey(subCategory)];
    if (!subCategoryLocator) throw new Error(`Unsupported subcategory: ${subCategory}`);
    await safeClick(this.page, subCategoryLocator());
  }

  // ─── Action methods — 1:1 with recorded acts (G.5) ─────────────────────
  async fillSearchProduct(value) {
    await this.searchProductInput().fill(value);
  }
  async clickSearch() {
    await safeClick(this.page, this.searchButton());
  }
  async clickWomenCategoryHeading() {
    await safeClick(this.page, this.womenCategoryHeadingLink());
  }
  async clickDress() {
    await safeClick(this.page, this.dressLink());
  }
  async clickMenCategoryHeading() {
    await safeClick(this.page, this.menCategoryHeadingLink());
  }
  async clickTshirts() {
    await safeClick(this.page, this.tshirtsLink());
  }
  async click6Polo() {
    await safeClick(this.page, this["6PoloLink"]());
  }
  async clickKids() {
    await safeClick(this.page, this.kidsLink());
  }
  async clickWomen() {
    await safeClick(this.page, this.womenLink());
  }
  async clickTops() {
    await safeClick(this.page, this.topsLink());
  }
}
