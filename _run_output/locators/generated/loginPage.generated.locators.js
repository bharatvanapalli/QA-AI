// GENERATED — do not edit directly. Overwritten on every QAAI export.
// Source: replayIrJson (action-time evidence — semantic .or() chains from all recorded strategies).
// To override: copy to locators/overrides/loginPage.override.js, then change
//   locators/loginPage.locators.js to re-export from './overrides/loginPage.override.js'.

export const loginPageLocators = {
  usernameInput: (page) => page.getByRole("textbox", { name: "Username" }),
  passwordInput: (page) => page.getByRole("textbox", { name: "Password" }),
  loginButton: (page) => page.getByRole("button", { name: "Login" }),
};
