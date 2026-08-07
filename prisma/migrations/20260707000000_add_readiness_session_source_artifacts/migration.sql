-- Scenario/Test Case Generation Completion Plan:
-- readiness/session/data/export contracts and project-scoped source artifacts.

ALTER TABLE "TestCase" ADD COLUMN "readinessStatus" TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE "TestCase" ADD COLUMN "readinessReasonsJson" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "readinessContractVersion" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "readinessComputedAt" DATETIME;
ALTER TABLE "TestCase" ADD COLUMN "approvalEligibility" TEXT NOT NULL DEFAULT 'eligible';
ALTER TABLE "TestCase" ADD COLUMN "runEligibility" TEXT NOT NULL DEFAULT 'blocked';
ALTER TABLE "TestCase" ADD COLUMN "sessionMode" TEXT NOT NULL DEFAULT 'fresh';
ALTER TABLE "TestCase" ADD COLUMN "producesStateJson" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "requiresStateJson" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "failurePolicy" TEXT NOT NULL DEFAULT 'continue_independent';
ALTER TABLE "TestCase" ADD COLUMN "rowExecutionPlanJson" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "rowCoverageStatus" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "skippedRowsJson" TEXT;

CREATE INDEX "TestCase_projectId_readinessStatus_idx" ON "TestCase"("projectId", "readinessStatus");
CREATE INDEX "TestCase_projectId_runEligibility_idx" ON "TestCase"("projectId", "runEligibility");

CREATE TABLE "SourceArtifact" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "sprintId" TEXT,
  "generationId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'firecrawl',
  "sourceArtifactVersion" TEXT NOT NULL DEFAULT 'source_artifact_v1',
  "sourceUrl" TEXT,
  "title" TEXT,
  "content" TEXT,
  "artifactJson" TEXT,
  "requirementClausesJson" TEXT,
  "businessRulesJson" TEXT,
  "acceptanceCriteriaJson" TEXT,
  "pageHintsJson" TEXT,
  "fieldHintsJson" TEXT,
  "oracleHintsJson" TEXT,
  "capabilitySeedsJson" TEXT,
  "confidence" TEXT NOT NULL DEFAULT 'discovered',
  "verifiedByPlaywright" BOOLEAN NOT NULL DEFAULT false,
  "crawlDepth" INTEGER,
  "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" DATETIME,
  "staleAt" DATETIME,
  "robotsPolicy" TEXT,
  "tenantAllowed" BOOLEAN NOT NULL DEFAULT false,
  "contentHash" TEXT,
  "hash" TEXT,
  "freshness" TEXT NOT NULL DEFAULT 'unknown',
  "redactionJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "SourceArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SourceArtifact_projectId_idx" ON "SourceArtifact"("projectId");
CREATE INDEX "SourceArtifact_projectId_generationId_idx" ON "SourceArtifact"("projectId", "generationId");
CREATE INDEX "SourceArtifact_source_freshness_idx" ON "SourceArtifact"("source", "freshness");
