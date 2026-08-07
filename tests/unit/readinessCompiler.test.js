import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readiness = require('../../server/services/readinessCompiler');
const { encodeJson } = require('../../server/services/jsonField');

function runnableCase(overrides = {}) {
  return {
    id: 'tc-1',
    projectId: 'project-1',
    name: 'Verify dashboard welcome message',
    type: 'functional',
    module: 'Dashboard',
    confidence: 90,
    status: 'pending',
    assertions: 'Dashboard shows Welcome',
    steps: encodeJson([{ order: 1, action: 'Navigate', target: 'Dashboard' }]),
    declaredAssertions: encodeJson([
      { id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'Welcome' } },
    ]),
    ...overrides,
  };
}

describe('readiness compiler', () => {
  it('keeps approval lifecycle separate from run eligibility for a ready case', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase());

    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.READY);
    expect(compiled.approvalEligibility).toBe(readiness.APPROVAL_ELIGIBILITY.ELIGIBLE);
    expect(compiled.runEligibility).toBe(readiness.RUN_ELIGIBILITY.ALLOWED);
    expect(compiled.sessionMode).toBe(readiness.SESSION_MODE.FRESH);
    expect(compiled.failurePolicy).toBe(readiness.FAILURE_POLICY.CONTINUE_INDEPENDENT);
  });

  it('fails closed when a case references sheet data without an approved mapping version', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase({
      dataBindingJson: encodeJson({
        sheet: 'LoginRows',
        status: 'complete',
        columnToField: { username: 'username' },
      }),
    }));

    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.NEEDS_DATA_CHOICE);
    expect(compiled.runEligibility).toBe(readiness.RUN_ELIGIBILITY.BLOCKED);
    expect(compiled.approvalEligibility).toBe(readiness.APPROVAL_ELIGIBILITY.ELIGIBLE);
    expect(compiled.readinessReasons.map((r) => r.code)).toContain('data_binding_not_approved');
  });

  it('requires durable dependency ids before continuation can run', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase({
      dependsOnNames: ['Login as admin'],
    }));

    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.NEEDS_SESSION_DEPENDENCY);
    expect(compiled.runEligibility).toBe(readiness.RUN_ELIGIBILITY.BLOCKED);
    expect(compiled.readinessReasons.map((r) => r.code)).toContain('depends_on_names_unresolved');
  });

  it('uses continue_from_dependency and block_dependents for declared dependency chains', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase({
      dependsOnIds: encodeJson(['tc-login']),
    }));

    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.READY);
    expect(compiled.sessionMode).toBe(readiness.SESSION_MODE.CONTINUE_FROM_DEPENDENCY);
    expect(compiled.failurePolicy).toBe(readiness.FAILURE_POLICY.BLOCK_DEPENDENTS);
    expect(compiled.dependsOnIds).toEqual(['tc-login']);
  });

  it('derives session requirements from durable state contract JSON fields', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase({
      requiresStateJson: encodeJson([
        { key: 'employeeId', type: 'created_record', scope: 'scenario', sourceCaseId: 'tc-create', required: true },
      ]),
      dependsOnIds: encodeJson(['tc-create']),
    }));

    expect(compiled.sessionMode).toBe(readiness.SESSION_MODE.CONTINUE_FROM_DEPENDENCY);
    expect(compiled.failurePolicy).toBe(readiness.FAILURE_POLICY.BLOCK_DEPENDENTS);
    expect(compiled.requiresState).toMatchObject([
      { key: 'employeeId', type: 'created_record', scope: 'scenario', sourceCaseId: 'tc-create', required: true },
    ]);
    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.READY);
  });

  it('treats Firecrawl-only app capability as discovered context, not runnable proof', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase(), {
      sourceArtifacts: [{
        id: 'artifact-1',
        source: 'firecrawl',
        confidence: 'discovered',
        verifiedByPlaywright: false,
        freshness: 'fresh',
        tenantAllowed: true,
      }],
    });

    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.NEEDS_APP_CLARIFICATION);
    expect(compiled.runEligibility).toBe(readiness.RUN_ELIGIBILITY.BLOCKED);
    expect(compiled.readinessReasons.map((r) => r.code)).toContain('firecrawl_only_capability');
  });

  it('does not allow generic page-ready as the final oracle', () => {
    const compiled = readiness.compileCaseReadiness(runnableCase({
      assertions: 'page ready',
      declaredAssertions: encodeJson([
        { id: 'a1', type: 'TEXT', criticality: 'must', payload: { expectedText: 'page ready' } },
      ]),
    }));

    expect(compiled.readinessStatus).toBe(readiness.READINESS_STATUS.NEEDS_ORACLE);
    expect(compiled.runEligibility).toBe(readiness.RUN_ELIGIBILITY.BLOCKED);
    expect(compiled.readinessReasons.map((r) => r.code)).toContain('generic_page_ready_oracle');
  });

  it('treats readinessStatus as a cached contract that can become stale', () => {
    expect(readiness.isCachedReadinessCurrent({
      readinessStatus: 'ready',
      readinessContractVersion: 'old-version',
      readinessComputedAt: new Date().toISOString(),
    })).toBe(false);
  });
});
