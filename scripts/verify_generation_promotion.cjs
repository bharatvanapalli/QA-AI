'use strict';
/*
 * DB ACCEPTANCE — runs the CaseCompiler over a REAL generated suite and reports
 * the promotion breakdown, then asserts the gate's invariant on live data:
 *   NO case that compiles to `blocked` may currently be status='approved'.
 *
 * Standalone diagnostic (NOT in the always-green code bundle — it depends on DB
 * state). Run after a generation to prove the suite is honest:
 *   node scripts/verify_generation_promotion.cjs [projectId|generationId]
 * Skips cleanly (exit 0) if env/DB/cases are unavailable.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
let prisma, compileStoredCase;
try {
  require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
  // Use the ROOT prisma client directly (server/prisma.js resolves the server's
  // own client, which points at a different dev.db when run from a script).
  const { PrismaClient } = require(path.join(ROOT, 'node_modules', '@prisma', 'client'));
  prisma = new PrismaClient();
  ({ compileStoredCase } = require(path.join(ROOT, 'server', 'services', 'caseCompiler')));
} catch (e) {
  console.log(`SKIP — DB/env unavailable (${e.message.split('\n')[0]})`);
  process.exit(0);
}

const SELECT = { id: true, name: true, status: true, automatability: true, module: true, assertions: true, steps: true, declaredAssertions: true, dataBindingJson: true, operationsJson: true };

(async () => {
  const arg = process.argv[2] || null;
  let cases = [];
  try {
    if (arg) {
      cases = await prisma.testCase.findMany({ where: { OR: [{ generationId: arg }, { projectId: arg }] }, select: SELECT });
    }
    if (!cases.length) {
      const latest = await prisma.testCase.findFirst({ orderBy: { createdAt: 'desc' }, select: { generationId: true, projectId: true } });
      if (latest) {
        cases = await prisma.testCase.findMany({
          where: latest.generationId ? { generationId: latest.generationId } : { projectId: latest.projectId },
          select: SELECT,
        });
      }
    }
  } catch (e) {
    console.log(`SKIP — query failed (${e.message.split('\n')[0]})`);
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  }

  if (!cases.length) { console.log('SKIP — no generated cases in the DB to audit.'); await prisma.$disconnect().catch(() => {}); process.exit(0); }

  const tally = { ready: 0, needs_review: 0, blocked: 0, manual: 0 };
  const blockerCounts = {};
  const approvedBlocked = [];
  for (const tc of cases) {
    const v = compileStoredCase(tc);
    if (!v.automatable) { tally.manual++; continue; }
    tally[v.state]++;
    for (const b of v.blockers) blockerCounts[b.code] = (blockerCounts[b.code] || 0) + 1;
    if (v.state === 'blocked' && tc.status === 'approved') approvedBlocked.push({ name: tc.name, blockers: v.blockers.map((b) => b.code) });
  }

  console.log(`— CaseCompiler audit over ${cases.length} case(s) —`);
  console.log(`  ready=${tally.ready}  needs_review=${tally.needs_review}  blocked=${tally.blocked}  manual=${tally.manual}`);
  if (Object.keys(blockerCounts).length) {
    console.log('  blocker breakdown: ' + Object.entries(blockerCounts).map(([k, n]) => `${k}=${n}`).join(', '));
  }
  console.log(`  approved cases that compile BLOCKED (must be 0): ${approvedBlocked.length}`);
  for (const a of approvedBlocked.slice(0, 10)) console.log(`    ✗ "${a.name}" — ${a.blockers.join(', ')}`);

  await prisma.$disconnect().catch(() => {});
  if (approvedBlocked.length) {
    console.log(`\nFAILED — ${approvedBlocked.length} approved case(s) are blocked (the promotion gate was bypassed or they were approved before the gate existed).`);
    process.exit(1);
  }
  console.log('\nOK — promotion invariant holds: no approved case is blocked. (Blocked/needs_review counts above show what the compiler is correctly refusing to promote.)');
  process.exit(0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
