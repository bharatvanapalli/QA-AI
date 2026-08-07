'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const protocol = require('../server/services/controllerCompositeProtocols');

let passed = 0;

function verify(name, check) {
  check();
  passed += 1;
  process.stdout.write(`PASS ${name}\n`);
}

function operation(overrides = {}) {
  return {
    operationId: 'action:order:equipment',
    actionOccurrenceId: 'occurrence:action:order:equipment:1',
    type: 'Select',
    selection: { kind: 'exact_text', value: 'Dry Van' },
    ...overrides,
  };
}

verify('dropdown popup opening is never commit eligible', () => {
  const value = protocol.createDropdownProtocol({
    operation: operation(),
    ownerRef: 'equipment-owner',
  });
  assert.equal(value.phases.find((phaseValue) => phaseValue.phaseId === 'popup-associated').commitEligible, false);
  assert.equal(value.phases.at(-1).phaseId, 'owner-readback');
  assert.equal(value.phases.at(-1).commitEligible, true);
});

verify('calendar protocol is strictly owner year month day owner-readback', () => {
  const value = protocol.createCalendarProtocol({
    operation: operation({
      operationId: 'action:order:date',
      actionOccurrenceId: 'occurrence:action:order:date:1',
      type: 'Date',
      selection: null,
      value: '2026-08-20',
      targetIdentity: {
        accessibleName: 'Ship Date',
        role: 'combobox',
      },
    }),
    ownerRef: 'date-owner',
    ownerAccessibleName: 'Ship Date',
  });
  assert.deepEqual(value.phases.map((phaseValue) => phaseValue.phaseId), [
    'owner-ready', 'open-owner', 'popup-associated',
    'open-year-picker', 'choose-year', 'year-committed',
    'open-month-picker', 'choose-month', 'month-committed',
    'choose-day', 'commit-date', 'owner-readback',
  ]);
});

verify('time normalization treats 09:00 AM and 09:00 as equal', () => {
  assert.equal(protocol.normalizeTime('09:00 AM'), '09:00');
  const result = protocol.resolveExactOptionCandidate({
    selection: { kind: 'exact_text', value: '09:00 AM' },
    valueKind: 'time',
    owner: { ref: 'time-owner' },
    candidates: [{
      label: '09:00',
      ownerRef: 'time-owner',
      ref: 'time-9',
      actionable: true,
    }],
  });
  assert.equal(result.status, protocol.OPTION_RESOLUTION_STATUS.RESOLVED);
});

verify('ambiguous or partial timezone labels cannot authorize mutation', () => {
  const result = protocol.resolveExactOptionCandidate({
    selection: { kind: 'exact_text', value: 'Central' },
    owner: { ref: 'zone-owner' },
    candidates: [{
      label: 'Central Standard Time', ownerRef: 'zone-owner', ref: 'cst',
    }, {
      label: 'Central Daylight Time', ownerRef: 'zone-owner', ref: 'cdt',
    }],
  });
  assert.equal(result.status, protocol.OPTION_RESOLUTION_STATUS.NOT_FOUND);
  assert.equal(result.candidate, null);
});

verify('protocol module plans phases but owns no dispatch stop or verdict', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'controllerCompositeProtocols.js'),
    'utf8',
  );
  assert.equal(/\bdispatch\s*\(/.test(source), false);
  assert.equal(/require\(['"]\.\/(?:controllerActionExecutionGateway|mcp)/.test(source), false);
  assert.equal(/\bstopDescendants\b|\bstopCase\b|\bverdict\b/.test(source), false);
});

process.stdout.write(`OK ${passed} composite protocol invariants\n`);
