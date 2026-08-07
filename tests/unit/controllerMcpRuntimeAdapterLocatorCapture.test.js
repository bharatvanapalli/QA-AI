import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createControllerMcpRuntimeAdapter,
} = require('../../server/services/controllerMcpRuntimeAdapter');

// Phase 30.0 — these tests cover the NEW wiring only: does the resolver
// remember the exact MCP ref it resolved for an operation, and does
// captureVerifiedLocator call through to browser_evaluate with that ref,
// fail safe on a miss, and never hang past its timeout. The deep proof
// logic inside actionLocatorResolver.captureStructuralLocator (same-node
// verification, priority ladder, export-safety) already has its own
// dedicated fixtures elsewhere (actionLocatorResolverPhase3.test.js,
// authoritativeCdpCapture.test.js) — this file does not re-prove that.

const clickOperation = {
  operationId: 'action:login:sign-in',
  kind: 'action',
  type: 'Click',
  targetIdentity: { role: 'button', accessibleName: 'Sign in' },
};

function makeSession(callToolImpl) {
  return {
    closed: false,
    authorityMode: 'browser_transaction_controller',
    client: { callTool: vi.fn(callToolImpl) },
  };
}

describe('controller MCP runtime adapter — passive locator capture (Phase 30.0)', () => {
  it('returns null when no ref was ever resolved for the operation', async () => {
    const session = makeSession(async () => ({ text: '' }));
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [clickOperation] });
    const result = await adapter.captureVerifiedLocator('action:never-resolved');
    expect(result).toBeNull();
    expect(session.client.callTool).not.toHaveBeenCalled();
  });

  it('returns null once the session is closed, even with a remembered ref', async () => {
    const session = makeSession(async ({ name }) => {
      if (name === 'browser_snapshot') return { text: '- button "Sign in" [ref=e5]' };
      return { text: 'Result: {"ok":true}' };
    });
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [clickOperation] });
    const resolution = await adapter.resolver({ operation: clickOperation, remainingMs: 2000 });
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.target.ref).toBe('e5');

    session.closed = true;
    const result = await adapter.captureVerifiedLocator(clickOperation.operationId);
    expect(result).toBeNull();
  });

  it('remembers the resolved ref and calls browser_evaluate with it, never throwing on a malformed reply', async () => {
    const calls = [];
    const session = makeSession(async ({ name, arguments: args }) => {
      calls.push({ name, args });
      if (name === 'browser_snapshot') return { text: '- button "Sign in" [ref=e5]' };
      // Deliberately malformed browser_evaluate reply — captureStructuralLocator
      // must fail safe (return null), not throw, on evidence it can't parse.
      return { text: 'Result: not valid json' };
    });
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [clickOperation] });

    const resolution = await adapter.resolver({ operation: clickOperation, remainingMs: 2000 });
    expect(resolution.status).toBe('RESOLVED');
    expect(resolution.target.ref).toBe('e5');

    const captured = await adapter.captureVerifiedLocator(clickOperation.operationId);
    expect(captured).toBeNull();

    const evaluateCall = calls.find((c) => c.name === 'browser_evaluate');
    expect(evaluateCall).toBeTruthy();
    expect(evaluateCall.args.target).toBe('e5');
  });

  it('never hangs past its timeout when the transport stalls', async () => {
    const session = makeSession(async ({ name }) => {
      if (name === 'browser_snapshot') return { text: '- button "Sign in" [ref=e5]' };
      return new Promise(() => {}); // browser_evaluate never resolves
    });
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [clickOperation] });
    await adapter.resolver({ operation: clickOperation, remainingMs: 2000 });

    const startedAt = Date.now();
    const result = await adapter.captureVerifiedLocator(clickOperation.operationId, { timeoutMs: 200 });
    expect(result).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });

  // NOTE: the genuine success path (a real authoritative match producing a
  // verified locator) is NOT covered by a synthetic fixture here. Building
  // one requires exactly reproducing every internal validation predicate of
  // actionLocatorResolver.captureStructuralLocator (proof shape, identity
  // scheme, strategy naming) without a live browser to derive them from —
  // guessing those fields risks a fixture that only passes because it
  // happens to match my guess, which proves nothing real. That module's own
  // success-path proof lives in its own fixtures (actionLocatorResolverPhase3
  // .test.js, authoritativeCdpCapture.test.js); genuine end-to-end proof of
  // THIS wiring needs a live run (tracked separately as the live-proof gate).

  it('never mutates the resolver decision — capture is purely observational', async () => {
    const session = makeSession(async ({ name }) => {
      if (name === 'browser_snapshot') return { text: '- button "Sign in" [ref=e5]' };
      return { text: 'Result: {"ok":false}' };
    });
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [clickOperation] });
    const before = await adapter.resolver({ operation: clickOperation, remainingMs: 2000 });
    await adapter.captureVerifiedLocator(clickOperation.operationId);
    const after = await adapter.resolver({ operation: clickOperation, remainingMs: 2000, context: { forceFreshSnapshot: true } });
    expect(after.status).toBe(before.status);
    expect(after.target.ref).toBe(before.target.ref);
  });
});
