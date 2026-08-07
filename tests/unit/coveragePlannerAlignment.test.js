import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const coveragePlanner = require('../../server/services/coveragePlanner');

function testData() {
  return {
    sheets: [
      {
        name: 'Login positive',
        datasetRevisionId: 'revision-1',
        sheetId: 'sheet-positive',
        rows: [{ __datasetRowId: 'row-positive', Email: 'safe@example.test' }],
      },
      {
        name: 'Login negative',
        datasetRevisionId: 'revision-1',
        sheetId: 'sheet-negative',
        rows: [{ __datasetRowId: 'row-negative', Email: 'invalid@example.test' }],
      },
    ],
    mapping: {
      bindings: [
        {
          sheet: 'Login positive',
          datasetRevisionId: 'revision-1',
          sheetId: 'sheet-positive',
          mappingId: 'mapping-1',
          mappingVersion: 2,
          columnToField: { email: 'Email' },
        },
        {
          sheet: 'Login negative',
          datasetRevisionId: 'revision-1',
          sheetId: 'sheet-negative',
          mappingId: 'mapping-1',
          mappingVersion: 2,
          columnToField: { email: 'Email' },
        },
      ],
    },
  };
}

function alignmentPlan() {
  return {
    planId: 'alignment-plan-1',
    alignments: [{
      alignmentId: 'alignment-1',
      storyId: 'US-1',
      clauseIds: ['REQ-1'],
      status: 'aligned',
      decision: { reason: 'all exact story-id row groups selected' },
      selected: [
        {
          datasetId: 'dataset-1',
          datasetRevisionId: 'revision-1',
          sheetId: 'sheet-positive',
          rowGroupId: 'group-positive',
          rowIds: ['row-positive'],
          matchKind: 'story_id',
          score: 1,
        },
        {
          datasetId: 'dataset-1',
          datasetRevisionId: 'revision-1',
          sheetId: 'sheet-negative',
          rowGroupId: 'group-negative',
          rowIds: ['row-negative'],
          matchKind: 'story_id',
          score: 1,
        },
      ],
    }],
  };
}

describe('coverage planner immutable story-data alignment', () => {
  it('materializes every selected row group without choosing only the best match', () => {
    const manifest = coveragePlanner.buildCoveragePlanManifest({
      requirementClauses: [{ id: 'REQ-1', storyId: 'US-1', behaviourText: 'The user signs in.' }],
      testData: testData(),
      storyDataAlignmentPlan: alignmentPlan(),
    });

    expect(manifest.items).toHaveLength(2);
    expect(manifest.items.map((item) => item.dataSource.rowGroupId).sort()).toEqual(['group-negative', 'group-positive']);
    expect(manifest.items.map((item) => item.dataSource.rowIds[0]).sort()).toEqual(['row-negative', 'row-positive']);
    expect(manifest.items.every((item) => item.required && item.confidence === 'exact')).toBe(true);
  });

  it('fails closed when an exact alignment resolves to duplicate immutable sheet identities', () => {
    const duplicate = testData();
    duplicate.sheets.push({ ...duplicate.sheets[0], name: 'Duplicate display copy' });

    expect(() => coveragePlanner.buildCoveragePlanManifest({
      requirementClauses: [{ id: 'REQ-1', storyId: 'US-1', behaviourText: 'The user signs in.' }],
      testData: duplicate,
      storyDataAlignmentPlan: alignmentPlan(),
    })).toThrowError(expect.objectContaining({ code: 'STORY_DATA_ALIGNMENT_UNRESOLVED' }));
  });
});
