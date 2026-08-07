import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe('MCP scheduler', () => {
  it('drops background screenshots while a critical call is active', async () => {
    const hold = deferred();
    const session = {
      client: {
        callTool: async ({ name }) => {
          if (name === 'browser_snapshot') {
            await hold.promise;
            return { content: [{ type: 'text', text: '- button "Login" [ref=e1]' }] };
          }
          return { content: [{ type: 'image', data: 'abc', mimeType: 'image/jpeg' }] };
        },
      },
      broadcast: () => {},
      telemetry: { recordTool: () => {} },
    };

    const critical = mcp.callTool(session, 'browser_snapshot', {});
    const background = await mcp.callTool(session, 'browser_take_screenshot', {}, {
      lane: 'background',
      skipIfBusy: true,
      telemetry: false,
      source: 'live_frame',
    });

    expect(background.qaaiSkipped).toBe(true);
    expect(background.qaaiBackgroundSkipped).toBe(true);

    hold.resolve();
    const criticalResult = await critical;
    expect(criticalResult.isError).not.toBe(true);
  });

  it('lets a critical action run immediately after a dropped background frame', async () => {
    const calls = [];
    const session = {
      client: {
        callTool: async ({ name }) => {
          calls.push(name);
          return { content: [{ type: 'text', text: `${name} ok` }] };
        },
      },
      broadcast: () => {},
    };

    const shot = await mcp.callTool(session, 'browser_take_screenshot', {}, {
      lane: 'background',
      skipIfBusy: true,
      telemetry: false,
      source: 'live_frame',
    });
    const click = await mcp.callTool(session, 'browser_snapshot', {});

    expect(shot.qaaiSkipped).not.toBe(true);
    expect(click.isError).not.toBe(true);
    // browser_snapshot internally settles (re-snapshots to return the stabilised
    // accessibility tree — the deliberate stale-ref fix in mcp.js), so it may fire
    // more than once. Behaviorally: the background screenshot ran (not skipped),
    // and the critical snapshot ran after it, in order.
    expect(calls[0]).toBe('browser_take_screenshot');
    expect(calls).toContain('browser_snapshot');
    expect(calls.indexOf('browser_snapshot')).toBeGreaterThan(calls.indexOf('browser_take_screenshot'));
  });
});
