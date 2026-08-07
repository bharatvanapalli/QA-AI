'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const VERIFY_TIMEOUT_MS = 30_000;
const VITEST_TIMEOUT_MS = 180_000;
const VITEST_BIN = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const verifiers = Object.freeze([
  'verify_static_conductor_runtime.cjs',
  'verify_action_execution_gateway.cjs',
  'verify_controller_atomic_cutover.cjs',
  'verify_browser_transaction_contract.cjs',
  'verify_browser_transaction_controller.cjs',
  'verify_browser_transaction_journal.cjs',
  'verify_browser_snapshot_lifecycle.cjs',
  'verify_controller_action_gateway.cjs',
  'verify_controller_composite_protocols.cjs',
  'verify_controller_composite_execution.cjs',
  'verify_controller_evidence_reader.cjs',
  'verify_controller_execution_scheduler.cjs',
  'verify_controller_failure_attribution.cjs',
  'verify_controller_mcp_runtime_adapter.cjs',
  'verify_controller_recovery_directives.cjs',
  'verify_controller_recovery_proposals.cjs',
  'verify_controller_resume_reconciliation.cjs',
  'verify_controller_semantic_resolver.cjs',
  'verify_controller_typed_adapters.cjs',
  'verify_controller_verdict_runtime.cjs',
  'verify_controller_chaos_matrix.cjs',
  'verify_controller_final_invariants.cjs',
]);

function fail(message, result = null) {
  if (result?.error?.code === 'ETIMEDOUT') {
    process.stderr.write(`${message}: timed out\n`);
  } else {
    process.stderr.write(`${message}${result?.status == null ? '' : `: exit ${result.status}`}\n`);
  }
  process.exitCode = 1;
  return false;
}

function runNode(label, args, timeout) {
  process.stdout.write(`\nGATE_START ${label} timeout=${timeout}ms\n`);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    timeout,
    windowsHide: true,
    killSignal: 'SIGTERM',
  });
  const durationMs = Date.now() - startedAt;
  if (result.error || result.status !== 0) {
    return fail(`GATE_FAIL ${label} duration=${durationMs}ms`, result);
  }
  process.stdout.write(`GATE_PASS ${label} duration=${durationMs}ms\n`);
  return true;
}

function main() {
  if (!fs.existsSync(VITEST_BIN)) {
    throw new Error(`Vitest executable is missing: ${VITEST_BIN}`);
  }
  for (const verifier of verifiers) {
    const absolute = path.join(ROOT, 'scripts', verifier);
    if (!fs.existsSync(absolute)) throw new Error(`Required verifier is missing: ${verifier}`);
    if (!runNode(verifier, [absolute], VERIFY_TIMEOUT_MS)) return;
  }
  runNode(
    'controller-unit-suite',
    [
      VITEST_BIN,
      'run',
      '--config',
      path.join(ROOT, 'vitest.controller.config.js'),
      '--reporter=verbose',
    ],
    VITEST_TIMEOUT_MS,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
