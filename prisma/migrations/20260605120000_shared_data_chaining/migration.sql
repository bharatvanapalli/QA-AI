-- Cross-case data chaining sprint Day 1 — additive only (SQLite-safe).
--
-- Three columns join the schema:
--   Run.sharedData          — JSON object, accumulated across the run as cases
--                             extract values via the browser_extract_data tool.
--                             Values are primitive (string/number/boolean).
--                             Read by downstream cases that declare requiresData.
--
--   TestCase.producesData   — JSON array of key names this case extracts.
--                             Declared by the architect; honoured by the
--                             conductor when it sees a step with
--                             action='ExtractData' or via the equivalent
--                             tool call.
--
--   TestCase.requiresData   — JSON array of key names this case CONSUMES
--                             from upstream cases. P0-17 architect output
--                             validator rejects any key whose corresponding
--                             producer doesn't exist in the dependency chain.
--                             At runtime, the conductor filters Run.sharedData
--                             by this array and injects only the requested
--                             subset into the per-case USER message (NOT the
--                             system prompt — preserves prompt cache across
--                             cases).
--
-- All three nullable. Existing TestCase / Run rows continue to work with
-- NULL values (the conductor's case-start hook treats NULL as
-- "no requirements / no production" and skips the data-chaining branch).
ALTER TABLE "Run"      ADD COLUMN "sharedData"    TEXT;
ALTER TABLE "TestCase" ADD COLUMN "producesData"  TEXT;
ALTER TABLE "TestCase" ADD COLUMN "requiresData"  TEXT;
