'use strict';
/**
 * Poll a Run to completion, then print per-operation locator-capture
 * coverage from its RunResult.stepResults — the same evidence
 * liveReplayCodegen.js reads. Use this after qaai-trigger-run.js to confirm
 * a fix actually changed live capture behavior, not just static code.
 *
 * Usage:
 *   node scripts/qaai-inspect-run.js --run <runId> [--timeout 480000]
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const RUN_ID = argValue('--run', null);
const TIMEOUT_MS = Number(argValue('--timeout', '480000'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  if (!RUN_ID) throw new Error('Pass --run <runId>.');
  const start = Date.now();
  let run;
  while (Date.now() - start < TIMEOUT_MS) {
    run = await prisma.run.findUnique({ where: { id: RUN_ID } });
    if (!run) throw new Error(`Run ${RUN_ID} not found.`);
    if (run.status !== 'running') break;
    await sleep(15_000);
  }
  console.log('RUN_STATUS:', JSON.stringify({ status: run.status, passed: run.passed, failed: run.failed, blocked: run.blocked }));

  const results = await prisma.runResult.findMany({ where: { runId: RUN_ID }, include: { testCase: { select: { name: true } } } });
  for (const r of results) {
    const steps = JSON.parse(r.stepResults || '[]');
    const actions = steps.filter((s) => s.kind === 'action');
    const asserts = steps.filter((s) => s.kind === 'assertion');
    const selects = steps.filter((s) => s.action === 'Select' || s.action === 'Radio');
    console.log(`\n=== ${r.testCase.name} (${r.testCaseId}) — status: ${r.status} ===`);
    console.log(`  actions:    ${actions.filter((s) => s.verifiedLocator).length}/${actions.length} have a verifiedLocator`);
    console.log(`  assertions: ${asserts.filter((s) => s.verifiedLocator).length}/${asserts.length} have a verifiedLocator`);
    console.log(`  select/radio: ${selects.filter((s) => s.verifiedLocator).length}/${selects.length} have a verifiedLocator`);
    for (const s of steps) {
      if (s.action === 'Select' || s.action === 'Radio') {
        console.log(`    ${s.action} "${s.target}" => disp:${s.commitDisposition} expr:${s.verifiedLocator?.expression || 'NULL'}`);
      }
    }
  }
})().catch((err) => {
  console.error('INSPECT_FAILED:', err.message);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
