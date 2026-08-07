import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  accordionStateFromSnapshot,
  candidateForOperation,
  evaluateOptionalCondition,
  createControllerMcpRuntimeAdapter,
  diagnosticSnapshotPreview,
} = require('../../server/services/controllerMcpRuntimeAdapter');
const {
  compileOperationContractV2,
} = require('../../server/services/operationContractV2');
const {
  RESOLUTION_STATUS,
} = require('../../server/services/browserTransactionController');
const {
  createTypedAdapterPlan,
} = require('../../server/services/controllerTypedAdapterRegistry');
const {
  createControllerActionExecutionGateway,
  DELIVERY_STATUS,
} = require('../../server/services/controllerActionExecutionGateway');
const {
  createControllerAuthority,
} = require('../../server/services/browserTransactionAuthority');

function operation(predicate, accessibleName, type = 'Click') {
  return {
    type,
    targetIdentity: { accessibleName },
    condition: { predicate, onFalse: 'skip' },
    optional: true,
  };
}

describe('controller MCP optional conditions', () => {
  it('treats a negative semantic evaluate acknowledgment as proven non-delivery', async () => {
    const session = {
      id: 'negative-semantic-evaluate',
      authorityMode: 'browser_transaction_controller',
      closed: false,
      client: {
        callTool: async () => ({
          isError: false,
          content: [{
            type: 'text',
            text: '### Result\n"{\\"ok\\":false,\\"reason\\":\\"calendar_choice_not_found\\"}"',
          }],
        }),
      },
    };
    const adapter = createControllerMcpRuntimeAdapter({ session });
    const gateway = createControllerActionExecutionGateway({ transport: adapter.transport });
    const delivery = await gateway.dispatch({
      authority: createControllerAuthority(),
      operation: {
        operationId: 'date-action',
        actionOccurrenceId: 'date-action:1',
      },
      plan: {
        mutation: {
          toolName: 'browser_evaluate',
          phaseId: 'choose-day',
          args: {
            function: '() => { document.querySelector("button")?.click(); return { ok: false }; }',
          },
        },
      },
      context: { session },
      remainingMs: 3_000,
    });

    expect(delivery).toMatchObject({
      deliveryStatus: DELIVERY_STATUS.NOT_DELIVERED,
      reason: 'calendar_choice_not_found',
      recoverable: true,
    });
  });

  it('keeps the date value input as owner instead of promoting its opener button', () => {
    const date = compileOperationContractV2({
      id: 'date-owner-case',
      steps: [{
        id: 'date',
        type: 'Date',
        target: 'Ship Date calendar',
        value: '2026-08-20',
      }],
    }).actions[0];
    expect(candidateForOperation(date, [
      {
        ref: 'date-owner',
        role: 'textbox',
        accessibleName: 'Ship Date',
        semanticNames: ['Ship Date calendar'],
        interactionRef: 'date-trigger',
      },
      {
        ref: 'date-trigger',
        role: 'button',
        accessibleName: 'Ship Date calendar',
      },
    ])).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      candidate: { ref: 'date-owner', interactionRef: 'date-trigger' },
    });
  });

  it('redacts values from zero-candidate snapshot diagnostics', () => {
    const preview = diagnosticSnapshotPreview(
      '- textbox "Password" [value="super-secret"]\n- token: abc123',
      0,
    );
    expect(preview).not.toContain('super-secret');
    expect(preview).not.toContain('abc123');
    expect(preview).toContain('[redacted]');
  });

  it('finds a visible prompt from its semantic subject instead of literal predicate prose', () => {
    const result = evaluateOptionalCondition(
      operation('the Stay signed in prompt is visible', 'option that continues to the application'),
      '- heading "Stay signed in?"\n- button "Yes" [ref=e1]',
      [],
    );
    expect(result).toMatchObject({ value: true, reason: 'optional_subject_visible' });
  });

  it('proves an accordion is already expanded and skips the toggle', () => {
    const candidates = [{ ref: 'e2', accessibleName: 'Pickup and Delivery', role: 'button' }];
    const result = evaluateOptionalCondition(
      operation('Pickup and Delivery section is collapsed', 'Pickup and Delivery', 'Expand'),
      '- button "Pickup and Delivery" [expanded] [ref=e2]',
      candidates,
    );
    expect(result).toMatchObject({ value: false, reason: 'optional_owner_already_expanded' });
  });

  it('proves an unselected radio needs the authored action', () => {
    const candidates = [{ ref: 'e3', accessibleName: 'Ship Date & Time', role: 'radio' }];
    const result = evaluateOptionalCondition(
      operation('Ship Date & Time is not already selected', 'Ship Date & Time', 'Radio'),
      '- radio "Ship Date & Time" [ref=e3]',
      candidates,
    );
    expect(result).toMatchObject({ value: true, reason: 'optional_owner_not_selected' });
  });

  it('reads a typed accordion owner without the Playwright expanded marker as collapsed', () => {
    const candidates = [{ ref: 'e4', accessibleName: 'Pickup and Delivery', role: 'button' }];
    const result = evaluateOptionalCondition(
      operation('Pickup and Delivery section is collapsed', 'Pickup and Delivery', 'Expand'),
      '- button "Pickup and Delivery" [ref=e4]',
      candidates,
    );
    expect(result).toMatchObject({ value: true, reason: 'optional_owner_collapsed' });
  });

  it('ignores a semantic container and reads the actionable accordion owner', () => {
    const candidates = [
      { ref: 'e4', accessibleName: 'Pickup and Delivery', role: 'generic' },
      {
        ref: 'e5',
        accessibleName: 'Pickup and Delivery Shipper, Consignee, and Planning Dates',
        role: 'button',
      },
    ];
    const result = evaluateOptionalCondition(
      operation('Pickup and Delivery section is collapsed', 'Pickup and Delivery section', 'Expand'),
      [
        '- generic "Pickup and Delivery" [ref=e4]',
        '- button "Pickup and Delivery Shipper, Consignee, and Planning Dates" [ref=e5]',
      ].join('\n'),
      candidates,
    );
    expect(result).toMatchObject({ value: true, reason: 'optional_owner_collapsed' });
  });

  it('does not infer accordion state for an arbitrary non-accordion button', () => {
    expect(accordionStateFromSnapshot(
      operation('Details is visible', 'Details', 'Click'),
      '- button "Details" [ref=e5]',
      { ref: 'e5', accessibleName: 'Details', role: 'button' },
    )).toBeNull();
  });

  it('proves a typed Expand transaction from the exact owner changing to expanded', async () => {
    const snapshots = [
      '- button "Pickup and Delivery" [ref=e7]',
      '- button "Pickup and Delivery" [expanded] [ref=e7]\n- region "Pickup and Delivery" [ref=e8]',
    ];
    let snapshotIndex = 0;
    const session = {
      id: 'accordion-proof',
      authorityMode: 'browser_transaction_controller',
      closed: false,
      client: {
        callTool: async () => ({
          isError: false,
          content: [{ type: 'text', text: snapshots[Math.min(snapshotIndex++, 1)] }],
        }),
      },
    };
    const expand = compileOperationContractV2({
      id: 'accordion-case',
      steps: [{
        id: 'expand',
        type: 'Expand',
        target: 'Pickup and Delivery section',
        optional: true,
        condition: {
          predicate: 'Pickup and Delivery section is collapsed',
          onFalse: 'skip',
        },
      }],
    }).actions[0];
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [expand] });
    const resolution = await adapter.resolver({ operation: expand, remainingMs: 3_000 });
    expect(resolution).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      target: { ref: 'e7' },
    });
    const plan = createTypedAdapterPlan({ operation: expand, resolution });
    const pre = await adapter.observer({
      operation: expand,
      resolution,
      plan,
      phase: 'pre_dispatch',
      remainingMs: 3_000,
    });
    expect(pre.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: 'accordion_owner_state', status: 'MISMATCH' }),
    ]));
    const post = await adapter.observer({
      operation: expand,
      resolution,
      plan,
      phase: 'post_dispatch',
      remainingMs: 3_000,
    });
    expect(post.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: 'accordion_owner_state', status: 'MATCHED' }),
    ]));
  });

  it('re-resolves the same semantic date owner after a controlled rerender', async () => {
    const snapshots = [
      '- button "Ship Date calendar" [ref=e11]',
      '- textbox "Ship Date calendar" [ref=e12]: "08/20/2026"',
    ];
    let snapshotIndex = 0;
    const session = {
      id: 'date-rerender-proof',
      authorityMode: 'browser_transaction_controller',
      closed: false,
      client: {
        callTool: async () => ({
          isError: false,
          content: [{ type: 'text', text: snapshots[Math.min(snapshotIndex++, 1)] }],
        }),
      },
    };
    const date = compileOperationContractV2({
      id: 'date-case',
      steps: [{
        id: 'date',
        type: 'Date',
        target: 'Ship Date calendar',
        value: '2026-08-20',
      }],
    }).actions[0];
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [date] });
    const resolution = await adapter.resolver({ operation: date, remainingMs: 3_000 });
    expect(resolution).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      target: { ref: 'e11' },
    });
    const plan = createTypedAdapterPlan({ operation: date, resolution });
    const post = await adapter.observer({
      operation: date,
      resolution,
      plan,
      phase: 'post_dispatch',
      remainingMs: 3_000,
    });
    expect(post.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ claimId: 'normalized_date_owner_value', status: 'MATCHED' }),
    ]));
  });

  it('recaptures only when the controller explicitly requests a fresh resolution attempt', async () => {
    let snapshots = 0;
    const session = {
      id: 'delayed-email-page',
      authorityMode: 'browser_transaction_controller',
      closed: false,
      client: {
        callTool: async ({ name }) => {
          expect(name).toBe('browser_snapshot');
          snapshots += 1;
          return {
            isError: false,
            content: [{
              type: 'text',
              text: snapshots === 1
                ? '- Page URL: https://example.test/email\n- heading "Loading" [ref=e1]'
                : '- Page URL: https://example.test/email\n- textbox "Email Address" [ref=e2]',
            }],
          };
        },
      },
    };
    const fill = compileOperationContractV2({
      id: 'email-case',
      steps: [{ id: 'email', type: 'Fill', target: 'Email Address field', value: 'qa@example.test' }],
    }).actions[0];
    const adapter = createControllerMcpRuntimeAdapter({ session, operations: [fill] });
    const first = await adapter.resolver({ operation: fill, remainingMs: 3_000 });
    expect(first).toMatchObject({
      status: RESOLUTION_STATUS.NOT_FOUND,
    });
    const resolution = await adapter.resolver({
      operation: fill,
      remainingMs: 3_000,
      context: {
        resolutionAttempt: 2,
        forceFreshSnapshot: true,
      },
    });
    expect(resolution).toMatchObject({
      status: RESOLUTION_STATUS.RESOLVED,
      target: { ref: 'e2' },
    });
    expect(snapshots).toBe(2);
  });
});
