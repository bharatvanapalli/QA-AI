import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const authSession = require('../../server/services/universalAuthSessionManager.js');

function action(id, text, overrides = {}) {
  return {
    id,
    toolName: overrides.toolName || 'browser_click',
    actionKind: overrides.actionKind || 'click',
    evidenceJson: JSON.stringify({
      targetText: text,
      targetFacts: { accessibleName: text },
      pageUrl: overrides.pageUrl || 'https://app.example.test/login',
    }),
    ...overrides,
  };
}

describe('universal auth session manager', () => {
  it('classifies provider sign-in generically without site-specific branches', () => {
    const row = authSession.buildAuthSetupEvidenceRow({
      id: 'auth-1',
      runResultId: 'rr-auth',
      testCase: {
        id: 'tc-auth',
        requiresAuth: true,
        authProfile: 'operator',
      },
      actionEvidences: [
        action('ae-email', 'Email Address', { toolName: 'browser_fill', actionKind: 'fill' }),
        action('ae-provider', 'Sign in with Company Provider'),
        action('ae-id', 'Identifier', { toolName: 'browser_fill', actionKind: 'fill', pageUrl: 'https://idp.example.test/login' }),
        action('ae-next', 'Next'),
        action('ae-password', 'Password', { toolName: 'browser_fill', actionKind: 'fill', pageUrl: 'https://idp.example.test/login' }),
        action('ae-submit', 'Sign in', { pageUrl: 'https://idp.example.test/login' }),
      ],
      trail: [
        { tool: 'browser_click', args: { element: 'Sign in with Company Provider' }, pageUrlAfter: 'https://idp.example.test/login' },
        { tool: 'browser_click', args: { element: 'Sign in' }, pageUrlAfter: 'https://app.example.test/home', observation: 'Welcome home' },
      ],
      assertionOutcomes: [
        { assertionId: 'asn-home', kind: 'text', expected: 'Welcome home', actual: 'Welcome home', matched: true },
      ],
    });

    const evidence = JSON.parse(row.evidenceJson);
    const loginIds = JSON.parse(row.loginActionEvidenceIds);
    expect(evidence.providerType).toBe('sso');
    expect(evidence.providerLabel).toBe('Company Provider');
    expect(evidence.complete).toBe(true);
    expect(evidence.missing).toEqual([]);
    expect(loginIds).toContain('ae-provider');
    expect(authSession.authSetupEvidenceIsComplete(row)).toBe(true);
  });

  it('marks manual-gated auth incomplete even when a login flow exists', () => {
    const row = authSession.buildAuthSetupEvidenceRow({
      id: 'auth-manual',
      runResultId: 'rr-manual',
      testCase: { id: 'tc-manual', requiresAuth: true },
      actionEvidences: [
        action('ae-user', 'Username', { toolName: 'browser_fill', actionKind: 'fill' }),
        action('ae-pass', 'Password', { toolName: 'browser_fill', actionKind: 'fill' }),
        action('ae-submit', 'Sign in'),
      ],
      trail: [
        { tool: 'browser_click', args: { element: 'Sign in' }, observation: 'MFA verification code required' },
      ],
      assertionOutcomes: [
        { assertionId: 'asn-home', kind: 'text', expected: 'Welcome home', actual: 'Welcome home', matched: true },
      ],
    });

    const evidence = JSON.parse(row.evidenceJson);
    expect(evidence.manualGateCount).toBeGreaterThan(0);
    expect(evidence.missing).toContain('manual_gate');
    expect(authSession.authSetupEvidenceIsComplete(row)).toBe(false);
  });

  it('builds generic Playwright auth fixture scaffolding from auth evidence', () => {
    const row = authSession.buildAuthSetupEvidenceRow({
      id: 'auth-fixture',
      runResultId: 'rr-fixture',
      testCase: {
        id: 'tc-fixture',
        requiresAuth: true,
        authProfile: 'operator',
        authProfileStorageStateRef: 'fixture:auth-state-1',
      },
      actionEvidences: [],
      trail: [{ tool: 'browser_navigate', pageUrlAfter: 'https://app.example.test/home', observation: 'Welcome home' }],
      assertionOutcomes: [
        { assertionId: 'asn-home', kind: 'text', expected: 'Welcome home', actual: 'Welcome home', matched: true },
      ],
    });

    const scaffold = authSession.buildAuthFixtureScaffold({
      adapterId: 'playwright-pom-js',
      results: [{ authSetupEvidences: [row] }],
    });

    expect(scaffold.files['fixtures/auth/README.md']).toContain('universal auth/session');
    expect(scaffold.files['fixtures/auth/auth.setup.ts']).toContain('QAAI_AUTH_STORAGE_STATE');
    expect(scaffold.files['fixtures/auth/auth.setup.ts']).not.toContain('context.storageState');
    expect(scaffold.files['fixtures/auth/operator.storageState.json']).toBeTruthy();
    const storageRef = JSON.parse(scaffold.files['fixtures/auth/operator.storageState.json']);
    expect(storageRef).toMatchObject({
      authProfileId: 'operator',
      storageStateRef: 'fixture:auth-state-1',
      materializedStorageStatePath: '.auth/state.json',
      valuePolicy: 'reference_only_no_secrets',
    });
    const contract = JSON.parse(scaffold.files['fixtures/auth/session-contract.json']);
    expect(contract.storageStateRefs).toEqual(['fixture:auth-state-1']);
    expect(contract.storageStateReferenceFiles).toEqual(['fixtures/auth/operator.storageState.json']);
    expect(contract.rows[0]).toMatchObject({
      authProfileId: 'operator',
      storageStateRef: 'fixture:auth-state-1',
      complete: true,
    });
  });

  it('does not copy raw credential values into auth setup evidence', () => {
    const row = authSession.buildAuthSetupEvidenceRow({
      id: 'auth-secret',
      runResultId: 'rr-secret',
      testCase: { id: 'tc-secret', requiresAuth: true },
      actionEvidences: [
        action('ae-user', 'Username', { toolName: 'browser_fill', actionKind: 'fill' }),
        action('ae-pass', 'Password', { toolName: 'browser_fill', actionKind: 'fill', evidenceJson: JSON.stringify({ targetText: 'Password', value: 'super-secret-password' }) }),
        action('ae-submit', 'Sign in'),
      ],
      trail: [{ tool: 'browser_click', args: { element: 'Sign in' }, pageUrlAfter: 'https://app.example.test/home', observation: 'Welcome home' }],
      assertionOutcomes: [
        { assertionId: 'asn-home', kind: 'text', expected: 'Welcome home', actual: 'Welcome home', matched: true },
      ],
    });

    expect(row.evidenceJson).not.toContain('super-secret-password');
  });
});
