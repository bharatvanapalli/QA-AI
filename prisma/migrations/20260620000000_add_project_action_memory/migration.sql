-- Active per-project execution memory for stable reruns.
-- Stores verified action-time locators keyed by semantic step intent, not by
-- chronological step number.

CREATE TABLE "ProjectActionMemory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "testCaseId" TEXT NOT NULL DEFAULT '',
  "scenarioId" TEXT,
  "module" TEXT,
  "stepOrdinal" INTEGER,
  "stepIntentHash" TEXT NOT NULL,
  "stepIntentHashVersion" TEXT NOT NULL DEFAULT 'qaai-step-intent-v1',
  "stepIntentPartsJson" TEXT,
  "routeKey" TEXT NOT NULL,
  "pageUrl" TEXT NOT NULL DEFAULT '',
  "toolName" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "elementKey" TEXT NOT NULL,
  "elementLabel" TEXT,
  "selectorExpression" TEXT,
  "frameworkExpressionsJson" TEXT,
  "actionLocatorJson" TEXT,
  "targetFactsJson" TEXT,
  "contextJson" TEXT,
  "domAtlasPageJson" TEXT,
  "successCount" INTEGER NOT NULL DEFAULT 1,
  "failureCount" INTEGER NOT NULL DEFAULT 0,
  "healthScore" INTEGER NOT NULL DEFAULT 100,
  "trustState" TEXT NOT NULL DEFAULT 'candidate',
  "lastRunId" TEXT,
  "lastRunResultId" TEXT,
  "lastUsedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectActionMemory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProjectActionMemory_projectId_testCaseId_routeKey_actionType_stepIntentHash_key"
  ON "ProjectActionMemory"("projectId", "testCaseId", "routeKey", "actionType", "stepIntentHash");

CREATE INDEX "ProjectActionMemory_projectId_testCaseId_idx"
  ON "ProjectActionMemory"("projectId", "testCaseId");

CREATE INDEX "ProjectActionMemory_projectId_routeKey_actionType_idx"
  ON "ProjectActionMemory"("projectId", "routeKey", "actionType");

CREATE INDEX "ProjectActionMemory_projectId_healthScore_idx"
  ON "ProjectActionMemory"("projectId", "healthScore");

CREATE INDEX "ProjectActionMemory_projectId_trustState_idx"
  ON "ProjectActionMemory"("projectId", "trustState");
