import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const conductor = require('../../server/services/agents/conductor.js');

const derive = conductor._declaredAssertionsFromExecutionContract;

describe('declaredAssertionsFromExecutionContract', () => {
  it('derives only assertion nodes with stable identities and normalized contracts', () => {
    const result = derive({
      nodes: [
        {
          kind: 'action',
          contractStepId: 'case:step:1',
          raw: { type: 'TEXT', payload: { expectedText: 'must not leak' } },
        },
        {
          kind: 'assertion',
          assertionId: 'ASN-primary',
          persistedAssertionId: 'ASN-persisted',
          contractStepId: 'case:assertion:1',
          raw: {
            type: 'url_state',
            criticality: 'SHOULD',
            payload: { expectedUrlPattern: '/dashboard' },
          },
          expectedOutcome: { expected: '/dashboard' },
        },
        {
          kind: 'assertion',
          persistedAssertionId: 'ASN-secondary',
          contractStepId: 'case:assertion:2',
          plannedText: 'Welcome is visible',
          expectedKind: 'visible_text',
          expectedOutcome: { expected: 'Welcome' },
          raw: {},
        },
        {
          kind: 'assertion',
          contractStepId: 'case:assertion:3',
          plannedText: 'Account panel is visible',
          expectedKind: 'element-visible',
          expectedOutcome: { expected: 'Account panel' },
          raw: { criticality: 'not-a-tier' },
        },
      ],
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'ASN-primary',
        type: 'URL',
        criticality: 'should',
        payload: { expectedUrlPattern: '/dashboard' },
      }),
      expect.objectContaining({
        id: 'ASN-secondary',
        type: 'TEXT',
        criticality: 'must',
        payload: { expectedText: 'Welcome' },
      }),
      expect.objectContaining({
        id: 'case:assertion:3',
        type: 'VISIBLE',
        criticality: 'must',
        payload: { target: 'Account panel' },
      }),
    ]);
  });
});
