'use strict';
/* Guard: self-heal mis-captured role NAMES. When a resolve carries a ghost role candidate
 * (a data value in the name slot, e.g. "initialPassword") alongside the corroborated real one
 * (role name "Password" attested by placeholder/label/text), normalizeCandidates must DROP the
 * ghost so the static locator resolves to the clean getByRole(name:"Password"). Regression:
 * run 707ba2ac masking spec emitted getByRole('textbox',{name:'initialPassword'}) → timeout.
 * Generic: cross-strategy corroboration, never a site string. */
const path = require('path');
const { normalizeCandidates, dropUncorroboratedRoleNames } = require(path.join(__dirname,'..','server','services','codegen','adapters','_candidateNormalize'));

let fail = 0;
const ok = (c,m)=>{ if(!c){console.error('  FAIL:',m);fail++;} else console.log('  ok:',m); };

// real run shape (el1 from masking step 2)
const ghosty = [
  { strategy:'role', role:'textbox', name:'initialPassword', contextText:['Login'] },
  { strategy:'role', role:'textbox', name:'Password', contextText:['Login'] },
  { strategy:'placeholder', text:'Password', contextText:['Login'] },
  { strategy:'label', text:'Password', contextText:['Login'] },
  { strategy:'text', text:'Password', contextText:['Login'] },
];
{
  const out = normalizeCandidates(ghosty);
  const names = out.filter(c=>c.strategy==='role').map(c=>c.name);
  ok(!names.includes('initialPassword'), `ghost role-name "initialPassword" dropped (roles left: ${JSON.stringify(names)})`);
  ok(names.includes('Password'), 'corroborated role-name "Password" retained');
  ok(out.length > 0, 'candidates not emptied');
}

// SAFE: no placeholder/label/text to corroborate against → role candidate kept (no false drop)
{
  const onlyRole = [{ strategy:'role', role:'button', name:'Submit Order' }];
  const out = dropUncorroboratedRoleNames(onlyRole);
  ok(out.length === 1 && out[0].name === 'Submit Order', 'uncorroborated-but-sole role candidate kept (no attesters)');
}

// SAFE: the role name IS the attested one → kept
{
  const normal = [
    { strategy:'role', role:'textbox', name:'Username' },
    { strategy:'placeholder', text:'Username' },
  ];
  const out = dropUncorroboratedRoleNames(normal);
  ok(out.some(c=>c.strategy==='role'&&c.name==='Username'), 'corroborated role "Username" kept');
}

// SAFE: two role candidates, NEITHER corroborated → keep both (can't tell which is the ghost)
{
  const ambiguous = [
    { strategy:'role', role:'textbox', name:'fooBar' },
    { strategy:'role', role:'textbox', name:'bazQux' },
  ];
  const out = dropUncorroboratedRoleNames(ambiguous);
  ok(out.length === 2, 'no attesters → both uncorroborated roles kept (no destructive guess)');
}

if (fail) { console.error(`\n${fail} check(s) FAILED`); process.exit(1); }
console.log('\nverify_role_name_corroboration: all checks passed');
