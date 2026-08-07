-- Enterprise Mode P3d — bound capability-operation plan per test case.
-- Additive only (ADD COLUMN nullable). Preserves all existing TestCase rows
-- (operationsJson NULL = no plan: legacy / whole-project / manual cases).
-- Apply with `prisma migrate deploy` at the next coordinated restart, alongside
-- 20260610000000_add_p3_atlas_slices. JSON shape:
--   { status: 'complete'|'incomplete', operations: [{operation, capabilityRef, params}],
--     dropped: [{operation, reason, detail}] }

ALTER TABLE "TestCase" ADD COLUMN "operationsJson" TEXT;
