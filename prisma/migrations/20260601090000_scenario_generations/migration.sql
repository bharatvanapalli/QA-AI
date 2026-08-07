-- Versioning: ScenarioGeneration + generationId on TestScenario / TestCase / Run.
-- Additive only (new table + nullable columns + indexes), then a one-time
-- backfill that groups every project's EXISTING scenarios/cases/runs into a
-- "Generation 1" so prior trial data stays visible as the current generation.

-- 1. New table -------------------------------------------------------------
CREATE TABLE "ScenarioGeneration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "scenarioCount" INTEGER NOT NULL DEFAULT 0,
    "caseCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScenarioGeneration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScenarioGeneration_projectId_version_key" ON "ScenarioGeneration"("projectId", "version");
CREATE INDEX "ScenarioGeneration_projectId_isCurrent_idx" ON "ScenarioGeneration"("projectId", "isCurrent");

-- 2. Nullable FK columns (no DB-level FK constraint — SQLite ADD COLUMN can't
--    add one; the relation is enforced at the Prisma client layer, and we
--    never delete a generation, so cascade/SetNull at the DB is moot) -------
ALTER TABLE "TestScenario" ADD COLUMN "generationId" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "generationId" TEXT;
ALTER TABLE "Run" ADD COLUMN "generationId" TEXT;
CREATE INDEX "TestScenario_generationId_idx" ON "TestScenario"("generationId");
CREATE INDEX "TestCase_generationId_idx" ON "TestCase"("generationId");
CREATE INDEX "Run_generationId_idx" ON "Run"("generationId");

-- 3. Backfill — one "Generation 1" per project that already has scenarios.
--    Deterministic id 'gen-' || projectId so the UPDATEs below can target it
--    without a generated UUID. CURRENT_TIMESTAMP matches Prisma's own
--    @default(now()) storage format for SQLite DateTime.
INSERT INTO "ScenarioGeneration" ("id", "projectId", "version", "label", "isCurrent", "scenarioCount", "caseCount", "createdAt")
SELECT 'gen-' || p."id", p."id", 1, 'Initial generation', true,
       (SELECT COUNT(*) FROM "TestScenario" s WHERE s."projectId" = p."id"),
       (SELECT COUNT(*) FROM "TestCase" t WHERE t."projectId" = p."id"),
       CURRENT_TIMESTAMP
FROM "Project" p
WHERE EXISTS (SELECT 1 FROM "TestScenario" s WHERE s."projectId" = p."id");

UPDATE "TestScenario"
   SET "generationId" = 'gen-' || "projectId"
 WHERE "generationId" IS NULL
   AND EXISTS (SELECT 1 FROM "ScenarioGeneration" g WHERE g."id" = 'gen-' || "TestScenario"."projectId");

UPDATE "TestCase"
   SET "generationId" = 'gen-' || "projectId"
 WHERE "generationId" IS NULL
   AND EXISTS (SELECT 1 FROM "ScenarioGeneration" g WHERE g."id" = 'gen-' || "TestCase"."projectId");

UPDATE "Run"
   SET "generationId" = 'gen-' || "projectId"
 WHERE "generationId" IS NULL
   AND EXISTS (SELECT 1 FROM "ScenarioGeneration" g WHERE g."id" = 'gen-' || "Run"."projectId");
