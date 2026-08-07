'use strict';

const { compileStoredCase } = require('./caseCompiler');
const { decodeJson, encodeJson } = require('./jsonField');
const dependencyGraph = require('./dependencyGraph');

const READINESS_CONTRACT_VERSION = 'readiness_contract_v1_20260707';

const READINESS_STATUS = Object.freeze({
  READY: 'ready',
  NEEDS_REVIEW: 'needs_review',
  BLOCKED: 'blocked',
  NEEDS_DATA_CHOICE: 'needs_data_choice',
  NEEDS_AUTH_SETUP: 'needs_auth_setup',
  NEEDS_SESSION_DEPENDENCY: 'needs_session_dependency',
  NEEDS_ORACLE: 'needs_oracle',
  NEEDS_APP_CLARIFICATION: 'needs_app_clarification',
  REPAIR_RETRY_NEEDED: 'repair_retry_needed',
  LEGACY_UNVERIFIED: 'legacy_unverified',
});

const RUN_ELIGIBILITY = Object.freeze({
  ALLOWED: 'allowed',
  BLOCKED: 'blocked',
});

const APPROVAL_ELIGIBILITY = Object.freeze({
  ELIGIBLE: 'eligible',
  NEEDS_REVIEW: 'needs_review',
  BLOCKED: 'blocked',
});

const SESSION_MODE = Object.freeze({
  FRESH: 'fresh',
  CONTINUE_FROM_DEPENDENCY: 'continue_from_dependency',
  SHARED_SCENARIO: 'shared_scenario',
  SETUP_ONLY: 'setup_only',
});

const FAILURE_POLICY = Object.freeze({
  BLOCK_DEPENDENTS: 'block_dependents',
  CONTINUE_INDEPENDENT: 'continue_independent',
});

const STATE_TYPES = Object.freeze({
  AUTH_SESSION: 'auth_session',
  CREATED_RECORD: 'created_record',
  SELECTED_RECORD: 'selected_record',
  MODULE_GATE: 'module_gate',
  UPLOADED_FILE: 'uploaded_file',
});

const SOURCE_AUTHORITY = Object.freeze([
  'uploaded_user_requirements',
  'approved_test_data_mapping',
  'playwright_verified_app_capability',
  'firecrawl_discovered_source',
  'ai_inference',
]);

const DATA_CODES = new Set([
  'unresolved_tokens_no_binding',
  'unmapped_tokens',
  'data_binding_incomplete',
  'data_placeholder_not_in_mapping',
  'data_token_without_approved_binding',
  'data_token_not_approved',
  'assertion_token_not_approved',
  'approved_data_literal',
  'approved_expected_literal',
  'bound_field_literal',
  'missing_approved_data',
  'data_binding_not_approved',
  'proposed_data_mapping',
  'unapproved_data_mapping',
]);

const ORACLE_CODES = new Set([
  'assertion_invalid',
  'no_assertions',
  'url_pattern_unresolved_token',
  'no_must_assertion',
  'data_oracle_missing',
  'expected_value_token_unsupplied',
  'generic_page_ready_oracle',
]);

const APP_CODES = new Set([
  'no_typed_operations',
  'crawl_coverage_gap',
  'missing_capability',
  'capability_unverified',
  'firecrawl_only_capability',
]);

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  const decoded = decodeJson(value, null);
  return Array.isArray(decoded) ? decoded.filter(Boolean) : [];
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  const decoded = decodeJson(value, null);
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : null;
}

function normalizeDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function reason({
  code,
  severity = 'warning',
  family = 'readiness',
  message,
  caseId = null,
  stepId = null,
  dataBindingId = null,
  sourceArtifactId = null,
  repairable = true,
  userActionRequired = false,
  detail = undefined,
}) {
  return {
    code: String(code || 'readiness_unknown'),
    severity,
    family,
    message: message || String(code || 'Readiness issue'),
    caseId: caseId || null,
    ...(stepId ? { stepId } : {}),
    ...(dataBindingId ? { dataBindingId } : {}),
    ...(sourceArtifactId ? { sourceArtifactId } : {}),
    repairable: !!repairable,
    userActionRequired: !!userActionRequired,
    ...(detail !== undefined ? { detail } : {}),
  };
}

function familyForCode(code) {
  if (DATA_CODES.has(code)) return 'data';
  if (ORACLE_CODES.has(code)) return 'oracle';
  if (APP_CODES.has(code)) return 'app';
  if (/auth|credential|login/i.test(code || '')) return 'auth';
  if (/depend|session|state/i.test(code || '')) return 'session';
  return 'readiness';
}

function statusForReasonCodes(codes) {
  const list = new Set(codes.filter(Boolean));
  if ([...list].some((c) => DATA_CODES.has(c))) return READINESS_STATUS.NEEDS_DATA_CHOICE;
  if ([...list].some((c) => /auth|credential|login/i.test(c))) return READINESS_STATUS.NEEDS_AUTH_SETUP;
  if ([...list].some((c) => /depend|session|state/i.test(c))) return READINESS_STATUS.NEEDS_SESSION_DEPENDENCY;
  if ([...list].some((c) => ORACLE_CODES.has(c))) return READINESS_STATUS.NEEDS_ORACLE;
  if ([...list].some((c) => APP_CODES.has(c))) return READINESS_STATUS.NEEDS_APP_CLARIFICATION;
  return READINESS_STATUS.NEEDS_REVIEW;
}

function bindingStatus(binding) {
  const source = String(binding && (binding.source || binding.mappingSource || binding.status || '')).toLowerCase();
  const mappingStatus = String(binding && (binding.mappingStatus || binding.status || '')).toLowerCase();
  if (!binding) return null;
  if (source.includes('draft') || source.includes('proposed')) return 'draft_or_proposed';
  if (mappingStatus && !['approved', 'complete_approved', 'complete'].includes(mappingStatus)) return mappingStatus;
  if (binding.mappingId && binding.mappingVersion) return 'approved';
  return mappingStatus || source || null;
}

function hasDraftOrProposedData(binding) {
  const status = bindingStatus(binding);
  if (binding && binding.sheet && !(binding.mappingId && binding.mappingVersion) && status !== 'approved') return true;
  if (!status) return false;
  return /draft|proposed|unapproved|none|needs_mapping/.test(status);
}

function looksGenericPageReady(tc) {
  const text = `${tc && tc.assertions || ''} ${tc && tc.steps || ''}`.toLowerCase();
  return /\bpage ready\b/.test(text);
}

function deriveStateContracts(keys, { type = STATE_TYPES.CREATED_RECORD, scope = 'case', sourceCaseId = null, required = true } = {}) {
  return asArray(keys).map((key) => ({
    key: String(key),
    type,
    scope,
    ...(sourceCaseId ? { sourceCaseId } : {}),
    required: !!required,
  }));
}

function normalizeStateContracts(raw, fallbackKeys, { type = STATE_TYPES.CREATED_RECORD, scope = 'case', required = true } = {}) {
  const allowedTypes = new Set(Object.values(STATE_TYPES));
  const allowedScopes = new Set(['case', 'scenario', 'generation']);
  const structured = asArray(raw)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const key = String(item.key || '').trim();
      if (!key) return null;
      const nextType = allowedTypes.has(item.type) ? item.type : type;
      const nextScope = allowedScopes.has(item.scope) ? item.scope : scope;
      return {
        key,
        type: nextType,
        scope: nextScope,
        ...(item.sourceCaseId ? { sourceCaseId: String(item.sourceCaseId) } : {}),
        required: item.required == null ? !!required : !!item.required,
      };
    })
    .filter(Boolean);
  return structured.length ? structured : deriveStateContracts(fallbackKeys, { type, scope, required });
}

function deriveSessionMode(tc, deps, producedState, requiredState) {
  const explicit = String(tc && tc.sessionMode || '').trim();
  if (Object.values(SESSION_MODE).includes(explicit)) return explicit;
  if (deps.length) return SESSION_MODE.CONTINUE_FROM_DEPENDENCY;
  if (requiredState.length) return SESSION_MODE.CONTINUE_FROM_DEPENDENCY;
  if (producedState.length && /setup|login|fixture|seed/i.test(String(tc && tc.name || ''))) return SESSION_MODE.SETUP_ONLY;
  return SESSION_MODE.FRESH;
}

function deriveFailurePolicy(deps, producedState, requiredState) {
  return (deps.length || producedState.length || requiredState.length)
    ? FAILURE_POLICY.BLOCK_DEPENDENTS
    : FAILURE_POLICY.CONTINUE_INDEPENDENT;
}

function rowPlanFromContracts(tc, binding, quality) {
  const phase45 = quality && quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : {};
  const rowExecutionPlan = phase45.rowExecutionPlan || (binding && binding.rowExecutionPlan) || null;
  const skippedRows = [];
  if (rowExecutionPlan && Array.isArray(rowExecutionPlan.skippedRows)) skippedRows.push(...rowExecutionPlan.skippedRows);
  if (binding && Array.isArray(binding.skippedRows)) skippedRows.push(...binding.skippedRows);
  const rows = Array.isArray(rowExecutionPlan && rowExecutionPlan.rows) ? rowExecutionPlan.rows
    : Array.isArray(rowExecutionPlan && rowExecutionPlan.rowIds) ? rowExecutionPlan.rowIds
      : [];
  let rowCoverageStatus = null;
  if (rowExecutionPlan) {
    if (skippedRows.length) rowCoverageStatus = rows.length ? 'partial' : 'blocked';
    else rowCoverageStatus = rows.length || rowExecutionPlan.rowSelector ? 'covered' : 'unknown';
  } else if (binding && binding.sheet) {
    rowCoverageStatus = 'unknown';
  }
  return { rowExecutionPlan, rowCoverageStatus, skippedRows };
}

function firecrawlOnlyReasons(tc, sourceArtifacts = []) {
  const reasons = [];
  const quality = asObject(tc && tc.qualityContractJson) || {};
  const phase45 = quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : {};
  const evidence = [
    ...(Array.isArray(phase45.capabilityEvidence) ? phase45.capabilityEvidence : []),
    ...(Array.isArray(phase45.sourceArtifacts) ? phase45.sourceArtifacts : []),
    ...(Array.isArray(sourceArtifacts) ? sourceArtifacts : []),
  ];
  for (const artifact of evidence) {
    const source = String(artifact && artifact.source || '').toLowerCase();
    const confidence = String(artifact && artifact.confidence || '').toLowerCase();
    const verified = artifact && artifact.verifiedByPlaywright === true;
    const freshness = String(artifact && artifact.freshness || '').toLowerCase();
    const expiry = normalizeDate(artifact && (artifact.expiresAt || artifact.staleAt));
    const stale = freshness === 'stale' || (!!expiry && expiry < new Date());
    const blockedByPolicy = artifact && (artifact.tenantAllowed === false || /disallow|blocked|deny/i.test(String(artifact.robotsPolicy || '')));
    if (source === 'firecrawl' && (!verified || confidence === 'discovered' || stale || blockedByPolicy)) {
      reasons.push(reason({
        code: stale ? 'firecrawl_source_stale' : blockedByPolicy ? 'firecrawl_source_policy_blocked' : 'firecrawl_only_capability',
        severity: 'warning',
        family: 'app',
        message: 'Firecrawl-discovered source is context only until Playwright verifies the app capability.',
        caseId: tc && tc.id,
        sourceArtifactId: artifact.id || artifact.sourceArtifactId || null,
        repairable: true,
        userActionRequired: true,
      }));
    }
  }
  return reasons;
}

function sourceArtifactIsUsableForReadiness(artifact, now = new Date()) {
  if (!artifact) return false;
  if (artifact.source === 'firecrawl' && artifact.verifiedByPlaywright !== true) return false;
  if (artifact.tenantAllowed === false) return false;
  if (/disallow|blocked|deny/i.test(String(artifact.robotsPolicy || ''))) return false;
  const expiresAt = normalizeDate(artifact.expiresAt || artifact.staleAt);
  if (expiresAt && expiresAt <= now) return false;
  if (String(artifact.freshness || '').toLowerCase() === 'stale') return false;
  return true;
}

function compileCaseReadiness(tc, contracts = {}, data = null, dependencies = {}) {
  const now = contracts.now instanceof Date ? contracts.now : new Date();
  const reasons = [];
  const deps = dependencyGraph.decodeDeps(tc && tc.dependsOnIds);
  const dependsOnNames = asArray(tc && tc.dependsOnNames);
  const producedState = normalizeStateContracts(tc && tc.producesStateJson, tc && tc.producesData, { type: STATE_TYPES.CREATED_RECORD, scope: 'case', required: false });
  const requiredState = normalizeStateContracts(tc && tc.requiresStateJson, tc && tc.requiresData, { type: STATE_TYPES.CREATED_RECORD, scope: 'case', required: true });
  const sessionMode = deriveSessionMode(tc, deps, producedState, requiredState);
  const failurePolicy = deriveFailurePolicy(deps, producedState, requiredState);
  const quality = asObject(tc && tc.qualityContractJson) || {};
  const binding = asObject(tc && tc.dataBindingJson);
  const { rowExecutionPlan, rowCoverageStatus, skippedRows } = rowPlanFromContracts(tc, binding, quality);

  let storedVerdict = null;
  try { storedVerdict = compileStoredCase(tc, contracts); } catch (err) {
    storedVerdict = { state: 'blocked', blockers: [{ code: 'compiler_error', detail: err.message }], warnings: [] };
  }

  for (const blocker of (storedVerdict.blockers || [])) {
    const code = blocker && blocker.code || 'compiler_blocker';
    reasons.push(reason({
      code,
      severity: 'error',
      family: familyForCode(code),
      message: blocker.detail || `Compiler blocker: ${code}`,
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: true,
      detail: blocker,
    }));
  }
  for (const warning of (storedVerdict.warnings || [])) {
    const code = warning && warning.code || 'compiler_warning';
    reasons.push(reason({
      code,
      severity: 'warning',
      family: familyForCode(code),
      message: warning.detail || `Compiler warning: ${code}`,
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: familyForCode(code) !== 'readiness',
      detail: warning,
    }));
  }

  if (hasDraftOrProposedData(binding)) {
    reasons.push(reason({
      code: 'data_binding_not_approved',
      severity: 'error',
      family: 'data',
      message: 'Case uses draft/proposed/unapproved data binding and cannot run until an approved mapping is selected.',
      caseId: tc && tc.id,
      dataBindingId: binding && binding.mappingId,
      repairable: true,
      userActionRequired: true,
    }));
  }

  const authSetup = quality && quality.phase45 && quality.phase45.authSetupPlan ? quality.phase45.authSetupPlan
    : asObject(tc && tc.authSetupPlan) || null;
  if (authSetup && ['needs_app_clarification', 'needs_auth_setup', 'needs_data_choice'].includes(String(authSetup.status || authSetup.reason || ''))) {
    const authCode = String(authSetup.status || authSetup.reason) === 'needs_data_choice' ? 'auth_credentials_missing' : 'auth_setup_missing';
    reasons.push(reason({
      code: authCode,
      severity: 'error',
      family: 'auth',
      message: authCode === 'auth_credentials_missing'
        ? 'Authentication setup exists but credentials/data choice is missing.'
        : 'Case requires an authenticated start state but no verified setup is available.',
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: true,
      detail: authSetup,
    }));
  }

  if (requiredState.length && !deps.length) {
    reasons.push(reason({
      code: 'requires_state_without_dependency',
      severity: 'error',
      family: 'session',
      message: 'Case requires state from another case but has no durable dependsOnIds chain.',
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: true,
    }));
  }
  if (dependsOnNames.length && !deps.length) {
    reasons.push(reason({
      code: 'depends_on_names_unresolved',
      severity: 'error',
      family: 'session',
      message: 'Case declares named dependencies that have not been resolved into durable dependsOnIds.',
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: true,
      detail: { dependsOnNames },
    }));
  }
  if (sessionMode !== SESSION_MODE.FRESH && !deps.length && requiredState.length) {
    reasons.push(reason({
      code: 'continuation_without_dependency',
      severity: 'error',
      family: 'session',
      message: 'Continuation/session-sharing case must declare dependsOnIds.',
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: true,
    }));
  }

  if (looksGenericPageReady(tc)) {
    reasons.push(reason({
      code: 'generic_page_ready_oracle',
      severity: 'warning',
      family: 'oracle',
      message: 'Generic "page ready" oracle is not enough as a final runnable oracle.',
      caseId: tc && tc.id,
      repairable: true,
      userActionRequired: true,
    }));
  }

  reasons.push(...firecrawlOnlyReasons(tc, contracts.sourceArtifacts || []));

  if (dependencies && Array.isArray(dependencies.findings)) {
    for (const finding of dependencies.findings) {
      reasons.push(reason({
        code: finding.code || 'dependency_finding',
        severity: finding.severity || 'warning',
        family: 'session',
        message: finding.message || `Dependency finding: ${finding.code || 'dependency_finding'}`,
        caseId: tc && tc.id,
        repairable: true,
        userActionRequired: finding.severity === 'error',
        detail: finding,
      }));
    }
  }

  const errorReasons = reasons.filter((r) => r.severity === 'error');
  const reasonCodes = reasons.map((r) => r.code);
  let readinessStatus = READINESS_STATUS.READY;
  if (!tc || !tc.id) readinessStatus = READINESS_STATUS.BLOCKED;
  else if (tc.readinessStatus === READINESS_STATUS.LEGACY_UNVERIFIED && !tc.qualityContractJson) readinessStatus = READINESS_STATUS.LEGACY_UNVERIFIED;
  else if (errorReasons.length) readinessStatus = statusForReasonCodes(errorReasons.map((r) => r.code));
  else if (reasonCodes.length) readinessStatus = statusForReasonCodes(reasonCodes);

  if (readinessStatus === READINESS_STATUS.NEEDS_REVIEW && !tc.qualityContractJson && !tc.operationsJson && !tc.declaredAssertions) {
    readinessStatus = READINESS_STATUS.LEGACY_UNVERIFIED;
  }

  const runEligibility = readinessStatus === READINESS_STATUS.READY
    ? RUN_ELIGIBILITY.ALLOWED
    : RUN_ELIGIBILITY.BLOCKED;
  const approvalEligibility = (!tc || !tc.id)
    ? APPROVAL_ELIGIBILITY.BLOCKED
    : (reasons.some((r) => r.severity === 'error' && !['data', 'auth', 'session', 'app', 'oracle'].includes(r.family))
      ? APPROVAL_ELIGIBILITY.NEEDS_REVIEW
      : APPROVAL_ELIGIBILITY.ELIGIBLE);

  return {
    readinessStatus,
    readinessReasons: reasons,
    readinessContractVersion: READINESS_CONTRACT_VERSION,
    readinessComputedAt: now.toISOString(),
    approvalEligibility,
    runEligibility,
    sessionMode,
    dependsOnIds: deps,
    producesState: producedState,
    requiresState: requiredState,
    failurePolicy,
    rowExecutionPlan,
    rowCoverageStatus,
    skippedRows,
    sourceAuthority: SOURCE_AUTHORITY,
    cached: false,
  };
}

function readinessUpdateData(compiled) {
  return {
    readinessStatus: compiled.readinessStatus,
    readinessReasonsJson: encodeJson(compiled.readinessReasons || []),
    readinessContractVersion: compiled.readinessContractVersion || READINESS_CONTRACT_VERSION,
    readinessComputedAt: new Date(compiled.readinessComputedAt || Date.now()),
    approvalEligibility: compiled.approvalEligibility || APPROVAL_ELIGIBILITY.ELIGIBLE,
    runEligibility: compiled.runEligibility || RUN_ELIGIBILITY.BLOCKED,
    sessionMode: compiled.sessionMode || SESSION_MODE.FRESH,
    producesStateJson: encodeJson(compiled.producesState || []),
    requiresStateJson: encodeJson(compiled.requiresState || []),
    failurePolicy: compiled.failurePolicy || FAILURE_POLICY.CONTINUE_INDEPENDENT,
    rowExecutionPlanJson: compiled.rowExecutionPlan ? encodeJson(compiled.rowExecutionPlan) : null,
    rowCoverageStatus: compiled.rowCoverageStatus || null,
    skippedRowsJson: compiled.skippedRows && compiled.skippedRows.length ? encodeJson(compiled.skippedRows) : null,
  };
}

function isCachedReadinessCurrent(tc) {
  return !!(tc && tc.readinessContractVersion === READINESS_CONTRACT_VERSION && tc.readinessComputedAt);
}

async function persistCaseReadiness(prisma, tc, opts = {}) {
  const compiled = compileCaseReadiness(tc, opts.contracts || opts, opts.data || null, opts.dependencies || {});
  if (!prisma || !tc || !tc.id) return compiled;
  try {
    await prisma.testCase.update({
      where: { id: tc.id },
      data: readinessUpdateData(compiled),
    });
  } catch (err) {
    if (opts.strict) throw err;
  }
  return compiled;
}

async function compileAndPersistCaseReadiness(prisma, tc, opts = {}) {
  return persistCaseReadiness(prisma, tc, opts);
}

module.exports = {
  READINESS_CONTRACT_VERSION,
  READINESS_STATUS,
  RUN_ELIGIBILITY,
  APPROVAL_ELIGIBILITY,
  SESSION_MODE,
  FAILURE_POLICY,
  STATE_TYPES,
  SOURCE_AUTHORITY,
  compileCaseReadiness,
  readinessUpdateData,
  isCachedReadinessCurrent,
  persistCaseReadiness,
  compileAndPersistCaseReadiness,
  sourceArtifactIsUsableForReadiness,
};
