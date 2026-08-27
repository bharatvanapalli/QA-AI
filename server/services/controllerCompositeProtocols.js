'use strict';

const {
  buildCalendarChoiceFunction,
  buildCalendarCommitFunction,
  buildCalendarModeFunction,
  buildTimeOptionSelectionFunction,
} = require('./semanticTemporalSelection');
const {
  buildVirtualizedOptionSelectionFunction,
} = require('./semanticSelectionState');

const PROTOCOL_VERSION = 'qaai-controller-composite-protocol-v1';

const PROTOCOL_KIND = Object.freeze({
  DROPDOWN: 'DROPDOWN',
  AUTOCOMPLETE: 'AUTOCOMPLETE',
  CALENDAR: 'CALENDAR',
  TIME: 'TIME',
});

const PHASE_KIND = Object.freeze({
  OBSERVE: 'OBSERVE',
  MUTATION: 'MUTATION',
});

const DIRECTIVE_STATUS = Object.freeze({
  OBSERVE: 'OBSERVE',
  READY_FOR_MUTATION: 'READY_FOR_MUTATION',
  RESOLVE_EXACT_CANDIDATE: 'RESOLVE_EXACT_CANDIDATE',
  COMPLETE: 'COMPLETE',
  PROOF_REQUIRED: 'PROOF_REQUIRED',
});

const OPTION_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  WRONG_OWNER: 'WRONG_OWNER',
  DISABLED: 'DISABLED',
});

class ControllerCompositeProtocolError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerCompositeProtocolError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function token(value) {
  return clean(value).toLocaleLowerCase('en-US');
}

function selectionValue(selection) {
  if (selection == null) return null;
  if (typeof selection === 'string' || typeof selection === 'number') return selection;
  if (typeof selection !== 'object') return null;
  return selection.expectedText ?? selection.value ?? selection.text ?? selection.label ?? selection.name ?? selection.ref ?? selection.reference ?? selection.ordinal ?? null;
}

function normalizeTime(value) {
  const raw = selectionValue(value) ?? value;
  const source = clean(raw).toUpperCase();
  const match = source.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? null : Number(match[3]);
  if (minute > 59 || (second != null && second > 59)) return null;
  if (match[4]) {
    if (hour < 1 || hour > 12) return null;
    if (match[4] === 'AM' && hour === 12) hour = 0;
    if (match[4] === 'PM' && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}${second == null ? '' : `:${String(second).padStart(2, '0')}`}`;
}

function normalizeDate(value) {
  const raw = selectionValue(value) ?? value;
  const source = clean(raw);
  let match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  match = source.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${String(Number(match[1])).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
}

function normalizeOptionValue(value, valueKind = 'text') {
  if (valueKind === 'time') return normalizeTime(value);
  if (valueKind === 'date') return normalizeDate(value);
  return token(value);
}

function ownerKey(owner = {}) {
  return clean(
    owner.backendNodeId
      || owner.nodeId
      || owner.ref
      || owner.reference
      || owner.ownerId,
  ) || null;
}

function candidateOwnerKey(candidate = {}) {
  return clean(
    candidate.ownerBackendNodeId
      || candidate.ownerNodeId
      || candidate.ownerRef
      || candidate.associatedOwnerId
      || candidate.ownerIdentity?.backendNodeId
      || candidate.ownerIdentity?.ref,
  ) || null;
}

function resolveExactOptionCandidate({
  selection,
  candidates = [],
  owner = {},
  valueKind = 'text',
} = {}) {
  const requested = selectionValue(selection);
  const normalizedRequested = normalizeOptionValue(requested, valueKind);
  if (normalizedRequested == null || normalizedRequested === '') {
    throw new ControllerCompositeProtocolError(
      'Exact option resolution requires a normalizable authored selection.',
      'CONTROLLER_PROTOCOL_SELECTION_REQUIRED',
      { selection },
    );
  }
  const expectedOwner = ownerKey(owner);
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : []).map((candidate) => {
    const label = candidate.label
      ?? candidate.text
      ?? candidate.accessibleName
      ?? candidate.name
      ?? candidate.value;
    const normalized = normalizeOptionValue(label, valueKind);
    const candidateOwner = candidateOwnerKey(candidate);
    return Object.freeze({
      ...candidate,
      label: clean(label) || null,
      normalized,
      ownerKey: candidateOwner,
      ownerMatches: !expectedOwner || candidateOwner === expectedOwner,
    });
  });
  const valueMatches = normalizedCandidates.filter((candidate) => candidate.normalized === normalizedRequested);
  const ownerMatches = valueMatches.filter((candidate) => candidate.ownerMatches);
  if (!ownerMatches.length && valueMatches.length) {
    return Object.freeze({
      status: OPTION_RESOLUTION_STATUS.WRONG_OWNER,
      candidate: null,
      candidates: Object.freeze(valueMatches),
      reason: 'exact_option_belongs_to_different_owner',
      mayObserveMore: false,
    });
  }
  if (!ownerMatches.length) {
    return Object.freeze({
      status: OPTION_RESOLUTION_STATUS.NOT_FOUND,
      candidate: null,
      candidates: Object.freeze([]),
      reason: 'exact_option_not_observed',
      mayObserveMore: true,
    });
  }
  if (ownerMatches.length > 1) {
    return Object.freeze({
      status: OPTION_RESOLUTION_STATUS.AMBIGUOUS,
      candidate: null,
      candidates: Object.freeze(ownerMatches),
      reason: 'multiple_exact_option_candidates',
      mayObserveMore: false,
    });
  }
  if (ownerMatches[0].disabled === true || ownerMatches[0].actionable === false) {
    return Object.freeze({
      status: OPTION_RESOLUTION_STATUS.DISABLED,
      candidate: ownerMatches[0],
      candidates: Object.freeze(ownerMatches),
      reason: 'exact_option_disabled',
      mayObserveMore: false,
    });
  }
  return Object.freeze({
    status: OPTION_RESOLUTION_STATUS.RESOLVED,
    candidate: ownerMatches[0],
    candidates: Object.freeze(ownerMatches),
    reason: 'exact_option_resolved_for_owner',
    mayObserveMore: false,
  });
}

function mutation(toolName, args, phaseId) {
  return Object.freeze({
    toolName,
    args: Object.freeze({ ...args }),
    phaseId,
  });
}

function phase({
  phaseId,
  kind,
  requiredClaim,
  mutationValue = null,
  dynamicCandidate = null,
  skipWhenClaim = null,
  semanticAcknowledgmentClaim = null,
  acceptSemanticAcknowledgmentClaim = null,
  observationAttempts = null,
  final = false,
} = {}) {
  return Object.freeze({
    phaseId,
    kind,
    requiredClaim,
    mutation: mutationValue,
    dynamicCandidate,
    skipWhenClaim,
    semanticAcknowledgmentClaim,
    acceptSemanticAcknowledgmentClaim,
    observationAttempts,
    final,
    commitEligible: final,
  });
}

function protocol(operation, kind, phases, metadata = {}) {
  return Object.freeze({
    schemaVersion: PROTOCOL_VERSION,
    protocolKind: kind,
    operationId: operation.operationId,
    actionOccurrenceId: operation.actionOccurrenceId,
    phases: Object.freeze(phases),
    metadata: Object.freeze({ ...metadata }),
  });
}

function createDropdownProtocol({
  operation,
  ownerRef,
  triggerRef = null,
  autocomplete = false,
  atomicSelection = true,
} = {}) {
  const clean = (val) => String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  const derivedOption = clean(
    selectionValue(operation.selection)
    || operation.value
    || (operation.element && operation.element.includes(',') ? operation.element.split(/,\s*/).pop() : null)
    || (operation.target && operation.target.includes(',') ? operation.target.split(/,\s*/).pop() : null)
    || operation.element
    || operation.target
  );
  const kind = autocomplete ? PROTOCOL_KIND.AUTOCOMPLETE : PROTOCOL_KIND.DROPDOWN;
  if (atomicSelection === true || derivedOption) {
    return protocol(operation, kind, [
      phase({ phaseId: 'owner-ready', kind: PHASE_KIND.OBSERVE, requiredClaim: 'same_owner_actionable' }),
      phase({
        phaseId: 'select-option',
        kind: PHASE_KIND.MUTATION,
        requiredClaim: 'exact_option_selected',
        skipWhenClaim: 'owner_state_committed',
        semanticAcknowledgmentClaim: 'exact_option_selected',
        mutationValue: mutation('browser_evaluate', {
          element: operation.targetIdentity?.accessibleName || operation.target || `<locator ${ownerRef}>`,
          target: ownerRef,
          function: buildVirtualizedOptionSelectionFunction({
            expectedSelection: derivedOption,
          }),
        }, 'select-option'),
      }),
      phase({
        phaseId: 'owner-readback',
        kind: PHASE_KIND.OBSERVE,
        requiredClaim: 'owner_state_committed',
        acceptSemanticAcknowledgmentClaim: 'exact_option_selected',
        observationAttempts: 1,
        final: true,
      }),
    ], {
      ownerRef,
      triggerRef: triggerRef || ownerRef,
      selection: derivedOption,
      valueKind: 'text',
      atomicVirtualizedSelection: true,
      popupOpenAloneNeverCommits: true,
    });
  }
  return protocol(operation, kind, [
    phase({ phaseId: 'owner-ready', kind: PHASE_KIND.OBSERVE, requiredClaim: 'same_owner_actionable' }),
    phase({
      phaseId: 'open-owner',
      kind: PHASE_KIND.MUTATION,
      requiredClaim: 'open_owner_delivery',
      skipWhenClaim: 'associated_popup_open',
      mutationValue: mutation('browser_click', { target: triggerRef || ownerRef }, 'open-owner'),
    }),
    phase({ phaseId: 'popup-associated', kind: PHASE_KIND.OBSERVE, requiredClaim: 'associated_popup_open' }),
    phase({
      phaseId: 'option-resolved',
      kind: PHASE_KIND.OBSERVE,
      requiredClaim: 'exact_option_candidate',
      dynamicCandidate: 'option',
    }),
    phase({
      phaseId: 'select-option',
      kind: PHASE_KIND.MUTATION,
      requiredClaim: 'exact_option_selected',
      dynamicCandidate: 'option',
    }),
    phase({
      phaseId: 'owner-readback',
      kind: PHASE_KIND.OBSERVE,
      requiredClaim: 'owner_state_committed',
      final: true,
    }),
  ], {
    ownerRef,
    triggerRef: triggerRef || ownerRef,
    selection: operation.selection,
    valueKind: 'text',
    popupOpenAloneNeverCommits: true,
  });
}

function createCalendarProtocol({
  operation,
  ownerRef,
  triggerRef = null,
  ownerAccessibleName = null,
} = {}) {
  const date = normalizeDate(operation.value);
  if (!date) {
    throw new ControllerCompositeProtocolError(
      'Calendar protocol requires canonical date value.',
      'CONTROLLER_PROTOCOL_DATE_INVALID',
      { value: operation.value },
    );
  }
  const [year, month, day] = date.split('-');
  return protocol(operation, PROTOCOL_KIND.CALENDAR, [
    phase({ phaseId: 'owner-ready', kind: PHASE_KIND.OBSERVE, requiredClaim: 'same_owner_actionable' }),
    phase({
      phaseId: 'open-owner',
      kind: PHASE_KIND.MUTATION,
      requiredClaim: 'open_owner_delivery',
      skipWhenClaim: 'associated_popup_open',
      mutationValue: mutation('browser_click', { target: triggerRef || ownerRef }, 'open-owner'),
    }),
    phase({ phaseId: 'popup-associated', kind: PHASE_KIND.OBSERVE, requiredClaim: 'associated_popup_open' }),
    phase({
      phaseId: 'choose-day',
      kind: PHASE_KIND.MUTATION,
      requiredClaim: 'day_selected',
      mutationValue: mutation('browser_evaluate', {
        function: buildCalendarChoiceFunction({ kind: 'day', value: day }),
      }, 'choose-day'),
    }),
    phase({
      phaseId: 'commit-date',
      kind: PHASE_KIND.MUTATION,
      requiredClaim: 'date_committed',
      semanticAcknowledgmentClaim: 'date_committed',
      mutationValue: mutation('browser_evaluate', {
        function: buildCalendarCommitFunction({
          accessibleName: ownerAccessibleName
            || operation.targetIdentity?.accessibleName
            || operation.targetIdentity?.label,
          expectedDate: date,
        }),
      }, 'commit-date'),
    }),
    phase({
      phaseId: 'owner-readback',
      kind: PHASE_KIND.OBSERVE,
      requiredClaim: 'normalized_date_owner_value',
      acceptSemanticAcknowledgmentClaim: 'date_committed',
      observationAttempts: 1,
      final: true,
    }),
  ], {
    ownerRef,
    triggerRef: triggerRef || ownerRef,
    ownerAccessibleName: ownerAccessibleName
      || operation.targetIdentity?.accessibleName
      || operation.targetIdentity?.label,
    normalizedDate: date,
    year,
    month,
    day,
    popupOpenAloneNeverCommits: true,
  });
}

function createTimeProtocol({
  operation,
  ownerRef,
  ownerAccessibleName = null,
} = {}) {
  const time = normalizeTime(operation.value || selectionValue(operation.selection));
  if (!time) {
    throw new ControllerCompositeProtocolError(
      'Time protocol requires a canonical or normalizable time value.',
      'CONTROLLER_PROTOCOL_TIME_INVALID',
      { value: operation.value || operation.selection },
    );
  }
  return protocol(operation, PROTOCOL_KIND.TIME, [
    phase({ phaseId: 'owner-ready', kind: PHASE_KIND.OBSERVE, requiredClaim: 'same_owner_actionable' }),
    phase({
      phaseId: 'select-time-option',
      kind: PHASE_KIND.MUTATION,
      requiredClaim: 'exact_time_selected',
      semanticAcknowledgmentClaim: 'exact_time_selected',
      skipWhenClaim: 'normalized_time_owner_value',
      mutationValue: mutation('browser_evaluate', {
        element: ownerAccessibleName || operation.targetIdentity?.accessibleName || `<locator ${ownerRef}>`,
        target: ownerRef,
        // Keep the transient/virtualized popup lifecycle inside one gateway
        // mutation. Passing an option ref through a later snapshot lets the
        // popup close or rerender before selection and recreates a live-lock.
        function: buildTimeOptionSelectionFunction({ expectedTime: time }),
      }, 'select-time-option'),
    }),
    phase({
      phaseId: 'owner-readback',
      kind: PHASE_KIND.OBSERVE,
      requiredClaim: 'normalized_time_owner_value',
      acceptSemanticAcknowledgmentClaim: 'exact_time_selected',
      observationAttempts: 1,
      final: true,
    }),
  ], {
    ownerRef,
    ownerAccessibleName: ownerAccessibleName
      || operation.targetIdentity?.accessibleName
      || operation.targetIdentity?.label,
    normalizedTime: time,
    valueKind: 'time',
    popupOpenAloneNeverCommits: true,
  });
}

function phaseOccurrenceId(protocolValue, phaseValue) {
  return `${protocolValue.actionOccurrenceId}:phase:${phaseValue.phaseId}:1`;
}

function protocolDirective(protocolValue, phaseIndex, facts = {}) {
  const phases = protocolValue?.phases || [];
  if (phaseIndex >= phases.length) {
    return Object.freeze({ status: DIRECTIVE_STATUS.COMPLETE, phase: null, mutation: null });
  }
  const current = phases[phaseIndex];
  if (facts.requiredClaimMatched !== true) {
    if (current.kind === PHASE_KIND.OBSERVE && current.dynamicCandidate) {
      return Object.freeze({
        status: DIRECTIVE_STATUS.RESOLVE_EXACT_CANDIDATE,
        phase: current,
        mutation: null,
        candidateKind: current.dynamicCandidate,
      });
    }
    if (current.kind === PHASE_KIND.OBSERVE) {
      return Object.freeze({ status: DIRECTIVE_STATUS.OBSERVE, phase: current, mutation: null });
    }
    if (!current.mutation && current.dynamicCandidate) {
      const candidateRef = clean(facts.candidateRef);
      if (!candidateRef) {
        return Object.freeze({
          status: DIRECTIVE_STATUS.RESOLVE_EXACT_CANDIDATE,
          phase: current,
          mutation: null,
          candidateKind: current.dynamicCandidate,
        });
      }
      return Object.freeze({
        status: DIRECTIVE_STATUS.READY_FOR_MUTATION,
        phase: current,
        mutation: mutation('browser_click', { target: candidateRef }, current.phaseId),
        phaseOccurrenceId: phaseOccurrenceId(protocolValue, current),
      });
    }
    return Object.freeze({
      status: DIRECTIVE_STATUS.READY_FOR_MUTATION,
      phase: current,
      mutation: current.mutation,
      phaseOccurrenceId: phaseOccurrenceId(protocolValue, current),
    });
  }
  if (current.final) {
    return Object.freeze({ status: DIRECTIVE_STATUS.COMPLETE, phase: current, mutation: null });
  }
  return protocolDirective(protocolValue, phaseIndex + 1, {});
}

module.exports = {
  PROTOCOL_VERSION,
  PROTOCOL_KIND,
  PHASE_KIND,
  DIRECTIVE_STATUS,
  OPTION_RESOLUTION_STATUS,
  ControllerCompositeProtocolError,
  selectionValue,
  normalizeTime,
  normalizeDate,
  resolveExactOptionCandidate,
  createDropdownProtocol,
  createCalendarProtocol,
  createTimeProtocol,
  phaseOccurrenceId,
  protocolDirective,
};
