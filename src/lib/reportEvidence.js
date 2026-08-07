const PROBLEM_STATUSES = new Set(['fail', 'failed', 'blocked', 'error']);

function cleanText(value, max = 320) {
  if (value === null || value === undefined) return '';
  let source = value;
  if (typeof value === 'object') {
    try { source = JSON.stringify(value); } catch (_) { source = String(value); }
  }
  const text = String(source).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function parseStepResults(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function statusOf(verdict) {
  return cleanText(verdict?.status, 40).toLowerCase();
}

function isProblemVerdict(verdict) {
  const status = statusOf(verdict);
  const op = verdict?.operationCheck || verdict?.stepOperationCheck || null;
  const assertion = verdict?.assertion || verdict?.stepAssertion || null;
  const assertions = Array.isArray(verdict?.assertions) ? verdict.assertions : [];
  return PROBLEM_STATUSES.has(status)
    || verdict?.actionOutcome === 'failed'
    || verdict?.assertionOutcome === 'not_matched'
    || verdict?.assertionOutcome === 'uncheckable'
    || verdict?.executionError === true
    || op?.matched === false
    || assertion?.matched === false
    || assertions.some((entry) => entry?.outcome === 'not_matched' || entry?.outcome === 'uncheckable')
    || Boolean(cleanText(verdict?.error));
}

function plainStep(step) {
  if (!step) return '';
  if (typeof step === 'string') return cleanText(step);
  return cleanText(
    step.description
      || step.text
      || [step.action, step.element || step.target, step.value ? `with "${step.value}"` : '']
        .filter(Boolean)
        .join(' '),
  );
}

// A nested check (operationCheck / legacy assertion) that never records its
// own `.matched` defers to the step's own resolved status — a required
// check's pass/fail IS the step's pass/fail, not a separate fact to prove.
function resolvedMatch(explicitMatched, verdict) {
  if (explicitMatched === true || explicitMatched === false) return explicitMatched;
  const status = statusOf(verdict);
  if (status === 'pass') return true;
  if (status === 'fail' || status === 'blocked') return false;
  return undefined;
}

function checkKindLabel(kind) {
  const normalized = cleanText(kind, 80).replace(/[_-]+/g, ' ').toLowerCase();
  if (!normalized) return 'required state';
  if (normalized === 'input value readback') return 'input value';
  if (normalized === 'page ready') return 'page readiness';
  if (normalized === 'page state') return 'page state';
  return normalized;
}

function primaryCheck(verdict) {
  const journalAssertions = Array.isArray(verdict?.assertions) ? verdict.assertions : [];
  const journalAssertion = journalAssertions.find((entry) => entry?.outcome === 'not_matched')
    || journalAssertions.find((entry) => entry?.outcome === 'uncheckable')
    || journalAssertions[0];
  if (journalAssertion) {
    const outcome = cleanText(journalAssertion.outcome, 40);
    return {
      type: 'assertion',
      matched: outcome === 'matched' ? true : outcome === 'not_matched' ? false : undefined,
      outcome,
      status: cleanText(journalAssertion.status, 40),
      expected: cleanText(journalAssertion.expected, 260),
      actual: cleanText(journalAssertion.actual, 260),
      comparator: cleanText(journalAssertion.comparator, 80),
      observed: cleanText(journalAssertion.evidence || journalAssertion.reason || journalAssertion.actual, 320),
      label: checkKindLabel(journalAssertion.kind || journalAssertion.channel || 'verification'),
    };
  }
  const op = verdict?.operationCheck || verdict?.stepOperationCheck || null;
  if (op) {
    // `operationCheck` is the DECLARED requirement (condition/expected/kind/
    // target) authored for this step — it never carries its own resolved
    // `.matched`/`.status`. The requirement's actual resolution is the step's
    // own outcome: a required operationCheck gates whether the step commits
    // at all, so `verdict.status` IS the check's resolution, not a separate
    // fact. Reading `op.matched` directly always returned undefined and
    // rendered every operation check as "uncheckable", regardless of whether
    // the step actually passed.
    const matched = resolvedMatch(op.matched, verdict);
    return {
      type: 'operation',
      matched,
      status: cleanText(op.status || verdict?.status, 40),
      expected: cleanText(op.expected || op.target, 260),
      actual: cleanText(op.actual, 260),
      comparator: cleanText(op.comparator || op.kind, 80),
      observed: cleanText(op.evidence || op.reason || verdict?.reason, 320),
      label: checkKindLabel(op.kind || op.channel),
    };
  }
  const assertion = verdict?.assertion || verdict?.stepAssertion || null;
  if (assertion) {
    return {
      type: 'assertion',
      matched: resolvedMatch(assertion.matched, verdict),
      status: cleanText(assertion.status || verdict?.status, 40),
      expected: cleanText(assertion.expected, 260),
      actual: cleanText(assertion.actual, 260),
      comparator: cleanText(assertion.comparator, 80),
      observed: cleanText(assertion.evidence || assertion.reason || verdict?.reason, 320),
      label: 'verification',
    };
  }
  return null;
}

export function buildStepReportNarrative({ step, number, verdict }) {
  if (!verdict) return null;
  const check = primaryCheck(verdict);
  const status = statusOf(verdict);
  const problem = isProblemVerdict(verdict);
  const observed = cleanText(
    check?.observed
      || verdict.error
      || verdict.evidence
      || verdict.reason,
    360,
  );
  const stepText = plainStep(step);
  const checked = check
    ? `QAAI checked ${check.label}${check.expected ? `: expected ${check.expected}` : ''}${check.comparator ? ` (${check.comparator})` : ''}.`
    : stepText
      ? `QAAI worked on Step ${number}: ${stepText}.`
      : `QAAI worked on Step ${number}.`;

  let conclusion = '';
  const continuation = cleanText(verdict?.continuationOutcome, 80).toLowerCase();
  const continued = continuation === 'continue' || continuation === 'retry';
  if (check?.matched === false && check.type === 'assertion') {
    conclusion = continued
      ? 'That declared validation did not match. QAAI recorded it and continued with independent steps.'
      : 'That declared validation did not match. Execution stopped here for dependent steps.';
  } else if (check?.matched === false) {
    conclusion = continued
      ? 'That required state was not proven. QAAI recorded it and continued with independent steps.'
      : 'That required state was not proven on the website, so execution stopped here for dependent steps.';
  } else if (check?.outcome === 'uncheckable') {
    conclusion = continued
      ? 'That validation could not be checked. QAAI recorded it and continued with independent steps.'
      : 'That validation could not be checked, so execution stopped here for dependent steps.';
  } else if (problem) {
    conclusion = status === 'blocked'
      ? 'The conductor could not safely continue from this step.'
      : 'This step did not complete successfully.';
  } else if (status === 'pass' || check?.matched === true) {
    conclusion = 'QAAI confirmed this step and moved on.';
  } else if (status === 'skipped') {
    conclusion = 'The run ended before this step was individually executed.';
  }

  if (!problem && !check && !observed) return null;

  return {
    title: problem ? (continued ? 'Validation evidence' : 'Why this step stopped') : 'Step evidence',
    tone: problem ? (status === 'fail' || check?.type === 'assertion' ? 'danger' : 'warn') : 'success',
    checked,
    observed: observed || (check?.matched === true ? 'The expected state was confirmed.' : ''),
    conclusion,
  };
}

export function buildStepEvidenceRows(verdict) {
  if (!verdict) return [];
  const journalAssertions = Array.isArray(verdict.assertions) ? verdict.assertions : [];
  if (journalAssertions.length > 0) {
    return journalAssertions.map((assertion, index) => ({
      id: cleanText(assertion?.id, 120) || `assertion-${index + 1}`,
      outcome: cleanText(assertion?.outcome || assertion?.assertionOutcome || assertion?.status, 40) || 'uncheckable',
      expected: cleanText(assertion?.expected ?? assertion?.expectedValue ?? assertion?.expectedState, 320),
      actual: cleanText(assertion?.actual ?? assertion?.actualValue ?? assertion?.observed ?? assertion?.observedValue ?? assertion?.observedState, 320),
      comparator: cleanText(assertion?.comparator || assertion?.operator, 80),
      reason: cleanText(assertion?.reason || assertion?.message || assertion?.error, 360),
      evidence: cleanText(assertion?.evidence || assertion?.evidenceRef || assertion?.evidenceReferences || assertion?.screenshotRef || assertion?.traceRef, 360),
    }));
  }

  const legacy = [
    verdict.operationCheck || verdict.stepOperationCheck,
    verdict.assertion || verdict.stepAssertion,
  ].filter(Boolean);
  return legacy.map((assertion, index) => {
    const matched = resolvedMatch(assertion.matched, verdict);
    return {
      id: `legacy-check-${index + 1}`,
      outcome: matched === true ? 'matched' : matched === false ? 'not_matched' : 'uncheckable',
      expected: cleanText(assertion.expected || assertion.target, 320),
      actual: cleanText(assertion.actual, 320),
      comparator: cleanText(assertion.comparator || assertion.kind || assertion.channel, 80),
      reason: cleanText(assertion.reason || verdict?.reason, 360),
      evidence: cleanText(assertion.evidence, 360),
    };
  });
}

export function buildStepContinuation(verdict) {
  const outcome = cleanText(verdict?.continuationOutcome, 80).toLowerCase();
  const labels = {
    continue: 'Continued',
    retry: 'Retried',
    stop_descendants: 'Stopped dependent steps',
    stop_case: 'Stopped case',
  };
  const label = labels[outcome] || '';
  const reason = cleanText(verdict?.continuationReason || verdict?.reason || verdict?.error, 360);
  return label || reason ? { label, reason } : null;
}

export function buildConductorSummary(result) {
  if (!result || result.status === 'pass') return null;
  const steps = parseStepResults(result.stepResults);
  const issue = steps.find(isProblemVerdict);
  if (!issue) return null;
  const narrative = buildStepReportNarrative({
    step: null,
    number: issue.ordinal || issue.index || steps.indexOf(issue) + 1,
    verdict: issue,
  });
  if (!narrative) return null;
  const parts = [
    `${issue.continuationOutcome === 'continue' ? 'QAAI recorded an issue at' : 'QAAI stopped at'} Step ${issue.ordinal || issue.index || steps.indexOf(issue) + 1}.`,
    narrative.checked,
    narrative.observed ? `Observed: ${narrative.observed}` : '',
    narrative.conclusion,
  ].filter(Boolean);
  return cleanText(parts.join(' '), 520);
}
