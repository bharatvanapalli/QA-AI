'use strict';

/**
 * VerdictEngine (friend-hardened architecture) — the deterministic JUDGE.
 *
 * The Conductor is the autonomous QA INVESTIGATOR: it classifies row intent,
 * GATHERS evidence from the live page, interprets, and proposes deltas. It does
 * NOT decide pass/fail. This module does — mechanically — from the row's
 * `requiredEvidence` contract (Phase A2, testDataMatrix.buildRowEvidenceContract)
 * and the `observations` the Conductor gathered for each required item.
 *
 * Why deterministic and not "let the model judge": handing the verdict to the
 * LLM re-introduces fake-pass (the exact failure the mechanical verdict was
 * built to stop). The intelligence lives in WHAT to require and HOW to gather it;
 * the final tally is a pure function the model cannot talk its way around.
 *
 * NO LLM. NO DB. NO side effects. Pure function; exported for tests.
 *
 *   evaluateEvidenceContract(contract, observations) -> {
 *     verdict: 'works' | 'bug' | 'not_judged',
 *     reason, items[], deltas[], violated[], unobservable[]
 *   }
 *
 * Each requiredEvidence[i] is paired with observations[i] (index-aligned; the
 * Conductor builds observations as requiredEvidence.map(gather)). Each
 * observation: { status: 'satisfied' | 'violated' | 'unobservable', detail?, delta? }.
 *
 *   satisfied    — the live page shows what this evidence requires.
 *   violated     — the live page shows the OPPOSITE (a real defect: e.g. a
 *                  negative row reached the dashboard, or an empty field produced
 *                  NO validation error). This is what catches the inverse bug.
 *   unobservable — the Conductor could NOT determine it after genuinely
 *                  exhausting its gathering (re-snapshot/settle/scope). It is a
 *                  LAST RESORT, never the easy escape hatch (the caller enforces
 *                  the "exhausted effort" precondition; the engine only tallies).
 *
 * Verdict tally (first hit wins):
 *   1. any required item VIOLATED            -> 'bug'        (definitive defect)
 *   2. else any required item UNOBSERVABLE   -> 'not_judged' (evidence_missing)
 *   3. else all required items SATISFIED     -> 'works'
 *   4. else (no required evidence at all)    -> 'not_judged' (can't claim works
 *                                               with nothing checked — anti-fake-pass)
 *
 * A text DELTA (the page's correct-class error said "Required" while the doc
 * expected "Username is required") is carried as advisory in `deltas` and does
 * NOT change the verdict — per the inline-error-semantic-pass principle.
 */

const VALID_OBS_STATUS = new Set(['satisfied', 'violated', 'unobservable']);

function normaliseObservation(o) {
  if (!o || typeof o !== 'object') return { status: 'unobservable', detail: 'no observation recorded' };
  const status = VALID_OBS_STATUS.has(o.status) ? o.status : 'unobservable';
  return {
    status,
    detail: typeof o.detail === 'string' ? o.detail : null,
    delta: (o.delta && typeof o.delta === 'object') ? o.delta : null,
  };
}

function evaluateEvidenceContract(contract, observations) {
  const required = (contract && Array.isArray(contract.requiredEvidence)) ? contract.requiredEvidence : [];
  const obs = Array.isArray(observations) ? observations : [];

  const items = required.map((req, i) => {
    const o = normaliseObservation(obs[i]);
    return {
      kind: (req && req.kind) || 'unknown',
      required: req,
      status: o.status,
      detail: o.detail,
      delta: o.delta,
    };
  });

  // Deltas = authoring-time contract deltas (Phase A2) + any per-item text deltas
  // the Conductor surfaced (correct-class error, different wording). Advisory only.
  const deltas = [
    ...((contract && Array.isArray(contract.contractDeltas)) ? contract.contractDeltas : []),
    ...items.filter((it) => it.delta).map((it) => ({ kind: 'evidence_text_delta', item: it.kind, ...it.delta })),
  ];

  const violated = items.filter((it) => it.status === 'violated');
  const unobservable = items.filter((it) => it.status === 'unobservable');
  const allSatisfied = items.length > 0 && items.every((it) => it.status === 'satisfied');

  if (violated.length) {
    return { verdict: 'bug', reason: 'required_evidence_violated', items, deltas, violated: violated.map((it) => it.kind), unobservable: [] };
  }
  if (unobservable.length) {
    return { verdict: 'not_judged', reason: 'evidence_missing', items, deltas, violated: [], unobservable: unobservable.map((it) => it.kind) };
  }
  if (allSatisfied) {
    return { verdict: 'works', reason: 'all_required_evidence_satisfied', items, deltas, violated: [], unobservable: [] };
  }
  // No required evidence to satisfy — never claim "works" on an empty contract.
  return { verdict: 'not_judged', reason: 'no_required_evidence', items, deltas, violated: [], unobservable: [] };
}

/**
 * Map an engine verdict onto the persisted RunResult.status + the user-facing
 * binary, honouring the locked design:
 *   works -> pass         (website performs well)
 *   bug   -> fail         (website has a bug)
 *   not_judged -> blocked, blockedReason 'evidence_missing'
 *       — NOT a product verdict. Reports renders this as
 *       "Not judged: automation evidence missing", visually distinct from a
 *       website bug, so an automation/evidence gap is never misread as a defect.
 */
function mapVerdictToRunStatus(engineResult) {
  const v = engineResult && engineResult.verdict;
  if (v === 'works') return { status: 'pass', reason: engineResult.reason, blockedReason: null };
  if (v === 'bug') return { status: 'fail', reason: engineResult.reason, blockedReason: null };
  // not_judged (or anything unexpected) -> honest "couldn't test" state.
  return { status: 'blocked', reason: engineResult ? engineResult.reason : 'evidence_missing', blockedReason: 'evidence_missing' };
}

module.exports = { evaluateEvidenceContract, mapVerdictToRunStatus };
