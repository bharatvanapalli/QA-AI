'use strict';

const {
  DELIVERY_STATUS,
} = require('./controllerActionExecutionGateway');
const {
  PROOF_STATUS,
  EVIDENCE_TIER,
} = require('./browserProofContract');
const {
  PHASE_KIND,
  selectionValue,
  normalizeTime,
  normalizeDate,
  OPTION_RESOLUTION_STATUS,
  resolveExactOptionCandidate,
} = require('./controllerCompositeProtocols');
const {
  dispatchWindow,
} = require('./browserTransactionController');

const COMPOSITE_EXECUTOR_VERSION = 'qaai-controller-composite-executor-v1';

class ControllerCompositeExecutorError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerCompositeExecutorError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function claimStatus(observation, claimId) {
  const claims = Array.isArray(observation?.claims) ? observation.claims : [];
  const matching = claims.filter((claim) => clean(claim?.claimId || claim?.id) === claimId);
  if (!matching.length) return PROOF_STATUS.UNKNOWN;
  const strongestTier = Math.max(...matching.map((claim) => Number(claim.tier) || 0));
  const strongest = matching.filter((claim) => Number(claim.tier) === strongestTier);
  const statuses = new Set(strongest.map((claim) => clean(claim.status).toUpperCase()));
  if (statuses.has(PROOF_STATUS.MATCHED) && statuses.has(PROOF_STATUS.MISMATCH)) {
    return PROOF_STATUS.UNKNOWN;
  }
  if (statuses.has(PROOF_STATUS.MATCHED)) return PROOF_STATUS.MATCHED;
  if (statuses.has(PROOF_STATUS.MISMATCH)) return PROOF_STATUS.MISMATCH;
  return PROOF_STATUS.UNKNOWN;
}

function claimReason(observation, claimId) {
  const claims = Array.isArray(observation?.claims) ? observation.claims : [];
  const matching = claims
    .filter((claim) => clean(claim?.claimId || claim?.id) === claimId)
    .sort((left, right) => Number(right?.tier || 0) - Number(left?.tier || 0));
  return clean(matching[0]?.reason) || null;
}

function factRefsOf(...values) {
  return Object.freeze([
    ...new Set(values.flatMap((value) => (
      Array.isArray(value?.factRefs) ? value.factRefs
        : value?.factRef ? [value.factRef]
          : []
    )).map(clean).filter(Boolean)),
  ]);
}

function requestedCandidate(protocol, candidateKind) {
  const metadata = protocol?.metadata || {};
  if (candidateKind === 'option') return selectionValue(metadata.selection);
  if (candidateKind === 'time') return metadata.normalizedTime;
  if (candidateKind === 'year_control') return 'Choose Year';
  if (candidateKind === 'month_control') return 'Choose Month';
  if (candidateKind === 'year') return metadata.year;
  if (candidateKind === 'month') return metadata.month;
  if (candidateKind === 'day') return String(Number(metadata.day));
  return null;
}

function monthAliases(value) {
  const month = Number(value);
  if (!Number.isInteger(month) || month < 1 || month > 12) return [];
  const date = new Date(Date.UTC(2020, month - 1, 1));
  return [
    String(month),
    String(month).padStart(2, '0'),
    date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
    date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
  ];
}

function normalizedCandidateToken(value, candidateKind) {
  if (candidateKind === 'time') return normalizeTime(value);
  if (candidateKind === 'month') return clean(value).toLocaleLowerCase('en-US');
  if (candidateKind === 'day' || candidateKind === 'year') return String(Number(value));
  return clean(value).toLocaleLowerCase('en-US');
}

function temporalCandidateRoleScore(candidate, candidateKind, popupAssociated) {
  const role = clean(candidate?.role).toLowerCase();
  const section = clean(candidate?.section || candidate?.parentName).toLowerCase();
  if (candidateKind === 'year_control' || candidateKind === 'month_control') {
    return role === 'button' ? 100 : 0;
  }
  if (candidateKind === 'time') {
    if (['option', 'menuitem', 'listitem', 'radio'].includes(role)) return 100;
    if (role === 'button') return 90;
    if (role === 'generic') return 10;
    return 40;
  }
  if (!['year', 'month', 'day'].includes(candidateKind)) return 1;
  if (role === 'button') return 100;
  if (role === 'gridcell' || role === 'cell') return 90;
  if (role === 'option' || role === 'listitem' || role === 'radio') return 80;
  if (popupAssociated && role === 'generic') {
    return /\b(?:date|calendar|month|year|decade)\b/.test(section) ? 60 : 10;
  }
  return 0;
}

function resolveDynamicCandidate(protocol, phase, observation, {
  popupAssociated = false,
} = {}) {
  const requested = requestedCandidate(protocol, phase.dynamicCandidate);
  if (phase.dynamicCandidate === 'option') {
    const ownerRef = clean(protocol?.metadata?.ownerRef);
    const optionRoles = new Set(['option', 'menuitem', 'listitem', 'radio']);
    const popupOwnershipProven = observation?.popupOwnership?.proven === true;
    const ownedOptionTokens = new Set(
      (Array.isArray(observation?.popupOwnership?.ownedOptionNames)
        ? observation.popupOwnership.ownedOptionNames
        : [])
        .map((value) => normalizedCandidateToken(value, 'option'))
        .filter(Boolean),
    );
    const candidates = (Array.isArray(observation?.candidates) ? observation.candidates : [])
      .map((candidate) => {
        const explicitOwner = clean(
          candidate?.ownerBackendNodeId
            || candidate?.ownerNodeId
            || candidate?.ownerRef
            || candidate?.associatedOwnerId
            || candidate?.ownerIdentity?.backendNodeId
            || candidate?.ownerIdentity?.ref,
        );
        if (explicitOwner || !optionRoles.has(clean(candidate?.role).toLowerCase())) {
          return candidate;
        }
        const candidateToken = normalizedCandidateToken(
          candidate?.label
            ?? candidate?.text
            ?? candidate?.accessibleName
            ?? candidate?.name
            ?? candidate?.value,
          'option',
        );
        if (!popupAssociated
          || !popupOwnershipProven
          || !ownedOptionTokens.has(candidateToken)) {
          return candidate;
        }
        return Object.freeze({
          ...candidate,
          ownerRef,
          ownerCorrelation: 'exact_dom_controlled_popup_option_name',
        });
      });
    const resolved = resolveExactOptionCandidate({
      selection: protocol?.metadata?.selection,
      candidates,
      owner: { ref: ownerRef },
      valueKind: protocol?.metadata?.valueKind || 'text',
    });
    return Object.freeze({
      status: resolved.status,
      candidate: resolved.candidate,
      candidates: resolved.candidates,
      factRefs: factRefsOf(observation, resolved.candidate),
      reason: resolved.reason,
      mayObserveMore: resolved.mayObserveMore,
    });
  }
  const aliases = phase.dynamicCandidate === 'month'
    ? monthAliases(requested)
    : phase.dynamicCandidate === 'year_control'
      ? ['Choose Year', 'Select Year', 'Year']
      : phase.dynamicCandidate === 'month_control'
        ? ['Choose Month', 'Select Month', 'Month']
        : [requested];
  const accepted = new Set(aliases.map((value) => normalizedCandidateToken(value, phase.dynamicCandidate)).filter(Boolean));
  const candidates = (Array.isArray(observation?.candidates) ? observation.candidates : [])
    .filter((candidate) => candidate?.actionable !== false && candidate?.disabled !== true)
    .map((candidate) => Object.freeze({
      candidate,
      roleScore: temporalCandidateRoleScore(
        candidate,
        phase.dynamicCandidate,
        popupAssociated,
      ),
    }))
    .filter((entry) => entry.roleScore > 0)
    .filter((entry) => accepted.has(normalizedCandidateToken(
      entry.candidate.accessibleName
        || entry.candidate.name
        || entry.candidate.label
        || entry.candidate.text
        || entry.candidate.value,
      phase.dynamicCandidate,
    )))
    .map((entry) => entry)
    .sort((left, right) => right.roleScore - left.roleScore)
    .map((entry) => Object.freeze({
      ...entry.candidate,
      dynamicRoleScore: entry.roleScore,
    }));
  const uniqueByRef = new Map();
  for (const candidate of candidates) {
    const ref = clean(candidate.ref || candidate.reference);
    if (ref) uniqueByRef.set(ref, candidate);
  }
  const unique = [...uniqueByRef.values()];
  const strongest = unique.length
    ? unique.filter((candidate) => (
      candidate.dynamicRoleScore === unique[0].dynamicRoleScore
    ))
    : [];
  if (strongest.length === 1) {
    return Object.freeze({
      status: 'RESOLVED',
      candidate: strongest[0],
      factRefs: factRefsOf(observation, strongest[0]),
    });
  }
  if (strongest.length !== 1) {
    return Object.freeze({
      status: strongest.length ? 'AMBIGUOUS' : 'NOT_FOUND',
      candidate: null,
      factRefs: factRefsOf(observation),
    });
  }
  return Object.freeze({ status: 'NOT_FOUND', candidate: null, factRefs: factRefsOf(observation) });
}

function createControllerCompositeExecutor({
  observer,
  gateway,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  maxObservationAttempts = 5,
  observationIntervalMs = 125,
} = {}) {
  if (typeof observer !== 'function') throw new TypeError('Composite executor requires observer().');
  if (!gateway || typeof gateway.dispatch !== 'function') {
    throw new TypeError('Composite executor requires gateway.dispatch().');
  }

  const execute = async ({
    authority,
    operation,
    resolution,
    plan,
    context = {},
    remainingMs,
    onFirstDispatch = () => {},
  } = {}) => {
    const protocol = plan?.protocol;
    if (!protocol || !Array.isArray(protocol.phases) || !protocol.phases.length) {
      throw new ControllerCompositeExecutorError(
        'Composite execution requires a typed protocol with phases.',
        'CONTROLLER_COMPOSITE_PROTOCOL_REQUIRED',
      );
    }
    const committedCandidateEvidence = () => (
      lastCommittedDynamicCandidate
        ? Object.freeze({
          ref: clean(lastCommittedDynamicCandidate.ref || lastCommittedDynamicCandidate.reference) || null,
          accessibleName: clean(
            lastCommittedDynamicCandidate.accessibleName
              || lastCommittedDynamicCandidate.name
              || lastCommittedDynamicCandidate.label,
          ) || null,
        })
        : null
    );
    const deadlineAt = Number(now()) + Math.max(1, Number(remainingMs) || 1);
    const factRefs = [];
    let candidate = null;
    // Mirrors `candidate` but survives the per-phase reset below. This is the
    // only record of which dynamically-resolved option/candidate a
    // dynamicCandidate mutation actually dispatched against — evidence
    // capture (controllerMcpRuntimeAdapter.js#captureVerifiedLocator) needs
    // this exact ref, not the trigger/owner ref a plain resolver() call
    // would have recorded, to render Select/Radio-style composite steps
    // correctly.
    let lastCommittedDynamicCandidate = null;
    let firstDispatch = true;
    let lastDelivery = null;
    let popupAssociated = false;
    const semanticAcknowledgments = new Map();

    const observePhase = async (phase, phaseIndex) => {
      let lastObservation = null;
      const observationAttempts = phase?.observationAttempts != null
        && Number.isInteger(Number(phase.observationAttempts))
        ? Math.max(1, Math.min(maxObservationAttempts, Number(phase.observationAttempts)))
        : maxObservationAttempts;
      for (let attempt = 1; attempt <= observationAttempts; attempt += 1) {
        const phaseRemainingMs = deadlineAt - Number(now());
        if (phaseRemainingMs <= 0) break;
        lastObservation = await observer({
          operation,
          resolution,
          plan: Object.freeze({ ...plan, protocolPhase: phase, protocolPhaseIndex: phaseIndex }),
          phase: `protocol:${phase.phaseId}`,
          attempt,
          remainingMs: phaseRemainingMs,
          delivery: lastDelivery,
          context,
        });
        factRefs.push(...factRefsOf(lastObservation));
        if (lastObservation?.sessionLost || lastObservation?.manualBoundary) return lastObservation;
        if (phase.dynamicCandidate) {
          const dynamic = resolveDynamicCandidate(protocol, phase, lastObservation, {
            popupAssociated,
          });
          factRefs.push(...dynamic.factRefs);
          if (dynamic.status === 'RESOLVED') {
            candidate = dynamic.candidate;
            return Object.freeze({
              ...lastObservation,
              dynamicCandidateResolved: true,
            });
          }
          if (dynamic.status === 'AMBIGUOUS') {
            return Object.freeze({
              ...lastObservation,
              dynamicCandidateAmbiguous: true,
              dynamicCandidateReason: dynamic.reason,
            });
          }
          if (dynamic.mayObserveMore === false) {
            return Object.freeze({
              ...lastObservation,
              dynamicCandidateRejected: true,
              dynamicCandidateReason: dynamic.reason,
            });
          }
        } else {
          const status = claimStatus(lastObservation, phase.requiredClaim);
          if (status !== PROOF_STATUS.UNKNOWN) {
            return Object.freeze({
              ...lastObservation,
              requiredClaimStatus: status,
              requiredClaimReason: claimReason(lastObservation, phase.requiredClaim),
            });
          }
        }
        if (attempt < observationAttempts) {
          await sleep(Math.min(observationIntervalMs, Math.max(0, deadlineAt - Number(now()))));
        }
      }
      return lastObservation;
    };

    for (let phaseIndex = 0; phaseIndex < protocol.phases.length; phaseIndex += 1) {
      const protocolPhase = protocol.phases[phaseIndex];
      if (Number(now()) >= deadlineAt) break;
      if (protocolPhase.kind === PHASE_KIND.OBSERVE) {
        const observation = await observePhase(protocolPhase, phaseIndex);
        if (observation?.sessionLost) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.UNKNOWN,
              sessionLost: true,
              reason: 'browser_session_lost',
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        if (observation?.manualBoundary) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.UNKNOWN,
              manualBoundary: true,
              reason: 'manual_boundary_observed',
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        const matched = protocolPhase.dynamicCandidate
          ? observation?.dynamicCandidateResolved === true
          : observation?.requiredClaimStatus === PROOF_STATUS.MATCHED;
        const acknowledgedClaim = clean(protocolPhase.acceptSemanticAcknowledgmentClaim);
        const exactSemanticAcknowledgment = acknowledgedClaim
          ? semanticAcknowledgments.get(acknowledgedClaim)
          : null;
        if (!matched && protocolPhase.final && exactSemanticAcknowledgment) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.MATCHED,
              reason: `composite_protocol_committed:semantic-acknowledgment:${acknowledgedClaim}`,
              factRefs: Object.freeze([
                ...new Set([...factRefs, ...factRefsOf(exactSemanticAcknowledgment)]),
              ]),
            },
            delivery: lastDelivery,
            semanticAcknowledgment: exactSemanticAcknowledgment,
            // Virtualized/autocomplete selection commits via an in-page
            // browser_evaluate scan, never a resolved candidate ref — there is
            // nothing to report here, and that's an accurate reflection of
            // how this path works, not a missed capture.
            committedCandidate: null,
          });
        }
        if (!matched) {
          return Object.freeze({
            proof: {
              status: observation?.requiredClaimStatus === PROOF_STATUS.MISMATCH
                ? PROOF_STATUS.MISMATCH
                : PROOF_STATUS.UNKNOWN,
              reason: observation?.dynamicCandidateAmbiguous
                ? 'composite_candidate_ambiguous'
                : observation?.dynamicCandidateRejected
                  ? observation.dynamicCandidateReason || 'composite_candidate_rejected'
                  : observation?.requiredClaimReason
                    || `composite_phase_unproven:${protocolPhase.phaseId}`,
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        if (protocolPhase.requiredClaim === 'associated_popup_open') {
          popupAssociated = true;
        }
        if (protocolPhase.final) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.MATCHED,
              reason: `composite_protocol_committed:${protocolPhase.phaseId}`,
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
            committedCandidate: committedCandidateEvidence(),
          });
        }
        continue;
      }

      // A controller-level recovery re-enters the same authored occurrence.
      // Before asking the exactly-once gateway for a mutation phase again,
      // observe that phase's declared effect. If it is already true, resume at
      // the next phase without redispatching the successful browser action.
      if (context.resumeCompositePhases === true && protocolPhase.requiredClaim) {
        const recoveryObservation = await observePhase(Object.freeze({
          ...protocolPhase,
          kind: PHASE_KIND.OBSERVE,
          dynamicCandidate: null,
          skipWhenClaim: null,
        }), phaseIndex);
        if (recoveryObservation?.sessionLost) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.UNKNOWN,
              sessionLost: true,
              reason: 'browser_session_lost',
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        if (recoveryObservation?.manualBoundary) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.UNKNOWN,
              manualBoundary: true,
              reason: 'manual_boundary_observed',
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        if (recoveryObservation?.requiredClaimStatus === PROOF_STATUS.MATCHED) {
          if (protocolPhase.requiredClaim === 'associated_popup_open') popupAssociated = true;
          continue;
        }
      }

      if (protocolPhase.skipWhenClaim) {
        const skipObservation = await observePhase(Object.freeze({
          ...protocolPhase,
          kind: PHASE_KIND.OBSERVE,
          requiredClaim: protocolPhase.skipWhenClaim,
          dynamicCandidate: null,
        }), phaseIndex);
        if (skipObservation?.sessionLost) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.UNKNOWN,
              sessionLost: true,
              reason: 'browser_session_lost',
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        if (skipObservation?.manualBoundary) {
          return Object.freeze({
            proof: {
              status: PROOF_STATUS.UNKNOWN,
              manualBoundary: true,
              reason: 'manual_boundary_observed',
              factRefs: Object.freeze([...new Set(factRefs)]),
            },
            delivery: lastDelivery,
          });
        }
        if (claimStatus(skipObservation, protocolPhase.skipWhenClaim) === PROOF_STATUS.MATCHED) {
          if (protocolPhase.skipWhenClaim === 'associated_popup_open') {
            popupAssociated = true;
          }
          continue;
        }
      }

      const mutation = protocolPhase.mutation || (
        protocolPhase.dynamicCandidate && candidate
          ? {
            toolName: 'browser_click',
            args: { target: candidate.ref || candidate.reference },
            phaseId: protocolPhase.phaseId,
          }
          : null
      );
      if (!mutation) {
        return Object.freeze({
          proof: {
            status: PROOF_STATUS.UNKNOWN,
            reason: `composite_mutation_candidate_missing:${protocolPhase.phaseId}`,
            factRefs: Object.freeze([...new Set(factRefs)]),
          },
          delivery: lastDelivery,
        });
      }
      const remainingBeforeDispatchMs = Math.max(1, deadlineAt - Number(now()));
      const { dispatchBudgetMs } = dispatchWindow(
        remainingBeforeDispatchMs,
        Math.max(1, Number(remainingMs) || remainingBeforeDispatchMs),
      );
      let dispatchTimer = null;
      try {
        lastDelivery = await Promise.race([
          gateway.dispatch({
            authority,
            operation,
            plan: Object.freeze({ ...plan, mutation }),
            context,
            remainingMs: dispatchBudgetMs,
          }),
          new Promise((_, reject) => {
            dispatchTimer = setTimer(() => reject(Object.assign(
              new Error('Composite dispatch exceeded its reserved sub-deadline.'),
              { code: 'CONTROLLER_COMPOSITE_DISPATCH_DEADLINE' },
            )), dispatchBudgetMs);
          }),
        ]);
      } catch (error) {
        const positivelyNotDelivered = error?.positivelyNotDelivered === true
          || error?.deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED;
        lastDelivery = Object.freeze({
          dispatchAttemptId: `dispatch:${operation.actionOccurrenceId}:${protocolPhase.phaseId}:1`,
          deliveryStatus: positivelyNotDelivered
            ? DELIVERY_STATUS.NOT_DELIVERED
            : DELIVERY_STATUS.DELIVERY_UNCERTAIN,
          reason: clean(error?.code || error?.name) || 'composite_gateway_dispatch_error',
          factRefs: Object.freeze(factRefsOf(error)),
        });
      } finally {
        if (dispatchTimer != null) clearTimer(dispatchTimer);
      }
      factRefs.push(...factRefsOf(lastDelivery));
      const semanticAcknowledgmentClaim = clean(protocolPhase.semanticAcknowledgmentClaim);
      const semanticAcknowledgment = lastDelivery?.semanticAcknowledgment;
      if (
        semanticAcknowledgmentClaim
        && semanticAcknowledgment?.ok === true
        && semanticAcknowledgment?.actionPerformed === true
        && semanticAcknowledgment?.expectedSelectionMatched === true
      ) {
        semanticAcknowledgments.set(semanticAcknowledgmentClaim, Object.freeze({
          ...semanticAcknowledgment,
          factRefs: Object.freeze(factRefsOf(lastDelivery, semanticAcknowledgment)),
        }));
      }
      if (firstDispatch) {
        firstDispatch = false;
        onFirstDispatch(lastDelivery);
      }
      if (lastDelivery.deliveryStatus === DELIVERY_STATUS.NOT_DELIVERED) {
        return Object.freeze({
          proof: {
            status: PROOF_STATUS.UNKNOWN,
            reason: lastDelivery.reason || 'composite_required_mutation_proven_undelivered',
            factRefs: Object.freeze([...new Set(factRefs)]),
          },
          delivery: lastDelivery,
          positivelyNotDelivered: true,
        });
      }
      if (protocolPhase.dynamicCandidate && candidate) {
        lastCommittedDynamicCandidate = candidate;
      }
      candidate = null;
    }

    return Object.freeze({
      proof: {
        status: PROOF_STATUS.UNKNOWN,
        reason: 'composite_operation_deadline_reached',
        factRefs: Object.freeze([...new Set(factRefs)]),
      },
      delivery: lastDelivery,
    });
  };

  return Object.freeze({
    executorVersion: COMPOSITE_EXECUTOR_VERSION,
    execute,
  });
}

module.exports = {
  COMPOSITE_EXECUTOR_VERSION,
  ControllerCompositeExecutorError,
  claimStatus,
  claimReason,
  resolveDynamicCandidate,
  temporalCandidateRoleScore,
  createControllerCompositeExecutor,
  EVIDENCE_TIER,
};
