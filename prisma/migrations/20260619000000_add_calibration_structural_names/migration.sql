-- Add ARIA-landmark accessible-name capture to CalibrationPage.
-- Nullable + additive → preserves all existing calibration/trial data.
-- Holds a JSON string[] of landmark names (navigation/region/banner/...) so the
-- structural-label grounding gate can demote zero-diagnostic-value assertions
-- (e.g. expectedText "Topbar Menu") generically, keyed off ARIA role.
ALTER TABLE "CalibrationPage" ADD COLUMN "structuralNamesJson" TEXT;
