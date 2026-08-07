'use strict';

const assert = require('assert');
const { normaliseStepShape, normaliseSteps, serialiseStepsForPrompt } = require('../stepShape');

{
  const step = normaliseStepShape({
    order: 2,
    action: 'Fill',
    element: 'Username textbox',
    value: 'Admin',
    expected: 'Admin entered in Username field is visible',
  });

  assert.strictEqual(step.operationCheck.kind, 'input_accepted');
  assert.strictEqual(step.operationCheck.expected, 'Username textbox accepts the provided value');
  assert.strictEqual(step.operationCheck.target, 'Username textbox');
  assert.strictEqual(step.expectedKind, null);
}

{
  const step = normaliseStepShape({
    order: 4,
    action: 'Click',
    element: 'Profile menu button',
    expected: 'Profile menu opens',
  });

  assert.strictEqual(step.operationCheck.kind, 'menu_opened');
  assert.strictEqual(step.operationCheck.expected, 'Profile menu opens');
}

{
  const step = normaliseStepShape({
    order: 3,
    action: 'Type',
    element: 'Password textbox',
    value: 'admin123',
    operationCheck: { kind: 'input_accepted', expected: 'Password entered' },
    expected: 'Password entered',
  });

  assert.strictEqual(step.operationCheck.kind, 'input_accepted');
  assert.strictEqual(step.operationCheck.expected, 'Password textbox accepts the provided value');
}

{
  const step = normaliseStepShape({
    order: 5,
    action: 'Verify',
    element: 'Dashboard heading',
    expected: 'Dashboard',
    verificationPoint: true,
  });

  assert.strictEqual(step.operationCheck, null);
  assert.strictEqual(step.verificationPoint, true);
}

{
  const step = normaliseStepShape({
    order: 6,
    action: 'Verify',
    element: 'PIM page content',
    expected: 'Employee List visible; user still authenticated',
  });

  assert.strictEqual(step.operationCheck.kind, 'page_ready');
  assert.strictEqual(step.operationCheck.expected, 'Employee List visible; user still authenticated');
  assert.strictEqual(step.verificationPoint, false);
}

{
  const steps = normaliseSteps(JSON.stringify([
    { action: 'Navigate', value: 'https://example.test/login' },
    { action: 'Fill', target: 'Username textbox', value: 'Admin' },
  ]));

  assert.strictEqual(steps.length, 2);
  assert.strictEqual(steps[0].action, 'Navigate');
  assert.strictEqual(steps[0].value, 'https://example.test/login');
  assert.strictEqual(steps[1].element, 'Username textbox');
}

{
  const promptSteps = serialiseStepsForPrompt(JSON.stringify([
    { action: 'Click', target: 'Login button', expected: 'Dashboard opens' },
  ]));

  assert.strictEqual(promptSteps.length, 1);
  assert.strictEqual(promptSteps[0].action, 'Click');
  assert.strictEqual(promptSteps[0].element, 'Login button');
}

console.log('stepShape.test.js: PASS');
