'use strict';

const REQUIRED_METHODS = [
  'emitSetup',
  'emitAuth',
  'emitLocatorResolver',
  'emitStep',
  'emitWait',
  'emitPopupHandling',
  'emitAssertion',
  'emitDataProvider',
  'emitRetryPolicy',
  'emitHumanInput',
  'emitTeardown',
  'fileLayout',
  'compileCmd',
  'runCmd',
  'validatePackage',
];

const STEP_OPS = new Set([
  'resolve',
  'waitFor',
  'act',
  'handlePopup',
  'assert',
  'humanInput',
]);

const HUMAN_DISPOSITIONS = new Set(['manual_gate', 'test_hook', 'unsupported']);
const VERDICT_STATUSES = new Set(['pass', 'fail', 'blocked', 'needs_human', 'skipped']);
const ASSERT_CHANNELS = new Set([
  'UI_TEXT',
  'UI_ROLE',
  'PAGE',
  'URL',
  'API',
  'DB_READ',
  'EMAIL_SMS',
  'DOWNLOAD',
  'PDF',
  'AUDIT_LOG',
  'ASYNC_JOB',
  'EVALUATE',
  'FORBIDDEN_TEXT',
  'FORBIDDEN_ROLE',
  'VISIBLE',
  'HIDDEN',
  'VALUE',
  'NUMBER',
  'COUNT',
  'CHECKED',
  'ATTRIBUTE',
  'ENABLED',
  'DISABLED',
  'EDITABLE',
  'READ_ONLY',
  'SELECTED',
]);
const ASSERT_CHANNELS_REQUIRING_EXPECTED = new Set([
  'UI_TEXT',
  'URL',
  'FORBIDDEN_TEXT',
  'VALUE',
  'NUMBER',
  'COUNT',
  'ATTRIBUTE',
  'SELECTED',
]);
const DATA_SENSITIVITY = new Set(['synthetic', 'masked', 'restricted']);
const SECRET_KEY_RE = /(password|passwd|pwd|token|secret|apikey|api_key|otp|mfa|code)/i;
const SAFE_REF_RE = /^(env|vault|fixture|masked):/i;
const ACTIONS_REQUIRING_VALUE_REF = new Set(['fill', 'type', 'press', 'selectOption', 'upload']);
const TYPED_BINDING_KINDS = new Set([
  'literal',
  'secret_env',
  'workbook_column',
  'runtime_output',
  'dependency_output',
  'generated_value',
]);

function finding(rule, severity, message, path = null) {
  return { rule, severity, message, path, engine: 'framework-adapter' };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function walkSecrets(value, path, findings) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkSecrets(item, `${path}[${i}]`, findings));
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const sensitivityMetadata = /(^|[.\]])sensitivity($|\.)/.test(path || '');
    // dataRow.fields.* and dataRows[N].fields.* are intentional test-data matrix values —
    // they are uploaded test credentials (not production secrets) and must be allowed as
    // literals so the exported data JSON can parameterize the spec with different inputs.
    const testDataFields = /^dataRows?\b/.test(path || '') && /(^|[.\]])fields($|\.)/.test(path || '');
    if (!sensitivityMetadata && !testDataFields && SECRET_KEY_RE.test(key) && typeof child === 'string' && child.trim() && !SAFE_REF_RE.test(child.trim())) {
      findings.push(finding(
        'replayir_secret_literal',
        'error',
        `ReplayIR secret-like field "${childPath}" must use env:/vault:/fixture:/masked:, not a literal.`,
        childPath
      ));
    }
    walkSecrets(child, childPath, findings);
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateSafeValueRef(step, path, findings, opts = {}) {
  const valueBinding = isPlainObject(step.valueBinding) ? step.valueBinding : null;
  if (valueBinding && !TYPED_BINDING_KINDS.has(valueBinding.kind)) {
    findings.push(finding(
      'replayir_value_binding_kind_unknown',
      'warn',
      `${path}.valueBinding.kind is not recognized; the binding is retained unchanged for adapter-local handling.`,
      `${path}.valueBinding.kind`
    ));
  }
  if (hasOwn(step, 'value') && (!valueBinding || valueBinding.kind !== 'literal')) {
    findings.push(finding(
      'replayir_inline_value_forbidden',
      'warn',
      `${path}.value has no typed literal binding; it is retained for diagnostic lowering instead of suppressing the authored operation.`,
      `${path}.value`
    ));
  }

  const needsValueRef = (!valueBinding && !!opts.required) || hasOwn(step, 'valueRef');
  if (!needsValueRef) return;
  if (typeof step.valueRef !== 'string' || !step.valueRef.trim()) {
    findings.push(finding(
      'replayir_value_ref_required',
      'warn',
      `${path}.valueRef or valueBinding is required for this step; the authored operation remains in output as an explicit contract.`,
      `${path}.valueRef`
    ));
    return;
  }
  if (!SAFE_REF_RE.test(step.valueRef.trim())) {
    findings.push(finding(
      'replayir_value_ref_unsafe',
      'warn',
      `${path}.valueRef must use env:/vault:/fixture:/masked:.`,
      `${path}.valueRef`
    ));
  }
}

function sensitivityValue(value, field, path, findings) {
  if (value == null || value === '') return null;
  if (DATA_SENSITIVITY.has(value)) return value;
  findings.push(finding(
    'replayir_data_row_bad_sensitivity',
    'error',
    `${path}${field ? `.${field}` : ''} must be synthetic, masked, or restricted.`,
    field ? `${path}.${field}` : path
  ));
  return null;
}

function fieldSensitivity(rowSensitivity, field, path, findings) {
  if (typeof rowSensitivity === 'string') {
    return sensitivityValue(rowSensitivity, null, path, findings);
  }
  if (!isPlainObject(rowSensitivity)) return null;

  let foundKey = Object.prototype.hasOwnProperty.call(rowSensitivity, field) ? field : null;
  if (!foundKey) {
    const lower = String(field).toLowerCase();
    foundKey = Object.keys(rowSensitivity).find((k) => String(k).toLowerCase() === lower) || null;
  }
  if (!foundKey) return null;
  return sensitivityValue(rowSensitivity[foundKey], foundKey, path, findings);
}

function validateDataRow(row, path, findings) {
  if (!isPlainObject(row)) {
    findings.push(finding('replayir_data_row_not_object', 'error', `${path} must be an object.`, path));
    return;
  }
  if (!Number.isFinite(Number(row.index))) {
    findings.push(finding('replayir_data_row_index_missing', 'error', `${path}.index must be numeric.`, `${path}.index`));
  }
  if (!row.label || typeof row.label !== 'string') {
    findings.push(finding('replayir_data_row_label_missing', 'error', `${path}.label is required.`, `${path}.label`));
  }
  if (hasOwn(row, 'fields') && !isPlainObject(row.fields)) {
    findings.push(finding('replayir_data_row_fields_bad', 'error', `${path}.fields must be an object when present.`, `${path}.fields`));
  }

  if (hasOwn(row, 'sensitivity') && row.sensitivity != null && row.sensitivity !== ''
      && typeof row.sensitivity !== 'string' && !isPlainObject(row.sensitivity)) {
    findings.push(finding(
      'replayir_data_row_bad_sensitivity',
      'error',
      `${path}.sensitivity must be synthetic, masked, restricted, or a role-keyed object of those values.`,
      `${path}.sensitivity`
    ));
  }
  if (typeof row.sensitivity === 'string') {
    sensitivityValue(row.sensitivity, null, `${path}.sensitivity`, findings);
  } else if (isPlainObject(row.sensitivity)) {
    for (const [field, value] of Object.entries(row.sensitivity)) {
      sensitivityValue(value, field, `${path}.sensitivity`, findings);
    }
  }

  const fields = isPlainObject(row.fields) ? row.fields : {};
  for (const [field, value] of Object.entries(fields)) {
    const sens = fieldSensitivity(row.sensitivity, field, `${path}.sensitivity`, findings) || 'synthetic';
    if ((sens === 'masked' || sens === 'restricted')
        && typeof value === 'string'
        && value.trim()
        && !SAFE_REF_RE.test(value.trim())) {
      findings.push(finding(
        'replayir_data_row_sensitive_literal',
        'error',
        `${path}.fields.${field} is ${sens}; the row value must already be an env:/vault:/fixture:/masked: ref, not a literal.`,
        `${path}.fields.${field}`
      ));
    }
  }
}

function validateReplayIR(ir) {
  const findings = [];
  if (!isPlainObject(ir)) {
    return {
      valid: false,
      findings: [finding('replayir_not_object', 'error', 'ReplayIR must be an object.')],
    };
  }

  if (!ir.caseId || typeof ir.caseId !== 'string') {
    findings.push(finding('replayir_case_id_missing', 'error', 'ReplayIR.caseId is required.'));
  }
  if (!ir.authProfile) {
    findings.push(finding('replayir_auth_profile_missing', 'warn', 'ReplayIR.authProfile is absent; authored steps remain exportable without an inferred authentication flow.'));
  }
  if (hasOwn(ir, 'dataRow')) {
    validateDataRow(ir.dataRow, 'dataRow', findings);
  }
  if (hasOwn(ir, 'dataRows')) {
    if (!Array.isArray(ir.dataRows)) {
      findings.push(finding('replayir_data_rows_not_array', 'error', 'ReplayIR.dataRows must be an array when present.', 'dataRows'));
    } else {
      ir.dataRows.forEach((row, i) => validateDataRow(row, `dataRows[${i}]`, findings));
    }
  }
  if (!Array.isArray(ir.steps) || ir.steps.length === 0) {
    findings.push(finding('replayir_steps_missing', 'error', 'ReplayIR.steps must be a non-empty array.'));
  } else {
    ir.steps.forEach((step, i) => {
      const path = `steps[${i}]`;
      if (!isPlainObject(step)) {
        findings.push(finding('replayir_step_not_object', 'error', `${path} must be an object.`, path));
        return;
      }
      if (!STEP_OPS.has(step.op)) {
        findings.push(finding('replayir_step_unknown_op', 'warn', `${path}.op "${step.op}" is not in the frozen ReplayIR vocabulary; it will be emitted as an explicit unsupported operation contract.`, `${path}.op`));
      }
      if (step.op === 'resolve' && (!Array.isArray(step.candidates) || step.candidates.length === 0)) {
        findings.push(finding('replayir_resolve_no_candidates', 'warn', `${path} has no locator candidates; the authored resolve operation remains in output for localized repair.`, path));
      }
      if (step.op === 'act') {
        validateSafeValueRef(step, path, findings, { required: ACTIONS_REQUIRING_VALUE_REF.has(step.action) });
      }
      if (step.op === 'assert' && !step.contractRef) {
        findings.push(finding('replayir_assert_no_contract_ref', 'error', `${path} assert step needs contractRef.`, path));
      }
      if (step.op === 'assert' && !ASSERT_CHANNELS.has(step.channel)) {
        findings.push(finding(
          'replayir_assert_bad_channel',
          'error',
          `${path}.channel must use the frozen assert.channel enum.`,
          `${path}.channel`
        ));
      }
      const hasConcreteExpected = step.expected != null && String(step.expected).trim() !== '';
      const hasTypedExpected = isPlainObject(step.expectedBinding)
        && TYPED_BINDING_KINDS.has(step.expectedBinding.kind);
      const hasDataExpected = step.dataExpected != null && String(step.dataExpected).trim() !== ''
        || (step.dataBinding && step.dataBinding.expectedColumn != null && String(step.dataBinding.expectedColumn).trim() !== '');
      if (step.op === 'assert' && ASSERT_CHANNELS_REQUIRING_EXPECTED.has(step.channel)
          && !hasConcreteExpected && !hasTypedExpected && !hasDataExpected) {
        findings.push(finding(
          'replayir_assert_expected_missing',
          'warn',
          `${path}.expected or expectedBinding is missing for ${step.channel}; retain the authored assertion as an explicit repair contract.`,
          `${path}.expected`
        ));
      }
      if (step.op === 'humanInput' && !HUMAN_DISPOSITIONS.has(step.disposition)) {
        findings.push(finding('replayir_human_input_bad_disposition', 'error', `${path}.disposition must be manual_gate, test_hook, or unsupported.`, `${path}.disposition`));
      }
      if (step.op === 'humanInput') {
        validateSafeValueRef(step, path, findings, { required: step.disposition === 'test_hook' });
      }
    });
  }

  if (!isPlainObject(ir.verdict)) {
    findings.push(finding('replayir_verdict_missing', 'error', 'ReplayIR.verdict is required.'));
  } else if (!VERDICT_STATUSES.has(ir.verdict.status)) {
    findings.push(finding('replayir_verdict_bad_status', 'error', `ReplayIR.verdict.status "${ir.verdict.status}" is invalid.`, 'verdict.status'));
  }

  walkSecrets(ir, '', findings);
  return { valid: findings.every((f) => f.severity !== 'error'), findings };
}

function validateAdapter(adapter) {
  const findings = [];
  if (!isPlainObject(adapter)) {
    return {
      valid: false,
      findings: [finding('adapter_not_object', 'error', 'FrameworkAdapter must be an object.')],
    };
  }
  if (!adapter.id || typeof adapter.id !== 'string') {
    findings.push(finding('adapter_id_missing', 'error', 'FrameworkAdapter.id is required.'));
  }
  for (const name of REQUIRED_METHODS) {
    if (typeof adapter[name] !== 'function') {
      findings.push(finding('adapter_method_missing', 'error', `FrameworkAdapter.${name}() is required.`, name));
    }
  }
  if (typeof adapter.regressionCorpus !== 'function' && !Array.isArray(adapter.regressionCorpus)) {
    findings.push(finding('adapter_regression_corpus_missing', 'error', 'FrameworkAdapter.regressionCorpus is required.'));
  }
  return { valid: findings.every((f) => f.severity !== 'error'), findings };
}

function assertNoErrors(label, result) {
  const errors = (result.findings || []).filter((f) => f.severity === 'error');
  if (errors.length) {
    const summary = errors.map((f) => `${f.rule}: ${f.message}`).join('; ');
    const err = new Error(`${label} failed: ${summary}`);
    err.findings = result.findings;
    throw err;
  }
}

function compileReplayIR(adapter, replayIR, opts = {}) {
  // Adapters attach emission-only bookkeeping to their options. Keep that
  // state internal so frozen/shared caller options remain valid inputs.
  opts = { ...(opts || {}) };
  const adapterCheck = validateAdapter(adapter);
  assertNoErrors('FrameworkAdapter validation', adapterCheck);
  const irCheck = validateReplayIR(replayIR);

  const layout = adapter.fileLayout(replayIR, opts);
  const rows = Array.isArray(opts.dataRows)
    ? opts.dataRows
    : (Array.isArray(replayIR.dataRows)
      ? replayIR.dataRows
      : (replayIR.dataRow ? [replayIR.dataRow] : []));
  const chunks = [
    adapter.emitSetup(replayIR, opts),
    adapter.emitRetryPolicy(replayIR, opts),
    adapter.emitDataProvider(rows, replayIR, opts),
    replayIR.authProfile ? adapter.emitAuth(replayIR.authProfile, replayIR, opts) : '',
  ];

  const loweringFindings = [];
  const authoredSteps = [];
  const inputSteps = Array.isArray(replayIR.steps) ? replayIR.steps : [];
  for (let index = 0; index < inputSteps.length; index += 1) {
    const rawStep = inputSteps[index];
    const step = isPlainObject(rawStep) ? rawStep : { op: 'unsupported', authoredPayload: rawStep };
    const identity = {
      authoredIndex: index,
      stepId: step.stepId || step.id || null,
      contractStepId: step.contractStepId || null,
      sourceContractStepId: step.sourceContractStepId || null,
      op: step.op || null,
      authored: step.authored !== false,
    };
    authoredSteps.push(identity);

    const emitUnsupported = (reason) => adapter.emitHumanInput('unsupported', {
      ...step,
      disposition: 'unsupported',
      unsupportedOperation: step.op || 'unknown',
      authoredOperationContract: identity,
      loweringReason: reason,
    }, replayIR, opts);

    let emitted = '';
    try {
      if (step.op === 'resolve') emitted = adapter.emitLocatorResolver(step.candidates || [], step, replayIR, opts);
      else if (step.op === 'waitFor') emitted = adapter.emitWait(step.condition, step, replayIR, opts);
      else if (step.op === 'act') emitted = adapter.emitStep(step, replayIR, opts);
      else if (step.op === 'handlePopup') emitted = adapter.emitPopupHandling(step.known || [], step, replayIR, opts);
      else if (step.op === 'assert') emitted = adapter.emitAssertion(step, replayIR, opts);
      else if (step.op === 'humanInput') emitted = adapter.emitHumanInput(step.disposition, step, replayIR, opts);
      else emitted = emitUnsupported('unknown_authored_operation');
    } catch (error) {
      loweringFindings.push(finding(
        'adapter_step_emission_failed',
        'warn',
        `Authored step ${index + 1} could not use its primary emitter and was retained as an unsupported operation contract: ${String(error && error.message || error)}`,
        `steps[${index}]`
      ));
      emitted = emitUnsupported('primary_emitter_failed');
    }
    if (typeof emitted !== 'string' || !emitted.trim()) {
      loweringFindings.push(finding(
        'adapter_step_emission_empty',
        'warn',
        `Authored step ${index + 1} produced no primary text and was retained as an unsupported operation contract.`,
        `steps[${index}]`
      ));
      emitted = emitUnsupported('primary_emitter_empty');
    }
    chunks.push(emitted);
  }

  chunks.push(adapter.emitTeardown(replayIR, opts));
  const content = chunks.filter((part) => typeof part === 'string' && part.trim()).join('\n\n').trimEnd() + '\n';
  const supportFiles = typeof adapter.supportFiles === 'function'
    ? (adapter.supportFiles(replayIR, opts) || {})
    : {};
  return {
    adapterId: adapter.id,
    layout,
    files: { ...supportFiles, [layout.testFile || layout.primaryFile]: content },
    compileCommand: adapter.compileCmd(replayIR, opts),
    runCommand: adapter.runCmd(replayIR, opts),
    authoredSteps,
    authoredStepCount: authoredSteps.length,
    findings: [...adapterCheck.findings, ...irCheck.findings, ...loweringFindings],
  };
}

module.exports = {
  REQUIRED_METHODS,
  STEP_OPS,
  HUMAN_DISPOSITIONS,
  ASSERT_CHANNELS,
  DATA_SENSITIVITY,
  TYPED_BINDING_KINDS,
  ASSERT_CHANNELS_REQUIRING_EXPECTED,
  validateAdapter,
  validateReplayIR,
  compileReplayIR,
  finding,
};
