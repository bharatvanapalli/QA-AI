'use strict';

const BDD_FRAMEWORKS = new Set(['playwright-bdd', 'cucumber-playwright', 'selenium-bdd']);

function normalizeFramework(framework) {
  return String(framework || '').trim().toLowerCase();
}

function isBddFramework(framework) {
  return BDD_FRAMEWORKS.has(normalizeFramework(framework));
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseOperationsJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return { status: 'invalid', operations: [], dropped: [{ reason: 'invalid_operations_json', detail: 'operationsJson is not valid JSON' }] };
  }
}

function droppedSummary(dropped) {
  return dropped.map((item, index) => {
    if (typeof item === 'string') return `${index + 1}. ${item}`;
    const op = clean(item && (item.operation || item.op || item.name));
    const reason = clean(item && (item.reason || item.rule || item.code));
    const detail = clean(item && (item.detail || item.message || item.path));
    return `${index + 1}. ${[op, reason, detail].filter(Boolean).join(' - ') || 'operation dropped'}`;
  });
}

function finding(rule, severity, message, path = null, snippet = null) {
  return {
    rule,
    severity,
    path,
    line: 1,
    message,
    snippet: snippet ? String(snippet).slice(0, 160) : undefined,
    engine: 'bdd-export-gate',
  };
}

function assessBddOperationsForExport({ framework, testCase, operationsJson } = {}) {
  const findings = [];
  if (!isBddFramework(framework)) {
    return { exportable: true, findings, operationsPlan: null, dropped: [] };
  }

  const plan = parseOperationsJson(operationsJson !== undefined ? operationsJson : testCase && testCase.operationsJson);
  if (!plan) {
    return { exportable: true, findings, operationsPlan: null, dropped: [] };
  }

  const dropped = Array.isArray(plan.dropped) ? plan.dropped : [];
  const status = clean(plan.status || 'complete').toLowerCase();
  if (status === 'incomplete' || status === 'invalid' || dropped.length) {
    const lines = droppedSummary(dropped);
    const caseName = clean(testCase && testCase.name, 'this case');
    findings.push(finding(
      'bdd_export_operations_incomplete',
      'warning',
      `BDD output for "${caseName}" retained with diagnostics because authoring could not normalize ${dropped.length || 1} required operation(s).`,
      'operationsJson',
      lines.join('\n')
    ));
    if (status === 'incomplete' || status === 'invalid') {
      findings.push(finding(
        'bdd_export_operation_status_incomplete',
        'warning',
        `operationsJson.status is "${status}"; authored fallbacks remain in the BDD package and this diagnostic identifies the unresolved operation plan.`,
        'operationsJson.status'
      ));
    }
    dropped.forEach((item, index) => {
      const summary = droppedSummary([item])[0];
      findings.push(finding(
        'bdd_export_operation_dropped',
        'warning',
        `Operation-plan diagnostic ${summary}; the authored operation remains in output as an executable fallback or localized unsupported-operation failure.`,
        `operationsJson.dropped[${index}]`,
        summary
      ));
    });
  }

  return {
    exportable: true,
    findings,
    operationsPlan: plan,
    dropped,
  };
}

function blockedSpecMessage({ framework, testCase, gate } = {}) {
  const caseName = clean(testCase && testCase.name, 'BDD case');
  const lines = [
    `QAAI BDD OUTPUT DIAGNOSTIC`,
    `Framework: ${normalizeFramework(framework) || 'bdd'}`,
    `Case: ${caseName}`,
    `Reason: operation-plan diagnostics were retained alongside the complete authored BDD flow.`,
  ];
  for (const f of (gate && gate.findings) || []) {
    if (f.rule === 'bdd_export_operation_dropped') lines.push(`- ${f.message}`);
  }
  return lines.join('\n');
}

module.exports = {
  assessBddOperationsForExport,
  blockedSpecMessage,
  parseOperationsJson,
  isBddFramework,
  finding,
};
