'use strict';

/**
 * Journey planning (P1 — architectural review 2026-06-02).
 *
 * THE PROBLEM
 * The MCP run is ONE accumulating browser session: case B ("search the employee")
 * relies on data case A ("create the employee") left behind in-session. Exported
 * as isolated per-case specs, B has no employee to find → a case that PASSED in
 * the run exports to a spec that fails standalone.
 *
 * THE FIX (Strategy c)
 * Cases coupled by `dependsOnIds` are not independent tests — they are steps of
 * one E2E journey. Emit ONE spec per dependency chain (a `test.step()` per case
 * in dependency order, sharing one lexical scope so a unique value created in
 * step A is in scope for step B). Standalone cases stay one spec each.
 *
 * A "journey" = a weakly-connected component of the dependsOnIds graph,
 * restricted to the cases actually in this run, ordered TOPOLOGICALLY so a
 * producer step runs before its consumer.
 *
 * THE GUARANTEE the rest of P1 leans on: the returned journeys are a PARTITION
 * of the input case ids — disjoint and covering. Every case appears in exactly
 * one journey. That is what makes "don't also emit the standalone spec for a
 * subsumed case" STRUCTURAL rather than a flag-check that could drift: the emit
 * loop iterates journeys, so a case can be emitted neither twice nor zero times.
 *
 * Pure module — no prisma, no fs, no LLM. A graph join (CLAUDE.md: graph joins
 * are Node, not an agent). Cycle-safe: never throws (codegen must not be able to
 * crash a run); a stray cycle degrades to input order for that component.
 */

/** Tolerantly decode TestCase.dependsOnIds (array | JSON string | null) → string[]. */
function decodeDeps(raw) {
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string');
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
    } catch (_) { return []; }
  }
  return [];
}

/**
 * Kahn topological sort within one component. Stable tie-break by the caller's
 * input order (so output is deterministic and matches caseNumbering ordering
 * when the caller pre-sorts that way). Cycle remnants are appended in input
 * order rather than thrown.
 */
function topoOrder(memberIds, deps, orderIdx) {
  const set = new Set(memberIds);
  const indeg = new Map(memberIds.map((id) => [id, 0]));
  const dependents = new Map(memberIds.map((id) => [id, []])); // prereq -> [dependents]
  for (const id of memberIds) {
    for (const d of (deps.get(id) || [])) {
      if (!set.has(d)) continue; // drop edges to cases outside this component/run
      indeg.set(id, indeg.get(id) + 1);
      dependents.get(d).push(id);
    }
  }
  const cmp = (a, b) => orderIdx.get(a) - orderIdx.get(b);
  const ready = memberIds.filter((id) => indeg.get(id) === 0);
  const result = [];
  while (ready.length) {
    ready.sort(cmp);
    const n = ready.shift();
    result.push(n);
    for (const m of dependents.get(n)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) ready.push(m);
    }
  }
  if (result.length < memberIds.length) {
    // Cycle (shouldn't happen — runs.expandDependenciesAndTopoSort rejects
    // DEPENDENCY_CYCLE upstream) — append leftovers in input order, never throw.
    const inResult = new Set(result);
    result.push(...memberIds.filter((id) => !inResult.has(id)).sort(cmp));
  }
  return result;
}

/**
 * Partition a run's test cases into journeys.
 *
 * @param {Array<{id:string, dependsOnIds?:(string[]|string|null), name?:string}>} cases
 *        The cases in THIS run (pre-sorted however you want the tie-break, e.g.
 *        caseNumbering order). dependsOnIds may reference cases not in the run;
 *        those edges are dropped (dangling prereqs don't couple a journey).
 * @returns {Array<{ id:string, caseIds:string[], size:number, isJourney:boolean }>}
 *          One entry per journey, topo-ordered caseIds, in stable run order.
 *          A PARTITION of the input ids: disjoint + covering.
 */
function planJourneys(cases, { extraEdges = [] } = {}) {
  const list = Array.isArray(cases) ? cases.filter((c) => c && c.id) : [];
  const ids = new Set(list.map((c) => c.id));

  // In-set directed edges: case -> {prereqs in this run}.
  const deps = new Map();
  for (const c of list) {
    deps.set(c.id, new Set(decodeDeps(c.dependsOnIds).filter((d) => ids.has(d) && d !== c.id)));
  }
  for (const edge of Array.isArray(extraEdges) ? extraEdges : []) {
    const from = edge && String(edge.from || '');
    const to = edge && String(edge.to || '');
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) continue;
    if (!deps.has(to)) deps.set(to, new Set());
    deps.get(to).add(from);
  }

  // Weakly-connected components via union-find (path-halving + union).
  const parent = new Map(list.map((c) => [c.id, c.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const [cid, set] of deps) for (const d of set) union(cid, d);

  const comps = new Map(); // root -> [caseIds]
  for (const c of list) {
    const r = find(c.id);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(c.id);
  }

  const orderIdx = new Map(list.map((c, i) => [c.id, i]));
  const journeys = [];
  for (const memberIds of comps.values()) {
    const ordered = topoOrder(memberIds, deps, orderIdx);
    journeys.push({ id: ordered[0], caseIds: ordered, size: ordered.length, isJourney: ordered.length > 1 });
  }
  // Stable run order: by the earliest input index among each journey's members.
  journeys.sort((a, b) =>
    Math.min(...a.caseIds.map((i) => orderIdx.get(i))) - Math.min(...b.caseIds.map((i) => orderIdx.get(i))));
  return journeys;
}

/**
 * Convenience for the inline emit site: build a Set of case ids that are
 * SINGLETON journeys (safe to emit a standalone per-case spec immediately) and
 * a Map from caseId → its journey, from one planJourneys() call.
 */
function indexJourneys(cases, opts = {}) {
  const journeys = planJourneys(cases, opts);
  const singletonIds = new Set();
  const journeyOf = new Map();
  for (const j of journeys) {
    for (const cid of j.caseIds) journeyOf.set(cid, j);
    if (!j.isJourney) singletonIds.add(j.caseIds[0]);
  }
  return { journeys, singletonIds, journeyOf };
}

module.exports = { planJourneys, indexJourneys, decodeDeps, topoOrder };
