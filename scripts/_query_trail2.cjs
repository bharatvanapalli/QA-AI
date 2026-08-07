'use strict';
// Use server's own Prisma client — same binary that conductor uses
const { PrismaClient } = require('../server/node_modules/@prisma/client');
const db = new PrismaClient();
async function main() {
  const rr = await db.runResult.findFirst({
    where: { testCaseId: 'cc13d9c4-862c-4243-ad7a-e348c37b9beb' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      error: true,
      stepResults: true,
      assertionCheckResults: true,
      mechanicalVerdictReason: true,
      agentClaimedVerdict: true,
      durationMs: true,
      rcaClass: true,
      rcaWhat: true,
      blockedReason: true,
      richTraceFile: true,
      assertionGateWouldReject: true,
      assertionGateReason: true,
      createdAt: true
    }
  });
  if (!rr) { console.log('No result yet'); await db.$disconnect(); return; }
  console.log('=== RunResult ===');
  console.log('ID:', rr.id);
  console.log('Status:', rr.status);
  console.log('Duration:', rr.durationMs, 'ms');
  console.log('createdAt:', rr.createdAt);
  console.log('agentClaimedVerdict:', rr.agentClaimedVerdict);
  console.log('mechanicalVerdictReason:', (rr.mechanicalVerdictReason || '').slice(0, 300));
  console.log('blockedReason:', (rr.blockedReason || '').slice(0, 300));
  console.log('assertionGateWouldReject:', rr.assertionGateWouldReject);
  console.log('assertionGateReason:', (rr.assertionGateReason || '').slice(0, 300));
  console.log('rcaClass:', rr.rcaClass, '| rcaWhat:', (rr.rcaWhat || '').slice(0, 200));
  console.log('error:', (rr.error || '').slice(0, 300));
  console.log('richTraceFile:', rr.richTraceFile);

  // stepResults
  let steps = [];
  try { steps = JSON.parse(rr.stepResults || '[]'); } catch(_) {}
  console.log('\n=== Step Results (' + steps.length + ' steps) ===');
  steps.forEach((s, i) => {
    console.log(i, 'step:', s.index, 'status:', s.status, s.error ? ('ERR: ' + String(s.error).slice(0, 80)) : '');
  });

  // assertionCheckResults
  let checks = [];
  try { checks = JSON.parse(rr.assertionCheckResults || '[]'); } catch(_) {}
  console.log('\n=== Assertion Checks (' + checks.length + ') ===');
  checks.forEach((c, i) => {
    console.log(i, 'assertion:', (c.assertion || '').slice(0, 60), '| outcome:', c.outcome, '| source:', c.source);
  });

  await db.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
