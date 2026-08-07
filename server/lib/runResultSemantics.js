'use strict';

function combinedText(row) {
  return [
    row?.status,
    row?.error,
    row?.blockedReason,
    row?.mechanicalVerdictReason,
  ].filter(Boolean).join(' ').toLowerCase();
}

function isNonExecutionPlaceholderResult(row) {
  const status = String(row?.status || '').toLowerCase();
  if (status !== 'skipped') return false;
  const text = combinedText(row);
  return (
    text.includes('did not run') ||
    text.includes('run_cancelled') ||
    text.includes('before this case executed') ||
    text.includes('before this data row executed') ||
    text.includes('row_not_run') ||
    text.includes('not individually executed') ||
    text.includes('never executed')
  );
}

function hasRealExecutionResult(row) {
  return !!row && !isNonExecutionPlaceholderResult(row);
}

function nonExecutionPlaceholderWhere({ runId, testCaseIds } = {}) {
  const where = {
    status: 'skipped',
    OR: [
      { error: { contains: 'did not run' } },
      { error: { contains: 'run_cancelled' } },
      { error: { contains: 'before this case executed' } },
      { error: { contains: 'before this data row executed' } },
      { blockedReason: 'row_not_run' },
      { mechanicalVerdictReason: { contains: 'not individually executed' } },
      { mechanicalVerdictReason: { contains: 'never executed' } },
    ],
  };
  if (runId) where.runId = runId;
  if (Array.isArray(testCaseIds) && testCaseIds.length) {
    where.testCaseId = { in: testCaseIds };
  }
  return where;
}

module.exports = {
  isNonExecutionPlaceholderResult,
  hasRealExecutionResult,
  nonExecutionPlaceholderWhere,
};
