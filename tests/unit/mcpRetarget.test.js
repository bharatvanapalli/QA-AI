import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import mcp from '../../server/services/mcp.js';

describe('MCP generic wrapper retargeting', () => {
  it('keeps internal snapshot reads off the scheduled callTool lane', () => {
    const source = readFileSync('server/services/mcp.js', 'utf8');
    const stabilise = source.slice(
      source.indexOf('async function stabiliseSnapshot'),
      source.indexOf('/**', source.indexOf('async function stabiliseSnapshot') + 1),
    );
    const refresh = source.slice(
      source.indexOf('async function _refreshSnapshot'),
      source.indexOf('async function _refreshValidationSnapshotOnce'),
    );

    expect(stabilise).toContain('rawTransitionTool(');
    expect(refresh).toContain('rawTransitionTool(');
    expect(stabilise).not.toContain('await callTool(');
    expect(refresh).not.toContain('await callTool(');
  });

  it('retargets browser_type from a generic wrapper to its only child textbox', () => {
    const snapshot = [
      '- generic "Username wrapper" [ref=e10]',
      '  - textbox "Username" [ref=e11]',
    ].join('\n');
    const session = {
      lastSnapshot: snapshot,
      refRoleMap: mcp.buildRefRoleMap(snapshot),
    };
    const args = { element: 'Username textbox', target: 'e10', text: 'Admin' };

    const result = mcp.retargetGenericWrapperForTool(session, 'browser_type', args);

    expect(result?.rewrites).toEqual([{ from: 'e10', to: 'e11', role: 'textbox', fieldName: 'Username textbox' }]);
    expect(args.target).toBe('e11');
  });

  it('does not retarget ambiguous wrapper children', () => {
    const snapshot = [
      '- generic "Name wrapper" [ref=e20]',
      '  - textbox "First name" [ref=e21]',
      '  - textbox "Last name" [ref=e22]',
    ].join('\n');
    const session = {
      lastSnapshot: snapshot,
      refRoleMap: mcp.buildRefRoleMap(snapshot),
    };
    const args = { element: 'Name textbox', target: 'e20', text: 'Alice' };

    const result = mcp.retargetGenericWrapperForTool(session, 'browser_type', args);

    expect(result).toBeNull();
    expect(args.target).toBe('e20');
  });

  it('retargets browser_fill_form fields independently', () => {
    const snapshot = [
      '- generic "Password wrapper" [ref=e30]',
      '  - textbox "Password" [ref=e31]',
    ].join('\n');
    const session = {
      lastSnapshot: snapshot,
      refRoleMap: mcp.buildRefRoleMap(snapshot),
    };
    const args = { fields: [{ name: 'Password', target: 'e30', value: 'secret' }] };

    const result = mcp.retargetGenericWrapperForTool(session, 'browser_fill_form', args);

    expect(result?.rewrites[0]).toMatchObject({ from: 'e30', to: 'e31', role: 'textbox', fieldName: 'Password' });
    expect(args.fields[0].target).toBe('e31');
  });

  it('retargets hover from an inner image/icon ref to the parent tooltip trigger', () => {
    const snapshot = [
      '- link "User Management" [ref=e40]',
      '  - img "User Management icon" [ref=e41]',
    ].join('\n');
    const session = {
      lastSnapshot: snapshot,
      refRoleMap: mcp.buildRefRoleMap(snapshot),
    };
    const args = { element: 'User Management menu icon', target: 'e41', ref: 'e41' };

    const result = mcp.retargetHoverIconToTrigger(session, args);

    expect(result?.rewrites[0]).toMatchObject({ from: 'e41', to: 'e40', role: 'link', fieldName: 'User Management menu icon' });
    expect(args.target).toBe('e40');
    expect(args.ref).toBe('e40');
  });

  it('replaces a timed-out MCP transport without closing the live browser', async () => {
    let oldClientClosed = 0;
    let oldTransportClosed = 0;
    const liveCdp = { context: { id: 'preserved-browser' } };
    const replacementClient = { callTool: async () => ({ content: [] }) };
    const replacementTransport = { _process: { pid: 4321 } };
    const messages = [];
    const session = {
      client: { close: async () => { oldClientClosed += 1; } },
      transport: { close: async () => { oldTransportClosed += 1; } },
      subprocessPid: null,
      liveCdp,
      broadcast: (message) => messages.push(message),
      mcpTransportFactory: async () => ({
        client: replacementClient,
        transport: replacementTransport,
        toolList: { tools: [{ name: 'browser_snapshot' }] },
      }),
    };

    await expect(mcp._recoverMcpTransport(session, 'browser_click_hard_timeout')).resolves.toBe(true);

    expect(oldClientClosed).toBe(1);
    expect(oldTransportClosed).toBe(1);
    expect(session.client).toBe(replacementClient);
    expect(session.transport).toBe(replacementTransport);
    expect(session.subprocessPid).toBe(4321);
    expect(session.mcpTools).toEqual([{ name: 'browser_snapshot' }]);
    expect(session.liveCdp).toBe(liveCdp);
    expect(messages.at(-1)?.message).toContain('authenticated browser page was preserved');
  });

  it('recovers a timed-out stability snapshot instead of poisoning later MCP calls', async () => {
    const replacementClient = { callTool: vi.fn(async () => ({ content: [] })) };
    const factory = vi.fn(async () => ({
      client: replacementClient,
      transport: { _process: { pid: 9876 } },
      toolList: { tools: [{ name: 'browser_snapshot' }] },
    }));
    const session = {
      client: {
        callTool: vi.fn(() => new Promise(() => {})),
        close: vi.fn(async () => {}),
      },
      transport: { close: vi.fn(async () => {}) },
      subprocessPid: null,
      mcpTransportFactory: factory,
    };
    const firstSnapshot = '- textbox "Email Address" [ref=e1]';
    const startedAt = Date.now();

    const result = await mcp._stabiliseSnapshot(session, firstSnapshot, 'browser_navigate', { timeoutMs: 100 });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.txt).toBe(firstSnapshot);
    expect(result.record.capped).toBe(true);
    expect(factory).toHaveBeenCalledOnce();
    expect(session.client).toBe(replacementClient);
  });

  it('recovers a timed-out validation refresh instead of leaving an orphaned SDK request', async () => {
    const replacementClient = { callTool: vi.fn(async () => ({ content: [] })) };
    const factory = vi.fn(async () => ({
      client: replacementClient,
      transport: { _process: { pid: 9877 } },
      toolList: { tools: [{ name: 'browser_snapshot' }] },
    }));
    const session = {
      client: {
        callTool: vi.fn(() => new Promise(() => {})),
        close: vi.fn(async () => {}),
      },
      transport: { close: vi.fn(async () => {}) },
      subprocessPid: null,
      mcpTransportFactory: factory,
    };
    const startedAt = Date.now();

    await expect(mcp._refreshSnapshot(session, { timeoutMs: 100 })).resolves.toBeNull();

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(factory).toHaveBeenCalledOnce();
    expect(session.client).toBe(replacementClient);
  });

  it('recovers a timed-out transition observation before the next action', async () => {
    const replacementClient = { callTool: vi.fn(async () => ({ content: [] })) };
    const factory = vi.fn(async () => ({
      client: replacementClient,
      transport: { _process: { pid: 9878 } },
      toolList: { tools: [{ name: 'browser_snapshot' }] },
    }));
    const session = {
      client: {
        callTool: vi.fn(() => new Promise(() => {})),
        close: vi.fn(async () => {}),
      },
      transport: { close: vi.fn(async () => {}) },
      subprocessPid: null,
      mcpTransportFactory: factory,
    };
    const startedAt = Date.now();

    await expect(mcp._rawTransitionTool(session, 'browser_snapshot', {}, 100))
      .rejects.toMatchObject({ code: 'MCP_HARD_TIMEOUT' });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(factory).toHaveBeenCalledOnce();
    expect(session.client).toBe(replacementClient);
  });

  it('bounds DOM ref evaluation and replaces a poisoned transport', async () => {
    const replacementClient = { callTool: vi.fn(async () => ({ content: [] })) };
    const factory = vi.fn(async () => ({
      client: replacementClient,
      transport: { _process: { pid: 9879 } },
      toolList: { tools: [{ name: 'browser_evaluate' }] },
    }));
    const session = {
      client: {
        callTool: vi.fn(() => new Promise(() => {})),
        close: vi.fn(async () => {}),
      },
      transport: { close: vi.fn(async () => {}) },
      subprocessPid: null,
      mcpTransportFactory: factory,
    };
    const startedAt = Date.now();

    await expect(mcp._rawEvaluateBoundRef(session, {
      ref: 'e2169',
      functionSource: '(el) => !!el',
      timeoutMs: 100,
    })).rejects.toMatchObject({ code: 'MCP_HARD_TIMEOUT' });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(factory).toHaveBeenCalledOnce();
    expect(session.client).toBe(replacementClient);
    await expect(session.client.callTool({ name: 'browser_snapshot', arguments: {} }))
      .resolves.toEqual({ content: [] });
  });
});
