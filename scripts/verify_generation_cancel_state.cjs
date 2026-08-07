#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const scenarios = read('server', 'routes', 'scenarios.js');
const agents = read('server', 'routes', 'agents.js');
const calibrator = read('server', 'services', 'agents', 'calibrator.js');
const runSuite = read('src', 'pages', 'RunSuite.jsx');
const runStream = read('src', 'store', 'runStream.jsx');

let pass = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  pass += 1;
  console.log(`OK ${message}`);
}

const earlyCreate = scenarios.indexOf('cancelToken = cancelRegistry.create(req.user.id);');
const calibratorCall = scenarios.indexOf('await runCalibrator({');
const architectRun = scenarios.indexOf('result = await architect.run({');
ok(earlyCreate >= 0, 'generation route creates a cancel token');
ok(calibratorCall >= 0 && earlyCreate < calibratorCall, 'generation cancel token exists before Site Atlas refresh');
ok(architectRun >= 0 && earlyCreate < architectRun, 'generation cancel token exists before Architect LLM run');
ok(scenarios.slice(calibratorCall, calibratorCall + 700).includes('signal: cancelToken.signal'), 'generation route passes cancel signal into runCalibrator');
ok(scenarios.includes('const finishCancelled = () =>') && scenarios.includes("code: 'CANCELLED'"), 'generation route has explicit cancelled response path');
ok(scenarios.includes('if (cancelToken) cancelRegistry.clear(req.user.id);'), 'generation route clears cancel token on outer errors');

ok(calibrator.includes('function throwIfAborted(signal)'), 'calibrator has a shared abort guard');
ok(calibrator.includes('function cancellableDelay(ms, signal)'), 'calibrator waits are abortable');
ok(calibrator.includes('attemptFormLogin(mcpSession, cred, startUrl, log, signal)'), 'calibrator form-login receives the abort signal');
ok(calibrator.includes('await attemptFormLogin(mcpSession, cred, startUrl, log, signal)'), 'runCalibrator passes signal into form-login');
ok(calibrator.includes('if (pageErr?.code === \'CANCELLED\' || signal?.aborted) throw pageErr;'), 'page-level crawl fallback does not swallow cancellation');
ok(calibrator.includes('await cancellableDelay(attempt === 0 ? 800 : 1200, signal);'), 'snapshot settle polling is cancellable');

ok(agents.includes("send({ type: 'run.cancelling', projectId: project.id });"), 'cancel route broadcasts run.cancelling');
ok(agents.includes("phase: 'architect', error: 'cancelled', cancelled: true"), 'cancel route broadcasts Architect cancelled when no Run row exists');

ok(runSuite.includes('function normalizeArchitectStatus(rawStatus, cancelling = false)'), 'Run Suite normalizes global Architect status');
ok(runSuite.includes("} else if (msg.type === 'run.cancelling')"), 'Run Suite handles run.cancelling acknowledgement');
ok(runSuite.includes("setPhaseStatus('cancelling');"), 'Terminate click immediately enters cancelling state');
ok(runSuite.includes("const generationBusy = phaseStatus === 'running' || phaseStatus === 'cancelling';"), 'Run Suite blocks duplicate generation while stopping');
ok(runSuite.includes('const isLive = isLiveArchitectStatus(status);'), 'Run Suite keeps live theatre visible during cancelling');
ok(runSuite.includes("cancelling: { word: 'Stopping...'"), 'Live theatre has a cancelling status face');
ok(runStream.includes("cancelling: msg.phase === 'architect' ? false : state.cancelling"), 'global store clears stale generation cancelling state on Architect start/complete');

console.log(`PASS verify_generation_cancel_state (${pass} checks)`);
