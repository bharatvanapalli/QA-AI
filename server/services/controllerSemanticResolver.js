'use strict';

const RESOLVER_VERSION = 'qaai-controller-semantic-resolver-v1';

const RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  CONFLICT: 'CONFLICT',
  STALE: 'STALE',
});

const IDENTITY_FIELDS = Object.freeze([
  'accessibleName',
  'role',
  'framePath',
  'form',
  'section',
  'controlType',
  'backendNodeId',
]);

class ControllerSemanticResolverError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ControllerSemanticResolverError';
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

function normalizeFramePath(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const frame = clean(value);
  return frame ? [frame] : [];
}

function normalizeIdentity(value = {}) {
  const identity = value && typeof value === 'object' ? value : {};
  return Object.freeze({
    accessibleName: clean(
      identity.accessibleName
        || identity.name
        || identity.label
        || identity.text,
    ) || null,
    role: clean(identity.role) || null,
    framePath: Object.freeze(normalizeFramePath(
      identity.framePath || identity.frame || identity.frameId,
    )),
    form: clean(identity.form || identity.formName || identity.formId) || null,
    section: clean(identity.section || identity.scope || identity.region) || null,
    controlType: clean(identity.controlType || identity.type || identity.inputType) || null,
    backendNodeId: clean(identity.backendNodeId || identity.nodeId) || null,
  });
}

function normalizedComparable(field, value) {
  if (field === 'framePath') return normalizeFramePath(value).map(token).join('>');
  return token(value);
}

function identityValuePresent(field, value) {
  return field === 'framePath'
    ? Array.isArray(value) && value.length > 0
    : Boolean(clean(value));
}

function exactIdentityMatch(authored, candidate, aliases = []) {
  const mismatches = [];
  const missing = [];
  for (const field of IDENTITY_FIELDS) {
    const expected = authored[field];
    if (!identityValuePresent(field, expected)) continue;
    const actual = candidate[field];
    if (!identityValuePresent(field, actual)) {
      missing.push(field);
      continue;
    }
    if (field === 'accessibleName') {
      const accepted = [expected, ...aliases].map(token).filter(Boolean);
      if (!accepted.includes(token(actual))) mismatches.push(field);
      continue;
    }
    if (normalizedComparable(field, expected) !== normalizedComparable(field, actual)) {
      mismatches.push(field);
    }
  }
  return Object.freeze({
    exact: mismatches.length === 0 && missing.length === 0,
    mismatches: Object.freeze(mismatches),
    missing: Object.freeze(missing),
  });
}

function preferredIdentity(candidate = {}) {
  const owner = candidate.ownerIdentity && typeof candidate.ownerIdentity === 'object'
    ? normalizeIdentity(candidate.ownerIdentity)
    : null;
  const direct = normalizeIdentity(candidate.identity || candidate);
  return Object.freeze({
    identity: owner || direct,
    promotedFromInnerControl: Boolean(owner),
    innerIdentity: owner ? direct : null,
  });
}

function candidateKey(candidate) {
  const identity = candidate.identity;
  if (identity.backendNodeId) {
    return `backend:${identity.framePath.map(token).join('>')}:${identity.backendNodeId}`;
  }
  return `semantic:${IDENTITY_FIELDS.map((field) => normalizedComparable(field, identity[field])).join('|')}`;
}

function mergeCandidates(group) {
  const identities = group.map((candidate) => candidate.identity);
  const merged = {};
  const correlationConflicts = [];
  for (const field of IDENTITY_FIELDS) {
    const present = identities
      .map((identity) => identity[field])
      .filter((value) => identityValuePresent(field, value));
    const normalized = [...new Set(present.map((value) => normalizedComparable(field, value)))];
    if (normalized.length > 1) correlationConflicts.push(field);
    merged[field] = present[0] ?? (field === 'framePath' ? [] : null);
  }
  return Object.freeze({
    identity: normalizeIdentity(merged),
    ref: group.map((candidate) => clean(candidate.ref)).find(Boolean) || null,
    sources: Object.freeze([...new Set(group.map((candidate) => clean(candidate.source)).filter(Boolean))]),
    factRefs: Object.freeze([
      ...new Set(group.flatMap((candidate) => (
        Array.isArray(candidate.factRefs) ? candidate.factRefs : candidate.factRef ? [candidate.factRef] : []
      )).map(clean).filter(Boolean)),
    ]),
    connected: group.every((candidate) => candidate.connected !== false),
    stale: group.some((candidate) => candidate.stale === true),
    visible: group.some((candidate) => candidate.visible === true),
    actionable: group.some((candidate) => candidate.actionable === true),
    promotedFromInnerControl: group.some((candidate) => candidate.promotedFromInnerControl === true),
    correlationConflicts: Object.freeze(correlationConflicts),
  });
}

function correlateCandidates(candidateInputs = []) {
  const groups = new Map();
  for (const raw of Array.isArray(candidateInputs) ? candidateInputs : []) {
    if (!raw || typeof raw !== 'object') continue;
    const preferred = preferredIdentity(raw);
    const candidate = {
      ...raw,
      ...preferred,
    };
    const key = candidateKey(candidate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return Object.freeze([...groups.values()].map(mergeCandidates));
}

function resolveSemanticTarget({
  targetIdentity,
  aliases = [],
  candidates = [],
  browserEpoch = null,
} = {}) {
  const authored = normalizeIdentity(targetIdentity);
  if (!authored.accessibleName && !authored.backendNodeId) {
    throw new ControllerSemanticResolverError(
      'Semantic resolution requires authored accessible name or backend node identity.',
      'CONTROLLER_SEMANTIC_TARGET_IDENTITY_REQUIRED',
    );
  }
  const correlated = correlateCandidates(candidates).map((candidate) => {
    const match = exactIdentityMatch(authored, candidate.identity, aliases);
    const epochMismatch = browserEpoch != null
      && candidate.sources.length > 0
      && candidates.some((raw) => (
        candidateKey({ identity: preferredIdentity(raw).identity }) === candidateKey(candidate)
        && raw.browserEpoch != null
        && String(raw.browserEpoch) !== String(browserEpoch)
      ));
    return Object.freeze({
      ...candidate,
      match,
      stale: candidate.stale || !candidate.connected || epochMismatch,
    });
  });

  const exact = correlated.filter((candidate) => candidate.match.exact);
  const freshExact = exact.filter((candidate) => !candidate.stale);
  if (freshExact.length === 1) {
    const candidate = freshExact[0];
    return Object.freeze({
      schemaVersion: RESOLVER_VERSION,
      status: RESOLUTION_STATUS.RESOLVED,
      target: candidate,
      candidateCount: correlated.length,
      factRefs: candidate.factRefs,
      reason: candidate.promotedFromInnerControl
        ? 'exact_semantic_owner_resolved'
        : 'exact_semantic_target_resolved',
    });
  }
  if (freshExact.length > 1) {
    return Object.freeze({
      schemaVersion: RESOLVER_VERSION,
      status: RESOLUTION_STATUS.AMBIGUOUS,
      target: null,
      candidateCount: correlated.length,
      matchingCandidates: Object.freeze(freshExact),
      factRefs: Object.freeze([...new Set(freshExact.flatMap((candidate) => candidate.factRefs))]),
      reason: 'multiple_exact_semantic_targets',
    });
  }
  if (exact.length) {
    return Object.freeze({
      schemaVersion: RESOLVER_VERSION,
      status: RESOLUTION_STATUS.STALE,
      target: null,
      candidateCount: correlated.length,
      matchingCandidates: Object.freeze(exact),
      factRefs: Object.freeze([...new Set(exact.flatMap((candidate) => candidate.factRefs))]),
      reason: 'exact_semantic_target_stale',
    });
  }

  const immutableNodeConflict = authored.backendNodeId
    ? correlated.find((candidate) => (
      candidate.identity.backendNodeId === authored.backendNodeId
      && candidate.match.mismatches.length > 0
    ))
    : null;
  const correlationConflict = correlated.find((candidate) => candidate.correlationConflicts.length > 0);
  if (immutableNodeConflict || correlationConflict) {
    const conflicting = immutableNodeConflict || correlationConflict;
    return Object.freeze({
      schemaVersion: RESOLVER_VERSION,
      status: RESOLUTION_STATUS.CONFLICT,
      target: null,
      candidateCount: correlated.length,
      conflictingCandidate: conflicting,
      factRefs: conflicting.factRefs,
      reason: immutableNodeConflict
        ? 'backend_node_semantic_identity_conflict'
        : 'cross_source_identity_conflict',
    });
  }

  return Object.freeze({
    schemaVersion: RESOLVER_VERSION,
    status: RESOLUTION_STATUS.NOT_FOUND,
    target: null,
    candidateCount: correlated.length,
    factRefs: Object.freeze([]),
    reason: 'exact_semantic_target_not_found',
  });
}

module.exports = {
  RESOLVER_VERSION,
  RESOLUTION_STATUS,
  IDENTITY_FIELDS,
  ControllerSemanticResolverError,
  normalizeIdentity,
  exactIdentityMatch,
  preferredIdentity,
  correlateCandidates,
  resolveSemanticTarget,
};
