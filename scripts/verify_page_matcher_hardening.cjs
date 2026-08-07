'use strict';
// Guard: PAGE-matcher hardening (forbiddenSignals hard-deny + untrusted pageName).
const { matchPageAssertion, isUntrustedPageName } = require('../server/services/mcp');
let fail = 0;
const ok = (label, got, want) => { const pass = got === want; if (!pass) fail++; console.log(`  ${pass?'PASS':'FAIL'}  ${label}  (got=${JSON.stringify(got)} want=${JSON.stringify(want)})`); };

console.log('isUntrustedPageName — UNTRUSTED (data/result strings, must be true):');
['{{expectedValidationError}}','username_is_required','password_is_required',
 'Username is required; Password is required','(none)','none','validation_or_graceful_rejection',
 'Invalid credentials','remain on login page','',null,undefined
].forEach(v => ok(JSON.stringify(v), isUntrustedPageName(v), true));

console.log('\nisUntrustedPageName — TRUSTED (real page identities, must be false):');
['Login','Dashboard','Employee List','PIM','Admin','My Info','Leave','Login page','Buzz','Directory'
].forEach(v => ok(JSON.stringify(v), isUntrustedPageName(v), false));

// --- forbiddenSignals hard-deny ---
const LOGIN_SNAP = `- document:
  - heading "Login" [level=1]
  - textbox "Username" [ref=e23]
  - textbox "Password" [ref=e30]
  - button "Login" [ref=e32]`;
const DASH_SNAP = `- document:
  - heading "Dashboard" [level=1]
  - link "Dashboard" [ref=e10]
  - textbox "Search" [ref=e11]
  - button "Login" [ref=e99]`;  // note: a stray Login button + Dashboard present

const negOraclePayload = {
  pageName: '{{expectedValidationError}}',           // poisoned (untrusted)
  expectedSignals: { text: ['Username','Password'], role: [{role:'textbox',name:'Username'},{role:'button',name:'Login'}] },
  primaryIndicator: { role: 'textbox', name: 'Username' },
  forbiddenSignals: { text: ['Dashboard'], role: [{role:'link',name:'Dashboard'}] },
};

console.log('\nforbiddenSignals hard-deny:');
let r = matchPageAssertion(null, negOraclePayload, { snapshot: LOGIN_SNAP, currentUrl: 'https://x/auth/login' });
ok('login snapshot (no Dashboard) -> matched via primaryIndicator', r.matched, true);
ok('  stage = primary_indicator', r.stage, 'primary_indicator');

r = matchPageAssertion(null, negOraclePayload, { snapshot: DASH_SNAP, currentUrl: 'https://x/dashboard' });
ok('dashboard snapshot (Dashboard present) -> REJECTED even though Username/Login present', r.matched, false);
ok('  stage = forbidden_present', r.stage, 'forbidden_present');

// No forbiddenSignals -> behaves as before (positive landing case unaffected)
const posPayload = { pageName: 'Dashboard', expectedSignals: { text:['Dashboard'], role:[{role:'heading',name:'Dashboard'}] }, primaryIndicator:{role:'heading',name:'Dashboard'} };
r = matchPageAssertion(null, posPayload, { snapshot: DASH_SNAP, currentUrl:'https://x/dashboard' });
ok('positive Dashboard oracle (no forbiddenSignals) still matches', r.matched, true);

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — page-matcher hardening verified');
