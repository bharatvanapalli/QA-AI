'use strict';
/**
 * Deterministic guard for Enterprise Mode P4b (auth-profile identity). No LLM, no DB.
 *   node scripts/verify_authprofile.cjs
 *
 * [1] authProfileResolver — pure resolution (strategy/disposition enums, valueRef
 *     refs, validation findings).
 * [2] assertContractComplete — requireAuthProfile gate (inert until P9).
 * [3] persistCases — authProfile stamp + graceful pre-regen ladder.
 * [4] schema + additive migration.
 * [5] routes (org-scoped CRUD) + mount + inert scenarios.js identity tie-in.
 */
const fs = require('fs');
const path = require('path');
const apr = require('../server/services/authProfileResolver');
const tcc = require('../server/services/testCaseContract');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.log('  ✗ ' + m); failures++; };
const assert = (c, m) => (c ? ok(m) : bad(m));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

console.log('\n[1] authProfileResolver — pure identity resolution');
assert(apr.isStrategy('form') && apr.isStrategy('SSO') && !apr.isStrategy('telepathy'), 'isStrategy accepts form/sso, rejects junk');
assert(apr.isDisposition('bypass_fixture') && apr.isDisposition('manual_gate') && !apr.isDisposition('whatever'), 'isDisposition accepts the four, rejects junk');
const rFix = apr.resolveAuthProfile({ name: 'admin', strategy: 'sso', disposition: 'bypass_fixture', authFixtureId: 'fix1' });
assert(rFix.storageStateRef === 'fixture:fix1' && rFix.credentialRef === null, 'bypass_fixture → storageStateRef "fixture:<id>", no credentialRef');
const rCred = apr.resolveAuthProfile({ name: 'maker', disposition: 'supported_test_hook', credentialRef: 'maker_login' });
assert(rCred.credentialRef === 'maker_login' && rCred.storageStateRef === null, 'supported_test_hook → named credentialRef, no storageStateRef');
const rMan = apr.resolveAuthProfile({ name: 'x', disposition: 'manual_gate' });
assert(rMan.storageStateRef === null && rMan.credentialRef === null, 'manual_gate → neither ref (run pauses for a human)');
const rUns = apr.resolveAuthProfile({ name: 'x', disposition: 'unsupported' });
assert(rUns.disposition === 'unsupported' && rUns.storageStateRef === null, 'unsupported → marked, no ref (never silently passed)');
assert(apr.resolveAuthProfile({ strategy: 'bogus', disposition: 'bogus' }).strategy === 'form', 'unknown strategy/disposition normalise to safe defaults');
const vGood = apr.validateAuthProfile({ name: 'admin', strategy: 'form', disposition: 'bypass_fixture', authFixtureId: 'f1' });
assert(vGood.ok === true && vGood.findings.length === 0, 'a complete bypass_fixture profile validates clean');
assert(apr.validateAuthProfile({ strategy: 'form', disposition: 'manual_gate' }).findings.some((f) => f.code === 'auth_profile_no_name'), 'no name → error');
const vBad = apr.validateAuthProfile({ name: 'x', strategy: 'mind-meld', disposition: 'nope' });
assert(vBad.findings.some((f) => f.code === 'auth_profile_bad_strategy') && vBad.findings.some((f) => f.code === 'auth_profile_bad_disposition'), 'bad strategy + disposition → two errors');
const vWarn = apr.validateAuthProfile({ name: 'x', strategy: 'form', disposition: 'bypass_fixture' });
assert(vWarn.ok === true && vWarn.findings.some((f) => f.code === 'auth_profile_fixture_missing' && f.severity === 'warning'), 'bypass_fixture w/o fixture → warning (surfaced, not blocked)');

console.log('\n[2] assertContractComplete — requireAuthProfile (inert until P9)');
const base = { automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'BRD' }] };
assert(!tcc.assertContractComplete({ ...base, requireAuthProfile: false, authProfile: null }).violations.includes('no_auth_profile'), 'requireAuthProfile:false → no violation (INERT — current generations unaffected)');
assert(tcc.assertContractComplete({ ...base, requireAuthProfile: true, authProfile: null }).violations.includes('no_auth_profile'), 'requireAuthProfile:true + no authProfile → no_auth_profile');
assert(!tcc.assertContractComplete({ ...base, requireAuthProfile: true, authProfile: 'admin' }).violations.includes('no_auth_profile'), 'requireAuthProfile:true + authProfile set → ok');

console.log('\n[3] persistCases — authProfile stamp + graceful pre-regen ladder');
const tccSrc = read('server', 'services', 'testCaseContract.js');
assert(/authProfileName = null/.test(tccSrc), 'persistCases accepts authProfileName (default null = inert)');
assert(/authProfile: authProfileVal/.test(tccSrc), 'top rung writes authProfile (the newest optional column)');
assert(/\{ \.\.\.data, requirementRefs: reqRefs, operationsJson \}/.test(tccSrc), 'a fallback rung drops authProfile for a pre-regen client (degrades gracefully)');
assert(/requireAuthProfile,/.test(tccSrc), 'gate receives requireAuthProfile');

console.log('\n[4] Schema + migration (additive)');
const schema = read('prisma', 'schema.prisma');
assert(/model AuthProfile \{/.test(schema), 'schema defines model AuthProfile');
assert(/@@unique\(\[projectId, name\]\)/.test(schema), 'AuthProfile @@unique([projectId, name])');
assert(/strategy\s+String/.test(schema) && /disposition\s+String/.test(schema), 'AuthProfile carries strategy + disposition');
assert(/authProfile\s+String\?/.test(schema), 'TestCase.authProfile column added (nullable)');
assert(/authProfiles\s+AuthProfile\[\]/.test(schema), 'Project has the authProfiles back-relation');
const migPath = path.join(__dirname, '..', 'prisma', 'migrations', '20260613000000_add_auth_profile', 'migration.sql');
const mig = fs.existsSync(migPath) ? fs.readFileSync(migPath, 'utf8') : '';
assert(/CREATE TABLE "AuthProfile"/.test(mig), 'migration creates the AuthProfile table');
assert(/ADD COLUMN "authProfile"/.test(mig), 'migration adds TestCase.authProfile (additive)');

console.log('\n[5] Route + wiring (org-scoped CRUD, mounted, inert tie-in)');
const route = read('server', 'routes', 'authProfiles.js');
assert(/\.get\('\/'/.test(route) && /\.post\('\/'/.test(route) && /\.put\('\/:id'/.test(route) && /\.delete\('\/:id'/.test(route), 'authProfiles CRUD (GET/POST/PUT/DELETE)');
assert(/validateAuthProfile/.test(route) && /INVALID_AUTH_PROFILE/.test(route), 'create/update validate via the resolver (bad → 400)');
assert(/orgId: req\.org\.id/.test(route), 'routes are project+org-scoped (never raw projectId)');
assert(/P2002/.test(route), 'duplicate profile name → 409 (the @@unique guard)');
const idx = read('server', 'index.js');
assert(/auth-profiles/.test(idx) && /authProfilesRoutes/.test(idx), 'server mounts /api/projects/:projectId/auth-profiles');
const scn = read('server', 'routes', 'scenarios.js');
assert(/genAuthProfileName/.test(scn) && /authProfileName: genAuthProfileName/.test(scn), 'scenarios.js resolves the slice AuthProfile name + threads it to persistCases (inert)');

console.log(`\n${failures === 0 ? 'PASS — P4b auth-profile identity (model + resolver + inert gate + routes + slice tie-in) enforced' : 'FAIL — ' + failures + ' check(s) failed'}\n`);
process.exit(failures === 0 ? 0 : 1);
