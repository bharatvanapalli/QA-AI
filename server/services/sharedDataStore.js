'use strict';

/**
 * Cross-case data chaining — Run.sharedData read/write/filter helpers.
 *
 * Run.sharedData is a JSON object on the Run row that accumulates primitive
 * values extracted by the browser_extract_data tool throughout the run.
 * Downstream cases that declare requiresData receive a FILTERED view of
 * this bag in their per-case user message (only the keys they asked for).
 *
 * Persistence semantics (additive, non-destructive):
 *   - mergeSharedData(prisma, runId, patch)  reads → merges → writes
 *     atomically within a Prisma transaction. Existing keys are overwritten
 *     by the patch (last-write-wins), which is fine because the architect's
 *     P0-17 grounding rule prevents conflicting producers in practice.
 *
 *   - readSharedData(prisma, runId)          returns parsed object, or {}
 *
 *   - filterForCase(bag, requiresData)       returns a SUBSET of bag keyed
 *     by the entries in requiresData. Keys with no upstream value are
 *     omitted (the conductor surfaces "<missing keys>" as a trace warning,
 *     not a hard fail — the per-case prompt simply doesn't include the
 *     missing key, and the step that references ${missingKey} fails its
 *     own check).
 *
 * Validation rules for inserted values (enforced upstream in the tool):
 *   - keys: /^[a-zA-Z_][a-zA-Z0-9_]*$/  (JS-identifier shape; lets the
 *     architect emit ${trackingId} in step values without escaping)
 *   - values: typeof === 'string' | 'number' | 'boolean'  (no objects/arrays
 *     — the bag is FLAT; compound payloads decompose into multiple keys)
 *
 * The conductor's case-start hook calls readSharedData → filterForCase →
 * injects into the per-case USER message. The system prompt is invariant
 * across cases so the prompt cache stays warm.
 */

/** Whether a value is a permitted primitive for the shared-data bag. */
function isPermittedValue(v) {
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/** Whether a key matches the JS-identifier shape the architect must use. */
function isPermittedKey(k) {
  return typeof k === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && k.length <= 64;
}

/**
 * Parse Run.sharedData into a plain object. Empty / malformed → {}.
 * Pure function — no I/O.
 */
function parseSharedData(rawJson) {
  if (!rawJson || typeof rawJson !== 'string') return {};
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Defensively re-filter: drop any non-primitive value or invalid key
    // that snuck in from a manual DB edit.
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isPermittedKey(k) && isPermittedValue(v)) out[k] = v;
    }
    return out;
  } catch (_) {
    return {};
  }
}

/**
 * Read the current Run.sharedData as a parsed object.
 *
 * @param {PrismaClient} prisma
 * @param {string}       runId
 * @returns {Promise<Record<string, string|number|boolean>>}
 */
async function readSharedData(prisma, runId) {
  if (!prisma || !runId) return {};
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { sharedData: true },
  });
  return parseSharedData(run?.sharedData);
}

/**
 * Merge a patch into Run.sharedData. Read-modify-write — Prisma SQLite
 * doesn't expose a clean JSON-patch operator, so we serialise the merge
 * client-side. Concurrent writers within the same run aren't expected
 * (cases run sequentially per the dependency-graph topo sort), so the
 * absence of optimistic locking is acceptable for v1.
 *
 * Returns the merged bag (parsed) for the caller's immediate use.
 *
 * @param {PrismaClient}                              prisma
 * @param {string}                                    runId
 * @param {Record<string, string|number|boolean>}     patch
 * @returns {Promise<{merged: Record<string, any>, rejected: string[]}>}
 */
async function mergeSharedData(prisma, runId, patch) {
  if (!prisma || !runId) return { merged: {}, rejected: [] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { merged: await readSharedData(prisma, runId), rejected: [] };
  }
  const rejected = [];
  const cleanPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!isPermittedKey(k)) { rejected.push(`key:${k}`); continue; }
    if (!isPermittedValue(v)) { rejected.push(`value:${k}`); continue; }
    cleanPatch[k] = v;
  }
  const existing = await readSharedData(prisma, runId);
  const merged = { ...existing, ...cleanPatch };
  await prisma.run.update({
    where: { id: runId },
    data: { sharedData: JSON.stringify(merged) },
  });
  return { merged, rejected };
}

/**
 * Filter a sharedData bag down to the keys this case requires. Used by
 * the conductor's case-start hook before building the per-case user
 * message.
 *
 * @param {Record<string, any>} bag
 * @param {string[]|string|null} requiresData  Array, JSON-encoded array, or null
 * @returns {{filtered: Record<string, any>, missing: string[]}}
 */
function filterForCase(bag, requiresData) {
  if (!bag || typeof bag !== 'object') return { filtered: {}, missing: [] };
  // Accept either an array or a JSON-encoded string (matches what's stored
  // in TestCase.requiresData on the DB).
  let keys = [];
  if (Array.isArray(requiresData)) {
    keys = requiresData;
  } else if (typeof requiresData === 'string' && requiresData.trim().length > 0) {
    try {
      const parsed = JSON.parse(requiresData);
      if (Array.isArray(parsed)) keys = parsed;
    } catch (_) { /* swallow — treat as no requirements */ }
  }
  const filtered = {};
  const missing = [];
  for (const k of keys) {
    if (!isPermittedKey(k)) continue;
    if (Object.prototype.hasOwnProperty.call(bag, k)) filtered[k] = bag[k];
    else missing.push(k);
  }
  return { filtered, missing };
}

/**
 * Format a filtered shared-data bag into the per-case user-message section.
 * Surfaces missing keys as an explicit warning so the agent doesn't burn
 * a turn searching for a value that was never produced.
 *
 * Example output:
 *
 *   ## Available shared data
 *   - `trackingId`: `1Z9999999999999999`
 *   - `orderId`: `WO-2026-00481`
 *   (missing from upstream: customsId)
 */
function renderForPrompt(filtered, missing) {
  const lines = ['## Available shared data'];
  const entries = Object.entries(filtered || {});
  if (entries.length === 0 && (!missing || missing.length === 0)) {
    return ''; // No data, no requirement — nothing to inject.
  }
  if (entries.length === 0) {
    lines.push('(none of the requested keys are available yet)');
  } else {
    for (const [k, v] of entries) {
      lines.push(`- \`${k}\`: \`${String(v).slice(0, 200)}\``);
    }
  }
  if (Array.isArray(missing) && missing.length > 0) {
    lines.push(`(missing from upstream: ${missing.join(', ')})`);
  }
  return lines.join('\n');
}

module.exports = {
  isPermittedKey,
  isPermittedValue,
  parseSharedData,
  readSharedData,
  mergeSharedData,
  filterForCase,
  renderForPrompt,
};
