import { describe, expect, it } from 'vitest';
import {
  SOURCE_LEDGER_FINDING_CODES,
  buildSourceLedger,
  validateSourceLedgerClaims as validateSourceClaims,
} from '../../server/services/addScenarioSourceLedger.js';
import {
  SOURCE_COVERAGE_SECRET,
  buildLargeSourceCoverageFixture,
  buildSourceCoverageFixture,
  claimsForCoverageFixture,
  literalIdsForEntry,
} from '../fixtures/addScenarioSourceCoverage.fixture.js';

function findingCodes(report) {
  return report.findings.map((finding) => finding.code);
}

function validateFixture(fixture, options = {}) {
  const ledger = buildSourceLedger(fixture.rawSource);
  const authority = claimsForCoverageFixture(ledger, {
    entries: fixture.entries,
    ...options,
  });
  const report = validateSourceClaims(ledger, fixture.rawSource, authority);
  return { ledger, authority, report };
}

function expectMissingExecutable(report, unitRef) {
  expect(report.complete).toBe(false);
  expect(findingCodes(report)).toContain(SOURCE_LEDGER_FINDING_CODES.SOURCE_UNIT_OMITTED);
  expect(report.coverage.omittedUnitRefs).toContain(unitRef);
}

describe('Phase 5 SourceLedgerV1 coverage acceptance', () => {
  it('rejects one missing unique middle action instead of letting surrounding claims hide it', () => {
    const fixture = buildSourceCoverageFixture();
    const { ledger } = validateFixture(fixture);
    const baseline = claimsForCoverageFixture(ledger, { entries: fixture.entries });
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitKeys: ['unique_middle_action'],
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expectMissingExecutable(report, baseline.unitRefsByKey.unique_middle_action);
  });

  it('rejects a missing authored assertion', () => {
    const fixture = buildSourceCoverageFixture();
    const { ledger } = validateFixture(fixture);
    const baseline = claimsForCoverageFixture(ledger, { entries: fixture.entries });
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitKeys: ['required_assertion'],
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expectMissingExecutable(report, baseline.unitRefsByKey.required_assertion);
  });

  it('rejects an omitted authored condition', () => {
    const fixture = buildSourceCoverageFixture();
    const { ledger } = validateFixture(fixture);
    const baseline = claimsForCoverageFixture(ledger, { entries: fixture.entries });
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitKeys: ['required_condition'],
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expectMissingExecutable(report, baseline.unitRefsByKey.required_condition);
  });

  it('rejects an unconsumed inline data literal even when the data line is claimed', () => {
    const fixture = buildSourceCoverageFixture();
    const ledger = buildSourceLedger(fixture.rawSource);
    const baseline = claimsForCoverageFixture(ledger, { entries: fixture.entries });
    const orderLiteralIds = literalIdsForEntry(ledger, baseline.unitRefsByKey.order_data);
    expect(orderLiteralIds.length).toBeGreaterThan(0);
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitLiteralIds: orderLiteralIds,
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expect(report.complete).toBe(false);
    expect(findingCodes(report)).toContain(SOURCE_LEDGER_FINDING_CODES.LITERAL_UNCONSUMED);
    expect(report.unconsumedLiteralUnitIds).toContain(baseline.unitRefsByKey.order_data);
  });

  it('rejects one missing operation from a compound authored source unit', () => {
    const fixture = buildSourceCoverageFixture();
    const ledger = buildSourceLedger(fixture.rawSource);
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitKeys: ['compound_select'],
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expect(report.complete).toBe(false);
    expect(findingCodes(report)).toContain(SOURCE_LEDGER_FINDING_CODES.COMPOUND_TEXT_RESIDUAL);
    expect(report.coverage.residualSpans
      .map((entry) => fixture.rawSource.slice(entry.sourceSpan.start, entry.sourceSpan.end))
      .join(' ')).toContain('select High');
  });

  it('distinguishes repeated identical actions and rejects one omitted occurrence', () => {
    const fixture = buildSourceCoverageFixture();
    const ledger = buildSourceLedger(fixture.rawSource);
    const baseline = claimsForCoverageFixture(ledger, { entries: fixture.entries });
    expect(baseline.unitRefsByKey.refresh_first).not.toBe(baseline.unitRefsByKey.refresh_second);
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitKeys: ['refresh_second'],
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expectMissingExecutable(report, baseline.unitRefsByKey.refresh_second);
    expect(report.unlinkedExecutableUnitIds).not.toContain(baseline.unitRefsByKey.refresh_first);
  });

  it('accepts metadata-only units without requiring fake browser operations', () => {
    const fixture = buildSourceCoverageFixture();
    const { report } = validateFixture(fixture);

    expect(findingCodes(report)).not.toContain(SOURCE_LEDGER_FINDING_CODES.EXECUTABLE_LINK_MISSING);
    expect(findingCodes(report)).not.toContain(SOURCE_LEDGER_FINDING_CODES.SOURCE_UNIT_OMITTED);
  });

  it('keeps an explicitly unresolved source unit visible and blocks completeness', () => {
    const fixture = buildSourceCoverageFixture();
    const { authority, report } = validateFixture(fixture);

    expect(report.valid).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.unresolvedUnitIds).toEqual([authority.unitRefsByKey.unresolved_follow_up]);
  });

  it('proves all 89 authored operations are linked with no executable omissions', () => {
    const fixture = buildLargeSourceCoverageFixture();
    const { ledger, report } = validateFixture(fixture);
    const executableUnitCount = ledger.units.filter((unit) => unit.kind !== 'heading').length;

    expect(fixture.operationCount).toBe(89);
    expect(executableUnitCount).toBe(89);
    expect(report.valid).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.unlinkedExecutableUnitIds).toEqual([]);
    expect(report.unconsumedLiteralUnitIds).toEqual([]);
    expect(report.unresolvedUnitIds).toEqual([]);
    expect(report.coverage.claimedUnits).toBe(report.coverage.totalUnits);
  });

  it('derives deterministic spans, per-occurrence identities, and digests from exact source', () => {
    const fixture = buildSourceCoverageFixture();
    const first = buildSourceLedger(fixture.rawSource);
    const second = buildSourceLedger(fixture.rawSource);

    expect(second).toEqual(first);
    expect(first.sourceDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(first.ledgerDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    first.units.forEach((unit, index) => {
      expect(unit.ordinal).toBe(index + 1);
      const exactSourceQuote = fixture.rawSource.slice(unit.sourceSpan.start, unit.sourceSpan.end);
      if (unit.sensitive) {
        expect(unit.sourceQuote).not.toContain(SOURCE_COVERAGE_SECRET);
        expect(unit.sourceQuote).toContain('[REDACTED]');
      } else {
        expect(exactSourceQuote).toBe(unit.sourceQuote);
      }
      expect(unit.quoteDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    });
    const refreshUnits = first.units.filter((unit) => unit.sourceQuote === '8. Click Refresh.');
    expect(refreshUnits).toHaveLength(2);
    expect(refreshUnits[0].id).not.toBe(refreshUnits[1].id);
  });

  it('does not expose a raw sensitive literal in unconsumed-literal diagnostics', () => {
    const fixture = buildSourceCoverageFixture();
    const ledger = buildSourceLedger(fixture.rawSource);
    const baseline = claimsForCoverageFixture(ledger, { entries: fixture.entries });
    const secretLiteralIds = [
      ...literalIdsForEntry(ledger, baseline.unitRefsByKey.secret_data),
      ...literalIdsForEntry(ledger, baseline.unitRefsByKey.consume_secret),
    ].filter((literalId) => ledger.literals.find((literal) => literal.id === literalId)?.sensitive === true);
    expect(secretLiteralIds.length).toBeGreaterThan(0);
    const authority = claimsForCoverageFixture(ledger, {
      entries: fixture.entries,
      omitLiteralIds: secretLiteralIds,
    });
    const report = validateSourceClaims(ledger, fixture.rawSource, authority);

    expect(findingCodes(report)).toContain(SOURCE_LEDGER_FINDING_CODES.LITERAL_UNCONSUMED);
    expect(JSON.stringify(report)).not.toContain(SOURCE_COVERAGE_SECRET);
  });
});
