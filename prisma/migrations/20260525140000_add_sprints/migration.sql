-- CreateTable: Sprint (per-project release container, B3 hybrid)
CREATE TABLE "Sprint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lifecycle" TEXT NOT NULL DEFAULT 'in_progress',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable: SprintTestCase (join — which cases ran inside which sprint)
CREATE TABLE "SprintTestCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sprintId" TEXT NOT NULL,
    "testCaseId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SprintTestCase_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SprintTestCase_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable: add nullable sprintId columns to artifact tables. Plain TEXT
-- (no enforced FK) so SQLite ALTER works without the RedefineTables rewrite
-- pattern; integrity is enforced at the Prisma/application layer.
ALTER TABLE "Document"     ADD COLUMN "sprintId" TEXT;
ALTER TABLE "Requirement"  ADD COLUMN "sprintId" TEXT;
ALTER TABLE "Run"          ADD COLUMN "sprintId" TEXT;
ALTER TABLE "BlockedItem"  ADD COLUMN "sprintId" TEXT;
ALTER TABLE "GovernancePR" ADD COLUMN "sprintId" TEXT;

-- Indices
CREATE INDEX "Sprint_projectId_idx" ON "Sprint"("projectId");
CREATE UNIQUE INDEX "SprintTestCase_sprintId_testCaseId_key" ON "SprintTestCase"("sprintId", "testCaseId");
CREATE INDEX "SprintTestCase_testCaseId_idx" ON "SprintTestCase"("testCaseId");
CREATE INDEX "Document_sprintId_idx"     ON "Document"("sprintId");
CREATE INDEX "Requirement_sprintId_idx"  ON "Requirement"("sprintId");
CREATE INDEX "Run_sprintId_idx"          ON "Run"("sprintId");
CREATE INDEX "BlockedItem_sprintId_idx"  ON "BlockedItem"("sprintId");
CREATE INDEX "GovernancePR_sprintId_idx" ON "GovernancePR"("sprintId");
