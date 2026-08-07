import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const prisma = require('../../server/prisma');
const executionJournal = require('../../server/services/executionJournal');
const scriptValidationRunner = require('../../server/services/scriptValidationRunner');
const runs = require('../../server/services/runs');

function persistedRunResult(stepResults) {
  return {
    id: 'result-1',
    testCaseId: 'case-1',
    createdAt: new Date('2026-07-15T05:00:01.000Z'),
    status: 'fail',
    screenshots: '[]',
    networkLog: '[]',
    domSnapshots: '[]',
    chatHistory: '[]',
    stepResults: JSON.stringify(stepResults),
    visualDiffs: '[]',
    assertionCheckResults: '[]',
    dependencyPath: '[]',
    replayIrJson: JSON.stringify({ complete: true }),
    exportMeta: null,
    testCase: {
      id: 'case-1',
      name: 'Journal projection case',
      module: 'Reports',
      type: 'functional',
      confidence: 1,
      steps: JSON.stringify([
        { id: 'open', action: 'Navigate', description: 'Open the page' },
        { id: 'price', action: 'Verify', description: 'Verify the price' },
      ]),
      userGuidance: null,
      dependsOnIds: '[]',
      declaredAssertions: '[]',
      scenarioId: 'scenario-1',
      scenario: {
        id: 'scenario-1',
        name: 'Report truth',
        module: 'Reports',
        priority: 'high',
        category: 'functional',
      },
    },
  };
}

function mockRunReads(result) {
  vi.spyOn(prisma.run, 'findFirst').mockResolvedValue({
    id: 'run-1',
    userId: 'user-1',
    projectId: 'project-1',
    generationId: null,
    sprintName: 'Journal proof',
    status: 'completed',
    passed: 0,
    failed: 1,
    blocked: 0,
    skipped: 0,
    startedAt: new Date('2026-07-15T05:00:00.000Z'),
    completedAt: new Date('2026-07-15T05:00:02.000Z'),
    results: [result],
  });
  vi.spyOn(prisma.blockedItem, 'findMany').mockResolvedValue([]);
  vi.spyOn(prisma.testScenario, 'findMany').mockResolvedValue([]);
  vi.spyOn(scriptValidationRunner, 'readLatestValidationReport').mockReturnValue(null);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('server-authoritative report journal boundary', () => {
  it('decodes persisted stepResults and projects the result with executionJournal', async () => {
    let rows = executionJournal.initializeExecutionJournal({
      approvedSteps: [
        { id: 'open', action: 'Navigate', description: 'Open the page' },
        { id: 'price', action: 'Verify', kind: 'assertion', description: 'Verify the price' },
      ],
    });
    rows = executionJournal.recordActionOutcome(rows, 'open', 'succeeded');
    rows = executionJournal.recordAssertionOutcome(rows, 'price', {
      outcome: 'not_matched',
      expected: 10,
      observed: 12,
      comparator: 'number_equals',
    });
    rows = executionJournal.finalizeExecutionJournal(rows);

    mockRunReads(persistedRunResult(rows));
    const projector = vi.spyOn(executionJournal, 'projectExecutionJournal');

    const run = await runs.getRun('user-1', 'run-1');

    expect(run.results[0].stepResults).toEqual(rows);
    expect(projector).toHaveBeenCalledWith(rows);
    expect(run.results[0].journalSummary).toEqual(
      executionJournal.projectExecutionJournal(rows),
    );
    expect(run.results[0].journalSummary).toMatchObject({
      planned: 2,
      executed: 2,
      passed: 1,
      validationFailed: 1,
      executionErrors: 0,
      executionCompleted: true,
    });
  });

  it('returns null authority for legacy results without persisted journal rows', async () => {
    mockRunReads(persistedRunResult([]));

    const run = await runs.getRun('user-1', 'run-1');

    expect(run.results[0].stepResults).toEqual([]);
    expect(run.results[0].journalSummary).toBeNull();
  });
});

describe('Reports journal-summary selection contract', () => {
  it('prefers a valid server summary and retains the legacy projection fallback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/pages/Reports.jsx'),
      'utf8',
    );
    const start = source.indexOf('const journalSummary = useMemo(() => {');
    const end = source.indexOf('const executionFullyCompleted', start);
    const selection = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(selection).toContain('result.journalSummary');
    expect(selection).toContain("typeof persisted === 'string'");
    expect(selection).toContain('Number.isFinite(Number(persisted.planned))');
    expect(selection).toMatch(/\?\s*persisted\s*:\s*stepProjection\.summary/);
  });
});
