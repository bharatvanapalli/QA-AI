// GENERATED — do not edit directly. Overwritten on every QAAI export.
// Source: replayIrJson (action-time evidence — semantic .or() chains from all recorded strategies).
// To override: copy to locators/overrides/productsPage.override.js, then change
//   locators/productsPage.locators.js to re-export from './overrides/productsPage.override.js'.

export const productsPageLocators = {
  searchProductInput: (page) => page.getByRole("textbox", { name: "Search Product" }),
  searchButton: (page) => page.getByRole("button", { name: "" }),
  womenCategoryHeadingLink: (page) => page.getByRole("link", { name: " Women" }),
  dressLink: (page) => page.getByRole("link", { name: "Dress" }),
  menCategoryHeadingLink: (page) => page.getByRole("link", { name: " Men" }),
  tshirtsLink: (page) => page.getByRole("link", { name: "Tshirts" }),
  "6PoloLink": (page) => page.getByRole("link", { name: "(6) Polo" }),
  kidsLink: (page) => page.getByRole("link", { name: " Kids" }),
  womenLink: (page) => page.getByRole("link", { name: " Women" }),
  topsLink: (page) => page.getByRole("link", { name: "Tops" }),
};
