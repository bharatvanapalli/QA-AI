'use strict';

const path = require('path');
const compiler = require('./bddCompiler');
const glueEmitters = require('./bddGlueEmitters');
const boundOps = require('./bddBoundOperations');
const exportValidate = require('../_exportValidate');

const PLAYWRIGHT_BDD = new Set(['playwright-bdd', 'cucumber-playwright']);
const SELENIUM_BDD = new Set(['selenium-bdd']);
const DROPPED_OPERATION_RULES = new Set([
  'operation_not_in_vocabulary',
  'capability_not_in_atlas',
  'operation_not_allowed_for_type',
  'bad_criteria_operator',
  'dropped_operation',
  'operation_dropped',
]);
const ASSERTION_OPERATIONS = new Set(['assertVisibleText', 'assertTableContains']);

function finding(rule, severity, message, pathValue = null) {
  return { rule, severity, message, path: pathValue, engine: 'bdd-export-readiness' };
}

function normalizeFramework(framework) {
  return String(framework || '').trim().toLowerCase();
}

function isBddFramework(framework) {
  const fw = normalizeFramework(framework);
  return PLAYWRIGHT_BDD.has(fw) || SELENIUM_BDD.has(fw);
}

function hasErrors(findings) {
  return findings.some((f) => f && f.severity === 'error');
}

function cleanText(value, fallback = '') {
  const text = String(value == null ? fallback : value).replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function slug(value, fallback = 'case') {
  return cleanText(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function featurePath({ featureName, scenarioName, moduleName } = {}) {
  const safeFeature = compiler.semanticName(featureName, 'authored-browser-workflow');
  const safeScenario = compiler.semanticName(scenarioName, 'execute-authored-browser-workflow');
  const safeModule = compiler.semanticName(moduleName, safeFeature);
  const folder = slug(safeModule, 'authored-workflow');
  const file = `${slug(safeScenario || safeFeature, 'execute-authored-browser-workflow')}.feature`;
  return path.posix.join('features', folder, file);
}

function normalizeOperationFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    rule: raw.rule || 'operation_plan_finding',
    severity: raw.severity || 'warning',
    message: raw.message || raw.reason || 'Operation plan finding.',
    path: raw.path || null,
    engine: raw.engine || 'operation-plan',
    dropped: raw.dropped === true || raw.disposition === 'dropped',
  };
}

function collectDroppedSignals({ droppedOperations, droppedOps, operationPlan, operationFindings } = {}) {
  const signals = [];
  const explicit = [
    ...(Array.isArray(droppedOperations) ? droppedOperations : []),
    ...(Array.isArray(droppedOps) ? droppedOps : []),
    ...(Array.isArray(operationPlan && operationPlan.droppedOperations) ? operationPlan.droppedOperations : []),
    ...(Array.isArray(operationPlan && operationPlan.droppedOps) ? operationPlan.droppedOps : []),
  ];

  explicit.forEach((item, index) => {
    const op = typeof item === 'string' ? item : item && (item.operation || item.op || item.name);
    const reason = typeof item === 'string' ? null : item && (item.reason || item.rule || item.message);
    signals.push({
      operation: op || `dropped-${index + 1}`,
      reason: reason || 'operation was dropped before export',
      path: item && item.path ? item.path : 'droppedOperations',
    });
  });

  const findings = Array.isArray(operationFindings)
    ? operationFindings.map(normalizeOperationFinding).filter(Boolean)
    : [];
  for (const f of findings) {
    if (f.dropped || DROPPED_OPERATION_RULES.has(f.rule)) {
      signals.push({
        operation: f.operation || f.path || f.rule,
        reason: f.message,
        path: f.path || 'operationFindings',
      });
    }
  }

  return { signals, findings };
}

function emitGlue(framework, operations, bindingMetadata = null) {
  const fw = normalizeFramework(framework);
  if (PLAYWRIGHT_BDD.has(fw)) {
    return glueEmitters.emitPlaywrightBddGlue({ operations, bindingMetadata });
  }
  if (SELENIUM_BDD.has(fw)) {
    return glueEmitters.emitSeleniumBddGlue({ operations, bindingMetadata });
  }
  return {
    valid: false,
    files: {},
    findings: [finding('bdd_export_framework_unsupported', 'error', `Framework "${framework}" is not an operation-backed BDD adapter.`, 'framework')],
  };
}

function assessBddExportReadiness({
  framework = 'playwright-bdd',
  caseStatus = 'pass',
  featureName,
  scenarioName,
  moduleName,
  tags,
  operations,
  authoredSteps,
  bindingMetadata,
  capabilities,
  dataRows,
  dataRow,
  droppedOperations,
  droppedOps,
  operationPlan,
  operationFindings,
} = {}) {
  const fw = normalizeFramework(framework);
  const findings = [];
  const { signals: droppedSignals, findings: planFindings } = collectDroppedSignals({
    droppedOperations,
    droppedOps,
    operationPlan,
    operationFindings,
  });
  findings.push(...planFindings);

  if (!isBddFramework(fw)) {
    findings.push(finding('bdd_export_framework_unsupported', 'error', `Framework "${framework}" is not supported by the operation-backed BDD exporter.`, 'framework'));
  }

  if (droppedSignals.length) {
    findings.push(finding(
      'bdd_export_dropped_operations',
      'warning',
      `BDD export retained ${droppedSignals.length} previously dropped operation(s) as executable authored-step fallbacks.`,
      'droppedOperations'
    ));
  }

  const authoredList = Array.isArray(authoredSteps) ? authoredSteps : [];
  const plannedOperations = Array.isArray(operations)
    ? operations
    : (Array.isArray(operationPlan && operationPlan.operations) ? operationPlan.operations : []);
  const reconciled = compiler.reconcileAuthoredOperations({
    operations: plannedOperations,
    authoredSteps: authoredList,
    bindingMetadata,
  });
  findings.push(...reconciled.findings);
  const opList = reconciled.operations.slice();
  for (const signal of droppedSignals) {
    if (authoredList.length) continue;
    opList.push({
      operation: signal.operation || 'authored step',
      action: signal.operation || 'perform',
      element: 'authored semantic target',
      value: signal.reason || 'diagnostic fallback',
      provenance: { kind: 'structural_fallback', reason: signal.reason || null },
    });
  }
  if (!opList.length) {
    findings.push(finding('bdd_export_no_operations', 'warning', 'No operation plan was available; an executable current-page context diagnostic is emitted.', 'operations'));
    opList.push({ kind: 'context', action: 'observe', element: 'current page state', value: 'current page' });
  }
  const status = String(caseStatus || '').trim().toLowerCase();
  if ((status === 'fail' || status === 'failed' || status === 'blocked')
      && !opList.some((op) => ASSERTION_OPERATIONS.has(op && op.operation))) {
    findings.push(finding(
      'bdd_export_no_verdict_assertion',
      'warning',
      `BDD export for non-pass case "${caseStatus}" has no bound assertion operation; the authored action flow remains emitted with this diagnostic.`,
      'operations'
    ));
  }

  if (!isBddFramework(fw)) {
    return {
      exportable: false,
      valid: false,
      files: {},
      findings,
      droppedSignals,
      boundOperations: opList,
    };
  }

  const bound = boundOps.validateBoundOperations({
    operations: opList,
    capabilities,
    dataRows,
    dataRow,
    bindingMetadata,
    adapterId: fw,
  });
  findings.push(...bound.findings);

  const feature = compiler.compileFeature({
    featureName,
    scenarioName,
    tags,
    operations: bound.boundOperations,
    bindingMetadata,
    dataRows,
    adapterId: fw,
  });
  findings.push(...feature.findings);

  const glue = emitGlue(fw, bound.boundOperations, bindingMetadata);
  findings.push(...glue.findings);

  const files = {
    [featurePath({ featureName, scenarioName, moduleName })]: feature.feature,
    ...glue.files,
  };

  const exportCheck = exportValidate.validateExport({
    framework: fw,
    caseStatus,
    files,
  });
  findings.push(...exportCheck.findings);

  return {
    exportable: true,
    valid: true,
    diagnosticValid: !hasErrors(findings),
    files,
    findings,
    droppedSignals,
    boundOperations: bound.boundOperations,
    outline: feature.outline,
    exampleColumns: feature.exampleColumns,
  };
}

module.exports = {
  assessBddExportReadiness,
  collectDroppedSignals,
  featurePath,
  isBddFramework,
  finding,
};
