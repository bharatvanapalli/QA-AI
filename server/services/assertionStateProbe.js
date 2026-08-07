'use strict';

const controlStateProbe = require('./controlStateProbe');

const TABLE_STATE_FUNCTION = `(element) => {
  if (!element || element.nodeType !== 1) return { found: false };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const rowNodes = Array.from(element.querySelectorAll('tr, [role="row"]'));
  const matrix = rowNodes.map((row) => Array.from(row.querySelectorAll('th, td, [role="columnheader"], [role="rowheader"], [role="cell"], [role="gridcell"]'))
    .map((cell) => clean(cell.innerText || cell.textContent)));
  const nonempty = matrix.filter((row) => row.length > 0);
  const headerNodes = Array.from(element.querySelectorAll('thead th, [role="columnheader"]'));
  const headers = headerNodes.length ? headerNodes.map((cell) => clean(cell.innerText || cell.textContent)) : [];
  const rows = headers.length && nonempty.length && headers.every((value, index) => nonempty[0][index] === value)
    ? nonempty.slice(1) : nonempty;
  return { found: true, headers, rows, rowCount: rows.length, columnCount: Math.max(headers.length, ...rows.map((row) => row.length), 0) };
}`;

const COLLECTION_STATE_FUNCTION = `(element) => {
  if (!element || element.nodeType !== 1) return { found: false };
  const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
  const direct = Array.from(element.querySelectorAll(':scope > li, :scope > option, :scope > [role="listitem"], :scope > [role="option"], :scope > [role="row"]'));
  const nodes = direct.length ? direct : Array.from(element.children || []);
  const items = nodes.map((node) => clean(node.innerText || node.textContent)).filter(Boolean);
  if (!items.length) {
    return { found: false, uncheckable: true, items: [], count: 0, reason: 'collection_items_not_observed' };
  }
  return { found: true, items, count: items.length };
}`;

function normalizeTargetName(value) {
  let normalized = String(value == null ? '' : value).trim();
  const literalText = normalized.match(/^visible\s+text\s+["'](.+?)["']$/i);
  if (literalText) return literalText[1].trim();
  normalized = normalized.replace(/^through\s+secure\s+input\s+readback\s+that\s+(?:the\s+)?/i, '');
  normalized = normalized.replace(/^verify\s+(?:that\s+)?/i, '');
  return normalized.trim();
}

function targetDescriptor(assertion = {}) {
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : assertion;
  const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
  const element = payload.element && typeof payload.element === 'object' ? payload.element : {};
  return {
    name: normalizeTargetName(target.name || target.label || element.name || element.label || payload.targetName
      || payload.elementName || payload.fieldName || payload.label || '') || null,
    role: String(target.role || element.role || payload.role || '').trim().toLowerCase() || null,
  };
}

function assertionType(assertion = {}) {
  return String(assertion.type || assertion.kind || '').trim().toUpperCase();
}

function snapshotCollectionState(snapshotText, targetName = '') {
  const rows = String(snapshotText || '').split(/\r?\n/).map((line, index) => {
    const roleMatch = line.match(/^\s*-?\s*([a-z][a-z0-9_-]*)\b/i);
    const nameMatch = line.match(/"([^"]*)"/);
    return {
      index,
      indent: (line.match(/^\s*/) || [''])[0].length,
      role: String(roleMatch?.[1] || '').toLowerCase(),
      name: String(nameMatch?.[1] || '').replace(/\s+/g, ' ').trim(),
      line,
    };
  });
  const itemRoles = new Set(['option', 'menuitem', 'listitem', 'treeitem']);
  const noResultsText = (value) => /^no results found[.!]?$/i.test(String(value || '').trim());
  const groups = [];
  let current = null;
  for (const row of rows) {
    const isNoResults = noResultsText(row.name);
    if (!itemRoles.has(row.role) && !isNoResults) {
      if (current && row.indent <= current.baseIndent) current = null;
      continue;
    }
    if (!current) {
      const contextRows = rows.slice(Math.max(0, row.index - 8), row.index);
      current = {
        firstIndex: row.index,
        baseIndent: row.indent,
        items: [],
        requiresPositiveScope: false,
        context: contextRows.map((entry) => `${entry.role} ${entry.name}`).join(' '),
      };
      groups.push(current);
    }
    if (isNoResults) current.requiresPositiveScope = true;
    if (row.name) current.items.push(row.name);
  }
  const useful = groups.filter((group) => group.items.length > 0);
  if (!useful.length) return { found: false, uncheckable: true, items: [], count: 0, reason: 'collection_items_not_observed' };
  const normalizedTarget = normalizeTargetName(targetName);
  const stop = new Set([
    'the', 'a', 'an', 'option', 'options', 'item', 'items', 'list', 'visible',
    'choice', 'choices', 'collection', 'collections', 'group', 'groups',
  ]);
  const wanted = normalizedTarget.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((value) => value.length > 1 && !stop.has(value));
  const ranked = useful.map((group) => {
    const context = new Set(group.context.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean));
    const score = wanted.filter((value) => context.has(value)).length;
    return { ...group, score };
  }).sort((left, right) => right.score - left.score || left.firstIndex - right.firstIndex);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score && ranked[0].score === 0) {
    return { found: false, uncheckable: true, items: [], count: 0, reason: 'collection_target_ambiguous' };
  }
  if ((normalizedTarget || ranked[0].requiresPositiveScope) && ranked[0].score === 0) {
    return { found: false, uncheckable: true, items: [], count: 0, reason: 'collection_target_not_observed' };
  }
  return {
    found: true,
    items: ranked[0].items,
    count: ranked[0].items.length,
    reason: ranked[0].score > 0 ? 'collection_scoped_to_target' : 'single_collection_observed',
  };
}

function probeFunction(assertion = {}) {
  const type = assertionType(assertion);
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : assertion;
  if (['TABLE', 'TABLE_ROW', 'TABLE_CELL', 'TABLE_COLUMN', 'TABLE_QUERY'].includes(type)) return TABLE_STATE_FUNCTION;
  if (['COLLECTION', 'COLLECTION_MEMBERSHIP'].includes(type)) return COLLECTION_STATE_FUNCTION;
  const attribute = type === 'ATTRIBUTE' ? payload.attributeName || payload.name : null;
  return controlStateProbe.elementStateFunction({ attributeNames: attribute ? [attribute] : [] });
}

function actualFromEvidence(assertion = {}, evidence = {}, page = {}) {
  const type = assertionType(assertion);
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : assertion;
  if (type === 'URL') return page.url || evidence.url || null;
  if (['TEXT', 'FORBIDDEN_TEXT', 'REGEX'].includes(type)) {
    const elementText = String(evidence.text == null ? '' : evidence.text).trim();
    if (elementText) return elementText;
    const controlValue = evidence.actualValue ?? evidence.valueAfter ?? evidence.inputValue ?? evidence.selectedText;
    if (controlValue != null && String(controlValue).trim()) return controlValue;
    return page.text ?? null;
  }
  if (['VISIBLE', 'HIDDEN'].includes(type)) return { visible: evidence.visible };
  if (type === 'ATTRIBUTE') {
    const name = payload.attributeName || payload.name;
    return { attribute: name, value: evidence.attributes?.[name], attributes: evidence.attributes || {} };
  }
  if (type === 'SELECTED') return { selected: evidence.selected ?? evidence.ariaSelected };
  if (type === 'CHECKED') return { checked: evidence.checked ?? evidence.ariaChecked };
  if (['TABLE', 'TABLE_ROW', 'TABLE_CELL', 'TABLE_COLUMN', 'TABLE_QUERY'].includes(type)) return evidence;
  if (['COLLECTION', 'COLLECTION_MEMBERSHIP'].includes(type)) return evidence.items || evidence;
  if (type === 'COUNT') return evidence.count ?? evidence.rowCount ?? evidence.items?.length ?? null;
  return evidence.actualValue ?? evidence.valueAfter ?? evidence.inputValue ?? evidence.selectedText ?? evidence.text ?? null;
}

module.exports = {
  TABLE_STATE_FUNCTION,
  COLLECTION_STATE_FUNCTION,
  normalizeTargetName,
  targetDescriptor,
  assertionType,
  snapshotCollectionState,
  probeFunction,
  actualFromEvidence,
};
