import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  exactNextAuthoredActionControl,
  firstLaterActionOperation,
  firstLaterSemanticOperation,
  exactAuthoredDestinationReached,
  exactLaterAuthoredAssertion,
  exactNextRequiredControl,
  exactPageTransitionCommitted,
  exactWaitStateReached,
  minimumCandidateCountForObservation,
  popupAssociationEvidence,
} = require('../../server/services/controllerMcpRuntimeAdapter');

const wait = {
  operationId: 'wait:options',
  kind: 'synchronization',
  type: 'WaitForState',
  targetIdentity: { accessibleName: 'options page' },
};
const signInAssertion = {
  operationId: 'assertion:sign-in',
  kind: 'assertion',
  type: 'AssertVisible',
  targetIdentity: { role: 'button', accessibleName: 'Sign in with Microsoft' },
};
const laterEmail = {
  operationId: 'action:microsoft-email',
  kind: 'action',
  type: 'Fill',
  targetIdentity: { role: 'textbox', accessibleName: 'Email Address' },
};
const createOrder = {
  operationId: 'action:orders:create',
  kind: 'action',
  type: 'Click',
  targetIdentity: { role: 'button', accessibleName: 'Create Order' },
};

describe('controller MCP next-control proof', () => {
  it('uses the first later action control and skips waits and assertions', () => {
    expect(firstLaterSemanticOperation([wait, signInAssertion, laterEmail]))
      .toBe(signInAssertion);
    expect(exactNextRequiredControl({
      phase: 'post_dispatch',
      ownerVisible: false,
      laterOperations: [wait, signInAssertion, laterEmail],
      candidates: [{
        ref: 'current-email',
        role: 'textbox',
        accessibleName: 'Email Address',
      }],
    })).toBe(true);
  });

  it('accepts the exact first later control after dispatch', () => {
    expect(exactNextRequiredControl({
      phase: 'post_dispatch',
      ownerVisible: false,
      laterOperations: [wait, signInAssertion, laterEmail],
      candidates: [{
        ref: 'current-email',
        role: 'textbox',
        accessibleName: 'Email Address',
      }],
    })).toBe(true);
  });

  it('uses the first later authored action for navigation-menu proof', () => {
    const ordersPageAssertion = {
      operationId: 'assertion:orders-page',
      kind: 'assertion',
      type: 'AssertVisible',
      targetIdentity: { accessibleName: 'Orders page' },
    };
    expect(firstLaterActionOperation([wait, ordersPageAssertion, createOrder, laterEmail]))
      .toBe(createOrder);
    expect(exactNextAuthoredActionControl({
      phase: 'post_dispatch',
      ownerVisible: true,
      laterOperations: [wait, ordersPageAssertion, createOrder, laterEmail],
      candidates: [{
        ref: 'create-order',
        role: 'button',
        accessibleName: 'Create Order',
      }],
    })).toBe(true);
  });

  it('does not jump past an earlier authored action to a convenient later control', () => {
    expect(exactNextAuthoredActionControl({
      phase: 'post_dispatch',
      ownerVisible: true,
      laterOperations: [wait, createOrder, laterEmail],
      candidates: [{
        ref: 'email',
        role: 'textbox',
        accessibleName: 'Email Address',
      }],
    })).toBe(false);
  });

  it('does not pre-commit while the current action owner is still visible', () => {
    expect(exactNextRequiredControl({
      phase: 'pre_dispatch',
      ownerVisible: true,
      laterOperations: [signInAssertion],
      candidates: [{
        ref: 'sign-in',
        role: 'button',
        accessibleName: 'Sign in with Microsoft',
      }],
    })).toBe(false);
  });

  it('does not mistake a visible source control for an already reached destination', () => {
    const operation = {
      type: 'Click',
      targetIdentity: {
        accessibleName: 'Orders',
      },
      destination: 'Orders',
    };
    const snapshotText = [
      '- link "Orders" [ref=e93]',
      '- button "Go to Orders" [ref=e283]',
    ].join('\n');

    expect(exactAuthoredDestinationReached({
      operation,
      phase: 'pre_dispatch',
      ownerVisible: true,
      snapshotText,
    })).toBe(false);
    expect(exactAuthoredDestinationReached({
      operation,
      phase: 'post_dispatch',
      ownerVisible: true,
      snapshotText,
    })).toBe(true);
  });

  it('does not let an unrelated later control satisfy an authored wait', () => {
    expect(exactWaitStateReached({
      operation: {
        type: 'WaitForState',
        targetIdentity: {
          role: 'button',
          accessibleName: 'Sign in with Microsoft',
        },
        destination: { url: '/auth/msal-login' },
      },
      snapshotText: '- Page URL: https://example.test/email\n- textbox "Email Address" [ref=e1]',
      candidates: [{
        ref: 'e1',
        role: 'textbox',
        accessibleName: 'Email Address',
      }],
    })).toBe(false);
  });

  it('uses an exact downstream authored assertion to finish synchronization', () => {
    expect(exactLaterAuthoredAssertion({
      laterOperations: [{
        operationId: 'assertion:welcome',
        kind: 'assertion',
        type: 'AssertVisible',
        targetIdentity: {
          accessibleName: 'visible text "Welcome OdysseyOne!"',
        },
      }],
      snapshotText: '- heading "Welcome OdysseyOne!" [ref=e158]',
      candidates: [{
        ref: 'e158',
        role: 'heading',
        accessibleName: 'Welcome OdysseyOne!',
      }],
    })).toBe(true);
  });

  it('treats inspect-current-page waits as one fresh observation', () => {
    expect(exactWaitStateReached({
      operation: {
        type: 'WaitForState',
        targetIdentity: {
          accessibleName: 'Inspect the current page for a Stay signed in prompt',
        },
      },
      snapshotText: '- heading "Home" [ref=e1]',
      candidates: [{
        ref: 'e1',
        role: 'heading',
        accessibleName: 'Home',
      }],
    })).toBe(true);
  });

  it('accepts only the authored wait target or destination', () => {
    expect(exactWaitStateReached({
      operation: {
        type: 'WaitForState',
        targetIdentity: {
          role: 'button',
          accessibleName: 'Sign in with Microsoft',
        },
        destination: { url: '/auth/msal-login' },
      },
      snapshotText: '- Page URL: https://example.test/auth/msal-login\n- button "Sign in with Microsoft" [ref=e2]',
      candidates: [{
        ref: 'e2',
        role: 'button',
        accessibleName: 'Sign in with Microsoft',
      }],
    })).toBe(true);
  });

  it('proves a page-ready click from a changed URL only after the exact prior owner disappears', () => {
    const operation = {
      type: 'Click',
      operationCheck: {
        kind: 'page_ready',
      },
    };
    expect(exactPageTransitionCommitted({
      operation,
      phase: 'post_dispatch',
      ownerVisible: false,
      preDispatchObservation: { url: 'https://example.test/password' },
      currentUrl: 'https://example.test/dashboard',
    })).toBe(true);
    expect(exactPageTransitionCommitted({
      operation,
      phase: 'post_dispatch',
      ownerVisible: true,
      preDispatchObservation: { url: 'https://example.test/password' },
      currentUrl: 'https://example.test/dashboard',
    })).toBe(false);
  });

  it('does not use a generic URL change to prove a non-navigation control action', () => {
    expect(exactPageTransitionCommitted({
      operation: {
        type: 'Click',
        operationCheck: {
          kind: 'menu_opened',
        },
      },
      phase: 'post_dispatch',
      ownerVisible: false,
      preDispatchObservation: { url: 'https://example.test/form' },
      currentUrl: 'https://example.test/form?menu=open',
    })).toBe(false);
  });

  it('allows a URL-only snapshot only for post-dispatch page-ready reconciliation', () => {
    const operation = {
      type: 'Click',
      operationCheck: {
        kind: 'page_ready',
      },
    };
    expect(minimumCandidateCountForObservation(operation, 'post_dispatch')).toBe(0);
    expect(minimumCandidateCountForObservation(operation, 'pre_dispatch')).toBe(1);
    expect(minimumCandidateCountForObservation({
      ...operation,
      operationCheck: {
        kind: 'menu_opened',
      },
    }, 'post_dispatch')).toBe(1);
  });

  it('correlates a popup only when the exact owner controls its visible surface', () => {
    expect(popupAssociationEvidence({
      phase: 'post_dispatch',
      ownerRef: 'equipment-owner',
      ownerExpanded: true,
      popupCandidates: [{
        ref: 'ltl-option',
        role: 'option',
        accessibleName: 'LTL',
      }],
      popupOwnershipReadback: {
        ok: true,
        controlledPopupCount: 1,
      },
    })).toMatchObject({
      matched: true,
      reason: 'exact_owner_controls_visible_popup',
      newPopupCandidateCount: 0,
    });
  });

  it('does not treat an expanded owner plus an unrelated popup as ownership proof', () => {
    expect(popupAssociationEvidence({
      phase: 'post_dispatch',
      ownerRef: 'equipment-owner',
      ownerExpanded: true,
      popupCandidates: [{
        ref: 'unrelated-empty-option',
        role: 'option',
        accessibleName: 'No results found',
      }],
      popupOwnershipReadback: {
        ok: true,
        controlledPopupCount: 0,
      },
    })).toMatchObject({
      matched: false,
      reason: 'expanded_owner_popup_relationship_unproven',
    });
  });

  it('does not correlate an unchanged unrelated popup surface', () => {
    const popup = {
      ref: 'unrelated-option',
      role: 'option',
      accessibleName: 'Unrelated',
    };
    expect(popupAssociationEvidence({
      phase: 'post_dispatch',
      ownerRef: 'equipment-owner',
      ownerExpanded: false,
      popupCandidates: [popup],
      preDispatchObservation: { candidates: [popup] },
    })).toMatchObject({
      matched: false,
      reason: 'popup_owner_correlation_unavailable',
    });
  });

  it('lets explicit wrong-owner metadata veto temporal popup correlation', () => {
    expect(popupAssociationEvidence({
      phase: 'post_dispatch',
      ownerRef: 'equipment-owner',
      ownerExpanded: false,
      popupCandidates: [{
        ref: 'ltl-option',
        role: 'option',
        accessibleName: 'LTL',
        ownerRef: 'freight-term-owner',
      }],
      preDispatchObservation: { candidates: [] },
    })).toMatchObject({
      matched: false,
      reason: 'popup_explicitly_owned_by_different_control',
    });
  });
});
