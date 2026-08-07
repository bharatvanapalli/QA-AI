import { describe, expect, it } from 'vitest';
import registry from '../../server/services/controlAdapterRegistry.js';
import controlActions from '../../server/services/controlActionAdapter.js';

describe('universal control adapter registry', () => {
  it('resolves typed control families without website knowledge', () => {
    expect(registry.resolveControlAdapter({ action: 'Fill', role: 'textbox' })).toMatchObject({
      ok: true,
      controlType: 'textbox',
      adapter: { id: 'text-input-v1', family: 'input' },
    });
    expect(registry.resolveControlAdapter({ action: 'Select', tag: 'select' })).toMatchObject({
      ok: true,
      controlType: 'native_select',
      adapter: { id: 'native-select-v1' },
    });
    expect(registry.resolveControlAdapter({ action: 'Select', controlKind: 'aria', role: 'combobox' })).toMatchObject({
      ok: true,
      controlType: 'combobox',
      adapter: { id: 'popup-choice-v1' },
    });
  });

  it('resolves date, time, toggle, disclosure, and grid adapters', () => {
    expect(registry.resolveControlAdapter({ action: 'Date', controlKind: 'semantic' }).adapter.id).toBe('date-control-v1');
    expect(registry.resolveControlAdapter({ action: 'Time', controlType: 'time_picker' }).adapter.id).toBe('time-control-v1');
    expect(registry.resolveControlAdapter({ action: 'Check', role: 'checkbox' }).adapter.id).toBe('toggle-control-v1');
    expect(registry.resolveControlAdapter({ action: 'Expand', controlType: 'accordion' }).adapter.id).toBe('disclosure-control-v1');
    expect(registry.resolveControlAdapter({ action: 'Click', role: 'grid' }).adapter.id).toBe('grid-table-v1');
  });

  it('models browser contexts as boundaries rather than fake DOM controls', () => {
    expect(registry.resolveControlAdapter({ action: 'Switch', contextKind: 'iframe' })).toMatchObject({
      ok: true,
      controlType: null,
      contextKind: 'iframe',
      adapter: { id: 'browser-context-v1', family: 'browser_context' },
    });
    expect(registry.resolveControlAdapter({ action: 'Wait', contextKind: 'new_tab' })).toMatchObject({
      ok: true,
      contextKind: 'new_tab',
      adapter: { executionSurface: 'playwright' },
    });
  });

  it('covers file transfer, drag/drop, and visual-only surfaces explicitly', () => {
    expect(registry.resolveControlAdapter({ action: 'Upload', inputType: 'file' }).adapter.id).toBe('file-transfer-v1');
    expect(registry.resolveControlAdapter({ action: 'Drag', controlType: 'drag_source' }).adapter.id).toBe('drag-drop-v1');
    expect(registry.resolveControlAdapter({ action: 'Click', tag: 'canvas' })).toMatchObject({
      ok: true,
      adapter: { id: 'canvas-visual-v1', executionSurface: 'visual_assist' },
    });
  });

  it('rejects semantically incompatible action and control pairs', () => {
    expect(registry.resolveControlAdapter({ action: 'Select', controlType: 'textbox' })).toMatchObject({
      ok: false,
      code: 'control_adapter_action_mismatch',
      controlType: 'textbox',
    });
    expect(() => registry.requireControlAdapter({ action: 'Date', controlType: 'checkbox' }))
      .toThrow(/control_adapter_action_mismatch/);
  });

  it('declares deterministic state and evidence contracts for every adapter', () => {
    const ids = registry.CONTROL_ADAPTERS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of registry.CONTROL_ADAPTERS) {
      expect(item.websiteNeutral).toBe(true);
      expect(item.stateMachine.length).toBeGreaterThan(1);
      expect(item.evidenceChannels.length).toBeGreaterThan(0);
      expect(item.postconditions.length).toBeGreaterThan(0);
    }
  });

  it('attaches the selected adapter contract to live control plans', () => {
    const fill = controlActions.buildControlActionPlan({
      action: 'Fill',
      element: 'Email address',
      role: 'textbox',
      value: 'qa@example.test',
    });
    expect(fill).toMatchObject({
      controlAdapter: { id: 'text-input-v1', controlType: 'textbox' },
      metadata: { controlAdapterId: 'text-input-v1', controlFamily: 'input', controlType: 'textbox' },
    });

    const choice = controlActions.buildControlActionPlan({
      action: 'Select',
      element: 'Equipment',
      role: 'combobox',
      controlKind: 'custom',
      value: 'LTL',
    });
    expect(choice).toMatchObject({
      controlAdapter: { id: 'popup-choice-v1', controlType: 'combobox' },
      metadata: { controlAdapterId: 'popup-choice-v1', controlFamily: 'choice' },
    });
  });

  it('keeps scroll as utility evidence instead of inventing a DOM control', () => {
    const plan = controlActions.buildControlActionPlan({ action: 'Scroll', element: 'Planning Date/Time' });
    expect(plan).toMatchObject({
      controlAdapter: { id: 'scroll-utility-v1', controlType: null },
      metadata: { controlFamily: 'utility' },
    });
  });
});
