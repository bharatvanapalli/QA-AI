'use strict';

const CONTRACT_OWNERSHIP = 'qaai_assertion_contract';
const CONTRACT_BLOCKED_REASON = 'assertion_contract_defect';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function flattenText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(flattenText).join(' ');
  return String(value);
}

function assertionExpectedText(assertion) {
  const p = assertion && assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  return lower([
    assertion && assertion.type,
    assertion && assertion.note,
    p.pageName,
    flattenText(p.expectedSignals),
    flattenText(p.primaryIndicator),
    p.expectedText,
    p.expectedUrl,
    p.expectedUrlPattern,
    p.expectedReturn,
    p.unexpectedText,
  ].filter(Boolean).join(' '));
}

function outcomeEvidenceText(outcome) {
  return lower([
    outcome && outcome.evidence,
    outcome && outcome.reason,
    outcome && outcome.semanticReasoning,
    outcome && outcome.assertion,
  ].filter(Boolean).join(' '));
}

function explanationText(failureExplanation) {
  const parsed = parseJson(failureExplanation, failureExplanation);
  return lower(flattenText(parsed));
}

function isHard(assertion) {
  return !assertion || !assertion.criticality || assertion.criticality === 'must';
}

function intentText(testCase, { includeTitle = false } = {}) {
  return lower([
    testCase && testCase.requirementText,
    testCase && testCase.requirements,
    testCase && testCase.userStory,
    testCase && testCase.acceptanceCriteria,
    testCase && testCase.expectedOutcome,
    testCase && testCase.assertions,
    testCase && testCase.steps,
    testCase && testCase.userGuidance,
    includeTitle ? testCase && testCase.name : null,
  ].filter(Boolean).join(' '));
}

function hasLogoutIntent(testCase) {
  const strong = intentText(testCase);
  const title = lower(testCase && testCase.name);
  const logoutVerbRe = /\b(log\s*out|logout|sign\s*out|session\s+end)\b/;
  const loginRedirectRe = /\bredirect(?:s|ed)?\s+(?:\w+\s+){0,8}to\s+(?:the\s+)?login\b/;
  const negatedLoginRedirectRe = /\b(?:no|not|never|without)\s+(?:being\s+)?redirect(?:ed|s)?\s+(?:back\s+)?to\s+(?:the\s+)?login\b|\bno\s+redirect\s+to\s+(?:the\s+)?login\b/;
  const positiveLogoutIntent = (text) => logoutVerbRe.test(text)
    || (loginRedirectRe.test(text) && !negatedLoginRedirectRe.test(text));
  return {
    strong: positiveLogoutIntent(strong),
    titleFallback: positiveLogoutIntent(title),
    any: positiveLogoutIntent(strong) || positiveLogoutIntent(title),
  };
}

function expectsDashboard(assertion) {
  return /\bdashboard\b|\/dashboard(?:\/index)?\b/.test(assertionExpectedText(assertion));
}

function evidenceShowsLogin(outcome, finalUrl, trace) {
  const text = lower([outcomeEvidenceText(outcome), finalUrl, trace].filter(Boolean).join(' '));
  return /\blogin\b|\/auth\/login\b|username|password/.test(text);
}

function evidenceShowsExpectedBusinessOutcome({ testCase, outcome, finalUrl, trace }) {
  if (hasLogoutIntent(testCase).any && evidenceShowsLogin(outcome, finalUrl, trace)) return true;
  return false;
}

function explanationConfessesContractDefect(failureExplanation) {
  const text = explanationText(failureExplanation);
  if (!text) return false;
  return /assertion logic is inverted|test design error|wrong page state|not a product bug|not a product defect|wrong assertion|assertion contract|checking for the wrong page/.test(text);
}

function firstFailingHardAssertion(declaredAssertions, recordedOutcomes) {
  const declared = Array.isArray(declaredAssertions) ? declaredAssertions : [];
  const outcomes = Array.isArray(recordedOutcomes) ? recordedOutcomes : [];
  const byId = new Map(outcomes.map((o) => [o && o.assertionId, o]).filter((x) => x[0]));
  for (const assertion of declared) {
    if (!assertion || !assertion.id || !isHard(assertion)) continue;
    const outcome = byId.get(assertion.id);
    if (outcome && outcome.outcome === 'not_matched') return { assertion, outcome };
  }
  return null;
}

function buildLogoutMessage(assertion, outcome) {
  const expectedByAssertion = expectsDashboard(assertion) ? 'dashboard page' : clean(assertion && assertion.payload && assertion.payload.pageName) || 'declared page state';
  const observedByEvidence = /login/.test(outcomeEvidenceText(outcome)) ? 'login page' : 'recorded page evidence';
  return {
    message: `QAAI assertion contract defect: assertion expected ${expectedByAssertion} but the logout flow reached ${observedByEvidence}.`,
    expectedByAssertion,
    observedByEvidence,
    suggestedAssertion: 'Replace the dashboard PAGE assertion with a login-page PAGE assertion for logout, optionally adding dashboard absence as a negative check.',
  };
}

function classifyAssertionContractDefect({
  testCase = null,
  declaredAssertions = [],
  recordedOutcomes = [],
  finalUrl = null,
  trace = null,
  failureExplanation = null,
  verdictReason = null,
} = {}) {
  const reason = lower(verdictReason);
  const relevantVerdict = !reason || reason.includes('assertion_not_matched') || reason.includes('soft_assertion_behavioral_absence');
  if (!relevantVerdict) return { isDefect: false };

  const failing = firstFailingHardAssertion(declaredAssertions, recordedOutcomes);
  const explanationSaysDefect = explanationConfessesContractDefect(failureExplanation);
  if (!failing && !explanationSaysDefect) return { isDefect: false };

  const assertion = failing && failing.assertion;
  const outcome = failing && failing.outcome;
  const logoutIntent = hasLogoutIntent(testCase);
  const dashboardExpected = assertion ? expectsDashboard(assertion) : false;
  const loginObserved = outcome ? evidenceShowsLogin(outcome, finalUrl, trace) : false;
  const deterministicContradiction = dashboardExpected && loginObserved;

  if (logoutIntent.any && deterministicContradiction) {
    const details = buildLogoutMessage(assertion, outcome);
    return {
      isDefect: true,
      assertionId: assertion.id,
      defectType: 'inverted_logout_assertion',
      ownership: CONTRACT_OWNERSHIP,
      blockedReason: CONTRACT_BLOCKED_REASON,
      rawMechanicalVerdict: 'fail',
      rawFailureReason: reason || 'assertion_not_matched',
      userFacingVerdict: 'blocked',
      evidenceBasis: logoutIntent.strong ? 'contract_and_evidence' : 'title_fallback_plus_evidence',
      ...details,
    };
  }

  if (logoutIntent.strong && dashboardExpected && explanationSaysDefect && evidenceShowsExpectedBusinessOutcome({ testCase, outcome, finalUrl, trace })) {
    const details = buildLogoutMessage(assertion, outcome || {});
    return {
      isDefect: true,
      assertionId: assertion.id,
      defectType: 'wrong_page_assertion',
      ownership: CONTRACT_OWNERSHIP,
      blockedReason: CONTRACT_BLOCKED_REASON,
      rawMechanicalVerdict: 'fail',
      rawFailureReason: reason || 'assertion_not_matched',
      userFacingVerdict: 'blocked',
      evidenceBasis: 'contract_and_explanation_supported_by_evidence',
      ...details,
    };
  }

  if (explanationSaysDefect && failing && evidenceShowsExpectedBusinessOutcome({ testCase, outcome, finalUrl, trace })) {
    return {
      isDefect: true,
      assertionId: assertion.id,
      defectType: 'intent_assertion_mismatch',
      ownership: CONTRACT_OWNERSHIP,
      blockedReason: CONTRACT_BLOCKED_REASON,
      rawMechanicalVerdict: 'fail',
      rawFailureReason: reason || 'assertion_not_matched',
      userFacingVerdict: 'blocked',
      evidenceBasis: 'explanation_supported_by_evidence',
      message: 'QAAI assertion contract defect: recorded evidence indicates the tested flow succeeded, but the declared assertion checked the wrong outcome.',
      expectedByAssertion: clean(assertionExpectedText(assertion)),
      observedByEvidence: clean(outcomeEvidenceText(outcome)),
      suggestedAssertion: 'Repair the declared assertion so it verifies the page state implied by the test flow.',
    };
  }

  return { isDefect: false };
}

function inferFailureExplanationOwnership(explanation) {
  if (!explanation || typeof explanation !== 'object') return explanation;
  if (explanation.ownership) return explanation;
  const text = explanationText(explanation);
  if (/assertion logic is inverted|test design error|wrong page state|not a product bug|not a product defect|wrong assertion|assertion contract/.test(text)) {
    return {
      ...explanation,
      ownershipSignal: CONTRACT_OWNERSHIP,
      recommendedStatusSignal: 'blocked',
    };
  }
  return {
    ...explanation,
    ownership: 'website',
    recommendedStatus: 'fail',
  };
}

module.exports = {
  CONTRACT_OWNERSHIP,
  CONTRACT_BLOCKED_REASON,
  classifyAssertionContractDefect,
  inferFailureExplanationOwnership,
  _private: {
    hasLogoutIntent,
    expectsDashboard,
    evidenceShowsLogin,
    explanationConfessesContractDefect,
  },
};
