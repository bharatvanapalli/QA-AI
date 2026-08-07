// E2E live run driver + monitor for Orange HRM. PrismaClient ctor loads .env.
// Usage: node e2e_run.cjs start  |  node e2e_run.cjs watch
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BASE = 'http://localhost:5000';
const PROJECT = '9675bfde-acb2-4eda-aaed-b6694b88f920';
const USER = { sub: 'a5d916cd-4178-4bcc-b409-c885a389e843', email: 'bharatvanapalli8@gmail.com', role: 'user' };

function authHeaders() {
  const token = jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: '4h' });
  const csrf = crypto.randomBytes(16).toString('hex');
  return { 'Content-Type': 'application/json', 'Cookie': `token=${token}; XSRF-TOKEN=${csrf}`, 'x-xsrf-token': csrf };
}

async function start() {
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/agents/execute`, { method: 'POST', headers: authHeaders(), body: '{}' });
  console.log('[execute] status:', res.status, (await res.text()).slice(0, 200));
}

async function watch() {
  const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' },
    select: { id: true, status: true, passed: true, failed: true, blocked: true, skipped: true, startedAt: true } });
  if (!run) return console.log('no run found');
  const results = await prisma.runResult.findMany({ where: { runId: run.id },
    orderBy: { id: 'asc' },
    select: { status: true, blockedReason: true, error: true, testCase: { select: { name: true } } } });
  console.log(`run=${run.id.slice(0,8)} status=${run.status}  P${run.passed}/F${run.failed}/B${run.blocked}/S${run.skipped}  results=${results.length}  age=${Math.round((Date.now()-run.startedAt)/1000)}s`);
  const byReason = {};
  for (const r of results) {
    const tag = r.status === 'blocked' ? `blocked:${r.blockedReason||'NULL'}` : r.status;
    byReason[tag] = (byReason[tag]||0)+1;
  }
  console.log('  breakdown:', JSON.stringify(byReason));
  // Show non-pass cases with reason/error for issue-spotting
  const issues = results.filter(r => r.status !== 'pass' && r.status !== 'skipped');
  for (const r of issues.slice(0, 20)) {
    console.log(`  • ${r.status}${r.blockedReason?`(${r.blockedReason})`:''}: "${(r.testCase?.name||'').slice(0,46)}" — ${(r.error||'').split('\n')[0].slice(0,70)}`);
  }
  // flag any blocked row with NULL reason (E0 regression)
  const nullReason = results.filter(r => r.status === 'blocked' && !r.blockedReason).length;
  if (nullReason) console.log(`  ⚠ ${nullReason} blocked row(s) with NULL blockedReason (E0 gap)`);
  return run.status;
}

async function rerunOne(q) {
  const run = await prisma.run.findFirst({ where: { projectId: PROJECT }, orderBy: { startedAt: 'desc' }, select: { id: true } });
  const r = await prisma.runResult.findFirst({ where: { runId: run.id, testCase: { name: { contains: q } } }, orderBy: { id: 'desc' }, select: { id: true, testCaseId: true, status: true } });
  console.log(`[rerunone] run=${run.id.slice(0,8)} case=${r.testCaseId.slice(0,8)} "${q}" prev=${r.status} prevId=${r.id.slice(0,8)}`);
  const url = `${BASE}/api/projects/${PROJECT}/agents/runs/${run.id}/cases/${r.testCaseId}/rerun`;
  const res = await fetch(url, { method: 'POST', headers: authHeaders(), body: '{}' });
  console.log('[rerunone] POST', res.status, (await res.text()).slice(0,140));
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const cur = await prisma.runResult.findFirst({ where: { runId: run.id, testCaseId: r.testCaseId }, orderBy: { id: 'desc' }, select: { id: true, status: true, blockedReason: true, mechanicalVerdictReason: true } });
    process.stdout.write(`\r[rerunone] status=${cur?.status} mech=${cur?.mechanicalVerdictReason||'-'} id=${cur?.id?.slice(0,8)}     `);
    if (cur && cur.id !== r.id) { console.log(`\n[rerunone] FRESH: status=${cur.status} mech=${cur.mechanicalVerdictReason||'-'} blockedReason=${cur.blockedReason||'-'}`); return; }
  }
  console.log('\n[rerunone] timed out');
}

async function rerunFailed() {
  const res = await fetch(`${BASE}/api/projects/${PROJECT}/agents/rerun-failed`, { method: 'POST', headers: authHeaders(), body: '{}' });
  console.log('[rerun-failed] status:', res.status, (await res.text()).slice(0, 220));
}

(async () => {
  try {
    const a = process.argv[2] || 'watch';
    if (a === 'start') await start();
    else if (a === 'rerunfailed') await rerunFailed();
    else if (a === 'rerunone') await rerunOne(process.argv[3] || 'empty password');
    else await watch();
  }
  catch (e) { console.error('ERR', e.message); }
  finally { await prisma.$disconnect(); process.exit(0); }
})();
