import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');

const LOGIN = [
  '### Page',
  '- heading "Sign in" [ref=e1]',
  '- textbox "Email" [ref=e2]',
  '- button "Next" [ref=e3]',
].join('\n');

const DASHBOARD = [
  '### Page',
  '- heading "Dashboard" [ref=e10]',
  '- main "Application dashboard" [ref=e11]',
].join('\n');

function resultSnapshot(text) {
  return { isError: false, content: [{ type: 'text', text }] };
}

function parse(result) {
  return JSON.parse(result.content[0].text);
}

function sessionWith(snapshot, callTool) {
  return {
    id: 'validation-latency-test',
    lastSnapshot: snapshot,
    refRoleMap: mcp.buildRefRoleMap(snapshot),
    currentUrl: 'https://example.test/current',
    visitedUrls: new Set(),
    broadcast: () => {},
    client: { callTool },
  };
}

describe('MCP validation snapshot latency contract', () => {
  it('takes exactly one bounded explicit snapshot when stability is skipped for validation', async () => {
    const calls = [];
    const session = sessionWith(LOGIN, async (request, _schema, requestOptions) => {
      calls.push({ request, requestOptions });
      return resultSnapshot(DASHBOARD);
    });

    const out = await mcp.snapshot(session, {
      skipSnapshotStability: true,
      timeoutMs: 750,
      strictActionEvidence: false,
      telemetry: false,
      source: 'unit_validation_snapshot',
    });

    expect(out.error).toBeNull();
    expect(out.text).toContain('Dashboard');
    expect(calls).toHaveLength(1);
    expect(calls[0].request.name).toBe('browser_snapshot');
    expect(calls[0].requestOptions.timeout).toBe(750);
    expect(session.lastSnapshot).toBe(DASHBOARD);
    expect(session.refRoleMap.get('e10')?.role).toBe('heading');
  });

  it('never lets the validation skip option bypass mutating-action stabilization', async () => {
    const calls = [];
    const session = sessionWith(LOGIN, async ({ name }) => {
      calls.push(name);
      return resultSnapshot(DASHBOARD);
    });

    const out = await mcp.callTool(session, 'browser_click', {
      element: 'Next',
      target: 'e3',
    }, {
      skipSnapshotStability: true,
      strictActionEvidence: false,
      telemetry: false,
    });

    expect(out.isError).not.toBe(true);
    expect(calls[0]).toBe('browser_tabs');
    expect(calls.indexOf('browser_click')).toBeGreaterThan(0);
    expect(calls.indexOf('browser_tabs')).toBeLessThan(calls.indexOf('browser_click'));
    expect(calls.filter((name) => name === 'browser_snapshot')).toHaveLength(1);
  });

  it('accepts matching cached action evidence without any fresh snapshot call', async () => {
    let calls = 0;
    const session = sessionWith(DASHBOARD, async () => {
      calls += 1;
      return resultSnapshot(DASHBOARD);
    });

    const out = parse(await mcp.callTool(session, 'assertion_check', { expectedText: 'Dashboard' }));

    expect(out.matched).toBe(true);
    expect(out.validationAttempts).toBe(1);
    expect(out.freshSnapshotAttempted).toBe(false);
    expect(calls).toBe(0);
  });

  it('uses one bounded fresh snapshot after a cached miss and does not poll or sleep', async () => {
    const calls = [];
    const session = sessionWith(LOGIN, async (request, _schema, requestOptions) => {
      calls.push({ request, requestOptions });
      return resultSnapshot(DASHBOARD);
    });
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    let out;
    let timerDelays;
    try {
      out = parse(await mcp.callTool(session, 'assertion_check', { expectedText: 'Dashboard' }));
      timerDelays = timeoutSpy.mock.calls.map((call) => call[1]);
    } finally {
      timeoutSpy.mockRestore();
    }

    expect(out.matched).toBe(true);
    expect(out.validationAttempts).toBe(2);
    expect(out.freshSnapshotAttempted).toBe(true);
    expect(out.freshSnapshotAcquired).toBe(true);
    expect(out.pollCapped).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].request.name).toBe('browser_snapshot');
    expect(calls[0].requestOptions.timeout).toBeGreaterThanOrEqual(250);
    expect(calls[0].requestOptions.timeout).toBeLessThanOrEqual(5_000);
    // The sole timer is the hard request-timeout guard. No 600ms stability
    // sleep or 1000ms assertion-poll sleep may be scheduled.
    expect(timerDelays).toEqual([
      calls[0].requestOptions.timeout,
    ]);
  });

  it('preserves the last good cache and treats a failed fresh read as uncheckable', async () => {
    let calls = 0;
    const session = sessionWith(LOGIN, async () => {
      calls += 1;
      return { isError: true, content: [{ type: 'text', text: 'snapshot timeout' }] };
    });

    const out = parse(await mcp.callTool(session, 'assertion_check', { expectedText: 'Dashboard' }));

    expect(out.matched).toBe(false);
    expect(out.reason).toBe('transient_snapshot_timeout');
    expect(out.freshSnapshotAttempted).toBe(true);
    expect(out.freshSnapshotAcquired).toBe(false);
    expect(out.pollCapped).toBeUndefined();
    expect(calls).toBe(1);
    expect(session.lastSnapshot).toBe(LOGIN);
  });

  it('applies the same cached-then-one-fresh limit to PAGE assertions', async () => {
    let calls = 0;
    const session = sessionWith(LOGIN, async () => {
      calls += 1;
      return resultSnapshot(DASHBOARD);
    });

    const out = parse(await mcp.checkAssertion(session, {
      pageAssertion: {
        pageName: 'dashboard',
        expectedSignals: { role: [{ role: 'heading', name: 'Dashboard' }] },
      },
    }));

    expect(out.matched).toBe(true);
    expect(calls).toBe(1);
  });
});
