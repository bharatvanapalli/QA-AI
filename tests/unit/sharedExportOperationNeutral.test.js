const fs = require('fs');
const path = require('path');

const exportCheckpoint = require('../../server/services/codegen/adapters/exportCheckpoint');
const operationBacked = require('../../server/services/codegen/adapters/operationBacked');

function operationResult() {
  return {
    capabilities: [],
    operationPlan: {
      status: 'incomplete',
      operations: [
        {
          operation: 'downloadFile',
          operationId: 'step-download',
          contractStepId: 'contract-download',
          sourceIndex: 0,
          params: { target: '{{reportName}}' },
          locatorProvenance: 'verified_dom_action',
          typedBindings: { reportName: { kind: 'workbook', column: 'Report Name' } },
        },
        {
          operation: 'futureWidgetAction',
          operationId: 'step-widget',
          sourceIndex: 1,
          params: { target: 'Widget control' },
          locatorProvenance: 'llm_guessed_role',
        },
        {
          operation: 'navigateToModule',
          operationId: 'transition-observed',
          sourceIndex: 2,
          authored: false,
          origin: 'observed_context_transition',
          params: { module: 'Observed destination' },
        },
      ],
      dropped: [
        {
          sourceIndex: 3,
          reason: 'No specialized adapter implementation was available.',
          rawOperation: {
            operation: 'customControlAction',
            operationId: 'step-custom',
            params: { action: 'activate', target: 'Custom control' },
            locatorProvenance: 'candidate_accessibility_role',
          },
        },
      ],
    },
  };
}

describe('shared export operation retention is website-neutral and non-blocking', () => {
  it('retains invalid generated content while returning diagnostics only', () => {
    const content = "test('retained', async ({ page }) => { const el1 = page.locator('#control'); await el1.click({ force: true }); });\n";
    const one = exportCheckpoint.checkpoint({
      path: 'tests/generated.spec.ts',
      content,
      framework: 'playwright-pom',
      strict: true,
    });

    expect(one.ok).toBe(true);
    expect(one.retained).toBe(true);
    expect(one.content).toBe(content);
    expect(one.errors.length).toBeGreaterThan(0);
    expect(one.errors.every((diagnostic) => diagnostic.severity === 'warn')).toBe(true);

    const files = {
      'tests/generated.spec.ts': content,
      'pages/GeneratedPage.ts': 'export class GeneratedPage {}\n',
    };
    const all = exportCheckpoint.checkpointAll(files, { framework: 'playwright-pom', strict: true });
    expect(all.ok).toBe(true);
    expect(all.retained).toBe(true);
    expect(all.files).toEqual(files);
    expect(all.byFile['tests/generated.spec.ts'].content).toBe(content);
  });

  it('retains authored operations and observed transitions in exact source order without a block', () => {
    const assessed = operationBacked.assessOperationPlan({ result: operationResult(), ir: {} });

    expect(assessed.mode).toBe('operationBacked');
    expect(assessed.block).toBeNull();
    expect(assessed.retained).toBe(true);
    expect(assessed.retainedOperationCount).toBe(4);
    expect(assessed.boundOperations.map((operation) => operation.operationId)).toEqual([
      'step-download',
      'step-widget',
      'transition-observed',
      'step-custom',
    ]);
    expect(assessed.boundOperations.map((operation) => operation.sourceIndex)).toEqual([0, 1, 2, 3]);
    expect(assessed.boundOperations[0]).toMatchObject({
      contractStepId: 'contract-download',
      locatorProvenance: 'verified_dom_action',
      typedBindings: { reportName: { kind: 'workbook', column: 'Report Name' } },
      authored: true,
      executable: true,
    });
    expect(assessed.boundOperations[2]).toMatchObject({ authored: false, executable: false });
    expect(assessed.findings.every((finding) => finding.severity === 'warn')).toBe(true);
  });

  it('emits every authored Playwright operation with stable IDs and localized evidence comments', () => {
    const assessed = operationBacked.assessOperationPlan({ result: operationResult(), ir: {} });
    const source = [
      "import { test, expect, type Locator, type Page } from '@playwright/test';",
      '',
      "test.describe('generated flow', () => {",
      "  test('retains operations', async ({ page }) => {",
      "      await page.screenshot({ path: 'evidence.png' });",
      '  });',
      '});',
      '',
    ].join('\n');
    const emitted = operationBacked.augmentPlaywright(source, assessed.boundOperations);

    expect(emitted).toContain('"operationId": "step-download"');
    expect(emitted).toContain('"locatorProvenance": "verified_dom_action"');
    expect(emitted).toContain('"typedBindings"');
    expect(emitted).toContain('await qaaOps("downloadFile",');
    expect(emitted).toContain('await qaaOps("futureWidgetAction",');
    expect(emitted).toContain('await qaaOps("customControlAction",');
    expect(emitted).not.toContain('await qaaOps("navigateToModule", { "module": "Observed destination" }, "transition-observed")');
    expect(emitted).toContain('Observed transition transition-observed is retained as non-authored context evidence');
    expect(emitted).toContain('llm_guessed_role evidence was used');
    expect(emitted).toContain('runtime helper reports any unsupported behavior at this exact step');
    expect(emitted.indexOf('"step-download"')).toBeLessThan(emitted.indexOf('"step-widget"'));
    expect(emitted.indexOf('"step-widget"')).toBeLessThan(emitted.indexOf('"transition-observed"'));
    expect(emitted.indexOf('"transition-observed"')).toBeLessThan(emitted.indexOf('"step-custom"'));
  });

  it('emits the same stable operation contracts for Selenium', () => {
    const assessed = operationBacked.assessOperationPlan({ result: operationResult(), ir: {} });
    const source = [
      'import org.testng.annotations.Test;',
      'import java.time.Duration;',
      'public class GeneratedTest {',
      '  public void run() throws Exception {',
      '    captureScreenshot("final");',
      '  }',
      '}',
      '',
    ].join('\n');
    const emitted = operationBacked.augmentSelenium(source, assessed.boundOperations, {});

    expect(emitted).toContain('runQaaOperation("downloadFile"');
    expect(emitted).toContain('"step-download"');
    expect(emitted).toContain('runQaaOperation("futureWidgetAction"');
    expect(emitted).toContain('runQaaOperation("customControlAction"');
    expect(emitted).toContain('Observed transition transition-observed is retained as non-authored context evidence');
    expect(emitted).not.toContain('runQaaOperation("navigateToModule", mapOf("module", "Observed destination"), "transition-observed")');
    expect(emitted).toContain('final String operationId; final String capabilityId;');
  });

  it('contains no readiness gate, certification language, domain fixture, or random element identifier', () => {
    const root = path.resolve(__dirname, '../..');
    const source = [
      fs.readFileSync(path.join(root, 'server/services/codegen/adapters/exportCheckpoint.js'), 'utf8'),
      fs.readFileSync(path.join(root, 'server/services/codegen/adapters/operationBacked.js'), 'utf8'),
    ].join('\n');

    expect(source).not.toMatch(/mode:\s*['"]blocked['"]|refusing operation-backed export|certification gate|readiness gate/i);
    expect(source).not.toMatch(/features_items|productinfo|single-products|brands_products|RootPage/i);
    expect(source).not.toMatch(/\bel\d+Locator\b|Math\.random|randomUUID/i);
  });
});
