'use strict';

/**
 * Regression coverage for negative-login ReplayIR export repair.
 *
 * Run with:
 *   node server/services/__tests__/replayExportCredentialRepair.test.js
 */

const assert = require('assert');
const { _compileJourneyGroup } = require('../codegen/replayExport');

function baseCtx(group) {
  return {
    adapter: {
      emitJourneySpec(cases) {
        return JSON.stringify(cases.map((c) => c.ir.steps), null, 2);
      },
      runCmd() { return 'npx playwright test'; },
    },
    adapterId: 'playwright-pom-js',
    adapterVersion: 'test',
    isJs: true,
    group,
    admitted: [],
    blocked: [],
    manifestEntries: [],
    findings: [],
    usedPaths: new Set(),
    loginPrecondition: null,
    scenariosWithOwnLogin: new Set(),
    logoutUrl: null,
    logoutActionSteps: [],
  };
}

function credentialSteps(pairs) {
  const steps = [];
  let idx = 0;
  for (const pair of pairs) {
    steps.push({ op: 'act', action: 'fill', valueRef: 'env:QAAI_USERNAME', target: `user${idx}` });
    steps.push({ op: 'act', action: 'fill', valueRef: 'env:QAAI_PASSWORD', target: `pass${idx}` });
    steps.push({ op: 'act', action: 'click', target: `login${idx}` });
    idx += 1;
  }
  steps.push({ op: 'assert', channel: 'UI_TEXT', expected: 'Username' });
  return steps;
}

function item({ name, steps, declaredSteps }) {
  return {
    r: {
      envelope: { ir: { title: name, steps } },
      caseName: name,
      status: 'pass',
      runResultId: `rr-${name}`,
      testCaseId: `tc-${name}`,
      moduleName: 'Authentication',
      declaredSteps,
    },
  };
}

function declaredFill(target, value, expected) {
  return { action: 'Fill', target, element: target, value, expected };
}

function compile(items) {
  const ctx = baseCtx({ scenarioId: 'scenario-credential-repair', scenarioName: 'Invalid credentials handling', items });
  _compileJourneyGroup(ctx);
  return ctx;
}

{
  const ctx = compile([item({
    name: 'Login with invalid username and valid password shows Invalid credentials',
    steps: credentialSteps([{}]),
    declaredSteps: [
      declaredFill('Username textbox', 'invalid_user_xyz', 'Invalid username entered'),
      declaredFill('Password textbox', 'admin123', 'Valid password entered'),
    ],
  })]);
  assert.strictEqual(ctx.blocked.length, 0, 'invalid username case must not be blocked');
  const exported = JSON.parse(ctx.admitted[0].content)[0];
  assert.strictEqual(exported[0].rawValue, 'invalid_user_xyz');
  assert.strictEqual(exported[0].valueRef, undefined);
  assert.strictEqual(exported[1].valueRef, 'env:QAAI_PASSWORD');
  assert.strictEqual(exported[1].rawValue, undefined);
}

{
  const ctx = compile([item({
    name: 'Login with valid username and wrong password shows Invalid credentials',
    steps: credentialSteps([{}]),
    declaredSteps: [
      declaredFill('Username textbox', 'Admin', 'Valid username entered'),
      declaredFill('Password textbox', 'wrongpassword999', 'Wrong password entered'),
    ],
  })]);
  assert.strictEqual(ctx.blocked.length, 0, 'wrong password case must not be blocked');
  const exported = JSON.parse(ctx.admitted[0].content)[0];
  assert.strictEqual(exported[0].valueRef, 'env:QAAI_USERNAME');
  assert.strictEqual(exported[0].rawValue, undefined);
  assert.strictEqual(exported[1].rawValue, 'wrongpassword999');
  assert.strictEqual(exported[1].valueRef, undefined);
}

{
  const ctx = compile([item({
    name: 'Multiple failed login attempts do not crash application',
    steps: credentialSteps([{}, {}, {}]),
    declaredSteps: [
      declaredFill('Username textbox', 'bad_user_1', 'Username entered'),
      declaredFill('Password textbox', 'wrongpass', 'Password entered'),
      declaredFill('Username textbox', 'bad_user_2', 'Username re-entered'),
      declaredFill('Password textbox', 'wrongpass', 'Password re-entered'),
      declaredFill('Username textbox', 'bad_user_3', 'Username re-entered'),
      declaredFill('Password textbox', 'wrongpass', 'Password re-entered'),
    ],
  })]);
  assert.strictEqual(ctx.blocked.length, 0, 'repeated failed login case must not be blocked');
  const exported = JSON.parse(ctx.admitted[0].content)[0];
  const rawValues = exported.filter((s) => s.action === 'fill').map((s) => s.rawValue);
  assert.deepStrictEqual(rawValues, ['bad_user_1', 'wrongpass', 'bad_user_2', 'wrongpass', 'bad_user_3', 'wrongpass']);
}

console.log('replayExportCredentialRepair.test.js: PASS');
