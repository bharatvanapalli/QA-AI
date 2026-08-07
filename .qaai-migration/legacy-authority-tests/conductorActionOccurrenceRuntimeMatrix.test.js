import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const conductorPath = path.resolve(process.cwd(), 'server/services/agents/conductor.js');
const transformedConductorSource = fs.readFileSync(conductorPath, 'utf8').replace(/\r\n/g, '\n');

function normalizeOccurrencePart(value, fallback = 'action') {
  const normalized = String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9:._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function actionOccurrenceReuseKey({
  caseId = 'case',
  contractStepId,
  authoredActionId = null,
  authoredActionIdSource = null,
  authoredStepIndex = null,
  stepIndex = null,
  operation = 'action',
} = {}) {
  const rawStepIndex = authoredStepIndex == null ? stepIndex : authoredStepIndex;
  const stableStepIndex = rawStepIndex == null || rawStepIndex === '' || !Number.isFinite(Number(rawStepIndex))
    ? 'unknown'
    : Math.max(0, Math.floor(Number(rawStepIndex)));
  const hasExplicitAuthoredId = !!authoredActionId && authoredActionIdSource !== 'allocator_fallback';
  const authoredOccurrence = hasExplicitAuthoredId
    ? `authored:${normalizeOccurrencePart(authoredActionId, 'action')}`
    : `step:${stableStepIndex}`;
  return [
    normalizeOccurrencePart(caseId, 'case'),
    normalizeOccurrencePart(contractStepId, `runtime-step-${stableStepIndex === 'unknown' ? 1 : stableStepIndex + 1}`),
    normalizeOccurrencePart(operation, 'action'),
    authoredOccurrence,
  ].join(':');
}

const IDENTITY_KEYS = [
  'actionIdentity',
  'actionOccurrenceId',
  'authoredActionId',
  'captureBinding',
  'caseId',
  'contractStepId',
  'occurrenceKey',
  'occurrenceOrdinal',
  'runBinding',
  'sequenceIndex',
  'sourceActionOccurrenceId',
  'sourceContractStepId',
];
const IDENTITY_KEY_PATTERN = new RegExp(`\\b(?:${IDENTITY_KEYS.join('|')})\\b`);
const MUTATING_CODE_PATTERN = /\b(?:clear|click|focus|blur|dispatchEvent|submit|setAttribute|removeAttribute|appendChild|removeChild|replaceChildren|insertAdjacentHTML|scrollIntoView)\s*\(|\b(?:value|checked|selectedIndex|innerHTML|outerHTML|textContent)\s*=/i;

function findBalancedEnd(source, openIndex, open = '(', close = ')') {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unbalanced ${open}${close} expression at ${openIndex}`);
}

function splitTopLevelArgs(source) {
  const args = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') round += 1;
    else if (char === ')') round -= 1;
    else if (char === '[') square += 1;
    else if (char === ']') square -= 1;
    else if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      args.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) args.push(tail);
  return args;
}

function allMcpCalls(source, offset = 0) {
  const calls = [];
  const signature = 'mcp.callTool(';
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(signature, cursor);
    if (start < 0) break;
    const open = start + signature.length - 1;
    const end = findBalancedEnd(source, open);
    const text = source.slice(start, end + 1);
    calls.push({
      start: offset + start,
      end: offset + end + 1,
      text,
      args: splitTopLevelArgs(source.slice(open + 1, end)),
    });
    cursor = end + 1;
  }
  return calls;
}

function sourceSection(startAnchor, endAnchor) {
  const start = transformedConductorSource.indexOf(startAnchor);
  if (start < 0) throw new Error(`Missing transformed-source start anchor: ${startAnchor}`);
  const end = endAnchor
    ? transformedConductorSource.indexOf(endAnchor, start + startAnchor.length)
    : transformedConductorSource.length;
  if (end < 0) throw new Error(`Missing transformed-source end anchor: ${endAnchor}`);
  return {
    start,
    end,
    text: transformedConductorSource.slice(start, end),
  };
}

function callInSection(site) {
  const section = sourceSection(site.start, site.end);
  const calls = allMcpCalls(section.text, section.start);
  const call = calls[site.ordinal || 0];
  if (!call) throw new Error(`Missing MCP call ${site.ordinal || 0} for ${site.id}`);
  return { ...call, section: section.text };
}

function identityOptions(call) {
  return call.args[3] || '';
}

function expectIdentityBound(call, expectedSource = null) {
  expect(call.args.length, call.text).toBeGreaterThanOrEqual(4);
  const options = identityOptions(call);
  expect(options, call.text).toMatch(/actionDispatchIdentity|actionIdentity|actionOccurrenceId/);
  if (expectedSource) expect(options, call.text).toContain(expectedSource);
}

function expectExplicitInfrastructure(call, expectedSource) {
  expect(call.args.length, call.text).toBeGreaterThanOrEqual(4);
  const options = identityOptions(call);
  expect(options, call.text).toMatch(/authoredAction\s*:\s*false|infrastructureActionDispatchOptions|nonAuthoredDispatchOptions/);
  expect(`${call.section}\n${options}`, call.text).toContain(expectedSource);
}

function rawArgsOf(call) {
  return call.args[2] || '';
}

const MUTATING_SITE_MATRIX = [
  {
    id: 'data-row-recovery-storage-clear', classification: 'infrastructure', source: 'data_row_recovery',
    start: 'const resetCurrentMcpSessionForDataRowRecovery', end: 'const ensureCleanMcpSessionForDataRowRecovery', ordinal: 0,
  },
  {
    id: 'data-row-recovery-navigation', classification: 'infrastructure', source: 'data_row_recovery',
    start: 'const resetCurrentMcpSessionForDataRowRecovery', end: 'const ensureCleanMcpSessionForDataRowRecovery', ordinal: 1,
  },
  {
    id: 'per-row-storage-clear', classification: 'infrastructure', source: 'per_row_session_reset',
    start: 'if (ei > 0 && dataRows.length > 1', end: 'await ensureCleanMcpSessionForDataRowRecovery', ordinal: 0,
  },
  {
    id: 'optional-prompt-dismiss', classification: 'authored', source: 'optional_prompt_dismiss',
    start: 'const dismissLabels = [', end: 'Optional prompt "${target}" is visible', ordinal: 0,
  },
  {
    id: 'field-blocked-probe', classification: 'diagnostic', source: 'field_blocked_probe',
    start: "if (kind === 'field_blocked')", end: "if (kind === 'input_accepted')", ordinal: 0,
  },
  {
    id: 'restore-fill', classification: 'recovery-child', source: 'restore_fill',
    start: 'const restoreFillStep = async', end: 'const restoreSelectStep = async', ordinal: 0,
  },
  {
    id: 'restore-native-select', classification: 'recovery-child', source: 'restore_select',
    start: 'const restoreSelectStep = async', end: 'const currentStateStillHasStep = async', ordinal: 0,
  },
  {
    id: 'restore-open-select', classification: 'recovery-child', source: 'restore_open_select',
    start: 'const restoreSelectStep = async', end: 'const currentStateStillHasStep = async', ordinal: 1,
  },
  {
    id: 'restore-option-click', classification: 'recovery-child', source: 'pre_submit_restore_option',
    start: 'const restoreSelectStep = async', end: 'const currentStateStillHasStep = async', ordinal: 2,
  },
  {
    id: 'case-pre-navigation', classification: 'mixed-pre-navigation', source: 'pre_navigation',
    start: 'if (shouldPreNavigate) {', end: '} else {\n    // Continuation case', ordinal: 0,
  },
  {
    id: 'continuation-precision-navigation', classification: 'infrastructure', source: 'continuation_entry_recovery',
    start: 'if (precisionBridge.enabled()) {', end: 'let memoryReplayTerminalBlock', ordinal: 0,
  },
  {
    id: 'memory-first-dispatch', classification: 'authored', source: 'project_memory_dispatch',
    start: 'const tryMemoryFirstReplay = async', end: 'const deterministicDomFillByLabel = async', ordinal: 0,
  },
  {
    id: 'deterministic-dom-fill', classification: 'authored', source: 'deterministic_dom_fill',
    start: 'const deterministicDomFillByLabel = async', end: 'const deterministicDomSelectByLabel = async', ordinal: 0,
  },
  {
    id: 'deterministic-dom-select', classification: 'authored', source: 'deterministic_dom_select',
    start: 'const deterministicDomSelectByLabel = async', end: 'const kernelAppendTrail =', ordinal: 0,
  },
  {
    id: 'deterministic-exact-fill-retry', classification: 'retry', source: 'deterministic_exact_fill_retry',
    start: 'const kernelRetryExactFill = async', end: 'const kernelRetryExactClick = async', ordinal: 0,
  },
  {
    id: 'deterministic-exact-click-retry', classification: 'retry', source: 'deterministic_exact_click_retry',
    start: 'const kernelRetryExactClick = async', end: 'const kernelSeal =', ordinal: 0,
  },
  {
    id: 'deterministic-initial-dispatch', classification: 'authored', source: 'deterministic_kernel_initial_dispatch',
    start: 'const runDeterministicKernelStep = async', end: 'const drainDeterministicKernel = async', ordinal: 0,
  },
  {
    id: 'model-main-dispatch', classification: 'conditional-authored', source: 'main_authored_dispatch',
    start: 'const dispatchOptions = memoryFastPathDispatch', end: '// -- B-2e precision: post-action capture', ordinal: 0,
  },
  {
    id: 'kb-ref-retry', classification: 'retry', source: 'kb_ref_retry',
    start: 'const deterministicRef = findRefForKbLocator', end: 'let healHistoryArr = []', ordinal: 0,
  },
  {
    id: 'healed-ref-retry', classification: 'retry', source: 'healed_retry',
    start: 'if (!healingBudgetExhausted && healed && healed.confidence', end: 'const trailEntry = actionTrail[actionTrail.length - 1];', ordinal: 0,
  },
  {
    id: 'generic-click-option-owner-probe', classification: 'diagnostic-child', source: 'generic_click_option_owner_probe',
    start: 'const runGenericClickKernelStep = async', end: 'const conductorUniversalActionRuntime =', ordinal: 0,
  },
  {
    id: 'generic-click-option-query-end', classification: 'recovery-child', source: 'generic_click_option_query_end',
    start: 'const runGenericClickKernelStep = async', end: 'const conductorUniversalActionRuntime =', ordinal: 1,
  },
  {
    id: 'generic-click-option-query-backspace', classification: 'recovery-child', source: 'generic_click_option_query_backspace',
    start: 'const runGenericClickKernelStep = async', end: 'const conductorUniversalActionRuntime =', ordinal: 2,
  },
  {
    id: 'generic-click-option-query-restore', classification: 'recovery-child', source: 'generic_click_option_query_change_restore',
    start: 'const runGenericClickKernelStep = async', end: 'const conductorUniversalActionRuntime =', ordinal: 3,
  },
  {
    id: 'generic-click-initial-or-retry', classification: 'authored-retry', source: 'generic_click_',
    start: 'const runGenericClickKernelStep = async', end: 'const conductorUniversalActionRuntime =', ordinal: 4,
  },
  {
    id: 'universal-semantic-target-reveal', classification: 'diagnostic-child', source: 'semantic_target_reveal_',
    start: 'const conductorUniversalActionRuntime =', end: 'const runDeterministicKernelStep = async', ordinal: 1,
  },
  {
    id: 'universal-keyboard-focus', classification: 'diagnostic', source: 'universal_keyboard_focus',
    start: 'const conductorUniversalActionRuntime =', end: 'const runDeterministicKernelStep = async', ordinal: 2,
  },
  {
    id: 'universal-control-dispatch', classification: 'authored-retry', source: 'universal_action_',
    start: 'const conductorUniversalActionRuntime =', end: 'const runDeterministicKernelStep = async', ordinal: 3,
  },
  {
    id: 'universal-typed-event-dispatch', classification: 'authored-retry', source: 'universal_typed_event_dispatch',
    start: 'const conductorUniversalActionRuntime =', end: 'const runDeterministicKernelStep = async', ordinal: 4,
  },
  {
    id: 'auth-fixture-cookie-injection', classification: 'infrastructure', source: 'auth_fixture_cookie_injection',
    start: 'async function injectAuthFixture', end: 'async function emitJourneySpecs', ordinal: 0,
  },
  {
    id: 'auth-fixture-origin-navigation', classification: 'infrastructure', source: 'auth_fixture_storage_origin',
    start: 'async function injectAuthFixture', end: 'async function emitJourneySpecs', ordinal: 1,
  },
  {
    id: 'auth-fixture-local-storage-injection', classification: 'infrastructure', source: 'auth_fixture_local_storage',
    start: 'async function injectAuthFixture', end: 'async function emitJourneySpecs', ordinal: 2,
  },
];

// Direct call order is intentionally pinned. Any added/removed mcp.callTool
// boundary must be classified in this file before the runtime contract can pass.
// The mutation rows above are located by semantic source section; these rows
// describe the complementary read-only/assertion traffic by direct-call index.
const OBSERVATION_CALL_MATRIX = [
  { index: 2, id: 'data-row-recovery-snapshot', tool: /browser_snapshot/ },
  { index: 4, id: 'precision-atlas-read', tool: /browser_evaluate/ },
  { index: 6, id: 'exact-target-input-readback', tool: /browser_evaluate/ },
  { index: 7, id: 'named-input-readback', tool: /browser_evaluate/ },
  { index: 8, id: 'tooltip-visible-probe', tool: /browser_evaluate/ },
  { index: 10, id: 'inline-assertion-check', tool: /assertion_check/ },
  { index: 17, id: 'continuation-fresh-snapshot', tool: /browser_snapshot/ },
  { index: 28, id: 'universal-state-read', tool: /browser_evaluate/ },
  { index: 33, id: 'universal-assertion-read', tool: /browser_evaluate/ },
  { index: 35, id: 'critic-dom-read-before-kernel', tool: /browser_evaluate/ },
  { index: 36, id: 'kernel-failure-screenshot', tool: /browser_screenshot/ },
  { index: 40, id: 'declared-assertion-check', tool: /assertion_check/ },
  { index: 41, id: 'translated-assertion-check', tool: /assertion_check/ },
  { index: 42, id: 'case-final-screenshot', tool: /browser_screenshot/ },
  { index: 43, id: 'critic-dom-read-after-loop', tool: /browser_evaluate/ },
];

function extractArrowDeclaration(source, declarationAnchor) {
  const start = source.indexOf(declarationAnchor);
  if (start < 0) throw new Error(`Missing declaration: ${declarationAnchor}`);
  const arrow = source.indexOf('=>', start);
  const open = source.indexOf('{', arrow);
  const close = findBalancedEnd(source, open, '{', '}');
  const semicolon = source.indexOf(';', close);
  return { start, end: semicolon + 1, text: source.slice(start, semicolon + 1) };
}

function evaluateDeclaration(declaration, exportName, context) {
  const sandbox = {
    ...context,
    module: { exports: null },
    exports: {},
    console,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(`${declaration}\nmodule.exports = ${exportName};`, sandbox, {
    filename: `${exportName}.runtime-contract.js`,
  });
  return { exported: sandbox.module.exports, sandbox };
}

function assertNoIdentityKeys(value, label = 'tool args') {
  const serialized = JSON.stringify(value);
  expect(serialized, label).not.toMatch(IDENTITY_KEY_PATTERN);
}

describe('Conductor authored-action occurrence runtime matrix', () => {
  it('transforms the real Conductor and inventories every direct mutating MCP boundary', () => {
    const allCalls = allMcpCalls(transformedConductorSource);
    const located = MUTATING_SITE_MATRIX.map((site) => ({ site, call: callInSection(site) }));

    const mutatingStarts = new Set(located.map(({ call }) => call.start));
    const observationCalls = allCalls.filter((call) => !mutatingStarts.has(call.start));

    expect(allCalls).toHaveLength(MUTATING_SITE_MATRIX.length + OBSERVATION_CALL_MATRIX.length);
    expect(MUTATING_SITE_MATRIX).toHaveLength(32);
    expect(mutatingStarts.size).toBe(MUTATING_SITE_MATRIX.length);
    expect(observationCalls).toHaveLength(OBSERVATION_CALL_MATRIX.length);
    expect(observationCalls.map((call) => allCalls.indexOf(call))).toEqual(OBSERVATION_CALL_MATRIX.map((row) => row.index));
    for (const row of OBSERVATION_CALL_MATRIX) {
      expect(allCalls[row.index].text, row.id).toMatch(row.tool);
    }
    expect(located.map(({ site }) => site.id)).toEqual([
      'data-row-recovery-storage-clear',
      'data-row-recovery-navigation',
      'per-row-storage-clear',
      'optional-prompt-dismiss',
      'field-blocked-probe',
      'restore-fill',
      'restore-native-select',
      'restore-open-select',
      'restore-option-click',
      'case-pre-navigation',
      'continuation-precision-navigation',
      'memory-first-dispatch',
      'deterministic-dom-fill',
      'deterministic-dom-select',
      'deterministic-exact-fill-retry',
      'deterministic-exact-click-retry',
      'deterministic-initial-dispatch',
      'model-main-dispatch',
      'kb-ref-retry',
      'healed-ref-retry',
      'generic-click-option-owner-probe',
      'generic-click-option-query-end',
      'generic-click-option-query-backspace',
      'generic-click-option-query-restore',
      'generic-click-initial-or-retry',
      'universal-semantic-target-reveal',
      'universal-keyboard-focus',
      'universal-control-dispatch',
      'universal-typed-event-dispatch',
      'auth-fixture-cookie-injection',
      'auth-fixture-origin-navigation',
      'auth-fixture-local-storage-injection',
    ]);
  });

  it('binds authored calls and explicitly classifies infrastructure mutations', () => {
    for (const site of MUTATING_SITE_MATRIX) {
      const call = callInSection(site);
      if (site.classification === 'infrastructure') {
        expectExplicitInfrastructure(call, site.source);
        continue;
      }
      if (site.classification === 'mixed-pre-navigation' || site.classification === 'diagnostic' || site.classification === 'conditional-authored') continue;
      expectIdentityBound(call, site.source);
    }
  });

  it('never places occurrence identity inside raw MCP tool arguments', () => {
    for (const site of MUTATING_SITE_MATRIX) {
      const call = callInSection(site);
      expect(rawArgsOf(call), `${site.id} raw argument source`).not.toMatch(IDENTITY_KEY_PATTERN);
    }
  });

  it('persists identity through kernel trails instead of dropping adapter identity fields', () => {
    const kernelTrail = sourceSection('const kernelAppendTrail =', 'const kernelRetryExactFill = async').text;
    expect(kernelTrail).toMatch(/kernelAppendTrail\s*=\s*\(\s*\{[^}]*actionIdentity/s);
    expect(kernelTrail).toMatch(/actionIdentity|ensureTrailActionOccurrence/);
    expect(kernelTrail).toMatch(/actionEvidenceRecorder\.kernelAppendTrail/);
  });

  it('reuses one generic-click occurrence for initial dispatch and semantic retry, including trail rows', async () => {
    const declaration = extractArrowDeclaration(transformedConductorSource, 'const runGenericClickKernelStep = async');
    const dispatchOptions = [];
    const trailInputs = [];
    let allocations = 0;
    const mcp = {
      callTool: vi.fn(async (_session, _tool, args, options) => {
        assertNoIdentityKeys(args, 'generic click raw args');
        dispatchOptions.push(options);
        return { isError: dispatchOptions.length === 1 };
      }),
      textOfContent: () => '',
    };
    const { exported: runGenericClickKernelStep } = evaluateDeclaration(
      declaration.text,
      'runGenericClickKernelStep',
      {
        actionTransactionRepository: {
          loadTransaction: vi.fn(async () => null),
          saveTransaction: vi.fn(async () => ({ persisted: true })),
        },
        approvedSteps: [],
        currentPageUrl: 'https://example.test/form',
        deterministicActionEngine: { actionNarration: () => 'Click Submit' },
        genericClickExecution: {
          executeGenericClick: async ({ dispatch }) => {
            const observation = { snapshotText: '- button "Submit" [ref=old-ref]' };
            await dispatch({ attempt: 1, retry: false, resolution: { ref: 'old-ref' }, observation });
            await dispatch({ attempt: 2, retry: true, resolution: { ref: 'new-ref' }, observation });
            return { handled: true };
          },
        },
        identityForNewActionOccurrence: ({ stepIndex }) => {
          allocations += 1;
          const actionOccurrenceId = `submit:click:${allocations}`;
          const actionIdentity = { contractStepId: 'submit', actionOccurrenceId, sequenceIndex: stepIndex + 1 };
          return { ...actionIdentity, actionIdentity };
        },
        actionDispatchIdentity: (identity, options) => ({ ...options, ...identity, actionIdentity: identity.actionIdentity || identity }),
        kernelAppendTrail: (input) => {
          trailInputs.push(input);
          return {};
        },
        kernelNextStepVerifiesEffect: () => false,
        kernelStepTarget: () => 'Submit',
        lastSnapshotText: '',
        mcp,
        mcpSession: {},
        redactArgs: (args) => args,
        runId: 'run-generic',
        send: () => {},
        startUrl: 'https://example.test/form',
        stepResults: [{}],
        tc: { id: 'tc-generic' },
      },
    );

    await runGenericClickKernelStep({ idx: 0, step: { contractStepId: 'submit', action: 'Click', target: 'Submit' } });

    expect(allocations).toBe(1);
    expect(dispatchOptions).toHaveLength(2);
    expect(dispatchOptions[0].actionOccurrenceId).toBe(dispatchOptions[1].actionOccurrenceId);
    expect(trailInputs).toHaveLength(2);
    expect(trailInputs.map((entry) => entry.actionIdentity.actionOccurrenceId)).toEqual([
      dispatchOptions[0].actionOccurrenceId,
      dispatchOptions[0].actionOccurrenceId,
    ]);
  });

  it('scopes universal identities per authored step while sharing them within retries and event attempts', async () => {
    const generic = extractArrowDeclaration(transformedConductorSource, 'const runGenericClickKernelStep = async');
    const deterministicStart = transformedConductorSource.indexOf('const runDeterministicKernelStep = async', generic.end);
    if (deterministicStart < 0) throw new Error('Missing deterministic kernel after universal adapter');
    const universalAdapter = transformedConductorSource.slice(generic.end, deterministicStart);
    const calls = [];
    const trails = [];
    let capturedHooks = null;
    let allocations = 0;
    const context = {
      actionDispatchIdentity: (identity, options) => ({ ...options, ...identity, actionIdentity: identity.actionIdentity || identity }),
      assertionStateProbe: {},
      currentPageUrl: 'https://example.test/form',
      currentStepIndex: 0,
      downloadWatcher: null,
      executionJournal: { recordAttempt: (rows) => rows },
      identityForNewActionOccurrence: ({ stepIndex, toolName }) => {
        allocations += 1;
        const actionOccurrenceId = `step-${stepIndex + 1}:${toolName}:${allocations}`;
        const actionIdentity = { contractStepId: `step-${stepIndex + 1}`, actionOccurrenceId, sequenceIndex: allocations };
        return { ...actionIdentity, actionIdentity };
      },
      kernelAppendTrail: (input) => {
        trails.push(input);
        return {};
      },
      kernelResolveRef: async () => 'event-ref',
      kernelStepTarget: (step) => step.target || 'Target',
      kernelStepValue: (step) => step.value || step.url,
      lastSnapshotText: '',
      mcp: {
        callTool: vi.fn(async (_session, toolName, args, options) => {
          assertNoIdentityKeys(args, `${toolName} raw args`);
          calls.push({ toolName, args, options });
          return { isError: false };
        }),
        getLastSnapshot: () => '- page',
        textOfContent: () => '',
      },
      mcpBrowserEventAdapters: { createMcpBrowserEventAdapters: () => ({}) },
      mcpSession: {},
      redactArgs: (args) => args,
      runId: 'run-universal',
      send: () => {},
      startUrl: 'https://example.test/form',
      stepResults: [{}, {}],
      tc: { id: 'tc-universal' },
      totalSteps: 2,
      universalActionKernel: {
        actionToken: (step) => String(step.action || '').toLowerCase(),
      },
      waitContract: { buildWaitContract: () => ({}) },
      kernelSeal: () => ({}),
      assertionCheckResults: [],
      conductorUniversalRuntime: {
        createConductorUniversalRuntime: ({ hooks }) => {
          capturedHooks = hooks;
          return {
            run: async ({ step }) => {
              if (step.testMode === 'control') {
                const phase = { toolName: 'browser_click', args: { element: step.target, target: 'control-ref' } };
                await hooks.dispatch({ step, plan: { kind: 'click', target: step.target }, phase, attempt: 1, retry: false });
                await hooks.dispatch({ step, plan: { kind: 'click', target: step.target }, phase, attempt: 2, retry: true });
              } else {
                await hooks.dispatchEvent({ step, eventKind: 'navigation' });
                await hooks.dispatchEvent({ step, eventKind: 'navigation' });
              }
              return { handled: true };
            },
          };
        },
      },
    };
    const sandbox = { ...context, module: { exports: null }, exports: {}, console, setTimeout, clearTimeout };
    vm.runInNewContext(`${universalAdapter}
const runUniversalActionRuntimeStep = async (request) => {
  activeUniversalActionIdentity = null;
  try {
    return await conductorUniversalActionRuntime.run(request);
  } finally {
    activeUniversalActionIdentity = null;
  }
};
module.exports = { conductorUniversalActionRuntime, runUniversalActionRuntimeStep };`, sandbox, {
      filename: 'universal-action-adapter.runtime-contract.js',
    });
    const { runUniversalActionRuntimeStep } = sandbox.module.exports;

    sandbox.currentStepIndex = 0;
    await runUniversalActionRuntimeStep({ idx: 0, step: { testMode: 'control', action: 'Click', target: 'First' } });
    sandbox.currentStepIndex = 1;
    await runUniversalActionRuntimeStep({ idx: 1, step: { testMode: 'event', action: 'Navigate', url: 'https://example.test/next' } });

    expect(capturedHooks).toBeTruthy();
    expect(calls).toHaveLength(4);
    const occurrences = calls.map((call) => call.options.actionOccurrenceId);
    expect(occurrences[0]).toBe(occurrences[1]);
    expect(occurrences[2]).toBe(occurrences[3]);
    expect(occurrences[0]).not.toBe(occurrences[2]);
    expect(allocations).toBe(2);
    expect(trails.map((entry) => entry.actionIdentity.actionOccurrenceId)).toEqual(occurrences);
  });

  it('reuses deterministic identity across initial dispatch, exact retry, and DOM-select recovery', () => {
    const initial = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'deterministic-initial-dispatch'));
    const fillRetry = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'deterministic-exact-fill-retry'));
    const clickRetry = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'deterministic-exact-click-retry'));
    const domSelect = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'deterministic-dom-select'));
    for (const call of [initial, fillRetry, clickRetry, domSelect]) expectIdentityBound(call);

    const fillSection = sourceSection('const kernelRetryExactFill = async', 'const kernelRetryExactClick = async').text;
    const clickSection = sourceSection('const kernelRetryExactClick = async', 'const kernelSeal =').text;
    const selectSection = sourceSection('const deterministicDomSelectByLabel = async', 'const kernelAppendTrail =').text;
    expect(fillSection).toMatch(/actionIdentity/);
    expect(clickSection).toMatch(/actionIdentity/);
    expect(selectSection).toMatch(/actionIdentity/);

    const deterministic = sourceSection('const runDeterministicKernelStep = async', 'const drainDeterministicKernel = async').text;
    expect(deterministic).toMatch(/kernelRetryExactFill\(\{[^}]*actionIdentity/s);
    expect(deterministic).toMatch(/kernelRetryExactClick\(\{[^}]*actionIdentity/s);
    expect(deterministic).toMatch(/deterministicDomSelectByLabel\(\{[^}]*actionIdentity/s);
  });

  it('allocates distinct source-linked child occurrences for every restore mutation', () => {
    const restore = sourceSection('const restoreFillStep = async', 'const currentStateStillHasStep = async').text;
    const sites = MUTATING_SITE_MATRIX.filter((site) => site.id.startsWith('restore-'));
    const optionExpressions = sites.map((site) => {
      const call = callInSection(site);
      expectIdentityBound(call, site.source);
      return identityOptions(call);
    });
    expect(new Set(optionExpressions).size).toBe(4);
    expect((restore.match(/identityForNewActionOccurrence\s*\(/g) || [])).toHaveLength(4);
    expect((restore.match(/sourceActionOccurrenceId/g) || []).length).toBeGreaterThanOrEqual(4);
    expect((restore.match(/sourceContractStepId/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('links generic custom-control child operations to one authored click occurrence', () => {
    const generic = sourceSection('const runGenericClickKernelStep = async', 'const conductorUniversalActionRuntime =').text;
    const sites = MUTATING_SITE_MATRIX.filter((site) => site.id.startsWith('generic-click-option-'));
    expect(sites).toHaveLength(4);
    for (const site of sites) expectIdentityBound(callInSection(site), site.source);
    expect(generic).toMatch(/identityForGenericClickChild/);
    expect(generic).toMatch(/sourceActionOccurrenceId:\s*parentIdentity\.actionOccurrenceId/);
    expect(generic).toMatch(/sourceContractStepId:\s*parentIdentity\.contractStepId/);
  });

  it('uses one occurrence for all optional-dismiss label attempts and persists their trail', () => {
    const optional = sourceSection('const dismissLabels = [', 'Optional prompt "${target}" is visible').text;
    const call = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'optional-prompt-dismiss'));
    expectIdentityBound(call, 'optional_prompt_dismiss');
    expect((optional.match(/identityForNewActionOccurrence\s*\(/g) || [])).toHaveLength(1);
    expect(optional).toMatch(/identityForNewActionOccurrence\s*\(\{[^}]*reuseDeferred\s*:\s*true/s);
    expect(optional).toMatch(/if\s*\(result\?\.isError\)\s*deferActionOccurrence\(optionalDismissIdentity\)/);
    expect(optional).toMatch(/appendActionTrailEntry|kernelAppendTrail/);
    expect(optional).toMatch(/\.\.\.optionalDismissIdentity/);
  });

  it('classifies case-start navigation as authored only when it consumes Navigate step zero', () => {
    const preNav = sourceSection('if (shouldPreNavigate) {', '} else {\n    // Continuation case').text;
    const call = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'case-pre-navigation'));
    expect(preNav).toContain('isNavigateLikeApprovedStep(0)');
    expect(preNav).toMatch(/preNavigationAuthored[\s\S]*toolCanCompleteStep\('browser_navigate',\s*preNavigationStep\)/);
    expect(preNav).toMatch(/preNavigationIdentity[\s\S]*identityForNewActionOccurrence/);
    expectIdentityBound(call);
    expect(identityOptions(call)).toContain('preNavigationIdentity || {}');
    expect(identityOptions(call)).toContain('authored_case_start_navigation');
    expect(identityOptions(call)).toContain('infrastructure_case_start_navigation');
    expect(preNav).toMatch(/const navTrailEntry\s*=\s*\{[\s\S]*\.\.\.\(preNavigationIdentity \|\| \{\}\)/);

    const dispatchHelper = sourceSection('function actionDispatchIdentity', "const waitContract = require('../waitContract');").text;
    expect(dispatchHelper).toMatch(/if\s*\(!actionOccurrenceId\)\s*return\s*\{\s*\.\.\.options,\s*authoredAction:\s*false\s*\}/);

    const continuation = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'continuation-precision-navigation'));
    expectExplicitInfrastructure(continuation, 'continuation_entry_recovery');
  });

  it('reuses the same authored occurrence when memory-first falls back to model dispatch', () => {
    const memory = sourceSection('const tryMemoryFirstReplay = async', 'const deterministicDomFillByLabel = async').text;
    const model = sourceSection('await realignPastPassiveVerification();', 'if (\n        !sequentialContractBlocked').text;
    const occurrenceRuntime = sourceSection('const deferredActionOccurrences = new Map()', 'const ensureTrailActionOccurrence =').text;
    const ensureRuntime = sourceSection('const ensureTrailActionOccurrence =', 'const validateSnapshotSinglePass = async').text;
    expect(occurrenceRuntime).toMatch(/reuseDeferred[\s\S]*deferredActionOccurrences\.has/);
    expect(ensureRuntime).toMatch(/identityForNewActionOccurrence\s*\(\{[\s\S]*reuseDeferred\s*:\s*true/);
    expect(memory).toMatch(/identityForNewActionOccurrence\s*\(\{[^}]*reuseDeferred\s*:\s*true/s);
    expect((memory.match(/deferActionOccurrence\(memoryActionIdentity\)/g) || [])).toHaveLength(2);
    expect(model).toContain('ensureTrailActionOccurrence');
  });

  it('isolates deferred occurrences by case and authored occurrence while preserving exact retry reuse', () => {
    const authoredOccurrence = {
      caseId: 'case-a',
      contractStepId: 'shared-submit-step',
      authoredActionId: 'submit-action-first',
      authoredActionIdSource: 'authored_contract',
      authoredStepIndex: 3,
      toolName: 'browser_click',
    };
    const firstKey = actionOccurrenceReuseKey(authoredOccurrence);
    const exactRetryKey = actionOccurrenceReuseKey({ ...authoredOccurrence });
    const repeatedActionKey = actionOccurrenceReuseKey({
      ...authoredOccurrence,
      authoredActionId: 'submit-action-second',
      authoredStepIndex: 4,
    });
    const otherCaseKey = actionOccurrenceReuseKey({
      ...authoredOccurrence,
      caseId: 'case-b',
    });
    const firstLegacyKey = actionOccurrenceReuseKey({
      caseId: 'legacy-case',
      contractStepId: 'case_step_4',
      authoredActionId: 'case_step_4:action:1',
      authoredActionIdSource: 'allocator_fallback',
      authoredStepIndex: 3,
      toolName: 'browser_click',
    });
    const secondLegacyKey = actionOccurrenceReuseKey({
      caseId: 'legacy-case',
      contractStepId: 'case_step_4',
      authoredActionId: 'case_step_4:action:2',
      authoredActionIdSource: 'allocator_fallback',
      authoredStepIndex: 4,
      toolName: 'browser_click',
    });

    expect(exactRetryKey).toBe(firstKey);
    expect(repeatedActionKey).not.toBe(firstKey);
    expect(otherCaseKey).not.toBe(firstKey);
    expect(secondLegacyKey).not.toBe(firstLegacyKey);

    const deferred = new Map();
    const identity = { actionOccurrenceId: 'shared-submit-step:click:1' };
    deferred.set(firstKey, identity);
    expect(deferred.get(exactRetryKey)).toBe(identity);
    expect(deferred.has(repeatedActionKey)).toBe(false);

    const occurrenceRuntime = sourceSection('const deferredActionOccurrences = new Map()', 'const ensureTrailActionOccurrence =').text;
    expect(occurrenceRuntime).toContain('actionOccurrenceReuseKey({');
    expect(occurrenceRuntime).toContain('caseId: tc.id');
    expect(occurrenceRuntime).toContain('authoredStepIndex: stepIndex');
  });

  it('keeps assertion observations occurrence-free and source-links any mutating probe', () => {
    const mainAlignment = sourceSection('await realignPastPassiveVerification();', 'if (\n        !sequentialContractBlocked').text;
    expect(mainAlignment).toMatch(/isStepMutatingTool[\s\S]*ensureTrailActionOccurrence|ensureTrailActionOccurrence[\s\S]*isStepMutatingTool/);

    const fieldProbe = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'field-blocked-probe'));
    if (MUTATING_CODE_PATTERN.test(fieldProbe.section)) {
      const options = identityOptions(fieldProbe);
      expect(fieldProbe.args.length, fieldProbe.text).toBeGreaterThanOrEqual(4);
      expect(options).toContain('field_blocked_probe');
      expect(options).toMatch(/authoredAction\s*:\s*false/);
      expect(options).toMatch(/assertionLinked\s*:\s*true/);
      expect(options).toMatch(/diagnosticMutation\s*:\s*true/);
      expect(options).toContain('sourceContractStepId');
      expect(options).not.toMatch(/actionDispatchIdentity|actionOccurrenceId|actionIdentity/);
    }

    const universalFocus = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'universal-keyboard-focus'));
    expectIdentityBound(universalFocus, 'universal_keyboard_focus');
    expect(`${universalFocus.section}\n${identityOptions(universalFocus)}`).toMatch(/sourceActionOccurrenceId|sourceContractStepId|activeUniversalActionIdentity/);

    const semanticReveal = callInSection(MUTATING_SITE_MATRIX.find((site) => site.id === 'universal-semantic-target-reveal'));
    expectIdentityBound(semanticReveal, 'semantic_target_reveal_');
    expect(identityOptions(semanticReveal)).toMatch(/authoredAction\s*:\s*false/);
    expect(identityOptions(semanticReveal)).toMatch(/childOperation\s*:\s*true/);
    expect(`${semanticReveal.section}\n${identityOptions(semanticReveal)}`).toContain('activeUniversalActionIdentity');

    for (const anchor of [
      "mcp.callTool(mcpSession, 'assertion_check', assertionInput)",
      "mcp.callTool(mcpSession, 'assertion_check', {",
      "mcp.callTool(mcpSession, 'assertion_check', translation.args)",
    ]) {
      const start = transformedConductorSource.indexOf(anchor);
      expect(start, anchor).toBeGreaterThanOrEqual(0);
      const call = allMcpCalls(transformedConductorSource.slice(start), start)[0];
      expect(identityOptions(call), call.text).not.toMatch(/actionDispatchIdentity|actionOccurrenceId/);
    }
  });
});
