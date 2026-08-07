import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const frameworkAdapter = require('../../server/services/codegen/adapters/frameworkAdapter');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');
const seleniumPom = require('../../server/services/codegen/adapters/seleniumPom');
const seleniumBdd = require('../../server/services/codegen/adapters/seleniumBddReference');

function verifiedCss(selector, label = 'Recorded control') {
  const source = 'verified_mcp_accessibility_snapshot';
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: source,
    evidenceSource: source,
    expression: `locator(${JSON.stringify(selector)})`,
    frameworkExpressions: {
      playwright: `locator(${JSON.stringify(selector)})`,
      selenium: `By.cssSelector(${JSON.stringify(selector)})`,
    },
    strategy: 'css',
    elementLabel: label,
    proof: { source, verified: true, sameElement: true, count: 1, visible: true, enabled: true },
    domAtlas: { verifiedActions: [{ action: 'interact', selector }] },
  };
}

function neutralIr() {
  return {
    version: 1,
    caseId: 'internal-case-reference',
    title: 'Update account preferences',
    authProfile: { id: 'existing-session', strategy: 'existing_session' },
    steps: [
      {
        op: 'resolve',
        as: 'el1',
        elementLabel: 'Account name',
        actionLocator: verifiedCss('#account-name', 'Account name'),
        candidates: [{ strategy: 'role', role: 'textbox', name: 'Account name' }],
      },
      {
        op: 'act', action: 'fill', target: 'el1', rawValue: 'Primary account',
        valueBinding: { kind: 'literal', value: 'Primary account' },
      },
      {
        op: 'resolve',
        as: 'node_2',
        elementLabel: 'Save changes',
        candidates: [{ strategy: 'role', role: 'button', name: 'Save changes' }],
      },
      { op: 'act', action: 'click', target: 'node_2' },
      { op: 'waitFor', condition: { kind: 'visible', target: 'node_2', timeoutMs: 4321 } },
      {
        op: 'act',
        action: 'navigate',
        contextSwitchInferred: true,
        url: 'https://identity.example.test/oauth/authorize?nonce=secret&state=volatile',
      },
      {
        op: 'assert', channel: 'UI_TEXT', expected: 'Preferences saved', contractRef: 'preferences-saved',
        expectedBinding: { kind: 'literal', value: 'Preferences saved' },
      },
    ],
    verdict: { status: 'pass', perAssertionOutcomes: [] },
  };
}

describe('website-neutral Selenium lowering', () => {
  it('uses exact verified evidence without broadening and preserves authored executable order', () => {
    const ir = neutralIr();
    const compiled = frameworkAdapter.compileReplayIR(seleniumReference, ir);
    const source = compiled.files[compiled.layout.testFile];

    expect(source).toContain('LocatorCandidate.css("#account-name")');
    expect(source).not.toContain('LocatorCandidate.role("textbox", "Account name")');
    expect(source.indexOf('accountNameField.sendKeys("Primary account")')).toBeGreaterThan(-1);
    expect(source.indexOf('saveChangesButton.click()')).toBeGreaterThan(source.indexOf('accountNameField.sendKeys'));
    expect(source.indexOf('Duration.ofMillis(4321)')).toBeGreaterThan(source.indexOf('saveChangesButton.click()'));
    expect(source.indexOf('QAAI_OBSERVED_NAVIGATION')).toBeGreaterThan(source.indexOf('Duration.ofMillis(4321)'));
    expect(source.indexOf('seesText("Preferences saved")')).toBeGreaterThan(source.indexOf('QAAI_OBSERVED_NAVIGATION'));
    expect(source).not.toContain('driver.get("https://identity.example.test/oauth/authorize');
    expect(source).toContain('urlContains("/oauth/authorize")');
    expect(source).not.toMatch(/nonce|state=|volatile/);
    expect(source).not.toMatch(/\bel1\b|node_2|internal-case-reference/);
  });

  it('keeps unverified locators executable with local provenance and semantic repeated-field names', () => {
    const ir = { caseId: 'internal', title: 'Enter contact details', steps: [] };
    const opts = { className: 'ContactDetailsTest', adapterFindings: [] };
    seleniumPom.emitSetup(ir, opts);
    const first = {
      op: 'resolve', as: 'field_1', elementLabel: 'Email address',
      actionLocator: verifiedCss('#primary-email', 'Email address'),
      candidates: [{ strategy: 'role', role: 'textbox', name: 'Email address' }],
    };
    const second = {
      op: 'resolve', as: 'field_2', elementLabel: 'Email address',
      candidates: [{ strategy: 'role', role: 'textbox', name: 'Email address' }],
    };
    seleniumPom.emitLocatorResolver(first.candidates, first, { ...ir, steps: [first] }, opts);
    seleniumPom.emitLocatorResolver(second.candidates, second, { ...ir, steps: [second] }, opts);
    seleniumPom.emitStep({ op: 'act', action: 'fill', target: 'field_1', rawValue: 'first value' }, ir, opts);
    seleniumPom.emitStep({ op: 'act', action: 'fill', target: 'field_2', rawValue: 'second value' }, ir, opts);
    const files = seleniumPom.supportFiles(ir, opts);
    const output = Object.values(files).join('\n');

    expect(output).toContain('LocatorCandidate.css("#primary-email")');
    expect(output).not.toContain('LocatorCandidate.role("textbox", "Email address"), LocatorCandidate.css("#primary-email")');
    expect(output.match(/QAAI_GUESSED_LOCATOR/g)).toHaveLength(1);
    expect(output).toContain('candidate locator evidence was not action-time verified');
    expect(output).toContain('emailAddressInput');
    expect(output).toContain('secondEmailAddressInput');
    expect(output).not.toMatch(/emailAddressInput2|field_1|field_2|person@example/i);
    expect(output).toContain('fillEmailAddress');
    expect(output).toContain('fillSecondEmailAddress');
  });

  it('keeps a wait-only guessed-locator warning centralized while preserving the executable wait', () => {
    const ir = { caseId: 'wait-only-case', title: 'Wait for arbitrary status', steps: [] };
    const opts = { className: 'WaitOnlyCaseTest', adapterFindings: [] };
    seleniumPom.emitSetup(ir, opts);
    const waitCode = seleniumPom.emitWait(
      { kind: 'visible', target: 'arbitrary-status-region', timeoutMs: 2468 },
      { op: 'waitFor', condition: { kind: 'visible', target: 'arbitrary-status-region', timeoutMs: 2468 } },
      ir,
      opts,
    );
    const output = Object.values(seleniumPom.supportFiles(ir, opts)).join('\n');
    const methodMatch = waitCode.match(/visibilityOf\(page\.([A-Za-z_$][A-Za-z0-9_$]*)\(\)\)/);

    expect(waitCode).not.toContain('QAAI_GUESSED_LOCATOR');
    expect(waitCode).toContain('Duration.ofMillis(2468)');
    expect(methodMatch).toBeTruthy();
    expect(output.match(/QAAI_GUESSED_LOCATOR/g)).toHaveLength(1);
    expect(output).toContain('authored wait target had no action-time verified DOM locator');
    expect(output).toContain(`public WebElement ${methodMatch[1]}()`);
  });

  it('consumes all six typed binding kinds without empty or cross-case workbook fallbacks', () => {
    const opts = { dataCaseSlug: 'account-data' };
    seleniumReference.emitDataProvider([
      { index: 0, label: 'Account row', fields: { Account: 'A-100' } },
    ], {}, opts);
    const expression = (binding, expected = false) => seleniumReference.bindingExpression({
      target: 'account field',
      rawValue: expected ? undefined : 'raw',
      expected: expected ? 'expected' : undefined,
      ...(expected ? { expectedBinding: binding } : { valueBinding: binding }),
    }, opts, {}, expected).expression;

    expect(expression({ kind: 'literal', value: 'inline value' })).toBe('"inline value"');
    expect(expression({ kind: 'secret_env', reference: 'env:QAAI_ACCOUNT_SECRET' })).toBe('EnvReader.required("QAAI_ACCOUNT_SECRET")');
    expect(expression({ kind: 'workbook_column', sheet: 'Accounts', column: 'Account', usableRowCount: 1 })).toBe('DataReader.required(row, "Account")');
    expect(expression({ kind: 'runtime_output', reference: 'runtime:created_id' })).toContain('EnvReader.required("QAAI_RUNTIME_OUTPUT_CREATED_ID")');
    expect(expression({ kind: 'dependency_output', reference: 'dependency:login.session' })).toContain('EnvReader.required("QAAI_DEPENDENCY_OUTPUT_LOGIN_SESSION")');
    expect(expression({ kind: 'generated_value', reference: 'generated:uuid' })).toContain('EnvReader.required("QAAI_GENERATED_VALUE_UUID")');

    const unproven = expression({ kind: 'workbook_column', sheet: 'Other case', column: 'Account', usableRowCount: 0 });
    expect(unproven).toContain('EnvReader.required(');
    expect(unproven).not.toContain('row');
    expect(unproven).not.toBe('""');
  });

  it('emits BDD exact and guessed locators, typed values, and observed navigation without empty examples', () => {
    const ir = neutralIr();
    ir.dataRows = [{ index: 0, label: 'Incomplete row', fields: { Other: 'not-this-case' } }];
    ir.steps[1].valueBinding = { kind: 'workbook_column', sheet: 'Accounts', column: 'Account', usableRowCount: 1 };
    const result = {
      runId: 'internal-run', runResultId: 'internal-result', testCaseId: 'internal-case',
      caseName: ir.title, moduleName: 'Account settings', status: 'pass',
      envelope: { complete: true, ir },
    };
    const locators = new Map();
    const feature = seleniumBdd.renderFeature(result, locators, { locatorScope: 'account-preferences' });
    const files = seleniumBdd.assemblePackage({ admitted: [], locators, envVars: [] });
    const catalog = Object.entries(files).find(([name]) => name.endsWith('/LocatorCatalog.java'))?.[1] || '';
    const glue = Object.entries(files).find(([name]) => name.endsWith('/ReplayIrSteps.java'))?.[1] || '';

    expect(catalog).toContain('LocatorCandidate.css("#account-name")');
    expect(feature).toContain('QAAI_GUESSED_LOCATOR');
    expect(feature).toContain('fill "Account name" with env "QAAI_WORKBOOK_COLUMN_ACCOUNT"');
    expect(feature).not.toContain('Examples:');
    expect(feature).not.toContain('<Account>');
    expect(feature).toContain('QAAI_OBSERVED_NAVIGATION');
    expect(feature).toContain('browser should already be at URL containing "/oauth/authorize"');
    expect(feature).not.toContain('I open "https://identity.example.test/oauth/authorize');
    expect(glue).toContain('browserShouldAlreadyBeAtUrl');
  });

  it('contains no injected website or business-domain templates', () => {
    const ir = neutralIr();
    const compiled = frameworkAdapter.compileReplayIR(seleniumReference, ir);
    const refOutput = Object.values(compiled.files).join('\n');
    const opts = { className: 'NeutralCaseTest', adapterFindings: [] };
    seleniumPom.emitSetup(ir, opts);
    for (const step of ir.steps) {
      if (step.op === 'resolve') seleniumPom.emitLocatorResolver(step.candidates, step, ir, opts);
      if (step.op === 'act') seleniumPom.emitStep(step, ir, opts);
    }
    const pomOutput = Object.values(seleniumPom.supportFiles(ir, opts)).join('\n');
    expect(`${refOutput}\n${pomOutput}`).not.toMatch(/features_items|brands_products|product grid|price range|selectBrand|searchForProduct/i);
  });
});
