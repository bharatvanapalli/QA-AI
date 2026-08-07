-- Enterprise Mode P6 — persist the mechanically-emitted ReplayIR pinned to each
-- RunResult. JSON envelope { ir, complete, gaps, emittedAt, emitterVersion }.
-- Additive ONLY (one nullable column). Existing rows keep NULL → current runs are
-- byte-identical; the column populates on future runs and emission never breaks a
-- run. Hand-authored + `migrate deploy` (NOT `migrate dev` — see [[prisma-migration-gotcha]]).
ALTER TABLE "RunResult" ADD COLUMN "replayIrJson" TEXT;
