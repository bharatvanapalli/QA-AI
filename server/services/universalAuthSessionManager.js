'use strict';

const AUTH_SCHEMA_VERSION = 'qaai-universal-auth-session-v1';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function parseMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function safeJson(value) {
  try { return JSON.stringify(value == null ? '' : value); } catch (_) { return ''; }
}

function textFromTrailEntry(entry = {}) {
  return [
    entry.tool,
    entry.args && entry.args.element,
    entry.args && entry.args.label,
    entry.args && entry.args.name,
    entry.args && entry.args.placeholder,
    entry.args && entry.args.role,
    entry.args && entry.args.target,
    entry.pageUrl,
    entry.pageUrlAfter,
    entry.observation,
    entry.resultText,
    entry.stepOperationCheck,
  ].filter(Boolean).map(clean).join(' ');
}

function textFromActionEvidence(item = {}) {
  const evidence = parseMaybeJson(item.evidenceJson) || {};
  return [
    item.toolName,
    item.actionKind,
    item.pageUrl,
    item.pageUrlAfter,
    item.targetText,
    evidence.targetText,
    evidence.element,
    evidence.label,
    evidence.name,
    evidence.role,
    evidence.fieldLabel,
    evidence.args && evidence.args.element,
    evidence.args && evidence.args.label,
    evidence.args && evidence.args.name,
    evidence.args && evidence.args.placeholder,
    evidence.args && evidence.args.role,
    evidence.args && evidence.args.target,
    evidence.pageUrl,
    evidence.pageUrlAfter,
    safeJson(evidence.targetFacts || ''),
  ].filter(Boolean).map(clean).join(' ');
}

function allAuthText({ testCase = null, trail = [], actionEvidences = [] } = {}) {
  return [
    testCase && testCase.name,
    testCase && testCase.title,
    testCase && testCase.description,
    safeJson(testCase && (testCase.requiresStateJson || testCase.requiresState || testCase.qualityContractJson || '')),
    ...(Array.isArray(trail) ? trail.map(textFromTrailEntry) : []),
    ...(Array.isArray(actionEvidences) ? actionEvidences.map(textFromActionEvidence) : []),
  ].filter(Boolean).join(' ');
}

function providerLabelFromText(text) {
  const raw = clean(text).replace(/https?:\/\/\S+/gi, ' ');
  const patterns = [
    /\b(?:sign|log)\s*in\s+with\s+([A-Za-z0-9 ._-]{2,80}?)(?=\s+(?:browser_[a-z_]+|identifier|username|email|password|next|continue|submit|sign|log|auth|session|sso)\b|$|[.,;|()[\]{}])/i,
    /\bcontinue\s+with\s+([A-Za-z0-9 ._-]{2,80}?)(?=\s+(?:browser_[a-z_]+|identifier|username|email|password|next|continue|submit|sign|log|auth|session|sso)\b|$|[.,;|()[\]{}])/i,
    /\buse\s+([A-Za-z0-9 ._-]{2,80}?)\s+(?:sso|single\s+sign[-\s]?on|identity\s+provider)\b/i,
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (m && clean(m[1])) return clean(m[1]).replace(/[.。,:;|()[\]{}]+$/g, '').slice(0, 80);
  }
  return null;
}

function authFlowSignals({ testCase = null, trail = [], actionEvidences = [], assertionOutcomes = [] } = {}) {
  const text = allAuthText({ testCase, trail, actionEvidences });
  const textLc = lower(text);
  const providerLabel = providerLabelFromText(text);
  const loginActionIds = (Array.isArray(actionEvidences) ? actionEvidences : [])
    .filter((item) => {
      const actionText = lower(textFromActionEvidence(item));
      return /\b(?:login|log\s*in|sign\s*in|signin|auth|authenticate|session|credential|password|passcode|username|email|identifier|provider|sso|single\s+sign|next|continue|submit)\b/.test(actionText);
    })
    .map((item) => item.id)
    .filter(Boolean);

  const manualGateCount = [
    ...(Array.isArray(trail) ? trail.map(textFromTrailEntry) : []),
    ...(Array.isArray(actionEvidences) ? actionEvidences.map(textFromActionEvidence) : []),
  ].filter((item) => /\b(?:captcha|mfa|multi[-_\s]?factor|one[-_\s]?time|otp|verification\s+code|manual\s+approval|human\s+approval)\b/i.test(item)).length;

  const pageUrls = (Array.isArray(trail) ? trail : [])
    .flatMap((entry) => [entry && entry.pageUrl, entry && entry.pageUrlAfter])
    .filter(Boolean)
    .map(clean);
  const origins = [...new Set(pageUrls.map((url) => {
    try { return new URL(url).origin; } catch (_) { return null; }
  }).filter(Boolean))];

  const hasPassword = /\b(?:password|passcode|pwd|secret)\b/i.test(text);
  const hasIdentifier = /\b(?:email|username|user\s*name|login\s*id|identifier|phone)\b/i.test(text);
  const hasProviderChoice = /\b(?:sign|log)\s*in\s+with\b/i.test(text) || /\bcontinue\s+with\b/i.test(text) || /\b(?:sso|single\s+sign[-\s]?on|identity\s+provider|federated\s+login|provider)\b/i.test(text);
  const hasSubmit = /\b(?:sign\s*in|log\s*in|signin|login|submit|continue|next)\b/i.test(text);
  const hasSessionLanguage = /\b(?:authenticated|auth\s*session|logged\s*in|signed\s*in|session)\b/i.test(text);
  const hasMagicLink = /\b(?:magic\s+link|email\s+link|one[-\s]?time\s+link)\b/i.test(text);
  const hasSaml = /\bsaml\b/i.test(text);
  const hasOidcOauth = /\b(?:oidc|openid|oauth|authorize)\b/i.test(text);
  const hasRedirectedAuth = origins.length > 1 && /\b(?:login|auth|authorize|idp|identity|provider|sso)\b/i.test(text);

  let providerType = 'unknown';
  if (hasMagicLink) providerType = 'magic_link';
  else if (hasSaml) providerType = 'saml';
  else if (hasOidcOauth) providerType = 'oidc_oauth';
  else if (hasProviderChoice || hasRedirectedAuth) providerType = 'sso';
  else if (hasPassword || hasIdentifier) providerType = 'password';
  else if (hasSessionLanguage) providerType = 'session';

  return {
    schemaVersion: AUTH_SCHEMA_VERSION,
    providerType,
    providerLabel,
    loginActionEvidenceIds: loginActionIds,
    manualGateCount,
    originCount: origins.length,
    flow: {
      identifierField: hasIdentifier,
      providerChoice: hasProviderChoice,
      credentialSecret: hasPassword,
      credentialSubmit: hasSubmit,
      redirectedAuth: hasRedirectedAuth,
      sessionLanguage: hasSessionLanguage,
      magicLink: hasMagicLink,
      manualGate: manualGateCount > 0,
    },
    assertionSignalCount: Array.isArray(assertionOutcomes) ? assertionOutcomes.length : 0,
  };
}

function findPostLoginOracle({ trail = [], assertionOutcomes = [], testCase = null } = {}) {
  const assertion = (Array.isArray(assertionOutcomes) ? assertionOutcomes : []).find((item) => {
    const matched = item && (item.matched === true || item.outcome === 'matched' || item.effective === 'matched');
    const expected = clean(item && (item.expected ?? item.text ?? item.reason ?? ''));
    const actual = clean(item && (item.actual ?? ''));
    if (!matched || (!expected && !actual)) return false;
    const text = lower(`${item.kind || ''} ${expected} ${actual}`);
    return /\b(?:dashboard|home|welcome|signed\s*in|logged\s*in|landing|portal|account|profile|workspace|post[-_\s]?login|authenticated)\b/.test(text);
  });
  if (assertion) {
    return {
      source: 'assertion_evidence',
      assertionId: assertion.assertionId || assertion.id || null,
      expected: assertion.expected ?? assertion.text ?? null,
      actual: assertion.actual ?? null,
      matched: true,
    };
  }

  const trailEntry = (Array.isArray(trail) ? trail : []).find((entry) => {
    const text = lower(`${entry?.pageUrlAfter || entry?.pageUrl || ''} ${entry?.stepOperationCheck || ''} ${entry?.observation || ''} ${entry?.resultText || ''}`);
    return /\b(?:dashboard|home|welcome|portal|landing|account|profile|workspace|post[-_\s]?login|authenticated)\b/.test(text);
  });
  if (trailEntry) {
    return {
      source: 'trail',
      pageUrl: trailEntry.pageUrlAfter || trailEntry.pageUrl || null,
      observation: trailEntry.observation || trailEntry.resultText || trailEntry.stepOperationCheck || null,
    };
  }

  const declared = Array.isArray(testCase?.declaredAssertions) ? testCase.declaredAssertions : [];
  const declaredOracle = declared.find((item) => /\b(?:dashboard|home|welcome|portal|landing|account|profile|workspace|post[-_\s]?login|authenticated)\b/i.test(`${item?.kind || ''} ${item?.expected || ''} ${item?.text || ''}`));
  if (declaredOracle) {
    return {
      source: 'declared_assertion',
      assertionId: declaredOracle.id || declaredOracle.assertionId || null,
      expected: declaredOracle.expected || declaredOracle.text || null,
    };
  }
  return null;
}

function authRequiredForRun({ testCase = null, trail = [], actionEvidences = [] } = {}) {
  if (testCase?.requiresAuth || testCase?.authRequired || testCase?.authProfile || testCase?.authProfileId) return true;
  const text = allAuthText({ testCase, trail, actionEvidences });
  return /\b(?:auth_session|authenticated|login|log\s*in|sign\s*in|signin|password|credential|sso|single\s+sign|session|identity\s+provider)\b/i.test(text);
}

function storageStateRefForTestCase(testCase = null) {
  return clean(testCase?.authProfileStorageStateRef
    || testCase?.storageStateRef
    || testCase?.authStateRef
    || testCase?.authProfile?.storageStateRef
    || '') || null;
}

function roleProfileForTestCase(testCase = null) {
  return clean(testCase?.authRole
    || testCase?.role
    || testCase?.authProfileName
    || testCase?.authProfile
    || testCase?.authProfileId
    || '') || null;
}

function dependencyIdsForTestCase(testCase = null) {
  const raw = testCase?.dependsOnIds ?? testCase?.dependsOn ?? testCase?.dependencyIds ?? [];
  if (Array.isArray(raw)) return [...new Set(raw.filter(Boolean).map(String))];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? [...new Set(parsed.filter(Boolean).map(String))] : [raw.trim()];
  } catch (_) {
    return [raw.trim()];
  }
}

function sessionModeForTestCase(testCase = null) {
  return clean(testCase?.sessionMode || testCase?.session?.mode || testCase?.dependencySessionMode).toLowerCase() || 'independent';
}

function buildDependencySessionPlan({
  testCase = null,
  projectId = null,
  runId = null,
  caseId = null,
  continuityGroupId = null,
} = {}) {
  const mode = sessionModeForTestCase(testCase);
  const dependencyIds = dependencyIdsForTestCase(testCase);
  const continuation = mode === 'continue_from_dependency';
  return {
    schemaVersion: `${AUTH_SCHEMA_VERSION}:dependency-continuity`,
    mode,
    continuation,
    projectId: projectId || testCase?.projectId || null,
    runId: runId || null,
    caseId: caseId || testCase?.id || null,
    continuityGroupId: clean(continuityGroupId || testCase?.continuityGroupId) || null,
    dependencyCaseId: continuation ? dependencyIds[0] || null : null,
    dependencyIds,
    failurePolicy: clean(testCase?.failurePolicy || testCase?.dependencyFailurePolicy || testCase?.dependencyPolicy?.failurePolicy).toLowerCase() || null,
    requiresExistingSession: continuation,
    createNewSession: !continuation,
    replayAuthentication: false,
    revisitLogin: false,
    repeatAuthActions: false,
  };
}

async function acquireSessionForCase({
  registry,
  userId,
  projectId,
  runId,
  testCase,
  createSession = null,
  continuityGroupId = null,
} = {}) {
  const plan = buildDependencySessionPlan({
    testCase,
    projectId,
    runId,
    caseId: testCase?.id,
    continuityGroupId,
  });
  if (plan.continuation) {
    if (!registry || typeof registry.leaseContinuation !== 'function') {
      return { session: null, reused: false, plan, reason: 'session_registry_unavailable' };
    }
    if (!plan.dependencyCaseId) {
      return { session: null, reused: false, plan, reason: 'dependency_case_missing' };
    }
    const lease = registry.leaseContinuation({
      userId,
      projectId: plan.projectId,
      runId,
      caseId: plan.caseId,
      dependsOnCaseId: plan.dependencyCaseId,
      dependsOnCaseIds: plan.dependencyIds,
      continuityGroupId: plan.continuityGroupId,
    });
    return { ...lease, plan };
  }
  if (typeof createSession !== 'function') {
    return { session: null, reused: false, plan, reason: 'session_factory_unavailable' };
  }
  const session = await createSession({ userId, projectId: plan.projectId, runId, caseId: plan.caseId, plan });
  if (session && registry?.setScoped && userId && plan.projectId && runId && plan.caseId) {
    registry.setScoped({
      userId,
      projectId: plan.projectId,
      runId,
      caseId: plan.caseId,
      continuityGroupId: plan.continuityGroupId,
    }, session);
  }
  return { session: session || null, reused: false, created: !!session, plan };
}

function buildAuthSetupEvidenceRow({ id, runResultId, testCase, actionEvidences = [], trail = [], assertionOutcomes = [], encodeJson = JSON.stringify, schemaVersion = AUTH_SCHEMA_VERSION } = {}) {
  const signals = authFlowSignals({ testCase, trail, actionEvidences, assertionOutcomes });
  const authRequired = authRequiredForRun({ testCase, trail, actionEvidences });
  if (!authRequired && !signals.loginActionEvidenceIds.length) return null;

  const postLoginOracle = findPostLoginOracle({ trail, assertionOutcomes, testCase });
  const storageStateRef = storageStateRefForTestCase(testCase);
  const missing = [];
  if (!signals.loginActionEvidenceIds.length && !storageStateRef) missing.push('login_action_evidence_or_storage_state');
  if (!postLoginOracle) missing.push('post_login_oracle');
  if (signals.manualGateCount > 0) missing.push('manual_gate');
  if (signals.providerType === 'password' && signals.flow.credentialSecret && !signals.flow.credentialSubmit && !storageStateRef) {
    missing.push('credential_submit');
  }

  const complete = missing.length === 0 && (signals.loginActionEvidenceIds.length > 0 || !!storageStateRef);
  return {
    id,
    runResultId,
    testCaseId: testCase?.id || null,
    authProfileId: testCase?.authProfile || testCase?.authProfileId || null,
    mode: storageStateRef ? 'storage_state' : signals.providerType === 'sso' ? 'interactive_provider_login' : signals.providerType === 'password' ? 'interactive_login' : 'session_establishment',
    loginActionEvidenceIds: encodeJson(signals.loginActionEvidenceIds),
    storageStateRef,
    postLoginOracleJson: postLoginOracle ? encodeJson(postLoginOracle) : null,
    sessionVerifiedAt: complete && postLoginOracle ? new Date() : null,
    expiresAt: testCase?.authProfileExpiresAt || null,
    evidenceJson: encodeJson({
      schemaVersion,
      providerType: signals.providerType,
      providerLabel: signals.providerLabel,
      roleProfile: roleProfileForTestCase(testCase),
      flow: signals.flow,
      manualGateCount: signals.manualGateCount,
      originCount: signals.originCount,
      complete,
      missing,
      inferred: !(testCase?.authProfile || testCase?.authProfileId),
      actionCount: signals.loginActionEvidenceIds.length,
      storageStateRefPresent: !!storageStateRef,
    }),
  };
}

function authSetupEvidenceIsComplete(row) {
  if (!row) return false;
  const loginIds = parseMaybeJson(row.loginActionEvidenceIds, []);
  const evidence = parseMaybeJson(row.evidenceJson, {}) || {};
  const missing = Array.isArray(evidence.missing) ? evidence.missing : [];
  return !!(
    Array.isArray(loginIds)
    && (loginIds.length > 0 || row.storageStateRef)
    && (row.storageStateRef || row.sessionVerifiedAt)
    && row.postLoginOracleJson
    && evidence.manualGateCount !== undefined
    && Number(evidence.manualGateCount || 0) === 0
    && missing.length === 0
  );
}

function sanitizeFileStem(value, fallback = 'auth-profile') {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function authEvidenceFromResult(result = {}) {
  const rows = Array.isArray(result.authSetupEvidences) ? result.authSetupEvidences : [];
  return rows.map((row) => ({
    ...row,
    parsedEvidence: parseMaybeJson(row.evidenceJson, {}) || {},
    postLoginOracle: parseMaybeJson(row.postLoginOracleJson, null),
    loginActionEvidenceIds: parseMaybeJson(row.loginActionEvidenceIds, []),
  }));
}

function authProfileFileStem(row, index = 0) {
  return sanitizeFileStem(
    row?.authProfileId
      || row?.parsedEvidence?.roleProfile
      || row?.parsedEvidence?.providerLabel
      || (index ? `auth-profile-${index + 1}` : 'default'),
  );
}

function storageStateReferenceFile(row, index = 0) {
  return {
    schemaVersion: `${AUTH_SCHEMA_VERSION}:storage-state-reference`,
    authProfileId: row.authProfileId || null,
    providerType: row.parsedEvidence?.providerType || 'unknown',
    providerLabel: row.parsedEvidence?.providerLabel || null,
    roleProfile: row.parsedEvidence?.roleProfile || null,
    storageStateRef: row.storageStateRef || null,
    materializedStorageStatePath: row.storageStateRef ? '.auth/state.json' : null,
    envOverride: 'QAAI_AUTH_STORAGE_STATE',
    valuePolicy: 'reference_only_no_secrets',
    note: 'This file is a QAAI auth/session reference contract. Real Playwright storageState is materialized only from an approved AuthFixture or supplied by QAAI_AUTH_STORAGE_STATE.',
    index,
  };
}

function buildAuthFixtureScaffold({ results = [], adapterId = null } = {}) {
  const isPlaywright = /playwright/i.test(String(adapterId || ''));
  if (!isPlaywright) return { files: {}, summary: { authCaseCount: 0, storageStateRefCount: 0 } };
  const evidences = (Array.isArray(results) ? results : []).flatMap(authEvidenceFromResult);
  const authCases = evidences.filter((row) => row && (row.loginActionEvidenceIds.length || row.storageStateRef || row.authProfileId));
  const storageRefs = [...new Set(authCases.map((row) => clean(row.storageStateRef)).filter(Boolean))].sort();
  const profiles = [...new Set(authCases.map((row) => clean(row.authProfileId || row.parsedEvidence?.roleProfile || 'default')).filter(Boolean))].sort();
  const files = {};

  files['fixtures/auth/README.md'] = [
    '# Auth fixtures',
    '',
    'QAAI writes universal auth/session setup information here.',
    'Use approved storage-state refs, environment variables, or valueRefs. Never hardcode passwords, tokens, cookies, or one-time codes in generated specs.',
    'When an approved AuthFixture is available, QAAI materializes real Playwright storage state at .auth/state.json and wires it through playwright.config.ts.',
    'Per-profile fixtures here are reference contracts unless they are backed by an approved storage-state ref.',
    '',
    `Detected auth setup rows: ${authCases.length}`,
    `Storage-state refs: ${storageRefs.length ? storageRefs.join(', ') : 'none'}`,
    '',
  ].join('\n');

  files['fixtures/auth/auth.setup.ts'] = [
    "import { test as setup, expect } from '@playwright/test';",
    '',
    'const authFile = process.env.QAAI_AUTH_STORAGE_STATE || undefined;',
    '',
    "setup('QAAI auth/session setup', async ({ page }) => {",
    '  // Universal scaffold: QAAI uses captured AuthSetupEvidence to decide whether a saved',
    '  // storage-state fixture can be reused or whether the recorded login flow should replay.',
    '  if (authFile) {',
    '    // Playwright loads this file from playwright.config.ts/use.storageState or project config.',
    '    // This setup file intentionally does not save or mutate storage state.',
    '    return;',
    '  }',
    '  const targetUrl = process.env.QAAI_TARGET_URL;',
    '  if (targetUrl) {',
    '    await page.goto(targetUrl);',
    '    await expect(page).not.toHaveURL(/about:blank/);',
    '  }',
    '});',
    '',
  ].join('\n');

  authCases.forEach((row, index) => {
    const stem = authProfileFileStem(row, index);
    files[`fixtures/auth/${stem}.storageState.json`] = JSON.stringify(storageStateReferenceFile(row, index), null, 2) + '\n';
  });

  files['fixtures/auth/session-contract.json'] = JSON.stringify({
    schemaVersion: AUTH_SCHEMA_VERSION,
    authCaseCount: authCases.length,
    storageStateRefs: storageRefs,
    profiles,
    storageStateReferenceFiles: authCases.map((row, index) => `fixtures/auth/${authProfileFileStem(row, index)}.storageState.json`),
    providerTypes: [...new Set(authCases.map((row) => row.parsedEvidence?.providerType).filter(Boolean))].sort(),
    manualGateCount: authCases.reduce((sum, row) => sum + Number(row.parsedEvidence?.manualGateCount || 0), 0),
    rows: authCases.map((row) => ({
      authProfileId: row.authProfileId || null,
      mode: row.mode || null,
      providerType: row.parsedEvidence?.providerType || 'unknown',
      providerLabel: row.parsedEvidence?.providerLabel || null,
      roleProfile: row.parsedEvidence?.roleProfile || null,
      storageStateRef: row.storageStateRef || null,
      loginActionEvidenceCount: row.loginActionEvidenceIds.length,
      postLoginOracleSource: row.postLoginOracle?.source || null,
      complete: row.parsedEvidence?.complete === true,
      missing: Array.isArray(row.parsedEvidence?.missing) ? row.parsedEvidence.missing : [],
    })),
  }, null, 2) + '\n';

  return {
    files,
    summary: {
      authCaseCount: authCases.length,
      storageStateRefCount: storageRefs.length,
      profileCount: profiles.length,
    },
  };
}

module.exports = {
  AUTH_SCHEMA_VERSION,
  authFlowSignals,
  authRequiredForRun,
  findPostLoginOracle,
  buildAuthSetupEvidenceRow,
  authSetupEvidenceIsComplete,
  buildAuthFixtureScaffold,
  dependencyIdsForTestCase,
  sessionModeForTestCase,
  buildDependencySessionPlan,
  acquireSessionForCase,
};
