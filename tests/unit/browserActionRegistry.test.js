import { describe, expect, it } from 'vitest';
import registry from '../../server/services/browserActionRegistry.js';
import pipelineContract from '../../server/services/pipelineContract.js';
import replayEmitter from '../../server/services/codegen/replayEmitter.js';
import actionLocatorResolver from '../../server/services/actionLocatorResolver.js';

describe('browser action registry', () => {
  it('keeps every registered action contract-valid', () => {
    expect(registry.validateRegistry()).toEqual([]);
  });

  it('drives step completion classes from the shared registry', () => {
    expect(registry.toolsForStepClass('fill').has('deterministic_dom_fill')).toBe(true);
    expect(registry.toolsForStepClass('click').has('deterministic_dom_click')).toBe(true);
    expect(registry.toolsForStepClass('select').has('deterministic_dom_select')).toBe(true);

    expect(pipelineContract.toolCanCompleteStep('deterministic_dom_fill', { action: 'Fill', element: 'Username' })).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('deterministic_dom_click', { action: 'Click', element: 'Save' })).toBe(true);
    expect(pipelineContract.toolCanCompleteStep('deterministic_dom_select', { action: 'Select', element: 'Status' })).toBe(true);
  });

  it('makes deterministic runtime actions visible to ReplayIR codegen', () => {
    expect(replayEmitter.TOOL_ACTION.deterministic_dom_fill).toBe('fill');
    expect(replayEmitter.TOOL_ACTION.deterministic_dom_click).toBe('click');
    expect(replayEmitter.TOOL_ACTION.deterministic_dom_select).toBe('selectOption');
  });

  it('registers selector waits as an exportable waitFor operation', () => {
    const wait = registry.getActionEntry('browser_wait_for_selector');

    expect(wait).toMatchObject({
      canonicalAction: 'wait',
      exportable: true,
      replayIrMapping: 'waitFor',
      kind: 'action',
    });
    expect(registry.toolsForStepClass('wait').has('browser_wait_for_selector')).toBe(true);
    expect(registry.replayToolActionMap().browser_wait_for_selector).toBe('waitFor');
    expect(replayEmitter.TOOL_ACTION.browser_wait_for_selector).toBe('waitFor');

    const emitted = replayEmitter.buildReplayIR({
      caseId: 'selector-wait-runtime',
      title: 'Wait for dashboard content',
      trail: [{
        tool: 'browser_wait_for_selector',
        ok: true,
        args: { element: 'Dashboard content', state: 'visible', timeoutMs: 4_321 },
        pageUrl: 'https://example.test/dashboard',
        contractStepId: 'selector-wait-runtime:step:1',
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });
    const waitStep = emitted.ir.steps.find((step) => step.op === 'waitFor');
    const waitTarget = waitStep?.condition?.target;

    expect(waitStep).toMatchObject({
      op: 'waitFor',
      condition: {
        kind: 'visible',
        timeoutMs: 4_321,
      },
    });
    expect(waitTarget).toBeTruthy();
    expect(emitted.ir.steps.some((step) => step.op === 'waitFor' && step.condition?.target === waitTarget)).toBe(true);
    expect(emitted.ir.steps.some((step) => step.op === 'act' && step.action === 'waitFor')).toBe(false);
  });

  it('preserves exact runtime operation names and the actual authored wait tool', () => {
    expect(registry.replayToolActionMap()).toMatchObject({
      browser_navigate_back: 'navigateBack',
      browser_navigate_forward: 'navigateForward',
      browser_double_click: 'doubleClick',
      browser_triple_click: 'tripleClick',
      browser_type: 'type',
      browser_select_option: 'selectOption',
      browser_uncheck: 'uncheck',
      browser_handle_dialog: 'handleDialog',
      browser_resize: 'resize',
      browser_close: 'close',
      browser_wait_for: 'waitFor',
    });
    expect(registry.isUtilityTool('browser_wait_for')).toBe(false);
    expect(registry.toolsForStepClass('wait').has('browser_wait_for')).toBe(true);
  });

  it('keeps coordinate and scroll operations diagnostic until exact replay proof exists', () => {
    for (const tool of ['browser_mouse_click', 'browser_click_xy', 'browser_scroll']) {
      const action = registry.getActionEntry(tool);
      expect(action).toMatchObject({
        exportable: false,
        codegenFallback: registry.CODEGEN_FALLBACKS.EMIT_FIXME,
      });
      expect(registry.replayToolActionMap()[tool]).toBeUndefined();
    }
  });

  it('requires non-exportable runtime actions to declare an explicit preview fallback', () => {
    const vision = registry.getActionEntry('vision_click_canvas');
    expect(vision.exportable).toBe(false);
    expect(vision.codegenFallback).toBe(registry.CODEGEN_FALLBACKS.EMIT_FIXME);
    expect(replayEmitter.TOOL_ACTION.vision_click_canvas).toBeUndefined();
  });

  it('registers every mutating browser runtime tool known to locator resolution', () => {
    for (const tool of actionLocatorResolver.MUTATING_ELEMENT_TOOLS) {
      const entry = registry.getActionEntry(tool);
      expect(entry, `${tool} must be present in the browser action contract`).toBeTruthy();
      expect(entry.codegenFallback, `${tool} must declare a codegen fallback`).toBeTruthy();
    }
  });

  it('collects both drag endpoint refs at action time', () => {
    expect(actionLocatorResolver.targetRefsForTool('browser_drag', {
      startTarget: 'e10',
      startElement: 'Source card',
      endTarget: 'e20',
      endElement: 'Destination lane',
    })).toEqual([
      expect.objectContaining({ endpoint: 'source', ref: 'e10', element: 'Source card' }),
      expect.objectContaining({ endpoint: 'target', ref: 'e20', element: 'Destination lane' }),
    ]);
  });

  it('turns unknown runtime actions into explicit certification gaps', () => {
    const emitted = replayEmitter.buildReplayIR({
      caseId: 'unknown-action',
      title: 'Unknown action cannot be certified',
      trail: [{
        tool: 'browser_future_click',
        ok: true,
        args: { element: 'Save' },
        pageUrl: 'https://example.test/form',
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });

    expect(emitted.complete).toBe(false);
    expect(emitted.gaps.some((gap) => gap.code === 'unregistered_runtime_action')).toBe(true);
    expect(emitted.findings.some((finding) => finding.code === 'unregistered_runtime_action')).toBe(true);
  });
});
