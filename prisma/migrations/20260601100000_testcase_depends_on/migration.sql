-- 20260601100000_testcase_depends_on
-- Case-level dependency graph. Architect emits prerequisite case names per
-- test case; the agents pipeline resolves names → IDs and writes a JSON
-- array of upstream TestCase ids into this column. runs.startRun reads it
-- to topo-sort the input testCaseIds and auto-include missing prerequisites
-- so a "Rerun" on a stateful flow (Login → Checkout) actually rebuilds the
-- prior state instead of starting cold.
--
-- Nullable — legacy rows have no dependencies, which is what we want.
ALTER TABLE "TestCase" ADD COLUMN "dependsOnIds" TEXT;
