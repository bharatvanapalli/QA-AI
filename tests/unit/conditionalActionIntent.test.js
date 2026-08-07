import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  isPresenceConditionalAction,
  conditionalActionRequiredByContract,
} = require('../../server/services/conditionalActionIntent');

describe('conditionalActionIntent', () => {
  it.each([
    { optional: true },
    { ifVisible: true },
    { ifPresent: true },
    { whenVisible: true },
    { whenPresent: true },
    { required: false },
    { proofRequired: false },
    { condition: { predicate: 'target is visible', onFalse: 'skip' } },
    { when: { description: 'prompt is present', onFalse: 'skip' } },
    { description: 'Dismiss the prompt if it is visible' },
  ])('recognizes presence-conditional action intent %#', (source) => {
    expect(isPresenceConditionalAction(source)).toBe(true);
  });

  it('recognizes conditional intent nested in runtime contract layers', () => {
    expect(isPresenceConditionalAction({
      metadata: {
        payload: {
          operationCheck: { whenPresent: true },
        },
      },
    })).toBe(true);
  });

  it.each([
    { contractRequired: true },
    { requiredEvenIfAbsent: true },
    { requiredForFlow: true },
    { flowCritical: true },
    { requiredForContinuation: true },
    { blocking: true },
    { contract: { required: true } },
    { contract: { proofRequired: true } },
    { metadata: { contract: { requiredForContinuation: true } } },
  ])('honors explicit required override %#', (source) => {
    expect(conditionalActionRequiredByContract(source)).toBe(true);
  });

  it('keeps ordinary and optional non-required actions separate', () => {
    expect(isPresenceConditionalAction({ action: 'Click', target: 'Save' })).toBe(false);
    expect(conditionalActionRequiredByContract({ whenVisible: true, required: false })).toBe(false);
  });
});
