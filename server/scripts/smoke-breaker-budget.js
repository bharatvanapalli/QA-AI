'use strict';

/**
 * E10.3 + E10.4 smoke test — verifies the in-memory circuit breaker
 * trips after N failures and the budget service correctly tallies
 * a synthetic usage record.
 *
 * Run with:  node server/scripts/smoke-breaker-budget.js
 */

const breaker = require('../lib/circuitBreaker');
const budget = require('../services/budget');
const prisma = require('../prisma');

function fail(status) {
  const e = new Error(`upstream ${status}`);
  e.status = status;
  return e;
}

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (cond, label) => {
    if (cond) { console.log(`  PASS  ${label}`); passed++; }
    else      { console.log(`  FAIL  ${label}`); failed++; }
  };

  // ── Breaker tests ────────────────────────────────────────
  console.log('--- circuit breaker ---');
  breaker._reset('test-provider');

  // 1. Closed by default.
  let st = breaker.getState('test-provider');
  check(st.status === 'closed', 'starts closed');

  // 2. 4 failures don't trip (threshold is 5).
  for (let i = 0; i < 4; i++) breaker.recordFailure('test-provider', fail(500));
  st = breaker.getState('test-provider');
  check(st.status === 'closed' && st.failureCount === 4, 'still closed after 4 fails');

  // 3. 5th failure trips it open.
  breaker.recordFailure('test-provider', fail(503));
  st = breaker.getState('test-provider');
  check(st.status === 'open', 'opens after 5th failure');

  // 4. check() now throws BREAKER_OPEN.
  let thrown = null;
  try { breaker.check('test-provider'); } catch (e) { thrown = e; }
  check(thrown?.code === 'BREAKER_OPEN', 'check() throws BREAKER_OPEN when open');

  // 5. 4xx errors don't count toward the streak (reset first).
  breaker._reset('test-provider');
  for (let i = 0; i < 10; i++) breaker.recordFailure('test-provider', fail(400));
  st = breaker.getState('test-provider');
  check(st.status === 'closed' && st.failureCount === 0, '4xx errors do not trip breaker');

  // 6. 429 (rate limit) doesn't count.
  breaker._reset('test-provider');
  for (let i = 0; i < 10; i++) breaker.recordFailure('test-provider', fail(429));
  st = breaker.getState('test-provider');
  check(st.status === 'closed', '429 does not trip breaker');

  // 7. Network error (no status) counts.
  breaker._reset('test-provider');
  for (let i = 0; i < 5; i++) breaker.recordFailure('test-provider', new Error('ECONNREFUSED'));
  st = breaker.getState('test-provider');
  check(st.status === 'open', 'network errors (no status) trip breaker');

  // 8. recordSuccess closes the breaker.
  breaker.recordSuccess('test-provider');
  st = breaker.getState('test-provider');
  check(st.status === 'closed' && st.failureCount === 0, 'recordSuccess closes the breaker');

  // ── Budget tests ─────────────────────────────────────────
  console.log('--- budget service ---');
  const user = await prisma.user.findFirst({ where: { currentOrgId: { not: null } } });
  if (!user) {
    console.log('  SKIP  no users with currentOrgId — skipping budget tests');
  } else {
    const todayKey = budget._todayUtc();

    // Clean slate for this test run.
    await prisma.userDailyUsage.deleteMany({ where: { userId: user.id, date: todayKey } });
    await prisma.user.update({ where: { id: user.id }, data: { dailyTokenLimit: 1000 } });

    // 9. Initially under limit.
    let s = await budget.getStatus(user.id);
    check(s.used === 0 && s.limit === 1000 && s.pct === 0, 'starts at 0 / 1000');

    // 10. Record 400 tokens → 40 %.
    await budget.recordUsage(user.id, 'claude', { input_tokens: 200, output_tokens: 200 });
    s = await budget.getStatus(user.id);
    check(s.used === 400 && s.pct === 40, 'records 400 tokens (40%)');

    // 11. Under limit → assertWithinLimit doesn't throw.
    let thrown2 = null;
    try { await budget.assertWithinLimit(user.id); } catch (e) { thrown2 = e; }
    check(!thrown2, 'assertWithinLimit OK at 40%');

    // 12. Push to over-limit.
    await budget.recordUsage(user.id, 'claude', { input_tokens: 800, output_tokens: 0 });
    s = await budget.getStatus(user.id);
    check(s.used === 1200 && s.pct === 100, 'over-limit shows 1200 tokens / 100%');

    // 13. Now assertWithinLimit throws BUDGET_EXCEEDED.
    let thrown3 = null;
    try { await budget.assertWithinLimit(user.id); } catch (e) { thrown3 = e; }
    check(thrown3?.code === 'BUDGET_EXCEEDED', 'assertWithinLimit throws BUDGET_EXCEEDED when over');

    // 14. Multi-provider breakdown surfaces both.
    await budget.recordUsage(user.id, 'gemini', { input_tokens: 100, output_tokens: 50 });
    s = await budget.getStatus(user.id);
    check(s.perProvider.claude?.tokens === 1200 && s.perProvider.gemini?.tokens === 150,
      'per-provider breakdown shows claude=1200, gemini=150');

    // 15. Unlimited (limit=0) bypasses gate.
    await prisma.user.update({ where: { id: user.id }, data: { dailyTokenLimit: 0 } });
    let thrown4 = null;
    try { await budget.assertWithinLimit(user.id); } catch (e) { thrown4 = e; }
    check(!thrown4, 'limit=0 is unlimited (gate bypassed)');

    // Cleanup.
    await prisma.userDailyUsage.deleteMany({ where: { userId: user.id, date: todayKey } });
    await prisma.user.update({ where: { id: user.id }, data: { dailyTokenLimit: null } });
  }

  await prisma.$disconnect();

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
