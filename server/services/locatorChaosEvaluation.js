'use strict';

const actionLocatorResolver = require('./actionLocatorResolver');
const locatorIntelligenceV2 = require('./locatorIntelligenceV2');

const CHAOS_EVALUATION_SCHEMA_VERSION = 'qaai-locator-chaos-evaluation-v1';

function primaryLocator(actionLocator) {
  return actionLocatorResolver.primaryActionLocator(actionLocator);
}

function expressionOf(actionLocator) {
  const primary = primaryLocator(actionLocator);
  return primary && (primary.frameworkExpressions?.playwright || primary.expression) || null;
}

function proofOf(actionLocator) {
  const primary = primaryLocator(actionLocator);
  return primary && primary.proof && typeof primary.proof === 'object' ? primary.proof : {};
}

function locatorSurvived(actionLocator, { toolName = 'browser_click' } = {}) {
  const primary = primaryLocator(actionLocator);
  if (!primary) return false;
  const expression = expressionOf(primary);
  const proof = proofOf(primary);
  return !!expression
    && actionLocatorResolver.locatorExpressionIsExportSafe(expression)
    && proof.count === 1
    && proof.sameElement === true
    && !actionLocatorResolver.actionLocatorNeedsPrecisionUpgrade(actionLocator, { toolName });
}

function normalizeGap(gap) {
  if (!gap || typeof gap !== 'object') return null;
  return {
    code: gap.code || gap.type || 'locator_unverified',
    reason: gap.reason || gap.detail || gap.message || null,
    coordinate: gap.coordinate || null,
    pageUrl: gap.pageUrl || null,
  };
}

function buildEvidence(actionLocator, { toolName = 'browser_click', stepOrdinal = null, elementLabel = null, pageUrl = null } = {}) {
  if (!primaryLocator(actionLocator)) return null;
  return locatorIntelligenceV2.buildLocatorEvidenceBundle({
    actionLocator,
    toolName,
    stepOrdinal,
    elementLabel,
    pageUrl,
  });
}

function normalizeCaseResult(raw = {}, index = 0) {
  const actionLocator = raw.actionLocator || null;
  const evidence = raw.locatorEvidenceV2 || buildEvidence(actionLocator, raw);
  const gap = normalizeGap(raw.actionLocatorGap || raw.gap || null);
  const survived = locatorSurvived(actionLocator, raw);
  const gateStatus = evidence?.exportGate?.status || null;
  const outcome = survived
    ? 'survived'
    : (gap || gateStatus === 'blocked' || gateStatus === 'draft' || raw.expected === 'blocked'
      ? 'blocked'
      : 'failed');
  const silentGreen = outcome !== 'survived' && gateStatus === 'certified';
  const selected = evidence?.selected || null;
  const expression = expressionOf(actionLocator) || selected?.expression || null;
  const proof = proofOf(actionLocator);
  return {
    name: raw.name || `chaos-${index + 1}`,
    category: raw.category || 'locator',
    mutation: raw.mutation || null,
    expected: raw.expected || null,
    outcome,
    silentGreen,
    expression,
    exportSafe: expression ? actionLocatorResolver.locatorExpressionIsExportSafe(expression) : false,
    proof: {
      count: proof.count ?? selected?.proof?.count ?? null,
      sameElement: proof.sameElement === true || selected?.proof?.sameElement === true,
      visible: proof.visible ?? selected?.proof?.visible ?? null,
      enabled: proof.enabled ?? selected?.proof?.enabled ?? null,
    },
    certification: evidence ? {
      status: gateStatus,
      score: selected?.score ?? null,
      confidence: selected?.confidence || null,
      weaknesses: Array.isArray(evidence.weaknesses) ? evidence.weaknesses : [],
      repairRecommendation: evidence.repairRecommendation || null,
      fingerprintHash: evidence.fingerprint?.hash || selected?.fingerprint?.hash || null,
    } : null,
    gap,
  };
}

function buildChaosEvaluationReport({ suiteName = 'Locator Chaos Evaluation', cases = [], metadata = {} } = {}) {
  const normalized = (Array.isArray(cases) ? cases : []).map(normalizeCaseResult);
  const summary = normalized.reduce((acc, item) => {
    acc.total += 1;
    acc[item.outcome] = (acc[item.outcome] || 0) + 1;
    if (item.silentGreen) acc.silentGreens += 1;
    return acc;
  }, { total: 0, survived: 0, blocked: 0, failed: 0, silentGreens: 0 });
  summary.survivalRate = summary.total ? Math.round((summary.survived / summary.total) * 100) : 0;
  summary.safetyRate = summary.total ? Math.round(((summary.survived + summary.blocked) / summary.total) * 100) : 0;
  summary.status = summary.failed > 0 || summary.silentGreens > 0
    ? 'failed'
    : (summary.blocked > 0 ? 'guarded' : 'passed');

  const findings = [];
  for (const item of normalized) {
    if (item.silentGreen) {
      findings.push({
        severity: 'error',
        rule: 'chaos_silent_green',
        caseName: item.name,
        message: 'Chaos case was certified even though the locator did not survive the mutation.',
      });
    }
    if (item.outcome === 'failed') {
      findings.push({
        severity: 'error',
        rule: 'chaos_unclassified_failure',
        caseName: item.name,
        message: 'Chaos case neither produced a resilient locator nor a blocked repair reason.',
      });
    }
  }

  return {
    schemaVersion: CHAOS_EVALUATION_SCHEMA_VERSION,
    suiteName,
    generatedAt: new Date().toISOString(),
    metadata,
    summary,
    cases: normalized,
    findings,
  };
}

function assertChaosReportPassed(report) {
  const summary = report && report.summary || {};
  if (summary.failed > 0 || summary.silentGreens > 0) {
    const err = new Error(`Locator chaos evaluation failed: ${summary.failed || 0} failed, ${summary.silentGreens || 0} silent green.`);
    err.report = report;
    throw err;
  }
  return true;
}

module.exports = {
  CHAOS_EVALUATION_SCHEMA_VERSION,
  locatorSurvived,
  normalizeCaseResult,
  buildChaosEvaluationReport,
  assertChaosReportPassed,
};
