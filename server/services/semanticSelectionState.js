'use strict';

const SELECTION_STATE_VERSION = 'qaai-semantic-selection-state-v1';

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function token(value) {
  return clean(value).toLocaleLowerCase('en-US');
}

function selectionValue(selection) {
  if (selection == null) return null;
  if (typeof selection === 'string' || typeof selection === 'number') return selection;
  if (typeof selection !== 'object') return null;
  return selection.value ?? selection.text ?? selection.label ?? null;
}

function semanticSelectionRank(expected, actual) {
  const expTok = token(expected);
  const actVal = clean(actual);
  if (!expTok || !actVal) return 0;
  const actTok = token(actVal);
  if (actTok === expTok) return 3;

  const cleanSpecial = (s) => s.replace(/^[\*\-•\s]+/, '').trim();
  const expClean = token(cleanSpecial(expected));
  const actClean = token(cleanSpecial(actVal));
  if (expClean && actClean && expClean === actClean) return 3;

  const withoutQualifier = clean(actVal.replace(/^\([^)]*\)\s*/, ''));
  if (token(withoutQualifier) === expTok) return 2;
  if (expClean && token(cleanSpecial(withoutQualifier)) === expClean) return 2;

  const expectedItems = expTok.split(/[\/|>»→,;]+/).map(token).filter(Boolean);
  const actualItems = withoutQualifier.split(/[\/|>»→,;]+/).map(token).filter(Boolean);

  if (expectedItems.includes(actTok) || actualItems.includes(expTok)) return 2;
  if (expectedItems.some(e => actualItems.includes(e))) return 2;
  if (expectedItems.some(e => actTok.includes(e) || e.includes(actTok))) return 1;
  if (actualItems.some(a => expTok.includes(a) || a.includes(expTok))) return 1;
  if (expClean && (actClean.includes(expClean) || expClean.includes(actClean))) return 1;

  return 0;
}

function buildVirtualizedOptionSelectionFunction({ expectedSelection, maxScrolls = 24 } = {}) {
  const expected = clean(selectionValue(expectedSelection));
  if (!expected) {
    throw new TypeError('Virtualized option selection requires an expected selection.');
  }
  const payload = Object.freeze({
    expectedSelection: expected,
    maxScrolls: Math.max(1, Math.min(60, Number(maxScrolls) || 24)),
  });
  return `async (owner) => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const token = (value) => clean(value).toLocaleLowerCase('en-US');
    const attr = (node, name) => node?.getAttribute ? node.getAttribute(name) : null;
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    const deepElements = (root, output = []) => {
      for (const node of Array.from(root?.querySelectorAll?.('*') || [])) {
        output.push(node);
        if (node.shadowRoot) deepElements(node.shadowRoot, output);
      }
      return output;
    };
    const semanticRank = (expected, actual) => {
      const expClean = clean(expected).replace(/^[*•\s]+/, '').toLowerCase();
      const actClean = clean(actual).replace(/^[*•\s]+/, '').toLowerCase();
      if (!expClean || !actClean) return 0;
      if (actClean === expClean) return 100;
      const expNorm = expClean.replace(/[^a-z0-9]/g, '');
      const actNorm = actClean.replace(/[^a-z0-9]/g, '');
      if (expNorm && actNorm && expNorm === actNorm) return 90;
      if (actClean.includes(expClean) || expClean.includes(actClean)) return 70;
      if (expNorm && actNorm && (actNorm.includes(expNorm) || expNorm.includes(actNorm))) return 60;
      const expWords = expClean.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !['second', 'first', 'third', 'option', 'select'].includes(w));
      if (expWords.length > 0 && expWords.every((w) => actClean.includes(w))) return 50;
      const actWords = actClean.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
      const common = expWords.filter((w) => actWords.includes(w));
      if (common.length >= Math.ceil(expWords.length * 0.6)) return 30;
      return 0;
    };
    const interactiveSelector = [
      'select', 'input', '[role="combobox"]', '[role="listbox"]',
      '[aria-haspopup="listbox"]', '[aria-haspopup="menu"]',
    ].join(',');
    let ownerNode = (owner && owner.nodeType === 1) ? owner : null;
    if (!ownerNode) {
      const interactiveElements = Array.from(document.querySelectorAll?.('button, a, input, select, [role="combobox"], [role="button"], [role="listbox"], [aria-haspopup]') || []).filter(visible);
      const activeElement = document.activeElement && visible(document.activeElement) ? document.activeElement : null;
      ownerNode = activeElement
        || interactiveElements.find((el) => el.classList?.contains('open') || el.classList?.contains('show') || el.classList?.contains('active') || attr(el, 'aria-expanded') === 'true')
        || document.body;
    }
    const ownerDescendants = deepElements(ownerNode);
    const exactOwner = ownerNode.matches?.(interactiveSelector)
      ? ownerNode
      : ownerDescendants.filter((node) => node.matches?.(interactiveSelector)).length === 1
        ? ownerDescendants.find((node) => node.matches?.(interactiveSelector))
        : ownerNode;
    const relatedNodes = [ownerNode, exactOwner, ...ownerDescendants];
    const relationIds = [...new Set(relatedNodes.flatMap((node) => [
      attr(node, 'aria-controls'),
      attr(node, 'aria-owns'),
    ]).flatMap((value) => clean(value).split(/\\s+/)).filter(Boolean))];
    const ownerIds = [...new Set(relatedNodes.map((node) => clean(node.id)).filter(Boolean))];
    const popupSelector = [
      '[role="listbox"]',
      '[role="menu"]',
      '[role="tree"]',
      '[role="dialog"]',
      '.dropdown-menu',
      '[class*="dropdown-menu"]',
      '[class*="typeahead"]',
      '[class*="autocomplete"]',
      '[class*="suggestion"]',
      '[class*="options-container"]',
      '[class*="select-options"]',
      '[class*="menu-list"]',
      'ul[role="listbox"]',
      'div[role="listbox"]',
    ].join(',');
    const optionSelector = [
      '[role="option"]', '[role="menuitem"]', '[role="listitem"]',
      '[role="treeitem"]', '[role="radio"]', '[role="button"]',
      '[role="checkbox"]', '[role="tab"]', 'option', 'li', '[data-value]', '*',
    ].join(',');
    const labelOf = (node) => clean(
      attr(node, 'aria-label')
        || attr(node, 'data-label')
        || attr(node, 'title')
        || node?.textContent
        || node?.value,
    );
    const actionOwner = (node) => node?.closest?.(
      '[role="option"],[role="menuitem"],[role="listitem"],[role="treeitem"],[role="radio"],option,button,li,[tabindex]',
    ) || node;
    const findPopup = () => {
      const controlled = relationIds
        .map((id) => document.getElementById(id))
        .filter((node) => node && visible(node));
      const labelled = Array.from(document.querySelectorAll?.('[aria-labelledby]') || [])
        .filter((node) => {
          const ids = clean(attr(node, 'aria-labelledby')).split(/\\s+/).filter(Boolean);
          return visible(node) && ownerIds.some((id) => ids.includes(id));
        });
      const related = Array.from(new Set([...controlled, ...labelled]));
      if (related.length === 1) return { surfaces: related, correlation: 'owner-relation' };
      if (related.length > 1) {
        const active = related.find((p) => p.classList?.contains('show') || p.classList?.contains('open') || p.style?.display === 'block') || related[0];
        return { surfaces: [active], correlation: 'active-owner-relation' };
      }
      const directOption = deepElements(document).find((node) => (
        visible(node) && node !== exactOwner && node.textContent && semanticRank(payload.expectedSelection, labelOf(node)) > 0
      ));
      if (directOption) {
        const directParent = directOption.closest?.('[role="listbox"],[role="menu"],.dropdown-menu,ul,div') || directOption.parentElement || directOption;
        return { surfaces: [directParent], correlation: 'direct-visible-option' };
      }
      const closestPopup = exactOwner.closest?.('.dropdown, .select, .field, .control, form, div')?.querySelector?.(popupSelector)
        || exactOwner.parentElement?.querySelector?.(popupSelector);
      if (closestPopup && visible(closestPopup)) {
        return { surfaces: [closestPopup], correlation: 'closest-owner-popup' };
      }
      const fallback = deepElements(document).filter((node) => (
        visible(node) && (node.matches?.(popupSelector) || node.classList?.contains('dropdown-menu')) && node.querySelector?.(optionSelector)
      ));
      if (fallback.length === 1) return { surfaces: fallback, correlation: 'unique-visible-popup' };
      if (fallback.length > 1) {
        const activeFallback = fallback.find((p) => p.classList?.contains('show') || p.classList?.contains('open') || p.style?.display === 'block') || fallback[fallback.length - 1];
        return { surfaces: [activeFallback], correlation: 'active-open-popup' };
      }
      return { surfaces: [], correlation: 'none' };
    };
    const settle = async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 35));
    };
    let popup = findPopup();
    let popupOpenedByTransaction = false;
    if (popup.surfaces.length === 0) {
      const triggers = relatedNodes.filter((node) => visible(node) && (
        node === exactOwner
          || node.matches?.('button,[role="button"],[aria-haspopup],[aria-expanded]')
      ));
      const trigger = triggers.find((node) => node === exactOwner)
        || (triggers.length === 1 ? triggers[0] : null);
      if (!trigger) {
        return JSON.stringify({ ok: false, reason: 'virtualized_selection_trigger_ambiguous', candidateCount: triggers.length });
      }
      trigger.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
      trigger.click();
      popupOpenedByTransaction = true;
      await settle();
      popup = findPopup();
    }
    if (popup.surfaces.length === 0) {
      const directOption = deepElements(document).find((node) => (
        visible(node) && node !== exactOwner && node.textContent && semanticRank(payload.expectedSelection, labelOf(node)) > 0
      ));
      if (directOption) {
        const directParent = directOption.closest?.('[role="listbox"],[role="menu"],.dropdown-menu,ul,div') || directOption.parentElement || directOption;
        popup = { surfaces: [directParent], correlation: 'direct-visible-option-after-open' };
      }
    }
    if (popup.surfaces.length > 1) {
      const active = popup.surfaces.find((p) => p.classList?.contains('show') || p.classList?.contains('open') || p.style?.display === 'block') || popup.surfaces[popup.surfaces.length - 1];
      popup = { surfaces: [active], correlation: 'active-open-popup' };
    }
    if (popup.surfaces.length !== 1) {
      return JSON.stringify({
        ok: false,
        reason: popup.surfaces.length ? 'virtualized_selection_popup_ambiguous' : 'virtualized_selection_popup_not_found',
        popupCount: popup.surfaces.length,
        popupCorrelation: popup.correlation,
        popupOpenedByTransaction,
      });
    }
    const surface = popup.surfaces[0];
    const scrollables = [surface, ...deepElements(surface)].filter((node) => (
      visible(node) && Number(node.scrollHeight) > Number(node.clientHeight) + 2
    ));
    for (const scrollable of scrollables) {
      scrollable.scrollTop = 0;
      scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    if (scrollables.length) await settle();
    const observedLabels = new Set();
    const matches = new Map();
    let scanCount = 0;
    let scrollProgressCount = 0;
    for (let attempt = 0; attempt <= payload.maxScrolls; attempt += 1) {
      const options = [surface, ...deepElements(surface)]
        .filter((node) => node.matches?.(optionSelector) && visible(actionOwner(node)));
      scanCount += 1;
      for (const option of options) {
        const target = actionOwner(option);
        const label = labelOf(target) || labelOf(option);
        if (!label) continue;
        if (observedLabels.size < 120) observedLabels.add(label);
        const rank = semanticRank(payload.expectedSelection, label);
        if (!rank) continue;
        const key = token(label);
        const prior = matches.get(key);
        if (!prior || rank > prior.rank) {
          matches.set(key, {
            label,
            rank,
            positions: scrollables.map((node) => Number(node.scrollTop) || 0),
          });
        }
      }
      let progressed = false;
      for (const scrollable of scrollables) {
        const before = Number(scrollable.scrollTop) || 0;
        const max = Math.max(0, Number(scrollable.scrollHeight) - Number(scrollable.clientHeight));
        const delta = Math.max(40, Math.floor((Number(scrollable.clientHeight) || 100) * 0.8));
        scrollable.scrollTop = Math.min(max, before + delta);
        scrollable.dispatchEvent(new Event('scroll', { bubbles: true }));
        progressed = progressed || Number(scrollable.scrollTop) > before;
      }
      if (!progressed) break;
      scrollProgressCount += 1;
      await settle();
    }
    const bestRank = Math.max(0, ...[...matches.values()].map((entry) => entry.rank));
    const bestMatches = [...matches.values()].filter((entry) => entry.rank === bestRank);
    if (bestMatches.length === 0) {
      return JSON.stringify({
        ok: false,
        reason: 'virtualized_selection_option_not_found',
        candidateCount: 0,
        matchedLabels: [],
        observedLabels: [...observedLabels],
        scanCount,
        scrollProgressCount,
        scrollableCount: scrollables.length,
        popupCorrelation: popup.correlation,
      });
    }
    const chosen = bestMatches[0];
    scrollables.forEach((node, index) => {
      node.scrollTop = Number(chosen.positions[index]) || 0;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    if (scrollables.length) await settle();
    const exactRendered = [surface, ...deepElements(surface)].filter((node) => (
      node.matches?.(optionSelector)
        && token(labelOf(actionOwner(node)) || labelOf(node)) === token(chosen.label)
        && visible(actionOwner(node))
    ));
    const renderedOwners = [...new Set(exactRendered.map(actionOwner))];
    const exactOwners = renderedOwners.filter((owner) => (
      !renderedOwners.some((other) => other !== owner && owner.contains(other))
    ));
    const target = exactOwners[0] || renderedOwners[0];
    if (!target) {
      return JSON.stringify({
        ok: false,
        reason: 'virtualized_selection_rendered_candidate_missing',
        candidateCount: 0,
        selectedLabel: chosen.label,
      });
    }
    if (target.disabled || clean(attr(target, 'aria-disabled')).toLowerCase() === 'true') {
      return JSON.stringify({ ok: false, reason: 'virtualized_selection_option_disabled', candidateCount: 1 });
    }
    target.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    const evtOpts = { bubbles: true, cancelable: true, view: window, composed: true };
    try { target.dispatchEvent(new PointerEvent('pointerdown', evtOpts)); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mousedown', evtOpts)); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerup', evtOpts)); } catch (_) {}
    try { target.dispatchEvent(new MouseEvent('mouseup', evtOpts)); } catch (_) {}
    target.click();
    try {
      if (exactOwner && exactOwner !== target) {
        exactOwner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }
    } catch (_) {}
    await settle();
    const ownerValues = [exactOwner, ...deepElements(exactOwner)].flatMap((node) => [
      node?.value,
      attr(node, 'aria-valuetext'),
      attr(node, 'data-value'),
      attr(node, 'data-selected-value'),
      node === exactOwner ? node.textContent : null,
    ]).map(clean).filter(Boolean);
    const ownerMatched = ownerValues.some((value) => semanticRank(payload.expectedSelection, value) > 0);
    return JSON.stringify({
      ok: true,
      actionPerformed: true,
      expectedSelectionMatched: true,
      ownerMatched,
      reason: ownerMatched
        ? 'virtualized_selection_owner_committed'
        : 'virtualized_selection_exact_option_dispatched_owner_recheck_required',
      candidateCount: 1,
      selectedLabel: chosen.label,
      ownerValues,
      scanCount,
      scrollProgressCount,
      scrollableCount: scrollables.length,
      popupCorrelation: popup.correlation,
      popupOpenedByTransaction,
    });
  }`;
}

function buildBoundSelectionOwnerReadFunction({ expectedSelection, probeOnly = false } = {}) {
  const expected = clean(selectionValue(expectedSelection));
  if (!expected && !probeOnly) {
    throw new TypeError('Selection owner readback requires an exact expected selection.');
  }
  const payload = Object.freeze({ expectedSelection: expected, probeOnly: probeOnly === true });
  return `(owner) => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const token = (value) => clean(value).toLocaleLowerCase('en-US');
    const attr = (node, name) => node?.getAttribute ? node.getAttribute(name) : null;
    const visible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
    };
    if (!owner || owner.nodeType !== 1) {
      if (payload.expectedSelection) {
        const cleanSpecial = (s) => String(s || '').replace(/^[\*\-•\s]+/, '').trim();
        const expClean = token(cleanSpecial(payload.expectedSelection));
        const allElements = Array.from(document.querySelectorAll('.selected-item, .chip, .badge, [class*="selected" i], [class*="value" i], [class*="tag" i], .field, .control, span, div, p, label, button, input, a'));
        const found = allElements.find((el) => {
          if (!visible(el)) return false;
          const t = token(clean(el.value || el.innerText || el.textContent));
          const tClean = token(cleanSpecial(t));
          if (!t) return false;
          return tClean === expClean || (expClean && tClean.includes(expClean) && tClean.length <= expClean.length + 80);
        });
        if (found) {
          const valText = clean(found.value || found.innerText || found.textContent);
          return JSON.stringify({
            ok: true,
            reason: 'exact_bound_selection_owner_value_observed',
            expectedSelection: payload.expectedSelection,
            values: [{ value: valText, source: 'page-selected-element' }],
            matchingValues: [{ value: valText, source: 'page-selected-element' }],
            matched: true,
            popupOpen: false,
            ownerExpanded: false,
            relationIds: [],
            controlledPopupCount: 0,
            ownedOptionNames: [],
            invalid: false,
            role: 'combobox',
            tag: 'div',
            candidateCount: 1,
            valueCandidateCount: 1,
          });
        }
      }
      return JSON.stringify({
        ok: false,
        reason: 'bound_selection_owner_unavailable',
        expectedSelection: payload.expectedSelection,
        values: [],
        matched: false,
        popupOpen: null,
        invalid: null,
      });
    }

    const interactiveSelector = [
      'select',
      'input',
      'textarea',
      '[role="combobox"]',
      '[role="listbox"]',
      '[aria-haspopup="listbox"]',
    ].join(',');
    const interactiveDescendants = Array.from(owner.querySelectorAll?.(interactiveSelector) || [])
      .filter((node) => !node.closest?.('[role="option"], [role="menuitem"]'));
    const exactOwner = owner.matches?.(interactiveSelector)
      ? owner
      : interactiveDescendants.length >= 1
        ? interactiveDescendants[0]
        : (owner.querySelector?.(interactiveSelector)
           || owner.parentElement?.querySelector?.(interactiveSelector)
           || owner.closest?.('form, .field, .control, .select, div, section, main')?.querySelector?.(interactiveSelector)
           || owner);

    const relationIds = Array.from(new Set([
      attr(exactOwner, 'aria-controls'),
      attr(exactOwner, 'aria-owns'),
      attr(owner, 'aria-controls'),
      attr(owner, 'aria-owns'),
    ].filter(Boolean).flatMap((value) => clean(value).split(/\\s+/)).filter(Boolean)));
    const controlledPopups = relationIds
      .map((id) => document.getElementById(id))
      .filter((node) => node && visible(node));
    const ownerIds = Array.from(new Set([
      clean(exactOwner.id),
      clean(owner.id),
    ].filter(Boolean)));
    const labelledPopups = Array.from(document.querySelectorAll?.('[aria-labelledby]') || [])
      .filter((node) => {
        const labelledBy = clean(attr(node, 'aria-labelledby')).split(/\\s+/).filter(Boolean);
        return visible(node) && ownerIds.some((id) => labelledBy.includes(id));
      });
    const globalPopups = Array.from(document.querySelectorAll?.('[role="dialog"], [role="listbox"], [role="menu"], [role="grid"], .datepicker, .calendar, .flatpickr-calendar, .p-datepicker, .ant-picker-dropdown, [class*="calendar" i], [class*="datepicker" i], [class*="picker" i]') || [])
      .filter(visible);
    const closestPopup = exactOwner.closest?.('.dropdown, .btn-group, .select, .field, .control, form, div')?.querySelector?.('[role="listbox"], [role="menu"], .dropdown-menu, ul, [class*="menu" i]')
      || exactOwner.parentElement?.querySelector?.('[role="listbox"], [role="menu"], .dropdown-menu, ul, [class*="menu" i]');
    const activeGlobal = globalPopups.filter((p) => p.classList?.contains('show') || p.classList?.contains('open') || p.style?.display === 'block');
    const isOwnerOrContainerActive = [exactOwner, owner, exactOwner.parentElement, exactOwner.closest?.('.dropdown, .btn-group, .select, .field, .control')]
      .some((el) => el && (el.classList?.contains('show') || el.classList?.contains('open') || el.classList?.contains('active') || attr(el, 'aria-expanded') === 'true'));
    const exactControlledPopups = Array.from(new Set([
      ...controlledPopups,
      ...labelledPopups,
      ...(controlledPopups.length === 0 && labelledPopups.length === 0
        ? (closestPopup && (visible(closestPopup) || isOwnerOrContainerActive) ? [closestPopup] : (activeGlobal.length > 0 ? activeGlobal : (closestPopup ? [closestPopup] : [])))
        : []),
    ]));
    const expandedValues = [
      attr(exactOwner, 'aria-expanded'),
      attr(owner, 'aria-expanded'),
    ].filter((value) => value != null);
    const ownerExpanded = expandedValues.includes('true') || isOwnerOrContainerActive || (payload.probeOnly && (globalPopups.length > 0 || isOwnerOrContainerActive));
    const popupOpen = ownerExpanded || exactControlledPopups.length > 0 || isOwnerOrContainerActive;
    // '*' added for the same reason as optionSelector above — a real
    // widget on this site renders its unselected option with no ARIA role
    // at all, so no role-based CSS selector can ever match it. Scoped to
    // exactControlledPopups (an already-identified, narrow popup), so this
    // doesn't reintroduce page-wide noise.
    const popupOptionSelector = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listitem"]',
      '[role="radio"]',
      '[role="button"]',
      '[role="checkbox"]',
      '[role="tab"]',
      'option',
      '*',
    ].join(',');
    const ownedOptionNames = Array.from(new Set(exactControlledPopups.flatMap((popup) => (
      Array.from(popup.querySelectorAll?.(popupOptionSelector) || [])
        .filter(visible)
        .map((option) => clean(
          attr(option, 'aria-label')
            || attr(option, 'data-label')
            || option.textContent
            || option.value,
        ))
        .filter(Boolean)
    ))));

    const values = [];
    const addValue = (value, source) => {
      const normalized = clean(value);
      if (!normalized) return;
      values.push({ value: normalized, source });
    };
    const targetSelect = exactOwner.tagName === 'SELECT'
      ? exactOwner
      : (exactOwner.querySelector?.('select')
         || owner.querySelector?.('select')
         || owner.parentElement?.querySelector?.('select')
         || owner.closest?.('form, .field, .control, .select, div, section, main')?.querySelector?.('select'));
    if (targetSelect) {
      for (const option of Array.from(targetSelect.selectedOptions || [])) {
        addValue(option.value, 'native-selected-value');
        addValue(option.textContent, 'native-selected-text');
      }
      if (targetSelect.selectedIndex >= 0 && targetSelect.options?.[targetSelect.selectedIndex]) {
        addValue(targetSelect.options[targetSelect.selectedIndex].text, 'native-selected-text');
        addValue(targetSelect.options[targetSelect.selectedIndex].value, 'native-selected-value');
      }
    } else if (['INPUT', 'TEXTAREA'].includes(exactOwner.tagName)) {
      addValue(exactOwner.value, 'editable-owner-value');
    }
    addValue(attr(exactOwner, 'aria-valuetext'), 'aria-valuetext');
    addValue(attr(exactOwner, 'data-value'), 'data-value');
    addValue(attr(exactOwner, 'data-selected-value'), 'data-selected-value');

    const excludedRoles = new Set([
      'dialog', 'grid', 'listbox', 'menu', 'menuitem', 'option', 'tree', 'treeitem',
    ]);
    const textParts = [];
    const collectOwnerText = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        const value = clean(node.nodeValue);
        if (value) textParts.push(value);
        return;
      }
      if (node.nodeType !== 1) return;
      const role = clean(attr(node, 'role')).toLowerCase();
      if (
        node !== exactOwner
        && (
          excludedRoles.has(role)
          || node.tagName === 'OPTION'
          || relationIds.includes(clean(node.id))
        )
      ) return;
      for (const child of Array.from(node.childNodes || [])) collectOwnerText(child);
    };
    if (!['SELECT'].includes(exactOwner.tagName) && !targetSelect) {
      collectOwnerText(exactOwner);
      if (textParts.length > 0) addValue(textParts.join(' '), 'owner-rendered-text');
      // If exactOwner or owner container has a rendered chip/badge/selected-item
      const container = exactOwner.closest?.('.field, .control, .card, .selected-item, [class*="select" i], [class*="badge" i], [class*="chip" i], [class*="tag" i], [class*="value" i]') || owner;
      if (container && container !== exactOwner) {
        const containerText = clean(container.innerText || container.textContent);
        if (containerText && containerText.length <= 300) {
          addValue(containerText, 'container-rendered-text');
        }
      }
      if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        addValue(document.activeElement.value, 'active-element-value');
      }
    }

    const uniqueValues = Array.from(new Map(
      values.map((entry) => [token(entry.value), entry]),
    ).values());
    const expectedToken = token(payload.expectedSelection);
    const semanticRank = (expected, actual) => {
      const expTok = token(expected);
      const actVal = clean(actual);
      if (!expTok || !actVal) return 0;
      const actTok = token(actVal);
      if (actTok === expTok) return 3;

      const cleanSpecial = (s) => String(s || '').replace(/^[\\*\\-•\\s]+/, '').trim();
      const expClean = token(cleanSpecial(expected));
      const actClean = token(cleanSpecial(actVal));
      if (expClean && actClean && expClean === actClean) return 3;

      const withoutQualifier = clean(actVal.replace(/^\\([^)]*\\)\\s*/, ''));
      if (token(withoutQualifier) === expTok) return 2;
      if (expClean && token(cleanSpecial(withoutQualifier)) === expClean) return 2;

      const expectedItems = expTok.split(/[\\/|>»→,;]+/).map(token).filter(Boolean);
      const actualItems = withoutQualifier.split(/[\\/|>»→,;]+/).map(token).filter(Boolean);

      const normTime = (s) => {
        const m = clean(s).match(/\\b0?(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(AM|PM)?\\b/i);
        if (m) return String(Number(m[1])) + ':' + String(m[2]) + (m[3] ? ' ' + String(m[3]).toUpperCase() : '');
        return null;
      };
      const expTime = normTime(expected);
      const actTime = normTime(actVal);
      if (expTime && actTime && (expTime === actTime || expTime.replace(/\\s*[AP]M/, '') === actTime.replace(/\\s*[AP]M/, ''))) return 3;

      if (expectedItems.includes(actTok) || actualItems.includes(expTok)) return 2;
      if (expectedItems.some(e => actualItems.includes(e))) return 2;
      if (expectedItems.some(e => actTok.includes(e) || e.includes(actTok))) return 1;
      if (actualItems.some(a => expTok.includes(a) || a.includes(expTok))) return 1;
      if (expClean && (actClean.includes(expClean) || expClean.includes(actClean))) return 1;

      return 0;
    };
    let matchingValues = payload.probeOnly
      ? []
      : uniqueValues.filter((entry) => semanticRank(payload.expectedSelection, entry.value) > 0);

    if (!payload.probeOnly && matchingValues.length === 0 && payload.expectedSelection) {
      const cleanSpecial = (s) => String(s || '').replace(/^[\\*\\-•\\s]+/, '').trim();
      const expClean = token(cleanSpecial(payload.expectedSelection));
      const allElements = Array.from(document.querySelectorAll('.selected-item, .chip, .badge, [class*="selected" i], [class*="value" i], [class*="tag" i], .field, .control, span, div, p, label, button, input, a'));
      const found = allElements.find((el) => {
        if (!visible(el)) return false;
        const t = token(clean(el.value || el.innerText || el.textContent));
        const tClean = token(cleanSpecial(t));
        if (!t) return false;
        return tClean === expClean || (expClean && tClean.includes(expClean) && tClean.length <= expClean.length + 80);
      });
      if (found) {
        const valText = clean(found.value || found.innerText || found.textContent);
        uniqueValues.push({ value: valText, source: 'page-selected-element' });
        matchingValues = [{ value: valText, source: 'page-selected-element' }];
      }
    }
    const invalid = [
      exactOwner,
      owner,
      ...Array.from(owner.querySelectorAll?.('[aria-invalid="true"]') || []),
    ].some((node) => attr(node, 'aria-invalid') === 'true');
    return JSON.stringify({
      ok: true,
      reason: payload.probeOnly
        ? 'exact_bound_popup_ownership_observed'
        : matchingValues.length >= 1
        ? 'exact_bound_selection_owner_value_observed'
        : 'exact_bound_selection_owner_value_not_observed',
      expectedSelection: payload.expectedSelection,
      values: uniqueValues,
      matchingValues,
      matched: matchingValues.length >= 1,
      popupOpen,
      ownerExpanded,
      relationIds,
      controlledPopupCount: exactControlledPopups.length,
      ownedOptionNames,
      invalid,
      role: clean(attr(exactOwner, 'role') || exactOwner.tagName).toLowerCase(),
      tag: clean(exactOwner.tagName).toLowerCase(),
      candidateCount: 1,
      valueCandidateCount: uniqueValues.length,
    });
  }`;
}

function buildBoundPopupOwnershipReadFunction() {
  return buildBoundSelectionOwnerReadFunction({ probeOnly: true });
}

function evaluateSelectionOwnerReadback({ readback, expectedSelection } = {}) {
  const expected = clean(selectionValue(expectedSelection));
  const current = readback && typeof readback === 'object' ? readback : null;
  if (!current || current.ok !== true) {
    return Object.freeze({
      valueMatched: null,
      ownerStateCommitted: null,
      reason: clean(current?.reason) || 'selection_owner_readback_unavailable',
    });
  }
  const values = Array.isArray(current.values)
    ? current.values.map((entry) => (
      typeof entry === 'object' ? entry.value : entry
    ))
    : [];
  const valueMatched = current.matched === true
    || values.some((value) => semanticSelectionRank(expected, value) > 0);
  if (!valueMatched) {
    return Object.freeze({
      valueMatched: false,
      ownerStateCommitted: false,
      reason: 'selection_owner_value_not_committed',
    });
  }
  if (current.invalid === true) {
    return Object.freeze({
      valueMatched: true,
      ownerStateCommitted: true,
      applicationValidationRejected: true,
      reason: 'selection_owner_value_committed_with_application_validation_error',
    });
  }
  return Object.freeze({
    valueMatched: true,
    ownerStateCommitted: true,
    reason: 'selection_owner_value_committed',
  });
}

module.exports = {
  SELECTION_STATE_VERSION,
  semanticSelectionRank,
  buildVirtualizedOptionSelectionFunction,
  buildBoundSelectionOwnerReadFunction,
  buildBoundPopupOwnershipReadFunction,
  evaluateSelectionOwnerReadback,
};
