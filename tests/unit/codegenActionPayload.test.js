import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference');
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');
const seleniumPom = require('../../server/services/codegen/adapters/seleniumPom');
const replayIrBdd = require('../../server/services/codegen/adapters/replayIrBdd');
const seleniumBdd = require('../../server/services/codegen/adapters/seleniumBddReference');

function payloadSteps() {
  return [
    { op: 'resolve', as: 'target', candidates: [{ strategy: 'css', selector: '#target' }], guessedLocator: true },
    { op: 'resolve', as: 'destination', candidates: [{ strategy: 'css', selector: '#destination' }] },
    { op: 'act', target: 'target', action: 'click', button: 'right', modifiers: ['Shift'] },
    { op: 'act', target: 'target', action: 'doubleClick', button: 'right', modifiers: ['Shift'], clickCount: 2 },
    { op: 'act', target: 'target', action: 'tripleClick', button: 'middle', modifiers: ['Control'], clickCount: 3 },
    { op: 'act', target: 'target', action: 'selectOption', valueRef: 'env:QAAI_VALUE', optionValues: ['A', 'B'] },
    { op: 'act', target: 'target', action: 'upload', valueRef: 'env:QAAI_FILE', filePaths: ['C:\\fixtures\\a.txt', 'C:\\fixtures\\b.txt'] },
    { op: 'act', target: 'target', destinationTarget: 'destination', action: 'drag' },
  ];
}

describe('ReplayIR action payload fidelity', () => {
  it('preserves modern MCP click, array, upload, and drag endpoint payloads', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'TC-PAYLOAD',
      authProfile: { id: 'none', strategy: 'none' },
      trail: [
        { tool: 'browser_click', args: { element: 'Context button', doubleClick: true, button: 'right', modifiers: ['Shift'] } },
        { tool: 'browser_select_option', args: { element: 'Regions', values: ['APAC', 'EMEA'] } },
        { tool: 'browser_file_upload', args: { element: 'Attachments', paths: ['C:\\fixtures\\a.txt', 'C:\\fixtures\\b.txt'] } },
        { tool: 'browser_drag', args: { startElement: 'Source card', startTarget: 'e10', endElement: 'Done lane', endTarget: 'e20' } },
      ],
      verdictStatus: 'pass',
    });

    const acts = emitted.ir.steps.filter((step) => step.op === 'act');
    expect(acts.find((step) => step.action === 'doubleClick')).toMatchObject({ button: 'right', modifiers: ['Shift'], clickCount: 2 });
    expect(acts.find((step) => step.action === 'selectOption').optionValues).toEqual(['APAC', 'EMEA']);
    expect(acts.find((step) => step.action === 'upload').filePaths).toEqual(['C:\\fixtures\\a.txt', 'C:\\fixtures\\b.txt']);
    expect(acts.find((step) => step.action === 'drag')).toMatchObject({ sourceRef: 'e10', destinationRef: 'e20' });
    const dragResolves = emitted.ir.steps.filter((step) => step.op === 'resolve' && /Source card|Done lane/.test(step.elementLabel || ''));
    expect(dragResolves.map((step) => step.elementLabel)).toEqual(['Done lane', 'Source card']);
  });

  it('emits exact payloads with valid Playwright reference and direct POM primitives', () => {
    const ir = { caseId: 'TC-PAYLOAD', steps: payloadSteps() };
    const click = playwrightReference.emitStep(ir.steps[2], ir);
    const doubleClick = playwrightReference.emitStep(ir.steps[3], ir);
    const tripleClick = playwrightReference.emitStep(ir.steps[4], ir);
    const select = playwrightReference.emitStep(ir.steps[5], ir);
    const upload = playwrightReference.emitStep(ir.steps[6], ir);
    expect(click).toContain('.click({"button":"right","modifiers":["Shift"]})');
    expect(doubleClick).toContain('.dblclick({"button":"right","modifiers":["Shift"]})');
    expect(tripleClick).toContain('.click({"button":"middle","modifiers":["Control"],"clickCount":3})');
    expect(select).toContain('.selectOption(["A","B"])');
    expect(upload).toContain('.setInputFiles(["C:\\\\fixtures\\\\a.txt","C:\\\\fixtures\\\\b.txt"])');

    const direct = (step) => playwrightPom._pomEmitAct(
      { ...step, locatorRecipe: { expression: 'page.locator("#target")' } },
      new Map(), false, null, new Map(), null, ir,
    );
    expect(direct(ir.steps[3])).toContain('.dblclick(');
    expect(direct(ir.steps[3])).not.toContain('.doubleClick(');
    expect(direct(ir.steps[4])).toContain('.click({"button":"middle","modifiers":["Control"],"clickCount":3})');
    expect(direct(ir.steps[6])).toContain('.setInputFiles(');
    expect(direct(ir.steps[6])).not.toContain('.upload(');

    const page = playwrightPom._emitPageFile(
      'samplePage',
      { target: { source: 'actionLocator', expr: 'page.locator("#target")' } },
      new Map([
        ['click:target', { action: 'click', name: 'target' }],
        ['selectOption:target', { action: 'selectOption', name: 'target' }],
        ['upload:target', { action: 'upload', name: 'target' }],
      ]),
    );
    expect(page).toContain('options: { button?:');
    expect(page).toContain('value: string | string[]');
    expect(page).toContain('.setInputFiles(value)');
  });

  it('emits executable Selenium reference and POM equivalents for the same payloads', () => {
    const steps = payloadSteps();
    expect(seleniumReference.emitStep(steps[2])).toContain('contextClick(target)');
    expect(seleniumReference.emitStep(steps[4])).toContain("MouseEvent('auxclick'");
    expect(seleniumReference.emitStep(steps[5])).toContain('selectByVisibleText("A")');
    expect(seleniumReference.emitStep(steps[5])).toContain('selectByVisibleText("B")');
    expect(seleniumReference.emitStep(steps[6])).toContain('C:\\\\fixtures\\\\a.txt\\nC:\\\\fixtures\\\\b.txt');

    const opts = {};
    seleniumPom.emitLocatorResolver([{ strategy: 'css', selector: '#target' }], { op: 'resolve', as: 'target' }, {}, opts);
    seleniumPom.emitLocatorResolver([{ strategy: 'css', selector: '#destination' }], { op: 'resolve', as: 'destination' }, {}, opts);
    const calls = steps.slice(2).map((step) => seleniumPom.emitStep(step, {}, opts)).join('\n');
    const support = seleniumPom.supportFiles({}, opts);
    const page = Object.entries(support).find(([name]) => name.includes('/pages/'))[1];
    expect(calls).toContain('"right", "Shift"');
    expect(calls).toContain('"A", "B"');
    expect(calls).toContain('"C:\\\\fixtures\\\\a.txt", "C:\\\\fixtures\\\\b.txt"');
    expect(page).toContain('performClick(');
    expect(page).toContain('String... values');
    expect(page).toContain('String... paths');
    expect(page).toContain('dragAndDrop(');
  });

  it('carries payloads into both BDD families and pre-arms Playwright dialogs before triggers', () => {
    const steps = payloadSteps();
    const click = steps[2];
    const dialog = { op: 'act', action: 'handleDialog', accept: true, promptText: 'approved' };
    const ir = {
      version: 1,
      caseId: 'TC-PAYLOAD',
      authProfile: { id: 'none', strategy: 'none' },
      steps: [steps[0], click, dialog, ...steps.slice(1, 2), ...steps.slice(3)],
      verdict: { status: 'pass', perAssertionOutcomes: [] },
    };
    const rendered = replayIrBdd.renderIr(ir);
    const text = rendered.lines.map((line) => line.text).join('\n');
    expect(text.indexOf('prearm the browser dialog')).toBeLessThan(text.indexOf('I click'));
    expect(text).toContain('with options');
    expect(text).toContain('select recorded options');
    expect(text).toContain('upload recorded files');
    const glue = replayIrBdd.emitGlue();
    expect(glue).toContain('await el.selectOption(values)');
    expect(glue).toContain('await el.setInputFiles(paths)');

    const feature = seleniumBdd.renderFeature({
      runResultId: 'RR-PAYLOAD', testCaseId: 'TC-PAYLOAD', status: 'pass', caseName: 'Payload fidelity', envelope: { ir },
    }, new Map());
    expect(feature).toContain('with button "right" and modifiers');
    expect(feature).toContain('select recorded values');
    expect(feature).toContain('upload recorded files');
    const seleniumPackage = seleniumBdd.assemblePackage({ admitted: [], locators: new Map(), envVars: [] });
    const stepGlue = Object.entries(seleniumPackage).find(([name]) => name.endsWith('/ReplayIrSteps.java'))[1];
    expect(stepGlue).toContain('performClick(');
    expect(stepGlue).toContain('selectRecordedValues');
    expect(stepGlue).toContain('uploadRecordedFiles');
    expect(stepGlue).toContain('sendKeys(Keys.ESCAPE)');
  });
});
