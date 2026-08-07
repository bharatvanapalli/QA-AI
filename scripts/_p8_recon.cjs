'use strict';
/* P8 recon (READ-ONLY): what can the execution-parity harness actually use?
 *  (1) RunResults that carry replayIrJson, grouped by status — do real fail/blocked exist?
 *  (2) the sanctioned exec-value source for project 9675bfde (approved TestDataMapping +
 *      AuthProfile) — so env values come from approved refs, never Excel literals.
 *  Reports PRESENCE/keys, not secret values. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');
const { decodeJson } = require('../server/services/jsonField');

const PID = '9675bfde-acb2-4eda-aaed-b6694b88f920';

(async () => {
  const all = await prisma.runResult.findMany({
    where: { replayIrJson: { not: null } },
    select: { id: true, runId: true, status: true, replayIrJson: true, testCase: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const byStatus = {};
  for (const r of all) {
    const env = decodeJson(r.replayIrJson, null);
    const complete = !!(env && env.complete);
    const key = `${r.status}${complete ? '' : ' (incomplete)'}`;
    (byStatus[key] = byStatus[key] || []).push({ id: r.id.slice(0, 8), run: r.runId.slice(0, 8), case: r.testCase && r.testCase.name });
  }
  console.log(`\n[1] RunResults WITH replayIrJson: ${all.length} total`);
  for (const [k, list] of Object.entries(byStatus)) {
    console.log(`  ${k}: ${list.length}`);
    list.slice(0, 4).forEach((x) => console.log(`     - ${x.id} (run ${x.run}) ${x.case || ''}`));
  }

  console.log('\n[2] sanctioned exec-value source for project 9675bfde');
  const tds = await prisma.testDataSet.findMany({ where: { projectId: PID }, select: { id: true, name: true, mappingJson: true } }).catch(() => []);
  console.log(`  TestDataSet rows: ${tds.length}`);
  for (const t of tds) {
    const m = decodeJson(t.mappingJson, null);
    const bindings = m && (m.bindings || m.columns) || [];
    const roles = Array.isArray(bindings) ? bindings.map((b) => b.field || b.role || b.column).filter(Boolean) : Object.keys(bindings || {});
    console.log(`    - ${t.name}: roles=[${roles.join(', ')}]`);
  }
  const maps = await prisma.testDataMapping.findMany({ where: { testDataSet: { projectId: PID }, status: 'approved' }, select: { id: true, version: true, mappingJson: true } }).catch((e) => { console.log('    (TestDataMapping query failed: ' + e.message + ')'); return []; });
  console.log(`  approved TestDataMapping rows: ${maps.length}`);
  const ap = await prisma.authProfile.findMany({ where: { projectId: PID }, select: { name: true, strategy: true, disposition: true, credentialRef: true } }).catch(() => []);
  console.log(`  AuthProfile rows: ${ap.length}`);
  ap.forEach((a) => console.log(`    - ${a.name}: ${a.strategy}/${a.disposition} credentialRef=${a.credentialRef || '(none)'}`));

  console.log('\n[3] env presence (values NOT printed)');
  for (const k of ['QAAI_TARGET_URL', 'QAAI_USERNAME', 'QAAI_PASSWORD', 'ORANGEHRM_USERNAME', 'ORANGEHRM_PASSWORD']) {
    console.log(`  ${k}: ${process.env[k] ? 'SET' : 'unset'}`);
  }

  // The exact env-ref names the known-good slice needs (from its IR valueRefs).
  const slice = await prisma.runResult.findMany({ where: { runId: '2de0cb23-1b69-422e-b0da-e0b20cbfa8f2' }, select: { replayIrJson: true } });
  const refs = new Set();
  for (const r of slice) { const e = decodeJson(r.replayIrJson, null); for (const s of (e && e.ir && e.ir.steps) || []) if (s.valueRef) refs.add(s.valueRef); }
  console.log(`\n[4] valueRefs the 2de0cb23 slice needs: [${[...refs].join(', ')}]`);

  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
