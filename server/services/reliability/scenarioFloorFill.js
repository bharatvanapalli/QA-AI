'use strict';

const { buildCaseContractPacks } = require('./selfHealingPipeline');

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function scenarioNameKey(scenario = {}) {
  return cleanText(scenario && scenario.name).toLowerCase();
}

function scenarioCoverageRefs(scenarios = []) {
  const refs = new Set();
  for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
    for (const caseObj of Array.isArray(scenario && scenario.cases) ? scenario.cases : []) {
      if (caseObj && typeof caseObj.primaryCoverageRef === 'string' && caseObj.primaryCoverageRef.trim()) refs.add(caseObj.primaryCoverageRef.trim());
      if (caseObj && typeof caseObj.coverageItemId === 'string' && caseObj.coverageItemId.trim()) refs.add(caseObj.coverageItemId.trim());
      if (caseObj && caseObj.dataBinding && typeof caseObj.dataBinding.coverageItemId === 'string' && caseObj.dataBinding.coverageItemId.trim()) {
        refs.add(caseObj.dataBinding.coverageItemId.trim());
      }
      for (const ref of Array.isArray(caseObj && caseObj.coverageRefs) ? caseObj.coverageRefs : []) {
        if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
      }
      for (const ref of Array.isArray(caseObj && caseObj.requirementRefs) ? caseObj.requirementRefs : []) {
        if (typeof ref === 'string' && ref.trim()) refs.add(ref.trim());
      }
    }
  }
  return refs;
}

function inferActionsFromClause(text = '') {
  const lower = String(text || '').toLowerCase();
  if (/search|filter|find|lookup|list|directory/.test(lower)) return ['search'];
  if (/create|add|save|update|edit/.test(lower)) return ['save'];
  if (/submit|assign|request|claim/.test(lower)) return ['submit'];
  if (/login|sign in|authenticate/.test(lower)) return ['login'];
  return ['verify'];
}

function inferOracleFromClause(text = '', title = '') {
  const lower = `${text} ${title}`.toLowerCase();
  if (/validation|required|invalid|missing|error/.test(lower)) {
    return { kind: 'validation_message', target: title || 'Validation message', expected: 'validation message', source: 'verified_clause', required: true };
  }
  if (/search|filter|find|lookup|list|directory|table|record/.test(lower)) {
    return { kind: 'table_row', target: title || 'Results table', expected: 'matching result or no records found', source: 'verified_clause', required: true };
  }
  if (/url|redirect|dashboard|page/.test(lower)) {
    return { kind: 'visible', target: title || 'Expected page', expected: true, source: 'verified_clause', required: true };
  }
  return { kind: 'state_change', target: title || 'Expected result', expected: true, source: 'verified_clause', required: true };
}

function packFromClause(clause = {}, index = 0) {
  if (!clause || !clause.id) return null;
  const body = cleanText(clause.behaviourText || clause.text || clause.description || clause.excerpt || clause.title);
  if (!body) return null;
  const title = cleanText(clause.title || clause.name || body || clause.id).slice(0, 90);
  const coverageRef = cleanText(clause.id || `verified-clause-${index + 1}`);
  const requiredOracle = inferOracleFromClause(body, title);
  return {
    schemaVersion: '1.0',
    contractVersion: '1.0',
    coverageRef,
    type: 'verified_clause_route_floor_fill',
    syntheticFromClause: true,
    aliases: [clause.id, clause.storyId, clause.requirementId].map(cleanText).filter(Boolean),
    storyId: clause.storyId || clause.requirementId || clause.id,
    module: clause.module || clause.moduleHint || 'Core',
    title,
    pageIntent: title,
    requiredFields: [],
    requiredActions: inferActionsFromClause(body),
    semanticTokenMap: {},
    semanticTokens: {},
    rowIntent: {
      sheet: null,
      rowSelector: null,
      rowIds: [],
      rowSource: 'needs_mapping',
    },
    requiredOracle,
    requiredOracles: [requiredOracle],
    allowedPages: [],
    allowedCapabilities: [],
    dataRows: [],
    rowIntents: [],
    authPreconditions: [],
    capabilityHints: [],
  };
}

function floorFillScenarioSuite({
  scenarios = [],
  coveragePlan = null,
  requirementClauses = [],
  testData = null,
  appCapabilityMap = null,
  targetFloor = 0,
  scenarioFactory,
  reason = 'route_floor_fill',
} = {}) {
  const floor = Number.isFinite(Number(targetFloor)) ? Math.max(0, Math.floor(Number(targetFloor))) : 0;
  const out = Array.isArray(scenarios) ? [...scenarios] : [];
  if (!floor || out.length >= floor || typeof scenarioFactory !== 'function') {
    return { scenarios: out, added: 0, targetFloor: floor, source: 'none' };
  }

  const names = new Set(out.map(scenarioNameKey).filter(Boolean));
  const refs = scenarioCoverageRefs(out);
  const packs = buildCaseContractPacks({
    manifest: coveragePlan || {},
    testData,
    appCapabilityMap,
    targetPackCount: floor,
  });
  const seenPackRefs = new Set(packs.map((pack) => cleanText(pack && pack.coverageRef)).filter(Boolean));
  const clausePacks = (Array.isArray(requirementClauses) ? requirementClauses : [])
    .map(packFromClause)
    .filter((pack) => pack && pack.coverageRef && !seenPackRefs.has(pack.coverageRef));
  const ordered = [
    ...packs.filter((pack) => pack && pack.coverageRef && !refs.has(pack.coverageRef)),
    ...clausePacks.filter((pack) => pack && pack.coverageRef && !refs.has(pack.coverageRef)),
    ...packs.filter((pack) => pack && pack.coverageRef && refs.has(pack.coverageRef)),
    ...clausePacks.filter((pack) => pack && pack.coverageRef && refs.has(pack.coverageRef)),
  ];

  let added = 0;
  for (const pack of ordered) {
    if (out.length >= floor) break;
    const scenario = scenarioFactory(pack, reason);
    if (!scenario || !Array.isArray(scenario.cases) || !scenario.cases.length) continue;
    const key = scenarioNameKey(scenario);
    if (key && names.has(key)) continue;
    if (key) names.add(key);
    if (pack.coverageRef) refs.add(pack.coverageRef);
    out.push(scenario);
    added += 1;
  }

  return {
    scenarios: out,
    added,
    targetFloor: floor,
    source: added ? 'case_contract_pack' : 'none',
  };
}

module.exports = {
  floorFillScenarioSuite,
  packFromClause,
  scenarioCoverageRefs,
};
