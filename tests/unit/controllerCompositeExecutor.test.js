import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createCalendarProtocol,
  createDropdownProtocol,
  createTimeProtocol,
} = require('../../server/services/controllerCompositeProtocols');
const {
  createControllerCompositeExecutor,
  resolveDynamicCandidate,
} = require('../../server/services/controllerCompositeExecutor');
const {
  DELIVERY_STATUS,
} = require('../../server/services/controllerActionExecutionGateway');
const {
  PROOF_STATUS,
} = require('../../server/services/browserProofContract');

function matchedClaim(claimId) {
  return {
    claimId,
    status: PROOF_STATUS.MATCHED,
    tier: 5,
    factRef: `fact:${claimId}`,
  };
}

function exactPopupOwnership(...ownedOptionNames) {
  return {
    proven: true,
    controlledPopupCount: 1,
    ownedOptionNames,
  };
}

describe('controller composite executor', () => {
  it('resolves calendar mode controls and values only to actionable calendar roles', () => {
    const operation = {
      operationId: 'action:order:pickup-date',
      actionOccurrenceId: 'occurrence:action:order:pickup-date:1',
      type: 'Date',
      value: '2026-08-20',
      targetIdentity: {
        accessibleName: 'Pickup Date',
        role: 'combobox',
      },
    };
    const calendar = createCalendarProtocol({ operation, ownerRef: 'pickup-date-owner' });
    const yearControl = { phaseId: 'year-control-resolved', dynamicCandidate: 'year_control' };
    expect(resolveDynamicCandidate(calendar, yearControl, {
      candidates: [
        { ref: 'year-container', role: 'generic', accessibleName: 'Choose Year' },
        { ref: 'year-button', role: 'button', accessibleName: 'Choose Year' },
      ],
    }, { popupAssociated: true })).toMatchObject({
      status: 'RESOLVED',
      candidate: { ref: 'year-button' },
    });

    const exactYear = { phaseId: 'year-resolved', dynamicCandidate: 'year' };
    expect(resolveDynamicCandidate(calendar, exactYear, {
      candidates: [
        { ref: 'year-text', role: 'generic', accessibleName: '2026' },
        { ref: 'year-option', role: 'button', accessibleName: '2026' },
      ],
    }, { popupAssociated: true })).toMatchObject({
      status: 'RESOLVED',
      candidate: { ref: 'year-option' },
    });

    expect(resolveDynamicCandidate(calendar, exactYear, {
      candidates: [
        { ref: 'page-year', role: 'generic', accessibleName: '2026', section: 'Order summary' },
        { ref: 'calendar-year', role: 'generic', accessibleName: '2026', section: 'Choose Date' },
      ],
    }, { popupAssociated: true })).toMatchObject({
      status: 'RESOLVED',
      candidate: { ref: 'calendar-year' },
    });

    expect(resolveDynamicCandidate(calendar, exactYear, {
      candidates: [
        { ref: 'calendar-year', role: 'generic', accessibleName: '2026', section: '2020 - 2029' },
      ],
    }, { popupAssociated: true })).toMatchObject({
      status: 'RESOLVED',
      candidate: { ref: 'calendar-year' },
    });
  });

  it('does not toggle an owner closed when its associated popup is already open', async () => {
    const operation = {
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:1',
      selection: { kind: 'exact_text', value: 'LTL' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'equipment-owner',
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      factRef: 'fact:select-option-delivered',
    });
    const observer = vi.fn(async ({ plan }) => {
      const phase = plan.protocolPhase;
      if (phase.requiredClaim === 'exact_option_candidate') {
        return {
          candidates: [{
            ref: 'ltl-option',
            role: 'option',
            accessibleName: 'LTL',
            actionable: true,
          }],
          popupOwnership: exactPopupOwnership('LTL'),
          claims: [],
          factRefs: ['fact:ltl-option-visible'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(phase.requiredClaim)],
        factRefs: [`fact:${phase.requiredClaim}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'equipment-owner' } },
      plan: { protocol },
      remainingMs: 2_000,
    });

    expect(result.proof).toMatchObject({
      status: PROOF_STATUS.MATCHED,
      reason: 'composite_protocol_committed:owner-readback',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      plan: expect.objectContaining({
        mutation: {
          toolName: 'browser_click',
          args: { target: 'ltl-option' },
          phaseId: 'select-option',
        },
      }),
    }));
  });

  it('never dispatches an exact option that explicitly belongs to another owner', async () => {
    const operation = {
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:wrong-owner',
      selection: { kind: 'exact_text', value: 'LTL' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'equipment-owner',
    });
    const dispatch = vi.fn();
    const observer = vi.fn(async ({ plan }) => {
      const phase = plan.protocolPhase;
      if (phase.requiredClaim === 'exact_option_candidate') {
        return {
          candidates: [{
            ref: 'ltl-freight-option',
            role: 'option',
            accessibleName: 'LTL',
            ownerRef: 'freight-term-owner',
            actionable: true,
          }],
          popupOwnership: exactPopupOwnership('LTL'),
          claims: [],
          factRefs: ['fact:wrong-owner-option'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(phase.requiredClaim)],
        factRefs: [`fact:${phase.requiredClaim}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'equipment-owner' } },
      plan: { protocol },
      remainingMs: 2_000,
    });

    expect(result.proof).toMatchObject({
      status: PROOF_STATUS.UNKNOWN,
      reason: 'exact_option_belongs_to_different_owner',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('reports the exact owner commit failure after selecting an option once', async () => {
    const operation = {
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:owner-not-committed',
      selection: { kind: 'exact_text', value: 'LTL' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'equipment-owner',
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      factRef: 'fact:select-option-delivered',
    });
    const observer = vi.fn(async ({ plan }) => {
      const phase = plan.protocolPhase;
      if (phase.requiredClaim === 'exact_option_candidate') {
        return {
          candidates: [{
            ref: 'ltl-option',
            role: 'option',
            accessibleName: 'LTL',
            actionable: true,
          }],
          popupOwnership: exactPopupOwnership('LTL'),
          claims: [],
          factRefs: ['fact:ltl-option-visible'],
        };
      }
      if (phase.requiredClaim === 'owner_state_committed') {
        return {
          candidates: [],
          claims: [{
            claimId: 'owner_state_committed',
            status: PROOF_STATUS.MISMATCH,
            tier: 5,
            factRef: 'fact:owner-readback',
            reason: 'selection_owner_value_not_committed',
          }],
          factRefs: ['fact:owner-readback'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(phase.requiredClaim)],
        factRefs: [`fact:${phase.requiredClaim}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'equipment-owner' } },
      plan: { protocol },
      remainingMs: 2_000,
    });

    expect(result.proof).toMatchObject({
      status: PROOF_STATUS.MISMATCH,
      reason: 'selection_owner_value_not_committed',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('observes a framework-delayed exact option without reopening the owner', async () => {
    const operation = {
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:delayed-option',
      selection: { kind: 'exact_text', value: 'LTL' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'equipment-owner',
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      factRef: 'fact:select-option-delivered',
    });
    let optionObservation = 0;
    const observer = vi.fn(async ({ plan }) => {
      const phase = plan.protocolPhase;
      if (phase.requiredClaim === 'exact_option_candidate') {
        optionObservation += 1;
        return {
          candidates: optionObservation < 4 ? [] : [{
            ref: 'ltl-option',
            role: 'option',
            accessibleName: 'LTL',
            actionable: true,
          }],
          popupOwnership: exactPopupOwnership('LTL'),
          claims: [],
          factRefs: [`fact:option-observation:${optionObservation}`],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(phase.requiredClaim)],
        factRefs: [`fact:${phase.requiredClaim}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'equipment-owner' } },
      plan: { protocol },
      remainingMs: 2_000,
    });

    expect(result.proof.status).toBe(PROOF_STATUS.MATCHED);
    expect(optionObservation).toBe(4);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].plan.mutation.phaseId).toBe('select-option');
  });

  it('reserves owner-readback time after an uncertain option delivery without redispatching', async () => {
    const operation = {
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:uncertain-option',
      selection: { kind: 'exact_text', value: 'LTL' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'equipment-owner',
    });
    const dispatch = vi.fn(() => new Promise(() => {}));
    const observer = vi.fn(async ({ plan }) => {
      const phase = plan.protocolPhase;
      if (phase.requiredClaim === 'exact_option_candidate') {
        return {
          candidates: [{
            ref: 'ltl-option',
            role: 'option',
            accessibleName: 'LTL',
            actionable: true,
          }],
          popupOwnership: exactPopupOwnership('LTL'),
          claims: [],
          factRefs: ['fact:ltl-option-visible'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(phase.requiredClaim)],
        factRefs: [`fact:${phase.requiredClaim}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'equipment-owner' } },
      plan: { protocol },
      remainingMs: 120,
    });

    expect(result.proof.status).toBe(PROOF_STATUS.MATCHED);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].remainingMs).toBeLessThan(120);
  });

  it('resumes a composite occurrence from browser proof without repeating completed mutation phases', async () => {
    const operation = {
      operationId: 'action:order:equipment',
      actionOccurrenceId: 'occurrence:action:order:equipment:recovery',
      selection: { kind: 'exact_text', value: 'LTL' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'equipment-owner',
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      factRef: 'fact:select-option-delivered',
    });
    const observer = vi.fn(async ({ plan }) => {
      const phase = plan.protocolPhase;
      if (phase.requiredClaim === 'exact_option_candidate') {
        return {
          candidates: [{
            ref: 'ltl-option',
            role: 'option',
            accessibleName: 'LTL',
            actionable: true,
          }],
          popupOwnership: exactPopupOwnership('LTL'),
          claims: [],
          factRefs: ['fact:ltl-option-visible'],
        };
      }
      if (phase.requiredClaim === 'exact_option_selected') {
        return {
          candidates: [],
          claims: [{
            claimId: 'exact_option_selected',
            status: PROOF_STATUS.UNKNOWN,
            tier: 5,
            factRef: 'fact:option-not-yet-selected',
          }],
          factRefs: ['fact:option-not-yet-selected'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(phase.requiredClaim)],
        factRefs: [`fact:${phase.requiredClaim}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'equipment-owner' } },
      plan: { protocol },
      context: { resumeCompositePhases: true },
      remainingMs: 2_000,
    });

    expect(result.proof.status).toBe(PROOF_STATUS.MATCHED);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].plan.mutation.phaseId).toBe('select-option');
  });

  it('keeps open reveal select and commit inside one exactly-once time mutation', async () => {
    const operation = {
      operationId: 'action:order:early-pickup-time',
      actionOccurrenceId: 'occurrence:action:order:early-pickup-time:1',
      type: 'Select',
      value: '09:00 AM',
      targetIdentity: {
        accessibleName: 'Early Pickup Time dropdown',
        role: 'combobox',
      },
    };
    const protocol = createTimeProtocol({
      operation,
      ownerRef: 'early-pickup-time-owner',
      ownerAccessibleName: '00:00',
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      factRef: 'fact:atomic-time-selection-delivered',
    });
    const observer = vi.fn(async ({ plan }) => {
      const claimId = plan.protocolPhase.requiredClaim;
      if (claimId === 'normalized_time_owner_value' && dispatch.mock.calls.length === 0) {
        return {
          candidates: [],
          claims: [{
            claimId,
            status: PROOF_STATUS.UNKNOWN,
            tier: 5,
            factRef: 'fact:time-owner-not-yet-committed',
          }],
          factRefs: ['fact:time-owner-not-yet-committed'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(claimId)],
        factRefs: [`fact:${claimId}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'early-pickup-time-owner' } },
      plan: { protocol },
      context: {},
      remainingMs: 2_000,
    });

    expect(result.proof.status).toBe(PROOF_STATUS.MATCHED);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].plan.mutation).toMatchObject({
      phaseId: 'select-time-option',
      toolName: 'browser_evaluate',
      args: { target: 'early-pickup-time-owner' },
    });
    const source = dispatch.mock.calls[0][0].plan.mutation.args.function;
    expect(source).toContain('popup.surfaces.length === 0');
    expect(source).toContain('raw.click()');
    expect(source).toContain('time_owner_not_committed');
    expect(protocol.phases.map((phase) => phase.phaseId)).toEqual([
      'owner-ready',
      'select-time-option',
      'owner-readback',
    ]);
  });

  it('dispatches one atomic mutation for an owned virtualized custom select', async () => {
    const operation = {
      operationId: 'action:order:pickup-timezone',
      actionOccurrenceId: 'occurrence:action:order:pickup-timezone:1',
      type: 'Select',
      value: 'Central',
      selection: { kind: 'exact_text', value: 'Central' },
      targetIdentity: { accessibleName: 'Pickup Time Zone', role: 'combobox' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'pickup-timezone-owner',
      atomicSelection: true,
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      factRef: 'fact:atomic-virtualized-selection-delivered',
    });
    const observer = vi.fn(async ({ plan }) => {
      const claimId = plan.protocolPhase.requiredClaim;
      if (claimId === 'owner_state_committed' && dispatch.mock.calls.length === 0) {
        return {
          candidates: [],
          claims: [{
            claimId,
            status: PROOF_STATUS.UNKNOWN,
            tier: 5,
            factRef: 'fact:timezone-not-yet-committed',
          }],
          factRefs: ['fact:timezone-not-yet-committed'],
        };
      }
      return {
        candidates: [],
        claims: [matchedClaim(claimId)],
        factRefs: [`fact:${claimId}`],
      };
    });
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'pickup-timezone-owner' } },
      plan: { protocol },
      context: {},
      remainingMs: 2_000,
    });

    expect(result.proof.status).toBe(PROOF_STATUS.MATCHED);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].plan.mutation).toMatchObject({
      phaseId: 'select-option',
      toolName: 'browser_evaluate',
      args: { target: 'pickup-timezone-owner' },
    });
    expect(dispatch.mock.calls[0][0].plan.mutation.args.function)
      .toContain('virtualized_selection_semantic_ambiguous');
  });

  it('commits an exact atomic option acknowledgment when rerender removes owner readback identity', async () => {
    const operation = {
      operationId: 'action:order:pickup-timezone-rerender',
      actionOccurrenceId: 'occurrence:action:order:pickup-timezone-rerender:1',
      type: 'Select',
      value: 'Central',
      selection: { kind: 'exact_text', value: 'Central' },
      targetIdentity: { accessibleName: 'Pickup Time Zone', role: 'combobox' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'pickup-timezone-owner',
      atomicSelection: true,
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      browserAcknowledged: true,
      acknowledgmentKind: 'browser_evaluate_semantic_acknowledgment',
      semanticAcknowledgment: {
        ok: true,
        actionPerformed: true,
        expectedSelectionMatched: true,
        ownerMatched: false,
        selectedLabel: '(UTC-06:00)US/Central',
      },
      factRefs: ['fact:exact-central-option-clicked'],
    });
    const observer = vi.fn(async ({ plan }) => ({
      candidates: [],
      claims: [{
        claimId: plan.protocolPhase.requiredClaim,
        status: plan.protocolPhase.requiredClaim === 'same_owner_actionable'
          ? PROOF_STATUS.MATCHED
          : PROOF_STATUS.UNKNOWN,
        tier: 5,
        factRef: 'fact:owner-rerendered',
      }],
      factRefs: ['fact:owner-rerendered'],
    }));
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'pickup-timezone-owner' } },
      plan: { protocol },
      context: {},
      remainingMs: 2_000,
    });

    expect(result.proof).toMatchObject({
      status: PROOF_STATUS.MATCHED,
      reason: 'composite_protocol_committed:semantic-acknowledgment:exact_option_selected',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls.filter(([input]) => (
      input.plan.protocolPhase.phaseId === 'owner-readback'
    ))).toHaveLength(1);
  });

  it('does not commit an atomic acknowledgment for a different selected option', async () => {
    const operation = {
      operationId: 'action:order:pickup-timezone-wrong-option',
      actionOccurrenceId: 'occurrence:action:order:pickup-timezone-wrong-option:1',
      type: 'Select',
      value: 'Central',
      selection: { kind: 'exact_text', value: 'Central' },
      targetIdentity: { accessibleName: 'Pickup Time Zone', role: 'combobox' },
    };
    const protocol = createDropdownProtocol({
      operation,
      ownerRef: 'pickup-timezone-owner',
      atomicSelection: true,
    });
    const dispatch = vi.fn().mockResolvedValue({
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      browserAcknowledged: true,
      acknowledgmentKind: 'browser_evaluate_semantic_acknowledgment',
      semanticAcknowledgment: {
        ok: true,
        actionPerformed: true,
        expectedSelectionMatched: false,
        ownerMatched: false,
        selectedLabel: '(UTC-05:00)US/Eastern',
      },
      factRefs: ['fact:wrong-option-clicked'],
    });
    const observer = vi.fn(async ({ plan }) => ({
      candidates: [],
      claims: [{
        claimId: plan.protocolPhase.requiredClaim,
        status: plan.protocolPhase.requiredClaim === 'same_owner_actionable'
          ? PROOF_STATUS.MATCHED
          : PROOF_STATUS.UNKNOWN,
        tier: 5,
        factRef: 'fact:owner-rerendered',
      }],
      factRefs: ['fact:owner-rerendered'],
    }));
    const executor = createControllerCompositeExecutor({
      observer,
      gateway: { dispatch },
      sleep: async () => {},
    });

    const result = await executor.execute({
      authority: { capability: 'DISPATCH_BROWSER_MUTATION' },
      operation,
      resolution: { target: { ref: 'pickup-timezone-owner' } },
      plan: { protocol },
      context: {},
      remainingMs: 2_000,
    });

    expect(result.proof.status).toBe(PROOF_STATUS.UNKNOWN);
    expect(result.proof.reason).toBe('composite_phase_unproven:owner-readback');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
