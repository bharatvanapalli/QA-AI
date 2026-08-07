'use strict';

const registry = require('./bddStepRegistry');

function finding(rule, severity, message, path = null) {
  return { rule, severity, message, path, engine: 'bdd-compiler' };
}

function cleanText(value, fallback = '') {
  const s = String(value == null ? fallback : value)
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

const STRICT_STEP_ID_FIELDS = ['contractStepId', 'authoredStepId', 'sourceStepId', 'stepId', 'id'];

function strictStepId(step) {
  if (!step || typeof step !== 'object') return '';
  for (const field of STRICT_STEP_ID_FIELDS) {
    const value = cleanText(step[field]);
    if (value) return value;
  }
  return '';
}

function isNonAuthoredContext(step) {
  if (!step || typeof step !== 'object') return false;
  return step.nonAuthoredContext === true
    || step.authored === false
    || cleanText(step.kind).toLowerCase() === 'context';
}

function reconcileAuthoredOperations({ operations, authoredSteps, bindingMetadata } = {}) {
  const planned = Array.isArray(operations) ? operations.filter(Boolean) : [];
  const authored = Array.isArray(authoredSteps) ? authoredSteps.filter(Boolean) : [];
  const findings = [];
  if (!authored.length) return { operations: planned.slice(), findings };

  const plannedById = new Map();
  planned.forEach((operation, index) => {
    const id = strictStepId(operation);
    if (!id) return;
    if (!plannedById.has(id)) plannedById.set(id, []);
    plannedById.get(id).push({ operation, index });
  });

  const consumedPlanIndexes = new Set();
  const reconciled = authored.map((authoredStep, authoredIndex) => {
    const id = strictStepId(authoredStep);
    const match = id
      ? (plannedById.get(id) || []).find((entry) => !consumedPlanIndexes.has(entry.index))
      : null;
    if (!match) {
      findings.push(finding(
        id ? 'bdd_authored_step_plan_missing' : 'bdd_authored_step_id_missing',
        'warning',
        id
          ? `Authored step "${id}" had no exact operation-plan match and remains executable through neutral authored-step glue.`
          : `Authored step ${authoredIndex + 1} has no strict step ID and remains executable without positional or label-based reassignment.`,
        `authoredSteps[${authoredIndex}]`
      ));
      return registry.toAuthoredStep(authoredStep, authoredIndex, bindingMetadata);
    }

    consumedPlanIndexes.add(match.index);
    const plannedOperation = match.operation;
    const merged = {
      ...authoredStep,
      ...plannedOperation,
      params: {
        ...(authoredStep.params && typeof authoredStep.params === 'object' ? authoredStep.params : {}),
        ...(plannedOperation.params && typeof plannedOperation.params === 'object' ? plannedOperation.params : {}),
      },
      authoredStep,
    };
    for (const field of STRICT_STEP_ID_FIELDS) {
      if (authoredStep[field] != null && authoredStep[field] !== '') merged[field] = authoredStep[field];
    }
    return merged;
  });

  planned.forEach((operation, index) => {
    if (consumedPlanIndexes.has(index)) return;
    if (isNonAuthoredContext(operation)) {
      reconciled.push(operation);
      findings.push(finding(
        'bdd_non_authored_context_retained',
        'warning',
        `Unmatched operation-plan context at operations[${index}] is retained after the authored flow without being assigned to an authored step.`,
        `operations[${index}]`
      ));
      return;
    }
    findings.push(finding(
      'bdd_operation_plan_unmatched',
      'warning',
      `Operation-plan entry at operations[${index}] has no exact authored step ID match and was not reassigned by label or position.`,
      `operations[${index}]`
    ));
  });

  return { operations: reconciled, findings };
}

function semanticName(value, fallback) {
  const text = cleanText(value);
  if (!text
      || registry.internalIdentifier(text)
      || /^(?:root(?:\s*page)?|default|unknown|generated|recorded)(?:\s+(?:scenario|feature|case))?$/i.test(text)
      || /^(?:https?:\/\/|\/)/i.test(text)
      || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return fallback;
  return text;
}

function quoteParam(value, fallback = '') {
  const text = placeholderText(value, fallback).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${text}"`;
}

function escapeCell(value) {
  return placeholderText(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function placeholderText(value, fallback = '') {
  return cleanText(value, fallback).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name) => `<${cleanText(name)}>`);
}

const DATA_SENSITIVITY = new Set(['synthetic', 'masked', 'restricted']);
const SECRET_FIELD_RE = /(password|passcode|secret|token|api.?key|otp|pin|ssn|credit|card|cvv|auth)/i;

function normalizeTags(tags) {
  const raw = Array.isArray(tags) ? tags : [];
  return raw
    .map((tag) => cleanText(tag).replace(/^@/, '').replace(/[^A-Za-z0-9_-]+/g, '_'))
    .filter(Boolean)
    .map((tag) => `@${tag}`);
}

function envName(value, rowIndex) {
  const suffix = cleanText(value, 'value')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'VALUE';
  return `QAAI_TD_${suffix}_ROW_${Number(rowIndex || 0) + 1}`;
}

function defaultSensitivity(field) {
  return SECRET_FIELD_RE.test(cleanText(field)) ? 'masked' : 'synthetic';
}

function normalizeSensitivityValue(value, field, path, findings) {
  if (value == null || value === '') return defaultSensitivity(field);
  if (DATA_SENSITIVITY.has(value)) return value;
  findings.push(finding(
    'bdd_data_row_bad_sensitivity',
    'error',
    `${path} must be synthetic, masked, or restricted.`,
    path
  ));
  return defaultSensitivity(field);
}

function normalizeSensitivity(input, fields, rowIndex, findings) {
  const out = {};
  if (typeof input === 'string') {
    for (const field of Object.keys(fields)) {
      out[field] = normalizeSensitivityValue(input, field, `dataRows[${rowIndex}].sensitivity`, findings);
    }
    return out;
  }
  const byField = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const field of Object.keys(fields)) {
    out[field] = normalizeSensitivityValue(byField[field], field, `dataRows[${rowIndex}].sensitivity.${field}`, findings);
  }
  return out;
}

function normalizeRows(dataRows, findings = []) {
  if (!Array.isArray(dataRows)) return [];
  return dataRows
    .filter((row) => row && typeof row === 'object')
    .map((row, i) => {
      const fields = row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields) ? row.fields : {};
      const index = Number.isFinite(Number(row.index)) ? Number(row.index) : i;
      return {
        index,
        label: cleanText(row.label, `Row ${i + 1}`),
        fields,
        sensitivity: normalizeSensitivity(row.sensitivity, fields, i, findings),
      };
    });
}

function collectExampleColumns(rows) {
  const seen = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.fields || {})) {
      if (cleanText(key)) seen.add(key);
    }
  }
  return [...seen];
}

function placeholdersIn(lines) {
  const found = new Set();
  for (const line of lines) {
    String(line || '').replace(/<([^>]+)>/g, (_, name) => {
      if (cleanText(name)) found.add(name.trim());
      return _;
    });
  }
  return found;
}

function renderCriteriaTable(criteria, indent = '      ') {
  const rows = ['| field | operator | value |'];
  for (const criterion of criteria || []) {
    rows.push(`| ${escapeCell(criterion.field)} | ${escapeCell(criterion.operator)} | ${escapeCell(criterion.value)} |`);
  }
  return rows.map((line) => `${indent}${line}`);
}

function renderPattern(entry, params) {
  return entry.gherkin.replace(/\{([^}]+)\}/g, (_, name) => {
    const key = String(name || '').replace(/\?$/, '');
    const value = key === 'target' && params[key] == null ? 'current' : params[key];
    return quoteParam(value, key);
  });
}

function renderOperation(step, index, opts) {
  const adapterId = opts.adapterId || 'playwright-bdd';
  const validation = registry.validateOperationUse(step, { adapterId, path: `operations[${index}]` });
  const findings = [...validation.findings];
  const renderedStep = validation.valid
    ? step
    : registry.toAuthoredStep(step, index, opts.bindingMetadata);
  if (!validation.valid) {
    findings.push(finding(
      'bdd_authored_step_fallback',
      'warning',
      `operations[${index}] is emitted through neutral authored-step glue instead of being omitted.`,
      `operations[${index}]`
    ));
  }

  const entry = registry.getStep(renderedStep.operation);
  const params = renderedStep.params && typeof renderedStep.params === 'object' ? renderedStep.params : {};
  const lines = [];
  const provenance = renderedStep.locatorProvenance || renderedStep.provenance
    || renderedStep.actionLocator?.provenance || null;
  const provenanceKind = cleanText(provenance && (provenance.kind || provenance.source) || '').toLowerCase();
  if (renderedStep.authoredFallback || /(?:guess|candidate|structural|llm)/.test(provenanceKind)) {
    lines.push('    # QAAI_LOCATOR_FALLBACK: Exact action-time DOM evidence was unavailable; this step uses an executable semantic candidate.');
    lines.push('    # Replace only this locator candidate with verified DOM evidence if the semantic target does not match.');
  } else if (provenance && /(?:verified|exact|action.?time|dom)/.test(provenanceKind)) {
    lines.push('    # QAAI_LOCATOR_PROVENANCE: Exact verified locator evidence is preserved in the generated glue.');
  }
  if (renderedStep.optional === true || renderedStep.soft === true || renderedStep.nonBlocking === true) {
    lines.push('    # QAAI_NON_BLOCKING: This authored check records an ordinary mismatch and allows independent later steps to continue.');
  }
  lines.push(`    ${entry.keyword} ${renderPattern(entry, params)}`);

  if (entry.table === 'criteria') {
    lines.push(...renderCriteriaTable(params.criteria, '      '));
  }

  return { lines, findings };
}

function renderExamples(rows, columns) {
  if (!rows.length || !columns.length) return [];
  const header = `      | ${columns.map(escapeCell).join(' | ')} |`;
  const body = rows.map((row) => {
    const cells = columns.map((column) => escapeCell(exampleValue(row, column)));
    return `      | ${cells.join(' | ')} |`;
  });
  return ['', '    Examples:', header, ...body];
}

function exampleValue(row, column) {
  const sensitivity = row.sensitivity && row.sensitivity[column]
    ? row.sensitivity[column]
    : defaultSensitivity(column);
  if (sensitivity === 'restricted') return `vault:${cleanText(column, 'value')}:row-${Number(row.index || 0) + 1}`;
  if (sensitivity === 'masked') return `env:${envName(column, row.index)}`;
  return row.fields ? row.fields[column] : '';
}

function validateExamplesAgainstPlaceholders(featureLines, rows, columns) {
  const findings = [];
  const placeholders = placeholdersIn(featureLines);
  if (!placeholders.size) return findings;

  const colSet = new Set(columns);
  for (const placeholder of placeholders) {
    if (!colSet.has(placeholder)) {
      findings.push(finding(
        'bdd_outline_missing_example_column',
        'error',
        `Scenario Outline placeholder <${placeholder}> has no dataRows field column.`,
        `examples.${placeholder}`
      ));
    }
  }

  rows.forEach((row, i) => {
    for (const placeholder of placeholders) {
      const value = row.fields ? row.fields[placeholder] : undefined;
      if (value == null || String(value).trim() === '') {
        findings.push(finding(
          'bdd_outline_missing_example_value',
          'error',
          `dataRows[${i}].fields.${placeholder} is required by the Scenario Outline.`,
          `dataRows[${i}].fields.${placeholder}`
        ));
      }
    }
  });

  return findings;
}

function compileFeature({
  featureName,
  scenarioName,
  tags,
  operations,
  authoredSteps,
  bindingMetadata,
  dataRows,
  adapterId = 'playwright-bdd',
} = {}) {
  const findings = [];
  const registryCheck = registry.validateStepRegistry();
  findings.push(...registryCheck.findings);

  const reconciled = reconcileAuthoredOperations({ operations, authoredSteps, bindingMetadata });
  findings.push(...reconciled.findings);
  let opList = reconciled.operations;
  if (!opList.length) {
    findings.push(finding('bdd_no_operations', 'warning', 'No authored operations were supplied; emitting an executable current-page context diagnostic.'));
    opList = [{ kind: 'context', action: 'observe', element: 'current page state', value: 'current page' }];
  }

  const rows = normalizeRows(dataRows, findings);
  const exampleColumns = collectExampleColumns(rows);
  const outline = rows.length > 0 && exampleColumns.length > 0;
  const lines = [
    `Feature: ${semanticName(featureName, 'Authored browser workflow')}`,
    '',
  ];

  const tagLine = normalizeTags(tags).join(' ');
  if (tagLine) lines.push(`  ${tagLine}`);
  lines.push(`  ${outline ? 'Scenario Outline' : 'Scenario'}: ${semanticName(scenarioName, 'Execute authored browser workflow')}`);

  for (let i = 0; i < opList.length; i += 1) {
    const rendered = renderOperation(opList[i], i, { adapterId, bindingMetadata });
    findings.push(...rendered.findings);
    lines.push(...rendered.lines);
  }

  if (outline) {
    lines.push(...renderExamples(rows, exampleColumns));
    findings.push(...validateExamplesAgainstPlaceholders(lines, rows, exampleColumns));
  }

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    feature: lines.join('\n').trimEnd() + '\n',
    findings,
    outline,
    exampleColumns,
    operationSteps: opList.map((step) => ({
      operation: step && step.operation,
      pattern: registry.getStep(step && step.operation)?.gherkin || null,
    })),
  };
}

module.exports = {
  compileFeature,
  renderCriteriaTable,
  normalizeRows,
  collectExampleColumns,
  placeholdersIn,
  semanticName,
  renderOperation,
  strictStepId,
  reconcileAuthoredOperations,
  finding,
};
