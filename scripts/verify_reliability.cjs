'use strict';
/*
 * ONE command for the no-fake-pass reliability bundle: `npm run verify:reliability`.
 *
 * Runs every focused guard for the verdict/evidence honesty work and prints the
 * REAL guard + assertion totals, so any "N guards / M assertions" claim is backed
 * by a single reproducible command (reviewer round-3 #6). Exits non-zero if any
 * guard fails. A guard that SKIPs (e.g. the DB-dependent replay on a fresh DB) is
 * reported as skipped, not failed.
 *
 * NOTE: this bundle is the .cjs guard set. The Reports detector also has a vitest
 * unit test (tests/unit/verdictContradiction.test.js) that runs under `npm test`.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const SCRIPTS = __dirname;

const GUARDS = [
  'verify_verdict_no_fake_pass.cjs',
  'verify_prepersist_evidence_gate.cjs',
  'verify_runresult_writes_gated.cjs',
  'verify_data_row_intent.cjs',
  'verify_s2c1_replay.cjs',
  'verify_verdict_engine.cjs',
  'verify_negative_login_oracle.cjs',
  'verify_row_evidence_contract.cjs',
  'verify_evidence_registry.cjs',
  // root-cause hardening (assertion contract / evidence oracle / intent binding)
  'verify_assertion_contract_validation.cjs',
  'verify_row_evidence_verdict.cjs',
  'verify_binding_intent.cjs',
  'verify_data_row_ux.cjs',
  'verify_data_contract_hardening.cjs',
  'verify_trace_redaction.cjs',
  'verify_counter_separation.cjs',
  'verify_crawl_planner.cjs',
  'verify_crawl_planner_wired.cjs',
  'verify_live_crawl_planning.cjs',
  'verify_case_compiler.cjs',
  'verify_whole_project_operations.cjs',
  'verify_workbook_contract.cjs',
  'verify_story_id_bridge.cjs',
  'verify_story_binding.cjs',
  'verify_binding_persistence_path.cjs',
  'verify_oracle_contract.cjs',
  'verify_literal_leak_no_autobind.cjs',
  'verify_rtm_single_source.cjs',
  'verify_multi_source_binding.cjs',
  'verify_provisional_review.cjs',
  'verify_generation_compiler.cjs',
  'verify_verdict_defaults.cjs',
  'verify_credential_companion.cjs',
  'verify_execution_readiness.cjs',
  'verify_target_identity.cjs',
  'verify_deterministic_action_engine.cjs',
  'verify_deterministic_step_kernel.cjs',
  'verify_post_action_effect_proof.cjs',
  'verify_execution_hot_path.cjs',
  'verify_action_execution_gateway.cjs',
];

let failed = 0, skipped = 0, passedGuards = 0, totalAssertions = 0;
const rows = [];
for (const g of GUARDS) {
  const res = spawnSync(process.execPath, [path.join(SCRIPTS, g)], { encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  const asserts = (out.match(/^\s*PASS\s/gm) || []).length;
  const isSkip = /^SKIP —/m.test(out) && res.status === 0 && asserts === 0;
  const code = res.status;
  let mark;
  if (isSkip) { mark = 'SKIP'; skipped++; }
  else if (code === 0) { mark = 'OK  '; passedGuards++; totalAssertions += asserts; }
  else { mark = 'FAIL'; failed++; }
  rows.push({ g, mark, asserts, isSkip });
}

console.log('\n══ no-fake-pass reliability bundle ══');
for (const r of rows) {
  console.log(`  ${r.mark}  ${r.g.padEnd(40)} ${r.isSkip ? '(skipped — data not present)' : `${r.asserts} assertions`}`);
}
console.log('───────────────────────────────────────────────');
console.log(`  ${passedGuards} guard(s) green · ${skipped} skipped · ${failed} failed · ${totalAssertions} assertions total`);
console.log('───────────────────────────────────────────────');
if (failed) { console.log('RESULT: RED — a reliability guard failed.'); process.exit(1); }
console.log('RESULT: GREEN — every reliability guard passed (no un-evidenced pass can be produced or persisted).');
