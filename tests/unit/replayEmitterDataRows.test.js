import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const replayEmitter = require('../../server/services/codegen/replayEmitter.js');
const frameworkAdapter = require('../../server/services/codegen/adapters/frameworkAdapter.js');

function verifiedLocator(expression) {
  return {
    strategy: 'role',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    proof: { verified: true, sameElement: true, count: 1, visible: true, enabled: true },
  };
}

describe('ReplayIR workbook row projection', () => {
  it('uses inputs as the role source, preserves row provenance, and never materializes credential-shaped values', () => {
    const password = 'Workbook-Password-9!';
    const username = 'qa.user@example.test';
    const built = replayEmitter.buildReplayIR({
      caseId: 'tc-workbook-row',
      title: 'Search with a workbook row',
      trail: [{
        tool: 'browser_type',
        args: { element: 'Search Term', role: 'searchTerm', text: 'Odyssey' },
        actionLocator: verifiedLocator("getByRole('textbox', { name: 'Search Term' })"),
      }],
      verdictStatus: 'pass',
      dataRow: {
        index: 2,
        label: 'Row 3 - active user',
        setName: 'UserSearch',
        sheet: 'UserSearch',
        inputs: { searchTerm: 'Odyssey', username, password },
        expected: 'Results visible',
        expectedColumn: 'Expected Result',
        rowClass: 'positive',
        rowClassColumn: 'Case Class',
        rowId: 'row-user-search-3',
        dataBindingRef: {
          testDataSetId: 'dataset-users',
          datasetRevisionId: 'revision-4',
          sheetId: 'sheet-search',
          mappingId: 'mapping-search',
          mappingVersion: 8,
          workbookHash: 'workbook-hash',
          rowId: 'row-user-search-3',
        },
        sourceWorkbook: {
          kind: 'workbook',
          sheet: 'UserSearch',
          sheetId: 'sheet-search',
          workbookHash: 'workbook-hash',
          rowId: 'row-user-search-3',
        },
        fieldSensitivity: {
          searchTerm: 'synthetic',
          username: 'synthetic',
          password: 'synthetic',
        },
      },
    });

    const fill = built.ir.steps.find((step) => step.op === 'act' && step.action === 'fill');
    expect(fill).toMatchObject({ dataRole: 'searchTerm' });
    expect(fill).not.toHaveProperty('rawValue');

    expect(built.ir.dataRow).toMatchObject({
      index: 2,
      label: 'Row 3 - active user',
      setName: 'UserSearch',
      sheet: 'UserSearch',
      rowId: 'row-user-search-3',
      expectedColumn: 'Expected Result',
      rowClassColumn: 'Case Class',
      dataBindingRef: {
        testDataSetId: 'dataset-users',
        datasetRevisionId: 'revision-4',
        sheetId: 'sheet-search',
        mappingId: 'mapping-search',
        mappingVersion: 8,
        workbookHash: 'workbook-hash',
        rowId: 'row-user-search-3',
      },
      sourceWorkbook: {
        kind: 'workbook',
        sheet: 'UserSearch',
        sheetId: 'sheet-search',
        workbookHash: 'workbook-hash',
        rowId: 'row-user-search-3',
      },
    });
    expect(built.ir.dataRow.fields.searchTerm).toBe('Odyssey');
    expect(built.ir.dataRow.fields.username).toMatch(/^(?:env|vault|fixture|masked):/i);
    expect(built.ir.dataRow.fields.password).toMatch(/^(?:env|vault|fixture|masked):/i);
    expect(built.ir.dataRow.sensitivity).toMatchObject({
      searchTerm: 'synthetic',
      username: 'restricted',
      password: 'masked',
    });
    expect(built.ir.dataRow).not.toHaveProperty('inputs');
    expect(JSON.stringify(built.ir)).not.toContain(password);
    expect(JSON.stringify(built.ir)).not.toContain(username);
    expect(frameworkAdapter.validateReplayIR(built.ir).valid).toBe(true);
  });
});
