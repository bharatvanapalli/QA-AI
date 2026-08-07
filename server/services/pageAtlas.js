'use strict';

/**
 * Page Atlas — per-project learned page-identity store.
 *
 * Populated by the Conductor when a PAGE assertion is rescued via the
 * semantic LLM verifier (cold-start path). Read by the page matcher to
 * augment the architect's declared signals with previously-verified ones.
 *
 * Shape stored at Project.pageAtlas (JSON):
 *
 *   {
 *     "<pageName>": {
 *       "signals": {
 *         "text": [
 *           { "value": "Username",
 *             "source": "semantic_rescue" | "verified",
 *             "verifiedCount": 0,
 *             "firstSeenAt": <ms>,
 *             "lastSeenAt":  <ms> },
 *           ...
 *         ],
 *         "role": [
 *           { "value": { "role": "textbox", "name": "Username" }, ... }
 *         ],
 *         "url":  [
 *           { "value": "/", ... }
 *         ]
 *       }
 *     },
 *     ...
 *   }
 *
 * Day 3 — write side. The matcher integration (Day 4) reads this shape and
 * applies half-weight to entries with verifiedCount < 2; promotes to full
 * weight at verifiedCount >= 2 (the strict corroboration trigger).
 *
 * The atlas writes are project-scoped (every call carries projectId) so
 * concurrent runs in different projects never cross-pollute.
 */

/**
 * Heuristic signal extraction from an accessibility-tree snapshot.
 *
 * Pulls candidate signals the matcher could later use to identify the same
 * page deterministically. The semantic verifier already confirmed this is
 * the right page — we just need to extract DISTINCTIVE features so the next
 * deterministic check has more to work with.
 *
 * Strategy:
 *   - role:  extract role+name pairs for textbox / button / heading lines
 *            (these are most stable across SUTs and SUT redesigns)
 *   - text:  pull headings (most pages have at most one distinctive heading)
 *            and unique button labels
 *   - url:   the current URL's pathname
 *
 * Caps:
 *   - max 5 role signals
 *   - max 5 text signals (filters trivially short tokens)
 *   - max 1 url signal
 *
 * Returns { text, role, url } with the same shape the matcher expects.
 */
function extractSignalsFromSnapshot(snapshot, currentUrl) {
  const out = { text: [], role: [], url: [] };
  if (typeof snapshot !== 'string' || !snapshot) return out;

  const lines = snapshot.split(/\r?\n/);
  // Stable, structural roles worth capturing as identity evidence. We avoid
  // 'static text' / 'generic' / 'paragraph' — those are too common.
  const STRUCTURAL_ROLES = new Set([
    'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox',
    'button', 'link', 'checkbox', 'radio', 'switch',
    'heading', 'tab', 'menuitem',
  ]);

  const roleSeen = new Set();
  const textSeen = new Set();

  for (const raw of lines) {
    if (out.role.length >= 5 && out.text.length >= 5) break;
    // `  - <role> "<name>" [ref=eN] ...`
    const m = raw.match(/^\s*-\s*([a-z][a-z0-9_-]*)\s*(?:"([^"]+)")?/i);
    if (!m) continue;
    const role = (m[1] || '').toLowerCase();
    const name = m[2] || '';
    if (!STRUCTURAL_ROLES.has(role)) continue;

    // Role signal: only when role+name is non-trivial.
    if (name && name.length >= 2 && out.role.length < 5) {
      const key = `${role}|${name.toLowerCase()}`;
      if (!roleSeen.has(key)) {
        roleSeen.add(key);
        out.role.push({ role, name });
      }
    }
    // Text signal: pull headings and distinctive button names. Avoid generic
    // verbs (Continue/Next/Submit) that appear on every flow.
    if (name && (role === 'heading' || role === 'button') && out.text.length < 5) {
      const GENERIC = new Set(['continue', 'next', 'submit', 'ok', 'cancel', 'close', 'home']);
      const nameLc = name.toLowerCase().trim();
      if (name.length >= 3 && !GENERIC.has(nameLc) && !textSeen.has(nameLc)) {
        textSeen.add(nameLc);
        out.text.push(name);
      }
    }
  }

  // URL signal: current path only.
  if (typeof currentUrl === 'string' && currentUrl) {
    try {
      const u = new URL(currentUrl);
      const path = u.pathname || '/';
      out.url.push(path);
    } catch (_) {
      // Non-URL string — store as-is, the matcher's 3-stage tolerant matcher
      // will handle it.
      out.url.push(currentUrl);
    }
  }

  return out;
}

/**
 * Read Project.pageAtlas → parsed object. Returns {} on null / parse error.
 */
async function readAtlas(prisma, projectId) {
  if (!prisma || !projectId) return {};
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { pageAtlas: true },
  });
  if (!proj || !proj.pageAtlas) return {};
  try {
    const parsed = JSON.parse(proj.pageAtlas);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Merge a single page's extracted signals into the project's atlas.
 *
 * Merge semantics (additive, idempotent):
 *   - if pageName has no entry yet, create one with all extracted signals
 *     stamped { source, verifiedCount: 0, firstSeenAt, lastSeenAt }
 *   - if pageName already has an entry, MERGE new signals into existing
 *     channels:
 *       - identical value (same text string / same role+name / same url) →
 *         update lastSeenAt only, leave verifiedCount untouched (Day 4 owns
 *         the increment logic)
 *       - new value → append with source=source, verifiedCount=0
 *
 * Bounded: each channel capped at 10 entries to prevent unbounded growth.
 *
 * Returns { wrote, mergedSignals } for telemetry.
 */
async function recordRescuedSignals(prisma, projectId, pageName, signals, source) {
  if (!prisma || !projectId || !pageName) return { wrote: false, mergedSignals: 0 };
  if (!signals || typeof signals !== 'object') return { wrote: false, mergedSignals: 0 };

  const now = Date.now();
  const atlas = await readAtlas(prisma, projectId);
  if (!atlas[pageName] || typeof atlas[pageName] !== 'object') {
    atlas[pageName] = { signals: { text: [], role: [], url: [] } };
  }
  const ch = atlas[pageName].signals;
  if (!ch.text) ch.text = [];
  if (!ch.role) ch.role = [];
  if (!ch.url)  ch.url  = [];

  let mergedSignals = 0;

  const isSame = (channel, candidate) => {
    if (channel === 'role') {
      const c = candidate.value;
      return (entry) => entry.value
        && entry.value.role === c.role
        && (entry.value.name || '') === (c.name || '');
    }
    return (entry) => entry.value === candidate.value;
  };

  for (const channel of ['text', 'role', 'url']) {
    const arr = Array.isArray(signals[channel]) ? signals[channel] : [];
    for (const v of arr) {
      const candidate = { value: v };
      const cmp = isSame(channel, candidate);
      const existing = ch[channel].find(cmp);
      if (existing) {
        existing.lastSeenAt = now;
        continue;
      }
      if (ch[channel].length >= 10) continue;        // bounded
      ch[channel].push({
        value: v,
        source: source || 'semantic_rescue',
        verifiedCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      mergedSignals += 1;
    }
  }

  await prisma.project.update({
    where: { id: projectId },
    data: { pageAtlas: JSON.stringify(atlas) },
  });
  return { wrote: true, mergedSignals };
}

/**
 * Day 4 — atlas signal promotion via strict corroboration trigger.
 *
 * Called by the conductor AFTER a PAGE assertion passes deterministically
 * (i.e. WITHOUT needing semantic rescue) AND the atlas's existing signals
 * for that page would also have matched. That dual-agreement is what
 * promotes signals from unverified → verified.
 *
 * Each matched atlas entry has its verifiedCount bumped by 1.
 * At verifiedCount >= 2, source flips to 'verified' (full weight in matcher).
 *
 * Returns { promoted, incremented } for telemetry.
 */
async function bumpVerifiedSignals(prisma, projectId, pageName, matchedSignals) {
  if (!prisma || !projectId || !pageName) return { promoted: 0, incremented: 0 };
  if (!matchedSignals || typeof matchedSignals !== 'object') return { promoted: 0, incremented: 0 };

  const now = Date.now();
  const atlas = await readAtlas(prisma, projectId);
  if (!atlas[pageName] || !atlas[pageName].signals) return { promoted: 0, incremented: 0 };
  const ch = atlas[pageName].signals;

  let promoted = 0;
  let incremented = 0;

  const matchEntry = (channel, candidate, entry) => {
    if (channel === 'role') {
      return entry.value
        && entry.value.role === candidate.role
        && (entry.value.name || '') === (candidate.name || '');
    }
    return entry.value === candidate;
  };

  for (const channel of ['text', 'role', 'url']) {
    const arr = Array.isArray(matchedSignals[channel]) ? matchedSignals[channel] : [];
    if (!Array.isArray(ch[channel])) continue;
    for (const v of arr) {
      for (const entry of ch[channel]) {
        if (!matchEntry(channel, v, entry)) continue;
        if (entry.source === 'verified') {
          entry.lastSeenAt = now;
          continue;
        }
        entry.verifiedCount = (entry.verifiedCount || 0) + 1;
        entry.lastSeenAt = now;
        incremented += 1;
        if (entry.verifiedCount >= 2) {
          entry.source = 'verified';
          promoted += 1;
        }
      }
    }
  }

  if (incremented > 0) {
    await prisma.project.update({
      where: { id: projectId },
      data: { pageAtlas: JSON.stringify(atlas) },
    });
  }
  return { promoted, incremented };
}

const DOM_ATLAS_KEY = '__qaaiDomAtlas';
const DOM_ATLAS_SCHEMA_VERSION = 'qaai-dom-atlas-v1';

function clean(value, max = 200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
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

function stableKey(item, keys) {
  if (!item || typeof item !== 'object') return '';
  for (const key of keys) {
    const value = item[key];
    if (value != null && clean(value)) return `${key}:${clean(value, 300).toLowerCase()}`;
  }
  return JSON.stringify(item).slice(0, 300);
}

function mergeList(existing, incoming, options) {
  const out = Array.isArray(existing) ? existing.slice(0, options.limit) : [];
  const seen = new Map();
  out.forEach((item, index) => {
    const key = options.key(item);
    if (key) seen.set(key, index);
  });
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item || typeof item !== 'object') continue;
    const key = options.key(item);
    if (!key) continue;
    if (seen.has(key)) {
      const idx = seen.get(key);
      out[idx] = { ...out[idx], ...item, seenCount: (Number(out[idx].seenCount) || 1) + 1 };
      continue;
    }
    if (out.length >= options.limit) continue;
    seen.set(key, out.length);
    out.push({ ...item, seenCount: 1 });
  }
  return out;
}

function mergeScalarList(existing, incoming, limit) {
  const out = Array.isArray(existing) ? existing.map((v) => clean(v)).filter(Boolean).slice(0, limit) : [];
  const seen = new Set(out.map((v) => v.toLowerCase()));
  for (const value of Array.isArray(incoming) ? incoming : []) {
    const text = clean(value, 160);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    if (out.length >= limit) break;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function normalizeDomAtlasPage(domAtlas, options = {}) {
  if (!domAtlas || typeof domAtlas !== 'object') return null;
  const url = clean(domAtlas.url || options.pageUrl, 500);
  const routeKey = clean(domAtlas.routeKey || routeKeyFromUrl(url), 300) || '/';
  return {
    schemaVersion: DOM_ATLAS_SCHEMA_VERSION,
    pageKey: options.pageKey || routeKey,
    routeKey,
    url: url || null,
    title: clean(domAtlas.title, 160) || null,
    counts: domAtlas.counts && typeof domAtlas.counts === 'object' ? domAtlas.counts : {},
    controls: Array.isArray(domAtlas.controls) ? domAtlas.controls.slice(0, 100) : [],
    forms: Array.isArray(domAtlas.forms) ? domAtlas.forms.slice(0, 25) : [],
    tables: Array.isArray(domAtlas.tables) ? domAtlas.tables.slice(0, 20) : [],
    dialogs: Array.isArray(domAtlas.dialogs) ? domAtlas.dialogs.slice(0, 20) : [],
    landmarks: Array.isArray(domAtlas.landmarks) ? domAtlas.landmarks.slice(0, 30) : [],
    frames: Array.isArray(domAtlas.frames) ? domAtlas.frames.slice(0, 30) : [],
    shadowHosts: Array.isArray(domAtlas.shadowHosts) ? domAtlas.shadowHosts.slice(0, 30) : [],
    headings: mergeScalarList([], domAtlas.headings, 30),
    verifiedActions: Array.isArray(domAtlas.verifiedActions) ? domAtlas.verifiedActions.slice(0, 200) : [],
  };
}

function mergeDomAtlasPage(existing, incoming, options = {}) {
  const page = normalizeDomAtlasPage(incoming, options);
  if (!page) return existing || null;
  const now = Date.now();
  const prev = existing && typeof existing === 'object' ? existing : {};
  return {
    schemaVersion: DOM_ATLAS_SCHEMA_VERSION,
    pageKey: page.pageKey || prev.pageKey || page.routeKey,
    routeKey: page.routeKey || prev.routeKey || '/',
    url: page.url || prev.url || null,
    title: page.title || prev.title || null,
    counts: { ...(prev.counts || {}), ...(page.counts || {}) },
    firstSeenAt: prev.firstSeenAt || now,
    lastSeenAt: now,
    seenCount: (Number(prev.seenCount) || 0) + 1,
    controls: mergeList(prev.controls, page.controls, {
      limit: 100,
      key: (item) => stableKey(item, ['selector', 'name', 'placeholder', 'nameAttr']),
    }),
    forms: mergeList(prev.forms, page.forms, {
      limit: 25,
      key: (item) => stableKey(item, ['selector', 'action']),
    }),
    tables: mergeList(prev.tables, page.tables, {
      limit: 20,
      key: (item) => stableKey(item, ['selector']),
    }),
    dialogs: mergeList(prev.dialogs, page.dialogs, {
      limit: 20,
      key: (item) => stableKey(item, ['selector', 'name']),
    }),
    landmarks: mergeList(prev.landmarks, page.landmarks, {
      limit: 30,
      key: (item) => stableKey(item, ['selector', 'role', 'name']),
    }),
    frames: mergeList(prev.frames, page.frames, {
      limit: 30,
      key: (item) => stableKey(item, ['selector', 'name', 'title', 'src']),
    }),
    shadowHosts: mergeList(prev.shadowHosts, page.shadowHosts, {
      limit: 30,
      key: (item) => stableKey(item, ['selector']),
    }),
    headings: mergeScalarList(prev.headings, page.headings, 30),
    verifiedActions: mergeList(prev.verifiedActions, page.verifiedActions, {
      limit: 200,
      key: (item) => stableKey(item, ['expression', 'elementLabel', 'strategy']),
    }),
  };
}

function mergeDomAtlas(atlas, domAtlas, options = {}) {
  const out = atlas && typeof atlas === 'object' && !Array.isArray(atlas) ? { ...atlas } : {};
  const bucket = out[DOM_ATLAS_KEY] && typeof out[DOM_ATLAS_KEY] === 'object'
    ? { ...out[DOM_ATLAS_KEY], pages: { ...((out[DOM_ATLAS_KEY] || {}).pages || {}) } }
    : { schemaVersion: DOM_ATLAS_SCHEMA_VERSION, pages: {} };
  const page = normalizeDomAtlasPage(domAtlas, options);
  if (!page) return out;
  const key = page.pageKey || page.routeKey || routeKeyFromUrl(page.url);
  bucket.pages[key] = mergeDomAtlasPage(bucket.pages[key], page, { pageKey: key });
  bucket.lastUpdatedAt = Date.now();
  out[DOM_ATLAS_KEY] = bucket;
  return out;
}

async function recordDomAtlas(prisma, projectId, domAtlas, options = {}) {
  if (!prisma || !projectId || !domAtlas || typeof domAtlas !== 'object') return { wrote: false, pageKey: null };
  const atlas = await readAtlas(prisma, projectId);
  const normalized = normalizeDomAtlasPage(domAtlas, options);
  if (!normalized) return { wrote: false, pageKey: null };
  const merged = mergeDomAtlas(atlas, normalized, options);
  await prisma.project.update({
    where: { id: projectId },
    data: { pageAtlas: JSON.stringify(merged) },
  });
  return { wrote: true, pageKey: normalized.pageKey || normalized.routeKey };
}

module.exports = {
  extractSignalsFromSnapshot,
  readAtlas,
  recordRescuedSignals,
  bumpVerifiedSignals,
  DOM_ATLAS_KEY,
  DOM_ATLAS_SCHEMA_VERSION,
  normalizeDomAtlasPage,
  mergeDomAtlasPage,
  mergeDomAtlas,
  recordDomAtlas,
};
