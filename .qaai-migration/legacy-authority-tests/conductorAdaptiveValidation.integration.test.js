import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const waitContract = require('../../server/services/waitContract');
const mcp = require('../../server/services/mcp');

function loadAdaptivePolicy() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../server/services/agents/conductor.js'),
    'utf8',
  );
  const start = source.indexOf('async function validateSnapshotAdaptivePolicy');
  const end = source.indexOf('\nasync function drainExecutionFixedPoint', start);
  if (start < 0 || end < 0) throw new Error('adaptive validation policy source not found');
  const context = {
    waitContract,
    setTimeout,
    module: { exports: null },
  };
  vm.runInNewContext(
    `${source.slice(start, end)}\nmodule.exports = validateSnapshotAdaptivePolicy;`,
    context,
  );
  return context.module.exports;
}

function fakeClock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

describe('Conductor adaptive validation integration contract', () => {
  const validate = loadAdaptivePolicy();

  it('returns immediately from valid cached evidence', async () => {
    let refreshCalls = 0;
    const clock = fakeClock();
    const result = await validate({
      cachedSnapshot: '- textbox "Email Address" [ref=e1]',
      refreshSnapshot: async () => {
        refreshCalls += 1;
        return { text: '', fresh: false };
      },
      probe: (text) => text.includes('Email Address'),
      validationContract: { timeoutMs: 10_000, pollIntervalMs: 250, stableObservations: 2 },
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({ matched: true, source: 'cached', freshSnapshotAttempts: 0 });
    expect(refreshCalls).toBe(0);
  });

  it('requires two equivalent fresh matches and returns early', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await validate({
      cachedSnapshot: '- heading "Welcome" [ref=e1]',
      refreshSnapshot: async () => {
        calls += 1;
        return { text: '- textbox "Email Address" [ref=e2]', fresh: true };
      },
      probe: (text) => text.includes('Email Address'),
      validationContract: { timeoutMs: 10_000, pollIntervalMs: 250, stableObservations: 2 },
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({
      matched: true,
      source: 'fresh_stable',
      consecutiveMatches: 2,
      freshSnapshotAttempts: 2,
    });
    expect(calls).toBe(2);
    expect(result.durationMs).toBeLessThan(10_000);
  });

  it('classifies an unavailable evidence stream as QAAI uncheckable', async () => {
    const clock = fakeClock();
    const result = await validate({
      cachedSnapshot: '',
      refreshSnapshot: async () => ({ text: '', fresh: false, reason: 'snapshot_timeout' }),
      probe: () => false,
      validationContract: { timeoutMs: 500, pollIntervalMs: 250, stableObservations: 2 },
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(result).toMatchObject({
      matched: false,
      uncheckable: true,
      qaaiEvidenceError: true,
      reason: 'qaai_validation_snapshot_unavailable',
    });
  });

  it('routes Conductor validation snapshots through two stable MCP observations', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await mcp.snapshot({}, {
      source: 'single_pass_validation_snapshot',
      validationBudgetMs: 10_000,
      pollIntervalMs: 250,
      stableObservations: 2,
      qaaiNow: clock.now,
      qaaiSleep: clock.sleep,
      qaaiObserve: async () => {
        calls += 1;
        return { text: '- textbox "Email Address" [ref=e1]', isError: false };
      },
    });

    expect(result.error).toBeNull();
    expect(result.qaaiValidation).toMatchObject({
      source: 'single_pass_validation_snapshot',
      status: 'stable',
      attempts: 2,
      stableObservations: 2,
    });
    expect(calls).toBe(2);
  });

  it('uses navigation, assertion, and stabilization default budgets', () => {
    expect(mcp.validationSnapshotBudgetMs({ lastSnapshotOriginatingTool: 'browser_navigate' })).toBe(20_000);
    expect(mcp.validationSnapshotBudgetMs({ lastSnapshotOriginatingTool: 'browser_click' })).toBe(10_000);
    expect(mcp.validationSnapshotBudgetMs({ lastSnapshotOriginatingTool: 'browser_wait' })).toBe(5_000);
  });
});
