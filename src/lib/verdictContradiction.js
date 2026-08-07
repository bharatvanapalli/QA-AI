// HISTORICAL CONTRADICTION DETECTOR (run 91d6301a, audit P6 / round-2 #5).
//
// The backend fix (computeVerdict + the pre-persist evidence gate) prevents NEW
// false-passes, but rows ALREADY persisted as `pass` while a required assertion
// was uncheckable, or with no evidence at all, still sit in the DB. The report
// surfaces those honestly instead of rendering a clean green. Returns a
// contradiction descriptor for a `pass` row whose own stored evidence disproves
// the verdict, else null. Pure — parses the stored JSON shapes defensively.
//
// CRITICALITY JOIN (round-2 #5): a stored assertion outcome often omits
// `criticality`. We JOIN the outcome back to the row's declaredAssertions by
// assertionId to recover it, and warn ONLY on a resolved `must`. The default when
// the join cannot resolve (no outcome.criticality AND no matching declared id) is
// CONSERVATIVE — `must` — because an unattributable uncheckable on a pass is
// suspicious; soft-only rows whose ids DO join to a should/incidental are NOT
// warned. So "over-warn fixed" holds exactly when the assertionId join exists.

function parseMaybeJson(value, fallback) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return JSON.parse(value || ''); } catch (_) { return fallback; } }
  return value != null ? value : fallback;
}

export function detectVerdictContradiction(result) {
  if (!result || result.status !== 'pass') return null;
  const mvr = String(result.mechanicalVerdictReason || '').toLowerCase();
  // EVIDENCE-CONTRACT PASS is NOT a contradiction. When the row's deterministic
  // evidence contract decided the verdict (login form visible + remained on the
  // entry page + the inline field/auth error — the un-fakeable composite), the
  // pass IS verified, even though the case's legacy declaredAssertion may still be
  // recorded "uncheckable" (it was superseded, not relied upon). Without this, an
  // evidence-backed PASS wrongly showed the "uncertified pass" banner.
  if (mvr.startsWith('evidence_contract:')) return null;
  // The pre-fix escape hatch literally stamped this marker onto the pass.
  if (mvr.includes('hard_assertion_uncheckable_passed_on_clean_execution')) {
    return { kind: 'uncheckable_pass', text: 'This saved run was marked PASS while a REQUIRED assertion could not be verified ("uncheckable"). The current engine holds such a case for review instead of passing it — treat this historical green as UNCERTIFIED and rerun for a real verdict.' };
  }
  const outcomes = Array.isArray(result.assertionCheckResults) ? result.assertionCheckResults.filter(Boolean) : [];

  // Resolve criticality: outcome.criticality → declared assertion (by id) → 'must'.
  const declared = parseMaybeJson(result.testCase && result.testCase.declaredAssertions, []) || [];
  const critById = new Map((Array.isArray(declared) ? declared : []).filter((d) => d && d.id).map((d) => [d.id, d.criticality || 'must']));
  const resolveCrit = (o) => o.criticality
    || (o.assertionId && critById.has(o.assertionId) ? critById.get(o.assertionId) : 'must');

  // A pass sitting on top of an uncheckable REQUIRED (must) assertion.
  const anyHardUncheckable = outcomes.some((o) => {
    const s = String(o.effective || o.outcome || o.status || '').toLowerCase();
    return s === 'uncheckable' && resolveCrit(o) === 'must';
  });
  if (anyHardUncheckable) {
    return { kind: 'uncheckable_pass', text: 'This saved run is marked PASS but its own evidence shows a REQUIRED assertion was "uncheckable" — QAAI never actually verified it. Treat this historical green as UNCERTIFIED and rerun for a real verdict.' };
  }

  // A pass with NO evidence at all — no screenshots, no checks, no verified step.
  const ss = parseMaybeJson(result.screenshots, []);
  const steps = parseMaybeJson(result.stepResults, []);
  const ssLen = Array.isArray(ss) ? ss.length : 0;
  const anyStepPass = Array.isArray(steps) && steps.some((s) => s && s.status === 'pass');
  if (ssLen === 0 && outcomes.length === 0 && !anyStepPass) {
    return { kind: 'no_evidence', text: 'This saved run is marked PASS but carries NO evidence — no screenshots, no assertion checks, and no verified step. Treat this historical green as UNCERTIFIED and rerun to capture real evidence.' };
  }
  return null;
}
