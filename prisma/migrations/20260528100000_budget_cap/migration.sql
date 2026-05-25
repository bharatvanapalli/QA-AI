-- Phase E10.3 — Per-user daily token budget.
--
-- User.dailyTokenLimit: nullable; null means "use the BUDGET_DEFAULT_DAILY_TOKENS env".
-- UserDailyUsage: one row per (user, UTC date, provider). Upserted on every
--   successful provider.complete() call. The unique index guarantees the
--   upsert is atomic without a Prisma-side read-modify-write race.

ALTER TABLE "User" ADD COLUMN "dailyTokenLimit" INTEGER;

CREATE TABLE "UserDailyUsage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "callCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserDailyUsage_userId_date_provider_key" ON "UserDailyUsage"("userId", "date", "provider");
CREATE INDEX "UserDailyUsage_userId_date_idx" ON "UserDailyUsage"("userId", "date");
