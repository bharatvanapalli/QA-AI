import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const prisma = require('../../server/prisma');
const {
  countScenarioGenerationRelations,
  syncScenarioGenerationCounts,
} = require('../../server/services/scenarioGenerationCounts');

describe('scenario generation count integrity', () => {
  it('creates a scenario through checked project and generation relation connects', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `scenario-relation-${suffix}@example.test`,
        passwordHash: 'test-only',
      },
    });

    try {
      const project = await prisma.project.create({
        data: { userId: user.id, name: `Scenario relation test ${suffix}` },
      });
      const generation = await prisma.scenarioGeneration.create({
        data: { projectId: project.id, version: 1, label: 'Relation connect test' },
      });
      const scenario = await prisma.$transaction((tx) => tx.testScenario.create({
        data: {
          project: { connect: { id: project.id } },
          generation: { connect: { id: generation.id } },
          name: 'Checked relation scenario',
          module: 'test',
          priority: 'P1',
          category: 'positive',
          rationale: 'Proves the production checked-relation create shape.',
          source: 'agent',
        },
      }));

      expect(scenario).toMatchObject({
        projectId: project.id,
        generationId: generation.id,
        name: 'Checked relation scenario',
      });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('replaces stale cached totals with authoritative scenario and case relation counts', async () => {
    const suffix = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `generation-counts-${suffix}@example.test`,
        passwordHash: 'test-only',
      },
    });

    try {
      const project = await prisma.project.create({
        data: { userId: user.id, name: `Generation count test ${suffix}` },
      });
      const generation = await prisma.scenarioGeneration.create({
        data: {
          projectId: project.id,
          version: 1,
          label: 'Count integrity test',
          scenarioCount: 99,
          caseCount: 99,
        },
      });
      const firstScenario = await prisma.testScenario.create({
        data: {
          projectId: project.id,
          generationId: generation.id,
          name: 'First scenario',
          module: 'test',
          priority: 'P1',
          category: 'positive',
          rationale: 'Count integrity coverage',
        },
      });
      const secondScenario = await prisma.testScenario.create({
        data: {
          projectId: project.id,
          generationId: generation.id,
          name: 'Second scenario',
          module: 'test',
          priority: 'P2',
          category: 'negative',
          rationale: 'Count integrity coverage',
        },
      });
      const cases = await Promise.all(['One', 'Two', 'Three'].map((name, index) => (
        prisma.testCase.create({
          data: {
            projectId: project.id,
            generationId: generation.id,
            scenarioId: index < 2 ? firstScenario.id : secondScenario.id,
            name: `Case ${name}`,
            type: 'functional',
            module: 'test',
            confidence: 100,
            assertions: 'Expected state is visible.',
          },
        })
      )));

      await expect(countScenarioGenerationRelations(prisma, {
        projectId: project.id,
        generationId: generation.id,
      })).resolves.toEqual({ scenarioCount: 2, caseCount: 3 });

      await expect(prisma.$transaction((tx) => syncScenarioGenerationCounts(tx, {
        projectId: project.id,
        generationId: generation.id,
      }))).resolves.toEqual({ scenarioCount: 2, caseCount: 3 });
      await expect(prisma.scenarioGeneration.findUnique({ where: { id: generation.id } }))
        .resolves.toMatchObject({ scenarioCount: 2, caseCount: 3 });

      await prisma.$transaction(async (tx) => {
        await tx.testCase.delete({ where: { id: cases[2].id } });
        await tx.testScenario.delete({ where: { id: secondScenario.id } });
        await syncScenarioGenerationCounts(tx, {
          projectId: project.id,
          generationId: generation.id,
        });
      });
      await expect(prisma.scenarioGeneration.findUnique({ where: { id: generation.id } }))
        .resolves.toMatchObject({ scenarioCount: 1, caseCount: 2 });
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
