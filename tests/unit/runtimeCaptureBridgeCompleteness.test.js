import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mcp = require('../../server/services/mcp.js');
const recorder = require('../../server/services/actionEvidenceRecorder.js');

function authoritativeLocator() {
  const targetIdentity = {
    scheme: 'qaai-cdp-backend-node-v1',
    backendNodeId: 481,
    frameId: 'frame-main',
    documentUrl: 'https://example.test/login',
    connected: true,
  };
  const postIdentity = { ...targetIdentity, connected: true };
  const pre = {
    schema: 'qaai-authoritative-cdp-capture-v1',
    captured: true,
    authoritative: true,
    source: 'chromium_cdp',
    phase: 'pre_action',
    identity: targetIdentity,
    framePath: [],
    shadowPath: [{ selector: 'auth-shell' }],
    framePathSelectors: [],
    pageIdentity: { pageId: 'page-1', url: targetIdentity.documentUrl },
    frameIdentity: { url: targetIdentity.documentUrl, isMainFrame: true },
    captureBinding: { kind: 'mcp_bound_ref', ref: 'e16' },
  };
  const post = {
    ...pre,
    phase: 'post_action',
    identity: postIdentity,
  };
  return {
    strategy: 'role',
    expression: 'getByRole("textbox", { name: "Email Address", exact: true })',
    frameworkExpressions: { playwright: 'getByRole("textbox", { name: "Email Address", exact: true })' },
    verificationSource: 'authoritative_chromium_cdp',
    verified: true,
    contractStepId: 'tc-login:step:2',
    targetIdentity,
    targetFacts: { role: 'textbox', accessibleName: 'Email Address', cdpBackendNodeId: 481 },
    domAtlas: {
      verifiedActions: [{ strategy: 'role', expression: 'getByRole("textbox", { name: "Email Address", exact: true })' }],
    },
    context: {
      authoritativeCdp: { pre, post },
      captureBinding: pre.captureBinding,
      shadowPath: ['auth-shell'],
      popupIdentity: { id: 'tab-current', alias: 'primary' },
    },
    proof: {
      verified: true,
      count: 1,
      sameElement: true,
      actionTimeResolved: true,
      resolutionMode: 'authoritative_cdp_backend_node',
      identityVerified: true,
      backendNodeVerified: true,
      authoritativeCdpVerified: true,
      stableAcrossSnapshots: true,
      countBefore: 1,
      countAfter: 1,
      sameElementAcrossSnapshots: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      source: 'authoritative_chromium_cdp',
    },
  };
}

describe('runtime capture bridge completeness', () => {
  it('does not allow memory or live-ref fast paths to bypass locator evidence', () => {
    expect(mcp._strictActionEvidenceEnabled({}, { strictActionEvidence: false, source: 'memory_fast_path' }, 'browser_click')).toBe(true);
    expect(mcp._strictActionEvidenceEnabled({}, { strictActionEvidence: false }, 'browser_fill_form')).toBe(true);
    expect(mcp._strictActionEvidenceEnabled({}, { strictActionEvidence: false }, 'browser_hover')).toBe(true);
    expect(mcp._strictActionEvidenceEnabled({}, { strictActionEvidence: false }, 'browser_snapshot')).toBe(false);
  });

  it('detects stale capture runtimes without blocking action dispatch', () => {
    const current = mcp.captureRuntimeDescriptor({ sessionId: 'session-current' });
    expect(mcp.inspectCaptureRuntime({ captureRuntime: current, subprocessPid: null })).toMatchObject({ current: true, stale: false });
    const stale = { ...current, buildFingerprint: 'old-build' };
    expect(mcp.inspectCaptureRuntime({ captureRuntime: stale })).toMatchObject({
      current: false,
      stale: true,
      reasons: expect.arrayContaining(['capture_build_fingerprint_mismatch']),
    });
  });

  it('persists authoritative backend-node, context, and pre/post identity', () => {
    const runtime = mcp.captureRuntimeEvidence({ captureRuntime: mcp.captureRuntimeDescriptor(), subprocessPid: null });
    const built = recorder.recordExecutableAction({
      runResultId: 'rr-runtime-capture',
      testCase: { id: 'tc-login', name: 'Login' },
      status: 'pass',
      trailEntry: {
        tool: 'browser_type',
        contractStepId: 'tc-login:step:2',
        args: { element: 'Email Address', ref: 'e16', text: 'user@example.test' },
      },
      result: {
        isError: false,
        qaaiActionLocator: authoritativeLocator(),
        qaaiActionEvidence: { status: 'verified_pre_dispatch', captureRuntime: runtime },
        qaaiCaptureRuntime: runtime,
      },
    });

    expect(built.locatorRecipes).toHaveLength(1);
    expect(built.ledger).toMatchObject({ verifiedLocatorCount: 1, missingVerifiedLocatorCount: 0 });
    const recipe = JSON.parse(built.locatorRecipes[0].locatorRecipeJson);
    expect(recipe.captureEvidence).toMatchObject({
      backendNodeId: 481,
      popupIdentity: { id: 'tab-current', alias: 'primary' },
      pre: { backendNodeId: 481, phase: 'pre_action' },
      post: { backendNodeId: 481, phase: 'post_action' },
    });
    expect(JSON.parse(built.actionEvidences[0].evidenceJson).captureRuntime.buildFingerprint).toBe(mcp.CAPTURE_BUILD_FINGERPRINT);
  });

  it('writes an explicit capture gap when a locator-bearing result has no locator metadata', () => {
    const entry = {
      tool: 'browser_hover',
      contractStepId: 'tc-tooltip:step:1',
      args: { element: 'User Management', ref: 'e22' },
    };
    const built = recorder.recordExecutableAction({
      runResultId: 'rr-gap',
      testCase: { id: 'tc-tooltip' },
      trailEntry: entry,
      result: { isError: false, qaaiCaptureRuntime: mcp.captureRuntimeEvidence({ captureRuntime: mcp.captureRuntimeDescriptor() }) },
    });
    expect(entry.actionLocatorGap).toMatchObject({ code: 'action_locator_evidence_missing_at_recording_chokepoint' });
    expect(entry.actionLocatorKernel).toMatchObject({ status: 'locator_capture_gap' });
    expect(JSON.parse(built.actionEvidences[0].evidenceJson).actionLocatorGap).toMatchObject({
      code: 'action_locator_evidence_missing_at_recording_chokepoint',
    });
  });
});
