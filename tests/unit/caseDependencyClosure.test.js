import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCaseDependencyClosure } = require('../../server/services/caseDependencyClosure');
const { encodeJson } = require('../../server/services/jsonField');

function fakePrisma(rows) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    testCase: {
      findMany: async ({ where }) => {
        const ids = where?.id?.in || [];
        return ids.map((id) => byId.get(id)).filter(Boolean);
      },
    },
  };
}

describe('case dependency closure', () => {
  it('auto-includes prerequisites and returns dependency order', async () => {
    const prisma = fakePrisma([
      { id: 'tc-login', projectId: 'project-1', name: 'Login', dependsOnIds: null },
      { id: 'tc-create', projectId: 'project-1', name: 'Create employee', dependsOnIds: encodeJson(['tc-login']) },
      { id: 'tc-edit', projectId: 'project-1', name: 'Edit employee', dependsOnIds: encodeJson(['tc-create']) },
    ]);

    const closure = await resolveCaseDependencyClosure({
      prisma,
      projectId: 'project-1',
      caseIds: ['tc-edit'],
    });

    expect(closure.caseIds).toEqual(['tc-login', 'tc-create', 'tc-edit']);
    expect(closure.autoIncluded).toEqual(['tc-login', 'tc-create']);
    expect(closure.missingIds).toEqual([]);
    expect(closure.findings).toEqual([]);
  });

  it('reports missing dependencies instead of silently pretending the closure is complete', async () => {
    const prisma = fakePrisma([
      { id: 'tc-edit', projectId: 'project-1', name: 'Edit employee', dependsOnIds: encodeJson(['tc-missing']) },
    ]);

    const closure = await resolveCaseDependencyClosure({
      prisma,
      projectId: 'project-1',
      caseIds: ['tc-edit'],
    });

    expect(closure.caseIds).toEqual(['tc-edit']);
    expect(closure.missingIds).toEqual(['tc-missing']);
    expect(closure.findings.map((f) => f.code)).toContain('dependency_case_missing');
  });

  it('fails closed on missing dependencies at an execution boundary', async () => {
    const prisma = fakePrisma([
      { id: 'tc-edit', projectId: 'project-1', name: 'Edit employee', dependsOnIds: encodeJson(['tc-missing']) },
    ]);

    await expect(resolveCaseDependencyClosure({
      prisma,
      projectId: 'project-1',
      caseIds: ['tc-edit'],
      strict: true,
    })).rejects.toMatchObject({
      code: 'CASE_DEPENDENCY_CLOSURE_INVALID',
      status: 409,
      missingIds: ['tc-missing'],
    });
  });

  it('fails closed on a dependency cycle at an execution boundary', async () => {
    const prisma = fakePrisma([
      { id: 'case-a', projectId: 'project-1', dependsOnIds: encodeJson(['case-b']) },
      { id: 'case-b', projectId: 'project-1', dependsOnIds: encodeJson(['case-a']) },
    ]);

    await expect(resolveCaseDependencyClosure({
      prisma,
      projectId: 'project-1',
      caseIds: ['case-a'],
      strict: true,
    })).rejects.toMatchObject({
      code: 'CASE_DEPENDENCY_CLOSURE_INVALID',
      status: 409,
    });
  });
});
