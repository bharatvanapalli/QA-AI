'use strict';

const vocabulary = require('../../../lib/capabilityVocabulary');

const {
  OPERATIONS,
  CRITERIA_OPERATORS,
  isOperation,
  operationsForType,
  validateCriteria,
} = vocabulary;

function freezeEntry(entry) {
  return Object.freeze({
    ...entry,
    args: Object.freeze([...(entry.args || [])]),
  });
}

const INTERNAL_OPERATIONS = new Set([
  'authoredAction',
  'authoredAssertion',
  'authoredWait',
  'authoredContext',
  'authoredDependency',
]);

const STEP_REGISTRY = Object.freeze({
  authenticateAs: freezeEntry({
    operation: 'authenticateAs',
    keyword: 'Given',
    gherkin: 'I am authenticated as {role}',
    args: ['role'],
    replayOp: 'auth.profile',
    requiredCapability: null,
  }),
  navigateToModule: freezeEntry({
    operation: 'navigateToModule',
    keyword: 'When',
    gherkin: 'I navigate to the {module} module',
    args: ['module'],
    replayOp: 'navigate.module',
    requiredCapability: null,
  }),
  assertVisibleText: freezeEntry({
    operation: 'assertVisibleText',
    keyword: 'Then',
    gherkin: 'I should see {text}',
    args: ['text'],
    replayOp: 'assert.UI_TEXT',
    requiredCapability: null,
  }),
  fillField: freezeEntry({
    operation: 'fillField',
    keyword: 'When',
    gherkin: 'I fill the {field} field with {value}',
    args: ['field', 'value'],
    replayOp: 'act.fill',
    requiredCapability: 'form',
  }),
  submitForm: freezeEntry({
    operation: 'submitForm',
    keyword: 'When',
    gherkin: 'I submit the current form',
    args: [],
    replayOp: 'act.submit',
    requiredCapability: 'form',
  }),
  selectEntityWhere: freezeEntry({
    operation: 'selectEntityWhere',
    keyword: 'When',
    gherkin: 'I select {entity} entities where:',
    args: ['entity', 'criteria'],
    replayOp: 'collection.selectWhere',
    requiredCapability: 'entity_collection',
    table: 'criteria',
  }),
  rankByMin: freezeEntry({
    operation: 'rankByMin',
    keyword: 'And',
    gherkin: 'I choose the selected entity with minimum {field}',
    args: ['field'],
    replayOp: 'collection.rankByMin',
    requiredCapability: 'entity_collection',
  }),
  rankByMax: freezeEntry({
    operation: 'rankByMax',
    keyword: 'And',
    gherkin: 'I choose the selected entity with maximum {field}',
    args: ['field'],
    replayOp: 'collection.rankByMax',
    requiredCapability: 'entity_collection',
  }),
  chooseSelected: freezeEntry({
    operation: 'chooseSelected',
    keyword: 'And',
    gherkin: 'I choose the selected entity',
    args: [],
    replayOp: 'collection.chooseSelected',
    requiredCapability: 'entity_collection',
  }),
  assertTableContains: freezeEntry({
    operation: 'assertTableContains',
    keyword: 'Then',
    gherkin: 'the entity collection should contain:',
    args: ['criteria'],
    replayOp: 'assert.collectionContains',
    requiredCapability: 'entity_collection',
    table: 'criteria',
  }),
  invokeAction: freezeEntry({
    operation: 'invokeAction',
    keyword: 'When',
    gherkin: 'I invoke the {action} action',
    args: ['action'],
    replayOp: 'act.invokeAction',
    requiredCapability: 'workflow_action',
  }),
  downloadFile: freezeEntry({
    operation: 'downloadFile',
    keyword: 'When',
    gherkin: 'I download the {target} file',
    args: ['target?'],
    replayOp: 'download.file',
    requiredCapability: 'file',
  }),
});

const INTERNAL_STEP_REGISTRY = Object.freeze({
  authoredAction: freezeEntry({
    operation: 'authoredAction', keyword: 'When',
    gherkin: 'I perform authored action {identity} on {target} using {value} with details {details}',
    args: ['identity', 'target', 'value', 'details'], replayOp: 'authored.action', requiredCapability: null, internal: true,
  }),
  authoredAssertion: freezeEntry({
    operation: 'authoredAssertion', keyword: 'Then',
    gherkin: 'I verify authored expectation {identity} on {target} using {value} with details {details}',
    args: ['identity', 'target', 'value', 'details'], replayOp: 'authored.assertion', requiredCapability: null, internal: true,
  }),
  authoredWait: freezeEntry({
    operation: 'authoredWait', keyword: 'When',
    gherkin: 'I wait for authored condition {identity} on {target} using {value} with details {details}',
    args: ['identity', 'target', 'value', 'details'], replayOp: 'authored.wait', requiredCapability: null, internal: true,
  }),
  authoredContext: freezeEntry({
    operation: 'authoredContext', keyword: 'Given',
    gherkin: 'I establish authored context {identity} on {target} using {value} with details {details}',
    args: ['identity', 'target', 'value', 'details'], replayOp: 'authored.context', requiredCapability: null, internal: true,
  }),
  authoredDependency: freezeEntry({
    operation: 'authoredDependency', keyword: 'Given',
    gherkin: 'I use authored dependency {identity} from {target} using {value} with details {details}',
    args: ['identity', 'target', 'value', 'details'], replayOp: 'authored.dependency', requiredCapability: null, internal: true,
  }),
});

const ALL_STEP_KEYS = Object.freeze([...Object.keys(STEP_REGISTRY), ...Object.keys(INTERNAL_STEP_REGISTRY)]);
const ADAPTER_SUPPORT = Object.freeze({
  'playwright-bdd': ALL_STEP_KEYS,
  'cucumber-playwright': ALL_STEP_KEYS,
  'selenium-bdd': ALL_STEP_KEYS,
});

function finding(rule, severity, message, path = null) {
  return { rule, severity, message, path, engine: 'bdd-step-registry' };
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function internalIdentifier(value) {
  const text = clean(value);
  return !text
    || /^(?:el|element|node|target|step|case)[-_]?\d+$/i.test(text)
    || /^\d+$/.test(text)
    || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(text);
}

function humanize(value) {
  return clean(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function looksLikeUrl(value) {
  return /^(?:https?:\/\/|\/[^\s]*)/i.test(clean(value));
}

function semanticKind(step = {}) {
  const text = humanize(step.kind || step.type || step.operation || step.action || step.verb);
  if (/\b(assert(?:ion)?|verif(?:y|ication)|expect(?:ation)?|check|validate|validation)\b/.test(text)) return 'assertion';
  if (/\b(wait|waiting|poll|retry|pause)\b/.test(text)) return 'wait';
  if (/\b(depend(?:ency|ent)?|prerequisite|upstream|session continuation)\b/.test(text)) return 'dependency';
  if (/\b(context|precondition|setup|authenticate|authentication|login state)\b/.test(text)) return 'context';
  return 'action';
}

function semanticTarget(step = {}) {
  const params = step.params && typeof step.params === 'object' ? step.params : {};
  const raw = step.element || step.targetLabel || step.field || step.label || params.field
    || params.target || params.module || params.entity || params.action || step.target;
  if (looksLikeUrl(raw)) return 'authored destination';
  if (!internalIdentifier(raw)) return clean(raw);
  const kind = semanticKind(step);
  return kind === 'assertion' ? 'expected page state'
    : kind === 'wait' ? 'required page state'
      : kind === 'dependency' ? 'dependency output'
        : kind === 'context' ? 'browser context'
          : 'semantic page control';
}

function semanticIdentity(step = {}) {
  const params = step.params && typeof step.params === 'object' ? step.params : {};
  const action = humanize(step.action || step.verb || step.operation || step.kind || step.type);
  const target = semanticTarget(step);
  const candidate = [action, target].filter(Boolean).join(' ').trim();
  if (candidate && !internalIdentifier(candidate) && !looksLikeUrl(candidate)) return candidate;
  return `authored ${semanticKind(step)} step`;
}

function metadataBinding(bindingMetadata, stepIndex, preferredKey) {
  const entries = bindingMetadata && Array.isArray(bindingMetadata.entries) ? bindingMetadata.entries : [];
  return entries.find((entry) => entry && Number(entry.step) === Number(stepIndex) + 1
    && (!preferredKey || !entry.key || entry.key === preferredKey)) || null;
}

function bindingValue(binding, rawValue, target) {
  if (!binding || typeof binding !== 'object') return rawValue;
  if (binding.kind === 'literal') return Object.prototype.hasOwnProperty.call(binding, 'value') ? binding.value : rawValue;
  if (binding.kind === 'secret_env') return clean(binding.reference) || `env:QAAI_${clean(target || 'SECRET').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  if (binding.kind === 'workbook_column') {
    const proven = clean(binding.sheet) && clean(binding.column) && Number(binding.usableRowCount || 0) > 0;
    return proven ? `{{${clean(binding.column)}}}` : (rawValue == null || rawValue === '' ? 'unresolved workbook value' : rawValue);
  }
  if (['runtime_output', 'dependency_output', 'generated_value'].includes(binding.kind)) {
    return clean(binding.reference) || (rawValue == null || rawValue === '' ? `${binding.kind}:unresolved` : rawValue);
  }
  return rawValue;
}

function safeDetails(step, kind, target, binding) {
  const provenance = step.locatorProvenance || step.provenance || step.actionLocator?.provenance || null;
  const locatorRecipe = step.locatorRecipe || step.actionLocator || null;
  const candidates = Array.isArray(step.candidates) ? step.candidates : [];
  const details = {
    kind,
    target,
    authoredStepId: internalIdentifier(step.contractStepId || step.stepId || step.id) ? null : clean(step.contractStepId || step.stepId || step.id),
    optional: step.optional === true,
    soft: step.soft === true || step.nonBlocking === true,
    locatorProvenance: provenance,
    locatorRecipe,
    candidates,
    capabilityEvidence: step.capabilityEvidence || step.capability?.evidence || null,
    valueBinding: binding && typeof binding === 'object' ? binding : null,
    action: clean(step.action || step.verb || step.operation),
    authoredNavigation: step.authored === true || step.navigationAuthored === true,
  };
  return Buffer.from(JSON.stringify(details)).toString('base64');
}

function toAuthoredStep(step = {}, stepIndex = 0, bindingMetadata = null) {
  const source = step && typeof step === 'object' ? step : {};
  const kind = semanticKind(source);
  const operation = {
    assertion: 'authoredAssertion', wait: 'authoredWait', context: 'authoredContext', dependency: 'authoredDependency',
  }[kind] || 'authoredAction';
  const params = source.params && typeof source.params === 'object' ? source.params : {};
  const valueKey = ['value', 'inputValue', 'selectedValue', 'text', 'input', 'expectedValue', 'expected']
    .find((key) => source[key] != null || params[key] != null);
  const rawValue = valueKey ? (source[valueKey] ?? params[valueKey]) : 'no authored value';
  const explicitBinding = source.valueBinding || source.expectedBinding || metadataBinding(bindingMetadata, stepIndex, valueKey);
  const target = semanticTarget(source);
  const value = bindingValue(explicitBinding, rawValue, target);
  return {
    ...source,
    operation,
    params: {
      identity: semanticIdentity(source),
      target,
      value: value == null || value === '' ? 'no authored value' : value,
      details: safeDetails(source, kind, target, explicitBinding),
    },
    authoredFallback: true,
    sourceOperation: clean(source.operation || source.action || source.verb || source.kind || source.type) || 'authored step',
    semanticKind: kind,
    valueBinding: explicitBinding || null,
  };
}

function normalizeGherkinPattern(pattern) {
  return String(pattern || '')
    .trim()
    .replace(/^\s*(Given|When|Then|And|But)\s+/i, '')
    .replace(/\{[^}]+\}/g, '{}')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .toLowerCase();
}

function operationKeys() {
  return Object.keys(OPERATIONS).sort();
}

function registryKeys() {
  return Object.keys(STEP_REGISTRY).sort();
}

function getStep(operation) {
  return STEP_REGISTRY[operation] || INTERNAL_STEP_REGISTRY[operation] || null;
}

function adapterSupports(adapterId, operation) {
  const supported = ADAPTER_SUPPORT[String(adapterId || '').trim().toLowerCase()];
  return Array.isArray(supported) && supported.includes(operation);
}

function validateStepRegistry() {
  const findings = [];
  const ops = operationKeys();
  const registered = registryKeys();

  for (const op of ops) {
    if (!STEP_REGISTRY[op]) {
      findings.push(finding('bdd_registry_missing_operation', 'error', `Operation "${op}" has no canonical BDD step.`, op));
    }
  }

  for (const op of registered) {
    const entry = STEP_REGISTRY[op];
    if (!isOperation(op) && !INTERNAL_OPERATIONS.has(op)) {
      findings.push(finding('bdd_registry_unknown_operation', 'error', `Registry operation "${op}" is not in capabilityVocabulary.OPERATIONS.`, op));
    }
    if (entry.operation !== op) {
      findings.push(finding('bdd_registry_operation_mismatch', 'error', `Registry key "${op}" does not match entry.operation "${entry.operation}".`, op));
    }
    if (!entry.keyword || !/^(Given|When|Then|And|But)$/.test(entry.keyword)) {
      findings.push(finding('bdd_registry_bad_keyword', 'error', `Operation "${op}" has invalid Gherkin keyword.`, op));
    }
    if (!entry.gherkin || typeof entry.gherkin !== 'string') {
      findings.push(finding('bdd_registry_missing_pattern', 'error', `Operation "${op}" has no canonical Gherkin pattern.`, op));
    }
    if (!Array.isArray(entry.args)) {
      findings.push(finding('bdd_registry_args_not_array', 'error', `Operation "${op}" args must be an array.`, op));
    }
    if (entry.requiredCapability) {
      const allowed = operationsForType(entry.requiredCapability);
      if (!allowed.includes(op)) {
        findings.push(finding(
          'bdd_registry_bad_required_capability',
          'error',
          `Operation "${op}" is not valid for required capability "${entry.requiredCapability}".`,
          op
        ));
      }
    }
  }

  const byPattern = new Map();
  for (const entry of Object.values(STEP_REGISTRY)) {
    const normalized = normalizeGherkinPattern(entry.gherkin);
    const list = byPattern.get(normalized) || [];
    list.push(entry.operation);
    byPattern.set(normalized, list);
  }
  for (const [pattern, list] of byPattern.entries()) {
    if (list.length > 1) {
      findings.push(finding(
        'bdd_registry_duplicate_pattern',
        'error',
        `Canonical BDD pattern "${pattern}" is shared by: ${list.join(', ')}.`
      ));
    }
  }

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
  };
}

function validateOperationUse(step, { adapterId = 'playwright-bdd', path = 'steps[]' } = {}) {
  const findings = [];
  if (!step || typeof step !== 'object') {
    return {
      valid: false,
      findings: [finding('bdd_operation_not_object', 'error', `${path} must be an object.`, path)],
    };
  }

  const op = step.operation;
  if (!isOperation(op) && !INTERNAL_OPERATIONS.has(op)) {
    findings.push(finding('bdd_operation_unknown', 'error', `${path}.operation "${op}" is not in capabilityVocabulary.OPERATIONS.`, `${path}.operation`));
    return { valid: false, findings };
  }

  if (!getStep(op)) {
    findings.push(finding('bdd_registry_missing_operation', 'error', `Operation "${op}" has no canonical BDD step.`, `${path}.operation`));
  }

  if (!adapterSupports(adapterId, op)) {
    findings.push(finding(
      'bdd_adapter_unsupported_operation',
      'error',
      `Adapter "${adapterId}" does not support BDD operation "${op}".`,
      `${path}.operation`
    ));
  }

  const params = step.params && typeof step.params === 'object' ? step.params : {};
  const registry = getStep(op);
  for (const arg of registry ? registry.args : []) {
    const optional = arg.endsWith('?');
    const name = optional ? arg.slice(0, -1) : arg;
    if (!optional && !(name in params)) {
      findings.push(finding('bdd_operation_missing_param', 'error', `${path}.params.${name} is required for "${op}".`, `${path}.params.${name}`));
    }
  }

  if (params.criteria !== undefined) {
    for (const violation of validateCriteria(params.criteria, `${path}.params.criteria`)) {
      findings.push(finding('bdd_criteria_invalid', 'error', violation, `${path}.params.criteria`));
    }
  }

  return {
    valid: findings.every((f) => f.severity !== 'error'),
    findings,
  };
}

module.exports = {
  STEP_REGISTRY,
  INTERNAL_STEP_REGISTRY,
  ADAPTER_SUPPORT,
  CRITERIA_OPERATORS,
  finding,
  normalizeGherkinPattern,
  operationKeys,
  registryKeys,
  getStep,
  adapterSupports,
  validateStepRegistry,
  validateOperationUse,
  INTERNAL_OPERATIONS,
  internalIdentifier,
  semanticKind,
  semanticTarget,
  semanticIdentity,
  bindingValue,
  toAuthoredStep,
};
