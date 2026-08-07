import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  SOURCE_LEDGER_VERSION,
  SOURCE_LEDGER_FINDING_CODES: CODES,
  SourceLedgerError,
  buildSourceLedger,
  validateSourceLedgerClaims,
} = require('../../server/services/addScenarioSourceLedger');

function fullClaim(unit, disposition = 'action', ref = `${disposition}-${unit.ordinal}`) {
  const links = ['action', 'assertion', 'condition', 'data'].includes(disposition)
    ? [{ kind: disposition, ref }]
    : [];
  return {
    unitRef: unit.id,
    disposition,
    sourceSpan: { ...unit.sourceSpan },
    sourceQuote: unit.sourceQuote,
    links,
  };
}

function findingCodes(report) {
  return report.findings.map((entry) => entry.code);
}

describe('SourceLedgerV1', () => {
  it('builds lossless deterministic structural units without assigning browser meaning', () => {
    const sourceText = [
      '# Account workflow',
      'Steps:',
      '1. Open the account page.',
      '- Continue and verify the result.',
      '| Field | Value |',
      '| Email | user@example.com |',
      'Access Code = 007995145',
      'Verify status. Continue safely!',
    ].join('\n');

    const ledger = buildSourceLedger(sourceText);
    const repeated = buildSourceLedger(sourceText);

    expect(ledger.version).toBe(SOURCE_LEDGER_VERSION);
    expect(ledger.units.map((unit) => unit.kind)).toEqual([
      'heading',
      'heading',
      'numbered',
      'bullet',
      'table_row',
      'table_row',
      'data_declaration',
      'sentence',
      'sentence',
    ]);
    expect(ledger.units.map((unit) => unit.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(ledger.units.map((unit) => unit.id)).size).toBe(ledger.units.length);
    ledger.units.forEach((unit) => {
      expect(sourceText.slice(unit.sourceSpan.start, unit.sourceSpan.end)).toBe(unit.sourceQuote);
      expect(unit.quoteDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    });
    for (let index = 0; index < sourceText.length; index += 1) {
      if (/\s/.test(sourceText[index])) continue;
      expect(ledger.units.filter((unit) => index >= unit.sourceSpan.start && index < unit.sourceSpan.end)).toHaveLength(1);
    }
    expect(ledger.sourceDigest).toBe(repeated.sourceDigest);
    expect(ledger.ledgerDigest).toBe(repeated.ledgerDigest);
    expect(ledger).toEqual(repeated);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(ledger.units[0])).toBe(true);

    const numberedUnit = ledger.units.find((unit) => unit.kind === 'numbered');
    expect(ledger.literals.some((literal) => literal.unitRef === numberedUnit.id && literal.sourceQuote === '1')).toBe(false);
    expect(ledger.literals.map((literal) => literal.sourceQuote)).toEqual(expect.arrayContaining(['user@example.com', '007995145']));
  });

  it('supports more than 100 deterministic units and fails a configured smaller bound', () => {
    const sourceText = Array.from({ length: 120 }, (_, index) => `${index + 1}. Perform independent item ${index + 1}.`).join('\n');
    const ledger = buildSourceLedger(sourceText);

    expect(ledger.unitCount).toBe(120);
    expect(ledger.units.at(-1).ordinal).toBe(120);
    expect(new Set(ledger.units.map((unit) => unit.id)).size).toBe(120);
    expect(() => buildSourceLedger(sourceText, { maxUnits: 100 })).toThrowError(SourceLedgerError);
    try {
      buildSourceLedger(sourceText, { maxUnits: 100 });
    } catch (error) {
      expect(error.findings[0].code).toBe(CODES.UNIT_LIMIT_EXCEEDED);
      expect(error.findings[0].details).toEqual({ count: 120, maxUnits: 100 });
    }
  });

  it('accepts exact complete claims and exposes a deterministic integration report', () => {
    const sourceText = ['Scenario:', '1. Click Continue.', 'Verify Ready is visible.', 'Test Id: 007'].join('\n');
    const ledger = buildSourceLedger(sourceText);
    const claims = ledger.units.map((unit) => {
      if (unit.kind === 'heading') return fullClaim(unit, 'metadata');
      if (unit.kind === 'data_declaration') return fullClaim(unit, 'data');
      if (/^Verify/.test(unit.sourceQuote)) return fullClaim(unit, 'assertion');
      return fullClaim(unit, 'action');
    });
    const requiredLiterals = ledger.literals.filter((literal) => {
      const unit = ledger.units.find((entry) => entry.id === literal.unitRef);
      return unit.kind === 'data_declaration' || /^Verify/.test(unit.sourceQuote) || unit.kind === 'numbered';
    });
    const literalUsages = requiredLiterals.map((literal) => ({ literalRef: literal.id, consumerRefs: [`binding-${literal.ordinal}`] }));

    const report = validateSourceLedgerClaims(ledger, sourceText, { claims, literalUsages });
    const repeated = validateSourceLedgerClaims(ledger, sourceText, { claims, literalUsages });

    expect(report.valid).toBe(true);
    expect(report.complete).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.coverage).toMatchObject({ totalUnits: 4, claimedUnits: 4, omittedUnitRefs: [], residualSpans: [] });
    expect(report.unlinkedExecutableUnitIds).toEqual([]);
    expect(report.unconsumedLiteralUnitIds).toEqual([]);
    expect(report.unresolvedUnitIds).toEqual([]);
    expect(report.claimsDigest).toBe(repeated.claimsDigest);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('reports omitted executable units, missing links, duplicate coverage, and residual compound text independently', () => {
    const sourceText = ['Click Save and verify Success.', 'Click Continue.'].join('\n');
    const ledger = buildSourceLedger(sourceText);
    const compound = ledger.units[0];
    const second = ledger.units[1];
    const actionQuote = 'Click Save';
    const actionStart = compound.sourceSpan.start;
    const partialClaim = {
      unitRef: compound.id,
      disposition: 'action',
      sourceSpan: { start: actionStart, end: actionStart + actionQuote.length },
      sourceQuote: actionQuote,
      links: [],
    };

    const report = validateSourceLedgerClaims(ledger, sourceText, {
      claims: [partialClaim, { ...partialClaim, links: [{ kind: 'action', ref: 'duplicate-action' }] }],
    });
    const codes = findingCodes(report);

    expect(report.valid).toBe(false);
    expect(codes).toContain(CODES.EXECUTABLE_LINK_MISSING);
    expect(codes).toContain(CODES.CLAIM_COVERAGE_DUPLICATE);
    expect(codes).toContain(CODES.COMPOUND_TEXT_RESIDUAL);
    expect(codes).toContain(CODES.SOURCE_UNIT_OMITTED);
    expect(report.coverage.omittedUnitRefs).toEqual([second.id]);
    expect(report.coverage.residualSpans.map((entry) => sourceText.slice(entry.sourceSpan.start, entry.sourceSpan.end)).join('')).toContain('andverifySuccess.');
    expect(report.coverage.residualSpans.every((entry) => !Object.hasOwn(entry, 'sourceQuote'))).toBe(true);
    expect(report.unlinkedExecutableUnitIds).toEqual([compound.id]);
  });

  it('keeps metadata and unresolved classifications explicit without inventing executable links', () => {
    const sourceText = ['Notes:', 'Use the approved environment.', 'Choose the appropriate account if available.'].join('\n');
    const ledger = buildSourceLedger(sourceText);
    const claims = [
      fullClaim(ledger.units[0], 'metadata'),
      fullClaim(ledger.units[1], 'metadata'),
      fullClaim(ledger.units[2], 'unresolved'),
    ];

    const report = validateSourceLedgerClaims(ledger, sourceText, { claims });

    expect(report.valid).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.unresolvedUnitIds).toEqual([ledger.units[2].id]);
    expect(report.unlinkedExecutableUnitIds).toEqual([]);
  });

  it('reports exact inline and declared literals that executable claims fail to consume', () => {
    const sourceText = ['Token: demo-token', 'Enter "COL" in field 007.'].join('\n');
    const ledger = buildSourceLedger(sourceText);
    const claims = [fullClaim(ledger.units[0], 'data'), fullClaim(ledger.units[1], 'action')]
      .map((claim) => ({
        ...claim,
        sourceQuote: sourceText.slice(claim.sourceSpan.start, claim.sourceSpan.end),
      }));

    const missing = validateSourceLedgerClaims(ledger, sourceText, { claims });
    expect(findingCodes(missing)).toContain(CODES.LITERAL_UNCONSUMED);
    expect(missing.unconsumedLiteralUnitIds).toEqual(expect.arrayContaining(ledger.units.map((unit) => unit.id)));

    const literalUsages = ledger.literals.map((literal) => ({ literalRef: literal.id, consumerRefs: [`consumer-${literal.ordinal}`] }));
    const consumed = validateSourceLedgerClaims(ledger, sourceText, { claims, literalUsages });
    expect(consumed.valid).toBe(true);
    expect(consumed.complete).toBe(true);
    expect(consumed.literals.consumed).toBe(consumed.literals.required);
  });

  it('rejects claim evidence drift and serialized ledger tampering', () => {
    const sourceText = 'Click Continue.';
    const ledger = buildSourceLedger(sourceText);
    const unit = ledger.units[0];
    const driftedClaim = {
      ...fullClaim(unit, 'action'),
      sourceQuote: 'Click Something Else.',
    };
    const drift = validateSourceLedgerClaims(ledger, sourceText, { claims: [driftedClaim] });
    expect(findingCodes(drift)).toContain(CODES.CLAIM_QUOTE_MISMATCH);

    const tampered = JSON.parse(JSON.stringify(ledger));
    tampered.units[0].sourceQuote = 'Click Tampered.';
    const tamper = validateSourceLedgerClaims(tampered, sourceText, { claims: [] });
    expect(findingCodes(tamper)).toContain(CODES.LEDGER_DIGEST_MISMATCH);
  });

  it('keeps password/token values process-local and redacts residual diagnostics', () => {
    const password = 'ultra-private-password-value';
    const token = 'token-value-that-must-not-leak';
    const sourceText = [
      `Password: ${password}`,
      `API Token = ${token}`,
      `Enter "${token}" and continue.`,
    ].join('\n');
    const sensitiveValues = [password, token];
    const ledger = buildSourceLedger(sourceText, { sensitiveValues });
    const serializedLedger = JSON.stringify(ledger);

    expect(serializedLedger).not.toContain(password);
    expect(serializedLedger).not.toContain(token);
    expect(ledger.units.every((unit) => unit.sensitive && unit.redacted)).toBe(true);
    expect(ledger.literals.filter((literal) => literal.sensitive).every((literal) => literal.sourceQuote === '[REDACTED]')).toBe(true);
    ledger.units.forEach((unit) => {
      expect(unit.quoteDigest).not.toBe('');
      expect(sourceText.slice(unit.sourceSpan.start, unit.sourceSpan.end)).not.toBe('');
    });

    const first = ledger.units[0];
    const prefixQuote = 'Password:';
    const claims = [{
      unitRef: first.id,
      disposition: 'data',
      sourceSpan: { start: first.sourceSpan.start, end: first.sourceSpan.start + prefixQuote.length },
      sourceQuote: prefixQuote,
      links: [{ kind: 'data', ref: 'password-binding' }],
    }];
    const report = validateSourceLedgerClaims(ledger, sourceText, {
      sensitiveValues,
      claims,
      requiredLiteralRefs: ledger.literals.map((literal) => literal.id),
    });
    const serializedReport = JSON.stringify(report);

    expect(report.valid).toBe(false);
    expect(findingCodes(report)).toContain(CODES.COMPOUND_TEXT_RESIDUAL);
    expect(findingCodes(report)).toContain(CODES.LITERAL_UNCONSUMED);
    expect(serializedReport).not.toContain(password);
    expect(serializedReport).not.toContain(token);
    expect(report.coverage.residualSpans.every((entry) => !Object.hasOwn(entry, 'sourceQuote'))).toBe(true);
    expect(report.coverage.residualSpans.some((entry) => entry.redacted === true)).toBe(true);
  });
});
