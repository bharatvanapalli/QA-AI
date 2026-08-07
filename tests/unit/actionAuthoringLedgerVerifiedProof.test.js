import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const replayExport = require('../../server/services/codegen/replayExport.js');

function authoritativeLocator() {
  const expression = 'getByRole("button", { name: "Continue", exact: true })';
  const identity = { scheme: 'qaai-cdp-backend-node-v1', backendNodeId: 65 };
  return {
    kind: 'playwright',
    verified: true,
    diagnosticOnly: false,
    verificationSource: 'authoritative_chromium_cdp',
    evidenceSource: 'authoritative_chromium_cdp',
    expression,
    frameworkExpressions: { playwright: expression },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e-continue' } },
    captureEvidence: {
      targetRef: 'e-continue',
      pre: { captured: true, authoritative: true, source: 'chromium_cdp', backendNodeId: 65 },
      post: { captured: true, authoritative: true, source: 'chromium_cdp', backendNodeId: 65 },
    },
    proof: {
      count: 1,
      countBefore: 1,
      countAfter: 1,
      sameElement: true,
      verified: true,
      actionTimeResolved: true,
      identityVerified: true,
      stableAcrossSnapshots: true,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
      source: 'authoritative_chromium_cdp',
    },
  };
}

describe('action authoring ledger authoritative proof', () => {
  it('never relabels an authoritative locator as guessed because of stale step flags', () => {
    const locator = authoritativeLocator();
    const ledger = replayExport.buildActionAuthoringLedger({
      results: [{
        testCaseId: 'case-1',
        runResultId: 'result-1',
        caseName: 'Authentication',
        envelope: { ir: { steps: [
          {
            op: 'resolve',
            as: 'continueButton',
            guessedLocator: true,
            locatorConfidence: 'guessed',
            actionLocator: locator,
          },
          {
            op: 'act',
            target: 'continueButton',
            action: 'click',
            guessedLocator: true,
            actionLocator: locator,
          },
        ] } },
      }],
    });

    expect(ledger.summary).toMatchObject({
      locatorNeedingActionCount: 1,
      missingVerifiedLocatorCount: 0,
      missingExportSafeLocatorCount: 0,
    });
    expect(ledger.records[0]).toMatchObject({
      hasVerifiedActionLocator: true,
      usesGuessedLocator: false,
      locatorSource: 'authoritative_chromium_cdp',
    });
  });

  it('recognizes the emitted authoritative CDP manifest proof as verified', () => {
    const locator = authoritativeLocator();
    const findings = replayExport.validatePomFileGraph('playwright-pom-js', {
      'locators/generated/login.generated.locators.js': [
        'export const loginLocators = {',
        `  continueButton: (page) => page.${locator.expression},`,
        '};',
      ].join('\n'),
      'evidence/locator-manifest.json': `${JSON.stringify([{
        as: 'continueButton',
        file: 'login',
        name: 'continueButton',
        expr: `page.${locator.expression}`,
        source: 'actionLocator',
        verificationSource: locator.verificationSource,
        evidenceSource: locator.evidenceSource,
        verified: true,
        proof: locator.proof,
      }], null, 2)}\n`,
      'evidence/dom-atlas.json': `${JSON.stringify({
        schemaVersion: 'qaai-dom-atlas-v1',
        pages: {
          '/login': { verifiedActions: [locator] },
        },
      }, null, 2)}\n`,
    });

    expect(findings.map((finding) => finding.rule)).not.toContain(
      'pom_graph_locator_not_verified_dom_inspection',
    );
  });
});
