import { describe, expect, it } from 'vitest';

const {
  hasRealExecutionResult,
  isNonExecutionPlaceholderResult,
  nonExecutionPlaceholderWhere,
} = require('../../server/lib/runResultSemantics');

describe('runResultSemantics', () => {
  it('treats cancelled-before-execution skipped rows as runnable placeholders', () => {
    expect(isNonExecutionPlaceholderResult({
      status: 'skipped',
      error: 'Run cancelled by user before this case executed - run_cancelled.',
    })).toBe(true);
    expect(hasRealExecutionResult({
      status: 'skipped',
      error: 'Run cancelled by user before this case executed - run_cancelled.',
    })).toBe(false);
  });

  it('does not treat real failed or blocked outcomes as placeholders', () => {
    expect(isNonExecutionPlaceholderResult({
      status: 'fail',
      error: 'Save button did not create the employee.',
    })).toBe(false);
    expect(hasRealExecutionResult({
      status: 'blocked',
      blockedReason: 'locator_not_found',
    })).toBe(true);
  });

  it('builds a Prisma where clause that deletes all non-execution placeholders', () => {
    expect(nonExecutionPlaceholderWhere({ runId: 'run-1', testCaseIds: ['tc-1'] })).toEqual({
      runId: 'run-1',
      testCaseId: { in: ['tc-1'] },
      status: 'skipped',
      OR: expect.arrayContaining([
        { error: { contains: 'did not run' } },
        { error: { contains: 'run_cancelled' } },
        { blockedReason: 'row_not_run' },
      ]),
    });
  });
});
