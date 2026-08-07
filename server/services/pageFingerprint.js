'use strict';

const crypto = require('crypto');

const SCHEMA = 'qaai_page_fingerprint_v1';
const SECRET_ASSIGNMENT_RE = /\b(password|passcode|pwd|secret|token|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi;

function clean(value, limit = 240) {
  return String(value == null ? '' : value)
    .replace(SECRET_ASSIGNMENT_RE, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname.replace(/\/+$/, '') || '/'}`;
  } catch (_) {
    return clean(value, 500).replace(/[?#].*$/, '').replace(/\/+$/, '') || null;
  }
}

function unique(items, limit = 40) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = typeof item === 'string' ? clean(item) : item;
    const key = typeof value === 'string' ? value.toLowerCase() : JSON.stringify(value || null);
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function authStateSignals(input = {}) {
  const text = clean([
    input.primaryHeading,
    ...(input.controls || []).map((control) => typeof control === 'string' ? control : `${control.role || ''} ${control.name || ''}`),
    ...(input.fields || []).map((field) => typeof field === 'string' ? field : `${field.type || ''} ${field.name || ''}`),
  ].join(' '), 4000).toLowerCase();
  return {
    passwordPromptVisible: /\b(password|passcode|pwd)\b/.test(text),
    loginControlVisible: /\b(log[ -]?in|sign[ -]?in|authenticate)\b/.test(text),
    logoutControlVisible: /\b(log[ -]?out|sign[ -]?out)\b/.test(text),
    accountControlVisible: /\b(profile|account|user menu|avatar)\b/.test(text),
  };
}

function buildPageFingerprint(input = {}) {
  const fields = unique((input.fields || []).map((field) => {
    if (typeof field === 'string') return { name: clean(field) };
    return {
      name: clean(field && (field.name || field.label || field.placeholder), 120) || null,
      role: clean(field && field.role, 40) || null,
      type: clean(field && field.type, 40) || null,
      autocomplete: clean(field && field.autocomplete, 80) || null,
      required: field && field.required === true,
      disabled: field && field.disabled === true,
    };
  }));
  const controls = unique((input.controls || []).map((control) => {
    if (typeof control === 'string') return { name: clean(control) };
    return {
      name: clean(control && (control.name || control.label || control.text), 120) || null,
      role: clean(control && control.role, 40) || null,
      disabled: control && control.disabled === true,
      selected: control && control.selected === true,
      checked: control && control.checked === true,
    };
  }));
  const base = {
    schema: SCHEMA,
    url: normalizedUrl(input.url),
    title: clean(input.title, 160) || null,
    primaryHeading: clean(input.primaryHeading, 180) || null,
    landmarks: unique(input.landmarks || [], 20),
    fields,
    controls,
    activeDialog: input.activeDialog ? {
      name: clean(input.activeDialog.name || input.activeDialog.text, 160) || null,
      role: clean(input.activeDialog.role || 'dialog', 40),
    } : null,
    messages: unique(input.messages || [], 15),
  };
  base.authState = input.authState && typeof input.authState === 'object'
    ? { ...authStateSignals(base), ...input.authState }
    : authStateSignals(base);
  base.structuralHash = stableHash({
    url: base.url,
    title: base.title,
    primaryHeading: base.primaryHeading,
    landmarks: base.landmarks,
    fields: base.fields,
    controls: base.controls,
    activeDialog: base.activeDialog,
    authState: base.authState,
  });
  base.observedAt = input.observedAt || new Date().toISOString();
  return base;
}

function fromSnapshotText({ url = null, title = null, snapshotText = '' } = {}) {
  const fields = [];
  const controls = [];
  const landmarks = [];
  const messages = [];
  let primaryHeading = null;
  let activeDialog = null;
  for (const rawLine of String(snapshotText || '').split(/\r?\n/)) {
    const line = clean(rawLine, 500);
    if (!line) continue;
    const match = line.match(/(?:^|[-*]\s+)(heading|textbox|searchbox|combobox|checkbox|radio|switch|button|link|dialog|alertdialog|navigation|main|form|alert|status)\s+(?:"([^"]*)"|'([^']*)'|([^\[]+))?/i);
    if (!match) continue;
    const role = match[1].toLowerCase();
    const name = clean(match[2] || match[3] || match[4] || '', 160) || null;
    if (role === 'heading' && !primaryHeading) primaryHeading = name;
    if (['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch'].includes(role)) fields.push({ role, name, type: role });
    else if (['button', 'link'].includes(role)) controls.push({ role, name });
    else if (['navigation', 'main', 'form'].includes(role)) landmarks.push(name ? `${role}:${name}` : role);
    else if (role === 'dialog' || role === 'alertdialog') activeDialog = { role, name };
    else if (role === 'alert' || role === 'status') messages.push(name);
  }
  return buildPageFingerprint({ url, title, primaryHeading, landmarks, fields, controls, activeDialog, messages });
}

function structuralSignature(fingerprint = {}) {
  return JSON.stringify({
    url: normalizedUrl(fingerprint.url),
    title: clean(fingerprint.title).toLowerCase(),
    primaryHeading: clean(fingerprint.primaryHeading).toLowerCase(),
    landmarks: unique(fingerprint.landmarks).map((value) => clean(value).toLowerCase()).sort(),
    fields: unique((fingerprint.fields || []).map((field) => `${clean(field.role).toLowerCase()}:${clean(field.name).toLowerCase()}:${clean(field.type).toLowerCase()}`)).sort(),
    controls: unique((fingerprint.controls || []).map((control) => `${clean(control.role).toLowerCase()}:${clean(control.name).toLowerCase()}`)).sort(),
    dialog: fingerprint.activeDialog ? `${clean(fingerprint.activeDialog.role).toLowerCase()}:${clean(fingerprint.activeDialog.name).toLowerCase()}` : '',
  });
}

function equivalent(left, right) {
  return structuralSignature(left) === structuralSignature(right);
}

function diff(left = {}, right = {}) {
  const changed = [];
  if (normalizedUrl(left.url) !== normalizedUrl(right.url)) changed.push('url');
  if (clean(left.title).toLowerCase() !== clean(right.title).toLowerCase()) changed.push('title');
  if (clean(left.primaryHeading).toLowerCase() !== clean(right.primaryHeading).toLowerCase()) changed.push('primary_heading');
  if (JSON.stringify(left.fields || []) !== JSON.stringify(right.fields || [])) changed.push('fields');
  if (JSON.stringify(left.controls || []) !== JSON.stringify(right.controls || [])) changed.push('controls');
  if (JSON.stringify(left.activeDialog || null) !== JSON.stringify(right.activeDialog || null)) changed.push('dialog');
  if (JSON.stringify(left.messages || []) !== JSON.stringify(right.messages || [])) changed.push('messages');
  return { changed: changed.length > 0, channels: changed };
}

function includesNormalized(actual, expected) {
  const haystack = clean(actual, 4000).toLowerCase();
  const needle = clean(expected, 500).toLowerCase();
  return !!needle && haystack.includes(needle);
}

function expectedValues(value) {
  return (Array.isArray(value) ? value : [value]).filter((item) => item != null && String(item).trim());
}

function urlMatchesPattern(actualUrl, pattern) {
  const actual = String(actualUrl || '').toLowerCase();
  const expected = String(pattern || '').trim().toLowerCase();
  if (!actual || !expected) return false;
  if (!expected.includes('*')) return actual.includes(expected);
  const escaped = expected.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try { return new RegExp(escaped, 'i').test(actual); } catch (_) { return false; }
}

function matchesExpectedState(fingerprint = {}, expectedState = {}) {
  if (!expectedState || typeof expectedState !== 'object' || Array.isArray(expectedState)) {
    return { matched: false, checked: false, reason: 'no_typed_expected_state', checks: [] };
  }

  const checks = [];
  const add = (channel, expected, actual, matched) => checks.push({ channel, expected, actual, matched: matched === true });

  for (const pattern of expectedValues(expectedState.urlPattern || expectedState.url)) {
    add('url', pattern, fingerprint.url || null, urlMatchesPattern(fingerprint.url, pattern));
  }
  for (const title of expectedValues(expectedState.titleIncludes || expectedState.title)) {
    add('title', title, fingerprint.title || null, includesNormalized(fingerprint.title, title));
  }
  for (const heading of expectedValues(expectedState.primaryHeadingIncludes || expectedState.primaryHeading)) {
    add('primary_heading', heading, fingerprint.primaryHeading || null, includesNormalized(fingerprint.primaryHeading, heading));
  }

  const visibleSurface = [
    fingerprint.title,
    fingerprint.primaryHeading,
    ...(fingerprint.landmarks || []),
    ...(fingerprint.fields || []).map((field) => `${field?.role || ''} ${field?.name || ''}`),
    ...(fingerprint.controls || []).map((control) => `${control?.role || ''} ${control?.name || ''}`),
    fingerprint.activeDialog ? `${fingerprint.activeDialog.role || ''} ${fingerprint.activeDialog.name || ''}` : '',
    ...(fingerprint.messages || []),
  ].filter(Boolean).join(' ');
  for (const text of expectedValues(expectedState.visibleText || expectedState.text)) {
    add('visible_text', text, visibleSurface, includesNormalized(visibleSurface, text));
  }

  const expectedControl = expectedState.control && typeof expectedState.control === 'object'
    ? expectedState.control
    : null;
  if (expectedControl) {
    const role = clean(expectedControl.role, 40).toLowerCase();
    const name = clean(expectedControl.name || expectedControl.label, 160);
    const matchedControl = (fingerprint.controls || []).find((control) => {
      const roleMatches = !role || clean(control?.role, 40).toLowerCase() === role;
      const nameMatches = !name || includesNormalized(control?.name, name) || includesNormalized(name, control?.name);
      return roleMatches && nameMatches;
    }) || null;
    add('control', { role: role || null, name: name || null }, matchedControl, !!matchedControl);
  }

  const expectedField = expectedState.field && typeof expectedState.field === 'object'
    ? expectedState.field
    : null;
  if (expectedField) {
    const role = clean(expectedField.role, 40).toLowerCase();
    const name = clean(expectedField.name || expectedField.label, 160);
    const type = clean(expectedField.type, 40).toLowerCase();
    const matchedField = (fingerprint.fields || []).find((field) => {
      const roleMatches = !role || clean(field?.role, 40).toLowerCase() === role;
      const nameMatches = !name || includesNormalized(field?.name, name) || includesNormalized(name, field?.name);
      const typeMatches = !type || clean(field?.type, 40).toLowerCase() === type;
      return roleMatches && nameMatches && typeMatches;
    }) || null;
    add('field', { role: role || null, name: name || null, type: type || null }, matchedField, !!matchedField);
  }

  const checked = checks.length > 0;
  const matched = checked && checks.every((check) => check.matched);
  return {
    matched,
    checked,
    reason: !checked ? 'no_typed_expected_state' : matched ? 'expected_state_matched' : 'expected_state_not_matched',
    checks,
  };
}

const PAGE_FINGERPRINT_FN = `() => {
  const norm = (value, limit = 180) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
  const visible = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const nameOf = (node) => norm(node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.getAttribute('placeholder') || node.textContent);
  const fields = [...document.querySelectorAll('input, textarea, select, [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"]')]
    .filter(visible).slice(0, 40).map((node) => ({
      name: nameOf(node), role: node.getAttribute('role') || null,
      type: node.getAttribute('type') || node.tagName.toLowerCase(),
      autocomplete: node.getAttribute('autocomplete') || null,
      required: node.required === true || node.getAttribute('aria-required') === 'true',
      disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
    }));
  const controls = [...document.querySelectorAll('button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"]')]
    .filter(visible).slice(0, 60).map((node) => ({
      name: nameOf(node), role: node.getAttribute('role') || node.tagName.toLowerCase(),
      disabled: node.disabled === true || node.getAttribute('aria-disabled') === 'true',
      selected: node.getAttribute('aria-selected') === 'true', checked: node.getAttribute('aria-checked') === 'true',
    }));
  const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')].find(visible);
  const messages = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')].filter(visible).map((node) => norm(node.textContent, 200)).filter(Boolean).slice(0, 15);
  const heading = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"], [role="heading"]')].find(visible);
  const landmarks = [...document.querySelectorAll('main, nav, form, [role="main"], [role="navigation"], [role="form"]')].filter(visible).slice(0, 20).map((node) => norm((node.getAttribute('role') || node.tagName.toLowerCase()) + ':' + (node.getAttribute('aria-label') || ''));
  return { url: location.href, title: document.title, primaryHeading: norm(heading?.textContent), landmarks, fields, controls, activeDialog: dialog ? { role: dialog.getAttribute('role') || 'dialog', name: nameOf(dialog) } : null, messages };
}`;

module.exports = {
  SCHEMA,
  PAGE_FINGERPRINT_FN,
  buildPageFingerprint,
  fromSnapshotText,
  structuralSignature,
  equivalent,
  diff,
  matchesExpectedState,
  normalizedUrl,
};
