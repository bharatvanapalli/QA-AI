import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dependencyGraph = require('../../server/services/dependencyGraph.js');
const { resolveCaseDependencyClosure } = require('../../server/services/caseDependencyClosure.js');
const sessionRegistry = require('../../server/services/sessionRegistry.js');
const authSessions = require('../../server/services/universalAuthSessionManager.js');

beforeEach(() => {
  sessionRegistry.sessions.clear();
  sessionRegistry.groupLeases.clear();
});

describe('website-neutral dependency and session continuity', () => {
  it('orders an explicit DAG deterministically without inventing or dropping cases', () => {
    const authored = [
      { id: 'independent', dependsOnIds: [] },
      { id: 'dependent', dependsOnIds: ['prerequisite'] },
      { id: 'prerequisite', dependsOnIds: [] },
    ];
    const ordered = dependencyGraph.orderCases(authored);
    expect(ordered.cycle).toBeNull();
    expect(ordered.cases.map((item) => item.id)).toEqual(['independent', 'prerequisite', 'dependent']);
    expect(new Set(ordered.cases)).toEqual(new Set(authored));
  });

  it('derives one stable continuity group from explicit dependency roots', () => {
    const graph = dependencyGraph.buildGraph([
      { id: 'login', dependsOnIds: [] },
      { id: 'shipment', dependsOnIds: ['login'] },
      { id: 'confirmation', dependsOnIds: ['shipment'] },
    ]);
    expect(dependencyGraph.dependencyRootIds('login', graph)).toEqual(['login']);
    expect(dependencyGraph.dependencyRootIds('shipment', graph)).toEqual(['login']);
    expect(dependencyGraph.dependencyRootIds('confirmation', graph)).toEqual(['login']);
    expect(dependencyGraph.continuityGroupId('confirmation', graph)).toBe('dependency-group:login');
  });

  it('reports a cycle without reordering authored cases or creating a blocker', async () => {
    const authored = [
      { id: 'case-a', projectId: 'project-1', dependsOnIds: ['case-b'] },
      { id: 'case-b', projectId: 'project-1', dependsOnIds: ['case-a'] },
    ];
    const prisma = {
      testCase: {
        findMany: vi.fn(async ({ where }) => authored.filter((item) => where.id.in.includes(item.id)).reverse()),
      },
    };
    const closure = await resolveCaseDependencyClosure({ prisma, projectId: 'project-1', caseIds: ['case-a', 'case-b'] });
    expect(closure.caseIds).toEqual(['case-a', 'case-b']);
    expect(closure.cycle).toEqual(expect.arrayContaining(['case-a', 'case-b']));
    expect(closure.findings).toContainEqual(expect.objectContaining({
      code: 'dependency_cycle',
      severity: 'warning',
      nonBlocking: true,
    }));
  });

  it('blocks only a truly dependent case with block_dependents policy', () => {
    const cases = [
      { id: 'failed', dependsOnIds: [] },
      { id: 'blocking-child', dependsOnIds: ['failed'], failurePolicy: 'block_dependents' },
      { id: 'soft-child', dependsOnIds: ['failed'], failurePolicy: 'continue' },
      { id: 'independent', dependsOnIds: [] },
    ];
    const graph = dependencyGraph.buildGraph(cases);
    const outcomes = new Map([['failed', { status: 'fail', runResultId: 'result-1' }]]);
    expect(dependencyGraph.evaluateGate(cases[1], outcomes, graph)).toMatchObject({ blocked: true, reason: 'failed_prereq' });
    expect(dependencyGraph.evaluateGate(cases[2], outcomes, graph)).toMatchObject({ blocked: false });
    expect(dependencyGraph.evaluateGate(cases[2], outcomes, graph).findings)
      .toContainEqual(expect.objectContaining({ code: 'dependency_failure_non_blocking' }));
    expect(dependencyGraph.evaluateGate(cases[3], outcomes, graph)).toMatchObject({ blocked: false, findings: [] });
  });

  it('continues a dependent session after validation-only assertion failures', () => {
    const prerequisite = { id: 'prerequisite', dependsOnIds: [] };
    const dependent = {
      id: 'dependent',
      dependsOnIds: ['prerequisite'],
      failurePolicy: 'block_dependents',
    };
    const graph = dependencyGraph.buildGraph([prerequisite, dependent]);
    const journal = [
      { status: 'pass', assertionStep: false },
      {
        status: 'fail',
        assertionStep: true,
        requiredForContinuation: false,
        failureImpact: 'validation_only',
        continuationOutcome: 'continue',
        executionError: false,
      },
      { status: 'pass', assertionStep: true },
    ];

    expect(dependencyGraph.journalAllowsDependentContinuation(journal)).toBe(true);
    expect(dependencyGraph.evaluateGate(dependent, new Map([[
      'prerequisite',
      { status: 'fail', continuationSatisfied: true, runResultId: 'result-1' },
    ]]), graph)).toMatchObject({ blocked: false, findings: [] });

    expect(dependencyGraph.journalAllowsDependentContinuation([
      { status: 'fail', assertionStep: false, requiredForContinuation: true, failureImpact: 'flow_blocking' },
    ])).toBe(false);
  });

  it('leases the exact dependency browser context and page without cross-scope leakage', () => {
    const context = { id: 'context-1' };
    const page = { id: 'page-1' };
    const session = {
      browser: { id: 'browser-1' },
      context,
      page,
      pageAlias: 'application-page',
      tabAlias: 'primary-tab',
      pageAliases: ['application-page', 'details-page'],
      tabAliases: ['primary-tab', 'details-tab'],
      contextTransitions: [{ kind: 'popup_opened', from: 'primary-tab', to: 'details-tab' }],
    };
    sessionRegistry.setScoped({ userId: 'user-1', projectId: 'project-1', runId: 'run-1', caseId: 'case-a' }, session);
    expect(sessionRegistry.get({ userId: 'user-1', projectId: 'project-2', runId: 'run-1', caseId: 'case-a' })).toBeUndefined();

    const lease = sessionRegistry.leaseContinuation({
      userId: 'user-1', projectId: 'project-1', runId: 'run-1', caseId: 'case-b', dependsOnCaseId: 'case-a',
    });
    expect(lease).toMatchObject({ reused: true, session, sameContext: context, samePage: page });
    expect(sessionRegistry.get({ userId: 'user-1', projectId: 'project-1', runId: 'run-1', caseId: 'case-b' })).toBe(session);
    expect(lease.artifacts).toMatchObject({
      pageAlias: 'application-page',
      tabAlias: 'primary-tab',
      contextTransitions: [{ kind: 'popup_opened', from: 'primary-tab', to: 'details-tab' }],
    });
  });

  it('recovers only from the exact live continuity group when a case alias is absent', () => {
    const session = { browser: { id: 'browser' }, context: { id: 'context' }, page: { id: 'page' }, closed: false };
    const rootScope = {
      userId: 'user', projectId: 'project', runId: 'run', caseId: 'login', continuityGroupId: 'dependency-group:login',
    };
    sessionRegistry.setScoped(rootScope, session);
    sessionRegistry.sessions.delete(sessionRegistry.scopedKey(rootScope));

    const lease = sessionRegistry.leaseContinuation({
      userId: 'user',
      projectId: 'project',
      runId: 'run',
      caseId: 'shipment',
      dependsOnCaseIds: ['login'],
      continuityGroupId: 'dependency-group:login',
    });
    expect(lease).toMatchObject({
      reused: true,
      session,
      leaseSource: 'continuity_group',
      continuityGroupId: 'dependency-group:login',
    });
  });

  it('rejects closed and conflicting dependency sessions instead of guessing', () => {
    const closed = { id: 'closed', closed: true };
    sessionRegistry.sessions.set(sessionRegistry.scopedKey({
      userId: 'user', projectId: 'project', runId: 'run', caseId: 'closed-dependency',
    }), closed);
    expect(sessionRegistry.leaseContinuation({
      userId: 'user', projectId: 'project', runId: 'run', caseId: 'child', dependsOnCaseIds: ['closed-dependency'],
    })).toMatchObject({ reused: false, reason: 'continuity_session_closed' });

    const first = { id: 'first', closed: false };
    const second = { id: 'second', closed: false };
    sessionRegistry.setScoped({ userId: 'user', projectId: 'project', runId: 'run-2', caseId: 'a' }, first);
    sessionRegistry.setScoped({ userId: 'user', projectId: 'project', runId: 'run-2', caseId: 'b' }, second);
    expect(sessionRegistry.leaseContinuation({
      userId: 'user', projectId: 'project', runId: 'run-2', caseId: 'child', dependsOnCaseIds: ['a', 'b'],
    })).toMatchObject({ reused: false, reason: 'dependency_sessions_conflict' });
  });

  it('does not expose an acquired case to descendants until its outcome commits continuity', () => {
    const session = { id: 'shared', closed: false };
    const common = {
      userId: 'user', projectId: 'project', runId: 'run', continuityGroupId: 'dependency-group:login',
    };
    sessionRegistry.setScoped({ ...common, caseId: 'login' }, session);
    expect(sessionRegistry.leaseContinuation({
      ...common, caseId: 'shipment', dependsOnCaseIds: ['login'],
    })).toMatchObject({ reused: true, session });

    expect(sessionRegistry.leaseContinuation({
      ...common, caseId: 'confirmation', dependsOnCaseIds: ['shipment'],
    })).toMatchObject({ reused: false, reason: 'dependency_session_not_committed' });

    sessionRegistry.setScoped({ ...common, caseId: 'shipment' }, session);
    expect(sessionRegistry.leaseContinuation({
      ...common, caseId: 'confirmation', dependsOnCaseIds: ['shipment'],
    })).toMatchObject({ reused: true, session });
  });

  it('never creates a session or replays login for continue_from_dependency', async () => {
    const session = { context: { id: 'context' }, page: { id: 'page' } };
    const continuityGroupId = 'dependency-group:login-case';
    sessionRegistry.setScoped({
      userId: 'user', projectId: 'project', runId: 'run', caseId: 'login-case', continuityGroupId,
    }, session);
    const createSession = vi.fn(async () => ({ id: 'new-session' }));
    const testCase = {
      id: 'continuation-case',
      dependsOnIds: ['login-case'],
      sessionMode: 'continue_from_dependency',
      failurePolicy: 'block_dependents',
    };
    const acquired = await authSessions.acquireSessionForCase({
      registry: sessionRegistry,
      userId: 'user',
      projectId: 'project',
      runId: 'run',
      testCase,
      createSession,
      continuityGroupId,
    });

    expect(acquired.session).toBe(session);
    expect(acquired.reused).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(acquired.plan).toMatchObject({
      mode: 'continue_from_dependency',
      dependencyCaseId: 'login-case',
      continuityGroupId,
      createNewSession: false,
      replayAuthentication: false,
      revisitLogin: false,
      repeatAuthActions: false,
    });
  });
});
