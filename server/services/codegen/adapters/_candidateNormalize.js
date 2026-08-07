'use strict';
/**
 * Shared locator-candidate normalizer for the ReplayIR adapters (P7b BDD, P7c Selenium).
 *
 * The KB sometimes stores a Playwright getBy* EXPRESSION inside a candidate's `css.selector`
 * (e.g. `getByRole("textbox", { name: "Username" })`, `getByText("Login button")`) rather
 * than a real CSS selector. Re-encoding it to the proper candidate strategy is LOSSLESS (the
 * same resolved evidence) and is what makes the generated glue actually runnable — a literal
 * `By.cssSelector("getByText(...)")` / `page.locator("getByText(...)")` would compile but
 * never match. This is NOT fabrication: nothing is invented, the recorded intent is preserved.
 *
 * Single source of truth so the BDD and Selenium adapters can never drift (the
 * [[buildrefrolemap-parser-drift]] / codegen-consolidation lesson: project from ONE parser).
 */

function semanticNameForRole(role, name) {
  const raw = String(name || '').replace(/\s+/g, ' ').trim();
  if (!raw) return raw;
  const r = String(role || '').toLowerCase();
  if (['button', 'link', 'menuitem'].includes(r)) {
    // Extended: also strip navigation-domain nouns (category, nav, section, menu…) that the
    // Conductor appends when crawling nav trees but which aren't in the aria-label.
    const m = raw.match(/^(.+?)\s+(button|link|submit|control|icon|action|category|subcategory|section|nav|navigation|menu|item|tab|panel|badge|chip)$/i);
    return m ? m[1].trim() : raw;
  }
  if (['textbox', 'searchbox', 'combobox'].includes(r)) {
    const m = raw.match(/^(.+?)\s+(input|field|textbox|searchbox|combobox|entry|box)$/i);
    return m ? m[1].trim() : raw;
  }
  if (['tab', 'option', 'menuitem', 'listitem'].includes(r)) {
    const m = raw.match(/^(.+?)\s+(tab|option|item|panel|section|category|subcategory|menu)$/i);
    return m ? m[1].trim() : raw;
  }
  // Generic fallback for any role not covered above: strip the same descriptor vocabulary.
  const m = raw.match(/^(.+?)\s+(button|link|field|input|category|subcategory|menu|item|tab|panel|section|icon|navigation|nav|dropdown|select|widget|control|element|area|region)$/i);
  return m ? m[1].trim() : raw;
}

function preserveCandidateEvidence(original, normalized) {
  if (!original || typeof original !== 'object') return normalized;
  return {
    ...original,
    ...normalized,
    normalizationMetadata: {
      ...(original.normalizationMetadata && typeof original.normalizationMetadata === 'object'
        ? original.normalizationMetadata
        : {}),
      sourceStrategy: original.strategy || null,
      evidencePreserved: true,
    },
  };
}

function withCandidateWarning(candidate, code, detail) {
  if (!candidate || typeof candidate !== 'object') return candidate;
  const existing = Array.isArray(candidate.warningMetadata) ? candidate.warningMetadata : [];
  if (existing.some((warning) => warning && warning.code === code)) return candidate;
  return {
    ...candidate,
    warningMetadata: [
      ...existing,
      { code, detail, nonBlocking: true, localized: true },
    ],
  };
}

function candidateFromTextDescriptor(text, extra = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { strategy: 'text', text: raw, ...extra };
  let m = raw.match(/^(.+?)\s+(button|submit)$/i);
  if (m) return { strategy: 'role', role: 'button', name: semanticNameForRole('button', m[1].trim()), ...extra };
  m = raw.match(/^(.+?)\s+link$/i);
  if (m) return { strategy: 'role', role: 'link', name: semanticNameForRole('link', m[1].trim()), ...extra };
  m = raw.match(/^(.+?)\s+(menu item|menuitem)$/i);
  if (m) return { strategy: 'role', role: 'menuitem', name: semanticNameForRole('menuitem', m[1].trim()), ...extra };
  // UI-widget suffixes that describe trigger buttons (profile menu, user dropdown, avatar icon,
  // settings toggle, hamburger trigger). These are interactive buttons — "button" is the correct
  // ARIA role. Without this mapping the text candidate is the only survivor but gets dropped by
  // isSyntheticTextCandidate (Pattern 1 matches "menu"/"dropdown"/etc.), leaving zero candidates
  // and blocking the export. This is the generic fix: widget descriptor → button role.
  m = raw.match(/^(.+?)\s+(menu|dropdown|drop-down|toggle|trigger|avatar|icon)$/i);
  if (m) return { strategy: 'role', role: 'button', name: semanticNameForRole('button', m[1].trim()), ...extra };
  m = raw.match(/^(.+?)\s+(input|field|textbox|searchbox|combobox)$/i);
  if (m) return { strategy: 'placeholder', text: m[1].trim(), ...extra };
  return { strategy: 'text', text: raw, ...extra };
}

function normalizeCandidate(c) {
  const extra = {};
  const cleanContext = (values) => (values || [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter((value) => value && !/[\u0080-\u00ff\ue000-\uf8ff]/.test(value));
  if (c && Array.isArray(c.contextText)) extra.contextText = cleanContext(c.contextText);
  if (c && Array.isArray(c.nearbyText)) extra.contextText = cleanContext(c.nearbyText);
  if (c && c.strategy === 'css' && typeof c.selector === 'string') {
    let m = c.selector.match(/getByRole\(\s*["']([^"']+)["']\s*,\s*\{\s*name:\s*["']([^"']+)["']/);
    if (m) return preserveCandidateEvidence(c, { strategy: 'role', role: m[1], name: semanticNameForRole(m[1], m[2]), ...extra });
    m = c.selector.match(/getByText\(\s*["']([^"']+)["']/); if (m) return preserveCandidateEvidence(c, candidateFromTextDescriptor(m[1], extra));
    m = c.selector.match(/getByLabel\(\s*["']([^"']+)["']/); if (m) return preserveCandidateEvidence(c, { strategy: 'label', text: m[1], ...extra });
    m = c.selector.match(/getByPlaceholder\(\s*["']([^"']+)["']/); if (m) return preserveCandidateEvidence(c, { strategy: 'placeholder', text: m[1], ...extra });
    m = c.selector.match(/getByTestId\(\s*["']([^"']+)["']/); if (m) return preserveCandidateEvidence(c, { strategy: 'testId', testId: m[1], ...extra });
    m = c.selector.match(/getByAltText\(\s*["']([^"']+)["']/); if (m) return preserveCandidateEvidence(c, { strategy: 'css', selector: `[alt="${m[1].replace(/"/g, '\\"')}"]`, ...extra });
    m = c.selector.match(/getByTitle\(\s*["']([^"']+)["']/); if (m) return preserveCandidateEvidence(c, { strategy: 'css', selector: `[title="${m[1].replace(/"/g, '\\"')}"]`, ...extra });
  }
  if (c && c.strategy === 'role' && c.name) {
    return preserveCandidateEvidence(c, { name: semanticNameForRole(c.role, c.name), ...extra });
  }
  if (c && c.strategy === 'text' && c.text) {
    return preserveCandidateEvidence(c, candidateFromTextDescriptor(c.text, extra));
  }
  return c && Object.keys(extra).length ? preserveCandidateEvidence(c, extra) : c;
}

function isSyntheticTextCandidate(c) {
  const n = normalizeCandidate(c) || {};
  if (n.strategy !== 'text' || !n.text) return false;
  const text = String(n.text || '').trim();
  // Drop text locators that are planning-layer descriptions, not actual page text.
  // Pattern 1: ends with a known descriptor noun ("Search Product input", "Submit button").
  if (/\S+\s+(input|button|link|field|dropdown|select|checkbox|radio|submit|category|subcategory|section|menu|item|tab|panel|icon|banner|header|label)$/i.test(text)) return true;
  // Pattern 2: spatial hierarchy phrases ("Tops subcategory link under Women",
  // "Dress item inside sidebar") — these are navigation descriptions, not UI text.
  if (/\s+(under|inside|within|beneath|below)\s+\S/i.test(text)) return true;
  // Pattern 3: multi-word relational phrases ("link under the Women menu").
  if (/\s+(of the|in the|for the|from the|under the|inside the)\s+/i.test(text)) return true;
  // Pattern 4: a UI-component noun PLUS a layout/region word ("User profile dropdown in
  // topbar", "Settings icon in header") — the agent is DESCRIBING the element by its
  // kind and position, not quoting its visible text. getByText() can never match this.
  // Keyed off structure (component-noun + region-word), never any site-specific string.
  const UI_NOUN = /\b(dropdown|drop-down|menu|button|btn|icon|avatar|toggle|switch|widget|field|input|textbox|checkbox|radio|link|breadcrumb|modal|dialog|popup|tooltip|carousel|spinner|loader|thumbnail|badge|chip)\b/i;
  const REGION_WORD = /\b(topbar|top bar|navbar|nav bar|sidebar|side bar|toolbar|header|footer|banner|corner|upper|lower)\b|\b(top|bottom)[- ]?(right|left)\b/i;
  if (UI_NOUN.test(text) && REGION_WORD.test(text)) return true;
  // Pattern 5: a UI-component noun with a trailing parenthetical qualifier ("Profile menu
  // (Amelia Brown)", "Avatar (logged-in user)") — disambiguating narration, not page text.
  if (/\([^)]+\)\s*$/.test(text) && UI_NOUN.test(text)) return true;
  return false;
}

function locatorText(c) {
  return String((c && (c.name || c.text || c.selector || c.testId)) || '').trim();
}

function isPollutedLocatorCandidate(c) {
  const n = normalizeCandidate(c) || {};
  const text = locatorText(n);
  if (!text) return false;
  if (/[\u0080-\u00ff\ue000-\uf8ff]/.test(text)) return true;
  if (text.length > 120) return true;
  if (text.length >= 40 && new Set(text).size <= 2) return true;
  if (/^[^a-z0-9]+$/i.test(text) && text.length >= 3) return true;
  if (/[<>]/.test(text) || /script/i.test(text)) return true;
  return false;
}

function isInputRoleCandidate(c) {
  const n = normalizeCandidate(c) || {};
  return n.strategy === 'role' && ['textbox', 'searchbox', 'combobox'].includes(String(n.role || '').toLowerCase()) && !!n.name;
}

function isDurableInputCandidate(c) {
  const n = normalizeCandidate(c) || {};
  if (n.strategy === 'placeholder' || n.strategy === 'label' || n.strategy === 'testId') return true;
  if (n.strategy === 'css' && n.selector && !/^getBy/i.test(String(n.selector))) return true;
  return false;
}

function looksLikeSearchValue(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (/^\d+$/.test(raw)) return true;
  if (/^[a-z0-9_@#$%.-]{3,}$/i.test(raw) && !/\s/.test(raw) && !/(user|name|email|login|password|search|product|price|category|filter|role)/i.test(raw)) return true;
  return false;
}

// Self-heal mis-captured role NAMES. The recorder sometimes writes a data VALUE into a
// role candidate's name slot (e.g. role=textbox name="initialPassword" / "newPassword456"
// for the login Password field). The real name survives in the SAME resolve as a corroborated
// candidate (role=textbox name="Password" PLUS placeholder/label/text "Password"). So: a role
// candidate whose name is NOT attested by any placeholder/label/text sibling is a ghost — drop
// it WHEN a corroborated role candidate exists, leaving the clean human-grade locator. Generic:
// keyed off cross-strategy corroboration, never a site string. Safe — if nothing is attested
// (no placeholder/label/text candidate) or no corroborated role alternative exists, no-op.
function dropUncorroboratedRoleNames(cands) {
  const list = cands || [];
  const norm = (s) => String(s || '').trim().toLowerCase();
  const attested = new Set(
    list.filter((c) => c && ['placeholder', 'label', 'text'].includes(c.strategy)).map((c) => norm(c.text || c.name)).filter(Boolean)
  );
  if (!attested.size) return list;
  const roleNamed = list.filter((c) => c && c.strategy === 'role' && c.name);
  const hasCorroboratedRole = roleNamed.some((c) => attested.has(norm(c.name)));
  if (!hasCorroboratedRole) return list;
  return list.map((c) => (
    c && c.strategy === 'role' && c.name && !attested.has(norm(c.name))
      ? withCandidateWarning(c, 'uncorroborated_accessible_name', 'Accessible-name evidence was not corroborated by sibling evidence; locator remains executable and should be reviewed locally.')
      : c
  ));
}

function dedupe(candidates) {
  const out = [];
  const seen = new Set();
  for (const c of candidates || []) {
    const key = JSON.stringify(c);
    if (!c || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function normalizeCandidates(cands) {
  const normalized = dropUncorroboratedRoleNames((cands || [])
    .map(normalizeCandidate)
    .filter(Boolean))
    .map((candidate) => {
      let annotated = candidate;
      if (isSyntheticTextCandidate(candidate)) {
        annotated = withCandidateWarning(annotated, 'descriptive_text_candidate', 'Candidate resembles authored element narration; it is retained as an executable last-resort locator rather than silently omitted.');
      }
      if (isPollutedLocatorCandidate(candidate)) {
        annotated = withCandidateWarning(annotated, 'low_quality_candidate_text', 'Candidate text has low-quality signals; exact evidence and provenance are retained for localized replacement.');
      }
      return annotated;
    });
  const hasDurableInput = normalized.some(isDurableInputCandidate);
  return dedupe(normalized.map((candidate) => (
    hasDurableInput && isInputRoleCandidate(candidate) && looksLikeSearchValue(candidate.name)
      ? withCandidateWarning(candidate, 'possible_runtime_value_as_name', 'Role name may be a runtime value; corroborated durable candidates should be preferred, but this evidence is retained.')
      : candidate
  )));
}

function labelForCandidates(cands) {
  const normalized = normalizeCandidates(cands);
  for (const c of normalized) { if (c.name) return c.name; if (c.text) return c.text; }
  for (const c of normalized) { if (c.selector) return c.selector; if (c.testId) return c.testId; }
  return 'element';
}

module.exports = {
  normalizeCandidate,
  normalizeCandidates,
  isSyntheticTextCandidate,
  isPollutedLocatorCandidate,
  dropUncorroboratedRoleNames,
  labelForCandidates,
  semanticNameForRole,
  candidateFromTextDescriptor,
  preserveCandidateEvidence,
  withCandidateWarning,
};
