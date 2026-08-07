import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const locatorIntelligenceV2 = require('../../server/services/locatorIntelligenceV2');
const actionPlan = require('../../server/services/codegen/_actionPlan');
const replayEmitter = require('../../server/services/codegen/replayEmitter');
const replayExport = require('../../server/services/codegen/replayExport');
const playwrightPomAdapter = require('../../server/services/codegen/adapters/playwrightPom');
const actionLocatorResolver = require('../../server/services/actionLocatorResolver');

function goldLocator(expression = 'getByRole("button", { name: "Save" })') {
  const source = actionLocatorResolver.VERIFIED_DOM_INSPECTION_SOURCE;
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'doc:locator-intelligence-test',
    nodeId: 'node:save',
    connected: true,
  };
  return {
    kind: 'playwright',
    verified: true,
    verificationSource: source,
    evidenceSource: source,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: 'role',
    elementLabel: 'Save',
    targetFacts: { role: 'button', accessibleName: 'Save' },
    targetIdentity,
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e-save' } },
    proof: {
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
      source,
    },
    domAtlas: { verifiedActions: [{ expression, source }] },
  };
}

describe('locator intelligence v2', () => {
  it('is enabled only by project-scoped trigger config', () => {
    expect(locatorIntelligenceV2.projectLocatorV2Enabled({})).toBe(false);
    expect(locatorIntelligenceV2.projectLocatorV2Enabled({
      triggerConfigJson: JSON.stringify({ locatorIntelligenceV2: true }),
    })).toBe(true);
    expect(locatorIntelligenceV2.projectLocatorV2Enabled({
      triggerConfigJson: JSON.stringify({ locatorIntelligence: { v2: true } }),
    })).toBe(true);
    expect(locatorIntelligenceV2.projectLocatorV2Enabled({
      triggerConfigJson: JSON.stringify({ locatorIntelligenceV2: false, locatorIntelligence: { v2: true } }),
    })).toBe(false);
  });

  it('certifies a unique same-element action locator', () => {
    const bundle = locatorIntelligenceV2.buildLocatorEvidenceBundle({
      actionLocator: goldLocator(),
      toolName: 'browser_click',
      stepOrdinal: 3,
      elementLabel: 'Save',
      pageUrl: 'https://app.test/users',
    });

    expect(bundle.schemaVersion).toBe(locatorIntelligenceV2.SCHEMA_VERSION);
    expect(bundle.selected.confidence).toBe('certified');
    expect(bundle.selected.score).toBeGreaterThanOrEqual(90);
    expect(bundle.fingerprint?.schemaVersion).toBe(locatorIntelligenceV2.FINGERPRINT_SCHEMA_VERSION);
    expect(bundle.selected.fingerprint?.hash).toBe(bundle.fingerprint.hash);
    expect(bundle.healing?.status).toBe('ready');
    expect(bundle.exportGate.status).toBe('certified');
    expect(bundle.weaknesses).toEqual([]);
  });

  it('blocks positional locators instead of silently marking them green', () => {
    const source = 'snapshot_ref_fallback';
    const positional = {
      kind: 'playwright',
      verificationSource: source,
      evidenceSource: source,
      expression: 'locator(".user-row").nth(2)',
      frameworkExpressions: { playwright: 'locator(".user-row").nth(2)' },
      strategy: 'css',
      proof: { count: 1, sameElement: true, source },
    };

    const bundle = locatorIntelligenceV2.buildLocatorEvidenceBundle({
      actionLocator: positional,
      toolName: 'browser_click',
      elementLabel: 'Edit',
    });

    expect(bundle.exportGate.status).toBe('blocked');
    expect(bundle.selected.confidence).toBe('unverified');
    expect(bundle.weaknesses).toContain('positional_locator');
    expect(bundle.repairRecommendation).toMatch(/Replace positional locator/);
  });

  it('auto-promotes a captured same-element candidate before ReplayIR export', () => {
    const badSource = 'snapshot_ref_fallback';
    const goodSource = actionLocatorResolver.VERIFIED_STRUCTURAL_DOM_SOURCE;
    const repairedExpression = 'getByTestId("save-user")';
    const targetIdentity = {
      scheme: 'qaai-dom-node-v1',
      documentId: 'doc:locator-intelligence-repair',
      nodeId: 'node:save-user',
      connected: true,
    };
    const positional = {
      kind: 'playwright',
      verificationSource: badSource,
      evidenceSource: badSource,
      expression: 'locator(".user-row").nth(2)',
      frameworkExpressions: { playwright: 'locator(".user-row").nth(2)' },
      strategy: 'css',
      elementLabel: 'Save user',
      targetFacts: { role: 'button', accessibleName: 'Save user' },
      proof: { count: 1, sameElement: true, source: badSource },
      allCandidates: [{
        kind: 'playwright',
        verified: true,
        verificationSource: goodSource,
        evidenceSource: goodSource,
        expression: repairedExpression,
        frameworkExpressions: { playwright: repairedExpression },
        strategy: 'testId',
        targetFacts: { role: 'button', accessibleName: 'Save user', testId: 'save-user' },
        context: { captureBinding: { kind: 'mcp_bound_ref', ref: 'e-save-user' } },
        proof: {
          count: 1,
          sameElement: true,
          visible: true,
          enabled: true,
          verified: true,
          actionTimeResolved: true,
          resolutionMode: 'bound_mcp_ref_structural',
          identityVerified: true,
          targetIdentity,
          matchedIdentity: { ...targetIdentity },
          source: goodSource,
        },
        domAtlas: { verifiedActions: [{ expression: repairedExpression, source: goodSource }] },
      }],
    };

    const locatorEvidenceV2 = locatorIntelligenceV2.buildLocatorEvidenceBundle({
      actionLocator: positional,
      toolName: 'browser_click',
      elementLabel: 'Save user',
      pageUrl: 'https://app.test/users',
    });

    expect(locatorEvidenceV2.exportGate.status).toBe('certified');
    expect(locatorEvidenceV2.selected.expression).toBe(repairedExpression);
    expect(locatorEvidenceV2.selected.autoRepaired).toBe(true);
    expect(locatorEvidenceV2.selected.provenance).toBe('candidatePromotion');
    expect(locatorEvidenceV2.repairedActionLocator.frameworkExpressions.playwright).toBe(repairedExpression);
    expect(actionLocatorResolver.isExportSafeActionLocator(locatorEvidenceV2.repairedActionLocator)).toBe(true);
    expect(locatorEvidenceV2.rejectedCandidates.some((candidate) => /nth\(2\)/.test(candidate.expression))).toBe(true);

    const emit = replayEmitter.buildReplayIR({
      caseId: 'tc-repaired-save',
      title: 'Repair locator before export',
      trail: [{
        tool: 'browser_click',
        ok: true,
        args: { element: 'Save user' },
        pageUrl: 'https://app.test/users',
        actionLocator: positional,
        locatorEvidenceV2,
        stepAuthoring: { id: 'step-save', locatorEvidenceV2 },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });
    const resolve = emit.ir.steps.find((step) => step.op === 'resolve');

    expect(emit.complete).toBe(true);
    expect(resolve.actionLocator.expression).toBe(repairedExpression);
    expect(resolve.locatorConfidence).not.toBe('guessed');
    expect(emit.ir.locatorCertification.summary.status).toBe('certified');
  });

  it('keeps codegen fallback evidence as draft until proof is captured', () => {
    const source = 'snapshot_ref_fallback';
    const fallback = {
      kind: 'playwright',
      unverifiedForCodegen: true,
      verificationSource: source,
      evidenceSource: source,
      expression: 'getByPlaceholder(/password/i)',
      frameworkExpressions: { playwright: 'getByPlaceholder(/password/i)' },
      strategy: 'placeholder',
      diagnosticOnly: true,
      guess: {
        isGuess: true,
        reviewRequired: true,
        source,
        annotation: 'QAAI-GUESSED: snapshot fallback; review before relying on it.',
      },
      targetFacts: { placeholder: 'Password' },
      proof: { source },
    };

    const bundle = locatorIntelligenceV2.buildLocatorEvidenceBundle({
      codegenLocator: fallback,
      toolName: 'browser_fill',
      elementLabel: 'Password',
    });

    expect(bundle.exportGate.status).toBe('draft');
    expect(bundle.selected.provenance).toBe('codegenLocator');
    expect(bundle.weaknesses).toContain('count_not_proven_unique');
    expect(bundle.weaknesses).toContain('same_element_not_proven');
  });

  it('survives action-plan shaping for export and reporting phases', () => {
    const locatorEvidenceV2 = { schemaVersion: locatorIntelligenceV2.SCHEMA_VERSION, exportGate: { status: 'draft' } };
    const shaped = actionPlan.toCodegenAction({
      tool: 'browser_click',
      args: { element: 'Save' },
      ok: true,
      locatorEvidenceV2,
    });

    expect(shaped.locatorEvidenceV2).toBe(locatorEvidenceV2);
  });

  it('keeps draft certification as a warning when ReplayIR owns an export-safe locator', () => {
    const source = 'snapshot_ref_fallback';
    const fallback = {
      kind: 'playwright',
      unverifiedForCodegen: true,
      verificationSource: source,
      evidenceSource: source,
      expression: 'getByPlaceholder(/password/i)',
      frameworkExpressions: { playwright: 'getByPlaceholder(/password/i)' },
      strategy: 'placeholder',
      diagnosticOnly: true,
      guess: {
        isGuess: true,
        reviewRequired: true,
        source,
        annotation: 'QAAI-GUESSED: snapshot fallback; review before relying on it.',
      },
      targetFacts: { placeholder: 'Password' },
      proof: { source },
    };
    const locatorEvidenceV2 = locatorIntelligenceV2.buildLocatorEvidenceBundle({
      codegenLocator: fallback,
      toolName: 'browser_fill',
      elementLabel: 'Password',
      pageUrl: 'https://app.test/login',
    });

    const emit = replayEmitter.buildReplayIR({
      caseId: 'tc-password',
      title: 'Password fill',
      trail: [{
        tool: 'browser_fill',
        ok: true,
        args: { element: 'Password', value: 'admin123' },
        pageUrl: 'https://app.test/login',
        codegenLocator: fallback,
        locatorEvidenceV2,
        stepAuthoring: { id: 'step-password', locatorEvidenceV2 },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });

    expect(emit.ir.locatorCertification.summary.status).toBe('draft');
    expect(emit.ir.locatorCertification.steps[0].selected.expression).toBe('getByPlaceholder(/password/i)');
    expect(emit.complete).toBe(true);
    expect(emit.gaps.some((gap) => gap.code === 'locator_certification_draft')).toBe(false);
    expect(emit.findings.some((finding) => finding.rule === 'locator_certification_draft' && finding.severity === 'warning')).toBe(true);

    const compiled = replayExport.compileResults({
      adapter: playwrightPomAdapter,
      results: [{
        runId: 'run-1',
        runResultId: 'rr-1',
        testCaseId: 'tc-password',
        status: 'pass',
        envelope: { ir: emit.ir, complete: true, gaps: [] },
      }],
    });
    expect(compiled.blocked).toEqual([]);
    expect(compiled.findings.some((finding) => finding.rule === 'locator_certification_draft' && finding.severity === 'warning')).toBe(true);
  });

  it('emits locator certification as exported POM evidence', () => {
    const actionLocator = goldLocator();
    const locatorEvidenceV2 = locatorIntelligenceV2.buildLocatorEvidenceBundle({
      actionLocator,
      toolName: 'browser_click',
      elementLabel: 'Save',
      pageUrl: 'https://app.test/users',
    });
    const emit = replayEmitter.buildReplayIR({
      caseId: 'tc-save',
      title: 'Save user',
      trail: [{
        tool: 'browser_click',
        ok: true,
        args: { element: 'Save' },
        pageUrl: 'https://app.test/users',
        actionLocator,
        locatorEvidenceV2,
        stepAuthoring: { id: 'step-save', locatorEvidenceV2 },
      }],
      declaredAssertions: [],
      assertionOutcomes: [],
      verdictStatus: 'pass',
    });

    expect(emit.complete).toBe(true);
    expect(emit.ir.locatorCertification.summary.status).toBe('certified');

    const emitted = playwrightPomAdapter.emitJourneySpec([
      { ir: emit.ir, caseName: 'Save user', scenarioName: 'User lifecycle' },
    ], { scenarioName: 'User lifecycle', lang: 'ts' });
    const locatorReport = JSON.parse(emitted.extraFiles['evidence/locator-certification-report.json']);
    const certReport = JSON.parse(emitted.extraFiles['evidence/certification-report.json']);

    expect(locatorReport.summary.status).toBe('certified');
    expect(locatorReport.summary.total).toBe(1);
    expect(certReport.evidence['locator-certification-report.json'].status).toBe('certified');
  });

  it('builds stable fingerprints from element facts instead of raw locator syntax', () => {
    const targetFacts = {
      role: 'button',
      accessibleName: 'Save user',
      testId: 'save-user',
      stableAttributes: { 'data-testid': 'save-user' },
    };
    const context = { formSelector: 'form[data-qa="user-editor"]', nearbyText: ['User editor Save user'] };
    const roleFingerprint = locatorIntelligenceV2.buildLocatorFingerprint({
      expression: 'getByRole("button", { name: "Save user" })',
      strategy: 'role',
      targetFacts,
      context,
    });
    const cssFingerprint = locatorIntelligenceV2.buildLocatorFingerprint({
      expression: 'locator("button[data-testid=\\"save-user\\"]")',
      strategy: 'css_stable_attr',
      targetFacts,
      context,
    });

    expect(roleFingerprint.hash).toBe(cssFingerprint.hash);
    const match = locatorIntelligenceV2.scoreFingerprintMatch(roleFingerprint, cssFingerprint);
    expect(match.matched).toBe(true);
    expect(match.score).toBeGreaterThanOrEqual(90);
  });

  it('selects the strongest healing candidate by fingerprint evidence', () => {
    const expected = locatorIntelligenceV2.buildLocatorFingerprint({
      expression: 'getByRole("button", { name: "Save user" })',
      strategy: 'role',
      targetFacts: { role: 'button', accessibleName: 'Save user', testId: 'save-user' },
      context: { formSelector: 'form[data-qa="user-editor"]', nearbyText: ['User editor Save user'] },
    });
    const weakSameLabel = {
      expression: 'getByRole("button", { name: "Save user" })',
      strategy: 'role',
      targetFacts: { role: 'button', accessibleName: 'Save user' },
      context: { nearbyText: ['Marketing settings Save user'] },
    };
    const strongSameElement = {
      expression: 'locator("button[data-testid=\\"save-user\\"]")',
      strategy: 'css_stable_attr',
      targetFacts: { role: 'button', accessibleName: 'Save user', testId: 'save-user' },
      context: { formSelector: 'form[data-qa="user-editor"]', nearbyText: ['User editor Save user'] },
    };

    const selected = locatorIntelligenceV2.selectHealingCandidateByFingerprint(expected, [weakSameLabel, strongSameElement]);

    expect(selected.candidate).toBe(strongSameElement);
    expect(selected.fingerprintMatch.matched).toBe(true);
    expect(selected.fingerprintMatch.reasons).toContain('same_testid');
  });
});
