'use strict';

const vocabulary = require('../../../lib/capabilityVocabulary');
const registry = require('./bddStepRegistry');

const {
  operationsForType,
  validateCapabilityRecord,
} = vocabulary;

const FIELD_CONTAINER_KEYS = new Set([
  'column',
  'columns',
  'field',
  'fields',
  'fieldNames',
  'headers',
  'header',
  'labels',
]);

function finding(rule, severity, message, path = null) {
  return { rule, severity, message, path, engine: 'bdd-bound-operations' };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stableKey(value) {
  return cleanText(value).toLowerCase();
}

function capabilityIds(capability) {
  return [
    capability && capability.id,
    capability && capability.capabilityId,
    capability && capability.ref,
    capability && capability.key,
    capability && capability.name,
  ].map(stableKey).filter(Boolean);
}

function parseCapabilitiesJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (isObject(value)) return value.capabilities || value.items || [];
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (isObject(parsed)) return parsed.capabilities || parsed.items || [];
  } catch (_) {
    return [];
  }
  return [];
}

function flattenCapabilities(input) {
  const out = [];

  function visit(value) {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;

    if (value.type && Array.isArray(value.operations)) {
      out.push(value);
      return;
    }

    if (Array.isArray(value.capabilities)) visit(value.capabilities);
    if (Array.isArray(value.pages)) visit(value.pages);
    if (value.capabilitiesJson) visit(parseCapabilitiesJson(value.capabilitiesJson));
  }

  visit(input);
  return out;
}

function buildCapabilityIndex(capabilities) {
  const index = new Map();
  for (const capability of flattenCapabilities(capabilities)) {
    for (const key of capabilityIds(capability)) {
      if (!index.has(key)) index.set(key, capability);
    }
  }
  return index;
}

function capabilityRef(step) {
  return cleanText(
    step && (step.capabilityRef || step.capabilityId || step.capabilityKey || step.capabilityName)
  );
}

function resolveCapability(ref, index) {
  if (isObject(ref)) return ref;
  return index.get(stableKey(ref)) || null;
}

function operationFields(step) {
  const params = isObject(step && step.params) ? step.params : {};
  const fields = [];
  if (Array.isArray(params.criteria)) {
    for (const criterion of params.criteria) {
      if (criterion && criterion.field) fields.push(criterion.field);
    }
  }
  if (['fillField', 'rankByMin', 'rankByMax'].includes(step && step.operation) && params.field) {
    fields.push(params.field);
  }
  return fields.map(cleanText).filter(Boolean);
}

function addFieldName(names, value) {
  const text = cleanText(value);
  if (text) names.add(stableKey(text));
}

function extractCapabilityFields(capability) {
  const names = new Set();

  function visit(value, parentKey = '') {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && FIELD_CONTAINER_KEYS.has(parentKey)) {
          addFieldName(names, item);
        } else {
          visit(item, parentKey);
        }
      }
      return;
    }
    if (!isObject(value)) return;

    if (FIELD_CONTAINER_KEYS.has(parentKey)) {
      addFieldName(names, value.name);
      addFieldName(names, value.label);
      addFieldName(names, value.header);
      addFieldName(names, value.field);
      addFieldName(names, value.text);
      addFieldName(names, value.key);
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, key);
    }
  }

  visit(capability && capability.evidence);
  return names;
}

function normalizeRows(dataRows, dataRow) {
  const source = Array.isArray(dataRows)
    ? dataRows
    : dataRow
      ? [dataRow]
      : [];
  return source
    .filter(isObject)
    .map((row, index) => ({
      index: Number.isFinite(Number(row.index)) ? Number(row.index) : index,
      fields: isObject(row.fields) ? row.fields : {},
    }));
}

function collectPlaceholders(value, found = new Set()) {
  if (value == null) return found;
  if (Array.isArray(value)) {
    value.forEach((item) => collectPlaceholders(item, found));
    return found;
  }
  if (isObject(value)) {
    Object.values(value).forEach((item) => collectPlaceholders(item, found));
    return found;
  }

  String(value).replace(/\{\{\s*([^}]+?)\s*\}\}|<([^>]+)>/g, (_, braceName, angleName) => {
    const name = cleanText(braceName || angleName);
    if (name) found.add(name);
    return _;
  });
  return found;
}

function validatePlaceholderCoverage(params, rows, path, findings) {
  const placeholders = collectPlaceholders(params);
  if (!placeholders.size) return;

  if (!rows.length) {
    findings.push(finding(
      'bdd_operation_placeholder_missing_data_row',
      'error',
      `${path} uses data placeholders but no dataRows/dataRow were supplied.`,
      path
    ));
    return;
  }

  rows.forEach((row, rowIndex) => {
    for (const placeholder of placeholders) {
      const value = row.fields ? row.fields[placeholder] : undefined;
      if (value == null || cleanText(value) === '') {
        findings.push(finding(
          'bdd_operation_placeholder_missing_field',
          'error',
          `dataRows[${rowIndex}].fields.${placeholder} is required by ${path}.`,
          `dataRows[${rowIndex}].fields.${placeholder}`
        ));
      }
    }
  });
}

function validateCapabilityBinding(step, capability, entry, path, findings) {
  const capabilityCheck = validateCapabilityRecord(capability);
  if (!capabilityCheck.ok) {
    findings.push(finding(
      'bdd_capability_invalid',
      'error',
      `${path}.capabilityRef points to an unusable capability: ${capabilityCheck.violations.join('; ')}`,
      `${path}.capabilityRef`
    ));
  }

  const allowed = operationsForType(capability && capability.type);
  if (!allowed.includes(step.operation)) {
    findings.push(finding(
      'bdd_operation_capability_type_mismatch',
      'error',
      `Operation "${step.operation}" is not valid for capability type "${capability && capability.type}".`,
      `${path}.capabilityRef`
    ));
  }

  const listedOps = Array.isArray(capability && capability.operations) ? capability.operations : [];
  if (!listedOps.includes(step.operation)) {
    findings.push(finding(
      'bdd_capability_operation_missing',
      'error',
      `Capability "${capability && capability.name}" does not expose operation "${step.operation}".`,
      `${path}.capabilityRef`
    ));
  }

  const fields = extractCapabilityFields(capability);
  if (fields.size) {
    for (const field of operationFields(step)) {
      if (!fields.has(stableKey(field))) {
        findings.push(finding(
          'bdd_capability_field_missing',
          'error',
          `Capability "${capability && capability.name}" has no verified field "${field}" for "${step.operation}".`,
          `${path}.params`
        ));
      }
    }
  }

  if (entry.requiredCapability && !allowed.includes(step.operation)) {
    findings.push(finding(
      'bdd_required_capability_not_satisfied',
      'error',
      `Operation "${step.operation}" requires a capability compatible with "${entry.requiredCapability}".`,
      `${path}.capabilityRef`
    ));
  }
}

function validateBoundOperations({
  operations,
  capabilities,
  dataRows,
  dataRow,
  bindingMetadata,
  adapterId = 'playwright-bdd',
} = {}) {
  const findings = [];
  const registryCheck = registry.validateStepRegistry();
  findings.push(...registryCheck.findings);

  const opList = Array.isArray(operations) ? operations : [];
  if (!opList.length) {
    findings.push(finding('bdd_no_operations', 'error', 'Bound BDD validation needs at least one operation.', 'operations'));
  }

  const capabilityIndex = buildCapabilityIndex(capabilities);
  const rows = normalizeRows(dataRows, dataRow);
  const boundOperations = [];

  opList.forEach((step, index) => {
    const path = `operations[${index}]`;
    const errorCountBefore = findings.filter((item) => item && item.severity === 'error').length;
    const usage = registry.validateOperationUse(step, { adapterId, path });
    findings.push(...usage.findings);

    const entry = registry.getStep(step && step.operation);
    const params = isObject(step && step.params) ? step.params : {};
    validatePlaceholderCoverage(params, rows, `${path}.params`, findings);

    let capability = null;
    if (entry && entry.requiredCapability) {
      const ref = capabilityRef(step);
      if (!ref) {
        findings.push(finding(
          'bdd_operation_capability_missing',
          'error',
          `${path}.capabilityRef is required for "${step.operation}".`,
          `${path}.capabilityRef`
        ));
      } else {
        capability = resolveCapability(ref, capabilityIndex);
        if (!capability) {
          findings.push(finding(
            'bdd_operation_capability_missing',
            'error',
            `${path}.capabilityRef "${ref}" does not match any atlas capability.`,
            `${path}.capabilityRef`
          ));
        } else {
          validateCapabilityBinding(step, capability, entry, path, findings);
        }
      }
    }

    const boundStep = {
      ...(step && typeof step === 'object' ? step : {}),
      capability: capability ? {
        id: capability.id || capability.capabilityId || null,
        capabilityId: capability.capabilityId || capability.id || null,
        name: capability.name || null,
        type: capability.type || null,
        operations: Array.isArray(capability.operations) ? [...capability.operations] : [],
        evidence: capability.evidence || null,
        pageUrl: capability.pageUrl || null,
      } : null,
    };
    const errorCountAfter = findings.filter((item) => item && item.severity === 'error').length;
    if (!usage.valid || errorCountAfter > errorCountBefore) {
      const fallback = registry.toAuthoredStep({
        ...boundStep,
        capabilityEvidence: capability && capability.evidence || null,
      }, index, bindingMetadata);
      boundOperations.push(fallback);
      findings.push(finding(
        'bdd_authored_step_fallback',
        'warning',
        `${path} is retained as executable ${fallback.semanticKind} glue because exact capability or value proof is incomplete.`,
        path
      ));
    } else {
      boundOperations.push(boundStep);
    }
  });

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
    boundOperations,
    capabilityCount: capabilityIndex.size,
    dataRowCount: rows.length,
  };
}

module.exports = {
  validateBoundOperations,
  flattenCapabilities,
  buildCapabilityIndex,
  resolveCapability,
  extractCapabilityFields,
  collectPlaceholders,
  finding,
};
