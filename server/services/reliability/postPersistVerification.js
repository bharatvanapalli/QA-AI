'use strict';

const {
  normalizeStepsInput,
  normalizeStepAction,
  SCENARIO_ACTIONS,
  tokensInValue,
  collectCaseReliabilityDefects,
} = require('./contracts');
const {
  buildCoverageIdentityMap,
  normalizeCoverageRefs,
} = require('./coverageIdentityMap');
const { computeScenarioGenerationStatus } = require('./scenarioGenerationStatus');
const readinessCompiler = require('../readinessCompiler');
const executableTestContract = require('../executableTestContract');

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function isInputStep(step = {}) {
  const action = normalizeStepAction(step.action, step.verify);
  return ['fill', 'select', 'check', 'upload'].includes(action);
}

function stepValue(step = {}) {
  if (step.value != null) return step.value;
  if (step.text != null) return step.text;
  if (step.input != null) return step.input;
  return '';
}

function add(defects, code, caseId, message, evidence = {}) {
  defects.push({ code, caseId, message, evidence });
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function unique(values) {
  return Array.from(new Set(arr(values).map(clean).filter(Boolean)));
}

function defectKey(defect = {}) {
  const evidence = defect.evidence && typeof defect.evidence === 'object' ? defect.evidence : {};
  return [
    defect.code,
    defect.caseId,
    defect.rowId,
    evidence.stepId || defect.stepId,
    evidence.token || defect.token,
    defect.coverageRef,
  ].map(clean).join('|');
}

function dedupeDefects(defects = []) {
  const seen = new Set();
  const out = [];
  for (const defect of arr(defects)) {
    if (!defect || !defect.code) continue;
    const key = defectKey(defect);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(defect);
  }
  return out;
}

function rowIntentsFromPlan(plan = {}) {
  return unique([
    ...arr(plan.rowIntents),
    ...arr(plan.rows).map((row) => row && (row.intent || row.rowIntent || row.caseIntent)),
  ]);
}

function itemIds(item = {}) {
  return unique([item.manifestItemId, item.coverageRef, item.id, item.coverageItemId]);
}

const POST_PERSIST_BLOCKING_CODES = new Set([
  'invalid_steps_shape',
  'malformed_steps_json',
  'non_array_steps',
  'post_persist_verification_failed',
]);

const POST_PERSIST_REPORTING_CODES = new Set([
  'coverage_owner_unknown',
  'wrong_coverage_owner',
  'missing_required_story_field',
  'token_collision',
  'weak_oracle',
  'verify_kind_none',
  'missing_structured_oracle',
  'missing_row_execution_plan',
  'silent_row_skip',
  'missing_data_lineage',
  'unregistered_browser_action',
  'non_exportable_action',
  'quality_contract_missing',
  'readiness_contract_missing',
  'readiness_status_mismatch',
  'session_mode_mismatch',
  'failure_policy_mismatch',
  'row_coverage_status_mismatch',
  'execution_contract_invalid',
  'selection_value_polluted',
  'condition_contains_browser_action',
  'malformed_control_target',
]);

function isPostPersistBlockingDefect(code) {
  return POST_PERSIST_BLOCKING_CODES.has(clean(code));
}

async function verifyPersistedGenerationContract({ prisma, generationId, projectId = null, identityMap = null } = {}) {
  if (!prisma || (!generationId && !projectId)) {
    return { ok: true, generationId, projectId, checkedCases: 0, defects: [], status: 'Good to run' };
  }
  const generation = generationId
    ? await prisma.scenarioGeneration.findUnique({ where: { id: generationId } }).catch(() => null)
    : null;
  const coverageManifest = parseJson(generation && generation.coveragePlanJson, null);
  const coverageIdentityMap = identityMap || buildCoverageIdentityMap(coverageManifest || {});
  const cases = await prisma.testCase.findMany({
    where: generationId ? { generationId } : { projectId },
    orderBy: { createdAt: 'asc' },
  });
  const defects = [];

  for (const tc of cases) {
    const quality = parseJson(tc.qualityContractJson, null);
    const phase45 = quality && quality.phase45 && typeof quality.phase45 === 'object' ? quality.phase45 : null;
    const dataBinding = parseJson(tc.dataBindingJson, null);
    const stepsResult = normalizeStepsInput(parseJson(tc.steps, []), { allowSingletonObject: false });
    const steps = stepsResult.ok ? stepsResult.steps : [];
    if (!stepsResult.ok) {
      add(defects, 'invalid_steps_shape', tc.id, `Persisted case "${tc.name}" has invalid step shape.`, { defect: stepsResult.defect || null });
    }

    if (!quality || !phase45 || phase45.enabled !== true) {
      add(defects, 'quality_contract_missing', tc.id, `Persisted case "${tc.name}" is missing qualityContractJson.phase45.`);
      continue;
    }

    try {
      executableTestContract.buildExecutionContract({
        testCase: tc,
        declaredSteps: steps,
        declaredAssertions: parseJson(tc.declaredAssertions, []),
      });
    } catch (error) {
      add(defects, 'execution_contract_invalid', tc.id, `Persisted case "${tc.name}" could not build its immutable execution contract.`, {
        code: error && error.code || null,
        reason: clean(error && error.message),
      });
    }

    const refs = normalizeCoverageRefs(phase45.coverageRefs || parseJson(tc.requirementRefs, []), coverageIdentityMap);
    if (!refs.length) add(defects, 'missing_coverageRefs', tc.id, `Persisted case "${tc.name}" has no resolvable coverageRefs.`);
    if (coverageIdentityMap.identities && coverageIdentityMap.identities.length) {
      for (const ref of refs) {
        if (!coverageIdentityMap.byRef.has(ref)) {
          add(defects, 'coverage_owner_unknown', tc.id, `Persisted case "${tc.name}" cites unknown coverageRef "${ref}".`, { ref });
        }
      }
    }
    if (dataBinding && dataBinding.sheet && !(phase45.rowExecutionPlan && arr(phase45.rowExecutionPlan.rowIds).length || arr(phase45.rowExecutionPlan && phase45.rowExecutionPlan.skippedRows).length)) {
      add(defects, 'missing_rowExecutionPlan', tc.id, `Persisted data-driven case "${tc.name}" has no rowExecutionPlan.`);
    }
    const matchedItems = arr(coverageManifest && coverageManifest.items).filter((item) => {
      const ids = itemIds(item).map((id) => normalizeCoverageRefs([id], coverageIdentityMap)[0]);
      return ids.some((id) => refs.includes(id));
    });
    const requiredRowIntents = unique(matchedItems.flatMap((item) => arr(item.dataRowIntents || item.rowIntents)));
    if (requiredRowIntents.length) {
      const actualRowIntents = unique([
        dataBinding && dataBinding.rowIntent,
        dataBinding && dataBinding.intent,
        dataBinding && dataBinding.rowSelector,
        ...(dataBinding ? arr(dataBinding.rowIntents) : []),
        ...rowIntentsFromPlan(phase45.rowExecutionPlan || {}),
      ]);
      for (const intent of requiredRowIntents) {
        if (!actualRowIntents.some((actual) => norm(actual) === norm(intent))) {
          add(defects, 'missing_row_intent', tc.id, `Persisted case "${tc.name}" is missing row intent "${intent}".`, { intent, actualRowIntents });
        }
      }
    }
    if (!arr(phase45.structuredOracles || phase45.oracles).length) {
      add(defects, 'missing_structured_oracle', tc.id, `Persisted case "${tc.name}" has no structured oracle.`);
    }
    if (!arr(phase45.browserActionBindings).length) {
      add(defects, 'missing_browserActionBindings', tc.id, `Persisted case "${tc.name}" has no browserActionBindings.`);
    }
    for (const step of steps) {
      const canonical = normalizeStepAction(step.action, step.verify);
      if (!canonical || !SCENARIO_ACTIONS.includes(canonical)) {
        add(defects, 'unregistered_browser_action', tc.id, `Persisted step action "${step.action}" is not canonical.`, { action: step.action });
      }
      if (isInputStep(step) && tokensInValue(stepValue(step)).length && !arr(step.dataLineage).length) {
        add(defects, 'missing_step_dataLineage', tc.id, `Persisted input step "${clean(step.target || step.element)}" has tokenized data but no step dataLineage.`, { target: step.target || step.element });
      }
      const selection = step.selectionCriteria && typeof step.selectionCriteria === 'object'
        ? step.selectionCriteria
        : null;
      const selectedText = clean(selection && (selection.expectedText || selection.text || selection.value || selection.predicate) || '');
      if (selectedText && /,?\s+(?:and\s+)?(?:assert|verify|validate|confirm|expect)\b/i.test(selectedText)) {
        add(defects, 'selection_value_polluted', tc.id, `Persisted selection step "${clean(step.target || step.element)}" mixes its option value with assertion prose.`, {
          stepId: step.id || null,
          selectedText,
        });
      }
      const condition = clean(step.condition && (step.condition.predicate || step.condition.text || step.condition) || '');
      if (condition && /\b(?:click|open|expand|collapse|select|choose|fill|enter|dismiss)\b/i.test(condition)) {
        add(defects, 'condition_contains_browser_action', tc.id, `Persisted step condition contains a second browser action instead of a predicate.`, {
          stepId: step.id || null,
          condition,
        });
      }
      const target = clean(step.target || step.element || '');
      if (/^(?:inspect|determine|check)\s+whether\b/i.test(target)) {
        add(defects, 'malformed_control_target', tc.id, `Persisted step target contains instruction prose instead of a control identity.`, {
          stepId: step.id || null,
          target,
        });
      }
    }
    const freshDefects = dedupeDefects(collectCaseReliabilityDefects({
      id: tc.id,
      caseId: tc.id,
      name: tc.name,
      module: tc.module,
      coverageRefs: refs,
      dataBinding,
      rowExecutionPlan: phase45.rowExecutionPlan || null,
      oracles: phase45.structuredOracles || phase45.oracles || [],
      steps,
    }, { module: tc.module, name: tc.name }, { coverageManifest }));
    for (const defect of freshDefects.filter((defect) => POST_PERSIST_REPORTING_CODES.has(defect.code))) {
      add(defects, defect.code, tc.id, defect.message, defect.evidence || {});
    }
    const computedStatus = computeScenarioGenerationStatus({ id: tc.id, caseId: tc.id }, freshDefects);
    if (phase45.status && phase45.status !== computedStatus) {
      add(defects, 'status_mismatch', tc.id, `Persisted status "${phase45.status}" does not match computed status "${computedStatus}".`, { persisted: phase45.status, computed: computedStatus });
    }
    const readiness = readinessCompiler.compileCaseReadiness(tc);
    if (!tc.readinessStatus || !tc.readinessContractVersion) {
      add(defects, 'readiness_contract_missing', tc.id, `Persisted case "${tc.name}" is missing durable readiness fields.`, {
        readinessStatus: tc.readinessStatus || null,
        readinessContractVersion: tc.readinessContractVersion || null,
      });
    } else if (tc.readinessStatus !== readiness.readinessStatus) {
      add(defects, 'readiness_status_mismatch', tc.id, `Persisted readinessStatus "${tc.readinessStatus}" does not match computed "${readiness.readinessStatus}".`, {
        persisted: tc.readinessStatus,
        computed: readiness.readinessStatus,
        reasons: readiness.readinessReasons,
      });
    }
    if ((tc.sessionMode || 'fresh') !== readiness.sessionMode) {
      add(defects, 'session_mode_mismatch', tc.id, `Persisted sessionMode "${tc.sessionMode || 'fresh'}" does not match computed "${readiness.sessionMode}".`, {
        persisted: tc.sessionMode || 'fresh',
        computed: readiness.sessionMode,
      });
    }
    if ((tc.failurePolicy || 'continue_independent') !== readiness.failurePolicy) {
      add(defects, 'failure_policy_mismatch', tc.id, `Persisted failurePolicy "${tc.failurePolicy || 'continue_independent'}" does not match computed "${readiness.failurePolicy}".`, {
        persisted: tc.failurePolicy || 'continue_independent',
        computed: readiness.failurePolicy,
      });
    }
    if ((tc.rowCoverageStatus || null) !== (readiness.rowCoverageStatus || null)) {
      add(defects, 'row_coverage_status_mismatch', tc.id, `Persisted rowCoverageStatus does not match computed row coverage.`, {
        persisted: tc.rowCoverageStatus || null,
        computed: readiness.rowCoverageStatus || null,
      });
    }
  }

  const blockingDefects = defects.filter((defect) => isPostPersistBlockingDefect(defect.code));

  return {
    ok: blockingDefects.length === 0,
    generationId,
    projectId,
    checkedCases: cases.length,
    defects,
    blockingDefects,
    status: computeScenarioGenerationStatus({}, defects.map((defect) => ({
      ...defect,
      severity: defect.code.includes('missing') || defect.code.includes('unregistered') ? 'repair_required' : 'warning',
      family: defect.code.includes('capability') ? 'app_capability' : 'system',
    }))),
  };
}

module.exports = {
  isPostPersistBlockingDefect,
  verifyPersistedGenerationContract,
};
