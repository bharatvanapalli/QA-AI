-- TestData Round B — data-driven (matrix) execution.
-- Additive only: all new columns are nullable, so existing TestCase / RunResult
-- rows (the preserved trial-run history) are untouched. Hand-authored + applied
-- via `prisma migrate deploy` because `migrate dev`'s shadow-DB replay is broken
-- on this checkout (see memory: prisma-migration-gotcha).

-- TestCase: per-case data-driven binding (null = ordinary case).
ALTER TABLE "TestCase" ADD COLUMN "dataBindingJson" TEXT;

-- RunResult: per-row tagging for fan-out executions (all null = non-data case).
ALTER TABLE "RunResult" ADD COLUMN "dataRowIndex" INTEGER;
ALTER TABLE "RunResult" ADD COLUMN "dataRowLabel" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "dataSetName" TEXT;

-- Fetch every fan-out row of one case within a run efficiently.
CREATE INDEX "RunResult_runId_testCaseId_idx" ON "RunResult"("runId", "testCaseId");
