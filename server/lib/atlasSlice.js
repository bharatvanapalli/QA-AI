'use strict';

/**
 * Enterprise Mode P3b — atlas slice math (PURE: no DB / LLM / IO).
 *
 * The atlas unit of work is (project, module, authProfile, atlasVersion). This
 * module owns the deterministic decisions ABOUT slices so the calibrator (DB
 * side) stays thin and scripts/verify_atlas.cjs can guard the rules directly:
 *
 *   computeAtlasFingerprint(hashes) — drift key from per-page snapshot hashes
 *   decideSliceVersion({...})       — new vs changed (version++) vs unchanged
 *   pickSlice(candidates, request)  — which slice a READ resolves to, AND the
 *                                     wrong-role firewall (a run NEVER grounds
 *                                     against another authProfile's evidence)
 *   atlasFreshness(completedAt,now) — stale surfaced, never silently used
 *
 * Doctrine (locked): one slice per (module, authProfile); a run grounds ONLY
 * against its own authProfile slice (admin ≠ demo evidence); structural drift
 * increments the version and supersedes the prior current; stale is SURFACED,
 * not hidden; the atlas governs HOW only (the anti-circular firewall lives in
 * testCaseContract — a `must` may never originate from the site/atlas).
 */

const crypto = require('crypto');

// Freshness horizon — past this a slice is reported stale (surfaced to the
// Architect + grounding; NOT auto-deleted, NOT a hard block until P9).
const STALE_DAYS = 14;
const STALE_MS = STALE_DAYS * 24 * 60 * 60 * 1000;
const ATLAS_SCHEMA_VERSION = 'atlas-parser-v2';

// Normalize an optional slice-key part: undefined/''/null → null (the legacy
// whole-app value) so a missing module/authProfile compares cleanly.
function norm(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * A drift key for an atlas: the SORTED, de-duped set of per-page snapshot hashes,
 * hashed. Order-independent (crawl order varies) + content-addressed — the same
 * site → the same fingerprint; any page's structure changing → a new one.
 * @param {string[]} snapshotHashes
 * @returns {string|null} null when there is nothing to fingerprint
 */
function computeAtlasFingerprint(snapshotHashes) {
  const hashes = (Array.isArray(snapshotHashes) ? snapshotHashes : []).filter(Boolean).map(String);
  if (!hashes.length) return null;
  const joined = [...new Set(hashes)].sort().join('|');
  return `${ATLAS_SCHEMA_VERSION}-` + crypto.createHash('sha256').update(joined).digest('hex').slice(0, 16);
}

function atlasSchemaCurrent(atlasFingerprint) {
  if (!atlasFingerprint) return true;
  return String(atlasFingerprint).startsWith(`${ATLAS_SCHEMA_VERSION}-`);
}

/**
 * Decide the version + drift disposition for a freshly-completed calibration of a
 * slice, given that slice's PRIOR current-complete calibration (or none).
 *   no prior            → v1, 'new'
 *   prior, same fp      → keep prior.version, 'unchanged' (a refresh — new row
 *                          still becomes current so freshness/staleAt advance)
 *   prior, different fp → prior.version + 1, 'changed' (drift — supersede prior)
 * @returns {{ version:number, drift:'new'|'unchanged'|'changed', supersede:boolean }}
 */
function decideSliceVersion({ priorVersion = 0, priorFingerprint = null, newFingerprint = null } = {}) {
  if (!priorVersion) return { version: 1, drift: 'new', supersede: false };
  if (priorFingerprint && newFingerprint && priorFingerprint === newFingerprint) {
    return { version: priorVersion, drift: 'unchanged', supersede: true };
  }
  return { version: priorVersion + 1, drift: 'changed', supersede: true };
}

const _byPreference = (a, b) =>
  (Number(!!b.isCurrent) - Number(!!a.isCurrent))     // current beats historical
  || ((b.version || 0) - (a.version || 0))            // then higher version
  || (new Date(b.completedAt || 0) - new Date(a.completedAt || 0)); // then freshest

/**
 * Resolve which atlas slice a READ should use. THE wrong-role firewall lives
 * here: when a specific authProfile is requested, a slice belonging to a
 * DIFFERENT non-null authProfile is NEVER chosen — a demo run cannot ground
 * against admin evidence. Resolution when a slice is requested:
 *   1. exact (module + authProfile) → chosen, no degrade
 *   2. role-agnostic legacy slice (authProfileId == null) → chosen, degraded
 *   3. nothing acceptable → { chosen:null } (absent / wrong-role block)
 * With NO slice requested (legacy callers): newest current-complete (any) —
 * preserves today's behavior exactly.
 *
 * @param {Array<{id,module,authProfileId,version,isCurrent,completedAt}>} candidates
 * @param {{module?:string, authProfileId?:string}} request
 * @returns {{ chosen:object|null, degraded:string|null, reason:string }}
 */
function pickSlice(candidates, request = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  const reqModule = norm(request.module);
  const reqAuth = norm(request.authProfileId);
  const sliced = reqModule !== null || reqAuth !== null;

  if (!sliced) {
    const chosen = [...list].sort(_byPreference)[0] || null;
    return { chosen, degraded: null, reason: chosen ? 'legacy_newest' : 'no_slice' };
  }

  const exact = list
    .filter((c) => norm(c.module) === reqModule && norm(c.authProfileId) === reqAuth)
    .sort(_byPreference)[0];
  if (exact) return { chosen: exact, degraded: null, reason: 'exact' };

  // Role-agnostic legacy fallback: ONLY a null-authProfile slice may stand in.
  // A DIFFERENT non-null authProfile is NEVER acceptable (the wrong-role block).
  const legacy = list
    .filter((c) => norm(c.authProfileId) === null)
    .sort(_byPreference)[0];
  if (legacy) {
    const degraded = reqAuth !== null ? 'no_authprofile_slice' : 'no_module_slice';
    return { chosen: legacy, degraded, reason: 'legacy_fallback' };
  }

  return { chosen: null, degraded: 'no_slice', reason: 'wrong_role_or_absent' };
}

/**
 * Stale/age of a slice. `staleAt` is the stored horizon when present, else
 * derived as completedAt + STALE_MS.
 * @returns {{ stale:boolean, ageMs:number|null, staleAt:string|null }}
 */
function atlasFreshness(completedAt, now = Date.now(), staleAt = null, atlasFingerprint = null) {
  if (!completedAt) {
    return { stale: false, ageMs: null, staleAt: null, schemaStale: false, schemaVersion: ATLAS_SCHEMA_VERSION };
  }
  const done = new Date(completedAt).getTime();
  const horizon = staleAt ? new Date(staleAt).getTime() : done + STALE_MS;
  const schemaStale = !atlasSchemaCurrent(atlasFingerprint);
  return {
    stale: now > horizon || schemaStale,
    ageMs: now - done,
    staleAt: new Date(horizon).toISOString(),
    schemaStale,
    schemaVersion: ATLAS_SCHEMA_VERSION,
  };
}

function deriveStaleAt(completedAt) {
  const done = completedAt ? new Date(completedAt).getTime() : Date.now();
  return new Date(done + STALE_MS);
}

// Human label for logs: "pim/demo v2", "pim v1", "whole-app v1".
function sliceLabel({ module, authProfileId, version } = {}) {
  const m = norm(module);
  const a = norm(authProfileId);
  const key = m ? (a ? `${m}/${a}` : m) : (a ? `whole-app/${a}` : 'whole-app');
  return `${key} v${version || 1}`;
}

module.exports = {
  STALE_DAYS,
  STALE_MS,
  ATLAS_SCHEMA_VERSION,
  norm,
  computeAtlasFingerprint,
  atlasSchemaCurrent,
  decideSliceVersion,
  pickSlice,
  atlasFreshness,
  deriveStaleAt,
  sliceLabel,
};
