-- Bug B (Test Cases dead step indicators): add a per-step verdict column
-- to RunResult so the expanded view can render pass / fail / blocked icons
-- against each declared step instead of the static list it had before.
--
-- JSON-encoded array of { index: int, status: pass|fail|blocked|skipped|pending, error?: string }.
-- Nullable so legacy rows (before this column existed) survive untouched —
-- they render with no per-step badges and that's the correct fallback.
ALTER TABLE "RunResult" ADD COLUMN "stepResults" TEXT;
