'use strict';

/**
 * Preview matrix (Phase A) — the pre-RUN, read-only projection of WHAT each
 * generated data-bound case will actually be judged on, BEFORE a single browser
 * step runs. It answers the question the live trail/Reports only answer after
 * the fact: "for this scenario × these data rows, what intent did we classify
 * each row as, what evidence will the VerdictEngine require, and where does the
 * authored data contradict that intent?"
 *
 * Pure + deterministic (CLAUDE.md "Node unless genuine novelty"): it simply
 * re-uses `testDataMatrix.resolveCaseRows` — the SAME row resolver + per-row
 * `evidenceContract` the run uses — and reshapes it for display. No LLM, no DB,
 * no side-effects, so it is unit-provable and can never diverge from the run
 * (both go through resolveCaseRows). The route below is the only DB-aware shell.
 */

const testDataMatrix = require('./testDataMatrix');

/** Resolve one case's rows + per-row evidence contract for preview. */
function buildCaseRows(tc, scenario, testData) {
  let rows = [];
  try {
    rows = testDataMatrix.resolveCaseRows(tc, scenario, testData) || [];
  } catch (_) {
    rows = []; // a malformed binding must never break the whole preview
  }
  return rows.map((r) => {
    const c = (r && r.evidenceContract) || {};
    return {
      index: r.index,
      label: r.label,
      sheet: r.sheet || r.setName || null,
      inputs: r.inputs || {},
      expected: r.expected == null ? null : r.expected,
      expectedColumn: r.expectedColumn || null,
      intentClass: c.intentClass || 'unknown',
      confidence: c.confidence || 'low',
      sourceColumns: Array.isArray(c.sourceColumns) ? c.sourceColumns : [],
      requiredEvidence: Array.isArray(c.requiredEvidence) ? c.requiredEvidence : [],
      advisoryExpectations: Array.isArray(c.advisoryExpectations) ? c.advisoryExpectations : [],
      contractDeltas: Array.isArray(c.contractDeltas) ? c.contractDeltas : [],
    };
  });
}

/**
 * @param {object} opts
 * @param {Array}  opts.cases          generated TestCase rows ({ id, title|name, scenarioId, scenario?, dataBindingJson })
 * @param {object} [opts.scenariosById] map scenarioId -> scenario ({ id, name, module })
 * @param {object} [opts.testData]      the project's parsed test-data bundle
 * @returns {{scenarios: Array, summary: object}}
 */
function buildPreviewMatrix({ cases = [], scenariosById = {}, testData = null } = {}) {
  const byScenario = new Map();
  const summary = {
    totalCases: 0,
    dataBoundCases: 0,
    totalRows: 0,
    byIntentClass: {},
    deltaCount: 0,
  };

  for (const tc of (Array.isArray(cases) ? cases : [])) {
    if (!tc) continue;
    summary.totalCases++;
    const scenario = (tc.scenarioId != null && scenariosById[tc.scenarioId]) || tc.scenario || null;
    const rows = buildCaseRows(tc, scenario, testData);
    const dataBound = rows.length > 0;
    if (dataBound) summary.dataBoundCases++;
    summary.totalRows += rows.length;
    for (const row of rows) {
      summary.byIntentClass[row.intentClass] = (summary.byIntentClass[row.intentClass] || 0) + 1;
      summary.deltaCount += row.contractDeltas.length;
    }

    const sKey = (scenario && (scenario.id != null ? `id:${scenario.id}` : (scenario.name ? `name:${scenario.name}` : null))) || '__ungrouped__';
    if (!byScenario.has(sKey)) {
      byScenario.set(sKey, {
        scenarioId: scenario && scenario.id != null ? scenario.id : null,
        scenarioName: (scenario && scenario.name) || 'Ungrouped',
        module: (scenario && scenario.module) || null,
        cases: [],
      });
    }
    byScenario.get(sKey).cases.push({
      caseId: tc.id != null ? tc.id : null,
      caseTitle: tc.title || tc.name || 'Untitled case',
      dataBound,
      sheet: dataBound ? rows[0].sheet : null,
      rowCount: rows.length,
      rows,
    });
  }

  return { scenarios: Array.from(byScenario.values()), summary };
}

module.exports = { buildPreviewMatrix, buildCaseRows };
