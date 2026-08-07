'use strict';

/**
 * Stable, human-facing scenario/case numbering — ONE source of truth so the
 * Test Cases, Reports, and Blocked pages all show the SAME label for a given
 * case ("which test case does this belong to?").
 *
 * Scheme (hierarchical): scenario → "S2", case → "S2 · C5".
 *   • Numbered PER GENERATION so a regenerated suite restarts at S1 (labels are
 *     unique within any one view — you never compare across generations in a
 *     single screen).
 *   • Scenario order MATCHES the scenarios API display order: priority asc
 *     (string compare, as Prisma orderBy does), then createdAt asc, then id.
 *   • Case order within a scenario: createdAt asc, then id (deterministic even
 *     though the DB include has no explicit order).
 *
 * Pass the project's scenarios with their `cases` included. Returns lookup maps
 * keyed by id; callers attach the label wherever a case/scenario is serialized.
 */
function buildCaseNumbering(scenarios) {
  const scenarioNumberById = new Map();
  const scenarioLabelById = new Map();
  const caseNumberById = new Map();
  const caseLabelById = new Map();

  // Group by generation (null/legacy scenarios share one bucket).
  const byGen = new Map();
  for (const s of Array.isArray(scenarios) ? scenarios : []) {
    if (!s || !s.id) continue;
    const g = s.generationId || '__none__';
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g).push(s);
  }

  const byCreatedThenId = (a, b) =>
    (new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
    || String(a.id).localeCompare(String(b.id));

  for (const group of byGen.values()) {
    const orderedScenarios = [...group].sort((a, b) =>
      String(a.priority || '').localeCompare(String(b.priority || ''))
      || byCreatedThenId(a, b)
    );
    // Separate counters: automation scenarios → S1, S2…; pure-manual scenarios → M1, M2…
    // A scenario is "pure manual" when every one of its cases has automatability === 'manual'.
    // Mixed scenarios (any automatable case) stay under the S-prefix.
    let autoNum = 0;
    let manualNum = 0;
    orderedScenarios.forEach((s) => {
      const orderedCases = [...(Array.isArray(s.cases) ? s.cases : [])].sort(byCreatedThenId);
      const isPureManual = orderedCases.length > 0
        && orderedCases.every((c) => c && c.automatability === 'manual');
      const prefix = isPureManual ? 'M' : 'S';
      const sNum = isPureManual ? (++manualNum) : (++autoNum);
      scenarioNumberById.set(s.id, sNum);
      scenarioLabelById.set(s.id, `${prefix}${sNum}`);
      orderedCases.forEach((c, ci) => {
        if (!c || !c.id) return;
        const cNum = ci + 1;
        caseNumberById.set(c.id, cNum);
        caseLabelById.set(c.id, `${prefix}${sNum} · C${cNum}`);
      });
    });
  }

  return { scenarioNumberById, scenarioLabelById, caseNumberById, caseLabelById };
}

module.exports = { buildCaseNumbering };
