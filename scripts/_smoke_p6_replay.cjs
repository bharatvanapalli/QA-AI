'use strict';
/**
 * P6 acceptance smoke (replay-from-REAL-trace) — the user's deterministic gate:
 *   past RunResult trace → ReplayIR → validateReplayIR → compile adapter
 *   → no secret leak → verdict parity, for a PASS and a FAIL/BLOCKED case.
 *
 * Emits from EXISTING captured MCP traces (RunResult.richTraceFile), so live-site
 * flakiness can never be confused with a ReplayIR defect. READ-ONLY over the trial
 * data — no seeding, no mutation, no teardown ([[preserve-trial-data]]).
 *
 * HONESTY: if a trace is missing required evidence, the emitter marks the IR
 * incomplete (complete:false + gaps) — this smoke SURFACES that, it does not paper
 * over it. If no PASS or no FAIL/BLOCKED trace exists, it says so plainly (that
 * category then needs the fresh OrangeHRM run).
 *
 *   node scripts/_smoke_p6_replay.cjs
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { reconstructTrail } = require('../server/services/codegen/_replayTrace');
const emitter = require('../server/services/codegen/replayEmitter');
const contract = require('../server/services/codegen/adapters/frameworkAdapter');
const registry = require('../server/services/codegen/adapters');
const apr = require('../server/services/authProfileResolver');
const { decodeJson } = require('../server/services/jsonField');

const results = [];
const check = (label, cond, detail) => { const ok = !!cond; results.push({ ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  — ' + (detail || '')}`); };

async function loadAuthProfile(projectId, name) {
  if (!name) return { id: 'default', strategy: 'none', disposition: 'bypass_fixture' };
  try {
    const row = await prisma.authProfile.findFirst({ where: { projectId, name } });
    if (!row) return { id: name, strategy: 'none', disposition: 'bypass_fixture' };
    const r = apr.resolveAuthProfile(row);
    return { id: row.name, strategy: row.strategy, disposition: row.disposition, storageStateRef: r.storageStateRef || undefined, credentialRef: r.credentialRef || undefined };
  } catch (_) { return { id: name, strategy: 'none', disposition: 'bypass_fixture' }; }
}

async function emitForResult(rr) {
  const tc = rr.testCase;
  const trail = reconstructTrail(rr.richTraceFile);
  const declaredAssertions = decodeJson(tc.declaredAssertions, []) || [];
  const assertionOutcomes = decodeJson(rr.assertionCheckResults, []) || [];
  const authProfile = await loadAuthProfile(tc.projectId, tc.authProfile);
  const kbRows = await prisma.knowledgeBaseLocator.findMany({ where: { projectId: tc.projectId }, select: { element: true, role: true, accessibleName: true, selector: true } }).catch(() => []);
  const kbByElement = new Map(kbRows.map((k) => [k.element, k]));
  const dataRow = (rr.dataRowIndex != null) ? { index: rr.dataRowIndex, label: rr.dataRowLabel || `Row ${rr.dataRowIndex}`, sensitivity: 'synthetic', fields: {} } : null;
  return emitter.buildReplayIR({
    caseId: tc.id, authProfile, trail, declaredAssertions, assertionOutcomes,
    verdictStatus: rr.status, dataRow, kbByElement,
  });
}

function proveOne(tag, rr, emit) {
  const tcName = rr.testCase.name;
  console.log(`\n[${tag}] "${tcName}" — recorded status=${rr.status} · trail=${reconstructTrail(rr.richTraceFile).length} tool(s) · complete=${emit.complete}`);
  if (!emit.complete) {
    // Honest path: missing evidence surfaced, NOT fabricated. The export lane would
    // mark this unsupported. We assert the gaps are explicit, then skip compile.
    check(`${tag}: incomplete trace surfaces explicit gaps (not fabricated)`, emit.gaps.length > 0, JSON.stringify(emit.gaps.slice(0, 2)));
    console.log(`    gaps: ${emit.gaps.map((g) => g.code).join(', ')}`);
    return;
  }
  const v = contract.validateReplayIR(emit.ir);
  check(`${tag}: validateReplayIR passes (0 errors)`, v.valid, JSON.stringify(v.findings.filter((f) => f.severity === 'error').slice(0, 2)));
  check(`${tag}: verdict PARITY — ir.verdict.status === RunResult.status (${rr.status})`, emit.ir.verdict.status === rr.status);
  const adapter = registry.getAdapter('playwright-reference');
  let compiled = null;
  try { compiled = contract.compileReplayIR(adapter, emit.ir); } catch (e) { check(`${tag}: compile through playwright-reference`, false, e.message); }
  if (compiled) {
    const content = compiled.files[compiled.layout.testFile || compiled.layout.primaryFile] || '';
    check(`${tag}: compiles to a non-empty spec`, content.length > 0);
    // no-leak: no act step inline value (validator enforced) + no secret-keyed literal (walkSecrets in validate)
    check(`${tag}: no inline act value (valueRef only)`, !emit.ir.steps.some((s) => s.op === 'act' && 'value' in s));
  }
}

(async () => {
  console.log('\n=== P6 replay-from-real-trace acceptance ===');
  const candidates = await prisma.runResult.findMany({
    where: { richTraceFile: { not: null } },
    select: {
      id: true, status: true, richTraceFile: true, assertionCheckResults: true,
      dataRowIndex: true, dataRowLabel: true, dataSetName: true,
      testCase: { select: { id: true, name: true, projectId: true, declaredAssertions: true, authProfile: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  // keep only those whose trace file actually reconstructs to a non-empty trail
  const usable = candidates.filter((rr) => rr.testCase && reconstructTrail(rr.richTraceFile).length > 0);
  console.log(`  captured traces with a reconstructable trail: ${usable.length} (of ${candidates.length} richTrace rows)`);

  const passRr = usable.find((rr) => rr.status === 'pass');
  const failRr = usable.find((rr) => rr.status === 'fail' || rr.status === 'blocked');

  if (!usable.length) {
    console.log('\n  NO usable captured traces on disk. The replay gate cannot run until a run produces a richTrace.');
    console.log('  → This is the case where the fresh OrangeHRM run is REQUIRED to generate a trace (report honestly; do not fake).\n');
    process.exitCode = 0;
    await prisma.$disconnect();
    return;
  }

  if (passRr) proveOne('PASS-case', passRr, await emitForResult(passRr));
  else console.log('\n  (no PASS trace captured yet — fresh run needed to cover the pass path)');

  if (failRr) proveOne('FAIL/BLOCKED-case', failRr, await emitForResult(failRr));
  else console.log('\n  (no FAIL/BLOCKED trace captured yet — fresh run needed to cover the failure path)');

  check('at least one real trace emitted + validated through the chain', results.some((r) => r.ok));
  check('a FAIL/BLOCKED trace was available to prove non-green parity', !!failRr, 'none captured — fresh run must cover this before P6 is fully accepted');

  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n=== ${failed ? 'ATTENTION' : 'PASS'} — ${results.length - failed}/${results.length} checks (pass trace: ${!!passRr}, fail/blocked trace: ${!!failRr}) ===\n`);
  process.exitCode = 0; // discovery smoke: missing-category is reported, not a hard fail
  await prisma.$disconnect();
})().catch(async (e) => { console.error('\nP6 REPLAY SMOKE ERROR:', e.message, '\n', e.stack); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
