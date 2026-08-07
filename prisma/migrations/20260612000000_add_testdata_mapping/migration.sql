-- Enterprise Mode P4a — the TestData approval ledger.
-- Additive only: one new table, no column changes to existing rows, so the
-- preserved trial-run history is untouched. Hand-authored + applied via
-- `prisma migrate deploy` (see memory: prisma-migration-gotcha — migrate dev's
-- shadow-DB replay is broken here).

-- An IMMUTABLE, versioned snapshot of an APPROVED column→field mapping. The
-- editable draft stays on TestDataSet.mappingJson; approving snapshots it here.
CREATE TABLE "TestDataMapping" (
    "id"               TEXT NOT NULL PRIMARY KEY,
    "testDataSetId"    TEXT NOT NULL,
    "projectId"        TEXT NOT NULL,
    "version"          INTEGER NOT NULL,
    "status"           TEXT NOT NULL DEFAULT 'approved',
    "mappingJson"      TEXT NOT NULL,
    "verificationJson" TEXT,
    "approvalNote"     TEXT,
    "createdBy"        TEXT,
    "approvedBy"       TEXT,
    "approvedAt"       DATETIME,
    "rejectedReason"   TEXT,
    "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TestDataMapping_testDataSetId_fkey" FOREIGN KEY ("testDataSetId") REFERENCES "TestDataSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TestDataMapping_projectId_idx" ON "TestDataMapping"("projectId");
CREATE INDEX "TestDataMapping_testDataSetId_status_idx" ON "TestDataMapping"("testDataSetId", "status");
CREATE UNIQUE INDEX "TestDataMapping_testDataSetId_version_key" ON "TestDataMapping"("testDataSetId", "version");
