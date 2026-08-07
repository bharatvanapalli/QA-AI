-- Add deterministic pre-Architect coverage planner evidence to generation history.
ALTER TABLE "ScenarioGeneration" ADD COLUMN "coveragePlanJson" TEXT;
ALTER TABLE "ScenarioGeneration" ADD COLUMN "coverageValidationJson" TEXT;
ALTER TABLE "ScenarioGeneration" ADD COLUMN "coverageRepairJson" TEXT;
