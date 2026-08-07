'use strict';
// Integration test for P1b journey codegen — MOCK provider, no LLM, no credits.
const codegen = require('../server/services/codegen');
const assert = require('assert');

let captured = {};
const fakeProvider = {
  async complete({ system, messages }) {
    captured.system = system;
    captured.userMsg = messages[0].content;
    return { content: [{ text: JSON.stringify({ test: {
      path: 'tests/pim/create-employee-journey.spec.ts',
      content: "import { test, expect } from '@playwright/test';\n// JOURNEY OK\n",
    } }) }] };
  },
};

const scenario = { name: 'Employee lifecycle', module: 'PIM' };
const journeyCases = [
  { testCase: { id: 'A', name: 'Create employee', steps: [],
      declaredAssertions: JSON.stringify([{ id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Successfully Saved' } }]) },
    actionPlan: { caseStatus: 'pass',
      actions: [{ tool: 'browser_type', args: { element: 'First Name' }, locator: { intent: 'First Name', expression: 'getByRole("textbox", { name: "First Name" })' } }],
      locatorManifest: [{ intent: 'First Name', expression: 'getByRole("textbox", { name: "First Name" })' }] } },
  { testCase: { id: 'B', name: 'Search the created employee', steps: [],
      declaredAssertions: JSON.stringify([{ id: 'b1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'John' } }]) },
    actionPlan: { caseStatus: 'pass',
      actions: [{ tool: 'browser_type', args: { element: 'Search' }, locator: { intent: 'Search', expression: 'getByRole("textbox", { name: "Search" })' } }],
      locatorManifest: [{ intent: 'Search', expression: 'getByRole("textbox", { name: "Search" })' }] } },
];

(async () => {
  // Capability matrix — Playwright journeys on, others gracefully off.
  assert.equal(codegen.supportsJourney('playwright-pom'), true, 'pw-pom supports journeys');
  assert.equal(codegen.supportsJourney('playwright-js'), true, 'pw-js supports journeys');
  assert.equal(codegen.supportsJourney('selenium-java'), false, 'selenium NOT yet (per-case fallback)');
  assert.equal(codegen.supportsJourney('playwright-bdd'), false, 'bdd NOT yet (per-case fallback)');

  const lay = codegen.layoutForJourney('playwright-pom', scenario, journeyCases.map((c) => c.testCase));
  assert.ok(/^tests\/pim\/.*-journey\.spec\.ts$/.test(lay.testFile), 'journey layout path: ' + lay.testFile);

  const content = await codegen.generateJourney({
    framework: 'playwright-pom', provider: fakeProvider, apiKey: 'k', model: 'm',
    scenario, journeyCases, targetUrl: 'https://app.example.com',
    credProfile: { users: [{ username: 'Admin' }], hasCreds: true }, authInfo: { authImportPath: '../../utils/auth' },
  });
  assert.ok(content.includes('JOURNEY OK'), 'journey content recovered from model output (not a JSON blob)');

  // System prompt = journey rules + fidelity + locator replay + login + creds.
  assert.ok(/test\.step/.test(captured.system), 'system: one test.step per case');
  assert.ok(/SHARED DATA/.test(captured.system), 'system: shared-data (P4) unique-const rule');
  assert.ok(/Date\.now\(\)/.test(captured.system), 'system: shows the unique-const pattern');
  assert.ok(/VERDICT FIDELITY/.test(captured.system), 'system: verdict fidelity carried');
  assert.ok(/LOCATOR REPLAY/.test(captured.system), 'system: locator replay carried');
  assert.ok(/login/.test(captured.system), 'system: shared login referenced');

  // User message: per-step caseStatus + declaredAssertions + resolved locators, in dep order.
  const um = JSON.parse(captured.userMsg);
  assert.equal(um.steps.length, 2, 'two ordered steps');
  assert.equal(um.steps[0].caseName, 'Create employee', 'producer step first');
  assert.equal(um.steps[1].caseName, 'Search the created employee', 'consumer step second');
  assert.equal(um.steps[0].caseStatus, 'pass', 'per-step caseStatus present');
  assert.equal(um.steps[0].declaredAssertions.length, 1, 'per-step declaredAssertions present');
  assert.ok(/First Name/.test(um.steps[0].resolvedLocators || ''), 'per-step resolved locators present');

  const split = codegen.splitFilesJourneyFor('playwright-pom', content, lay);
  assert.deepEqual(Object.keys(split), [lay.testFile], 'journey splits to a single spec file');

  const none = await codegen.generateJourney({ framework: 'selenium-java', provider: fakeProvider, scenario, journeyCases, targetUrl: 'x' });
  assert.equal(none, null, 'non-capable framework → null (caller keeps per-case specs)');

  console.log('PASS — journey codegen works end-to-end (mock provider, no credits):');
  console.log('  layout :', lay.testFile);
  console.log('  steps  :', um.steps.map((s) => s.caseName).join('  →  '));
  console.log('  prompt : test.step + SHARED DATA(Date.now) + VERDICT FIDELITY + LOCATOR REPLAY + login');
  console.log('  fallback: selenium-java → null (per-case preserved)');
})().catch((e) => { console.error('FAIL', e.message, '\n', e.stack); process.exit(1); });
