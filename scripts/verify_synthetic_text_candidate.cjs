'use strict';
/* Guard: isSyntheticTextCandidate must drop AGENT NARRATION descriptions (which getByText
 * can never match) while KEEPING real visible page text. Regression: run 707ba2ac emitted
 * getByText('User profile dropdown in topbar') and getByText('Profile menu (Amelia Brown)')
 * for topbar clicks → timeouts. The fix drops them so the case BLOCKS honestly (no doomed
 * getByText) instead of failing for a reason absent from the live run.
 * Generic: keyed off (component-noun + region-word) / (component-noun + trailing paren),
 * never any site string. */
const path = require('path');
const { isSyntheticTextCandidate } = require(path.join(__dirname,'..','server','services','codegen','adapters','_candidateNormalize'));

let fail = 0;
const t = (txt) => isSyntheticTextCandidate({ strategy: 'text', text: txt });
const drop = (txt) => { if (!t(txt)) { console.error(`  FAIL: should DROP narration -> "${txt}"`); fail++; } else console.log(`  ok drop: "${txt}"`); };
const keep = (txt) => { if (t(txt)) { console.error(`  FAIL: should KEEP real text -> "${txt}"`); fail++; } else console.log(`  ok keep: "${txt}"`); };

// must DROP (narration descriptions)
drop('User profile dropdown in topbar');     // P4: noun(dropdown)+region(topbar)
drop('Profile menu (Amelia Brown)');          // P5: noun(menu)+trailing paren
drop('Settings icon in header');              // P4
drop('Notifications button in top right');    // P4
drop('Avatar (logged-in user)');              // P5
drop('Tops subcategory link under Women');    // P2 (existing) still works

// must KEEP (real visible page text / labels)
keep('Dashboard');
keep('Required');
keep('Admin');
keep('Login');
keep('Menu');                                  // bare component word w/o region/paren = real button text
keep('Welcome to your account');
keep('Search results for laptops');            // contains no component noun
keep('Add to cart');
keep('Forgot your password?');
keep('Submit button');                         // PROMOTED to getByRole('button',{name:'Submit'}) — runnable, not dropped
keep('Username field');                        // PROMOTED to placeholder/role — runnable, not dropped

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_synthetic_text_candidate: all checks passed');
