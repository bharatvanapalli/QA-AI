'use strict';

const crypto = require('crypto');
const { normalizeAuthoredFlowSource } = require('./authoredFlowSourceNormalizer');

const CONTRACT_VERSION = 'CaseContractV1';
const RAW_BINDINGS = new WeakMap();
const RAW_BINDINGS_BY_CASE = new WeakMap();
const RAW_ROWS = new WeakMap();
const RAW_ROWS_BY_CASE = new WeakMap();

const SECTION_NAMES = new Set([
  'title',
  'requirement title',
  'scenario title',
  'test case title',
  'target url',
  'scenario',
  'scenarios',
  'test case',
  'test cases',
  'steps',
  'test steps',
  'test steps and validations',
  'steps and validations',
  'actions and validations',
  'test procedure',
  'procedure',
  'flow',
  'test flow',
  'user flow',
  'workflow',
  'acceptance flow',
  'user story',
  'test data',
  'inline test data',
  'data',
  'data rows',
  'fixtures',
  'credentials',
  'starting state',
  'initial state',
  'final state',
  'expected final state',
  'expected result',
  'expected results',
  'final validation',
  'preferred validation',
  'preferred final assertion',
  'session policy',
  'session requirement',
  'session requirements',
  'dependency and session contract',
  'failure behavior',
  'failure and continuation behavior',
  'failure and continuation',
  'continuation behavior',
  'execution constraints',
  'constraints',
  'generation requirement',
  'generation requirements',
  'authoring rule',
  'data binding rule',
  'expected scenario test case shape',
  'expected scenario shape',
  'expected test case shape',
]);

const DATA_SECTIONS = new Set([
  'test data',
  'inline test data',
  'data',
  'data rows',
  'fixtures',
  'credentials',
]);

const STEP_SECTIONS = new Set([
  'steps',
  'test steps',
  'test steps and validations',
  'steps and validations',
  'actions and validations',
  'test procedure',
  'procedure',
  'flow',
  'test flow',
  'user flow',
  'workflow',
  'acceptance flow',
  'user story',
]);
const ASSERTION_SECTIONS = new Set([
  'expected result',
  'expected results',
  'final validation',
  'preferred validation',
  'preferred final assertion',
  'final state',
  'expected final state',
]);

const META_DATA_LABEL_RE = /^(?:target url|scenario|test cases?|steps?|session mode|failure policy|depends on ids?|expected (?:scenario|test case) count|reason|authoring rule|data binding rule)$/i;
const SENSITIVE_LABEL_RE = /\b(?:password|passcode|passwd|pwd|secret|token|api[ _-]?key|client[ _-]?secret|private[ _-]?key|access[ _-]?key|otp|one[ _-]?time[ _-]?password|pin|credential)\b/i;
const ACTION_VERB_RE = /\b(?:navigate|open|go to|visit|enter|fill|type|input|select|choose|pick|set|check|tick|click|press|submit|hover|wait|scroll|expand|collapse|verify|validate|assert|confirm|expect|capture|screenshot|download|upload|close|dismiss)\b/i;
const DECLARATIVE_ASSERTION_RE = /\b(?:is|are|must be|should be|remains?|becomes?)\b[^.!?]{0,160}\b(?:visible|hidden|displayed|shown|present|absent|enabled|disabled|selected|checked|open|closed|empty)\b/i;
const ASSERTION_VERB_RE = /\b(?:assert|verify|validate|confirm|expect)\b/i;
const BROWSER_ACTION_VERB_RE = /\b(?:navigate|go to|visit|open|enter|fill|input|type|select|choose|pick|set|check|tick|click|press|submit|hover|wait|scroll|expand|collapse|capture|screenshot|download|upload|close|dismiss)\b/i;
const ATOMIC_OPERATION_BOUNDARY_RE = /(?:,\s*(?:and\s+)?|\s+(?:and\s+then|then|and)\s+)(?=(?:navigate|go\s+to|visit|open|enter|fill|input|type|select|choose|pick|set|check|tick|click|press|submit|hover|wait|scroll|expand|collapse|capture|screenshot|download|upload|close|dismiss|assert|verify|validate|confirm|expect)\b)/i;
const BLOCKED_PROSE_SECTIONS = new Set([
  ...DATA_SECTIONS,
  ...ASSERTION_SECTIONS,
  'starting state',
  'initial state',
  'session policy',
  'session requirement',
  'session requirements',
  'dependency and session contract',
  'failure behavior',
  'failure and continuation behavior',
  'failure and continuation',
  'continuation behavior',
  'execution constraints',
  'constraints',
  'generation requirement',
  'generation requirements',
  'authoring rule',
  'data binding rule',
  'expected scenario test case shape',
  'expected scenario shape',
  'expected test case shape',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function slug(value, fallback = 'value') {
  return normalize(value).replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || fallback;
}

function digest(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function stableId(prefix, value, ordinal = 0) {
  return `${prefix}-${digest(`${ordinal}\n${clean(value)}`)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLiteralValueChar(value) {
  return /[A-Za-z0-9_@.+:/-]/.test(String(value || ''));
}

function isConstraintDirective(value) {
  const text = clean(stripListPrefix(value));
  if (!text) return false;
  return /^(?:do not|don't|must not|never|avoid|nothing should)\b/i.test(text)
    || /^generate\s+(?:exactly|only|one|a single)\b/i.test(text)
    || /^preserve\s+(?:every|all|the authored)\b/i.test(text)
    || /^reuse\s+(?:the\s+)?(?:same|existing|current)\s+(?:browser|page|context|session|cookies?)\b/i.test(text)
    || /^open\s+a\s+fresh\s+browser\s+(?:session|page|context)\b/i.test(text)
    || /^leave\b[^.!?]{0,200}\bwithout\s+(?:clicking|submitting|saving|navigating)\b/i.test(text);
}

function isExecutableCandidate(value) {
  const text = clean(value);
  return Boolean(text)
    && !isConstraintDirective(text)
    && (ACTION_VERB_RE.test(text) || DECLARATIVE_ASSERTION_RE.test(text));
}

function literalOccurrenceRegExp(value, { global = false } = {}) {
  const literal = String(value == null ? '' : value);
  if (!literal) return null;
  const first = literal[0];
  const last = literal[literal.length - 1];
  const valueBoundary = 'A-Za-z0-9_@.+:/-';
  const left = isLiteralValueChar(first) ? `(^|[^${valueBoundary}])` : '()';
  const right = isLiteralValueChar(last) ? `(?=$|[^${valueBoundary}])` : '';
  return new RegExp(`${left}${escapeRegExp(literal)}${right}`, global ? 'gi' : 'i');
}

function replaceLiteralOccurrences(value, literal, replacement) {
  const expression = literalOccurrenceRegExp(literal, { global: true });
  if (!expression) return String(value == null ? '' : value);
  return String(value == null ? '' : value).replace(expression, (_match, prefix = '') => `${prefix}${replacement}`);
}

const GENERIC_BINDING_CONTEXT_TERMS = new Set([
  'field', 'input', 'dropdown', 'option', 'value', 'data', 'test', 'expected', 'actual',
  'select', 'choose', 'enter', 'fill', 'type', 'verify', 'validate', 'assert', 'control',
  'button', 'list', 'text', 'number', 'name', 'code', 'term', 'mode',
]);

function bindingContextScore(definition, text, literal) {
  const normalizedText = normalize(text);
  const normalizedLabel = normalize(definition && definition.label);
  const normalizedToken = normalize(definition && definition.name);
  if (!normalizedText || (!normalizedLabel && !normalizedToken)) return 0;

  let score = 0;
  if (normalizedLabel && normalizedText.includes(normalizedLabel)) score += 10000 + normalizedLabel.length;
  if (normalizedToken && normalizedToken !== normalizedLabel && normalizedText.includes(normalizedToken)) {
    score += 9000 + normalizedToken.length;
  }

  const semanticTerms = [...new Set(`${normalizedLabel} ${normalizedToken}`.split(/\s+/)
    .filter((term) => term && !GENERIC_BINDING_CONTEXT_TERMS.has(term)))];
  const textTerms = new Set(normalizedText.split(/\s+/).filter(Boolean));
  score += semanticTerms.filter((term) => textTerms.has(term)).length * 250;

  // When the authored label and literal both occur verbatim, prefer the label
  // nearest that exact literal occurrence. This resolves multi-control prose
  // without relying on definition order or a website-specific field catalog.
  const source = String(text || '').toLowerCase();
  const labelSource = String(definition && definition.label || '').toLowerCase();
  const literalSource = String(literal || '').toLowerCase();
  const labelIndex = labelSource ? source.indexOf(labelSource) : -1;
  const literalIndex = literalSource ? source.indexOf(literalSource) : -1;
  if (labelIndex >= 0 && literalIndex >= 0) {
    score += Math.max(1, 500 - Math.abs(labelIndex - literalIndex));
  }
  return score;
}

function uniquelyResolveLiteralDefinition(definitions, text, literal) {
  const candidates = [...new Map((definitions || []).map((definition) => [definition.id, definition])).values()];
  if (candidates.length === 1) return candidates[0];
  const ranked = candidates
    .map((definition) => ({ definition, score: bindingContextScore(definition, text, literal) }))
    .sort((a, b) => b.score - a.score || String(a.definition.id).localeCompare(String(b.definition.id)));
  if (!ranked.length || ranked[0].score <= 0) return null;
  if (ranked[1] && ranked[1].score === ranked[0].score) return null;
  return ranked[0].definition;
}

function tokenName(label) {
  const text = normalize(label);
  if (/\b(?:email|e mail|mail address)\b/.test(text)) return 'email';
  if (/\b(?:password|passcode|passwd|pwd)\b/.test(text)) return 'password';
  if (/\b(?:user name|username|login id)\b/.test(text)) return 'username';
  if (/\b(?:phone|telephone|mobile)\b/.test(text)) return 'phone';
  return slug(text, 'value').slice(0, 40);
}

function isSensitiveLabel(label) {
  return SENSITIVE_LABEL_RE.test(clean(label));
}

function envNameFor(token, rowNumber = null) {
  const base = `QAAI_INLINE_${String(token || 'VALUE').replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase()}`;
  return rowNumber == null ? base : `${base}_ROW_${rowNumber}`;
}

function stripListPrefix(line) {
  return String(line || '').replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

function parseSectionLine(line) {
  const stripped = String(line || '').replace(/^\s*#{1,6}\s*/, '').trim();
  const match = stripped.match(/^([A-Za-z][A-Za-z0-9 /_-]{0,100})\s*:\s*(.*)$/);
  if (!match) return null;
  const name = normalize(match[1]);
  if (!SECTION_NAMES.has(name)) return null;
  return { name, inline: clean(match[2]) };
}

function parseCaseHeader(line) {
  const stripped = String(line || '').replace(/^\s*#{1,6}\s*/, '').trim();
  if (/^expected\s+(?:scenario|test\s+case)\s+count\s*:/i.test(stripped)) return null;
  let match = stripped.match(/^(?:test\s+)?case(?:\s+#?\s*([A-Za-z0-9._-]+))?\s*(?::|[\-\u2013\u2014])\s*(.+)$/i);
  if (match) return { externalId: clean(match[1]) || null, name: clean(match[2]) };
  match = stripped.match(/^(TC[-_ ]?[A-Za-z0-9._-]+)\s*(?::|[\-\u2013\u2014])\s*(.+)$/i);
  if (match) return { externalId: clean(match[1]), name: clean(match[2]) };
  return null;
}

function parseScenarioHeader(line) {
  const stripped = String(line || '').replace(/^\s*#{1,6}\s*/, '').trim();
  const match = stripped.match(/^scenario(?:\s+#?\s*([A-Za-z0-9._-]+))?\s*:\s*(.+)$/i);
  return match ? { externalId: clean(match[1]) || null, name: clean(match[2]) } : null;
}

function findScenarioRanges(lines) {
  const explicit = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseScenarioHeader(lines[index]);
    if (header) {
      explicit.push({ ...header, start: index, bodyStart: index + 1 });
      continue;
    }
    const sectionLine = parseSectionLine(lines[index]);
    if (!sectionLine || !['scenario', 'scenario title'].includes(sectionLine.name)) continue;
    const name = sectionAuthoredValue(lines, index, sectionLine);
    if (name) {
      explicit.push({
        externalId: null,
        name,
        start: index,
        bodyStart: index + 1,
      });
    }
  }
  return explicit.map((entry, index) => ({
    ...entry,
    end: index + 1 < explicit.length ? explicit[index + 1].start : lines.length,
  }));
}

function sectionAuthoredValue(lines, index, sectionLine) {
  if (sectionLine && sectionLine.inline) return sectionLine.inline;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (parseSectionLine(lines[cursor]) || parseCaseHeader(lines[cursor])) break;
    const candidate = clean(stripListPrefix(lines[cursor]));
    if (candidate) return candidate;
  }
  return '';
}

function splitTableRow(line) {
  const text = String(line || '').trim();
  if (!text.includes('|')) return [];
  return text.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
}

function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseKeyValue(line, { allowColon = false } = {}) {
  const text = stripListPrefix(line);
  if (!text || text.includes('|')) return null;
  const separator = allowColon ? '(?:=|:)' : '=';
  const match = text.match(new RegExp(`^([^:=]{2,80})\\s*${separator}\\s*(.+)$`));
  if (!match) return null;
  const label = clean(match[1]);
  const value = clean(match[2]).replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, d, s) => d || s || '');
  if (!label || !value || META_DATA_LABEL_RE.test(label)) return null;
  return { label, value };
}

function explicitCounts(text) {
  const source = String(text || '');
  const resolve = (pattern) => {
    const values = [...source.matchAll(pattern)].map((match) => Number(match[1])).filter(Number.isFinite);
    if (!values.length) return null;
    if (values.length > 1 && values.every((value) => value === 1)) return values.length;
    return values[0];
  };
  return {
    scenarios: resolve(/expected\s+scenario\s+count\s*:\s*(\d+)/ig),
    cases: resolve(/expected\s+test\s+case\s+count\s*:\s*(\d+)/ig),
  };
}

function sourceText(requirements) {
  return (Array.isArray(requirements) ? requirements : []).map((requirement) => {
    const title = clean(requirement && requirement.title);
    const content = String(requirement && requirement.content || '');
    return [title, content].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');
}

function collectData(lines) {
  const definitions = new Map();
  const tokenByLabel = new Map();
  const rawBindings = new Map();
  const singletonBindings = new Map();
  const tableRows = [];
  const rawTableRows = [];
  let nextRowNumber = 1;
  let section = '';

  function uniqueToken(label) {
    const key = normalize(label);
    if (tokenByLabel.has(key)) return tokenByLabel.get(key);
    const base = tokenName(label);
    let candidate = base;
    let suffix = 2;
    while ([...definitions.keys()].includes(candidate)) candidate = `${base}_${suffix++}`;
    tokenByLabel.set(key, candidate);
    return candidate;
  }

  function rememberRaw(token, value) {
    if (!rawBindings.has(token)) rawBindings.set(token, new Set());
    rawBindings.get(token).add(String(value));
  }

  function ensureDefinition(label, value = null, { rowNumber = null, table = false } = {}) {
    const token = uniqueToken(label);
    const sensitive = isSensitiveLabel(label);
    const existing = definitions.get(token);
    if (!existing) {
      const source = sensitive
        ? { kind: 'environment', name: envNameFor(token, rowNumber) }
        : (table ? { kind: 'row_matrix' } : { kind: 'inline', value: clean(value) });
      definitions.set(token, {
        id: `data.${token}`,
        name: token,
        label: clean(label),
        classification: sensitive ? 'sensitive' : 'normal',
        source,
      });
    } else if (!sensitive && value != null && existing.source && existing.source.kind === 'inline' && existing.source.value !== clean(value)) {
      existing.source = { kind: 'row_matrix' };
    }
    if (value != null) rememberRaw(token, value);
    return definitions.get(token);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionLine = parseSectionLine(line);
    if (sectionLine) {
      section = sectionLine.name;
      if (DATA_SECTIONS.has(section) && sectionLine.inline) {
        const inline = parseKeyValue(sectionLine.inline, { allowColon: true });
        if (inline) {
          const definition = ensureDefinition(inline.label, inline.value);
          singletonBindings.set(definition.name, inline.value);
        }
      }
      continue;
    }

    const cells = splitTableRow(line);
    if (cells.length >= 2 && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const headers = cells;
      const dataish = DATA_SECTIONS.has(section) || headers.some((header) => /\b(?:email|user|password|token|input|expected|value|data|count|role|url)\b/i.test(header));
      if (!dataish) continue;
      headers.forEach((header) => ensureDefinition(header, null, { table: true }));
      index += 2;
      while (index < lines.length) {
        const values = splitTableRow(lines[index]);
        if (values.length !== headers.length || isTableDivider(lines[index])) break;
        const rowNumber = nextRowNumber;
        const rowId = `row-${String(rowNumber).padStart(3, '0')}`;
        const bindings = {};
        const rawRowBindings = {};
        headers.forEach((header, column) => {
          const value = values[column];
          if (!value) return;
          const definition = ensureDefinition(header, value, { rowNumber, table: true });
          rawRowBindings[definition.name] = value;
          bindings[definition.name] = definition.classification === 'sensitive'
            ? { kind: 'environment', name: envNameFor(definition.name, rowNumber) }
            : { kind: 'inline', value };
        });
        if (Object.keys(bindings).length) {
          tableRows.push({ id: rowId, bindings });
          rawTableRows.push({ id: rowId, bindings: rawRowBindings });
          nextRowNumber += 1;
        }
        index += 1;
      }
      index -= 1;
      continue;
    }

    const pair = parseKeyValue(line, { allowColon: DATA_SECTIONS.has(section) });
    if (pair) {
      const definition = ensureDefinition(pair.label, pair.value);
      singletonBindings.set(definition.name, pair.value);
      continue;
    }

    // Prose fallback is intentionally narrow: only unambiguous identity/secret labels.
    const prose = stripListPrefix(line);
    const proseRe = /\b(email(?:\s+address)?|e-mail|user\s*name|username|password|passcode|api\s*key|access\s*token|client\s*secret)\b\s*(?:is|=|:)\s*(?:"([^"]+)"|'([^']+)'|([^,;.\s]+))/ig;
    let match;
    while ((match = proseRe.exec(prose)) !== null) {
      const label = clean(match[1]);
      const value = clean(match[2] || match[3] || match[4]);
      if (!value) continue;
      const definition = ensureDefinition(label, value);
      singletonBindings.set(definition.name, value);
    }
  }

  const singletonPublicBindings = Object.fromEntries([...singletonBindings.entries()].map(([token, value]) => {
    const definition = definitions.get(token);
    return [token, definition.classification === 'sensitive'
      ? { kind: 'environment', name: envNameFor(token) }
      : { kind: 'inline', value }];
  }));
  const singletonRawBindings = Object.fromEntries(singletonBindings.entries());
  // Scalars authored beside a table are shared inputs/expectations for every
  // explicit row. A table cell for the same token is row-specific and wins.
  const dataRows = tableRows.length
    ? tableRows.map((row) => ({
      ...row,
      bindings: { ...singletonPublicBindings, ...(row.bindings || {}) },
    }))
    : (singletonBindings.size ? [{ id: 'row-001', bindings: singletonPublicBindings }] : []);
  const rawRows = rawTableRows.length
    ? rawTableRows.map((row) => ({
      ...row,
      bindings: { ...singletonRawBindings, ...(row.bindings || {}) },
    }))
    : (singletonBindings.size ? [{ id: 'row-001', bindings: singletonRawBindings }] : []);

  return {
    definitions: [...definitions.values()],
    dataRows,
    rawRows,
    rawBindings: new Map([...rawBindings.entries()].map(([token, values]) => [token, [...values].filter(Boolean)])),
  };
}

function mergeRawBindings(sharedData, localData) {
  const merged = new Map();
  const shared = sharedData && sharedData.rawBindings instanceof Map ? sharedData.rawBindings : new Map();
  const local = localData && localData.rawBindings instanceof Map ? localData.rawBindings : new Map();
  for (const [token, values] of shared.entries()) merged.set(token, [...values]);
  // A value authored inside the selected case is authoritative for that case.
  // Do not append it to a global positional list: that is how equal values in
  // neighbouring cases previously shifted case-to-value alignment.
  for (const [token, values] of local.entries()) merged.set(token, [...values]);
  return merged;
}

function mergeCaseRows(sharedData, localData) {
  const sharedRows = Array.isArray(sharedData && sharedData.dataRows) ? sharedData.dataRows : [];
  const localRows = Array.isArray(localData && localData.dataRows) ? localData.dataRows : [];
  if (!sharedRows.length) return localRows;
  if (!localRows.length) return sharedRows;
  if (sharedRows.length === 1) {
    return localRows.map((row) => ({
      ...row,
      bindings: { ...(sharedRows[0].bindings || {}), ...(row.bindings || {}) },
    }));
  }
  if (localRows.length === 1) {
    return sharedRows.map((row) => ({
      ...row,
      bindings: { ...(row.bindings || {}), ...(localRows[0].bindings || {}) },
    }));
  }
  // Never create an implicit cartesian product from two independently authored
  // matrices. Local rows are the selected case's executable authority.
  return localRows;
}

function mergeCaseRawRows(sharedData, localData) {
  const sharedRows = Array.isArray(sharedData && sharedData.dataRows) ? sharedData.dataRows : [];
  const localRows = Array.isArray(localData && localData.dataRows) ? localData.dataRows : [];
  const sharedRawById = new Map((Array.isArray(sharedData && sharedData.rawRows) ? sharedData.rawRows : [])
    .map((row) => [String(row && row.id || ''), row]));
  const localRawById = new Map((Array.isArray(localData && localData.rawRows) ? localData.rawRows : [])
    .map((row) => [String(row && row.id || ''), row]));

  const rawFor = (rawById, row) => {
    const raw = rawById.get(String(row && row.id || ''));
    return raw && raw.bindings && typeof raw.bindings === 'object' ? raw.bindings : {};
  };
  const select = (rows, rawById) => rows.map((row) => ({
    id: row.id,
    bindings: { ...rawFor(rawById, row) },
  }));

  if (!sharedRows.length) return select(localRows, localRawById);
  if (!localRows.length) return select(sharedRows, sharedRawById);
  if (sharedRows.length === 1) {
    const sharedBindings = rawFor(sharedRawById, sharedRows[0]);
    return localRows.map((row) => ({
      id: row.id,
      bindings: { ...sharedBindings, ...rawFor(localRawById, row) },
    }));
  }
  if (localRows.length === 1) {
    const localBindings = rawFor(localRawById, localRows[0]);
    return sharedRows.map((row) => ({
      id: row.id,
      bindings: { ...rawFor(sharedRawById, row), ...localBindings },
    }));
  }
  // Match mergeCaseRows: independent matrices never form an implicit product.
  return select(localRows, localRawById);
}

function mergeDataScopes(sharedData, localData) {
  return {
    rawBindings: mergeRawBindings(sharedData, localData),
    dataRows: mergeCaseRows(sharedData, localData),
    rawRows: mergeCaseRawRows(sharedData, localData),
  };
}

function findCaseRanges(lines, knownScenarioRanges = null) {
  const scenarioRanges = Array.isArray(knownScenarioRanges)
    ? knownScenarioRanges
    : findScenarioRanges(lines);
  const topLevelTitles = [];
  for (let index = 0; index < lines.length; index += 1) {
    const sectionLine = parseSectionLine(lines[index]);
    if (!sectionLine || !['requirement title', 'scenario title'].includes(sectionLine.name)) continue;
    const name = sectionAuthoredValue(lines, index, sectionLine);
    topLevelTitles.push({ name, start: index });
  }
  const authoredPartitions = topLevelTitles.filter((entry, index) => {
    const end = index + 1 < topLevelTitles.length ? topLevelTitles[index + 1].start : lines.length;
    return lines.slice(entry.start, end).some((line) => {
      const sectionLine = parseSectionLine(line);
      return Boolean(parseCaseHeader(line) || (sectionLine && STEP_SECTIONS.has(sectionLine.name)));
    });
  });
  if (authoredPartitions.length > 1) {
    return authoredPartitions.map((entry, index) => {
      const end = index + 1 < authoredPartitions.length ? authoredPartitions[index + 1].start : lines.length;
      let caseHeader = null;
      for (let cursor = entry.start; cursor < end; cursor += 1) {
        caseHeader = parseCaseHeader(lines[cursor]);
        if (!caseHeader) {
          const sectionLine = parseSectionLine(lines[cursor]);
          if (sectionLine && ['test case', 'test case title'].includes(sectionLine.name)) {
            const name = sectionAuthoredValue(lines, cursor, sectionLine);
            if (name) caseHeader = { externalId: null, name };
          }
        }
        if (caseHeader) break;
      }
      return {
        externalId: caseHeader && caseHeader.externalId || null,
        name: clean(caseHeader && caseHeader.name) || entry.name || `Authored case ${index + 1}`,
        start: entry.start,
        bodyStart: entry.start,
        end,
        partitionReason: 'authored_top_level_behavior',
      };
    });
  }

  const explicit = [];
  let section = '';
  for (let index = 0; index < lines.length; index += 1) {
    const sectionLine = parseSectionLine(lines[index]);
    if (sectionLine) section = sectionLine.name;
    const header = parseCaseHeader(lines[index]);
    if (header) {
      explicit.push({ ...header, start: index, bodyStart: index + 1 });
      continue;
    }
    if (sectionLine && ['test case', 'test case title'].includes(sectionLine.name)) {
      const name = sectionAuthoredValue(lines, index, sectionLine);
      if (name) {
        explicit.push({
          externalId: null,
          name,
          start: index,
          bodyStart: index + 1,
        });
      }
      continue;
    }
    if (section === 'test cases') {
      const list = String(lines[index] || '').match(/^\s*(\d+)[.)]\s+(.+)$/);
      if (list) {
        explicit.push({ externalId: list[1], name: clean(list[2]), start: index, bodyStart: index + 1 });
      }
    }
  }
  if (explicit.length) {
    return explicit.map((entry, index) => {
      const nextCaseStart = index + 1 < explicit.length ? explicit[index + 1].start : lines.length;
      const scenarioScope = scenarioRanges.find((scenario) => (
        entry.start > scenario.start && entry.start < scenario.end
      ));
      return {
        ...entry,
        // A case owns only the lines inside its authored scenario. Without this
        // boundary, the final case in one scenario absorbs the next scenario's
        // preamble and its Test Data block.
        end: scenarioScope ? Math.min(nextCaseStart, scenarioScope.end) : nextCaseStart,
        partitionReason: 'explicit_case',
      };
    });
  }

  const scenarios = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = parseScenarioHeader(lines[index]);
    if (header) scenarios.push({ ...header, start: index, bodyStart: index + 1 });
  }
  if (scenarios.length > 1) {
    return scenarios.map((entry, index) => ({
      ...entry,
      end: index + 1 < scenarios.length ? scenarios[index + 1].start : lines.length,
      partitionReason: 'explicit_scenario',
    }));
  }

  let authoredTitle = '';
  for (let index = 0; index < lines.length; index += 1) {
    const section = parseSectionLine(lines[index]);
    if (!section || !['title', 'requirement title', 'scenario title', 'test case title'].includes(section.name)) continue;
    authoredTitle = section.inline;
    if (!authoredTitle) {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (parseSectionLine(lines[cursor])) break;
        const candidate = clean(stripListPrefix(lines[cursor]));
        if (candidate) {
          authoredTitle = candidate;
          break;
        }
      }
    }
    if (authoredTitle) break;
  }
  const scenarioLine = lines.find((line) => /^\s*scenario\s*:/i.test(line));
  const name = authoredTitle || clean((scenarioLine || '').replace(/^[^:]+:\s*/, '')) || 'Procedural test flow';
  return [{ externalId: null, name, start: 0, bodyStart: 0, end: lines.length, partitionReason: 'single_behavior_topology' }];
}

function sectionText(lines, wanted) {
  const wantedSet = new Set(wanted);
  const chunks = [];
  let capture = false;
  for (const line of lines) {
    const section = parseSectionLine(line);
    if (section) {
      capture = wantedSet.has(section.name);
      if (capture && section.inline) chunks.push(section.inline);
      continue;
    }
    if (capture && clean(line)) chunks.push(stripListPrefix(line));
  }
  return clean(chunks.join(' '));
}

function collectStepTexts(lines) {
  const steps = [];
  const hasExplicitStepSection = lines.some((line) => {
    const parsed = parseSectionLine(line);
    return parsed && STEP_SECTIONS.has(parsed.name);
  });
  let section = '';
  let currentIndex = -1;
  for (const rawLine of lines) {
    const sectionLine = parseSectionLine(rawLine);
    if (sectionLine) {
      section = sectionLine.name;
      currentIndex = -1;
      if (STEP_SECTIONS.has(section) && sectionLine.inline && isExecutableCandidate(sectionLine.inline)) {
        steps.push(stripListPrefix(sectionLine.inline));
        currentIndex = steps.length - 1;
      }
      continue;
    }
    if (!STEP_SECTIONS.has(section)) continue;
    const listed = String(rawLine || '').match(/^(\s*)(?:\d+[.)]|[-*+])\s+(.+)$/);
    if (listed) {
      const indentation = listed[1].replace(/\t/g, '    ').length;
      const candidate = clean(listed[2]);
      if (indentation > 0 && currentIndex >= 0 && !isExecutableCandidate(candidate)) {
        steps[currentIndex] = clean(`${steps[currentIndex]} ${candidate}`);
        continue;
      }
      if (!candidate || isConstraintDirective(candidate)) {
        currentIndex = -1;
        continue;
      }
      steps.push(candidate);
      currentIndex = steps.length - 1;
      continue;
    }
    const continuation = clean(rawLine);
    if (!continuation) {
      currentIndex = -1;
      continue;
    }
    if (currentIndex >= 0) {
      steps[currentIndex] = clean(`${steps[currentIndex]} ${continuation}`);
    } else if (isExecutableCandidate(continuation)) {
      steps.push(continuation);
      currentIndex = steps.length - 1;
    }
  }

  if (hasExplicitStepSection || steps.length) return steps;

  // Prose fallback is intentionally scoped away from data, generation/session
  // metadata, expected-state declarations, and failure-policy instructions.
  // Only the user's narrative body may become executable steps.
  const proseLines = [];
  section = '';
  for (const rawLine of lines) {
    const sectionLine = parseSectionLine(rawLine);
    if (sectionLine) {
      section = sectionLine.name;
      if (!BLOCKED_PROSE_SECTIONS.has(section)
        && sectionLine.inline
        && isExecutableCandidate(sectionLine.inline)) {
        proseLines.push(sectionLine.inline);
      }
      continue;
    }
    const candidate = clean(rawLine);
    if (!candidate || BLOCKED_PROSE_SECTIONS.has(section)) continue;
    if (parseKeyValue(candidate, { allowColon: false }) || candidate.includes('|') || isTableDivider(candidate)) continue;
    proseLines.push(stripListPrefix(candidate));
  }
  const prose = proseLines.join(' ').replace(/\s+/g, ' ');
  return prose.split(/(?<=[.!?])\s+(?=[A-Z0-9])/) 
    .map((sentence) => clean(stripListPrefix(sentence)))
    .filter((sentence) => isExecutableCandidate(sentence))
    .slice(0, 500);
}

function punctuateAtomicClause(text) {
  const value = clean(text).replace(/^[,;]\s*/, '').replace(/[,;]\s*$/, '');
  if (!value || /[.!?]$/.test(value)) return value;
  return `${value}.`;
}

function isOptionListProse(text) {
  const value = clean(text);
  const assertionIndex = firstMatchIndex(value, ASSERTION_VERB_RE);
  const actionIndex = firstMatchIndex(value, BROWSER_ACTION_VERB_RE);
  if (assertionIndex < 0 || (actionIndex >= 0 && actionIndex < assertionIndex)) return false;
  return /\b(?:list|options?|choices|suggestions?)\b[^.!?]{0,180}\b(?:contains?|includes?|following|in (?:this|the) order)\b/i.test(value)
    || /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+option\b/i.test(value);
}

function isConditionalExpandInstruction(text) {
  const value = clean(text);
  return /\bif\b[^.!?]{0,180}\bcollapsed\b[^.!?]{0,180}\b(?:click|open|expand)\b/i.test(value)
    || /\b(?:open|expand)\b[^.!?]{0,180}\bif\b[^.!?]{0,180}\bcollapsed\b/i.test(value);
}

function isConditionalCollapseInstruction(text) {
  const value = clean(text);
  return /\bif\b[^.!?]{0,180}\bexpanded\b[^.!?]{0,180}\b(?:click|close|collapse)\b/i.test(value)
    || /\b(?:close|collapse)\b[^.!?]{0,180}\bif\b[^.!?]{0,180}\bexpanded\b/i.test(value);
}

function splitAssertionClauses(text) {
  const value = clean(text);
  if (!value || isOptionListProse(value)) return [value];
  const prefix = value.match(/^\s*(assert|verify|validate|confirm|expect)\s+that\s+/i);
  if (!prefix) return [value];
  const verb = prefix[1];
  const body = value.slice(prefix[0].length).replace(/[.!?]\s*$/, '');
  const explicitSubjects = body.split(/\s+and\s+that\s+/i).map(clean).filter(Boolean);
  if (explicitSubjects.length > 1) {
    return explicitSubjects.map((clause) => punctuateAtomicClause(`${verb} that ${clause}`));
  }

  // Only split coordinated subjects when both sides identify UI structures.
  // This avoids turning labels such as "Terms and Conditions" into fake steps.
  const coordinated = body.match(/^(.+?)\s+and\s+(.+?)\s+(?:are|is)\s+(visible|displayed|shown|hidden|absent|present|enabled|disabled|selected|checked)$/i);
  if (!coordinated) return [value];
  const uiSubjectRe = /\b(?:heading|section|control|button|field|option|dialog|page|panel|link|menu|tab|message|element|checkbox|radio|list|table|form|icon|label)\s*$/i;
  if (!uiSubjectRe.test(coordinated[1]) || !uiSubjectRe.test(coordinated[2])) return [value];
  return [coordinated[1], coordinated[2]].map((subject) => (
    punctuateAtomicClause(`${verb} that ${clean(subject)} is ${coordinated[3]}`)
  ));
}

function mergeInlineVerificationClauses(clauses) {
  const merged = [];
  for (const rawClause of Array.isArray(clauses) ? clauses : []) {
    const clause = clean(rawClause);
    if (!clause) continue;
    if (/^(?:assert|verify|validate|confirm|expect)\b/i.test(clause) && merged.length) {
      const prior = merged.pop().replace(/[.!?]\s*$/, '');
      merged.push(punctuateAtomicClause(`${prior}, and ${clause}`));
      continue;
    }
    merged.push(punctuateAtomicClause(clause));
  }
  return merged;
}

function collapseControlOpenAndSelection(clauses) {
  const collapsed = [];
  for (const clause of Array.isArray(clauses) ? clauses : []) {
    const prior = collapsed[collapsed.length - 1];
    const opensControl = prior && /^open\s+(?:the\s+)?[^.!?]{1,180}\b(?:dropdown|calendar|picker|list|menu)\b/i.test(prior);
    const selectsValue = /^(?:select|choose|pick|set)\b/i.test(clause);
    if (opensControl && selectsValue) {
      collapsed[collapsed.length - 1] = punctuateAtomicClause(
        `${prior.replace(/[.!?]\s*$/, '')}, ${clause.replace(/[.!?]\s*$/, '')}`,
      );
      continue;
    }
    collapsed.push(clause);
  }
  return collapsed;
}

function decomposeStepText(text) {
  const value = clean(text);
  if (!value || isOptionListProse(value)) return value ? [value] : [];
  if (isConditionalExpandInstruction(value) || isConditionalCollapseInstruction(value)) return [value];
  if (/^if\b[^.;]{0,240},\s*(?:click|open|expand|close|collapse|select|choose|fill|enter|dismiss)\b/i.test(value)) {
    return [value];
  }
  if (/^(?:in|into|on|from|within|using|after)\b[^.;]{0,220},\s*(?:navigate|go\s+to|visit|open|enter|fill|input|type|select|choose|pick|set|check|tick|click|press|submit|hover|wait|scroll|expand|collapse|capture|download|upload|close|dismiss)\b/i.test(value)) {
    return splitAssertionClauses(value);
  }
  const assertionIndex = firstMatchIndex(value, ASSERTION_VERB_RE);
  const actionIndex = firstMatchIndex(value, BROWSER_ACTION_VERB_RE);
  if (actionIndex >= 0 && assertionIndex > actionIndex && isOptionListProse(value.slice(assertionIndex))) {
    return [value];
  }
  const operationClauses = value.split(ATOMIC_OPERATION_BOUNDARY_RE).map(clean).filter(Boolean);
  if (operationClauses.length > 1) {
    const openedControl = (operationClauses[0].match(/\bopen\s+(?:the\s+)?(.+?\b(?:dropdown|calendar|picker|list|menu))\b/i) || [])[1];
    const contextualized = operationClauses.flatMap((rawClause, index) => {
      let clause = rawClause;
      if (index > 0
        && openedControl
        && /^\s*(?:select|choose|pick)\b/i.test(clause)
        && !/\b(?:dropdown|calendar|picker|list|menu)\b/i.test(clause)) {
        clause = `${clause.replace(/[.!?]\s*$/, '')} from the ${clean(openedControl)}`;
      }
      return splitAssertionClauses(punctuateAtomicClause(clause));
    });
    return collapseControlOpenAndSelection(mergeInlineVerificationClauses(contextualized));
  }
  return splitAssertionClauses(value);
}

function decomposeStepTexts(stepTexts) {
  return (Array.isArray(stepTexts) ? stepTexts : []).flatMap(decomposeStepText).slice(0, 500);
}

function decomposeStepEntries(stepTexts) {
  return (Array.isArray(stepTexts) ? stepTexts : []).flatMap((authoredText, authoredIndex) => {
    const atomicTexts = decomposeStepText(authoredText);
    return atomicTexts.map((text, atomicIndex) => ({
      text,
      authoredText: clean(authoredText),
      logicalOrdinal: authoredIndex + 1,
      atomicOrdinal: atomicIndex + 1,
      atomicCount: atomicTexts.length,
    }));
  }).slice(0, 500);
}

function firstMatchIndex(value, expression) {
  const match = String(value || '').match(expression);
  return match ? match.index : -1;
}

function isQuantitativeAssertion(text) {
  const value = clean(text);
  return /\bnumber\s+of\b|\b(?:count|quantity|total|sum|average|minimum|maximum)\b/i.test(value)
    || /\b(?:at least|at most|more than|less than|greater than|fewer than)\s+\d+(?:\.\d+)?\b/i.test(value)
    || /\b\d+(?:\.\d+)?\s+(?:items?|rows?|results?|records?|entries|matches|errors?|warnings?|messages?|users?|orders?|products?|options?)\b/i.test(value);
}

const MONTH_NUMBER = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
});

function validIsoDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 1000 || year > 9999) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function canonicalIsoDate(text) {
  const value = clean(text);
  let match = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (match) return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i);
  if (match) return validIsoDate(Number(match[3]), MONTH_NUMBER[match[1].toLowerCase()], Number(match[2]));
  match = value.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (first > 12 && second <= 12) return validIsoDate(Number(match[3]), second, first);
  if (second > 12 && first <= 12) return validIsoDate(Number(match[3]), first, second);
  return null;
}

const ORDINAL_NUMBER = Object.freeze({
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
});

function unquote(value) {
  if (value == null) return '';
  let str = String(value).trim();
  while ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'")) || (str.startsWith('“') && str.endsWith('”'))) {
    if (str.length <= 1) break;
    str = str.slice(1, -1).trim();
  }
  str = str.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return str;
}

function tidyTarget(value) {
  if (!value) return '';
  const cleaned = clean(value)
    .replace(/^(?:inspect|determine|check)\s+whether\s+(?:the\s+)?/i, '')
    .replace(/^(?:that|the)\s+/i, '')
    .replace(/\s+(?:is|are|becomes?|remains?)$/i, '')
    .replace(/[,:;.!?]+$/, '')
    .trim();
  return unquote(cleaned);
}

function assertionCoreClause(text) {
  return clean(text)
    .split(/\.\s+(?=(?:if|when)\b)/i)[0]
    .replace(/,\s*(?:and\s+)?(?:if|when)\b.*$/i, '')
    .trim();
}

function explicitlyReferencesPriorControl(text) {
  const value = clean(text);
  if (!value) return false;
  const control = '(?:field|input|box|textarea|dropdown|list|menu|picker|calendar|control|button|link|option|prompt|alert|dialog|modal)';
  return /\b(?:from|in|within|using|on)\s+it\b/i.test(value)
    || new RegExp(`\\b(?:from|in|within|using|on)\\s+(?:(?:this|that)\\s+|(?:the\s+)?(?:same|opened|current|previously\\s+opened)\\s+)${control}\\b`, 'i').test(value);
}

function inferStepTarget(type, text, previousControlTarget = null) {
  const value = clean(text);
  if (!value) return previousControlTarget || null;
  if (type === 'Navigate') {
    const url = (value.match(/https?:\/\/[^\s"'()]+/i) || [])[0];
    return url ? url.replace(/[.,;!?]+$/, '') : tidyTarget(value.replace(/^navigate\s+to\s+/i, ''));
  }
  if (type === 'Scroll') return scrollSemantics(value).target || previousControlTarget || null;
  if (type === 'Expand' || type === 'Collapse') return disclosureSemantics(type, value).target || previousControlTarget || null;
  if (type === 'AcceptAlert' || type === 'DismissAlert') {
    const alertTarget = value.match(/\b(?:accept|dismiss|cancel|confirm)\s+(?:the\s+)?(.+?)(?:[.;]|$)/i);
    return tidyTarget(alertTarget && alertTarget[1] || 'alert');
  }

  if (previousControlTarget && explicitlyReferencesPriorControl(value)) return previousControlTarget;

  if (isAssertionType(type)) {
    const assertion = assertionCoreClause(value)
      .replace(/^\s*(?:verify|assert|validate|confirm|expect)(?:\s+that)?\s+/i, '')
      .replace(/[.!?]+$/, '');
    const visibleSubject = assertion.match(/^(.+?)(?=\s+(?:is|are)\s+(?:visible|hidden|displayed|shown|present|absent|enabled|disabled)\b)/i);
    const subject = visibleSubject || assertion.match(/^(.+?)(?=\s+(?:contains?|displays?|shows?|represents?|has|(?:automatically\s+)?changes?|matches?|equals?|must|should)\b)/i);
    return tidyTarget(subject && subject[1] || assertion);
  }

  const actionBody = value.replace(/^if\b[^.;]{0,240},\s*/i, '');
  if (['Click', 'Hover'].includes(type)) {
    const identified = actionBody.match(/\bidentified\s+as\s+["']?([^"'.;]+)["']?/i);
    if (identified) return tidyTarget(identified[1]);
    const direct = actionBody.match(/^\s*(?:click|press|submit|open|hover(?:\s+over)?|dismiss|choose)\s+(?:the\s+)?(.+?)(?:[.;]|$)/i);
    if (direct) return tidyTarget(direct[1]);
  }
  const control = '(?:field|input|box|textarea|dropdown|list|menu|picker|calendar|control|button|link|option|section|panel|heading|page|dashboard|tab|message|form|icon|prompt|alert|dialog|modal|popup)';
  const controlMatches = [...value.matchAll(new RegExp(`\\b(?:in|into|from|within|using|on)\\s+(?:the\\s+)?([^,;.]+?\\b${control})\\b`, 'ig'))];
  if (controlMatches.length) return tidyTarget(controlMatches[controlMatches.length - 1][1]);

  if (['Fill', 'Type'].includes(type)) {
    const intoTarget = value.match(/\b(?:in|into)\s+(?:the\s+)?(.+?)(?:[.;]|$)/i);
    if (intoTarget) return tidyTarget(intoTarget[1]);
    const leading = value.match(/^\s*(?:fill|type)\s+(?:the\s+)?(.+?)(?=\s+(?:with|using)\b|[.;]|$)/i);
    if (leading) return tidyTarget(leading[1]);
  }
  if (type === 'Radio') {
    const selected = value.match(/^\s*(?:select|choose|check)\s+(?:the\s+)?(.+?)(?:\s+only)?(?:\s+(?:if|when|unless)\b|[.;]|$)/i);
    if (selected) return tidyTarget(selected[1]);
  }
  if (['Select', 'Date'].includes(type)) {
    const opened = value.match(/\bopen\s+(?:the\s+)?(.+?\b(?:dropdown|calendar|picker|list|menu))\b/i);
    if (opened) return tidyTarget(opened[1]);
    const idempotentTarget = value.match(/^\s*(?:select|choose|check|tick)\s+(?:the\s+)?(.+?)(?:\s+only)?\s+(?:if|when|unless)\s+(?:it\s+)?is\s+not\s+already\s+(?:selected|checked)\b/i);
    if (idempotentTarget) return tidyTarget(idempotentTarget[1]);
  }
  if (['Select', 'Date', 'Radio'].includes(type) && previousControlTarget) return previousControlTarget;
  if (type === 'WaitForState') {
    const waited = value.match(/\bwait\s+(?:up\s+to\s+\d+\s+seconds?\s+)?(?:until|for)\s+(?:the\s+)?(.+?)(?:\s+(?:is|are|to\s+become|becomes?)\b|[.;]|$)/i);
    if (waited) return tidyTarget(waited[1]);
  }
  const leadingAction = actionBody.match(/^\s*(?:click|press|submit|open|hover(?:\s+over)?|dismiss|choose)\s+(?:the\s+)?(.+?)(?:[.;]|$)/i);
  return tidyTarget(leadingAction && leadingAction[1]) || previousControlTarget || null;
}

function selectionCriteriaForText(text) {
  const value = clean(text);
  const contains = value.match(/\b(?:visible\s+)?label\s+contains\s+["']?([^"'.;,]+?)["']?(?=\s+from\s+(?:the\s+)?|,\s*(?:and\s+)?(?:assert|verify|validate|confirm|expect)\b|[.;]|$)/i);
  if (contains) {
    const expectedText = unquote(clean(contains[1]));
    return { kind: 'predicate', predicate: `visible label contains ${expectedText}`, expectedText };
  }
  const ordinal = value.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+(?:st|nd|rd|th)?)\s+(?:[^,.;]{0,80}\s+)?option(?:\s*,\s*([^.;]+))?/i);
  if (ordinal) {
    const numeric = ORDINAL_NUMBER[String(ordinal[1]).toLowerCase()] || Number(String(ordinal[1]).replace(/\D/g, ''));
    return {
      kind: 'ordinal',
      ordinal: numeric,
      ...(clean(ordinal[2]) ? { expectedText: unquote(clean(ordinal[2])) } : {}),
    };
  }
  const exact = value.match(/\b(?:select|choose|pick)\s+(?:the\s+)?(.+?)(?=\s+from\b|\s+in\b|\s+if\b|,\s*(?:and\s+)?(?:assert|verify|validate|confirm|expect)\b|[.;]|$)/i);
  const textValue = tidyTarget(exact && exact[1]);
  return textValue ? { kind: 'exact_text', text: textValue } : null;
}

function inlineActionVerification(text) {
  const value = clean(text);
  const index = firstMatchIndex(value, ASSERTION_VERB_RE);
  if (index < 0) return null;
  return clean(value.slice(index).replace(/^[,;]\s*/, '')) || null;
}

function conditionForText(type, text) {
  if (isAssertionType(type)) return null;
  const value = clean(text);
  if (type === 'Expand' || type === 'Collapse') {
    const state = value.match(/\bif\s+(?:it|the\s+.+?\b(?:section|panel|disclosure|accordion))\s+is\s+(collapsed|expanded)\b/i);
    if (state) {
      const target = disclosureSemantics(type, value).target || 'disclosure control';
      return { kind: 'authored_predicate', predicate: `${target} is ${state[1].toLowerCase()}`, onFalse: 'skip' };
    }
  }
  const leading = value.match(/^if\s+(.+?)(?:,\s*|\s+then\s+)(?=(?:click|open|expand|close|collapse|select|choose|fill|enter|dismiss)\b)/i);
  const trailing = value.match(/\s+(?:if|when|unless)\s+(.+?)(?:[.;]|$)/i);
  const predicate = clean(leading && leading[1] || trailing && trailing[1]);
  return predicate ? { kind: 'authored_predicate', predicate, onFalse: 'skip' } : null;
}

function nonSensitiveInlineValue(type, text, target) {
  if (!['Fill', 'Type', 'Time', 'DateTime'].includes(type) || SENSITIVE_LABEL_RE.test(target || '')) return null;
  const value = clean(text);
  const withValue = value.match(/\b(?:with|using)\s+(.+?)(?:[.!?]|$)/i);
  if (withValue) return unquote(clean(withValue[1]));
  const enterValue = value.match(/\b(?:enter|type|input)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?/i);
  return unquote(clean(enterValue && enterValue[1])) || null;
}

function scrollSemantics(text) {
  const value = clean(text);
  const boundary = /\b(?:top|start|beginning)\b/i.test(value)
    ? 'start'
    : (/\b(?:bottom|end)\b/i.test(value) ? 'end' : null);
  if (boundary && !/\b(?:into view|until\b|section|field|control|element)\b/i.test(value)) {
    return { scrollMode: 'page', boundary };
  }
  const untilTarget = (value.match(/\buntil\s+(?:the\s+)?(.+?)\s+(?:is|becomes)\s+visible\b/i) || [])[1];
  const intoViewTarget = (value.match(/\bscroll\s+(?:the\s+)?(.+?)\s+into\s+view\b/i) || [])[1];
  const toTarget = (value.match(/\bscroll\s+(?:up|down|forward|backward)?\s*to\s+(?:the\s+)?(.+?)(?:[.!?]|$)/i) || [])[1];
  const target = clean(untilTarget || intoViewTarget || toTarget);
  return target ? { target: tidyTarget(target), scrollMode: 'target' } : { scrollMode: 'page' };
}

function disclosureSemantics(type, text) {
  const value = clean(text);
  const directTarget = (value.match(/\b(?:expand|open|collapse|close)\s+(?:the\s+)?(.+?\b(?:section|panel|disclosure|accordion))\b/i) || [])[1];
  const stateTarget = (value.match(/\b(?:the\s+)?(.+?\b(?:section|panel|disclosure|accordion))\s+(?:is|appears)\s+(?:collapsed|expanded)\b/i) || [])[1];
  const target = tidyTarget(directTarget || stateTarget);
  const expanded = type === 'Expand';
  return {
    ...(target ? { target } : {}),
    idempotent: true,
    expectedState: { property: 'expanded', equals: expanded },
  };
}

function stepSemanticMetadata(type, text, { previousControlTarget = null, hasDataRef = false } = {}) {
  const target = inferStepTarget(type, text, previousControlTarget);
  const authoredCondition = conditionForText(type, text);
  const normalizedCondition = authoredCondition && target && /^it\b/i.test(authoredCondition.predicate || '')
    ? { ...authoredCondition, predicate: authoredCondition.predicate.replace(/^it\b/i, target) }
    : authoredCondition;
  const common = {
    ...(target ? { target, element: target } : {}),
    ...(normalizedCondition ? { condition: normalizedCondition } : {}),
  };
  if (type === 'Navigate') {
    const value = (clean(text).match(/https?:\/\/[^\s"'()]+/i) || [])[0];
    return { ...common, ...(value ? { value: value.replace(/[.,;!?]+$/, '') } : {}) };
  }
  if (type === 'AcceptAlert' || type === 'DismissAlert') {
    return { ...common, target: target || 'alert', element: target || 'alert' };
  }
  if (type === 'Scroll') return { ...common, ...scrollSemantics(text) };
  if (type === 'Radio') {
    const unchecked = /\b(?:uncheck|clear|deselect|not selected|not checked)\b/i.test(text);
    const assertionText = inlineActionVerification(text);
    return {
      ...common,
      value: !unchecked,
      checked: !unchecked,
      ...(assertionText ? {
        expected: assertionText,
        verificationPoint: true,
        verify: { kind: 'checked', control: { name: target }, checked: !unchecked },
      } : {}),
    };
  }
  if (type === 'Date') {
    const value = canonicalIsoDate(text);
    const assertionText = inlineActionVerification(text);
    return {
      ...common,
      ...(value ? { value } : {}),
      ...(assertionText ? {
        expected: assertionText,
        verificationPoint: true,
        verify: { kind: 'value', field: { name: target }, equals: value || assertionText },
      } : {}),
    };
  }
  if (type === 'Select') {
    const selectionCriteria = selectionCriteriaForText(text);
    const selectedValue = selectionCriteria && (
      selectionCriteria.expectedText || selectionCriteria.text || selectionCriteria.value || selectionCriteria.predicate
    );
    const assertionText = inlineActionVerification(text);
    return {
      ...common,
      ...(selectionCriteria ? { selectionCriteria } : {}),
      ...(assertionText ? {
        expected: assertionText,
        verificationPoint: true,
        verify: { kind: 'selected', control: { name: target, role: 'combobox' }, value: selectedValue || assertionText },
      } : {}),
    };
  }
  if (type === 'Expand' || type === 'Collapse') return { ...common, ...disclosureSemantics(type, text) };
  if (isAssertionType(type)) {
    const expected = assertionCoreClause(text).replace(/^\s*(?:verify|assert|validate|confirm|expect)(?:\s+that)?\s+/i, '');
    const verify = type === 'AssertVisible'
      ? { kind: 'visible', element: { name: target || expected } }
      : (type === 'AssertHidden'
        ? { kind: 'hidden', element: { name: target || expected } }
        : (type === 'AssertUrl' ? { kind: 'url', url: expected } : { kind: 'text', text: expected }));
    return { ...common, expected, verificationPoint: true, stepKind: 'verification', verify };
  }
  const inlineValue = hasDataRef ? null : nonSensitiveInlineValue(type, text, target);
  const assertionText = inlineActionVerification(text);
  const valueVerification = assertionText && ['Fill', 'Type'].includes(type)
    ? { kind: 'value', field: { name: target, role: 'textbox' }, equals: inlineValue || assertionText }
    : null;
  return {
    ...common,
    ...(inlineValue ? { value: inlineValue } : {}),
    ...(assertionText ? { expected: assertionText, verificationPoint: true } : {}),
    ...(valueVerification ? { verify: valueVerification } : {}),
  };
}

function assertionStepType(value) {
  if (/\b(?:no|zero)\b[^.!?]{0,180}\b(?:visible|displayed|shown|present|appears?)\b|\b(?:hidden|not visible|not displayed|absent|does not appear|disappears)\b/i.test(value)) return 'AssertHidden';
  if (/\burl\b|https?:\/\//i.test(value)) return 'AssertUrl';
  if (isQuantitativeAssertion(value)) return 'AssertNumber';
  if (/\b(?:visible|displayed|shown|appears|present)\b/i.test(value)) return 'AssertVisible';
  return 'AssertText';
}

function actionStepType(value) {
  if (/^\s*(?:accept|ok)\s+(?:the\s+)?(?:alert|prompt|dialog)\b|^\s*accept\s+(?:alert|prompt)\b/i.test(value)) return 'AcceptAlert';
  if (/^\s*(?:dismiss|cancel)\s+(?:the\s+)?(?:alert|prompt|dialog)\b|^\s*dismiss\s+(?:alert|prompt)\b/i.test(value)) return 'DismissAlert';
  if (/^\s*confirm\s+(?:the\s+)?(?:alert|prompt|dialog)\b/i.test(value)) return 'AcceptAlert';
  if (isConditionalExpandInstruction(value) || /\bexpand\b/i.test(value)) return 'Expand';
  if (isConditionalCollapseInstruction(value) || /\bcollapse\b/i.test(value)) return 'Collapse';
  if (/\bscroll\b/i.test(value)) return 'Scroll';
  if (/\bnavigate\b|\bgo to\b|\bvisit\b|\bopen\b[^.]*https?:\/\//i.test(value)) return 'Navigate';
  if (/\btype\b/i.test(value)) return 'Type';
  if (/\b(?:enter|fill|input)\b/i.test(value)) return 'Fill';
  const idempotentSelection = /\b(?:radio|radio button|checkbox)\b/i.test(value)
    || (!/\b(?:dropdown|list|menu)\b/i.test(value)
      && /\b(?:(?:if|when) (?:it )?is not|unless) already (?:selected|checked)\b/i.test(value));
  if (/\b(?:select|choose|pick|set)\b/i.test(value) && canonicalIsoDate(value)) return 'Date';
  if (/\b(?:select|choose|check|tick)\b/i.test(value) && idempotentSelection) return 'Radio';
  if (/\bchoose\s+(?:the\s+)?option\s+that\b/i.test(value) && !/\b(?:dropdown|list|menu|picker)\b/i.test(value)) return 'Click';
  if (/\bselect\b|\b(?:choose|pick)\b[^.]*\b(?:option|dropdown|list)\b/i.test(value)) return 'Select';
  if (/\bhover\b/i.test(value)) return 'Hover';
  if (/\bwait\b/i.test(value)) return 'WaitForState';
  if (/\bscreenshot\b|\bcapture\b[^.]*\bscreen/i.test(value)) return 'Screenshot';
  if (/\bdownload\b/i.test(value)) return 'Download';
  if (/\bpopup\b|\bnew (?:tab|window)\b/i.test(value)) return 'Popup';
  if (/\b(?:click|press|submit|choose|open)\b/i.test(value)) return 'Click';
  return 'WaitForState';
}

function stepType(text) {
  const value = clean(text);
  if (/^\s*(?:accept|ok)\s+(?:the\s+)?(?:alert|prompt|dialog)\b|^\s*accept\s+(?:alert|prompt)\b/i.test(value)) return 'AcceptAlert';
  if (/^\s*(?:dismiss|cancel)\s+(?:the\s+)?(?:alert|prompt|dialog)\b|^\s*dismiss\s+(?:alert|prompt)\b/i.test(value)) return 'DismissAlert';
  if (/^\s*confirm\s+(?:the\s+)?(?:alert|prompt|dialog)\b/i.test(value)) return 'AcceptAlert';
  if (isConditionalExpandInstruction(value)) return 'Expand';
  if (isConditionalCollapseInstruction(value)) return 'Collapse';
  const assertionIndex = firstMatchIndex(value, ASSERTION_VERB_RE);
  const actionIndex = firstMatchIndex(value, BROWSER_ACTION_VERB_RE);
  if (actionIndex >= 0 && (assertionIndex < 0 || actionIndex < assertionIndex)) {
    return actionStepType(value.slice(actionIndex));
  }
  if (assertionIndex >= 0) return assertionStepType(value.slice(assertionIndex));
  return actionStepType(value);
}

function isAssertionType(type) {
  return /^Assert/.test(type);
}

function explicitDispatchedValue(type, text, target) {
  const value = clean(text);
  if (['Fill', 'Type'].includes(type)) {
    const withValue = value.match(/\b(?:with|using)\s+(.+?)(?:[.!?]|$)/i);
    if (withValue) return clean(withValue[1]);
    const entered = value.match(/\b(?:enter|type|input)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?/i);
    return clean(entered && entered[1]) || null;
  }
  if (['Select', 'Date', 'Calendar', 'Radio', 'Check'].includes(type)) {
    const quoted = value.match(/["']([^"']+)["']/);
    if (quoted) return clean(quoted[1]);
    const selected = value.match(
      /^\s*(?:select|choose|pick|check|tick|set)\s+(?:the\s+)?(.+?)(?=\s+(?:from|as|in|on)\b|[.;]|$)/i,
    );
    const candidate = clean(selected && selected[1]);
    if (candidate && normalize(candidate) !== normalize(target)) return candidate;
  }
  return null;
}

function bindText(
  text,
  dataDefinitions,
  rawBindings,
  {
    inputLike = false,
    referenceLike = false,
    allowInputLabelFallback = true,
  } = {},
) {
  let bound = String(text || '');
  const authoredText = bound;
  const refs = new Set();
  const orderedDefinitions = [...dataDefinitions].sort((a, b) => b.label.length - a.label.length);
  const literalGroups = new Map();
  for (const definition of orderedDefinitions) {
    const token = definition.name;
    const tokenRe = new RegExp(`\\{\\{\\s*${escapeRegExp(token)}\\s*\\}\\}`, 'i');
    if (tokenRe.test(authoredText)) refs.add(definition.id);
    const rawValues = (rawBindings.get(token) || []).slice().sort((a, b) => b.length - a.length);
    for (const rawValue of rawValues) {
      if (!rawValue || rawValue.length < 2) continue;
      const literalRe = literalOccurrenceRegExp(rawValue);
      if (!literalRe || !literalRe.test(authoredText)) continue;
      const key = String(rawValue).toLowerCase();
      if (!literalGroups.has(key)) literalGroups.set(key, { literal: String(rawValue), definitions: [] });
      literalGroups.get(key).definitions.push(definition);
    }
  }

  for (const group of [...literalGroups.values()].sort((a, b) => b.literal.length - a.literal.length)) {
    const definition = uniquelyResolveLiteralDefinition(group.definitions, authoredText, group.literal);
    if (!definition) continue;
    refs.add(definition.id);
    if (definition.classification === 'sensitive') {
      const reference = definition.source && definition.source.kind === 'environment' && definition.source.name
        ? `env:${definition.source.name}`
        : `env:${envNameFor(definition.name)}`;
      bound = replaceLiteralOccurrences(bound, group.literal, reference);
    }
  }

  if (inputLike && refs.size === 0 && allowInputLabelFallback) {
    const authoredNormalized = normalize(authoredText);
    const labelMatches = orderedDefinitions.map((definition) => {
      const normalizedLabel = normalize(definition.label);
      const index = normalizedLabel ? authoredNormalized.lastIndexOf(normalizedLabel) : -1;
      return { definition, normalizedLabel, index, end: index < 0 ? -1 : index + normalizedLabel.length };
    }).filter((entry) => entry.index >= 0)
      .sort((left, right) => right.end - left.end || right.normalizedLabel.length - left.normalizedLabel.length);
    if (labelMatches.length) refs.add(labelMatches[0].definition.id);
  }
  if (referenceLike && !inputLike) {
    for (const definition of orderedDefinitions) {
      const normalizedLabel = normalize(definition.label);
      if (normalizedLabel && normalize(authoredText).includes(normalizedLabel)) refs.add(definition.id);
    }
  }
  return { text: clean(bound), dataRefs: [...refs] };
}

function defaultFailureBehavior(type, text) {
  const value = clean(text);
  if (/\boptional\b/i.test(value)) return 'continue';
  if (/\bstop (?:the )?case\b/i.test(value)) return 'stop_case';
  if (/\bcontinue\b/i.test(value) && isAssertionType(type)) return 'continue';
  if (isAssertionType(type)) return 'continue';
  if (['Fill', 'Type', 'Select', 'Check', 'Radio', 'Date', 'Calendar', 'Scroll', 'Expand', 'Collapse', 'Navigate', 'Click'].includes(type)) return 'stop_descendants';
  return 'continue';
}

function buildSteps(caseId, stepTexts, dataDefinitions, rawBindings) {
  const steps = [];
  let lastStateChangingStepId = null;
  let activeControlScope = null;
  for (const [index, rawEntry] of stepTexts.entries()) {
    const entry = rawEntry && typeof rawEntry === 'object'
      ? rawEntry
      : { text: rawEntry, authoredText: rawEntry, logicalOrdinal: index + 1, atomicOrdinal: 1, atomicCount: 1 };
    const rawText = clean(entry.text);
    const type = stepType(rawText);
    const inputLike = ['Fill', 'Type', 'Select', 'Check', 'Radio', 'Date', 'Calendar'].includes(type);
    const explicitValue = inputLike
      ? explicitDispatchedValue(type, rawText, inferStepTarget(type, rawText, null))
      : null;
    const explicitValueIsDataLabel = explicitValue && dataDefinitions.some((definition) => (
      normalize(definition && definition.label) === normalize(explicitValue)
      || normalize(definition && definition.name) === normalize(explicitValue)
    ));
    const allowInputLabelFallback = !explicitValue || explicitValueIsDataLabel;
    const bound = bindText(rawText, dataDefinitions, rawBindings, {
      inputLike,
      referenceLike: inputLike || isAssertionType(type),
      allowInputLabelFallback,
    });
    const authoredBound = bindText(entry.authoredText || rawText, dataDefinitions, rawBindings, {
      inputLike,
      referenceLike: inputLike || isAssertionType(type),
      allowInputLabelFallback,
    });
    const id = `${caseId}.step.${String(index + 1).padStart(3, '0')}`;
    const stateChanging = ['Navigate', 'Fill', 'Type', 'Select', 'Check', 'Radio', 'Date', 'Calendar', 'Scroll', 'Expand', 'Collapse', 'Click'].includes(type);
    const independent = /\bindependent(?:ly)?\b/i.test(rawText);
    const dependsOn = independent || !lastStateChangingStepId ? [] : [lastStateChangingStepId];
    const scopeBoundary = ['Navigate', 'Scroll', 'Expand', 'Collapse'].includes(type);
    if (scopeBoundary) activeControlScope = null;
    const previousControlTarget = activeControlScope && explicitlyReferencesPriorControl(bound.text)
      ? activeControlScope.target
      : null;
    const semantics = stepSemanticMetadata(type, bound.text, {
      previousControlTarget,
      hasDataRef: bound.dataRefs.length > 0,
    });
    if (inputLike && bound.dataRefs.length === 1) {
      const definition = dataDefinitions.find((entry) => entry && entry.id === bound.dataRefs[0]);
      if (definition?.classification === 'sensitive' && definition.source?.kind === 'environment' && definition.source.name) {
        semantics.valueRef = `env:${definition.source.name}`;
      } else if (definition?.source?.kind === 'inline'
        && definition.source.value !== undefined
        && !Object.prototype.hasOwnProperty.call(semantics, 'value')
        && !semantics.selectionCriteria) {
        semantics.value = definition.source.value;
      }
    }
    const step = {
      id,
      ordinal: index + 1,
      logicalStepId: `${caseId}.logical.${String(entry.logicalOrdinal || index + 1).padStart(3, '0')}`,
      logicalOrdinal: Number(entry.logicalOrdinal) || index + 1,
      authoredText: authoredBound.text,
      atomicOrdinal: Number(entry.atomicOrdinal) || 1,
      atomicCount: Number(entry.atomicCount) || 1,
      type,
      text: bound.text,
      dataRefs: bound.dataRefs,
      dependsOn,
      flowImpact: stateChanging ? 'state_change' : (isAssertionType(type) ? 'observation' : 'wait'),
      failureBehavior: defaultFailureBehavior(type, rawText),
      ...semantics,
    };
    steps.push(step);
    const target = clean(step.target || step.element);
    if (target && (
      ['Select', 'Date', 'Radio'].includes(type)
      || (type === 'Click' && /\b(?:open|dropdown|list|menu|picker|calendar|suggestion)\b/i.test(bound.text))
    )) {
      activeControlScope = { target };
    } else if (stateChanging && !['WaitForState', 'Screenshot'].includes(type)) {
      activeControlScope = null;
    }
    if (stateChanging) lastStateChangingStepId = id;
  }
  addDefaultOperationChecks(steps);
  return steps;
}

function authoredControlValue(step = {}) {
  if (step.value !== undefined && step.value !== null && step.value !== '') return step.value;
  const selection = step.selectionCriteria && typeof step.selectionCriteria === 'object'
    ? step.selectionCriteria
    : null;
  if (selection) {
    return selection.expectedText || selection.text || selection.value || selection.predicate || null;
  }
  return null;
}

function addDefaultOperationChecks(steps) {
  const rows = Array.isArray(steps) ? steps : [];
  for (let index = 0; index < rows.length; index += 1) {
    const step = rows[index];
    if (!step || step.operationCheck || isAssertionType(step.type)) continue;
    const target = clean(step.target || step.element || step.text) || 'requested control';
    const next = rows.slice(index + 1).find((candidate) => candidate && candidate.type !== 'Screenshot') || null;
    const nextTarget = clean(next && (next.target || next.element));
    const controlValue = authoredControlValue(step);
    if (['Fill', 'Type'].includes(step.type)) {
      step.operationCheck = {
        kind: 'input_accepted',
        target,
        expected: controlValue != null
          ? `${target} contains the approved value.`
          : `${target} accepts the provided value.`,
        required: true,
        ...(controlValue != null ? { condition: { value: controlValue } } : {}),
      };
      continue;
    }
    if (['Select', 'Date', 'Radio'].includes(step.type)) {
      step.operationCheck = {
        kind: 'control_state',
        target,
        expected: controlValue != null
          ? `${target} displays the selected value ${String(controlValue)}.`
          : `${target} reflects the requested selection.`,
        required: true,
        ...(controlValue != null ? { condition: { value: controlValue } } : {}),
      };
      continue;
    }
    if (step.type === 'Navigate') {
      step.operationCheck = {
        kind: 'page_ready',
        target: nextTarget || target,
        expected: nextTarget
          ? `${nextTarget} is available after navigation.`
          : 'The requested destination is loaded.',
        required: true,
        ...(nextTarget ? { condition: { text: nextTarget } } : {}),
      };
      continue;
    }
    if (step.type === 'Click') {
      const opensControl = /\b(?:dropdown|list|menu|picker|calendar|suggestion)\b/i.test(`${target} ${step.text}`);
      step.operationCheck = opensControl
        ? {
          kind: 'menu_opened',
          target,
          expected: `${target} options are visible after opening the control.`,
          required: true,
        }
        : {
          kind: nextTarget ? 'page_ready' : 'action_completed',
          target: nextTarget || target,
          expected: nextTarget
            ? `${nextTarget} is available after activating ${target}.`
            : `${target} action completes.`,
          required: true,
          ...(nextTarget ? { condition: { text: nextTarget } } : {}),
        };
      continue;
    }
    if (['Expand', 'Collapse'].includes(step.type)) {
      step.operationCheck = {
        kind: 'control_state',
        target,
        expected: `${target} is ${step.type === 'Expand' ? 'expanded' : 'collapsed'}.`,
        required: true,
        condition: { expanded: step.type === 'Expand' },
      };
    }
  }
  return rows;
}

function assertionChannel(type) {
  if (type === 'AssertUrl') return 'url';
  if (type === 'AssertNumber') return 'number';
  if (['AssertVisible', 'AssertHidden', 'AssertEnabled', 'AssertDisabled', 'AssertSelected', 'AssertChecked'].includes(type)) return 'state';
  return 'text';
}

function assertionActualProperty(type, verify = {}) {
  if (['AssertVisible', 'AssertHidden'].includes(type)) return 'visible';
  if (['AssertEnabled', 'AssertDisabled'].includes(type)) return 'enabled';
  if (type === 'AssertSelected') return 'selected';
  if (type === 'AssertChecked' || verify.kind === 'checked') return 'checked';
  if (type === 'AssertUrl' || verify.kind === 'url') return 'url';
  if (type === 'AssertNumber') return 'number';
  if (verify.kind === 'value' || verify.kind === 'selected') return 'value';
  return 'text';
}

function assertionExpectedFromText(type, text) {
  const core = assertionCoreClause(text)
    .replace(/^\s*(?:verify|assert|validate|confirm|expect)(?:\s+that)?\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (type === 'AssertVisible') return true;
  if (type === 'AssertHidden') return false;
  if (type === 'AssertEnabled') return true;
  if (type === 'AssertDisabled') return false;
  if (type === 'AssertSelected') return true;
  if (type === 'AssertChecked') return true;
  if (type === 'AssertUrl') {
    const url = (core.match(/https?:\/\/[^\s)]+/i) || [])[0];
    return clean(url || core).replace(/[.,;!?]+$/, '');
  }
  if (type === 'AssertNumber') {
    const number = core.match(/-?\d+(?:\.\d+)?/);
    return number ? Number(number[0]) : core;
  }
  const semanticValue = core.match(/\b(?:changes?|becomes?)\s+from\s+.+?\s+to\s+(?:exactly\s+)?(.+)$/i)
    || core.match(/\b(?:equals?|matches?)\s+(?:exactly\s+)?(.+)$/i)
    || core.match(/\bcontains?\s+(?:exactly\s+)?(.+)$/i)
    || core.match(/\b(?:is|are)\s+(?:set\s+to\s+)?exactly\s+(.+)$/i);
  return clean(semanticValue && semanticValue[1] || core)
    .replace(/^["']|["']$/g, '')
    .replace(/[.,;!?]+$/, '')
    .trim();
}

function assertionExpected(type, step, text) {
  const verify = step && step.verify && typeof step.verify === 'object' ? step.verify : {};
  if (verify.kind === 'checked' && typeof verify.checked === 'boolean') return verify.checked;
  if (verify.equals !== undefined && verify.equals !== null && verify.equals !== '') return verify.equals;
  if (verify.value !== undefined && verify.value !== null && verify.value !== '') return verify.value;
  if (verify.url !== undefined && verify.url !== null && verify.url !== '') return verify.url;
  if (step && step.expected !== undefined && step.expected !== null && step.expected !== '') {
    return assertionExpectedFromText(type, step.expected);
  }
  return assertionExpectedFromText(type, text);
}

function assertionComparator(type, text, verify = {}) {
  if (type === 'AssertVisible') return 'visible';
  if (type === 'AssertHidden') return 'hidden';
  if (type === 'AssertEnabled') return 'enabled';
  if (type === 'AssertDisabled') return 'disabled';
  if (type === 'AssertSelected') return 'selected';
  if (type === 'AssertChecked' || verify.kind === 'checked') return 'checked';
  if (type === 'AssertUrl') return 'url_matches';
  if (type === 'AssertNumber') return 'equals';
  if (/\bcontains?\b/i.test(clean(text))) return 'contains';
  if (verify.kind === 'selected') return 'equals';
  return 'equals';
}

function assertionExpectedOperand(type, expected) {
  if (typeof expected === 'boolean') return { role: 'expected', kind: 'boolean', value: expected };
  if (typeof expected === 'number') return { role: 'expected', kind: 'number', value: expected };
  if (type === 'AssertUrl') return { role: 'expected', kind: 'url', value: expected };
  return { role: 'expected', kind: 'text', value: expected };
}

function structuredAssertion(caseId, ordinal, { type, text, step = null, dataRefs = [] }) {
  const verify = step && step.verify && typeof step.verify === 'object' ? step.verify : {};
  const expected = assertionExpected(type, step, text);
  const comparator = assertionComparator(type, text, verify);
  const target = clean(step && (step.target || step.element));
  const actualProperty = assertionActualProperty(type, verify);
  return {
    id: `${caseId}.assertion.${String(ordinal).padStart(3, '0')}`,
    ordinal,
    type,
    text,
    dataRefs,
    stepId: step && step.id || null,
    comparator,
    expected,
    failureBehavior: clean(step && step.failureBehavior) || 'continue',
    required: true,
    ...(target ? { target, targetIdentity: { name: target } } : {}),
    payload: {
      channel: assertionChannel(type),
      ...(target ? { target: { name: target } } : {}),
      operands: [
        { role: 'actual', kind: 'target_property', property: actualProperty },
        assertionExpectedOperand(type, expected),
      ],
    },
  };
}

function buildAssertions(caseId, caseLines, steps, dataDefinitions, rawBindings) {
  const assertions = [];
  for (const step of steps.filter((candidate) => isAssertionType(candidate.type) || candidate.verificationPoint === true)) {
    const assertionType = isAssertionType(step.type)
      ? step.type
      : assertionStepType(step.expected || inlineActionVerification(step.text) || step.text);
    const assertionText = isAssertionType(step.type)
      ? step.text
      : clean(step.expected || inlineActionVerification(step.text) || step.text);
    assertions.push(structuredAssertion(caseId, assertions.length + 1, {
      type: assertionType,
      text: assertionText,
      step,
      dataRefs: step.dataRefs,
    }));
  }

  let section = '';
  for (const line of caseLines) {
    const sectionLine = parseSectionLine(line);
    if (sectionLine) {
      section = sectionLine.name;
      if (ASSERTION_SECTIONS.has(section) && sectionLine.inline) {
        const bound = bindText(sectionLine.inline, dataDefinitions, rawBindings);
        if (bound.text && !isConstraintDirective(bound.text)) {
          const type = stepType(`Verify ${bound.text}`);
          assertions.push(structuredAssertion(caseId, assertions.length + 1, {
            type,
            text: bound.text,
            dataRefs: bound.dataRefs,
          }));
        }
      }
      continue;
    }
    if (!ASSERTION_SECTIONS.has(section)) continue;
    const candidate = stripListPrefix(line);
    if (!candidate || candidate.length > 500 || isConstraintDirective(candidate)) continue;
    const bound = bindText(candidate, dataDefinitions, rawBindings);
    if (!bound.text || assertions.some((item) => normalize(item.text) === normalize(bound.text))) continue;
    const type = stepType(`Verify ${bound.text}`);
    assertions.push(structuredAssertion(caseId, assertions.length + 1, {
      type,
      text: bound.text,
      dataRefs: bound.dataRefs,
    }));
  }
  return assertions;
}

function sessionContract(text) {
  const source = String(text || '');
  const explicitFresh = /session\s*mode\s*:\s*fresh\b|\bsessionMode\s*:\s*fresh\b|\bopen\s+a\s+fresh\s+browser\s+session\b/i.test(source);
  const continuation = !explicitFresh && /continue_from_(?:previous_)?(?:case|dependency)|continue\s+from\s+(?:(?:the\s+)?previous\s+case|case|tc[-_ ]?\w+)|depends\s+on\s+(?:case\s+)?(?:tc[-_ ]?[A-Za-z0-9._-]+)/i.test(source);
  const dependencies = [
    ...source.matchAll(/(?:depends\s+on|continue\s+from)\s+(?:case\s+)?(TC[-_ ]?[A-Za-z0-9._-]+)/ig),
    ...source.matchAll(/dependsOn(?:Ids|CaseRefs)\s*:\s*(TC[-_ ]?[A-Za-z0-9._-]+)/ig),
  ].map((match) => clean(match[1]));
  return {
    mode: continuation ? 'continue_from_case' : 'fresh',
    dependsOnCaseRefs: [...new Set(dependencies)],
    producesAuthenticatedState: !continuation && /\b(?:login|sign[ -]?in)\b/i.test(source),
    requiresAuthenticatedState: continuation && /\bauthenticated\b/i.test(source),
  };
}

function caseFailurePolicy(text, sessionRequirement = {}) {
  const source = String(text || '');
  const explicit = source.match(/\bfailurePolicy\s*:\s*(block_dependents|continue_independent|stop_case)\b/i);
  if (explicit) return explicit[1].toLowerCase();
  if (/\bfailure\s+policy\s*:\s*block\s+dependents\b/i.test(source)) return 'block_dependents';
  if (/\bfailure\s+policy\s*:\s*continue\s+independent\b/i.test(source)) return 'continue_independent';
  return sessionRequirement && sessionRequirement.mode === 'continue_from_case'
    ? 'block_dependents'
    : 'continue_independent';
}

function clonePublic(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sanitizeForPersistence(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const copy = clonePublic(contract);
  const dictionaries = [];
  if (Array.isArray(copy.dataDictionary)) dictionaries.push(copy.dataDictionary);
  if (Array.isArray(copy.dataBindings)) dictionaries.push(copy.dataBindings);
  for (const dictionary of dictionaries) {
    for (const entry of dictionary) {
      if (!entry || entry.classification !== 'sensitive') continue;
      delete entry.value;
      if (!entry.source || entry.source.kind !== 'environment') {
        entry.source = { kind: 'environment', name: envNameFor(entry.name) };
      }
      delete entry.source.value;
    }
  }
  for (const row of (Array.isArray(copy.dataRows) ? copy.dataRows : [])) {
    for (const [name, binding] of Object.entries(row && row.bindings || {})) {
      const definition = (copy.dataBindings || copy.dataDictionary || []).find((entry) => entry && entry.name === name);
      if (!definition || definition.classification !== 'sensitive') continue;
      row.bindings[name] = binding && binding.kind === 'environment'
        ? { kind: 'environment', name: binding.name }
        : { kind: 'environment', name: envNameFor(name) };
    }
  }
  return copy;
}

function compileCaseContractV1(requirements = []) {
  const docs = Array.isArray(requirements) ? requirements : [];
  const rawText = sourceText(docs);
  const text = normalizeAuthoredFlowSource(rawText, {
    sectionNames: [...SECTION_NAMES],
    dataSections: [...DATA_SECTIONS],
  });
  const lines = text.split(/\r?\n/);
  const data = collectData(lines);
  const scenarioRanges = findScenarioRanges(lines);
  const ranges = findCaseRanges(lines, scenarioRanges);
  const globalPreambleEnd = scenarioRanges.length
    ? scenarioRanges[0].start
    : (ranges.length ? ranges[0].start : lines.length);
  const sharedData = globalPreambleEnd > 0
    ? collectData(lines.slice(0, globalPreambleEnd))
    : { rawBindings: new Map(), dataRows: [], rawRows: [] };
  const scenarioDataByStart = new Map(scenarioRanges.map((scenario) => {
    const firstCase = ranges.find((range) => range.start > scenario.start && range.start < scenario.end);
    const preambleEnd = firstCase ? firstCase.start : scenario.end;
    return [
      scenario.start,
      collectData(lines.slice(scenario.bodyStart, preambleEnd)),
    ];
  }));
  const rawBindingsByCase = new Map();
  const rawRowsByCase = new Map();
  const explicitOneFlow = /\bone\s+continuous\b|\bdo\s+not\s+split\b|\bone\s+coherent\b|\bsingle\s+(?:continuous\s+)?(?:flow|journey|case)\b/i.test(text);
  const counts = explicitCounts(text);
  const cases = ranges.map((range, index) => {
    const caseLines = lines.slice(range.bodyStart, range.end);
    const id = stableId('case', `${range.externalId || ''}\n${range.name}`, index + 1);
    const localData = collectData(caseLines.length ? caseLines : lines);
    const scenarioScope = scenarioRanges.find((scenario) => (
      range.start > scenario.start && range.start < scenario.end
    ));
    const scopedSharedData = scenarioScope
      ? mergeDataScopes(sharedData, scenarioDataByStart.get(scenarioScope.start))
      : sharedData;
    const caseRawBindings = mergeRawBindings(scopedSharedData, localData);
    const caseRows = mergeCaseRows(scopedSharedData, localData);
    const caseRawRows = mergeCaseRawRows(scopedSharedData, localData);
    rawBindingsByCase.set(id, caseRawBindings);
    const authoredStepTexts = collectStepTexts(caseLines.length ? caseLines : lines);
    const steps = buildSteps(id, decomposeStepEntries(authoredStepTexts), data.definitions, caseRawBindings);
    const assertions = buildAssertions(id, caseLines.length ? caseLines : lines, steps, data.definitions, caseRawBindings);
    const usedRefs = new Set([
      ...steps.flatMap((step) => step.dataRefs || []),
      ...assertions.flatMap((assertion) => assertion.dataRefs || []),
    ]);
    const dataBindings = data.definitions.map(clonePublic);
    const unusedDataRefs = dataBindings.map((entry) => entry.id).filter((idRef) => !usedRefs.has(idRef));
    const filteredRows = caseRows.map((row) => ({
      id: row.id,
      bindings: Object.fromEntries(Object.entries(row.bindings || {}).filter(([name]) => usedRefs.has(`data.${name}`))),
    })).filter((row) => Object.keys(row.bindings).length > 0);
    const filteredRawRows = caseRawRows.map((row) => ({
      id: row.id,
      bindings: Object.fromEntries(Object.entries(row.bindings || {}).filter(([name]) => usedRefs.has(`data.${name}`))),
    })).filter((row) => Object.keys(row.bindings).length > 0);
    rawRowsByCase.set(id, filteredRawRows);
    const caseText = caseLines.join('\n');
    const initialStateText = sectionText(caseLines, ['starting state', 'initial state']);
    const finalStateText = sectionText(caseLines, ['final state', 'expected final state', 'expected result', 'expected results', 'final validation', 'preferred final assertion']);
    const session = sessionContract(caseText);
    const authoredScenario = scenarioScope ? {
      id: stableId(
        'scenario',
        `${scenarioScope.externalId || ''}\n${scenarioScope.name}`,
        scenarioRanges.indexOf(scenarioScope) + 1,
      ),
      externalId: scenarioScope.externalId || null,
      name: scenarioScope.name,
      ordinal: scenarioRanges.indexOf(scenarioScope) + 1,
    } : null;
    return {
      version: CONTRACT_VERSION,
      id,
      externalId: range.externalId || null,
      name: range.name,
      intent: range.name,
      authoredScenario,
      behavioralPartition: {
        ordinal: index + 1,
        reason: explicitOneFlow && ranges.length === 1 ? 'explicit_one_flow' : range.partitionReason,
      },
      initialState: { description: initialStateText || null },
      expectedFinalState: { description: finalStateText || null },
      sessionRequirement: session,
      failurePolicy: caseFailurePolicy(caseText, session),
      dataBindings,
      dataRows: filteredRows,
      steps,
      assertions,
      unusedDataRefs,
    };
  });

  cases.forEach((caseContract, index) => {
    const session = caseContract.sessionRequirement || {};
    const ownRefs = new Set([caseContract.id, caseContract.externalId].filter(Boolean).map(normalize));
    session.dependsOnCaseRefs = (Array.isArray(session.dependsOnCaseRefs) ? session.dependsOnCaseRefs : [])
      .filter((ref) => ref && !ownRefs.has(normalize(ref)));
    if (session.mode === 'continue_from_case' && index > 0) {
      const predecessor = cases[index - 1];
      session.predecessorCaseId = predecessor.id;
      session.predecessorCaseName = predecessor.name;
      if (!session.dependsOnCaseRefs.length) {
        session.dependsOnCaseRefs = [predecessor.externalId || predecessor.id];
      }
    }
    caseContract.sessionRequirement = session;
  });

  if (cases.length > 1) {
    if (counts.scenarios == null || counts.scenarios === 1) {
      counts.scenarios = scenarioRanges.length > 1 ? scenarioRanges.length : cases.length;
    }
    if (counts.cases == null || counts.cases === 1) counts.cases = cases.length;
  }

  const usedAcrossCases = new Set(cases.flatMap((item) => item.dataBindings.filter((entry) => !item.unusedDataRefs.includes(entry.id)).map((entry) => entry.id)));
  const envelope = {
    version: CONTRACT_VERSION,
    source: {
      requirementIds: docs.map((doc) => doc && doc.id).filter(Boolean),
      digest: digest(rawText),
    },
    explicitCounts: counts,
    partitioning: {
      mode: explicitOneFlow && cases.length === 1 ? 'explicit_one_flow' : (cases.length > 1 ? 'explicit_behavioral_cases' : 'single_behavior_topology'),
      explicitOneFlow,
      caseCount: cases.length,
      scenarioCount: scenarioRanges.length || (cases.length ? 1 : 0),
      dataRowsDoNotCreateCases: true,
    },
    dataDictionary: data.definitions.map(clonePublic),
    dataRows: clonePublic(data.dataRows),
    unusedDataRefs: data.definitions.map((entry) => entry.id).filter((idRef) => !usedAcrossCases.has(idRef)),
    cases,
  };
  RAW_BINDINGS.set(envelope, data.rawBindings);
  RAW_BINDINGS_BY_CASE.set(envelope, rawBindingsByCase);
  RAW_ROWS.set(envelope, data.rawRows);
  RAW_ROWS_BY_CASE.set(envelope, rawRowsByCase);
  return envelope;
}

function rawBindingsForContract(contract) {
  return contract && RAW_BINDINGS.get(contract) || new Map();
}

function rawBindingsForCase(contract, caseId) {
  const byCase = contract && RAW_BINDINGS_BY_CASE.get(contract);
  const selected = byCase instanceof Map && caseId != null ? byCase.get(String(caseId)) : null;
  return selected instanceof Map ? selected : rawBindingsForContract(contract);
}

function rawRowsForCase(contract, caseId) {
  const byCase = contract && RAW_ROWS_BY_CASE.get(contract);
  const selected = byCase instanceof Map && caseId != null ? byCase.get(String(caseId)) : null;
  if (Array.isArray(selected)) return selected;
  const rows = contract && RAW_ROWS.get(contract);
  return Array.isArray(rows) ? rows : [];
}

function wordSet(value) {
  return new Set(normalize(value).split(' ').filter((word) => word.length > 2));
}

function selectCaseContractV1(caseObj, envelope, fallbackIndex = 0) {
  const cases = envelope && Array.isArray(envelope.cases) ? envelope.cases : [];
  if (!cases.length) return null;
  if (cases.length === 1) return sanitizeForPersistence(cases[0]);
  const wanted = wordSet(`${caseObj && caseObj.name || ''} ${caseObj && caseObj.intent || ''}`);
  let best = null;
  let bestScore = -1;
  for (const candidate of cases) {
    const words = wordSet(`${candidate.name || ''} ${candidate.intent || ''} ${candidate.externalId || ''}`);
    const score = [...wanted].filter((word) => words.has(word)).length;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (bestScore <= 0) best = cases[Math.max(0, fallbackIndex) % cases.length];
  return sanitizeForPersistence(best);
}

function mergeIntoQualityContract(qualityContract, caseContract) {
  const base = qualityContract && typeof qualityContract === 'object' ? { ...qualityContract } : {};
  const sanitized = sanitizeForPersistence(caseContract);
  if (sanitized) base.caseContractV1 = sanitized;
  return base;
}

module.exports = {
  CONTRACT_VERSION,
  compileCaseContractV1,
  rawBindingsForContract,
  rawBindingsForCase,
  rawRowsForCase,
  sanitizeForPersistence,
  selectCaseContractV1,
  mergeIntoQualityContract,
  tokenName,
  isSensitiveLabel,
  envNameFor,
  _private: {
    bindText,
    buildSteps,
    buildAssertions,
    collectData,
    collectStepTexts,
    decomposeStepText,
    decomposeStepTexts,
    findCaseRanges,
    findScenarioRanges,
    isQuantitativeAssertion,
    parseKeyValue,
    stepType,
  },
};
