import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  exactFillAcknowledgment,
  protectedPasswordAcknowledgment,
} = require('../../server/services/controllerMcpRuntimeAdapter');

function input(overrides = {}) {
  return {
    operation: { type: 'Fill' },
    resolution: { target: { ref: 'e16' } },
    plan: { mutation: { toolName: 'browser_fill', args: { target: 'e16' } } },
    delivery: {
      deliveryStatus: 'DELIVERED',
      browserAcknowledged: true,
      acknowledgmentKind: 'browser_fill_returned',
    },
    ownerVisible: true,
    ...overrides,
  };
}

describe('controller MCP fill acknowledgment', () => {
  it('accepts an explicit browser acknowledgment correlated to the exact live owner', () => {
    expect(exactFillAcknowledgment(input())).toBe(true);
  });

  it.each([
    ['owner is not visible', { ownerVisible: false }],
    ['owner ref differs', {
      plan: { mutation: { toolName: 'browser_fill', args: { target: 'e99' } } },
    }],
    ['delivery is uncertain', {
      delivery: {
        deliveryStatus: 'DELIVERY_UNCERTAIN',
        browserAcknowledged: true,
        acknowledgmentKind: 'browser_fill_returned',
      },
    }],
    ['transport did not explicitly acknowledge', {
      delivery: {
        deliveryStatus: 'DELIVERED',
        browserAcknowledged: false,
        acknowledgmentKind: null,
      },
    }],
  ])('rejects the proof when %s', (_label, override) => {
    expect(exactFillAcknowledgment(input(override))).toBe(false);
  });

  it('proves protected non-empty input only from the exact acknowledged write', () => {
    expect(protectedPasswordAcknowledgment(input({
      delivery: {
        deliveryStatus: 'DELIVERED',
        browserAcknowledged: true,
        acknowledgmentKind: 'browser_fill_returned',
        protectedInputNonEmpty: true,
      },
    }))).toBe(true);
    expect(protectedPasswordAcknowledgment(input({
      delivery: {
        deliveryStatus: 'DELIVERED',
        browserAcknowledged: true,
        acknowledgmentKind: 'browser_fill_returned',
        protectedInputNonEmpty: false,
      },
    }))).toBe(false);
  });
});
