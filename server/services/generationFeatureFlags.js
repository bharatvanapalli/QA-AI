'use strict';

function enabled(name, defaultValue = true) {
  const envName = `QAAI_${String(name).replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
  const raw = process.env[envName] ?? process.env[name];
  if (raw == null || raw === '') return !!defaultValue;
  return !['0', 'false', 'off', 'no', 'disabled'].includes(String(raw).trim().toLowerCase());
}

function flags() {
  return {
    firecrawlIntakeEnabled: enabled('firecrawlIntakeEnabled', false),
    firecrawlLiveCrawlEnabled: enabled('firecrawlLiveCrawlEnabled', false),
    canonicalGenerationPipelineEnabled: enabled('canonicalGenerationPipelineEnabled', true),
    readinessGateEnabled: enabled('readinessGateEnabled', true),
    sessionContractEnabled: enabled('sessionContractEnabled', true),
    generationScopedTestCasesEnabled: enabled('generationScopedTestCasesEnabled', true),
    captureFirstActionKernelEnabled: enabled('captureFirstActionKernelEnabled', true),
    recordExecutableActionRequired: enabled('recordExecutableActionRequired', true),
    strictReplayIrCompletionEnabled: enabled('strictReplayIrCompletionEnabled', true),
    authSetupEvidenceRequired: enabled('authSetupEvidenceRequired', true),
    assertionEvidenceRequired: enabled('assertionEvidenceRequired', true),
    roundTripScriptValidationEnabled: enabled('roundTripScriptValidationEnabled', true),
    recorderSidecarEnabled: enabled('recorderSidecarEnabled', false),
    stagehandObserveAssistEnabled: enabled('stagehandObserveAssistEnabled', false),
  };
}

module.exports = { enabled, flags };
