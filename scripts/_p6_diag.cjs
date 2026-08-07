'use strict';
/**
 * DIAGNOSTIC (read-only): why did the live IR come back complete:false? Compares the
 * STORED IR (emitted from the conductor's in-memory actionTrail) against a re-emit from
 * the SAME result's persisted richTrace (reconstructTrail/toolResults — the shape the
 * deterministic smoke validated). Tells us: genuine missing evidence (honest) vs. an
 * actionTrail shape the emitter under-reads (defect to fix).
 *   node scripts/_p6_diag.cjs <runId>
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const { reconstructTrail } = require('../server/services/codegen/_replayTrace');
const emitter = require('../server/services/codegen/replayEmitter');
const { decodeJson } = require('../server/services/jsonField');
const prisma = new PrismaClient();

(async () => {
  const runId = process.argv[2];
  const results = await prisma.runResult.findMany({
    where: { runId },
    include: { testCase: { select: { name: true, declaredAssertions: true, authProfile: true, projectId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const rr of results) {
    console.log(`\n══════ [${rr.status}] ${rr.testCase?.name?.slice(0, 56)} ══════`);
    console.log(`richTraceFile: ${rr.richTraceFile || '(none)'}`);
    const env = decodeJson(rr.replayIrJson, null);

    // 1) STORED IR steps (from the LIVE in-memory actionTrail)
    console.log('\n  STORED IR steps (from live actionTrail):');
    for (const s of env?.ir?.steps || []) {
      if (s.op === 'resolve') console.log(`    resolve ${s.as}: ${JSON.stringify(s.candidates)}`);
      else if (s.op === 'act') console.log(`    act ${s.action}${s.target ? ' →' + s.target : ''}${s.url ? ' url=' + s.url : ''}${s.valueRef ? ' valueRef=' + s.valueRef : ''}`);
      else if (s.op === 'assert') console.log(`    assert ${s.contractRef} ch=${s.channel} outcome=${s.evidence?.outcome}`);
      else console.log(`    ${s.op} ${JSON.stringify(s).slice(0, 80)}`);
    }
    console.log(`  STORED complete=${env?.complete} gaps=${JSON.stringify((env?.gaps || []).map((g) => g.code + ':' + g.where))}`);

    // 2) Re-emit from the persisted richTrace (reconstructTrail / toolResults shape)
    const trail = reconstructTrail(rr.richTraceFile);
    console.log(`\n  reconstructTrail → ${trail.length} item(s). locator-needing items + their element field:`);
    const NEEDS = new Set(['browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_hover']);
    for (const a of trail) {
      if (!a || !NEEDS.has(a.tool)) continue;
      const args = a.args || {};
      console.log(`    ${a.tool} ok=${a.ok} element=${JSON.stringify(args.element ?? args.name ?? args.ref ?? null)} argKeys=[${Object.keys(args).join(',')}]`);
    }
    const reEmit = emitter.buildReplayIR({
      caseId: rr.testCaseId,
      trail,
      declaredAssertions: decodeJson(rr.testCase.declaredAssertions, []) || [],
      assertionOutcomes: decodeJson(rr.assertionCheckResults, []) || [],
      verdictStatus: rr.status,
    });
    console.log(`  RE-EMIT(from richTrace) complete=${reEmit.complete} gaps=${JSON.stringify(reEmit.gaps.map((g) => g.code))}  resolves=${reEmit.ir.steps.filter((s) => s.op === 'resolve').length} acts=${reEmit.ir.steps.filter((s) => s.op === 'act').length}`);
  }
  await prisma.$disconnect();
})().catch(async (e) => { console.error('DIAG ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
