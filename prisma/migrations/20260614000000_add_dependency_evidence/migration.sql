-- Enterprise Mode P5 — failed-prerequisite evidence inheritance on RunResult.
-- Additive ONLY (four nullable columns). Existing rows keep NULL → the current
-- generation/run behaviour is byte-identical; the columns populate only when the
-- P9 flag (requireDependencyOrder) enforces the dependency gate in the conductor.
-- Hand-authored + `migrate deploy` (NOT `migrate dev` — see [[prisma-migration-gotcha]]).
ALTER TABLE "RunResult" ADD COLUMN "blockedByTestCaseId" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "blockedByRunResultId" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "blockedByReason" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "dependencyPath" TEXT;
