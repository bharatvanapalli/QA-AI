import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scope = require('../../server/services/executionDataPinScope');

describe('execution data pin scope', () => {
  it('extracts exact compiler-owned mapping and dataset revision pins', () => {
    const pins = scope.pinsFromScenarios([{
      cases: [{
        id: 'case-1',
        dataBindingJson: JSON.stringify({
          testDataSetId: 'dataset-1',
          mappingId: 'mapping-1',
          mappingVersion: 3,
          workbookHash: 'catalog-1',
          datasetRevisionId: 'dataset-revision-1',
          sheetId: 'sheet-1',
          rowGroupId: 'row-group-1',
          rowIds: ['row-1', 'row-2'],
        }),
      }],
    }]);

    expect(pins).toEqual([expect.objectContaining({
      caseId: 'case-1',
      testDataSetId: 'dataset-1',
      mappingId: 'mapping-1',
      mappingVersion: 3,
      workbookHash: 'catalog-1',
      datasetRevisionId: 'dataset-revision-1',
      sheetId: 'sheet-1',
      rowGroupId: 'row-group-1',
      rowIds: ['row-1', 'row-2'],
    })]);
  });

  it('keeps pins isolated to the active conductor call', async () => {
    expect(scope.currentExecutionDataPins()).toEqual([]);
    await scope.runWithExecutionDataPins({
      scenarios: [{ cases: [{ id: 'case-1', dataBinding: { mappingId: 'mapping-1' } }] }],
    }, async () => {
      await Promise.resolve();
      expect(scope.currentExecutionDataPins()).toEqual([expect.objectContaining({ mappingId: 'mapping-1' })]);
    });
    expect(scope.currentExecutionDataPins()).toEqual([]);
  });

  it('carries the authoritative execution generation on every selected-case pin', async () => {
    await scope.runWithExecutionDataPins({
      generationId: 'generation-7',
      scenarios: [{
        cases: [{
          id: 'case-1',
          dataBinding: {
            mappingId: 'mapping-1',
            // A serialized binding cannot redirect lookup to another
            // generation; the conductor-owned generation wins.
            generationId: 'generation-from-binding',
          },
        }],
      }],
    }, async () => {
      expect(scope.currentExecutionDataPins()).toEqual([
        expect.objectContaining({
          caseId: 'case-1',
          mappingId: 'mapping-1',
          generationId: 'generation-7',
        }),
      ]);
    });
  });

  it('keeps malformed data-bound pins visible while ignoring truly unbound cases', () => {
    const pins = scope.pinsFromScenarios([{
      cases: [
        { id: 'data-bound-missing-mapping', dataBinding: { testDataSetId: 'dataset-1', sheetId: 'sheet-1' } },
        { id: 'incomplete-data-binding', dataBinding: { status: 'incomplete', findings: [{ code: 'story_id_no_data' }] } },
        { id: 'inline-data-binding', dataBinding: { status: 'complete', mode: 'inline', inlineRevision: 'inline-1' } },
        { id: 'invalid-json-binding', dataBindingJson: '{not-json' },
        { id: 'legacy-data-free', dataBindingJson: null },
        { id: 'legacy-empty-binding', dataBindingJson: '{}' },
        { id: 'legacy-blank-binding', dataBindingJson: '   ' },
      ],
    }]);

    expect(pins).toEqual([{
      caseId: 'data-bound-missing-mapping',
      testDataSetId: 'dataset-1',
      sheetId: 'sheet-1',
    }, {
      caseId: 'incomplete-data-binding',
      status: 'incomplete',
      findings: [{ code: 'story_id_no_data' }],
    }, {
      caseId: 'invalid-json-binding',
      status: 'incomplete',
      pinParseError: 'data_binding_json_invalid',
      findings: [{ code: 'data_binding_json_invalid' }],
    }]);
  });
});
