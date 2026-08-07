'use strict';

function clean(value, max = 2000) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function elementStateFunction({ attributeNames = [] } = {}) {
  const names = [...new Set((Array.isArray(attributeNames) ? attributeNames : [])
    .map((name) => clean(name, 120)).filter(Boolean))];
  return `(element) => {
    if (!element || element.nodeType !== 1) return { found: false };
    const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
    const attr = (name) => element.getAttribute ? element.getAttribute(name) : null;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const width = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    const area = Math.max(1, rect.width * rect.height);
    const visible = style.display !== 'none' && style.visibility !== 'hidden'
      && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    const inViewport = width > 0 && height > 0;
    const options = element.tagName === 'SELECT'
      ? Array.from(element.selectedOptions || []).map((option) => ({ value: String(option.value), text: clean(option.textContent) }))
      : [];
    const exactNodeText = (node) => node
      ? clean((node.getAttribute && node.getAttribute('aria-label')) || node.innerText || node.textContent)
      : '';
    const ariaValueText = clean(attr('aria-valuetext'));
    const activeDescendantId = clean(attr('aria-activedescendant'));
    const activeDescendantText = exactNodeText(activeDescendantId ? document.getElementById(activeDescendantId) : null);
    const ariaSelectedNodes = Array.from(element.querySelectorAll('[aria-selected="true"]'));
    const uniqueAriaSelectedText = ariaSelectedNodes.length === 1 ? exactNodeText(ariaSelectedNodes[0]) : '';
    const semanticRole = clean(attr('role')).toLowerCase();
    const semanticControlText = semanticRole === 'combobox'
      ? clean(element.innerText || element.textContent)
      : '';
    const semanticSelectedFallback = ariaValueText || activeDescendantText || uniqueAriaSelectedText
      ? ''
      : semanticControlText;
    const customSelectedTexts = Array.from(new Set([
      ariaValueText,
      activeDescendantText,
      uniqueAriaSelectedText,
      semanticSelectedFallback,
    ].filter(Boolean)));
    const customSelectedText = customSelectedTexts[0] || null;
    const describedIds = clean(attr('aria-describedby')).split(/\\s+/).filter(Boolean);
    const described = describedIds.map((id) => document.getElementById(id)).filter(Boolean);
    const tooltipNodes = [...described, ...Array.from(document.querySelectorAll('[role="tooltip"]'))];
    const tooltipTexts = Array.from(new Set(tooltipNodes.filter((node) => {
      const s = window.getComputedStyle(node); const r = node.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && r.width > 0 && r.height > 0;
    }).map((node) => clean(node.innerText || node.textContent)).filter(Boolean)));
    const semanticExpanded = (() => {
      const explicit = attr('aria-expanded');
      if (explicit != null) return explicit === 'true';
      if (element.tagName === 'DETAILS' || element.hasAttribute('open')) return !!element.open || element.hasAttribute('open');
      const controlsId = clean(attr('aria-controls'));
      const controlled = controlsId ? document.getElementById(controlsId) : null;
      if (controlled) {
        const hidden = controlled.getAttribute('aria-hidden');
        if (hidden != null) return hidden !== 'true';
        const controlledStyle = window.getComputedStyle(controlled);
        const controlledRect = controlled.getBoundingClientRect();
        return controlledStyle.display !== 'none' && controlledStyle.visibility !== 'hidden'
          && controlledRect.width > 0 && controlledRect.height > 0;
      }
      let owner = element;
      for (let depth = 0; owner && depth < 5; depth += 1, owner = owner.parentElement) {
        const classTokens = Array.from(owner.classList || []);
        if (classTokens.some((token) => /(?:^|[-_])expanded(?:$|[-_])/i.test(token))) return true;
        if (classTokens.some((token) => /(?:^|[-_])collapsed(?:$|[-_])/i.test(token))) return false;
      }
      return null;
    })();
    const requested = ${JSON.stringify(names)};
    const attributes = Object.fromEntries(requested.map((name) => [name, attr(name)]));
    if (requested.includes('expanded') && attributes.expanded == null && semanticExpanded != null) {
      attributes.expanded = semanticExpanded;
    }
    const value = element.isContentEditable ? clean(element.textContent) : ('value' in element ? String(element.value == null ? '' : element.value) : null);
    return {
      found: true, visible, inViewport, enabled: !element.disabled && attr('aria-disabled') !== 'true',
      value, valueAfter: value, actualValue: value, inputValue: value,
      selectedValue: options[0] ? options[0].value : (customSelectedText || value),
      selectedText: options[0] ? options[0].text : customSelectedText,
      selectedValues: options.length ? options.map((option) => option.value) : customSelectedTexts,
      selectedTexts: options.length ? options.map((option) => option.text) : customSelectedTexts,
      checked: typeof element.checked === 'boolean' ? element.checked : null,
      selected: typeof element.selected === 'boolean' ? element.selected : null,
      ariaChecked: attr('aria-checked'), ariaSelected: attr('aria-selected'),
      ariaExpanded: attr('aria-expanded'), expanded: semanticExpanded, attributes,
      text: clean(element.innerText || element.textContent),
      focused: document.activeElement === element,
      targetHovered: element.matches ? element.matches(':hover') : false,
      intersectionRatio: (width * height) / area,
      tooltipVisible: tooltipTexts.length > 0,
      tooltipText: tooltipTexts.length === 1 ? tooltipTexts[0] : null,
      tooltipTexts,
      url: String(location.href), title: document.title,
      scrollX: window.scrollX, scrollY: window.scrollY,
    };
  }`;
}

const PAGE_STATE_FUNCTION = `() => ({
  found: true,
  url: String(location.href),
  title: document.title,
  scrollX: window.scrollX,
  scrollY: window.scrollY,
  maxScrollX: Math.max(0, document.documentElement.scrollWidth - (window.innerWidth || document.documentElement.clientWidth)),
  maxScrollY: Math.max(0, document.documentElement.scrollHeight - (window.innerHeight || document.documentElement.clientHeight)),
  focusedTarget: (() => {
    const node = document.activeElement;
    if (!node || node === document.body) return null;
    return String(node.getAttribute('aria-label') || node.getAttribute('name') || node.id || node.tagName || '');
  })(),
})`;

function dropdownStateFunction({ ownerRef = null } = {}) {
  return `(element) => {
    if (!element || element.nodeType !== 1) return { available: false };
    const suppliedOwnerRef = ${JSON.stringify(clean(ownerRef, 200) || null)};
    const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    const attr = (node, name) => node && node.getAttribute ? node.getAttribute(name) : null;
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const reference = (node, fallback = null) => clean(
      (node && (node.id || attr(node, 'data-testid') || attr(node, 'data-qaai-id')))
      || fallback || '',
    ) || null;
    const role = (node) => clean(attr(node, 'role') || '').toLowerCase()
      || (node && node.tagName === 'SELECT' ? 'combobox' : null);
    const label = (node) => clean(
      attr(node, 'aria-label')
      || (node.labels && node.labels[0] && node.labels[0].innerText)
      || attr(node, 'placeholder')
      || attr(node, 'title')
      || '',
    ) || null;
    const describe = (node, fallbackRef = null) => {
      if (!node || node.nodeType !== 1) return null;
      const value = 'value' in node ? String(node.value == null ? '' : node.value) : null;
      const selectedOption = node.tagName === 'SELECT' ? node.selectedOptions && node.selectedOptions[0] : null;
      return {
        ref: reference(node, fallbackRef),
        role: role(node),
        tag: String(node.tagName || '').toLowerCase(),
        label: label(node),
        text: clean(node.innerText || node.textContent || ''),
        value,
        selectedValue: selectedOption ? String(selectedOption.value) : value,
        displayedValue: selectedOption ? clean(selectedOption.textContent) : clean(value),
        visible: visible(node),
        enabled: !node.disabled && attr(node, 'aria-disabled') !== 'true',
        expanded: attr(node, 'aria-expanded') === 'true' ? true
          : attr(node, 'aria-expanded') === 'false' ? false : null,
        selected: attr(node, 'aria-selected') === 'true' ? true
          : attr(node, 'aria-selected') === 'false' ? false : null,
        attributes: {
          'aria-controls': attr(node, 'aria-controls'),
          'aria-owns': attr(node, 'aria-owns'),
          'aria-expanded': attr(node, 'aria-expanded'),
          'aria-selected': attr(node, 'aria-selected'),
        },
      };
    };
    const triggerNode = element.closest('[role="combobox"], [aria-haspopup], button') || element;
    const owner = describe(element, suppliedOwnerRef);
    const trigger = describe(triggerNode, suppliedOwnerRef);
    const relationIds = Array.from(new Set([
      attr(element, 'aria-controls'), attr(element, 'aria-owns'),
      attr(triggerNode, 'aria-controls'), attr(triggerNode, 'aria-owns'),
    ].filter(Boolean).flatMap((value) => clean(value).split(/\s+/)).filter(Boolean)));
    const popupNodes = [];
    const seen = new Set();
    const addPopup = (node) => {
      if (!node || seen.has(node) || !visible(node)) return;
      seen.add(node);
      popupNodes.push(node);
    };
    relationIds.forEach((id) => addPopup(document.getElementById(id)));
    document.querySelectorAll('[role="listbox"], [role="menu"], [role="tree"], [role="grid"], [role="dialog"]')
      .forEach(addPopup);
    const optionSelector = '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="treeitem"]';
    const describeOption = (node, index) => ({
      ...describe(node),
      text: clean(attr(node, 'aria-label') || node.innerText || node.textContent || ''),
      value: 'value' in node ? String(node.value == null ? '' : node.value) : clean(node.innerText || node.textContent || ''),
      index,
    });
    const popups = popupNodes.map((popup) => {
      const popupId = reference(popup);
      const controlled = popupId && relationIds.includes(popupId);
      const labelledBy = clean(attr(popup, 'aria-labelledby')).split(/\s+/).filter(Boolean);
      const ownerIds = [reference(element), reference(triggerNode)].filter(Boolean);
      const related = controlled || labelledBy.some((id) => ownerIds.includes(id));
      const descriptor = describe(popup);
      return {
        ...descriptor,
        ownerRef: related ? suppliedOwnerRef || reference(element) || reference(triggerNode) : null,
        options: Array.from(popup.querySelectorAll(optionSelector)).filter(visible).map(describeOption),
      };
    });
    const nativeOptions = element.tagName === 'SELECT'
      ? Array.from(element.options || []).map((option, index) => ({
          ...describeOption(option, index), visible: true, selected: option.selected === true,
        }))
      : [];
    return {
      available: true,
      owner,
      trigger,
      valueNode: owner,
      popups,
      visibleOptions: nativeOptions.length
        ? nativeOptions
        : popups.flatMap((popup) => popup.options || []),
      nativeSelectReady: element.tagName === 'SELECT' && owner.visible && owner.enabled,
    };
  }`;
}

function parseProbeResult(raw, parseEvaluateReturnValue = null) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  let value = raw;
  if (typeof parseEvaluateReturnValue === 'function') {
    try { value = parseEvaluateReturnValue(String(raw || '')); } catch (_) {}
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
    const match = value.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
  }
  return null;
}

function buildControlObservation({ kind, before = null, after = null, dispatchResult = null } = {}) {
  const prior = before && typeof before === 'object' ? before : {};
  const current = after && typeof after === 'object' ? after : {};
  const dispatched = dispatchResult && typeof dispatchResult === 'object' ? dispatchResult : {};
  const merged = { ...dispatched, ...current };
  if (kind === 'scroll') {
    const axis = merged.axis === 'x' ? 'x' : 'y';
    return {
      ...merged,
      before: axis === 'x' ? prior.scrollX : prior.scrollY,
      after: axis === 'x' ? merged.scrollX : merged.scrollY,
      max: axis === 'x' ? merged.maxScrollX : merged.maxScrollY,
    };
  }
  if (kind === 'hover' && !merged.tooltipText && Array.isArray(merged.tooltipTexts) && merged.tooltipTexts.length === 1) {
    merged.tooltipText = merged.tooltipTexts[0];
  }
  if (kind === 'date') merged.selectedDate = merged.selectedDate || merged.inputValue || merged.actualValue;
  return merged;
}

module.exports = {
  PAGE_STATE_FUNCTION,
  elementStateFunction,
  dropdownStateFunction,
  parseProbeResult,
  buildControlObservation,
};
