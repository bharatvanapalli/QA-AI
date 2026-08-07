'use strict';
/**
 * Poll-until-terminal for the fresh P6 activation run. Exits 0 the moment the new
 * Run leaves 'running'. READ-ONLY.  node scripts/_p6_wait_run.cjs <triggerISO> <lastRunBeforeId>
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const PID = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const triggerAt = new Date(process.argv[2] || 0);
const lastRunBefore = process.argv[3] || null;
const MAX_MS = 18 * 60 * 1000, STEP = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  let appeared = null;
  while (Date.now() - t0 < MAX_MS) {
    const run = await prisma.run.findFirst({ where: { projectId: PID }, orderBy: { startedAt: 'desc' }, select: { id: true, status: true, passed: true, failed: true, blocked: true, skipped: true, startedAt: true } }).catch(() => null);
    const isNew = run && run.id !== lastRunBefore && run.startedAt >= triggerAt;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    if (isNew) {
      appeared = run.id;
      const done = run.status !== 'running';
      console.log(`[${elapsed}s] run ${run.id.slice(0, 8)} status=${run.status} P${run.passed}/F${run.failed}/B${run.blocked}/S${run.skipped}`);
      if (done) { console.log(`DONE ${run.id} ${run.status}`); await prisma.$disconnect(); process.exit(0); }
    } else {
      console.log(`[${elapsed}s] waiting for new run to appear…`);
    }
    await sleep(STEP);
  }
  console.log(`TIMEOUT after ${Math.round((Date.now() - t0) / 1000)}s (appeared=${appeared || 'never'})`);
  await prisma.$disconnect();
  process.exit(3);
})().catch(async (e) => { console.error('WAIT ERROR', e); try { await prisma.$disconnect(); } catch (_) {} process.exit(1); });
