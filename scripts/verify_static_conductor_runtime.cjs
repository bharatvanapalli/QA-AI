'use strict';

const crypto = require('crypto');
const fs = require('fs');
const Module = require('module');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_RUNTIME_PATH = path.join(ROOT, 'server', 'services', 'agents', 'conductor.js');
const FROZEN_CONDUCTOR_PATH = path.join(ROOT, '.qaai-migration', 'runtime-freeze', 'conductor.materialized.candidate.js');
const CONTROLLER_CONDUCTOR_PATH = path.join(ROOT, 'server', 'services', 'agents', 'controllerConductor.js');
const PINNED_PATH = path.join(ROOT, 'server', 'services', 'agents', 'conductorPinned.js');
const LOADER_PATH = path.join(ROOT, 'server', 'services', 'agents', 'conductorRuntimeLoader.js');
const MANIFEST_PATH = path.join(ROOT, '.qaai-migration', 'runtime-freeze', 'manifest.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').toUpperCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  process.stdout.write(`PASS ${message}\n`);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const conductor = fs.readFileSync(FROZEN_CONDUCTOR_PATH, 'utf8');
  const controllerConductor = fs.readFileSync(CONTROLLER_CONDUCTOR_PATH, 'utf8');
  const pinned = fs.readFileSync(PINNED_PATH, 'utf8');

  assert(
    !fs.existsSync(LEGACY_RUNTIME_PATH),
    'retired legacy Conductor is absent from the production runtime tree',
  );
  assert(
    sha256(conductor) === manifest.materialized.sha256,
    'reviewed Conductor matches frozen materialized SHA-256',
  );
  assert(
    Buffer.byteLength(conductor) === manifest.materialized.bytes,
    'reviewed Conductor matches frozen materialized byte length',
  );
  assert(
    pinned.includes("require('./controllerConductor')")
      && !pinned.includes("require('./conductor')")
      && !pinned.includes('conductorRuntimeLoader')
      && !pinned.includes('loadConductorRuntime'),
    'pinned entry imports only the reviewed controller Conductor',
  );
  assert(
    !fs.existsSync(LOADER_PATH),
    'server-side runtime source transformer is absent',
  );
  new vm.Script(Module.wrap(conductor), {
    filename: FROZEN_CONDUCTOR_PATH,
    displayErrors: true,
  });
  assert(true, 'frozen legacy Conductor is syntax-valid CommonJS');
  new vm.Script(Module.wrap(controllerConductor), {
    filename: CONTROLLER_CONDUCTOR_PATH,
    displayErrors: true,
  });
  assert(true, 'reviewed controller Conductor is syntax-valid CommonJS');
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
