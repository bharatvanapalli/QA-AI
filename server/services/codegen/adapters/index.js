'use strict';

const playwrightReference = require('./playwrightReference');
const playwrightPom = require('./playwrightPom');
const playwrightPomJs = require('./playwrightPomJs');
const seleniumReference = require('./seleniumReference');
const seleniumPom = require('./seleniumPom');
const seleniumBddReference = require('./seleniumBddReference');
const bddStepRegistry = require('./bddStepRegistry');
const bddCompiler = require('./bddCompiler');
const bddGlueEmitters = require('./bddGlueEmitters');
const bddBoundOperations = require('./bddBoundOperations');
const bddExportReadiness = require('./bddExportReadiness');

const { playwrightReferenceJs } = playwrightReference;

const adapters = Object.freeze(Object.assign(Object.create(null), {
  [playwrightReference.id]: playwrightReference,
  [playwrightPom.id]: playwrightPom,
  [playwrightPomJs.id]: playwrightPomJs,
  [seleniumReference.id]: seleniumReference,
  [seleniumPom.id]: seleniumPom,
  [seleniumBddReference.id]: seleniumBddReference,
  [playwrightReferenceJs.id]: playwrightReferenceJs,
}));

function getAdapter(id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(adapters, id)) return null;
  return adapters[id];
}

function listAdapters() {
  return Object.keys(adapters).sort();
}

function diagnosticOutput({ requestedFramework, adapterId = null, operation = null, code, message }) {
  const diagnostic = {
    code,
    severity: 'error',
    requestedFramework: typeof requestedFramework === 'string' ? requestedFramework : null,
    adapterId,
    operation: typeof operation === 'string' ? operation : null,
    message,
  };
  return {
    supported: false,
    outputKind: 'diagnostic-helper',
    requestedFramework: diagnostic.requestedFramework,
    adapterId,
    operation: diagnostic.operation,
    selectedFramework: null,
    legacyFallbackUsed: false,
    diagnostics: [diagnostic],
    files: {
      'QAAI_ADAPTER_DIAGNOSTIC.json': `${JSON.stringify({ version: 1, diagnostic }, null, 2)}\n`,
    },
  };
}

function resolveAdapterSelection(requestedFramework) {
  const adapter = getAdapter(requestedFramework);
  if (!adapter) {
    return diagnosticOutput({
      requestedFramework,
      code: 'adapter_framework_unsupported',
      message: `No code-generation adapter is registered for the exact framework id "${String(requestedFramework || '')}". No alternate framework was selected.`,
    });
  }
  return {
    supported: true,
    outputKind: 'adapter-selection',
    requestedFramework,
    adapterId: adapter.id,
    adapter,
    selectedFramework: adapter.id,
    legacyFallbackUsed: false,
    diagnostics: [],
  };
}

function dispatchAdapterOperation(requestedFramework, operation, args = []) {
  const selection = resolveAdapterSelection(requestedFramework);
  if (!selection.supported) return selection;
  if (typeof operation !== 'string' || typeof selection.adapter[operation] !== 'function') {
    return diagnosticOutput({
      requestedFramework,
      adapterId: selection.adapterId,
      operation,
      code: 'adapter_operation_unsupported',
      message: `Adapter "${selection.adapterId}" does not implement operation "${String(operation || '')}". No legacy adapter or alternate framework was invoked.`,
    });
  }
  const callArgs = Array.isArray(args) ? args : [args];
  const output = selection.adapter[operation](...callArgs);
  return {
    ...selection,
    outputKind: 'adapter-output',
    operation,
    // Preserve the exact caller-owned ReplayIR/options objects. Dispatch does not
    // clone, normalize, reorder, or reinterpret authored steps, locator evidence,
    // typed bindings, or observed context transitions.
    dispatchInput: { arguments: callArgs },
    output,
  };
}

module.exports = {
  adapters,
  getAdapter,
  listAdapters,
  resolveAdapterSelection,
  dispatchAdapterOperation,
  diagnosticOutput,
  playwrightReference,
  playwrightPom,
  playwrightPomJs,
  seleniumReference,
  seleniumPom,
  seleniumBddReference,
  bddStepRegistry,
  bddCompiler,
  bddGlueEmitters,
  bddBoundOperations,
  bddExportReadiness,
};
