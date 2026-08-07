import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const waits = require('../../server/services/waitContract');

describe('wait contract', () => {
  it('uses bounded navigation waits and never networkidle', () => {
    const contract = waits.buildWaitContract({ action: 'Navigate', value: 'https://example.test/users' });
    expect(contract).toMatchObject({ kind: 'navigation', armBeforeAction: true, timeoutMs: 20_000 });
    expect(JSON.stringify(contract)).not.toMatch(/networkidle|waitForTimeout/i);
  });

  it('describes value, selection, checked, popup, and download effects', () => {
    expect(waits.buildWaitContract({ action: 'Fill', element: 'Password', dataRef: 'credential.password' })).toMatchObject({ kind: 'value', sensitive: true });
    expect(waits.buildWaitContract({ action: 'Select', element: 'Country' }).kind).toBe('selection');
    expect(waits.buildWaitContract({ action: 'Check', element: 'Terms' }).kind).toBe('checked');
    expect(waits.buildWaitContract({ action: 'Popup' })).toMatchObject({ kind: 'event', armBeforeAction: true, expected: { event: 'popup' } });
    expect(waits.buildWaitContract({ action: 'Download' })).toMatchObject({ kind: 'event', armBeforeAction: true, expected: { event: 'download' } });
  });

  it('requires two equivalent successful observations at 250 ms cadence', async () => {
    const contract = waits.buildWaitContract({ action: 'Click', operationCheck: { kind: 'dialog_visible' } });
    let clock = 0;
    let reads = 0;
    const result = await waits.pollUntilStable({
      contract,
      before: { url: 'https://example.test/a', title: 'A', fields: [], controls: [] },
      observe: async () => {
        reads += 1;
        return reads === 1 ? { effects: [] } : { effect: 'dialog' };
      },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(result.matched).toBe(true);
    expect(reads).toBe(3);
    expect(clock).toBe(500);
  });

  it('returns a typed timeout reason with the last observed state', async () => {
    const contract = { ...waits.buildWaitContract({ action: 'Fill', element: 'Email' }), timeoutMs: 500 };
    let clock = 0;
    const result = await waits.pollUntilStable({
      contract,
      observe: async () => ({ valueConfirmed: false }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    expect(result).toMatchObject({ matched: false, timedOut: true });
    expect(result.reason).toContain('value_readback_not_confirmed');
    expect(result.observed).toEqual({ valueConfirmed: false });
  });

  it('does not let volatile fingerprint audit timestamps make a stable page time out', async () => {
    const contract = {
      ...waits.buildWaitContract({ action: 'WaitForState', target: 'destination page' }),
      timeoutMs: 1_000,
      pollIntervalMs: 250,
      stableObservations: 2,
    };
    const fingerprint = (observedAt) => ({
      url: 'https://example.test/destination',
      title: 'Destination',
      primaryHeading: 'Ready',
      landmarks: ['main'],
      fields: [],
      controls: [{ role: 'button', name: 'Continue' }],
      activeDialog: null,
      observedAt,
    });
    let clock = 0;
    let reads = 0;
    const result = await waits.pollUntilStable({
      contract,
      before: { fingerprint: fingerprint('2026-07-19T10:00:00.000Z') },
      observe: async () => ({
        fresh: true,
        fingerprint: fingerprint(`2026-07-19T10:00:00.${String(++reads).padStart(3, '0')}Z`),
      }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });

    expect(result).toMatchObject({ matched: true, timedOut: false, observations: 2 });
    expect(reads).toBe(2);
    expect(clock).toBe(250);
  });

  it('attaches consecutive WaitForState utilities to the next operation without emitting verdicts', () => {
    const steps = waits.attachWaitUtilitiesToSteps([
      { id: 'navigate', ordinal: 1, action: 'Navigate', value: 'https://example.test' },
      {
        id: 'wait-page',
        ordinal: 2,
        action: 'WaitForState',
        target: 'destination page',
        sourceQuote: 'Wait for the destination page.',
        sourceClauseRefs: ['clause-2'],
      },
      {
        id: 'wait-button',
        ordinal: 3,
        action: 'WaitForState',
        target: 'Continue button',
        sourceQuote: 'Wait until Continue is visible.',
        sourceClauseRefs: ['clause-3'],
      },
      { id: 'continue', ordinal: 4, action: 'Click', target: 'Continue button' },
    ]);

    expect(steps[1]).toMatchObject({
      runtimeUtility: true,
      executionRole: 'synchronization',
      emitsStepVerdict: false,
      verdictPolicy: 'none',
      attachedToStepId: 'continue',
    });
    expect(steps[2]).toMatchObject({
      runtimeUtility: true,
      emitsStepVerdict: false,
      attachedToStepId: 'continue',
    });
    expect(steps[3].preconditionWaitUtilities).toHaveLength(2);
    expect(steps[3].preconditionWaitUtilities[0]).toMatchObject({
      schema: waits.WAIT_UTILITY_SCHEMA,
      waitStepId: 'wait-page',
      sourceQuote: 'Wait for the destination page.',
      sourceClauseRefs: ['clause-2'],
      emitsStepVerdict: false,
    });
    expect(steps[3].preconditionWaitUtilities[1]).toMatchObject({
      waitStepId: 'wait-button',
      sourceClauseRefs: ['clause-3'],
    });
    expect(steps[0].preconditionWaitUtilities).toBeUndefined();
  });
});
