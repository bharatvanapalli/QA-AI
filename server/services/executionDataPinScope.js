'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function malformedBinding(code) {
  return {
    status: 'incomplete',
    pinParseError: code,
    findings: [{ code }],
  };
}

function parseBinding(testCase) {
  if (testCase && isDataBoundBinding(testCase.dataBinding)) return testCase.dataBinding;
  if (testCase && isDataBoundBinding(testCase.dataBindingJson)) return testCase.dataBindingJson;
  if (testCase && typeof testCase.dataBindingJson === 'string') {
    if (!testCase.dataBindingJson.trim()) return null;
    try {
      const parsed = JSON.parse(testCase.dataBindingJson);
      if (parsed == null) return null;
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return malformedBinding('data_binding_json_shape_invalid');
      return parsed;
    } catch (_) {
      return malformedBinding('data_binding_json_invalid');
    }
  }
  return null;
}

function isDataBoundBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return false;
  // Inline CaseContract data is materialized from compiler-owned step evidence;
  // it intentionally has no external dataset/mapping pin.
  if (String(binding.mode || '').trim().toLowerCase() === 'inline') return false;
  // A non-empty object in the case-level dataBinding field is an authored data
  // contract, even when malformed/incomplete and missing all immutable IDs.
  // Null/absent/legacy {} bindings remain truly data-free.
  return Object.keys(binding).length > 0;
}

function pinsFromScenarios(scenarios = [], { generationId = null } = {}) {
  return (Array.isArray(scenarios) ? scenarios : []).flatMap((scenario) => (
    Array.isArray(scenario && scenario.cases) ? scenario.cases : []
  ).map((testCase) => {
    const binding = parseBinding(testCase);
    if (!isDataBoundBinding(binding)) return null;
    // The generation is execution-owned context, not a value that a serialized
    // data binding may choose. Carry it with every selected-case pin so runtime
    // catalog verification can resolve the immutable generation-wide
    // DatasetCatalog even when this conductor call executes only one dataset.
    const authoritativeGenerationId = String(
      generationId
      || testCase && testCase.generationId
      || scenario && scenario.generationId
      || '',
    ).trim() || null;
    return {
      ...binding,
      caseId: testCase && testCase.id || null,
      ...(authoritativeGenerationId ? { generationId: authoritativeGenerationId } : {}),
    };
  })).filter(Boolean);
}

function runWithExecutionDataPins(opts, callback) {
  const pins = pinsFromScenarios(opts && opts.scenarios, {
    generationId: opts && opts.generationId,
  });
  return storage.run({ pins }, callback);
}

function currentExecutionDataPins() {
  const store = storage.getStore();
  return store && Array.isArray(store.pins) ? store.pins : [];
}

module.exports = {
  runWithExecutionDataPins,
  currentExecutionDataPins,
  pinsFromScenarios,
  isDataBoundBinding,
};
