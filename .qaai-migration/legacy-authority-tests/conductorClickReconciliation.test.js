import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const conductor = require('../../server/services/agents/conductorPinned');
const pageFingerprint = require('../../server/services/pageFingerprint');
const { resolveSnapshotElement } = require('../../server/services/clickTargetResolver');

describe('Conductor website-neutral click reconciliation', () => {
  it('reconciles a provider-qualified authored label with one contextual generic live button', () => {
    const snapshot = [
      '- main "Account access"',
      '  - region "Company Provider"',
      '    - text "Continue with Company Provider"',
      '    - button "Sign in" [ref=company-provider-sign-in]',
      '  - region "Local account"',
      '    - button "Back" [ref=back]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Sign in with Company Provider',
    })).toMatchObject({
      ok: true,
      ref: 'company-provider-sign-in',
      control: {
        ref: 'company-provider-sign-in',
        role: 'button',
        name: 'Sign in',
      },
      reason: 'clickable_control_resolved',
    });
  });

  it('resolves one strong generic live name even when authored page scope is absent locally', () => {
    const snapshot = '- button "Sign in" [ref=account-sign-in]';

    const resolution = conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Sign in button on Account access page',
    });

    expect(resolution).toMatchObject({
      ok: true,
      ref: 'account-sign-in',
      control: {
        role: 'button',
        name: 'Sign in',
      },
      evidence: {
        roleHint: 'button',
        roleMatch: true,
        contextHitCount: 0,
      },
      diagnostics: {
        contract: {
          identityTokenCount: 2,
          contextTokenCount: 2,
          roleHint: 'button',
          hasScopeClause: true,
        },
        considered: [{ role: 'button', disabled: false }],
        rejected: [],
        scored: [{ role: 'button', nameHitCount: 2, contextHitCount: 0 }],
      },
    });
    expect(JSON.stringify(resolution.diagnostics)).not.toContain('Sign in');
    expect(JSON.stringify(resolution.diagnostics)).not.toContain('Account access');
  });

  it('uses authored scope context to choose between duplicate generic live names', () => {
    const snapshot = [
      '- region "Account access"',
      '  - button "Sign in" [ref=account-sign-in]',
      '- region "Guest access"',
      '  - button "Sign in" [ref=guest-sign-in]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Sign in button on Account access page',
    })).toMatchObject({
      ok: true,
      ref: 'account-sign-in',
      confidenceMargin: 25,
      evidence: {
        contextHitCount: 2,
      },
    });
  });

  it('keeps duplicate generic live names ambiguous when scope context is unavailable', () => {
    const snapshot = [
      '- button "Sign in" [ref=sign-in-one]',
      '- button "Sign in" [ref=sign-in-two]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Sign in button on Account access page',
    })).toMatchObject({
      ok: false,
      ref: null,
      reason: 'ambiguous_clickable_control',
      candidates: [
        { ref: 'sign-in-one', role: 'button' },
        { ref: 'sign-in-two', role: 'button' },
      ],
    });
  });

  it('uses an explicit authored widget role to break a button-versus-link tie', () => {
    const snapshot = [
      '- link "Sign in" [ref=sign-in-link]',
      '- button "Sign in" [ref=sign-in-button]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Sign in button on Account access page',
    })).toMatchObject({
      ok: true,
      ref: 'sign-in-button',
      confidenceMargin: 30,
      control: {
        role: 'button',
        name: 'Sign in',
      },
      evidence: {
        roleHint: 'button',
        roleMatch: true,
      },
    });
  });

  it('returns ambiguous when equal live candidates have the same semantic and structural evidence', () => {
    const snapshot = [
      '- region "Company Provider"',
      '  - text "Continue with Company Provider"',
      '  - button "Sign in" [ref=provider-sign-in-one]',
      '  - button "Sign in" [ref=provider-sign-in-two]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Sign in with Company Provider',
    })).toMatchObject({
      ok: false,
      ref: null,
      control: null,
      reason: 'ambiguous_clickable_control',
      candidates: [
        { ref: 'provider-sign-in-one' },
        { ref: 'provider-sign-in-two' },
      ],
    });
  });

  it('resolves an exact authored and live accessible name', () => {
    const snapshot = [
      '- heading "Workspace access"',
      '- button "Continue to workspace" [ref=continue-to-workspace]',
      '- button "Cancel" [ref=cancel]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Continue to workspace',
    })).toMatchObject({
      ok: true,
      ref: 'continue-to-workspace',
      control: {
        ref: 'continue-to-workspace',
        role: 'button',
        name: 'Continue to workspace',
      },
      reason: 'clickable_control_resolved',
    });
  });

  it('rejects a disabled control even when its accessible name is an exact match', () => {
    const snapshot = [
      '- heading "Workspace access"',
      '- button "Continue to workspace" [disabled] [ref=disabled-continue]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Continue to workspace',
    })).toMatchObject({
      ok: false,
      ref: null,
      control: null,
      reason: 'no_clickable_control',
    });
  });

  it('resolves a custom combobox trigger as a clickable control', () => {
    const snapshot = [
      '- textbox "Order Number" [ref=order-number]',
      '- combobox "Equipment" [ref=equipment-trigger]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Equipment dropdown',
    })).toMatchObject({
      ok: true,
      ref: 'equipment-trigger',
      control: { role: 'combobox', name: 'Equipment' },
    });
  });

  it('does not resolve a similarly named number field for a date target', () => {
    const snapshot = [
      '- textbox "Early Pickup Number" [ref=pickup-number]',
      '- textbox "Early Pickup Date" [ref=pickup-date]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Early Pickup Date calendar',
    })).toMatchObject({
      ok: true,
      ref: 'pickup-date',
      control: { role: 'textbox', name: 'Early Pickup Date' },
    });
  });

  it('uses an isolated structural label for an accessibility-unnamed editable click target', () => {
    const snapshot = [
      '- text "Early Pickup Date"',
      '- textbox "" [ref=early-pickup-date]',
      '- text "Late Pickup Date"',
      '- textbox "" [ref=late-pickup-date]',
    ].join('\n');

    expect(conductor._resolveClickableControl(snapshot, {
      authoredLabel: 'Early Pickup Date calendar',
      role: 'textbox',
    })).toMatchObject({
      ok: true,
      ref: 'early-pickup-date',
      control: { role: 'textbox', name: '' },
    });
  });

  it('resolves a non-interactive section target for scroll utilities without pretending it is clickable', () => {
    const snapshot = [
      '- heading "General Information" [ref=general-information]',
      '- region "References" [ref=references-section]',
      '- region "Pickup and Delivery" [ref=pickup-delivery-section]',
    ].join('\n');

    expect(resolveSnapshotElement(snapshot, {
      authoredLabel: 'References section',
    })).toMatchObject({
      ok: true,
      ref: 'references-section',
      control: { role: 'region', name: 'References' },
      reason: 'snapshot_element_resolved',
    });
  });

  it('recognizes an already-reached transition only from declared structured state and fingerprints', () => {
    const beforeFingerprint = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example.test/access',
      title: 'Account access',
      primaryHeading: 'Choose a workspace',
      controls: [{ role: 'button', name: 'Open workspace' }],
    });
    const currentFingerprint = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example.test/workspace',
      title: 'Team Workspace',
      primaryHeading: 'Projects',
      controls: [{ role: 'button', name: 'New project' }],
    });

    expect(conductor._genericTransitionAlreadySatisfied({
      step: {
        action: 'Click',
        element: 'Open workspace',
        operationCheck: {
          kind: 'page_ready',
          expectedState: {
            urlPattern: '/workspace',
            titleIncludes: 'Workspace',
            visibleText: 'Projects',
            control: { role: 'button', name: 'New project' },
          },
        },
      },
      beforeFingerprint,
      currentFingerprint,
    })).toMatchObject({
      satisfied: true,
      reason: 'declared_transition_already_satisfied',
    });
  });

  it('does not infer transition completion from page change without matching declared state', () => {
    const beforeFingerprint = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example.test/access',
      title: 'Account access',
      primaryHeading: 'Choose a workspace',
      controls: [{ role: 'button', name: 'Open workspace' }],
    });
    const currentFingerprint = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example.test/workspace',
      title: 'Team Workspace',
      primaryHeading: 'Projects',
      controls: [{ role: 'button', name: 'New project' }],
    });

    expect(conductor._genericTransitionAlreadySatisfied({
      step: {
        action: 'Click',
        element: 'Open settings',
        operationCheck: {
          kind: 'page_ready',
          expectedState: {
            urlPattern: '/settings',
            titleIncludes: 'Settings',
            visibleText: 'Billing',
            control: { role: 'button', name: 'Save settings' },
          },
        },
      },
      beforeFingerprint,
      currentFingerprint,
    })).toMatchObject({
      satisfied: false,
      reason: 'transition_not_proven',
    });
  });

  it('uses the concrete visible name when an authored destination adds a generic page suffix', () => {
    const currentFingerprint = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example.test/orders',
      title: 'Orders',
      primaryHeading: 'Orders',
      controls: [{ role: 'button', name: 'Create Order' }],
    });

    expect(conductor._genericTransitionAlreadySatisfied({
      step: {
        action: 'AssertVisible',
        verify: { kind: 'visible', element: { name: 'Orders page' } },
      },
      currentFingerprint,
    })).toMatchObject({
      satisfied: true,
      reason: 'declared_transition_already_satisfied',
    });
  });

  it('does not treat a navigation label as proof that the destination page is already open', () => {
    const currentFingerprint = pageFingerprint.buildPageFingerprint({
      url: 'https://app.example.test/home',
      title: 'Home',
      primaryHeading: 'Home',
      controls: [{ role: 'link', name: 'Orders' }],
    });

    expect(conductor._genericTransitionAlreadySatisfied({
      step: {
        action: 'AssertVisible',
        verify: { kind: 'visible', element: { name: 'Orders page' } },
      },
      currentFingerprint,
    })).toMatchObject({
      satisfied: false,
      reason: 'transition_not_proven',
    });
  });
});
