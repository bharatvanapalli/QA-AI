-- AlterTable
ALTER TABLE "Project" ADD COLUMN "verdictMode" TEXT;

-- AlterTable
ALTER TABLE "TestCase" ADD COLUMN "declaredAssertions" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sprintId" TEXT,
    "sprintName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "blocked" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "verdictMode" TEXT NOT NULL DEFAULT 'legacy',
    "config" TEXT,
    CONSTRAINT "Run_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Run" ("blocked", "completedAt", "config", "failed", "id", "passed", "projectId", "skipped", "sprintId", "sprintName", "startedAt", "status", "userId") SELECT "blocked", "completedAt", "config", "failed", "id", "passed", "projectId", "skipped", "sprintId", "sprintName", "startedAt", "status", "userId" FROM "Run";
DROP TABLE "Run";
ALTER TABLE "new_Run" RENAME TO "Run";
CREATE INDEX "Run_userId_projectId_idx" ON "Run"("userId", "projectId");
CREATE INDEX "Run_sprintId_idx" ON "Run"("sprintId");
CREATE TABLE "new_RunResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "durationMs" INTEGER,
    "error" TEXT,
    "screenshots" TEXT NOT NULL DEFAULT '[]',
    "video" TEXT,
    "trace" TEXT,
    "networkLog" TEXT,
    "domSnapshots" TEXT,
    "rcaWhat" TEXT,
    "rcaWhy" TEXT,
    "rcaFix" TEXT,
    "rcaClass" TEXT,
    "rcaConfidence" INTEGER,
    "ticketId" TEXT,
    "ticketUrl" TEXT,
    "chatHistory" TEXT,
    "baselineScreenshot" TEXT,
    "visualVerdict" TEXT,
    "visualDiffSummary" TEXT,
    "visualDiffs" TEXT,
    "stepResults" TEXT,
    "richTraceFile" TEXT,
    "assertionGateWouldReject" BOOLEAN NOT NULL DEFAULT false,
    "assertionGateReason" TEXT,
    "verdictVersion" TEXT NOT NULL DEFAULT 'legacy',
    "verdictMode" TEXT NOT NULL DEFAULT 'legacy',
    "agentClaimedVerdict" TEXT,
    "flipDirection" TEXT,
    "assertionCheckResults" TEXT,
    "mechanicalVerdictReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RunResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RunResult_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RunResult" ("assertionGateReason", "assertionGateWouldReject", "baselineScreenshot", "chatHistory", "createdAt", "domSnapshots", "durationMs", "error", "id", "networkLog", "rcaClass", "rcaConfidence", "rcaFix", "rcaWhat", "rcaWhy", "richTraceFile", "runId", "screenshots", "status", "stepResults", "testCaseId", "ticketId", "ticketUrl", "trace", "video", "visualDiffSummary", "visualDiffs", "visualVerdict") SELECT "assertionGateReason", "assertionGateWouldReject", "baselineScreenshot", "chatHistory", "createdAt", "domSnapshots", "durationMs", "error", "id", "networkLog", "rcaClass", "rcaConfidence", "rcaFix", "rcaWhat", "rcaWhy", "richTraceFile", "runId", "screenshots", "status", "stepResults", "testCaseId", "ticketId", "ticketUrl", "trace", "video", "visualDiffSummary", "visualDiffs", "visualVerdict" FROM "RunResult";
DROP TABLE "RunResult";
ALTER TABLE "new_RunResult" RENAME TO "RunResult";
CREATE INDEX "RunResult_runId_idx" ON "RunResult"("runId");
CREATE INDEX "RunResult_verdictVersion_createdAt_flipDirection_idx" ON "RunResult"("verdictVersion", "createdAt", "flipDirection");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
