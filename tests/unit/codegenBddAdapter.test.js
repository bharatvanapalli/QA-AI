import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vocabulary = require('../../server/lib/capabilityVocabulary');
const adapters = require('../../server/services/codegen/adapters');
const registry = require('../../server/services/codegen/adapters/bddStepRegistry');
const compiler = require('../../server/services/codegen/adapters/bddCompiler');
const glueEmitters = require('../../server/services/codegen/adapters/bddGlueEmitters');
const boundOps = require('../../server/services/codegen/adapters/bddBoundOperations');
const readiness = require('../../server/services/codegen/adapters/bddExportReadiness');
const seleniumBdd = require('../../server/services/codegen/adapters/seleniumBddReference');
const exportValidate = require('../../server/services/codegen/_exportValidate');
const fixture = require('../../server/services/codegen/adapters/fixtures/bdd-capability-flow.json');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atlasCapabilities() {
  return [
    {
      id: 'cap-products',
      type: 'entity_collection',
      name: 'Product collection',
      operations: ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'],
      evidence: {
        root: { selector: '[data-testid="products-table"]' },
        columns: [
          { name: 'name', selector: '[data-col="name"]' },
          { name: 'color', selector: '[data-col="color"]' },
          { name: 'price', selector: '[data-col="price"]' },
          { name: 'cart item', selector: '[data-col="cart-item"]' },
        ],
      },
      elementRefs: ['products-table'],
    },
    {
      id: 'cap-add-cart',
      type: 'workflow_action',
      name: 'Add to cart',
      operations: ['invokeAction'],
      evidence: {
        button: { selector: '[data-action="add-to-cart"]' },
      },
      elementRefs: ['add-to-cart'],
    },
  ];
}

function boundFixture(overrides = {}) {
  const copy = clone(fixture);
  copy.operations = copy.operations.map((step) => {
    if (['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'].includes(step.operation)) {
      return { ...step, capabilityRef: 'cap-products' };
    }
    if (step.operation === 'invokeAction') {
      return { ...step, capabilityRef: 'cap-add-cart' };
    }
    return step;
  });
  return {
    ...copy,
    capabilities: atlasCapabilities(),
    ...overrides,
  };
}

describe('BDD capability adapter seam', () => {
  it('uses capabilityVocabulary as the complete BDD operation source', () => {
    expect(adapters.bddStepRegistry).toBe(registry);
    expect(registry.operationKeys()).toEqual(Object.keys(vocabulary.OPERATIONS).sort());
    expect(registry.registryKeys()).toEqual(registry.operationKeys());

    const result = registry.validateStepRegistry();
    expect(result.valid).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('has exactly one canonical normalized Gherkin pattern per operation', () => {
    const byPattern = new Map();
    for (const entry of Object.values(registry.STEP_REGISTRY)) {
      const normalized = registry.normalizeGherkinPattern(entry.gherkin);
      const list = byPattern.get(normalized) || [];
      list.push(entry.operation);
      byPattern.set(normalized, list);
    }

    expect([...byPattern.values()].filter((list) => list.length > 1)).toEqual([]);
    expect(byPattern.size).toBe(Object.keys(vocabulary.OPERATIONS).length);
  });

  it('compiles the product-selection example into Scenario Outline plus criteria Data Tables', () => {
    const result = compiler.compileFeature(fixture);

    expect(result.valid).toBe(true);
    expect(result.outline).toBe(true);
    expect(result.exampleColumns).toEqual(['color']);
    expect(result.feature).toContain('Scenario Outline: Add the least priced matching product to cart');
    expect(result.feature).toContain('When I select "product" entities where:');
    expect(result.feature).toContain('| name | contains | iPhone 17 |');
    expect(result.feature).toContain('| color | equals | <color> |');
    expect(result.feature).toContain('And I choose the selected entity with minimum "price"');
    expect(result.feature).toContain('When I invoke the "add to cart" action');
    expect(result.feature).toContain('Examples:');
    expect(result.feature).toContain('| color |');
    expect(result.feature).toContain('| black |');
    expect(result.feature).toContain('| pink |');

    const exported = exportValidate.validateExport({
      framework: 'playwright-bdd',
      caseStatus: 'pass',
      files: { 'features/shop/product-selection.feature': result.feature },
    });
    expect(exported.exportPassed).toBe(true);
    expect(exported.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('renders masked and restricted BDD examples as safe references', () => {
    const result = compiler.compileFeature({
      featureName: 'Secure login',
      scenarioName: 'Login with approved data',
      operations: [
        { operation: 'fillField', params: { field: 'username', value: '<username>' } },
        { operation: 'fillField', params: { field: 'password', value: '<password>' } },
        { operation: 'fillField', params: { field: 'ssn', value: '<ssn>' } },
      ],
      dataRows: [
        {
          index: 0,
          label: 'Admin row',
          fields: { username: 'admin@example.com', password: 'SuperSecret123', ssn: '111-22-3333' },
          sensitivity: { username: 'synthetic', password: 'masked', ssn: 'restricted' },
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.feature).toContain('| admin@example.com | env:QAAI_TD_PASSWORD_ROW_1 | vault:ssn:row-1 |');
    expect(result.feature).not.toContain('SuperSecret123');
    expect(result.feature).not.toContain('111-22-3333');
  });

  it('defaults secret-looking BDD example columns to masked references', () => {
    const result = compiler.compileFeature({
      featureName: 'Secure login',
      scenarioName: 'Login with approved data',
      operations: [
        { operation: 'fillField', params: { field: 'password', value: '<password>' } },
      ],
      dataRows: [
        { index: 0, label: 'Admin row', fields: { password: 'SuperSecret123' } },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.feature).toContain('env:QAAI_TD_PASSWORD_ROW_1');
    expect(result.feature).not.toContain('SuperSecret123');
  });

  it('rejects invalid field-level BDD data sensitivity', () => {
    const result = compiler.compileFeature({
      featureName: 'Secure login',
      scenarioName: 'Login with approved data',
      operations: [
        { operation: 'fillField', params: { field: 'username', value: '<username>' } },
      ],
      dataRows: [
        { index: 0, label: 'Admin row', fields: { username: 'admin@example.com' }, sensitivity: { username: 'plaintext' } },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_data_row_bad_sensitivity')).toBe(true);
  });

  it('validates bound BDD operations against verified atlas capabilities', () => {
    const payload = boundFixture();
    const result = boundOps.validateBoundOperations(payload);

    expect(adapters.bddBoundOperations).toBe(boundOps);
    expect(result.valid).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(result.boundOperations.find((op) => op.operation === 'selectEntityWhere').capability.type).toBe('entity_collection');
    expect(result.boundOperations.find((op) => op.operation === 'invokeAction').capability.type).toBe('workflow_action');

    const compiled = compiler.compileFeature({ ...payload, operations: result.boundOperations });
    expect(compiled.valid).toBe(true);
  });

  it('hard-blocks non-global BDD operations without a capability binding', () => {
    const payload = boundFixture();
    delete payload.operations.find((op) => op.operation === 'selectEntityWhere').capabilityRef;

    const result = boundOps.validateBoundOperations(payload);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_operation_capability_missing')).toBe(true);
  });

  it('hard-blocks atlas capabilities without a durable selector', () => {
    const payload = boundFixture();
    payload.capabilities[0].evidence = { root: { selector: '' } };

    const result = boundOps.validateBoundOperations(payload);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_capability_invalid')).toBe(true);
  });

  it('hard-blocks operations not exposed by the matched capability', () => {
    const payload = boundFixture();
    payload.capabilities[0].operations = ['selectEntityWhere', 'chooseSelected', 'assertTableContains'];

    const result = boundOps.validateBoundOperations(payload);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_capability_operation_missing')).toBe(true);
  });

  it('hard-blocks placeholders that are not supplied by every data row', () => {
    const payload = boundFixture({
      dataRows: [
        { index: 0, label: 'Row without color', fields: {}, sensitivity: 'synthetic' },
      ],
    });

    const result = boundOps.validateBoundOperations(payload);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_operation_placeholder_missing_field')).toBe(true);
  });

  it('hard-blocks collection field references missing from verified capability evidence', () => {
    const payload = boundFixture();
    payload.operations.find((op) => op.operation === 'rankByMin').params.field = 'discount';

    const result = boundOps.validateBoundOperations(payload);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_capability_field_missing')).toBe(true);
  });

  it('marks a fully bound Playwright-BDD package exportable', () => {
    const payload = boundFixture();
    const result = readiness.assessBddExportReadiness({
      ...payload,
      framework: 'playwright-bdd',
      caseStatus: 'pass',
      moduleName: 'Shop',
    });

    expect(adapters.bddExportReadiness).toBe(readiness);
    expect(result.exportable).toBe(true);
    expect(result.files['features/shop/add-the-least-priced-matching-product-to-cart.feature']).toContain('Scenario Outline');
    expect(result.files['steps/capability.steps.ts']).toContain('ops(page).selectEntityWhere(');
    expect(result.files['support/capabilityOperations.ts']).toContain('__QAAI_BDD_OPERATION_RUNNER__');
    expect(result.files['support/capabilityOperations.ts']).toContain('function columnFor(');
    expect(result.files['support/capabilityOperations.ts']).toContain('async selectEntityWhere(');
    expect(result.files['support/capabilityOperations.ts']).toContain('private async doRankByMin(');
    expect(result.files['support/capabilityOperations.ts']).toContain('[data-col=\\"price\\"]');
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('emits downloadFile as a real Playwright download operation from verified file evidence', () => {
    const result = readiness.assessBddExportReadiness({
      framework: 'playwright-bdd',
      caseStatus: 'pass',
      featureName: 'Reports',
      scenarioName: 'Download report',
      moduleName: 'Reports',
      operations: [
        { operation: 'downloadFile', capabilityRef: 'cap-download', params: { target: 'report' } },
      ],
      capabilities: [
        {
          id: 'cap-download',
          type: 'file',
          name: 'Report download',
          operations: ['downloadFile'],
          evidence: { control: { selector: '[data-testid="download-report"]' } },
        },
      ],
    });

    expect(result.exportable).toBe(true);
    expect(result.files['features/reports/download-report.feature']).toContain('When I download the "report" file');
    expect(result.files['support/capabilityOperations.ts']).toContain("page.waitForEvent('download'");
    expect(result.files['support/capabilityOperations.ts']).toContain('download.saveAs(savePath)');
    expect(result.files['support/capabilityOperations.ts']).toContain('[data-testid=\\"download-report\\"]');
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('retains BDD output with diagnostics when P3d reports dropped operations', () => {
    const payload = boundFixture({
      droppedOperations: [
        { operation: 'invokeAction', reason: 'capability_not_in_atlas' },
      ],
    });

    const result = readiness.assessBddExportReadiness({
      ...payload,
      framework: 'playwright-bdd',
    });

    expect(result.exportable).toBe(true);
    expect(Object.keys(result.files).length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.rule === 'bdd_export_dropped_operations' && f.severity === 'warning')).toBe(true);
  });

  it('retains BDD output when operation-plan findings signal a dropped operation', () => {
    const payload = boundFixture({
      operationFindings: [
        {
          rule: 'capability_not_in_atlas',
          severity: 'warning',
          message: 'No verified Place Order capability exists in this module.',
          disposition: 'dropped',
        },
      ],
    });

    const result = readiness.assessBddExportReadiness({
      ...payload,
      framework: 'selenium-bdd',
    });

    expect(result.exportable).toBe(true);
    expect(Object.keys(result.files).length).toBeGreaterThan(0);
    expect(result.droppedSignals).toHaveLength(1);
    expect(result.findings.some((f) => f.rule === 'bdd_export_dropped_operations' && f.severity === 'warning')).toBe(true);
  });

  it('retains BDD output with diagnostics when TestData does not cover operation placeholders', () => {
    const payload = boundFixture({
      dataRows: [
        { index: 0, label: 'Row without color', fields: {}, sensitivity: 'synthetic' },
      ],
    });

    const result = readiness.assessBddExportReadiness({
      ...payload,
      framework: 'playwright-bdd',
    });

    expect(result.exportable).toBe(true);
    expect(Object.keys(result.files).length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.rule === 'bdd_operation_placeholder_missing_field')).toBe(true);
  });

  it('allows failed MCP BDD only when a bound assertion operation is present', () => {
    const payload = boundFixture();
    const result = readiness.assessBddExportReadiness({
      ...payload,
      framework: 'playwright-bdd',
      caseStatus: 'fail',
    });

    expect(result.exportable).toBe(true);
    expect(result.files['support/capabilityOperations.ts']).toContain('doAssertTableContains');
    expect(result.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('retains failed MCP BDD actions with a missing-verdict diagnostic', () => {
    const payload = boundFixture();
    payload.operations = payload.operations.filter((op) => op.operation !== 'assertTableContains');
    const result = readiness.assessBddExportReadiness({
      ...payload,
      framework: 'playwright-bdd',
      caseStatus: 'fail',
    });

    expect(result.exportable).toBe(true);
    expect(Object.keys(result.files).length).toBeGreaterThan(0);
    expect(result.findings.some((f) => f.rule === 'bdd_export_no_verdict_assertion')).toBe(true);
  });

  it('hard-blocks unsupported BDD adapter operations', () => {
    const result = compiler.compileFeature({
      ...fixture,
      adapterId: 'company-bdd-not-onboarded',
    });

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_adapter_unsupported_operation')).toBe(true);
  });

  it('hard-blocks criteria operators outside capabilityVocabulary', () => {
    const bad = JSON.parse(JSON.stringify(fixture));
    bad.operations.find((op) => op.operation === 'selectEntityWhere').params.criteria[0].operator = 'approximately';

    const result = compiler.compileFeature(bad);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_criteria_invalid')).toBe(true);
    expect(vocabulary.CRITERIA_OPERATORS).not.toContain('approximately');
  });

  it('requires Scenario Outline placeholders to be supplied by dataRows fields', () => {
    const bad = JSON.parse(JSON.stringify(fixture));
    bad.operations.push({ operation: 'assertVisibleText', params: { text: '<missingExpected>' } });

    const result = compiler.compileFeature(bad);

    expect(result.valid).toBe(false);
    expect(result.findings.some((f) => f.rule === 'bdd_outline_missing_example_column')).toBe(true);
  });

  it('emits Playwright-BDD glue from the registry and delegates to operation helpers', () => {
    const feature = compiler.compileFeature(fixture);
    const glue = glueEmitters.emitPlaywrightBddGlue({ operations: fixture.operations });
    const steps = glue.files['steps/capability.steps.ts'];
    const support = glue.files['support/capabilityOperations.ts'];

    expect(adapters.bddGlueEmitters).toBe(glueEmitters);
    expect(glue.valid).toBe(true);
    for (const step of fixture.operations) {
      const entry = registry.getStep(step.operation);
      expect(steps).toContain(glueEmitters.cucumberExpression(entry));
      expect(steps).toContain(`ops(page).${step.operation}(`);
      expect(support).toContain(`async ${step.operation}(`);
    }
    expect(steps).toContain('criteriaFromDataTable(dataTable)');
    expect(support).toContain('resolveSafeRefs(params)');
    expect(support).toContain('envNameFromRef(kind, body)');
    expect(support).toContain('__QAAI_BDD_OPERATION_RUNNER__');
    expect(support).toContain('"equals","not_equals","contains"');
    expect(steps).not.toMatch(/\bpage\.(getBy|locator|click|fill)\b/);

    const exported = exportValidate.validateExport({
      framework: 'playwright-bdd',
      caseStatus: 'pass',
      files: {
        'features/shop/product-selection.feature': feature.feature,
        ...glue.files,
      },
    });
    expect(exported.exportPassed).toBe(true);
    expect(exported.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('emits Selenium-BDD glue from the same registry and delegates to operation helpers', () => {
    const feature = compiler.compileFeature({ ...fixture, adapterId: 'selenium-bdd' });
    const glue = glueEmitters.emitSeleniumBddGlue({ operations: fixture.operations });
    const steps = glue.files['src/test/java/com/qaai/steps/CapabilitySteps.java'];
    const operations = glue.files['src/main/java/com/qaai/bdd/CapabilityOperations.java'];
    const criteria = glue.files['src/main/java/com/qaai/bdd/Criteria.java'];

    expect(glue.valid).toBe(true);
    for (const step of fixture.operations) {
      const entry = registry.getStep(step.operation);
      expect(steps).toContain(`@${entry.keyword}(${JSON.stringify(glueEmitters.cucumberExpression(entry))})`);
      expect(steps).toContain(`ops().${step.operation}(`);
      expect(operations).toContain(`public void ${step.operation}(`);
    }
    expect(steps).toContain('Criteria.fromDataTable(dataTable)');
    expect(operations).toContain('resolveSafeRefs(entry.getValue())');
    expect(operations).toContain('envNameFromRef(kind, body)');
    expect(criteria).toContain('Set.of("equals", "not_equals", "contains"');
    expect(steps).not.toMatch(/driver\.findElement|By\.xpath|By\.cssSelector/);

    const exported = exportValidate.validateExport({
      framework: 'selenium-bdd',
      caseStatus: 'pass',
      files: {
        'src/test/resources/features/shop/product-selection.feature': feature.feature,
        ...glue.files,
      },
    });
    expect(exported.exportPassed).toBe(true);
    expect(exported.findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('reconciles partial operation plans by strict step ID while preserving authored order and dependencies', () => {
    const authoredSteps = [
      { stepId: 'step-action', action: 'click', element: 'Publish report' },
      { stepId: 'step-dependency', kind: 'dependency', action: 'continue', element: 'authenticated browser session', value: 'prerequisite case' },
    ];
    const operations = [
      { stepId: 'step-action', operation: 'invokeAction', params: { action: 'Publish report' } },
      { stepId: 'foreign-step', operation: 'assertVisibleText', params: { text: 'Publish report' } },
    ];

    const result = compiler.reconcileAuthoredOperations({ operations, authoredSteps });

    expect(result.operations.map((step) => step.operation)).toEqual(['invokeAction', 'authoredDependency']);
    expect(result.operations.map((step) => step.stepId)).toEqual(['step-action', 'step-dependency']);
    expect(result.findings.some((f) => f.rule === 'bdd_operation_plan_unmatched')).toBe(true);
    expect(JSON.stringify(result.operations)).not.toContain('foreign-step');

    const endToEnd = readiness.assessBddExportReadiness({
      framework: 'playwright-bdd',
      featureName: 'Reports',
      scenarioName: 'Publish report from the continued session',
      authoredSteps,
      operationPlan: { operations },
    });
    expect(endToEnd.exportable).toBe(true);
    expect(endToEnd.boundOperations.map((step) => step.stepId)).toEqual(['step-action', 'step-dependency']);
    expect(Object.keys(endToEnd.files).length).toBeGreaterThan(0);
  });

  it('requires a runtime authentication seam instead of silently passing standalone authenticateAs', () => {
    const result = glueEmitters.emitPlaywrightBddGlue({ operations: ['authenticateAs'] });
    const support = result.files['support/capabilityOperations.ts'];

    expect(result.valid).toBe(true);
    expect(support).toContain('__QAAI_BDD_AUTHENTICATOR__');
    expect(support).toContain('QAAI_AUTHENTICATION_REQUIRED');
    expect(support).not.toContain("if (operation === 'authenticateAs') return;");
  });

  it('retains Playwright and Selenium glue files alongside unsupported-operation findings', () => {
    const playwright = glueEmitters.emitPlaywrightBddGlue({ operations: ['selectEntityWhere', 'notInVocabulary'] });
    const selenium = glueEmitters.emitSeleniumBddGlue({ operations: ['selectEntityWhere', 'notInVocabulary'] });

    for (const result of [playwright, selenium]) {
      expect(result.valid).toBe(false);
      expect(result.diagnosticValid).toBe(false);
      expect(result.findings.some((f) => f.rule === 'bdd_registry_missing_operation')).toBe(true);
      expect(Object.keys(result.files).length).toBeGreaterThan(0);
      expect(Object.values(result.files).join('\n')).toContain('authoredAction');
    }
  });

  it('executes metadata-backed Selenium fallback actions and fails unsupported operations locally', () => {
    const ir = {
      version: 1,
      caseId: 'INTERNAL-UNKNOWN-OPERATION',
      authProfile: { id: 'none', strategy: 'none' },
      steps: [
        { op: 'customInteraction', action: 'click', target: 'Publish report' },
        { op: 'opaqueBrowserCommand' },
      ],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    };

    const feature = seleniumBdd.renderFeature({
      caseName: 'Publish report',
      moduleName: 'Reports',
      status: 'pass',
      envelope: { complete: true, ir },
    }, new Map());
    expect(feature).toContain('When I perform authored action "click" on "Publish report"');
    expect(feature).toContain('QAAI_UNSUPPORTED_OPERATION');
    expect(feature).toContain('When I execute authored browser operation "opaqueBrowserCommand"');

    const files = seleniumBdd.assemblePackage({ admitted: [], locators: new Map(), envVars: [] });
    const steps = Object.entries(files).find(([name]) => name.endsWith('/ReplayIrSteps.java'))?.[1] || '';
    expect(steps).toContain('el.click();');
    expect(steps).toContain('QAAI_UNSUPPORTED_AUTHORED_OPERATION');
    expect(steps).not.toContain('Assert.assertNotNull(BddWorld.driver().getTitle(), "Expected the current page to remain available for " + operation);');
  });
});
