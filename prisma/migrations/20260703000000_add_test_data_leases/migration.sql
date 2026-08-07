-- Phase 2A: runtime test-data mutex leases.
CREATE TABLE "TestDataLease" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "testCaseId" TEXT,
  "lockKey" TEXT NOT NULL,
  "dataSetName" TEXT,
  "dataRowIndex" INTEGER,
  "expiresAt" DATETIME NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "TestDataLease_projectId_lockKey_key" ON "TestDataLease"("projectId", "lockKey");
CREATE INDEX "TestDataLease_runId_idx" ON "TestDataLease"("runId");
CREATE INDEX "TestDataLease_expiresAt_idx" ON "TestDataLease"("expiresAt");
