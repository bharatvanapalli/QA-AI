'use strict';
/**
 * Deterministic STATEFUL-DEPENDENCY inference (site-INDEPENDENT).
 *
 * dependencyGraph.js is EXPLICIT-EDGES-ONLY by doctrine. But many stateful journeys
 * ship with dependsOnIds=null (the Architect didn't author the edge), so a case that
 * READS authenticated/established state ("avatar after login", "session persists")
 * would run on a broken half-login if its login case failed. This module infers the
 * MISSING edge: a case that depends on established state but does NOT establish its
 * own session → its scenario's session-establishing (login/setup) case.
 *
 * Pure + deterministic — no LLM, no prisma, no fs (unit-tested). Used in TWO places:
 *  - the Architect, to MATERIALIZE dependsOnIds at generation (durable metadata);
 *  - the conductor, to merge inferred edges in-memory before buildGraph so the
 *    (default-on) gate hard-blocks dependents even when dependsOnIds were never
 *    authored. The graph itself stays explicit-only; we just supplied the edges.
 *
 * Conservative by design: same-scenario only; never gates a self-establishing case;
 * only fires when a session-establishing case exists in the scenario.
 */
const { caseEstablishesSessionLive } = require('./sessionScope');

// A case READS authenticated / post-setup state when its name or steps reference a
// post-login / session / post-creation context. Generic vocabulary, no site strings.
const DEPENDENT_CONTEXT_RE = /(after (?:login|sign[- ]?in|signin|authenticat|user creation|creating|logging in)|session (?:persist|still|remain|active|cookie|established)|logged[- ]?in|authenticated|avatar|top[- ]?right|while logged in|after .{0,40}? (?:created|creation)|user menu|profile dropdown|stays? logged|remains? logged)/i;

function caseText(c) {
  let steps = c && c.steps;
  if (typeof steps === 'string') { try { steps = JSON.parse(steps); } catch (_) { steps = [steps]; } }
  return `${(c && c.name) || ''} ${JSON.stringify(Array.isArray(steps) ? steps : (steps ? [steps] : []))}`.toLowerCase();
}

/** A case that depends on established state but does NOT establish its own session. */
function isDependentStatefulCase(c) {
  if (!c) return false;
  if (caseEstablishesSessionLive(c)) return false; // establishes its own session → independent
  return DEPENDENT_CONTEXT_RE.test(caseText(c));
}

/**
 * Infer prerequisite IDs for a scenario's cases (authoring order). Each dependent
 * stateful case → the NEAREST PRECEDING session-establishing case (else the first
 * session-establishing case in the scenario).
 * @returns Map<tcId, [prereqId]>
 */
function inferStatefulPrereqIds(cases) {
  const list = (cases || []).filter((c) => c && c.id);
  const out = new Map();
  const establishers = list.filter((c) => caseEstablishesSessionLive(c));
  if (!establishers.length) return out;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!isDependentStatefulCase(c)) continue;
    let prereq = null;
    for (let j = i - 1; j >= 0; j--) { if (caseEstablishesSessionLive(list[j])) { prereq = list[j]; break; } }
    if (!prereq) prereq = establishers[0];
    if (prereq && prereq.id !== c.id) out.set(c.id, [prereq.id]);
  }
  return out;
}

module.exports = { inferStatefulPrereqIds, isDependentStatefulCase, DEPENDENT_CONTEXT_RE };
