import { describe, expect, it, vi } from 'vitest';

const mutex = await import('../../server/services/testDataMutex.js');

describe('testDataMutex', () => {
  it('locks the dataset row and protected identity values without exposing raw secrets', () => {
    const keys = mutex.buildRowLockKeys({
      projectId: 'project-1',
      testCaseId: 'tc-1',
      row: {
        index: 2,
        setName: 'AuthProfiles',
        inputs: {
          username: 'Admin',
          password: 'FixtureSecret-Row1!',
          firstName: 'QAAI',
        },
      },
    });

    expect(keys).toContain('dataset:authprofiles:row:2');
    expect(keys.some((key) => key.startsWith('field:username:value:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('field:password:value:'))).toBe(true);
    expect(keys.join('\n')).not.toContain('Admin');
    expect(keys.join('\n')).not.toContain('FixtureSecret-Row1!');
  });

  it('falls back to a case-row lock when no protected values exist', () => {
    const keys = mutex.buildRowLockKeys({
      projectId: 'project-1',
      testCaseId: 'tc-1',
      row: { index: 0, setName: '', inputs: { color: 'red' } },
    });

    expect(keys).toContain('dataset:default:row:0');
  });

  it('reclaims a lease immediately when its owning run is terminal', async () => {
    let reclaimed = false;
    const conflict = Object.assign(new Error('unique conflict'), { code: 'P2002' });
    const prisma = {
      run: {
        findUnique: vi.fn(async () => ({ status: 'cancelled' })),
      },
      testDataLease: {
        create: vi.fn(async () => {
          if (!reclaimed) throw conflict;
          return { id: 'new-lease' };
        }),
        findUnique: vi.fn(async () => ({
          id: 'stale-lease',
          runId: 'cancelled-run',
          expiresAt: new Date(Date.now() + 60_000),
        })),
        deleteMany: vi.fn(async ({ where }) => {
          if (where?.id === 'stale-lease') reclaimed = true;
          return { count: 1 };
        }),
      },
    };

    const lease = await mutex.acquireRowLeases({
      prisma,
      projectId: 'project-1',
      runId: 'new-run',
      testCaseId: 'tc-1',
      row: { index: 0, setName: 'InlineText', inputs: { color: 'red' } },
      timeoutMs: 100,
      pollMs: 1,
    });

    expect(lease).toMatchObject({ acquired: true, leaseIds: ['new-lease'] });
    expect(prisma.run.findUnique).toHaveBeenCalledWith({
      where: { id: 'cancelled-run' },
      select: { status: true },
    });
    expect(prisma.testDataLease.deleteMany).toHaveBeenCalledWith({ where: { id: 'stale-lease' } });
  });
});
