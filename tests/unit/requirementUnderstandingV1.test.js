import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SCHEMA_VERSION,
  buildRequirementUnderstandingV1,
  validateRequirementUnderstandingV1,
  filterClausesForSelectedRequirements,
  attachRequirementUnderstandingV1,
} = require('../../server/services/requirementUnderstandingV1');

function uploadedRequirement(overrides = {}) {
  return {
    id: 'req-a',
    projectId: 'project-1',
    sourceType: 'upload',
    sourceIdentifier: 'doc-a',
    title: 'Employee administration story',
    category: 'user-stories',
    content: 'As an administrator I can log in and create an employee record.',
    ...overrides,
  };
}

function verifiedClause(overrides = {}) {
  return {
    id: 'clause-a',
    sourceType: 'USER_STORY',
    sourceDocId: 'doc-a',
    storyId: 'US-100',
    spanStart: 0,
    behaviourText: 'An administrator can log in and create an employee record.',
    excerpt: 'An administrator can log in and create an employee record.',
    testable: true,
    ...overrides,
  };
}

describe('RequirementUnderstandingV1', () => {
  it('is deterministic across input ordering and validates its generated contract', () => {
    const requirements = [
      uploadedRequirement(),
      uploadedRequirement({
        id: 'req-b',
        sourceIdentifier: 'doc-b',
        title: 'Search employees',
        content: 'A manager can search employees using a name and expected result.',
      }),
    ];
    const clauses = [
      verifiedClause(),
      verifiedClause({
        id: 'clause-b',
        sourceDocId: 'doc-b',
        storyId: 'US-101',
        behaviourText: 'A manager can search employees using a name and expected result.',
      }),
    ];

    const first = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      sprintId: 'sprint-1',
      requirements,
      requirementClauses: clauses,
    });
    const reversed = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      sprintId: 'sprint-1',
      requirements: [...requirements].reverse(),
      requirementClauses: [...clauses].reverse(),
    });

    expect(first).toEqual(reversed);
    expect(first.schemaVersion).toBe(SCHEMA_VERSION);
    expect(first.contractId).toMatch(/^ruv1-[a-f0-9]{64}$/);
    expect(first.sourceSnapshot.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.clauseIds).toEqual(['clause-a', 'clause-b']);
    expect(validateRequirementUnderstandingV1(first)).toEqual({ ok: true, errors: [] });
  });

  it('keeps only clauses linked to selected requirement sources', () => {
    const result = filterClausesForSelectedRequirements({
      requirements: [uploadedRequirement()],
      requirementClauses: [
        verifiedClause(),
        verifiedClause({ id: 'clause-other', sourceDocId: 'doc-other', storyId: 'US-999' }),
      ],
    });

    expect(result.selectedDocumentIds).toEqual(['doc-a']);
    expect(result.clauses.map((clause) => clause.id)).toEqual(['clause-a']);
    expect(result.excludedClauses.map((clause) => clause.id)).toEqual(['clause-other']);

    const contract = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      requirements: [uploadedRequirement()],
      requirementClauses: [
        verifiedClause(),
        verifiedClause({ id: 'clause-other', sourceDocId: 'doc-other', storyId: 'US-999' }),
      ],
    });
    expect(contract.behaviors.map((behavior) => behavior.id)).toEqual(['clause-a']);
    expect(contract.stats).toMatchObject({ verifiedClauseCount: 1, excludedClauseCount: 1 });
    expect(contract.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'clause_outside_selected_requirement_scope',
        sourceRef: 'clause-other',
      }),
    ]));
  });

  it('retains ADO and Jira requirements without clauses as provisional sources', () => {
    const contract = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      requirements: [
        {
          id: 'ado-row-1',
          sourceType: 'ado',
          sourceIdentifier: 'ADO-4711',
          title: 'Approve an order',
          content: 'As an approver I can review and approve an order.',
        },
        {
          id: 'jira-row-1',
          sourceType: 'jira',
          sourceIdentifier: 'SHOP-52',
          title: 'Reject an order',
          content: 'As an approver I can reject an invalid order.',
        },
      ],
    });

    expect(contract.status).toBe('needs_review');
    expect(contract.behaviors).toEqual([]);
    expect(contract.provisionalSources).toEqual([
      expect.objectContaining({ requirementId: 'ado-row-1', sourceIdentifier: 'ADO-4711' }),
      expect.objectContaining({ requirementId: 'jira-row-1', sourceIdentifier: 'SHOP-52' }),
    ]);
    expect(contract.stats.provisionalSourceCount).toBe(2);
    expect(contract.understanding.roles.map((role) => role.key)).toContain('approver');
    expect(validateRequirementUnderstandingV1(contract).ok).toBe(true);
  });

  it('deduplicates clauses by stable identity', () => {
    const duplicate = verifiedClause();
    const contract = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      requirements: [uploadedRequirement()],
      requirementClauses: [duplicate, { ...duplicate }],
    });

    expect(contract.clauseIds).toEqual(['clause-a']);
    expect(contract.behaviors).toHaveLength(1);
    expect(contract.stats.verifiedClauseCount).toBe(1);
  });

  it('redacts sensitive key-value data from behaviors and all derived evidence', () => {
    const rawPassword = 'Never-Persist-Password-42';
    const rawToken = 'token-value-that-must-not-leak';
    const contract = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      requirements: [uploadedRequirement({
        content: `As an administrator I can log in.\npassword=${rawPassword}\napi_key=${rawToken}`,
      })],
      requirementClauses: [verifiedClause({
        behaviourText: `The administrator can log in with password=${rawPassword}`,
        excerpt: `The administrator can log in with password=${rawPassword}`,
      })],
    });
    const serialized = JSON.stringify(contract);

    expect(serialized).not.toContain(rawPassword);
    expect(serialized).not.toContain(rawToken);
    expect(contract.behaviors[0].redactedBehaviorText).toContain('password=[REDACTED]');
    expect(validateRequirementUnderstandingV1(contract).ok).toBe(true);
  });

  it('reports degraded empty input and validation errors for malformed contracts', () => {
    const empty = buildRequirementUnderstandingV1({ projectId: 'project-1' });

    expect(empty.status).toBe('degraded');
    expect(empty.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'no_selected_requirements', severity: 'error' }),
    ]));
    expect(validateRequirementUnderstandingV1(empty).ok).toBe(true);

    const malformed = {
      ...empty,
      contractId: 'not-a-hash',
      projectId: null,
      status: 'complete',
      stats: { ...empty.stats, verifiedClauseCount: 99 },
    };
    const validation = validateRequirementUnderstandingV1(malformed);

    expect(validation.ok).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
      'invalid_contract_id',
      'required',
      'invalid_status',
      'count_mismatch',
    ]));
  });

  it('attaches the contract without changing the existing manifest shape', () => {
    const contract = buildRequirementUnderstandingV1({
      projectId: 'project-1',
      requirements: [uploadedRequirement()],
      requirementClauses: [verifiedClause()],
    });
    const manifest = { version: 1, items: [{ id: 'coverage-1' }] };

    expect(attachRequirementUnderstandingV1(manifest, contract)).toEqual({
      ...manifest,
      requirementUnderstandingV1: contract,
    });
    expect(manifest).toEqual({ version: 1, items: [{ id: 'coverage-1' }] });
  });
});
