import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');
const recorder = require('../../server/services/actionEvidenceRecorder.js');

function sessionWithRequiredTarget(toolName = 'browser_click') {
  return {
    lastSnapshot: '- button "External bridge action" [ref=e2]',
    mcpTools: [{
      name: toolName,
      inputSchema: {
        type: 'object',
        properties: {
          element: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['target'],
      },
    }],
  };
}

function realSnapshotRef(snapshotText, accessibleName) {
  const escaped = String(accessibleName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(snapshotText || '').match(new RegExp(`button\\s+["']${escaped}["'][^\\n]*\\[ref=([^\\s\\]]+)`, 'i'));
  return match ? match[1] : null;
}

describe('Phase 1 external @playwright/mcp bridge acceptance', () => {
  it('adapts exact snapshot refs to the installed required-target transport schema', () => {
    const session = sessionWithRequiredTarget();

    expect(mcp.normaliseToolArgs('browser_click', {
      ref: 'e2',
      element: 'External bridge action',
    }, session)).toEqual({
      args: {
        ref: 'e2',
        target: 'e2',
        element: 'External bridge action',
      },
      notes: ['browser_click target: required-schema-exact-ref'],
    });

    expect(mcp.normaliseToolArgs('browser_click', {
      ref: 'f3e27',
      element: 'Framed action',
    }, session).args).toMatchObject({ ref: 'f3e27', target: 'f3e27' });
  });

  it('never promotes narration, loose refs, or non-required schemas into target', () => {
    const required = sessionWithRequiredTarget();
    const optional = sessionWithRequiredTarget();
    optional.mcpTools[0].inputSchema.required = [];

    expect(mcp.normaliseToolArgs('browser_click', {
      element: 'External bridge action',
    }, required).args).not.toHaveProperty('target');
    expect(mcp.normaliseToolArgs('browser_click', {
      ref: 'External bridge action',
      element: 'External bridge action',
    }, required).args).not.toHaveProperty('target');
    expect(mcp.normaliseToolArgs('browser_click', {
      ref: 'e2',
      element: 'External bridge action',
    }, optional).args).not.toHaveProperty('target');
  });

  it('preserves an authored target and restores normalized ref syntax as an exact target', () => {
    const session = sessionWithRequiredTarget();

    expect(mcp.normaliseToolArgs('browser_click', {
      target: '#explicit-selector',
      ref: 'e2',
      element: 'External bridge action',
    }, session)).toEqual({
      args: {
        target: '#explicit-selector',
        ref: 'e2',
        element: 'External bridge action',
      },
      notes: [],
    });

    expect(mcp.normaliseToolArgs('browser_click', {
      target: '[ref=e2]',
      element: 'External bridge action',
    }, session)).toEqual({
      args: {
        ref: 'e2',
        target: 'e2',
        element: 'External bridge action',
      },
      notes: [
        'browser_click target: ref-bracket',
        'browser_click target: required-schema-exact-ref',
      ],
    });
  });

  it('carries only supplied authored occurrence identity into action evidence', () => {
    expect(mcp._actionEvidenceIdentity({
      contractStepId: 'args-step',
      actionOccurrenceId: 'args-occurrence',
    }, {
      actionIdentity: {
        schemaVersion: 'qaai-action-identity-v1',
        caseId: 'authored-case',
        contractStepId: 'authored-step',
        sourceContractStepId: 'source-step',
        authoredActionId: 'authored-action',
        actionOccurrenceId: 'authored-occurrence',
        sourceActionOccurrenceId: 'source-occurrence',
        sequenceIndex: 7,
      },
    })).toEqual({
      schemaVersion: 'qaai-action-identity-v1',
      caseId: 'authored-case',
      contractStepId: 'authored-step',
      sourceContractStepId: 'source-step',
      authoredActionId: 'authored-action',
      actionOccurrenceId: 'authored-occurrence',
      sourceActionOccurrenceId: 'source-occurrence',
      sequenceIndex: 7,
    });
    expect(mcp._actionEvidenceIdentity({
      contractStepId: 'forged-step',
      actionOccurrenceId: 'forged-occurrence',
      actionIdentity: {
        caseId: 'forged-case',
        authoredActionId: 'forged-action',
      },
    }, {})).toEqual({});
    expect(mcp._actionEvidenceIdentity({}, {})).toEqual({});
  });

  it('retains authored identity on post gaps without falsely binding removed or replacement nodes', () => {
    const identity = {
      schemaVersion: 'qaai-action-identity-v1',
      caseId: 'post-state-case',
      contractStepId: 'post-state-step',
      authoredActionId: 'post-state-action',
      actionOccurrenceId: 'post-state-occurrence',
      sequenceIndex: 3,
    };
    const pre = {
      captured: true,
      phase: 'pre_action',
      pageIdentity: { pageId: 'page-post-state', url: 'https://example.test/action' },
      identity: { backendNodeId: 77, connected: true },
      captureBinding: {
        kind: 'mcp_bound_ref',
        sessionId: 'post-state-session',
        phase: 'pre_action',
        ref: 'e77',
        pageId: 'page-post-state',
        backendNodeId: 77,
        status: 'bound',
        ...identity,
      },
    };
    const newSession = () => ({
      id: 'post-state-session',
      captureRuntime: {
        sessionId: 'post-state-session',
        bindingAttempts: [],
        runBindings: [],
      },
    });

    const removedSession = newSession();
    const removed = mcp._bindAuthoritativePostCapture(removedSession, pre, {
      captured: true,
      phase: 'post_action',
      presentInSnapshot: false,
      sameBackendNode: false,
      removed: true,
      pageIdentity: { ...pre.pageIdentity },
      identity: { backendNodeId: 77, connected: false },
    });
    expect(removed.captureBinding).toMatchObject({
      phase: 'post_action',
      status: 'not_bound',
      reason: 'acted_node_removed',
      ref: 'e77',
      ...identity,
    });
    expect(removedSession.captureRuntime.runBindings).toHaveLength(0);

    const closedSession = newSession();
    const closed = mcp._bindAuthoritativePostCapture(
      closedSession,
      pre,
      mcp._authoritativePostGap(pre, 'page_closed'),
    );
    expect(closed.captureBinding).toMatchObject({
      phase: 'post_action',
      status: 'not_bound',
      reason: 'page_closed',
      ref: 'e77',
      ...identity,
    });
    expect(closedSession.captureRuntime.runBindings).toHaveLength(0);

    const replacementSession = newSession();
    const replacement = mcp._bindAuthoritativePostCapture(replacementSession, pre, {
      captured: true,
      phase: 'post_action',
      presentInSnapshot: true,
      sameBackendNode: false,
      removed: false,
      replacement: { resolved: true, backendNodeId: 88 },
      pageIdentity: { ...pre.pageIdentity },
      identity: { backendNodeId: 88, connected: true },
    });
    expect(replacement.captureBinding).toMatchObject({
      phase: 'post_action',
      status: 'observed_replacement',
      reason: 'replacement_observed',
      ...identity,
    });
    expect(replacementSession.captureRuntime.runBindings).toHaveLength(0);

    const boundSession = newSession();
    const bound = mcp._bindAuthoritativePostCapture(boundSession, pre, {
      captured: true,
      phase: 'post_action',
      presentInSnapshot: true,
      sameBackendNode: true,
      removed: false,
      pageIdentity: { ...pre.pageIdentity },
      identity: { backendNodeId: 77, connected: true },
    });
    expect(bound.captureBinding).toMatchObject({
      phase: 'post_action',
      status: 'bound',
      ref: 'e77',
      backendNodeId: 77,
      ...identity,
    });
    expect(boundSession.captureRuntime.runBindings).toHaveLength(1);
  });

  it('binds a real MCP snapshot ref to the owner CDP node and persists executable evidence', async () => {
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
    let stage = 'session_start';
    let session = null;
    try {
      session = await mcp.startMcpSession({
        userId: 'phase1-external-mcp-bridge',
        viewport: { width: 960, height: 640 },
        extraCaps: [],
        broadcast: (entry) => broadcasts.push(entry),
      });
      stage = 'session_started';
      expect(session.subprocessPid).toBeGreaterThan(0);
      expect(session.liveCdp?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(session.mcpTools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        'browser_snapshot',
        'browser_click',
        'browser_evaluate',
      ]));

      const ownerPage = mcp.livePlaywrightPageForSession(session);
      expect(ownerPage).toBeTruthy();
      await ownerPage.setContent(`
        <button data-testid="external-bridge-action" type="button">External bridge action</button>
        <output id="bridge-result">not-clicked</output>
        <script>
          document.querySelector('[data-testid="external-bridge-action"]').addEventListener('click', () => {
            document.querySelector('#bridge-result').textContent = 'clicked';
          });
        </script>
      `, { waitUntil: 'domcontentloaded' });

      stage = 'snapshot_ref';
      const snapshot = await mcp.snapshot(session, {
        timeoutMs: 30_000,
        source: 'phase1_external_bridge_snapshot',
      });
      expect(snapshot.error).toBeNull();
      const ref = realSnapshotRef(snapshot.text, 'External bridge action');
      expect(ref).toBeTruthy();

      stage = 'real_tool_action';
      const contractStepId = 'external-bridge:step:1';
      const actionOccurrenceId = 'external-bridge:step:1:click:1';
      const result = await mcp.callTool(session, 'browser_click', {
        ref,
        element: 'External bridge action',
      }, {
        timeoutMs: 45_000,
        source: 'phase1_external_bridge_action',
        actionIdentity: { contractStepId, actionOccurrenceId },
      });
      if (result?.isError === true) {
        throw new Error([
          `real_mcp_action_error=${mcp.textOfContent(result.content) || 'unknown MCP action error'}`,
          result.qaaiPreDispatchRejection
            ? `pre_dispatch=${JSON.stringify(result.qaaiPreDispatchRejection)}`
            : null,
          result.actionLocatorGap ? `locator_gap=${JSON.stringify(result.actionLocatorGap)}` : null,
        ].filter(Boolean).join('; '));
      }
      expect(await ownerPage.locator('#bridge-result').textContent()).toBe('clicked');

      const pre = result.qaaiActionLocator?.context?.authoritativeCdp?.pre;
      expect(pre).toMatchObject({
        captured: true,
        authoritative: true,
        source: 'chromium_cdp',
        captureBinding: { kind: 'mcp_bound_ref', ref },
        identity: { backendNodeId: expect.any(Number), connected: true },
      });
      expect(pre.identity.backendNodeId).toBeGreaterThan(0);

      stage = 'runtime_binding';
      const runtimeEvidence = mcp.captureRuntimeEvidence(session);
      expect(runtimeEvidence).toMatchObject({
        current: true,
        liveCdpEnabled: true,
        mcpSubprocessPid: session.subprocessPid,
      });
      const binding = runtimeEvidence.runBindings.find((entry) => (
        entry.ref === ref && entry.backendNodeId === pre.identity.backendNodeId
      ));
      expect(binding).toMatchObject({
        sessionId: session.id,
        phase: 'pre_action',
        ref,
        pageId: pre.pageIdentity.pageId,
        backendNodeId: pre.identity.backendNodeId,
        status: 'bound',
        contractStepId,
        actionOccurrenceId,
      });

      stage = 'recorder';
      const built = recorder.recordExecutableAction({
        runResultId: 'phase1-external-mcp-bridge-result',
        testCase: { id: 'phase1-external-mcp-bridge-case', name: 'External MCP bridge action' },
        status: 'pass',
        trailEntry: {
          tool: 'browser_click',
          toolUseId: 'phase1-external-mcp-bridge-tool',
          contractStepId,
          actionOccurrenceId,
          args: { ref, element: 'External bridge action' },
          pageUrl: ownerPage.url(),
        },
        result,
      });
      expect(built.locatorRecipes).toHaveLength(1);
      expect(built.actionEvidences).toHaveLength(1);
      expect(built.actionEvidences[0]).toMatchObject({
        contractStepId,
        locatorRecipeId: built.locatorRecipes[0].id,
      });

      console.info(JSON.stringify({
        phase1ExternalMcpBridge: 'passed',
        subprocessPid: session.subprocessPid,
        liveCdpEndpoint: session.liveCdp.endpoint,
        ref,
        backendNodeId: pre.identity.backendNodeId,
        runBindingCount: runtimeEvidence.runBindings.length,
        elapsedMs: Date.now() - startedAt,
      }));
    } catch (error) {
      const stderr = broadcasts
        .filter((entry) => String(entry?.message || '').includes('[mcp.stderr]'))
        .map((entry) => entry.message)
        .join(' | ')
        .slice(0, 2_000);
      throw new Error([
        `external_mcp_bridge_stage=${stage}`,
        `elapsed_ms=${Date.now() - startedAt}`,
        `subprocess_pid=${session?.subprocessPid || 'not_started'}`,
        `live_cdp=${session?.liveCdp?.endpoint || 'not_connected'}`,
        `error=${error?.message || error}`,
        stderr ? `stderr=${stderr}` : null,
      ].filter(Boolean).join('; '));
    } finally {
      if (session) await mcp.stopMcpSession(session);
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }, 150_000);
});
