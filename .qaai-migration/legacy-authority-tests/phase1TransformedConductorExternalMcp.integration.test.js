import fs from 'node:fs';
import { Socket } from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');
const recorder = require('../../server/services/actionEvidenceRecorder.js');
const deterministicActionEngine = require('../../server/services/agents/deterministicActionEngine.js');
const executionJournal = require('../../server/services/executionJournal.js');
const pipelineContract = require('../../server/services/pipelineContract.js');
const genericClickExecution = require('../../server/services/genericClickExecution.js');
const actionLocatorResolver = require('../../server/services/actionLocatorResolver.js');
const waitContract = require('../../server/services/waitContract.js');

const conductorPath = path.resolve(process.cwd(), 'server/services/agents/conductor.js');
const transformedConductorSource = fs.readFileSync(conductorPath, 'utf8').replace(/\r\n/g, '\n');

const IDENTITY_KEY_PATTERN = /\b(?:actionIdentity|actionOccurrenceId|authoredActionId|captureBinding|caseId|contractStepId|occurrenceKey|occurrenceOrdinal|runBinding|sequenceIndex|sourceActionOccurrenceId|sourceContractStepId)\b/;

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
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Unbalanced ${open}${close} expression at ${openIndex}`);
}

function extractFunctionDeclaration(source, functionName) {
  const anchor = `function ${functionName}(`;
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`Missing transformed function: ${functionName}`);
  const parameterOpen = source.indexOf('(', start);
  const parameterClose = findBalancedEnd(source, parameterOpen, '(', ')');
  const open = source.indexOf('{', parameterClose);
  const close = findBalancedEnd(source, open, '{', '}');
  return source.slice(start, close + 1);
}

function extractConstDeclaration(source, variableName) {
  const anchor = `const ${variableName} =`;
  const start = source.indexOf(anchor);
  if (start < 0) throw new Error(`Missing transformed declaration: ${variableName}`);
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
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
    else if (char === ';' && round === 0 && square === 0 && curly === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unterminated transformed declaration: ${variableName}`);
}

function createTransformedClickRuntime(context) {
  const functionNames = [
    'normalizeOccurrencePart',
    'operationForTool',
    'actionOccurrenceReuseKey',
    'createActionOccurrenceAllocator',
    'actionDispatchIdentity',
  ];
  const declarationNames = [
    'cloneContractPayload',
    'actionContractNodeForStepIndex',
    'assertionContractNodeForInput',
    'contractMetadataForTool',
    'requireContractMetadataForTool',
    'identityForNewActionOccurrence',
    'kernelStepTarget',
    'kernelNextStepVerifiesEffect',
    'kernelAppendTrail',
    'runGenericClickKernelStep',
  ];
  const productionSource = [
    ...functionNames.map((name) => extractFunctionDeclaration(transformedConductorSource, name)),
    ...declarationNames.slice(0, 5).map((name) => extractConstDeclaration(transformedConductorSource, name)),
    extractConstDeclaration(transformedConductorSource, 'allocateActionOccurrence'),
    extractConstDeclaration(transformedConductorSource, 'deferredActionOccurrences'),
    ...declarationNames.slice(5).map((name) => extractConstDeclaration(transformedConductorSource, name)),
    'module.exports = { runGenericClickKernelStep };',
  ].join('\n\n');

  const sandbox = {
    ...context,
    module: { exports: null },
    exports: {},
    console,
    Date,
    Map,
    Math,
    RegExp,
    Set,
    String,
    clearTimeout,
    setTimeout,
  };
  try {
    vm.runInNewContext(productionSource, sandbox, {
      filename: 'phase1-transformed-conductor-external-mcp.runtime.js',
    });
  } catch (error) {
    const lineMatch = String(error?.stack || '').match(/phase1-transformed-conductor-external-mcp\.runtime\.js:(\d+)/);
    const line = lineMatch ? Number(lineMatch[1]) : null;
    const lines = productionSource.split('\n');
    const excerpt = line
      ? lines.slice(Math.max(0, line - 4), Math.min(lines.length, line + 3))
        .map((text, index) => `${Math.max(1, line - 3) + index}: ${text}`)
        .join('\n')
      : 'runtime source line unavailable';
    throw new Error(`Transformed runtime compilation failed: ${error?.message || error}\n${excerpt}`);
  }
  return { ...sandbox.module.exports, sandbox, productionSource };
}

function realSnapshotRef(snapshotText, accessibleName) {
  const escaped = String(accessibleName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(snapshotText || '').match(new RegExp(`button\\s+["']${escaped}["'][^\\n]*\\[ref=([^\\s\\]]+)`, 'i'));
  return match ? match[1] : null;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

async function endpointIsReachable(endpoint) {
  if (!endpoint) return false;
  const parsed = new URL(endpoint);
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(reachable);
    };
    const timer = setTimeout(() => finish(false), 750);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.connect(Number(parsed.port), parsed.hostname);
  });
}

async function waitUntil(predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}

describe('Phase 1 transformed Conductor to external MCP acceptance', () => {
  it('compiles the exact transformed occurrence and click declarations', () => {
    const runtime = createTransformedClickRuntime({
      tc: { id: 'phase1-transformed-runtime-compile' },
    });
    expect(runtime.runGenericClickKernelStep).toBeTypeOf('function');
    expect(runtime.productionSource).toContain('actionDispatchIdentity(authoredClickIdentity');
  });

  it('preserves one authored action identity through the real click, CDP binding, trail, and recorder', async () => {
    const startedAt = Date.now();
    const previousEnvironment = {
      QAAI_MCP_HEADLESS: process.env.QAAI_MCP_HEADLESS,
      QAAI_MCP_NO_SANDBOX: process.env.QAAI_MCP_NO_SANDBOX,
      QAAI_STRICT_ACTION_EVIDENCE: process.env.QAAI_STRICT_ACTION_EVIDENCE,
    };
    process.env.QAAI_MCP_HEADLESS = '1';
    process.env.QAAI_MCP_NO_SANDBOX = '1';
    process.env.QAAI_STRICT_ACTION_EVIDENCE = '1';

    const broadcasts = [];
    const dispatches = [];
    const snapshots = [];
    const actionTrail = [];
    let stage = 'session_start';
    let session = null;
    let stoppedPid = null;
    let stoppedEndpoint = null;
    let captureDebug = null;
    let runtimeOutcome = null;
    let resolverDiagnostics = [];
    try {
      session = await mcp.startMcpSession({
        userId: 'phase1-transformed-conductor-external-mcp',
        viewport: { width: 960, height: 640 },
        extraCaps: [],
        broadcast: (entry) => broadcasts.push(entry),
      });
      expect(session.subprocessPid).toBeGreaterThan(0);
      expect(session.liveCdp?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(await endpointIsReachable(session.liveCdp.endpoint)).toBe(true);
      const liveClickTool = session.mcpTools.find((tool) => tool.name === 'browser_click');
      expect(liveClickTool?.inputSchema?.required).toContain('target');

      const ownerPage = mcp.livePlaywrightPageForSession(session);
      expect(ownerPage).toBeTruthy();
      await ownerPage.setContent(`
        <button data-testid="transformed-conductor-action" type="button">Transformed conductor action</button>
        <output id="transformed-conductor-result">not-clicked</output>
        <script>
          document.querySelector('[data-testid="transformed-conductor-action"]').addEventListener('click', () => {
            document.querySelector('#transformed-conductor-result').textContent = 'clicked';
          });
        </script>
      `, { waitUntil: 'domcontentloaded' });

      const runtimeMcp = {
        ...mcp,
        snapshot: async (...args) => {
          const result = await mcp.snapshot(...args);
          snapshots.push(result);
          return result;
        },
        callTool: async (mcpSession, toolName, args, options) => {
          dispatches.push({
            toolName,
            args: JSON.parse(JSON.stringify(args)),
            options: JSON.parse(JSON.stringify(options || {})),
          });
          const result = await mcp.callTool(mcpSession, toolName, args, options);
          dispatches[dispatches.length - 1].result = result;
          return result;
        },
      };

      const contractStepId = 'phase1-integrated:step:1';
      const step = {
        contractStepId,
        action: 'Click',
        target: 'Transformed conductor action',
      };
      const executionContract = {
        schema: 'qaai-execution-contract-v1',
        contractId: 'phase1-transformed-conductor-contract',
        nodes: [{
          kind: 'action',
          stepOrdinal: 1,
          contractStepId,
          actionType: 'Click',
          methodName: 'browser_click',
          dataBinding: { isDataBound: false },
        }],
      };
      const stepResults = [{
        stepId: contractStepId,
        index: 1,
        status: 'pending',
        operationCheck: null,
      }];
      const identityAcceptanceSeal = ({ idx, proposedStatus, error, toolName }) => {
        const reduced = {
          idx,
          status: proposedStatus,
          error: proposedStatus === 'pass' ? null : error,
          advance: proposedStatus === 'pass',
          toolName,
        };
        Object.assign(stepResults[idx], reduced);
        return reduced;
      };

      stage = 'transformed_runtime';
      const durableTransactions = new Map();
      resolverDiagnostics = [];
      const runtimeActionLocatorResolver = {
        ...actionLocatorResolver,
        resolveVerifiedForTool: async (request) => {
          try {
            const result = await actionLocatorResolver.resolveVerifiedForTool(request);
            resolverDiagnostics.push({
              ok: result?.ok === true,
              reason: result?.reason || result?.diagnostic?.reason || null,
              source: result?.actionLocator?.verificationSource || result?.actionLocator?.evidenceSource || null,
              verified: actionLocatorResolver.isVerifiedActionLocator(result?.actionLocator),
            });
            return result;
          } catch (error) {
            resolverDiagnostics.push({ ok: false, reason: error?.message || String(error) });
            throw error;
          }
        },
      };
      const actionTransactionRepository = {
        loadTransaction: async (identity) => durableTransactions.get(JSON.stringify(identity)) || null,
        saveTransaction: async (identity, transaction) => {
          durableTransactions.set(JSON.stringify(identity), JSON.parse(JSON.stringify(transaction)));
          return { persisted: true };
        },
      };
      const runtime = createTransformedClickRuntime({
        actionTransactionRepository,
        actionEvidenceRecorder: recorder,
        actionLocatorResolver: runtimeActionLocatorResolver,
        actionTrail,
        approvedSteps: [step],
        currentPageUrl: ownerPage.url(),
        currentStepIndex: 0,
        dataRow: null,
        deterministicActionEngine,
        executionJournal,
        executionContract,
        genericClickExecution,
        inferDataBindingFromArgs: () => ({ isDataBound: false }),
        lastSnapshotText: '',
        kernelSeal: identityAcceptanceSeal,
        mcp: runtimeMcp,
        mcpSession: session,
        pipelineContract,
        redactArgs: (args) => args,
        runId: 'phase1-transformed-conductor-run',
        send: () => {},
        startUrl: ownerPage.url(),
        stepResults,
        tc: { id: 'phase1-transformed-conductor-case', name: 'Transformed Conductor external MCP click' },
        totalSteps: 1,
        waitContract,
      });
      expect(runtime.productionSource).toContain('const runGenericClickKernelStep = async');
      expect(runtime.productionSource).toContain('actionDispatchIdentity(authoredClickIdentity');

      const outcome = await runtime.runGenericClickKernelStep({ idx: 0, step });
      runtimeOutcome = outcome;
      expect(outcome).toMatchObject({ handled: true });
      expect(await ownerPage.locator('#transformed-conductor-result').textContent()).toBe('clicked');

      stage = 'dispatch_identity';
      const clickDispatches = dispatches.filter((entry) => entry.toolName === 'browser_click');
      expect(clickDispatches.length).toBeGreaterThanOrEqual(1);
      expect(clickDispatches.length).toBeLessThanOrEqual(2);
      const snapshotRefs = [...new Set(snapshots
        .map((entry) => realSnapshotRef(entry?.text, step.target))
        .filter(Boolean))];
      expect(snapshotRefs.length).toBeGreaterThan(0);
      for (const attempted of clickDispatches) {
        expect(JSON.stringify(attempted.args)).not.toMatch(IDENTITY_KEY_PATTERN);
        expect(attempted.args).toMatchObject({ element: 'Transformed conductor action' });
        expect(snapshotRefs).toContain(attempted.args.target);
      }
      const dispatch = clickDispatches[clickDispatches.length - 1];
      const snapshotRef = dispatch.args.target;

      const identity = clickDispatches[0].options.actionIdentity;
      expect(identity).toMatchObject({
        caseId: 'phase1-transformed-conductor-case',
        contractStepId,
        actionOccurrenceId: expect.any(String),
        authoredActionId: expect.any(String),
        occurrenceOrdinal: 1,
        sequenceIndex: 1,
        toolName: 'browser_click',
        operation: 'click',
      });
      for (const attempted of clickDispatches) {
        expect(attempted.options.actionIdentity).toMatchObject(identity);
        expect(attempted.options.runBinding).toMatchObject(identity);
        expect(attempted.options.captureBinding).toMatchObject(identity);
      }
      expect(new Set(clickDispatches.map((entry) => entry.options.actionOccurrenceId)).size).toBe(1);
      expect(clickDispatches[0].options.source).toBe('generic_click_initial_dispatch');
      if (clickDispatches.length === 2) {
        expect(clickDispatches[1].options.source).toBe('generic_click_exact_retry');
      }

      stage = 'trail_and_cdp';
      expect(actionTrail).toHaveLength(clickDispatches.length);
      for (const attemptedTrail of actionTrail) {
        expect(attemptedTrail).toMatchObject({
          contractStepId,
          actionOccurrenceId: identity.actionOccurrenceId,
          authoredActionId: identity.authoredActionId,
          actionIdentity: {
            contractStepId,
            actionOccurrenceId: identity.actionOccurrenceId,
            authoredActionId: identity.authoredActionId,
          },
        });
      }
      if (actionTrail.length === 2) {
        expect(actionTrail[1].kernelRecovery).toMatchObject({
          strategy: 'fresh_observation_semantic_reresolve',
          attempt: 2,
        });
      }
      const trailEntry = actionTrail[actionTrail.length - 1];

      const result = dispatch.result;
      expect(result?.isError).not.toBe(true);
      const pre = result.qaaiActionLocator?.context?.authoritativeCdp?.pre;
      const post = result.qaaiActionLocator?.context?.authoritativeCdp?.post;
      captureDebug = {
        pre: pre ? {
          captured: pre.captured,
          authoritative: pre.authoritative,
          source: pre.source,
          identity: pre.identity,
          captureBinding: pre.captureBinding,
        } : null,
        post: post ? {
          captured: post.captured,
          authoritative: post.authoritative,
          source: post.source,
          identity: post.identity,
          captureBinding: post.captureBinding,
        } : null,
      };
      stage = 'pre_cdp_capture';
      expect(pre).toMatchObject({
        captured: true,
        authoritative: true,
        source: 'chromium_cdp',
        identity: { backendNodeId: expect.any(Number), connected: true },
        captureBinding: {
          kind: 'mcp_bound_ref',
          phase: 'pre_action',
          status: 'bound',
          ref: snapshotRef,
          backendNodeId: expect.any(Number),
          contractStepId,
          actionOccurrenceId: identity.actionOccurrenceId,
          authoredActionId: identity.authoredActionId,
        },
      });
      stage = 'post_cdp_capture';
      expect(post).toMatchObject({
        captured: true,
        authoritative: true,
        source: 'chromium_cdp',
        identity: { backendNodeId: pre.identity.backendNodeId, connected: true },
        captureBinding: {
          kind: 'mcp_bound_ref',
          phase: 'post_action',
          status: 'bound',
          ref: snapshotRef,
          backendNodeId: pre.identity.backendNodeId,
          contractStepId,
          actionOccurrenceId: identity.actionOccurrenceId,
          authoredActionId: identity.authoredActionId,
        },
      });

      const runtimeEvidence = mcp.captureRuntimeEvidence(session);
      const binding = runtimeEvidence.runBindings.find((entry) => (
        entry.actionOccurrenceId === identity.actionOccurrenceId
        && entry.backendNodeId === pre.identity.backendNodeId
      ));
      expect(binding).toMatchObject({
        sessionId: session.id,
        phase: 'pre_action',
        ref: snapshotRef,
        backendNodeId: pre.identity.backendNodeId,
        status: 'bound',
        contractStepId,
        actionOccurrenceId: identity.actionOccurrenceId,
        authoredActionId: identity.authoredActionId,
      });
      const postBinding = runtimeEvidence.runBindings.find((entry) => (
        entry.phase === 'post_action'
        && entry.actionOccurrenceId === identity.actionOccurrenceId
        && entry.backendNodeId === pre.identity.backendNodeId
      ));
      expect(postBinding).toMatchObject({
        sessionId: session.id,
        phase: 'post_action',
        ref: snapshotRef,
        backendNodeId: pre.identity.backendNodeId,
        status: 'bound',
        caseId: identity.caseId,
        contractStepId,
        actionOccurrenceId: identity.actionOccurrenceId,
        authoredActionId: identity.authoredActionId,
        sequenceIndex: identity.sequenceIndex,
      });

      stage = 'recorder';
      const built = recorder.recordExecutableAction({
        runResultId: 'phase1-transformed-conductor-result',
        testCase: { id: 'phase1-transformed-conductor-case', name: 'Transformed Conductor external MCP click' },
        status: 'pass',
        trailEntry,
        result,
        executionContract,
      });
      expect(built.locatorRecipes).toHaveLength(1);
      expect(built.actionEvidences).toHaveLength(1);
      expect(built.locatorRecipes[0].contractStepId).toBe(contractStepId);
      const persistedLocatorRecipe = JSON.parse(built.locatorRecipes[0].locatorRecipeJson);
      expect(persistedLocatorRecipe).toMatchObject({
        actionIdentity: {
          actionOccurrenceId: identity.actionOccurrenceId,
          authoredActionId: identity.authoredActionId,
        },
        captureEvidence: {
          backendNodeId: pre.identity.backendNodeId,
        },
      });
      expect(built.actionEvidences[0]).toMatchObject({
        contractStepId,
        locatorRecipeId: built.locatorRecipes[0].id,
      });
      const persistedEvidence = JSON.parse(built.actionEvidences[0].evidenceJson);
      expect(persistedEvidence.authoredIdentity).toMatchObject({
        caseId: identity.caseId,
        contractStepId,
        actionOccurrenceId: identity.actionOccurrenceId,
        authoredActionId: identity.authoredActionId,
      });

      stage = 'cleanup';
      stoppedPid = session.subprocessPid;
      stoppedEndpoint = session.liveCdp.endpoint;
      await mcp.stopMcpSession(session);
      session = null;
      expect(await waitUntil(() => !processIsAlive(stoppedPid))).toBe(true);
      expect(await waitUntil(async () => !(await endpointIsReachable(stoppedEndpoint)))).toBe(true);

      console.info(JSON.stringify({
        phase1TransformedConductorExternalMcp: 'passed',
        actionOccurrenceId: identity.actionOccurrenceId,
        backendNodeId: pre.identity.backendNodeId,
        snapshotRef,
        subprocessStopped: !processIsAlive(stoppedPid),
        cdpEndpointStopped: !(await endpointIsReachable(stoppedEndpoint)),
        elapsedMs: Date.now() - startedAt,
      }));
    } catch (error) {
      const stderr = broadcasts
        .filter((entry) => String(entry?.message || '').includes('[mcp.stderr]'))
        .map((entry) => entry.message)
        .join(' | ')
        .slice(0, 2_000);
      const dispatchDebug = dispatches.slice(-4).map((entry) => ({
        toolName: entry.toolName,
        source: entry.options?.source || null,
        targetStatus: entry.options?.targetAuthorization?.status || null,
        isError: entry.result?.isError === true,
        resultText: mcp.textOfContent(entry.result?.content).slice(0, 300),
      }));
      const trailDebug = actionTrail.slice(-4).map((entry) => ({
        tool: entry.tool,
        ok: entry.ok,
        error: entry.error || null,
        resultText: mcp.textOfContent(entry.result?.content).slice(0, 300),
      }));
      throw new Error([
        `transformed_conductor_external_mcp_stage=${stage}`,
        `elapsed_ms=${Date.now() - startedAt}`,
        `subprocess_pid=${session?.subprocessPid || stoppedPid || 'not_started'}`,
        `live_cdp=${session?.liveCdp?.endpoint || stoppedEndpoint || 'not_connected'}`,
        `error=${error?.message || error}`,
        captureDebug ? `capture=${JSON.stringify(captureDebug)}` : null,
        runtimeOutcome ? `outcome=${JSON.stringify(runtimeOutcome)}` : null,
        resolverDiagnostics.length ? `resolver=${JSON.stringify(resolverDiagnostics)}` : null,
        dispatchDebug.length ? `dispatches=${JSON.stringify(dispatchDebug)}` : null,
        trailDebug.length ? `trail=${JSON.stringify(trailDebug)}` : null,
        stderr ? `stderr=${stderr}` : null,
      ].filter(Boolean).join('; '));
    } finally {
      if (session) {
        stoppedPid = session.subprocessPid;
        stoppedEndpoint = session.liveCdp?.endpoint || null;
        await mcp.stopMcpSession(session);
        session = null;
      }
      if (stoppedPid) await waitUntil(() => !processIsAlive(stoppedPid));
      if (stoppedEndpoint) await waitUntil(async () => !(await endpointIsReachable(stoppedEndpoint)));
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 150_000);
});
