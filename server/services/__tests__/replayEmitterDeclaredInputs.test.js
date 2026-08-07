'use strict';

/**
 * Regression coverage for ReplayIR preserving declared negative inputs during
 * capture, before the exporter has to repair anything.
 *
 * Run with:
 *   node server/services/__tests__/replayEmitterDeclaredInputs.test.js
 */

const assert = require('assert');
const emitter = require('../codegen/replayEmitter');

function verifiedLocator(label, index = 0) {
  const expression = `getByPlaceholder(${JSON.stringify(label)})`;
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: 'verified_mcp_accessibility_snapshot',
    evidenceSource: 'verified_mcp_accessibility_snapshot',
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: 'placeholder',
    toolName: 'browser_fill_form',
    elementLabel: label,
    targetFacts: { role: 'textbox', accessibleName: label, placeholder: label },
    proof: { count: 1, sameElement: true, source: 'verified_mcp_accessibility_snapshot', verified: true },
    domAtlas: { verifiedActions: [{ toolName: 'browser_fill_form', elementLabel: label, expression }] },
    context: { source: 'verified_mcp_accessibility_snapshot', ref: `e${index + 1}` },
  };
}

function formLocator(labels) {
  return {
    kind: 'multi',
    toolName: 'browser_fill_form',
    fields: labels.map((label, index) => ({
      index,
      ref: `e${index + 1}`,
      name: label,
      actionLocator: verifiedLocator(label, index),
    })),
  };
}

{
  const result = emitter.buildReplayIR({
    caseId: 'TC-declared-negative',
    title: 'Login with valid username and wrong password shows Invalid credentials',
    trail: [{
      tool: 'browser_fill_form',
      ok: true,
      args: {
        fields: [
          { name: 'Username', type: 'textbox', value: 'Admin' },
          { name: 'Password', type: 'textbox', value: 'wrongpassword999' },
        ],
      },
      actionLocator: formLocator(['Username', 'Password']),
    }],
    declaredSteps: [
      { action: 'Fill', target: 'Username textbox', value: 'Admin', expected: 'Valid username entered' },
      { action: 'Fill', target: 'Password textbox', value: 'wrongpassword999', expected: 'Wrong password entered' },
    ],
    credentialValues: null,
    declaredAssertions: [],
    assertionOutcomes: [],
    verdictStatus: 'pass',
  });
  const fills = result.ir.steps.filter((s) => s.op === 'act' && s.action === 'fill');
  assert.strictEqual(fills.length, 2);
  assert.strictEqual(fills[0].valueRef, 'env:QAAI_USERNAME');
  assert.strictEqual(fills[0].rawValue, undefined);
  assert.strictEqual(fills[1].rawValue, 'wrongpassword999');
  assert.strictEqual(fills[1].valueRef, undefined);
  assert.strictEqual(result.complete, true);
}

{
  const result = emitter.buildReplayIR({
    caseId: 'TC-declared-repeated',
    title: 'Multiple failed login attempts do not crash application',
    trail: [
      {
        tool: 'browser_fill_form',
        ok: true,
        args: {
          fields: [
            { name: 'Username', type: 'textbox', value: 'bad_user_1' },
            { name: 'Password', type: 'textbox', value: 'wrongpass' },
          ],
        },
        actionLocator: formLocator(['Username', 'Password']),
      },
      {
        tool: 'browser_fill_form',
        ok: true,
        args: {
          fields: [
            { name: 'Username', type: 'textbox', value: 'bad_user_2' },
            { name: 'Password', type: 'textbox', value: 'wrongpass' },
          ],
        },
        actionLocator: formLocator(['Username', 'Password']),
      },
    ],
    declaredSteps: [
      { action: 'Fill', target: 'Username textbox', value: 'bad_user_1', expected: 'Username entered' },
      { action: 'Fill', target: 'Password textbox', value: 'wrongpass', expected: 'Password entered' },
      { action: 'Fill', target: 'Username textbox', value: 'bad_user_2', expected: 'Username re-entered' },
      { action: 'Fill', target: 'Password textbox', value: 'wrongpass', expected: 'Password re-entered' },
    ],
    credentialValues: null,
    declaredAssertions: [],
    assertionOutcomes: [],
    verdictStatus: 'pass',
  });
  const rawValues = result.ir.steps
    .filter((s) => s.op === 'act' && s.action === 'fill')
    .map((s) => s.rawValue);
  assert.deepStrictEqual(rawValues, ['bad_user_1', 'wrongpass', 'bad_user_2', 'wrongpass']);
}

console.log('replayEmitterDeclaredInputs.test.js: PASS');
