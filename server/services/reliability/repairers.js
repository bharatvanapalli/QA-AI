'use strict';

const {
  CONTRACT_VERSION,
  SCHEMA_VERSION,
  normalizeStepsInput,
  requiredFieldsFromContext,
  fieldPresentInSteps,
} = require('./contracts');
const {
  canonicalizeSemanticToken,
  canonicalizeTokenExpression,
} = require('./semanticFieldMapper');

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value == null ? '' : value).trim();
}

function norm(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSteps(caseObj = {}) {
  const result = normalizeStepsInput(caseObj.steps, { allowSingletonObject: false });
  return result.ok ? result.steps : [];
}

function coverageRefsOf(caseObj = {}) {
  return asArray(caseObj.coverageRefs || caseObj.requirementRefs).filter(Boolean);
}

function caseMatchesTask(caseObj = {}, task = {}) {
  const caseId = caseObj.id || caseObj.caseId;
  if (asArray(task.targetCaseIds).includes(caseId)) return true;
  const refs = new Set(coverageRefsOf(caseObj));
  return asArray(task.targetCoverageRefs).some((ref) => refs.has(ref));
}

function mapTargetCases(scenarios = [], task = {}, mapper = (caseObj) => caseObj) {
  const next = cloneJson(scenarios) || [];
  for (const scenario of next) {
    const cases = asArray(scenario && scenario.cases);
    scenario.cases = cases.map((caseObj) => (caseMatchesTask(caseObj, task) ? mapper(caseObj, scenario) : caseObj));
  }
  return next;
}

function tokenForField(field) {
  return canonicalizeSemanticToken(field, { purpose: 'business search field' }) || norm(field) || 'value';
}

function labelForField(field) {
  const key = norm(field);
  const map = {
    username: 'Username filter',
    role: 'User Role filter',
    userrole: 'User Role filter',
    employeename: 'Employee Name filter',
    status: 'Status filter',
    event: 'Event field',
    currency: 'Currency field',
    amount: 'Amount field',
    remarks: 'Remarks field',
    remark: 'Remarks field',
    employeeid: 'Employee Id field',
  };
  return map[key] || `${clean(field)} field`;
}

function actionForField(field) {
  const key = norm(field);
  if (['role', 'userrole', 'status', 'event', 'currency'].includes(key)) return 'Select';
  return 'Fill';
}

function stepForField(field, coverageRefs = []) {
  const token = tokenForField(field);
  return {
    id: `repair_step_${token}`,
    action: actionForField(field),
    target: labelForField(field),
    value: `{{${token}}}`,
    coverageRefs,
    source: 'repair',
  };
}

function addColumnMapping(caseObj, field) {
  const token = tokenForField(field);
  if (!caseObj.dataBinding || typeof caseObj.dataBinding !== 'object') return;
  caseObj.dataBinding.columnToField = {
    ...(caseObj.dataBinding.columnToField && typeof caseObj.dataBinding.columnToField === 'object'
      ? caseObj.dataBinding.columnToField
      : {}),
  };
  if (!caseObj.dataBinding.columnToField[token]) {
    caseObj.dataBinding.columnToField[token] = clean(field) || token;
  }
}

function insertBeforeFinalOracle(steps, newSteps) {
  const finalIndex = steps.length > 0 ? steps.length - 1 : 0;
  const final = steps[finalIndex];
  const finalLooksLikeOracle = final && /verify|assert/i.test(clean(final.action));
  if (!finalLooksLikeOracle) return [...steps, ...newSteps];
  return [...steps.slice(0, finalIndex), ...newSteps, ...steps.slice(finalIndex)];
}

function requiredFieldsForTask(caseObj = {}, scenario = {}, task = {}, context = {}) {
  const fields = new Set(requiredFieldsFromContext(caseObj, scenario, context));
  for (const defect of asArray(task.defects)) {
    const field = defect && defect.evidence && defect.evidence.field;
    if (field) fields.add(field);
  }
  return Array.from(fields).filter(Boolean);
}

function buildRowIdsFromBinding(binding = {}) {
  const rows = asArray(binding.rowIds || binding.resolvedRowIds || binding.selectedRowIds || binding.rows || binding.resolvedRows);
  return rows.map((row, index) => {
    if (row && typeof row === 'object') return clean(row.id || row.rowId || row.key || row.index || row.rowIndex || index + 1);
    return clean(row || index + 1);
  }).filter(Boolean);
}

function repairMissingRowCoverage({ scenarios, task }) {
  return {
    scenarios: mapTargetCases(scenarios, task, (caseObj) => {
      const next = { ...caseObj };
      const binding = next.dataBinding && typeof next.dataBinding === 'object' ? next.dataBinding : null;
      if (!binding || !binding.sheet) return next;
      const existing = next.rowExecutionPlan && typeof next.rowExecutionPlan === 'object' ? next.rowExecutionPlan : {};
      const rowIds = asArray(existing.rowIds).length ? existing.rowIds : buildRowIdsFromBinding(binding);
      next.rowExecutionPlan = {
        schemaVersion: SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        caseId: next.id || next.caseId || '',
        dataBindingId: binding.id || binding.mappingId || undefined,
        rowIds,
        executionMode: existing.executionMode || binding.executionMode || (rowIds.length > 1 ? 'per_row' : 'single'),
        skippedRows: asArray(existing.skippedRows || binding.skippedRows),
        skipReasons: {
          ...(existing.skipReasons && typeof existing.skipReasons === 'object' ? existing.skipReasons : {}),
          ...(binding.skipReasons && typeof binding.skipReasons === 'object' ? binding.skipReasons : {}),
        },
      };
      for (const skipped of next.rowExecutionPlan.skippedRows) {
        if (!next.rowExecutionPlan.skipReasons[skipped]) {
          next.rowExecutionPlan.skipReasons[skipped] = 'Explicitly preserved skip reason added by reliability repair.';
        }
      }
      return next;
    }),
  };
}

function repairMissingDataLineage({ scenarios, task }) {
  return {
    scenarios: mapTargetCases(scenarios, task, (caseObj) => {
      const next = { ...caseObj };
      const steps = normalizeSteps(next);
      for (const defect of asArray(task.defects)) {
        const token = defect && defect.evidence && defect.evidence.token;
        if (token) addColumnMapping(next, token);
      }
      for (const step of steps) {
        const value = step && (step.value ?? step.text ?? step.input ?? '');
        const matches = String(value || '').match(/\{\{\s*([^}]+?)\s*\}\}/g) || [];
        for (const match of matches) addColumnMapping(next, match.replace(/[{}]/g, '').trim());
      }
      return next;
    }),
  };
}

function replaceToken(value, target, replacement) {
  if (typeof value !== 'string') return value;
  const pattern = new RegExp(`\\{\\{\\s*${target}\\s*\\}\\}`, 'ig');
  return value.replace(pattern, `{{${replacement}}}`);
}

function repairTokenCollision({ scenarios, task }) {
  return {
    scenarios: mapTargetCases(scenarios, task, (caseObj) => {
      const next = { ...caseObj };
      const steps = normalizeSteps(next).map((step) => {
        const copy = { ...step };
        const target = clean(copy.target || copy.element || '').toLowerCase();
        const loginContext = target.includes('login') || (target.includes('username') && !target.includes('search') && !target.includes('filter'));
        if (!loginContext) {
          copy.value = replaceToken(copy.value, 'username', 'usernamefilter');
          copy.value = replaceToken(copy.value, 'loginusername', 'usernamefilter');
          copy.value = replaceToken(copy.value, 'password', 'passwordfilter');
          copy.value = replaceToken(copy.value, 'loginpassword', 'passwordfilter');
          copy.value = canonicalizeTokenExpression(copy.value, { purpose: 'business search field' });
        } else {
          copy.value = canonicalizeTokenExpression(copy.value, { purpose: 'auth field', authContext: true });
        }
        return copy;
      });
      next.steps = steps;
      addColumnMapping(next, 'usernamefilter');
      addColumnMapping(next, 'passwordfilter');
      return next;
    }),
  };
}

function oracleForCase(caseObj = {}, task = {}) {
  const text = `${caseObj.name || ''} ${caseObj.caseIntent || ''} ${caseObj.module || ''} ${asArray(caseObj.coverageRefs).join(' ')}`.toLowerCase();
  if (text.includes('claim')) {
    return { kind: 'validation_message', target: 'Claim required fields', expected: 'Required', source: 'repair', required: true };
  }
  if (text.includes('admin') || text.includes('system user')) {
    return { kind: 'table_row', target: 'System Users results table', expected: 'matching user row', source: 'repair', required: true };
  }
  if (text.includes('pim') || text.includes('employee')) {
    return { kind: 'text', target: 'Personal Details page', expected: 'Personal Details', source: 'repair', required: true };
  }
  const field = asArray(task.defects).map((defect) => defect && defect.evidence && defect.evidence.field).filter(Boolean)[0];
  if (field) {
    return { kind: 'state_change', target: `${field} outcome`, expected: true, source: 'repair', required: true };
  }
  return { kind: 'state_change', target: 'Business outcome', expected: true, source: 'repair', required: true };
}

function repairWeakOracle({ scenarios, task }) {
  return {
    scenarios: mapTargetCases(scenarios, task, (caseObj) => {
      const next = { ...caseObj };
      const oracle = oracleForCase(next, task);
      next.oracles = [oracle, ...asArray(next.oracles).filter((item) => norm(item && item.target) !== norm(oracle.target))];
      const steps = normalizeSteps(next);
      if (steps.length) {
        const last = { ...steps[steps.length - 1] };
        last.verify = { kind: oracle.kind === 'validation_message' ? 'validation_message' : 'text', target: oracle.target, expected: oracle.expected };
        last.expected = oracle.expected;
        steps[steps.length - 1] = last;
        next.steps = steps;
      }
      return next;
    }),
  };
}

function repairMissingRequiredField({ scenarios, task, context = {} }) {
  return {
    scenarios: mapTargetCases(scenarios, task, (caseObj, scenario) => {
      const next = { ...caseObj };
      let steps = normalizeSteps(next);
      const refs = coverageRefsOf(next);
      const additions = [];
      for (const field of requiredFieldsForTask(next, scenario, task, context)) {
        if (fieldPresentInSteps(field, steps)) continue;
        additions.push(stepForField(field, refs));
        addColumnMapping(next, field);
      }
      if (additions.length) {
        steps = insertBeforeFinalOracle(steps, additions);
        next.steps = steps;
      }
      return next;
    }),
  };
}

function itemForCoverageRef(context = {}, coverageRef) {
  return asArray(context.coverageManifest && context.coverageManifest.items)
    .find((item) => [item.manifestItemId, item.coverageRef, item.id, item.coverageItemId].filter(Boolean).includes(coverageRef));
}

function repairMissingCoverage({ scenarios, task, context = {} }) {
  const next = cloneJson(scenarios) || [];
  const existingRefs = new Set(next.flatMap((scenario) => asArray(scenario.cases).flatMap(coverageRefsOf)));
  const additions = [];
  for (const ref of asArray(task.targetCoverageRefs)) {
    if (!ref || existingRefs.has(ref)) continue;
    const item = itemForCoverageRef(context, ref) || {};
    const fields = asArray(item.requiredFields);
    const coverageRefs = [ref];
    const steps = fields.map((field) => stepForField(field, coverageRefs));
    steps.push({
      id: `repair_step_verify_${norm(ref)}`,
      action: 'Verify',
      target: item.title || 'Business outcome',
      expected: 'Expected business outcome',
      verify: { kind: 'text', target: item.title || 'Business outcome', expected: 'Expected business outcome' },
      coverageRefs,
      source: 'repair',
    });
    additions.push({
      id: `repair_case_${norm(ref)}`,
      name: item.title || `Generated coverage for ${ref}`,
      module: item.module || item.storyRef?.moduleHint || undefined,
      caseIntent: `cover_${norm(ref)}`,
      coverageRefs,
      requirementRefs: item.storyId ? [item.storyId] : coverageRefs,
      requiredFields: fields,
      steps,
      oracles: [{
        schemaVersion: SCHEMA_VERSION,
        contractVersion: CONTRACT_VERSION,
        kind: fields.length ? 'state_change' : 'text',
        target: item.title || 'Business outcome',
        expected: 'Expected business outcome',
        source: 'repair',
        required: true,
      }],
    });
  }
  if (!additions.length) return { scenarios: next };
  const scenario = next[0] || { id: 'repair_scenario_missing_coverage', name: 'Missing Coverage Repairs', cases: [] };
  scenario.cases = [...asArray(scenario.cases), ...additions];
  if (!next.length) next.push(scenario);
  else next[0] = scenario;
  return { scenarios: next };
}

function repairUnregisteredBrowserAction({ scenarios, task }) {
  const aliases = {
    tap: 'Click',
    press: 'Click',
    input: 'Fill',
    type: 'Fill',
    choose: 'Select',
    pick: 'Select',
    assert: 'Verify',
    verifytext: 'Verify',
    wait: 'Wait',
  };
  return {
    scenarios: mapTargetCases(scenarios, task, (caseObj) => {
      const next = { ...caseObj };
      next.steps = normalizeSteps(next).map((step) => {
        const raw = norm(step && step.action);
        if (!raw || !aliases[raw]) return step;
        return { ...step, action: aliases[raw] };
      });
      return next;
    }),
  };
}

const defaultReliabilityRepairers = Object.freeze({
  missing_row_coverage: repairMissingRowCoverage,
  missing_data_lineage: repairMissingDataLineage,
  token_collision: repairTokenCollision,
  weak_oracle: repairWeakOracle,
  missing_required_field: repairMissingRequiredField,
  missing_coverage: repairMissingCoverage,
  unregistered_browser_action: repairUnregisteredBrowserAction,
});

module.exports = {
  defaultReliabilityRepairers,
  repairMissingRowCoverage,
  repairMissingDataLineage,
  repairTokenCollision,
  repairWeakOracle,
  repairMissingRequiredField,
  repairMissingCoverage,
  repairUnregisteredBrowserAction,
};
