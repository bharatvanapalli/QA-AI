import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  OUTCOMES,
  compareTypedAssertion,
} = require('../../server/services/typedAssertionComparator');
const {
  VALID_TYPES,
  normalizeForCase,
  validateRecord,
} = require('../../server/lib/declaredAssertions');

const compare = (type, payload, actual) => compareTypedAssertion({ type, payload }, actual);

describe('deterministic typed assertion comparators', () => {
  it('returns the stable matched/not_matched/uncheckable evidence shape', () => {
    expect(compare('TEXT', { expectedText: 'Order ready' }, '  ORDER   ready  ')).toEqual({
      outcome: 'matched',
      matched: true,
      expected: 'Order ready',
      actual: '  ORDER   ready  ',
      comparator: 'contains',
      reason: 'text_matched',
    });

    expect(compare('TEXT', { expectedText: 'Complete' }, 'Still processing')).toMatchObject({
      outcome: 'not_matched',
      matched: false,
      expected: 'Complete',
      actual: 'Still processing',
      comparator: 'contains',
      reason: 'text_not_matched',
    });

    expect(compare('TEXT', { expectedText: 'Complete' }, null)).toMatchObject({
      outcome: 'uncheckable',
      matched: null,
      reason: 'text_actual_unavailable',
    });
    expect(OUTCOMES).toEqual({ MATCHED: 'matched', NOT_MATCHED: 'not_matched', UNCHECKABLE: 'uncheckable' });
  });

  it('supports text modes and deterministic regex without semantic rescue', () => {
    expect(compare('TEXT', { expectedText: 'Alpha', comparator: 'equals', caseSensitive: true }, 'alpha').outcome)
      .toBe('not_matched');
    expect(compare('FORBIDDEN_TEXT', { unexpectedText: 'fatal error' }, 'Request completed').outcome)
      .toBe('matched');
    expect(compare('REGEX', { pattern: '^INV-[0-9]{4}$' }, 'INV-2048').outcome).toBe('matched');
    expect(compare('REGEX', { pattern: '[' }, 'anything')).toMatchObject({
      outcome: 'uncheckable',
      reason: 'regex_pattern_invalid',
    });
  });

  it('compares numbers with tolerance and explicit ordering', () => {
    expect(compare('NUMBER', { expectedNumber: 10, tolerance: 0.1 }, '10.08')).toMatchObject({
      outcome: 'matched', expected: 10, actual: 10.08, comparator: 'equals', reason: 'number_matched',
    });
    expect(compare('NUMBER', { expectedNumber: 10, tolerance: 0.1 }, '10.2').outcome).toBe('not_matched');
    expect(compare('NUMBER', { expectedNumber: 10, comparator: 'gt' }, 11).outcome).toBe('matched');
    expect(compare('NUMBER', { expectedNumber: 10 }, 'not a number')).toMatchObject({
      outcome: 'uncheckable', reason: 'number_actual_unavailable',
    });
  });

  it('compares currency amount, code, and tolerance independently', () => {
    expect(compare('CURRENCY', {
      expectedAmount: 20,
      expectedCurrency: 'USD',
      tolerance: 0.01,
    }, '$20.004')).toMatchObject({ outcome: 'matched', reason: 'currency_matched' });

    expect(compare('CURRENCY', {
      expectedAmount: 20,
      expectedCurrency: 'USD',
    }, { amount: 20, currency: 'EUR' })).toMatchObject({
      outcome: 'not_matched', reason: 'currency_code_not_matched',
    });

    expect(compare('CURRENCY', {
      expectedAmount: 20,
      expectedCurrency: 'USD',
    }, '20.00')).toMatchObject({
      outcome: 'uncheckable', reason: 'currency_code_unavailable',
    });
  });

  it('compares date, time, and date-time values with explicit tolerances', () => {
    expect(compare('DATE', { expectedDate: '2026-07-15' }, '2026-07-15T10:30:00Z').outcome).toBe('matched');
    expect(compare('TIME', { expectedTime: '09:30:00', toleranceSeconds: 30 }, '09:30:20').outcome).toBe('matched');
    expect(compare('DATE_TIME', { expectedDateTime: '2026-07-15T09:30:00Z', comparator: 'after' },
      '2026-07-15T09:31:00Z').outcome).toBe('matched');
    expect(compare('DATE', { expectedDate: 'not-a-date' }, '2026-07-15')).toMatchObject({
      outcome: 'uncheckable', reason: 'date_expected_invalid',
    });
  });

  it('compares full URLs, patterns, origins, and paths without guessing', () => {
    expect(compare('URL', { expectedUrlPattern: '/orders/42' },
      'https://shop.example.test/orders/42?view=full').outcome).toBe('matched');
    expect(compare('URL', { expectedUrl: '/orders/42', comparator: 'path' },
      'https://shop.example.test/orders/42?view=full').outcome).toBe('matched');
    expect(compare('URL', { expectedUrl: 'https://shop.example.test', comparator: 'origin' },
      'https://other.example.test/orders/42').outcome).toBe('not_matched');
    expect(compare('URL', { expectedUrl: '^https://[^/]+/done$', comparator: 'regex' },
      'https://app.example.test/done').outcome).toBe('matched');
  });

  it('compares visibility, attributes, values, selected, checked, and count', () => {
    expect(compare('VISIBLE', { target: 'Save' }, { visible: true }).outcome).toBe('matched');
    expect(compare('HIDDEN', { target: 'Spinner' }, { exists: false }).outcome).toBe('matched');
    expect(compare('ATTRIBUTE', { attributeName: 'data-state', expectedValue: 'active' }, {
      attributes: { 'data-state': 'ACTIVE' },
    }).outcome).toBe('matched');
    expect(compare('ATTRIBUTE', { attributeName: 'disabled', comparator: 'absent' }, {
      attributes: { role: 'button' },
    }).outcome).toBe('matched');
    expect(compare('VALUE', { expectedValue: 'alice@example.test' }, { value: 'alice@example.test' }).outcome)
      .toBe('matched');
    expect(compare('SELECTED', { target: 'Enabled' }, { ariaSelected: 'true' }).outcome).toBe('matched');
    expect(compare('CHECKED', { target: 'Remember me', expectedChecked: false }, { checked: false }).outcome)
      .toBe('matched');
    expect(compare('COUNT', { expectedCount: 2, comparator: 'gte' }, ['one', 'two', 'three']).outcome)
      .toBe('matched');
  });

  it('treats nullish attribute values as absent while preserving empty attributes', () => {
    for (const value of [null, undefined]) {
      const actual = { attributes: { 'aria-expanded': value } };
      expect(compare('ATTRIBUTE', { attributeName: 'aria-expanded', comparator: 'present' }, actual))
        .toMatchObject({ outcome: 'not_matched', actual: false, reason: 'attribute_presence_not_matched' });
      expect(compare('ATTRIBUTE', { attributeName: 'aria-expanded', comparator: 'absent' }, actual))
        .toMatchObject({ outcome: 'matched', actual: false, reason: 'attribute_presence_matched' });
      expect(compare('ATTRIBUTE', { attributeName: 'aria-expanded', expectedValue: 'true' }, actual))
        .toMatchObject({ outcome: 'not_matched', reason: 'attribute_not_found' });
    }

    expect(compare('ATTRIBUTE', { attributeName: 'disabled', comparator: 'present' }, {
      attributes: { disabled: '' },
    })).toMatchObject({ outcome: 'matched', actual: true });
  });

  it('checks table rows, cells, columns, and queries against structured rows', () => {
    const table = {
      columns: ['Name', 'Status', 'Amount'],
      rows: [
        ['Alice', 'Active', 10],
        ['Bob', 'Suspended', 20],
      ],
    };

    expect(compare('TABLE_ROW', { expectedRow: { Name: 'alice', Status: 'active' } }, table)).toMatchObject({
      outcome: 'matched', reason: 'table_row_matched',
    });
    expect(compare('TABLE_CELL', {
      where: { Name: 'Bob' }, column: 'Status', expectedValue: 'Suspended',
    }, table)).toMatchObject({ outcome: 'matched', reason: 'table_cell_matched' });
    expect(compare('TABLE_COLUMN', {
      column: 'Name', expectedValues: ['Alice', 'Bob'], comparator: 'contains_all',
    }, table)).toMatchObject({ outcome: 'matched', reason: 'collection_membership_matched' });
    expect(compare('TABLE_QUERY', {
      where: { Status: 'Active' }, expectedCount: 1,
    }, table)).toMatchObject({ outcome: 'matched', actual: 1, reason: 'table_query_count_matched' });
    expect(compare('TABLE_QUERY', {
      where: { Status: 'Missing' }, exists: false,
    }, table)).toMatchObject({ outcome: 'matched', reason: 'table_query_matched' });
  });

  it('supports partial structured collection membership and exact unordered sets', () => {
    const actual = [
      { id: 1, status: 'pending', metadata: { region: 'west' } },
      { id: 2, status: 'ready', metadata: { region: 'east', owner: 'qa' } },
    ];
    expect(compare('COLLECTION', {
      expectedMember: { id: 2, metadata: { region: 'east' } },
    }, actual)).toMatchObject({ outcome: 'matched', reason: 'collection_membership_matched' });
    expect(compare('COLLECTION_MEMBERSHIP', {
      expectedItems: [{ id: 1 }, { id: 3 }], comparator: 'contains_all',
    }, actual)).toMatchObject({ outcome: 'not_matched', reason: 'collection_membership_not_matched' });
    expect(compare('COLLECTION', {
      expectedItems: ['b', 'a'], comparator: 'unordered_equals',
    }, ['A', 'B'])).toMatchObject({ outcome: 'matched' });
  });

  it('proves ordered temporal relationships and preserves missing or ambiguous operand truth', () => {
    const assertion = {
      type: 'TEMPORAL_RELATIONSHIP',
      payload: { comparator: 'before', operands: [{ name: 'Pickup' }, { name: 'Delivery' }] },
    };
    const run = (operands) => compareTypedAssertion(assertion, { operands });
    expect(run([
      { name: 'Pickup', status: 'resolved', value: '2026-08-20T09:00:00Z' },
      { name: 'Delivery', status: 'resolved', value: '2026-08-20T11:00:00Z' },
    ])).toMatchObject({ outcome: 'matched', reason: 'relationship_matched' });
    expect(run([
      { name: 'Pickup', status: 'resolved', value: '2026-08-20T12:00:00Z' },
      { name: 'Delivery', status: 'resolved', value: '2026-08-20T11:00:00Z' },
    ])).toMatchObject({ outcome: 'not_matched', reason: 'relationship_not_matched' });
    expect(run([{ status: 'resolved', value: '2026-08-20T09:00:00Z' }, { status: 'missing' }]))
      .toMatchObject({ outcome: 'uncheckable', reason: 'relationship_operand_missing' });
    expect(run([{ status: 'ambiguous' }, { status: 'resolved', value: '2026-08-20T11:00:00Z' }]))
      .toMatchObject({ outcome: 'uncheckable', reason: 'relationship_operand_ambiguous' });
  });
});

describe('declared assertion typed validation compatibility', () => {
  it('accepts every new typed assertion payload without changing legacy records', () => {
    const records = [
      { type: 'REGEX', payload: { pattern: '^ok$' } },
      { type: 'NUMBER', payload: { expectedNumber: '1,000', tolerance: 1 } },
      { type: 'CURRENCY', payload: { expectedAmount: '$12.50', expectedCurrency: 'USD' } },
      { type: 'DATE', payload: { expectedDate: '2026-07-15' } },
      { type: 'TIME', payload: { expectedTime: '09:30' } },
      { type: 'DATE_TIME', payload: { expectedDateTime: '2026-07-15T09:30:00Z' } },
      { type: 'DATETIME', payload: { expected: '2026-07-15T09:30:00Z' } },
      { type: 'VISIBLE', payload: { target: 'Save button' } },
      { type: 'HIDDEN', payload: { selector: '#spinner' } },
      { type: 'ATTRIBUTE', payload: { attributeName: 'aria-expanded', expectedValue: 'true' } },
      { type: 'VALUE', payload: { expectedValue: '' } },
      { type: 'SELECTED', payload: { target: 'Active option' } },
      { type: 'CHECKED', payload: { name: 'Remember me', expectedChecked: false } },
      { type: 'COUNT', payload: { expectedCount: 0 } },
      { type: 'TABLE_ROW', payload: { expectedRow: { Name: 'Alice' } } },
      { type: 'TABLE_CELL', payload: { column: 'Status', expectedValue: 'Active' } },
      { type: 'TABLE_COLUMN', payload: { column: 'Name', expectedValues: ['Alice'] } },
      { type: 'TABLE_QUERY', payload: { where: { Status: 'Active' } } },
      { type: 'COLLECTION', payload: { expectedMember: { id: 1 } } },
      { type: 'TEXT', payload: { expectedText: 'legacy text' } },
      { type: 'URL', payload: { expectedUrlPattern: '/legacy' } },
    ];

    for (const record of records) expect(validateRecord(record), JSON.stringify(record)).toMatchObject({ ok: true });
    for (const type of records.map((record) => record.type)) expect(VALID_TYPES.has(type)).toBe(true);

    const normalized = normalizeForCase(records, { automatability: 'automatable', caseName: 'typed matrix' });
    expect(normalized.normalized).toHaveLength(records.length);
    expect(normalized.normalized.every((record) => record.parseFailed !== true)).toBe(true);
    expect(normalized.issues).toEqual([]);
  });

  it('preserves malformed typed assertions as parseFailed instead of throwing', () => {
    const malformed = [
      { type: 'NUMBER', payload: { expectedNumber: 'many' } },
      { type: 'VISIBLE', payload: {} },
      { type: 'TABLE', payload: { mode: 'unknown' } },
      { type: 'COLLECTION', payload: {} },
    ];
    const normalized = normalizeForCase(malformed, { automatability: 'automatable', caseName: 'bad typed matrix' });
    expect(normalized.normalized).toHaveLength(malformed.length);
    expect(normalized.normalized.every((record) => record.parseFailed === true)).toBe(true);
    expect(normalized.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('number_assertion_needs_numeric_expected'),
      expect.stringContaining('visibility_assertion_needs_target'),
      expect.stringContaining('table_assertion_needs_supported_mode'),
      expect.stringContaining('collection_assertion_needs_expected_member_or_items'),
    ]));
  });
});
