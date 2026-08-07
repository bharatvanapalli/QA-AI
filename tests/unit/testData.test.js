import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseWorkbook } = require('../../server/services/testData');

function dataUrl(mime, text) {
  return `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}`;
}

describe('test data parser', () => {
  it('parses CSV into one structured sheet', () => {
    const parsed = parseWorkbook({
      name: 'login-data.csv',
      mimeType: 'text/csv',
      content: 'Username,Password,Expected Result\nstandard_user,secret_sauce,Inventory page\nlocked_out,secret_sauce,Error message\n',
    });

    expect(parsed.rowCount).toBe(2);
    expect(parsed.sheets).toEqual([
      {
        name: 'login-data',
        headers: ['Username', 'Password', 'Expected Result'],
        rows: [
          { Username: 'standard_user', Password: 'secret_sauce', 'Expected Result': 'Inventory page' },
          { Username: 'locked_out', Password: 'secret_sauce', 'Expected Result': 'Error message' },
        ],
      },
    ]);
  });

  it('parses quoted CSV and raw data URLs', () => {
    const parsed = parseWorkbook({
      name: 'people.csv',
      mimeType: 'text/csv',
      content: dataUrl('text/csv', 'Name,Comment\n"Ada Lovelace","said ""hello"", then left"\n'),
    });

    expect(parsed.rowCount).toBe(1);
    expect(parsed.sheets[0].rows[0]).toEqual({
      Name: 'Ada Lovelace',
      Comment: 'said "hello", then left',
    });
  });

  it('detects tab-delimited text and records a complete immutable parser manifest', () => {
    const parsed = parseWorkbook({
      name: 'users.tsv',
      mimeType: 'text/tab-separated-values',
      content: 'Email\tRole\tExpected Result\nada@example.test\tadmin\tDashboard\n',
    });

    expect(parsed.sheets[0]).toMatchObject({
      name: 'users',
      headers: ['Email', 'Role', 'Expected Result'],
      rows: [{ Email: 'ada@example.test', Role: 'admin', 'Expected Result': 'Dashboard' }],
    });
    expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.parserManifest).toMatchObject({
      parserVersion: 'test-data-parser-v2',
      sourceSheetCount: 1,
      parsedSheetCount: 1,
      sourceRowCount: 1,
      parsedRowCount: 1,
      complete: true,
      truncations: [],
    });
  });

  it('makes source hashes content-sensitive without exposing source values', () => {
    const first = parseWorkbook({ name: 'a.csv', content: 'Value\none\n', mimeType: 'text/csv' });
    const second = parseWorkbook({ name: 'a.csv', content: 'Value\ntwo\n', mimeType: 'text/csv' });

    expect(first.sourceHash).not.toBe(second.sourceHash);
    expect(JSON.stringify(first.parserManifest)).not.toContain('one');
    expect(JSON.stringify(second.parserManifest)).not.toContain('two');
  });

  it('warns on empty sheets without flattening the contract', () => {
    const parsed = parseWorkbook({ name: 'empty.csv', mimeType: 'text/csv', content: '' });

    expect(parsed.rowCount).toBe(0);
    expect(parsed.sheets).toEqual([{ name: 'empty', headers: [], rows: [] }]);
    expect(parsed.warnings.join('\n')).toMatch(/empty sheet/i);
  });

  it('dedupes duplicate headers and drops blank header columns', () => {
    const parsed = parseWorkbook({
      name: 'headers.csv',
      mimeType: 'text/csv',
      content: 'Email,,Email, Expected Result \na@example.com,ignored,b@example.com,ok\n',
    });

    expect(parsed.sheets[0].headers).toEqual(['Email', 'Email 2', 'Expected Result']);
    expect(parsed.sheets[0].rows[0]).toEqual({
      Email: 'a@example.com',
      'Email 2': 'b@example.com',
      'Expected Result': 'ok',
    });
    expect(parsed.warnings.join('\n')).toMatch(/blank header/i);
    expect(parsed.warnings.join('\n')).toMatch(/duplicate header/i);
  });

  it('parses xlsx workbooks with multiple sheets when SheetJS is installed', () => {
    let XLSX;
    try {
      XLSX = require('xlsx');
    } catch (_) {
      return;
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Username', 'Password', 'Expected Result'],
        ['standard_user', 'secret_sauce', 'Inventory'],
      ]),
      'Login'
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ['Search', 'Expected Result'],
        ['backpack', 'Backpack shown'],
      ]),
      'Catalog'
    );
    const buf = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const parsed = parseWorkbook({
      name: 'multi.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${buf.toString('base64')}`,
    });

    expect(parsed.rowCount).toBe(2);
    expect(parsed.sheets.map((s) => s.name)).toEqual(['Login', 'Catalog']);
    expect(parsed.sheets[0].headers).toEqual(['Username', 'Password', 'Expected Result']);
    expect(parsed.sheets[1].rows[0]).toEqual({ Search: 'backpack', 'Expected Result': 'Backpack shown' });
  });
});
