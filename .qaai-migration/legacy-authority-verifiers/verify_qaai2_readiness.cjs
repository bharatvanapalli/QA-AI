#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checks = [];

function read(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}

function assertFile(rel, label = rel) {
  checks.push({ phase: 'file', label, pass: fs.existsSync(path.join(root, rel)), detail: rel });
}

function assertContains(rel, needle, label, phase) {
  const body = read(rel);
  checks.push({
    phase,
    label,
    pass: !!body && body.includes(needle),
    detail: `${rel} contains ${needle}`,
  });
}

function assertRegex(rel, regex, label, phase) {
  const body = read(rel);
  checks.push({
    phase,
    label,
    pass: !!body && regex.test(body),
    detail: `${rel} matches ${regex}`,
  });
}

// Phase 0: canonical runtime/export action contracts.
assertFile('server/services/browserActionRegistry.js', 'browser action registry');
assertContains('server/services/browserActionRegistry.js', 'codegenFallback', 'actions declare codegen fallback', 'phase0');
assertContains('server/services/pipelineContract.js', 'browserActionRegistry', 'pipeline contract references registry', 'phase0');
assertContains('server/services/codegen/replayEmitter.js', 'unregistered_runtime_action', 'unknown runtime actions become export gaps', 'phase0');

// Phase 1: executable scenario quality.
assertFile('server/services/scenarioQualityContract.js', 'scenario quality contract');
assertContains('server/services/generationCompiler.js', 'qualityContract', 'generation persists quality contract', 'phase1');
assertContains('server/services/nativePlaywrightLane.js', '## Preconditions', 'Markdown specs include preconditions', 'phase1');
assertContains('server/services/nativePlaywrightLane.js', '## Session And Cleanup', 'Markdown specs include cleanup rules', 'phase1');

// Phase 2: source-first test data binding and collision control.
assertFile('server/services/testDataBindingContract.js', 'test data binding contract');
assertFile('server/services/testDataMutex.js', 'test data mutex service');
assertFile('server/services/testDataRuntimeLock.js', 'runtime data lock service');
assertContains('server/services/testDataBindingContract.js', 'data_token_without_approved_binding', 'missing/unsafe data binding is detectable', 'phase2');
assertContains('server/services/testDataMutex.js', 'lock', 'data mutex exposes lock behavior', 'phase2');

// Phase 3: pre-flight and session isolation.
assertFile('server/services/environmentPreflight.js', 'environment preflight service');
assertContains('server/services/agents/conductor.js', 'environmentPreflight', 'conductor runs environment preflight', 'phase3');
assertContains('server/services/agents/conductor.js', 'forceFreshConversation', 'fresh agent conversation after session reset', 'phase3');
assertContains('server/services/agents/conductor.js', 'mcp.stopMcpSession', 'conductor closes browser sessions', 'phase3');

// Phase 4: in-loop healing with budgets.
assertFile('server/services/runtimeHealingPolicy.js', 'runtime healing policy');
assertContains('server/services/runtimeHealingPolicy.js', 'max_heal_time_ms', 'healing has time budget', 'phase4');
assertContains('server/services/runtimeHealingPolicy.js', 'runtime_failed_after_healing_budget', 'budget-exhausted status is emitted', 'phase4');
assertContains('server/services/agents/conductor.js', "status: 'healed'", 'healed pass evidence is emitted', 'phase4');

// Phase 5: native Playwright agent lane.
assertFile('server/services/nativePlaywrightLane.js', 'native Playwright lane');
assertContains('server/services/nativePlaywrightLane.js', 'playwright-test-planner.agent.md', 'native lane includes planner agent', 'phase5');
assertContains('server/services/nativePlaywrightLane.js', 'playwright-test-generator.agent.md', 'native lane includes generator agent', 'phase5');
assertContains('server/services/nativePlaywrightLane.js', 'playwright-test-healer.agent.md', 'native lane includes healer agent', 'phase5');
assertContains('server/services/nativePlaywrightLane.js', 'playwright-test-reviewer.agent.md', 'native lane includes reviewer agent', 'phase5');
assertContains('server/services/nativePlaywrightLane.js', 'run-test-mcp-server', 'native lane uses Playwright agent MCP server', 'phase5');
assertContains('server/services/nativePlaywrightLane.js', 'locked_child_worker', 'native lane sandbox policy is explicit', 'phase5');

// Phase 6: script validation, repair, assistant, and certified outputs.
assertFile('server/services/scriptValidationRunner.js', 'script validation runner');
assertFile('server/services/scriptValidationAgent.js', 'async script validation agent');
assertFile('server/services/scriptBundleStore.js', 'persistent output bundle store');
assertFile('server/services/scriptRepairAgent.js', 'script repair agent');
assertContains('server/services/scriptValidationAgent.js', 'enqueueReplayIrRunValidation', 'live run can enqueue ReplayIR script validation', 'phase6');
assertContains('server/services/agents/conductor.js', 'enqueueReplayIrRunValidation', 'conductor queues script validation after live run', 'phase6');
assertContains('server/services/scriptValidationRunner.js', '.github/workflows/qaai-run.yml', 'generated packages include CI workflow', 'phase6');
assertContains('server/services/scriptValidationRunner.js', 'DENY_ENV_RE', 'script runner strips platform secrets', 'phase6');
assertContains('server/routes/outputFiles.js', '/:bundleId/run', 'Output Files has Run scripts route', 'phase6');
assertContains('server/routes/outputFiles.js', '/:bundleId/assistant/chat', 'Output Files assistant chat route exists', 'phase6');
assertContains('server/routes/outputFiles.js', '/:bundleId/assistant/patch-line', 'assistant can patch a generated line', 'phase6');
assertContains('server/routes/outputFiles.js', '/:bundleId/repairs/:failureId/propose', 'repair proposal route exists', 'phase6');
assertContains('server/routes/outputFiles.js', 'tryProviderScriptRepairProposal', 'repair proposal can use provider-backed bounded patches', 'phase6');
assertContains('src/components/OutputFilesAssistant.jsx', 'localStorage', 'assistant keeps bundle-scoped conversation continuity', 'phase6');
assertContains('src/components/OutputFilesAssistant.jsx', '/apply patch', 'assistant exposes explicit patch command', 'phase6');
assertContains('src/pages/Reports.jsx', 'RunScriptValidationSummary', 'Reports separate behavior result from script result', 'phase6');

// Phase 7: semantic locator and replay memory foundation.
assertFile('server/services/locatorIntelligenceV2.js', 'semantic locator intelligence');
assertFile('server/services/locatorChaosEvaluation.js', 'locator drift benchmark evaluator');
assertContains('server/services/actionLocatorResolver.js', 'primaryActionLocator', 'deterministic action locator resolution exists', 'phase7');
assertContains('server/services/projectActionMemory.js', 'record', 'action memory records locator experience', 'phase7');

// Phase 8: evidence, failure analysis, and report clarity.
assertFile('server/services/evidenceBundle.js', 'evidence bundle service');
assertFile('server/services/codegen/executionParity.js', 'script/runtime parity service');
assertContains('server/services/runs.js', 'scriptValidation', 'run payload carries script validation evidence', 'phase8');
assertContains('src/pages/Reports.jsx', 'Show raw trace', 'reports keep technical trace details behind a developer toggle', 'phase8');
assertContains('server/lib/redactSecrets.js', 'redactArgs', 'trace/action redaction service exists', 'phase8');

// Phase 9: benchmark and deployment hardening.
assertFile('scripts/verify_reliability.cjs', 'reliability verifier');
assertFile('tests/unit/locatorChaosEvaluation.test.js', 'locator drift benchmark tests');
assertContains('server/services/scriptValidationRunner.js', 'timeoutMs', 'script runner has execution timeout', 'phase9');
assertContains('server/services/nativePlaywrightLane.js', 'artifactAllowlist', 'native lane artifact allowlist exists', 'phase9');
assertContains('server/services/testDataMutex.js', 'expiresAt', 'data locks have expiration for parallel safety', 'phase9');

const failed = checks.filter((check) => !check.pass);
for (const check of checks) {
  const status = check.pass ? 'ok' : 'missing';
  console.log(`${status.padEnd(7)} ${check.phase.padEnd(7)} ${check.label}`);
  if (!check.pass) console.log(`        ${check.detail}`);
}

if (failed.length) {
  console.error(`\nQAAI 2.0 readiness failed: ${failed.length}/${checks.length} checks missing.`);
  process.exit(1);
}

console.log(`\nQAAI 2.0 readiness passed: ${checks.length} architecture checks.`);
