'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { UNIVERSAL_DOM_SCRIPT } = require('../universalDomEngine');
const { compareTypedAssertion } = require('../typedAssertionComparator');

test('UNIVERSAL_DOM_SCRIPT is defined and exports valid JS', () => {
  assert.ok(typeof UNIVERSAL_DOM_SCRIPT === 'string');
  assert.ok(UNIVERSAL_DOM_SCRIPT.includes('__qaai_universal_dom_engine__'));
  assert.ok(UNIVERSAL_DOM_SCRIPT.includes('computeAccessibleName'));
  assert.ok(UNIVERSAL_DOM_SCRIPT.includes('extractLiveValue'));
  assert.ok(UNIVERSAL_DOM_SCRIPT.includes('executeAtomicClick'));
  assert.ok(UNIVERSAL_DOM_SCRIPT.includes('executeAtomicFill'));
  assert.ok(UNIVERSAL_DOM_SCRIPT.includes('executeAtomicSelect'));
});

test('compareTypedAssertion correctly validates temporal ordering', () => {
  const contract = {
    type: 'TEMPORAL_RELATIONSHIP',
    payload: {
      comparator: 'before',
      operands: [
        { name: 'Early Delivery Date/Time', role: null },
        { name: 'Late Delivery Date/Time', role: null }
      ]
    }
  };

  const actual = {
    operands: [
      { name: 'Early Delivery Date/Time', value: '2026-08-21T13:00:00', status: 'resolved' },
      { name: 'Late Delivery Date/Time', value: '2026-08-21T15:00:00', status: 'resolved' }
    ]
  };

  const result = compareTypedAssertion(contract, actual);
  assert.equal(result.matched, true);
  assert.equal(result.outcome, 'matched');
});

test('compareTypedAssertion rejects inverted temporal ordering', () => {
  const contract = {
    type: 'TEMPORAL_RELATIONSHIP',
    payload: {
      comparator: 'before',
      operands: [
        { name: 'Early Delivery Date/Time', role: null },
        { name: 'Late Delivery Date/Time', role: null }
      ]
    }
  };

  const actual = {
    operands: [
      { name: 'Early Delivery Date/Time', value: '2026-08-21T13:00:00', status: 'resolved' },
      { name: 'Late Delivery Date/Time', value: '2026-08-20T15:00:00', status: 'resolved' }
    ]
  };

  const result = compareTypedAssertion(contract, actual);
  assert.equal(result.matched, false);
  assert.equal(result.outcome, 'not_matched');
});
