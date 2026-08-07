'use strict';

const PROOF_CONTRACT_VERSION = 'qaai-browser-proof-contract-v1';

const PROOF_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  MISMATCH: 'MISMATCH',
  UNKNOWN: 'UNKNOWN',
});

const EVIDENCE_TIER = Object.freeze({
  EXACT_LIVE_OWNER_OR_DESTINATION: 500,
  DOM_AX_CDP_CORROBORATION: 400,
  BROWSER_EVENT: 300,
  SCREENSHOT: 200,
  FINGERPRINT_OR_NARRATION: 100,
});

const STATUS_VALUES = new Set(Object.values(PROOF_STATUS));
const TIER_VALUES = new Set(Object.values(EVIDENCE_TIER));

class BrowserProofContractError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'BrowserProofContractError';
    this.code = code;
    Object.assign(this, details);
  }
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeClaim(input = {}) {
  const claimId = clean(input.claimId || input.id);
  const status = clean(input.status).toUpperCase();
  const tier = Number(input.tier);
  if (!claimId || !STATUS_VALUES.has(status) || !TIER_VALUES.has(tier)) {
    throw new BrowserProofContractError(
      'Evidence claims require claimId, canonical status, and canonical precedence tier.',
      'BROWSER_PROOF_CLAIM_INVALID',
      { claimId: claimId || null, status: status || null, tier: Number.isFinite(tier) ? tier : null },
    );
  }
  return Object.freeze({
    claimId,
    status,
    tier,
    source: clean(input.source) || null,
    factRef: clean(input.factRef) || null,
    fresh: input.fresh !== false,
    reason: clean(input.reason) || null,
  });
}

function normalizeAlternative(input = {}, index) {
  const id = clean(input.id) || `alternative:${index + 1}`;
  const allOf = [...new Set(
    (Array.isArray(input.allOf) ? input.allOf : []).map(clean).filter(Boolean),
  )];
  if (!allOf.length) {
    throw new BrowserProofContractError(
      'Each proof alternative requires at least one claim.',
      'BROWSER_PROOF_ALTERNATIVE_EMPTY',
      { alternativeId: id },
    );
  }
  return Object.freeze({ id, allOf: Object.freeze(allOf) });
}

function createProofContract(input = {}) {
  const id = clean(input.id);
  const alternatives = (Array.isArray(input.alternatives) ? input.alternatives : [])
    .map(normalizeAlternative);
  if (!id || !alternatives.length) {
    throw new BrowserProofContractError(
      'Proof contract requires an id and at least one exact alternative.',
      'BROWSER_PROOF_CONTRACT_INVALID',
      { id: id || null, alternativeCount: alternatives.length },
    );
  }
  return Object.freeze({
    schemaVersion: PROOF_CONTRACT_VERSION,
    id,
    alternatives: Object.freeze(alternatives),
  });
}

function strongestClaim(claims) {
  const fresh = claims.filter((claim) => claim.fresh !== false);
  if (!fresh.length) return null;
  const highestTier = Math.max(...fresh.map((claim) => claim.tier));
  const strongest = fresh.filter((claim) => claim.tier === highestTier);
  const statuses = new Set(strongest.map((claim) => claim.status));
  if (statuses.has(PROOF_STATUS.MATCHED) && statuses.has(PROOF_STATUS.MISMATCH)) {
    return Object.freeze({
      status: PROOF_STATUS.UNKNOWN,
      tier: highestTier,
      reason: 'equal_precedence_evidence_conflict',
      claims: Object.freeze(strongest),
    });
  }
  const decisive = strongest.find((claim) => claim.status !== PROOF_STATUS.UNKNOWN);
  return Object.freeze({
    status: decisive?.status || PROOF_STATUS.UNKNOWN,
    tier: highestTier,
    reason: decisive?.reason || 'strongest_evidence_unknown',
    claims: Object.freeze(strongest),
  });
}

function reconcileClaims(claimInputs = []) {
  const byId = new Map();
  for (const input of Array.isArray(claimInputs) ? claimInputs : []) {
    const claim = normalizeClaim(input);
    if (!byId.has(claim.claimId)) byId.set(claim.claimId, []);
    byId.get(claim.claimId).push(claim);
  }
  return new Map(
    [...byId.entries()].map(([claimId, claims]) => [claimId, strongestClaim(claims)]),
  );
}

function evaluateAnyOfProof(proofContract, claimInputs = []) {
  const contract = proofContract?.schemaVersion === PROOF_CONTRACT_VERSION
    ? proofContract
    : createProofContract(proofContract);
  const reconciled = reconcileClaims(claimInputs);
  const alternatives = contract.alternatives.map((alternative) => {
    const claims = alternative.allOf.map((claimId) => ({
      claimId,
      result: reconciled.get(claimId) || null,
    }));
    const matched = claims.every(({ result }) => result?.status === PROOF_STATUS.MATCHED);
    const mismatched = claims.some(({ result }) => result?.status === PROOF_STATUS.MISMATCH);
    return Object.freeze({
      id: alternative.id,
      status: matched
        ? PROOF_STATUS.MATCHED
        : mismatched
          ? PROOF_STATUS.MISMATCH
          : PROOF_STATUS.UNKNOWN,
      claims: Object.freeze(claims),
    });
  });

  const matchedAlternative = alternatives.find((alternative) => alternative.status === PROOF_STATUS.MATCHED);
  const status = matchedAlternative
    ? PROOF_STATUS.MATCHED
    : alternatives.every((alternative) => alternative.status === PROOF_STATUS.MISMATCH)
      ? PROOF_STATUS.MISMATCH
      : PROOF_STATUS.UNKNOWN;
  const factRefs = [
    ...new Set(
      (Array.isArray(claimInputs) ? claimInputs : [])
        .map((claim) => clean(claim?.factRef))
        .filter(Boolean),
    ),
  ];
  const exactFailureReasons = [
    ...new Set(
      alternatives
        .flatMap((alternative) => alternative.claims)
        .map(({ result }) => clean(result?.reason))
        .filter((reason) => (
          reason
          && ![
            'strongest_evidence_unknown',
            'equal_precedence_evidence_conflict',
          ].includes(reason)
        )),
    ),
  ];
  return Object.freeze({
    schemaVersion: PROOF_CONTRACT_VERSION,
    contractId: contract.id,
    status,
    matchedAlternativeId: matchedAlternative?.id || null,
    alternatives: Object.freeze(alternatives),
    factRefs: Object.freeze(factRefs),
    reason: status === PROOF_STATUS.MATCHED
      ? `matched:${matchedAlternative.id}`
      : status === PROOF_STATUS.MISMATCH
        ? exactFailureReasons.length === 1
          ? exactFailureReasons[0]
          : 'all_exact_alternatives_mismatched'
        : 'exact_proof_unavailable',
  });
}

module.exports = {
  PROOF_CONTRACT_VERSION,
  PROOF_STATUS,
  EVIDENCE_TIER,
  BrowserProofContractError,
  normalizeClaim,
  createProofContract,
  reconcileClaims,
  evaluateAnyOfProof,
};
