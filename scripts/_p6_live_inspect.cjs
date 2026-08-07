'use strict';
/**
 * P6 LIVE ACTIVATION — inspect half. Reads the FRESH run's RunResult.replayIrJson
 * and runs the user's acceptance steps 3-8 on the LIVE-persisted envelope:
 *   3 inspect replayIrJson    4 validate envelope {ir,complete,gaps,emittedAt,emitterVersion}
 *   5 validateReplayIR(ir)    6 compile through the reference Playwright adapter
 *   7 no inline secret/test-data value    8 ir.verdict.status === RunResult.status
 *
 * Activation = at least one RunResult of the fresh run carries a populated, VALID,
 * leak-free, verdict-parity envelope. complete:false + gaps are surfaced HONESTLY
 * (missing trace evidence is reported, never fabricated) — not treated as a defect.
 * READ-ONLY. [[preserve-trial-data]]
 *
 *   node scripts/_p6_live_inspect.cjs [runId]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const contract = require('../server/services/codegen/adapters/frameworkAdapter');
const registry = require('../server/services/codegen/adapters');
const { decodeJson } = require('../server/services/jsonField');
const prisma = new PrismaClient();

const PID = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const SECRET_LITERALS = ['admin123']; // OrangeHRM demo password — must NEVER appear in an IR
let fails = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails++; };
const A = (c, m, d) => (c ? ok(m) : bad(`${m}${d ? '  — ' + d : ''}`));

(async () => {
  const runId = process.argv[2];
  const run = runId
    ? await prisma.run.findUnique({ where: { id: runId } })
    : await prisma.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' } });
  if (!run) { console.error('no run found'); process.exit(2); }
  console.log(`\nRUN ${run.id}`);
  console.log(`  status=${run.status}  P${run.passed}/F${run.failed}/B${run.blocked}/S${run.skipped}  started=${run.startedAt.toISOString()}  completed=${run.completedAt ? run.completedAt.toISOString() : '(still running?)'}`);

  const results = await prisma.runResult.findMany({
    where: { runId: run.id },
    include: { testCase: { select: { name: true, declaredAssertions: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`  ${results.length} RunResult(s)\n`);

  const adapter = registry.getAdapter('playwright-reference');
  let activated = 0;

  for (const rr of results) {
    const label = `[${rr.status}] ${rr.testCase?.name?.slice(0, 60) || rr.testCaseId}`;
    console.log(`── ${label}`);
    const env = decodeJson(rr.replayIrJson, null);

    // (3) populated
    if (!env) { bad(`replayIrJson present  (RunResult ${rr.id})`); console.log(''); continue; }
    ok('replayIrJson populated by the live run');

    // (4) envelope shape
    const shapeOk = env && env.ir && typeof env.complete === 'boolean' && Array.isArray(env.gaps) && env.emittedAt && env.emitterVersion;
    A(shapeOk, `envelope shape {ir,complete,gaps,emittedAt,emitterVersion}  (v=${env.emitterVersion}, complete=${env.complete}, gaps=${env.gaps?.length ?? '?'})`);
    if (!shapeOk) { console.log(''); continue; }
    if (!env.complete) console.log(`        honesty: complete=false — gaps: ${env.gaps.map((g) => g.code).join(', ')}`);

    // (5) validateReplayIR
    const v = contract.validateReplayIR(env.ir);
    const vErrors = (v.findings || []).filter((f) => f.severity === 'error');
    A(v.valid && vErrors.length === 0, 'validateReplayIR → valid, zero error findings', vErrors.map((f) => f.rule).join(','));

    // (6) compile through the REAL reference adapter
    let compiled = null;
    try { compiled = contract.compileReplayIR(adapter, env.ir); } catch (e) { bad('compileReplayIR threw: ' + e.message); }
    let compiledContent = '';
    if (compiled) {
      compiledContent = compiled.files?.[compiled.layout?.testFile || compiled.layout?.primaryFile] || Object.values(compiled.files || {}).join('\n');
      A(compiledContent.length > 0, 'adapter compiled a non-empty spec from the live IR');
    }

    // (7) no inline secret / test-data value
    const acts = (env.ir.steps || []).filter((s) => s.op === 'act');
    A(acts.every((s) => !('value' in s)), 'NO act step carries an inline value (valueRef only)');
    const valueActs = acts.filter((s) => ['fill', 'type', 'press', 'selectOption'].includes(s.action));
    A(valueActs.every((s) => /^(env|vault|fixture|masked):/i.test(s.valueRef || '')), 'value-bearing acts use a safe valueRef scheme');
    const irStr = JSON.stringify(env.ir);
    const leaked = SECRET_LITERALS.filter((lit) => irStr.includes(lit));
    A(leaked.length === 0, 'no known secret literal anywhere in the IR', leaked.join(','));
    const compiledLeak = SECRET_LITERALS.filter((lit) => compiledContent.includes(lit));
    A(compiledLeak.length === 0, 'no known secret literal in the COMPILED spec', compiledLeak.join(','));

    // (8) verdict parity
    A(env.ir.verdict && env.ir.verdict.status === rr.status, `ir.verdict.status === RunResult.status  (ir=${env.ir.verdict?.status}, rr=${rr.status})`);

    const stepOps = {};
    for (const s of (env.ir.steps || [])) stepOps[s.op] = (stepOps[s.op] || 0) + 1;
    console.log(`        steps: ${JSON.stringify(stepOps)}  perAssertion: ${(env.ir.verdict?.perAssertionOutcomes || []).map((p) => p.status).join('/')}`);
    activated++;
    console.log('');
  }

  console.log(`activation envelopes inspected: ${activated}/${results.length}`);
  const verdict = (fails === 0 && activated >= 1 && run.status !== 'running')
    ? 'PASS — fresh live execution persists a valid, leak-free, verdict-parity ReplayIR pinned to the RunResult'
    : (run.status === 'running' ? 'WAIT — run still in progress; re-run inspect after completion'
      : `FAIL — ${fails} check(s) failed`);
  console.log(`\n${verdict}\n`);
  await prisma.$disconnect();
  process.exit(fails === 0 && activated >= 1 && run.status !== 'running' ? 0 : 1);
})().catch(async (e) => { console.error('INSPECT ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
