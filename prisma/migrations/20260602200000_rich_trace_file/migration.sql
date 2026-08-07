-- 20260602200000_rich_trace_file
-- Phase H Stage 0.5 — Rich per-turn telemetry capture pointer.
--
-- richTraceFile: absolute path on the QAAI server to a gzipped JSON file
-- containing the full uncapped turn-by-turn record (snapshots, tokens,
-- elapsed-ms, assistant text, stability iteration counts) that Stage 2's
-- replay harness will consume. Nullable so legacy rows + early-Phase-H
-- runs without telemetry remain valid; the conductor populates this only
-- after the case completes.
--
-- File path lives in the DB, file lives on disk — same pattern as Download.
-- Cleanup is handled by the trace cleanup service when the parent Run is
-- deleted.

ALTER TABLE "RunResult" ADD COLUMN "richTraceFile" TEXT;
