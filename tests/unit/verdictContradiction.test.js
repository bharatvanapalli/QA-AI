import { describe, it, expect } from 'vitest';
import { detectVerdictContradiction } from '../../src/lib/verdictContradiction.js';

// The historical contradiction detector (run 91d6301a). Documents the EXACT
// criticality-join expectation the reviewer asked be explicit: a soft-only
// uncheckable row avoids the banner ONLY when its assertionId joins to a
// should/incidental declared assertion; an unjoinable uncheckable stays
// conservative (treated as must → banner).

const uncheckable = (id, criticality) => ({ assertionId: id, outcome: 'uncheckable', ...(criticality ? { criticality } : {}) });
const declared = (id, criticality) => ({ id, criticality, type: 'PAGE' });

describe('detectVerdictContradiction', () => {
  it('flags a pass with a must uncheckable outcome (criticality on the outcome)', () => {
    const c = detectVerdictContradiction({ status: 'pass', assertionCheckResults: [uncheckable('A', 'must')], screenshots: ['/a.png'], stepResults: [{ status: 'pass' }] });
    expect(c).toBeTruthy();
    expect(c.kind).toBe('uncheckable_pass');
  });

  it('does NOT over-warn a soft-only uncheckable that JOINS to a should declared assertion', () => {
    const c = detectVerdictContradiction({
      status: 'pass',
      assertionCheckResults: [uncheckable('A')], // no criticality on the outcome
      testCase: { declaredAssertions: [declared('A', 'should')] },
      screenshots: ['/a.png'], stepResults: [{ status: 'pass' }],
    });
    expect(c).toBeNull();
  });

  it('flags when the join resolves the outcome to a must declared assertion', () => {
    const c = detectVerdictContradiction({
      status: 'pass',
      assertionCheckResults: [uncheckable('A')],
      testCase: { declaredAssertions: [declared('A', 'must')] },
      screenshots: ['/a.png'], stepResults: [{ status: 'pass' }],
    });
    expect(c).toBeTruthy();
    expect(c.kind).toBe('uncheckable_pass');
  });

  it('stays CONSERVATIVE (flags) when criticality is unknown and unjoinable', () => {
    // No outcome.criticality AND no matching declared id → defaults to must → banner.
    const c = detectVerdictContradiction({
      status: 'pass',
      assertionCheckResults: [uncheckable('ORPHAN')],
      testCase: { declaredAssertions: [declared('OTHER', 'should')] },
      screenshots: ['/a.png'], stepResults: [{ status: 'pass' }],
    });
    expect(c).toBeTruthy();
  });

  it('parses declaredAssertions when stored as a JSON string', () => {
    const c = detectVerdictContradiction({
      status: 'pass',
      assertionCheckResults: [uncheckable('A')],
      testCase: { declaredAssertions: JSON.stringify([declared('A', 'incidental')]) },
      screenshots: ['/a.png'], stepResults: [{ status: 'pass' }],
    });
    expect(c).toBeNull(); // incidental → not required → no banner
  });

  it('flags the pre-fix escape-hatch marker in mechanicalVerdictReason', () => {
    const c = detectVerdictContradiction({ status: 'pass', mechanicalVerdictReason: 'all_assertions_matched ⚠ hard_assertion_uncheckable_passed_on_clean_execution', assertionCheckResults: [], screenshots: ['/a.png'], stepResults: [{ status: 'pass' }] });
    expect(c).toBeTruthy();
    expect(c.kind).toBe('uncheckable_pass');
  });

  it('flags a pass with NO evidence at all (the row-9 class)', () => {
    const c = detectVerdictContradiction({ status: 'pass', assertionCheckResults: [], screenshots: [], stepResults: [{ status: 'skipped' }] });
    expect(c).toBeTruthy();
    expect(c.kind).toBe('no_evidence');
  });

  it('does NOT flag a clean pass (screenshots + passing step + matched outcome)', () => {
    const c = detectVerdictContradiction({ status: 'pass', assertionCheckResults: [{ assertionId: 'A', outcome: 'matched', criticality: 'must' }], screenshots: ['/a.png'], stepResults: [{ status: 'pass' }] });
    expect(c).toBeNull();
  });

  it('never flags a non-pass row', () => {
    for (const status of ['fail', 'blocked', 'skipped', 'needs_human']) {
      expect(detectVerdictContradiction({ status, assertionCheckResults: [], screenshots: [], stepResults: [] })).toBeNull();
    }
  });
});
