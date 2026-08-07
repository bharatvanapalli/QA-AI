'use strict';

const crypto = require('crypto');
const mcp = require('./mcp');
const authoritativeCdpCapture = require('./authoritativeCdpCapture');
const universalControlModel = require('./universalControlModel');
const browserMutationTaxonomy = require('./browserMutationTaxonomy');

const MUTATING_ELEMENT_TOOLS = browserMutationTaxonomy.TARGET_CAPABLE_MUTATION_TOOLS;
const COORDINATE_ELEMENT_TOOLS = new Set([
  'browser_mouse_click',
  'browser_click_xy',
]);

const VERIFIED_DOM_INSPECTION_SOURCE = 'verified_dom_inspection';
const VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE = 'verified_mcp_accessibility_snapshot';
const VERIFIED_STRUCTURAL_DOM_SOURCE = 'verified_structural_dom';
const VERIFIED_COORDINATE_DOM_SOURCE = 'verified_coordinate_dom';
const AUTHORITATIVE_CHROMIUM_CDP_SOURCE = 'authoritative_chromium_cdp';
const ACTIVE_DOM_EXCAVATION_SOURCE = 'active_dom_excavation';
const SEMANTIC_DOM_SCOUT_SOURCE = 'semantic_dom_scout';
const KNOWLEDGE_BASE_CANDIDATE_SOURCE = 'knowledge_base_candidate';
const DIAGNOSTIC_SOURCES = new Set(['args', 'snapshot_ref_fallback', 'action_locator_minimal']);
const QAAI_TESTABILITY_ATTRS = [
  'data-qaai-id',
  'data-qaai-role',
  'data-qaai-row-key',
];
const TESTABILITY_ATTRS = [
  ...QAAI_TESTABILITY_ATTRS,
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
  'data-pw',
  'data-automation-id',
];
const STRONG_UNIQUE_LOCATOR_STRATEGIES = new Set([
  'qaai-attr',
  'testid',
  'testId',
  'id',
  'name',
  'label',
  'placeholder',
  'aria',
  'autocomplete',
  'password_type',
  'scoped_role',
  'scoped_label',
  'scoped_placeholder',
  'scoped_css',
  'row_scoped_role',
  'row_scoped_css',
  'shadow_scoped_role',
  'shadow_scoped_label',
  'shadow_scoped_placeholder',
  'shadow_scoped_css',
]);
const PRIVATE_USE_GLYPH_RE = /[\uE000-\uF8FF]/g;
const DECORATIVE_SYMBOL_RE = /[\u2600-\u27BF\u{1F000}-\u{1FAFF}]/gu;
const CORRUPTED_ICON_TEXT_RE = /(?:ï|ð|â|Ã|�)[\w\u0080-\u00ff�]{0,8}/gi;
const HUMAN_TEXT_RE = /[\p{L}\p{N}]/u;

const INSPECT_FUNCTION = `(${function qaaiInspectActionTarget(el) {
  const target = el && el.nodeType === 1 ? el : null;
  const clean = (value, max = 160) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const cleanAccessibleName = (value, max = 160) => clean(value, max * 2)
    .replace(/[\uE000-\uF8FF]/g, ' ')
    .replace(/[\u2600-\u27BF]/g, ' ')
    .replace(/(?:ï|ð|â|Ã|�)[\w\u0080-\u00ff�]{0,8}/gi, ' ')
    .replace(/[^\p{L}\p{N}\s'"()\-./:&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  const hasHumanName = (value) => /[\p{L}\p{N}]/u.test(cleanAccessibleName(value));
  const regexEscape = (value) => String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const playwrightNameOption = (normalized, raw) => {
    const name = cleanAccessibleName(normalized);
    if (!name) return JSON.stringify('');
    return clean(raw) && clean(raw) !== name
      ? `new RegExp(${JSON.stringify(regexEscape(name))}, "i")`
      : JSON.stringify(name);
  };
  const lower = (value) => clean(value).toLowerCase();
  const attr = (node, name) => node && node.getAttribute ? clean(node.getAttribute(name)) : '';
  const hasAttr = (node, name) => !!(node && node.hasAttribute && node.hasAttribute(name));
  const cssEscape = (value) => {
    const raw = String(value == null ? '' : value);
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
    return raw.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  };
  const cssAttr = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const xpathLiteral = (value) => {
    const raw = String(value == null ? '' : value);
    if (!raw.includes('"')) return '"' + raw + '"';
    if (!raw.includes("'")) return "'" + raw + "'";
    return 'concat("' + raw.split('"').join('", \'"\', "') + '")';
  };
  const queryAllDeep = (selector, root = document) => {
    const out = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      let matches = [];
      let all = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
        all = selector === '*' ? matches : Array.from(root.querySelectorAll('*'));
      } catch (_) { return; }
      for (const node of matches) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }
      for (const node of all) {
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(root || document);
    return out;
  };
  const allElements = () => queryAllDeep('*');
  const nodeIdentityOf = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const key = '__qaaiNodeIdentityV1';
    let state = window[key];
    if (!state || state.document !== document || !(state.nodes instanceof WeakMap)) {
      const timeOrigin = Math.round(Number(window.performance && window.performance.timeOrigin) || Date.now());
      state = {
        document,
        documentId: `doc:${timeOrigin}:${String(location.origin || '')}${String(location.pathname || '/')}`,
        nextNodeId: 1,
        nodes: new WeakMap(),
      };
      try {
        Object.defineProperty(window, key, { value: state, configurable: true, writable: true });
      } catch (_) {
        window[key] = state;
      }
    }
    let nodeId = state.nodes.get(node);
    if (!nodeId) {
      nodeId = `node:${state.nextNodeId++}`;
      state.nodes.set(node, nodeId);
    }
    return {
      scheme: 'qaai-dom-node-v1',
      documentId: state.documentId,
      nodeId,
      connected: node.isConnected !== false,
      tag: String(node.tagName || '').toLowerCase() || null,
    };
  };
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const enabled = (node) => {
    if (!node || node.nodeType !== 1) return false;
    return !node.disabled && attr(node, 'aria-disabled') !== 'true';
  };
  const dynamicToken = (value) => {
    const raw = String(value || '');
    if (!raw || raw.length > 80) return true;
    if (/^(?:css|sc|jss|makeStyles|Private|Mui|chakra|emotion|Styled|ng|ember|svelte|astro|v)-?[a-z0-9_-]*$/i.test(raw)) return true;
    if (/(?:^|[-_])(?:[a-f0-9]{8,}|[a-z0-9]{10,})(?:$|[-_])/i.test(raw)) return true;
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(raw)) return true;
    return false;
  };
  const stableAttrNames = [
    'data-qaai-id',
    'data-qaai-role',
    'data-qaai-row-key',
    'data-testid',
    'data-test-id',
    'data-test',
    'data-qa',
    'data-cy',
    'data-pw',
    'data-automation-id',
    'data-automation',
    'data-role',
    'aria-label',
    'name',
    'placeholder',
    'title',
    'alt',
    'href',
    'type',
  ];
  const implicitRole = (node) => {
    const explicit = lower(attr(node, 'role'));
    if (explicit) return explicit;
    const tag = lower(node.tagName);
    const type = lower(attr(node, 'type'));
    if (tag === 'button') return 'button';
    if (tag === 'a' && attr(node, 'href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      if (['email', 'tel', 'text', 'url', 'password', 'number', ''].includes(type)) return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'form') return 'form';
    return '';
  };
  const labelTexts = (node) => {
    const labels = [];
    if (node && node.labels) {
      for (const label of Array.from(node.labels)) {
        const text = cleanAccessibleName(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const id = attr(node, 'id');
    if (id) {
      for (const label of Array.from(document.querySelectorAll(`label[for="${cssAttr(id)}"]`))) {
        const text = cleanAccessibleName(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const closestLabel = node.closest && node.closest('label');
    if (closestLabel) {
      const text = cleanAccessibleName(closestLabel.innerText || closestLabel.textContent);
      if (text) labels.push(text);
    }
    return Array.from(new Set(labels)).slice(0, 4);
  };
  const byIdText = (ids) => String(ids || '')
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((node) => cleanAccessibleName(node.innerText || node.textContent))
    .filter(Boolean)
    .join(' ');
  const rawAccessibleName = (node) => {
    if (!node) return '';
    const labelled = byIdText(attr(node, 'aria-labelledby'));
    const labels = labelTexts(node);
    const values = [
      attr(node, 'aria-label'),
      labelled,
      labels[0],
      attr(node, 'alt'),
      attr(node, 'title'),
      attr(node, 'placeholder'),
      ['button', 'a', 'summary', 'option'].includes(lower(node.tagName)) ? clean(node.innerText || node.textContent) : '',
      lower(node.tagName) === 'input' && ['button', 'submit', 'reset'].includes(lower(attr(node, 'type'))) ? attr(node, 'value') : '',
    ];
    return clean(values.find(Boolean) || '');
  };
  const accessibleName = (node) => cleanAccessibleName(rawAccessibleName(node));
  const sameName = (a, b) => cleanAccessibleName(a).toLowerCase() === cleanAccessibleName(b).toLowerCase();
  const nameMatches = (node, expected) => sameName(accessibleName(node), expected);
  const firstElementFromXPath = (xpath) => {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const nodes = [];
      for (let i = 0; i < result.snapshotLength; i++) nodes.push(result.snapshotItem(i));
      return nodes;
    } catch (_) {
      return [];
    }
  };
  const proofFromNodes = (nodes) => {
    const targetIdentity = nodeIdentityOf(target);
    const matchedIdentity = nodes.length === 1 ? nodeIdentityOf(nodes[0]) : null;
    const sameElement = nodes.length === 1 && nodes[0] === target;
    return {
      count: nodes.length,
      sameElement,
      visible: visible(target),
      enabled: enabled(target),
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      targetIdentity,
      matchedIdentity,
      identityVerified: sameElement
        && !!targetIdentity
        && !!matchedIdentity
        && targetIdentity.documentId === matchedIdentity.documentId
        && targetIdentity.nodeId === matchedIdentity.nodeId,
    };
  };
  const proofCss = (selector) => {
    try { return proofFromNodes(queryAllDeep(selector)); }
    catch (_) { return { count: 0, sameElement: false, visible: visible(target), enabled: enabled(target), invalid: true }; }
  };
  const proofXPath = (xpath) => proofFromNodes(firstElementFromXPath(xpath));
  const uniqueCss = (selector) => {
    const proof = proofCss(selector);
    return proof.count === 1 && proof.sameElement ? selector : '';
  };
  const nthOfType = (node) => {
    let i = 1;
    let prev = node.previousElementSibling;
    while (prev) {
      if (prev.tagName === node.tagName) i++;
      prev = prev.previousElementSibling;
    }
    return i;
  };
  const cssPath = (node) => {
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = lower(cur.tagName);
      const id = attr(cur, 'id');
      if (id && !dynamicToken(id)) {
        parts.unshift(`${tag}#${cssEscape(id)}`);
        break;
      }
      let part = tag;
      const stableClass = Array.from(cur.classList || []).find((cls) => !dynamicToken(cls));
      if (stableClass) part += `.${cssEscape(stableClass)}`;
      part += `:nth-of-type(${nthOfType(cur)})`;
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.length ? parts.join(' > ') : lower(node.tagName);
  };
  const xpathPath = (node) => {
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      const tag = lower(cur.tagName);
      const id = attr(cur, 'id');
      if (id && !dynamicToken(id)) {
        parts.unshift(`*[@id=${xpathLiteral(id)}]`);
        return '//' + parts.join('/');
      }
      parts.unshift(`${tag}[${nthOfType(cur)}]`);
      cur = cur.parentElement;
    }
    return '/' + parts.join('/');
  };
  const stableContainerSelector = (node) => {
    if (!node) return '';
    const id = attr(node, 'id');
    if (id && !dynamicToken(id)) return `${lower(node.tagName)}#${cssEscape(id)}`;
    for (const name of stableAttrNames) {
      const value = attr(node, name);
      if (value && !dynamicToken(value)) return `${lower(node.tagName)}[${name}="${cssAttr(value)}"]`;
    }
    return uniqueCss(cssPath(node)) || '';
  };
  const selectorIsExportSafe = (selector) => {
    const raw = clean(selector);
    return !!raw && !/:(?:nth-of-type|nth-child)\s*\(/i.test(raw) && !/\[ref\s*=/i.test(raw);
  };
  const frameSelector = (frame) => {
    if (!frame) return '';
    const id = attr(frame, 'id');
    if (id && !dynamicToken(id)) return `${lower(frame.tagName)}#${cssEscape(id)}`;
    for (const name of ['name', 'title', 'src', 'data-testid', 'data-test', 'data-qa']) {
      const value = attr(frame, name);
      if (value && !dynamicToken(value)) return `${lower(frame.tagName)}[${name}="${cssAttr(value)}"]`;
    }
    return '';
  };
  const frameContext = () => {
    const framePath = [];
    let cursor = window;
    let selectorMissing = false;
    let guard = 0;
    try {
      while (cursor && guard++ < 8) {
        const frame = cursor.frameElement;
        if (!frame) break;
        const selector = frameSelector(frame);
        if (!selector) {
          selectorMissing = true;
          break;
        }
        framePath.unshift(selector);
        const parentWindow = cursor.parent;
        if (!parentWindow || parentWindow === cursor) break;
        cursor = parentWindow;
      }
    } catch (_) {
      selectorMissing = true;
    }
    return {
      inFrame: framePath.length > 0 || selectorMissing,
      selector: framePath.length ? framePath[framePath.length - 1] : '',
      framePath,
      selectorMissing,
    };
  };
  const shadowContext = () => {
    try {
      const shadowPath = [];
      const hostTags = [];
      let node = target;
      let immediateRoot = null;
      let guard = 0;
      while (node && guard++ < 8) {
        const root = node.getRootNode && node.getRootNode();
        const host = root && root.host && root.mode !== 'closed' ? root.host : null;
        if (!host) break;
        if (!immediateRoot) immediateRoot = root;
        const selector = stableContainerSelector(host);
        if (!selectorIsExportSafe(selector)) {
          return {
            mode: root.mode || 'open',
            hostSelector: null,
            hostSelectorMissing: true,
            shadowPath,
            shadowPathMissing: true,
            hostTags,
            root: immediateRoot,
          };
        }
        shadowPath.unshift(selector);
        hostTags.unshift(lower(host.tagName));
        node = host;
      }
      if (!shadowPath.length) return null;
      return {
        mode: immediateRoot && immediateRoot.mode || 'open',
        hostSelector: shadowPath[shadowPath.length - 1],
        hostSelectorMissing: false,
        shadowPath,
        shadowPathMissing: false,
        hostTag: hostTags[hostTags.length - 1] || null,
        hostTags,
        root: immediateRoot,
      };
    } catch (_) {
      return null;
    }
  };
  const atlasSelector = (node) => stableContainerSelector(node) || cssPath(node);
  const stableAttrsFor = (node, max = 8) => {
    const out = {};
    let count = 0;
    for (const name of stableAttrNames) {
      const value = attr(node, name);
      if (!value || dynamicToken(value)) continue;
      out[name] = value;
      count += 1;
      if (count >= max) break;
    }
    return out;
  };
  const roleForLandmark = (node) => {
    const role = implicitRole(node);
    if (role) return role;
    const tag = lower(node.tagName);
    if (['main', 'nav', 'header', 'footer', 'aside'].includes(tag)) return tag === 'nav' ? 'navigation' : tag;
    if (tag === 'section') return 'region';
    if (tag === 'table') return 'table';
    if (tag === 'ul' || tag === 'ol') return 'list';
    return '';
  };
  const isControl = (node) => {
    const tag = lower(node.tagName);
    const role = implicitRole(node);
    return ['button', 'a', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)
      || ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'slider', 'option'].includes(role)
      || hasAttr(node, 'onclick')
      || hasAttr(node, 'contenteditable');
  };
  const compactNode = (node) => {
    const tag = lower(node.tagName);
    const role = implicitRole(node);
    const rawNodeName = rawAccessibleName(node);
    const nodeName = accessibleName(node);
    const selector = atlasSelector(node);
    return {
      selector,
      tag,
      ...(role ? { role } : {}),
      ...(rawNodeName && rawNodeName !== nodeName ? { rawName: rawNodeName } : {}),
      ...(nodeName ? { name: nodeName } : {}),
      ...(attr(node, 'type') ? { type: attr(node, 'type') } : {}),
      ...(attr(node, 'placeholder') ? { placeholder: attr(node, 'placeholder') } : {}),
      ...(attr(node, 'name') ? { nameAttr: attr(node, 'name') } : {}),
      ...(attr(node, 'href') ? { href: attr(node, 'href') } : {}),
      ...(visible(node) ? { visible: true } : { visible: false }),
      ...(enabled(node) ? { enabled: true } : { enabled: false }),
      stableAttributes: stableAttrsFor(node),
    };
  };
  const buildDomAtlas = () => {
    const nodes = allElements();
    const controls = [];
    const forms = [];
    const tables = [];
    const dialogs = [];
    const landmarks = [];
    const shadowHosts = [];
    const frames = [];
    const seenControl = new Set();

    for (const node of nodes) {
      const tag = lower(node.tagName);
      if (isControl(node) && visible(node) && controls.length < 100) {
        const item = compactNode(node);
        const key = `${item.selector}|${item.role || ''}|${item.name || item.placeholder || item.nameAttr || ''}`;
        if (!seenControl.has(key)) {
          seenControl.add(key);
          const parentForm = node.closest && node.closest('form');
          const parentRow = node.closest && node.closest('tr, [role="row"]');
          if (parentForm) item.formSelector = atlasSelector(parentForm);
          if (parentRow) item.rowText = clean(parentRow.innerText || parentRow.textContent, 120);
          controls.push(item);
        }
      }
      if (tag === 'form' && forms.length < 25) {
        const formControls = Array.from(node.querySelectorAll('input, textarea, select, button, [role="button"], [role="textbox"], [role="combobox"]'))
          .filter((child) => visible(child))
          .slice(0, 30)
          .map((child) => {
            const item = compactNode(child);
            return {
              selector: item.selector,
              tag: item.tag,
              ...(item.role ? { role: item.role } : {}),
              ...(item.name ? { name: item.name } : {}),
              ...(item.type ? { type: item.type } : {}),
              ...(item.placeholder ? { placeholder: item.placeholder } : {}),
              ...(item.nameAttr ? { nameAttr: item.nameAttr } : {}),
            };
          });
        forms.push({
          selector: atlasSelector(node),
          action: attr(node, 'action') || null,
          method: attr(node, 'method') || 'get',
          controls: formControls,
        });
      }
      if (tag === 'table' && tables.length < 20) {
        const headers = Array.from(node.querySelectorAll('th')).map((th) => clean(th.innerText || th.textContent, 80)).filter(Boolean).slice(0, 20);
        tables.push({
          selector: atlasSelector(node),
          headers,
          rowCount: node.querySelectorAll('tr').length,
          columnCount: Math.max(0, ...Array.from(node.querySelectorAll('tr')).slice(0, 5).map((tr) => tr.children.length)),
        });
      }
      if ((tag === 'dialog' || attr(node, 'role') === 'dialog' || attr(node, 'aria-modal') === 'true') && dialogs.length < 20) {
        dialogs.push({ selector: atlasSelector(node), name: accessibleName(node) || null, visible: visible(node) });
      }
      const landmarkRole = roleForLandmark(node);
      if (landmarkRole && ['main', 'navigation', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'table', 'list'].includes(landmarkRole) && landmarks.length < 30) {
        landmarks.push({ selector: atlasSelector(node), role: landmarkRole, name: accessibleName(node) || null });
      }
      if (node.shadowRoot && shadowHosts.length < 30) {
        shadowHosts.push({ selector: atlasSelector(node), tag, mode: node.shadowRoot.mode || 'open' });
      }
      if ((tag === 'iframe' || tag === 'frame') && frames.length < 30) {
        frames.push({
          selector: atlasSelector(node),
          title: attr(node, 'title') || null,
          name: attr(node, 'name') || null,
          src: attr(node, 'src') || null,
        });
      }
    }

    const headings = nodes
      .filter((node) => /^h[1-6]$/i.test(node.tagName || '') && visible(node))
      .map((node) => clean(node.innerText || node.textContent, 120))
      .filter(Boolean)
      .slice(0, 30);
    const url = String(location.href || '');
    return {
      schemaVersion: 'qaai-dom-atlas-v1',
      url,
      routeKey: String(location.pathname || '/') || '/',
      title: clean(document.title, 120) || null,
      counts: {
        elements: nodes.length,
        controls: controls.length,
        forms: forms.length,
        tables: tables.length,
        dialogs: dialogs.length,
        frames: frames.length,
        shadowHosts: shadowHosts.length,
      },
      controls,
      forms,
      tables,
      dialogs,
      landmarks,
      frames,
      shadowHosts,
      headings,
    };
  };
  const seleniumCss = (selector) => `By.cssSelector(${JSON.stringify(selector)})`;
  const seleniumXPath = (xpath) => `By.xpath(${JSON.stringify(xpath)})`;
  const add = (list, c) => {
    if (!c || !c.expression || /\.(?:first|nth|last)\s*\(/.test(String(c.expression))) return;
    if (c.strategy === 'role' && !hasHumanName(c.name)) return;
    const key = `${c.strategy}|${c.expression}|${c.selector || ''}`;
    if (list.some((x) => `${x.strategy}|${x.expression}|${x.selector || ''}` === key)) return;
    list.push(c);
  };

  if (!target) return JSON.stringify({ ok: false, error: 'missing element binding' });

  const role = implicitRole(target);
  const rawName = rawAccessibleName(target);
  const name = accessibleName(target);
  const labels = labelTexts(target);
  const tag = lower(target.tagName);
  const type = attr(target, 'type');
  const placeholder = attr(target, 'placeholder');
  const title = attr(target, 'title');
  const alt = attr(target, 'alt');
  const nameAttr = attr(target, 'name');
  const id = attr(target, 'id');
  const value = clean(target.value, 80);
  const href = attr(target, 'href');
  const rect = target.getBoundingClientRect();
  const testIds = {};
  for (const name of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
    const value = attr(target, name);
    if (value) testIds[name] = value;
  }
  const stableAttributes = {};
  for (const name of stableAttrNames) {
    const value = attr(target, name);
    if (value && !dynamicToken(value)) stableAttributes[name] = value;
  }

  const form = target.closest && target.closest('form');
  const row = target.closest && target.closest('tr, [role="row"]');
  const dialog = target.closest && target.closest('dialog, [role="dialog"], [aria-modal="true"]');
  const card = target.closest && target.closest('article, section, li, [role="listitem"], [data-qaai-id], [data-qaai-role], [data-qaai-row-key], [data-testid], [data-test-id], [data-test], [data-qa], [data-cy], [data-pw], [data-automation-id], .card, .panel');
  const formSelector = stableContainerSelector(form);
  const rowSelector = stableContainerSelector(row);
  const dialogSelector = stableContainerSelector(dialog);
  const cardSelector = stableContainerSelector(card);
  const frameLocatorContext = frameContext();
  const frameLocatorSelector = frameLocatorContext.selector || '';
  const frameLocatorPath = Array.isArray(frameLocatorContext.framePath) ? frameLocatorContext.framePath : [];
  const shadowRoot = shadowContext();
  const nearbyText = [];
  for (const node of [target.previousElementSibling, target.nextElementSibling, target.parentElement, form, row, dialog, card]) {
    const text = clean(node && (node.innerText || node.textContent), 120);
    if (text && !nearbyText.includes(text)) nearbyText.push(text);
  }

  const candidates = [];
  const containerBaseFor = (node) => {
    if (!node || node.nodeType !== 1) return '';
    const nodeTag = lower(node.tagName);
    const nodeRole = implicitRole(node);
    if (nodeTag === 'tr') return 'tr';
    if (nodeRole === 'row') return '[role="row"]';
    if (nodeTag === 'li') return 'li';
    if (nodeRole === 'listitem') return '[role="listitem"]';
    if (nodeTag === 'article') return 'article';
    if (nodeTag === 'section') return 'section';
    if (nodeTag === 'form') return 'form';
    if (nodeTag === 'fieldset') return 'fieldset';
    if (nodeTag === 'dialog') return 'dialog';
    if (['dialog', 'group', 'region', 'menu', 'listbox', 'tablist', 'toolbar'].includes(nodeRole)) return `[role="${nodeRole}"]`;
    return '';
  };
  const containerKindFor = (node) => {
    const nodeTag = lower(node && node.tagName);
    const nodeRole = implicitRole(node);
    if (nodeTag === 'tr' || nodeRole === 'row') return 'row';
    if (nodeTag === 'form') return 'form';
    if (nodeTag === 'dialog' || nodeRole === 'dialog') return 'dialog';
    if (nodeTag === 'li' || nodeRole === 'listitem') return 'card';
    if (nodeTag === 'article' || nodeTag === 'section' || nodeRole === 'region' || nodeRole === 'group') return 'card';
    return 'container';
  };
  const descendants = (selector, root) => {
    try { return Array.from((root || document).querySelectorAll(selector)); }
    catch (_) { return []; }
  };
  const localCssSelectorsForTarget = () => {
    const selectors = [];
    for (const attrName of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id', 'name', 'autocomplete', 'aria-label', 'placeholder', 'title', 'type', 'href']) {
      const attrValue = attr(target, attrName);
      if (!attrValue || (attrName !== 'type' && dynamicToken(attrValue))) continue;
      selectors.push(`${tag}[${attrName}="${cssAttr(attrValue)}"]`);
    }
    if (id && !dynamicToken(id)) selectors.push(`#${cssEscape(id)}`);
    return Array.from(new Set(selectors));
  };
  const addScopedContainerCandidates = (node, baseScore) => {
    if (!node || node === target) return;
    const base = containerBaseFor(node);
    if (!base) return;
    const containerText = clean(node.innerText || node.textContent, 180);
    if (!containerText) return;
    const matches = queryAllDeep(base).filter((candidateNode) => clean(candidateNode.innerText || candidateNode.textContent, 180).includes(containerText));
    if (matches.length !== 1 || matches[0] !== node) return;
    const containerKind = containerKindFor(node);
    const containerExpr = `locator(${JSON.stringify(base)}).filter({ hasText: ${JSON.stringify(containerText)} })`;
    const scopedCandidate = (strategy, expression, childMatches, candidate, selector, scoreOffset = 0) => {
      add(candidates, {
        strategy,
        expression,
        frameworkExpressions: { playwright: expression, ...(selector ? { selenium: seleniumCss(selector) } : {}) },
        candidate: { ...(candidate || {}), contextText: [containerText] },
        selector: selector || base,
        proof: proofFromNodes(childMatches),
        score: baseScore + scoreOffset,
        context: { containerSelector: base, containerText, containerKind },
      });
    };
    if (role && name) {
      scopedCandidate(
        containerKind === 'row' ? 'row_scoped_role' : 'scoped_role',
        `${containerExpr}.getByRole(${JSON.stringify(role)}, { name: ${roleNameOption(name, rawName)} })`,
        descendants('*', node).filter((child) => implicitRole(child) === role && nameMatches(child, name)),
        { strategy: 'scoped_role', expression: `${containerExpr}.getByRole(${JSON.stringify(role)}, { name: ${roleNameOption(name, rawName)} })`, role, name },
        base,
        30
      );
    }
    for (const label of labels) {
      scopedCandidate(
        containerKind === 'row' ? 'row_scoped_label' : 'scoped_label',
        `${containerExpr}.getByLabel(${JSON.stringify(label)})`,
        descendants('input, textarea, select', node).filter((child) => labelTexts(child).some((text) => sameName(text, label)) || attr(child, 'aria-label') === label),
        { strategy: 'label', text: label },
        base,
        20
      );
    }
    if (placeholder) {
      scopedCandidate(
        containerKind === 'row' ? 'row_scoped_placeholder' : 'scoped_placeholder',
        `${containerExpr}.getByPlaceholder(${JSON.stringify(placeholder)})`,
        descendants('input, textarea', node).filter((child) => attr(child, 'placeholder') === placeholder),
        { strategy: 'placeholder', text: placeholder },
        base,
        18
      );
    }
    for (const selector of localCssSelectorsForTarget()) {
      scopedCandidate(
        containerKind === 'row' ? 'row_scoped_css' : 'scoped_css',
        `${containerExpr}.locator(${JSON.stringify(selector)})`,
        descendants(selector, node),
        { strategy: 'css', selector },
        selector,
        10
      );
    }
  };
  const addShadowHostCandidates = () => {
    const root = shadowRoot && shadowRoot.root;
    const shadowPath = shadowRoot && Array.isArray(shadowRoot.shadowPath) ? shadowRoot.shadowPath : [];
    if (!root || typeof root.querySelectorAll !== 'function' || !shadowPath.length || shadowRoot.shadowPathMissing) return;
    const hostSelector = shadowPath[shadowPath.length - 1];
    const hostExpr = shadowPath
      .map((selector, index) => `${index === 0 ? 'locator' : '.locator'}(${JSON.stringify(selector)})`)
      .join('');
    const shadowDescendants = (selector) => descendants(selector, root);
    const shadowCandidate = (strategy, expression, childMatches, candidate, selector, scoreOffset = 0) => {
      add(candidates, {
        strategy,
        expression,
        frameworkExpressions: { playwright: expression, ...(selector ? { selenium: seleniumCss(selector) } : {}) },
        candidate: { ...(candidate || {}), shadowHostSelector: hostSelector, shadowPath },
        selector: selector || hostSelector,
        proof: proofFromNodes(childMatches),
        score: 960 + scoreOffset,
        context: {
          shadowHostSelector: hostSelector,
          shadowPath,
          shadowHostTag: shadowRoot.hostTag || null,
          shadowHostTags: shadowRoot.hostTags || [],
          shadowRootMode: root.mode || 'open',
        },
      });
    };
    if (role && name) {
      const expression = `${hostExpr}.getByRole(${JSON.stringify(role)}, { name: ${roleNameOption(name, rawName)} })`;
      shadowCandidate(
        'shadow_scoped_role',
        expression,
        shadowDescendants('*').filter((child) => implicitRole(child) === role && nameMatches(child, name)),
        { strategy: 'scoped_role', expression, role, name },
        hostSelector,
        30
      );
    }
    for (const label of labels) {
      const expression = `${hostExpr}.getByLabel(${JSON.stringify(label)})`;
      shadowCandidate(
        'shadow_scoped_label',
        expression,
        shadowDescendants('input, textarea, select').filter((child) => labelTexts(child).some((text) => sameName(text, label)) || attr(child, 'aria-label') === label),
        { strategy: 'label', text: label },
        hostSelector,
        20
      );
    }
    if (placeholder) {
      const expression = `${hostExpr}.getByPlaceholder(${JSON.stringify(placeholder)})`;
      shadowCandidate(
        'shadow_scoped_placeholder',
        expression,
        shadowDescendants('input, textarea').filter((child) => attr(child, 'placeholder') === placeholder),
        { strategy: 'placeholder', text: placeholder },
        hostSelector,
        18
      );
    }
    for (const selector of localCssSelectorsForTarget()) {
      const expression = `${hostExpr}.locator(${JSON.stringify(selector)})`;
      shadowCandidate(
        'shadow_scoped_css',
        expression,
        shadowDescendants(selector),
        { strategy: 'css', selector },
        selector,
        10
      );
    }
  };
  addShadowHostCandidates();
  addScopedContainerCandidates(row, 930);
  addScopedContainerCandidates(dialog, 910);
  addScopedContainerCandidates(form, 900);
  addScopedContainerCandidates(card, 880);

  for (const [testAttr, testId] of Object.entries(testIds)) {
    const selector = `[${testAttr}="${cssAttr(testId)}"]`;
    if (testAttr === 'data-testid') {
      const nodes = allElements().filter((node) => attr(node, testAttr) === testId);
      add(candidates, {
        strategy: 'testId',
        expression: `getByTestId(${JSON.stringify(testId)})`,
        frameworkExpressions: {
          playwright: `getByTestId(${JSON.stringify(testId)})`,
          selenium: seleniumCss(selector),
        },
        candidate: { strategy: 'testId', testId },
        proof: proofFromNodes(nodes),
        score: 1000,
      });
    } else {
      const qaaiAttr = testAttr.startsWith('data-qaai-');
      add(candidates, {
        strategy: qaaiAttr ? 'qaai-attr' : 'css-attr',
        expression: `locator(${JSON.stringify(selector)})`,
        frameworkExpressions: {
          playwright: `locator(${JSON.stringify(selector)})`,
          selenium: seleniumCss(selector),
        },
        candidate: { strategy: 'css', selector },
        selector,
        proof: proofCss(selector),
        score: qaaiAttr ? 1010 : 990,
      });
    }
  }
  if (role && name) {
    const nodes = allElements().filter((node) => implicitRole(node) === role && nameMatches(node, name));
    const nameOption = playwrightNameOption(name, rawName);
    add(candidates, {
      strategy: 'role',
      role,
      name,
      expression: `getByRole(${JSON.stringify(role)}, { name: ${nameOption} })`,
      frameworkExpressions: {
        playwright: `getByRole(${JSON.stringify(role)}, { name: ${nameOption} })`,
        selenium: seleniumXPath(`//*[(${role === 'button' ? 'self::button or @role="button" or (self::input and (@type="button" or @type="submit" or @type="reset"))' : `@role=${xpathLiteral(role)}`}) and (normalize-space(.)=${xpathLiteral(name)} or @aria-label=${xpathLiteral(name)} or @title=${xpathLiteral(name)} or @placeholder=${xpathLiteral(name)} or @value=${xpathLiteral(name)})]`),
      },
      candidate: { strategy: 'role', role, name },
      proof: proofFromNodes(nodes),
      score: tag === 'input' && ['textbox', 'searchbox', 'combobox'].includes(role) ? 760 : 950,
    });
  }
  for (const label of labels) {
    const controls = allElements().filter((node) => labelTexts(node).some((text) => sameName(text, label)));
    add(candidates, {
      strategy: 'label',
      text: label,
      expression: `getByLabel(${JSON.stringify(label)})`,
      frameworkExpressions: {
        playwright: `getByLabel(${JSON.stringify(label)})`,
        selenium: seleniumXPath(`//*[@id=(//label[normalize-space(.)=${xpathLiteral(label)}]/@for)] | //label[normalize-space(.)=${xpathLiteral(label)}]//*[self::input or self::textarea or self::select]`),
      },
      candidate: { strategy: 'label', text: label },
      proof: proofFromNodes(controls),
      score: 900,
    });
  }
  if (placeholder) {
    if (formSelector && ['input', 'textarea'].includes(tag)) {
      const scoped = uniqueCss(`${formSelector} ${tag}[placeholder="${cssAttr(placeholder)}"]`);
      if (scoped) {
        add(candidates, {
          strategy: 'context-css',
          expression: `locator(${JSON.stringify(scoped)})`,
          frameworkExpressions: { playwright: `locator(${JSON.stringify(scoped)})`, selenium: seleniumCss(scoped) },
          candidate: { strategy: 'css', selector: scoped, contextText: nearbyText.slice(0, 4) },
          selector: scoped,
          proof: proofCss(scoped),
          score: 890,
        });
      }
    }
    add(candidates, {
      strategy: 'placeholder',
      text: placeholder,
      expression: `getByPlaceholder(${JSON.stringify(placeholder)})`,
      frameworkExpressions: {
        playwright: `getByPlaceholder(${JSON.stringify(placeholder)})`,
        selenium: seleniumCss(`[placeholder="${cssAttr(placeholder)}"]`),
      },
      candidate: { strategy: 'placeholder', text: placeholder },
      proof: proofCss(`[placeholder="${cssAttr(placeholder)}"]`),
      score: 880,
    });
  }
  if (alt) {
    add(candidates, {
      strategy: 'alt',
      text: alt,
      expression: `getByAltText(${JSON.stringify(alt)})`,
      frameworkExpressions: {
        playwright: `getByAltText(${JSON.stringify(alt)})`,
        selenium: seleniumCss(`[alt="${cssAttr(alt)}"]`),
      },
      candidate: { strategy: 'css', selector: `[alt="${cssAttr(alt)}"]` },
      proof: proofCss(`[alt="${cssAttr(alt)}"]`),
      score: 830,
    });
  }
  if (title) {
    add(candidates, {
      strategy: 'title',
      text: title,
      expression: `getByTitle(${JSON.stringify(title)})`,
      frameworkExpressions: {
        playwright: `getByTitle(${JSON.stringify(title)})`,
        selenium: seleniumCss(`[title="${cssAttr(title)}"]`),
      },
      candidate: { strategy: 'css', selector: `[title="${cssAttr(title)}"]` },
      proof: proofCss(`[title="${cssAttr(title)}"]`),
      score: 810,
    });
  }
  if (formSelector && (role === 'button' || tag === 'button' || (tag === 'input' && ['submit', 'button', 'reset'].includes(type)))) {
    const buttonSelector = tag === 'button'
      ? `${formSelector} button${type ? `[type="${cssAttr(type)}"]` : ''}`
      : `${formSelector} input[type="${cssAttr(type || 'submit')}"]`;
    const scoped = uniqueCss(buttonSelector);
    if (scoped) {
      add(candidates, {
        strategy: 'context-css',
        expression: `locator(${JSON.stringify(scoped)})`,
        frameworkExpressions: { playwright: `locator(${JSON.stringify(scoped)})`, selenium: seleniumCss(scoped) },
        candidate: { strategy: 'css', selector: scoped, contextText: nearbyText.slice(0, 4) },
        selector: scoped,
        proof: proofCss(scoped),
        score: 780,
      });
    }
  }
  if (row && (role === 'button' || tag === 'button' || tag === 'a')) {
    const rowText = clean(row.innerText || row.textContent, 120);
    const rowCandidates = Array.from(row.querySelectorAll('button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"]'));
    const index = rowCandidates.indexOf(target) + 1;
    if (rowText && index > 0) {
      const xpath = `//*[self::tr or @role="row"][contains(normalize-space(.), ${xpathLiteral(rowText.slice(0, 60))})]//*[self::button or self::a or @role="button" or @role="link"][${index}]`;
      add(candidates, {
        strategy: 'context-xpath',
        expression: `locator(${JSON.stringify('xpath=' + xpath)})`,
        frameworkExpressions: { playwright: `locator(${JSON.stringify('xpath=' + xpath)})`, selenium: seleniumXPath(xpath) },
        candidate: { strategy: 'css', selector: 'xpath=' + xpath, contextText: [rowText] },
        selector: 'xpath=' + xpath,
        proof: proofXPath(xpath),
        score: 760,
      });
    }
  }
  if (card && (role === 'button' || role === 'link' || tag === 'button' || tag === 'a')) {
    const cardText = clean(card.innerText || card.textContent, 120);
    const cardControls = Array.from(card.querySelectorAll('button, a[href], input[type="button"], input[type="submit"], [role="button"], [role="link"]'));
    const index = cardControls.indexOf(target) + 1;
    if (cardText && index > 0) {
      const xpath = `//*[self::article or self::section or self::li or @role="listitem" or contains(concat(" ", normalize-space(@class), " "), " card ") or contains(concat(" ", normalize-space(@class), " "), " panel ")][contains(normalize-space(.), ${xpathLiteral(cardText.slice(0, 60))})]//*[self::button or self::a or @role="button" or @role="link"][${index}]`;
      add(candidates, {
        strategy: 'context-xpath',
        expression: `locator(${JSON.stringify('xpath=' + xpath)})`,
        frameworkExpressions: { playwright: `locator(${JSON.stringify('xpath=' + xpath)})`, selenium: seleniumXPath(xpath) },
        candidate: { strategy: 'css', selector: 'xpath=' + xpath, contextText: [cardText] },
        selector: 'xpath=' + xpath,
        proof: proofXPath(xpath),
        score: 755,
      });
    }
  }
  if (id && !dynamicToken(id)) {
    const selector = `#${cssEscape(id)}`;
    add(candidates, {
      strategy: 'css-id',
      expression: `locator(${JSON.stringify(selector)})`,
      frameworkExpressions: { playwright: `locator(${JSON.stringify(selector)})`, selenium: seleniumCss(selector) },
      candidate: { strategy: 'css', selector },
      selector,
      proof: proofCss(selector),
      score: 720,
    });
  }
  if (nameAttr) {
    if (formSelector && ['input', 'textarea', 'select', 'button'].includes(tag)) {
      const scoped = uniqueCss(`${formSelector} ${tag}[name="${cssAttr(nameAttr)}"]`);
      if (scoped) {
        add(candidates, {
          strategy: 'context-css',
          expression: `locator(${JSON.stringify(scoped)})`,
          frameworkExpressions: { playwright: `locator(${JSON.stringify(scoped)})`, selenium: seleniumCss(scoped) },
          candidate: { strategy: 'css', selector: scoped, contextText: nearbyText.slice(0, 4) },
          selector: scoped,
          proof: proofCss(scoped),
          score: 735,
        });
      }
    }
    const selector = `${tag}[name="${cssAttr(nameAttr)}"]`;
    add(candidates, {
      strategy: 'css-name',
      expression: `locator(${JSON.stringify(selector)})`,
      frameworkExpressions: { playwright: `locator(${JSON.stringify(selector)})`, selenium: seleniumCss(selector) },
      candidate: { strategy: 'css', selector },
      selector,
      proof: proofCss(selector),
      score: 710,
    });
  }
  for (const [attrName, attrValue] of Object.entries(stableAttributes)) {
    if (['type', 'href'].includes(attrName)) continue;
    const selector = `${tag}[${attrName}="${cssAttr(attrValue)}"]`;
    add(candidates, {
      strategy: 'css-attr',
      expression: `locator(${JSON.stringify(selector)})`,
      frameworkExpressions: { playwright: `locator(${JSON.stringify(selector)})`, selenium: seleniumCss(selector) },
      candidate: { strategy: 'css', selector },
      selector,
      proof: proofCss(selector),
      score: 690,
    });
  }
  const structuralCss = uniqueCss(cssPath(target)) || cssPath(target);
  add(candidates, {
    strategy: 'css-structural',
    expression: `locator(${JSON.stringify(structuralCss)})`,
    frameworkExpressions: { playwright: `locator(${JSON.stringify(structuralCss)})`, selenium: seleniumCss(structuralCss) },
    candidate: { strategy: 'css', selector: structuralCss },
    selector: structuralCss,
    proof: proofCss(structuralCss),
    score: 610,
  });
  const xpath = xpathPath(target);
  add(candidates, {
    strategy: 'xpath',
    expression: `locator(${JSON.stringify('xpath=' + xpath)})`,
    frameworkExpressions: { playwright: `locator(${JSON.stringify('xpath=' + xpath)})`, selenium: seleniumXPath(xpath) },
    candidate: { strategy: 'css', selector: 'xpath=' + xpath },
    selector: 'xpath=' + xpath,
    proof: proofXPath(xpath),
    score: 500,
  });

  const facts = {
    tag,
    id: id || null,
    role: role || null,
    type: type || null,
    nameAttr: nameAttr || null,
    placeholder: placeholder || null,
    title: title || null,
    alt: alt || null,
    rawAccessibleName: rawName || null,
    normalizedAccessibleName: name || null,
    accessibleName: name || null,
    labels,
    testIds,
    value: value || null,
    href: href || null,
    text: clean(target.innerText || target.textContent, 120) || null,
    visible: visible(target),
    enabled: enabled(target),
    boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    stableAttributes,
  };
  const context = {
    formSelector: formSelector || null,
    formAction: form ? attr(form, 'action') || null : null,
    formMethod: form ? attr(form, 'method') || null : null,
    rowSelector: rowSelector || null,
    rowText: row ? clean(row.innerText || row.textContent, 160) : null,
    dialogSelector: dialogSelector || null,
    cardSelector: cardSelector || null,
    inFrame: frameLocatorContext.inFrame === true,
    frameSelector: frameLocatorSelector || null,
    framePath: frameLocatorPath,
    frameSelectorMissing: frameLocatorContext.selectorMissing === true,
    framePathMissing: frameLocatorContext.selectorMissing === true,
    shadowHostSelector: shadowRoot && shadowRoot.hostSelector || null,
    shadowPath: shadowRoot && shadowRoot.shadowPath || [],
    shadowPathMissing: shadowRoot && shadowRoot.shadowPathMissing === true,
    shadowRoot: shadowRoot ? {
      mode: shadowRoot.mode || 'open',
      hostSelector: shadowRoot.hostSelector || null,
      hostSelectorMissing: shadowRoot.hostSelectorMissing === true,
      shadowPath: shadowRoot.shadowPath || [],
      shadowPathMissing: shadowRoot.shadowPathMissing === true,
      hostTag: shadowRoot.hostTag || null,
      hostTags: shadowRoot.hostTags || [],
    } : null,
    nearbyText: nearbyText.slice(0, 8),
  };
  const targetIdentity = nodeIdentityOf(target);
  const targetFingerprint = {
    schema: 'qaai-acted-node-fingerprint-input/1',
    tag,
    role: role || null,
    accessibleName: name || null,
    labels,
    placeholder: placeholder || null,
    nameAttr: nameAttr || null,
    testIds,
    stableAttributes,
    ancestorSelectors: [rowSelector, formSelector, dialogSelector, cardSelector].filter(Boolean),
    framePath: frameLocatorPath,
    shadowPath: shadowRoot && shadowRoot.shadowPath || [],
  };
  return JSON.stringify({
    ok: true,
    facts,
    context,
    candidates,
    domAtlas: buildDomAtlas(),
    targetIdentity,
    targetFingerprint,
  });
}.toString()})`;

const ACTIVE_SCOUT_FUNCTION = `(${function qaaiActiveLocatorScout(payload) {
  const clean = (value, max = 180) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const lower = (value) => clean(value).toLowerCase();
  const attr = (node, name) => node && node.getAttribute ? clean(node.getAttribute(name)) : '';
  const cssEscape = (value) => {
    const raw = String(value == null ? '' : value);
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
    return raw.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
  };
  const cssAttr = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const queryAllDeep = (selector) => {
    const out = [];
    const seen = new Set();
    const visit = (root) => {
      if (!root || typeof root.querySelectorAll !== 'function') return;
      let matches = [];
      let all = [];
      try {
        matches = Array.from(root.querySelectorAll(selector));
        all = selector === '*' ? matches : Array.from(root.querySelectorAll('*'));
      } catch (_) { return; }
      for (const node of matches) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }
      for (const node of all) {
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(document);
    return out;
  };
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const enabled = (node) => !!node && !node.disabled && attr(node, 'aria-disabled') !== 'true';
  const implicitRole = (node) => {
    const explicit = lower(attr(node, 'role'));
    if (explicit) return explicit;
    const tag = lower(node && node.tagName);
    const type = lower(attr(node, 'type'));
    if (tag === 'button') return 'button';
    if (tag === 'a' && attr(node, 'href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (['email', 'tel', 'text', 'url', 'password', 'number', ''].includes(type)) return 'textbox';
    }
    return '';
  };
  const labelsFor = (node) => {
    const labels = [];
    if (node && node.labels) {
      for (const label of Array.from(node.labels)) {
        const text = clean(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const id = attr(node, 'id');
    if (id) {
      for (const label of Array.from(document.querySelectorAll('label[for="' + cssAttr(id) + '"]'))) {
        const text = clean(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const wrapper = node.closest && node.closest('label');
    if (wrapper) {
      const text = clean(wrapper.innerText || wrapper.textContent);
      if (text) labels.push(text);
    }
    return Array.from(new Set(labels)).slice(0, 4);
  };
  const accessibleName = (node) => {
    if (!node) return '';
    return clean(attr(node, 'aria-label') || labelsFor(node)[0] || attr(node, 'placeholder') ||
      attr(node, 'title') || attr(node, 'alt') || attr(node, 'value') ||
      (/^(button|a|option)$/i.test(node.tagName) ? node.innerText || node.textContent : ''));
  };
  const cssPath = (node) => {
    if (!node || node.nodeType !== 1) return '';
    const testId = attr(node, 'data-qaai-id') || attr(node, 'data-qaai-role') || attr(node, 'data-qaai-row-key') || attr(node, 'data-testid') || attr(node, 'data-test-id') || attr(node, 'data-test') || attr(node, 'data-qa') || attr(node, 'data-cy') || attr(node, 'data-pw') || attr(node, 'data-automation-id');
    if (testId) {
      for (const key of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
        const selector = '[' + key + '="' + cssAttr(testId) + '"]';
        if (queryAllDeep(selector).length === 1) return selector;
      }
    }
    const id = attr(node, 'id');
    if (id && queryAllDeep('#' + cssEscape(id)).length === 1) return '#' + cssEscape(id);
    const name = attr(node, 'name');
    if (name) {
      const selector = lower(node.tagName) + '[name="' + cssAttr(name) + '"]';
      if (queryAllDeep(selector).length === 1) return selector;
    }
    const parts = [];
    let cur = node;
    while (cur && cur.nodeType === 1 && cur !== document.body && parts.length < 6) {
      const tag = lower(cur.tagName);
      let index = 1;
      let sib = cur;
      while ((sib = sib.previousElementSibling)) {
        if (lower(sib.tagName) === tag) index += 1;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };
  const selectorIsExportSafe = (selector) => {
    const raw = clean(selector);
    return !!raw && !/:(?:nth-of-type|nth-child)\s*\(/i.test(raw) && !/\[ref\s*=/i.test(raw);
  };
  const stableElementSelector = (node) => {
    if (!node || node.nodeType !== 1) return '';
    const nodeTag = lower(node.tagName);
    for (const key of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
      const value = attr(node, key);
      if (!value) continue;
      const selector = nodeTag + '[' + key + '="' + cssAttr(value) + '"]';
      if (queryAllDeep(selector).length === 1) return selector;
    }
    const id = attr(node, 'id');
    if (id) {
      const selector = nodeTag + '#' + cssEscape(id);
      if (queryAllDeep(selector).length === 1) return selector;
    }
    const name = attr(node, 'name');
    if (name) {
      const selector = nodeTag + '[name="' + cssAttr(name) + '"]';
      if (queryAllDeep(selector).length === 1) return selector;
    }
    return '';
  };
  const shadowScopeFor = (node) => {
    try {
      const root = node && node.getRootNode && node.getRootNode();
      const host = root && root.host && root.mode !== 'closed' ? root.host : null;
      if (!host || !root || typeof root.querySelectorAll !== 'function') return null;
      const hostSelector = stableElementSelector(host);
      if (!selectorIsExportSafe(hostSelector)) return null;
      return { root, host, hostSelector, hostExpr: 'locator(' + JSON.stringify(hostSelector) + ')' };
    } catch (_) {
      return null;
    }
  };
  const expressionFor = (node) => {
    const role = implicitRole(node);
    const name = accessibleName(node);
    let testAttr = '';
    let testId = '';
    for (const key of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
      const value = attr(node, key);
      if (value) {
        testAttr = key;
        testId = value;
        break;
      }
    }
    const label = labelsFor(node)[0];
    const placeholder = attr(node, 'placeholder');
    const shadowScope = shadowScopeFor(node);
    if (shadowScope) {
      if (role && name) {
        const expression = shadowScope.hostExpr + '.getByRole(' + JSON.stringify(role) + ', { name: ' + JSON.stringify(name) + ' })';
        return { strategy: 'shadow_scoped_role', expression, candidate: { strategy: 'scoped_role', expression, role, name, shadowHostSelector: shadowScope.hostSelector } };
      }
      if (label) {
        const expression = shadowScope.hostExpr + '.getByLabel(' + JSON.stringify(label) + ')';
        return { strategy: 'shadow_scoped_label', expression, candidate: { strategy: 'label', text: label, shadowHostSelector: shadowScope.hostSelector } };
      }
      if (placeholder) {
        const expression = shadowScope.hostExpr + '.getByPlaceholder(' + JSON.stringify(placeholder) + ')';
        return { strategy: 'shadow_scoped_placeholder', expression, candidate: { strategy: 'placeholder', text: placeholder, shadowHostSelector: shadowScope.hostSelector } };
      }
    }
    if (testId && testAttr === 'data-testid') return { strategy: 'testId', expression: 'getByTestId(' + JSON.stringify(testId) + ')', candidate: { strategy: 'testId', testId } };
    if (testId) {
      const selector = '[' + testAttr + '="' + cssAttr(testId) + '"]';
      return { strategy: testAttr.indexOf('data-qaai-') === 0 ? 'qaai-attr' : 'css-attr', expression: 'locator(' + JSON.stringify(selector) + ')', candidate: { strategy: 'css', selector } };
    }
    if (role && name) return { strategy: 'role', expression: 'getByRole(' + JSON.stringify(role) + ', { name: ' + JSON.stringify(name) + ' })', candidate: { strategy: 'role', role, name } };
    if (label) return { strategy: 'label', expression: 'getByLabel(' + JSON.stringify(label) + ')', candidate: { strategy: 'label', text: label } };
    if (placeholder) return { strategy: 'placeholder', expression: 'getByPlaceholder(' + JSON.stringify(placeholder) + ')', candidate: { strategy: 'placeholder', text: placeholder } };
    const selector = cssPath(node);
    return selector ? { strategy: 'css', expression: 'locator(' + JSON.stringify(selector) + ')', candidate: { strategy: 'css', selector } } : null;
  };
  const proofFor = (node, expression) => {
    let matches = null;
    const source = String(expression || '');
    const locatorMatches = Array.from(source.matchAll(/locator\(\s*["']([^"']+)["']/g));
    const chainedSemantic = locatorMatches.length === 1 && /\.getBy(?:Role|Label|Placeholder|Text|TestId|AltText|Title)\s*\(/.test(source);
    const hostSelector = locatorMatches.length > 1 || chainedSemantic ? locatorMatches[0][1] : null;
    const innerSelector = locatorMatches.length > 1 ? locatorMatches[locatorMatches.length - 1][1] : (!chainedSemantic && locatorMatches[0] ? locatorMatches[0][1] : null);
    let scopeRoot = null;
    if (hostSelector) {
      const hosts = queryAllDeep(hostSelector);
      scopeRoot = hosts.length === 1 && hosts[0].shadowRoot ? hosts[0].shadowRoot : null;
    }
    const query = (selector) => queryAllDeep(selector, scopeRoot || document);
    if (innerSelector) {
      matches = query(innerSelector);
    } else {
      const roleMatch = /getByRole\(\s*["']([^"']+)["']\s*,\s*\{\s*name:\s*["']([^"']+)["']\s*\}/.exec(source);
      const labelMatch = /getByLabel\(\s*["']([^"']+)["']\s*\)/.exec(expression || '');
      const placeholderMatch = /getByPlaceholder\(\s*["']([^"']+)["']\s*\)/.exec(expression || '');
      const testIdMatch = /getByTestId\(\s*["']([^"']+)["']\s*\)/.exec(expression || '');
      if (roleMatch) {
        matches = query('*').filter((item) => implicitRole(item) === roleMatch[1] && accessibleName(item) === roleMatch[2]);
      } else if (labelMatch) {
        matches = query('*').filter((item) => labelsFor(item).includes(labelMatch[1]));
      } else if (placeholderMatch) {
        matches = query('*').filter((item) => attr(item, 'placeholder') === placeholderMatch[1]);
      } else if (testIdMatch) {
        matches = query('*').filter((item) => ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id'].some((key) => attr(item, key) === testIdMatch[1]));
      }
    }
    const count = Array.isArray(matches) ? matches.length : 0;
    return {
      count,
      sameElement: false,
      candidateUnique: count === 1,
      visible: visible(node),
      enabled: enabled(node),
      verified: false,
      actionTimeResolved: false,
      actedNodeBound: false,
      source: 'semantic_dom_scout',
    };
  };
  const scoreNode = (node, terms) => {
    const text = lower([accessibleName(node), attr(node, 'name'), attr(node, 'placeholder'), attr(node, 'id'), attr(node, 'data-qaai-id'), attr(node, 'data-qaai-role'), attr(node, 'data-qaai-row-key'), attr(node, 'data-testid'), attr(node, 'data-qa'), attr(node, 'title')].join(' '));
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      if (text === term) score += 120;
      else if (text.includes(term)) score += 60;
    }
    if (visible(node)) score += 20;
    if (enabled(node)) score += 10;
    return score;
  };
  const controls = () => queryAllDeep('input, textarea, select, button, a[href], [role="button"], [role="option"], [role="menuitem"], [role="combobox"], [contenteditable="true"]');
  const terms = clean([
    payload && payload.elementLabel,
    payload && payload.args && (payload.args.element || payload.args.label || payload.args.name || payload.args.placeholder || payload.args.role || payload.args.text),
  ].filter(Boolean).join(' ')).toLowerCase().split(/[^a-z0-9@._-]+/).filter((x) => x && x.length > 1).slice(0, 10);
  const beforeVisible = new Set(controls().filter(visible));
  // Capture must be observational. A locator scout may rank visible DOM
  // candidates, but it must never click/hover/focus controls to expose more DOM.
  // Only the authored action is allowed to mutate the page.
  const exposedBy = [];
  const wanted = controls().map((node) => ({ node, score: scoreNode(node, terms) })).sort((a, b) => b.score - a.score);
  const selected = (wanted.find((item) => item.score > 0 && visible(item.node)) || wanted.find((item) => item.score > 0) || {}).node || null;
  const form = selected && selected.closest && selected.closest('form, [role="form"], [role="dialog"], [class*="form"], [class*="modal"], [class*="dropdown"]');
  const formControls = (form ? Array.from(form.querySelectorAll('input, textarea, select, button, [role="combobox"], [role="button"], [role="option"], [role="menuitem"]')) : controls())
    .filter((node) => visible(node) || beforeVisible.has(node))
    .slice(0, 80);
  const build = (node, index) => {
    const expr = expressionFor(node);
    if (!expr) return null;
    const shadowScope = shadowScopeFor(node);
    return {
      index,
      strategy: expr.strategy,
      expression: expr.expression,
      frameworkExpressions: { playwright: expr.expression },
      candidate: expr.candidate,
      targetFacts: {
        tag: lower(node.tagName),
        role: implicitRole(node),
        accessibleName: accessibleName(node),
        placeholder: attr(node, 'placeholder') || null,
        nameAttr: attr(node, 'name') || null,
        testId: attr(node, 'data-qaai-id') || attr(node, 'data-qaai-role') || attr(node, 'data-qaai-row-key') || attr(node, 'data-testid') || attr(node, 'data-test-id') || attr(node, 'data-test') || attr(node, 'data-qa') || attr(node, 'data-cy') || attr(node, 'data-pw') || null,
        selector: cssPath(node),
      },
      context: {
        containerScope: form ? cssPath(form) : null,
        formSelector: form ? cssPath(form) : null,
        shadowHostSelector: shadowScope ? shadowScope.hostSelector : null,
        shadowRootMode: shadowScope ? shadowScope.root.mode || 'open' : null,
      },
      proof: proofFor(node, expr.expression),
      score: 100 - index,
    };
  };
  const primary = selected ? build(selected, 0) : null;
  const fields = formControls.map(build).filter(Boolean);
  return JSON.stringify({
    ok: !!(primary || fields.length),
    url: location.href,
    title: document.title,
    source: 'active_dom_excavation',
    exposedBy,
    newlyVisible: controls().filter((node) => visible(node) && !beforeVisible.has(node)).map((node) => ({
      name: accessibleName(node),
      role: implicitRole(node),
      selector: cssPath(node),
    })).filter((item) => item.name || item.selector).slice(0, 25),
    primary,
    fields,
  });
}.toString()})`;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function normalizedIdentityPath(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => clean(item && typeof item === 'object' ? item.selector || item.expression || item.name : item))
    .filter(Boolean)
    .slice(0, 20);
}

function buildActedNodeFingerprint({ targetFingerprint = null, targetFacts = null, context = null, pageUrl = null } = {}) {
  const facts = targetFacts && typeof targetFacts === 'object' ? targetFacts : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const supplied = targetFingerprint && typeof targetFingerprint === 'object' ? targetFingerprint : {};
  const stableAttributes = supplied.stableAttributes && typeof supplied.stableAttributes === 'object'
    ? supplied.stableAttributes
    : facts.stableAttributes && typeof facts.stableAttributes === 'object' ? facts.stableAttributes : {};
  const testIds = supplied.testIds && typeof supplied.testIds === 'object'
    ? supplied.testIds
    : facts.testIds && typeof facts.testIds === 'object' ? facts.testIds : {};
  const canonical = {
    schema: 'qaai-acted-node-fingerprint/1',
    route: routeKeyFromUrl(pageUrl),
    tag: clean(supplied.tag || facts.tag || facts.tagName).toLowerCase() || null,
    role: clean(supplied.role || facts.role || facts.ariaRole).toLowerCase() || null,
    accessibleName: cleanAccessibleName(supplied.accessibleName || facts.normalizedAccessibleName || facts.accessibleName || facts.rawAccessibleName) || null,
    labels: (Array.isArray(supplied.labels) ? supplied.labels : Array.isArray(facts.labels) ? facts.labels : [])
      .map((item) => cleanAccessibleName(item)).filter(Boolean).slice(0, 8),
    placeholder: cleanAccessibleName(supplied.placeholder || facts.placeholder) || null,
    nameAttr: clean(supplied.nameAttr || facts.nameAttr) || null,
    testIds,
    stableAttributes,
    ancestorSelectors: normalizedIdentityPath(supplied.ancestorSelectors || [
      ctx.rowSelector,
      ctx.formSelector,
      ctx.dialogSelector,
      ctx.cardSelector,
      ctx.containerSelector,
    ]),
    framePath: normalizedIdentityPath(supplied.framePath || ctx.framePath),
    shadowPath: normalizedIdentityPath(supplied.shadowPath || ctx.shadowPath || ctx.shadowRoot?.shadowPath),
  };
  const hash = crypto.createHash('sha256').update(stableStringify(canonical), 'utf8').digest('hex');
  return { ...canonical, hash };
}

function actionTimeSameElementProof(proof = {}) {
  if (!proof || proof.count !== 1 || proof.sameElement !== true || proof.actionTimeResolved !== true) return false;
  if (proof.resolutionMode === 'authoritative_cdp_backend_node') {
    const target = proof.targetIdentity;
    const matched = proof.matchedIdentity;
    return proof.backendNodeVerified === true
      && proof.identityVerified === true
      && target?.scheme === 'qaai-cdp-backend-node-v1'
      && matched?.scheme === target.scheme
      && Number(target.backendNodeId) > 0
      && Number(target.backendNodeId) === Number(matched.backendNodeId);
  }
  if (!['bound_mcp_ref', 'bound_mcp_ref_structural', 'coordinate_hit_test'].includes(proof.resolutionMode)) return false;
  const target = proof.targetIdentity;
  const matched = proof.matchedIdentity;
  return !!target && !!matched
    && target.scheme === 'qaai-dom-node-v1'
    && matched.scheme === target.scheme
    && target.connected === true
    && matched.connected === true
    && !!target.documentId
    && !!target.nodeId
    && target.documentId === matched.documentId
    && target.nodeId === matched.nodeId
    && proof.identityVerified === true;
}

function markLocatorGuess(locator, { source = null, reason = null } = {}) {
  if (!locator || typeof locator !== 'object') return locator || null;
  const guessSource = clean(source || locator.verificationSource || locator.evidenceSource || locator.proof?.source) || 'unverified_unknown';
  const guessReason = clean(reason || locator.diagnostic?.reason || 'No action-time locator candidate proved unique resolution to the acted DOM node.');
  return {
    ...locator,
    verified: false,
    verificationStatus: 'unverified',
    diagnosticOnly: true,
    guess: {
      isGuess: true,
      reviewRequired: true,
      source: guessSource,
      reason: guessReason,
      annotation: 'QAAI-GUESSED: this locator could not be proven against the acted DOM node; review before relying on it.',
    },
  };
}

function cleanAccessibleName(value, max = 160) {
  return clean(value)
    .replace(PRIVATE_USE_GLYPH_RE, ' ')
    .replace(DECORATIVE_SYMBOL_RE, ' ')
    .replace(CORRUPTED_ICON_TEXT_RE, ' ')
    .replace(/[^\p{L}\p{N}\s'"()\-./:&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function containsGlyphContamination(value) {
  const raw = String(value == null ? '' : value);
  PRIVATE_USE_GLYPH_RE.lastIndex = 0;
  CORRUPTED_ICON_TEXT_RE.lastIndex = 0;
  DECORATIVE_SYMBOL_RE.lastIndex = 0;
  return PRIVATE_USE_GLYPH_RE.test(raw) || CORRUPTED_ICON_TEXT_RE.test(raw) || DECORATIVE_SYMBOL_RE.test(raw);
}

function isGlyphOnlyName(value) {
  const raw = clean(value);
  if (!raw) return false;
  return !HUMAN_TEXT_RE.test(cleanAccessibleName(raw));
}

function regexEscape(value) {
  return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function roleNameOption(normalizedName, rawName = normalizedName) {
  const name = cleanAccessibleName(normalizedName);
  if (!name) return null;
  return clean(rawName) && clean(rawName) !== name
    ? `new RegExp(${JSON.stringify(regexEscape(name))}, "i")`
    : JSON.stringify(name);
}

function primaryActionLocator(actionLocator) {
  if (!actionLocator || typeof actionLocator !== 'object') return null;
  if (actionLocator.kind === 'multi' && Array.isArray(actionLocator.fields)) {
    const first = actionLocator.fields.find((field) => field && field.actionLocator);
    return first ? first.actionLocator : null;
  }
  return actionLocator.expression || actionLocator.frameworkExpressions ? actionLocator : null;
}

function normalizeCandidateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const c = candidate.candidate && typeof candidate.candidate === 'object' ? candidate.candidate : candidate;
  if (c.strategy === 'role' && (!c.name || !clean(c.name) || isGlyphOnlyName(c.name))) return null;
  if (c.strategy === 'css' && c.selector) return { strategy: 'css', selector: String(c.selector), ...(Array.isArray(c.contextText) ? { contextText: c.contextText } : {}) };
  if (c.strategy === 'testId' && c.testId) return { strategy: 'testId', testId: String(c.testId) };
  if (c.strategy === 'role' && c.role && c.name) return { strategy: 'role', role: String(c.role).toLowerCase(), name: String(c.name) };
  if (c.strategy === 'label' && c.text) return { strategy: 'label', text: String(c.text) };
  if (c.strategy === 'placeholder' && c.text) return { strategy: 'placeholder', text: String(c.text) };
  if (c.strategy === 'text' && c.text) return { strategy: 'text', text: String(c.text) };
  if (/^(?:shadow_|row_)?scoped_(?:role|label|placeholder|css)$/.test(String(c.strategy || '')) && c.expression) {
    return {
      strategy: String(c.strategy),
      expression: String(c.expression),
      ...(c.role ? { role: String(c.role).toLowerCase() } : {}),
      ...(c.name ? { name: String(c.name) } : {}),
      ...(c.text ? { text: String(c.text) } : {}),
      ...(c.selector ? { selector: String(c.selector) } : {}),
      ...(c.shadowHostSelector ? { shadowHostSelector: String(c.shadowHostSelector) } : {}),
    };
  }
  return null;
}

function dedupeCandidates(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    if (!isV1LocatorCandidate(c)) continue;
    const normalized = normalizeCandidateCandidate(c);
    if (!normalized) continue;
    const key = JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function dedupeFullCandidates(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    if (!c || typeof c !== 'object') continue;
    if (!isV1LocatorCandidate(c)) continue;
    const expression = clean(c.frameworkExpressions?.playwright || c.expression);
    const key = `${c.strategy || ''}|${expression}|${c.selector || ''}|${c.ref || ''}`;
    if (!expression || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function expressionContainsAny(expression, patterns) {
  const raw = clean(expression);
  return patterns.some((pattern) => pattern.test(raw));
}

function locatorCandidateWarnings(candidate = {}) {
  const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression || candidate.selector || candidate.candidate?.selector);
  const selector = clean(candidate.selector || candidate.candidate?.selector);
  const facts = candidate.targetFacts || {};
  const values = [
    selector,
    expression,
    facts.id,
    facts.className,
    facts.nameAttr,
    facts.testId,
  ].filter(Boolean).join(' ');
  const warnings = [];
  if (expressionContainsAny(expression, [/\.(?:nth|first|last)\s*\(/i, /:(?:nth-of-type|nth-child)\s*\(/i])) {
    warnings.push('positional_locator');
  }
  if (expressionContainsAny(expression, [/\bnth-child\b/i, /\bnth-of-type\b/i])) {
    warnings.push('structural_css');
  }
  if (/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:^|[-_])(?:[a-f0-9]{8,}|[a-z0-9]{10,})(?:$|[-_]))/i.test(values)) {
    warnings.push('dynamic_token');
  }
  if (/\b(?:css|sc|jss|makeStyles|Private|Mui|chakra|emotion|Styled|ng|ember|svelte|astro|v)-?[a-z0-9_-]*\b/i.test(values)) {
    warnings.push('generated_class_or_framework_token');
  }
  const count = Number(candidate.proof?.count);
  if (Number.isFinite(count) && count > 1) warnings.push('duplicate_matches');
  if (candidate.proof && candidate.proof.sameElement === false) warnings.push('not_same_element');
  warnings.push(...locatorExpressionVolatility(expression || selector));
  return Array.from(new Set(warnings));
}

function locatorCandidateStrategyRank(candidate = {}) {
  const strategy = String(candidate.strategy || candidate.candidate?.strategy || '').toLowerCase();
  const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression || candidate.selector || candidate.candidate?.selector);
  if (/data-qaai-(?:id|role|row-key)/i.test(expression) || strategy === 'qaai-attr') return 1200;
  if (strategy === 'testid' || /^getByTestId\s*\(/i.test(expression)) return 1160;
  if (/\[(?:data-testid|data-test-id|data-test|data-qa|data-cy|data-pw|data-automation-id)=/i.test(expression)) return 1120;
  if (/^(?:shadow_|row_)?scoped_role$/.test(strategy)) return 1080;
  if (strategy === 'role' || /^getByRole\s*\(/i.test(expression)) return 1060;
  if (/^(?:shadow_|row_)?scoped_label$/.test(strategy) || strategy === 'label' || /^getByLabel\s*\(/i.test(expression)) return 1020;
  if (/^(?:shadow_|row_)?scoped_placeholder$/.test(strategy) || strategy === 'placeholder' || /^getByPlaceholder\s*\(/i.test(expression)) return 980;
  if (strategy === 'title' || /^getByTitle\s*\(/i.test(expression)) return 940;
  if (strategy === 'alt' || /^getByAltText\s*\(/i.test(expression)) return 930;
  if (strategy === 'css-name' || /\[name=/i.test(expression)) return 850;
  if (strategy === 'css-id' || /locator\(\s*["']#[^"']+["']\s*\)/i.test(expression)) return 780;
  if (/^(?:shadow_|row_)?scoped_css$/.test(strategy) || strategy === 'context-css') return 720;
  if (strategy === 'css-attr') return 680;
  if (strategy === 'css' || strategy === 'css-structural' || strategy === 'structural') return 300;
  return 500;
}

function locatorCandidateRank(candidate = {}) {
  const warnings = locatorCandidateWarnings(candidate);
  let rank = locatorCandidateStrategyRank(candidate);
  if (warnings.includes('dynamic_token')) rank -= 360;
  if (warnings.includes('generated_class_or_framework_token')) rank -= 260;
  if (warnings.includes('duplicate_matches')) rank -= 240;
  if (warnings.includes('not_same_element')) rank -= 220;
  if (warnings.includes('structural_css')) rank -= 180;
  if (warnings.includes('positional_locator')) rank -= 500;
  return rank + ((Number(candidate.score) || 0) / 1000);
}

function normalizeCandidateSemanticFields(candidate) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const nested = candidate.candidate && typeof candidate.candidate === 'object'
    ? candidate.candidate
    : {};
  return {
    ...candidate,
    role: clean(candidate.role) || clean(nested.role) || undefined,
    name: clean(candidate.name) || clean(nested.name) || undefined,
  };
}

function chooseCandidate(candidates) {
  const valid = (Array.isArray(candidates) ? candidates : [])
    .map(normalizeCandidateSemanticFields)
    .filter((c) => c && c.expression && !/\.(?:first|nth|last)\s*\(/.test(String(c.expression)))
    .filter(isV1LocatorCandidate)
    .filter((c) => locatorExpressionIsExportSafe(c.frameworkExpressions?.playwright || c.expression, c))
    .filter((c) => !(c.strategy === 'role' && (!clean(c.name) || isGlyphOnlyName(c.name))))
    .map((c, index) => ({ ...c, _index: index }))
    .filter((c) => c.proof && c.proof.sameElement === true && c.proof.count === 1);
  if (!valid.length) return null;
  valid.sort((a, b) => locatorCandidateRank(b) - locatorCandidateRank(a) || (Number(b.score) || 0) - (Number(a.score) || 0) || a._index - b._index);
  const selected = { ...valid[0] };
  delete selected._index;
  return selected;
}

function isV1LocatorCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const strategy = String(candidate.strategy || candidate.candidate?.strategy || '').toLowerCase();
  const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression || candidate.selector || candidate.candidate?.selector);
  const verifiedExceptionalXpath = strategy === 'verified_xpath'
    && candidate.proof?.authoritativeCdpVerified === true
    && candidate.proof?.backendNodeVerified === true;
  if ((strategy.includes('xpath') || /^locator\(\s*["']xpath=|^xpath=/i.test(expression)) && !verifiedExceptionalXpath) return false;
  if (strategy === 'css-structural' || strategy === 'structural') return false;
  if (/:(?:nth-of-type|nth-child)\s*\(/i.test(expression)) return false;
  return true;
}

function wrapPlaywrightExpression(expression, context) {
  const raw = clean(expression);
  if (!raw) return raw;
  if (/^frameLocator\s*\(/.test(raw) || /^page\.frameLocator\s*\(/.test(raw)) return raw;
  const declaredPath = Array.isArray(context && context.framePath)
    ? context.framePath.map((item) => clean(item && typeof item === 'object' ? item.selector : item)).filter(Boolean)
    : [];
  const frameSelector = clean(context && context.frameSelector);
  const framePath = declaredPath.length ? declaredPath : (frameSelector ? [frameSelector] : []);
  if (!framePath.length) return raw;
  const inner = raw.replace(/^page\./, '');
  const frameChain = framePath
    .map((selector, index) => `${index === 0 ? 'frameLocator' : '.frameLocator'}(${JSON.stringify(selector)})`)
    .join('');
  return `${frameChain}.${inner}`;
}

function buildActionLocatorFromInspection({ toolName, args, inspection, pageUrl, elementLabel, fieldIndex = null }) {
  if (!inspection || inspection.ok !== true) return null;
  if (inspection.captureBinding?.kind !== 'mcp_bound_ref') return null;
  const selected = chooseCandidate(inspection.candidates);
  if (!selected) return null;
  if (!actionTimeSameElementProof(selected.proof)) return null;
  if (inspection.context?.inFrame === true) {
    const framePath = Array.isArray(inspection.context?.framePath) ? inspection.context.framePath.filter(Boolean) : [];
    if (!framePath.length && !clean(inspection.context?.frameSelector)) return null;
  }
  const verificationSource = selected.proof?.authoritativeCdpVerified === true
    ? AUTHORITATIVE_CHROMIUM_CDP_SOURCE
    : VERIFIED_DOM_INSPECTION_SOURCE;
  const proof = {
    ...(selected.proof || {}),
    source: verificationSource,
    verified: true,
    actionTimeResolved: true,
    resolutionMode: selected.proof?.authoritativeCdpVerified === true
      ? 'authoritative_cdp_backend_node'
      : 'bound_mcp_ref',
  };
  const replayCandidates = dedupeCandidates([
    selected.candidate || selected,
    ...(inspection.candidates || []).map((c) => c && (c.candidate || c)),
  ]);
  const playwright = wrapPlaywrightExpression(
    selected.frameworkExpressions?.playwright || selected.expression,
    inspection.context || {}
  );
  if (!locatorExpressionIsExportSafe(playwright, selected)) return null;
  const selenium = selected.frameworkExpressions?.selenium || null;
  const targetIdentity = inspection.targetIdentity || proof.targetIdentity || null;
  const actedNodeFingerprint = buildActedNodeFingerprint({
    targetFingerprint: inspection.targetFingerprint,
    targetFacts: inspection.facts,
    context: inspection.context,
    pageUrl,
  });
  const actionContext = {
    ...(inspection.context || {}),
    targetIdentity,
    captureBinding: { ...inspection.captureBinding },
    actedNodeFingerprint,
  };
  const domAtlas = normalizeDomAtlasForAction(inspection.domAtlas, {
    pageUrl,
    action: {
      toolName,
      elementLabel,
      strategy: selected.strategy || 'unknown',
      expression: playwright,
      frameworkExpressions: {
        playwright,
        ...(selenium ? { selenium } : {}),
      },
      targetFacts: inspection.facts || {},
      context: actionContext,
      proof,
    },
  });
  return {
    kind: 'playwright',
    verified: true,
    verificationSource,
    evidenceSource: verificationSource,
    diagnosticOnly: false,
    expression: playwright,
    frameworkExpressions: {
      playwright,
      ...(selenium ? { selenium } : {}),
    },
    strategy: selected.strategy || 'unknown',
    toolName,
    pageUrl: pageUrl || null,
    elementLabel: elementLabel || null,
    ...(fieldIndex == null ? {} : { fieldIndex }),
    targetFacts: inspection.facts || {},
    targetIdentity,
    actedNodeFingerprint,
    context: actionContext,
    proof,
    ...(domAtlas ? { domAtlas } : {}),
    candidates: replayCandidates,
    allCandidates: (inspection.candidates || [])
      .filter(isV1LocatorCandidate)
      .map((c) => ({
        strategy: c.strategy,
        expression: c.expression,
        proof: c.proof || null,
        score: c.score || 0,
      })),
  };
}

function authoritativeReplayCandidate(selected = {}) {
  if (selected.strategy === 'testid') {
    const attribute = clean(selected.attribute).toLowerCase() || 'data-testid';
    const value = clean(selected.value);
    if (attribute === 'data-testid') return { strategy: 'testId', testId: value };
    if (/^data-(?:test|qa|cy|pw)$/.test(attribute) && value) {
      const escapedValue = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return {
        strategy: 'css',
        selector: `[${attribute}="${escapedValue}"]`,
        attribute,
        value,
      };
    }
    return null;
  }
  if (selected.strategy === 'role') return { strategy: 'role', role: selected.role, name: selected.name };
  if (selected.strategy === 'label') return { strategy: 'label', text: selected.text };
  if (selected.strategy === 'placeholder') return { strategy: 'placeholder', text: selected.text };
  if (selected.strategy === 'scoped_semantic') {
    return {
      strategy: selected.semantic?.strategy === 'label' ? 'scoped_label' : 'scoped_role',
      expression: selected.expression,
      role: selected.semantic?.role,
      name: selected.semantic?.name,
      text: selected.semantic?.text,
      selector: selected.scopeSelector,
    };
  }
  return {
    strategy: selected.strategy === 'verified_xpath' ? 'verified_xpath' : 'css',
    selector: selected.selector,
  };
}

function buildActionLocatorFromAuthoritativeCapture({ toolName, args, capture, pageUrl, elementLabel, fieldIndex = null }) {
  const selected = capture?.selectedCandidate;
  if (!capture?.captured || !capture?.authoritative || !capture?.identity?.backendNodeId || !selected?.expression) return null;
  if (selected.proof?.authoritativeCdpVerified !== true || selected.proof?.backendNodeVerified !== true) return null;
  if (capture.stabilization?.stableAcrossSnapshots !== true) return null;
  if (Array.isArray(capture.framePath) && capture.framePath.length && capture.framePathExportable !== true) return null;
  const attributes = capture.node?.attributes && typeof capture.node.attributes === 'object' ? capture.node.attributes : {};
  const targetFacts = {
    tag: clean(capture.node?.localName || capture.node?.nodeName).toLowerCase() || null,
    role: clean(capture.accessibility?.role).toLowerCase() || null,
    rawAccessibleName: clean(capture.accessibility?.name) || null,
    normalizedAccessibleName: cleanAccessibleName(capture.accessibility?.name) || null,
    accessibleName: cleanAccessibleName(capture.accessibility?.name) || null,
    placeholder: clean(attributes.placeholder) || null,
    nameAttr: clean(attributes.name) || null,
    stableAttributes: Object.fromEntries(Object.entries(attributes).filter(([name, value]) =>
      TESTABILITY_ATTRS.includes(String(name).toLowerCase()) && clean(value))),
    testIds: Object.fromEntries(Object.entries(attributes).filter(([name, value]) =>
      /^(?:data-testid|data-test|data-qa|data-cy|data-pw)$/i.test(name) && clean(value))),
    cdpBackendNodeId: capture.identity.backendNodeId,
    cdpFrameId: capture.identity.frameId || null,
    cdpDocumentUrl: capture.identity.documentUrl || null,
  };
  const context = {
    framePath: selected.framePath || capture.framePathSelectors || [],
    inFrame: Array.isArray(capture.framePath) && capture.framePath.length > 0,
    shadowPath: capture.candidateAnalysis?.shadowHostSelectors || [],
    captureBinding: capture.captureBinding,
    authoritativeCdp: { pre: capture },
    cdpFramePath: capture.framePath || [],
    cdpShadowPath: capture.shadowPath || [],
    pageIdentity: capture.pageIdentity || null,
    frameIdentity: capture.frameIdentity || null,
  };
  const candidate = {
    strategy: selected.strategy,
    expression: selected.expression,
    frameworkExpressions: { playwright: selected.expression },
    candidate: authoritativeReplayCandidate(selected),
    score: 10_000 - (Number(selected.priority) || 0),
    targetFacts,
    context,
    proof: {
      ...(selected.proof || {}),
      source: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
      verified: true,
      actionTimeResolved: true,
      actedNodeBound: true,
      resolutionMode: 'authoritative_cdp_backend_node',
    },
  };
  return buildActionLocatorFromInspection({
    toolName,
    args: args || {},
    pageUrl: pageUrl || capture.identity.documentUrl,
    elementLabel,
    fieldIndex,
    inspection: {
      ok: true,
      captureBinding: capture.captureBinding,
      candidates: [candidate],
      facts: targetFacts,
      context,
      targetIdentity: capture.identity,
      targetFingerprint: {
        tag: targetFacts.tag,
        role: targetFacts.role,
        accessibleName: targetFacts.accessibleName,
        testIds: targetFacts.testIds,
        stableAttributes: targetFacts.stableAttributes,
        framePath: context.framePath,
        shadowPath: context.shadowPath,
      },
      domAtlas: {
        url: pageUrl || capture.identity.documentUrl,
        frames: capture.framePath || [],
        shadowHosts: capture.shadowPath || [],
        controls: [{ strategy: selected.strategy, expression: selected.expression, targetFacts, proof: candidate.proof }],
      },
    },
  });
}

function attachAuthoritativeCdpEvidence(actionLocator, capture) {
  if (!actionLocator || typeof actionLocator !== 'object' || !capture?.captured || !capture?.identity?.backendNodeId) {
    return actionLocator || null;
  }
  const primary = primaryActionLocator(actionLocator);
  if (!primary) return actionLocator;
  const facts = primary.targetFacts && typeof primary.targetFacts === 'object' ? primary.targetFacts : {};
  const existingRole = clean(facts.role || facts.ariaRole).toLowerCase();
  const existingName = cleanAccessibleName(facts.accessibleName || facts.normalizedAccessibleName || facts.rawAccessibleName);
  const cdpRole = clean(capture.accessibility?.role).toLowerCase();
  const cdpName = cleanAccessibleName(capture.accessibility?.name);
  const authoritativeCdp = {
    pre: capture,
    identityAgreement: {
      role: !existingRole || !cdpRole ? null : existingRole === cdpRole,
      accessibleName: !existingName || !cdpName ? null : existingName === cdpName,
    },
  };
  return {
    ...actionLocator,
    authoritativeCdp,
    targetFacts: {
      ...facts,
      cdpBackendNodeId: capture.identity.backendNodeId,
      cdpFrameId: capture.identity.frameId || null,
      cdpDocumentUrl: capture.identity.documentUrl || null,
      cdpRole: cdpRole || null,
      cdpAccessibleName: cdpName || null,
    },
    context: {
      ...(primary.context || {}),
      authoritativeCdp,
      cdpFramePath: Array.isArray(capture.framePath) ? capture.framePath : [],
      cdpShadowPath: Array.isArray(capture.shadowPath) ? capture.shadowPath : [],
    },
    proof: {
      ...(primary.proof || {}),
      authoritativeCdpCaptured: true,
      authoritativeCdpSource: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
      backendNodeId: capture.identity.backendNodeId,
    },
  };
}

const AUTHORITATIVE_REVERIFY_MARKER = 'data-qaai-cdp-reverify';
const AUTHORITATIVE_REVERIFY_ALLOWED_CALLS = new Set([
  'frameLocator',
  'locator',
  'getByRole',
  'getByLabel',
  'getByPlaceholder',
  'getByTestId',
  'getByText',
  'filter',
  'or',
  'and',
  'RegExp',
]);

function locatorFromVerifiedExpression(page, expression) {
  const raw = clean(expression);
  if (!page || !raw || !locatorExpressionIsExportSafe(raw)) return null;
  if (/[`;]|\$\{|\b(?:require|process|globalThis|Function|eval|constructor|__proto__)\b/.test(raw)) return null;
  const relative = raw.replace(/^page\./, '');
  if (!/^(?:frameLocator|locator|getByRole|getByLabel|getByPlaceholder|getByTestId|getByText)\s*\(/.test(relative)) return null;
  const calls = Array.from(relative.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g), (match) => match[1]);
  if (!calls.length || calls.some((call) => !AUTHORITATIVE_REVERIFY_ALLOWED_CALLS.has(call))) return null;
  try {
    // The expression is generated by QAAI from an already bound-ref-verified
    // candidate, is export-safe, and is restricted to Playwright locator calls.
    // It is still not trusted as proof: the two CDP backend-node comparisons
    // below are the only mechanism that can promote it.
    return Function('page', `"use strict"; return page.${relative};`)(page);
  } catch (_) {
    return null;
  }
}

async function captureReverifiedCandidateNode({ session, page, locator, markerValue, phase }) {
  if (!page || !locator || typeof locator.count !== 'function' || typeof locator.evaluate !== 'function') return null;
  let count = null;
  try { count = await locator.count(); } catch (_) { return null; }
  if (count !== 1) return null;
  let marked = false;
  try {
    await require('./actionExecutionGateway').dispatchBrowserMutation({
      session,
      mutationName: 'playwright_locator_add_capture_marker',
      args: { markerAttribute: AUTHORITATIVE_REVERIFY_MARKER, markerValue, phase },
      actionOccurrenceId: `resolver:${session?.id || 'session'}:${phase}:marker-add:${markerValue}`,
      source: 'locator_reverification_marker',
      dispatch: () => locator.evaluate((node, marker) => {
        if (!node || node.nodeType !== 1) throw new Error('candidate_node_unavailable');
        node.setAttribute(marker.attribute, marker.value);
      }, { attribute: AUTHORITATIVE_REVERIFY_MARKER, value: markerValue }),
    });
    marked = true;
    const captured = await authoritativeCdpCapture.captureMarkedCandidates({
      page,
      markers: [{ id: phase, markerAttribute: AUTHORITATIVE_REVERIFY_MARKER, markerValue }],
      phase,
    });
    const result = Array.isArray(captured) ? captured[0] : null;
    if (!result?.captured || !result?.authoritative || !Number(result?.identity?.backendNodeId)) return null;
    return { count, capture: result };
  } catch (_) {
    return null;
  } finally {
    if (marked) {
      try {
        await require('./actionExecutionGateway').dispatchBrowserMutation({
          session,
          mutationName: 'playwright_locator_remove_capture_marker',
          args: { markerAttribute: AUTHORITATIVE_REVERIFY_MARKER, markerValue, phase },
          actionOccurrenceId: `resolver:${session?.id || 'session'}:${phase}:marker-remove:${markerValue}`,
          source: 'locator_reverification_marker_cleanup',
          dispatch: () => locator.evaluate((node, marker) => {
            if (node?.getAttribute?.(marker.attribute) === marker.value) node.removeAttribute(marker.attribute);
          }, { attribute: AUTHORITATIVE_REVERIFY_MARKER, value: markerValue }),
        });
      } catch (_) {}
    }
  }
}

function authoritativeContextCanReverify(primary, capture) {
  if (!primary || !capture?.captured || !capture?.authoritative || !Number(capture?.identity?.backendNodeId)) return false;
  if (capture.selectedCandidate?.expression) return false;
  const source = primary.verificationSource || primary.evidenceSource || primary.proof?.source || null;
  if (![VERIFIED_DOM_INSPECTION_SOURCE, VERIFIED_STRUCTURAL_DOM_SOURCE].includes(source)) return false;
  if (!isVerifiedActionLocator(primary) || primary.diagnosticOnly === true || primary.guess?.isGuess === true) return false;
  const framePath = Array.isArray(capture.framePath) ? capture.framePath : [];
  const frameSelectors = Array.isArray(capture.framePathSelectors) ? capture.framePathSelectors.map(clean).filter(Boolean) : [];
  if (framePath.length && (capture.framePathExportable !== true || frameSelectors.length !== framePath.length)) return false;
  const candidateFramePath = Array.isArray(primary.context?.framePath)
    ? primary.context.framePath.map((item) => clean(item?.selector || item)).filter(Boolean)
    : [];
  if (JSON.stringify(candidateFramePath) !== JSON.stringify(frameSelectors)) return false;
  return true;
}

async function reverifyCandidateAgainstAuthoritativeCapture({ session, actionLocator, capture } = {}) {
  const primary = primaryActionLocator(actionLocator);
  if (!authoritativeContextCanReverify(primary, capture)) return null;
  const exactPage = typeof mcp._exactAuthoritativePageForIdentity === 'function'
    ? mcp._exactAuthoritativePageForIdentity(session, capture.pageIdentity || {})
    : null;
  const page = exactPage?.page || null;
  if (!page) return null;
  const expression = clean(primary.frameworkExpressions?.playwright || primary.expression);
  const expectedBackendNodeId = Number(capture.identity.backendNodeId);
  const markerPrefix = `qaai-reverify-${crypto.randomBytes(8).toString('hex')}`;
  const firstLocator = locatorFromVerifiedExpression(page, expression);
  const before = await captureReverifiedCandidateNode({
    session,
    page,
    locator: firstLocator,
    markerValue: `${markerPrefix}-before`,
    phase: 'resolver_candidate_reverification_before_stabilization',
  });
  if (Number(before?.capture?.identity?.backendNodeId) !== expectedBackendNodeId) return null;
  try { await page.waitForTimeout(60); } catch (_) {}
  const secondLocator = locatorFromVerifiedExpression(page, expression);
  const after = await captureReverifiedCandidateNode({
    session,
    page,
    locator: secondLocator,
    markerValue: `${markerPrefix}-after`,
    phase: 'resolver_candidate_reverification_after_stabilization',
  });
  if (Number(after?.capture?.identity?.backendNodeId) !== expectedBackendNodeId) return null;

  const attached = attachAuthoritativeCdpEvidence(primary, capture);
  const { guess: _guess, diagnostic: _diagnostic, ...cleanLocator } = attached;
  const authoritativeIdentity = {
    scheme: 'qaai-cdp-backend-node-v1',
    backendNodeId: expectedBackendNodeId,
    frameId: capture.identity.frameId || null,
    documentUrl: capture.identity.documentUrl || null,
    connected: capture.identity.connected !== false,
  };
  const proof = {
    ...(primary.proof || {}),
    source: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
    verified: true,
    sameElement: true,
    count: 1,
    countBefore: before.count,
    countAfter: after.count,
    actionTimeResolved: true,
    resolutionMode: 'authoritative_cdp_backend_node',
    identityVerified: true,
    targetIdentity: authoritativeIdentity,
    matchedIdentity: { ...authoritativeIdentity },
    authoritativeCdpVerified: true,
    backendNodeVerified: true,
    expectedBackendNodeId,
    matchedBackendNodeId: expectedBackendNodeId,
    backendNodeIdBefore: expectedBackendNodeId,
    backendNodeIdAfter: expectedBackendNodeId,
    stableAcrossSnapshots: true,
    sameElementAcrossSnapshots: true,
  };
  const context = {
    ...(cleanLocator.context || {}),
    authoritativeCdp: {
      pre: capture,
      reverification: {
        source: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
        expression,
        expectedBackendNodeId,
        backendNodeIdBefore: expectedBackendNodeId,
        backendNodeIdAfter: expectedBackendNodeId,
        countBefore: before.count,
        countAfter: after.count,
        exactPageId: capture.pageIdentity?.pageId || null,
        framePath: Array.isArray(capture.framePathSelectors) ? capture.framePathSelectors : [],
        shadowPath: Array.isArray(capture.shadowPath) ? capture.shadowPath : [],
        stableAcrossSnapshots: true,
      },
    },
    cdpFramePath: Array.isArray(capture.framePath) ? capture.framePath : [],
    cdpShadowPath: Array.isArray(capture.shadowPath) ? capture.shadowPath : [],
  };
  const reverifiedLocator = {
    ...cleanLocator,
    verified: true,
    verificationStatus: 'verified',
    verificationSource: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
    evidenceSource: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
    diagnosticOnly: false,
    targetFacts: {
      ...(cleanLocator.targetFacts || {}),
      cdpBackendNodeId: expectedBackendNodeId,
      cdpFrameId: capture.identity.frameId || null,
      cdpDocumentUrl: capture.identity.documentUrl || null,
    },
    context,
    proof,
  };
  const domAtlas = normalizeDomAtlasForAction(cleanLocator.domAtlas || {
    schemaVersion: 'qaai-dom-atlas-v1',
    url: cleanLocator.pageUrl || capture.identity.documentUrl || null,
    counts: { controls: 1 },
    controls: [{
      selector: expression,
      tag: reverifiedLocator.targetFacts?.tag || null,
      role: reverifiedLocator.targetFacts?.role || null,
      name: reverifiedLocator.targetFacts?.accessibleName || null,
      placeholder: reverifiedLocator.targetFacts?.placeholder || null,
      source: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
    }],
  }, {
    pageUrl: cleanLocator.pageUrl || capture.identity.documentUrl || null,
    action: reverifiedLocator,
  });
  return {
    ...reverifiedLocator,
    ...(domAtlas ? { domAtlas } : {}),
  };
}

function targetRefsForTool(toolName, args = {}) {
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    return args.fields.map((field, index) => ({
      index,
      // Bug 2 guard: field.target may be a descriptive name, not a DOM ref — only use it when it looks like one.
      ref: clean(field && (field.ref || (DOM_REF_RE.test(clean(field.target) || '') ? field.target : null))),
      element: clean(field && (field.element || field.label || field.name || field.placeholder || field.type || `field ${index + 1}`)),
      field,
    }));
  }
  if (toolName === 'browser_drag') {
    // Drag is a two-element action. Capture both endpoints while each MCP ref is
    // still bound to the action-time accessibility tree; guessing the source
    // later from narration cannot prove that the generated drag is faithful.
    const rawStartRef = clean(args.startTarget || args.sourceTarget || args.sourceRef);
    const rawEndRef = clean(args.endTarget || args.target || args.ref);
    return [
      {
        endpoint: 'source',
        index: null,
        ref: DOM_REF_RE.test(rawStartRef || '') ? rawStartRef : '',
        element: clean(args.startElement || args.sourceElement || args.sourceLabel || rawStartRef),
        field: null,
      },
      {
        endpoint: 'target',
        index: null,
        ref: DOM_REF_RE.test(rawEndRef || '') ? rawEndRef : '',
        element: clean(args.endElement || args.targetElement || args.targetLabel || args.element || args.name || rawEndRef),
        field: null,
      },
    ].filter((target) => !!target.ref);
  }
  // Bug 2 guard: args.target may be a descriptive element name (e.g., "Login button"), not a DOM ref.
  // Only fall back to args.target when it actually looks like a Playwright MCP ref (e.g., "e32").
  const ref = clean(args.ref || (DOM_REF_RE.test(clean(args.target) || '') ? args.target : null));
  if (!ref) return [];
  return [{ index: null, ref, element: clean(args.element || args.label || args.name || args.placeholder || args.role || args.target || ref), field: null }];
}

function parseInspectionResult(evalResult) {
  const rawText = mcp.textOfContent(evalResult?.content) || '';
  const parsed = mcp.parseEvaluateReturnValue(rawText);
  if (parsed && typeof parsed === 'object') return parsed;
  if (typeof parsed === 'string' && parsed.trim()) {
    try { return JSON.parse(parsed); } catch (_) { return null; }
  }
  return null;
}

async function inspectRef({ session, ref, element }) {
  if (!session?.client || typeof session.client.callTool !== 'function') return null;
  const evalResult = await session.client.callTool({
    name: 'browser_evaluate',
    arguments: {
      element: element || `<locator ${ref}>`,
      // @playwright/mcp uses `target` (NOT `ref`) for the snapshot element reference.
      target: ref,
      function: INSPECT_FUNCTION,
    },
  });
  if (evalResult?.isError) return null;
  const parsed = parseInspectionResult(evalResult);
  if (!parsed || parsed.ok !== true) return parsed;
  return {
    ...parsed,
    captureBinding: {
      kind: 'mcp_bound_ref',
      ref,
      element: element || null,
      capturedAt: new Date().toISOString(),
    },
  };
}

async function activeScout({ session, toolName, args, pageUrl, elementLabel }) {
  if (!session?.client || typeof session.client.callTool !== 'function') return null;
  const payload = {
    toolName,
    args: args || {},
    pageUrl: pageUrl || null,
    elementLabel: elementLabel || clean(args?.element || args?.label || args?.name || args?.placeholder || args?.role || ''),
  };
  // MCP 0.0.75: use `function` (callable), not `expression` (removed).
  // Wrap the IIFE so MCP can invoke it as a no-arg function.
  const evalResult = await session.client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => { return ${ACTIVE_SCOUT_FUNCTION}(${JSON.stringify(payload)}); }`,
    },
  });
  if (evalResult?.isError) return null;
  return parseInspectionResult(evalResult);
}

function buildActionLocatorFromScoutCandidate({ toolName, args, scout, candidate, pageUrl, elementLabel, fieldIndex = null }) {
  if (!scout || !candidate || !candidate.expression) return null;
  const proof = {
    ...(candidate.proof || {}),
    sameElement: false,
    verified: false,
    actedNodeBound: false,
    source: SEMANTIC_DOM_SCOUT_SOURCE,
  };
  const playwright = wrapPlaywrightExpression(candidate.frameworkExpressions?.playwright || candidate.expression, candidate.context || {});
  if (!locatorExpressionIsExportSafe(playwright, candidate)) return null;
  const replayCandidates = dedupeCandidates([
    candidate.candidate,
    ...(Array.isArray(scout.fields) ? scout.fields.map((c) => c && c.candidate) : []),
  ]);
  const domAtlas = normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1',
    url: scout.url || pageUrl || null,
    routeKey: routeKeyFromUrl(scout.url || pageUrl || null),
    title: scout.title || null,
    counts: { controls: Array.isArray(scout.fields) ? scout.fields.length : 1 },
    controls: (Array.isArray(scout.fields) ? scout.fields : [candidate]).map((field) => ({
      selector: field?.targetFacts?.selector || field?.expression || null,
      tag: field?.targetFacts?.tag || null,
      role: field?.targetFacts?.role || null,
      name: field?.targetFacts?.accessibleName || null,
      placeholder: field?.targetFacts?.placeholder || null,
      visible: field?.proof?.visible ?? null,
      enabled: field?.proof?.enabled ?? null,
      source: SEMANTIC_DOM_SCOUT_SOURCE,
    })).filter((control) => control.selector || control.name || control.placeholder),
    forms: candidate.context?.formSelector ? [{ selector: candidate.context.formSelector, source: SEMANTIC_DOM_SCOUT_SOURCE }] : [],
    tables: [],
    dialogs: [],
    landmarks: [],
    frames: [],
    shadowHosts: candidate.context?.shadowHostSelector
      ? [{ selector: candidate.context.shadowHostSelector, mode: candidate.context.shadowRootMode || 'open', source: SEMANTIC_DOM_SCOUT_SOURCE }]
      : [],
    headings: [],
  }, {
    pageUrl: scout.url || pageUrl || null,
    action: {
      toolName,
      elementLabel,
      strategy: candidate.strategy || 'semantic_dom_scout',
      expression: playwright,
      frameworkExpressions: { playwright },
      targetFacts: candidate.targetFacts || {},
      context: candidate.context || {},
      proof,
      exposedBy: scout.exposedBy || [],
      newlyVisible: scout.newlyVisible || [],
    },
  });
  return markLocatorGuess({
    kind: 'playwright',
    verified: false,
    verificationSource: SEMANTIC_DOM_SCOUT_SOURCE,
    evidenceSource: SEMANTIC_DOM_SCOUT_SOURCE,
    diagnosticOnly: true,
    expression: playwright,
    frameworkExpressions: { playwright },
    strategy: candidate.strategy || 'semantic_dom_scout',
    toolName,
    pageUrl: scout.url || pageUrl || null,
    elementLabel: elementLabel || null,
    ...(fieldIndex == null ? {} : { fieldIndex }),
    targetFacts: candidate.targetFacts || {},
    context: candidate.context || {},
    proof,
    ...(domAtlas ? { domAtlas } : {}),
    candidates: replayCandidates,
    allCandidates: (Array.isArray(scout.fields) ? scout.fields : [candidate])
      .filter(isV1LocatorCandidate)
      .map((c) => ({
        strategy: c.strategy,
        expression: c.expression,
        proof: c.proof || null,
        score: c.score || 0,
      })),
    activeScout: {
      exposedBy: scout.exposedBy || [],
      newlyVisible: scout.newlyVisible || [],
      source: SEMANTIC_DOM_SCOUT_SOURCE,
    },
  }, {
    source: SEMANTIC_DOM_SCOUT_SOURCE,
    reason: 'A semantic DOM scout found a unique candidate, but it was not bound to the acted browser node.',
  });
}

function buildActionLocatorFromScout({ toolName, args, scout, pageUrl, elementLabel }) {
  if (!scout || scout.ok !== true) return null;
  if (toolName === 'browser_fill_form' && Array.isArray(scout.fields) && (!Array.isArray(args?.fields) || args.fields.length === 0)) {
    const fields = [];
    let domAtlas = null;
    for (const [index, candidate] of scout.fields.entries()) {
      const label = candidate?.targetFacts?.accessibleName || candidate?.targetFacts?.placeholder || candidate?.targetFacts?.nameAttr || `field ${index + 1}`;
      const actionLocator = buildActionLocatorFromScoutCandidate({
        toolName,
        args: {},
        scout,
        candidate,
        pageUrl,
        elementLabel: label,
        fieldIndex: index,
      });
      if (actionLocator) {
        if (!domAtlas) domAtlas = domAtlasFromActionLocator(actionLocator);
        fields.push({ index, ref: null, name: label, actionLocator });
      }
    }
    return fields.length ? {
      kind: 'multi',
      toolName,
      pageUrl: scout.url || pageUrl || null,
      fields,
      verificationSource: SEMANTIC_DOM_SCOUT_SOURCE,
      evidenceSource: SEMANTIC_DOM_SCOUT_SOURCE,
      ...(domAtlas ? { domAtlas } : {}),
      activeScout: { exposedBy: scout.exposedBy || [], newlyVisible: scout.newlyVisible || [] },
    } : null;
  }
  if (toolName === 'browser_fill_form' && Array.isArray(args?.fields) && Array.isArray(scout.fields)) {
    const fields = [];
    let domAtlas = null;
    for (const [index, field] of args.fields.entries()) {
      const label = clean(field && (field.element || field.label || field.name || field.placeholder || field.type || `field ${index + 1}`));
      const labelLower = label.toLowerCase();
      const candidate = scout.fields.find((c) => {
        const facts = c && c.targetFacts || {};
        const haystack = clean([facts.accessibleName, facts.placeholder, facts.nameAttr, facts.testId, facts.selector].filter(Boolean).join(' ')).toLowerCase();
        return labelLower && haystack.includes(labelLower);
      }) || scout.fields[index] || scout.primary;
      const actionLocator = buildActionLocatorFromScoutCandidate({
        toolName,
        args: field || {},
        scout,
        candidate,
        pageUrl,
        elementLabel: label,
        fieldIndex: index,
      });
      if (actionLocator) {
        if (!domAtlas) domAtlas = domAtlasFromActionLocator(actionLocator);
        fields.push({ index, ref: clean(field && (field.ref || field.target)) || null, name: label, actionLocator });
      }
    }
    return fields.length ? {
      kind: 'multi',
      toolName,
      pageUrl: scout.url || pageUrl || null,
      fields,
      verificationSource: ACTIVE_DOM_EXCAVATION_SOURCE,
      evidenceSource: ACTIVE_DOM_EXCAVATION_SOURCE,
      ...(domAtlas ? { domAtlas } : {}),
      activeScout: { exposedBy: scout.exposedBy || [], newlyVisible: scout.newlyVisible || [] },
    } : null;
  }
  const candidate = scout.primary || (Array.isArray(scout.fields) ? scout.fields[0] : null);
  return buildActionLocatorFromScoutCandidate({
    toolName,
    args: args || {},
    scout,
    candidate,
    pageUrl,
    elementLabel,
  });
}

function buildFallbackFromArgs({ toolName, args, pageUrl, elementLabel }) {
  const selector = clean(args.selector || args.css || args.target);
  if (!selector || /^e\d+$/i.test(selector) || /\[ref=e\d+\]/i.test(selector)) return null;
  const expression = /^xpath=|^\/\//.test(selector)
    ? `locator(${JSON.stringify(selector.startsWith('xpath=') ? selector : 'xpath=' + selector)})`
    : `locator(${JSON.stringify(selector)})`;
  if (!locatorExpressionIsExportSafe(expression)) return null;
  return markLocatorGuess({
    kind: 'playwright',
    verified: false,
    verificationSource: 'args',
    evidenceSource: 'args',
    diagnosticOnly: true,
    expression,
    frameworkExpressions: {
      playwright: expression,
      selenium: selector.startsWith('xpath=') || selector.startsWith('//')
        ? `By.xpath(${JSON.stringify(selector.replace(/^xpath=/, ''))})`
        : `By.cssSelector(${JSON.stringify(selector)})`,
    },
    strategy: selector.startsWith('xpath=') || selector.startsWith('//') ? 'xpath' : 'css',
    toolName,
    pageUrl: pageUrl || null,
    elementLabel: elementLabel || null,
    targetFacts: {},
    context: {},
    proof: { count: null, sameElement: null, visible: null, enabled: null, source: 'args' },
    candidates: [{ strategy: 'css', selector: selector.startsWith('//') ? 'xpath=' + selector : selector }],
    allCandidates: [],
  }, {
    source: 'args',
    reason: 'The locator came from tool arguments and was not resolved against the live acted DOM node.',
  });
}

function candidateFromSnapshotExpression(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const expression = clean(candidate.expression);
  if (!expression || /\.(?:first|nth|last)\s*\(/.test(expression)) return null;
  if (containsGlyphContamination(expression) && !['role', 'text'].includes(String(candidate.strategy || '').toLowerCase())) return null;
  if (candidate.strategy === 'role' && (!clean(candidate.name) || isGlyphOnlyName(candidate.name))) return null;
  const playwright = expression.startsWith('page.') ? expression.slice(5) : expression;
  const literalArg = (method) => {
    const match = expression.match(new RegExp(`${method}\\(\\s*["']([^"']+)["']`, 'i'));
    return match ? clean(match[1]) : '';
  };
  const normalized = {
    strategy: String(candidate.strategy || '').toLowerCase(),
    expression: playwright,
    frameworkExpressions: { playwright },
    ref: clean(candidate.ref) || null,
    proof: {
      count: null,
      sameElement: null,
      visible: null,
      enabled: null,
      source: 'snapshot_ref_fallback',
    },
    score: Number(candidate.stability || 0),
  };
  if (candidate.strategy === 'testid' || candidate.strategy === 'testId') {
    const testId = clean(candidate.testId || candidate.testid || literalArg('getByTestId'));
    if (!testId) return null;
    return {
      ...normalized,
      strategy: 'testId',
      candidate: { strategy: 'testId', testId },
      targetFacts: {
        role: clean(candidate.role) || null,
        accessibleName: clean(candidate.name) || null,
        testId,
      },
    };
  }
  if (candidate.strategy === 'role' && candidate.role && candidate.name) {
    const rawName = clean(candidate.name);
    const name = cleanAccessibleName(rawName);
    if (!name) return null;
    const nameOption = roleNameOption(name, rawName);
    if (!nameOption) return null;
    const role = String(candidate.role).toLowerCase();
    return {
      ...normalized,
      strategy: 'role',
      role,
      name,
      expression: `getByRole(${JSON.stringify(role)}, { name: ${nameOption} })`,
      frameworkExpressions: { playwright: `getByRole(${JSON.stringify(role)}, { name: ${nameOption} })` },
      candidate: { strategy: 'role', role, name },
      targetFacts: {
        role,
        rawAccessibleName: rawName || null,
        normalizedAccessibleName: name,
        accessibleName: name,
      },
    };
  }
  if (candidate.strategy === 'placeholder' && (candidate.placeholder || literalArg('getByPlaceholder') || candidate.name)) {
    const text = clean(candidate.placeholder || literalArg('getByPlaceholder') || candidate.name);
    return {
      ...normalized,
      strategy: 'placeholder',
      text,
      candidate: { strategy: 'placeholder', text },
      targetFacts: {
        role: clean(candidate.role) || null,
        placeholder: text,
        rawAccessibleName: clean(candidate.name) || null,
        normalizedAccessibleName: cleanAccessibleName(candidate.name) || null,
        accessibleName: cleanAccessibleName(candidate.name) || null,
      },
    };
  }
  if (candidate.strategy === 'text' && candidate.name) {
    const text = cleanAccessibleName(candidate.name);
    if (!text) return null;
    return {
      ...normalized,
      strategy: 'text',
      text,
      expression: `getByText(${JSON.stringify(text)}, { exact: false })`,
      frameworkExpressions: { playwright: `getByText(${JSON.stringify(text)}, { exact: false })` },
      candidate: { strategy: 'text', text },
      targetFacts: {
        role: clean(candidate.role) || null,
        rawAccessibleName: clean(candidate.name) || null,
        normalizedAccessibleName: text,
        accessibleName: text,
      },
    };
  }
  if (candidate.strategy === 'css' && expression) {
    const selectorMatch = expression.match(/locator\(\s*["']([^"']+)["']/i);
    const selector = selectorMatch ? selectorMatch[1] : null;
    if (!selector || /\[ref=/i.test(selector)) return null;
    return {
      ...normalized,
      strategy: 'css',
      selector,
      candidate: { strategy: 'css', selector },
      targetFacts: {
        role: clean(candidate.role) || null,
        rawAccessibleName: clean(candidate.name) || null,
        normalizedAccessibleName: cleanAccessibleName(candidate.name) || null,
        accessibleName: cleanAccessibleName(candidate.name) || null,
        id: selector.startsWith('#') ? selector.slice(1) : null,
      },
    };
  }
  if (candidate.strategy === 'scoped_role' && expression) {
    return {
      ...normalized,
      strategy: 'scoped_role',
      candidate: { strategy: 'scoped_role', expression },
      targetFacts: {
        role: clean(candidate.role) || null,
        parentRole: clean(candidate.parentRole) || null,
        parentName: clean(candidate.parentName) || null,
        rawAccessibleName: clean(candidate.name) || null,
        normalizedAccessibleName: cleanAccessibleName(candidate.name) || null,
        accessibleName: cleanAccessibleName(candidate.name) || null,
      },
    };
  }
  return null;
}

function buildSnapshotDomAtlas({ candidates, pageUrl, selected, elementLabel, toolName }) {
  const source = selected?.verificationSource || selected?.evidenceSource || selected?.proof?.source || 'snapshot_ref_fallback';
  const controls = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const facts = c && c.targetFacts ? c.targetFacts : {};
    const selector = c?.candidate?.selector || c?.expression || null;
    const key = `${selector || ''}|${facts.role || ''}|${facts.accessibleName || facts.placeholder || facts.testId || ''}`;
    if (!selector || seen.has(key)) continue;
    seen.add(key);
    controls.push({
      selector,
      ...(facts.role ? { role: facts.role } : {}),
      ...(facts.accessibleName ? { name: facts.accessibleName } : {}),
      ...(facts.placeholder ? { placeholder: facts.placeholder } : {}),
      ...(facts.testId ? { testId: facts.testId } : {}),
      visible: null,
      enabled: null,
      source,
    });
    if (controls.length >= 25) break;
  }
  return normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1',
    url: pageUrl || null,
    routeKey: routeKeyFromUrl(pageUrl),
    title: null,
    counts: { controls: controls.length },
    controls,
    forms: [],
    tables: [],
    dialogs: [],
    landmarks: [],
    frames: [],
    shadowHosts: [],
    headings: [],
  }, {
    pageUrl,
    action: {
      toolName,
      elementLabel,
      strategy: selected?.strategy || 'snapshot_ref_fallback',
      expression: selected?.frameworkExpressions?.playwright || selected?.expression || null,
      frameworkExpressions: selected?.frameworkExpressions || {},
      targetFacts: selected?.targetFacts || {},
      context: { source },
      proof: selected?.proof || {},
    },
  });
}

function selectSnapshotCandidateForRef({ ref, snapshotText }) {
  if (!ref || !snapshotText) return { selected: null, candidates: [], allCandidates: [] };
  const allCandidates = (mcp.parseMcpSnapshotToCandidates(snapshotText) || [])
    .map(candidateFromSnapshotExpression)
    .filter((candidate) => candidate && locatorExpressionIsExportSafe(candidate.frameworkExpressions?.playwright || candidate.expression, candidate));
  const expressionCounts = new Map();
  for (const candidate of allCandidates) {
    const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression);
    if (!expression) continue;
    expressionCounts.set(expression, (expressionCounts.get(expression) || 0) + 1);
  }
  const candidates = dedupeFullCandidates(allCandidates.filter((candidate) => candidate.ref === ref));
  const withProof = candidates.map((candidate) => {
    const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression);
    const snapshotOccurrenceCount = expressionCounts.get(expression) || 0;
    return {
      ...candidate,
      proof: {
        ...(candidate.proof || {}),
        count: null,
        sameElement: false,
        snapshotOccurrenceCount,
        visible: null,
        enabled: null,
        source: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
        verified: false,
        actionTimeResolved: false,
        actedNodeBound: false,
      },
      verificationSource: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
      evidenceSource: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
    };
  });
  const selected = withProof
    .sort((a, b) => locatorCandidateRank(b) - locatorCandidateRank(a) || (Number(b.score) || 0) - (Number(a.score) || 0))[0]
    || null;

  return { selected, candidates: withProof, allCandidates };
}

// DOM refs from Playwright MCP are always "e" followed by digits (e.g., "e23", "e124").
// A descriptive target like "Login button" is NOT a ref and must not be used as one.
const DOM_REF_RE = /^e\d+$/i;

function buildVerifiedFromSnapshotRef({ toolName, args, snapshotText, pageUrl, elementLabel }) {
  // Bug 2 guard: prefer args.ref; only fall back to args.target when it looks like a DOM ref.
  const rawRef = args && (args.ref || (DOM_REF_RE.test(clean(args.target) || '') ? args.target : null));
  const ref = clean(rawRef);
  if (!ref || !DOM_REF_RE.test(ref)) return null;
  const { selected, candidates } = selectSnapshotCandidateForRef({ ref, snapshotText });
  if (!selected) return null;
  const playwright = selected.frameworkExpressions?.playwright || selected.expression;
  const selenium = selected.frameworkExpressions?.selenium || null;
  if (!locatorExpressionIsExportSafe(playwright, selected)) return null;
  const domAtlas = buildSnapshotDomAtlas({ candidates, pageUrl, selected, elementLabel, toolName });
  return markLocatorGuess({
    kind: 'playwright',
    verified: false,
    verificationSource: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
    evidenceSource: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
    diagnosticOnly: true,
    expression: playwright,
    frameworkExpressions: {
      playwright,
      ...(selenium ? { selenium } : {}),
    },
    strategy: selected.strategy || 'snapshot',
    toolName,
    pageUrl: pageUrl || null,
    elementLabel: elementLabel || clean(args.element || args.name || args.label || args.role) || null,
    targetFacts: selected.targetFacts || {},
    context: { source: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE, ref },
    proof: selected.proof || {
      count: null,
      sameElement: false,
      visible: null,
      enabled: null,
      source: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
      verified: false,
      actionTimeResolved: false,
      actedNodeBound: false,
    },
    ...(domAtlas ? { domAtlas } : {}),
    candidates,
    allCandidates: candidates.map((c) => ({
      strategy: c.strategy,
      expression: c.expression,
      proof: c.proof || null,
      score: c.score || 0,
    })),
  }, {
    source: VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
    reason: 'The locator came from an accessibility snapshot ref and was not recertified against the live acted DOM node.',
  });
}

function buildFallbackFromSnapshotRef(options = {}) {
  const { toolName, args, snapshotText, pageUrl, elementLabel } = options;
  const rawRef = args && (args.ref || (DOM_REF_RE.test(clean(args.target) || '') ? args.target : null));
  const ref = clean(rawRef);
  if (!ref || !DOM_REF_RE.test(ref)) return null;
  if (!ref || !snapshotText) return null;
  const allSnapshotCandidates = (mcp.parseMcpSnapshotToCandidates(snapshotText) || [])
    .map(candidateFromSnapshotExpression)
    .filter(Boolean);
  const expressionCounts = new Map();
  for (const candidate of allSnapshotCandidates) {
    const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression);
    if (!expression) continue;
    expressionCounts.set(expression, (expressionCounts.get(expression) || 0) + 1);
  }
  const snapshotCandidates = allSnapshotCandidates
    .filter((candidate) => candidate && candidate.ref === ref)
    .map((candidate) => {
      const expression = clean(candidate.frameworkExpressions?.playwright || candidate.expression);
      const snapshotOccurrenceCount = expressionCounts.get(expression) || 0;
      return {
        ...candidate,
        proof: {
          ...(candidate.proof || {}),
          count: null,
          sameElement: false,
          snapshotOccurrenceCount,
          visible: null,
          enabled: null,
          source: 'snapshot_ref_fallback',
          verified: false,
          actionTimeResolved: false,
          actedNodeBound: false,
        },
      };
    });
  const candidates = dedupeFullCandidates(snapshotCandidates);
  if (!candidates.length) return null;
  // Select the PRIMARY by uniqueness-by-construction, NOT by strategy fashion. A
  // role+name can be shared or inherited across controls (a password input often
  // exposes no role of its own and its accessibility line borrows the adjacent
  // field's name), so a placeholder / test-id / label — unique by construction — is
  // a safer canonical locator than role+name. Order: testId → placeholder → label →
  // role+name → css → text. Buttons/links (no placeholder/label) still resolve to
  // role+name exactly as before. Generic; keyed off strategy, never a field/site name.
  const selected = candidates.find((c) => c.strategy === 'testId')
    || candidates.find((c) => c.strategy === 'placeholder')
    || candidates.find((c) => c.strategy === 'label')
    || candidates.find((c) => c.strategy === 'role' && c.name && String(c.name).trim())
    || candidates.find((c) => c.strategy === 'css')
    || candidates.find((c) => c.strategy === 'text')
    || candidates[0];
  const playwright = selected.frameworkExpressions?.playwright || selected.expression;
  if (!locatorExpressionIsExportSafe(playwright, selected)) return null;
  const selenium = selected.frameworkExpressions?.selenium || null;
  const domAtlas = buildSnapshotDomAtlas({ candidates, pageUrl, selected, elementLabel, toolName });
  return propagateLocatorEvidence(markLocatorGuess({
    kind: 'playwright',
    verified: false,
    verificationSource: 'snapshot_ref_fallback',
    evidenceSource: 'snapshot_ref_fallback',
    diagnosticOnly: true,
    expression: playwright,
    frameworkExpressions: {
      playwright,
      ...(selenium ? { selenium } : {}),
    },
    strategy: selected.strategy || 'snapshot_ref_fallback',
    toolName,
    pageUrl: pageUrl || null,
    elementLabel: elementLabel || clean(args.element || args.name || args.label || args.role) || null,
    targetFacts: selected.targetFacts || {},
    context: { source: 'snapshot_ref_fallback' },
    proof: selected.proof || { source: 'snapshot_ref_fallback' },
    ...(domAtlas ? { domAtlas } : {}),
    candidates,
    allCandidates: candidates.map((c) => ({
      strategy: c.strategy,
      expression: c.expression,
      proof: c.proof || null,
      score: c.score || 0,
    })),
    diagnostic: {
      reason: 'browser_evaluate inspection unavailable; derived semantic candidates from the current MCP snapshot ref line',
      source: 'snapshot_ref_fallback',
    },
  }, {
    source: 'snapshot_ref_fallback',
    reason: 'The snapshot candidate was not resolved against the live acted DOM node.',
  }), options);
}

// Builds a verified action locator from a KnowledgeBaseLocator row.
// Used in the live-ref bypass when buildVerifiedFromSnapshotRef returns null —
// i.e., the element exists in the DOM but has no accessible role/name visible to
// the MCP accessibility snapshot (avatar buttons, custom widgets, etc.).
// The KB entry was previously verified during an earlier run or seeded manually,
// so VERIFIED_DOM_INSPECTION_SOURCE is the correct evidenceSource.
function buildVerifiedFromKbEntry({ kbEntry, toolName, pageUrl, elementLabel }) {
  if (!kbEntry || !kbEntry.selector) return null;
  const raw = kbEntry.selector.startsWith('page.') ? kbEntry.selector.slice(5) : kbEntry.selector;
  if (!locatorExpressionIsExportSafe(raw, kbEntry)) return null;
  const resolvedUrl = pageUrl || kbEntry.pageUrl || null;
  const domAtlas = normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1',
    url: resolvedUrl,
    routeKey: routeKeyFromUrl(resolvedUrl),
    title: null,
    counts: { controls: 1 },
    controls: [{
      selector: raw,
      ...(kbEntry.role ? { role: kbEntry.role } : {}),
      ...(kbEntry.accessibleName ? { name: kbEntry.accessibleName } : {}),
      visible: null,
      enabled: null,
      source: KNOWLEDGE_BASE_CANDIDATE_SOURCE,
    }],
    forms: [], tables: [], dialogs: [], landmarks: [], frames: [], shadowHosts: [], headings: [],
  }, {
    pageUrl: resolvedUrl,
    action: {
      toolName: toolName || null,
      elementLabel: elementLabel || kbEntry.element || null,
      strategy: kbEntry.strategy || 'css',
      expression: raw,
      frameworkExpressions: { playwright: raw },
      targetFacts: {
        role: kbEntry.role || null,
        accessibleName: kbEntry.accessibleName || null,
      },
      context: { source: KNOWLEDGE_BASE_CANDIDATE_SOURCE },
      proof: { count: null, sameElement: false, verified: false, actionTimeResolved: false, actedNodeBound: false, source: KNOWLEDGE_BASE_CANDIDATE_SOURCE },
    },
  });
  if (!domAtlas) return null;
  return markLocatorGuess({
    kind: 'playwright',
    verified: false,
    verificationSource: KNOWLEDGE_BASE_CANDIDATE_SOURCE,
    evidenceSource: KNOWLEDGE_BASE_CANDIDATE_SOURCE,
    diagnosticOnly: true,
    expression: raw,
    frameworkExpressions: { playwright: raw },
    strategy: kbEntry.strategy || 'css',
    toolName: toolName || null,
    pageUrl: resolvedUrl,
    elementLabel: elementLabel || kbEntry.element || null,
    targetFacts: {
      role: kbEntry.role || null,
      accessibleName: kbEntry.accessibleName || null,
    },
    context: { source: KNOWLEDGE_BASE_CANDIDATE_SOURCE, kbSource: true },
    proof: {
      count: null,
      sameElement: false,
      visible: null,
      enabled: null,
      source: KNOWLEDGE_BASE_CANDIDATE_SOURCE,
      verified: false,
      actionTimeResolved: false,
      actedNodeBound: false,
    },
    domAtlas,
  }, {
    source: KNOWLEDGE_BASE_CANDIDATE_SOURCE,
    reason: 'The locator came from historical Knowledge Base evidence and was not recertified against the current acted DOM node.',
  });
}

function locatorStabilityProven(evidence = {}) {
  const proof = evidence && typeof evidence === 'object' && evidence.proof && typeof evidence.proof === 'object'
    ? evidence.proof
    : evidence && typeof evidence === 'object' ? evidence : {};
  const countBefore = Number(proof.countBefore ?? evidence.countBefore);
  const countAfter = Number(proof.countAfter ?? evidence.countAfter);
  const sameFingerprint = clean(proof.fingerprintBefore || evidence.fingerprintBefore)
    && clean(proof.fingerprintBefore || evidence.fingerprintBefore) === clean(proof.fingerprintAfter || evidence.fingerprintAfter);
  return proof.stableAcrossSnapshots === true
    && countBefore === 1
    && countAfter === 1
    && (proof.sameElementAcrossSnapshots === true || !!sameFingerprint);
}

function locatorExpressionVolatility(expression) {
  const raw = clean(expression);
  if (!raw) return [];
  const warnings = [];
  const explicitTestContract = /getByTestId\s*\(|\[(?:data-qaai-(?:id|role|row-key)|data-testid|data-test-id|data-test|data-qa|data-cy|data-pw|data-automation-id)\s*=/i.test(raw);
  if (/\.(?:nth|first|last)\s*\(|:(?:nth-of-type|nth-child)\s*\(/i.test(raw)) warnings.push('positional_selector');
  if (!explicitTestContract) {
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(raw)) warnings.push('uuid_token');
    if (/(?:#|\[id\s*=\s*["'])\d{6,}(?:["']?\]|\b)/i.test(raw)) warnings.push('long_numeric_id');
    if (/(?:#|\[id\s*=\s*["'])[^"'\]\s]*(?:[-_:])\d{6,}(?:["']?\]|\b)/i.test(raw)) warnings.push('dynamic_numeric_suffix_id');
    if (/(?:#|\[id\s*=\s*["'])[^"'\]\s]*(?:[a-f0-9]{10,}|[a-z0-9]{16,})[^"'\]\s]*/i.test(raw)) warnings.push('hashed_id');
    if (/\.(?:css|sc|jss|makeStyles|Private|Mui|chakra|emotion|Styled|ng|ember|svelte|astro|v)[-_]?[a-z0-9_-]*/i.test(raw)) warnings.push('framework_generated_class');
    if (/\.[a-z_-]*[a-f0-9]{8,}[a-z0-9_-]*/i.test(raw)) warnings.push('hashed_class');
  }
  return Array.from(new Set(warnings));
}

function locatorExpressionIsExportSafe(expression, evidence = {}) {
  const raw = clean(expression);
  if (!raw) return false;
  if (/\.(?:first|nth|last)\s*\(/.test(raw)) return false;
  if (/:(?:nth-of-type|nth-child)\s*\(/i.test(raw)) return false;
  if (containsGlyphContamination(raw)) return false;
  if (/\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i.test(raw)) return false;
  if (/^getByRole\(\s*["'][^"']+["']\s*\)$/i.test(raw)) return false;
  const roleName = raw.match(/getByRole\(\s*["'][^"']+["']\s*,\s*\{\s*name\s*:\s*["']([^"']*)["']/i);
  if (roleName && isGlyphOnlyName(roleName[1])) return false;
  const volatility = locatorExpressionVolatility(raw);
  if (volatility.length && !locatorStabilityProven(evidence)) return false;
  return true;
}

function persistedAuthoritativeCdpProof(primary, proof, captureBinding) {
  if (!primary || !proof || captureBinding?.kind !== 'mcp_bound_ref') return false;
  const captureEvidence = primary.captureEvidence && typeof primary.captureEvidence === 'object'
    ? primary.captureEvidence
    : proof.captureEvidence && typeof proof.captureEvidence === 'object'
      ? proof.captureEvidence
      : null;
  const pre = captureEvidence?.pre && typeof captureEvidence.pre === 'object'
    ? captureEvidence.pre
    : null;
  const post = captureEvidence?.post && typeof captureEvidence.post === 'object'
    ? captureEvidence.post
    : null;
  const preBackendNodeId = Number(pre?.backendNodeId);
  const postBackendNodeId = Number(post?.backendNodeId);
  const bindingRef = clean(captureBinding.ref || captureBinding.targetRef || captureBinding.elementRef);
  const capturedRef = clean(
    captureEvidence?.targetRef ||
    captureEvidence?.ref ||
    pre?.targetRef ||
    pre?.ref ||
    post?.targetRef ||
    post?.ref,
  );
  const targetIdentity = proof.targetIdentity && typeof proof.targetIdentity === 'object'
    ? proof.targetIdentity
    : primary.targetIdentity && typeof primary.targetIdentity === 'object'
      ? primary.targetIdentity
      : null;
  const matchedIdentity = proof.matchedIdentity && typeof proof.matchedIdentity === 'object'
    ? proof.matchedIdentity
    : primary.matchedIdentity && typeof primary.matchedIdentity === 'object'
      ? primary.matchedIdentity
      : null;
  const identityNodeId = (identity) => clean(identity?.backendNodeId);
  const targetNodeId = identityNodeId(targetIdentity);
  const matchedNodeId = identityNodeId(matchedIdentity);
  const identityAgrees =
    (!targetNodeId || !matchedNodeId || targetNodeId === matchedNodeId) &&
    (!targetNodeId || targetNodeId === String(preBackendNodeId)) &&
    (!matchedNodeId || matchedNodeId === String(postBackendNodeId));

  return pre?.captured === true
    && post?.captured === true
    && pre?.authoritative === true
    && post?.authoritative === true
    && clean(pre?.source) === 'chromium_cdp'
    && clean(post?.source) === 'chromium_cdp'
    && Number.isInteger(preBackendNodeId)
    && preBackendNodeId > 0
    && Number.isInteger(postBackendNodeId)
    && postBackendNodeId > 0
    && preBackendNodeId === postBackendNodeId
    && (!bindingRef || !capturedRef || bindingRef === capturedRef)
    && identityAgrees
    && proof.verified === true
    && proof.actionTimeResolved === true
    && proof.sameElement === true
    && proof.identityVerified === true
    && proof.stableAcrossSnapshots === true
    && Number(proof.count) === 1;
}

function isVerifiedActionLocator(actionLocator) {
  if (!actionLocator || typeof actionLocator !== 'object') return false;
  if (actionLocator.kind === 'multi') {
    const fields = Array.isArray(actionLocator.fields) ? actionLocator.fields : [];
    return fields.length > 0 && fields.every((field) => isVerifiedActionLocator(field && field.actionLocator));
  }
  if (actionLocator.kind === 'drag') {
    return isVerifiedActionLocator(actionLocator.dragSourceLocator)
      && isVerifiedActionLocator(actionLocator.dragTargetLocator);
  }
  const primary = primaryActionLocator(actionLocator);
  if (!primary || primary.diagnosticOnly === true) return false;
  const proof = primary.proof && typeof primary.proof === 'object' ? primary.proof : {};
  const source = primary.verificationSource || primary.evidenceSource || proof.source || null;
  const expression = primary.frameworkExpressions?.playwright || primary.expression || null;
  const domAtlas = primary.domAtlas && typeof primary.domAtlas === 'object' ? primary.domAtlas : null;
  const captureBinding = primary.captureBinding || primary.context?.captureBinding || null;
  if (![AUTHORITATIVE_CHROMIUM_CDP_SOURCE, VERIFIED_DOM_INSPECTION_SOURCE, VERIFIED_STRUCTURAL_DOM_SOURCE, VERIFIED_COORDINATE_DOM_SOURCE].includes(source)) return false;
  if (
    source === VERIFIED_COORDINATE_DOM_SOURCE
      ? captureBinding?.kind !== 'coordinate_hit_test'
      : captureBinding?.kind !== 'mcp_bound_ref'
  ) return false;
  if (primary.verified !== true && proof.verified !== true) return false;
  const persistedCdpProof = source === AUTHORITATIVE_CHROMIUM_CDP_SOURCE
    && persistedAuthoritativeCdpProof(primary, proof, captureBinding);
  if (!actionTimeSameElementProof(proof) && !persistedCdpProof) return false;
  const legacyAuthoritativeProof =
    proof.authoritativeCdpVerified === true &&
    proof.backendNodeVerified === true &&
    proof.stableAcrossSnapshots === true &&
    !!domAtlas &&
    Array.isArray(domAtlas.verifiedActions) &&
    domAtlas.verifiedActions.length > 0;
  if (source === AUTHORITATIVE_CHROMIUM_CDP_SOURCE && !legacyAuthoritativeProof && !persistedCdpProof) return false;
  if (source !== AUTHORITATIVE_CHROMIUM_CDP_SOURCE
    && (!domAtlas || !Array.isArray(domAtlas.verifiedActions) || domAtlas.verifiedActions.length === 0)) return false;
  if (!locatorExpressionIsExportSafe(expression, primary)) return false;
  if (DIAGNOSTIC_SOURCES.has(String(source))) return false;
  return true;
}

function verifiedActionLocatorOrNull(actionLocator) {
  return isVerifiedActionLocator(actionLocator) ? actionLocator : null;
}

// ── EXPORT-SAFE bar (decoupled from the GOLD / verdict bar) ──────────────────
// THE architectural separation: a locator is EXPORT-SAFE when it carries a
// faithful, export-safe Playwright expression derived from the browser's own
// accessibility snapshot or DOM (accessibility snapshot, DOM inspection, DOM
// excavation, or the snapshot-ref fallback) — REGARDLESS of proof.count===1 /
// sameElement / a populated domAtlas.verifiedActions. Codegen / replay / step
// emission read THIS bar so that every executed action gets a real per-step
// locator; KB promotion + verdict keep reading the stricter isVerifiedActionLocator.
// This is what stops a perfect getByRole('button',{name:'Login'}) from being
// discarded just because its accessible name collides with another snapshot line.
const EXPORT_SAFE_SOURCES = new Set([
  AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
  VERIFIED_DOM_INSPECTION_SOURCE,
  VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
  VERIFIED_STRUCTURAL_DOM_SOURCE,
  VERIFIED_COORDINATE_DOM_SOURCE,
  ACTIVE_DOM_EXCAVATION_SOURCE,
  SEMANTIC_DOM_SCOUT_SOURCE,
  KNOWLEDGE_BASE_CANDIDATE_SOURCE,
  'snapshot_ref_fallback',
  'args',
  'legacy_dom_facts',
]);

function isExportSafeActionLocator(actionLocator) {
  if (!actionLocator || typeof actionLocator !== 'object') return false;
  if (actionLocator.kind === 'multi') {
    const fields = Array.isArray(actionLocator.fields) ? actionLocator.fields : [];
    return fields.length > 0 && fields.every((field) => isExportSafeActionLocator(field && field.actionLocator));
  }
  // GOLD is always export-safe.
  if (isVerifiedActionLocator(actionLocator)) return true;
  const primary = primaryActionLocator(actionLocator);
  if (!primary) return false;
  const proof = primary.proof && typeof primary.proof === 'object' ? primary.proof : {};
  const source = primary.verificationSource || primary.evidenceSource || proof.source || null;
  const expression = primary.frameworkExpressions?.playwright || primary.expression || null;
  if (primary.diagnosticOnly !== true || primary.guess?.isGuess !== true) return false;
  if (!EXPORT_SAFE_SOURCES.has(String(source))) return false;
  if (!locatorExpressionIsExportSafe(expression, primary)) return false;
  return true;
}

function exportSafeActionLocatorOrNull(actionLocator) {
  return isExportSafeActionLocator(actionLocator) ? actionLocator : null;
}

function actionLocatorNeedsPrecisionUpgrade(actionLocator, { toolName } = {}) {
  if (!isVerifiedActionLocator(actionLocator)) return true;
  const primary = primaryActionLocator(actionLocator);
  if (!primary) return true;
  const expression = primary.frameworkExpressions?.playwright || primary.expression || null;
  if (!locatorExpressionIsExportSafe(expression, primary)) return true;
  return !actionTimeSameElementProof(primary.proof || {});
}

function firstActionRef(toolName, args = {}) {
  const targets = targetRefsForTool(toolName, args || {});
  return targets[0]?.ref || clean(args.ref || (DOM_REF_RE.test(clean(args.target) || '') ? args.target : null)) || null;
}

function isLikelyTransientTarget(label = '', toolName = '') {
  const text = clean([label, toolName].filter(Boolean).join(' ')).toLowerCase();
  return /\b(dropdown|option|autocomplete|suggestion|menu|logout|popover|overlay|toast|modal)\b/.test(text);
}

function actionLocatorGap({ toolName, args = {}, pageUrl, elementLabel, snapshotText, diagnostic, strategiesTried = [], detail } = {}) {
  const label = elementLabel || clean(args.element || args.label || args.name || args.placeholder || args.role) || null;
  const ref = firstActionRef(toolName, args);
  const source = diagnostic?.verificationSource || diagnostic?.evidenceSource || diagnostic?.proof?.source || null;
  const tried = Array.from(new Set((strategiesTried || []).filter(Boolean)));
  return {
    code: 'missing_verified_action_locator',
    reason: 'excavation_failed',
    nonBlocking: true,
    where: toolName || 'mutating_action',
    toolName: toolName || null,
    ref,
    elementLabel: label,
    strategiesTried: tried,
    pageUrl: pageUrl || null,
    transient: isLikelyTransientTarget(label || '', toolName || ''),
    detail: detail || 'No locator candidate verified count=1 and sameElement=true.',
    hasRef: !!ref,
    hasSnapshot: !!snapshotText,
    diagnosticSource: source,
  };
}

function locatorEvidenceOptions(options = {}, actionLocator = null) {
  const args = options.args && typeof options.args === 'object' ? options.args : {};
  const contractNode = options.contractNode && typeof options.contractNode === 'object' ? options.contractNode : {};
  const session = options.session && typeof options.session === 'object' ? options.session : {};
  const actionIdentity = options.actionIdentity && typeof options.actionIdentity === 'object'
    ? options.actionIdentity
    : args.actionIdentity && typeof args.actionIdentity === 'object'
      ? args.actionIdentity
      : contractNode.actionIdentity && typeof contractNode.actionIdentity === 'object'
        ? contractNode.actionIdentity
        : {};
  const normalizedActionIdentity = { ...actionIdentity };
  for (const field of [
    'schemaVersion',
    'caseId',
    'contractStepId',
    'sourceContractStepId',
    'authoredStepId',
    'authoredActionId',
    'actionOccurrenceId',
    'sourceActionOccurrenceId',
    'occurrenceKey',
    'occurrenceOrdinal',
    'sequenceIndex',
    'toolUseId',
    'toolName',
    'operation',
  ]) {
    const value = options[field] ?? args[field] ?? contractNode[field];
    if (value !== undefined && value !== null && value !== '') normalizedActionIdentity[field] = value;
  }
  return {
    actionLocator,
    actionIdentity: normalizedActionIdentity,
    contractStepId: options.contractStepId || args.contractStepId || normalizedActionIdentity.contractStepId || contractNode.contractStepId || contractNode.id || null,
    sourceContractStepId: options.sourceContractStepId || args.sourceContractStepId || normalizedActionIdentity.sourceContractStepId || contractNode.sourceContractStepId || null,
    actionOccurrenceId: options.actionOccurrenceId || args.actionOccurrenceId || normalizedActionIdentity.actionOccurrenceId || contractNode.actionOccurrenceId || null,
    sourceActionOccurrenceId: options.sourceActionOccurrenceId || args.sourceActionOccurrenceId || normalizedActionIdentity.sourceActionOccurrenceId || contractNode.sourceActionOccurrenceId || null,
    authoredActionId: options.authoredActionId || args.authoredActionId || normalizedActionIdentity.authoredActionId || contractNode.authoredActionId || null,
    sequenceIndex: options.sequenceIndex ?? args.sequenceIndex ?? normalizedActionIdentity.sequenceIndex ?? contractNode.sequenceIndex ?? null,
    pageUrl: options.pageUrl || actionLocator?.pageUrl || null,
    pageAlias: options.pageAlias || session.activePageAlias || session.pageAlias || null,
    tabAlias: options.tabAlias || session.activeTabAlias || session.tabAlias || null,
    popupIdentity: options.popupIdentity || session.activePopupIdentity || session.popupIdentity || null,
    contextTransition: options.contextTransition || options.transitionProof || null,
    containerScope: options.containerScope || null,
    repeatedFieldScope: options.repeatedFieldScope || null,
    fieldIndex: options.fieldIndex ?? null,
    capturedAt: options.capturedAt || null,
  };
}

function propagateLocatorEvidence(actionLocator, options = {}) {
  if (!actionLocator || typeof actionLocator !== 'object') return actionLocator || null;
  return buildLocatorEvidenceRecord(locatorEvidenceOptions(options, actionLocator)).locator;
}

async function resolveForTool(options = {}) {
  const { session, toolName, args, snapshotText, pageUrl, elementLabel } = options;
  if (!MUTATING_ELEMENT_TOOLS.has(toolName)) return null;
  const targets = targetRefsForTool(toolName, args || {});
  if (!targets.length) {
    if (COORDINATE_ELEMENT_TOOLS.has(toolName)) {
      const coordinateLocator = await captureCoordinateLocator({
        session,
        toolName,
        args: args || {},
        pageUrl,
        element: elementLabel || clean(args?.element || args?.label || args?.name || args?.target || ''),
      });
      if (coordinateLocator) return propagateLocatorEvidence(coordinateLocator, options);
    }
    return propagateLocatorEvidence(buildFallbackFromArgs({ toolName, args: args || {}, pageUrl, elementLabel }), options);
  }

  const resolveBoundTarget = async (target, targetArgs, targetLabel, fieldIndex = null) => {
    let authoritativeCdp = null;
    if (typeof mcp.captureAuthoritativeActionTarget === 'function') {
      try {
        const captureIdentity = locatorEvidenceOptions({ ...options, args: targetArgs || args || {}, fieldIndex });
        authoritativeCdp = await mcp.captureAuthoritativeActionTarget(session, {
          ref: target.ref,
          element: targetLabel,
          pageUrl,
          phase: 'pre_action',
          actionIdentity: captureIdentity.actionIdentity,
          contractStepId: captureIdentity.contractStepId,
          sourceContractStepId: captureIdentity.sourceContractStepId,
          actionOccurrenceId: captureIdentity.actionOccurrenceId,
          sourceActionOccurrenceId: captureIdentity.sourceActionOccurrenceId,
          authoredActionId: captureIdentity.authoredActionId,
          sequenceIndex: captureIdentity.sequenceIndex,
          pageAlias: captureIdentity.pageAlias,
          tabAlias: captureIdentity.tabAlias,
          popupIdentity: captureIdentity.popupIdentity,
          contextTransition: captureIdentity.contextTransition,
          fieldIndex,
        });
      } catch (_) {
        authoritativeCdp = null;
      }
    }
    const authoritativeLocator = buildActionLocatorFromAuthoritativeCapture({
      toolName,
      args: targetArgs || {},
      capture: authoritativeCdp,
      pageUrl,
      elementLabel: targetLabel,
      fieldIndex,
    });
    if (isVerifiedActionLocator(authoritativeLocator)) return authoritativeLocator;
    const authoritativeCaptureAvailable = authoritativeCdp?.captured === true
      && authoritativeCdp?.authoritative === true
      && Number(authoritativeCdp?.identity?.backendNodeId) > 0;
    let diagnosticCandidate = null;
    try {
      const inspection = await inspectRef({ session, ref: target.ref, element: targetLabel });
      const inspected = buildActionLocatorFromInspection({
        toolName,
        args: targetArgs || {},
        inspection,
        pageUrl,
        elementLabel: targetLabel,
        fieldIndex,
      });
      if (isVerifiedActionLocator(inspected)) {
        if (!authoritativeCaptureAvailable) return inspected;
        const reverified = await reverifyCandidateAgainstAuthoritativeCapture({
          session,
          actionLocator: inspected,
          capture: authoritativeCdp,
        });
        if (isVerifiedActionLocator(reverified)) return reverified;
        diagnosticCandidate = markLocatorGuess(attachAuthoritativeCdpEvidence(inspected, authoritativeCdp), {
          source: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
          reason: 'The legacy DOM candidate did not reverify uniquely against the authoritative CDP backend node across stabilization.',
        });
      }
    } catch (_) {}

    try {
      const structural = await captureStructuralLocator({
        ...options,
        session,
        ref: target.ref,
        element: targetLabel,
        pageUrl,
      });
      if (isVerifiedActionLocator(structural)) {
        if (!authoritativeCaptureAvailable) return structural;
        const reverified = await reverifyCandidateAgainstAuthoritativeCapture({
          session,
          actionLocator: structural,
          capture: authoritativeCdp,
        });
        if (isVerifiedActionLocator(reverified)) return reverified;
        if (!diagnosticCandidate) {
          diagnosticCandidate = markLocatorGuess(attachAuthoritativeCdpEvidence(structural, authoritativeCdp), {
            source: AUTHORITATIVE_CHROMIUM_CDP_SOURCE,
            reason: 'The structural DOM candidate did not reverify uniquely against the authoritative CDP backend node across stabilization.',
          });
        }
      }
    } catch (_) {}

    return diagnosticCandidate || buildFallbackFromSnapshotRef({
      ...options,
      toolName,
      args: targetArgs || {},
      snapshotText,
      pageUrl,
      elementLabel: targetLabel,
      fieldIndex,
    }) || buildFallbackFromArgs({ toolName, args: targetArgs || {}, pageUrl, elementLabel: targetLabel });
  };

  if (toolName === 'browser_fill_form') {
    const fields = [];
    let domAtlas = null;
    for (const target of targets) {
      const fieldArgs = target.field || { ref: target.ref, element: target.element };
      const actionLocator = await resolveBoundTarget(target, fieldArgs, target.element, target.index);
      if (actionLocator && !domAtlas) domAtlas = domAtlasFromActionLocator(actionLocator);
      fields.push({
        index: target.index,
        ref: target.ref,
        name: target.element,
        actionLocator: actionLocator || null,
        missingLocator: !actionLocator,
      });
    }
    return fields.length ? propagateLocatorEvidence({
      kind: 'multi',
      toolName,
      pageUrl: pageUrl || null,
      fields,
      ...(domAtlas ? { domAtlas } : {}),
    }, options) : null;
  }

  if (toolName === 'browser_drag') {
    const sourceTarget = targets.find((target) => target.endpoint === 'source') || null;
    const destinationTarget = targets.find((target) => target.endpoint === 'target') || null;
    const sourceLocator = sourceTarget
      ? await resolveBoundTarget(sourceTarget, args || {}, sourceTarget.element)
      : null;
    const destinationLocator = destinationTarget
      ? await resolveBoundTarget(destinationTarget, args || {}, destinationTarget.element)
      : null;
    const primary = destinationLocator || sourceLocator;
    if (!primary) return null;
    return {
      ...primary,
      kind: 'drag',
      toolName,
      dragSourceLocator: sourceLocator ? propagateLocatorEvidence(sourceLocator, options) : null,
      dragTargetLocator: destinationLocator ? propagateLocatorEvidence(destinationLocator, options) : null,
    };
  }

  const target = targets[0];
  return propagateLocatorEvidence(
    await resolveBoundTarget(target, args || {}, elementLabel || target.element),
    options,
  );
}

async function fulfillForTool(options = {}) {
  const args = options.args || {};
  const strategiesTried = [];
  const coordinateAction = COORDINATE_ELEMENT_TOOLS.has(options.toolName);
  if (firstActionRef(options.toolName, args)) {
    strategiesTried.push('bound_ref_dom_inspection', 'bound_ref_structural_resolution', 'snapshot_ref_candidate');
  } else if (coordinateAction) {
    strategiesTried.push('visual_coordinate_dom_probe');
  } else {
    strategiesTried.push('args_fallback');
  }
  const firstPass = await resolveForTool(options);
  if (isVerifiedActionLocator(firstPass)) {
    return {
      ok: true,
      actionLocator: firstPass,
      diagnostic: null,
      gap: null,
      fulfilledBy: firstPass.verificationSource || firstPass.evidenceSource || 'verified_locator',
    };
  }
  let scout = null;
  let excavated = null;
  try {
    strategiesTried.push('scoped_role');
    scout = await activeScout(options);
    excavated = propagateLocatorEvidence(buildActionLocatorFromScout({
      toolName: options.toolName,
      args: options.args || {},
      scout,
      pageUrl: options.pageUrl,
      elementLabel: options.elementLabel,
    }), options);
  } catch (_) {
    scout = null;
    excavated = null;
  }
  if (isVerifiedActionLocator(excavated)) {
    return {
      ok: true,
      actionLocator: excavated,
      diagnostic: firstPass || null,
      gap: null,
      scout,
      fulfilledBy: ACTIVE_DOM_EXCAVATION_SOURCE,
    };
  }
  if (excavated) {
    return {
      ok: false,
      actionLocator: excavated,
      diagnostic: firstPass || null,
      gap: coordinateAction
        ? coordinateGap({
            toolName: options.toolName,
            args,
            pageUrl: options.pageUrl,
            elementLabel: options.elementLabel,
            strategiesTried,
            detail: 'Coordinate/vision action resolved only diagnostic locator evidence; no DOM candidate proved count=1 and sameElement=true.',
          })
        : actionLocatorGap({
            toolName: options.toolName,
            args,
            pageUrl: options.pageUrl,
            elementLabel: options.elementLabel,
            snapshotText: options.snapshotText,
            diagnostic: excavated,
            strategiesTried,
            detail: 'Active DOM excavation produced only diagnostic locator evidence; no candidate verified count=1 and sameElement=true.',
          }),
      scout,
      fulfilledBy: ACTIVE_DOM_EXCAVATION_SOURCE,
    };
  }
  const diagnostic = firstPass || null;
  return {
    ok: false,
    actionLocator: firstPass || null,
    diagnostic,
    scout,
    gap: coordinateAction
      ? coordinateGap({
          toolName: options.toolName,
          args,
          pageUrl: options.pageUrl,
          elementLabel: options.elementLabel,
          strategiesTried,
        })
      : actionLocatorGap({
          toolName: options.toolName,
          args,
          pageUrl: options.pageUrl,
          elementLabel: options.elementLabel,
          snapshotText: options.snapshotText,
          diagnostic,
          strategiesTried,
          detail: 'Active locator scout could not fulfill this action from current DOM state.',
        }),
  };
}

async function forceExcavateDeepLocator(optionsOrSession = {}, maybeToolCall = null, maybeContractNode = null) {
  const options = maybeToolCall
    ? {
        session: optionsOrSession && optionsOrSession.client ? optionsOrSession : optionsOrSession?.session,
        toolName: maybeToolCall.name || maybeToolCall.toolName || maybeToolCall.tool,
        args: maybeToolCall.args || maybeToolCall.input || {},
        pageUrl: maybeToolCall.pageUrl || null,
        elementLabel: clean(maybeToolCall.args?.element || maybeToolCall.args?.label || maybeToolCall.args?.name || maybeToolCall.element || maybeContractNode?.plannedText || ''),
        contractNode: maybeContractNode || null,
      }
    : { ...(optionsOrSession || {}) };
  const session = options.session;
  const toolName = options.toolName;
  const args = options.args || {};
  if (!session?.client || typeof session.client.callTool !== 'function') {
    return null;
  }

  const targetLabel = clean(
    options.elementLabel ||
    args.element ||
    args.label ||
    args.name ||
    args.placeholder ||
    args.role ||
    options.contractNode?.raw?.target ||
    options.contractNode?.plannedText ||
    ''
  );
  const payload = {
    toolName,
    args,
    targetLabel,
    contractStepId: options.contractNode?.contractStepId || null,
  };

  const excavation = await session.client.callTool({
    name: 'browser_evaluate',
    arguments: {
      // MCP 0.0.75: use `function` (callable async arrow), not `expression` (removed).
      function: `async () => { return await (${async function qaaiForceExcavateDeepLocator(payload) {
        const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
        const lower = (value) => clean(value).toLowerCase();
        const targetText = lower(payload && payload.targetLabel);
        const args = payload && payload.args || {};
        const argNeedles = [
          targetText,
          lower(args.element),
          lower(args.label),
          lower(args.name),
          lower(args.placeholder),
          lower(args.role),
          lower(args.text),
        ].filter(Boolean);
        const visible = (node) => {
          if (!node || node.nodeType !== 1) return false;
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
        };
        const enabled = (node) => {
          if (!node || node.nodeType !== 1) return false;
          return !node.disabled && node.getAttribute('aria-disabled') !== 'true';
        };
        const actionable = (node) => visible(node) && enabled(node);
        const textOf = (node) => clean([
          node && node.getAttribute && node.getAttribute('aria-label'),
          node && node.getAttribute && node.getAttribute('title'),
          node && node.getAttribute && node.getAttribute('placeholder'),
          node && node.getAttribute && node.getAttribute('name'),
          node && node.textContent,
        ].filter(Boolean).join(' '));
        const roleOf = (node) => lower(node && node.getAttribute && node.getAttribute('role'));
        const selectorFor = (node) => {
          if (!node || node.nodeType !== 1) return null;
          const cssEscape = (value) => {
            if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
            return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
          };
          for (const attr of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id', 'aria-label', 'name', 'id']) {
            const value = node.getAttribute && node.getAttribute(attr);
            if (value) return attr === 'id' ? `#${cssEscape(value)}` : `${node.tagName.toLowerCase()}[${attr}="${String(value).replace(/"/g, '\\"')}"]`;
          }
          const parts = [];
          let cur = node;
          while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
            let part = cur.tagName.toLowerCase();
            if (cur.id) {
              part += `#${cssEscape(cur.id)}`;
              parts.unshift(part);
              break;
            }
            const parent = cur.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.tagName === cur.tagName);
              if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
            }
            parts.unshift(part);
            cur = parent;
          }
          return parts.length ? parts.join(' > ') : null;
        };
        const all = Array.from(document.querySelectorAll('*'));
        const target = all.find((node) => {
          const hay = lower(textOf(node));
          return argNeedles.some((needle) => hay === needle || hay.includes(needle));
        }) || null;
        const interactiveSelector = [
          'button',
          'a[href]',
          'summary',
          '[role="button"]',
          '[role="menu"]',
          '[role="menuitem"]',
          '[role="combobox"]',
          '[role="listbox"]',
          '[aria-haspopup]',
          '[aria-expanded]',
          '.dropdown-toggle',
          '.dropdown',
          '.menu',
          '.menu-toggle',
          '[data-toggle="dropdown"]',
          '[data-bs-toggle="dropdown"]',
        ].join(',');
        const triggerCandidates = [];
        if (target) {
          let cur = target;
          while (cur && cur.nodeType === 1 && cur !== document.body) {
            if (cur.matches && cur.matches(interactiveSelector)) triggerCandidates.push(cur);
            cur = cur.parentElement;
          }
        }
        for (const node of all) {
          if (!node.matches || !node.matches(interactiveSelector)) continue;
          const hay = lower(textOf(node));
          const role = roleOf(node);
          const expanded = node.getAttribute('aria-expanded');
          if (argNeedles.some((needle) => hay.includes(needle)) || expanded === 'false' || ['button', 'menu', 'menuitem', 'combobox'].includes(role)) {
            triggerCandidates.push(node);
          }
        }
        const uniqueTriggers = [...new Set(triggerCandidates)].filter(actionable).slice(0, 8);
        const exposedBy = [];
        // Evidence collection is read-only. Do not click, hover, focus, scroll,
        // or dispatch synthetic events from a guessed trigger. The authored
        // browser action is the only allowed page mutation.
        void uniqueTriggers;
        const nowVisible = all.concat(Array.from(document.querySelectorAll('*'))).some((node) => {
          const hay = lower(textOf(node));
          return actionable(node) && argNeedles.some((needle) => hay === needle || hay.includes(needle));
        });
        return {
          ok: exposedBy.length > 0 || nowVisible,
          targetLabel: payload && payload.targetLabel || null,
          exposedBy,
          nowVisible,
          url: window.location.href,
        };
      }})(${JSON.stringify(payload)}); }`,
    },
  });
  if (excavation?.isError) {
    // DOM script threw in the browser (CSP, async-unsupported, or SPA guard).
    // Don't fatal immediately — fall through to snapshot-based resolution which doesn't
    // run browser-side JS. Only throw at line 2101 if that also fails.
    console.warn('[excavation] DOM script failed for', targetLabel || toolName, '— falling back to snapshot resolver');
  }

  const snapshot = await session.client.callTool({ name: 'browser_snapshot', arguments: {} }).catch(() => null);
  const snapshotText = mcp.textOfContent(snapshot?.content) || options.snapshotText || '';
  const verified = await resolveVerifiedForTool({
    ...options,
    session,
    toolName,
    args,
    snapshotText,
    pageUrl: options.pageUrl || null,
    elementLabel: targetLabel,
  });
  if (verified && isVerifiedActionLocator(verified.actionLocator)) {
    return verified.actionLocator;
  }
  return null;
}

// ── NEVER-FAIL STRUCTURAL CAPTURE (Phase A) ─────────────────────────────────
// Resolves the model's snapshot REF to the REAL DOM element (the browser knows
// exactly which node a ref is — no text-matching a descriptor label that a
// nameless <div> never contains) and computes a GUARANTEED-UNIQUE, export-safe
// Playwright locator via a readable ladder. Because a full structural CSS path
// from the document root is unique BY CONSTRUCTION, this cannot return "not
// captured": any element the agent successfully interacted with yields a
// locator. Verifies uniqueness in-page (querySelectorAll length === 1) before
// returning. Codegen-only (verified:false → never KB/verdict-promoted), but
// export-safe so the emitter ships it. This is what eliminates locator_gap.
const LEGACY_STRUCTURAL_SELECTOR_FN = `(${function qaaiStructuralSelector(el) {
  if (!el || el.nodeType !== 1) return { ok: false };
  const cssEsc = (v) => (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(String(v)) : String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c);
  const uniq = (sel) => { try { return !!sel && document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
  // Skip framework-generated dynamic ids/classes — they change every render.
  const isDynamicId = (id) => !id || /\\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}|:r[0-9a-z]+:|^ember\\d+|^ng-|^cdk-|^mat-|^react-/i.test(String(id));
  const tag = el.tagName.toLowerCase();
  const norm = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const role = (el.getAttribute && el.getAttribute('role')) || null;
  const ariaName = (el.getAttribute && el.getAttribute('aria-label')) || (el.getAttribute && el.getAttribute('name')) || null;
  const mk = (strategy, selector, playwright) => ({ ok: true, strategy, selector: selector || null, playwright, tag, role, name: ariaName });

  // 1. stable test-id attributes
  for (const a of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v) { const s = '[' + a + '="' + String(v).replace(/"/g, '\\\\"') + '"]'; if (uniq(s)) return mk(a === 'data-testid' ? 'testid' : (a.indexOf('data-qaai-') === 0 ? 'qaai-attr' : 'css-attr'), s, a === 'data-testid' ? 'getByTestId(' + JSON.stringify(v) + ')' : "locator('" + s.replace(/'/g, "\\\\'") + "')"); }
  }
  // 2. static id
  if (el.id && !isDynamicId(el.id)) { const s = '#' + cssEsc(el.id); if (uniq(s)) return mk('id', s, "locator('" + s.replace(/'/g, "\\\\'") + "')"); }
  // 3. name attribute (form fields)
  const nm = el.getAttribute && el.getAttribute('name');
  if (nm) { const s = tag + '[name="' + String(nm).replace(/"/g, '\\\\"') + '"]'; if (uniq(s)) return mk('name', s, "locator('" + s.replace(/'/g, "\\\\'") + "')"); }
  // 4. label association → getByLabel (readable + stable)
  if (el.id) { try { const lab = document.querySelector('label[for="' + cssEsc(el.id) + '"]'); const t = lab && norm(lab.textContent); if (t) return mk('label', null, 'getByLabel(' + JSON.stringify(t) + ')'); } catch (_) {} }
  { let p = el.parentElement, g = 0; while (p && p !== document.body && g++ < 6) { if (p.tagName === 'LABEL') { const t = norm(p.textContent); if (t) return mk('label', null, 'getByLabel(' + JSON.stringify(t) + ')'); break; } p = p.parentElement; } }
  // 5. aria-label
  const al = el.getAttribute && el.getAttribute('aria-label'); if (al && norm(al)) return mk('aria', null, 'getByLabel(' + JSON.stringify(norm(al)) + ')');
  // 6. placeholder
  const ph = el.getAttribute && el.getAttribute('placeholder'); if (ph && norm(ph)) return mk('placeholder', null, 'getByPlaceholder(' + JSON.stringify(norm(ph)) + ')');
  // 7. minimal unique CSS path (unique by construction)
  const parts = []; let cur = el, guard = 0;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement && guard++ < 30) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && !isDynamicId(cur.id)) { parts.unshift('#' + cssEsc(cur.id)); const s0 = parts.join(' > '); if (uniq(s0)) return mk('css_path', s0, "locator('" + s0.replace(/'/g, "\\\\'") + "')"); break; }
    const parent = cur.parentElement;
    if (parent) { const sib = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName); if (sib.length > 1) part += ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')'; }
    parts.unshift(part);
    const sofar = parts.join(' > ');
    if (uniq(sofar)) return mk('css_path', sofar, "locator('" + sofar.replace(/'/g, "\\\\'") + "')");
    cur = parent;
  }
  const full = parts.join(' > ');
  if (uniq(full)) return mk('css_path', full, "locator('" + full.replace(/'/g, "\\\\'") + "')");
  return { ok: false };
}})`;

const STRUCTURAL_SELECTOR_FN = `(${function qaaiPreciseStructuralSelector(el) {
  if (!el || el.nodeType !== 1) return { ok: false };
  const nodeIdentityOf = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const key = '__qaaiNodeIdentityV1';
    let state = window[key];
    if (!state || state.document !== document || !(state.nodes instanceof WeakMap)) {
      const timeOrigin = Math.round(Number(window.performance && window.performance.timeOrigin) || Date.now());
      state = { document, documentId: `doc:${timeOrigin}:${String(window.location?.origin || '')}${String(window.location?.pathname || '/')}`, nextNodeId: 1, nodes: new WeakMap() };
      try { Object.defineProperty(window, key, { value: state, configurable: true, writable: true }); }
      catch (_) { window[key] = state; }
    }
    let nodeId = state.nodes.get(node);
    if (!nodeId) { nodeId = `node:${state.nextNodeId++}`; state.nodes.set(node, nodeId); }
    return { scheme: 'qaai-dom-node-v1', documentId: state.documentId, nodeId, connected: node.isConnected !== false, tag: String(node.tagName || '').toLowerCase() || null };
  };
  const cssEsc = (v) => (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(String(v)) : String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c);
  const cssAttr = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const all = (selector, root) => {
    const out = [];
    const seen = new Set();
    const visit = (scope) => {
      if (!scope || typeof scope.querySelectorAll !== 'function') return;
      let matches = [];
      let nodes = [];
      try {
        matches = Array.from(scope.querySelectorAll(selector));
        nodes = selector === '*' ? matches : Array.from(scope.querySelectorAll('*'));
      } catch (_) { return; }
      for (const node of matches) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }
      for (const node of nodes) {
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(root || document);
    return out;
  };
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const enabled = (node) => !!node && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const isDynamicId = (id) => !id || /\\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}|:r[0-9a-z]+:|^ember\\d+|^ng-|^cdk-|^mat-|^react-/i.test(String(id));
  const isDynamicValue = (value) => {
    const raw = String(value || '');
    if (!raw || raw.length > 100) return true;
    return /(?:^|[-_])(?:[a-f0-9]{8,}|[a-z0-9]{12,})(?:$|[-_])/i.test(raw)
      || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(raw);
  };
  const tag = el.tagName.toLowerCase();
  const norm = (s, max = 220) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, max);
  const attr = (node, name) => node && node.getAttribute ? norm(node.getAttribute(name)) : '';
  const implicitRole = (node) => {
    const explicit = attr(node, 'role').toLowerCase();
    if (explicit) return explicit;
    const nodeTag = String(node && node.tagName || '').toLowerCase();
    const type = attr(node, 'type').toLowerCase();
    if (nodeTag === 'button') return 'button';
    if (nodeTag === 'a' && attr(node, 'href')) return 'link';
    if (nodeTag === 'textarea') return 'textbox';
    if (nodeTag === 'select') return 'combobox';
    if (nodeTag === 'option') return 'option';
    if (nodeTag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (['email', 'tel', 'text', 'url', 'password', 'number', ''].includes(type)) return 'textbox';
    }
    return '';
  };
  const labelsFor = (node) => {
    const labels = [];
    if (node && node.labels) {
      for (const label of Array.from(node.labels)) {
        const text = norm(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const id = attr(node, 'id');
    if (id) {
      for (const label of all('label[for="' + cssAttr(id) + '"]')) {
        const text = norm(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const wrapper = node.closest && node.closest('label');
    if (wrapper) {
      const text = norm(wrapper.innerText || wrapper.textContent);
      if (text) labels.push(text);
    }
    return Array.from(new Set(labels)).slice(0, 4);
  };
  const accessibleName = (node) => {
    const nodeTag = String(node && node.tagName || '').toLowerCase();
    return norm(attr(node, 'aria-label') || labelsFor(node)[0] || attr(node, 'placeholder') ||
      attr(node, 'title') || attr(node, 'alt') || attr(node, 'value') ||
      (['button', 'a', 'option', 'summary'].includes(nodeTag) ? node.innerText || node.textContent : ''));
  };
  const textOf = (node) => norm(node && (node.innerText || node.textContent), 180);
  const locatorCall = (selector) => 'locator(' + JSON.stringify(selector) + ')';
  const roleCall = (role, name) => 'getByRole(' + JSON.stringify(role) + ', { name: ' + JSON.stringify(name) + ' })';
  const selectorIsExportSafe = (selector) => {
    const raw = norm(selector);
    return !!raw && !/:(?:nth-of-type|nth-child)\s*\(/i.test(raw) && !/\[ref\s*=/i.test(raw);
  };
  const frameSelector = (frame) => {
    if (!frame) return '';
    const frameTag = String(frame.tagName || '').toLowerCase();
    const frameAttr = (name) => frame.getAttribute ? norm(frame.getAttribute(name)) : '';
    const id = frameAttr('id');
    if (id && !isDynamicValue(id)) return frameTag + '#' + cssEsc(id);
    for (const a of ['name', 'title', 'src', 'data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
      const v = frameAttr(a);
      if (v && !isDynamicValue(v)) return frameTag + '[' + a + '="' + cssAttr(v) + '"]';
    }
    return '';
  };
  const frameContext = () => {
    const framePath = [];
    let cursor = window;
    let selectorMissing = false;
    let guard = 0;
    try {
      while (cursor && guard++ < 8) {
        const frame = cursor.frameElement;
        if (!frame) break;
        const selector = frameSelector(frame);
        if (!selector) {
          selectorMissing = true;
          break;
        }
        framePath.unshift(selector);
        const parentWindow = cursor.parent;
        if (!parentWindow || parentWindow === cursor) break;
        cursor = parentWindow;
      }
    } catch (_) {
      selectorMissing = true;
    }
    return {
      inFrame: framePath.length > 0 || selectorMissing,
      selector: framePath.length ? framePath[framePath.length - 1] : '',
      framePath,
      selectorMissing,
    };
  };
  const stableShadowHostSelector = (node) => {
    if (!node || node.nodeType !== 1) return '';
    const nodeTag = node.tagName.toLowerCase();
    const nodeId = attr(node, 'id');
    if (nodeId && !isDynamicId(nodeId)) {
      const selector = nodeTag + '#' + cssEsc(nodeId);
      const matches = all(selector);
      if (matches.length === 1 && matches[0] === node) return selector;
    }
    for (const a of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id', 'aria-label', 'name']) {
      const v = attr(node, a);
      if (!v || isDynamicValue(v)) continue;
      const selector = nodeTag + '[' + a + '="' + cssAttr(v) + '"]';
      const matches = all(selector);
      if (matches.length === 1 && matches[0] === node) return selector;
    }
    return '';
  };
  const shadowContext = () => {
    try {
      const shadowPath = [];
      const hostTags = [];
      let node = el;
      let immediateRoot = null;
      let immediateHost = null;
      let guard = 0;
      while (node && guard++ < 8) {
        const root = node.getRootNode && node.getRootNode();
        const host = root && root.host && root.mode !== 'closed' ? root.host : null;
        if (!host) break;
        if (!immediateRoot) {
          immediateRoot = root;
          immediateHost = host;
        }
        const selector = stableShadowHostSelector(host);
        if (!selectorIsExportSafe(selector)) {
          return { hostSelector: null, hostSelectorMissing: true, shadowPath, shadowPathMissing: true, hostTags, root: immediateRoot, host: immediateHost };
        }
        shadowPath.unshift(selector);
        hostTags.unshift(String(host.tagName || '').toLowerCase());
        node = host;
      }
      if (!shadowPath.length) return null;
      return {
        hostSelector: shadowPath[shadowPath.length - 1],
        hostSelectorMissing: false,
        shadowPath,
        shadowPathMissing: false,
        hostTags,
        root: immediateRoot,
        host: immediateHost,
      };
    } catch (_) {
      return null;
    }
  };
  const frameCtx = frameContext();
  const shadowCtx = shadowContext();
  const mk = (strategy, selector, playwright, matches, extra) => {
    const sameElement = matches.length === 1 && matches[0] === el;
    const targetIdentity = nodeIdentityOf(el);
    const matchedIdentity = matches.length === 1 ? nodeIdentityOf(matches[0]) : null;
    return ({
    ok: true,
    strategy,
    selector: selector || null,
    playwright,
    inFrame: frameCtx.inFrame === true,
    frameSelector: frameCtx.selector || null,
    framePath: frameCtx.framePath || [],
    frameSelectorMissing: frameCtx.selectorMissing === true,
    framePathMissing: frameCtx.selectorMissing === true,
    shadowHostSelector: shadowCtx && shadowCtx.hostSelector || null,
    shadowPath: shadowCtx && shadowCtx.shadowPath || [],
    shadowPathMissing: shadowCtx && shadowCtx.shadowPathMissing === true,
    tag,
    role: implicitRole(el) || null,
    name: accessibleName(el) || null,
    proof: {
      count: matches.length,
      sameElement,
      visible: visible(el),
      enabled: enabled(el),
      verified: sameElement,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref_structural',
      targetIdentity,
      matchedIdentity,
      identityVerified: sameElement
        && !!targetIdentity
        && !!matchedIdentity
        && targetIdentity.documentId === matchedIdentity.documentId
        && targetIdentity.nodeId === matchedIdentity.nodeId,
      source: 'verified_structural_dom',
    },
    ...(extra || {}),
  });
  };
  const exact = (strategy, selector, playwright, matches, extra) =>
    (matches.length === 1 && matches[0] === el) ? mk(strategy, selector, playwright, matches, extra) : null;
  const role = implicitRole(el);
  const name = accessibleName(el);
  const label = labelsFor(el)[0] || attr(el, 'aria-label');
  const placeholder = attr(el, 'placeholder');
  const matchRole = (root) => all('*', root).filter((node) => implicitRole(node) === role && accessibleName(node) === name);
  const matchLabel = (root) => all('input, textarea, select', root).filter((node) => labelsFor(node).includes(label) || attr(node, 'aria-label') === label);
  const matchPlaceholder = (root) => all('input, textarea', root).filter((node) => attr(node, 'placeholder') === placeholder);

  for (const a of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
    const v = attr(el, a);
    if (!v || isDynamicValue(v)) continue;
    const selector = '[' + a + '="' + cssAttr(v) + '"]';
    const expr = a === 'data-testid' ? 'getByTestId(' + JSON.stringify(v) + ')' : locatorCall(selector);
    const hit = exact(a === 'data-testid' ? 'testId' : (a.indexOf('data-qaai-') === 0 ? 'qaai-attr' : 'css-attr'), selector, expr, all(selector));
    if (hit) return hit;
  }
  const id = attr(el, 'id');
  if (id && !isDynamicId(id)) {
    const selector = '#' + cssEsc(id);
    const hit = exact('id', selector, locatorCall(selector), all(selector));
    if (hit) return hit;
  }
  for (const a of ['name', 'autocomplete', 'aria-label', 'title', 'alt']) {
    const v = attr(el, a);
    if (!v || isDynamicValue(v)) continue;
    const selector = tag + '[' + a + '="' + cssAttr(v) + '"]';
    const hit = exact(a === 'aria-label' ? 'aria' : a, selector, locatorCall(selector), all(selector));
    if (hit) return hit;
  }
  if (role && name) {
    const hit = exact('role', null, roleCall(role, name), matchRole(document));
    if (hit) return hit;
  }
  if (label) {
    const hit = exact('label', null, 'getByLabel(' + JSON.stringify(label) + ')', matchLabel(document));
    if (hit) return hit;
  }
  if (placeholder) {
    const hit = exact('placeholder', null, 'getByPlaceholder(' + JSON.stringify(placeholder) + ')', matchPlaceholder(document));
    if (hit) return hit;
  }
  if (tag === 'input' && attr(el, 'type').toLowerCase() === 'password') {
    const hit = exact('password_type', 'input[type="password"]', locatorCall('input[type="password"]'), all('input[type="password"]'));
    if (hit) return hit;
  }

  const stableSelector = stableShadowHostSelector;
  const localCssSelectors = () => {
    const selectors = [];
    for (const a of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id', 'id', 'name', 'autocomplete', 'aria-label', 'placeholder', 'title', 'type', 'href']) {
      const v = attr(el, a);
      if (!v || (a !== 'type' && isDynamicValue(v))) continue;
      selectors.push((a === 'id') ? '#' + cssEsc(v) : tag + '[' + a + '="' + cssAttr(v) + '"]');
    }
    return Array.from(new Set(selectors));
  };
  const containers = [];
  const addContainer = (node, expr, selector, strategy, text) => {
    if (!node || node === el || containers.some((item) => item.node === node && item.expr === expr)) return;
    containers.push({ node, expr, selector: selector || null, strategy, text: text || null });
  };
  if (shadowCtx && shadowCtx.hostSelector && !shadowCtx.hostSelectorMissing) {
    const shadowHostExpr = shadowCtx.shadowPath
      .map((selector, index) => (index === 0 ? locatorCall(selector) : '.locator(' + JSON.stringify(selector) + ')'))
      .join('');
    addContainer(shadowCtx.root, shadowHostExpr, shadowCtx.hostSelector, 'shadow_container', null);
  }
  let cur = el.parentElement;
  let guard = 0;
  while (cur && cur.nodeType === 1 && cur !== document.body && guard++ < 10) {
    const selector = stableSelector(cur);
    if (selector) addContainer(cur, locatorCall(selector), selector, 'stable_container', null);
    const curTag = cur.tagName.toLowerCase();
    const curRole = implicitRole(cur);
    const base = curTag === 'tr' ? 'tr'
      : curRole === 'row' ? '[role="row"]'
      : curTag === 'li' ? 'li'
      : curRole === 'listitem' ? '[role="listitem"]'
      : curTag === 'article' ? 'article'
      : curTag === 'section' ? 'section'
      : curTag === 'form' ? 'form'
      : curTag === 'fieldset' ? 'fieldset'
      : curTag === 'dialog' ? 'dialog'
      : ['dialog', 'group', 'region', 'menu', 'listbox', 'tablist', 'toolbar'].includes(curRole) ? '[role="' + curRole + '"]'
      : '';
    const text = textOf(cur);
    if (base && text && text.length <= 180) {
      const matches = all(base).filter((node) => textOf(node).includes(text));
      if (matches.length === 1 && matches[0] === cur) {
        addContainer(cur, locatorCall(base) + '.filter({ hasText: ' + JSON.stringify(text) + ' })', base, curRole === 'row' || curTag === 'tr' ? 'row_text_container' : 'text_container', text);
      }
    }
    cur = cur.parentElement;
  }

  for (const container of containers) {
    const roleStrategy = container.strategy === 'row_text_container'
      ? 'row_scoped_role'
      : container.strategy === 'shadow_container'
        ? 'shadow_scoped_role'
        : 'scoped_role';
    const cssStrategy = container.strategy === 'row_text_container'
      ? 'row_scoped_css'
      : container.strategy === 'shadow_container'
        ? 'shadow_scoped_css'
        : 'scoped_css';
    const labelStrategy = container.strategy === 'shadow_container' ? 'shadow_scoped_label' : 'scoped_label';
    const placeholderStrategy = container.strategy === 'shadow_container' ? 'shadow_scoped_placeholder' : 'scoped_placeholder';
    if (role && name) {
      const hit = exact(
        roleStrategy,
        container.selector,
        container.expr + '.' + roleCall(role, name),
        matchRole(container.node),
        { containerSelector: container.selector, containerText: container.text }
      );
      if (hit) return hit;
    }
    if (label) {
      const hit = exact(labelStrategy, container.selector, container.expr + '.getByLabel(' + JSON.stringify(label) + ')', matchLabel(container.node), { containerSelector: container.selector, containerText: container.text });
      if (hit) return hit;
    }
    if (placeholder) {
      const hit = exact(placeholderStrategy, container.selector, container.expr + '.getByPlaceholder(' + JSON.stringify(placeholder) + ')', matchPlaceholder(container.node), { containerSelector: container.selector, containerText: container.text });
      if (hit) return hit;
    }
    for (const selector of localCssSelectors()) {
      const matches = all(selector, container.node);
      const hit = exact(cssStrategy, selector, container.expr + '.locator(' + JSON.stringify(selector) + ')', matches, { containerSelector: container.selector, containerText: container.text });
      if (hit) return hit;
    }
  }
  return { ok: false, reason: 'no_non_positional_unique_locator' };
}})`;

const COORDINATE_SELECTOR_FN = `(${function qaaiCoordinateSelector(payload) {
  const input = payload || {};
  const x = Number(input.x ?? input.clientX ?? input.pageX);
  const y = Number(input.y ?? input.clientY ?? input.pageY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'missing_coordinates' };
  const nodeIdentityOf = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const key = '__qaaiNodeIdentityV1';
    let state = window[key];
    if (!state || state.document !== document || !(state.nodes instanceof WeakMap)) {
      const timeOrigin = Math.round(Number(window.performance && window.performance.timeOrigin) || Date.now());
      state = { document, documentId: `doc:${timeOrigin}:${String(location.origin || '')}${String(location.pathname || '/')}`, nextNodeId: 1, nodes: new WeakMap() };
      try { Object.defineProperty(window, key, { value: state, configurable: true, writable: true }); }
      catch (_) { window[key] = state; }
    }
    let nodeId = state.nodes.get(node);
    if (!nodeId) { nodeId = `node:${state.nextNodeId++}`; state.nodes.set(node, nodeId); }
    return { scheme: 'qaai-dom-node-v1', documentId: state.documentId, nodeId, connected: node.isConnected !== false, tag: String(node.tagName || '').toLowerCase() || null };
  };
  const cssEsc = (v) => (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(String(v)) : String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c);
  const cssAttr = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const norm = (s, max = 220) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  const attr = (node, name) => node && node.getAttribute ? norm(node.getAttribute(name)) : '';
  const isDynamicValue = (value) => {
    const raw = String(value || '');
    if (!raw || raw.length > 100) return true;
    return /(?:^|[-_])(?:[a-f0-9]{8,}|[a-z0-9]{12,})(?:$|[-_])/i.test(raw)
      || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(raw)
      || /:(?:nth-of-type|nth-child)\s*\(/i.test(raw);
  };
  const all = (selector, root) => {
    const out = [];
    const seen = new Set();
    const visit = (scope) => {
      if (!scope || typeof scope.querySelectorAll !== 'function') return;
      let matches = [];
      let nodes = [];
      try {
        matches = Array.from(scope.querySelectorAll(selector));
        nodes = selector === '*' ? matches : Array.from(scope.querySelectorAll('*'));
      } catch (_) { return; }
      for (const node of matches) {
        if (!seen.has(node)) {
          seen.add(node);
          out.push(node);
        }
      }
      for (const node of nodes) {
        if (node.shadowRoot) visit(node.shadowRoot);
      }
    };
    visit(root || document);
    return out;
  };
  const visible = (node) => {
    try {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width >= 0 && rect.height >= 0;
    } catch (_) { return false; }
  };
  const enabled = (node) => !!node && !node.disabled && attr(node, 'aria-disabled') !== 'true';
  const implicitRole = (node) => {
    const explicit = attr(node, 'role').toLowerCase();
    if (explicit) return explicit;
    const tag = String(node && node.tagName || '').toLowerCase();
    const type = attr(node, 'type').toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && attr(node, 'href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (['email', 'tel', 'text', 'url', 'password', 'number', ''].includes(type)) return 'textbox';
    }
    return '';
  };
  const labelsFor = (node) => {
    const labels = [];
    if (node && node.labels) {
      for (const label of Array.from(node.labels)) {
        const text = norm(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const id = attr(node, 'id');
    if (id) {
      for (const label of all('label[for="' + cssAttr(id) + '"]')) {
        const text = norm(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const wrapper = node.closest && node.closest('label');
    if (wrapper) {
      const text = norm(wrapper.innerText || wrapper.textContent);
      if (text) labels.push(text);
    }
    return Array.from(new Set(labels)).slice(0, 4);
  };
  const accessibleName = (node) => {
    const tag = String(node && node.tagName || '').toLowerCase();
    return norm(attr(node, 'aria-label') || labelsFor(node)[0] || attr(node, 'placeholder') ||
      attr(node, 'title') || attr(node, 'alt') || attr(node, 'value') ||
      (['button', 'a', 'option', 'summary'].includes(tag) ? node.innerText || node.textContent : ''));
  };
  const isControl = (node) => {
    const tag = String(node && node.tagName || '').toLowerCase();
    const role = implicitRole(node);
    return ['button', 'a', 'input', 'select', 'textarea', 'summary', 'option'].includes(tag)
      || ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'slider', 'option'].includes(role)
      || !!attr(node, 'onclick')
      || attr(node, 'tabindex') !== '';
  };
  const targetAtPoint = () => {
    let node = null;
    try { node = document.elementFromPoint(x, y); } catch (_) { node = null; }
    if (node && node.shadowRoot && typeof node.shadowRoot.elementFromPoint === 'function') {
      try { node = node.shadowRoot.elementFromPoint(x, y) || node; } catch (_) {}
    }
    let cur = node && node.nodeType === 1 ? node : null;
    let guard = 0;
    while (cur && cur !== document.body && guard++ < 8) {
      if (isControl(cur)) return cur;
      cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
    }
    return node && node.nodeType === 1 ? node : null;
  };
  const locatorCall = (selector) => 'locator(' + JSON.stringify(selector) + ')';
  const roleCall = (role, name) => 'getByRole(' + JSON.stringify(role) + ', { name: ' + JSON.stringify(name) + ' })';
  const target = targetAtPoint();
  if (!target) return { ok: false, reason: 'no_element_at_coordinates', coordinate: { x, y } };
  const tag = String(target.tagName || '').toLowerCase();
  const role = implicitRole(target);
  const name = accessibleName(target);
  const label = labelsFor(target)[0] || attr(target, 'aria-label');
  const placeholder = attr(target, 'placeholder');
  const proof = (matches) => {
    const sameElement = matches.length === 1 && matches[0] === target;
    const targetIdentity = nodeIdentityOf(target);
    const matchedIdentity = matches.length === 1 ? nodeIdentityOf(matches[0]) : null;
    return {
      count: matches.length,
      sameElement,
      visible: visible(target),
      enabled: enabled(target),
      verified: sameElement,
      actionTimeResolved: true,
      resolutionMode: 'coordinate_hit_test',
      targetIdentity,
      matchedIdentity,
      identityVerified: sameElement
        && !!targetIdentity
        && !!matchedIdentity
        && targetIdentity.documentId === matchedIdentity.documentId
        && targetIdentity.nodeId === matchedIdentity.nodeId,
      source: 'verified_coordinate_dom',
    };
  };
  const mk = (strategy, selector, playwright, matches, extra) => ({
    ok: true,
    strategy,
    selector: selector || null,
    playwright,
    tag,
    role: role || null,
    name: name || null,
    coordinate: { x, y },
    proof: proof(matches),
    ...(extra || {}),
  });
  const exact = (strategy, selector, playwright, matches, extra) =>
    (matches.length === 1 && matches[0] === target) ? mk(strategy, selector, playwright, matches, extra) : null;
  const matchRole = (root) => all('*', root).filter((node) => implicitRole(node) === role && accessibleName(node) === name);
  const matchLabel = (root) => all('input, textarea, select', root).filter((node) => labelsFor(node).includes(label) || attr(node, 'aria-label') === label);
  const matchPlaceholder = (root) => all('input, textarea', root).filter((node) => attr(node, 'placeholder') === placeholder);
  for (const a of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id']) {
    const v = attr(target, a);
    if (!v || isDynamicValue(v)) continue;
    const selector = '[' + a + '="' + cssAttr(v) + '"]';
    const expr = a === 'data-testid' ? 'getByTestId(' + JSON.stringify(v) + ')' : locatorCall(selector);
    const hit = exact(a === 'data-testid' ? 'coordinate_testId' : (a.indexOf('data-qaai-') === 0 ? 'coordinate_qaai_attr' : 'coordinate_css_attr'), selector, expr, all(selector));
    if (hit) return hit;
  }
  const id = attr(target, 'id');
  if (id && !isDynamicValue(id)) {
    const selector = '#' + cssEsc(id);
    const hit = exact('coordinate_id', selector, locatorCall(selector), all(selector));
    if (hit) return hit;
  }
  for (const a of ['name', 'autocomplete', 'aria-label', 'title', 'alt']) {
    const v = attr(target, a);
    if (!v || isDynamicValue(v)) continue;
    const selector = tag + '[' + a + '="' + cssAttr(v) + '"]';
    const hit = exact(a === 'aria-label' ? 'coordinate_aria' : 'coordinate_' + a, selector, locatorCall(selector), all(selector));
    if (hit) return hit;
  }
  if (role && name) {
    const hit = exact('coordinate_role', null, roleCall(role, name), matchRole(document));
    if (hit) return hit;
  }
  if (label) {
    const hit = exact('coordinate_label', null, 'getByLabel(' + JSON.stringify(label) + ')', matchLabel(document));
    if (hit) return hit;
  }
  if (placeholder) {
    const hit = exact('coordinate_placeholder', null, 'getByPlaceholder(' + JSON.stringify(placeholder) + ')', matchPlaceholder(document));
    if (hit) return hit;
  }
  const localSelectors = [];
  for (const a of ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id', 'name', 'aria-label', 'placeholder', 'title', 'type']) {
    const v = attr(target, a);
    if (!v || (a !== 'type' && isDynamicValue(v))) continue;
    localSelectors.push(tag + '[' + a + '="' + cssAttr(v) + '"]');
  }
  const containerBase = (node) => {
    const nodeTag = String(node && node.tagName || '').toLowerCase();
    const nodeRole = implicitRole(node);
    if (nodeTag === 'tr') return 'tr';
    if (nodeRole === 'row') return '[role="row"]';
    if (nodeTag === 'form') return 'form';
    if (nodeTag === 'li') return 'li';
    if (nodeRole === 'listitem') return '[role="listitem"]';
    if (nodeTag === 'article') return 'article';
    if (nodeTag === 'section') return 'section';
    if (nodeTag === 'dialog') return 'dialog';
    if (['dialog', 'group', 'region', 'menu', 'listbox', 'tablist', 'toolbar'].includes(nodeRole)) return '[role="' + nodeRole + '"]';
    return '';
  };
  const textOf = (node) => norm(node && (node.innerText || node.textContent), 180);
  let cur = target.parentElement;
  let guard = 0;
  while (cur && cur.nodeType === 1 && cur !== document.body && guard++ < 10) {
    const base = containerBase(cur);
    const text = textOf(cur);
    if (base && text) {
      const containers = all(base).filter((node) => textOf(node).includes(text));
      if (containers.length === 1 && containers[0] === cur) {
        const scope = locatorCall(base) + '.filter({ hasText: ' + JSON.stringify(text) + ' })';
        if (role && name) {
          const hit = exact('coordinate_scoped_role', base, scope + '.' + roleCall(role, name), matchRole(cur), { containerSelector: base, containerText: text });
          if (hit) return hit;
        }
        if (label) {
          const hit = exact('coordinate_scoped_label', base, scope + '.getByLabel(' + JSON.stringify(label) + ')', matchLabel(cur), { containerSelector: base, containerText: text });
          if (hit) return hit;
        }
        if (placeholder) {
          const hit = exact('coordinate_scoped_placeholder', base, scope + '.getByPlaceholder(' + JSON.stringify(placeholder) + ')', matchPlaceholder(cur), { containerSelector: base, containerText: text });
          if (hit) return hit;
        }
        for (const selector of localSelectors) {
          const hit = exact('coordinate_scoped_css', selector, scope + '.locator(' + JSON.stringify(selector) + ')', all(selector, cur), { containerSelector: base, containerText: text });
          if (hit) return hit;
        }
      }
    }
    cur = cur.parentElement;
  }
  return {
    ok: false,
    reason: 'no_non_positional_unique_locator',
    coordinate: { x, y },
    targetFacts: {
      tag,
      role: role || null,
      accessibleName: name || null,
      placeholder: placeholder || null,
      text: norm(target.innerText || target.textContent, 120) || null,
    },
  };
}})`;

function coordinateFromArgs(args = {}) {
  const source = args && typeof args === 'object' ? args : {};
  const nested = source.position || source.coordinate || source.coordinates || source.point || {};
  const x = Number(source.x ?? source.clientX ?? source.pageX ?? nested.x ?? nested.clientX ?? nested.pageX);
  const y = Number(source.y ?? source.clientY ?? source.pageY ?? nested.y ?? nested.clientY ?? nested.pageY);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function coordinateGap({ toolName, args = {}, pageUrl, elementLabel, detail, strategiesTried = [] } = {}) {
  const coordinate = coordinateFromArgs(args);
  return {
    code: 'locator_unverified',
    type: 'locator_unverified',
    reason: 'visual_to_dom_conversion_failed',
    nonBlocking: true,
    where: toolName || 'coordinate_action',
    toolName: toolName || null,
    pageUrl: pageUrl || null,
    elementLabel: elementLabel || clean(args.element || args.label || args.name || args.target || '') || null,
    narration: elementLabel || clean(args.element || args.label || args.name || args.target || '') || null,
    coordinate,
    strategiesTried: Array.from(new Set(['visual_coordinate_dom_probe', ...(strategiesTried || [])])),
    repairable: true,
    detail: detail || 'Coordinate/vision action could not be converted into a non-positional DOM locator before the step was sealed.',
  };
}

async function captureCoordinateLocator(options = {}) {
  const { session, toolName, args = {}, pageUrl, element } = options;
  if (!session?.client || typeof session.client.callTool !== 'function') return null;
  const coordinate = coordinateFromArgs(args);
  if (!coordinate) return null;
  let evalResult;
  try {
    evalResult = await session.client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: `() => { return ${COORDINATE_SELECTOR_FN}(${JSON.stringify({ ...coordinate, elementLabel: element || null })}); }`,
      },
    });
  } catch (_) { return null; }
  if (!evalResult || evalResult.isError) return null;
  const res = parseInspectionResult(evalResult);
  if (!res || !res.ok || !res.playwright || !locatorExpressionIsExportSafe(res.playwright, res)) return null;
  const proof = {
    ...(res.proof || {}),
    count: res.proof?.count === 1 ? 1 : res.proof?.count,
    sameElement: res.proof?.sameElement === true,
    visible: res.proof?.visible ?? null,
    enabled: res.proof?.enabled ?? null,
    source: VERIFIED_COORDINATE_DOM_SOURCE,
    verified: res.proof?.count === 1 && res.proof?.sameElement === true,
  };
  if (!actionTimeSameElementProof(proof)) return null;
  const expr = res.playwright;
  const resolvedUrl = pageUrl || null;
  const targetFacts = {
    role: res.role || null,
    accessibleName: res.name || null,
    selector: res.selector || null,
    coordinate: res.coordinate || coordinate,
    containerSelector: res.containerSelector || null,
    containerText: res.containerText || null,
  };
  const actionContext = {
    source: VERIFIED_COORDINATE_DOM_SOURCE,
    captureBinding: { kind: 'coordinate_hit_test', coordinate: res.coordinate || coordinate },
    coordinate: res.coordinate || coordinate,
    visualFallback: true,
    containerSelector: res.containerSelector || null,
    containerText: res.containerText || null,
    targetIdentity: proof.targetIdentity || null,
  };
  const actedNodeFingerprint = buildActedNodeFingerprint({ targetFacts, context: actionContext, pageUrl: resolvedUrl });
  actionContext.actedNodeFingerprint = actedNodeFingerprint;
  const action = {
    toolName,
    elementLabel: element || null,
    strategy: res.strategy || 'coordinate_dom_capture',
    expression: expr,
    frameworkExpressions: { playwright: expr },
    targetFacts,
    context: actionContext,
    proof,
  };
  const domAtlas = normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1',
    url: resolvedUrl,
    routeKey: routeKeyFromUrl(resolvedUrl),
    title: null,
    counts: { controls: 1 },
    controls: [{
      selector: res.selector || expr,
      tag: res.tag || null,
      role: res.role || null,
      name: res.name || null,
      visible: proof.visible ?? null,
      enabled: proof.enabled ?? null,
      coordinate: res.coordinate || coordinate,
      source: VERIFIED_COORDINATE_DOM_SOURCE,
    }],
    forms: [],
    tables: [],
    dialogs: [],
    landmarks: [],
    frames: [],
    shadowHosts: [],
    headings: [],
  }, { pageUrl: resolvedUrl, action });
  return propagateLocatorEvidence({
    kind: 'playwright',
    verified: true,
    verificationSource: VERIFIED_COORDINATE_DOM_SOURCE,
    evidenceSource: VERIFIED_COORDINATE_DOM_SOURCE,
    diagnosticOnly: false,
    expression: expr,
    frameworkExpressions: { playwright: expr },
    strategy: res.strategy || 'coordinate_dom_capture',
    toolName,
    pageUrl: resolvedUrl,
    elementLabel: element || null,
    targetFacts: action.targetFacts,
    targetIdentity: proof.targetIdentity || null,
    actedNodeFingerprint,
    context: action.context,
    proof,
    ...(domAtlas ? { domAtlas } : {}),
    candidates: [{ strategy: res.strategy || 'coordinate_dom_capture', expression: expr, selector: res.selector || null }],
    allCandidates: [{ strategy: res.strategy || 'coordinate_dom_capture', expression: expr, proof, score: 100 }],
  }, options);
}

async function captureStructuralLocator(options = {}) {
  const { session, ref, element, pageUrl, toolName = null } = options;
  if (!session?.client || typeof session.client.callTool !== 'function' || !ref) return null;
  let evalResult;
  try {
    evalResult = await session.client.callTool({
      name: 'browser_evaluate',
      // @playwright/mcp names the element-reference param `target` (NOT `ref`). Passing
      // `ref` was silently ignored → MCP ran a PAGE-level page.evaluate with no element
      // bound → the function's `el` arg was undefined → every excavation returned
      // {ok:false}. With `target`, MCP scopes to the element via locator.evaluate(fn).
      arguments: { element: element || `<locator ${ref}>`, target: ref, function: STRUCTURAL_SELECTOR_FN },
    });
  } catch (_) { return null; }
  if (!evalResult || evalResult.isError) return null;
  const res = parseInspectionResult(evalResult);
  if (!res || !res.ok || !res.playwright) return null;
  const framePath = Array.isArray(res.framePath) ? res.framePath.map(clean).filter(Boolean) : [];
  if (res.inFrame === true && !framePath.length && !clean(res.frameSelector)) return null;
  const expr = wrapPlaywrightExpression(res.playwright, { frameSelector: res.frameSelector || null, framePath });
  if (!locatorExpressionIsExportSafe(expr, res)) return null;
  const resolvedUrl = pageUrl || null;
  const proof = {
    ...(res.proof || {}),
    count: res.proof?.count === 1 ? 1 : res.proof?.count,
    sameElement: res.proof?.sameElement === true,
    visible: res.proof?.visible ?? null,
    enabled: res.proof?.enabled ?? null,
    source: VERIFIED_STRUCTURAL_DOM_SOURCE,
    verified: res.proof?.count === 1 && res.proof?.sameElement === true,
  };
  if (!actionTimeSameElementProof(proof)) return null;
  const targetFacts = {
    role: res.role || null,
    accessibleName: res.name || null,
    selector: res.selector || null,
    containerSelector: res.containerSelector || null,
    containerText: res.containerText || null,
    frameSelector: res.frameSelector || null,
    framePath,
    shadowHostSelector: res.shadowHostSelector || null,
    shadowPath: Array.isArray(res.shadowPath) ? res.shadowPath.map(clean).filter(Boolean) : [],
  };
  const actionContext = {
    source: VERIFIED_STRUCTURAL_DOM_SOURCE,
    ref,
    captureBinding: { kind: 'mcp_bound_ref', ref },
    containerSelector: res.containerSelector || null,
    containerText: res.containerText || null,
    inFrame: res.inFrame === true,
    frameSelector: res.frameSelector || null,
    framePath,
    frameSelectorMissing: res.frameSelectorMissing === true,
    framePathMissing: res.framePathMissing === true || res.frameSelectorMissing === true,
    shadowHostSelector: res.shadowHostSelector || null,
    shadowPath: Array.isArray(res.shadowPath) ? res.shadowPath.map(clean).filter(Boolean) : [],
    shadowPathMissing: res.shadowPathMissing === true,
    targetIdentity: proof.targetIdentity || null,
  };
  const actedNodeFingerprint = buildActedNodeFingerprint({ targetFacts, context: actionContext, pageUrl: resolvedUrl });
  actionContext.actedNodeFingerprint = actedNodeFingerprint;
  const action = {
    toolName,
    elementLabel: element || null,
    strategy: res.strategy || 'structural_dom_capture',
    expression: expr,
    frameworkExpressions: { playwright: expr },
    targetFacts,
    context: actionContext,
    proof,
  };
  const domAtlas = normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1', url: resolvedUrl, routeKey: routeKeyFromUrl(resolvedUrl), title: null,
    counts: { controls: 1 },
    controls: [{ selector: res.selector || expr, tag: res.tag || null, role: res.role || null, name: res.name || null, visible: proof.visible ?? null, enabled: proof.enabled ?? null, source: VERIFIED_STRUCTURAL_DOM_SOURCE }],
    forms: [],
    tables: [],
    dialogs: [],
    landmarks: [],
    frames: framePath.map((selector, depth) => ({ selector, depth, source: VERIFIED_STRUCTURAL_DOM_SOURCE })),
    shadowHosts: /^shadow_scoped_/.test(String(res.strategy || ''))
      ? (Array.isArray(res.shadowPath) ? res.shadowPath : [])
        .map((selector, depth) => ({ selector, depth, source: VERIFIED_STRUCTURAL_DOM_SOURCE }))
      : [],
    headings: [],
  }, { pageUrl: resolvedUrl, action });
  return propagateLocatorEvidence({
    kind: 'playwright',
    verified: true,
    diagnosticOnly: false,
    verificationSource: VERIFIED_STRUCTURAL_DOM_SOURCE,
    evidenceSource: VERIFIED_STRUCTURAL_DOM_SOURCE,
    expression: expr,
    frameworkExpressions: { playwright: expr },
    strategy: res.strategy || 'structural_dom_capture',
    toolName,
    pageUrl: resolvedUrl,
    elementLabel: element || null,
    targetFacts: action.targetFacts,
    targetIdentity: proof.targetIdentity || null,
    actedNodeFingerprint,
    context: action.context,
    proof,
    ...(domAtlas ? { domAtlas } : {}),
  }, options);
}

function isSensitiveInputIntent({ toolName, args, elementLabel } = {}) {
  if (!/type|fill/i.test(String(toolName || ''))) return false;
  const fields = Array.isArray(args?.fields) ? args.fields : [args || {}];
  const text = [
    elementLabel,
    args?.element,
    args?.label,
    args?.name,
    args?.placeholder,
    args?.type,
    ...fields.flatMap((field) => field ? [field.element, field.label, field.name, field.placeholder, field.type] : []),
  ].filter(Boolean).join(' ');
  return /\b(?:pass(?:word)?|pwd|secret|token|api[-_\s]?key|pin|otp)\b/i.test(text);
}

function sensitiveInputPayload({ toolName, args, elementLabel } = {}) {
  const fields = Array.isArray(args?.fields) ? args.fields : [args || {}];
  const field = fields.find((item) => isSensitiveInputIntent({ toolName, args: item, elementLabel })) || fields[0] || {};
  return {
    toolName: toolName || null,
    label: clean([
      elementLabel,
      field.element,
      field.label,
      field.name,
      field.placeholder,
      field.type,
      args?.element,
      args?.label,
      args?.name,
      args?.placeholder,
      args?.type,
    ].filter(Boolean).join(' ')),
    value: clean(field.text || field.value || args?.text || args?.value || ''),
  };
}

const SENSITIVE_INPUT_SELECTOR_FN = `(${function qaaiSensitiveInputSelector(payload) {
  const clean = (value, max = 180) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const lower = (value) => clean(value).toLowerCase();
  const attr = (node, name) => node && node.getAttribute ? clean(node.getAttribute(name)) : '';
  const cssEsc = (value) => {
    const raw = String(value == null ? '' : value);
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
    return raw.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\\\' + ch);
  };
  const cssAttr = (value) => String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const uniq = (sel) => { try { return !!sel && document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const enabled = (node) => !!node && !node.disabled && attr(node, 'aria-disabled') !== 'true';
  const labelsFor = (node) => {
    const labels = [];
    if (node && node.labels) {
      for (const label of Array.from(node.labels)) {
        const text = clean(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const id = attr(node, 'id');
    if (id) {
      for (const label of Array.from(document.querySelectorAll('label[for="' + cssAttr(id) + '"]'))) {
        const text = clean(label.innerText || label.textContent);
        if (text) labels.push(text);
      }
    }
    const wrapper = node.closest && node.closest('label');
    if (wrapper) {
      const text = clean(wrapper.innerText || wrapper.textContent);
      if (text) labels.push(text);
    }
    return Array.from(new Set(labels)).slice(0, 4);
  };
  const fieldText = (node) => clean([
    attr(node, 'aria-label'),
    labelsFor(node).join(' '),
    attr(node, 'placeholder'),
    attr(node, 'name'),
    attr(node, 'id'),
    attr(node, 'autocomplete'),
    attr(node, 'data-qaai-id'),
    attr(node, 'data-qaai-role'),
    attr(node, 'data-qaai-row-key'),
    attr(node, 'data-testid'),
    attr(node, 'data-test-id'),
    attr(node, 'data-test'),
    attr(node, 'data-qa'),
    attr(node, 'data-cy'),
    attr(node, 'data-pw'),
    attr(node, 'title'),
  ].filter(Boolean).join(' '), 320);
  const sensitiveRe = /\b(?:pass(?:word)?|pwd|secret|token|api[-_\s]?key|pin|otp)\b/i;
  const terms = lower(payload && payload.label)
    .split(/[^a-z0-9@._-]+/)
    .filter((term) => term && term.length > 1)
    .slice(0, 12);
  const intendedPassword = terms.some((term) => /^pass(?:word)?$|^pwd$/.test(term));
  const controls = Array.from(document.querySelectorAll('input, textarea'))
    .filter((node) => {
      const type = lower(attr(node, 'type') || (node.tagName === 'TEXTAREA' ? 'textarea' : 'text'));
      if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'hidden'].includes(type)) return false;
      return type === 'password' || sensitiveRe.test(fieldText(node));
    });
  const value = clean(payload && payload.value, 512);
  const scoreNode = (node) => {
    const type = lower(attr(node, 'type') || '');
    const hay = lower(fieldText(node));
    let score = 0;
    if (type === 'password') score += intendedPassword ? 300 : 180;
    if (visible(node)) score += 40;
    if (enabled(node)) score += 20;
    if (value && node.value === value) score += 240;
    for (const term of terms) {
      if (!term) continue;
      if (hay === term) score += 140;
      else if (hay.includes(term)) score += 70;
    }
    if (terms.includes('confirm') && /\bconfirm\b/.test(hay)) score += 120;
    if (terms.includes('current') && /\bcurrent\b/.test(hay)) score += 90;
    if ((terms.includes('new') || terms.includes('reset')) && /\bnew|reset\b/.test(hay)) score += 80;
    return score;
  };
  const nodes = controls
    .map((node) => ({ node, score: scoreNode(node) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const target = (nodes.find((item) => visible(item.node) && enabled(item.node)) || nodes[0] || {}).node || null;
  if (!target) return JSON.stringify({ ok: false, reason: 'no_sensitive_input_candidate' });

  const mk = (strategy, selector, playwright) => {
    let count = 0;
    if (selector) {
      try { count = document.querySelectorAll(selector).length; } catch (_) { count = 0; }
    } else if (strategy === 'label') {
      const label = labelsFor(target)[0] || attr(target, 'aria-label');
      count = Array.from(document.querySelectorAll('input, textarea')).filter((node) => labelsFor(node).includes(label) || attr(node, 'aria-label') === label).length;
    } else if (strategy === 'placeholder') {
      const ph = attr(target, 'placeholder');
      count = Array.from(document.querySelectorAll('input, textarea')).filter((node) => attr(node, 'placeholder') === ph).length;
    } else if (strategy === 'testid') {
      const tid = attr(target, 'data-qaai-id') || attr(target, 'data-qaai-role') || attr(target, 'data-qaai-row-key') || attr(target, 'data-testid') || attr(target, 'data-test-id') || attr(target, 'data-test') || attr(target, 'data-qa') || attr(target, 'data-cy') || attr(target, 'data-pw') || attr(target, 'data-automation-id');
      count = Array.from(document.querySelectorAll('[data-qaai-id], [data-qaai-role], [data-qaai-row-key], [data-testid], [data-test-id], [data-test], [data-qa], [data-cy], [data-pw], [data-automation-id]'))
        .filter((node) => ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id'].some((key) => attr(node, key) === tid)).length;
    }
    return {
      ok: count === 1,
      strategy,
      selector: selector || null,
      playwright,
      tag: lower(target.tagName),
      type: lower(attr(target, 'type') || (target.tagName === 'TEXTAREA' ? 'textarea' : 'text')),
      role: 'textbox',
      name: clean(attr(target, 'aria-label') || labelsFor(target)[0] || attr(target, 'placeholder') || attr(target, 'name') || attr(target, 'id')),
      proof: { count, sameElement: false, candidateUnique: count === 1, visible: visible(target), enabled: enabled(target), verified: false, actionTimeResolved: false, actedNodeBound: false, source: 'semantic_dom_scout' },
    };
  };
  const testIdAttrs = ['data-qaai-id', 'data-qaai-role', 'data-qaai-row-key', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id'];
  for (const a of testIdAttrs) {
    const v = attr(target, a);
    if (v) {
      const sel = '[' + a + '="' + cssAttr(v) + '"]';
      const strategy = a === 'data-testid' ? 'testid' : (a.indexOf('data-qaai-') === 0 ? 'qaai-attr' : 'css-attr');
      const playwright = a === 'data-testid'
        ? 'getByTestId(' + JSON.stringify(v) + ')'
        : 'locator(' + JSON.stringify(sel) + ')';
      const out = mk(strategy, sel, playwright);
      if (out.ok) return JSON.stringify(out);
    }
  }
  const id = attr(target, 'id');
  if (id && !/\\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}|:r[0-9a-z]+:|^ember\\d+|^ng-|^cdk-|^mat-|^react-/i.test(id)) {
    const sel = '#' + cssEsc(id);
    if (uniq(sel)) return JSON.stringify(mk('id', sel, "locator('" + sel.replace(/'/g, "\\\\'") + "')"));
  }
  const name = attr(target, 'name');
  if (name) {
    const sel = lower(target.tagName) + '[name="' + cssAttr(name) + '"]';
    if (uniq(sel)) return JSON.stringify(mk('name', sel, "locator('" + sel.replace(/'/g, "\\\\'") + "')"));
  }
  const autocomplete = attr(target, 'autocomplete');
  if (autocomplete) {
    const sel = lower(target.tagName) + '[autocomplete="' + cssAttr(autocomplete) + '"]';
    if (uniq(sel)) return JSON.stringify(mk('autocomplete', sel, "locator('" + sel.replace(/'/g, "\\\\'") + "')"));
  }
  if (lower(attr(target, 'type')) === 'password' && uniq('input[type="password"]')) {
    return JSON.stringify(mk('password_type', 'input[type="password"]', 'locator(' + JSON.stringify('input[type="password"]') + ')'));
  }
  const label = labelsFor(target)[0] || attr(target, 'aria-label');
  if (label) {
    const out = mk('label', null, 'getByLabel(' + JSON.stringify(label) + ')');
    if (out.ok) return JSON.stringify(out);
  }
  const ph = attr(target, 'placeholder');
  if (ph) {
    const out = mk('placeholder', null, 'getByPlaceholder(' + JSON.stringify(ph) + ')');
    if (out.ok) return JSON.stringify(out);
  }
  return JSON.stringify({ ok: false, reason: 'no_unique_sensitive_locator' });
}})`;

async function captureSensitiveInputLocator(options = {}) {
  const { session, toolName, args, element, pageUrl } = options;
  if (!session?.client || typeof session.client.callTool !== 'function') return null;
  if (!isSensitiveInputIntent({ toolName, args, elementLabel: element })) return null;
  const payload = sensitiveInputPayload({ toolName, args, elementLabel: element });
  let evalResult;
  try {
    // MCP 0.0.75 requires `function` (a callable string), not `expression`.
    // Wrap the IIFE so MCP can call it as a no-arg function; the payload is
    // serialized inline so it travels as a closure constant, not an arg.
    evalResult = await session.client.callTool({
      name: 'browser_evaluate',
      arguments: {
        function: `() => { return ${SENSITIVE_INPUT_SELECTOR_FN}(${JSON.stringify(payload)}); }`,
      },
    });
  } catch (_) { return null; }
  if (!evalResult || evalResult.isError) return null;
  const res = parseInspectionResult(evalResult);
  if (!res || !res.ok || !res.playwright || !locatorExpressionIsExportSafe(res.playwright, res)) return null;
  const expr = res.playwright;
  const resolvedUrl = pageUrl || null;
  const proof = {
    ...(res.proof || {}),
    count: res.proof?.count === 1 ? 1 : res.proof?.count,
    sameElement: res.proof?.sameElement === true,
    sameElement: false,
    source: SEMANTIC_DOM_SCOUT_SOURCE,
    verified: false,
    actedNodeBound: false,
  };
  if (proof.count !== 1) return null;
  const action = {
    toolName: toolName || null,
    elementLabel: element || payload.label || null,
    strategy: res.strategy || 'sensitive_input_dom_capture',
    expression: expr,
    frameworkExpressions: { playwright: expr },
    targetFacts: {
      role: res.role || 'textbox',
      accessibleName: res.name || null,
      selector: res.selector || null,
      tag: res.tag || null,
      type: res.type || null,
      sensitiveInput: true,
    },
    context: { source: SEMANTIC_DOM_SCOUT_SOURCE, sensitiveInputCapture: true },
    proof,
  };
  const domAtlas = normalizeDomAtlasForAction({
    schemaVersion: 'qaai-dom-atlas-v1', url: resolvedUrl, routeKey: routeKeyFromUrl(resolvedUrl), title: null,
    counts: { controls: 1 },
    controls: [{
      selector: res.selector || expr,
      tag: res.tag || null,
      role: res.role || 'textbox',
      name: res.name || null,
      type: res.type || null,
      visible: proof.visible ?? null,
      enabled: proof.enabled ?? null,
      source: SEMANTIC_DOM_SCOUT_SOURCE,
      sensitiveInput: true,
    }],
    forms: [], tables: [], dialogs: [], landmarks: [], frames: [], shadowHosts: [], headings: [],
  }, { pageUrl: resolvedUrl, action });
  return propagateLocatorEvidence(markLocatorGuess({
    kind: 'playwright',
    verified: false,
    diagnosticOnly: true,
    verificationSource: SEMANTIC_DOM_SCOUT_SOURCE,
    evidenceSource: SEMANTIC_DOM_SCOUT_SOURCE,
    expression: expr,
    frameworkExpressions: { playwright: expr },
    strategy: res.strategy || 'sensitive_input_dom_capture',
    toolName: toolName || null,
    pageUrl: resolvedUrl,
    elementLabel: element || payload.label || null,
    targetFacts: action.targetFacts,
    context: action.context,
    proof,
    ...(domAtlas ? { domAtlas } : {}),
  }, {
    source: SEMANTIC_DOM_SCOUT_SOURCE,
    reason: 'A unique sensitive-input candidate was found by semantics but was not bound to the acted browser node.',
  }), options);
}

async function resolveVerifiedForTool(options = {}) {
  const fulfilled = await fulfillForTool(options);
  const actionLocator = propagateLocatorEvidence(fulfilled.actionLocator, options);
  if (isVerifiedActionLocator(actionLocator)) {
    return {
      ok: true,
      actionLocator,
      diagnostic: fulfilled.diagnostic || null,
      gap: null,
      scout: fulfilled.scout || null,
      fulfilledBy: fulfilled.fulfilledBy || null,
    };
  }
  const args = options.args || {};
  const diagnostic = fulfilled.diagnostic || actionLocator || null;
  return {
    ok: false,
    actionLocator: actionLocator || null,
    diagnostic,
    scout: fulfilled.scout || null,
    gap: fulfilled.gap || actionLocatorGap({
      toolName: options.toolName,
      args,
      pageUrl: options.pageUrl,
      elementLabel: options.elementLabel,
      snapshotText: options.snapshotText,
      diagnostic,
      strategiesTried: firstActionRef(options.toolName, args)
        ? ['snapshot_ref', 'targeted_ref_excavation', 'scoped_role']
        : ['args_fallback', 'scoped_role'],
      detail: 'QAAI actively searched the live DOM but could not fulfill this locator from the current page state.',
    }),
  };
}

function candidatesFromActionLocator(actionLocator) {
  const primary = primaryActionLocator(actionLocator);
  if (!primary) return [];
  return dedupeCandidates(primary.candidates || []);
}

function fieldActionLocator(actionLocator, field, index = null) {
  if (!actionLocator || actionLocator.kind !== 'multi' || !Array.isArray(actionLocator.fields)) return null;
  const ref = clean(field && (field.ref || field.target));
  const name = clean(field && (field.name || field.label || field.element || field.placeholder)).toLowerCase();
  const found = actionLocator.fields.find((item) =>
    (ref && item.ref === ref) ||
    (index != null && item.index === index) ||
    (name && clean(item.name).toLowerCase() === name)
  );
  return found ? found.actionLocator : null;
}

function expressionForKnowledgeBase(actionLocator, lang = 'playwright') {
  const primary = primaryActionLocator(actionLocator);
  if (!primary || !isVerifiedActionLocator(primary)) return null;
  if (lang === 'selenium') return primary.frameworkExpressions?.selenium || null;
  return primary.frameworkExpressions?.playwright || primary.expression || null;
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').slice(0, limit) : [];
}

function normalizeDomAtlasForAction(domAtlas, options = {}) {
  if (!domAtlas || typeof domAtlas !== 'object') return null;
  const url = clean(domAtlas.url || options.pageUrl);
  const atlas = {
    schemaVersion: 'qaai-dom-atlas-v1',
    url: url || null,
    routeKey: clean(domAtlas.routeKey) || routeKeyFromUrl(url),
    title: clean(domAtlas.title) || null,
    counts: domAtlas.counts && typeof domAtlas.counts === 'object' ? domAtlas.counts : {},
    controls: boundedArray(domAtlas.controls, 100),
    forms: boundedArray(domAtlas.forms, 25),
    tables: boundedArray(domAtlas.tables, 20),
    dialogs: boundedArray(domAtlas.dialogs, 20),
    landmarks: boundedArray(domAtlas.landmarks, 30),
    frames: boundedArray(domAtlas.frames, 30),
    shadowHosts: boundedArray(domAtlas.shadowHosts, 30),
    headings: Array.isArray(domAtlas.headings) ? domAtlas.headings.map(clean).filter(Boolean).slice(0, 30) : [],
    verifiedActions: [],
  };
  if (options.action && typeof options.action === 'object') {
    const actionProof = options.action.proof && typeof options.action.proof === 'object'
      ? options.action.proof
      : {};
    const actionSource = options.action.verificationSource
      || options.action.evidenceSource
      || actionProof.source
      || null;
    const captureBinding = options.action.captureBinding
      || options.action.context?.captureBinding
      || null;
    const authoritativeCdpVerified = actionSource === AUTHORITATIVE_CHROMIUM_CDP_SOURCE
      && persistedAuthoritativeCdpProof(options.action, actionProof, captureBinding);
    if (
      [AUTHORITATIVE_CHROMIUM_CDP_SOURCE, VERIFIED_DOM_INSPECTION_SOURCE, VERIFIED_STRUCTURAL_DOM_SOURCE, VERIFIED_COORDINATE_DOM_SOURCE].includes(actionSource)
      && (actionTimeSameElementProof(actionProof) || authoritativeCdpVerified)
    ) {
      atlas.verifiedActions.push(options.action);
    }
  }
  return atlas;
}

function routeKeyFromUrl(url) {
  if (!url) return '/';
  try {
    const u = new URL(url);
    return u.pathname || '/';
  } catch (_) {
    return String(url).replace(/[?#].*$/, '') || '/';
  }
}

function locatorUrlOrigin(url) {
  if (!url) return null;
  try { return new URL(String(url)).origin; } catch (_) { return null; }
}

function locatorContextPath(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => clean(entry && typeof entry === 'object'
      ? entry.selector || entry.expression || entry.name
      : entry))
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * Attach an immutable, website-neutral evidence envelope to a captured locator.
 * This function annotates the exact framework expressions; it never rewrites,
 * broadens, ranks, or guesses a locator.
 */
function buildLocatorEvidenceRecord(options = {}) {
  const rawLocator = options.actionLocator && typeof options.actionLocator === 'object'
    ? options.actionLocator
    : null;
  const primary = primaryActionLocator(rawLocator);
  const context = primary?.context && typeof primary.context === 'object' ? primary.context : {};
  const proof = primary?.proof && typeof primary.proof === 'object' ? primary.proof : {};
  const pageUrl = clean(options.pageUrl || primary?.pageUrl || rawLocator?.pageUrl) || null;
  const stableRoute = routeKeyFromUrl(pageUrl);
  const origin = locatorUrlOrigin(pageUrl);
  const source = clean(primary?.verificationSource || primary?.evidenceSource || proof.source) || 'unverified_unknown';
  const inheritedEvidence = primary?.contextEvidence && typeof primary.contextEvidence === 'object'
    ? primary.contextEvidence
    : rawLocator?.contextEvidence && typeof rawLocator.contextEvidence === 'object'
      ? rawLocator.contextEvidence
      : {};
  const inheritedActionIdentity = options.actionIdentity && typeof options.actionIdentity === 'object'
    ? options.actionIdentity
    : primary?.actionIdentity && typeof primary.actionIdentity === 'object'
      ? primary.actionIdentity
      : rawLocator?.actionIdentity && typeof rawLocator.actionIdentity === 'object'
        ? rawLocator.actionIdentity
        : inheritedEvidence.actionIdentity && typeof inheritedEvidence.actionIdentity === 'object'
          ? inheritedEvidence.actionIdentity
          : {};
  const contractStepId = clean(options.contractStepId || inheritedActionIdentity.contractStepId || primary?.contractStepId || rawLocator?.contractStepId) || null;
  const sourceContractStepId = clean(options.sourceContractStepId || inheritedActionIdentity.sourceContractStepId || primary?.sourceContractStepId || rawLocator?.sourceContractStepId || inheritedEvidence.sourceContractStepId) || null;
  const actionOccurrenceId = clean(options.actionOccurrenceId || inheritedActionIdentity.actionOccurrenceId || primary?.actionOccurrenceId || rawLocator?.actionOccurrenceId || inheritedEvidence.actionOccurrenceId) || null;
  const sourceActionOccurrenceId = clean(options.sourceActionOccurrenceId || inheritedActionIdentity.sourceActionOccurrenceId || primary?.sourceActionOccurrenceId || rawLocator?.sourceActionOccurrenceId || inheritedEvidence.sourceActionOccurrenceId) || null;
  const authoredActionId = clean(options.authoredActionId || inheritedActionIdentity.authoredActionId || primary?.authoredActionId || rawLocator?.authoredActionId || inheritedEvidence.authoredActionId) || null;
  const rawSequenceIndex = options.sequenceIndex
    ?? inheritedActionIdentity.sequenceIndex
    ?? primary?.sequenceIndex
    ?? rawLocator?.sequenceIndex
    ?? inheritedEvidence.sequenceIndex;
  const sequenceIndex = Number.isFinite(Number(rawSequenceIndex)) && Number(rawSequenceIndex) >= 0
    ? Math.floor(Number(rawSequenceIndex))
    : null;
  const actionIdentity = {
    ...inheritedActionIdentity,
    contractStepId,
    sourceContractStepId,
    actionOccurrenceId,
    sourceActionOccurrenceId,
    authoredActionId,
    sequenceIndex,
  };
  const locatorProofVerified = !!rawLocator && isVerifiedActionLocator(rawLocator);
  const locatorProvenButUnbound = locatorProofVerified && !contractStepId;
  const verified = locatorProofVerified && !!contractStepId;
  const frameworkExpressions = primary?.frameworkExpressions && typeof primary.frameworkExpressions === 'object'
    ? primary.frameworkExpressions
    : {};
  const playwright = typeof (frameworkExpressions.playwright || primary?.expression) === 'string'
    ? (frameworkExpressions.playwright || primary.expression)
    : null;
  const selenium = typeof frameworkExpressions.selenium === 'string' ? frameworkExpressions.selenium : null;
  const framePath = locatorContextPath(options.framePath || context.framePath || context.frames || primary?.framePath);
  const shadowHostPath = locatorContextPath(
    options.shadowHostPath || context.shadowHostPath || context.shadowPath || context.shadowHosts || primary?.shadowHostPath || primary?.shadowPath,
  );
  const containerScope = clean(
    options.containerScope || context.containerScope || context.rowSelector || context.formSelector
      || context.tableSelector || context.dialogSelector || primary?.containerScope,
  ) || null;
  const repeatedFieldScope = clean(
    options.repeatedFieldScope || context.repeatedFieldScope || context.fieldScope || primary?.repeatedFieldScope,
  ) || null;
  const fieldIndexCandidate = options.fieldIndex ?? primary?.fieldIndex ?? rawLocator?.fieldIndex;
  const fieldIndex = Number.isInteger(Number(fieldIndexCandidate)) ? Number(fieldIndexCandidate) : null;
  const popupSource = options.popupIdentity || primary?.popupIdentity || context.popupIdentity;
  const popupIdentity = popupSource && typeof popupSource === 'object'
    ? { ...popupSource }
    : null;
  const pageAlias = clean(options.pageAlias || primary?.pageAlias || context.pageAlias)
    || `page:${origin || 'unknown'}${stableRoute || '/'}`;
  const popupAlias = popupIdentity && clean(popupIdentity.alias || popupIdentity.id);
  const tabAlias = clean(options.tabAlias || primary?.tabAlias || context.tabAlias)
    || (popupAlias ? `popup:${popupAlias}` : 'tab:current');
  const capturedAt = clean(options.capturedAt || primary?.capturedAt) || new Date().toISOString();
  const exactFrameworkExpressions = Object.fromEntries(
    Object.entries(frameworkExpressions).filter(([, expression]) => typeof expression === 'string' && expression.length),
  );
  if (playwright && !exactFrameworkExpressions.playwright) exactFrameworkExpressions.playwright = playwright;
  if (selenium && !exactFrameworkExpressions.selenium) exactFrameworkExpressions.selenium = selenium;
  const transitionSource = options.contextTransition || primary?.contextTransition || context.contextTransition;
  const targetIdentity = primary?.targetIdentity || context.targetIdentity || proof.targetIdentity || null;
  const matchedIdentity = proof.matchedIdentity || null;
  const actedNodeFingerprint = primary?.actedNodeFingerprint || context.actedNodeFingerprint || null;
  const exactSameElement = verified && actionTimeSameElementProof(proof);
  const guess = !verified && !locatorProvenButUnbound && playwright
    ? (primary?.guess || rawLocator?.guess || {
        isGuess: true,
        reviewRequired: true,
        source,
        reason: 'No action-time locator candidate proved unique resolution to the acted DOM node.',
        annotation: 'QAAI-GUESSED: this locator could not be proven against the acted DOM node; review before relying on it.',
      })
    : null;
  const evidence = {
    schema: 'qaai-action-locator-context/1',
    contractStepId,
    sourceContractStepId,
    actionOccurrenceId,
    sourceActionOccurrenceId,
    authoredActionId,
    sequenceIndex,
    actionIdentity,
    verified,
    verificationStatus: verified ? 'verified' : locatorProvenButUnbound ? 'unbound' : 'unverified',
    identityStatus: contractStepId ? 'bound_to_authored_contract' : 'missing_contract_step_id',
    persistable: verified && !!contractStepId,
    verificationSource: source,
    evidenceSource: source,
    exactFrameworkExpressions,
    pageUrl,
    pageAlias,
    tabAlias,
    origin,
    stableRoute,
    popupIdentity,
    pageIdentity: {
      pageAlias,
      tabAlias,
      popupIdentity,
      documentId: targetIdentity?.documentId || null,
      origin,
      stableRoute,
    },
    framePath,
    shadowHostPath,
    containerScope,
    repeatedFieldScope,
    fieldIndex,
    uniqueness: {
      count: Number.isFinite(Number(proof.count)) ? Number(proof.count) : null,
      sameElement: exactSameElement,
      unique: exactSameElement,
      actionTimeResolved: proof.actionTimeResolved === true,
      identityVerified: proof.identityVerified === true,
    },
    targetIdentity,
    matchedIdentity,
    actedNodeFingerprint,
    guess,
    actionability: {
      visible: proof.visible === true,
      enabled: proof.enabled === true,
      editable: proof.editable === true ? true : proof.editable === false ? false : null,
    },
    capturedAt,
    contextTransition: transitionSource && typeof transitionSource === 'object'
      ? { ...transitionSource, origin: 'context_evidence', authored: false }
      : null,
  };

  let locator = rawLocator;
  if (rawLocator?.kind === 'multi' && Array.isArray(rawLocator.fields)) {
    locator = {
      ...rawLocator,
      fields: rawLocator.fields.map((field, index) => field?.actionLocator ? {
        ...field,
        actionLocator: buildLocatorEvidenceRecord({
          ...options,
          actionLocator: field.actionLocator,
          contractStepId,
          sourceContractStepId,
          fieldIndex: field.fieldIndex ?? field.index ?? index,
          repeatedFieldScope: field.repeatedFieldScope || field.scope || field.name || options.repeatedFieldScope || null,
          containerScope: field.containerScope || field.actionLocator?.context?.containerScope || options.containerScope || null,
        }).locator,
        fieldIndex: field.fieldIndex ?? field.index ?? index,
      } : field),
    };
  }
  if (locator) {
    locator = {
      ...locator,
      verified,
      diagnosticOnly: locatorProvenButUnbound ? true : locator.diagnosticOnly === true,
      verificationStatus: evidence.verificationStatus,
      identityStatus: evidence.identityStatus,
      persistable: evidence.persistable,
      verificationSource: source,
      evidenceSource: source,
      contractStepId,
      sourceContractStepId,
      actionOccurrenceId,
      sourceActionOccurrenceId,
      authoredActionId,
      sequenceIndex,
      actionIdentity,
      pageAlias,
      tabAlias,
      capturedAt,
      exactFrameworkExpressions,
      popupIdentity,
      pageIdentity: evidence.pageIdentity,
      framePath,
      shadowHostPath,
      containerScope,
      repeatedFieldScope,
      fieldIndex,
      uniqueness: evidence.uniqueness,
      actionability: evidence.actionability,
      targetIdentity,
      matchedIdentity,
      actedNodeFingerprint,
      ...(guess ? { guess } : {}),
      contextTransition: evidence.contextTransition,
      contextEvidence: evidence,
      ...(rawLocator.kind !== 'multi' && primary?.frameworkExpressions
        ? { frameworkExpressions: { ...primary.frameworkExpressions } }
        : {}),
      ...(rawLocator.kind !== 'multi' && primary?.expression ? { expression: primary.expression } : {}),
    };
  }
  return { ...evidence, locator };
}

function domAtlasFromActionLocator(actionLocator) {
  if (!actionLocator || typeof actionLocator !== 'object') return null;
  if (actionLocator.domAtlas && typeof actionLocator.domAtlas === 'object') return actionLocator.domAtlas;
  const primary = primaryActionLocator(actionLocator);
  if (primary && primary.domAtlas && typeof primary.domAtlas === 'object') return primary.domAtlas;
  if (actionLocator.kind === 'multi' && Array.isArray(actionLocator.fields)) {
    for (const field of actionLocator.fields) {
      const atlas = domAtlasFromActionLocator(field && field.actionLocator);
      if (atlas) return atlas;
    }
  }
  if (primary) {
    const expression = primary.frameworkExpressions?.playwright || primary.expression || null;
    const facts = primary.targetFacts && typeof primary.targetFacts === 'object' ? primary.targetFacts : {};
    const selector = expression || facts.selector || facts.id && `#${facts.id}` || null;
    if (selector) {
      return normalizeDomAtlasForAction({
        schemaVersion: 'qaai-dom-atlas-v1',
        url: primary.pageUrl || actionLocator.pageUrl || null,
        routeKey: routeKeyFromUrl(primary.pageUrl || actionLocator.pageUrl || null),
        title: null,
        counts: { controls: 1 },
        controls: [{
          selector,
          ...(facts.tag ? { tag: facts.tag } : {}),
          ...(facts.role ? { role: facts.role } : {}),
          ...(facts.accessibleName ? { name: facts.accessibleName } : {}),
          ...(facts.placeholder ? { placeholder: facts.placeholder } : {}),
          ...(facts.nameAttr ? { nameAttr: facts.nameAttr } : {}),
          visible: primary.proof?.visible ?? facts.visible ?? null,
          enabled: primary.proof?.enabled ?? facts.enabled ?? null,
          source: 'action_locator_minimal',
        }],
        forms: [],
        tables: [],
        dialogs: [],
        landmarks: [],
        frames: [],
        shadowHosts: [],
        headings: [],
      }, {
        pageUrl: primary.pageUrl || actionLocator.pageUrl || null,
        action: {
          toolName: primary.toolName || actionLocator.toolName || null,
          elementLabel: primary.elementLabel || actionLocator.elementLabel || null,
          strategy: primary.strategy || 'actionLocator',
          expression,
          frameworkExpressions: primary.frameworkExpressions || (expression ? { playwright: expression } : {}),
          targetFacts: facts,
          context: primary.context || {},
          proof: primary.proof || {},
        },
      });
    }
  }
  return null;
}

const SEMANTIC_CONTROL_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'generic', 'gridcell', 'link', 'listbox',
  'listitem', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio',
  'searchbox', 'spinbutton', 'switch', 'textbox', 'treeitem',
]);

const SEMANTIC_CONTROL_VALUE_OWNER_ROLES = new Set([
  'combobox', 'listbox', 'searchbox', 'spinbutton', 'textbox',
]);

const SEMANTIC_CONTROL_SURFACE_WORDS = new Set([
  'a', 'an', 'and', 'button', 'calendar', 'choice', 'control', 'dropdown',
  'field', 'icon', 'input', 'opener', 'picker', 'section', 'select', 'the',
  'toggle',
]);

const SEMANTIC_CONTROL_DISTINCTIVE_FIELD_TOKENS = new Set([
  'date', 'email', 'password', 'phone', 'search', 'time', 'timezone', 'username',
]);

function semanticControlNormalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function semanticControlNormalizeTime(value) {
  const text = String(value == null ? '' : value).trim().toUpperCase();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute < 0 || minute > 59) return null;
  if (match[3]) {
    if (hour < 1 || hour > 12) return null;
    if (hour === 12) hour = 0;
    if (match[3] === 'PM') hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function semanticControlTokens(value, { stripSurface = false } = {}) {
  const raw = semanticControlNormalize(value).split(' ').filter((part) => part.length > 1);
  if (!stripSurface) return Array.from(new Set(raw));
  const stripped = raw.filter((part) => !SEMANTIC_CONTROL_SURFACE_WORDS.has(part));
  return Array.from(new Set(stripped.length ? stripped : raw));
}

function semanticControlContextPath(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => clean(item && typeof item === 'object'
      ? item.selector || item.ref || item.id || item.name || item.hostSelector || ''
      : item, 240))
    .filter(Boolean);
}

function semanticControlCandidateContext(candidate = {}, evidence = {}) {
  const evidenceContext = evidence?.context && typeof evidence.context === 'object'
    ? evidence.context
    : {};
  return {
    frameId: clean(candidate.frameId || evidenceContext.frameId, 160) || null,
    framePath: semanticControlContextPath(candidate.framePath || evidenceContext.framePath),
    shadowPath: semanticControlContextPath(candidate.shadowPath),
  };
}

function semanticControlExpectedContext(targetContract = {}) {
  const context = targetContract.context && typeof targetContract.context === 'object'
    ? targetContract.context
    : {};
  return {
    frameId: clean(targetContract.frameId || context.frameId, 160) || null,
    framePath: semanticControlContextPath(targetContract.framePath || context.framePath),
    shadowPath: semanticControlContextPath(targetContract.shadowPath || context.shadowPath),
  };
}

function semanticControlContextMatches(candidate = {}, evidence = {}, targetContract = {}) {
  const expected = semanticControlExpectedContext(targetContract);
  const actual = semanticControlCandidateContext(candidate, evidence);
  if (expected.frameId && actual.frameId !== expected.frameId) return false;
  if (expected.framePath.length
    && JSON.stringify(actual.framePath) !== JSON.stringify(expected.framePath)) return false;
  if (expected.shadowPath.length
    && JSON.stringify(actual.shadowPath) !== JSON.stringify(expected.shadowPath)) return false;
  return true;
}

function semanticControlContextKey(candidate = {}) {
  return JSON.stringify({
    frameId: candidate.frameId || null,
    framePath: semanticControlContextPath(candidate.framePath),
    shadowPath: semanticControlContextPath(candidate.shadowPath),
  });
}

function semanticControlRole(value) {
  const role = semanticControlNormalize(value).replace(/\s+/g, '');
  if (role === 'menuitemradio' || role === 'menuitemcheckbox') return role;
  if (role === 'menuitem') return 'menuitem';
  return role;
}

function semanticControlIndent(line) {
  return (String(line || '').match(/^\s*/) || [''])[0].length;
}

function semanticControlRestAttribute(rest, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(rest || '').match(new RegExp(`\\[${escaped}=["']?([^\\]"']+)`, 'i'));
  return match ? clean(match[1]) : '';
}

function semanticControlColonStaticText(parsed) {
  const role = semanticControlRole(parsed?.role);
  if (!['text', 'heading', 'paragraph', 'generic'].includes(role)) return '';
  const match = String(parsed?.rest || '').trim()
    .match(/^(?:\[[^\]]+\]\s*)*:\s*(.+?)(?:\s+\[[^\]]+\].*)?$/);
  return match ? clean(match[1]) : '';
}

function semanticControlSnapshotRows(snapshotText) {
  const roleOrdinals = new Map();
  const rows = String(snapshotText || '').split(/\r?\n/).map((line, index) => {
    const parsed = mcp.parseSnapshotLine(line);
    const role = semanticControlRole(parsed?.role);
    const roleOrdinal = roleOrdinals.get(role) || 0;
    if (role) roleOrdinals.set(role, roleOrdinal + 1);
    const nameAttr = semanticControlRestAttribute(parsed?.rest, 'name');
    const title = semanticControlRestAttribute(parsed?.rest, 'title');
    const backendNodeId = Number(
      semanticControlRestAttribute(parsed?.rest, 'backendNodeId')
      || semanticControlRestAttribute(parsed?.rest, 'backendDOMNodeId'),
    );
    const colonStaticText = semanticControlColonStaticText(parsed);
    return {
      index,
      line,
      indent: semanticControlIndent(line),
      parsed,
      role,
      roleOrdinal,
      nameAttr,
      title,
      backendNodeId: Number.isFinite(backendNodeId) && backendNodeId > 0 ? backendNodeId : null,
      identityText: [parsed?.name, colonStaticText, parsed?.placeholder, parsed?.idAttr, parsed?.testid, nameAttr, title]
        .filter(Boolean).join(' '),
    };
  });
  return { rows, roleCounts: Object.fromEntries(roleOrdinals) };
}

function semanticControlStructuralContext(rows, candidateIndex) {
  const candidate = rows[candidateIndex];
  if (!candidate) return '';
  const selected = [];
  let ancestorIndent = candidate.indent;
  for (let index = candidateIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row.parsed) continue;
    if (row.indent < ancestorIndent) {
      if (row.identityText) selected.unshift(row.identityText);
      ancestorIndent = row.indent;
      if (ancestorIndent === 0) break;
    }
  }
  for (let index = candidateIndex - 1; index >= Math.max(0, candidateIndex - 5); index -= 1) {
    const row = rows[index];
    if (!row.parsed) continue;
    if (row.parsed.ref) break;
    if (row.identityText) selected.unshift(row.identityText);
  }
  for (let index = candidateIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.parsed || row.indent <= candidate.indent) break;
    if (row.parsed.ref) continue;
    if (row.identityText) selected.push(row.identityText);
  }
  return selected.filter(Boolean).join(' ');
}

function semanticControlCoverage(wanted, text) {
  if (!wanted.length) return 0;
  const live = new Set(semanticControlTokens(text));
  return wanted.filter((part) => live.has(part)).length / wanted.length;
}

function semanticControlAcceptedRoles(roleHints = [], semanticTarget = null) {
  const roles = new Set((Array.isArray(roleHints) ? roleHints : [roleHints])
    .map(semanticControlRole).filter(Boolean));
  const kind = semanticControlNormalize(semanticTarget?.kind);
  if (kind === 'option') {
    for (const role of ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem']) roles.add(role);
  }
  if (kind === 'control opener') {
    for (const role of ['button', 'combobox', 'listbox', 'searchbox', 'spinbutton', 'textbox']) roles.add(role);
  }
  if (kind === 'control opener' && semanticControlNormalize(semanticTarget?.controlKind) === 'disclosure') {
    // Some component libraries expose an accordion header as an interactive
    // generic node. It remains eligible only when expansion ownership is
    // proven below; generic descendants never qualify on text alone.
    roles.add('generic');
  }
  return roles;
}

function semanticControlComparableLabel(value) {
  return semanticControlTokens(value, { stripSurface: true }).join(' ');
}

function semanticControlExactLabelAssociation(candidate, label) {
  const wanted = semanticControlComparableLabel(label);
  if (!wanted) return false;
  const labels = [candidate?.accessibleName, ...(Array.isArray(candidate?.associatedLabels) ? candidate.associatedLabels : [])]
    .map(semanticControlComparableLabel)
    .filter(Boolean);
  return labels.includes(wanted);
}

function semanticControlNearestStaticLabel(rows, candidateIndex) {
  const candidate = rows[candidateIndex];
  if (!candidate) return '';
  const forwardLabel = () => {
    for (let index = candidateIndex + 1; index <= Math.min(rows.length - 1, candidateIndex + 3); index += 1) {
      const row = rows[index];
      if (!row?.parsed) continue;
      if (row.indent < candidate.indent) break;
      if (row.indent === candidate.indent && row.role !== 'generic' && row.parsed.ref) break;
      if (row.identityText) return row.identityText;
    }
    return '';
  };
  if (['checkbox', 'radio', 'switch'].includes(candidate.role)) {
    const adjacent = forwardLabel();
    if (adjacent) return adjacent;
  }
  for (let index = candidateIndex - 1; index >= Math.max(0, candidateIndex - 3); index -= 1) {
    const row = rows[index];
    if (!row?.parsed) continue;
    if (row.indent < candidate.indent - 2) break;
    const referencedStaticLabel = ['text', 'heading', 'paragraph'].includes(row.role)
      || (row.role === 'generic'
        && !!semanticControlColonStaticText(row.parsed)
        && !/\[cursor=(?:pointer|text)\]/i.test(String(row.parsed.rest || '')));
    if (referencedStaticLabel && row.identityText) return row.identityText;
    if (row.parsed.ref && SEMANTIC_CONTROL_ROLES.has(row.role)) {
      if (row.role === 'generic' && !row.identityText) continue;
      break;
    }
    if (row.identityText) return row.identityText;
  }
  return forwardLabel();
}

function semanticControlTemporalFacet(value) {
  const tokens = new Set(semanticControlTokens(value));
  if (tokens.has('timezone') || (tokens.has('time') && tokens.has('zone'))) return 'timezone';
  if (tokens.has('date') || tokens.has('calendar')) return 'date';
  if (tokens.has('time')) return 'time';
  return null;
}

function semanticControlTemporalScopeTokens(value) {
  return semanticControlTokens(value, { stripSurface: true })
    .filter((token) => !['date', 'time', 'zone', 'timezone'].includes(token));
}

const SEMANTIC_CONTROL_SCOPE_CONTRASTS = [
  ['early', 'late'],
  ['pickup', 'delivery'],
  ['start', 'end'],
  ['begin', 'end'],
  ['from', 'to'],
  ['departure', 'arrival'],
  ['origin', 'destination'],
];

function semanticControlScopedLabelTexts(candidate = {}, ownerPromoted = false) {
  const source = candidate && typeof candidate === 'object' ? candidate : {};
  const values = ownerPromoted
    ? source.actionOwnerScopedLabels
    : source.scopedLabels;
  return (Array.isArray(values) ? values : [])
    .map((value) => clean(value && typeof value === 'object' ? value.text : value, 240))
    .filter(Boolean);
}

function semanticControlPrimaryScopeLabel(candidate = {}, expectedTokens = [], ownerPromoted = false) {
  const labels = semanticControlScopedLabelTexts(candidate, ownerPromoted);
  if (!labels.length) return '';
  const axisTokens = new Set(SEMANTIC_CONTROL_SCOPE_CONTRASTS.flat());
  const expected = new Set(expectedTokens);
  return labels.find((label) => {
    const tokens = semanticControlTemporalScopeTokens(label);
    return tokens.some((token) => axisTokens.has(token) || expected.has(token));
  }) || '';
}

function semanticControlScopeContradicts(expectedTokens = [], observedLabel = '') {
  const expected = new Set(expectedTokens);
  const observed = new Set(semanticControlTemporalScopeTokens(observedLabel));
  return SEMANTIC_CONTROL_SCOPE_CONTRASTS.some(([left, right]) => (
    (expected.has(left) && observed.has(right) && !observed.has(left))
    || (expected.has(right) && observed.has(left) && !observed.has(right))
  ));
}

function semanticControlNearestGroupLabel(rows, candidateIndex) {
  for (let index = candidateIndex - 1; index >= Math.max(0, candidateIndex - 40); index -= 1) {
    const row = rows[index];
    if (!row?.identityText) continue;
    if (semanticControlTemporalScopeTokens(row.identityText).length) return row.identityText;
  }
  return '';
}

function semanticControlVisibleDisclosureContent(rows, candidateIndex) {
  const candidate = rows[candidateIndex];
  if (!candidate) return false;
  let siblingContainerSeen = false;
  for (let index = candidateIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row?.parsed) continue;
    if (row.indent < candidate.indent) break;
    if (row.indent === candidate.indent) {
      if (!['generic', 'group', 'region'].includes(row.role)) break;
      siblingContainerSeen = true;
      continue;
    }
    if (!siblingContainerSeen || !row.parsed.ref) continue;
    if (['button', 'checkbox', 'combobox', 'grid', 'heading', 'link', 'listbox', 'radio',
      'searchbox', 'spinbutton', 'textbox', 'tree'].includes(row.role)) return true;
  }
  return false;
}

function semanticControlTriggerOwnerLabel(rows, candidateIndex) {
  const candidate = rows[candidateIndex];
  if (!candidate) return '';
  let siblingControls = 0;
  for (let index = candidateIndex - 1; index >= Math.max(0, candidateIndex - 8); index -= 1) {
    const row = rows[index];
    if (!row?.parsed) continue;
    if (row.indent < Math.max(0, candidate.indent - 2)) break;
    if (!row.parsed.ref && row.identityText) return row.identityText;
    if (row.parsed.ref && row.indent === candidate.indent && SEMANTIC_CONTROL_ROLES.has(row.role)) {
      siblingControls += 1;
      const siblingName = clean(row.parsed.name || row.identityText || '');
      if (siblingName && ['combobox', 'listbox', 'searchbox', 'spinbutton', 'textbox'].includes(row.role)) {
        return siblingName;
      }
      if (siblingControls > 1) break;
      continue;
    }
    if (row.parsed.ref && row.indent < candidate.indent) break;
  }
  return '';
}

function semanticControlAssociatedTriggerRow(rows, ownerIndex, wantedTokens = []) {
  const owner = rows[ownerIndex];
  if (!owner?.parsed?.ref) return { row: null, ambiguous: false };
  if (owner.role === 'button') return { row: owner, ambiguous: false, source: 'owner_is_trigger' };
  if (!SEMANTIC_CONTROL_VALUE_OWNER_ROLES.has(owner.role)) return { row: null, ambiguous: false };

  const buttons = [];
  for (let index = ownerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row?.parsed) continue;
    if (row.indent < owner.indent) break;
    if (row.indent !== owner.indent || !row.parsed.ref) continue;
    if (row.role === 'button') {
      buttons.push(row);
      continue;
    }
    break;
  }
  if (!buttons.length) return { row: null, ambiguous: false };

  const exact = buttons.filter((row) => semanticControlCoverage(
    wantedTokens,
    row.parsed.name || row.identityText || '',
  ) === 1);
  if (exact.length === 1) return { row: exact[0], ambiguous: false, source: 'labelled_sibling_trigger' };
  if (exact.length > 1) return { row: null, ambiguous: true, candidates: exact };

  const generic = buttons.filter((row) => {
    const name = semanticControlNormalize(row.parsed.name || row.identityText || '');
    return !name || /\b(?:open|toggle|trigger|dropdown|menu|picker|calendar|select)\b/.test(name);
  });
  if (buttons.length === 1 && generic.length === 1) {
    return { row: generic[0], ambiguous: false, source: 'unique_adjacent_trigger' };
  }
  if (generic.length > 1) return { row: null, ambiguous: true, candidates: generic };
  return { row: null, ambiguous: false };
}

function semanticControlTriggerOwnerRow(rows, triggerIndex, wantedTokens = []) {
  const trigger = rows[triggerIndex];
  if (!trigger?.parsed?.ref || trigger.role !== 'button') return { row: null, ambiguous: false };
  for (let index = triggerIndex - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row?.parsed) continue;
    if (row.indent < trigger.indent) break;
    if (row.indent !== trigger.indent || !row.parsed.ref) continue;
    if (row.role === 'button') continue;
    if (!SEMANTIC_CONTROL_VALUE_OWNER_ROLES.has(row.role)) return { row: null, ambiguous: false };
    const ownerIdentity = `${row.identityText} ${semanticControlStructuralContext(rows, index)}`;
    if (semanticControlCoverage(wantedTokens, ownerIdentity) < 1) return { row: null, ambiguous: false };
    const pairing = semanticControlAssociatedTriggerRow(rows, index, wantedTokens);
    if (pairing.ambiguous) return { row: null, ambiguous: true, candidates: pairing.candidates };
    return pairing.row?.index === triggerIndex
      ? { row, ambiguous: false, source: pairing.source }
      : { row: null, ambiguous: false };
  }
  return { row: null, ambiguous: false };
}

function semanticControlDomMatch(row, evidence, snapshotRoleCounts, label, targetContract = {}) {
  const candidates = Array.isArray(evidence?.candidates) ? evidence.candidates : [];
  let best = null;
  let tied = false;
  let tiedCandidates = [];
  for (const candidate of candidates) {
    if (!semanticControlContextMatches(candidate, evidence, targetContract)) continue;
    const domRole = semanticControlRole(candidate?.role);
    if (domRole !== row.role && !(row.role === 'generic' && domRole)) continue;
    const pairs = [
      [row.parsed?.idAttr, candidate.id],
      [row.parsed?.testid, candidate.testid],
      [row.parsed?.placeholder, candidate.placeholder],
      [row.nameAttr, candidate.nameAttr],
    ];
    const stableHits = pairs.filter(([left, right]) => left && right
      && semanticControlNormalize(left) === semanticControlNormalize(right)).length;
    const nameMatch = row.parsed?.name && candidate.accessibleName
      && semanticControlNormalize(row.parsed.name) === semanticControlNormalize(candidate.accessibleName);
    const exactLabelAssociation = semanticControlExactLabelAssociation(candidate, label);
    const candidateBackendNodeId = semanticControlBackendIdentity(candidate);
    const backendNodeMatch = !!row.backendNodeId
      && !!candidateBackendNodeId
      && row.backendNodeId === candidateBackendNodeId;
    if (row.backendNodeId && candidateBackendNodeId && !backendNodeMatch) continue;
    const boundSnapshotRefs = [
      candidate.snapshotRef,
      candidate.accessibilityRef,
      candidate.mcpRef,
    ].map((value) => clean(value, 160)).filter(Boolean);
    const snapshotRefMatch = !!row.parsed?.ref && boundSnapshotRefs.includes(clean(row.parsed.ref, 160));
    const exactNodeBinding = backendNodeMatch || snapshotRefMatch;
    const countParity = Number(evidence?.roleCounts?.[domRole]) > 0
      && Number(evidence.roleCounts[domRole]) === Number(snapshotRoleCounts?.[row.role]);
    const ordinalMatch = countParity && Number(candidate.roleOrdinal) === Number(row.roleOrdinal);
    const duplicateUnnamedSnapshotRole = countParity
      && Number(snapshotRoleCounts?.[row.role]) > 1
      && !row.parsed?.name
      && !row.parsed?.idAttr
      && !row.parsed?.testid
      && !row.parsed?.placeholder;
    if (duplicateUnnamedSnapshotRole && !exactNodeBinding && !stableHits && !nameMatch && !exactLabelAssociation) continue;
    const identityAnchored = exactNodeBinding || stableHits > 0 || nameMatch || exactLabelAssociation;
    // Hit-testing and viewport state rank a proven identity; they must never
    // make an unrelated same-role control a candidate by themselves.
    if (!identityAnchored) continue;
    const score = (exactNodeBinding ? 1000 : 0)
      + stableHits * 200
      + (nameMatch ? 100 : 0)
      + (exactLabelAssociation ? 180 : 0)
      + (candidate.hitTarget === true ? 20 : 0)
      + (candidate.inViewport === true ? 10 : 0);
    if (!score) continue;
    if (!best || score > best.score) {
      best = {
        ...candidate,
        ...semanticControlCandidateContext(candidate, evidence),
        score,
        mappedRole: domRole,
        ordinalMatch,
        exactNodeBinding,
        backendNodeMatch,
        snapshotRefMatch,
        exactLabelAssociation,
      };
      tied = false;
      tiedCandidates = [];
    } else if (score === best.score) {
      const sameBackendNode = semanticControlBackendIdentity(best)
        && semanticControlBackendIdentity(best) === semanticControlBackendIdentity(candidate);
      const sameContext = semanticControlContextKey(best)
        === semanticControlContextKey(semanticControlCandidateContext(candidate, evidence));
      const bestOwnerIdentity = semanticControlActionOwnerIdentity(best, evidence);
      const candidateOwnerIdentity = semanticControlActionOwnerIdentity(candidate, evidence);
      const sameActionOwner = !!bestOwnerIdentity
        && bestOwnerIdentity === candidateOwnerIdentity;
      if ((!sameBackendNode && !sameActionOwner) || !sameContext) {
        tied = true;
        tiedCandidates = [best, candidate];
      }
    }
  }
  if (best && tied) {
    return {
      semanticAmbiguous: true,
      score: best.score,
      candidates: tiedCandidates.slice(0, 5).map((candidate) => ({
        role: semanticControlRole(candidate?.role) || null,
        accessibleName: clean(candidate?.accessibleName, 240) || null,
        id: clean(candidate?.id, 160) || null,
        testid: clean(candidate?.testid, 160) || null,
        placeholder: clean(candidate?.placeholder, 240) || null,
        ariaControls: clean(candidate?.ariaControls, 160) || null,
        ariaExpanded: candidate?.ariaExpanded ?? null,
        hitTarget: candidate?.hitTarget === true,
        inViewport: candidate?.inViewport === true,
        focused: candidate?.focused === true,
        actionOwnerIsSelf: candidate?.actionOwnerIsSelf === true,
        actionOwnerRole: semanticControlRole(candidate?.actionOwnerRole) || null,
        actionOwnerRoleOrdinal: Number.isInteger(Number(candidate?.actionOwnerRoleOrdinal))
          ? Number(candidate.actionOwnerRoleOrdinal)
          : null,
        actionOwnerId: clean(candidate?.actionOwnerId, 160) || null,
        actionOwnerAccessibleName: clean(candidate?.actionOwnerAccessibleName, 240) || null,
        ...semanticControlCandidateContext(candidate, evidence),
      })),
    };
  }
  return best;
}

function semanticControlInteractionOwnerRow(rows, domMatch) {
  if (!domMatch || domMatch.actionOwnerIsSelf !== false) return null;
  const ownerSnapshotRef = clean(domMatch.actionOwnerSnapshotRef || domMatch.actionOwnerRef, 160);
  if (ownerSnapshotRef) {
    const byRef = rows.find((row) => clean(row?.parsed?.ref, 160) === ownerSnapshotRef);
    if (byRef?.parsed?.ref) return byRef;
  }
  const ownerBackendNodeId = Number(domMatch.actionOwnerBackendNodeId);
  if (Number.isFinite(ownerBackendNodeId) && ownerBackendNodeId > 0) {
    const byBackendNode = rows.find((row) => row.backendNodeId === ownerBackendNodeId);
    if (byBackendNode?.parsed?.ref) return byBackendNode;
  }
  const ownerId = clean(domMatch.actionOwnerId, 160);
  if (ownerId) {
    const byId = rows.find((row) => clean(row?.parsed?.idAttr, 160) === ownerId);
    if (byId?.parsed?.ref) return byId;
  }
  return null;
}

function semanticControlPublicCandidate(candidate) {
  return {
    ref: candidate.ref,
    role: candidate.role,
    name: candidate.name || null,
    score: candidate.score,
    identityCoverage: candidate.identityCoverage,
    ownerCoverage: candidate.ownerCoverage,
    expanded: candidate.expanded,
    frameId: candidate.frameId || null,
    framePath: candidate.framePath || [],
    shadowPath: candidate.shadowPath || [],
    ownerPromoted: candidate.ownerPromoted === true,
    semanticConsistency: candidate.semanticConsistency || null,
    resolvedControl: candidate.resolvedControl || null,
  };
}

function semanticControlExpanded(row, domMatch) {
  if (domMatch?.semanticExpanded === true) return true;
  if (domMatch?.ariaExpanded === true || String(domMatch?.ariaExpanded).toLowerCase() === 'true') return true;
  return /\[(?:expanded|aria-expanded=(?:true|"true"|'true'))\]/i.test(String(row?.parsed?.rest || ''));
}

function semanticControlChecked(row, domMatch) {
  if (domMatch?.checked === true || String(domMatch?.ariaChecked).toLowerCase() === 'true') return true;
  return /\[(?:checked|aria-checked=(?:true|"true"|'true'))\]/i.test(String(row?.parsed?.rest || ''));
}

function semanticControlOwnedPopupVisible(rows, candidateIndex, ownerTokens) {
  const popupRoles = new Set(['dialog', 'grid', 'listbox', 'option']);
  return rows.some((row, index) => {
    if (!row.parsed?.ref || !popupRoles.has(row.role) || index === candidateIndex) return false;
    const context = `${row.identityText} ${semanticControlStructuralContext(rows, index)}`;
    return semanticControlCoverage(ownerTokens, context) === 1;
  });
}

function semanticControlOwnerOpen(rows, ownerLabel) {
  const ownerTokens = semanticControlTokens(ownerLabel, { stripSurface: true });
  const ownerName = semanticControlNormalize(ownerLabel);
  if (!ownerTokens.length) return false;
  return rows.some((row, index) => {
    if (!row.parsed?.ref) return false;
    if (!['button', 'combobox', 'listbox', 'searchbox', 'spinbutton', 'textbox', 'treeitem'].includes(row.role)) return false;
    const candidateName = semanticControlNormalize(row.parsed.name || '');
    const context = `${row.identityText} ${semanticControlStructuralContext(rows, index)}`;
    const identityMatches = candidateName === ownerName
      || (!!candidateName && (candidateName.includes(ownerName) || ownerName.includes(candidateName)))
      || semanticControlCoverage(ownerTokens, context) === 1;
    return identityMatches && (
      semanticControlExpanded(row, null)
      || semanticControlOwnedPopupVisible(rows, index, ownerTokens)
    );
  });
}

function semanticControlExactOptionCount(rows, label) {
  const expected = semanticControlNormalize(label);
  if (!expected) return 0;
  return rows.filter((row) => row.parsed?.ref
    && ['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem'].includes(row.role)
    && semanticControlNormalize(row.parsed.name || '') === expected).length;
}

function semanticControlBackendIdentity(candidate) {
  const value = Number(candidate?.backendNodeId);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function semanticControlActionOwnerIdentity(candidate, evidence = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const context = semanticControlContextKey(semanticControlCandidateContext(candidate, evidence));
  const backendNodeId = Number(candidate.actionOwnerBackendNodeId);
  if (Number.isFinite(backendNodeId) && backendNodeId > 0) {
    return `${context}::owner-backend:${backendNodeId}`;
  }
  const ownerId = clean(candidate.actionOwnerId, 160);
  if (ownerId) return `${context}::owner-id:${semanticControlNormalize(ownerId)}`;
  const ownerRole = semanticControlRole(candidate.actionOwnerRole);
  const ownerOrdinal = Number(candidate.actionOwnerRoleOrdinal);
  if (ownerRole && Number.isInteger(ownerOrdinal) && ownerOrdinal >= 0) {
    return `${context}::owner-role:${ownerRole}:${ownerOrdinal}`;
  }
  return null;
}

function resolveSemanticActionTarget(snapshotText, targetContract = {}) {
  const semanticTarget = targetContract.semanticTarget && typeof targetContract.semanticTarget === 'object'
    ? targetContract.semanticTarget
    : null;
  const optionTarget = semanticControlNormalize(semanticTarget?.kind) === 'option';
  const ownerInteractionConfirmed = optionTarget && targetContract.ownerInteractionConfirmed === true;
  const label = clean(optionTarget && semanticTarget?.name
    ? semanticTarget.name
    : targetContract.label || targetContract.name || targetContract.target || '');
  const ownerLabel = clean(targetContract.ownerScope?.ownerTarget || targetContract.ownerTarget || '');
  const wantedTokens = semanticControlTokens(label, { stripSurface: !optionTarget });
  const ownerTokens = semanticControlTokens(ownerLabel, { stripSurface: true });
  const acceptedRoles = semanticControlAcceptedRoles(targetContract.roleHints || targetContract.roles || [], semanticTarget);
  const semanticKind = semanticControlNormalize(semanticTarget?.kind);
  const semanticControlKind = semanticControlNormalize(semanticTarget?.controlKind);
  const preferTriggerRequested = semanticKind === 'control opener' && semanticTarget?.preferTrigger === true;
  const roleIntent = new Set(Array.from(acceptedRoles));
  const labelTokens = new Set(semanticControlTokens(label));
  const disclosureTarget = semanticKind === 'control opener' && semanticControlKind === 'disclosure';
  const radioTarget = roleIntent.has('radio') || roleIntent.has('menuitemradio');
  const temporalFacet = !radioTarget ? semanticControlTemporalFacet(label) : null;
  const dateTarget = !radioTarget && (temporalFacet === 'date' || semanticKind.startsWith('calendar'));
  const timeTarget = !radioTarget && temporalFacet === 'time';
  const temporalScopeTokens = semanticControlTemporalScopeTokens(label);
  if (ownerInteractionConfirmed) {
    acceptedRoles.add('listitem');
    acceptedRoles.add('generic');
  }
  const { rows, roleCounts } = semanticControlSnapshotRows(snapshotText);
  const ownedTriggerAvailable = semanticKind === 'control opener'
    && semanticControlKind === 'choice'
    && rows.some((row, index) => SEMANTIC_CONTROL_VALUE_OWNER_ROLES.has(row.role)
      && semanticControlAssociatedTriggerRow(rows, index, wantedTokens).row);
  const preferTrigger = preferTriggerRequested || ownedTriggerAvailable;
  const beforeRows = targetContract.snapshotBefore
    ? semanticControlSnapshotRows(targetContract.snapshotBefore).rows
    : [];
  const ownerOpen = optionTarget && ownerTokens.length
    ? semanticControlOwnerOpen(rows, ownerLabel)
    : false;
  const temporalOwnerProof = optionTarget
    && beforeRows.length > 0
    && semanticControlExactOptionCount(beforeRows, label) === 0;
  const candidates = [];
  const domIdentityAmbiguities = [];
  const controlNodeAmbiguities = [];

  if (!snapshotText || !wantedTokens.length) {
    return { ok: false, ref: null, code: 'semantic_control_identity_missing', candidateCount: 0, candidates: [] };
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.parsed?.ref || row.parsed.disabled || row.parsed.readonly) continue;
    if (!SEMANTIC_CONTROL_ROLES.has(row.role)) continue;
    let domMatch = semanticControlDomMatch(
      row,
      targetContract.domEvidence,
      roleCounts,
      label,
      targetContract,
    );
    if (domMatch?.semanticAmbiguous === true) {
      const snapshotTriggerOwnerLabel = row.role === 'button'
        ? semanticControlTriggerOwnerLabel(rows, index)
        : '';
      const snapshotAdjacentLabel = row.role !== 'generic'
        ? semanticControlNearestStaticLabel(rows, index)
        : '';
      const snapshotHasExactTypedIdentity = row.role !== 'generic'
        && !clean(row.parsed?.name)
        && acceptedRoles.has(row.role)
        && [row.parsed?.name, snapshotAdjacentLabel].some((value) => (
          semanticControlComparableLabel(value) === semanticControlComparableLabel(label)
        ));
      const snapshotOwnsRequestedControl = semanticKind === 'control opener'
        && semanticControlCoverage(wantedTokens, snapshotTriggerOwnerLabel) === 1;
      if (!snapshotOwnsRequestedControl && !snapshotHasExactTypedIdentity) {
        const ambiguousSnapshotIdentity = [
          row.identityText,
          semanticControlStructuralContext(rows, index),
          snapshotTriggerOwnerLabel,
          snapshotAdjacentLabel,
        ].filter(Boolean).join(' ');
        const relevantCoverage = semanticControlCoverage(wantedTokens, ambiguousSnapshotIdentity);
        const relevantMinimum = wantedTokens.length <= 2 ? 1 : (2 / 3);
        if (relevantCoverage >= relevantMinimum) {
          domIdentityAmbiguities.push(...(Array.isArray(domMatch.candidates) ? domMatch.candidates : []));
        }
        continue;
      }
      // A labelled accessibility owner can uniquely scope an otherwise generic
      // trigger even when lower-level DOM candidates share the same role/name.
      domMatch = null;
    }
    const expectedContext = semanticControlExpectedContext(targetContract);
    const contextConstrained = !!(
      expectedContext.frameId
      || expectedContext.framePath.length
      || expectedContext.shadowPath.length
    );
    if (contextConstrained
      && Number(targetContract.domEvidence?.roleCounts?.[row.role]) > 1
      && domMatch
      && domMatch.ordinalMatch !== true) continue;
    const domInteractionOwnerRow = semanticControlInteractionOwnerRow(rows, domMatch);
    const snapshotInteractionOwner = row.role === 'button'
      ? semanticControlTriggerOwnerRow(rows, index, wantedTokens)
      : { row: null, ambiguous: false };
    if (snapshotInteractionOwner.ambiguous) {
      controlNodeAmbiguities.push(...(snapshotInteractionOwner.candidates || []));
      continue;
    }
    const interactionOwnerRow = domInteractionOwnerRow || snapshotInteractionOwner.row;
    const resolvedRow = interactionOwnerRow || row;
    const resolvedIndex = interactionOwnerRow ? interactionOwnerRow.index : index;
    const ownerPromoted = !!interactionOwnerRow;
    const domOwnerPromoted = !!domInteractionOwnerRow;
    const triggerPair = row.role === 'button' && ownerPromoted
      ? { row, ambiguous: false, source: domOwnerPromoted ? 'dom_action_owner' : snapshotInteractionOwner.source }
      : semanticControlAssociatedTriggerRow(rows, resolvedIndex, wantedTokens);
    if (triggerPair.ambiguous && semanticKind === 'control opener') {
      controlNodeAmbiguities.push(...(triggerPair.candidates || []));
      continue;
    }
    const interactionRow = triggerPair.row || (ownerPromoted ? row : resolvedRow);
    const interactionIndex = interactionRow.index;
    const interactionRole = interactionRow.role;
    const effectiveRole = ownerPromoted
      ? semanticControlRole(domOwnerPromoted ? domMatch?.actionOwnerRole : resolvedRow.role) || resolvedRow.role
      : semanticControlRole(domMatch?.role) || resolvedRow.role;
    if (acceptedRoles.size
      && !acceptedRoles.has(resolvedRow.role)
      && !acceptedRoles.has(effectiveRole)) continue;
    if (domMatch && (domMatch.visible === false || domMatch.enabled === false)) continue;

    const directText = resolvedRow.identityText;
    const structuralText = semanticControlStructuralContext(rows, resolvedIndex);
    const nearestStaticLabel = semanticControlNearestStaticLabel(rows, resolvedIndex);
    const nearestGroupLabel = temporalFacet ? semanticControlNearestGroupLabel(rows, resolvedIndex) : '';
    const localTemporalFacet = semanticControlTemporalFacet(nearestStaticLabel);
    if (temporalFacet && localTemporalFacet && temporalFacet !== localTemporalFacet) continue;
    const resolvedDomLabels = domOwnerPromoted
      ? (Array.isArray(domMatch?.actionOwnerAssociatedLabels) ? domMatch.actionOwnerAssociatedLabels : [])
      : snapshotInteractionOwner.row ? []
        : (Array.isArray(domMatch?.associatedLabels) ? domMatch.associatedLabels : []);
    const resolvedDomName = domOwnerPromoted
      ? domMatch?.actionOwnerAccessibleName
      : snapshotInteractionOwner.row ? null : domMatch?.accessibleName;
    const resolvedDomPlaceholder = domOwnerPromoted
      ? domMatch?.actionOwnerPlaceholder
      : snapshotInteractionOwner.row ? null : domMatch?.placeholder;
    const scopedDomLabels = semanticControlScopedLabelTexts(domMatch, domOwnerPromoted);
    const primaryDomScopeLabel = temporalFacet
      ? semanticControlPrimaryScopeLabel(domMatch, temporalScopeTokens, domOwnerPromoted)
      : '';
    const scopedTemporalCoverage = temporalFacet && temporalScopeTokens.length && primaryDomScopeLabel
      ? semanticControlCoverage(temporalScopeTokens, primaryDomScopeLabel)
      : 0;
    if (temporalFacet
      && primaryDomScopeLabel
      && semanticControlScopeContradicts(temporalScopeTokens, primaryDomScopeLabel)) continue;
    const formalDomIdentityText = [
      resolvedDomName,
      ...resolvedDomLabels,
      resolvedDomPlaceholder,
      ownerPromoted ? domMatch?.actionOwnerId : domMatch?.id,
      ownerPromoted ? domMatch?.actionOwnerNameAttr : domMatch?.nameAttr,
      ownerPromoted ? domMatch?.actionOwnerTestid : domMatch?.testid,
    ].filter(Boolean).join(' ');
    const directDomTemporalFacet = semanticControlTemporalFacet([
      resolvedDomName,
      resolvedDomPlaceholder,
    ].filter(Boolean).join(' '));
    if (temporalFacet && directDomTemporalFacet && temporalFacet !== directDomTemporalFacet) continue;
    const domIdentityText = [
      formalDomIdentityText,
      domMatch?.nearbyText,
      domMatch?.ownerText,
      domMatch?.controlledByText,
      ...(temporalFacet && primaryDomScopeLabel ? [primaryDomScopeLabel] : scopedDomLabels),
    ].filter(Boolean).join(' ');
    const directCoverage = semanticControlCoverage(wantedTokens, directText);
    const structuralCoverage = semanticControlCoverage(wantedTokens, structuralText);
    const staticLabelCoverage = semanticControlCoverage(wantedTokens, nearestStaticLabel);
    const domCoverage = semanticControlCoverage(wantedTokens, domIdentityText);
    const combinedCoverage = semanticControlCoverage(
      wantedTokens,
      `${structuralText} ${nearestGroupLabel} ${nearestStaticLabel} ${domIdentityText}`,
    );
    // Temporal widgets are frequently exposed as a generic "Date"/"Time"
    // control inside a labelled group.  The nearest preceding temporal label
    // is only one signal: responsive and two-column layouts can place a sibling
    // label closer in accessibility-tree order than the control's real owner.
    // Require the authored scope across the complete owner context instead of
    // letting that one neighboring label veto an otherwise exact structural or
    // DOM relationship.
    const temporalScopeCoverage = temporalScopeTokens.length
      ? semanticControlCoverage(
          temporalScopeTokens,
          `${structuralText} ${nearestGroupLabel} ${nearestStaticLabel} ${domIdentityText}`,
        )
      : 1;
    if (temporalFacet
      && temporalScopeTokens.length
      && temporalScopeCoverage < 1
      && directCoverage < 1) continue;
    const baseIdentityCoverage = Math.max(
      directCoverage,
      structuralCoverage,
      staticLabelCoverage,
      domCoverage,
      combinedCoverage,
    );
    const directNormalized = semanticControlNormalize(
      resolvedRow.parsed.name || resolvedDomName || '',
    );
    const directTokens = new Set(semanticControlTokens(directNormalized));
    const wantedNormalized = semanticControlNormalize(label);
    const triggerOwnerLabel = interactionRole === 'button'
      ? semanticControlTriggerOwnerLabel(rows, interactionIndex)
      : '';
    const interactionNormalized = semanticControlNormalize(interactionRow.parsed.name || interactionRow.identityText || '');
    const namedTrigger = /\b(?:dropdown|drop down|menu|picker|calendar|select)\b/.test(interactionNormalized)
      && /\b(?:trigger|toggle|open|button)\b/.test(interactionNormalized);
    const triggerLikeName = interactionRole === 'button'
      && (namedTrigger || (preferTrigger && !!triggerOwnerLabel));
    const triggerLabelCoverage = semanticControlCoverage(wantedTokens, triggerOwnerLabel);
    const snapshotOwnedTriggerIdentity = semanticKind === 'control opener'
      && triggerLikeName
      && triggerLabelCoverage === 1;
    const identityCoverage = Math.max(baseIdentityCoverage, triggerLabelCoverage);
    const exactName = !!directNormalized && directNormalized === wantedNormalized;
    const containsName = !!directNormalized && !!wantedNormalized
      && (directNormalized.includes(wantedNormalized) || wantedNormalized.includes(directNormalized));
    const wantedTimeIdentity = optionTarget ? semanticControlNormalizeTime(label) : null;
    const resolvedTimeIdentity = optionTarget
      ? semanticControlNormalizeTime(resolvedRow.parsed.name || resolvedDomName || '')
      : null;
    const equivalentTimeName = !!wantedTimeIdentity && resolvedTimeIdentity === wantedTimeIdentity;
    const exactStaticLabel = !!nearestStaticLabel
      && semanticControlComparableLabel(nearestStaticLabel) === semanticControlComparableLabel(label);
    const exactDomLabel = domMatch?.exactLabelAssociation === true;
    const disclosureOwnerMatches = semanticControlComparableLabel(domMatch?.disclosureOwnerName)
      === semanticControlComparableLabel(label)
      || (Array.isArray(domMatch?.disclosureOwnerLabels)
        && domMatch.disclosureOwnerLabels.some((value) => semanticControlComparableLabel(value)
          === semanticControlComparableLabel(label)));
    if (preferTrigger && (
      interactionRole !== 'button'
      || (triggerLabelCoverage < 1 && !disclosureOwnerMatches)
    )) continue;
    const inputType = semanticControlNormalize(domMatch?.inputType);
    if (dateTarget && inputType === 'time') continue;
    if (timeTarget && inputType === 'date') continue;

    const ownerText = [structuralText, domMatch?.ownerText, domMatch?.controlledByText].filter(Boolean).join(' ');
    const ownerCoverage = ownerTokens.length ? semanticControlCoverage(ownerTokens, ownerText) : 1;
    const formalDomCoverage = semanticControlCoverage(wantedTokens, formalDomIdentityText);
    const domRelationText = [
      domMatch?.controlledByText,
      domMatch?.actionOwnerAccessibleName,
      ...(Array.isArray(domMatch?.actionOwnerAssociatedLabels) ? domMatch.actionOwnerAssociatedLabels : []),
    ].filter(Boolean).join(' ');
    const domRelationCoverage = semanticControlCoverage(wantedTokens, domRelationText);
    const formalDomIdentityPresent = semanticControlTokens(formalDomIdentityText).length > 0;
    const authoritativeDomMinimumCoverage = wantedTokens.length <= 2 ? 1 : (2 / 3);
    if (!optionTarget
      && domMatch
      && formalDomIdentityPresent
      && formalDomCoverage < authoritativeDomMinimumCoverage
      && domRelationCoverage < authoritativeDomMinimumCoverage
      && scopedTemporalCoverage < 1
      && !disclosureOwnerMatches
      && !snapshotOwnedTriggerIdentity) continue;

    const requestedAction = semanticControlNormalize(
      targetContract.requestedAction || targetContract.action
        || (optionTarget ? 'select'
          : radioTarget ? 'check'
            : dateTarget && semanticKind !== 'control opener' ? 'date'
              : timeTarget && semanticKind !== 'control opener' ? 'time'
                : semanticKind === 'control opener' ? 'click' : ''),
    ).replace(/\s+/g, '_');
    let resolvedControlType = clean(targetContract.requestedControlType || targetContract.controlType, 80).toLowerCase();
    if (!resolvedControlType && optionTarget) resolvedControlType = 'option';
    if (!resolvedControlType && dateTarget) {
      if (inputType === 'date') resolvedControlType = 'date_input';
      else if (exactDomLabel || (!domMatch && (
        directCoverage === 1 || exactStaticLabel || structuralCoverage === 1 || combinedCoverage === 1
      ))) resolvedControlType = 'date_picker';
    }
    if (!resolvedControlType && timeTarget) {
      if (inputType === 'time') resolvedControlType = 'time_input';
      else if (exactDomLabel || (!domMatch && (
        directCoverage === 1 || exactStaticLabel || structuralCoverage === 1 || combinedCoverage === 1
      ))) resolvedControlType = 'time_picker';
    }
    const controlIdentityLabels = [
      ...resolvedDomLabels,
      resolvedDomName,
      resolvedDomPlaceholder,
      domMatch?.controlledByText,
      directText,
      nearestStaticLabel,
      structuralText,
      nearestGroupLabel,
      triggerOwnerLabel,
    ];
    const resolvedControl = universalControlModel.createUniversalControl({
      action: requestedAction || 'click',
      target: label,
      ...(resolvedControlType ? { controlType: resolvedControlType } : {}),
      ownerNode: {
        ref: resolvedRow.parsed.ref,
        backendNodeId: domOwnerPromoted
          ? domMatch?.actionOwnerBackendNodeId
          : resolvedRow.backendNodeId || (resolvedRow === row ? domMatch?.backendNodeId : null),
        role: effectiveRole,
        tag: domOwnerPromoted ? domMatch?.actionOwnerTagName : domMatch?.tagName,
        inputType: domOwnerPromoted ? domMatch?.actionOwnerInputType : domMatch?.inputType,
        accessibleName: resolvedDomName || resolvedRow.parsed.name || null,
        associatedLabels: controlIdentityLabels,
        placeholder: resolvedDomPlaceholder || resolvedRow.parsed.placeholder || null,
        frameId: domMatch?.frameId || null,
        framePath: domMatch?.framePath || [],
        shadowPath: domMatch?.shadowPath || [],
        visible: domMatch ? domMatch.visible !== false : true,
        enabled: domMatch ? domMatch.enabled !== false : true,
      },
      interactionNode: {
        ref: interactionRow.parsed.ref,
        backendNodeId: interactionRow.backendNodeId || (interactionRow === row ? domMatch?.backendNodeId : null),
        role: interactionRole,
        accessibleName: interactionRow.parsed.name || (interactionRow === resolvedRow ? resolvedDomName : null) || null,
        associatedLabels: controlIdentityLabels,
        frameId: domMatch?.frameId || null,
        framePath: domMatch?.framePath || [],
        shadowPath: domMatch?.shadowPath || [],
        visible: domMatch ? domMatch.visible !== false : true,
        enabled: domMatch ? domMatch.enabled !== false : true,
      },
      valueNode: {
        ref: resolvedRow.parsed.ref,
        backendNodeId: domOwnerPromoted
          ? domMatch?.actionOwnerBackendNodeId
          : resolvedRow.backendNodeId || (resolvedRow === row ? domMatch?.backendNodeId : null),
        role: effectiveRole,
        accessibleName: resolvedDomName || resolvedRow.parsed.name || null,
        associatedLabels: controlIdentityLabels,
        frameId: domMatch?.frameId || null,
        framePath: domMatch?.framePath || [],
        shadowPath: domMatch?.shadowPath || [],
        visible: domMatch ? domMatch.visible !== false : true,
        enabled: domMatch ? domMatch.enabled !== false : true,
      },
      relationships: {
        ownerToTrigger: triggerPair.row ? triggerPair.source || 'associated_trigger' : 'owner_is_interaction',
      },
    });
    const semanticConsistency = universalControlModel.compareSemanticIdentity(resolvedControl);
    if (!semanticConsistency.ok) continue;
    if (optionTarget) {
      const matchKind = semanticControlNormalize(semanticTarget?.match || 'exact');
      const optionMatches = matchKind === 'contains'
        ? containsName || exactName || equivalentTimeName
        : exactName || equivalentTimeName;
      const looseOptionRole = resolvedRow.role === 'listitem' || resolvedRow.role === 'generic';
      const ownerProven = !ownerTokens.length || ownerCoverage === 1 || ownerOpen
        || temporalOwnerProof || ownerInteractionConfirmed;
      if (looseOptionRole && !ownerInteractionConfirmed) continue;
      if (!optionMatches || !ownerProven) continue;
    } else {
      const distinctiveFieldIdentity = wantedTokens.some((wantedToken) => (
        SEMANTIC_CONTROL_DISTINCTIVE_FIELD_TOKENS.has(wantedToken)
        && directTokens.has(wantedToken)
      ));
      const minimumCoverage = distinctiveFieldIdentity
        ? (1 / wantedTokens.length)
        : wantedTokens.length <= 2 ? 1 : (2 / 3);
      if (!exactName && !containsName && identityCoverage < minimumCoverage) continue;
    }

    let score = identityCoverage * 160 + ownerCoverage * (ownerTokens.length ? 100 : 0);
    if (exactName) score += 240;
    else if (equivalentTimeName) score += 230;
    else if (containsName) score += 120;
    if (domCoverage === 1) score += 100;
    if (structuralCoverage === 1) score += 80;
    if (combinedCoverage === 1) score += 140;
    if (temporalFacet && localTemporalFacet === temporalFacet) score += 320;
    if (temporalFacet && temporalScopeCoverage === 1) score += 260;
    if (temporalFacet && scopedTemporalCoverage === 1) score += 520;
    if (staticLabelCoverage === 1) score += 180;
    if (exactStaticLabel) score += 260;
    if (exactDomLabel) score += 360;
    const explicitOwnedTrigger = snapshotOwnedTriggerIdentity;
    if (explicitOwnedTrigger) score += 800;
    if (radioTarget && ['radio', 'menuitemradio'].includes(effectiveRole)) score += 220;
    if (dateTarget && inputType === 'date') score += 260;
    if (timeTarget && inputType === 'time') score += 260;
    if (acceptedRoles.has(effectiveRole) || acceptedRoles.has(resolvedRow.role)) score += 30;
    if (domMatch?.hitTarget === true) score += 160;
    if (domMatch?.inViewport === true) score += 40;
    if (domMatch?.focused === true) score += 80;
    const expanded = semanticControlExpanded(resolvedRow, domMatch);
    const inheritedDisclosureEvidence = domMatch?.disclosureOwnerIsSelf === false
      && disclosureOwnerMatches
      && (domMatch?.disclosureOwnerAriaExpanded != null || !!domMatch?.disclosureOwnerAriaControls);
    const visibleDisclosureContent = disclosureTarget
      && ['button', 'treeitem'].includes(effectiveRole)
      && semanticControlVisibleDisclosureContent(rows, resolvedIndex);
    const disclosureCapable = expanded
      || domMatch?.ariaExpanded != null
      || !!domMatch?.ariaControls
      || inheritedDisclosureEvidence
      || visibleDisclosureContent
      || resolvedRow.role === 'treeitem'
      || /\b(?:aria-controls|aria-expanded)\b/i.test(String(resolvedRow.parsed?.rest || ''));
    const disclosureRoleCompatible = ['button', 'treeitem', 'generic'].includes(effectiveRole)
      || (exactDomLabel && ['combobox', 'listbox', 'searchbox', 'spinbutton', 'textbox'].includes(effectiveRole));
    if (disclosureTarget && (!disclosureCapable || !disclosureRoleCompatible)) continue;
    const checked = semanticControlChecked(resolvedRow, domMatch);
    const explicitlyCollapsed = domMatch?.semanticExpanded === false
      || domMatch?.ariaExpanded === false
      || String(domMatch?.ariaExpanded).toLowerCase() === 'false'
      || /\[(?:collapsed|expanded=false|aria-expanded=(?:false|"false"|'false'))\]/i.test(
        String(resolvedRow?.parsed?.rest || ''),
      );
    const phaseAlreadySatisfied = !optionTarget && !explicitlyCollapsed && (
      expanded
      || (radioTarget && checked)
      || semanticControlOwnedPopupVisible(rows, resolvedIndex, wantedTokens)
    );
    const context = semanticControlCandidateContext(domMatch || {}, targetContract.domEvidence || {});
    candidates.push({
      ref: resolvedRow.parsed.ref,
      role: effectiveRole || resolvedRow.role,
      name: resolvedRow.parsed.name || resolvedDomName || '',
      score,
      index: resolvedIndex,
      identityCoverage,
      ownerCoverage,
      expanded,
      disclosureCapable,
      exactLabelAssociation: exactDomLabel || exactStaticLabel,
      hitTarget: domMatch?.hitTarget === true,
      inViewport: domMatch?.inViewport === true,
      focused: domMatch?.focused === true,
      backendNodeId: semanticControlBackendIdentity(ownerPromoted
        ? { backendNodeId: domMatch?.actionOwnerBackendNodeId }
        : domMatch),
      ...context,
      ownerPromoted,
      semanticConsistency,
      scopedLabels: scopedDomLabels,
      primaryScopeLabel: primaryDomScopeLabel || null,
      resolvedControl,
      ownerProof: ownerCoverage === 1 ? 'structural_owner'
        : ownerOpen ? 'expanded_owner'
          : temporalOwnerProof ? 'new_after_owner_open'
            : ownerInteractionConfirmed ? 'owner_interaction_confirmed' : null,
      phaseAlreadySatisfied,
    });
  }

  const disclosureCandidates = disclosureTarget
    ? candidates.filter((candidate) => candidate.disclosureCapable)
    : [];
  // A disclosure action must never degrade into clicking an arbitrary child
  // merely because it shares section text. No proven disclosure owner means
  // no compatible semantic control.
  const eligibleCandidates = disclosureTarget ? disclosureCandidates : candidates;
  const deduped = Array.from(new Map(eligibleCandidates.map((candidate) => [
    `${semanticControlContextKey(candidate)}::${candidate.backendNodeId
      ? `backend:${candidate.backendNodeId}`
      : `ref:${candidate.ref}`}`,
    candidate,
  ])).values())
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = deduped[0] || null;
  if (!best) {
    if (domIdentityAmbiguities.length || controlNodeAmbiguities.length) {
      return {
        ok: false,
        ref: null,
        code: 'ambiguous_semantic_control',
        ambiguous: true,
        unique: false,
        candidateCount: 2,
        confidenceMargin: 0,
        candidates: [...domIdentityAmbiguities, ...controlNodeAmbiguities].slice(0, 5),
      };
    }
    return { ok: false, ref: null, code: 'no_compatible_semantic_control', candidateCount: 0, candidates: [] };
  }
  const runnerUp = deduped[1] || null;
  const confidenceMargin = runnerUp ? best.score - runnerUp.score : best.score;
  if (runnerUp && confidenceMargin < 20) {
    const interactionWinners = deduped.filter((candidate) => candidate.hitTarget === true
      && candidate.inViewport === true);
    if (interactionWinners.length === 1) {
      const winner = interactionWinners[0];
      return {
        ok: true,
        ref: winner.ref,
        code: 'semantic_control_resolved_by_dom_interaction',
        candidateCount: 1,
        confidenceMargin: winner.score,
        phaseAlreadySatisfied: winner.phaseAlreadySatisfied === true,
        resolvedCandidate: semanticControlPublicCandidate(winner),
        candidates: deduped.slice(0, 5).map(semanticControlPublicCandidate),
        fulfilledBy: 'snapshot_dom_interaction_semantic_control',
      };
    }
    return {
      ok: false,
      ref: null,
      code: 'ambiguous_semantic_control',
      ambiguous: true,
      unique: false,
      candidateCount: deduped.length,
      confidenceMargin,
      candidates: deduped.slice(0, 5).map(semanticControlPublicCandidate),
    };
  }
  return {
    ok: true,
    ref: best.ref,
    code: 'semantic_control_resolved',
    candidateCount: 1,
    confidenceMargin,
    phaseAlreadySatisfied: best.phaseAlreadySatisfied === true,
    resolvedCandidate: semanticControlPublicCandidate(best),
    candidates: deduped.slice(0, 5).map(semanticControlPublicCandidate),
    fulfilledBy: targetContract.domEvidence ? 'snapshot_dom_semantic_control' : 'snapshot_semantic_control',
  };
}

const SEMANTIC_PRE_DISPATCH_STATES = new Set([
  'not_dispatched',
  'pending',
  'resolved',
  'precondition_proven',
]);

function recoverSemanticActionTargetBeforeDispatch({
  snapshotText,
  targetContract = {},
  previousResolution = null,
  dispatchStatus = 'not_dispatched',
} = {}) {
  const previousRef = clean(
    typeof previousResolution === 'string' ? previousResolution : previousResolution?.ref,
    160,
  );
  const normalizedDispatchStatus = semanticControlNormalize(dispatchStatus).replace(/\s+/g, '_')
    || 'not_dispatched';
  if (!previousRef) return resolveSemanticActionTarget(snapshotText, targetContract);

  const { rows } = semanticControlSnapshotRows(snapshotText);
  const previousRefStillCurrent = rows.some((row) => clean(row?.parsed?.ref, 160) === previousRef);
  if (previousRefStillCurrent) {
    const current = resolveSemanticActionTarget(snapshotText, targetContract);
    return {
      ...current,
      previousRef,
      staleRef: false,
      recoveredBeforeDispatch: false,
    };
  }

  if (!SEMANTIC_PRE_DISPATCH_STATES.has(normalizedDispatchStatus)) {
    return {
      ok: false,
      ref: null,
      code: 'stale_ref_recovery_forbidden_after_dispatch',
      staleRef: true,
      previousRef,
      dispatchStatus: normalizedDispatchStatus,
      candidateCount: 0,
      candidates: [],
    };
  }

  const recovered = resolveSemanticActionTarget(snapshotText, targetContract);
  if (!recovered.ok || !recovered.ref) {
    return {
      ...recovered,
      staleRef: true,
      previousRef,
      dispatchStatus: normalizedDispatchStatus,
      recoveredBeforeDispatch: false,
    };
  }
  return {
    ...recovered,
    code: 'semantic_control_recovered_before_dispatch',
    staleRef: true,
    previousRef,
    dispatchStatus: normalizedDispatchStatus,
    recoveredBeforeDispatch: true,
  };
}

const SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION = `(${function qaaiSemanticControlEvidence() {
  const clean = (value, max = 240) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  const attr = (node, name) => node?.getAttribute ? clean(node.getAttribute(name)) : '';
  const explicitRole = (node) => attr(node, 'role').toLowerCase().replace(/[^a-z]/g, '');
  const roleOf = (node) => {
    const explicit = explicitRole(node);
    if (explicit) return explicit;
    const tag = String(node?.tagName || '').toLowerCase();
    const type = attr(node, 'type').toLowerCase();
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
    return 'generic';
  };
  const visible = (node) => {
    if (!node || node.nodeType !== 1) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.width > 0 && rect.height > 0;
  };
  const interactionFacts = (node) => {
    const rect = node?.getBoundingClientRect?.();
    if (!rect) return { inViewport: false, hitTarget: false };
    const x = Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2));
    const inViewport = rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    const hit = inViewport ? document.elementFromPoint(x, y) : null;
    return {
      inViewport,
      hitTarget: !!hit && (hit === node || node.contains?.(hit) || hit.contains?.(node)),
    };
  };
  const labelledText = (node) => {
    const ids = attr(node, 'aria-labelledby').split(/\s+/).filter(Boolean);
    const root = node?.getRootNode?.();
    return ids.map((id) => clean(
      root?.getElementById?.(id)?.textContent || document.getElementById(id)?.textContent,
    )).filter(Boolean);
  };
  const associatedLabels = (node) => {
    if (!node) return [];
    return Array.from(new Set([
      ...Array.from(node.labels || []).map((label) => clean(label.textContent)),
      ...labelledText(node),
      clean(node.closest?.('label')?.textContent),
    ].filter(Boolean)));
  };
  const accessibleName = (node) => {
    if (!node) return '';
    return clean(
      attr(node, 'aria-label') || associatedLabels(node)[0] || attr(node, 'title')
        || (['BUTTON', 'SUMMARY', 'A', 'LI'].includes(node.tagName)
          || ['option', 'listitem', 'menuitem', 'menuitemradio', 'menuitemcheckbox'].includes(explicitRole(node))
          || node.hasAttribute?.('data-value') || node.hasAttribute?.('data-option') || node.hasAttribute?.('data-item')
          ? node.textContent : ''),
    );
  };
  const scopedLabelCache = new WeakMap();
  const scopedLabels = (node) => {
    if (!node || !node.getBoundingClientRect) return [];
    if (scopedLabelCache.has(node)) return scopedLabelCache.get(node);
    const nodeRect = node.getBoundingClientRect();
    const entries = [];
    const seenNodes = new Set();
    const add = (labelNode, depth, source) => {
      if (!labelNode || seenNodes.has(labelNode) || labelNode === node
        || labelNode.contains?.(node) || node.contains?.(labelNode) || !visible(labelNode)) return;
      const text = clean(attr(labelNode, 'aria-label') || labelNode.textContent, 160);
      if (!text || text.length > 140) return;
      const rect = labelNode.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return;
      const horizontalOverlap = Math.max(0, Math.min(nodeRect.right, rect.right) - Math.max(nodeRect.left, rect.left));
      const verticalOverlap = Math.max(0, Math.min(nodeRect.bottom, rect.bottom) - Math.max(nodeRect.top, rect.top));
      const aboveGap = nodeRect.top - rect.bottom;
      const leftGap = nodeRect.left - rect.right;
      const centerDistance = Math.abs((nodeRect.left + nodeRect.right) / 2 - (rect.left + rect.right) / 2);
      const above = aboveGap >= -6 && aboveGap <= 280
        && (horizontalOverlap > 0 || centerDistance <= Math.max(180, nodeRect.width));
      const left = leftGap >= -6 && leftGap <= 220 && verticalOverlap > 0;
      if (!above && !left) return;
      seenNodes.add(labelNode);
      entries.push({
        text,
        score: depth * 500 + (above ? Math.max(0, aboveGap) : Math.max(0, leftGap))
          + centerDistance * 0.2 + (source === 'semantic' ? 0 : 80),
      });
    };
    const semanticSelector = 'label, legend, h1, h2, h3, h4, h5, h6, [role="heading"], [data-label], [class*="label"]';
    let branch = node;
    let container = node.parentElement;
    for (let depth = 0; container && depth < 7; depth += 1) {
      for (const labelNode of Array.from(container.querySelectorAll?.(semanticSelector) || [])) {
        add(labelNode, depth, 'semantic');
      }
      let sibling = branch.previousElementSibling;
      for (let count = 0; sibling && count < 3; count += 1, sibling = sibling.previousElementSibling) {
        const interactiveCount = sibling.querySelectorAll?.('input, textarea, select, button, [role="combobox"], [role="listbox"]').length || 0;
        if (interactiveCount === 0) add(sibling, depth, 'sibling');
      }
      branch = container;
      container = container.parentElement;
      if (container === document.body || container === document.documentElement) break;
    }
    const labels = entries
      .sort((left, right) => left.score - right.score)
      .filter((entry, index, values) => values.findIndex((item) => item.text === entry.text) === index)
      .slice(0, 6)
      .map((entry) => entry.text);
    scopedLabelCache.set(node, labels);
    return labels;
  };
  const nearbyText = (node) => {
    const out = [];
    let sibling = node.previousElementSibling;
    for (let count = 0; sibling && count < 3; count += 1, sibling = sibling.previousElementSibling) {
      const value = clean(sibling.textContent, 120);
      if (value) out.unshift(value);
    }
    sibling = node.nextElementSibling;
    for (let count = 0; sibling && count < 3; count += 1, sibling = sibling.nextElementSibling) {
      const value = clean(sibling.textContent, 120);
      if (value) out.push(value);
    }
    const wrapper = node.closest?.('fieldset, [role="group"], [class*="field"], [class*="control"], .form-group');
    if (wrapper && wrapper !== node) out.push(clean(wrapper.textContent, 240));
    return clean(out.join(' '), 320);
  };
  const expandedState = (node) => {
    const explicit = attr(node, 'aria-expanded').toLowerCase();
    if (explicit === 'true') return true;
    if (explicit === 'false') return false;
    if (node?.tagName === 'DETAILS' || node?.hasAttribute?.('open')) return !!node.open || node.hasAttribute('open');
    let owner = node;
    for (let depth = 0; owner && depth < 5; depth += 1, owner = owner.parentElement) {
      const classes = Array.from(owner.classList || []);
      if (classes.some((value) => /(?:^|[-_])expanded(?:$|[-_])/i.test(value))) return true;
      if (classes.some((value) => /(?:^|[-_])collapsed(?:$|[-_])/i.test(value))) return false;
    }
    return null;
  };
  const selector = 'input, textarea, select, button, summary, a[href], li, [role], [aria-haspopup], [aria-expanded], [aria-controls], [onclick], [tabindex], [contenteditable="true"], [data-value], [data-option], [data-item]';
  const queryAllDeep = (root, output = []) => {
    for (const node of Array.from(root?.querySelectorAll?.(selector) || [])) {
      output.push(node);
    }
    for (const host of Array.from(root?.querySelectorAll?.('*') || [])) {
      if (host.shadowRoot) queryAllDeep(host.shadowRoot, output);
    }
    return output;
  };
  const allNodes = Array.from(new Set(queryAllDeep(document)));
  const stablePathSegment = (node) => {
    if (!node || node.nodeType !== 1) return '';
    const id = attr(node, 'id');
    if (id) return `#${id}`;
    for (const name of ['data-qaai-id', 'data-testid', 'data-test-id', 'data-automation-id']) {
      const value = attr(node, name);
      if (value) return `${String(node.tagName || '*').toLowerCase()}[${name}="${value}"]`;
    }
    const tag = String(node.tagName || '*').toLowerCase();
    const parent = node.parentElement;
    if (!parent) return tag;
    const siblings = Array.from(parent.children || []).filter((item) => item.tagName === node.tagName);
    return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag;
  };
  const shadowPathFor = (node) => {
    const path = [];
    let root = node?.getRootNode?.();
    while (root && root.host) {
      path.unshift(stablePathSegment(root.host));
      root = root.host.getRootNode?.();
    }
    return path.filter(Boolean);
  };
  const suppliedFrameContext = window.__QAAI_FRAME_CONTEXT__
    && typeof window.__QAAI_FRAME_CONTEXT__ === 'object'
    ? window.__QAAI_FRAME_CONTEXT__
    : {};
  const evidenceContext = {
    frameId: clean(suppliedFrameContext.frameId || document.documentElement?.getAttribute?.('data-qaai-frame-id')) || null,
    framePath: Array.isArray(suppliedFrameContext.framePath)
      ? suppliedFrameContext.framePath.map((item) => clean(item && typeof item === 'object' ? item.selector || item.ref || item.id : item)).filter(Boolean)
      : [],
  };
  const popupSurfaceSelector = '[role="listbox"], [role="menu"], [role="tree"], [role="grid"], [role="dialog"], [aria-modal="true"]';
  const popupRoles = new Set([
    'listbox', 'menu', 'tree', 'grid', 'dialog',
    'option', 'listitem', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'row', 'gridcell',
  ]);
  const controlledIds = new Set(allNodes
    .filter((node) => attr(node, 'aria-expanded').toLowerCase() === 'true')
    .flatMap((node) => attr(node, 'aria-controls').split(/\s+/).filter(Boolean)));
  const priorityNodes = allNodes.filter((node) => {
    if (!visible(node)) return false;
    const role = roleOf(node);
    const insidePopup = !!node.closest?.(popupSurfaceSelector);
    return popupRoles.has(role)
      || insidePopup
      || attr(node, 'aria-expanded').toLowerCase() === 'true'
      || controlledIds.has(attr(node, 'id'))
      || expandedState(node) != null
      || interactionFacts(node).inViewport === true
      || document.activeElement === node;
  }).slice(0, 320);
  const selectedNodes = new Set([...allNodes.slice(0, 160), ...priorityNodes]);
  const nodes = allNodes.filter((node) => selectedNodes.has(node));
  const controllersById = new Map();
  for (const controller of allNodes) {
    for (const controlledId of attr(controller, 'aria-controls').split(/\s+/).filter(Boolean)) {
      if (!controllersById.has(controlledId)) controllersById.set(controlledId, []);
      controllersById.get(controlledId).push(controller);
    }
  }
  const roleCounts = {};
  const roleOrdinals = {};
  const roleOrdinalByNode = new WeakMap();
  for (const node of nodes) {
    const role = roleOf(node);
    const ordinal = roleOrdinals[role] || 0;
    roleOrdinalByNode.set(node, ordinal);
    roleOrdinals[role] = ordinal + 1;
    roleCounts[role] = (roleCounts[role] || 0) + 1;
  }
  const actionOwnerSelector = [
    'button', 'summary', 'a[href]', 'input', 'textarea', 'select',
    '[role="button"]', '[role="combobox"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="spinbutton"]', '[role="slider"]', '[role="tab"]',
    '[role="treeitem"]', '[contenteditable="true"]', '[aria-haspopup]', '[aria-expanded]',
  ].join(', ');
  const candidates = nodes.map((node) => {
    const role = roleOf(node);
    const roleOrdinal = roleOrdinalByNode.get(node) || 0;
    const owner = node.closest?.('[role="listbox"], [role="dialog"], [role="grid"], [role="group"], fieldset, form');
    const disclosureOwner = node.closest?.('[aria-expanded], [aria-controls], summary');
    const actionOwner = node.closest?.(actionOwnerSelector) || node;
    const actionOwnerRole = roleOf(actionOwner);
    const nodeId = attr(node, 'id');
    const controllers = nodeId ? (controllersById.get(nodeId) || []) : [];
    const controlledByText = controllers.map((controller) => [
      accessibleName(controller),
      ...associatedLabels(controller),
      nearbyText(controller),
    ].filter(Boolean).join(' ')).join(' ');
    const interaction = interactionFacts(node);
    return {
      role,
      roleOrdinal,
      frameId: evidenceContext.frameId,
      framePath: evidenceContext.framePath,
      shadowPath: shadowPathFor(node),
      tagName: String(node.tagName || '').toLowerCase() || null,
      inputType: attr(node, 'type').toLowerCase() || null,
      accessibleName: accessibleName(node),
      associatedLabels: associatedLabels(node),
      scopedLabels: scopedLabels(node),
      nearbyText: nearbyText(node),
      ownerText: clean([accessibleName(owner), owner?.textContent].filter(Boolean).join(' '), 400),
      controlledByText: clean(controlledByText, 400),
      id: nodeId || null,
      nameAttr: attr(node, 'name') || null,
      placeholder: attr(node, 'placeholder') || null,
      testid: attr(node, 'data-testid') || attr(node, 'data-test-id') || attr(node, 'data-test')
        || attr(node, 'data-qa') || attr(node, 'data-cy') || attr(node, 'data-automation-id') || null,
      ariaControls: attr(node, 'aria-controls') || null,
      ariaExpanded: attr(node, 'aria-expanded') || null,
      semanticExpanded: expandedState(node),
      checked: typeof node.checked === 'boolean' ? node.checked : null,
      ariaChecked: attr(node, 'aria-checked') || null,
      disclosureOwnerAriaControls: attr(disclosureOwner, 'aria-controls') || null,
      disclosureOwnerAriaExpanded: attr(disclosureOwner, 'aria-expanded') || null,
      disclosureOwnerIsSelf: disclosureOwner === node,
      disclosureOwnerName: accessibleName(disclosureOwner),
      disclosureOwnerLabels: associatedLabels(disclosureOwner),
      actionOwnerIsSelf: actionOwner === node,
      actionOwnerRole,
      actionOwnerRoleOrdinal: roleOrdinalByNode.get(actionOwner) ?? null,
      actionOwnerId: attr(actionOwner, 'id') || null,
      actionOwnerTagName: String(actionOwner?.tagName || '').toLowerCase() || null,
      actionOwnerInputType: attr(actionOwner, 'type').toLowerCase() || null,
      actionOwnerAccessibleName: accessibleName(actionOwner),
      actionOwnerAssociatedLabels: associatedLabels(actionOwner),
      actionOwnerScopedLabels: scopedLabels(actionOwner),
      actionOwnerNameAttr: attr(actionOwner, 'name') || null,
      actionOwnerPlaceholder: attr(actionOwner, 'placeholder') || null,
      actionOwnerTestid: attr(actionOwner, 'data-testid') || attr(actionOwner, 'data-test-id')
        || attr(actionOwner, 'data-test') || attr(actionOwner, 'data-qaai-id') || null,
      value: node.isContentEditable
        ? clean(node.textContent, 2000)
        : ('value' in node ? String(node.value == null ? '' : node.value) : null),
      selectedValue: node.tagName === 'SELECT' && node.selectedOptions?.[0]
        ? String(node.selectedOptions[0].value == null ? '' : node.selectedOptions[0].value)
        : null,
      selectedText: node.tagName === 'SELECT' && node.selectedOptions?.[0]
        ? clean(node.selectedOptions[0].textContent, 500)
        : null,
      ...interaction,
      focused: document.activeElement === node,
      visible: visible(node),
      enabled: !node.disabled && attr(node, 'aria-disabled') !== 'true',
    };
  });
  return { schema: 'qaai-semantic-control-dom-evidence/1', context: evidenceContext, candidates, roleCounts };
}.toString()})`;

function proveSemanticControlOpen(plan, observation = {}) {
  const snapshotAfter = observation.snapshotAfter || observation.snapshotText || '';
  const snapshotBefore = observation.snapshotBeforeOpen || '';
  const roleHints = plan?.phases?.[0]?.resolution?.roleHints || [];
  const semanticTarget = plan?.phases?.[0]?.semanticTarget || { kind: 'control_opener' };
  const resolution = resolveSemanticActionTarget(snapshotAfter, {
    label: plan?.target,
    roleHints,
    semanticTarget,
  });
  const directlyExpanded = observation.ariaExpanded === true
    || String(observation.ariaExpanded).toLowerCase() === 'true'
    || resolution?.resolvedCandidate?.expanded === true;
  if (directlyExpanded || resolution?.phaseAlreadySatisfied === true) {
    return {
      kind: 'control_open', matched: true, checked: true, status: 'pass',
      reason: directlyExpanded ? 'semantic_control_expanded' : 'owner_scoped_popup_visible',
    };
  }
  const popupPattern = /^\s*-\s+(?:dialog|grid|listbox)\b/i;
  const optionPattern = /^\s*-\s+(?:option|menuitem|menuitemradio|menuitemcheckbox|treeitem)\b/i;
  const beforePopups = new Set(String(snapshotBefore).split(/\r?\n/).filter((line) => popupPattern.test(line)).map(semanticControlNormalize));
  const afterPopups = String(snapshotAfter).split(/\r?\n/).filter((line) => popupPattern.test(line));
  const newPopups = afterPopups.filter((line) => !beforePopups.has(semanticControlNormalize(line)));
  const beforeOptions = new Set(String(snapshotBefore).split(/\r?\n/).filter((line) => optionPattern.test(line)).map(semanticControlNormalize));
  const afterOptions = String(snapshotAfter).split(/\r?\n/).filter((line) => optionPattern.test(line));
  const newOptions = afterOptions.filter((line) => !beforeOptions.has(semanticControlNormalize(line)));
  const temporallyScopedPopup = resolution?.ok === true && (newPopups.length === 1 || newOptions.length > 0);
  return {
    kind: 'control_open',
    matched: temporallyScopedPopup,
    checked: true,
    status: temporallyScopedPopup ? 'pass' : 'fail',
    reason: temporallyScopedPopup
      ? (newPopups.length === 1 ? 'unique_new_control_popup_visible' : 'new_control_options_visible')
      : 'semantic_control_open_state_not_proven',
  };
}

module.exports = {
  MUTATING_ELEMENT_TOOLS,
  COORDINATE_ELEMENT_TOOLS,
  VERIFIED_DOM_INSPECTION_SOURCE,
  VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
  VERIFIED_STRUCTURAL_DOM_SOURCE,
  VERIFIED_COORDINATE_DOM_SOURCE,
  ACTIVE_DOM_EXCAVATION_SOURCE,
  SEMANTIC_DOM_SCOUT_SOURCE,
  KNOWLEDGE_BASE_CANDIDATE_SOURCE,
  resolveForTool,
  fulfillForTool,
  forceExcavateDeepLocator,
  captureStructuralLocator,
  captureCoordinateLocator,
  captureSensitiveInputLocator,
  resolveVerifiedForTool,
  buildActionLocatorFromInspection,
  buildActionLocatorFromAuthoritativeCapture,
  isVerifiedActionLocator,
  verifiedActionLocatorOrNull,
  isExportSafeActionLocator,
  exportSafeActionLocatorOrNull,
  actionLocatorNeedsPrecisionUpgrade,
  candidatesFromActionLocator,
  fieldActionLocator,
  primaryActionLocator,
  expressionForKnowledgeBase,
  domAtlasFromActionLocator,
  buildLocatorEvidenceRecord,
  normalizeDomAtlasForAction,
  targetRefsForTool,
  coordinateFromArgs,
  chooseCandidate,
  locatorCandidateRank,
  locatorCandidateWarnings,
  cleanAccessibleName,
  containsGlyphContamination,
  isGlyphOnlyName,
  buildVerifiedFromSnapshotRef,
  buildFallbackFromSnapshotRef,
  buildVerifiedFromKbEntry,
  locatorExpressionIsExportSafe,
  locatorExpressionVolatility,
  locatorStabilityProven,
  buildActedNodeFingerprint,
  attachAuthoritativeCdpEvidence,
  reverifyCandidateAgainstAuthoritativeCapture,
  isSensitiveInputIntent,
  actionLocatorGap,
  coordinateGap,
  resolveSemanticActionTarget,
  recoverSemanticActionTargetBeforeDispatch,
  SEMANTIC_CONTROL_DOM_EVIDENCE_FUNCTION,
  proveSemanticControlOpen,
};
