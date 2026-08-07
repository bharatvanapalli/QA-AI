'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  CONTROLLER_STATE,
  RUN_TERMINATION_REASON,
  continuationForState,
} = require('../server/services/browserTransactionContract');
const {
  createTypedAdapterPlan,
} = require('../server/services/controllerTypedAdapterRegistry');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  passed += 1;
  process.stdout.write(`PASS ${message}\n`);
}

async function main() {
  const pin = read('server/services/agents/conductorPinned.js');
  const controller = read('server/services/browserTransactionController.js');
  const runtime = read('server/services/browserTransactionRuntime.js');
  const adapter = read('server/services/controllerMcpRuntimeAdapter.js');
  const snapshot = read('server/services/browserSnapshotLifecycle.js');
  const gateway = read('server/services/controllerActionExecutionGateway.js');
  const journal = read('server/services/browserTransactionEventJournal.js');
  const verdict = read('server/services/controllerVerdictProjector.js');
  const runner = read('scripts/run_controller_exit_gates.cjs');

  assert(!exists('server/services/agents/conductor.js'), 'legacy Conductor is not executable');
  assert(!exists('server/services/agents/conductorRuntimeLoader.js'), 'runtime transformation is impossible');
  assert(pin.includes("require('./controllerConductor')"), 'one production Conductor is pinned');
  assert(!Object.values(CONTROLLER_STATE).includes('BLOCKED'), 'controller state model has no BLOCKED state');
  assert(
    continuationForState(CONTROLLER_STATE.ASSERTION_FAILED).disposition === 'CONTINUE',
    'assertion failure continues execution',
  );
  assert(
    JSON.stringify(Object.values(RUN_TERMINATION_REASON).sort()) === JSON.stringify([
      'BROWSER_SESSION_LOST',
      'REQUIRED_MUTATION_PROVEN_UNDELIVERED',
      'USER_CANCELLED',
    ]),
    'run termination remains restricted to cancellation, session loss, or proven nondelivery',
  );
  assert(
    controller.includes('gateway.dispatch({')
      && !controller.includes('session.client.callTool('),
    'controller mutation crosses only the gateway',
  );
  assert(
    gateway.includes('The same action occurrence cannot be dispatched twice.'),
    'gateway prevents occurrence redispatch',
  );
  assert(
    adapter.includes("session.authorityMode !== 'browser_transaction_controller'")
      && adapter.includes('authorization?.authorized !== true'),
    'raw MCP transport requires controller mode and exact authorization',
  );
  assert(
    adapter.includes('evaluateOptionalCondition(')
      && adapter.includes('forceFresh: true'),
    'unknown optional conditions recapture observation before any action',
  );
  assert(
    !snapshot.includes('gateway.dispatch')
      && !snapshot.includes('session.client.callTool'),
    'snapshot lifecycle has no mutation path',
  );
  assert(
    !/\b(update|delete)\s*:\s*async/.test(journal),
    'transaction journal exposes no update or delete authority',
  );
  assert(
    verdict.includes('CONTROLLER_VERDICT_WRITE_ONCE_VIOLATION'),
    'verdict persistence is write-once',
  );
  assert(
    runtime.includes('continuationDisposition: decision.continuation?.disposition')
      && runtime.includes('proofRefs: Array.isArray(decision.proofRefs)'),
    'terminal heartbeats expose continuation and proof facts',
  );
  assert(
    runner.includes('VERIFY_TIMEOUT_MS = 30_000')
      && runner.includes('VITEST_TIMEOUT_MS = 180_000'),
    'verification and test execution are bounded',
  );

  const waitPlan = await createTypedAdapterPlan({
    operation: {
      operationId: 'wait:final-invariant',
      actionOccurrenceId: 'occurrence:wait:final-invariant:1',
      kind: 'synchronization',
      type: 'WaitForState',
      targetIdentity: { accessibleName: 'Email address' },
      value: 'Email address',
    },
    resolution: { target: null },
    context: {},
  });
  assert(waitPlan.mutation == null, 'WaitForState remains observation-only');

  process.stdout.write(`\n${passed}/${passed} final controller invariants passed.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
