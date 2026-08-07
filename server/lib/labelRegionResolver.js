'use strict';

/**
 * Label-region LIVE ref resolver (B-2e control-loop fix).
 *
 * The loose resolver matched "User Role dropdown" to a nearby non-interactive
 * heading ("Add User", ref e158); the static-click guard then correctly refused
 * it — but with no recovery the conductor looped. This resolver turns that block
 * into a REPAIR: given the accessibility snapshot and the intended target label,
 * it finds the label's text in the tree and returns the nearest INTERACTIVE ref
 * (combobox / textbox / listbox / button / role-less custom trigger), skipping
 * static elements (heading / img / landmarks). Generic — works for custom role-
 * less dropdowns where role+name resolution fails.
 *
 * Pure: `parseSnapshotLine` (from mcp.js) is injected. Returns a ref string or null.
 */

const INTERACTIVE = new Set(['button', 'link', 'combobox', 'listbox', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'option', 'menuitem', 'spinbutton', 'slider', 'tab']);
const STATIC = new Set(['heading', 'img', 'image', 'banner', 'navigation', 'main', 'complementary', 'contentinfo', 'separator', 'paragraph']);
const PLACEHOLDERISH = /--\s*select\s*--|(?:^|\s)select\b|choose|combobox|dropdown|\bopen\b/i;

function refOf(line) { const m = /\[ref=([^\]\s]+)\]/.exec(String(line || '')); return m ? m[1] : null; }

function normLabel(s) {
  return String(s || '').toLowerCase()
    .replace(/\b(dropdown|combobox|select|field|input|button|box|list|the|control|widget|trigger|menu)\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @returns {string|null} the ref of the interactive control associated with `label`.
 */
function resolveInteractiveRefNearLabel(snapshotText, label, parseSnapshotLine = null, opts = {}) {
  const labelNorm = normLabel(label);
  if (!labelNorm) return null;
  const words = labelNorm.split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return null;
  const within = opts.within || 6; // search this many lines after the label anchor
  const lines = String(snapshotText || '').split(/\r?\n/).map((raw) => {
    const p = parseSnapshotLine ? parseSnapshotLine(raw) : null;
    return { raw, low: raw.toLowerCase(), role: String((p && p.role) || '').toLowerCase(), name: String((p && p.name) || '').toLowerCase(), ref: refOf(raw) };
  });

  // 1) Direct hit: an INTERACTIVE line whose own name carries the label words.
  for (const l of lines) {
    if (l.ref && INTERACTIVE.has(l.role) && words.some((w) => l.name.includes(w))) return l.ref;
  }

  // 2) Label anchor → nearest interactive (or role-less control-ish) ref after it,
  //    skipping clearly-static elements. Handles custom role-less dropdowns.
  for (let i = 0; i < lines.length; i++) {
    const anchor = lines[i];
    const labelHere = words.every((w) => anchor.low.includes(w)) || (words.length > 1 && words.filter((w) => anchor.low.includes(w)).length >= Math.ceil(words.length / 2));
    if (!labelHere) continue;
    for (let j = i; j < Math.min(lines.length, i + 1 + within); j++) {
      const c = lines[j];
      if (!c.ref) continue;
      if (j === i && INTERACTIVE.has(c.role) && words.some((w) => c.name.includes(w))) return c.ref; // same-line control
      if (STATIC.has(c.role)) continue; // never a heading/img/landmark
      if (INTERACTIVE.has(c.role)) return c.ref;
      // role-less / generic custom trigger: accept when it looks like a control
      if ((c.role === 'generic' || c.role === 'text' || c.role === '') && PLACEHOLDERISH.test(c.raw)) return c.ref;
    }
  }
  return null;
}

module.exports = { resolveInteractiveRefNearLabel, normLabel, refOf, INTERACTIVE, STATIC };
