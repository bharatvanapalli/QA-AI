import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const readinessCompiler = require('../../server/services/readinessCompiler');
const { encodeJson } = require('../../server/services/jsonField');
const {
  BULK_APPROVAL_DISPOSITION,
  bulkApprovalDisposition,
  bulkApprovalReportEntry,
} = require('../../server/services/bulkApprovalPolicy');

const ready = {
  readinessStatus: readinessCompiler.READINESS_STATUS.READY,
  approvalEligibility: readinessCompiler.APPROVAL_ELIGIBILITY.ELIGIBLE,
  runEligibility: readinessCompiler.RUN_ELIGIBILITY.ALLOWED,
  readinessReasons: [],
};

describe('bulk approval policy', () => {
  it('approves only a freshly compiled ready and runnable case', () => {
    expect(bulkApprovalDisposition(ready)).toBe(BULK_APPROVAL_DISPOSITION.APPROVE);

    expect(bulkApprovalDisposition({
      ...ready,
      runEligibility: readinessCompiler.RUN_ELIGIBILITY.BLOCKED,
    })).toBe(BULK_APPROVAL_DISPOSITION.NOT_RUNNABLE);

    expect(bulkApprovalDisposition({
      ...ready,
      readinessStatus: readinessCompiler.READINESS_STATUS.NEEDS_REVIEW,
    })).toBe(BULK_APPROVAL_DISPOSITION.NOT_RUNNABLE);

    expect(bulkApprovalDisposition({
      ...ready,
      approvalEligibility: readinessCompiler.APPROVAL_ELIGIBILITY.NEEDS_REVIEW,
    })).toBe(BULK_APPROVAL_DISPOSITION.NOT_RUNNABLE);

    expect(bulkApprovalDisposition(null)).toBe(BULK_APPROVAL_DISPOSITION.NOT_RUNNABLE);
  });

  it('fails closed when readiness or approval is explicitly blocked', () => {
    expect(bulkApprovalDisposition({
      ...ready,
      readinessStatus: readinessCompiler.READINESS_STATUS.BLOCKED,
    })).toBe(BULK_APPROVAL_DISPOSITION.BLOCKED);

    expect(bulkApprovalDisposition({
      ...ready,
      approvalEligibility: readinessCompiler.APPROVAL_ELIGIBILITY.BLOCKED,
    })).toBe(BULK_APPROVAL_DISPOSITION.BLOCKED);
  });

  it('holds back a real compiler result that is approval-eligible but not runnable', () => {
    const compiled = readinessCompiler.compileCaseReadiness({
      id: 'tc-data',
      projectId: 'project-1',
      name: 'Verify dashboard welcome message',
      status: 'pending',
      assertions: 'Dashboard shows Welcome',
      steps: encodeJson([{ order: 1, action: 'Navigate', target: 'Dashboard' }]),
      declaredAssertions: encodeJson([
        { id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Welcome' } },
      ]),
      dataBindingJson: encodeJson({
        sheet: 'LoginRows',
        status: 'complete',
        columnToField: { username: 'username' },
      }),
    });

    expect(compiled.approvalEligibility).toBe(readinessCompiler.APPROVAL_ELIGIBILITY.ELIGIBLE);
    expect(compiled.runEligibility).toBe(readinessCompiler.RUN_ELIGIBILITY.BLOCKED);
    expect(bulkApprovalDisposition(compiled)).toBe(BULK_APPROVAL_DISPOSITION.NOT_RUNNABLE);
  });

  it('reports the compiled eligibility fields for every held-back case', () => {
    const reason = { code: 'data_binding_not_approved', severity: 'error' };
    expect(bulkApprovalReportEntry(
      { id: 'tc-1', name: 'Bound case' },
      {
        readinessStatus: readinessCompiler.READINESS_STATUS.NEEDS_DATA_CHOICE,
        approvalEligibility: readinessCompiler.APPROVAL_ELIGIBILITY.ELIGIBLE,
        runEligibility: readinessCompiler.RUN_ELIGIBILITY.BLOCKED,
        readinessReasons: [reason],
      },
    )).toEqual({
      id: 'tc-1',
      name: 'Bound case',
      readinessStatus: readinessCompiler.READINESS_STATUS.NEEDS_DATA_CHOICE,
      approvalEligibility: readinessCompiler.APPROVAL_ELIGIBILITY.ELIGIBLE,
      runEligibility: readinessCompiler.RUN_ELIGIBILITY.BLOCKED,
      reasons: [reason],
    });
  });

  it('applies the shared policy in both bulk approval routes', () => {
    const source = readFileSync(resolve(process.cwd(), 'server/routes/testCases.js'), 'utf8');
    expect(source.match(/const disposition = bulkApprovalDisposition\(readiness\);/g)).toHaveLength(2);
    expect(source.match(/id: \{ in: approvableIds \}/g)).toHaveLength(2);
  });
});
