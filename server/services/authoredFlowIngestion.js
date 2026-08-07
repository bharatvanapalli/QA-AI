'use strict';

const crypto = require('crypto');
const caseContractV1 = require('./caseContractV1');

const VERSION = 'AuthoredFlowIngestionV1';

const ACTION_RE = /\b(?:navigate|open|go\s+to|visit|log\s*in|sign\s*in|log\s*out|sign\s*out|enter|fill|type|input|select|choose|pick|set|check|tick|uncheck|click(?:s|ed)?|press|submit|save|create|add|edit|update|delete|remove|hover|wait|scroll|expand|collapse|capture|screenshot|download|upload|close|dismiss)\b/i;
const ASSERTION_RE = /\b(?:verif(?:y|ies|ied)|validat(?:e|es|ed)|asserts?|expects?|confirms?|ensures?|sees?|should\s+(?:be|show|display|contain|appear)|must\s+(?:be|show|display|contain|appear))\b/i;
const ASSERTION_START_RE = /^(?:then\s+)?(?:verif(?:y|ies|ied)|validat(?:e|es|ed)|asserts?|expects?|confirms?|ensures?|sees?)\b/i;
const LIST_PREFIX_RE = /^\s*(?:(?:step\s*)?\d{1,4}[.)]|[-*+])\s+/i;
const BDD_PREFIX_RE = /^\s*(given|when|then|and|but)\b\s*/i;
const SECTION_RE = /^\s*([A-Za-z][A-Za-z0-9 /_-]{0,80})\s*:\s*(.*)$/;
const SENSITIVE_VALUE_RE = /^(?:bearer\s+)?(?:[A-Za-z0-9+/]{28,}={0,2}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})$/i;
const QUOTED_VALUE_RE = /\b(?:enter|fill|type|input|select|choose|pick|set|use)\s+(?:"([^"]+)"|'([^']+)'|`([^`]+)`)\s+(?:in|into|for|as|from)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 _/-]{0,70}?)(?=\s+(?:field|dropdown|list|option)\b|[.,;]|$)/gi;
const KNOWN_INLINE_LABEL_RE = /\b(email(?:\s+address)?|e-?mail|user\s*name|username|password|passcode|pwd|secret|token|api[ _-]?key|employee\s+name|first\s+name|last\s+name|role|expected(?:\s+(?:message|result|page|status))?)\s*(?::|=|\bis\b)?\s*/gi;

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
]);
const DATA_SECTIONS = new Set([
  'test data',
  'inline test data',
  'data',
  'data rows',
  'fixtures',
  'credentials',
  'examples',
]);
const PRECONDITION_SECTIONS = new Set([
  'precondition',
  'preconditions',
  'starting state',
  'initial state',
  'given',
]);
const ASSERTION_SECTIONS = new Set([
  'expected result',
  'expected results',
  'final validation',
  'preferred validation',
  'preferred final assertion',
  'final state',
  'expected final state',
  'assertions',
  'validations',
]);
const STORY_SECTIONS = new Set([
  'user story',
  'story',
  'requirement',
  'requirement title',
  'scenario',
  'scenario title',
  'test case',
  'test case title',
]);
const ALL_SECTIONS = new Set([
  ...STEP_SECTIONS,
  ...DATA_SECTIONS,
  ...PRECONDITION_SECTIONS,
  ...ASSERTION_SECTIONS,
  ...STORY_SECTIONS,
  'target url',
  'session policy',
  'failure behavior',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function normalizedSection(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sha(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function stableId(prefix, ...parts) {
  return `${prefix}-${sha(parts.join('\u001f'), 20)}`;
}

function normalizeSources(input) {
  let candidates;
  if (typeof input === 'string') candidates = [{ content: input }];
  else if (Array.isArray(input)) candidates = input;
  else if (input && Array.isArray(input.documents)) candidates = input.documents;
  else if (input && Array.isArray(input.sources)) candidates = input.sources;
  else candidates = input ? [input] : [];

  return candidates.map((candidate, index) => {
    const rawText = String(
      typeof candidate === 'string'
        ? candidate
        : (candidate.rawText ?? candidate.content ?? candidate.text ?? ''),
    );
    const id = clean(candidate && (candidate.id || candidate.sourceId))
      || `source-${String(index + 1).padStart(3, '0')}`;
    return {
      id,
      title: clean(candidate && (candidate.title || candidate.name)) || null,
      sourceType: clean(candidate && (candidate.sourceType || candidate.type)) || 'authored_text',
      mediaType: clean(candidate && candidate.mediaType) || 'text/plain',
      rawText,
      length: rawText.length,
      sha256: sha(rawText, 64),
    };
  });
}

function lineAndColumn(source, offset) {
  const bounded = Math.max(0, Math.min(Number(offset) || 0, source.length));
  let line = 1;
  let lastBreak = -1;
  for (let index = 0; index < bounded; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: bounded - lastBreak };
}

function sourceSpan(source, sourceId, start, end) {
  const safeStart = Math.max(0, Math.min(start, source.length));
  const safeEnd = Math.max(safeStart, Math.min(end, source.length));
  const from = lineAndColumn(source, safeStart);
  const to = lineAndColumn(source, safeEnd);
  return {
    sourceId,
    start: safeStart,
    end: safeEnd,
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
    quote: source.slice(safeStart, safeEnd),
  };
}

function linesWithSpans(source) {
  const lines = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const full = match[0];
    if (!full && match.index === source.length) break;
    const content = full.replace(/(?:\r\n|\r|\n)$/, '');
    const leading = (content.match(/^\s*/) || [''])[0].length;
    const trailing = (content.match(/\s*$/) || [''])[0].length;
    const start = match.index + leading;
    const end = Math.max(start, match.index + content.length - trailing);
    lines.push({
      raw: content,
      text: content.slice(leading, content.length - trailing),
      start,
      end,
      line: lines.length + 1,
    });
    if (!full.length) break;
  }
  return lines;
}

function trimRange(source, start, end) {
  let left = start;
  let right = end;
  while (left < right && /\s/.test(source[left])) left += 1;
  while (right > left && /\s/.test(source[right - 1])) right -= 1;
  return { start: left, end: right, text: source.slice(left, right) };
}

function removePrefixRange(source, start, end) {
  const range = trimRange(source, start, end);
  const raw = range.text;
  const list = raw.match(LIST_PREFIX_RE);
  const afterList = list ? list[0].length : 0;
  const bdd = raw.slice(afterList).match(BDD_PREFIX_RE);
  const afterBdd = bdd ? bdd[0].length : 0;
  return trimRange(source, range.start + afterList + afterBdd, range.end);
}

function parseHeading(line) {
  const match = line.text.match(SECTION_RE);
  if (!match) return null;
  const name = normalizedSection(match[1]);
  if (!ALL_SECTIONS.has(name)) return null;
  const rawIndex = line.text.indexOf(match[2], match[1].length + 1);
  return {
    name,
    body: match[2],
    bodyStart: line.start + Math.max(0, rawIndex),
    bodyEnd: line.end,
  };
}

function cellsForPipeLine(line) {
  const raw = line.text.trim();
  if (!raw.includes('|')) return [];
  const left = raw.startsWith('|') ? 1 : 0;
  const right = raw.endsWith('|') ? raw.length - 1 : raw.length;
  return raw.slice(left, right).split('|').map(clean);
}

function isPipeDivider(line) {
  const cells = cellsForPipeLine(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function cellsForCsvLine(line) {
  const cells = [];
  let value = '';
  let quote = '';
  for (let index = 0; index < line.text.length; index += 1) {
    const char = line.text[index];
    if (quote) {
      if (char === quote && line.text[index + 1] === quote) {
        value += char;
        index += 1;
      } else if (char === quote) quote = '';
      else value += char;
    } else if (char === '"' || char === '\'') quote = char;
    else if (char === ',') {
      cells.push(clean(value));
      value = '';
    } else value += char;
  }
  cells.push(clean(value));
  return cells;
}

function looksLikeSemanticInstruction(text) {
  const value = clean(text.replace(LIST_PREFIX_RE, '').replace(BDD_PREFIX_RE, ''));
  if (!value) return false;
  return /^(?:do|perform|complete|prepare|handle|make|use|provide|take|continue|proceed|return|finish|repeat|retry)\b/i.test(value)
    || /\b(?:and\s+then|after\s+that|next|finally)\b/i.test(value);
}

function dataToken(label) {
  return caseContractV1.tokenName(label)
    || normalizedSection(label).replace(/\s+/g, '_').slice(0, 60)
    || 'value';
}

function isSensitive(label, value) {
  return caseContractV1.isSensitiveLabel(label)
    || SENSITIVE_VALUE_RE.test(clean(value));
}

function maskedValue(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  return '•'.repeat(Math.min(12, Math.max(6, text.length)));
}

function dataEntry({ source, sourceId, label, value, start, end, origin, rowId = null }) {
  const sensitive = isSensitive(label, value);
  const token = dataToken(label);
  return {
    id: stableId('data', sourceId, start, end, token),
    label: clean(label),
    token,
    classification: sensitive ? 'sensitive' : 'normal',
    origin,
    rowId,
    value: sensitive ? null : clean(value),
    maskedValue: sensitive ? maskedValue(value) : clean(value),
    sourceSpan: sourceSpan(source, sourceId, start, end),
  };
}

function parseTableGroups(lines, source, sourceId) {
  const groups = [];
  const consumed = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const pipeHeaders = cellsForPipeLine(line);
    if (pipeHeaders.length >= 2 && lines[index + 1] && isPipeDivider(lines[index + 1])) {
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length) {
        const cells = cellsForPipeLine(lines[cursor]);
        if (cells.length !== pipeHeaders.length || isPipeDivider(lines[cursor])) break;
        rows.push({ line: lines[cursor], cells });
        cursor += 1;
      }
      const endLine = rows.length ? rows[rows.length - 1].line : lines[index + 1];
      const table = buildTable({
        format: 'markdown',
        headers: pipeHeaders,
        rows,
        source,
        sourceId,
        start: line.start,
        end: endLine.end,
      });
      groups.push(table);
      for (let mark = index; mark < cursor; mark += 1) consumed.add(mark);
      index = cursor - 1;
      continue;
    }

    const csvHeaders = cellsForCsvLine(line);
    const nextCsv = lines[index + 1] ? cellsForCsvLine(lines[index + 1]) : [];
    const headerish = csvHeaders.length >= 2
      && csvHeaders.every((cell) => /^[A-Za-z][A-Za-z0-9 _./-]{0,60}$/.test(cell));
    if (!headerish || nextCsv.length !== csvHeaders.length) continue;
    const rows = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const cells = cellsForCsvLine(lines[cursor]);
      if (cells.length !== csvHeaders.length || !lines[cursor].text.trim()) break;
      rows.push({ line: lines[cursor], cells });
      cursor += 1;
    }
    if (!rows.length) continue;
    groups.push(buildTable({
      format: 'csv',
      headers: csvHeaders,
      rows,
      source,
      sourceId,
      start: line.start,
      end: rows[rows.length - 1].line.end,
    }));
    for (let mark = index; mark < cursor; mark += 1) consumed.add(mark);
    index = cursor - 1;
  }
  return { groups, consumed };
}

function buildTable({ format, headers, rows, source, sourceId, start, end }) {
  const tableId = stableId('table', sourceId, start, end);
  const tableRows = rows.map((row, rowIndex) => {
    const rowId = `${tableId}.row.${rowIndex + 1}`;
    const values = headers.map((header, column) => dataEntry({
      source,
      sourceId,
      label: header,
      value: row.cells[column],
      start: row.line.start,
      end: row.line.end,
      origin: `${format}_table`,
      rowId,
    }));
    return {
      id: rowId,
      values,
      sourceSpan: sourceSpan(source, sourceId, row.line.start, row.line.end),
    };
  });
  return {
    id: tableId,
    format,
    headers: headers.map((label) => ({ label, token: dataToken(label) })),
    rows: tableRows,
    sourceSpan: sourceSpan(source, sourceId, start, end),
  };
}

function quotedDataEntries(source, sourceId) {
  const entries = [];
  QUOTED_VALUE_RE.lastIndex = 0;
  let match;
  while ((match = QUOTED_VALUE_RE.exec(source)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    const label = clean(match[4]);
    const localIndex = match[0].indexOf(value);
    const start = match.index + Math.max(0, localIndex);
    entries.push(dataEntry({
      source,
      sourceId,
      label,
      value,
      start,
      end: start + value.length,
      origin: 'quoted_inline',
    }));
  }
  return entries;
}

function naturalLiteralDataEntries(source, sourceId) {
  const entries = [];
  const emailRe = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  let match;
  while ((match = emailRe.exec(source)) !== null) {
    const nearby = source.slice(Math.max(0, match.index - 50), match.index).toLowerCase();
    entries.push(dataEntry({
      source,
      sourceId,
      label: /\b(?:login|sign\s*in|username|credential|admin)\b/.test(nearby) ? 'Username' : 'Email',
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
      origin: 'natural_inline',
    }));
  }
  return entries;
}

function knownInlineDataEntries(text, absoluteStart, source, sourceId, origin = 'inline_text') {
  const matches = [];
  KNOWN_INLINE_LABEL_RE.lastIndex = 0;
  let match;
  while ((match = KNOWN_INLINE_LABEL_RE.exec(text)) !== null) {
    matches.push({
      label: clean(match[1]),
      start: match.index,
      valueStart: KNOWN_INLINE_LABEL_RE.lastIndex,
    });
  }
  const entries = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    let rawValue = text.slice(current.valueStart, next ? next.start : text.length);
    rawValue = rawValue
      .replace(/^\s*(?:"|'|`)/, '')
      .replace(/(?:"|'|`)?\s*(?:,|;|\b(?:and\s+then|then|after\s+that)\b).*$/i, '')
      .trim();
    const firstToken = rawValue.match(/^\{\{[^}]+}}|^[^\s,.;]+(?:\s+[^\s,.;]+)?/);
    const value = firstToken
      ? clean(firstToken[0].replace(/^["'`]|["'`]$/g, '').replace(/\s+and$/i, ''))
      : '';
    if (!value || /^(?:field|value|data|button|page)$/i.test(value)) continue;
    const valueIndex = text.indexOf(value, current.valueStart);
    if (valueIndex < 0) continue;
    entries.push(dataEntry({
      source,
      sourceId,
      label: current.label,
      value,
      start: absoluteStart + valueIndex,
      end: absoluteStart + valueIndex + value.length,
      origin,
    }));
  }
  return entries;
}

function explicitDataEntries(text, absoluteStart, source, sourceId) {
  const trimmed = clean(text.replace(LIST_PREFIX_RE, ''));
  if (!trimmed) return [];
  const single = trimmed.match(/^([^:=]{1,60})\s*[:=]\s*(.+)$/);
  if (single && !/^https?$/i.test(clean(single[1]))) {
    const value = clean(single[2]);
    const valueIndex = text.indexOf(single[2]);
    return [dataEntry({
      source,
      sourceId,
      label: single[1],
      value,
      start: absoluteStart + Math.max(0, valueIndex),
      end: absoluteStart + Math.max(0, valueIndex) + single[2].length,
      origin: 'key_value',
    })];
  }
  return knownInlineDataEntries(text, absoluteStart, source, sourceId, 'key_value');
}

function splitInstructionRanges(source, start, end) {
  const base = removePrefixRange(source, start, end);
  if (!base.text) return [];
  const boundaries = [];
  const boundaryRe = /[.!?]+(?=\s+|$)|\s+(?:(?:and\s+)?then|after\s+that|next|finally)\s+(?=(?:navigate|open|go|visit|log|sign|enter|fill|type|select|choose|check|click|press|submit|save|create|add|edit|update|delete|remove|upload|download|wait|scroll|close|dismiss)\b)|\s+and\s+(?=(?:navigate|open|go|visit|log|sign|enter|fill|type|select|choose|click|press|submit|save|create|add|edit|update|delete|remove|upload|download|wait|scroll|close|dismiss)\b)|\s+(?=(?:create|save|log\s*out|logout|sign\s*out|signout)\b)/gi;
  let match;
  while ((match = boundaryRe.exec(base.text)) !== null) boundaries.push({
    start: match.index,
    end: boundaryRe.lastIndex,
    punctuation: /^[.!?]/.test(match[0]),
  });
  if (!boundaries.length) return [base];
  const ranges = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    const segment = trimRange(
      source,
      base.start + cursor,
      base.start + (boundary.punctuation ? boundary.end : boundary.start),
    );
    if (segment.text) ranges.push(segment);
    cursor = boundary.end;
  }
  const tail = trimRange(source, base.start + cursor, base.end);
  if (tail.text) ranges.push(tail);
  return ranges;
}

function atomicType(text) {
  if (!ACTION_RE.test(text) && !ASSERTION_RE.test(text)) return 'SemanticInstruction';
  const classified = caseContractV1._private.stepType(text);
  if (classified && classified !== 'Unknown') return classified;
  if (ASSERTION_RE.test(text)) return 'SemanticAssertion';
  if (ACTION_RE.test(text)) return 'SemanticAction';
  return 'SemanticInstruction';
}

function atomicParts(authoredText) {
  const assertionBoundary = /\s+(?:(?:(?:and\s+)?then|and)\s+)?(?=(?:verif(?:y|ies|ied)|validat(?:e|es|ed)|asserts?|expects?|confirms?|ensures?|sees?)\b)/i;
  let parts = authoredText.split(assertionBoundary).map(clean).filter(Boolean);
  if (parts.length === 1) {
    const existing = caseContractV1._private.decomposeStepText(authoredText);
    parts = existing.length ? existing : [authoredText];
  }
  return parts.map((text, index) => ({
    ordinal: index + 1,
    text,
    kind: ASSERTION_START_RE.test(text) ? 'assertion' : (ACTION_RE.test(text) ? 'action' : 'semantic'),
    type: atomicType(text),
  }));
}

function logicalStep({ source, sourceId, start, end, role = null, fallback = false }) {
  const range = removePrefixRange(source, start, end);
  const authoredText = clean(range.text);
  const id = stableId('logical-step', sourceId, range.start, range.end, authoredText);
  const atoms = atomicParts(authoredText);
  return {
    id,
    logicalStepId: id,
    authoredText,
    role: role || (ASSERTION_START_RE.test(authoredText) ? 'assertion' : 'action'),
    interpretationMode: fallback || !ACTION_RE.test(authoredText) && !ASSERTION_RE.test(authoredText)
      ? 'semantic_fallback'
      : 'deterministic',
    atomicActions: atoms.map((atom) => ({
      ...atom,
      id: `${id}.atomic.${atom.ordinal}`,
    })),
    sourceSpan: sourceSpan(source, sourceId, range.start, range.end),
  };
}

function statement({ source, sourceId, start, end, kind }) {
  const range = removePrefixRange(source, start, end);
  return {
    id: stableId(kind, sourceId, range.start, range.end, range.text),
    text: clean(range.text),
    sourceSpan: sourceSpan(source, sourceId, range.start, range.end),
  };
}

function storyUnderstanding(source, sourceId) {
  const actors = [];
  const goals = [];
  const benefits = [];
  const patterns = [
    {
      list: actors,
      kind: 'actor',
      re: /\bAs\s+(?:an?\s+)?([^,\r\n.]{1,80})/gi,
      group: 1,
    },
    {
      list: goals,
      kind: 'goal',
      re: /\bI\s+(?:want|need|would\s+like)\s+to\s+([^.\r\n]+?)(?=,\s*so\s+that\b|[.\r\n]|$)/gi,
      group: 1,
    },
    {
      list: benefits,
      kind: 'benefit',
      re: /\bso\s+that\s+([^.\r\n]+)/gi,
      group: 1,
    },
  ];
  for (const item of patterns) {
    let match;
    while ((match = item.re.exec(source)) !== null) {
      const value = clean(match[item.group]);
      if (!value) continue;
      const relative = match[0].indexOf(match[item.group]);
      const start = match.index + Math.max(0, relative);
      item.list.push({
        id: stableId(item.kind, sourceId, start, start + match[item.group].length, value),
        text: value,
        sourceSpan: sourceSpan(source, sourceId, start, start + match[item.group].length),
      });
    }
  }
  return { actors, goals, benefits };
}

function diagnostic(code, message, extra = {}) {
  return {
    code,
    severity: 'info',
    blocking: false,
    message,
    ...extra,
  };
}

function dedupeBySpan(items) {
  const seen = new Set();
  return items.filter((item) => {
    const span = item.sourceSpan || {};
    const key = `${span.sourceId}:${span.start}:${span.end}:${item.token || item.text || item.authoredText || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeData(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.sourceSpan.sourceId}:${item.sourceSpan.start}:${item.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function interpretSource(sourceRecord) {
  const source = sourceRecord.rawText;
  const sourceId = sourceRecord.id;
  const lines = linesWithSpans(source);
  const { groups: tables, consumed: tableLines } = parseTableGroups(lines, source, sourceId);
  const story = storyUnderstanding(source, sourceId);
  const logicalSteps = [];
  const preconditions = [];
  const assertions = [];
  const inlineData = tables.flatMap((table) => table.rows.flatMap((row) => row.values));
  const diagnostics = [];
  let section = '';
  let bddPhase = '';
  let recognizedHeadingCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text || tableLines.has(index)) continue;
    const heading = parseHeading(line);
    let bodyStart = line.start;
    let bodyEnd = line.end;
    let bodyText = line.text;
    if (heading) {
      section = heading.name;
      recognizedHeadingCount += 1;
      bodyStart = heading.bodyStart;
      bodyEnd = heading.bodyEnd;
      bodyText = heading.body;
      if (!clean(bodyText)) continue;
    }

    const bdd = bodyText.match(BDD_PREFIX_RE);
    if (bdd && !heading) {
      const keyword = bdd[1].toLowerCase();
      if (keyword !== 'and' && keyword !== 'but') bddPhase = keyword;
      bodyStart += bdd[0].length;
      bodyText = source.slice(bodyStart, bodyEnd);
    }

    if (DATA_SECTIONS.has(section)) {
      inlineData.push(...explicitDataEntries(bodyText, bodyStart, source, sourceId));
      continue;
    }
    if (PRECONDITION_SECTIONS.has(section) || bddPhase === 'given') {
      if (clean(bodyText)) preconditions.push(statement({
        source,
        sourceId,
        start: bodyStart,
        end: bodyEnd,
        kind: 'precondition',
      }));
      continue;
    }
    if (ASSERTION_SECTIONS.has(section) || bddPhase === 'then') {
      if (clean(bodyText)) {
        const assertion = statement({
          source,
          sourceId,
          start: bodyStart,
          end: bodyEnd,
          kind: 'assertion',
        });
        assertions.push(assertion);
        if (bddPhase === 'then') logicalSteps.push(logicalStep({
          source,
          sourceId,
          start: bodyStart,
          end: bodyEnd,
          role: 'assertion',
        }));
      }
      continue;
    }
    if (STORY_SECTIONS.has(section)
      && !STEP_SECTIONS.has(section)
      && !ACTION_RE.test(bodyText)
      && !ASSERTION_RE.test(bodyText)) {
      continue;
    }

    const listed = LIST_PREFIX_RE.test(bodyText);
    const inStepSection = STEP_SECTIONS.has(section);
    const bddAction = bddPhase === 'when';
    const executable = ACTION_RE.test(bodyText)
      || ASSERTION_RE.test(bodyText)
      || looksLikeSemanticInstruction(bodyText);
    if (inStepSection || listed || bddAction || executable) {
      const ranges = splitInstructionRanges(source, bodyStart, bodyEnd);
      for (const range of ranges) {
        if (!clean(range.text)) continue;
        const fallback = !ACTION_RE.test(range.text) && !ASSERTION_RE.test(range.text);
        logicalSteps.push(logicalStep({
          source,
          sourceId,
          start: range.start,
          end: range.end,
          fallback,
        }));
        if (ASSERTION_RE.test(range.text)) assertions.push(statement({
          source,
          sourceId,
          start: range.start,
          end: range.end,
          kind: 'assertion',
        }));
      }
    }
  }

  inlineData.push(...quotedDataEntries(source, sourceId));
  inlineData.push(...naturalLiteralDataEntries(source, sourceId));
  for (const line of lines) {
    if (!line.text) continue;
    inlineData.push(...knownInlineDataEntries(line.text, line.start, source, sourceId));
  }

  if (!logicalSteps.length && clean(source)) {
    const fallbackLines = lines.filter((line) => line.text && !parseHeading(line));
    const range = fallbackLines.length
      ? { start: fallbackLines[0].start, end: fallbackLines[fallbackLines.length - 1].end }
      : { start: 0, end: source.length };
    logicalSteps.push(logicalStep({
      source,
      sourceId,
      start: range.start,
      end: range.end,
      fallback: true,
    }));
  }

  const steps = dedupeBySpan(logicalSteps);
  const data = dedupeData(inlineData);
  if (!recognizedHeadingCount && clean(source)) {
    diagnostics.push(diagnostic(
      'low_structure_input',
      'The source was accepted as free-form text and interpreted without requiring headings.',
      { sourceId },
    ));
  }
  for (const step of steps) {
    if (step.interpretationMode === 'semantic_fallback') {
      diagnostics.push(diagnostic(
        'semantic_fallback_step',
        'The instruction is preserved verbatim for semantic execution because no controlled action was required.',
        { stepId: step.id, sourceSpan: step.sourceSpan },
      ));
    }
  }
  const sensitiveCount = data.filter((entry) => entry.classification === 'sensitive').length;
  if (sensitiveCount) {
    diagnostics.push(diagnostic(
      'sensitive_inline_data_detected',
      `${sensitiveCount} sensitive inline value${sensitiveCount === 1 ? ' was' : 's were'} classified and masked in structured output.`,
      { sourceId, count: sensitiveCount },
    ));
  }
  if (!steps.some((step) => step.role === 'assertion' || step.atomicActions.some((atom) => atom.kind === 'assertion'))
    && !assertions.length
    && clean(source)) {
    diagnostics.push(diagnostic(
      'no_explicit_assertion_observed',
      'No explicit validation phrase was found. This observation does not prevent ingestion or execution.',
      { sourceId },
    ));
  }

  const nonEmptyLines = lines.filter((line) => line.text).length;
  return {
    story,
    preconditions: dedupeBySpan(preconditions),
    logicalSteps: steps,
    assertions: dedupeBySpan(assertions),
    testData: {
      fields: data,
      tables,
    },
    diagnostics,
    sourceCoverage: {
      nonEmptyLineCount: nonEmptyLines,
      logicalStepCount: steps.length,
      semanticFallbackCount: steps.filter((step) => step.interpretationMode === 'semantic_fallback').length,
      assertionCount: dedupeBySpan(assertions).length,
      inlineDataCount: data.length,
      tableCount: tables.length,
    },
  };
}

function ingestAuthoredFlow(input) {
  const sources = normalizeSources(input);
  const perSource = sources.map(interpretSource);
  const diagnostics = perSource.flatMap((item) => item.diagnostics);
  const logicalSteps = perSource.flatMap((item) => item.logicalSteps);
  const assertions = perSource.flatMap((item) => item.assertions);
  const preconditions = perSource.flatMap((item) => item.preconditions);
  const fields = perSource.flatMap((item) => item.testData.fields);
  const tables = perSource.flatMap((item) => item.testData.tables);
  const actors = perSource.flatMap((item) => item.story.actors);
  const goals = perSource.flatMap((item) => item.story.goals);
  const benefits = perSource.flatMap((item) => item.story.benefits);

  if (!sources.some((source) => clean(source.rawText))) {
    diagnostics.push(diagnostic(
      'empty_source_observed',
      'No authored text was supplied. The ingestion request is preserved as an empty, non-blocking draft.',
    ));
  }

  return {
    version: VERSION,
    acceptance: {
      accepted: true,
      blocking: false,
      blockers: [],
    },
    source: {
      documents: sources,
      exactSourcePreserved: true,
    },
    understanding: {
      actors,
      goals,
      benefits,
      preconditions,
      logicalSteps,
      assertions,
      testData: { fields, tables },
    },
    diagnostics,
    summary: {
      sourceCount: sources.length,
      logicalStepCount: logicalSteps.length,
      atomicActionCount: logicalSteps.reduce((sum, step) => sum + step.atomicActions.length, 0),
      preconditionCount: preconditions.length,
      assertionCount: assertions.length,
      inlineDataCount: fields.length,
      tableCount: tables.length,
      sensitiveDataCount: fields.filter((entry) => entry.classification === 'sensitive').length,
      semanticFallbackCount: logicalSteps.filter((step) => step.interpretationMode === 'semantic_fallback').length,
    },
    sourceCoverage: perSource.map((item, index) => ({
      sourceId: sources[index].id,
      ...item.sourceCoverage,
    })),
  };
}

module.exports = {
  VERSION,
  ingestAuthoredFlow,
  _private: {
    atomicParts,
    linesWithSpans,
    normalizeSources,
    parseTableGroups,
    sourceSpan,
    splitInstructionRanges,
  },
};
