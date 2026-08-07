import { createRequire } from 'node:module';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp');
const executionJournal = require('../../server/services/executionJournal');
const widgetExecutionKernel = require('../../server/services/widgetExecutionKernel');

describe('generic operational evidence semantics', () => {
  it('recognizes changed option content even when the overlay role count is unchanged', () => {
    const before = '- listbox "Choices"\n  - option "Old"';
    const after = '- listbox "Choices"\n  - option "New"';

    expect(widgetExecutionKernel.detectOverlayDelta(before, after)).toMatchObject({
      beforeCount: 2,
      afterCount: 2,
      newOptions: ['New'],
      matched: true,
    });
  });

  it('preserves exact trigger menu state returned by the browser readback probe', async () => {
    let evaluateArgs = null;
    const state = await widgetExecutionKernel.evaluateRefState({
      session: { id: 'session' },
      ref: 'equipment-trigger',
      elementLabel: 'Equipment',
      mcp: {
        callTool: async (_session, _toolName, args) => {
          evaluateArgs = args;
          return { content: [{ text: JSON.stringify({ ok: true, menuOpen: true, ariaExpanded: 'true' }) }] };
        },
      },
    });

    expect(evaluateArgs.function).toContain("attr(menuTrigger, 'aria-expanded')");
    expect(evaluateArgs).toMatchObject({ ref: 'equipment-trigger', element: 'Equipment' });
    expect(state).toMatchObject({ ok: true, menuOpen: true, ariaExpanded: 'true' });
  });

  it('hardens blocked-field probes to exact before/after readback and restores mutations', () => {
    const oldProbe = `async () => {
      const expected = clean(payload.expectedValue);
      const expectedStillPresent = expected ? clean(after).toLowerCase() === expected.toLowerCase() || clean(before).toLowerCase() === expected.toLowerCase() : true;
      return { ok: expectedStillPresent, reason: expectedStillPresent ? 'probe_rejected_or_value_unchanged' : 'unexpected_value_after_probe', fieldLabel: best.text || payload.fieldLabel, before, after, probeValue: payload.probeValue, expectedValue: expected };
    }`;

    const hardened = mcp.hardenFieldBlockedProbeSource(oldProbe);

    expect(hardened).not.toContain('expectedStillPresent');
    expect(hardened).toContain("const unchanged = String(after == null ? '' : after) === String(before == null ? '' : before)");
    expect(hardened).toContain('setValue(node, before)');
    expect(hardened).toContain("reason: unchanged ? 'probe_rejected_value_unchanged' : 'field_value_changed_after_probe'");

    const liveConductorSource = fs.readFileSync('server/services/agents/conductor.js', 'utf8');
    expect(liveConductorSource).toContain('const expectedStillPresent = expected ?');
    const hardenedLiveProbe = mcp.hardenFieldBlockedProbeSource(liveConductorSource);
    expect(hardenedLiveProbe).not.toContain('const expectedStillPresent = expected ?');
    expect(hardenedLiveProbe).toContain("reason: unchanged ? 'probe_rejected_value_unchanged' : 'field_value_changed_after_probe'");
  });

  it('records semantic-only tooltip proof as a failed visual assertion and continues', () => {
    const mcpSource = fs.readFileSync('server/services/mcp.js', 'utf8');
    const hoverStart = mcpSource.indexOf('async function paintHoverVisualPreview');
    const hoverEnd = mcpSource.indexOf('// Pull the snapshot ref token', hoverStart);
    const hoverHelper = mcpSource.slice(hoverStart, hoverEnd);
    expect(hoverHelper).not.toContain("preview = document.createElement('div')");
    expect(hoverHelper).toContain("source: 'app_tooltip_visible'");
    expect(hoverHelper).toContain("source: hasWanted(label) ? 'hover_target_semantic_attribute' : 'app_tooltip_not_visible'");

    let rows = executionJournal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'tooltip', action: 'Verify', element: 'Orders tooltip' },
        { id: 'open', action: 'Click', element: 'Orders menu' },
      ],
    });
    rows = executionJournal.recordActionOutcome(rows, 'tooltip', { outcome: 'succeeded' });
    rows = executionJournal.recordAssertionOutcome(rows, 'tooltip', {
      outcome: 'matched',
      matched: true,
      blocking: false,
      evidence: 'Hovered "Orders"; tooltip text "Orders" was present semantically in DOM/accessibility via hover_target_semantic_attribute, but no rendered visual bubble was captured.',
    });

    expect(rows[0]).toMatchObject({
      status: 'fail',
      actionOutcome: 'succeeded',
      assertionOutcome: 'not_matched',
      continuationOutcome: 'continue',
      failureImpact: 'validation_only',
    });
    expect(rows[0].assertionOutcomes.at(-1)).toMatchObject({
      matched: false,
      visualMatched: false,
      semanticMatched: true,
      semanticOnlyVisualEvidence: true,
      reason: 'tooltip_semantic_only_no_visual',
    });
    expect(executionJournal.selectNextRunnableStep(rows)?.stepId).toBe('open');
  });

  it('keeps genuine rendered tooltip evidence matched', () => {
    let rows = executionJournal.initializeExecutionJournal({
      approvedSteps: [{ id: 'tooltip', action: 'Verify', element: 'Orders tooltip' }],
    });
    rows = executionJournal.recordActionOutcome(rows, 'tooltip', { outcome: 'succeeded' });
    rows = executionJournal.recordAssertionOutcome(rows, 'tooltip', {
      outcome: 'matched',
      matched: true,
      evidence: 'Hovered "Orders"; tooltip text "Orders" was observed via visible_tooltip_dom.',
    });

    expect(rows[0]).toMatchObject({ status: 'pass', assertionOutcome: 'matched' });
  });
});
