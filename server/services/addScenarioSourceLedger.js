'use strict';

const crypto = require('node:crypto');

/**
 * SourceLedgerV1 is compiler-owned structural evidence for Add Scenario.
 *
 * It deliberately does not infer browser actions, targets, assertions, or test
 * intent. It only partitions the immutable authored source into exact,
 * deterministic structural units and validates a provider's later semantic
 * disposition/link claims against that evidence.
 */

const SOURCE_LEDGER_VERSION = 'SourceLedgerV1';
const DEFAULT_SOURCE_LEDGER_MAX_UNITS = 250;

const SOURCE_UNIT_KINDS = Object.freeze([
  'heading',
  'bullet',
  'numbered',
  'table_row',
  'data_declaration',
  'sentence',
]);

const SOURCE_DISPOSITIONS = Object.freeze([
  'action',
  'assertion',
  'condition',
  'data',
  'metadata',
  'unresolved',
]);

const SOURCE_LEDGER_FINDING_CODES = Object.freeze({
  SOURCE_REQUIRED: 'source_ledger_source_required',
  UNIT_LIMIT_EXCEEDED: 'source_ledger_unit_limit_exceeded',
  LEDGER_INVALID: 'source_ledger_invalid',
  LEDGER_DIGEST_MISMATCH: 'source_ledger_digest_mismatch',
  SOURCE_DIGEST_MISMATCH: 'source_ledger_source_digest_mismatch',
  SOURCE_TEXT_UNCOVERED: 'source_ledger_source_text_uncovered',
  CLAIMS_REQUIRED: 'source_ledger_claims_required',
  CLAIM_INVALID: 'source_ledger_claim_invalid',
  CLAIM_UNIT_UNKNOWN: 'source_ledger_claim_unit_unknown',
  CLAIM_DISPOSITION_INVALID: 'source_ledger_claim_disposition_invalid',
  CLAIM_SPAN_INVALID: 'source_ledger_claim_span_invalid',
  CLAIM_QUOTE_MISMATCH: 'source_ledger_claim_quote_mismatch',
  CLAIM_COVERAGE_DUPLICATE: 'source_ledger_claim_coverage_duplicate',
  SOURCE_UNIT_OMITTED: 'source_ledger_source_unit_omitted',
  COMPOUND_TEXT_RESIDUAL: 'source_ledger_compound_text_residual',
  EXECUTABLE_LINK_MISSING: 'source_ledger_executable_link_missing',
  LINK_INVALID: 'source_ledger_link_invalid',
  LINK_DUPLICATE: 'source_ledger_link_duplicate',
  LITERAL_REF_UNKNOWN: 'source_ledger_literal_ref_unknown',
  LITERAL_USAGE_DUPLICATE: 'source_ledger_literal_usage_duplicate',
  LITERAL_CONSUMER_MISSING: 'source_ledger_literal_consumer_missing',
  LITERAL_UNCONSUMED: 'source_ledger_literal_unconsumed',
});

const SHA256_RE = /^sha256-[a-f0-9]{64}$/;
const REDACTED_SOURCE = '[REDACTED]';
const SENSITIVE_LABEL_RE = /(?:^|[^a-z0-9])(?:pass(?:word|code)?|pwd|secret|token|api[_ -]?key|credential|otp|mfa|pin)(?:$|[^a-z0-9])/i;
const DISPOSITION_SET = new Set(SOURCE_DISPOSITIONS);
const EXECUTABLE_DISPOSITIONS = new Set(['action', 'assertion', 'condition']);
const LINK_KINDS = new Set(SOURCE_DISPOSITIONS);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableSerialize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function sha256Text(value) {
  return `sha256-${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function deterministicId(prefix, identity) {
  return `${prefix}-${crypto.createHash('sha256').update(stableSerialize(identity), 'utf8').digest('hex').slice(0, 24)}`;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function finding(path, code, message, details = undefined) {
  const output = { path, code, message };
  if (details !== undefined) output.details = details;
  return output;
}

function normalizeMaxUnits(value) {
  const candidate = value === undefined ? DEFAULT_SOURCE_LEDGER_MAX_UNITS : value;
  if (!Number.isInteger(candidate) || candidate <= 0) {
    throw new SourceLedgerError('SourceLedgerV1 maxUnits must be a positive integer.', [
      finding('options.maxUnits', SOURCE_LEDGER_FINDING_CODES.LEDGER_INVALID, 'maxUnits must be a positive integer.'),
    ]);
  }
  return candidate;
}

function normalizeSensitiveValues(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !isNonBlankString(entry))) {
    throw new SourceLedgerError('SourceLedgerV1 sensitiveValues must contain non-empty strings.', [
      finding('options.sensitiveValues', SOURCE_LEDGER_FINDING_CODES.LEDGER_INVALID, 'sensitiveValues must be an array of non-empty strings.'),
    ]);
  }
  return [...new Set(value)].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function redactExplicitValues(text, sensitiveValues) {
  return sensitiveValues.reduce((output, value) => output.split(value).join(REDACTED_SOURCE), text);
}

function trimSpan(sourceText, start, end) {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/.test(sourceText[trimmedStart])) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/.test(sourceText[trimmedEnd - 1])) trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}

function sourceLines(sourceText) {
  const output = [];
  let start = 0;
  while (start < sourceText.length) {
    let contentEnd = start;
    while (contentEnd < sourceText.length && sourceText[contentEnd] !== '\n' && sourceText[contentEnd] !== '\r') contentEnd += 1;
    let fullEnd = contentEnd;
    if (sourceText[fullEnd] === '\r' && sourceText[fullEnd + 1] === '\n') fullEnd += 2;
    else if (sourceText[fullEnd] === '\r' || sourceText[fullEnd] === '\n') fullEnd += 1;
    output.push({ start, contentEnd, fullEnd });
    start = fullEnd;
  }
  return output;
}

function tableCellCount(text) {
  return text.split('|').map((entry) => entry.trim()).filter(Boolean).length;
}

function dataDeclaration(text, absoluteStart) {
  const match = /^([^:=\r\n]{1,120}?)(\s*)(:|=)(\s*)(\S[\s\S]*)$/.exec(text);
  if (!match) return null;
  const key = match[1].trim();
  const value = match[5].trimEnd();
  if (!key || /^(?:https?|ftp)$/i.test(key) || (match[3] === ':' && value.startsWith('//'))) return null;
  const separatorOffset = match[1].length + match[2].length;
  const valueOffset = separatorOffset + match[3].length + match[4].length;
  const keyLeading = match[1].length - match[1].trimStart().length;
  const keyStart = absoluteStart + keyLeading;
  const valueStart = absoluteStart + valueOffset;
  return {
    key,
    separator: match[3],
    keySpan: { start: keyStart, end: keyStart + key.length },
    valueSpan: { start: valueStart, end: valueStart + value.length },
    valueQuote: value,
  };
}

function classifyStructuralLine(text, absoluteStart) {
  const markdownHeading = /^(#{1,6})\s+\S/.exec(text);
  if (markdownHeading) return { kind: 'heading', marker: markdownHeading[1] };
  if (/^\S[\s\S]{0,160}:$/.test(text)) return { kind: 'heading', marker: ':' };
  if ((text.match(/\|/g) || []).length >= 2 && tableCellCount(text) > 0) {
    return { kind: 'table_row', columns: tableCellCount(text) };
  }
  const numbered = /^((?:\d+|[A-Za-z])[.)])\s+\S/.exec(text);
  if (numbered) return { kind: 'numbered', marker: numbered[1] };
  const bullet = /^([-+*•])\s+\S/.exec(text);
  if (bullet) return { kind: 'bullet', marker: bullet[1] };
  const declaration = dataDeclaration(text, absoluteStart);
  if (declaration) return { kind: 'data_declaration', declaration };
  return { kind: 'sentence' };
}

function sentenceSpans(sourceText, start, end) {
  const output = [];
  let cursor = start;
  for (let index = start; index < end; index += 1) {
    if (!/[.!?]/.test(sourceText[index])) continue;
    let next = index + 1;
    if (next >= end || !/\s/.test(sourceText[next])) continue;
    while (next < end && /\s/.test(sourceText[next])) next += 1;
    if (next >= end) continue;
    const span = trimSpan(sourceText, cursor, index + 1);
    if (span.end > span.start) output.push(span);
    cursor = next;
    index = next - 1;
  }
  const finalSpan = trimSpan(sourceText, cursor, end);
  if (finalSpan.end > finalSpan.start) output.push(finalSpan);
  return output;
}

function structuralUnits(sourceText) {
  const provisional = [];
  sourceLines(sourceText).forEach((line) => {
    const lineSpan = trimSpan(sourceText, line.start, line.contentEnd);
    if (lineSpan.end <= lineSpan.start) return;
    const lineText = sourceText.slice(lineSpan.start, lineSpan.end);
    const structural = classifyStructuralLine(lineText, lineSpan.start);
    const spans = structural.kind === 'sentence'
      ? sentenceSpans(sourceText, lineSpan.start, lineSpan.end)
      : [lineSpan];
    spans.forEach((span) => provisional.push({ kind: structural.kind, structural, span }));
  });

  return provisional.map((entry, index) => {
    const sourceQuote = sourceText.slice(entry.span.start, entry.span.end);
    const quoteDigest = sha256Text(sourceQuote);
    const structural = { ...entry.structural };
    delete structural.kind;
    const identity = {
      ordinal: index + 1,
      kind: entry.kind,
      sourceSpan: entry.span,
      quoteDigest,
      structural,
    };
    return {
      id: deterministicId('source-unit', identity),
      ordinal: index + 1,
      kind: entry.kind,
      sourceSpan: { ...entry.span },
      sourceQuote,
      quoteDigest,
      structural,
    };
  });
}

function candidateLiteralSpans(unit) {
  const candidates = [];
  const add = (kind, start, end) => {
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return;
    candidates.push({ kind, start, end });
  };

  const declaration = unit.structural?.declaration;
  if (unit.kind === 'data_declaration' && isPlainObject(declaration?.valueSpan)) {
    add('data_value', declaration.valueSpan.start, declaration.valueSpan.end);
  }

  const quote = unit.sourceQuote;
  const absolute = unit.sourceSpan.start;
  const numberedPrefix = unit.kind === 'numbered' ? /^((?:\d+|[A-Za-z])[.)])\s+/.exec(quote) : null;
  const semanticBodyStart = absolute + (numberedPrefix ? numberedPrefix[0].length : 0);
  const patterns = [
    ['quoted', /(["'`])(?:\\.|(?!\1)[^\\])*\1/g],
    ['url', /https?:\/\/[^\s<>"'`]+/gi],
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi],
    ['numeric', /\b\d[\d,:./-]*\b/g],
  ];
  patterns.forEach(([kind, pattern]) => {
    let match;
    while ((match = pattern.exec(quote)) !== null) {
      let end = match.index + match[0].length;
      if (kind === 'url') {
        while (end > match.index && /[),.;!?]/.test(quote[end - 1])) end -= 1;
      }
      const candidateStart = absolute + match.index;
      const candidateEnd = absolute + end;
      if (candidateEnd > semanticBodyStart) add(kind, candidateStart, candidateEnd);
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  });

  const priority = { data_value: 4, quoted: 3, url: 2, email: 2, numeric: 1 };
  candidates.sort((left, right) => (
    priority[right.kind] - priority[left.kind]
    || (right.end - right.start) - (left.end - left.start)
    || left.start - right.start
  ));
  const accepted = [];
  candidates.forEach((candidate) => {
    if (accepted.some((entry) => candidate.start >= entry.start && candidate.end <= entry.end)) return;
    accepted.push(candidate);
  });
  return accepted.sort((left, right) => left.start - right.start || left.end - right.end);
}

function structuralLiterals(sourceText, units) {
  const output = [];
  units.forEach((unit) => {
    candidateLiteralSpans(unit).forEach((candidate) => {
      const sourceQuote = sourceText.slice(candidate.start, candidate.end);
      const quoteDigest = sha256Text(sourceQuote);
      const identity = {
        unitRef: unit.id,
        kind: candidate.kind,
        sourceSpan: { start: candidate.start, end: candidate.end },
        quoteDigest,
      };
      output.push({
        id: deterministicId('source-literal', identity),
        ordinal: output.length + 1,
        unitRef: unit.id,
        kind: candidate.kind,
        sourceSpan: { start: candidate.start, end: candidate.end },
        sourceQuote,
        quoteDigest,
      });
    });
  });
  return output;
}

function projectSensitiveEvidence(sourceText, units, literals, sensitiveValues) {
  const projectedUnits = units.map((unit) => {
    const exactQuote = sourceText.slice(unit.sourceSpan.start, unit.sourceSpan.end);
    const declaration = unit.structural?.declaration;
    const sensitiveDeclaration = unit.kind === 'data_declaration'
      && isNonBlankString(declaration?.key)
      && SENSITIVE_LABEL_RE.test(declaration.key);
    const explicitSensitive = sensitiveValues.some((value) => exactQuote.includes(value));
    const unscopedSensitiveLabel = !declaration && SENSITIVE_LABEL_RE.test(exactQuote);
    const sensitive = sensitiveDeclaration || explicitSensitive || unscopedSensitiveLabel;
    if (!sensitive) return { ...unit, sensitive: false, redacted: false };

    let sourceQuote;
    const structural = { ...unit.structural };
    if (sensitiveDeclaration && isPlainObject(declaration?.valueSpan)) {
      const relativeStart = declaration.valueSpan.start - unit.sourceSpan.start;
      const relativeEnd = declaration.valueSpan.end - unit.sourceSpan.start;
      sourceQuote = `${exactQuote.slice(0, relativeStart)}${REDACTED_SOURCE}${exactQuote.slice(relativeEnd)}`;
      structural.declaration = { ...declaration, valueQuote: REDACTED_SOURCE };
    } else {
      sourceQuote = redactExplicitValues(exactQuote, sensitiveValues);
    }
    if (!sensitiveDeclaration && unscopedSensitiveLabel && sourceQuote === exactQuote) {
      sourceQuote = REDACTED_SOURCE;
    } else if (!sensitiveDeclaration && isPlainObject(declaration)) {
      structural.declaration = {
        ...declaration,
        valueQuote: redactExplicitValues(declaration.valueQuote, sensitiveValues),
      };
    }
    return { ...unit, sourceQuote, structural, sensitive: true, redacted: true };
  });

  const projectedUnitById = new Map(projectedUnits.map((unit) => [unit.id, unit]));
  const projectedLiterals = literals.map((literal) => {
    const parent = projectedUnitById.get(literal.unitRef);
    const exactQuote = sourceText.slice(literal.sourceSpan.start, literal.sourceSpan.end);
    const sensitive = parent?.sensitive === true || sensitiveValues.some((value) => exactQuote.includes(value));
    return {
      ...literal,
      sourceQuote: sensitive ? REDACTED_SOURCE : exactQuote,
      sensitive,
      redacted: sensitive,
    };
  });
  return { units: projectedUnits, literals: projectedLiterals };
}

function uncoveredNonWhitespace(sourceText, units) {
  const covered = new Uint8Array(sourceText.length);
  units.forEach((unit) => {
    for (let index = unit.sourceSpan.start; index < unit.sourceSpan.end; index += 1) covered[index] += 1;
  });
  const missing = [];
  for (let index = 0; index < sourceText.length; index += 1) {
    if (/\S/.test(sourceText[index]) && covered[index] !== 1) missing.push(index);
  }
  return missing;
}

class SourceLedgerError extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = 'SourceLedgerError';
    this.code = findings[0]?.code || SOURCE_LEDGER_FINDING_CODES.LEDGER_INVALID;
    this.findings = findings;
  }
}

/** Build and freeze deterministic SourceLedgerV1 structural evidence. */
function buildSourceLedger(sourceText, options = {}) {
  if (!isNonBlankString(sourceText)) {
    throw new SourceLedgerError('SourceLedgerV1 requires non-empty authored source.', [
      finding('sourceText', SOURCE_LEDGER_FINDING_CODES.SOURCE_REQUIRED, 'Authored source text must be non-empty.'),
    ]);
  }
  const maxUnits = normalizeMaxUnits(options.maxUnits);
  const sensitiveValues = normalizeSensitiveValues(options.sensitiveValues);
  const exactUnits = structuralUnits(sourceText);
  if (exactUnits.length > maxUnits) {
    throw new SourceLedgerError('SourceLedgerV1 unit limit exceeded.', [
      finding('units', SOURCE_LEDGER_FINDING_CODES.UNIT_LIMIT_EXCEEDED, `Source contains ${exactUnits.length} structural units; the configured bound is ${maxUnits}.`, { count: exactUnits.length, maxUnits }),
    ]);
  }
  const missing = uncoveredNonWhitespace(sourceText, exactUnits);
  if (missing.length > 0) {
    throw new SourceLedgerError('SourceLedgerV1 could not cover the exact authored source.', [
      finding('units', SOURCE_LEDGER_FINDING_CODES.SOURCE_TEXT_UNCOVERED, 'Every non-whitespace source character must occur in exactly one structural unit.', { offsets: missing.slice(0, 50) }),
    ]);
  }
  const sourceDigest = sha256Text(sourceText);
  const exactLiterals = structuralLiterals(sourceText, exactUnits);
  const { units, literals } = projectSensitiveEvidence(sourceText, exactUnits, exactLiterals, sensitiveValues);
  const digestAuthority = {
    version: SOURCE_LEDGER_VERSION,
    sourceDigest,
    unitCount: units.length,
    units,
    literals,
  };
  const ledger = {
    ...digestAuthority,
    ledgerDigest: sha256Text(stableSerialize(digestAuthority)),
  };
  return deepFreeze(ledger);
}

/** Validate a serialized ledger against its exact immutable source. */
function validateSourceLedger(ledger, sourceText, options = {}) {
  const findings = [];
  if (!isPlainObject(ledger) || ledger.version !== SOURCE_LEDGER_VERSION) {
    findings.push(finding('ledger', SOURCE_LEDGER_FINDING_CODES.LEDGER_INVALID, 'A SourceLedgerV1 object is required.'));
    return { valid: false, findings };
  }
  if (typeof sourceText !== 'string' || sha256Text(sourceText) !== ledger.sourceDigest) {
    findings.push(finding('sourceDigest', SOURCE_LEDGER_FINDING_CODES.SOURCE_DIGEST_MISMATCH, 'The ledger does not belong to this exact authored source.'));
    return { valid: false, findings };
  }
  let expected;
  try {
    expected = buildSourceLedger(sourceText, {
      maxUnits: Math.max(DEFAULT_SOURCE_LEDGER_MAX_UNITS, Number(ledger.unitCount) || 0),
      sensitiveValues: options.sensitiveValues,
    });
  } catch (error) {
    findings.push(...(Array.isArray(error?.findings) ? error.findings : [finding('ledger', SOURCE_LEDGER_FINDING_CODES.LEDGER_INVALID, error?.message || 'Ledger validation failed.')]));
    return { valid: false, findings };
  }
  if (!SHA256_RE.test(String(ledger.ledgerDigest || '')) || stableSerialize(expected) !== stableSerialize(ledger)) {
    findings.push(finding('ledgerDigest', SOURCE_LEDGER_FINDING_CODES.LEDGER_DIGEST_MISMATCH, 'Ledger content or deterministic digest was modified.'));
  }
  return { valid: findings.length === 0, findings };
}

function normalizeClaimSpan(claim, unit, sourceText, path, findings) {
  const span = claim.sourceSpan;
  if (!isPlainObject(span) || !Number.isInteger(span.start) || !Number.isInteger(span.end)
    || span.start < unit.sourceSpan.start || span.end > unit.sourceSpan.end || span.end <= span.start) {
    findings.push(finding(`${path}.sourceSpan`, SOURCE_LEDGER_FINDING_CODES.CLAIM_SPAN_INVALID, 'Claim span must be a non-empty exact subspan of its source unit.'));
    return null;
  }
  if (typeof claim.sourceQuote !== 'string'
    || claim.sourceQuote !== sourceText.slice(span.start, span.end)) {
    findings.push(finding(`${path}.sourceQuote`, SOURCE_LEDGER_FINDING_CODES.CLAIM_QUOTE_MISMATCH, 'Claim quote must exactly match its claimed source span.'));
    return null;
  }
  return { start: span.start, end: span.end };
}

function validateLinks(claim, disposition, path, findings) {
  const links = Array.isArray(claim.links) ? claim.links : [];
  const seen = new Set();
  const valid = [];
  links.forEach((link, index) => {
    const linkPath = `${path}.links[${index}]`;
    if (!isPlainObject(link) || !LINK_KINDS.has(link.kind) || !isNonBlankString(link.ref)) {
      findings.push(finding(linkPath, SOURCE_LEDGER_FINDING_CODES.LINK_INVALID, 'Links require a supported kind and non-empty compiler record reference.'));
      return;
    }
    const key = `${link.kind}:${link.ref}`;
    if (seen.has(key)) {
      findings.push(finding(linkPath, SOURCE_LEDGER_FINDING_CODES.LINK_DUPLICATE, 'A provider claim cannot repeat the same semantic link.'));
      return;
    }
    seen.add(key);
    valid.push({ kind: link.kind, ref: link.ref });
  });
  if ((EXECUTABLE_DISPOSITIONS.has(disposition) || disposition === 'data')
    && !valid.some((link) => link.kind === disposition)) {
    findings.push(finding(`${path}.links`, SOURCE_LEDGER_FINDING_CODES.EXECUTABLE_LINK_MISSING, `${disposition} source evidence must link to a ${disposition} compiler record.`));
  }
  return valid;
}

function contiguousResidualSpans(sourceText, unit, covered) {
  const output = [];
  let start = null;
  for (let offset = unit.sourceSpan.start; offset < unit.sourceSpan.end; offset += 1) {
    const residual = /\S/.test(sourceText[offset]) && covered[offset] === 0;
    if (residual && start === null) start = offset;
    if (!residual && start !== null) {
      output.push({ start, end: offset });
      start = null;
    }
  }
  if (start !== null) output.push({ start, end: unit.sourceSpan.end });
  return output;
}

/**
 * Validate provider classifications and semantic links without changing them.
 * The result is a deterministic report; invalid claims never mutate the ledger.
 */
function validateSourceLedgerClaims(ledger, sourceText, input = {}) {
  const ledgerValidation = validateSourceLedger(ledger, sourceText, { sensitiveValues: input.sensitiveValues });
  const findings = [...ledgerValidation.findings];
  const claims = Array.isArray(input.claims) ? input.claims : [];
  if (!Array.isArray(input.claims)) {
    findings.push(finding('claims', SOURCE_LEDGER_FINDING_CODES.CLAIMS_REQUIRED, 'Provider source claims must be an array.'));
  }
  const units = Array.isArray(ledger?.units) ? ledger.units : [];
  const literals = Array.isArray(ledger?.literals) ? ledger.literals : [];
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const literalById = new Map(literals.map((literal) => [literal.id, literal]));
  const covered = new Uint16Array(typeof sourceText === 'string' ? sourceText.length : 0);
  const claimedUnitRefs = new Set();
  const validClaims = [];
  const unlinkedExecutableUnitIds = new Set();
  const unresolvedUnitIds = new Set();

  claims.forEach((claim, index) => {
    const path = `claims[${index}]`;
    if (!isPlainObject(claim)) {
      findings.push(finding(path, SOURCE_LEDGER_FINDING_CODES.CLAIM_INVALID, 'Each provider source claim must be an object.'));
      return;
    }
    const unit = unitById.get(claim.unitRef);
    if (!unit) {
      findings.push(finding(`${path}.unitRef`, SOURCE_LEDGER_FINDING_CODES.CLAIM_UNIT_UNKNOWN, 'Claim references an unknown SourceLedgerV1 unit.'));
      return;
    }
    claimedUnitRefs.add(unit.id);
    const disposition = typeof claim.disposition === 'string' ? claim.disposition.trim().toLowerCase() : '';
    if (!DISPOSITION_SET.has(disposition)) {
      findings.push(finding(`${path}.disposition`, SOURCE_LEDGER_FINDING_CODES.CLAIM_DISPOSITION_INVALID, 'Claim disposition is unsupported.'));
      return;
    }
    const span = normalizeClaimSpan(claim, unit, sourceText, path, findings);
    const links = validateLinks(claim, disposition, path, findings);
    if ((EXECUTABLE_DISPOSITIONS.has(disposition) || disposition === 'data')
      && !links.some((link) => link.kind === disposition)) unlinkedExecutableUnitIds.add(unit.id);
    if (disposition === 'unresolved') unresolvedUnitIds.add(unit.id);
    if (!span) return;
    let duplicate = false;
    for (let offset = span.start; offset < span.end; offset += 1) {
      if (!/\S/.test(sourceText[offset])) continue;
      if (covered[offset] > 0) duplicate = true;
      covered[offset] += 1;
    }
    if (duplicate) findings.push(finding(`${path}.sourceSpan`, SOURCE_LEDGER_FINDING_CODES.CLAIM_COVERAGE_DUPLICATE, 'Provider claims cover the same non-whitespace source evidence more than once.'));
    validClaims.push({ unitRef: unit.id, disposition, sourceSpan: span, links });
  });

  const omittedUnitRefs = [];
  const residualSpans = [];
  units.forEach((unit, index) => {
    if (!claimedUnitRefs.has(unit.id)) {
      omittedUnitRefs.push(unit.id);
      findings.push(finding(`units[${index}]`, SOURCE_LEDGER_FINDING_CODES.SOURCE_UNIT_OMITTED, 'A structural source unit has no provider disposition claim.', { unitRef: unit.id }));
      return;
    }
    const residual = contiguousResidualSpans(sourceText, unit, covered);
    residual.forEach((span) => {
      const residualEvidence = {
        unitRef: unit.id,
        sourceSpan: span,
        quoteDigest: sha256Text(sourceText.slice(span.start, span.end)),
        redacted: unit.sensitive === true,
      };
      residualSpans.push(residualEvidence);
      findings.push(finding(`units[${index}]`, SOURCE_LEDGER_FINDING_CODES.COMPOUND_TEXT_RESIDUAL, 'Claimed source leaves non-whitespace text without an exact semantic or non-executable disposition.', residualEvidence));
    });
  });

  const literalUsageByRef = new Map();
  const literalUsages = Array.isArray(input.literalUsages) ? input.literalUsages : [];
  literalUsages.forEach((usage, index) => {
    const path = `literalUsages[${index}]`;
    if (!isPlainObject(usage) || !literalById.has(usage.literalRef)) {
      findings.push(finding(`${path}.literalRef`, SOURCE_LEDGER_FINDING_CODES.LITERAL_REF_UNKNOWN, 'Literal usage references an unknown structural literal.'));
      return;
    }
    if (literalUsageByRef.has(usage.literalRef)) {
      findings.push(finding(path, SOURCE_LEDGER_FINDING_CODES.LITERAL_USAGE_DUPLICATE, 'A structural literal may have only one usage declaration.'));
      return;
    }
    const consumers = Array.isArray(usage.consumerRefs)
      ? [...new Set(usage.consumerRefs.filter(isNonBlankString).map((entry) => entry.trim()))]
      : [];
    if (consumers.length === 0) {
      findings.push(finding(`${path}.consumerRefs`, SOURCE_LEDGER_FINDING_CODES.LITERAL_CONSUMER_MISSING, 'A consumed literal requires at least one compiler record reference.'));
    }
    literalUsageByRef.set(usage.literalRef, consumers);
  });

  const requiredLiteralRefs = new Set(Array.isArray(input.requiredLiteralRefs) ? input.requiredLiteralRefs : []);
  validClaims.forEach((claim) => {
    if (!EXECUTABLE_DISPOSITIONS.has(claim.disposition) && claim.disposition !== 'data') return;
    literals.forEach((literal) => {
      if (literal.sourceSpan.start >= claim.sourceSpan.start && literal.sourceSpan.end <= claim.sourceSpan.end) {
        requiredLiteralRefs.add(literal.id);
      }
    });
  });
  const unconsumedLiteralUnitIds = new Set();
  requiredLiteralRefs.forEach((literalRef) => {
    if (!literalById.has(literalRef)) {
      findings.push(finding('requiredLiteralRefs', SOURCE_LEDGER_FINDING_CODES.LITERAL_REF_UNKNOWN, 'Required literal reference is unknown.', { literalRef }));
    } else if (!literalUsageByRef.has(literalRef) || literalUsageByRef.get(literalRef).length === 0) {
      unconsumedLiteralUnitIds.add(literalById.get(literalRef).unitRef);
      findings.push(finding('literalUsages', SOURCE_LEDGER_FINDING_CODES.LITERAL_UNCONSUMED, 'An executable or data literal was not bound to a compiler record.', { literalRef }));
    }
  });

  const claimsAuthority = {
    ledgerDigest: ledger?.ledgerDigest || null,
    claims: validClaims,
    literalUsages: [...literalUsageByRef.entries()].map(([literalRef, consumerRefs]) => ({ literalRef, consumerRefs })),
  };
  const report = {
    valid: findings.length === 0,
    complete: findings.length === 0 && unresolvedUnitIds.size === 0,
    findings,
    claimsDigest: sha256Text(stableSerialize(claimsAuthority)),
    coverage: {
      totalUnits: units.length,
      claimedUnits: claimedUnitRefs.size,
      omittedUnitRefs,
      residualSpans,
    },
    literals: {
      total: literals.length,
      required: requiredLiteralRefs.size,
      consumed: [...requiredLiteralRefs].filter((literalRef) => (literalUsageByRef.get(literalRef) || []).length > 0).length,
    },
    unlinkedExecutableUnitIds: [...unlinkedExecutableUnitIds],
    unconsumedLiteralUnitIds: [...unconsumedLiteralUnitIds],
    unresolvedUnitIds: [...unresolvedUnitIds],
  };
  return deepFreeze(report);
}

module.exports = {
  SOURCE_LEDGER_VERSION,
  DEFAULT_SOURCE_LEDGER_MAX_UNITS,
  SOURCE_UNIT_KINDS,
  SOURCE_DISPOSITIONS,
  SOURCE_LEDGER_FINDING_CODES,
  SourceLedgerError,
  buildSourceLedger,
  validateSourceLedgerClaims,
};
