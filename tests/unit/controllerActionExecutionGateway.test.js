import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');
const {
  DELIVERY_STATUS,
  createInMemoryDispatchJournal,
  createControllerActionExecutionGateway,
} = require('../../server/services/controllerActionExecutionGateway');

function request(overrides = {}) {
  return {
    authority: createControllerAuthority(),
    operation: {
      operationId: 'action:login:email',
      actionOccurrenceId: 'occurrence:action:login:email:1',
    },
    plan: {
      mutation: {
        toolName: 'browser_fill',
        args: { target: 'e1', text: 'qa@example.test' },
      },
    },
    ...overrides,
  };
}

describe('ControllerActionExecutionGateway', () => {
  it('persists intent before one exact transport call', async () => {
    const journal = createInMemoryDispatchJournal();
    const transport = vi.fn().mockResolvedValue({ delivered: true });
    const gateway = createControllerActionExecutionGateway({ transport, journal });
    const result = await gateway.dispatch(request());

    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.deliveryStatus).toBe(DELIVERY_STATUS.DELIVERED);
    expect(journal.allEvents().map((event) => event.eventType)).toEqual([
      'DISPATCH_INTENT_PERSISTED',
      'DISPATCH_STARTED',
      'DELIVERY_RECORDED',
    ]);
    expect(journal.allEvents()[0]).not.toHaveProperty('args');
    expect(journal.allEvents()[0].argsDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects a second dispatch of the same occurrence even after positive nondelivery', async () => {
    const gateway = createControllerActionExecutionGateway({
      transport: vi.fn().mockResolvedValue({
        delivered: false,
        positivelyNotDelivered: true,
      }),
    });
    const first = request();
    expect((await gateway.dispatch(first)).deliveryStatus).toBe(DELIVERY_STATUS.NOT_DELIVERED);
    await expect(gateway.dispatch(first)).rejects.toMatchObject({
      code: 'CONTROLLER_GATEWAY_DUPLICATE_OCCURRENCE',
    });
  });

  it('returns delivery uncertainty as a fact instead of authoring a verdict', async () => {
    const gateway = createControllerActionExecutionGateway({
      transport: vi.fn().mockRejectedValue(new Error('response lost')),
    });
    await expect(gateway.dispatch(request())).resolves.toMatchObject({
      deliveryStatus: DELIVERY_STATUS.DELIVERY_UNCERTAIN,
    });
  });

  it('returns only an explicit safe browser acknowledgment from the transport', async () => {
    const gateway = createControllerActionExecutionGateway({
      transport: vi.fn().mockResolvedValue({
        delivered: true,
        browserAcknowledged: true,
        acknowledgmentKind: 'browser_fill_returned',
        protectedInputNonEmpty: true,
      }),
    });
    await expect(gateway.dispatch(request())).resolves.toMatchObject({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      browserAcknowledged: true,
      acknowledgmentKind: 'browser_fill_returned',
      inputEventObserved: false,
      protectedInputNonEmpty: true,
    });

    const genericGateway = createControllerActionExecutionGateway({
      transport: vi.fn().mockResolvedValue({ delivered: true }),
    });
    await expect(genericGateway.dispatch(request({
      operation: {
        operationId: 'action:login:email:generic',
        actionOccurrenceId: 'occurrence:action:login:email:generic:1',
      },
    }))).resolves.toMatchObject({
      browserAcknowledged: false,
      acknowledgmentKind: null,
      protectedInputNonEmpty: false,
    });
  });

  it('preserves only the typed semantic mutation acknowledgment and its fact reference', async () => {
    const gateway = createControllerActionExecutionGateway({
      transport: vi.fn().mockResolvedValue({
        delivered: true,
        browserAcknowledged: true,
        acknowledgmentKind: 'browser_evaluate_semantic_acknowledgment',
        semanticAcknowledgment: {
          ok: true,
          reason: 'virtualized_selection_owner_committed',
          actionPerformed: true,
          expectedSelectionMatched: true,
          ownerMatched: true,
          selectedLabel: '(UTC-06:00)US/Central',
          ignoredRawValue: 'must-not-cross-the-gateway',
        },
        factRefs: ['fact:semantic-selection'],
      }),
    });

    const result = await gateway.dispatch(request({
      operation: {
        operationId: 'action:order:timezone',
        actionOccurrenceId: 'occurrence:action:order:timezone:1',
      },
      plan: {
        mutation: {
          toolName: 'browser_evaluate',
          args: { target: 'timezone-owner', function: '() => ({ ok: true })' },
          phaseId: 'select-option',
        },
      },
    }));

    expect(result.semanticAcknowledgment).toEqual({
      ok: true,
      reason: 'virtualized_selection_owner_committed',
      actionPerformed: true,
      expectedSelectionMatched: true,
      ownerMatched: true,
      selectedLabel: '(UTC-06:00)US/Central',
    });
    expect(result.semanticAcknowledgment).not.toHaveProperty('ignoredRawValue');
    expect(result.factRefs).toEqual(expect.arrayContaining(['fact:semantic-selection']));
  });

  it('refuses dispatch when durable intent persistence fails', async () => {
    const transport = vi.fn();
    const gateway = createControllerActionExecutionGateway({
      transport,
      journal: {
        eventsForOccurrence: vi.fn().mockResolvedValue([]),
        appendDispatchEvent: vi.fn().mockResolvedValue({ persisted: false }),
      },
    });
    await expect(gateway.dispatch(request())).rejects.toMatchObject({
      code: 'CONTROLLER_GATEWAY_DURABILITY_REQUIRED',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects forged controller authority', async () => {
    const transport = vi.fn();
    const gateway = createControllerActionExecutionGateway({ transport });
    await expect(gateway.dispatch(request({
      authority: {
        schemaVersion: 'qaai-browser-transaction-authority-v1',
        owner: 'BrowserTransactionController',
      },
    }))).rejects.toMatchObject({
      code: 'BROWSER_TRANSACTION_CONTROLLER_AUTHORITY_REQUIRED',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('exposes no target actionability postcondition continuation or verdict methods', () => {
    const gateway = createControllerActionExecutionGateway({ transport: vi.fn() });
    expect(Object.keys(gateway).sort()).toEqual([
      'consumeTransportPermit',
      'dispatch',
      'gatewayVersion',
    ]);
  });
});
