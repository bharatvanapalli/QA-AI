'use strict';

/**
 * Per-user daily token budget — E10.3.
 *
 * Two responsibilities:
 *   1. Pre-flight (assertWithinLimit): throw BUDGET_EXCEEDED before
 *      making the upstream call when the user is at or above their
 *      daily ceiling. Conductor's existing error path surfaces this
 *      as a BLOCKED outcome on the run.
 *   2. Post-flight (recordUsage): increment the day's counters after
 *      a successful provider.complete(). On error we do NOT bill —
 *      the user shouldn't be charged for an upstream 5xx.
 *
 * Storage: UserDailyUsage rows keyed (userId, date YYYY-MM-DD UTC,
 * provider). One row per provider so we can show the breakdown in the
 * UI without re-aggregating, but the ceiling is enforced on the
 * cross-provider sum (a heavy Claude day + heavy Gemini day still
 * counts as one user's day).
 *
 * Ceiling resolution:
 *   - User.dailyTokenLimit if set (non-null, > 0)
 *   - else BUDGET_DEFAULT_DAILY_TOKENS env (default below)
 *   - 0 or negative ceiling = unlimited (escape hatch for ops)
 *
 * The chip in PageHeader queries GET /api/budget/status which returns
 * { used, limit, pct, perProvider, blockedToday } — UI decides whether
 * to render warning vs critical state at >= 80% / >= 100%.
 */

const prisma = require('../prisma');

const DEFAULT_DAILY_TOKEN_LIMIT = parseInt(
  process.env.BUDGET_DEFAULT_DAILY_TOKENS || '5000000',
  10,
); // 5M tokens / day default — generous; users override if needed.

/**
 * "Today" in UTC as YYYY-MM-DD. Server-wide consistent — no TZ math at
 * write time. UI also uses UTC midnight for the reset countdown.
 */
function todayUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function resolveLimit(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { dailyTokenLimit: true },
  });
  const override = u?.dailyTokenLimit;
  if (override == null) return DEFAULT_DAILY_TOKEN_LIMIT;
  return override; // 0 / negative = unlimited (handled by caller)
}

async function todaysTotal(userId, date) {
  const rows = await prisma.userDailyUsage.findMany({
    where: { userId, date },
    select: { provider: true, inputTokens: true, outputTokens: true, callCount: true, blockedCount: true },
  });
  let total = 0;
  let calls = 0;
  let blocked = 0;
  const perProvider = {};
  for (const r of rows) {
    const sum = (r.inputTokens || 0) + (r.outputTokens || 0);
    total += sum;
    calls += r.callCount || 0;
    blocked += r.blockedCount || 0;
    perProvider[r.provider] = {
      tokens: sum,
      input: r.inputTokens || 0,
      output: r.outputTokens || 0,
      calls: r.callCount || 0,
    };
  }
  return { total, calls, blocked, perProvider };
}

/**
 * Throws BUDGET_EXCEEDED when the user is over their daily ceiling.
 * Increments the blocked counter so the operator can see (in the
 * Settings UI) how many calls today were refused.
 */
async function assertWithinLimit(userId) {
  if (!userId) return; // background / scripts bypass
  const limit = await resolveLimit(userId);
  if (!limit || limit <= 0) return; // 0/negative = unlimited
  const date = todayUtc();
  const { total } = await todaysTotal(userId, date);
  if (total < limit) return;

  // Bump the blockedCount on the most-recent provider row so the UI
  // can show "12 calls refused today" without a separate counter.
  // We don't know the provider here yet (called BEFORE complete()),
  // so we attribute to a synthetic 'system' provider row.
  await prisma.userDailyUsage.upsert({
    where: { userId_date_provider: { userId, date, provider: 'system' } },
    create: {
      userId, date, provider: 'system',
      inputTokens: 0, outputTokens: 0, callCount: 0, blockedCount: 1,
    },
    update: { blockedCount: { increment: 1 } },
  });

  const err = new Error(
    `Daily token budget exceeded (${total.toLocaleString()} / ${limit.toLocaleString()} tokens used today). ` +
    `Limit resets at UTC midnight, or raise your ceiling in Settings → AI Provider.`,
  );
  err.code = 'BUDGET_EXCEEDED';
  err.status = 429;
  err.budget = { used: total, limit };
  throw err;
}

/**
 * Record a successful provider.complete() against the day's row.
 * Anthropic returns usage.{input_tokens, output_tokens}; Gemini's
 * geminiResponseToAnthropic translates to the same shape.
 *
 * Never throws — bookkeeping failures are logged and swallowed in the
 * llmProvider wrapper so they can't break the actual AI call.
 */
async function recordUsage(userId, provider, usage) {
  if (!userId || !usage) return;
  const input = Math.max(0, Number(usage.input_tokens) || 0);
  const output = Math.max(0, Number(usage.output_tokens) || 0);
  if (input === 0 && output === 0) return; // nothing to record

  const date = todayUtc();
  await prisma.userDailyUsage.upsert({
    where: { userId_date_provider: { userId, date, provider } },
    create: {
      userId, date, provider,
      inputTokens: input, outputTokens: output, callCount: 1, blockedCount: 0,
    },
    update: {
      inputTokens: { increment: input },
      outputTokens: { increment: output },
      callCount: { increment: 1 },
    },
  });
}

/**
 * GET /api/budget/status payload shape. UI consumes:
 *   { used, limit, pct, unlimited, perProvider, blockedToday, resetAt }
 */
async function getStatus(userId) {
  const date = todayUtc();
  const limit = await resolveLimit(userId);
  const { total, blocked, perProvider } = await todaysTotal(userId, date);
  const unlimited = !limit || limit <= 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((total / limit) * 100));

  // Reset = next UTC midnight as ISO string.
  const now = new Date();
  const reset = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0,
  ));

  return {
    used: total,
    limit: unlimited ? null : limit,
    pct,
    unlimited,
    blockedToday: blocked,
    perProvider,
    resetAt: reset.toISOString(),
  };
}

module.exports = {
  assertWithinLimit,
  recordUsage,
  getStatus,
  DEFAULT_DAILY_TOKEN_LIMIT,
  // exported for tests
  _todayUtc: todayUtc,
};
