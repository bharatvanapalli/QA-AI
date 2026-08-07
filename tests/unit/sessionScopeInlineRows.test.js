import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { caseEstablishesSessionLive } = require('../../server/lib/sessionScope');

describe('inline row session scope', () => {
  it('marks a compiler-owned per-row inline case as requiring row isolation', () => {
    expect(caseEstablishesSessionLive({
      steps: JSON.stringify([{ action: 'Fill', element: 'Search', value: 'first value' }]),
      rowExecutionPlanJson: JSON.stringify({
        mode: 'inline',
        executionMode: 'per_row',
        rowIds: ['row-001', 'row-002'],
      }),
    })).toBe(true);
  });

  it('does not broaden single-row inline or ordinary non-login cases', () => {
    expect(caseEstablishesSessionLive({
      steps: JSON.stringify([{ action: 'Fill', element: 'Search', value: 'only value' }]),
      rowExecutionPlanJson: JSON.stringify({
        mode: 'inline',
        executionMode: 'single',
        rowIds: ['row-001'],
      }),
    })).toBe(false);
    expect(caseEstablishesSessionLive({
      steps: JSON.stringify([{ action: 'Fill', element: 'Search', value: 'ordinary' }]),
    })).toBe(false);
  });
});
