-- Split Run.skipped into distinct `blocked` + `skipped` columns.
-- `blocked` = environmental/browser failures (agent tried, couldn't reach the
--             assertion). `skipped` = test.skip() / --grep deselection
--             (engineer intentionally excluded). Conflating them previously
--             let release recommendations read "blocked before assertions"
--             when the engineer actually meant to skip those cases.
ALTER TABLE "Run" ADD COLUMN "blocked" INTEGER NOT NULL DEFAULT 0;

-- Historical rows that previously stored "blocked" inside "skipped" are
-- ambiguous (we can't tell from the schema alone). Migrate them defensively:
-- assume legacy `skipped` was really `blocked` (the prior code only ever
-- produced 'blocked' for non-pass results — never 'skipped'). Engineers
-- who run --grep on real test.skip() can re-record the run after this.
UPDATE "Run" SET "blocked" = "skipped", "skipped" = 0;

-- Per-project uniqueness on GovernancePR.number so two projects can't both
-- mint "#101" (the old global counter would collide). Existing data may
-- contain collisions; if so this migration will fail and the user should
-- run a one-off renumbering script — flagged here intentionally so the
-- failure is loud instead of silent.
CREATE UNIQUE INDEX "GovernancePR_projectId_number_key" ON "GovernancePR"("projectId", "number");
