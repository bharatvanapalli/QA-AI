-- Fix the Test Cases vs Overview count divergence.
--
-- Two root causes:
--   1. On regenerate, `testCase.deleteMany({ status: { in: ['pending','approved'] } })`
--      left rows with status 'running' (interrupted runs) or 'rejected' (user
--      action). Their parent scenario was deleted, so they vanished from the
--      Test Cases page (which queries via scenarios) but the dashboard kept
--      counting them via `testCase.findMany({ projectId })`.
--   2. GovernancePR.testCaseId and BlockedItem.testCaseId were plain strings
--      with no foreign-key constraint, so orphan PR/Blocker rows survived TC
--      deletion forever, inflating the "PRs pending" / "blocked" tiles.
--
-- This migration:
--   (a) NULLs out testCaseId on PR/Blocker rows whose TC no longer exists.
--   (b) Deletes orphan TestCase rows whose scenario was removed (scenarioId
--       IS NULL after the prior SetNull cascade). RunResult rows for these
--       cascade-delete via the existing RunResult.testCase FK.
--   (c) Recomputes Run.passed/failed/blocked/skipped from surviving
--       RunResult rows so historical Run rows don't report stale counts.
--   (d) Adds proper foreign-key constraints to GovernancePR.testCaseId and
--       BlockedItem.testCaseId so future TC deletions cleanly SetNull
--       instead of orphaning.

-- (a) Null out stale testCaseId references BEFORE rebuilding the tables.
UPDATE "GovernancePR" SET "testCaseId" = NULL
 WHERE "testCaseId" IS NOT NULL
   AND "testCaseId" NOT IN (SELECT "id" FROM "TestCase");

UPDATE "BlockedItem" SET "testCaseId" = NULL
 WHERE "testCaseId" IS NOT NULL
   AND "testCaseId" NOT IN (SELECT "id" FROM "TestCase");

-- (b) Delete TestCase rows whose scenario was removed. These are the
--     "ghost" cases that polluted the dashboard but were invisible to the
--     Test Cases page. RunResult rows cascade-delete via existing FK.
DELETE FROM "TestCase" WHERE "scenarioId" IS NULL;

-- (c) Recompute denormalised Run counters from surviving RunResults so the
--     Recent Runs list and dashboard tiles reflect reality after orphan
--     cleanup. Any Run whose results were all orphans will now show zeros,
--     which is correct — those cases no longer exist.
UPDATE "Run" SET
  "passed"  = (SELECT COUNT(*) FROM "RunResult" WHERE "runId" = "Run"."id" AND "status" = 'pass'),
  "failed"  = (SELECT COUNT(*) FROM "RunResult" WHERE "runId" = "Run"."id" AND "status" = 'fail'),
  "blocked" = (SELECT COUNT(*) FROM "RunResult" WHERE "runId" = "Run"."id" AND "status" = 'blocked'),
  "skipped" = (SELECT COUNT(*) FROM "RunResult" WHERE "runId" = "Run"."id" AND "status" = 'skipped');

-- (d) Rebuild GovernancePR + BlockedItem with the new FK to TestCase.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_GovernancePR" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "testCaseId" TEXT,
    "number" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "requirement" TEXT NOT NULL,
    "specCode" TEXT NOT NULL,
    "lintPassed" BOOLEAN NOT NULL DEFAULT true,
    "lintFindings" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewer" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GovernancePR_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GovernancePR_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_GovernancePR" ("id", "projectId", "runId", "testCaseId", "number", "filename", "requirement", "specCode", "lintPassed", "lintFindings", "status", "reviewer", "reviewedAt", "createdAt", "updatedAt")
SELECT "id", "projectId", "runId", "testCaseId", "number", "filename", "requirement", "specCode", "lintPassed", "lintFindings", "status", "reviewer", "reviewedAt", "createdAt", "updatedAt" FROM "GovernancePR";
DROP TABLE "GovernancePR";
ALTER TABLE "new_GovernancePR" RENAME TO "GovernancePR";
CREATE UNIQUE INDEX "GovernancePR_projectId_number_key" ON "GovernancePR"("projectId", "number");
CREATE INDEX "GovernancePR_projectId_status_idx" ON "GovernancePR"("projectId", "status");

CREATE TABLE "new_BlockedItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "runId" TEXT,
    "testCaseId" TEXT,
    "reason" TEXT NOT NULL,
    "locator" TEXT,
    "message" TEXT NOT NULL,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockedItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BlockedItem_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_BlockedItem" ("id", "projectId", "runId", "testCaseId", "reason", "locator", "message", "resolved", "resolvedAt", "createdAt")
SELECT "id", "projectId", "runId", "testCaseId", "reason", "locator", "message", "resolved", "resolvedAt", "createdAt" FROM "BlockedItem";
DROP TABLE "BlockedItem";
ALTER TABLE "new_BlockedItem" RENAME TO "BlockedItem";
CREATE INDEX "BlockedItem_projectId_resolved_idx" ON "BlockedItem"("projectId", "resolved");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
