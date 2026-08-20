'use strict';

/**
 * RequirementUnderstandingV1 is the immutable, generation-scoped semantic
 * view of the selected requirements. It intentionally stops before scenario,
 * case, step, or TestData binding decisions.
 *
 * The contract is safe to persist inside an existing compatibility JSON field:
 * it contains source identities, hashes, verified behavior summaries, and the
 * derived document understanding, but never complete source bodies.
 */

const crypto = require('crypto');
const { buildDocumentUnderstanding } = require('./documentUnderstanding');

const SCHEMA_VERSION = 'qaai.requirement-understanding/1';
const CONTRACT_ID_PREFIX = 'ruv1-';
const HASH_PREFIX = 'sha256:';
const CONTRACT_STATUSES = new Set(['ready', 'needs_review', 'degraded']);
const DOCUMENT_SOURCE_TYPES = new Set(['upload', 'uploaded', 'document', 'file']);

const SENSITIVE_KEY_SOURCE = [
  'password',
  'passwd',
  'passcode',
  'pwd',
  'secret',
  'client[ _-]?secret',
  'api[ _-]?key',
  'access[ _-]?token',
  'refresh[ _-]?token',
  'id[ _-]?token',
  'auth(?:entication|orization)?[ _-]?token',
  'authorization',
  'token',
  'private[ _-]?key',
  'credential(?:s)?',
].join('|');

const SENSITIVE_ASSIGNMENT_RE = new RegExp(
  `(\\b(?:${SENSITIVE_KEY_SOURCE})\\b\\s*[:=]\\s*)([^\\r\\n]*)`,
  'gi',
);
const SENSITIVE_PROPERTY_RE = new RegExp(`^(?:${SENSITIVE_KEY_SOURCE})$`, 'i');
const BEARER_TOKEN_RE = /\b(Bearer\s+)([^\s,;]+)/gi;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value), 'utf8').digest('hex');
}

function hashRef(value) {
  return `${HASH_PREFIX}${sha256(value)}`;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((out, key) => {
      out[key] = stableValue(value[key]);
      return out;
    }, {});
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function uniqueSorted(values) {
  return Array.from(new Set((values || []).map(text).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

/**
 * Redact a sensitive key=value/key:value assignment through the end of its
 * source line. Losing non-secret prose on that line is preferable to retaining
 * a multi-word credential accidentally. Field names such as "Password field"
 * remain intact because they are not assignments.
 */
function redactSensitiveText(value) {
  return String(value == null ? '' : value)
    .replace(SENSITIVE_ASSIGNMENT_RE, (match, prefix, assignedValue) => {
      if (String(assignedValue || '').trim().startsWith('[REDACTED]')) return match;
      return `${prefix}[REDACTED]`;
    })
    .replace(BEARER_TOKEN_RE, '$1[REDACTED]');
}

function sanitizeForPersistence(value, propertyName = null) {
  if (value == null) return value;
  if (typeof value === 'string') {
    if (propertyName && SENSITIVE_PROPERTY_RE.test(propertyName)) return '[REDACTED]';
    return redactSensitiveText(value);
  }
  if (typeof value !== 'object') {
    if (propertyName && SENSITIVE_PROPERTY_RE.test(propertyName)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeForPersistence(item));
  return Object.keys(value).reduce((out, key) => {
    out[key] = sanitizeForPersistence(value[key], key);
    return out;
  }, {});
}

function normalizeRequirement(raw = {}) {
  const sourceType = text(raw.sourceType || raw.source || 'unknown').toLowerCase() || 'unknown';
  const sourceIdentifier = text(raw.sourceIdentifier || raw.externalId) || null;
  const storyId = text(raw.storyId || raw.storyKey) || null;
  const content = String(raw.content == null ? raw.description == null ? '' : raw.description : raw.content);
  const fallbackIdentity = stableStringify({
    sourceType,
    sourceIdentifier,
    storyId,
    title: text(raw.title || raw.name),
    contentHash: sha256(content),
  });
  const id = text(raw.id) || sourceIdentifier || storyId || `requirement-${sha256(fallbackIdentity).slice(0, 24)}`;
  const explicitDocumentId = text(raw.documentId || raw.sourceDocId) || null;
  const documentId = explicitDocumentId
    || (DOCUMENT_SOURCE_TYPES.has(sourceType) ? sourceIdentifier : null);

  return {
    id,
    sourceType,
    sourceIdentifier,
    storyId,
    documentId,
    title: text(raw.title || raw.name) || null,
    category: text(raw.category) || (sourceType === 'unknown' ? 'user-stories' : sourceType),
    content,
    contentHash: hashRef(content),
    charCount: content.length,
  };
}

function normalizeRequirements(requirements) {
  const byId = new Map();
  for (const raw of Array.isArray(requirements) ? requirements : []) {
    const candidate = normalizeRequirement(raw || {});
    const existing = byId.get(candidate.id);
    if (!existing || stableStringify(candidate) < stableStringify(existing)) byId.set(candidate.id, candidate);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function synthesizeClausesFromRequirement(requirement) {
  const content = text(requirement && requirement.content);
  if (!content) return [];
  const lines = content.split(/\r?\n/)
    .map((l) => text(l.replace(/^\s*[-*•\d.]+\s*/, '')))
    .filter((l) => l.length >= 6);
  if (!lines.length) return [];
  return lines.map((line, idx) => ({
    id: `clause-auto-${requirement.id}-${idx + 1}`,
    sourceType: text(requirement.sourceType) || 'USER_STORY',
    sourceDocId: requirement.documentId || requirement.id,
    storyId: requirement.storyId || requirement.sourceIdentifier || requirement.id,
    spanStart: idx * 50,
    behaviourText: line,
    excerpt: line,
    testable: true,
  }));
}

function clauseText(clause) {
  return text(clause && (clause.behaviourText || clause.behaviorText || clause.excerpt));
}

function clauseIdentity(clause = {}) {
  return text(clause.id) || `clause-${sha256(stableStringify({
    sourceType: text(clause.sourceType),
    sourceDocId: text(clause.sourceDocId),
    storyId: text(clause.storyId),
    spanStart: Number.isFinite(Number(clause.spanStart)) ? Number(clause.spanStart) : null,
    behavior: clauseText(clause),
  })).slice(0, 24)}`;
}

function normalizeClauses(clauses) {
  const byId = new Map();
  for (const raw of Array.isArray(clauses) ? clauses : []) {
    const candidate = { ...(raw || {}), id: clauseIdentity(raw || {}) };
    const existing = byId.get(candidate.id);
    if (!existing || stableStringify(candidate) < stableStringify(existing)) byId.set(candidate.id, candidate);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const aDoc = text(a.sourceDocId);
    const bDoc = text(b.sourceDocId);
    if (aDoc !== bDoc) return aDoc.localeCompare(bDoc);
    const aSpan = Number.isFinite(Number(a.spanStart)) ? Number(a.spanStart) : Number.MAX_SAFE_INTEGER;
    const bSpan = Number.isFinite(Number(b.spanStart)) ? Number(b.spanStart) : Number.MAX_SAFE_INTEGER;
    if (aSpan !== bSpan) return aSpan - bSpan;
    return a.id.localeCompare(b.id);
  });
}

function requirementRefs(requirement) {
  return new Set([
    requirement.id,
    requirement.sourceIdentifier,
    requirement.storyId,
    requirement.documentId,
  ].map(text).filter(Boolean));
}

function clauseRefs(clause) {
  return new Set([
    clause.sourceDocId,
    clause.storyId,
    clause.requirementId,
    clause.sourceIdentifier,
  ].map(text).filter(Boolean));
}

function setsIntersect(left, right) {
  for (const item of left) if (right.has(item)) return true;
  return false;
}

function filterClausesForSelectedRequirements({ requirements = [], requirementClauses = [] } = {}) {
  const selectedRequirements = normalizeRequirements(requirements);
  const selectedRefs = new Set();
  for (const requirement of selectedRequirements) {
    for (const ref of requirementRefs(requirement)) selectedRefs.add(ref);
  }

  const selectedDocumentIds = uniqueSorted(selectedRequirements.map((requirement) => requirement.documentId));
  const clauses = [];
  const excludedClauses = [];

  for (const clause of normalizeClauses(requirementClauses)) {
    const included = selectedRefs.size > 0 && setsIntersect(selectedRefs, clauseRefs(clause));
    (included ? clauses : excludedClauses).push(clause);
  }

  return { clauses, excludedClauses, selectedDocumentIds };
}

function requirementHasClause(requirement, clauses) {
  const refs = requirementRefs(requirement);
  return clauses.some((clause) => setsIntersect(refs, clauseRefs(clause)));
}

function behaviorFromClause(clause) {
  const behavior = clauseText(clause);
  const explicitlyNonTestable = clause.testable === false
    || text(clause.sourceType).toUpperCase() === 'NON_TESTABLE';
  return {
    id: clause.id,
    storyId: text(clause.storyId) || null,
    sourceType: text(clause.sourceType) || 'REQUIREMENT',
    sourceDocId: text(clause.sourceDocId) || null,
    behaviorHash: hashRef(behavior),
    redactedBehaviorText: redactSensitiveText(behavior).slice(0, 600),
    testable: !explicitlyNonTestable,
    nonTestableReason: explicitlyNonTestable
      ? text(clause.nonTestableReason || clause.reason) || 'The verified requirement clause is marked non-testable.'
      : null,
    coverageDisposition: text(clause.coverageDisposition)
      || (explicitlyNonTestable ? 'excluded_non_testable' : 'required'),
  };
}

function sortEvidence(list) {
  return (Array.isArray(list) ? list : [])
    .map((item) => sanitizeForPersistence(item))
    .sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function canonicalizeUnderstanding(raw) {
  const sanitized = sanitizeForPersistence(raw || {});
  const modules = (sanitized.modules || []).map((module) => ({
    ...module,
    sourceEvidence: sortEvidence(module.sourceEvidence),
    dataNeeds: (module.dataNeeds || []).map((need) => ({
      ...need,
      evidence: sortEvidence(need.evidence),
    })).sort((a, b) => `${text(a.key)}:${text(a.moduleKey)}`.localeCompare(`${text(b.key)}:${text(b.moduleKey)}`)),
  })).sort((a, b) => `${text(a.key)}:${text(a.name)}`.localeCompare(`${text(b.key)}:${text(b.name)}`));

  const withEvidence = (items) => (items || []).map((item) => ({
    ...item,
    evidence: sortEvidence(item.evidence),
  })).sort((a, b) => `${text(a.key)}:${text(a.name)}`.localeCompare(`${text(b.key)}:${text(b.name)}`));

  const dataNeeds = (sanitized.dataNeeds || []).map((need) => ({
    ...need,
    evidence: sortEvidence(need.evidence),
  })).sort((a, b) => `${text(a.moduleKey)}:${text(a.key)}`.localeCompare(`${text(b.moduleKey)}:${text(b.key)}`));

  const testability = sanitized.testability || {};
  const samples = testability.samples || {};

  return {
    readiness: sanitized.readiness || null,
    summary: sanitized.summary || null,
    modules,
    roles: withEvidence(sanitized.roles),
    entities: withEvidence(sanitized.entities),
    dataNeeds,
    testability: {
      ...testability,
      samples: {
        automatable: sortEvidence(samples.automatable),
        needsReview: sortEvidence(samples.needsReview),
        notAutomatable: sortEvidence(samples.notAutomatable),
      },
    },
    unmapped: sanitized.unmapped == null ? null : sanitized.unmapped,
  };
}

function issue(code, severity, sourceRef, detail) {
  return {
    code,
    severity,
    sourceRef: sourceRef || null,
    detail: redactSensitiveText(detail),
  };
}

function buildRequirementUnderstandingV1({
  projectId,
  sprintId = null,
  requirements = [],
  requirementClauses = [],
  builtAt = null,
} = {}) {
  const selectedRequirements = normalizeRequirements(requirements);
  const filtered = filterClausesForSelectedRequirements({
    requirements: selectedRequirements,
    requirementClauses,
  });
  const scopedClauses = [...filtered.clauses];

  // Auto-synthesize clauses for uploaded document sources if no pre-parsed DB clauses exist
  for (const req of selectedRequirements) {
    if (!requirementHasClause(req, scopedClauses) && DOCUMENT_SOURCE_TYPES.has(text(req.sourceType).toLowerCase())) {
      const syn = synthesizeClausesFromRequirement(req);
      for (const c of syn) scopedClauses.push(c);
    }
  }

  const behaviors = scopedClauses.map(behaviorFromClause);

  const provisionalRequirements = selectedRequirements.filter(
    (requirement) => !requirementHasClause(requirement, scopedClauses),
  );
  const provisionalSources = provisionalRequirements.map((requirement) => ({
    requirementId: requirement.id,
    sourceType: requirement.sourceType,
    sourceIdentifier: requirement.sourceIdentifier,
    title: requirement.title ? redactSensitiveText(requirement.title) : null,
    contentHash: requirement.contentHash,
    charCount: requirement.charCount,
    reason: 'no_verified_clause',
  }));

  const documents = selectedRequirements.map((requirement) => ({
    id: requirement.documentId || requirement.id,
    name: requirement.title || requirement.id,
    category: requirement.category,
    content: requirement.content,
  }));

  // DocumentUnderstanding prefers verified clauses when any are supplied. Add
  // provisional semantic inputs only for sources that have no verified clause,
  // so external (ADO/Jira) stories still contribute roles/data needs without
  // being misrepresented as verified behavior records in this contract.
  const provisionalSemanticInputs = provisionalRequirements
    .filter((requirement) => text(requirement.content))
    .map((requirement) => ({
      id: `provisional:${requirement.id}`,
      sourceType: `PROVISIONAL_${requirement.sourceType.toUpperCase()}`,
      sourceDocId: requirement.documentId || requirement.sourceIdentifier || requirement.id,
      storyId: requirement.storyId || requirement.sourceIdentifier || null,
      behaviourText: requirement.content,
      excerpt: requirement.content,
    }));

  const semanticInputs = scopedClauses.concat(provisionalSemanticInputs);
  const rawUnderstanding = buildDocumentUnderstanding({
    project: { id: text(projectId) || null, name: null, targetUrl: null },
    documents,
    requirementClauses: semanticInputs,
  });
  const understanding = canonicalizeUnderstanding({
    readiness: rawUnderstanding.readiness,
    summary: rawUnderstanding.summary,
    modules: rawUnderstanding.modules,
    roles: rawUnderstanding.roles,
    entities: rawUnderstanding.entities,
    dataNeeds: rawUnderstanding.dataNeeds,
    testability: rawUnderstanding.testability,
    unmapped: rawUnderstanding.unmapped,
  });

  const issues = [];
  if (!selectedRequirements.length) {
    issues.push(issue('no_selected_requirements', 'error', null, 'No requirements were selected for understanding.'));
  }
  for (const source of provisionalSources) {
    issues.push(issue(
      'requirement_without_verified_clause',
      'warning',
      source.requirementId,
      'The selected requirement has no verified atomic RequirementClause and remains provisional.',
    ));
  }
  for (const clause of filtered.excludedClauses) {
    issues.push(issue(
      'clause_outside_selected_requirement_scope',
      'info',
      clause.id,
      'A project clause was excluded because it is not linked to a selected requirement source.',
    ));
  }
  if (selectedRequirements.length && !behaviors.length) {
    issues.push(issue(
      'no_verified_behaviors',
      'warning',
      null,
      'The selected sources contain no verified atomic behavior clauses.',
    ));
  }

  const hasUsableSemanticSource = behaviors.length > 0
    || provisionalSources.some((source) => source.charCount > 0);
  if (selectedRequirements.length && !hasUsableSemanticSource) {
    issues.push(issue(
      'no_semantic_source_text',
      'error',
      null,
      'The selected requirements contain neither verified behavior nor readable source text.',
    ));
  }

  issues.sort((a, b) => `${a.severity}:${a.code}:${text(a.sourceRef)}`
    .localeCompare(`${b.severity}:${b.code}:${text(b.sourceRef)}`));

  let status = 'ready';
  if (!selectedRequirements.length || !hasUsableSemanticSource) status = 'degraded';
  else if (provisionalSources.length > 0 || understanding.readiness?.status !== 'ready_for_test_data') status = 'needs_review';

  const sourceSnapshotBasis = {
    requirements: selectedRequirements.map((requirement) => ({
      id: requirement.id,
      sourceType: requirement.sourceType,
      sourceIdentifier: requirement.sourceIdentifier,
      documentId: requirement.documentId,
      storyId: requirement.storyId,
      contentHash: requirement.contentHash,
    })),
    behaviors: behaviors.map((behavior) => ({ id: behavior.id, behaviorHash: behavior.behaviorHash })),
  };
  const sourceSnapshot = {
    requirementIds: selectedRequirements.map((requirement) => requirement.id),
    documentIds: filtered.selectedDocumentIds,
    sourceHash: hashRef(stableStringify(sourceSnapshotBasis)),
    requirementCount: selectedRequirements.length,
    documentCount: filtered.selectedDocumentIds.length,
  };

  const stats = {
    verifiedClauseCount: behaviors.length,
    provisionalSourceCount: provisionalSources.length,
    excludedClauseCount: filtered.excludedClauses.length,
  };

  const identityBasis = {
    schemaVersion: SCHEMA_VERSION,
    projectId: text(projectId) || null,
    sprintId: text(sprintId) || null,
    sourceSnapshot,
    clauseIds: behaviors.map((behavior) => behavior.id),
    behaviors,
    understanding,
    provisionalSources,
    issues,
    stats,
    status,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    contractId: `${CONTRACT_ID_PREFIX}${sha256(stableStringify(identityBasis))}`,
    projectId: text(projectId) || null,
    sprintId: text(sprintId) || null,
    builtAt: builtAt == null ? null : new Date(builtAt).toISOString(),
    sourceSnapshot,
    clauseIds: behaviors.map((behavior) => behavior.id),
    behaviors,
    understanding,
    provisionalSources,
    issues,
    stats,
    status,
  };
}

function validationError(path, code, message) {
  return { path, code, message };
}

function hasUnredactedSensitiveAssignment(value) {
  const input = String(value == null ? '' : value);
  const assignment = new RegExp(SENSITIVE_ASSIGNMENT_RE.source, 'gi');
  let match;
  while ((match = assignment.exec(input))) {
    if (!String(match[2] || '').trim().startsWith('[REDACTED]')) return true;
  }
  const bearer = new RegExp(BEARER_TOKEN_RE.source, 'gi');
  while ((match = bearer.exec(input))) {
    if (String(match[2] || '').trim() !== '[REDACTED]') return true;
  }
  return false;
}

function validateRequirementUnderstandingV1(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      errors: [validationError('$', 'invalid_type', 'RequirementUnderstandingV1 must be an object.')],
    };
  }

  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push(validationError('schemaVersion', 'invalid_schema_version', `Expected ${SCHEMA_VERSION}.`));
  }
  if (!new RegExp(`^${CONTRACT_ID_PREFIX}[a-f0-9]{64}$`).test(text(value.contractId))) {
    errors.push(validationError('contractId', 'invalid_contract_id', 'contractId must be a deterministic ruv1 SHA-256 identifier.'));
  }
  if (!text(value.projectId)) {
    errors.push(validationError('projectId', 'required', 'projectId is required.'));
  }
  if (value.sprintId != null && typeof value.sprintId !== 'string') {
    errors.push(validationError('sprintId', 'invalid_type', 'sprintId must be a string or null.'));
  }
  if (value.builtAt != null && Number.isNaN(Date.parse(value.builtAt))) {
    errors.push(validationError('builtAt', 'invalid_timestamp', 'builtAt must be null or an ISO-compatible timestamp.'));
  }

  const snapshot = value.sourceSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    errors.push(validationError('sourceSnapshot', 'required', 'sourceSnapshot is required.'));
  } else {
    if (!Array.isArray(snapshot.requirementIds)) errors.push(validationError('sourceSnapshot.requirementIds', 'invalid_type', 'requirementIds must be an array.'));
    if (!Array.isArray(snapshot.documentIds)) errors.push(validationError('sourceSnapshot.documentIds', 'invalid_type', 'documentIds must be an array.'));
    if (!/^sha256:[a-f0-9]{64}$/.test(text(snapshot.sourceHash))) errors.push(validationError('sourceSnapshot.sourceHash', 'invalid_hash', 'sourceHash must be a SHA-256 reference.'));
    if (Array.isArray(snapshot.requirementIds) && snapshot.requirementCount !== snapshot.requirementIds.length) {
      errors.push(validationError('sourceSnapshot.requirementCount', 'count_mismatch', 'requirementCount must equal requirementIds.length.'));
    }
    if (Array.isArray(snapshot.documentIds) && snapshot.documentCount !== snapshot.documentIds.length) {
      errors.push(validationError('sourceSnapshot.documentCount', 'count_mismatch', 'documentCount must equal documentIds.length.'));
    }
  }

  for (const field of ['clauseIds', 'behaviors', 'provisionalSources', 'issues']) {
    if (!Array.isArray(value[field])) errors.push(validationError(field, 'invalid_type', `${field} must be an array.`));
  }
  if (!value.understanding || typeof value.understanding !== 'object' || Array.isArray(value.understanding)) {
    errors.push(validationError('understanding', 'required', 'understanding is required.'));
  }
  if (!value.stats || typeof value.stats !== 'object' || Array.isArray(value.stats)) {
    errors.push(validationError('stats', 'required', 'stats is required.'));
  }
  if (!CONTRACT_STATUSES.has(value.status)) {
    errors.push(validationError('status', 'invalid_status', 'status must be ready, needs_review, or degraded.'));
  }

  if (Array.isArray(value.behaviors)) {
    value.behaviors.forEach((behavior, index) => {
      if (!behavior || typeof behavior !== 'object') {
        errors.push(validationError(`behaviors[${index}]`, 'invalid_type', 'Behavior must be an object.'));
        return;
      }
      if (!text(behavior.id)) errors.push(validationError(`behaviors[${index}].id`, 'required', 'Behavior id is required.'));
      if (!/^sha256:[a-f0-9]{64}$/.test(text(behavior.behaviorHash))) {
        errors.push(validationError(`behaviors[${index}].behaviorHash`, 'invalid_hash', 'behaviorHash must be a SHA-256 reference.'));
      }
      if (typeof behavior.testable !== 'boolean') {
        errors.push(validationError(`behaviors[${index}].testable`, 'invalid_type', 'testable must be boolean.'));
      }
    });
  }

  if (Array.isArray(value.clauseIds) && Array.isArray(value.behaviors)) {
    const behaviorIds = value.behaviors.map((behavior) => text(behavior && behavior.id));
    if (stableStringify(value.clauseIds) !== stableStringify(behaviorIds)) {
      errors.push(validationError('clauseIds', 'identity_mismatch', 'clauseIds must match behavior ids in order.'));
    }
  }
  if (value.stats && typeof value.stats === 'object') {
    const countChecks = [
      ['verifiedClauseCount', Array.isArray(value.behaviors) ? value.behaviors.length : null],
      ['provisionalSourceCount', Array.isArray(value.provisionalSources) ? value.provisionalSources.length : null],
    ];
    for (const [field, expected] of countChecks) {
      if (expected != null && value.stats[field] !== expected) {
        errors.push(validationError(`stats.${field}`, 'count_mismatch', `${field} does not match the contract inventory.`));
      }
    }
    if (!Number.isInteger(value.stats.excludedClauseCount) || value.stats.excludedClauseCount < 0) {
      errors.push(validationError('stats.excludedClauseCount', 'invalid_count', 'excludedClauseCount must be a non-negative integer.'));
    }
  }

  if (hasUnredactedSensitiveAssignment(JSON.stringify(value))) {
    errors.push(validationError('$', 'unredacted_sensitive_value', 'The contract contains an unredacted sensitive assignment.'));
  }

  return { ok: errors.length === 0, errors };
}

function attachRequirementUnderstandingV1(manifest, contract) {
  return {
    ...(manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}),
    requirementUnderstandingV1: contract,
  };
}

module.exports = {
  SCHEMA_VERSION,
  buildRequirementUnderstandingV1,
  validateRequirementUnderstandingV1,
  filterClausesForSelectedRequirements,
  attachRequirementUnderstandingV1,
  redactSensitiveText,
};
