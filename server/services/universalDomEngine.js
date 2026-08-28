'use strict';

/**
 * Universal DOM Engine (Injected Browser-Side Script)
 * 
 * Provides zero-framework-dependency:
 * 1. W3C Accessible Name & Role Computation
 * 2. Semantic Token Distance Matching
 * 3. Direct Live DOM Value & State Extraction
 * 4. Atomic Interaction Primitives (Click, Fill, Select, Disclose)
 * 5. State-Driven Dynamic Quiescence Settlement
 */

const UNIVERSAL_DOM_FUNCTION = function qaaiUniversalDomEngine() {
  const root = typeof window !== 'undefined' ? window : globalThis;
  if (root.__qaai_universal_dom_engine__) {
    return root.__qaai_universal_dom_engine__;
  }

  function clean(val) {
    return String(val == null ? '' : val).replace(/\s+/g, ' ').trim();
  }

  function token(val) {
    return clean(val).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function tokenizeWords(val) {
    return clean(val).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof window === 'undefined') return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function computeAccessibleName(el) {
    if (!el || el.nodeType !== (typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1)) return '';

    // 1. aria-labelledby
    const labelledby = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
    if (labelledby && typeof document !== 'undefined') {
      const parts = labelledby.split(/\s+/).map((id) => {
        const target = document.getElementById(id);
        return target ? clean(target.innerText || target.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    // 2. aria-label
    const ariaLabel = el.getAttribute ? el.getAttribute('aria-label') : null;
    if (ariaLabel && clean(ariaLabel)) return clean(ariaLabel);

    // 3. Native <label> association for form controls
    const tagName = (el.tagName || '').toUpperCase();
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tagName)) {
      if (el.id && typeof document !== 'undefined') {
        const label = document.querySelector('label[for=  + CSS.escape(el.id) +  ]');
        if (label) return clean(label.innerText || label.textContent);
      }
      const parentLabel = el.closest ? el.closest('label') : null;
      if (parentLabel) {
        const clone = parentLabel.cloneNode(true);
        const childInputs = clone.querySelectorAll('input, select, textarea, button');
        childInputs.forEach((i) => i.remove());
        const text = clean(clone.innerText || clone.textContent);
        if (text) return text;
      }
    }

    // 4. Placeholder / title / alt
    const placeholder = el.getAttribute ? el.getAttribute('placeholder') : null;
    if (placeholder && clean(placeholder)) return clean(placeholder);
    const title = el.getAttribute ? el.getAttribute('title') : null;
    if (title && clean(title)) return clean(title);
    const alt = el.getAttribute ? el.getAttribute('alt') : null;
    if (alt && clean(alt)) return clean(alt);

    // 5. Button or link text content
    const role = el.getAttribute ? el.getAttribute('role') : null;
    if (['BUTTON', 'A', 'LABEL', 'OPTION', 'TAB'].includes(tagName) || ['button', 'link', 'tab', 'menuitem', 'option'].includes(role)) {
      const text = clean(el.innerText || el.textContent);
      if (text) return text;
    }

    // 6. Spatial Proximity: Nearest preceding label / heading in form section
    const container = el.closest ? el.closest('.p-field, .form-group, .form-field, fieldset, section, div') : null;
    if (container) {
      const labelEl = container.querySelector('label, .label, legend, h1, h2, h3, h4, h5, h6, [class*= label]');
      if (labelEl && isVisible(labelEl)) {
        const text = clean(labelEl.innerText || labelEl.textContent);
        if (text) return text;
      }
    }

    return '';
  }

  function computeRole(el) {
    if (!el || el.nodeType !== (typeof Node !== 'undefined' ? Node.ELEMENT_NODE : 1)) return '';
    const explicitRole = el.getAttribute ? el.getAttribute('role') : null;
    if (explicitRole) return explicitRole.toLowerCase().trim();
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT') {
      const type = ((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['number', 'range'].includes(type)) return 'spinbutton';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A' && el.hasAttribute && el.hasAttribute('href')) return 'link';
    if (['H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(tag)) return 'heading';
    if (tag === 'TABLE') return 'table';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    return 'generic';
  }

  function extractLiveValue(el) {
    if (!el) return null;
    const tagName = (el.tagName || '').toUpperCase();

    // 1. Direct input / textarea / select value
    if (['INPUT', 'TEXTAREA'].includes(tagName)) {
      const type = ((el.getAttribute && el.getAttribute('type')) || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        return el.checked ? 'true' : 'false';
      }
      return el.value != null ? clean(el.value) : null;
    }
    if (tagName === 'SELECT') {
      if (el.selectedOptions && el.selectedOptions.length) {
        return clean(el.selectedOptions[0].text || el.selectedOptions[0].value);
      }
      return el.value != null ? clean(el.value) : null;
    }

    // 2. ARIA checked / value / selected states
    if (el.hasAttribute && el.hasAttribute('aria-checked')) {
      return el.getAttribute('aria-checked') === 'true' ? 'true' : 'false';
    }
    if (el.hasAttribute && el.hasAttribute('aria-valuenow')) {
      return clean(el.getAttribute('aria-valuenow'));
    }
    if (el.hasAttribute && el.hasAttribute('aria-selected')) {
      return el.getAttribute('aria-selected') === 'true' ? 'true' : 'false';
    }
    if (el.hasAttribute && el.hasAttribute('aria-expanded')) {
      return el.getAttribute('aria-expanded') === 'true' ? 'true' : 'false';
    }

    // 3. Custom component wrappers (e.g. PrimeNG / Material / Radix select & datepicker)
    if (el.querySelector) {
      const innerInput = el.querySelector('input, textarea, select');
      if (innerInput) {
        const innerVal = extractLiveValue(innerInput);
        if (innerVal != null && innerVal !== '') return innerVal;
      }
      const customLabel = el.querySelector('.p-dropdown-label, .p-select-label, .mat-select-value-text, [class*=selected], [class*=value]');
      if (customLabel) {
        const labelText = clean(customLabel.innerText || customLabel.textContent);
        if (labelText) return labelText;
      }
    }

    // 4. Default visible text content
    return clean(el.innerText || el.textContent);
  }

  const SECTION_QUALIFIERS = [
    { name: 'early delivery', tokens: ['early', 'delivery'] },
    { name: 'late delivery', tokens: ['late', 'delivery'] },
    { name: 'early pickup', tokens: ['early', 'pickup'] },
    { name: 'late pickup', tokens: ['late', 'pickup'] },
    { name: 'pickup', tokens: ['pickup'] },
    { name: 'delivery', tokens: ['delivery'] },
    { name: 'customer', tokens: ['customer'] },
    { name: 'order number', tokens: ['order', 'number'] },
    { name: 'references', tokens: ['reference', 'references'] },
    { name: 'equipment', tokens: ['equipment'] },
    { name: 'freight term', tokens: ['freight', 'term'] },
    { name: 'ship direction', tokens: ['ship', 'direction'] },
  ];

  function getEnclosingSectionText(el) {
    if (!el || typeof el.closest !== 'function') return '';
    const sectionContainer = el.closest('fieldset, section, [class*="section"], [class*="card"], [class*="panel"], [class*="field"], [class*="group"], tr, form, div');
    if (!sectionContainer) return '';
    const headers = sectionContainer.querySelectorAll('legend, h1, h2, h3, h4, h5, h6, label, [class*="header"], [class*="title"], [class*="label"]');
    const headerTexts = Array.from(headers).map(h => clean(h.innerText || h.textContent)).filter(Boolean);
    return clean(headerTexts.join(' '));
  }

  function semanticDistanceScore(query, el) {
    const qTokens = tokenizeWords(query);
    if (!qTokens.length) return 0;

    const accessibleName = computeAccessibleName(el);
    const role = computeRole(el);
    const textContent = clean(el.innerText || el.textContent);
    const idAttr = el.id || '';
    const nameAttr = (el.getAttribute && el.getAttribute('name')) || '';
    const phAttr = (el.getAttribute && el.getAttribute('placeholder')) || '';
    const sectionText = getEnclosingSectionText(el).toLowerCase();

    const nameTokens = new Set([
      ...tokenizeWords(accessibleName),
      ...tokenizeWords(idAttr),
      ...tokenizeWords(nameAttr),
      ...tokenizeWords(phAttr),
      ...tokenizeWords(textContent.slice(0, 100))
    ]);

    let matched = 0;
    for (const q of qTokens) {
      if (nameTokens.has(q)) {
        matched += 1;
      } else {
        for (const nt of nameTokens) {
          if (nt.includes(q) || q.includes(nt)) {
            matched += 0.7;
            break;
          }
        }
      }
    }

    let score = (matched / qTokens.length) * 1000;
    if (isVisible(el)) score += 200;
    if (['textbox', 'combobox', 'button', 'checkbox', 'radio'].includes(role)) score += 100;

    // ── Section-Scoped Grid & Block Disambiguation ──
    const qLower = query.toLowerCase();
    for (const qf of SECTION_QUALIFIERS) {
      const queryHasQualifier = qf.tokens.every(t => qLower.includes(t));
      if (queryHasQualifier) {
        const sectionHasQualifier = qf.tokens.every(t => sectionText.includes(t));
        if (sectionHasQualifier) {
          score += 600; // Strong match for the correct grid section
        } else {
          // If the element is inside a rival conflicting section, heavily penalize it
          const rival = SECTION_QUALIFIERS.find(r => r.name !== qf.name && r.tokens.every(t => sectionText.includes(t)));
          if (rival) {
            score -= 1200;
          }
        }
      }
    }

    return Math.round(score);
  }

  function findSemanticElements(query, roleFilter) {
    if (typeof document === 'undefined') return [];
    const elements = Array.from(document.querySelectorAll('input, select, textarea, button, a, [role], label, [tabindex], h1, h2, h3, h4, h5, h6, span, div, p'));
    const candidates = [];

    for (const el of elements) {
      if (!isVisible(el)) continue;
      const role = computeRole(el);
      if (roleFilter && role !== roleFilter.toLowerCase()) continue;

      const score = semanticDistanceScore(query, el);
      if (score >= 400) {
        candidates.push({
          element: el,
          score,
          role,
          accessibleName: computeAccessibleName(el),
          liveValue: extractLiveValue(el),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  function executeAtomicClick(el) {
    if (!el) return false;
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 10, height: 10 };
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const pointerEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const evtName of pointerEvents) {
      if (typeof MouseEvent === 'function') {
        const evt = new MouseEvent(evtName, {
          bubbles: true,
          cancelable: true,
          view: typeof window !== 'undefined' ? window : null,
          clientX: x,
          clientY: y,
        });
        el.dispatchEvent(evt);
      }
    }
    if (typeof el.focus === 'function') el.focus();
    return true;
  }

  function formatDateForInput(value, inputEl) {
    const rawVal = String(value || '').trim();
    const isoMatch = rawVal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!isoMatch) return rawVal;

    const [_, year, month, day] = isoMatch;
    const ph = (inputEl.placeholder || inputEl.getAttribute('aria-label') || '').toLowerCase();
    
    // US Format MM/DD/YYYY
    if (ph.includes('mm/dd/yyyy') || ph.includes('mm-dd-yyyy') || ph.includes('mm/dd/yy') || ph.includes('m/d/y')) {
      return `${month}/${day}/${year}`;
    }
    // EU Format DD/MM/YYYY
    if (ph.includes('dd/mm/yyyy') || ph.includes('dd-mm-yyyy')) {
      return `${day}/${month}/${year}`;
    }
    return rawVal;
  }

  function executeAtomicFill(el, value) {
    if (!el) return false;
    const tagName = (el.tagName || '').toUpperCase();
    const targetInput = (tagName === 'INPUT' || tagName === 'TEXTAREA') ? el : (el.querySelector ? el.querySelector('input, textarea') : null);
    if (!targetInput) {
      return executeAtomicClick(el);
    }

    if (typeof targetInput.scrollIntoView === 'function') {
      targetInput.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }
    if (typeof targetInput.focus === 'function') targetInput.focus();

    // Adapt value to masked date format if applicable
    const formattedVal = formatDateForInput(value, targetInput);

    // Clear existing value first
    if (typeof HTMLInputElement !== 'undefined' && typeof HTMLTextAreaElement !== 'undefined') {
      const prototype = targetInput.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(targetInput, '');
      } else {
        targetInput.value = '';
      }
    }

    // Set formatted target value
    if (typeof HTMLInputElement !== 'undefined' && typeof HTMLTextAreaElement !== 'undefined') {
      const prototype = targetInput.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(targetInput, formattedVal);
      } else {
        targetInput.value = formattedVal;
      }
    } else {
      targetInput.value = formattedVal;
    }

    if (typeof Event === 'function') {
      targetInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true, composed: true }));
      targetInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true, composed: true }));
      try {
        targetInput.dispatchEvent(new KeyboardEvent('keydown', { key: formattedVal.slice(-1) || 'a', bubbles: true }));
        targetInput.dispatchEvent(new KeyboardEvent('keyup', { key: formattedVal.slice(-1) || 'a', bubbles: true }));
      } catch (_) {}
      targetInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
    }
    return true;
  }

  function executeAtomicSelect(el, targetValue) {
    if (!el) return false;
    const strVal = clean(targetValue).toLowerCase();

    if ((el.tagName || '').toUpperCase() === 'SELECT' && el.options) {
      const options = Array.from(el.options);
      const match = options.find((opt) => token(opt.text) === token(strVal) || token(opt.value) === token(strVal) || (opt.text || '').toLowerCase().includes(strVal));
      if (match) {
        el.value = match.value;
        if (typeof Event === 'function') {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }
    }

    executeAtomicClick(el);
    return true;
  }

  const engine = {
    computeAccessibleName,
    computeRole,
    extractLiveValue,
    findSemanticElements,
    executeAtomicClick,
    executeAtomicFill,
    executeAtomicSelect,
    isVisible,
  };

  root.__qaai_universal_dom_engine__ = engine;
  return engine;
};

const UNIVERSAL_DOM_SCRIPT = '(' + UNIVERSAL_DOM_FUNCTION.toString() + ')();';

module.exports = {
  UNIVERSAL_DOM_FUNCTION,
  UNIVERSAL_DOM_SCRIPT,
  createUniversalDomEngine: UNIVERSAL_DOM_FUNCTION,
};
