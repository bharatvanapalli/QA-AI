-- Planned site-mapper redesign: crawl-quality columns on the atlas.
-- All additive + nullable → safe on a live DB, legacy rows unaffected, and a
-- pre-regen Prisma client keeps working via the graceful try/catch write ladder.

-- Calibration: crawl mode, coverage report, and the explicit sufficiency verdict.
ALTER TABLE "Calibration" ADD COLUMN "crawlMode" TEXT;
ALTER TABLE "Calibration" ADD COLUMN "coverageReportJson" TEXT;
ALTER TABLE "Calibration" ADD COLUMN "sufficiency" TEXT;

-- CalibrationPage: composite UI-state key (content-level dedup) + tab/panel substates.
ALTER TABLE "CalibrationPage" ADD COLUMN "stateKey" TEXT;
ALTER TABLE "CalibrationPage" ADD COLUMN "substatesJson" TEXT;
