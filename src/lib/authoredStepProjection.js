const asArray = (value) => (Array.isArray(value) ? value : []);

const firstPresent = (...values) => values.find(
  (value) => value !== undefined && value !== null && value !== '',
);

const numericOrdinal = (step, fallback) => {
  const candidate = Number(firstPresent(
    step?.stepOrdinal,
    step?.ordinal,
    step?.order,
    step?.sequenceIndex,
    fallback,
  ));
  return Number.isFinite(candidate) && candidate > 0 ? candidate : fallback;
};

const stepIdentity = (step, fallback) => String(firstPresent(
  step?.contractStepId,
  step?.stepId,
  step?.id,
  step?.nodeId,
  fallback,
));

const logicalIdentity = (step, fallback) => String(firstPresent(
  step?.logicalStepId,
  step?.logicalId,
  step?.parentLogicalStepId,
  step?.raw?.logicalStepId,
  fallback,
));

const interpretedStepText = (step) => {
  if (typeof step === 'string') return step;
  return String(firstPresent(
    step?.plannedText,
    step?.text,
    step?.description,
    step?.instruction,
    step?.name,
    step?.title,
    [step?.action, step?.target || step?.element].filter(Boolean).join(' '),
    '',
  ));
};

/**
 * The user's sentence is the display authority. Do not normalize whitespace or
 * rebuild it from compiler fields: traceability requires the exact stored text.
 */
export function authoredStepText(step) {
  if (typeof step === 'string') return step;
  return String(firstPresent(
    step?.authoredText,
    step?.userAuthoredText,
    step?.raw?.authoredText,
    interpretedStepText(step),
    '',
  ));
}

const parseStoredObject = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

/**
 * Prefer the run-pinned execution contract when it carries authored identity.
 * Legacy contracts without authored metadata keep the existing TestCase steps
 * fallback so older reports remain readable.
 */
export function selectAuthoredPlannedSteps({ result, testCase } = {}) {
  const executionContract = parseStoredObject(
    result?.executionContract ?? result?.executionContractJson,
  );
  const pinned = asArray(executionContract?.steps).length
    ? executionContract.steps
    : asArray(executionContract?.nodes);
  const pinnedHasAuthoredIdentity = pinned.some((step) => (
    step?.authoredText
    || step?.userAuthoredText
    || step?.logicalStepId
    || step?.raw?.authoredText
  ));
  if (pinnedHasAuthoredIdentity) return pinned;
  return asArray(testCase?.steps).length ? testCase.steps : pinned;
}

const journalLookup = (journalRows) => {
  const byId = new Map();
  const byOrdinal = new Map();
  for (const [index, row] of asArray(journalRows).entries()) {
    if (!row) continue;
    [
      row.stepId,
      row.contractStepId,
      row.id,
      row.nodeId,
      row.sourceStepId,
    ].filter(Boolean).forEach((id) => byId.set(String(id), row));
    byOrdinal.set(numericOrdinal(row, index + 1), row);
  }
  return { byId, byOrdinal };
};

const nestedAtomicActions = (step) => {
  const candidates = [
    step?.atomicActions,
    step?.interpreted?.atomicActions,
    step?.interpretation?.atomicActions,
    step?.executionActions,
  ];
  return candidates.find(Array.isArray) || [];
};

function projectAtomicAction(step, index, sourceOrdinal, journal) {
  const id = stepIdentity(step, `execution-action-${sourceOrdinal}-${index + 1}`);
  return {
    id,
    sourceOrdinal,
    atomicOrdinal: numericOrdinal(
      { ordinal: firstPresent(step?.atomicOrdinal, step?.ordinal) },
      index + 1,
    ),
    text: interpretedStepText(step),
    action: firstPresent(step?.action, step?.type, step?.stepKind, null),
    target: firstPresent(step?.target, step?.element, step?.label, null),
    value: firstPresent(step?.value, step?.input, null),
    expected: firstPresent(step?.expected, step?.validation, null),
    journal: journal || null,
  };
}

/**
 * Collapse compiler-level atomic rows into the logical authored steps the user
 * wrote, while retaining each atomic/journal row as expandable runtime detail.
 */
export function projectAuthoredStepRows(plannedSteps = [], journalRows = []) {
  const lookup = journalLookup(journalRows);
  const groups = [];
  const byLogicalId = new Map();

  asArray(plannedSteps).forEach((step, index) => {
    const sourceOrdinal = numericOrdinal(step, index + 1);
    const physicalId = stepIdentity(step, `planned-step-${sourceOrdinal}`);
    const logicalId = logicalIdentity(step, physicalId);
    let group = byLogicalId.get(logicalId);
    if (!group) {
      const text = authoredStepText(step);
      group = {
        id: logicalId,
        logicalStepId: logicalId,
        order: groups.length + 1,
        authoredText: text,
        step: typeof step === 'object' && step
          ? { ...step, authoredText: text, logicalStepId: logicalId }
          : { id: physicalId, authoredText: text, logicalStepId: logicalId },
        atomicActions: [],
        sourceOrdinals: [],
      };
      groups.push(group);
      byLogicalId.set(logicalId, group);
    }
    group.sourceOrdinals.push(sourceOrdinal);

    const journal = lookup.byId.get(physicalId) || lookup.byOrdinal.get(sourceOrdinal) || null;
    const nested = nestedAtomicActions(step);
    if (nested.length) {
      nested.forEach((atomic, atomicIndex) => {
        const atomicId = stepIdentity(atomic, `${physicalId}.atomic.${atomicIndex + 1}`);
        const atomicJournal = lookup.byId.get(atomicId)
          || (nested.length === 1 ? journal : null);
        group.atomicActions.push(projectAtomicAction(
          { ...atomic, id: atomicId },
          atomicIndex,
          sourceOrdinal,
          atomicJournal,
        ));
      });
    } else {
      group.atomicActions.push(projectAtomicAction(step, group.atomicActions.length, sourceOrdinal, journal));
    }
  });

  return groups;
}

const statusRank = (row) => {
  if (!row) return 0;
  if (row.executionError === true || row.qaaiExecutionError === true) return 90;
  if (row.assertionOutcome === 'not_matched' || row?.assertion?.matched === false) return 85;
  if (row.actionOutcome === 'failed' || ['fail', 'failed'].includes(String(row.status || '').toLowerCase())) return 80;
  if (String(row.status || '').toLowerCase() === 'blocked') return 75;
  if (row.actionOutcome === 'not_executed' || ['skipped', 'not_executed'].includes(String(row.status || '').toLowerCase())) return 70;
  if (String(row.status || '').toLowerCase() === 'running') return 60;
  if (String(row.status || '').toLowerCase() === 'pending') return 50;
  if (row.actionOutcome === 'succeeded' || ['pass', 'passed'].includes(String(row.status || '').toLowerCase())) return 10;
  return 1;
};

/**
 * Produce the existing row-shaped verdict expected by Reports without
 * discarding the constituent journal rows. The worst truthful outcome wins.
 */
export function summarizeAuthoredStepVerdict(runtimeDetails = []) {
  const rows = asArray(runtimeDetails)
    .map((detail) => detail?.verdict || detail?.journal || detail)
    .filter(Boolean);
  if (!rows.length) return null;
  let representative = rows[0];
  for (const row of rows) {
    if (statusRank(row) > statusRank(representative)) representative = row;
  }
  const durationMs = rows.reduce((total, row) => {
    const value = Number(row?.durationMs);
    return total + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
  return {
    ...representative,
    ...(durationMs > 0 ? { durationMs } : {}),
    atomicResults: rows,
    atomicResultCount: rows.length,
  };
}

