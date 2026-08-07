'use strict';

const {
  SCHEMA_VERSION,
  CONTRACT_VERSION,
  RELIABILITY_SEVERITY,
  REPAIR_STOP_REASON,
  createReliabilityDefect,
  collectScenarioReliabilityDefects,
  summarizeDefects,
  withContractVersions,
  buildRowExecutionPlan,
  buildStructuredOracles,
  isStrongBusinessOracle,
  requiredFieldsFromContext,
  fieldPresentInSteps,
  normalizeStepsInput,
} = require('./contracts');

const DEFAULT_REPAIR_BUDGET = Object.freeze({
  maxFullSuiteRepairRounds: 3,
  maxTargetedRepairsPerDefectFamily: 2,
  maxRepairWallClockMs: 120000,
  maxRepairTokens: 60000,
  maxRepairToolCalls: 20,
  maxCasesPerRepairPrompt: 5,
});

const SEVERITY_RANK = Object.freeze({
  [RELIABILITY_SEVERITY.INFO]: 0,
  [RELIABILITY_SEVERITY.WARNING]: 1,
  [RELIABILITY_SEVERITY.USER_DECISION_REQUIRED]: 2,
  [RELIABILITY_SEVERITY.REPAIR_REQUIRED]: 3,
  [RELIABILITY_SEVERITY.CRITICAL]: 4,
});

const REPAIR_FAMILY_BY_CODE = Object.freeze({
  double_encoded_steps: 'step_shape_defect',
  malformed_steps_json: 'step_shape_defect',
  invalid_steps_shape: 'step_shape_defect',
  coverage_missing_required: 'missing_coverage',
  coverage_required_missing: 'missing_coverage',
  missing_required_story_field: 'missing_required_field',
  token_collision: 'token_collision',
  proposed_data_mapping: 'unapproved_data_mapping',
  missing_approved_data: 'unapproved_data_mapping',
  missing_data_lineage: 'missing_data_lineage',
  missing_structured_oracle: 'weak_oracle',
  weak_oracle: 'weak_oracle',
  verify_kind_none: 'weak_oracle',
  missing_row_execution_plan: 'missing_row_coverage',
  invalid_row_execution_plan: 'missing_row_coverage',
  silent_row_skip: 'missing_row_coverage',
  generic_orangehrm_flow: 'generic_orangehrm_flow',
  duplicate_or_overlapping_case: 'duplicate_or_overlapping_case',
  cross_module_requirement_ref: 'cross_module_requirement_ref',
  missing_app_capability: 'missing_app_capability',
  stale_app_capability: 'missing_app_capability',
  unregistered_browser_action: 'unregistered_browser_action',
  non_exportable_action: 'unregistered_browser_action',
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mergeBudget(budget = {}) {
  return { ...DEFAULT_REPAIR_BUDGET, ...(budget && typeof budget === 'object' ? budget : {}) };
}

function severityRank(defect = {}) {
  return SEVERITY_RANK[defect.severity] == null ? SEVERITY_RANK[RELIABILITY_SEVERITY.WARNING] : SEVERITY_RANK[defect.severity];
}

function isOpenRepairableDefect(defect = {}) {
  return !!defect
    && defect.resolutionStatus !== 'auto_repaired'
    && defect.resolutionStatus !== 'dismissed'
    && defect.resolutionStatus !== 'superseded'
    && (defect.repairable === true || defect.severity === RELIABILITY_SEVERITY.REPAIR_REQUIRED || defect.severity === RELIABILITY_SEVERITY.CRITICAL);
}

function repairFamilyForDefect(defect = {}) {
  return REPAIR_FAMILY_BY_CODE[defect.code] || defect.family || 'system';
}

function defectKey(defect = {}) {
  return [
    defect.code || 'unknown',
    defect.caseId || '*',
    defect.coverageRef || '*',
    defect.rowId || '*',
  ].join(':');
}

function groupDefectsByRepairFamily(defects = []) {
  const grouped = new Map();
  for (const defect of (Array.isArray(defects) ? defects : [])) {
    if (!isOpenRepairableDefect(defect)) continue;
    const family = repairFamilyForDefect(defect);
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family).push(defect);
  }
  return Array.from(grouped.entries()).map(([family, familyDefects]) => ({
    family,
    defects: familyDefects,
    defectCodes: Array.from(new Set(familyDefects.map((defect) => defect.code))),
    targetCaseIds: Array.from(new Set(familyDefects.map((defect) => defect.caseId).filter(Boolean))),
    targetCoverageRefs: Array.from(new Set(familyDefects.map((defect) => defect.coverageRef).filter(Boolean))),
  }));
}

function createRepairTasks({ defects = [], budget = {} } = {}) {
  const finalBudget = mergeBudget(budget);
  const grouped = groupDefectsByRepairFamily(defects);
  const tasks = [];
  let skippedRepairsDueToBudget = 0;
  for (const group of grouped) {
    const chunks = [];
    for (let i = 0; i < group.defects.length; i += finalBudget.maxCasesPerRepairPrompt) {
      chunks.push(group.defects.slice(i, i + finalBudget.maxCasesPerRepairPrompt));
    }
    const allowedChunks = chunks.slice(0, finalBudget.maxTargetedRepairsPerDefectFamily);
    skippedRepairsDueToBudget += Math.max(0, chunks.length - allowedChunks.length);
    allowedChunks.forEach((chunk, index) => {
      tasks.push(withContractVersions({
        id: `repair_task_${group.family}_${index + 1}`,
        family: group.family,
        targetDefectIds: chunk.map((defect) => defect.id),
        targetDefectCodes: Array.from(new Set(chunk.map((defect) => defect.code))),
        targetCaseIds: Array.from(new Set(chunk.map((defect) => defect.caseId).filter(Boolean))),
        targetCoverageRefs: Array.from(new Set(chunk.map((defect) => defect.coverageRef).filter(Boolean))),
        defects: chunk,
      }));
    });
  }
  return { tasks, skippedRepairsDueToBudget, budget: finalBudget };
}

function createRepairRound({
  generationId = null,
  roundNumber = 1,
  family = 'system',
  targetCaseIds = [],
  targetCoverageRefs = [],
  defectsBefore = [],
  defectsAfter = [],
  accepted = false,
  rejectionReason = undefined,
  tokensUsed = 0,
  wallClockMs = 0,
  toolCallsUsed = 0,
} = {}) {
  return withContractVersions({
    id: `repair_round_${generationId || 'generation'}_${roundNumber}`,
    generationId,
    roundNumber,
    family,
    targetCaseIds,
    targetCoverageRefs,
    defectCodesBefore: Array.from(new Set((Array.isArray(defectsBefore) ? defectsBefore : []).map((defect) => defect.code).filter(Boolean))),
    defectCodesAfter: Array.from(new Set((Array.isArray(defectsAfter) ? defectsAfter : []).map((defect) => defect.code).filter(Boolean))),
    accepted,
    rejectionReason,
    tokensUsed,
    wallClockMs,
    toolCallsUsed,
    createdAt: new Date().toISOString(),
  });
}

function createAuditEvent({
  generationId = null,
  actorType = 'system',
  actorId = undefined,
  action,
  before = {},
  after = {},
} = {}) {
  return withContractVersions({
    id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`,
    generationId,
    actorType,
    actorId,
    action: action || 'reliability_repair_event',
    before,
    after,
    createdAt: new Date().toISOString(),
  });
}

function compareDefects({ beforeDefects = [], afterDefects = [], targetDefects = [] } = {}) {
  const beforeOpen = (Array.isArray(beforeDefects) ? beforeDefects : []).filter(isOpenRepairableDefect);
  const afterOpen = (Array.isArray(afterDefects) ? afterDefects : []).filter(isOpenRepairableDefect);
  const targetKeys = new Set((targetDefects.length ? targetDefects : beforeOpen).map(defectKey));
  const beforeTargetCount = beforeOpen.filter((defect) => targetKeys.has(defectKey(defect))).length;
  const afterTargetCount = afterOpen.filter((defect) => targetKeys.has(defectKey(defect))).length;
  const beforeKeys = new Set(beforeOpen.map(defectKey));
  const maxBeforeRank = beforeOpen.reduce((max, defect) => Math.max(max, severityRank(defect)), 0);
  const introducedDefects = afterOpen.filter((defect) => !beforeKeys.has(defectKey(defect)));
  const higherSeverityNewDefects = introducedDefects.filter((defect) => severityRank(defect) > maxBeforeRank);
  const targetDefectsReduced = afterTargetCount < beforeTargetCount;
  return {
    targetDefectsReduced,
    beforeTargetCount,
    afterTargetCount,
    introducedDefects,
    higherSeverityNewDefects,
    accepted: targetDefectsReduced && higherSeverityNewDefects.length === 0,
  };
}

function sameTargetDefectsRepeated({ beforeDefects = [], afterDefects = [], targetDefects = [] } = {}) {
  const targetKeys = new Set((targetDefects.length ? targetDefects : beforeDefects).map(defectKey));
  if (!targetKeys.size) return false;
  const beforeOpen = (Array.isArray(beforeDefects) ? beforeDefects : []).filter(isOpenRepairableDefect);
  const afterOpen = (Array.isArray(afterDefects) ? afterDefects : []).filter(isOpenRepairableDefect);
  const beforeTarget = new Set(beforeOpen.filter((defect) => targetKeys.has(defectKey(defect))).map(defectKey));
  const afterTarget = new Set(afterOpen.filter((defect) => targetKeys.has(defectKey(defect))).map(defectKey));
  if (!beforeTarget.size || beforeTarget.size !== afterTarget.size) return false;
  for (const key of beforeTarget) {
    if (!afterTarget.has(key)) return false;
  }
  return true;
}

function numericUsage(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function repairTokenUsage(result = {}) {
  if (!result || typeof result !== 'object') return { tokensUsed: 0, reported: false };
  if (result.tokensUsed != null) return { tokensUsed: numericUsage(result.tokensUsed), reported: true };
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : null;
  if (!usage) return { tokensUsed: 0, reported: false };
  const tokensUsed = numericUsage(usage.tokensUsed)
    + numericUsage(usage.inputTokens)
    + numericUsage(usage.outputTokens)
    + numericUsage(usage.totalTokens);
  return { tokensUsed, reported: true };
}

function budgetSnapshot({
  budget = {},
  wallClockMs = 0,
  toolCallsUsed = 0,
  tokensUsed = 0,
  tokenTelemetrySeen = false,
  skippedRepairsDueToBudget = 0,
  stopReason = undefined,
} = {}) {
  return {
    maxFullSuiteRepairRounds: budget.maxFullSuiteRepairRounds,
    maxTargetedRepairsPerDefectFamily: budget.maxTargetedRepairsPerDefectFamily,
    maxRepairWallClockMs: budget.maxRepairWallClockMs,
    maxRepairTokens: budget.maxRepairTokens,
    maxRepairToolCalls: budget.maxRepairToolCalls,
    maxCasesPerRepairPrompt: budget.maxCasesPerRepairPrompt,
    wallClockMs,
    toolCallsUsed,
    tokensUsed,
    tokenBudgetStatus: tokenTelemetrySeen ? 'enforced' : 'not_applicable_deterministic',
    skippedRepairsDueToBudget,
    budgetExhausted: stopReason === REPAIR_STOP_REASON.BUDGET_EXHAUSTED,
  };
}

function coverageRefsOf(caseObj = {}) {
  return Array.isArray(caseObj.coverageRefs) ? caseObj.coverageRefs.filter(Boolean) : [];
}

function approvedBinding(caseObj = {}) {
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  if (!binding) return null;
  const status = String(binding.mappingStatus || binding.status || binding.source || '').toLowerCase();
  return status === 'approved' || status === 'complete_approved' ? binding : null;
}

function oracleStrength(caseObj = {}) {
  return buildStructuredOracles(caseObj).filter(isStrongBusinessOracle).length;
}

function normalizedSteps(caseObj = {}) {
  const normalized = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
  return normalized.ok ? normalized.steps : [];
}

function requiredFieldsForMerge(caseObj = {}, target = {}) {
  const beforeSteps = normalizedSteps(caseObj);
  const fields = new Set(
    requiredFieldsFromContext(caseObj, {}, target.context || {})
      .filter((field) => fieldPresentInSteps(field, beforeSteps)),
  );
  for (const field of (Array.isArray(caseObj.requiredFields) ? caseObj.requiredFields : [])) {
    if (field) fields.add(String(field));
  }
  for (const defect of (Array.isArray(target.defects) ? target.defects : [])) {
    const field = defect && defect.evidence && defect.evidence.field;
    if (field) fields.add(String(field));
  }
  return Array.from(fields).filter(Boolean);
}

function rowPlanStrength(caseObj = {}) {
  const plan = buildRowExecutionPlan(caseObj);
  if (!plan) return { rows: 0, skipped: 0, hasPlan: false };
  return {
    rows: Array.isArray(plan.rowIds) ? plan.rowIds.length : 0,
    skipped: Array.isArray(plan.skippedRows) ? plan.skippedRows.length : 0,
    hasPlan: true,
  };
}

function lineageStrength(caseObj = {}) {
  if (Array.isArray(caseObj.dataLineage)) return caseObj.dataLineage.length;
  const binding = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
  if (!binding) return 0;
  const columns = binding.columnToField && typeof binding.columnToField === 'object'
    ? Object.keys(binding.columnToField).length
    : 0;
  const rows = rowPlanStrength(caseObj).rows || 1;
  return columns * rows;
}

function caseIntentSignature(caseObj = {}) {
  const refs = coverageRefsOf(caseObj).sort().join('|');
  const moduleName = String(caseObj.module || caseObj.moduleName || '').trim().toLowerCase();
  const intent = String(caseObj.caseIntent || caseObj.intent || caseObj.name || caseObj.title || '').trim().toLowerCase();
  if (!intent && !refs) return '';
  return `${moduleName}::${intent}::${refs}`;
}

function duplicateCaseIntentRows(scenarios = []) {
  const seen = new Map();
  const duplicates = [];
  for (const row of flattenCases(scenarios)) {
    const id = row.caseObj && (row.caseObj.id || row.caseObj.caseId);
    const signature = caseIntentSignature(row.caseObj);
    if (!signature) continue;
    const previous = seen.get(signature);
    if (previous && previous.id !== id) duplicates.push({ signature, firstCaseId: previous.id, duplicateCaseId: id });
    else seen.set(signature, { id });
  }
  return duplicates;
}

function safeMergeCase({ beforeCase = {}, afterCase = {}, target = {} } = {}) {
  const beforeId = beforeCase.id || beforeCase.caseId;
  const afterId = afterCase.id || afterCase.caseId;
  const beforeRefs = new Set(coverageRefsOf(beforeCase));
  const afterRefs = new Set(coverageRefsOf(afterCase));
  const targetCoverageRefs = new Set(Array.isArray(target.targetCoverageRefs) ? target.targetCoverageRefs : []);
  const sameCase = beforeId && afterId && beforeId === afterId;
  const declaredTarget = Array.from(targetCoverageRefs).some((ref) => afterRefs.has(ref) || beforeRefs.has(ref));
  if (!sameCase && !declaredTarget) {
    return { ok: false, reason: 'case_identity_not_targeted' };
  }
  for (const ref of beforeRefs) {
    if (!afterRefs.has(ref)) return { ok: false, reason: 'coverage_ref_dropped', ref };
  }
  const approved = approvedBinding(beforeCase);
  if (approved) {
    const next = approvedBinding(afterCase);
    if (!next || next.sheet !== approved.sheet) return { ok: false, reason: 'approved_data_binding_removed' };
  }
  if (beforeCase.rowExecutionPlan && !afterCase.rowExecutionPlan) {
    return { ok: false, reason: 'row_execution_plan_removed' };
  }
  const beforePlan = rowPlanStrength(beforeCase);
  const afterPlan = rowPlanStrength(afterCase);
  if (beforePlan.hasPlan && (!afterPlan.hasPlan || afterPlan.rows < beforePlan.rows)) {
    return { ok: false, reason: 'row_execution_plan_weakened', before: beforePlan, after: afterPlan };
  }
  if (lineageStrength(afterCase) < lineageStrength(beforeCase)) {
    return { ok: false, reason: 'data_lineage_weakened' };
  }
  const afterSteps = normalizedSteps(afterCase);
  for (const field of requiredFieldsForMerge(beforeCase, target)) {
    if (!fieldPresentInSteps(field, afterSteps)) {
      return { ok: false, reason: 'required_field_removed', field };
    }
  }
  if (oracleStrength(afterCase) < oracleStrength(beforeCase)) {
    return { ok: false, reason: 'oracle_downgraded' };
  }
  const beforeModule = beforeCase.module || beforeCase.moduleName;
  const afterModule = afterCase.module || afterCase.moduleName;
  if (beforeModule && afterModule && beforeModule !== afterModule && !target.allowModuleChange) {
    return { ok: false, reason: 'module_ownership_changed' };
  }
  return { ok: true };
}

function flattenCases(scenarios = []) {
  const rows = [];
  for (const [scenarioIndex, scenario] of (Array.isArray(scenarios) ? scenarios : []).entries()) {
    for (const [caseIndex, caseObj] of (Array.isArray(scenario && scenario.cases) ? scenario.cases : []).entries()) {
      rows.push({ scenarioIndex, caseIndex, scenario, caseObj });
    }
  }
  return rows;
}

function safeMergeScenarios({ baseScenarios = [], repairedScenarios = [], target = {} } = {}) {
  const merged = cloneJson(baseScenarios) || [];
  const baseCases = flattenCases(merged);
  const rejected = [];
  for (const repaired of flattenCases(repairedScenarios)) {
    const afterCase = repaired.caseObj;
    const afterId = afterCase && (afterCase.id || afterCase.caseId);
    const afterRefs = new Set(coverageRefsOf(afterCase));
    const match = baseCases.find((row) => {
      const beforeId = row.caseObj && (row.caseObj.id || row.caseObj.caseId);
      if (afterId && beforeId === afterId) return true;
      return coverageRefsOf(row.caseObj).some((ref) => afterRefs.has(ref) && (target.targetCoverageRefs || []).includes(ref));
    });
    if (!match) {
      const coverageTargeted = (target.family === 'missing_coverage')
        && Array.from(afterRefs).some((ref) => (target.targetCoverageRefs || []).includes(ref));
      if (coverageTargeted) {
        const scenarioId = repaired.scenario && (repaired.scenario.id || repaired.scenario.scenarioId);
        const scenarioName = repaired.scenario && (repaired.scenario.name || repaired.scenario.title);
        let scenarioIndex = merged.findIndex((scenario) => (
          (scenarioId && (scenario.id === scenarioId || scenario.scenarioId === scenarioId))
          || (scenarioName && (scenario.name === scenarioName || scenario.title === scenarioName))
        ));
        if (scenarioIndex < 0) {
          merged.push({
            ...(repaired.scenario || { id: `scenario_${target.family}`, name: 'Repaired coverage scenario' }),
            cases: [],
          });
          scenarioIndex = merged.length - 1;
        }
        merged[scenarioIndex].cases = Array.isArray(merged[scenarioIndex].cases) ? merged[scenarioIndex].cases : [];
        merged[scenarioIndex].cases.push(afterCase);
        continue;
      }
      rejected.push({ caseId: afterId, reason: 'target_case_not_found' });
      continue;
    }
    const guard = safeMergeCase({ beforeCase: match.caseObj, afterCase, target });
    if (!guard.ok) {
      rejected.push({ caseId: afterId, reason: guard.reason, detail: guard });
      continue;
    }
    merged[match.scenarioIndex].cases[match.caseIndex] = afterCase;
  }
  const duplicates = duplicateCaseIntentRows(merged);
  if (duplicates.length) {
    rejected.push({ reason: 'duplicate_or_overlapping_case_intent', duplicates });
  }
  return { ok: rejected.length === 0, scenarios: merged, rejected };
}

function stopReasonForDefects(defects = []) {
  const open = Array.isArray(defects) ? defects.filter((defect) => defect && defect.resolutionStatus !== 'auto_repaired') : [];
  if (!open.length) return REPAIR_STOP_REASON.ALL_CONTRACTS_PASSED;
  if (open.some((defect) => defect.code === 'missing_app_capability' || defect.code === 'stale_app_capability')) return REPAIR_STOP_REASON.MISSING_APP_CAPABILITY;
  if (open.some((defect) => defect.code === 'missing_approved_data' || defect.code === 'proposed_data_mapping')) return REPAIR_STOP_REASON.MISSING_APPROVED_DATA;
  if (open.some((defect) => defect.severity === RELIABILITY_SEVERITY.USER_DECISION_REQUIRED)) return REPAIR_STOP_REASON.MISSING_BUSINESS_DECISION;
  return REPAIR_STOP_REASON.MAX_ROUNDS_REACHED;
}

async function runReliabilityRepairOrchestrator({
  generationId = null,
  scenarios = [],
  defects = [],
  context = {},
  repairers = {},
  validate = null,
  budget = {},
  isCancelled = null,
} = {}) {
  const finalBudget = mergeBudget(budget);
  const startedAt = Date.now();
  const auditEvents = [];
  const repairRounds = [];
  let currentScenarios = cloneJson(scenarios) || [];
  let currentDefects = Array.isArray(defects) ? defects : collectScenarioReliabilityDefects(currentScenarios, context);
  let currentRepairPlan = createRepairTasks({ defects: currentDefects, budget: finalBudget });
  let stopReason = stopReasonForDefects(currentDefects);
  let wallClockMs = 0;
  let toolCallsUsed = 0;
  let tokensUsed = 0;
  let tokenTelemetrySeen = false;
  let skippedRepairsDueToBudget = currentRepairPlan.skippedRepairsDueToBudget;
  const cancelRequested = () => (typeof isCancelled === 'function' ? !!isCancelled() : false);

  if (!currentRepairPlan.tasks.length) {
    return {
      scenarios: currentScenarios,
      defects: currentDefects,
      repairTasks: currentRepairPlan.tasks,
      repairRounds,
      auditEvents,
      repairStopReason: stopReason,
      skippedRepairsDueToBudget,
      wallClockMs,
      toolCallsUsed,
      tokensUsed,
      budget: budgetSnapshot({
        budget: finalBudget,
        wallClockMs,
        toolCallsUsed,
        tokensUsed,
        tokenTelemetrySeen,
        skippedRepairsDueToBudget,
        stopReason,
      }),
      accepted: false,
    };
  }

  while (repairRounds.length < finalBudget.maxFullSuiteRepairRounds) {
    wallClockMs = Date.now() - startedAt;
    if (cancelRequested()) {
      stopReason = REPAIR_STOP_REASON.CANCELLED;
      auditEvents.push(createAuditEvent({
        generationId,
        action: 'repair_cancelled',
        before: { defectSummary: summarizeDefects(currentDefects) },
        after: { stopReason },
      }));
      break;
    }
    if (wallClockMs > finalBudget.maxRepairWallClockMs
      || toolCallsUsed >= finalBudget.maxRepairToolCalls
      || (tokenTelemetrySeen && tokensUsed >= finalBudget.maxRepairTokens)) {
      stopReason = REPAIR_STOP_REASON.BUDGET_EXHAUSTED;
      break;
    }
    currentRepairPlan = createRepairTasks({ defects: currentDefects, budget: finalBudget });
    skippedRepairsDueToBudget += currentRepairPlan.skippedRepairsDueToBudget;
    if (!currentRepairPlan.tasks.length) {
      stopReason = stopReasonForDefects(currentDefects);
      break;
    }
    let acceptedThisCycle = false;
    let attemptedThisCycle = false;
    for (const task of currentRepairPlan.tasks) {
      wallClockMs = Date.now() - startedAt;
      if (cancelRequested()) {
        stopReason = REPAIR_STOP_REASON.CANCELLED;
        auditEvents.push(createAuditEvent({
          generationId,
          action: 'repair_cancelled',
          before: { task },
          after: { stopReason },
        }));
        break;
      }
      if (wallClockMs > finalBudget.maxRepairWallClockMs
        || toolCallsUsed >= finalBudget.maxRepairToolCalls
        || repairRounds.length >= finalBudget.maxFullSuiteRepairRounds
        || (tokenTelemetrySeen && tokensUsed >= finalBudget.maxRepairTokens)) {
        stopReason = REPAIR_STOP_REASON.BUDGET_EXHAUSTED;
        break;
      }
    const repairer = repairers[task.family];
    if (typeof repairer !== 'function') {
      auditEvents.push(createAuditEvent({
        generationId,
        action: 'repair_skipped_no_repairer',
        before: { task },
        after: { stopReason: REPAIR_STOP_REASON.TOOL_FAILURE },
      }));
      continue;
    }
    let repairedScenarios;
    let repairTokensUsed = 0;
    try {
      attemptedThisCycle = true;
      toolCallsUsed += 1;
      const result = await Promise.resolve(repairer({
        scenarios: cloneJson(currentScenarios),
        task,
        defects: currentDefects,
        context,
      }));
      const usage = repairTokenUsage(result);
      repairTokensUsed = usage.tokensUsed;
      tokensUsed += repairTokensUsed;
      tokenTelemetrySeen = tokenTelemetrySeen || usage.reported;
      if (tokenTelemetrySeen && tokensUsed > finalBudget.maxRepairTokens) {
        stopReason = REPAIR_STOP_REASON.BUDGET_EXHAUSTED;
        auditEvents.push(createAuditEvent({
          generationId,
          action: 'repair_budget_exhausted',
          before: { task },
          after: { tokensUsed, maxRepairTokens: finalBudget.maxRepairTokens },
        }));
        break;
      }
      repairedScenarios = result && result.scenarios ? result.scenarios : result;
    } catch (err) {
      const systemDefect = createReliabilityDefect({
        code: 'llm_repair_failed',
        family: 'system',
        message: err && err.message ? err.message : 'Repair function failed.',
        evidence: { family: task.family },
      });
      currentDefects = [...currentDefects, systemDefect];
      stopReason = REPAIR_STOP_REASON.LLM_REPAIR_FAILED;
      auditEvents.push(createAuditEvent({
        generationId,
        action: 'repair_failed',
        before: { task },
        after: { error: systemDefect.message },
      }));
      break;
    }
    const merge = safeMergeScenarios({
      baseScenarios: currentScenarios,
      repairedScenarios,
      target: task,
    });
    if (!merge.ok) {
      const afterDefects = [
        ...currentDefects,
        createReliabilityDefect({
          code: 'repair_introduced_regression',
          severity: RELIABILITY_SEVERITY.CRITICAL,
          family: 'repair_merge',
          message: 'Repair output failed safe-merge checks.',
          evidence: { rejected: merge.rejected },
        }),
      ];
      repairRounds.push(createRepairRound({
        generationId,
        roundNumber: repairRounds.length + 1,
        family: task.family,
        targetCaseIds: task.targetCaseIds,
        targetCoverageRefs: task.targetCoverageRefs,
        defectsBefore: currentDefects,
        defectsAfter: afterDefects,
        accepted: false,
        rejectionReason: 'safe_merge_rejected',
        tokensUsed: repairTokensUsed,
        wallClockMs: Date.now() - startedAt,
        toolCallsUsed,
      }));
      currentDefects = afterDefects;
      stopReason = REPAIR_STOP_REASON.TOOL_FAILURE;
      auditEvents.push(createAuditEvent({
        generationId,
        action: 'repair_rejected_safe_merge',
        before: { task },
        after: { rejected: merge.rejected },
      }));
      break;
    }
    const afterDefects = typeof validate === 'function'
      ? await Promise.resolve(validate(merge.scenarios, context))
      : collectScenarioReliabilityDefects(merge.scenarios, context);
    const comparison = compareDefects({
      beforeDefects: currentDefects,
      afterDefects,
      targetDefects: task.defects,
    });
    repairRounds.push(createRepairRound({
      generationId,
      roundNumber: repairRounds.length + 1,
      family: task.family,
      targetCaseIds: task.targetCaseIds,
      targetCoverageRefs: task.targetCoverageRefs,
      defectsBefore: currentDefects,
      defectsAfter: afterDefects,
      accepted: comparison.accepted,
      rejectionReason: comparison.accepted ? undefined : (
        sameTargetDefectsRepeated({ beforeDefects: currentDefects, afterDefects, targetDefects: task.defects })
          ? REPAIR_STOP_REASON.SAME_DEFECT_REPEATED
          : 'defect_regression_guard_rejected'
      ),
      tokensUsed: repairTokensUsed,
      wallClockMs: Date.now() - startedAt,
      toolCallsUsed,
    }));
    auditEvents.push(createAuditEvent({
      generationId,
      action: comparison.accepted ? 'repair_accepted' : 'repair_rejected_regression_guard',
      before: { task, defectSummary: summarizeDefects(currentDefects) },
      after: { comparison, defectSummary: summarizeDefects(afterDefects) },
    }));
    if (comparison.accepted) {
      currentScenarios = merge.scenarios;
      currentDefects = afterDefects;
      stopReason = stopReasonForDefects(currentDefects);
      acceptedThisCycle = true;
      break;
    } else if (sameTargetDefectsRepeated({ beforeDefects: currentDefects, afterDefects, targetDefects: task.defects })) {
      stopReason = REPAIR_STOP_REASON.SAME_DEFECT_REPEATED;
      break;
    }
    }
    if (stopReason === REPAIR_STOP_REASON.BUDGET_EXHAUSTED
      || stopReason === REPAIR_STOP_REASON.SAME_DEFECT_REPEATED
      || stopReason === REPAIR_STOP_REASON.LLM_REPAIR_FAILED
      || stopReason === REPAIR_STOP_REASON.TOOL_FAILURE
      || stopReason === REPAIR_STOP_REASON.CANCELLED) {
      break;
    }
    if (acceptedThisCycle) continue;
    if (!attemptedThisCycle) {
      stopReason = stopReasonForDefects(currentDefects);
      break;
    }
    stopReason = stopReasonForDefects(currentDefects);
    break;
  }

  if (repairRounds.length >= finalBudget.maxFullSuiteRepairRounds && stopReasonForDefects(currentDefects) !== REPAIR_STOP_REASON.ALL_CONTRACTS_PASSED) {
    stopReason = REPAIR_STOP_REASON.MAX_ROUNDS_REACHED;
  }

  wallClockMs = Date.now() - startedAt;
  const finalRepairPlan = createRepairTasks({ defects: currentDefects, budget: finalBudget });
  return {
    scenarios: currentScenarios,
    defects: currentDefects,
    repairTasks: finalRepairPlan.tasks,
    repairRounds,
    auditEvents,
    repairStopReason: stopReason,
    skippedRepairsDueToBudget,
    wallClockMs,
    toolCallsUsed,
    tokensUsed,
    budget: budgetSnapshot({
      budget: finalBudget,
      wallClockMs,
      toolCallsUsed,
      tokensUsed,
      tokenTelemetrySeen,
      skippedRepairsDueToBudget,
      stopReason,
    }),
    cancelled: stopReason === REPAIR_STOP_REASON.CANCELLED,
    accepted: repairRounds.some((round) => round.accepted),
  };
}

module.exports = {
  DEFAULT_REPAIR_BUDGET,
  REPAIR_FAMILY_BY_CODE,
  groupDefectsByRepairFamily,
  createRepairTasks,
  createRepairRound,
  createAuditEvent,
  compareDefects,
  sameTargetDefectsRepeated,
  safeMergeCase,
  safeMergeScenarios,
  stopReasonForDefects,
  runReliabilityRepairOrchestrator,
};
