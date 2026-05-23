-- AlterTable
ALTER TABLE "RunResult" ADD COLUMN "domSnapshots" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "networkLog" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "rcaClass" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "rcaConfidence" INTEGER;
ALTER TABLE "RunResult" ADD COLUMN "rcaFix" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "rcaWhat" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "rcaWhy" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "ticketId" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "ticketUrl" TEXT;

-- CreateTable
CREATE TABLE "Discrepancy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Discrepancy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Document_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("content", "id", "mimeType", "name", "projectId", "sizeBytes", "uploadedAt") SELECT "content", "id", "mimeType", "name", "projectId", "sizeBytes", "uploadedAt" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE INDEX "Document_projectId_idx" ON "Document"("projectId");
CREATE TABLE "new_Requirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceIdentifier" TEXT,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "pulledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Requirement_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Requirement" ("content", "id", "projectId", "pulledAt", "sourceIdentifier", "sourceType", "title") SELECT "content", "id", "projectId", "pulledAt", "sourceIdentifier", "sourceType", "title" FROM "Requirement";
DROP TABLE "Requirement";
ALTER TABLE "new_Requirement" RENAME TO "Requirement";
CREATE INDEX "Requirement_projectId_idx" ON "Requirement"("projectId");
CREATE TABLE "new_TestScenario" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "dependencyOn" TEXT,
    "source" TEXT NOT NULL DEFAULT 'agent',
    "impacted" BOOLEAN NOT NULL DEFAULT false,
    "impactReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TestScenario_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TestScenario" ("category", "createdAt", "dependencyOn", "id", "module", "name", "priority", "projectId", "rationale", "source", "updatedAt") SELECT "category", "createdAt", "dependencyOn", "id", "module", "name", "priority", "projectId", "rationale", "source", "updatedAt" FROM "TestScenario";
DROP TABLE "TestScenario";
ALTER TABLE "new_TestScenario" RENAME TO "TestScenario";
CREATE INDEX "TestScenario_projectId_priority_idx" ON "TestScenario"("projectId", "priority");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Discrepancy_projectId_resolved_idx" ON "Discrepancy"("projectId", "resolved");
