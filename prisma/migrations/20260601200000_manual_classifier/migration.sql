-- 20260601200000_manual_classifier
-- Manual vs Automation classifier (Phase D).
--   automatability       — 'automatable' (default) | 'manual'
--   automatabilityReason — ≤120 char human-readable reason the Architect
--                          marked a case manual (e.g. "Real email channel")
--   manualGuide          — lazy-generated step-by-step tester instructions,
--                          cached after first expansion on the Manual tab
--   manualCompletedAt    — timestamp when the tester ticks "Mark complete";
--                          unblocks downstream cases that depend on this one
--
-- All additive + nullable (manualGuide / manualCompletedAt) or defaulted
-- (automatability). Legacy rows remain valid; cumulative-growth is preserved.
ALTER TABLE "TestCase" ADD COLUMN "automatability" TEXT NOT NULL DEFAULT 'automatable';
ALTER TABLE "TestCase" ADD COLUMN "automatabilityReason" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "manualGuide" TEXT;
ALTER TABLE "TestCase" ADD COLUMN "manualCompletedAt" DATETIME;
