import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const recorder = require('../../server/services/actionEvidenceRecorder.js');

function locator(expression, overrides = {}) {
  return {
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    verified: true,
    proof: {
      verified: true,
      sameElement: true,
      count: 1,
      visible: true,
      enabled: true,
      source: 'verified_dom_inspection',
    },
    domAtlas: {
      verifiedActions: [{ expression }],
    },
    targetFacts: {
      role: 'textbox',
      accessibleName: 'Field',
    },
    ...overrides,
  };
}

describe('capture-first action evidence recorder', () => {
  it('decomposes browser_fill_form into per-field action evidence with locator recipes', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-1',
      testCase: {
        id: 'tc-1',
        name: 'Login through external identity provider',
        declaredAssertions: [{ id: 'asn-1', kind: 'visible', required: true }],
      },
      status: 'pass',
      trail: [{
        tool: 'browser_fill_form',
        args: {
          fields: [
            { element: 'Email Address', value: 'user@example.test' },
            { element: 'Password', value: 'super-secret-password' },
          ],
        },
        actionLocator: {
          kind: 'multi',
          fields: [
            { index: 0, name: 'Email Address', actionLocator: locator("getByLabel('Email Address')") },
            { index: 1, name: 'Password', actionLocator: locator("getByLabel('Password')") },
          ],
        },
        pageUrl: 'https://example.test/login',
      }],
      assertionOutcomes: [
        { assertionId: 'asn-1', kind: 'visible', expected: 'Dashboard', actual: 'Dashboard', matched: true, source: 'assertion_check' },
      ],
    });

    expect(built.actionEvidences).toHaveLength(2);
    expect(built.locatorRecipes).toHaveLength(2);
    expect(built.ledger.actionEvidenceCount).toBe(2);
    expect(built.ledger.missingLocatorCount).toBe(0);
    expect(built.ledger.plannedAssertionCount).toBe(1);
    expect(built.ledger.assertionEvidenceCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('complete');

    const evidenceJson = built.actionEvidences.map((item) => item.evidenceJson).join('\n');
    expect(evidenceJson).not.toContain('super-secret-password');
    expect(built.actionEvidences[1].valueRef).toMatch(/^secret:/);
  });

  it('records deterministic browser_evaluate DOM mutations as exportable but incomplete without locator evidence', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-2',
      testCase: { id: 'tc-2', name: 'Deterministic fill' },
      status: 'pass',
      trail: [{
        tool: 'browser_evaluate',
        source: 'deterministic_dom_fill',
        args: { element: 'Username', value: 'alice' },
        pageUrl: 'https://example.test/admin',
      }],
    });

    expect(built.actionEvidences).toHaveLength(1);
    expect(built.ledger.actionEvidenceCount).toBe(1);
    expect(built.ledger.missingLocatorCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
    expect(built.ledger.overallRunStatus).toBe('evidence_capture_failed');
  });

  it('records click, navigation, and assertion evidence in shadow output', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-nav-assert',
      testCase: {
        id: 'tc-nav-assert',
        name: 'Navigate and assert dashboard',
        declaredAssertions: [{ id: 'asn-dashboard', kind: 'visible', required: true }],
      },
      status: 'pass',
      trail: [
        {
          tool: 'browser_navigate',
          args: { url: 'https://example.test/login' },
          pageUrlAfter: 'https://example.test/login',
          loadStateProof: 'domcontentloaded',
          postNavigationOracle: { title: 'Login' },
        },
        {
          tool: 'browser_click',
          args: { element: 'Continue' },
          actionLocator: locator("getByRole('button', { name: 'Continue' })", {
            targetFacts: { role: 'button', accessibleName: 'Continue' },
          }),
          pageUrl: 'https://example.test/login',
          pageUrlAfter: 'https://example.test/dashboard',
        },
        {
          tool: 'assertion_check',
          args: { assertionId: 'asn-dashboard', expected: 'Dashboard visible' },
          pageUrl: 'https://example.test/dashboard',
        },
      ],
      assertionOutcomes: [
        { assertionId: 'asn-dashboard', kind: 'visible', expected: 'Dashboard', actual: 'Dashboard', matched: true, source: 'assertion_check' },
      ],
    });

    expect(built.actionEvidences.map((item) => item.toolName)).toEqual([
      'browser_navigate',
      'browser_click',
      'assertion_check',
    ]);
    expect(built.navigationEvidences).toHaveLength(1);
    expect(built.navigationEvidences[0].requestedUrl).toBe('https://example.test/login');
    expect(built.navigationEvidences[0].resolvedUrl).toBe('https://example.test/login');
    expect(built.assertionEvidences).toHaveLength(1);
    expect(built.locatorRecipes).toHaveLength(1);
    expect(built.ledger.missingEvidenceCount).toBe(0);
    expect(built.ledger.evidenceStatus).toBe('complete');
  });

  it('does not count parse-failed assertions as complete evidence', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-parse-failed',
      testCase: {
        id: 'tc-parse-failed',
        name: 'Invalid oracle',
        declaredAssertions: [{ id: 'asn-broken', kind: 'text', required: true }],
      },
      status: 'pass',
      trail: [{
        tool: 'assertion_check',
        args: { assertionId: 'asn-broken', expected: '' },
      }],
      assertionOutcomes: [
        { assertionId: 'asn-broken', kind: 'text', outcome: 'parse_failed', reason: 'parse_failed: expected text is missing' },
      ],
    });

    expect(built.assertionEvidences).toHaveLength(1);
    expect(built.ledger.rawAssertionEvidenceCount).toBe(1);
    expect(built.ledger.assertionEvidenceCount).toBe(0);
    expect(built.ledger.parseFailedAssertionCount).toBe(1);
    expect(built.ledger.missingAssertionCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
  });

  it('requires real navigation proof before marking navigate evidence complete', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-nav-incomplete',
      testCase: { id: 'tc-nav-incomplete', name: 'Navigate without landing proof' },
      status: 'pass',
      trail: [{
        tool: 'browser_navigate',
        args: { url: 'https://example.test/dashboard' },
        pageUrlAfter: 'https://example.test/dashboard',
      }],
    });

    expect(built.navigationEvidences).toHaveLength(1);
    expect(built.ledger.missingNavigationEvidenceCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
  });

  it('requires post-login/session evidence for auth setup completeness', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-auth-incomplete',
      testCase: {
        id: 'tc-auth-incomplete',
        name: 'Login through external identity provider',
        requiresAuth: true,
      },
      status: 'pass',
      trail: [{
        tool: 'browser_fill',
        args: { element: 'Password', value: 'super-secret-password' },
        actionLocator: locator("getByLabel('Password')", {
          targetFacts: { role: 'textbox', accessibleName: 'Password' },
        }),
        pageUrl: 'https://idp.example.test/common',
      }],
    });

    expect(built.authSetupEvidences).toHaveLength(1);
    expect(built.ledger.authRequired).toBe(true);
    expect(built.ledger.missingAuthSetupCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
  });

  it('captures generic SSO auth setup as complete when every action and post-login oracle are evidenced', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-generic-sso-complete',
      testCase: {
        id: 'tc-generic-sso-complete',
        name: 'Login through identity provider sign-in',
        requiresAuth: true,
        declaredAssertions: [{ id: 'asn-landing', kind: 'text', required: true }],
      },
      status: 'pass',
      trail: [
        {
          tool: 'browser_fill',
          args: { element: 'Email Address', value: 'user@example.test' },
          actionLocator: locator("getByLabel('Email Address')"),
        },
        {
          tool: 'browser_click',
          args: { element: 'Continue' },
          actionLocator: locator("getByRole('button', { name: 'Continue' })", {
            targetFacts: { role: 'button', accessibleName: 'Continue' },
          }),
        },
        {
          tool: 'browser_click',
          args: { element: 'Sign in with Company Provider' },
          actionLocator: locator("getByRole('button', { name: 'Sign in with Company Provider' })", {
            targetFacts: { role: 'button', accessibleName: 'Sign in with Company Provider' },
          }),
          pageUrlAfter: 'https://idp.example.test/common',
        },
        {
          tool: 'browser_fill',
          args: { element: 'Identifier', value: 'user@example.test' },
          actionLocator: locator("getByLabel('Identifier')"),
        },
        {
          tool: 'browser_click',
          args: { element: 'Next' },
          actionLocator: locator("getByRole('button', { name: 'Next' })", {
            targetFacts: { role: 'button', accessibleName: 'Next' },
          }),
        },
        {
          tool: 'browser_fill',
          args: { element: 'Password', value: 'super-secret-password' },
          actionLocator: locator("getByLabel('Password')"),
        },
        {
          tool: 'browser_click',
          args: { element: 'Sign in' },
          actionLocator: locator("getByRole('button', { name: 'Sign in' })", {
            targetFacts: { role: 'button', accessibleName: 'Sign in' },
          }),
          pageUrlAfter: 'https://example.test/home',
        },
      ],
      assertionOutcomes: [
        { assertionId: 'asn-landing', kind: 'text', expected: 'Welcome home', actual: 'Welcome home', matched: true, source: 'assertion_check' },
      ],
    });

    expect(built.actionEvidences).toHaveLength(7);
    expect(built.locatorRecipes).toHaveLength(7);
    expect(built.authSetupEvidences).toHaveLength(1);
    expect(built.ledger.authRequired).toBe(true);
    expect(built.ledger.missingAuthSetupCount).toBe(0);
    expect(built.ledger.assertionEvidenceCount).toBe(1);
    expect(built.ledger.finalAssertionEvidenceCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('complete');
  });

  it('marks evidence incomplete when planned executable actions are missing', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-missing-action',
      testCase: { id: 'tc-missing-action', name: 'Incomplete planned flow' },
      status: 'pass',
      executionContract: {
        nodes: [
          { id: 'step-1', kind: 'click' },
          { id: 'step-2', kind: 'fill' },
          { id: 'step-3', kind: 'click' },
        ],
      },
      trail: [{
        tool: 'browser_click',
        args: { element: 'Create' },
        actionLocator: locator("getByRole('button', { name: 'Create' })", {
          targetFacts: { role: 'button', accessibleName: 'Create' },
        }),
      }],
    });

    expect(built.ledger.plannedExecutableStepCount).toBe(3);
    expect(built.ledger.actionEvidenceCount).toBe(1);
    expect(built.ledger.missingActionEvidenceCount).toBe(2);
    expect(built.ledger.missingEvidenceCount).toBe(2);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
    expect(built.ledger.overallRunStatus).toBe('evidence_capture_failed');
  });

  it('separates functional failure from evidence completeness', () => {
    const built = recorder.buildEvidenceFromTrail({
      runResultId: 'rr-3',
      testCase: {
        id: 'tc-3',
        name: 'Failed save with complete evidence',
        declaredAssertions: [{ id: 'asn-final', kind: 'text', required: true }],
      },
      status: 'fail',
      trail: [{
        tool: 'browser_click',
        args: { element: 'Save' },
        actionLocator: locator("getByRole('button', { name: 'Save' })", {
          targetFacts: { role: 'button', accessibleName: 'Save' },
        }),
        pageUrl: 'https://example.test/form',
      }],
      assertionOutcomes: [
        { assertionId: 'asn-final', kind: 'text', expected: 'Saved', actual: 'Error', matched: false, source: 'assertion_check' },
      ],
    });

    expect(built.ledger.executionStatus).toBe('failed');
    expect(built.ledger.evidenceStatus).toBe('complete');
    expect(built.ledger.overallRunStatus).toBe('complete');
  });

  it('treats legacy run results without capture-first evidence as diagnostic only', () => {
    expect(recorder.normalizeRunEvidenceStatus({ id: 'old-run', status: 'pass' })).toEqual({
      overallRunStatus: 'diagnostic_only',
      executionStatus: 'passed',
      evidenceStatus: 'capture_failed',
      scriptStatus: 'validation_failed',
      diagnosticOnly: true,
    });
  });

  it('persists shadow evidence rows and stores typed values as valueRef only', async () => {
    const calls = [];
    const delegate = (name) => ({
      async update(payload) {
        calls.push({ name, method: 'update', payload });
        return payload.data;
      },
      async deleteMany(payload) {
        calls.push({ name, method: 'deleteMany', payload });
        return { count: 0 };
      },
      async create(payload) {
        calls.push({ name, method: 'create', payload });
        return payload.data;
      },
    });
    const prisma = {
      runResult: delegate('runResult'),
      locatorRecipe: delegate('locatorRecipe'),
      actionEvidence: delegate('actionEvidence'),
      assertionEvidence: delegate('assertionEvidence'),
      authSetupEvidence: delegate('authSetupEvidence'),
      traceArtifact: delegate('traceArtifact'),
      navigationEvidence: delegate('navigationEvidence'),
      evidenceCompletenessLedger: delegate('evidenceCompletenessLedger'),
    };

    const trail = [];
    const liveScriptLedger = recorder.createLiveScriptLedger({
      testCase: { id: 'tc-persist', name: 'Persist typed value' },
      status: 'pass',
    });
    recorder.appendExecutableTrailEntry({
      actionTrail: trail,
      testCase: { id: 'tc-persist', name: 'Persist typed value' },
      status: 'pass',
      liveScriptLedger,
      entry: {
        tool: 'browser_type',
        args: { element: 'Username', value: 'alice@example.test' },
        actionLocator: locator("getByLabel('Username')"),
      },
    });

    await recorder.persistShadowEvidence({
      prisma,
      runResultId: 'rr-persist',
      testCase: { id: 'tc-persist', name: 'Persist typed value' },
      status: 'pass',
      trail,
      liveScriptLedger,
    });

    const runResultUpdate = calls.find((call) => call.name === 'runResult' && call.method === 'update');
    expect(runResultUpdate).toBeTruthy();
    const completeness = JSON.parse(runResultUpdate.payload.data.evidenceCompletenessJson);
    expect(completeness.liveScriptLedger).toBeTruthy();
    expect(completeness.liveScriptLedger.runResultId).toBe('rr-persist');
    expect(completeness.liveScriptLedger.lines).toHaveLength(1);
    expect(completeness.liveScriptLedger.lines[0].label).toBe('Username');
    const actionCreate = calls.find((call) => call.name === 'actionEvidence' && call.method === 'create');
    expect(actionCreate).toBeTruthy();
    expect(actionCreate.payload.data.valueRef).toMatch(/^value:/);
    expect(actionCreate.payload.data.evidenceJson).not.toContain('alice@example.test');
    expect(calls.some((call) => call.name === 'evidenceCompletenessLedger' && call.method === 'create')).toBe(true);
    expect(calls.some((call) => call.name === 'runResult' && call.method === 'update')).toBe(true);
  });

  it('automatically reuses one live script ledger for conductor-style actionTrail appends', async () => {
    const calls = [];
    const delegate = (name) => ({
      async update(payload) {
        calls.push({ name, method: 'update', payload });
        return payload.data;
      },
      async deleteMany(payload) {
        calls.push({ name, method: 'deleteMany', payload });
        return { count: 0 };
      },
      async create(payload) {
        calls.push({ name, method: 'create', payload });
        return payload.data;
      },
    });
    const prisma = {
      runResult: delegate('runResult'),
      locatorRecipe: delegate('locatorRecipe'),
      actionEvidence: delegate('actionEvidence'),
      assertionEvidence: delegate('assertionEvidence'),
      authSetupEvidence: delegate('authSetupEvidence'),
      traceArtifact: delegate('traceArtifact'),
      navigationEvidence: delegate('navigationEvidence'),
      evidenceCompletenessLedger: delegate('evidenceCompletenessLedger'),
    };
    const actionTrail = [];
    const testCase = { id: 'tc-auto-ledger', name: 'Auto live ledger' };

    recorder.appendExecutableTrailEntry({
      actionTrail,
      testCase,
      status: 'pass',
      entry: {
        tool: 'browser_click',
        args: { element: 'Open menu' },
        actionLocator: locator("getByRole('button', { name: 'Open menu' })"),
      },
    });
    recorder.appendExecutableTrailEntry({
      actionTrail,
      testCase,
      status: 'fail',
      entry: {
        tool: 'assertion_check',
        args: { expectedText: 'Active 61', actualText: 'Active 62' },
        ok: false,
      },
    });

    const liveLedger = recorder.getLiveScriptLedgerForTrail(actionTrail);
    expect(liveLedger).toBeTruthy();
    expect(liveLedger.lines).toHaveLength(2);

    await recorder.persistShadowEvidence({
      prisma,
      runResultId: 'rr-auto-ledger',
      testCase,
      status: 'fail',
      trail: actionTrail,
      assertionOutcomes: [
        { assertionId: 'asn-active', kind: 'text', expected: 'Active 61', actual: 'Active 62', matched: false, source: 'assertion_check' },
      ],
    });

    const runResultUpdate = calls.find((call) => call.name === 'runResult' && call.method === 'update');
    const completeness = JSON.parse(runResultUpdate.payload.data.evidenceCompletenessJson);
    expect(completeness.liveScriptLedger.runResultId).toBe('rr-auto-ledger');
    expect(completeness.liveScriptLedger.lines).toHaveLength(2);
    expect(completeness.liveScriptLedger.lines.map((line) => line.label)).toEqual(['Open menu', 'assert']);
  });

  it('surfaces capture-first persistence setup failures instead of silently succeeding', async () => {
    const prisma = {
      runResult: {
        async update(payload) {
          return payload.data;
        },
      },
    };

    await expect(recorder.persistShadowEvidence({
      prisma,
      runResultId: 'rr-no-delegate',
      testCase: { id: 'tc-no-delegate', name: 'Missing generated client delegates' },
      status: 'pass',
      trail: [],
    })).rejects.toThrow(/missing prisma\.locatorRecipe\.deleteMany/);
  });

  it('marks live-ref-only actions incomplete instead of export complete', () => {
    const entry = {
      tool: 'browser_click',
      args: { ref: 'e33', element: 'Sign in with Company Provider' },
      pageUrl: 'https://example.test/login',
    };

    const built = recorder.recordExecutableAction({
      runResultId: 'rr-live-ref',
      testCase: { id: 'tc-live-ref' },
      status: 'pass',
      trailEntry: entry,
    });

    expect(entry.captureFirst?.recorded).toBe(true);
    expect(entry.captureFirst?.exportable).toBe(true);
    expect(entry.captureFirst?.actionEvidenceComplete).toBe(false);
    expect(built.ledger.missingLocatorCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
  });

  it('fails the invariant when executable trail entries bypass the chokepoint', () => {
    const directTrail = [{
      tool: 'browser_click',
      args: { element: 'Save' },
      actionLocator: locator("getByRole('button', { name: 'Save' })"),
    }];

    expect(() => recorder.assertNoDirectExecutableTrailAppend(directTrail)).toThrow(/recordExecutableAction/);

    const recordedTrail = [];
    recorder.appendExecutableTrailEntry({
      actionTrail: recordedTrail,
      entry: {
        tool: 'browser_click',
        args: { element: 'Save' },
        actionLocator: locator("getByRole('button', { name: 'Save' })"),
      },
      status: 'pass',
    });

    expect(() => recorder.assertNoDirectExecutableTrailAppend(recordedTrail)).not.toThrow();
  });

  it('keeps deterministic DOM click incomplete without action evidence', () => {
    const built = recorder.recordExecutableAction({
      runResultId: 'rr-dom-click',
      testCase: { id: 'tc-dom-click' },
      status: 'pass',
      trailEntry: {
        tool: 'browser_evaluate',
        source: 'deterministic_dom_click',
        args: { element: 'Continue' },
      },
    });

    expect(built.actionEvidences).toHaveLength(1);
    expect(built.ledger.missingLocatorCount).toBe(1);
    expect(built.ledger.evidenceStatus).toBe('capture_failed');
  });

  it('kernel append preserves MCP evidence fields before writing the trail', () => {
    const actionTrail = [];
    const evidenceLocator = locator("getByRole('button', { name: 'Next' })", {
      targetFacts: { role: 'button', accessibleName: 'Next' },
    });
    const entry = {
      tool: 'browser_click',
      args: { element: 'Next' },
    };

    recorder.kernelAppendTrail({
      actionTrail,
      entry,
      result: {
        qaaiActionLocator: evidenceLocator,
        qaaiActionEvidence: { status: 'verified_pre_dispatch', attempts: 1 },
        codegenLocator: { expression: "page.getByRole('button', { name: 'Next' })" },
        locatorDiagnostic: { code: 'diagnostic_copy' },
        actionLocatorGap: { code: 'none' },
      },
      status: 'pass',
    });

    expect(actionTrail).toHaveLength(1);
    expect(entry.qaaiActionLocator).toEqual(evidenceLocator);
    expect(entry.actionLocator).toEqual(evidenceLocator);
    expect(entry.qaaiActionEvidence?.status).toBe('verified_pre_dispatch');
    expect(entry.codegenLocator?.expression).toContain('Next');
    expect(entry.captureFirst?.propagated?.qaaiActionLocator).toBe(true);
    expect(entry.captureFirst?.actionEvidenceComplete).toBe(true);
  });
});
