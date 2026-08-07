'use strict';

/**
 * Pure run-counter math (audit #6 — honest summary metrics).
 *
 * FAILED counts ONLY confirmed product failures. The honesty states are kept
 * SEPARATE so a run summary never confuses internal uncertainty / bad data /
 * environment failure with a real website defect:
 *   - needs_human  → `needsHuman`  ("not judged" — QAAI could not verify)
 *   - test_data_invalid / no_execution → already status='blocked' (the `blocked`
 *     bucket), never folded into FAILED.
 *
 * This reverts the earlier fold (`failed = fail + needs_human`) that inflated the
 * product-failure metric with not-judged rows. Pure + deterministic (unit-tested
 * by verify_counter_separation.cjs).
 *
 * @param {Record<string, number>} byStatus  counts keyed by RunResult.status
 * @returns {{ passed, failed, blocked, skipped, needsHuman }}
 */
function computeRunCounters(byStatus = {}) {
  const b = byStatus || {};
  return {
    passed:     b.pass        || 0,
    failed:     b.fail        || 0,   // confirmed product failures ONLY
    blocked:    b.blocked     || 0,
    skipped:    b.skipped     || 0,
    needsHuman: b.needs_human || 0,   // "not judged" — never folded into failed
  };
}

module.exports = { computeRunCounters };
