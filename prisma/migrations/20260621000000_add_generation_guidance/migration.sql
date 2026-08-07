-- Enterprise guidance workflow.
-- Stores user-directed generation/refinement instructions as first-class
-- traceable records instead of transient chat text.

CREATE TABLE "GenerationGuidance" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sprintId" TEXT,
  "generationId" TEXT,
  "scenarioId" TEXT,
  "testCaseId" TEXT,
  "scope" TEXT NOT NULL,
  "sourceSurface" TEXT,
  "instruction" TEXT NOT NULL,
  "quickIntentsJson" TEXT,
  "normalizedDirectives" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "appliedGenerationId" TEXT,
  "appliedScenarioId" TEXT,
  "appliedTestCaseId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" DATETIME,
  CONSTRAINT "GenerationGuidance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "GenerationGuidance_projectId_scope_status_idx"
  ON "GenerationGuidance"("projectId", "scope", "status");

CREATE INDEX "GenerationGuidance_projectId_generationId_idx"
  ON "GenerationGuidance"("projectId", "generationId");

CREATE INDEX "GenerationGuidance_scenarioId_idx"
  ON "GenerationGuidance"("scenarioId");

CREATE INDEX "GenerationGuidance_testCaseId_idx"
  ON "GenerationGuidance"("testCaseId");
