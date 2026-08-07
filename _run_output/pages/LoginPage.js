import { loginPageLocators } from '../locators/loginPage.locators.js';

export class LoginPage {
  constructor(page) {
    this.page = page;
    this._usernameInput = loginPageLocators.usernameInput(page);
    this._passwordInput = loginPageLocators.passwordInput(page);
    this._loginButton = loginPageLocators.loginButton(page);
  }

  // ─── Locator accessors (for assertions and direct locator use) ────────────
  usernameInput() { return this._usernameInput; }
  passwordInput() { return this._passwordInput; }
  loginButton() { return this._loginButton; }

  // ─── Action methods — 1:1 with recorded acts (G.5) ─────────────────────
  async fillUsername(value) {
    await this.usernameInput().fill(value);
  }
  async fillPassword(value) {
    await this.passwordInput().fill(value);
  }
  async clickLogin() {
    await this.loginButton().click();
  }
}
