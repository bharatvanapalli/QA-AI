export const SOURCE_COVERAGE_SECRET = 'Phase5-Coverage-Secret-Do-Not-Report!';

const CORE_ENTRIES = Object.freeze([
  { key: 'scenario_heading', disposition: 'metadata', text: '# Coverage integrity demonstration' },
  { key: 'open_workspace', disposition: 'action', text: '1. Open the request workspace.' },
  { key: 'unique_middle_action', disposition: 'action', text: '2. Click the unique middle control.' },
  { key: 'open_details', disposition: 'action', text: '3. Open the details panel.' },
  { key: 'required_assertion', disposition: 'assertion', text: '4. Verify the details panel is visible.' },
  { key: 'required_condition', disposition: 'condition', text: '5. If the Advanced section is collapsed, expand it.' },
  { key: 'order_data', disposition: 'data', text: 'Order Number = 007995145' },
  { key: 'consume_order_data', disposition: 'action', text: '6. Enter 007995145 in the Order Number field.' },
  {
    key: 'compound_operation',
    text: '7. Open the Priority dropdown, select High, and verify High is selected.',
    segments: Object.freeze([
      { key: 'compound_open', disposition: 'action', text: '7. Open the Priority dropdown,' },
      { key: 'compound_select', disposition: 'action', text: ' select High,' },
      { key: 'compound_assert', disposition: 'assertion', text: ' and verify High is selected.' },
    ]),
  },
  { key: 'refresh_first', disposition: 'action', text: '8. Click Refresh.' },
  { key: 'refresh_second', disposition: 'action', text: '8. Click Refresh.' },
  { key: 'notes_heading', disposition: 'metadata', text: 'Notes:' },
  { key: 'metadata_note', disposition: 'metadata', text: '- Preserve this authored note as metadata only.' },
  { key: 'unresolved_follow_up', disposition: 'unresolved', text: '9. Complete the unspecified follow-up requested by the user.' },
  { key: 'secret_data', disposition: 'data', text: `API Token = ${SOURCE_COVERAGE_SECRET}` },
  { key: 'consume_secret', disposition: 'action', text: `10. Enter ${SOURCE_COVERAGE_SECRET} in the API Token field.` },
]);

function compilerRef(key, index) {
  return `compiler:${key}:${String(index + 1).padStart(3, '0')}`;
}

function claimFor(unit, disposition, sourceSpan, sourceQuote, key, index) {
  const links = ['metadata', 'unresolved'].includes(disposition)
    ? []
    : [{ kind: disposition, ref: compilerRef(key, index) }];
  return {
    unitRef: unit.id,
    disposition,
    sourceSpan: { ...sourceSpan },
    sourceQuote,
    links,
  };
}

function consumeUnitByQuote(unitsByQuote, cursorByQuote, sourceQuote) {
  const candidates = unitsByQuote.get(sourceQuote) || [];
  const cursor = cursorByQuote.get(sourceQuote) || 0;
  const unit = candidates[cursor];
  if (!unit) throw new Error(`Fixture could not resolve SourceLedger unit for: ${sourceQuote}`);
  cursorByQuote.set(sourceQuote, cursor + 1);
  return unit;
}

/**
 * Translate fixture truth into exact provider claims after SourceLedgerV1 has
 * assigned deterministic IDs and absolute spans. This helper does not infer
 * semantics; CORE_ENTRIES is the independent fixture authority.
 */
export function claimsForCoverageFixture(ledger, options = {}) {
  const entries = options.entries || CORE_ENTRIES;
  const rawSource = options.sourceText || entries.map((entry) => entry.text).join('\n');
  const omitted = new Set(options.omitKeys || []);
  const unitsByQuote = new Map();
  ledger.units.forEach((unit) => {
    const exactSourceQuote = rawSource.slice(unit.sourceSpan.start, unit.sourceSpan.end);
    const candidates = unitsByQuote.get(exactSourceQuote) || [];
    candidates.push(unit);
    unitsByQuote.set(exactSourceQuote, candidates);
  });
  const cursorByQuote = new Map();
  const claims = [];
  const unitRefsByKey = {};
  let claimIndex = 0;

  entries.forEach((entry) => {
    const unit = consumeUnitByQuote(unitsByQuote, cursorByQuote, entry.text);
    unitRefsByKey[entry.key] = unit.id;
    if (entry.segments) {
      let relativeCursor = 0;
      entry.segments.forEach((segment) => {
        const relativeStart = entry.text.indexOf(segment.text, relativeCursor);
        if (relativeStart < 0) throw new Error(`Compound segment is not exact source: ${segment.text}`);
        relativeCursor = relativeStart + segment.text.length;
        unitRefsByKey[segment.key] = unit.id;
        if (omitted.has(segment.key) || omitted.has(entry.key)) return;
        const sourceSpan = {
          start: unit.sourceSpan.start + relativeStart,
          end: unit.sourceSpan.start + relativeStart + segment.text.length,
        };
        claims.push(claimFor(unit, segment.disposition, sourceSpan, segment.text, segment.key, claimIndex));
        claimIndex += 1;
      });
      return;
    }
    if (omitted.has(entry.key)) return;
    claims.push(claimFor(
      unit,
      entry.disposition,
      unit.sourceSpan,
      rawSource.slice(unit.sourceSpan.start, unit.sourceSpan.end),
      entry.key,
      claimIndex,
    ));
    claimIndex += 1;
  });

  const omittedLiteralIds = new Set(options.omitLiteralIds || []);
  const literalUsages = ledger.literals
    .filter((literal) => !omittedLiteralIds.has(literal.id))
    .map((literal, index) => ({
      literalRef: literal.id,
      consumerRefs: [`compiler:literal:${String(index + 1).padStart(3, '0')}`],
    }));

  return {
    claims,
    literalUsages,
    requiredLiteralRefs: [],
    unitRefsByKey,
  };
}

export function buildSourceCoverageFixture() {
  return {
    rawSource: CORE_ENTRIES.map((entry) => entry.text).join('\n'),
    entries: CORE_ENTRIES,
  };
}

function largeOperation(ordinal) {
  const number = String(ordinal).padStart(3, '0');
  if (ordinal <= 54) {
    return {
      key: `large_action_${number}`,
      disposition: 'action',
      text: `${ordinal}. Fill Field ${number} with VALUE-${number}.`,
    };
  }
  return {
    key: `large_assertion_${number}`,
    disposition: 'assertion',
    text: `${ordinal}. Verify Field ${number} equals VALUE-${number}.`,
  };
}

export function buildLargeSourceCoverageFixture() {
  const operations = Array.from({ length: 89 }, (_, index) => largeOperation(index + 1));
  const entries = [
    { key: 'large_heading', disposition: 'metadata', text: '# Large authored flow with 89 atomic operations' },
    ...operations,
  ];
  return {
    rawSource: entries.map((entry) => entry.text).join('\n'),
    entries,
    operationCount: operations.length,
  };
}

export function literalIdsForEntry(ledger, unitRef) {
  return ledger.literals
    .filter((literal) => literal.unitRef === unitRef)
    .map((literal) => literal.id);
}
