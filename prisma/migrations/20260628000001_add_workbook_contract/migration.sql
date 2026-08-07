-- Step 3A — persist the canonical WorkbookContract with the uploaded test-data
-- record. Additive + nullable → safe on a live DB; legacy rows + a pre-regen
-- client keep working via the graceful try/catch write ladder.
ALTER TABLE "TestDataSet" ADD COLUMN "workbookContractJson" TEXT;
