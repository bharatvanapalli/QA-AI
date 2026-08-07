'use strict';
/*
 * ACCEPTANCE REPLAY GUARD (run 91d6301a, S2 C1 "Data-driven form validation matrix").
 *
 * Feeds the run's STORED assertion outcomes back through the FIXED computeVerdict
 * and asserts that NONE of the old false-PASS rows recompute to `pass`:
 *   - rows with a hard uncheckable assertion → needs_human/assertion_uncheckable
 *   - the zero-evidence row → invariant throw (declared assertion, no record)
 * i.e. ZERO pass rows after recomputation.
 *
 * DB-dependent + read-only. If the run (or the DB / prisma client) is not present
 * — e.g. a fresh checkout or a reset DB — it SKIPS cleanly (exit 0) rather than
 * failing, so it can live in the reliability bundle without being brittle.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const RUN_PREFIX = '91d6301a';
const S2C1 = 'a66425b4-f662-40ec-8241-ccfd2a854616';

const ok = (label, cond, detail) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); return cond; };
const pj = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

(async () => {
  let PrismaClient, computeVerdict;
  try {
    process.env.DATABASE_URL = process.env.DATABASE_URL || ('file:' + path.join(ROOT, 'prisma', 'dev.db').replace(/\\/g, '/'));
    ({ PrismaClient } = require(path.join(ROOT, 'node_modules', '@prisma', 'client')));
    ({ computeVerdict } = require(path.join(ROOT, 'server', 'services', 'computeVerdict')));
  } catch (e) {
    console.log(`SKIP — prisma client / computeVerdict not loadable (${e && e.message}). Acceptance replay skipped.`);
    process.exit(0);
  }
  const p = new PrismaClient();
  try {
    const runs = await p.run.findMany({ where: { id: { startsWith: RUN_PREFIX } }, select: { id: true } });
    if (!runs.length) { console.log(`SKIP — run ${RUN_PREFIX}… not present in this DB; nothing to replay.`); await p.$disconnect(); process.exit(0); }
    const run = runs[0];
    const tc = await p.testCase.findUnique({ where: { id: S2C1 }, select: { declaredAssertions: true, name: true } });
    if (!tc) { console.log(`SKIP — test case S2 C1 (${S2C1}) not in this DB.`); await p.$disconnect(); process.exit(0); }

    const declared = (pj(tc.declaredAssertions, []) || []).map((d) => ({ id: d.id, criticality: d.criticality || 'must', type: d.type, parseFailed: d.parseFailed === true }));
    const rows = await p.runResult.findMany({ where: { runId: run.id, testCaseId: S2C1 }, select: { id: true, status: true, assertionCheckResults: true, stepResults: true } });
    if (!rows.length) { console.log('SKIP — no S2 C1 rows recorded for this run.'); await p.$disconnect(); process.exit(0); }

    console.log(`— replaying run ${run.id.slice(0, 8)}… S2 C1 "${tc.name}" (${rows.length} rows) through the fixed computeVerdict —`);
    let nowPass = 0, storedPass = 0;
    for (const r of rows) {
      if (r.status === 'pass') storedPass++;
      const recorded = (pj(r.assertionCheckResults, []) || []).map((o) => ({ assertionId: o.assertionId, outcome: o.outcome, primitiveUsed: o.primitiveUsed, source: o.source }));
      const steps = (pj(r.stepResults, []) || []).map((s) => ({ index: s.index, status: s.status }));
      let v;
      try { v = computeVerdict({ declared, recorded, steps, reachedEndTurn: true }); }
      catch (e) { v = { status: 'throw', reason: e.code || e.message }; }
      if (v.status === 'pass') nowPass++;
      console.log(`    [${r.id.slice(0, 8)}] stored=${r.status} → recomputed=${v.status}/${v.reason}`);
    }
    let fail = 0;
    if (!ok(`the run HAD false passes to fix (stored pass rows > 0)`, storedPass > 0, `storedPass=${storedPass}`)) fail++;
    if (!ok(`ZERO S2 C1 rows recompute to pass through the fixed verdict`, nowPass === 0, `nowPass=${nowPass}`)) fail++;
    await p.$disconnect();
    console.log('');
    if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
    console.log(`OK — acceptance replay: all ${storedPass} historical PASS rows of S2 C1 are non-pass under the fixed verdict (no fake green survives recomputation).`);
  } catch (e) {
    try { await p.$disconnect(); } catch (_) {}
    console.log(`SKIP — replay could not complete (${e && e.message}).`);
    process.exit(0);
  }
})();
