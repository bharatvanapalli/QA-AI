import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { prepareArchitectClauses } = require('../../server/services/requirementOracle');

const DOCUMENTS = [
  {
    id: 'doc-selected',
    projectId: 'project-1',
    sprintId: 'sprint-1',
    name: 'selected-story.txt',
    category: 'user-stories',
    content: 'US-100: An administrator can create an employee record.',
  },
  {
    id: 'doc-unselected',
    projectId: 'project-1',
    sprintId: 'sprint-1',
    name: 'unselected-story.txt',
    category: 'user-stories',
    content: 'US-999: A payroll user can delete every confidential salary record.',
  },
];

function matchesWhere(document, where) {
  if (where.projectId && document.projectId !== where.projectId) return false;
  if (where.sprintId && document.sprintId !== where.sprintId) return false;
  if (where.id?.in && !where.id.in.includes(document.id)) return false;
  return true;
}

function prismaDouble() {
  const findMany = vi.fn(async ({ where }) => DOCUMENTS.filter((document) => matchesWhere(document, where)));
  return {
    document: {
      findMany,
      findUnique: vi.fn(async ({ where }) => DOCUMENTS.find((document) => document.id === where.id) || null),
    },
    requirementClause: {
      upsert: vi.fn(async ({ create }) => ({ ...create })),
    },
    _findMany: findMany,
  };
}

const quietLog = { warn: vi.fn() };

describe('requirementOracle generation document scope', () => {
  it('prevents unselected documents from contributing clauses', async () => {
    const prisma = prismaDouble();
    const result = await prepareArchitectClauses({
      prisma,
      projectId: 'project-1',
      sprintId: 'sprint-1',
      sourceDocumentIds: ['doc-selected', 'doc-selected'],
      providerName: 'openai',
      apiKey: null,
      log: quietLog,
    });

    expect(prisma._findMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        sprintId: 'sprint-1',
        id: { in: ['doc-selected'] },
      },
      select: { id: true, name: true, content: true, category: true },
    });
    expect(result.stats.docCount).toBe(1);
    expect(result.requirementClauses.length).toBeGreaterThan(0);
    expect(result.requirementClauses.every((clause) => clause.sourceDocId === 'doc-selected')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('confidential salary');
  });

  it('preserves whole-project legacy behavior when scope options are omitted', async () => {
    const prisma = prismaDouble();
    const result = await prepareArchitectClauses({
      prisma,
      projectId: 'project-1',
      providerName: 'openai',
      apiKey: null,
      log: quietLog,
    });

    expect(prisma._findMany).toHaveBeenCalledWith({
      where: { projectId: 'project-1' },
      select: { id: true, name: true, content: true, category: true },
    });
    expect(result.stats.docCount).toBe(2);
    expect(new Set(result.requirementClauses.map((clause) => clause.sourceDocId))).toEqual(
      new Set(['doc-selected', 'doc-unselected']),
    );
  });

  it('treats an explicit empty document scope as selecting no documents', async () => {
    const prisma = prismaDouble();
    const result = await prepareArchitectClauses({
      prisma,
      projectId: 'project-1',
      sourceDocumentIds: [],
      providerName: 'openai',
      apiKey: null,
      log: quietLog,
    });

    expect(prisma._findMany.mock.calls[0][0].where).toEqual({
      projectId: 'project-1',
      id: { in: [] },
    });
    expect(result.requirementClauses).toEqual([]);
    expect(result.stats.clauseCount).toBe(0);
  });
});
