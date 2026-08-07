'use strict';
/**
 * Enterprise Mode P5 — deterministic, Node-owned case dependency graph + gate.
 *
 * Doctrine ([[structural-fixes-over-tactical]], CLAUDE.md "Node unless novelty"):
 * the LLM (Architect) PROPOSES `TestCase.dependsOnIds`; Node DISPOSES — the graph,
 * topo order, cycle detection, and the failed-prerequisite gate are pure functions
 * here. No LLM, no prisma, no fs → trivially unit-testable (scripts/verify_dependency.cjs).
 *
 * Three rules the user fixed at the P5 checkpoint:
 *  1. EXPLICIT EDGES ONLY — an edge exists iff it is in `dependsOnIds`. Never infer
 *     a dependency from shared scenario / module / name similarity. A case with no
 *     edges is NEVER gated, no matter what else failed.
 *  2. SEPARATE VERDICT VOCABULARY — a dependent blocked by a failed prerequisite is
 *     `blockedReason='failed_prereq'`, visibly distinct from app-fail / script-fail /
 *     AI-blocked. The gate never fabricates an app failure.
 *  3. CYCLE → FINDING, never a crash, never an LLM repair. topoSort returns the
 *     cyclic members; callers fall back to authoring order.
 *
 * SOFT-FIRST: this module only COMPUTES (order, cycle, gate decision, findings).
 * Whether a decision is ENFORCED (a real blocked RunResult written + execution
 * skipped) vs merely SURFACED (advisory finding) is the caller's call — the
 * conductor gates enforcement behind `requireDependencyOrder` (default false →
 * inert until P9), exactly like requireRequirementRefs / requireApprovedMapping.
 */

// A prerequisite with one of these outcomes did NOT satisfy the dependent's
// precondition → eligible to block it. Deliberately excluded:
//  - 'pass'        — satisfied.
//  - 'skipped'     — engineer-excluded ([[qaai-is-not-jira]] CLAUDE.md status semantics);
//                    blocking on an intentional exclusion would be surprising → advisory.
//  - not-yet-run / out-of-scope — we cannot claim it failed → advisory finding, no block
//                    (don't hide real bugs; don't over-block on absent context).
const UNSATISFIED = new Set(['fail', 'blocked', 'needs_human']);

function decodeExecutionJournal(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// A case may have a red functional assertion while still leaving the browser
// in the exact state required by its dependent case. Preserve the red verdict,
// but do not confuse validation-only failure with broken execution state.
function journalAllowsDependentContinuation(raw) {
  const rows = decodeExecutionJournal(raw);
  if (!rows.length) return false;
  return rows.every((row) => {
    const status = String(row?.status || '').trim().toLowerCase();
    if (status === 'pass') return true;
    if (status !== 'fail') return false;
    const continuation = String(row?.continuationOutcome || '').trim().toLowerCase();
    return row?.assertionStep === true
      && row?.requiredForContinuation !== true
      && row?.executionError !== true
      && row?.dependencySkipped !== true
      && String(row?.failureImpact || '').trim().toLowerCase() === 'validation_only'
      && !['stop', 'block', 'blocked'].includes(continuation);
  });
}

function outcomeIsUnsatisfied(outcome) {
  return Boolean(outcome)
    && UNSATISFIED.has(outcome.status)
    && outcome.continuationSatisfied !== true;
}

function decodeDeps(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.filter(Boolean).map(String))];
  if (!raw || typeof raw !== 'string') return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? [...new Set(a.filter(Boolean).map(String))] : [];
  } catch (_) {
    return [];
  }
}

/**
 * Build a dependency graph from a set of cases. Edges are restricted to prereq
 * ids PRESENT in this set — an id pointing outside the set (a prerequisite not
 * selected for this run) is NOT an edge; it is recorded under `externalDeps` and
 * surfaced as an advisory finding, never fabricated into a block.
 *
 * @param cases [{ id, name?, dependsOnIds }]  (dependsOnIds may be a JSON string or array)
 * @returns { nodes:Map<id,{id,name}>, deps:Map<id,id[]>, externalDeps:Map<id,id[]> }
 */
function buildGraph(cases) {
  const nodes = new Map();
  for (const c of cases || []) if (c && c.id) nodes.set(c.id, { id: c.id, name: c.name || null });
  const deps = new Map();
  const externalDeps = new Map();
  for (const c of cases || []) {
    if (!c || !c.id) continue;
    const inSet = [];
    const ext = [];
    for (const d of decodeDeps(c.dependsOnIds)) {
      if (d === c.id) continue; // self-edge → ignore
      (nodes.has(d) ? inSet : ext).push(d);
    }
    deps.set(c.id, inSet);
    if (ext.length) externalDeps.set(c.id, ext);
  }
  return { nodes, deps, externalDeps };
}

/**
 * Kahn's topological sort with a stable tiebreak. When several nodes are ready
 * simultaneously, the one earliest in `priority` (the caller's authoring order)
 * wins — so independent cases keep their authored order and the output is
 * deterministic. A cycle leaves some nodes unscheduled; they are returned in
 * `cycle` (callers emit a `dependency_cycle` finding and fall back to authoring
 * order). Never throws.
 *
 * @returns { order:id[], cycle:id[]|null }
 */
function topoSort(graph, priority) {
  const { nodes, deps } = graph;
  const rankSrc = priority && priority.length ? priority : [...nodes.keys()];
  const rank = new Map(rankSrc.map((id, i) => [id, i]));
  const indeg = new Map();
  const adj = new Map();
  for (const id of nodes.keys()) { indeg.set(id, 0); adj.set(id, []); }
  for (const [id, ds] of deps) {
    for (const d of ds) { adj.get(d).push(id); indeg.set(id, (indeg.get(id) || 0) + 1); }
  }
  const byRank = (a, b) => (rank.has(a) ? rank.get(a) : 1e9) - (rank.has(b) ? rank.get(b) : 1e9);
  const ready = [...nodes.keys()].filter((id) => indeg.get(id) === 0).sort(byRank);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    const freed = [];
    for (const m of adj.get(id)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) freed.push(m);
    }
    if (freed.length) { ready.push(...freed); ready.sort(byRank); }
  }
  const cycle = order.length === nodes.size ? null : [...nodes.keys()].filter((id) => !order.includes(id));
  return { order, cycle };
}

/**
 * Order a SUBSET of cases (e.g. one scenario's cases) so a prerequisite always
 * precedes its dependent, preserving authoring order as the tiebreak. On a cycle
 * the ORIGINAL order is returned unchanged (safe — never reorder into a broken
 * state) alongside the cyclic members. Returns the SAME case objects.
 *
 * @returns { cases:case[], cycle:id[]|null }
 */
function orderCases(cases) {
  const list = (cases || []).filter(Boolean);
  if (list.length < 2) return { cases: list, cycle: null };
  const graph = buildGraph(list);
  const { order, cycle } = topoSort(graph, list.map((c) => c.id));
  if (cycle) return { cases: list, cycle };
  const byId = new Map(list.map((c) => [c.id, c]));
  return { cases: order.map((id) => byId.get(id)).filter(Boolean), cycle: null };
}

// Return the stable authored roots for a case's dependency component. This is
// intentionally graph-owned: session code must not guess continuity groups
// from scenario order or names. Cycles return no roots and therefore cannot
// acquire a continuity lease.
function dependencyRootIds(tcId, graph) {
  if (!tcId || !graph?.nodes?.has(tcId)) return [];
  const roots = new Set();
  const visiting = new Set();
  const visited = new Set();
  let cyclic = false;
  const visit = (id) => {
    if (visiting.has(id)) { cyclic = true; return; }
    if (visited.has(id)) return;
    visiting.add(id);
    const deps = graph.deps.get(id) || [];
    if (deps.length === 0) roots.add(id);
    else deps.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  visit(String(tcId));
  if (cyclic) return [];
  const authoredOrder = [...graph.nodes.keys()];
  return authoredOrder.filter((id) => roots.has(id));
}

function continuityGroupId(tcId, graph) {
  const roots = dependencyRootIds(tcId, graph);
  return roots.length ? `dependency-group:${roots.join('+')}` : null;
}

/**
 * The chain of UNSATISFIED prerequisites reachable from `tcId`, root-cause first.
 * Powers RunResult.dependencyPath so a blocked dependent in a chain (A fail → B
 * → C) shows the full lineage [A, B], not just the immediate parent.
 *
 * @returns [{ id, name, status }]
 */
function unsatisfiedChain(tcId, outcomes, graph) {
  const chain = [];
  const seen = new Set();
  const visit = (id) => {
    for (const d of graph.deps.get(id) || []) {
      const o = outcomes.get(d);
      if (outcomeIsUnsatisfied(o) && !seen.has(d)) {
        seen.add(d);
        visit(d); // recurse to the root before recording → root-cause-first order
        chain.push({ id: d, name: graph.nodes.get(d) ? graph.nodes.get(d).name : null, status: o.status });
      }
    }
  };
  visit(tcId);
  return chain;
}

/**
 * The gate for ONE case, evaluated against the outcomes of cases that have
 * ALREADY executed in this run. Pure: decides, does not write.
 *
 * @param tc        { id, dependsOnIds }
 * @param outcomes  Map<tcId, { status, runResultId?, blockedReason? }>
 * @param graph     from buildGraph(allRunCases)
 * @returns {
 *   blocked: boolean,
 *   reason?: 'failed_prereq',
 *   blockedBy?: { testCaseId, status, runResultId, blockedReason },
 *   blockedByName?: string|null,
 *   path?: [{id,name,status}],          // evidence-inheritance dependencyPath
 *   findings: [{ code, tcId, prereqId, severity }]   // advisory, always returned
 * }
 */
function evaluateGate(tc, outcomes, graph) {
  const findings = [];
  if (!tc || !tc.id) return { blocked: false, findings };
  for (const ext of graph.externalDeps.get(tc.id) || []) {
    findings.push({ code: 'dependency_prereq_out_of_scope', tcId: tc.id, prereqId: ext, severity: 'warning' });
  }
  let firstFail = null;
  for (const d of graph.deps.get(tc.id) || []) {
    const o = outcomes.get(d);
    if (!o) { findings.push({ code: 'dependency_prereq_not_run', tcId: tc.id, prereqId: d, severity: 'warning' }); continue; }
    if (outcomeIsUnsatisfied(o) && !firstFail) firstFail = { id: d, status: o.status, runResultId: o.runResultId || null, blockedReason: o.blockedReason || null };
  }
  if (!firstFail) return { blocked: false, findings };
  const failurePolicy = String(
    tc.failurePolicy
      || tc.dependencyFailurePolicy
      || tc.dependencyPolicy?.failurePolicy
      || '',
  ).trim().toLowerCase();
  if (failurePolicy !== 'block_dependents') {
    findings.push({
      code: 'dependency_failure_non_blocking',
      tcId: tc.id,
      prereqId: firstFail.id,
      severity: 'warning',
      failurePolicy: failurePolicy || null,
    });
    return { blocked: false, findings };
  }
  const node = graph.nodes.get(firstFail.id);
  return {
    blocked: true,
    reason: 'failed_prereq',
    blockedBy: { testCaseId: firstFail.id, status: firstFail.status, runResultId: firstFail.runResultId, blockedReason: firstFail.blockedReason },
    blockedByName: node ? node.name : null,
    path: unsatisfiedChain(tc.id, outcomes, graph),
    findings,
  };
}

module.exports = {
  UNSATISFIED,
  decodeDeps,
  buildGraph,
  topoSort,
  orderCases,
  dependencyRootIds,
  continuityGroupId,
  unsatisfiedChain,
  evaluateGate,
  journalAllowsDependentContinuation,
  outcomeIsUnsatisfied,
};
