import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter.js');

function verifiedLocator(expression, nodeId) {
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'doc:locator-precedence',
    nodeId,
    connected: true,
  };
  const proof = {
    source: 'verified_dom_inspection',
    verified: true,
    count: 1,
    sameElement: true,
    actionTimeResolved: true,
    resolutionMode: 'bound_mcp_ref',
    identityVerified: true,
    targetIdentity: identity,
    matchedIdentity: { ...identity },
  };
  return {
    kind: 'playwright',
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    captureBinding: { kind: 'mcp_bound_ref', ref: nodeId },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: nodeId } },
    proof,
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      verifiedActions: [{ verificationSource: 'verified_dom_inspection', proof }],
    },
  };
}

function unverifiedLocator(expression) {
  return {
    kind: 'playwright',
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: false,
    diagnosticOnly: true,
    verificationSource: 'semantic_dom_scout',
    evidenceSource: 'semantic_dom_scout',
    guess: { isGuess: true, reviewRequired: true },
    proof: { source: 'semantic_dom_scout', verified: false },
  };
}

function resolveStep(ir) {
  return ir.steps.find((step) => step.op === 'resolve');
}

describe('ReplayIR locator evidence precedence', () => {
  it('keeps a verified direct action locator ahead of an unverified repaired locator', () => {
    const direct = verifiedLocator('getByRole("button", { name: "Save user" })', 'node:save');
    const repaired = unverifiedLocator('getByText("Save user")');
    const built = replayEmitter.buildReplayIR({
      caseId: 'verified-action-precedence',
      title: 'Save a user',
      trail: [{
        tool: 'browser_click',
        args: { element: 'Save user button', target: 'e5' },
        actionLocator: direct,
        locatorEvidenceV2: { repairedActionLocator: repaired },
      }],
      verdictStatus: 'pass',
    });

    expect(resolveStep(built.ir).actionLocator).toMatchObject({
      goldVerified: true,
      expression: direct.expression,
    });
  });

  it('keeps a verified per-field locator ahead of repaired and codegen guesses', () => {
    const direct = verifiedLocator('getByLabel("Email address")', 'node:email');
    const repaired = unverifiedLocator('getByPlaceholder("Email")');
    const codegen = unverifiedLocator('locator("input[type=\\"email\\"]")');
    const built = replayEmitter.buildReplayIR({
      caseId: 'verified-field-precedence',
      title: 'Enter an email',
      trail: [{
        tool: 'browser_fill_form',
        args: {
          fields: [{ name: 'Email address', type: 'textbox', target: 'e7', value: 'qa@example.test' }],
        },
        actionLocator: {
          kind: 'multi',
          fields: [{ index: 0, ref: 'e7', name: 'Email address', actionLocator: direct }],
        },
        codegenLocator: codegen,
        locatorEvidenceV2: { repairedActionLocator: repaired },
      }],
      verdictStatus: 'pass',
    });

    expect(resolveStep(built.ir).actionLocator).toMatchObject({
      goldVerified: true,
      expression: direct.expression,
    });
  });
});
