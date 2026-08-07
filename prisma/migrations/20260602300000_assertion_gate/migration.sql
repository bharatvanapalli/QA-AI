-- 20260602300000_assertion_gate
-- Phase H Stage 1.5 — soft-fail assertion-gate observation columns.
--
-- The gate fires when status='pass' is claimed but the agent didn't call
-- assertion_check enough to back the claim. In SOFT-FAIL mode (the rollout
-- mode this migration enables) the gate ONLY records its decision; it
-- does NOT change the result's status. These columns are what the flip-
-- to-hard-reject decision rests on, because WS log entries evaporate
-- with subscribers and we need queryable data over time.
--
--   assertionGateWouldReject — case-level boolean: would the case-level
--                              hard-reject have fired? (status='pass' +
--                              zero assertion_check calls + ≥1 declared)
--   assertionGateReason      — human-readable per-assertion breakdown.
--                              Captured even when wouldReject=false so
--                              we can compute the per-assertion rate too
--                              and decide flip granularity from data.
--
-- Both additive + defaulted/nullable. Legacy rows survive untouched.

ALTER TABLE "RunResult" ADD COLUMN "assertionGateWouldReject" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "RunResult" ADD COLUMN "assertionGateReason" TEXT;
