/**
 * Polls the live RunResult for S13·C1 and prints the action trail.
 * Run after _trigger_smoke_s13c1.cjs (or when a run is already in-flight).
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PROJECT_ID = '465f2d08-c8b5-469a-af41-9c0ba2a2ce93';
const TC_ID      = 'cc13d9c4-862c-4243-ad7a-e348c37b9beb';

(async () => {
  let prevLen    = 0;
  let stableHits = 0;

  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 5000));

    const run = await prisma.run.findFirst({
      where: { projectId: PROJECT_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    if (!run) { process.stdout.write('.'); continue; }

    const rr = await prisma.runResult.findFirst({
      where: { runId: run.id, testCaseId: TC_ID },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, actionTrail: true, error: true, blockedReason: true },
    });
    if (!rr) { process.stdout.write(','); continue; }

    let trail = [];
    try { trail = JSON.parse(rr.actionTrail || '[]'); } catch (_) {}

    if (trail.length > prevLen) {
      const fresh = trail.slice(prevLen);
      for (const e of fresh) {
        const t     = String(e.turn ?? '?').padStart(2);
        const tool  = String(e.tool || 'narrate').padEnd(26);
        const ok    = e.ok === false ? 'ERR' : e.ok === true ? ' ok' : ' · ';
        const narr  = String(e.narration || e.args?.url || '').slice(0, 110);
        const err   = e.error ? ` >> ${String(e.error).slice(0, 90)}` : '';
        console.log(`[t${t}] ${ok}  ${tool}  ${narr}${err}`);
      }
      prevLen    = trail.length;
      stableHits = 0;
    } else {
      stableHits++;
      if (i % 3 === 0) process.stdout.write(`(+${stableHits})`);
    }

    if (rr.status && rr.status !== 'running') {
      console.log(`\n\n══ FINAL: ${rr.status.toUpperCase()} ══`);
      if (rr.error)        console.log('error:', rr.error.slice(0, 300));
      if (rr.blockedReason) console.log('blockedReason:', rr.blockedReason);
      console.log('Total trail entries:', trail.length);
      // Summarise tool calls
      const toolCounts = {};
      let errCount = 0;
      for (const e of trail) {
        toolCounts[e.tool] = (toolCounts[e.tool] || 0) + 1;
        if (e.ok === false) errCount++;
      }
      console.log('Tool usage:', JSON.stringify(toolCounts, null, 2));
      console.log('Error turns:', errCount);
      break;
    }

    if (stableHits >= 12) {
      console.log('\n[poll] No new entries for 60s — likely stalled. Dumping last 5 trail entries:');
      trail.slice(-5).forEach(e => console.log(' ', JSON.stringify(e).slice(0, 200)));
      break;
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error('ERR', e.message); prisma.$disconnect(); process.exit(1); });
