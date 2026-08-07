'use strict';
/**
 * P4b live smoke (not a guard). Proves auth-profile identity on the real DB:
 *   1. AuthProfile model live (create/read; @@unique([projectId,name])).
 *   2. resolveAuthProfile maps disposition → valueRef (bypass_fixture → fixture:<id>;
 *      manual_gate → no ref).
 *   3. persistCases STAMPS TestCase.authProfile from authProfileName (the 4-rung
 *      ladder writing the newest column on the regenerated client).
 *   4. INERT default: persistCases without authProfileName → authProfile null.
 *
 * Additive — one synthetic AuthProfile + one synthetic generation, DELETED in
 * finally. Run AFTER migrate deploy + generate (client must know AuthProfile +
 * TestCase.authProfile):
 *
 *   node scripts/_smoke_p4b_authprofile.cjs [projectId]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const apr = require('../server/services/authProfileResolver');
const tcc = require('../server/services/testCaseContract');

const PID = process.argv.slice(2).find((a) => !a.startsWith('--')) || '9675bfde-acb2-4eda-aaed-b6694b88f920';
const results = [];
function check(label, cond, detail) { const ok = !!cond; results.push({ ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail || ''}`}`); }
function caseTpl(name) {
  return { name, type: 'positive', confidence: 90, assertions: 'logs in', automatability: 'automatable', declaredAssertions: [{ type: 'TEXT', criticality: 'must', provenance: 'BRD', payload: { expectedText: 'Dashboard' } }], steps: [{ order: 1, action: 'click', element: 'Login' }] };
}

(async () => {
  const project = await prisma.project.findUnique({ where: { id: PID } }) || await prisma.project.findFirst();
  console.log(`\n=== P4b auth-profile smoke · ${project.name} ===\n`);
  let profileId = null;
  let genId = null;
  try {
    // ── 1) AuthProfile model live ──
    console.log('[1] AuthProfile model');
    const profile = await prisma.authProfile.create({ data: { projectId: project.id, name: '_p4b_admin', strategy: 'sso', disposition: 'bypass_fixture', authFixtureId: 'fix-demo', updatedAt: new Date() } });
    profileId = profile.id;
    check('AuthProfile created (admin / sso / bypass_fixture)', profile.id && profile.disposition === 'bypass_fixture');
    let dup = null; try { dup = await prisma.authProfile.create({ data: { projectId: project.id, name: '_p4b_admin', updatedAt: new Date() } }); } catch (e) { dup = e.code; }
    check('duplicate (projectId,name) rejected by @@unique (P2002)', dup === 'P2002', String(dup));

    // ── 2) resolver ──
    console.log('\n[2] resolveAuthProfile');
    const r = apr.resolveAuthProfile(profile);
    check('bypass_fixture → storageStateRef "fixture:fix-demo"', r.storageStateRef === 'fixture:fix-demo' && r.credentialRef === null, JSON.stringify(r));
    const rMan = apr.resolveAuthProfile({ name: 'm', disposition: 'manual_gate' });
    check('manual_gate → no ref (human gate)', rMan.storageStateRef === null && rMan.credentialRef === null);

    // ── 3) persistCases stamps TestCase.authProfile ──
    console.log('\n[3] persistCases stamps the identity');
    const gen = await prisma.scenarioGeneration.create({ data: { projectId: project.id, version: 999100, label: '_P4B', isCurrent: false } });
    genId = gen.id;
    const scn = await prisma.testScenario.create({ data: { projectId: project.id, generationId: genId, name: '_p4b', module: 'pim', priority: 'high', category: 'functional', rationale: 'p4b smoke', source: 'agent' } });
    const stamped = await tcc.persistCases({ prisma, projectId: project.id, scenarioId: scn.id, generationId: genId, moduleName: 'pim', cases: [caseTpl('as admin')], authProfileName: '_p4b_admin', log: { warn() {}, info() {} } });
    const stampedTc = await prisma.testCase.findUnique({ where: { id: stamped[0].tc.id }, select: { authProfile: true } });
    check('case stamped with authProfile "_p4b_admin" (4-rung ladder wrote the new column live)', stampedTc.authProfile === '_p4b_admin', JSON.stringify(stampedTc));

    // ── 4) inert default ──
    console.log('\n[4] inert default (no authProfileName)');
    const plain = await tcc.persistCases({ prisma, projectId: project.id, scenarioId: scn.id, generationId: genId, moduleName: 'pim', cases: [caseTpl('no identity')], log: { warn() {}, info() {} } });
    const plainTc = await prisma.testCase.findUnique({ where: { id: plain[0].tc.id }, select: { authProfile: true } });
    check('case WITHOUT authProfileName → authProfile null (legacy behaviour unchanged)', plainTc.authProfile === null, JSON.stringify(plainTc));

    const failed = results.filter((x) => !x.ok).length;
    console.log(`\n=== ${failed ? 'FAIL' : 'PASS'} — ${results.length - failed}/${results.length} checks passed ===\n`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    if (genId) await prisma.scenarioGeneration.delete({ where: { id: genId } }).catch(() => {});
    if (profileId) await prisma.authProfile.delete({ where: { id: profileId } }).catch(() => {});
    console.log('(cleaned up synthetic AuthProfile + generation)');
    await prisma.$disconnect();
  }
})().catch(async (e) => { console.error('\nP4b SMOKE FAILED:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
