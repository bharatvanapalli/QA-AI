const r = require('../server/services/actionLocatorResolver');
const expr = 'locator(".oxd-userdropdown-tab")';
console.log('exportSafe:', r.locatorExpressionIsExportSafe(expr));
const kbEntry = {
  selector: expr,
  strategy: 'css',
  role: 'button',
  accessibleName: null,
  element: 'user dropdown trigger in top navigation',
  pageUrl: 'https://opensource-demo.orangehrmlive.com/web/index.php/dashboard/index',
  healthScore: 80,
};
const loc = r.buildVerifiedFromKbEntry({
  kbEntry,
  toolName: 'browser_click',
  pageUrl: kbEntry.pageUrl,
  elementLabel: 'user dropdown trigger in top navigation',
});
console.log('buildVerifiedFromKbEntry returned:', !!loc);
console.log('isVerifiedActionLocator:', r.isVerifiedActionLocator(loc));
console.log('verifiedActions.length:', loc && loc.domAtlas && loc.domAtlas.verifiedActions ? loc.domAtlas.verifiedActions.length : 'N/A');
console.log('expression:', loc && loc.expression);
console.log('verificationSource:', loc && loc.verificationSource);

// Also test that old page.locator().first() form is rejected
const bad = 'page.locator(".oxd-userdropdown-tab").first()';
const badEntry = { ...kbEntry, selector: bad };
const badLoc = r.buildVerifiedFromKbEntry({ kbEntry: badEntry, toolName: 'browser_click', pageUrl: kbEntry.pageUrl, elementLabel: 'avatar' });
console.log('old .first() form buildVerifiedFromKbEntry returned:', !!badLoc, '(expected: false)');
