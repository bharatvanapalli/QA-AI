-- Phase E4 — vision-based screenshot diff with semantic reasoning.
-- Additive only. All new columns are nullable so existing RunResult rows
-- stay valid and the visual pipeline opts in case-by-case.

ALTER TABLE "RunResult" ADD COLUMN "baselineScreenshot" TEXT;
ALTER TABLE "RunResult" ADD COLUMN "visualVerdict"      TEXT;
ALTER TABLE "RunResult" ADD COLUMN "visualDiffSummary"  TEXT;
ALTER TABLE "RunResult" ADD COLUMN "visualDiffs"        TEXT;
