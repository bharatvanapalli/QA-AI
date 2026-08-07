'use strict';

const nativePlaywrightLane = require('./nativePlaywrightLane');

const SCHEMA = 'qaai_scenario_quality_contract_v1';

const DEFAULT_SESSION_RULE = Object.freeze({
  isolation: 'fresh_context_per_case',
  storageState: 'none_unless_auth_profile_declares_it',
  cleanup: 'close_context_after_case',
  dirtyStatePolicy: 'never_reuse_dirty_state',
});

const GENERIC_TARGET_RE = /^(?:page|screen|form|feature|functionality|flow|system|application|app|details|data|thing|stuff)$/i;
const VAGUE_PHRASE_RE = /\b(?:works?|working|properly|as expected|correctly|all good|fine|valid data|invalid data|etc\.?|and so on|do the needful|perform action|complete process)\b/i;
const WEAK_ACTION_RE = /^(?:do|perform|test|execute|validate|check|verify)$/i;

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function norm(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, '{{$1}}')
    .replace(/[^a-z0-9{}]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function short(value, max = 160) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function stepIdentity(step = {}) {
  if (typeof step === 'string') return short(step);
  return short([
    step.action,
    step.element || step.target || step.locator_hint || step.field,
    step.value != null ? step.value : '',
    step.expected || step.operationCheck?.expected || '',
  ].filter(Boolean).join(' '));
}

function assertionIdentity(assertion = {}) {
  if (typeof assertion === 'string') return short(assertion);
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  return short([
    assertion.type,
    assertion.criticality,
    assertion.text || assertion.assertion || assertion.description,
    payload.expectedText,
    payload.expectedValue,
    payload.expectedUrlPattern,
    payload.expectedRole,
    payload.unexpectedText,
  ].filter(Boolean).join(' '));
}

function realAssertions(caseObj = {}) {
  return parseArray(caseObj.declaredAssertions).filter((a) => a && a.parseFailed !== true);
}

function hasConcreteAssertion(caseObj = {}) {
  if (realAssertions(caseObj).length > 0) return true;
  return !!String(caseObj.assertions || '').trim();
}

function isVagueStep(step = {}) {
  if (typeof step === 'string') {
    const text = step.trim();
    return !text || VAGUE_PHRASE_RE.test(text);
  }
  const action = short(step.action, 60);
  const target = short(step.element || step.target || step.locator_hint || step.field, 120);
  const expected = short(step.expected || step.operationCheck?.expected || step.verify?.expected || '', 160);
  const combined = [action, target, expected].filter(Boolean).join(' ');
  if (!action) return true;
  if (VAGUE_PHRASE_RE.test(combined)) return true;
  if (WEAK_ACTION_RE.test(action) && (!target || GENERIC_TARGET_RE.test(target)) && !expected && !step.verify && !step.operationCheck) return true;
  return false;
}

function caseSignature(caseObj = {}, scenario = {}) {
  const steps = parseArray(caseObj.steps).map(stepIdentity).map(norm).filter(Boolean);
  const assertions = realAssertions(caseObj).map(assertionIdentity).map(norm).filter(Boolean);
  return [
    norm(caseObj.module || scenario.module || ''),
    steps.join('|'),
    assertions.join('|'),
  ].join('::');
}

function resolveRole(caseObj = {}, scenario = {}, opts = {}) {
  return caseObj.authProfile
    || caseObj.role
    || scenario.authProfile
    || opts.authProfileName
    || opts.defaultRole
    || 'PROJECT_DEFAULT_OR_PUBLIC';
}

function expectedResult(caseObj = {}) {
  const assertions = realAssertions(caseObj);
  if (assertions.length) return assertions.map(assertionIdentity).filter(Boolean).join('; ');
  return short(caseObj.assertions || 'Declared assertion required');
}

function semanticFindings(caseObj = {}) {
  return parseArray(caseObj.semanticFindings).filter(Boolean).map((finding, index) => (
    typeof finding === 'string'
      ? { code: finding, index: null }
      : { ...finding, code: short(finding.code || `semantic_finding_${index + 1}`, 120) }
  ));
}

function buildQualityContract({ scenario = {}, caseObj = {}, opts = {}, blockers = [], warnings = [] } = {}) {
  const steps = parseArray(caseObj.steps);
  const role = resolveRole(caseObj, scenario, opts);
  const sessionRule = caseObj.sessionRule && typeof caseObj.sessionRule === 'object'
    ? { ...DEFAULT_SESSION_RULE, ...caseObj.sessionRule }
    : { ...DEFAULT_SESSION_RULE };
  const preconditions = ['Start from a clean browser context.'];
  const semanticIssues = semanticFindings(caseObj);
  if (role && role !== 'PROJECT_DEFAULT_OR_PUBLIC') preconditions.push(`Authenticate as ${role}.`);
  if (steps[0]) preconditions.push(`Begin with step 1: ${stepIdentity(steps[0])}.`);

  return {
    schema: SCHEMA,
    role,
    preconditions,
    sessionRule,
    cleanupRule: sessionRule.cleanup,
    expectedResult: expectedResult(caseObj),
    assertionCount: realAssertions(caseObj).length,
    stepCount: steps.length,
    confidence: Number.isFinite(Number(caseObj.confidence)) ? Number(caseObj.confidence) : null,
    semanticHealth: semanticIssues.length ? 'blocked' : 'healthy',
    semanticFindingCount: semanticIssues.length,
    markdownSpecStatus: blockers.length ? 'blocked_quality_contract' : 'ready_for_native_playwright_agent',
    blockers: blockers.map((b) => ({ ...b })),
    warnings: warnings.map((w) => ({ ...w })),
  };
}

function evaluateCaseQuality({ scenario = {}, caseObj = {}, opts = {}, duplicate = null } = {}) {
  const blockers = [];
  const warnings = [];
  const steps = parseArray(caseObj.steps);
  const semanticIssues = semanticFindings(caseObj);

  if (!short(caseObj.name)) blockers.push({ code: 'case_name_missing', detail: 'Generated case has no name.' });
  if (!steps.length) blockers.push({ code: 'steps_missing', detail: 'Generated case has no executable steps.' });
  steps.forEach((step, index) => {
    if (isVagueStep(step)) {
      blockers.push({
        code: 'vague_step',
        step: index + 1,
        detail: `Step ${index + 1} is too vague to execute or certify: "${stepIdentity(step)}".`,
      });
    }
  });
  if (String(caseObj.automatability || 'automatable') !== 'manual' && !hasConcreteAssertion(caseObj)) {
    blockers.push({ code: 'assertions_missing', detail: 'Automatable case has no declared assertion or human-readable assertion.' });
  }
  semanticIssues.forEach((finding) => blockers.push({
    code: 'semantic_design_defect',
    semanticCode: finding.code,
    ...(Number.isInteger(finding.index) ? { step: finding.index + 1 } : {}),
    detail: short(finding.detail || `Executable semantic validation reported ${finding.code}.`, 240),
  }));
  if (duplicate) {
    blockers.push({
      code: 'duplicate_case',
      detail: `Duplicates "${duplicate.caseName}" in scenario "${duplicate.scenarioName}".`,
    });
  }
  if (!caseObj.sessionRule) {
    warnings.push({ code: 'session_rule_defaulted', detail: 'No session rule was authored; QAAI assigned fresh_context_per_case.' });
  }

  if (semanticIssues.length) {
    const currentConfidence = Number(caseObj.confidence);
    caseObj.confidence = Number.isFinite(currentConfidence) ? Math.min(currentConfidence, 60) : 60;
  }

  const contract = buildQualityContract({ scenario, caseObj, opts, blockers, warnings });
  caseObj.qualityContract = contract;
  caseObj.sessionRule = contract.sessionRule;
  return { blockers, warnings, contract };
}

function compileScenarioQuality({ scenarios = [], project = {}, authProfileName = null, defaultRole = null } = {}) {
  const report = { total: 0, ready: 0, blocked: 0, warnings: 0, duplicates: 0, issues: [] };
  const seen = new Map();
  const opts = { project, authProfileName, defaultRole };

  for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
    for (const caseObj of Array.isArray(scenario && scenario.cases) ? scenario.cases : []) {
      report.total += 1;
      const sig = caseSignature(caseObj, scenario);
      const duplicate = sig && seen.has(sig) ? seen.get(sig) : null;
      if (sig && !duplicate) seen.set(sig, { caseName: caseObj.name, scenarioName: scenario.name });
      const result = evaluateCaseQuality({ scenario, caseObj, opts, duplicate });
      if (duplicate) report.duplicates += 1;
      if (result.blockers.length) {
        report.blocked += 1;
        report.issues.push({ case: caseObj.name, scenario: scenario.name, blockers: result.blockers, warnings: result.warnings });
      } else {
        report.ready += 1;
      }
      if (result.warnings.length) report.warnings += result.warnings.length;
    }
  }
  return { scenarios, report };
}

function buildMarkdownSpec({ project = {}, scenario = {}, testCase = {}, authProfile = null, dataRows = [], outputFile = null } = {}) {
  const qualityContract = testCase.qualityContract || buildQualityContract({ scenario, caseObj: testCase });
  return nativePlaywrightLane.buildMarkdownSpec({
    project,
    scenario,
    testCase: { ...testCase, qualityContract },
    authProfile: authProfile || { name: qualityContract.role, strategy: 'qaai_quality_contract' },
    dataRows,
    outputFile,
  });
}

module.exports = {
  SCHEMA,
  DEFAULT_SESSION_RULE,
  parseArray,
  isVagueStep,
  caseSignature,
  evaluateCaseQuality,
  semanticFindings,
  compileScenarioQuality,
  buildMarkdownSpec,
};
