'use strict';

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
const BINDING_KINDS = Object.freeze([
  'literal', 'secret_env', 'workbook_column', 'runtime_output', 'dependency_output', 'generated_value',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function norm(value) {
  return clean(value).toLowerCase();
}

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

function tokensIn(value) {
  const out = [];
  const text = clean(value);
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(text)) !== null) out.push(match[1]);
  return out;
}

function isInputStep(step = {}) {
  const action = norm(step.action || step.verb || '');
  return /^(?:fill|type|enter|input|select|choose|pick)$/.test(action);
}

function stepValue(step = {}) {
  if (step.value != null) return step.value;
  if (step.text != null) return step.text;
  if (step.input != null) return step.input;
  if (Array.isArray(step.values) && step.values.length) return step.values.join(', ');
  return null;
}

function stepLabel(step = {}) {
  return clean(step.element || step.target || step.field || step.label || step.locator_hint || '');
}

function isSecretField(label) {
  return /\b(pass(word)?|pwd|secret|token|api[_ -]?key|credential|otp|mfa|pin)\b/i.test(clean(label));
}

function isSafeReference(value) {
  const text = clean(value);
  return /\{\{\s*[a-zA-Z_][a-zA-Z0-9_.]*\s*\}\}/.test(text)
    || /^\$[A-Z_][A-Z0-9_]*$/.test(text)
    || /^env:[A-Z_][A-Z0-9_]*$/i.test(text)
    || /^vault:[a-zA-Z0-9_.:/-]+$/i.test(text)
    || /^fixture:[a-zA-Z0-9_.:/-]+$/i.test(text);
}

function secretEnvironmentReference(label) {
  const key = clean(label || 'secret').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'SECRET';
  return `env:QAAI_${key}`;
}

function workbookTokenProof(token, caseObj = {}, generationContract = null) {
  const tokenKey = norm(token);
  const caseBinding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : {};
  const bindings = generationContract && Array.isArray(generationContract.bindings) ? generationContract.bindings : [];
  const candidates = bindings.filter((binding) => {
    if (!binding || !binding.sheet) return false;
    if (caseBinding.sheet && norm(binding.sheet) !== norm(caseBinding.sheet)) return false;
    for (const pin of ['sheetId', 'testDataSetId', 'datasetRevisionId', 'mappingId']) {
      if (caseBinding[pin] && binding[pin] !== caseBinding[pin]) return false;
    }
    return true;
  });
  if (candidates.length !== 1) return null;
  const binding = candidates[0];
  const c2f = { ...(binding.columnToField || {}), ...(caseBinding.columnToField || {}) };
  let column = null;
  for (const [role, header] of Object.entries(c2f)) {
    if (norm(role) === tokenKey || norm(header) === tokenKey) { column = clean(header); break; }
  }
  if (!column && tokenKey === 'expected') column = clean(caseBinding.expectedColumn || binding.expectedColumn);
  if (!column) return null;
  const usableRowCount = Number(binding.usableRowCount ?? binding.rowCount ?? binding.valueCount ?? 0);
  if (!Number.isFinite(usableRowCount) || usableRowCount < 1) return null;
  return {
    kind: 'workbook_column',
    sheet: binding.sheet,
    sheetId: binding.sheetId || null,
    column,
    usableRowCount,
  };
}

function classifyBinding({ value, label = '', token = null, caseObj = {}, generationContract = null } = {}) {
  const text = clean(value);
  const lower = text.toLowerCase();
  const tokenName = token || tokensIn(text)[0] || null;
  if (tokenName) {
    const proof = workbookTokenProof(tokenName, caseObj, generationContract);
    return proof || { kind: 'literal', value: text, unresolvedWorkbookToken: tokenName };
  }
  if (/^(?:runtime|output):/i.test(text)) return { kind: 'runtime_output', reference: text };
  if (/^(?:dependency|depends-on|upstream):/i.test(text)) return { kind: 'dependency_output', reference: text };
  if (/^(?:generated|generator):/i.test(text)) return { kind: 'generated_value', reference: text };
  if (/^(?:env:|\$[A-Z_][A-Z0-9_]*$)/i.test(text) || (isSecretField(label) && isSafeReference(text))) {
    return { kind: 'secret_env', reference: text.replace(/^\$/, 'env:') };
  }
  if (isSecretField(label) && text) {
    return { kind: 'secret_env', reference: secretEnvironmentReference(label), sourceLiteralPresent: true };
  }
  return { kind: 'literal', value };
}

function bindingRoles(binding = {}) {
  const roles = new Map();
  const c2f = binding && binding.columnToField && typeof binding.columnToField === 'object' ? binding.columnToField : {};
  for (const [role, header] of Object.entries(c2f)) {
    roles.set(norm(role), clean(header));
    if (header) roles.set(norm(header), clean(header));
  }
  if (binding.expectedColumn) {
    roles.set('expected', clean(binding.expectedColumn));
    roles.set(norm(binding.expectedColumn), clean(binding.expectedColumn));
  }
  return roles;
}

function labelMatchesBoundRole(label, binding = {}) {
  const hay = norm(label);
  if (!hay) return false;
  for (const key of bindingRoles(binding).keys()) {
    if (key && (hay === key || hay.includes(key) || key.includes(hay))) return true;
  }
  return false;
}

function assertionExpectedValues(caseObj = {}) {
  const out = [];
  for (const [idx, assertion] of parseArray(caseObj.declaredAssertions).entries()) {
    if (!assertion || typeof assertion !== 'object' || assertion.parseFailed === true) continue;
    const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
    for (const key of ['expectedText', 'expectedValue', 'expectedUrlPattern', 'text', 'value']) {
      if (payload[key] == null) continue;
      const value = clean(payload[key]);
      if (value) out.push({ assertion: idx + 1, key, value });
    }
  }
  return out;
}

function certifyCaseDataBinding({ caseObj = {}, generationContract = null } = {}) {
  const strictApproved = !!(generationContract && generationContract.strict && generationContract.source === 'approved');
  const allowedTokens = new Set((generationContract?.allowedTokens || []).map((t) => norm(t)));
  const forbiddenLiterals = new Set((generationContract?.forbiddenLiterals || []).map((v) => norm(v)).filter(Boolean));
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  const bindingComplete = !!(binding && binding.sheet && binding.status !== 'incomplete');
  const defects = [];
  const certifiedInputs = [];
  const certifiedAssertions = [];

  for (const [idx, step] of parseArray(caseObj.steps).entries()) {
    if (!step || typeof step !== 'object' || !isInputStep(step)) continue;
    const value = stepValue(step);
    const label = stepLabel(step);
    const valueText = clean(value);
    const stepNo = idx + 1;
    if (!valueText) {
      defects.push({ code: 'input_value_missing', step: stepNo, field: label, detail: 'Input step has no value to bind or fill.' });
      continue;
    }

    const tokens = tokensIn(valueText);
    if (tokens.length) {
      if (strictApproved && !bindingComplete) {
        defects.push({ code: 'data_token_without_approved_binding', step: stepNo, field: label, tokens, detail: 'Tokenized input requires an approved complete data binding.' });
      }
      for (const token of tokens) {
        if (strictApproved && !allowedTokens.has(norm(token))) {
          defects.push({ code: 'data_token_not_approved', step: stepNo, field: label, token, detail: `{{${token}}} is not in the approved data mapping.` });
        }
        if (strictApproved && !workbookTokenProof(token, caseObj, generationContract)) {
          defects.push({ code: 'data_token_without_usable_workbook_row', step: stepNo, field: label, token, detail: `{{${token}}} does not resolve to one emitted sheet, column, and usable row.` });
        }
      }
      certifiedInputs.push({ step: stepNo, field: label, mode: 'approved_data_token', kind: 'workbook_column', tokens, bindings: tokens.map((token) => workbookTokenProof(token, caseObj, generationContract)).filter(Boolean) });
      continue;
    }

    if (strictApproved && isSecretField(label) && !isSafeReference(valueText)) {
      defects.push({ code: 'secret_literal_not_allowed', step: stepNo, field: label, detail: 'Secret-like input uses a literal instead of an env/vault/fixture/data token reference.' });
    }
    if (strictApproved && forbiddenLiterals.has(norm(valueText))) {
      defects.push({ code: 'approved_data_literal', step: stepNo, field: label, detail: 'Step copied a value from approved test data as a literal instead of using the mapped token.' });
    }
    if (strictApproved && bindingComplete && labelMatchesBoundRole(label, binding)) {
      defects.push({ code: 'bound_field_literal', step: stepNo, field: label, detail: 'A field covered by the approved data binding is filled with a literal; certified runs must use the binding token.' });
    }
    certifiedInputs.push({ step: stepNo, field: label, mode: isSafeReference(valueText) ? 'safe_reference' : 'safe_literal', ...classifyBinding({ value, label, caseObj, generationContract }) });
  }

  for (const expected of assertionExpectedValues(caseObj)) {
    const tokens = tokensIn(expected.value);
    if (tokens.length) {
      for (const token of tokens) {
        if (strictApproved && !allowedTokens.has(norm(token))) {
          defects.push({ code: 'assertion_token_not_approved', assertion: expected.assertion, token, detail: `{{${token}}} is not in the approved data mapping.` });
        }
        if (strictApproved && !workbookTokenProof(token, caseObj, generationContract)) {
          defects.push({ code: 'assertion_token_without_usable_workbook_row', assertion: expected.assertion, token, detail: `{{${token}}} does not resolve to one emitted sheet, column, and usable row.` });
        }
      }
      certifiedAssertions.push({ assertion: expected.assertion, key: expected.key, mode: 'approved_data_token', kind: 'workbook_column', tokens, bindings: tokens.map((token) => workbookTokenProof(token, caseObj, generationContract)).filter(Boolean) });
      continue;
    }
    if (strictApproved && forbiddenLiterals.has(norm(expected.value))) {
      defects.push({ code: 'approved_expected_literal', assertion: expected.assertion, key: expected.key, detail: 'Assertion copied an approved expected value as a literal instead of using the mapped expected token.' });
    }
    certifiedAssertions.push({ assertion: expected.assertion, key: expected.key, mode: isSafeReference(expected.value) ? 'safe_reference' : 'safe_literal', ...classifyBinding({ value: expected.value, caseObj, generationContract }) });
  }

  return {
    ok: defects.length === 0,
    strictApproved,
    bindingComplete,
    certifiedInputs,
    certifiedAssertions,
    defects,
  };
}

module.exports = {
  certifyCaseDataBinding,
  BINDING_KINDS,
  classifyBinding,
  workbookTokenProof,
  secretEnvironmentReference,
  _private: {
    clean,
    norm,
    tokensIn,
    isSafeReference,
    isSecretField,
    labelMatchesBoundRole,
    assertionExpectedValues,
  },
};
