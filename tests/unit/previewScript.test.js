import { describe, expect, it } from 'vitest';
import previewScript from '../../server/services/codegen/previewScript.js';

describe('preview script generation', () => {
  it('keeps non-exportable vision actions enabled with a semantic guessed locator', () => {
    const result = previewScript.buildPreviewScript({
      title: 'Canvas save action',
      trail: [{ tool: 'vision_click_canvas', args: { element: 'Save canvas button' } }],
    });

    expect(result.certificationStatus).toBe('preview_not_certified');
    expect(result.status).toBe('preview_available');
    expect(result.code).not.toContain('test.fixme');
    expect(result.code).toContain('QAAI_GUESSED_LOCATOR');
    expect(result.code).toContain('getByRole("button"');
    expect(result.code).toContain('Save canvas button');
    expect(result.runnable).toBe(true);
    expect(result.findings[0]).toMatchObject({
      tool: 'vision_click_canvas',
      codegenFallback: 'emit_fixme',
      certified: false,
    });
  });

  it('keeps unknown runtime actions enabled with an explicit soft diagnostic', () => {
    const result = previewScript.buildPreviewScript({
      title: 'Unknown action',
      trail: [{ tool: 'mystery_click' }],
    });

    expect(result.certificationStatus).toBe('preview_not_certified');
    expect(result.code).toContain('runtime action "mystery_click" is not registered');
    expect(result.code).toContain('expect.soft(false');
    expect(result.code).not.toContain('test.fixme');
    expect(result.findings[0].status).toBe('preview_available');
    expect(result.findings[0].runnable).toBe(true);
  });

  it('escapes regular-expression punctuation in semantic guessed locators', () => {
    const result = previewScript.buildPreviewScript({
      title: 'Special label',
      trail: [{ tool: 'vision_click_canvas', args: { element: 'Save [primary] (canvas)' } }],
    });

    expect(result.code).toContain('Save \\\\[primary\\\\] \\\\(canvas\\\\)');
    expect(result.code).not.toContain('test.fixme');
  });
});
