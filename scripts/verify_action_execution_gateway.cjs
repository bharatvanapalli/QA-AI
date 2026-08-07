'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
const exists = (relativePath) => fs.existsSync(path.join(ROOT, relativePath));

let assertions = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
  assertions += 1;
  process.stdout.write(`PASS ${message}\n`);
}

function occurrences(source, pattern) {
  return (source.match(pattern) || []).length;
}

function main() {
  const pin = read('server/services/agents/conductorPinned.js');
  const controller = read('server/services/browserTransactionController.js');
  const conductor = read('server/services/agents/controllerConductor.js');
  const sharedRunner = read('server/services/agents/conductorRunner.js');
  const routeRunner = read('server/routes/agents.js');
  const gateway = read('server/services/controllerActionExecutionGateway.js');
  const transport = read('server/services/controllerMcpRuntimeAdapter.js');

  assert(!exists('server/services/agents/conductor.js'), 'retired Conductor cannot be imported from the production tree');
  assert(!exists('server/services/agents/conductorRuntimeLoader.js'), 'runtime source transformation is absent');
  assert(
    pin.includes("require('./controllerConductor')")
      && !pin.includes("require('./conductor')"),
    'the production pin exposes only controllerConductor',
  );
  assert(
    occurrences(sharedRunner, /return runControllerConductorOnce\(\{/g) === 1,
    'the shared runner enters the controller exactly once',
  );
  assert(
    occurrences(routeRunner, /return runControllerConductorOnce\(\{/g) === 1,
    'the route runner enters the controller exactly once',
  );
  assert(
    !/\b(?:critic|supervisor)\.(?:run|review)\s*\(/i.test(sharedRunner)
      && !/\b(?:critic|supervisor)\.(?:run|review)\s*\(/i.test(routeRunner),
    'Critic and Supervisor have no execution or retry call in either active runner',
  );
  assert(
    conductor.includes("authorityMode: 'browser_transaction_controller'"),
    'the controller opens MCP sessions in controller-authority mode',
  );
  assert(
    controller.includes('gateway.dispatch({')
      && !controller.includes('session.client.callTool('),
    'the controller mutates only through the gateway fact boundary',
  );
  assert(
    gateway.includes('TRANSPORT_PERMIT_VERSION')
      && gateway.includes('state.consumed')
      && gateway.includes('The same action occurrence cannot be dispatched twice.'),
    'the gateway enforces a matching single-use permit and exactly-once occurrence',
  );
  assert(
    transport.includes("session.authorityMode !== 'browser_transaction_controller'")
      && transport.includes('authorization?.authorized !== true')
      && transport.includes('authorization.toolName !== toolName')
      && transport.includes('session.client.callTool('),
    'the sole raw MCP transport accepts only the gateway exact authorization',
  );
  assert(
    !sharedRunner.includes('applyAgentCaseRevision')
      && !routeRunner.includes('shouldRunPostMortemCritic'),
    'legacy agent revision and post-mortem retry authorities are absent',
  );

  process.stdout.write(`\n${assertions}/${assertions} controller authority checks passed.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
