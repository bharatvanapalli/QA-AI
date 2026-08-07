import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const proceduralFlowContract = require('../../server/services/proceduralFlowContract');
const planningBridge = require('../../server/services/caseContractPlanningBridge');
const testDesignPlanV1 = require('../../server/services/testDesignPlanV1');
const stepCompiler = require('../../server/services/testDesignStepCompiler');
const architect = require('../../server/services/agents/architect');
const authoredFlowIngestion = require('../../server/services/authoredFlowIngestion');

function compileThroughDesignPipeline(requirement) {
  const procedural = proceduralFlowContract.extractProceduralFlowContract([requirement]);
  const bridged = planningBridge.buildCaseContractPlanningBridge({
    proceduralFlowContract: procedural,
    coverageManifest: { version: 1, items: [] },
    caseContractPacks: [],
  });
  const plan = testDesignPlanV1.buildTestDesignPlanV1({
    coverageManifest: bridged.coverageManifest,
    caseContractPacks: bridged.caseContractPacks,
    requirements: [requirement],
  });
  const casePlanByCoverageRef = new Map(plan.scenarios
    .flatMap((scenario) => scenario.cases || [])
    .map((casePlan) => [casePlan.coverageRef, casePlan]));
  const candidates = bridged.caseContractPacks.map((pack) => architect.deterministicScenarioFromPack({
    ...pack,
    planCaseId: casePlanByCoverageRef.get(pack.coverageRef).planCaseId,
  }, 'authored_flow_ingestion_regression'));
  return {
    procedural,
    compiled: stepCompiler.compileCandidateSuite({
      testDesignPlan: plan,
      candidateScenarios: candidates,
      proceduralFlowContract: procedural,
    }),
  };
}

describe('authored procedural flow ingestion', () => {
  it('preserves authored scenario parents when each scenario contains multiple test cases', () => {
    const requirement = {
      id: 'req-authored-scenario-groups',
      source: 'upload',
      title: 'Grouped authored scenarios',
      content: [
        'Scenario 01: Edit profile fields',
        'Test Case 01.1: Enter a full name',
        'Steps:',
        '1. Enter "Ada Lovelace" in the Full Name field.',
        '2. Verify the Full Name field contains "Ada Lovelace".',
        '',
        'Test Case 01.2: Clear a full name',
        'Steps:',
        '1. Clear the Full Name field.',
        '2. Verify the Full Name field is empty.',
        '',
        'Scenario 02: Use dialog boxes',
        'Test Case 02.1: Accept a confirmation',
        'Steps:',
        '1. Click the Confirm button.',
        '2. Accept the confirmation dialog.',
        '3. Verify the accepted message is visible.',
      ].join('\n'),
    };

    const { procedural, compiled } = compileThroughDesignPipeline(requirement);

    expect(procedural.caseContractV1.explicitCounts).toEqual({ scenarios: 2, cases: 3 });
    expect(procedural.caseContractV1.cases.map((item) => item.authoredScenario.name)).toEqual([
      'Edit profile fields',
      'Edit profile fields',
      'Use dialog boxes',
    ]);
    expect(compiled.scenarios).toHaveLength(2);
    expect(compiled.scenarios.map((scenario) => scenario.name)).toEqual([
      'Edit profile fields',
      'Use dialog boxes',
    ]);
    expect(compiled.scenarios.map((scenario) => scenario.cases.length)).toEqual([2, 1]);
    expect(compiled.scenarios.flatMap((scenario) => scenario.cases).map((item) => item.name)).toEqual([
      'Enter a full name',
      'Clear a full name',
      'Accept a confirmation',
    ]);
  });

  it('preserves compact source, long steps, assertions, exact values, and continuation', () => {
    const fieldCount = 27;
    const data = Array.from({ length: fieldCount }, (_, index) => (
      `Field ${String(index + 1).padStart(2, '0')} = value-${String(index + 1).padStart(2, '0')}`
    ));
    const longSteps = ['1. Click Work Queue.'];
    for (let index = 0; index < fieldCount; index += 1) {
      const ordinal = String(index + 1).padStart(2, '0');
      longSteps.push(`${longSteps.length + 1}. Fill Field ${ordinal} with value-${ordinal}.`);
      longSteps.push(`${longSteps.length + 1}. Verify that Field ${ordinal} contains exactly value-${ordinal}.`);
    }

    const compactFirstCase = [
      'Requirement Title: Authenticate and open the workspace',
      'Target URL: https://example.test/login',
      'Test Data: Email Address: person@example.test Password: authored-secret',
      'Scenario: Complete one continuous authentication flow.',
      'Test Case: Authenticate in one browser session',
      'Steps: 1. Navigate to https://example.test/login. 2. In the Email Address field, enter person@example.test. 3. Click the Continue button. 4. Enter authored-secret in the Password field. 5. Click the Sign in button. 6. Verify that the Workspace dashboard is displayed.',
      'Session Policy: sessionMode: fresh dependsOnIds: none failurePolicy: block_dependents',
      'Expected Scenario/Test Case Shape: Expected scenario count: 1 Expected test case count: 1',
    ].join(' ');
    const secondCase = [
      'Scenario Title:',
      'Populate a long form in the authenticated session',
      '',
      'Session Requirement:',
      'continue_from_previous_case',
      '',
      'Initial State:',
      'The previous case completed and the authenticated workspace remains open.',
      '',
      'Inline Test Data:',
      ...data,
      '',
      'Test Steps and Validations:',
      ...longSteps,
    ].join('\n');
    const requirement = {
      id: 'req-generic-authored-flow',
      source: 'upload',
      title: 'Generic authored flow',
      content: `${compactFirstCase}\n\n${secondCase}`,
    };

    const { procedural, compiled } = compileThroughDesignPipeline(requirement);
    const contracts = procedural.caseContractV1.cases;
    const compiledCases = compiled.scenarios.flatMap((scenario) => scenario.cases);

    expect(procedural.caseContractV1.explicitCounts).toEqual({ scenarios: 2, cases: 2 });
    expect(contracts).toHaveLength(2);
    expect(contracts[0].name).toBe('Authenticate in one browser session');
    expect(contracts[0].sessionRequirement).toMatchObject({ mode: 'fresh', dependsOnCaseRefs: [] });
    expect(contracts[0].steps).toHaveLength(6);
    expect(contracts[0].steps[1]).toMatchObject({ type: 'Fill', target: 'Email Address field' });
    expect(contracts[0].steps.at(-1)).toMatchObject({ type: 'AssertVisible', target: 'Workspace dashboard' });

    expect(contracts[1].sessionRequirement).toMatchObject({
      mode: 'continue_from_case',
      predecessorCaseId: contracts[0].id,
    });
    expect(contracts[1].steps).toHaveLength(55);
    expect(contracts[1].steps.filter((step) => /^Assert/.test(step.type))).toHaveLength(fieldCount);

    expect(compiledCases).toHaveLength(2);
    expect(compiledCases[0].steps).toHaveLength(6);
    expect(compiledCases[1].steps).toHaveLength(55);
    expect(compiledCases[1].sessionMode).toBe('continue_from_dependency');
    expect(compiledCases[1].dependsOnNames).toEqual(['Authenticate in one browser session']);
    expect(compiledCases[1].steps[1]).toMatchObject({ value: 'value-01', target: 'Field 01' });
    expect(compiledCases[1].steps.at(-1)).toMatchObject({
      action: 'AssertText',
      target: 'Field 27',
      expected: 'value-27',
    });
    expect(JSON.stringify(compiledCases)).not.toMatch(/\{\{[^}]+\}\}/);
  });
});

describe('non-blocking authored flow source interpretation', () => {
  it('accepts a messy paragraph, preserves it exactly, and extracts actions and inline values', () => {
    const source = [
      'login to the application using admin@company.test and password Test123',
      'then click login after that go to employee page create one employee',
      'name john role manager and save it verify success message and employee should be displayed in the table',
      'then logout',
    ].join(' ');

    const result = authoredFlowIngestion.ingestAuthoredFlow({
      id: 'messy-flow',
      title: 'Messy employee flow',
      content: source,
    });

    expect(result.acceptance).toEqual({ accepted: true, blocking: false, blockers: [] });
    expect(result.source.documents[0].rawText).toBe(source);
    expect(result.source.exactSourcePreserved).toBe(true);
    expect(result.summary.logicalStepCount).toBeGreaterThanOrEqual(5);
    expect(result.understanding.logicalSteps.map((step) => step.authoredText).join(' '))
      .toContain('employee page');
    expect(result.understanding.testData.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: 'username', value: 'admin@company.test', classification: 'normal' }),
      expect.objectContaining({ token: 'password', value: null, classification: 'sensitive' }),
      expect.objectContaining({ token: 'employee_name', value: 'john' }),
      expect.objectContaining({ token: 'role', value: 'manager' }),
    ]));
    expect(result.diagnostics.every((item) => item.blocking === false)).toBe(true);
  });

  it('understands Given/When/Then and keeps compound action plus verification as one logical step', () => {
    const source = [
      'User Story:',
      'As a customer,',
      'I want to sign in,',
      'so that I can see my account.',
      '',
      'Given the customer account exists',
      'When the customer clicks "Sign in" and verifies the Dashboard is visible',
      'Then verify the customer name is displayed',
    ].join('\n');

    const result = authoredFlowIngestion.ingestAuthoredFlow({ id: 'bdd-flow', content: source });
    const compound = result.understanding.logicalSteps.find((step) => (
      step.authoredText.includes('clicks "Sign in"')
    ));

    expect(result.understanding.actors[0].text).toBe('customer');
    expect(result.understanding.goals[0].text).toBe('sign in');
    expect(result.understanding.benefits[0].text).toBe('I can see my account');
    expect(result.understanding.preconditions[0].text).toBe('the customer account exists');
    expect(compound.atomicActions).toHaveLength(2);
    expect(compound.atomicActions.map((item) => item.kind)).toEqual(['action', 'assertion']);
    expect(result.understanding.logicalSteps.filter((step) => step.role === 'assertion')).toHaveLength(1);
    for (const item of [
      ...result.understanding.preconditions,
      ...result.understanding.logicalSteps,
      ...result.understanding.assertions,
    ]) {
      expect(source.slice(item.sourceSpan.start, item.sourceSpan.end)).toBe(item.sourceSpan.quote);
    }
  });

  it('extracts key-value, Markdown, and CSV-like data while masking sensitive fields', () => {
    const source = [
      'Test Data:',
      'Username: alice.qa',
      'Password=NeverLogThis',
      '',
      '| employee name | role | expected status |',
      '| --- | --- | --- |',
      '| John Doe | Manager | Active |',
      '',
      'case_id,input_value,expected_message',
      'TC-1,"North, West",Saved',
      '',
      'Steps:',
      '1. Enter "John Doe" in the Employee Name field.',
      '2. Click Save and verify Saved is displayed.',
    ].join('\n');

    const result = authoredFlowIngestion.ingestAuthoredFlow({ id: 'data-flow', content: source });
    const password = result.understanding.testData.fields.find((entry) => entry.token === 'password');

    expect(result.summary.tableCount).toBe(2);
    expect(result.understanding.testData.tables.map((table) => table.format)).toEqual(['markdown', 'csv']);
    expect(password).toMatchObject({
      classification: 'sensitive',
      value: null,
    });
    expect(password.maskedValue).not.toContain('NeverLogThis');
    expect(result.source.documents[0].rawText).toBe(source);
    expect(result.understanding.testData.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: 'employee_name', value: 'John Doe' }),
      expect.objectContaining({ token: 'input_value', value: 'North, West' }),
      expect.objectContaining({ origin: 'quoted_inline', value: 'John Doe' }),
    ]));
  });

  it('retains an unknown instruction as a semantic fallback instead of dropping it', () => {
    const source = [
      'Complete the necessary setup for this tenant.',
      'Click Continue.',
    ].join('\n');

    const result = authoredFlowIngestion.ingestAuthoredFlow(source);
    const fallback = result.understanding.logicalSteps[0];

    expect(result.acceptance.accepted).toBe(true);
    expect(result.understanding.logicalSteps).toHaveLength(2);
    expect(fallback).toMatchObject({
      authoredText: 'Complete the necessary setup for this tenant.',
      interpretationMode: 'semantic_fallback',
    });
    expect(fallback.atomicActions[0]).toMatchObject({
      kind: 'semantic',
      type: 'SemanticInstruction',
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'semantic_fallback_step',
        blocking: false,
        stepId: fallback.id,
      }),
    ]));
  });

  it('keeps stable identities and exact spans for identical content across repeated ingestion', () => {
    const source = 'Steps:\r\n1. Open the login page.\r\n2. Enter "alice" in the Username field.\r\n3. Verify Dashboard is visible.';
    const first = authoredFlowIngestion.ingestAuthoredFlow({ id: 'stable-source', content: source });
    const second = authoredFlowIngestion.ingestAuthoredFlow({ id: 'stable-source', content: source });

    expect(first.understanding.logicalSteps.map((step) => step.id))
      .toEqual(second.understanding.logicalSteps.map((step) => step.id));
    for (const step of first.understanding.logicalSteps) {
      expect(source.slice(step.sourceSpan.start, step.sourceSpan.end)).toBe(step.sourceSpan.quote);
      expect(step.sourceSpan.startLine).toBeGreaterThan(1);
    }
  });
});
