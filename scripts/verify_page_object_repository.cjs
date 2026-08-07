'use strict';
/* Guard: Class G deterministic core (pageObjectRepository). Locks the semantic naming engine,
 * the generic URL splitter (no site-specific page names), and the conflict→block guardrail. */
const path = require('path');
const R = require(path.join(__dirname, '..', 'server', 'services', 'codegen', 'pageObjectRepository'));
let fail = 0;
const ok = (c, m) => { if (!c) { console.error('  FAIL:', m); fail++; } else console.log('  ok:', m); };

// ── pageKey: generic, strips web noise + collapses dynamic segments ─────────
ok(R.pageKey('https://x/web/index.php/auth/login') === 'auth/login', `login pageKey (${R.pageKey('https://x/web/index.php/auth/login')})`);
ok(R.pageKey('https://x/web/index.php/pim/viewEmployee/empNumber/1024') === 'pim/viewEmployee/empNumber/:id', `dynamic id collapsed (${R.pageKey('https://x/web/index.php/pim/viewEmployee/empNumber/1024')})`);
ok(R.pageKey('https://x/products/red-dress-42') === 'products/:id', `kebab slug id collapsed (${R.pageKey('https://x/products/red-dress-42')})`);
ok(R.pageKey('https://x/orders/ORD-123') === 'orders/:id', `prefixed order id collapsed (${R.pageKey('https://x/orders/ORD-123')})`);
ok(R.pageKey('https://x/users/jane.doe') === 'users/:id', `dot-separated identity collapsed (${R.pageKey('https://x/users/jane.doe')})`);
ok(R.pageKey('https://x/') === 'root', 'bare root → root');

// ── pageFileName: prefer calibrator role, else route leaf ───────────────────
ok(R.pageFileName('auth/login', null) === 'loginPage', `leaf→loginPage (${R.pageFileName('auth/login', null)})`);
ok(R.pageFileName('pim/viewEmployeeList', 'Employee List') === 'employeeListPage', `calibrator role wins (${R.pageFileName('pim/viewEmployeeList','Employee List')})`);
ok(R.pageFileName(R.pageKey('https://x/products/red-dress-42'), null) === 'productsPage', `slug route leaf wins (${R.pageFileName(R.pageKey('https://x/products/red-dress-42'), null)})`);
ok(R.pageFileName(R.pageKey('https://x/orders/ORD-123'), null) === 'ordersPage', `order route leaf wins (${R.pageFileName(R.pageKey('https://x/orders/ORD-123'), null)})`);

// ── semanticName: role+name → camelCase + role suffix; password by name/type ─
const sn = (role, name, text) => R.semanticName({ role, name, text, strategy: 'role' });
ok(sn('textbox', 'Username') === 'usernameInput', `usernameInput (${sn('textbox','Username')})`);
ok(sn('textbox', 'Password') === 'passwordInput', `passwordInput (${sn('textbox','Password')})`);
ok(sn('button', 'Login') === 'loginButton', `loginButton (${sn('button','Login')})`);
ok(sn('menuitem', 'Logout') === 'logoutMenuItem', `logoutMenuItem (${sn('menuitem','Logout')})`);
ok(sn('link', 'Admin') === 'adminLink', `adminLink (${sn('link','Admin')})`);
ok(R.semanticName({ role: 'banner', strategy: 'role' }) === null, 'role-only/no-name → null (weak → block)');

// ── buildLocatorRepository: union + conflict detection ──────────────────────
const login = (extraName) => ({ ir: { steps: [
  { op: 'act', action: 'navigate', url: 'https://x/web/index.php/auth/login' },
  { op: 'resolve', as: 'el1', candidates: [{ strategy: 'role', role: 'textbox', name: 'Username' }] },
  { op: 'resolve', as: 'el2', candidates: [{ strategy: 'role', role: 'textbox', name: 'Password' }, { strategy: 'placeholder', text: 'Password' }] },
  { op: 'resolve', as: 'el3', candidates: [{ strategy: 'role', role: 'button', name: extraName || 'Login' }] },
] } });
{
  const rep = R.buildLocatorRepository({ cases: [login(), login()] }); // identical twice → idempotent
  ok(rep.files.loginPage && Object.keys(rep.files.loginPage).sort().join(',') === 'loginButton,passwordInput,usernameInput', `loginPage members (${Object.keys(rep.files.loginPage||{}).join(',')})`);
  ok(rep.files.loginPage.usernameInput.expr === 'page.getByRole("textbox", { name: "Username" })', `exact approved locator stored (${rep.files.loginPage.usernameInput.expr})`);
  ok(rep.conflicts.length === 0, 'identical cases → zero conflicts (idempotent union)');
}
{
  const rep = R.buildLocatorRepository({ cases: [{ ir: { steps: [
    { op: 'resolve', as: 'products', pageUrl: 'https://x/category_products/1', candidates: [{ strategy: 'role', role: 'link', name: 'Products' }] },
  ] } }] });
  ok(rep.files.categoryProductsPage && rep.files.categoryProductsPage.productsLink, `resolve.pageUrl without prior navigate → categoryProductsPage (${Object.keys(rep.files).join(',')})`);
  ok(!rep.files.rootPage, 'resolve.pageUrl prevents locator from landing in rootPage');
}
{
  const rep = R.buildLocatorRepository({ cases: [{ ir: { steps: [
    { op: 'resolve', as: 'unnamed', pageUrl: 'https://x/form', candidates: [{ strategy: 'role', role: 'textbox' }] },
  ] } }] });
  ok(rep.manifest[0] && rep.manifest[0].status === 'weak', 'role-only/no-name candidate stays weak');
  ok(Object.keys(rep.files).length === 0, 'role-only/no-name candidate is not stored in locator repository');
}
{
  ok(R.uniquenessFinding('page.getByRole("button")').rule === 'uniqueness_unverified', 'static uniqueness flags role locator without accessible name');
  ok(R.uniquenessFinding('page.getByText("Go", { exact: true })').rule === 'uniqueness_unverified', 'static uniqueness flags very short text locator');
  ok(R.uniquenessFinding('page.getByRole("button", { name: "Save" })') === null, 'static uniqueness allows named role locator');
}
{
  const rep = R.buildLocatorRepository({ cases: [{ ir: { steps: [
    { op: 'resolve', as: 'go', pageUrl: 'https://x/dialog', candidates: [{ strategy: 'text', text: 'Go' }] },
  ] } }] });
  const entry = rep.manifest.find((m) => m.as === 'go');
  ok(entry && entry.uniqueness === 'unverified', 'manifest surfaces uniqueness_unverified for short text locator');
  ok(entry && entry.findings && entry.findings[0].rule === 'uniqueness_unverified', 'manifest carries uniqueness finding details');
  ok(rep.files.dialogPage && rep.files.dialogPage.goElement && rep.files.dialogPage.goElement.uniqueness === 'unverified', 'repository entry carries static uniqueness warning');
}
{
  // distinct roles → distinct names, both kept (no false conflict). Use a non-noise leaf.
  const f1 = { ir: { steps: [ { op:'act', action:'navigate', url:'https://x/p/profile' }, { op:'resolve', as:'g', candidates:[{ strategy:'role', role:'button', name:'Go' }] } ] } };
  const f2 = { ir: { steps: [ { op:'act', action:'navigate', url:'https://x/p/profile' }, { op:'resolve', as:'g', candidates:[{ strategy:'role', role:'link', name:'Go' }] } ] } };
  const rep = R.buildLocatorRepository({ cases: [f1, f2] });
  ok(rep.files.profilePage && rep.files.profilePage.goButton && rep.files.profilePage.goLink, `distinct roles → distinct names, both kept (${Object.keys(rep.files.profilePage||{}).join(',')})`);
  ok(rep.conflicts.length === 0, 'distinct names → no false conflict');
}
{
  // TRUE conflict: SAME semantic name, DIFFERENT expression. Name-casing variance ("Save" vs
  // "save") both camelCase to saveButton, but the getByRole names differ → must surface, never pick.
  const g3 = { ir: { steps: [ { op:'act', action:'navigate', url:'https://x/p/account' }, { op:'resolve', as:'s', candidates:[{ strategy:'role', role:'button', name:'Save' }] } ] } };
  const g4 = { ir: { steps: [ { op:'act', action:'navigate', url:'https://x/p/account' }, { op:'resolve', as:'s', candidates:[{ strategy:'role', role:'button', name:'save' }] } ] } };
  const rep = R.buildLocatorRepository({ cases: [g3, g4] });
  const conf = rep.conflicts.find((c) => c.name === 'saveButton');
  ok(conf && conf.existing !== conf.incoming, `true conflict surfaced (${conf ? conf.existing + ' vs ' + conf.incoming : 'NONE'})`);
}

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_page_object_repository: all checks passed');
