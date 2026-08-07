import { rootPageLocators } from '../locators/rootPage.locators.js';
import { safeClick } from '../tests/support/replayir.js';

export class RootPage {
  constructor(page) {
    this.page = page;
    this._productsLink = rootPageLocators.productsLink(page);
  }

  // ─── Locator accessors (for assertions and direct locator use) ────────────
  productsLink() { return this._productsLink; }

  // ─── Action methods — 1:1 with recorded acts (G.5) ─────────────────────
  async clickProducts() {
    await safeClick(this.page, this.productsLink());
  }
}
