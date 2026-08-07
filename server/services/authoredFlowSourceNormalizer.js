'use strict';

const DEFAULT_INLINE_KEYS = Object.freeze([
  'sessionMode',
  'dependsOnIds',
  'dependsOnCaseRefs',
  'failurePolicy',
  'expected scenario count',
  'expected test case count',
  'reason',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headingPattern(sectionNames) {
  const names = [...new Set((sectionNames || []).map(clean).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  if (!names.length) return null;
  return new RegExp(`(^|\\s)(${names.join('|')})\\s*:\\s*`, 'ig');
}

function splitRecognizedHeadings(source, sectionNames) {
  const pattern = headingPattern(sectionNames);
  if (!pattern) return String(source || '');
  return String(source || '').replace(pattern, (match, prefix, heading) => (
    `${prefix && /\r?\n/.test(prefix) ? prefix : '\n'}${clean(heading)}:\n`
  ));
}

function splitNumberedOperations(source) {
  return String(source || '').replace(
    /[ \t]+(?=(?:\d{1,3})[.)][ \t]+(?:[A-Z]|https?:\/\/))/g,
    '\n',
  );
}

function splitInlineContractKeys(line, keys = DEFAULT_INLINE_KEYS) {
  const pattern = new RegExp(
    `(?:^|\\s)(${keys.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})\\s*:\\s*`,
    'ig',
  );
  const matches = [...String(line || '').matchAll(pattern)];
  if (matches.length < 2) return [line];
  const parts = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const start = current.index + current[0].length;
    const end = next ? next.index : String(line).length;
    parts.push(`${clean(current[1])}: ${clean(String(line).slice(start, end))}`);
  }
  return parts.filter(clean);
}

function splitInlineDataFields(line) {
  const source = clean(line);
  if (!source || !source.includes(':')) return [line];
  const matches = [...source.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9 _\/-]{1,60})\s*:\s*/g)];
  if (!matches.length) return [line];
  const fields = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const valueStart = current.index + current[0].length;
    const valueEnd = next ? next.index : source.length;
    const label = clean(current[1]);
    const value = clean(source.slice(valueStart, valueEnd));
    if (label && value) fields.push(`${label} = ${value}`);
  }
  return fields.length ? fields : [line];
}

function normalizeAuthoredFlowSource(source, { sectionNames = [], dataSections = [] } = {}) {
  const withHeadings = splitRecognizedHeadings(
    String(source == null ? '' : source).replace(/\r\n?/g, '\n'),
    sectionNames,
  );
  const withSteps = splitNumberedOperations(withHeadings);
  const dataSet = new Set((dataSections || []).map((value) => clean(value).toLowerCase()));
  const out = [];
  let section = '';

  for (const rawLine of withSteps.split('\n')) {
    const line = clean(rawLine);
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const heading = line.match(/^([^:]{1,110}):$/);
    if (heading && sectionNames.some((name) => clean(name).toLowerCase() === clean(heading[1]).toLowerCase())) {
      section = clean(heading[1]).toLowerCase();
      out.push(`${clean(heading[1])}:`);
      continue;
    }
    if (dataSet.has(section)) {
      out.push(...splitInlineDataFields(line));
      continue;
    }
    out.push(...splitInlineContractKeys(line));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
  normalizeAuthoredFlowSource,
  _private: {
    splitInlineContractKeys,
    splitInlineDataFields,
    splitNumberedOperations,
    splitRecognizedHeadings,
  },
};
