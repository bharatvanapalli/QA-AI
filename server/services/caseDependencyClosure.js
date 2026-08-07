'use strict';

const dependencyGraph = require('./dependencyGraph');

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

async function resolveCaseDependencyClosure({
  prisma,
  projectId,
  caseIds = [],
  select = null,
  include = null,
  maxDepth = 100,
  strict = false,
} = {}) {
  if (!prisma) throw new Error('resolveCaseDependencyClosure requires prisma');
  const requestedIds = unique(caseIds);
  if (!requestedIds.length) {
    return { requestedIds, caseIds: [], cases: [], autoIncluded: [], missingIds: [], cycle: null, findings: [] };
  }
  const byId = new Map();
  const discoveryOrder = [];
  const discovered = new Set();
  const remember = (id) => {
    if (!id || discovered.has(id)) return;
    discovered.add(id);
    discoveryOrder.push(id);
  };
  requestedIds.forEach(remember);
  const missingIds = [];
  const findings = [];
  let frontier = requestedIds;
  let depth = 0;
  while (frontier.length && depth < maxDepth) {
    depth += 1;
    const idsToFetch = frontier.filter((id) => !byId.has(id));
    frontier = [];
    if (!idsToFetch.length) continue;
    const fetchedRows = await prisma.testCase.findMany({
      where: { id: { in: idsToFetch }, ...(projectId ? { projectId } : {}) },
      ...(select ? { select } : {}),
      ...(include ? { include } : {}),
    });
    const fetchRank = new Map(idsToFetch.map((id, index) => [id, index]));
    const rows = (Array.isArray(fetchedRows) ? fetchedRows : []).slice().sort((a, b) =>
      (fetchRank.get(a?.id) ?? Number.MAX_SAFE_INTEGER) - (fetchRank.get(b?.id) ?? Number.MAX_SAFE_INTEGER));
    for (const row of rows) if (row && row.id) { byId.set(row.id, row); remember(row.id); }
    const found = new Set(rows.map((row) => row.id));
    for (const id of idsToFetch) {
      if (!found.has(id)) {
        missingIds.push(id);
        findings.push({
          code: 'dependency_case_missing',
          severity: strict ? 'error' : 'warning',
          nonBlocking: !strict,
          caseId: id,
        });
      }
    }
    for (const row of rows) {
      for (const depId of dependencyGraph.decodeDeps(row.dependsOnIds)) {
        if (!byId.has(depId)) { remember(depId); frontier.push(depId); }
      }
    }
  }
  if (frontier.length) {
    findings.push({
      code: 'dependency_closure_depth_exceeded',
      severity: strict ? 'error' : 'warning',
      nonBlocking: !strict,
      caseIds: frontier,
    });
  }
  const cases = discoveryOrder.map((id) => byId.get(id)).filter(Boolean);
  const graph = dependencyGraph.buildGraph(cases);
  const sorted = dependencyGraph.topoSort(graph, discoveryOrder);
  const orderedIds = sorted.cycle ? discoveryOrder.filter((id) => byId.has(id)) : sorted.order;
  const caseMap = new Map(cases.map((c) => [c.id, c]));
  const orderedCases = orderedIds.map((id) => caseMap.get(id)).filter(Boolean);
  if (sorted.cycle) {
    findings.push({
      code: 'dependency_cycle',
      severity: strict ? 'error' : 'warning',
      nonBlocking: !strict,
      caseIds: sorted.cycle,
    });
  }
  const orderedCaseIds = orderedCases.map((c) => c.id);
  const requested = new Set(requestedIds);
  const result = {
    requestedIds,
    caseIds: orderedCaseIds,
    cases: orderedCases,
    autoIncluded: orderedCaseIds.filter((id) => !requested.has(id)),
    missingIds: unique(missingIds),
    cycle: sorted.cycle,
    authoredOrder: discoveryOrder.filter((id) => byId.has(id)),
    findings,
  };
  if (strict && findings.length) {
    const err = new Error('Execution refused because the selected case dependency graph is incomplete or invalid.');
    err.code = 'CASE_DEPENDENCY_CLOSURE_INVALID';
    err.status = 409;
    err.findings = findings;
    err.missingIds = result.missingIds;
    err.cycle = result.cycle;
    throw err;
  }
  return result;
}

module.exports = { resolveCaseDependencyClosure };
