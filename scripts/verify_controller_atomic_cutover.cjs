'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

function main() {
  const pinned = read('server/services/agents/conductorPinned.js');
  const sharedRunner = read('server/services/agents/conductorRunner.js');
  const routeRunner = read('server/routes/agents.js');
  const adapter = read('server/services/controllerMcpRuntimeAdapter.js');
  const controller = require('../server/services/agents/conductorPinned');

  assert(
    pinned.includes("require('./controllerConductor')")
      && !pinned.includes("require('./conductor')"),
    'production pin exposes only controllerConductor',
  );
  for (const [label, source] of [
    ['shared runner', sharedRunner],
    ['route runner', routeRunner],
  ]) {
    assert(
      (source.match(/return runControllerConductorOnce\(\{/g) || []).length === 1
        && !/\b(?:critic|supervisor)\.(?:run|review)\s*\(/i.test(source),
      `${label} enters the controller once and has no whole-case recovery authority`,
    );
  }
  assert(
    adapter.includes("authorization?.authorized !== true")
      && adapter.includes('session.client.callTool('),
    'raw MCP mutation transport requires gateway authorization',
  );
  assert(
    typeof controller.run === 'function'
      && controller.CONTROLLER_CONDUCTOR_VERSION === 'qaai-controller-conductor-v1',
    'pinned module exports the controller runtime contract',
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
