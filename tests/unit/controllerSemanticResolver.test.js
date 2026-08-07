import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const resolver = require('../../server/services/controllerSemanticResolver');

const target = {
  accessibleName: 'Email address',
  role: 'textbox',
  framePath: ['top'],
  form: 'Authentication',
  section: 'Sign in',
  controlType: 'email',
};

describe('controller semantic resolver', () => {
  it('correlates DOM AX and CDP facts for the same backend node', () => {
    const result = resolver.resolveSemanticTarget({
      targetIdentity: target,
      browserEpoch: 'epoch-1',
      candidates: [{
        source: 'dom',
        browserEpoch: 'epoch-1',
        ref: 'e1',
        identity: { ...target, backendNodeId: 42 },
        connected: true,
        visible: true,
        factRef: 'dom:42',
      }, {
        source: 'ax',
        browserEpoch: 'epoch-1',
        identity: { ...target, backendNodeId: 42 },
        connected: true,
        actionable: true,
        factRef: 'ax:42',
      }],
    });
    expect(result).toMatchObject({
      status: resolver.RESOLUTION_STATUS.RESOLVED,
      target: {
        ref: 'e1',
        sources: ['dom', 'ax'],
        actionable: true,
      },
      factRefs: ['dom:42', 'ax:42'],
    });
  });

  it('uses section identity to distinguish repeated labels', () => {
    const result = resolver.resolveSemanticTarget({
      targetIdentity: { ...target, accessibleName: 'Date', section: 'Pickup' },
      candidates: [{
        source: 'dom',
        identity: { ...target, accessibleName: 'Date', section: 'Pickup', backendNodeId: 1 },
        connected: true,
      }, {
        source: 'dom',
        identity: { ...target, accessibleName: 'Date', section: 'Delivery', backendNodeId: 2 },
        connected: true,
      }],
    });
    expect(result).toMatchObject({
      status: resolver.RESOLUTION_STATUS.RESOLVED,
      target: { identity: { section: 'Pickup', backendNodeId: '1' } },
    });
  });

  it('promotes an inner input to the authored owner identity without mutating', () => {
    const result = resolver.resolveSemanticTarget({
      targetIdentity: {
        accessibleName: 'Equipment',
        role: 'combobox',
        section: 'Order',
      },
      candidates: [{
        source: 'playwright',
        ref: 'inner-input',
        identity: {
          accessibleName: 'Equipment',
          role: 'textbox',
          section: 'Order',
          backendNodeId: 8,
        },
        ownerIdentity: {
          accessibleName: 'Equipment',
          role: 'combobox',
          section: 'Order',
          backendNodeId: 7,
        },
        connected: true,
        actionable: true,
      }],
    });
    expect(result).toMatchObject({
      status: resolver.RESOLUTION_STATUS.RESOLVED,
      reason: 'exact_semantic_owner_resolved',
      target: {
        promotedFromInnerControl: true,
        identity: { role: 'combobox', backendNodeId: '7' },
      },
    });
  });

  it('returns ambiguity instead of choosing between duplicate exact controls', () => {
    const result = resolver.resolveSemanticTarget({
      targetIdentity: { accessibleName: 'Continue', role: 'button' },
      candidates: [{
        source: 'dom',
        identity: { accessibleName: 'Continue', role: 'button', backendNodeId: 1 },
        connected: true,
      }, {
        source: 'dom',
        identity: { accessibleName: 'Continue', role: 'button', backendNodeId: 2 },
        connected: true,
      }],
    });
    expect(result.status).toBe(resolver.RESOLUTION_STATUS.AMBIGUOUS);
  });

  it('returns stale when the exact target belongs to an older browser epoch', () => {
    const result = resolver.resolveSemanticTarget({
      targetIdentity: { accessibleName: 'Sign in', role: 'button' },
      browserEpoch: 'epoch-2',
      candidates: [{
        source: 'ax',
        browserEpoch: 'epoch-1',
        identity: { accessibleName: 'Sign in', role: 'button', backendNodeId: 9 },
        connected: true,
      }],
    });
    expect(result.status).toBe(resolver.RESOLUTION_STATUS.STALE);
  });
});
