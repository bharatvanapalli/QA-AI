-- QAAI 2.0 Phase 1: persist scenario-quality contracts on generated cases.
ALTER TABLE "TestCase" ADD COLUMN "qualityContractJson" TEXT;
