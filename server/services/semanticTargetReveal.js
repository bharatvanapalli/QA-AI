'use strict';

const SURFACE_WORDS = new Set([
  'button', 'calendar', 'choice', 'combobox', 'control', 'date', 'dropdown',
  'field', 'icon', 'input', 'menu', 'opener', 'option', 'picker', 'section',
  'time', 'toggle',
]);

function normalizeLabel(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function identityTokens(value) {
  return normalizeLabel(value)
    .split(' ')
    .filter((token) => token.length > 1 && !SURFACE_WORDS.has(token));
}

function buildSemanticTargetRevealFunction({ label, roleHints = [], semanticTarget = null } = {}) {
  const normalizedLabel = normalizeLabel(label);
  const temporalFacet = /\b(?:date|calendar)\b/.test(normalizedLabel) && !/\btime\b/.test(normalizedLabel)
    ? 'date'
    : /\btime\b/.test(normalizedLabel) && !/\bdate\b/.test(normalizedLabel)
      ? 'time'
      : null;
  const payload = {
    label: String(label == null ? '' : label).trim().slice(0, 240),
    normalizedLabel,
    identityTokens: identityTokens(label),
    roleHints: Array.from(new Set((Array.isArray(roleHints) ? roleHints : [roleHints])
      .map(normalizeLabel)
      .filter(Boolean))),
    temporalFacet,
    preferInteractive: String(semanticTarget?.kind || '').toLowerCase().replace(/[^a-z]/g, '') === 'controlopener',
    bindRuntimeAlias: semanticTarget?.bindRuntimeAlias !== false,
  };

  return `() => {
    const payload = ${JSON.stringify(payload)};
    const clean = (value, max = 320) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim().slice(0, max);
    const normalize = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const attr = (node, name) => node?.getAttribute ? clean(node.getAttribute(name)) : '';
    const roleOf = (node) => {
      const explicit = normalize(attr(node, 'role')).replace(/\\s+/g, '');
      if (explicit) return explicit;
      const tag = String(node?.tagName || '').toLowerCase();
      const type = normalize(attr(node, 'type'));
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'a' && attr(node, 'href')) return 'link';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return node.multiple || Number(node.size) > 1 ? 'listbox' : 'combobox';
      if (tag === 'input') {
        if (type === 'radio') return 'radio';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'search') return 'searchbox';
        if (type === 'number') return 'spinbutton';
        if (!['button', 'submit', 'reset', 'image', 'hidden'].includes(type)) return 'textbox';
        return 'button';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return 'generic';
    };
    const queryAllDeep = (root, output = []) => {
      const selector = [
        'input', 'textarea', 'select', 'button', 'summary', 'a[href]', 'label', 'legend',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role]', '[aria-label]', '[aria-labelledby]',
        '[placeholder]', '[title]', '[data-testid]', '[data-test-id]', '[data-qaai-id]',
      ].join(',');
      for (const node of Array.from(root?.querySelectorAll?.(selector) || [])) output.push(node);
      for (const host of Array.from(root?.querySelectorAll?.('*') || [])) {
        if (host.shadowRoot) queryAllDeep(host.shadowRoot, output);
      }
      return output;
    };
    const styleVisible = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
        && rect.width > 0 && rect.height > 0;
    };
    const temporalFacetOf = (values) => {
      for (const value of values) {
        const normalized = normalize(value);
        const hasDate = /\b(?:date|calendar)\b/.test(normalized);
        const hasTime = /\btime\b/.test(normalized);
        if (hasDate && !hasTime) return 'date';
        if (hasTime && !hasDate) return 'time';
      }
      return null;
    };
    const contextualTexts = (node) => {
      const values = [];
      let current = node;
      for (let depth = 0; current && depth < 5; depth += 1) {
        const parent = current.parentElement;
        if (!parent) break;
        values.push(attr(parent, 'aria-label'), attr(parent, 'title'));
        let sibling = current.previousElementSibling;
        for (let inspected = 0; sibling && inspected < 3; inspected += 1, sibling = sibling.previousElementSibling) {
          if (!styleVisible(sibling)) continue;
          const tag = String(sibling.tagName || '').toLowerCase();
          const semantic = ['label', 'legend', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)
            || normalize(attr(sibling, 'role')) === 'heading';
          const containsControl = !!sibling.querySelector?.('input, textarea, select, button, [role="combobox"], [role="listbox"]');
          const text = clean(sibling.textContent, 120);
          if (text && (semantic || (!containsControl && sibling.children.length <= 2))) {
            values.push(text);
            break;
          }
        }
        current = parent;
      }
      return Array.from(new Set(values.filter(Boolean)));
    };
    const associatedLabels = (node) => {
      const values = Array.from(node?.labels || []).map((item) => clean(item.textContent));
      const labelledBy = attr(node, 'aria-labelledby').split(/\\s+/).filter(Boolean);
      const root = node?.getRootNode?.();
      for (const id of labelledBy) {
        values.push(clean(root?.getElementById?.(id)?.textContent || document.getElementById(id)?.textContent));
      }
      values.push(clean(node?.closest?.('label')?.textContent));
      return Array.from(new Set(values.filter(Boolean)));
    };
    const labelOwner = (node) => {
      if (String(node?.tagName || '').toLowerCase() !== 'label') return node;
      const root = node.getRootNode?.();
      const htmlFor = attr(node, 'for');
      return (htmlFor && (root?.getElementById?.(htmlFor) || document.getElementById(htmlFor)))
        || node.querySelector?.('input, textarea, select, button, [role], [tabindex]')
        || node;
    };
    const isInteractive = (node) => {
      const role = roleOf(node);
      return ['button', 'link', 'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox',
        'checkbox', 'radio', 'switch', 'treeitem'].includes(role)
        || node?.matches?.('[tabindex], [onclick], [aria-haspopup], [aria-expanded]');
    };
    const identityTexts = (node) => {
      const role = roleOf(node);
      const ownText = ['button', 'link', 'heading', 'generic'].includes(role) ? clean(node.textContent, 180) : '';
      return Array.from(new Set([
        attr(node, 'aria-label'), attr(node, 'title'), attr(node, 'placeholder'),
        ...associatedLabels(node), ownText,
      ].filter(Boolean)));
    };
    const candidatesByNode = new Map();
    for (const rawNode of queryAllDeep(document)) {
      const node = labelOwner(rawNode);
      if (!styleVisible(node) || node.disabled || attr(node, 'aria-disabled') === 'true') continue;
      const ownTexts = identityTexts(node);
      const contextTexts = contextualTexts(node);
      const texts = [...ownTexts, ...contextTexts];
      if (!texts.length) continue;
      const normalizedTexts = texts.map(normalize).filter(Boolean);
      const candidateTemporalFacet = temporalFacetOf([...ownTexts, ...contextTexts]);
      if (payload.temporalFacet && candidateTemporalFacet && payload.temporalFacet !== candidateTemporalFacet) continue;
      const tokenSet = new Set(normalizedTexts.flatMap((value) => value.split(' ')));
      const hits = payload.identityTokens.filter((token) => tokenSet.has(token));
      const coverage = payload.identityTokens.length ? hits.length / payload.identityTokens.length : 0;
      const exact = normalizedTexts.some((value) => value === payload.normalizedLabel);
      const contained = normalizedTexts.some((value) => value.includes(payload.normalizedLabel)
        || payload.normalizedLabel.includes(value));
      if (!exact && !contained && coverage < 1) continue;
      const role = roleOf(node);
      const roleMatch = payload.roleHints.length === 0 || payload.roleHints.includes(role);
      let score = hits.length * 60 + coverage * 400;
      if (exact) score += 1000;
      else if (contained) score += 420;
      if (roleMatch) score += 220;
      if (payload.temporalFacet && candidateTemporalFacet === payload.temporalFacet) score += 600;
      if (payload.preferInteractive && isInteractive(node)) score += 180;
      if (document.activeElement === node) score += 30;
      const rect = node.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      if (inViewport) score += 20;
      const current = candidatesByNode.get(node);
      const candidate = { node, score, role, label: texts[0] || '', exact, coverage, inViewport };
      if (!current || candidate.score > current.score) candidatesByNode.set(node, candidate);
    }
    const candidates = Array.from(candidatesByNode.values())
      .sort((left, right) => right.score - left.score);
    const best = candidates[0] || null;
    const runnerUp = candidates[1] || null;
    if (!best) return JSON.stringify({ ok: false, reason: 'semantic_target_not_found', candidateCount: 0 });
    if (runnerUp && best.score - runnerUp.score < 80) {
      return JSON.stringify({
        ok: false,
        reason: 'semantic_target_ambiguous',
        candidateCount: candidates.length,
        confidenceMargin: best.score - runnerUp.score,
        candidates: candidates.slice(0, 5).map((item) => ({ role: item.role, label: item.label, score: item.score })),
      });
    }
    const before = best.node.getBoundingClientRect();
    best.node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const after = best.node.getBoundingClientRect();
    const visible = after.bottom > 0 && after.right > 0 && after.top < window.innerHeight && after.left < window.innerWidth;
    const afterTexts = [...identityTexts(best.node), ...contextualTexts(best.node)].map(normalize).filter(Boolean);
    const identityPreserved = best.node.isConnected !== false && afterTexts.some((value) => (
      value === payload.normalizedLabel
      || value.includes(payload.normalizedLabel)
      || payload.normalizedLabel.includes(value)
      || payload.identityTokens.every((token) => value.split(' ').includes(token))
    ));
    let runtimeBinding = null;
    if (visible && identityPreserved && payload.bindRuntimeAlias) {
      const marker = 'qaai-runtime-' + String(
        globalThis.crypto?.randomUUID?.()
          || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)),
      ).replace(/[^a-z0-9-]/gi, '').slice(0, 96);
      const hadAriaLabel = best.node.hasAttribute('aria-label');
      const previousAriaLabel = hadAriaLabel ? best.node.getAttribute('aria-label') : null;
      best.node.setAttribute('data-qaai-runtime-target', marker);
      // The alias exists only until the refreshed accessibility snapshot has
      // issued an exact ref. It is removed before the authored action dispatch,
      // so locator capture still reflects the application's original DOM.
      best.node.setAttribute('aria-label', payload.label);
      runtimeBinding = { marker, hadAriaLabel, previousAriaLabel };
    }
    return JSON.stringify({
      ok: visible && identityPreserved,
      reason: !identityPreserved ? 'semantic_target_changed_during_reveal'
        : visible ? 'semantic_target_revealed' : 'semantic_target_not_visible_after_reveal',
      candidateCount: candidates.length,
      confidenceMargin: runnerUp ? best.score - runnerUp.score : best.score,
      role: best.role,
      label: best.label,
      visible,
      identityPreserved,
      moved: Math.abs(before.top - after.top) > 1 || Math.abs(before.left - after.left) > 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      runtimeBinding,
    });
  }`;
}

function buildSemanticTargetReleaseFunction(runtimeBinding = null) {
  const marker = String(runtimeBinding?.marker || '').trim();
  const payload = {
    marker: /^qaai-runtime-[a-z0-9-]{6,96}$/i.test(marker) ? marker : '',
    hadAriaLabel: runtimeBinding?.hadAriaLabel === true,
    previousAriaLabel: runtimeBinding?.previousAriaLabel == null
      ? null
      : String(runtimeBinding.previousAriaLabel).slice(0, 500),
  };
  return `() => {
    const payload = ${JSON.stringify(payload)};
    if (!payload.marker) return JSON.stringify({ ok: false, reason: 'runtime_binding_invalid' });
    const matches = [];
    const visit = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      for (const node of Array.from(root.querySelectorAll('[data-qaai-runtime-target]'))) {
        if (node.getAttribute('data-qaai-runtime-target') === payload.marker) matches.push(node);
      }
      for (const host of Array.from(root.querySelectorAll('*'))) {
        if (host.shadowRoot) visit(host.shadowRoot);
      }
    };
    visit(document);
    if (matches.length !== 1) {
      return JSON.stringify({ ok: false, reason: matches.length ? 'runtime_binding_ambiguous' : 'runtime_binding_missing', candidateCount: matches.length });
    }
    const node = matches[0];
    if (payload.hadAriaLabel) node.setAttribute('aria-label', payload.previousAriaLabel || '');
    else node.removeAttribute('aria-label');
    node.removeAttribute('data-qaai-runtime-target');
    return JSON.stringify({ ok: true, reason: 'runtime_binding_released' });
  }`;
}

module.exports = {
  buildSemanticTargetReleaseFunction,
  buildSemanticTargetRevealFunction,
  identityTokens,
  normalizeLabel,
};
