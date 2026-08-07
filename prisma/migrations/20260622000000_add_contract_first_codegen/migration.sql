-- Contract-first codegen spine.
-- These fields are nullable so legacy ReplayIR-only runs remain readable.

ALTER TABLE "RunResult" ADD COLUMN "executionContractJson" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "actionGraphJson" TEXT;
