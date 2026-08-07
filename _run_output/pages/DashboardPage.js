import { dashboardPageLocators } from '../locators/dashboardPage.locators.js';

export class DashboardPage {
  constructor(page) {
    this.page = page;
    this._logoutMenuItem = dashboardPageLocators.logoutMenuItem(page);
  }

  // ─── Locator accessors (for assertions and direct locator use) ────────────
  logoutMenuItem() { return this._logoutMenuItem; }

  // ─── Action methods — 1:1 with recorded acts (G.5) ─────────────────────
  async clickLogout() {
    await this.logoutMenuItem().click();
  }
}
