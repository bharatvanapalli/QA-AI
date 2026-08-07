'use strict';

/**
 * GenerationCompiler — the READY-ONLY gate for scenario generation.
 *
 * ARCHITECTURE CHANGE (not another warning). The old pipeline was:
 *   Architect generates → Node annotates/repairs a little → PERSIST → later the
 *   CaseCompiler classifies ready/needs_review/blocked.
 * So an imperfect suite still became the CURRENT generation, and "needs_review" was a
 * post-hoc label, not a bar. This module inverts that:
 *   Architect generates → coverage repair → COMPILE + DETERMINISTICALLY REPAIR every
 *   contract-backed case → persist the repaired ready suite as current. A candidate
 *   with no usable source contract (no story/coverage/data binding and unresolved
 *   tokens) is an impossible intermediate artifact and is withheld from persistence;
 *   it is not shown to the user as a not-ready test.
 *
 * It runs BEFORE the persist transaction (server/routes/scenarios.js), is PURE (no DB,
 * no LLM, no IO), and reuses the existing contract layer (WorkbookContract, CaseCompiler,
 * OracleContract) — it does not fork any parser. Generic across any site/workbook.
 *
 * The repair rules target the exact readiness noise the audits surfaced (advisory
 * placeholder warnings that were mechanically minting needs_review), and CLASSIFY each
 * case so a legitimate product-gap / static / execution-profile case is `ready`, not a
 * perpetual review state:
 *
 *   • static (no row consumption): a case that uses NO {{tokens}} and reads no per-row
 *     value is NOT data-driven — clear its data binding (a control-presence / navigation
 *     check must not be bound to a row matrix just because a storyId matched a sheet).
 *   • product-gap: a "control absent / presence check" bound to a *_MissingFeature_Bugs
 *     sheet is a real, intentional test with an absence oracle — clear the row-matrix
 *     advisories; it is ready.
 *   • data-driven, UNIFORM expected outcome: not tokenizing {{expected}} is fine (a fixed
 *     oracle covers every row) — the data_expected_placeholder_missing advisory is not a
 *     defect; clear it.
 *   • data-driven, VARYING expected outcome: the case MUST consume {{expected}} (or a
 *     row-selector that narrows to one outcome), else it would assert the same thing for
 *     rows that expect different results — synthesize the missing {{expected}} row
 *     oracle from the WorkbookContract instead of surfacing a not-ready case.
 *   • deterministic companion credentials: a single exact-mapped companion auth sheet is
 *     runnable as-is → ready (not needs_review).
 */

const { placeholdersInCase } = require('./testDataAuthoring');
const { classifyRowOutcomeClass } = require('./testDataMatrix');
const { buildWorkbookContract, buildCoverageItems } = require('./workbookContract');
const { normalizeStoryId } = require('../lib/storyId');
const caseCompiler = require('./caseCompiler');
const declaredAssertionsLib = require('../lib/declaredAssertions');
const scenarioQualityContract = require('./scenarioQualityContract');
const testDataBindingContract = require('./testDataBindingContract');
const { tokenSet: proceduralTokenSet } = require('./proceduralFlowContract');
const caseContractV1 = require('./caseContractV1');
const inlineCaseInstanceContract = require('./inlineCaseInstanceContract');

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');

const CASE_CLASS = Object.freeze({ DATA_DRIVEN: 'data-driven', STATIC: 'static', PRODUCT_GAP: 'product-gap', EXECUTION_PROFILE: 'execution-profile' });

// Advisory binding findings that are AUTHORING-QUALITY nags, not defects — the compiler
// clears them once it has deterministically decided they don't apply (uniform oracle /
// static case / product-gap). They must never, by themselves, mint a needs_review.
const CLEARABLE_ADVISORIES = new Set(['data_expected_placeholder_missing', 'data_input_placeholders_missing', 'data_literal_from_uploaded_sheet']);

function _parseArr(v) { if (Array.isArray(v)) return v; try { const j = JSON.parse(v || '[]'); return Array.isArray(j) ? j : []; } catch { return []; } }

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTokensInString(value, tokenMap) {
  let out = String(value);
  for (const [token, replacement] of Object.entries(tokenMap || {})) {
    const re = new RegExp(`\\{\\{\\s*${escapeRegExp(token)}\\s*\\}\\}`, 'gi');
    out = out.replace(re, String(replacement));
  }
  return out;
}

function replaceTokensDeep(value, tokenMap) {
  if (typeof value === 'string') return replaceTokensInString(value, tokenMap);
  if (Array.isArray(value)) return value.map((item) => replaceTokensDeep(item, tokenMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = replaceTokensDeep(val, tokenMap);
    return out;
  }
  return value;
}

function replaceRawBindingsInString(value, rawBindings) {
  let out = String(value == null ? '' : value);
  const replacements = [];
  for (const [token, values] of (rawBindings instanceof Map ? rawBindings.entries() : [])) {
    for (const rawValue of (Array.isArray(values) ? values : [])) {
      if (rawValue == null || String(rawValue).length < 2) continue;
      replacements.push({ token, rawValue: String(rawValue) });
    }
  }
  replacements.sort((a, b) => b.rawValue.length - a.rawValue.length);
  for (const { token, rawValue } of replacements) {
    out = out.replace(new RegExp(escapeRegExp(rawValue), 'gi'), `{{${token}}}`);
  }
  return out;
}

function replaceRawBindingsDeep(value, rawBindings) {
  if (typeof value === 'string') return replaceRawBindingsInString(value, rawBindings);
  if (Array.isArray(value)) return value.map((item) => replaceRawBindingsDeep(item, rawBindings));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = replaceRawBindingsDeep(val, rawBindings);
    return out;
  }
  return value;
}

function parseTestDataMapping(testData) {
  if (!testData || typeof testData !== 'object') return null;
  let mapping = testData.mapping;
  if (typeof mapping === 'string') {
    try { mapping = JSON.parse(mapping); } catch (_) { mapping = null; }
  }
  if (!mapping && testData.sheets && !Array.isArray(testData.sheets)) mapping = testData.sheets.mapping;
  return mapping && typeof mapping === 'object' ? mapping : null;
}

/**
 * Inline text is not an uploaded data binding.  Only preserve the historical
 * CaseContract tokenisation path when this exact case has selected a real
 * mapped workbook sheet. An unrelated sheet elsewhere in the project is not
 * evidence that inline procedural values should become row placeholders.
 */
function hasSelectedWorkbookBinding(caseObj, testData, workbookContract = null) {
  const binding = caseObj && caseObj.dataBinding && typeof caseObj.dataBinding === 'object'
    ? caseObj.dataBinding
    : null;
  const caseScope = inlineCaseInstanceContract.caseScopeId(caseObj || {});
  const bindingScope = inlineCaseInstanceContract.caseScopeId(binding || {});
  if (!caseScope || !bindingScope || caseScope !== bindingScope) return false;
  const wantedSheet = norm(binding && binding.sheet);
  const wantedSheetId = String(binding && binding.sheetId || '').trim();
  const wantedMappingId = String(binding && binding.mappingId || '').trim();
  const wantedDatasetId = String(binding && (binding.testDataSetId || binding.datasetId) || '').trim();
  if (!wantedSheet && !wantedSheetId) return false;

  const mapping = parseTestDataMapping(testData);
  const bindings = Array.isArray(mapping && mapping.bindings) ? mapping.bindings : [];
  const mappingCandidates = bindings.filter((entry) => {
    if (!entry) return false;
    const entryScope = inlineCaseInstanceContract.caseScopeId(entry);
    // A mapping that explicitly belongs to another authored case cannot
    // authorize token generation for this case, even when both cases use the
    // same workbook sheet. Legacy mappings without a case scope remain valid;
    // the selected case-local dataBinding still supplies their ownership.
    if (entryScope && entryScope !== caseScope) return false;
    if (wantedMappingId && String(entry.mappingId || '').trim() !== wantedMappingId) return false;
    if (wantedSheetId) {
      if (String(entry.sheetId || '').trim() !== wantedSheetId) return false;
    } else if (norm(entry.sheet) !== wantedSheet) return false;
    const entryDatasetId = String(entry.testDataSetId || entry.datasetId || '').trim();
    return !wantedDatasetId || !entryDatasetId || entryDatasetId === wantedDatasetId;
  });
  // Never first-pick one of several name-equivalent mappings. The selected
  // case must identify one mapping deterministically before inline literals
  // are converted into workbook tokens.
  if (mappingCandidates.length !== 1) return false;
  const mapped = mappingCandidates[0];
  const columnMaps = [mapped.columnToField]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const usableColumnMap = columnMaps.find((value) => Object.entries(value)
    .some(([column, field]) => String(column || '').trim() && String(field || '').trim()));
  if (!usableColumnMap) return false;
  const mappedHeaders = new Set(Object.values(usableColumnMap).map(norm).filter(Boolean));

  const sheets = Array.isArray(testData && testData.sheets)
    ? testData.sheets
    : (testData && testData.sheets && Array.isArray(testData.sheets.sheets) ? testData.sheets.sheets : []);
  const sheetCandidates = sheets.filter((sheet) => {
    if (!sheet) return false;
    if (wantedSheetId) {
      if (String(sheet.sheetId || '').trim() !== wantedSheetId) return false;
    } else if (norm(sheet.name) !== wantedSheet) return false;
    const sheetDatasetId = String(sheet.testDataSetId || sheet.datasetId || '').trim();
    return !wantedDatasetId || !sheetDatasetId || sheetDatasetId === wantedDatasetId;
  });
  if (sheetCandidates.length !== 1) return false;
  const sheet = sheetCandidates[0];
  const rawSheetHasMappedValue = Array.isArray(sheet.rows) && sheet.rows.some((row) => (
    row && typeof row === 'object' && !Array.isArray(row)
    && Object.entries(row).some(([column, value]) => mappedHeaders.has(norm(column))
      && value != null && String(value).trim().length > 0)
  ));
  if (!rawSheetHasMappedValue) return false;

  // The persisted mapping and raw sheet are necessary but not sufficient.
  // Token generation is allowed only when the canonical WorkbookContract also
  // proves that this exact sheet has headers and at least one usable data row.
  const contractSheets = Array.isArray(workbookContract && workbookContract.sheets)
    ? workbookContract.sheets.filter((entry) => entry && norm(entry.name) === norm(sheet.name))
    : [];
  if (contractSheets.length !== 1) return false;
  const contractSheet = contractSheets[0];
  if (contractSheet.mappingEligible !== true || Number(contractSheet.usableRowCount || 0) < 1) return false;
  const contractHeaders = new Set((Array.isArray(contractSheet.headers) ? contractSheet.headers : []).map(norm).filter(Boolean));
  if (!mappedHeaders.size || [...mappedHeaders].some((header) => !contractHeaders.has(header))) return false;
  return true;
}

function inlineLiteralTokenValues(definitions, rawBindings) {
  const values = {};
  for (const entry of (Array.isArray(definitions) ? definitions : [])) {
    if (!entry || !entry.name) continue;
    if (entry.source && entry.source.kind === 'inline' && entry.source.value != null) {
      values[entry.name] = entry.source.value;
      continue;
    }
    const authoredValues = rawBindings instanceof Map && Array.isArray(rawBindings.get(entry.name))
      ? rawBindings.get(entry.name).filter((value) => value != null && String(value).length > 0)
      : [];
    if (authoredValues.length) {
      // rawBindings is already scoped to the selected CaseContract id. Never
      // index a global/deduplicated value list by case ordinal.
      values[entry.name] = authoredValues[0];
    }
  }
  return values;
}

function explicitInlineTokenValues(definitions) {
  const values = {};
  for (const entry of (Array.isArray(definitions) ? definitions : [])) {
    if (!entry || !entry.name || !entry.source || entry.source.kind !== 'inline' || entry.source.value == null) continue;
    values[entry.name] = entry.source.value;
  }
  return values;
}

/**
 * Shared value-precedence lowering for every text-entry surface. CaseContract
 * extraction remains case-scoped; this helper only decides which authored
 * source wins when the same key appears in more than one source.
 */
function resolveInlinePipelineValues(definitions, rawBindings, options = {}) {
  const extractedValues = inlineLiteralTokenValues(definitions, rawBindings);
  const surface = String(options.inlineSourceSurface || '').trim().toLowerCase();
  const fromPastedText = surface === 'add_scenario' ? extractedValues : {};
  const fromUploadedText = surface === 'add_scenario' ? {} : extractedValues;
  return inlineCaseInstanceContract.resolveInlineValueSources({
    narrativeValues: options.narrativeValues || {},
    uploadedTextValues: fromUploadedText,
    pastedTextValues: fromPastedText,
    inlineDataValues: explicitInlineTokenValues(definitions),
    surface: surface || null,
  });
}

function inlineAuthorityEntries(definitions, tokenValues) {
  return (Array.isArray(definitions) ? definitions : [])
    .filter((entry) => entry && entry.name && Object.prototype.hasOwnProperty.call(tokenValues, entry.name))
    .map((entry) => ({
      id: entry.id || `data.${entry.name}`,
      name: entry.name,
      label: String(entry.label || entry.name).trim(),
      value: tokenValues[entry.name],
    }))
    .filter((entry) => entry.label && entry.value != null);
}

function flexibleLabelPattern(label) {
  return String(label || '').trim().split(/\s+/).map(escapeRegExp).join('\\s+');
}

function replaceLabeledInlineValue(value, entry) {
  let out = String(value == null ? '' : value);
  const labelPattern = flexibleLabelPattern(entry.label);
  if (!labelPattern || !norm(out).includes(norm(entry.label))) return out;
  const replacement = String(entry.value);
  if (/^-?\d+(?:\.\d+)?$/.test(replacement.trim())) {
    const numeric = new RegExp(`(${labelPattern}[^\\d\\r\\n]{0,100}?)-?\\d+(?:\\.\\d+)?`, 'gi');
    return out.replace(numeric, `$1${replacement}`);
  }
  const assigned = new RegExp(`(${labelPattern}\\s*(?:=|:|\\bis\\b|\\bshows?\\b|\\bequals?\\b|\\bcontains?\\b)\\s*)(?:"[^"]*"|'[^']*'|[^,;\\r\\n]+)`, 'gi');
  return out.replace(assigned, `$1${replacement}`);
}

function entryRefs(entries, refs) {
  const wanted = new Set((Array.isArray(refs) ? refs : []).map(String));
  return entries.filter((entry) => wanted.has(entry.id) || wanted.has(entry.name) || wanted.has(`data.${entry.name}`));
}

function materializeInlineAuthority(value, entries, inheritedEntries = []) {
  if (typeof value === 'string') {
    return entries.reduce((text, entry) => replaceLabeledInlineValue(text, entry), value);
  }
  if (Array.isArray(value)) return value.map((item) => materializeInlineAuthority(item, entries, inheritedEntries));
  if (!value || typeof value !== 'object') return value;

  const contextKeys = /^(?:element|target|field|label|control|metric|tab|column|heading)$/i;
  const contextText = Object.entries(value)
    .filter(([key, item]) => contextKeys.test(key) && (typeof item === 'string' || typeof item === 'number'))
    .map(([, item]) => String(item))
    .join(' ');
  const localEntries = contextText
    ? entries.filter((entry) => norm(contextText).includes(norm(entry.label)))
    : [];
  const activeEntries = localEntries.length ? localEntries : inheritedEntries;
  const directValueKey = /^(?:value|inputValue|selectedValue|expectedValue|expectedCount|count)$/i;
  const expectedKey = /^expected$/i;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (activeEntries.length === 1 && directValueKey.test(key) && (typeof item === 'string' || typeof item === 'number')) {
      out[key] = String(activeEntries[0].value);
      continue;
    }
    if (activeEntries.length === 1 && expectedKey.test(key) && (typeof item === 'string' || typeof item === 'number')) {
      const text = String(item).trim();
      const reconciled = replaceLabeledInlineValue(text, activeEntries[0]);
      const mentionsLabel = norm(text).includes(norm(activeEntries[0].label));
      const looksLikeScalar = !mentionsLabel
        && !/[.!?;,]/.test(text)
        && !/\b(?:visible|displayed|shown|contains?|equals?|matches?|selected|enabled|disabled)\b/i.test(text);
      out[key] = looksLikeScalar ? String(activeEntries[0].value) : reconciled;
      continue;
    }
    out[key] = materializeInlineAuthority(item, entries, activeEntries);
  }
  return out;
}

function materializeInlineCase(caseObj, selected, definitions, tokenValues) {
  const materialized = replaceTokensDeep(caseObj, tokenValues);
  const entries = inlineAuthorityEntries(definitions, tokenValues);
  if (!entries.length) return materialized;

  for (const key of ['name', 'assertions', 'operations']) {
    if (Object.prototype.hasOwnProperty.call(materialized, key)) {
      materialized[key] = materializeInlineAuthority(materialized[key], entries);
    }
  }
  if (Array.isArray(materialized.steps)) {
    const contractSteps = Array.isArray(selected && selected.steps) ? selected.steps : [];
    materialized.steps = materialized.steps.map((step, index) => {
      const scopedEntries = entryRefs(entries, contractSteps[index] && contractSteps[index].dataRefs);
      // CaseContractV1's dataRefs are the authority for replacing a generated
      // step value. Re-inferring from the target label would overwrite an
      // explicitly authored negative such as "not-an-email".
      return materializeInlineAuthority(step, scopedEntries, scopedEntries);
    });
  }
  if (Array.isArray(materialized.declaredAssertions)) {
    const contractAssertions = Array.isArray(selected && selected.assertions) ? selected.assertions : [];
    materialized.declaredAssertions = materialized.declaredAssertions.map((assertion, index) => {
      const scopedEntries = entryRefs(entries, contractAssertions[index] && contractAssertions[index].dataRefs);
      return materializeInlineAuthority(assertion, scopedEntries, scopedEntries);
    });
  } else if (materialized.declaredAssertions != null) {
    materialized.declaredAssertions = materializeInlineAuthority(materialized.declaredAssertions, entries);
  }
  return materialized;
}

function refsInValue(value, definitions) {
  const text = JSON.stringify(value == null ? '' : value);
  return (Array.isArray(definitions) ? definitions : [])
    .filter((entry) => entry && entry.name && new RegExp(`\\{\\{\\s*${escapeRegExp(entry.name)}\\s*\\}\\}`, 'i').test(text))
    .map((entry) => entry.id || `data.${entry.name}`);
}

function annotateStepDataRefs(steps, definitions) {
  return (Array.isArray(steps) ? steps : []).map((step) => {
    if (!step || typeof step !== 'object') return step;
    const refs = [...new Set([
      ...(Array.isArray(step.dataRefs) ? step.dataRefs : []),
      ...refsInValue(step, definitions),
    ])];
    return refs.length ? { ...step, dataRefs: refs, ...(refs.length === 1 ? { dataRef: refs[0] } : {}) } : step;
  });
}

function preserveAuthoredStepIdentities(steps, contractSteps) {
  const authored = Array.isArray(steps) ? steps : [];
  const contract = Array.isArray(contractSteps) ? contractSteps : [];
  const aligned = authored.length > 0 && authored.length === contract.length;
  return authored.map((step, index) => {
    if (!step || typeof step !== 'object') return step;
    const contractStep = aligned && contract[index] && typeof contract[index] === 'object' ? contract[index] : null;
    const ownId = step.contractStepId || step.stepId || step.id || null;
    const contractId = contractStep && (contractStep.contractStepId || contractStep.stepId || contractStep.id) || null;
    const stableId = contractId || ownId;
    if (!stableId) return step;
    return {
      ...step,
      contractStepId: String(stableId),
      ...(ownId && String(ownId) !== String(stableId) ? { sourceContractStepId: String(ownId) } : {}),
      origin: 'authored',
      authored: true,
    };
  });
}

function inlineContractCompilerBinding(caseObj) {
  if (!caseObj || caseObj._caseContractBindingsComplete !== true) return null;
  const definitions = caseObj.caseContractV1 && Array.isArray(caseObj.caseContractV1.dataBindings)
    ? caseObj.caseContractV1.dataBindings
    : [];
  return {
    sheet: '__case_contract_v1__',
    status: 'complete',
    source: 'case_contract_v1',
    columnToField: Object.fromEntries(definitions.map((entry) => [entry.name, entry.name])),
    findings: [],
  };
}

function compilerDataBinding(caseObj) {
  return caseObj && caseObj.dataBinding && typeof caseObj.dataBinding === 'object'
    ? caseObj.dataBinding
    : inlineContractCompilerBinding(caseObj);
}

function annotateTypedBindings(caseObj, generationContract = null) {
  if (!caseObj || typeof caseObj !== 'object') return [];
  const originalSteps = caseObj.steps;
  const parsedSteps = _parseArr(originalSteps);
  const entries = [];
  const valueKeys = ['value', 'inputValue', 'selectedValue', 'text', 'input'];
  const expectedKeys = ['expectedValue'];

  const annotated = parsedSteps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return step;
    const label = step.element || step.target || step.field || step.label || step.locator_hint || '';
    const next = { ...step };
    const valueKey = valueKeys.find((key) => step[key] != null);
    const expectedKey = expectedKeys.find((key) => step[key] != null);
    if (valueKey) {
      const binding = testDataBindingContract.classifyBinding({
        value: step[valueKey],
        label,
        caseObj,
        generationContract,
      });
      next.valueBinding = binding;
      entries.push({ step: index + 1, key: valueKey, ...binding });
    }
    if (expectedKey) {
      const binding = testDataBindingContract.classifyBinding({
        value: step[expectedKey],
        label,
        caseObj,
        generationContract,
      });
      next.expectedBinding = binding;
      entries.push({ step: index + 1, key: expectedKey, ...binding });
    }
    return next;
  });

  caseObj.steps = typeof originalSteps === 'string' ? JSON.stringify(annotated) : annotated;
  caseObj.bindingMetadata = {
    version: 1,
    caseScopeId: inlineCaseInstanceContract.caseScopeId(caseObj),
    entries,
  };
  return entries;
}

function bindInlineProceduralRequirementData(caseObj, proceduralFlowContract, fallbackIndex = 0, options = {}) {
  if (!caseObj || !proceduralFlowContract || !proceduralFlowContract.isProcedural) return false;
  const envelope = proceduralFlowContract.caseContractV1;
  const selected = caseContractV1.selectCaseContractV1(caseObj, envelope, fallbackIndex);
  if (!selected) return false;
  const rawBindings = typeof caseContractV1.rawBindingsForCase === 'function'
    ? caseContractV1.rawBindingsForCase(envelope, selected.id)
    : caseContractV1.rawBindingsForContract(envelope);
  const definitions = Array.isArray(selected.dataBindings) ? selected.dataBindings : [];
  const selectedScope = inlineCaseInstanceContract.caseScopeId(selected) || String(selected.id || '').trim() || null;
  if (!inlineCaseInstanceContract.caseScopeId(caseObj) && selectedScope) caseObj.caseScopeId = selectedScope;
  if (caseObj.dataBinding && typeof caseObj.dataBinding === 'object'
      && !inlineCaseInstanceContract.caseScopeId(caseObj.dataBinding)
      && inlineCaseInstanceContract.caseScopeId(caseObj)) {
    caseObj.dataBinding.caseScopeId = inlineCaseInstanceContract.caseScopeId(caseObj);
  }
  const resolvedInlineValues = resolveInlinePipelineValues(definitions, rawBindings, options);
  const selectedWorkbookBinding = hasSelectedWorkbookBinding(caseObj, options.testData, options.workbookContract);

  if (!selectedWorkbookBinding) {
    // Pasted or uploaded procedural text is authored case content, not an
    // implicit data source. Restore every inline value, including credentials,
    // in the user-visible case fields exactly as authored. Logging/telemetry
    // redaction is a separate boundary and must not rewrite the saved test.
    Object.assign(caseObj, materializeInlineCase(
      caseObj,
      selected,
      definitions,
      resolvedInlineValues.values,
    ));

    // A deterministic procedural fallback may carry descriptive inlineValues
    // metadata in dataBinding, but without a proven selected sheet it is not an
    // executable data binding. Do not let it masquerade as a workbook contract.
    caseObj.dataBinding = null;
    // The authored literals now live directly on this executable case. Row
    // metadata belongs only to a real row runner; retaining a global parser row
    // here could leak another explicit case's same-labelled value into lineage
    // or later export decisions.
    if (Array.isArray(selected.dataRows)) selected.dataRows = [];
  } else {
    // A sheet selected by this exact case and present in both the persisted
    // mapping and workbook sheets is genuine row data. Keep that established
    // data-driven path tokenised.
    Object.assign(caseObj, replaceRawBindingsDeep(caseObj, rawBindings));
  }

  caseObj.caseContractV1 = selected;
  caseObj.steps = preserveAuthoredStepIdentities(
    annotateStepDataRefs(caseObj.steps, definitions),
    selected && selected.steps,
  );
  const tokens = caseTokens(caseObj).map(norm).filter(Boolean);
  const available = proceduralTokenSet(proceduralFlowContract);
  const missing = tokens.filter((token) => !available.has(token));
  caseObj._caseContractBindingsComplete = tokens.length > 0 && missing.length === 0;
  caseObj.inlineRequirementData = {
    version: 'CaseContractV1',
    source: resolvedInlineValues.surface || 'uploaded_requirement',
    precedenceVersion: resolvedInlineValues.precedenceVersion,
    provenance: resolvedInlineValues.provenance,
    tokens: definitions.map((entry) => entry.name),
    bindings: definitions.map((entry) => ({
      ref: entry.id,
      name: entry.name,
      classification: entry.classification,
      source: entry.source,
    })),
    unusedDataRefs: selected.unusedDataRefs || [],
  };
  return caseObj._caseContractBindingsComplete;
}

/**
 * Every authored/executable {{token}} in the case. CaseContractV1 and
 * inlineRequirementData are lineage dictionaries: their canonical source-step
 * text contains tokens even when the generated case intentionally keeps pasted
 * literals. Counting those metadata tokens made a literal Add Scenario look
 * data-driven and blocked it on a binding that did not exist.
 */
function caseTokens(caseObj) {
  if (!caseObj || typeof caseObj !== 'object') return [];
  const executableSurface = { ...caseObj };
  delete executableSurface.caseContractV1;
  delete executableSurface.inlineRequirementData;
  delete executableSurface.dataBindingCertification;
  if (executableSurface.qualityContract && typeof executableSurface.qualityContract === 'object') {
    executableSurface.qualityContract = { ...executableSurface.qualityContract };
    delete executableSurface.qualityContract.caseContractV1;
  }
  return placeholdersInCase(executableSurface);
}

/** Does the case consume per-ROW data — a {{token}}, or an assertion whose expected is a token? */
function caseConsumesRowData(caseObj) {
  if (caseTokens(caseObj).length) return true;
  const das = _parseArr(caseObj.declaredAssertions);
  for (const a of das) {
    const p = (a && a.payload) || a || {};
    for (const v of [p.expectedText, p.expectedValue, p.expectedUrlPattern, p.text]) {
      if (typeof v === 'string') { TOKEN_RE.lastIndex = 0; if (TOKEN_RE.test(v)) return true; }
    }
  }
  return false;
}

const PRODUCT_GAP_RE = /\b(absent|not (present|available|implemented|shown)|presence check|control (present|absent|missing)|missing feature|feature gap|does not exist|no such (control|field|button))\b/i;
function looksProductGap(caseObj, binding) {
  if (binding && /missingfeature|_bugs\b/i.test(String(binding.sheet || ''))) return true;
  return PRODUCT_GAP_RE.test(String(caseObj.name || '')) || PRODUCT_GAP_RE.test(String(caseObj.assertions || ''));
}

/** Does any assertion reference the {{expected}} data oracle (or the expected column)? */
function caseUsesExpectedToken(caseObj, binding) {
  const expectedCol = binding && binding.expectedColumn ? norm(binding.expectedColumn) : null;
  const das = _parseArr(caseObj.declaredAssertions);
  const strings = [];
  for (const a of das) { const p = (a && a.payload) || a || {}; for (const v of [p.expectedText, p.expectedValue, p.text]) if (typeof v === 'string') strings.push(v); }
  for (const s of strings) {
    TOKEN_RE.lastIndex = 0; let m;
    while ((m = TOKEN_RE.exec(s)) !== null) { const k = norm(m[1]); if (k === 'expected' || (expectedCol && k === expectedCol)) return true; }
  }
  return false;
}

/**
 * For a data-driven binding, are the bound rows' expected outcomes UNIFORM or VARYING?
 * Uniform → a fixed oracle covers every row (no {{expected}} needed). Varying → the case
 * must consume {{expected}} or select one outcome class. Keyed off the WorkbookContract
 * RowContracts (intentClass + outcome signature), never a site string.
 */
function boundOutcome(binding, contract) {
  const sheet = (contract.sheets || []).find((s) => norm(s.name) === norm(binding.sheet));
  if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.length) return { uniform: true, classes: [], rowCount: 0 };
  let rows = sheet.rows;
  const sel = String(binding.rowSelector || '');
  if (/^story:/i.test(sel)) {
    const want = normalizeStoryId(sel.slice(6));
    rows = rows.filter((r) => normalizeStoryId(r.storyId) === want);
  }
  if (!rows.length) rows = sheet.rows;
  const classes = new Set();
  for (const r of rows) {
    // Prefer the declared intent class; else derive an outcome signature from expected values.
    let cls = r.intentClass || null;
    if (!cls) {
      try {
        const o = classifyRowOutcomeClass({ index: r.index, sheet: sheet.name, inputs: r.inputs || {}, raw: r, expected: (r.expected && r.expected[0] && r.expected[0].value) || null });
        cls = o && o.class ? o.class : null;
      } catch (_) { cls = null; }
    }
    if (!cls) {
      // No intent signal — signature on the presence/value of the first expected cell.
      const ev = (r.expected && r.expected[0] && r.expected[0].value) ? norm(r.expected[0].value) : '';
      cls = ev ? `val:${ev}` : 'none';
    }
    classes.add(cls);
  }
  return { uniform: classes.size <= 1, classes: [...classes], rowCount: rows.length };
}

function stripFindings(binding, codes) {
  if (!binding || !Array.isArray(binding.findings)) return;
  binding.findings = binding.findings.filter((f) => !(f && codes.has(f.code)));
  if (!binding.findings.length) delete binding.findings;
}

function buildContractIndex(contract) {
  const coverageItems = (() => { try { return buildCoverageItems(contract); } catch (_) { return []; } })();
  const byId = new Map();
  const byStory = new Map();
  for (const ci of coverageItems) {
    if (!ci || !ci.sheet) continue;
    if (ci.id) byId.set(String(ci.id), ci);
    const sid = normalizeStoryId(ci.storyId);
    if (sid && !byStory.has(sid)) byStory.set(sid, ci);
  }
  return { coverageItems, byId, byStory };
}

function coverageItemTokenNames(ci) {
  const names = new Set();
  for (const h of (Array.isArray(ci && ci.requiredPlaceholders) ? ci.requiredPlaceholders : [])) {
    const k = norm(h);
    if (k) names.add(k);
  }
  for (const c of (Array.isArray(ci && ci.expectedColumns) ? ci.expectedColumns : [])) {
    const k = norm(c && c.name);
    if (k) names.add(k);
    if (k) names.add('expected');
  }
  return names;
}

function coverageItemTextScore(caseObj, ci) {
  const hay = norm([
    caseObj && caseObj.name,
    caseObj && caseObj.module,
    caseObj && caseObj.type,
    caseObj && caseObj.scenario,
  ].filter(Boolean).join(' '));
  const sheetBits = String(ci && ci.sheet || '').split(/[_\-\s]+/).map(norm).filter(Boolean);
  let score = 0;
  for (const bit of sheetBits) {
    if (bit && bit.length > 2 && hay.includes(bit)) score += 1;
  }
  return score;
}

/**
 * Recover the data source when the Architect lost storyId/coverageItemId but kept
 * row tokens. This is the missing architectural bridge: WorkbookContract owns the
 * token vocabulary, so a case that says {{firstName}} / {{expected}} can be bound
 * deterministically even if the LLM forgot the sheet/story citation.
 */
function findCoverageItemByTokens(caseObj, index) {
  const tokens = caseTokens(caseObj).map(norm).filter(Boolean);
  if (!tokens.length || !index || !Array.isArray(index.coverageItems)) return null;
  let best = null;
  for (const ci of index.coverageItems) {
    const available = coverageItemTokenNames(ci);
    if (!available.size) continue;
    const covered = tokens.filter((t) => available.has(t)).length;
    if (!covered) continue;
    const full = covered === tokens.length ? 1 : 0;
    const score = (full * 1000) + (covered * 50) + coverageItemTextScore(caseObj, ci);
    if (!best || score > best.score) best = { ci, score, covered, full };
  }
  return best && (best.full || best.covered >= Math.max(1, Math.ceil(tokens.length * 0.6))) ? best.ci : null;
}

function firstExpectedColumn(ci) {
  return ci && Array.isArray(ci.expectedColumns) && ci.expectedColumns[0] ? ci.expectedColumns[0].name : null;
}

function expectedColumnsByRole(ci) {
  const out = {};
  for (const c of (Array.isArray(ci && ci.expectedColumns) ? ci.expectedColumns : [])) {
    if (c && c.oracleType && c.name && !out[c.oracleType]) out[c.oracleType] = c.name;
  }
  return out;
}

function bindFromCoverageItem(caseObj, ci, source = 'generation_compiler') {
  if (!caseObj || !ci || !ci.sheet) return false;
  const existing = (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') ? caseObj.dataBinding : {};
  const columnToField = (existing.columnToField && typeof existing.columnToField === 'object') ? { ...existing.columnToField } : {};
  for (const h of (Array.isArray(ci.requiredPlaceholders) ? ci.requiredPlaceholders : [])) {
    const key = norm(h);
    if (key && !columnToField[key]) columnToField[key] = h;
  }
  const exp = firstExpectedColumn(ci);
  if (exp && !columnToField.expected) columnToField.expected = exp;
  caseObj.coverageItemId = caseObj.coverageItemId || ci.id || null;
  caseObj.storyId = caseObj.storyId || ci.storyId || null;
  caseObj.dataBinding = {
    ...existing,
    sheet: ci.sheet,
    rowSelector: ci.rowSelector || (ci.storyId ? `story:${ci.storyId}` : 'all'),
    storyId: ci.storyId || existing.storyId || null,
    storyColumn: ci.storyColumn || existing.storyColumn || null,
    coverageItemId: ci.id || existing.coverageItemId || null,
    matchKind: source === 'coverageItem' ? 'coverageItem' : 'storyId',
    source,
    status: 'complete',
    columnToField,
    expectedColumn: existing.expectedColumn || exp || null,
    expectedColumns: Object.keys(existing.expectedColumns || {}).length ? existing.expectedColumns : expectedColumnsByRole(ci),
  };
  delete caseObj.dataBinding.needsReview;
  delete caseObj.dataBinding.findings;
  return true;
}

function repairBindingFromContract(caseObj, contract, index = buildContractIndex(contract)) {
  if (!caseObj || !contract) return false;
  const cited = caseObj.coverageItemId ? index.byId.get(String(caseObj.coverageItemId)) : null;
  if (cited) return bindFromCoverageItem(caseObj, cited, 'coverageItem');
  const sid = normalizeStoryId(caseObj.storyId);
  const byStory = sid ? index.byStory.get(sid) : null;
  if (byStory) return bindFromCoverageItem(caseObj, byStory, 'storyId');
  const byTokens = findCoverageItemByTokens(caseObj, index);
  if (byTokens) return bindFromCoverageItem(caseObj, byTokens, 'tokenSignature');
  return false;
}

function coverageItemForBinding(binding, index) {
  if (!binding || !index) return null;
  if (binding.coverageItemId && index.byId.has(String(binding.coverageItemId))) return index.byId.get(String(binding.coverageItemId));
  const sid = normalizeStoryId(binding.storyId);
  if (sid && index.byStory.has(sid)) {
    const byStory = index.byStory.get(sid);
    if (!binding.sheet || norm(byStory.sheet) === norm(binding.sheet)) return byStory;
  }
  const selectorStory = /^story:/i.test(String(binding.rowSelector || '')) ? normalizeStoryId(String(binding.rowSelector).slice(6)) : null;
  if (selectorStory && index.byStory.has(selectorStory)) {
    const byStory = index.byStory.get(selectorStory);
    if (!binding.sheet || norm(byStory.sheet) === norm(binding.sheet)) return byStory;
  }
  return (index.coverageItems || []).find((ci) => norm(ci.sheet) === norm(binding.sheet)) || null;
}

function placeholderForHeader(header) {
  const k = norm(header);
  return k ? `{{${k}}}` : null;
}

function stepFieldKey(step) {
  return norm([step && step.element, step && step.target, step && step.label, step && step.name].filter(Boolean).join(' '));
}

function rowValuesForColumn(ci, header) {
  const key = norm(header);
  const vals = new Set();
  const rows = Array.isArray(ci && ci._rows) ? ci._rows : [];
  for (const r of rows) {
    const inputs = r && r.inputs && typeof r.inputs === 'object' ? r.inputs : {};
    for (const [h, v] of Object.entries(inputs)) {
      if (norm(h) === key && String(v == null ? '' : v).trim()) vals.add(norm(v));
    }
  }
  return vals;
}

function coverageItemWithRows(ci, contract) {
  if (!ci || !contract) return ci;
  const sheet = (contract.sheets || []).find((s) => norm(s.name) === norm(ci.sheet));
  if (!sheet) return ci;
  let rows = Array.isArray(sheet.rows) ? sheet.rows : [];
  if (/^story:/i.test(String(ci.rowSelector || ''))) {
    const sid = normalizeStoryId(String(ci.rowSelector).slice(6));
    rows = rows.filter((r) => normalizeStoryId(r.storyId) === sid);
  }
  return { ...ci, _rows: rows };
}

/**
 * A data-bound case with literal values or missing placeholders is not ready in the
 * architectural sense: it would repeat the same value for every row. Rewrite its
 * fill steps and row oracle from the WorkbookContract so the generated case really
 * consumes the row data it is bound to.
 */
function synthesizeRowPlaceholders(caseObj, binding, contract, index) {
  const baseCi = coverageItemForBinding(binding, index);
  const ci = coverageItemWithRows(baseCi, contract);
  if (!ci) return false;
  let changed = false;
  const inputHeaders = Array.isArray(ci.requiredPlaceholders) ? ci.requiredPlaceholders : [];
  const inputByNorm = new Map(inputHeaders.map((h) => [norm(h), h]));
  const valueNormToHeader = new Map();
  for (const h of inputHeaders) {
    for (const v of rowValuesForColumn(ci, h)) if (v && !valueNormToHeader.has(v)) valueNormToHeader.set(v, h);
  }

  const steps = _parseArr(caseObj.steps);
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const action = String(step.action || '').toLowerCase();
    if (!/\b(fill|type|enter|input|select|choose)\b/.test(action)) continue;
    const field = stepFieldKey(step);
    let header = null;
    for (const [k, h] of inputByNorm) {
      if (k && (field.includes(k) || k.includes(field))) { header = h; break; }
    }
    if (!header && step.value != null) header = valueNormToHeader.get(norm(step.value)) || null;
    const ph = header ? placeholderForHeader(header) : null;
    if (ph && step.value !== ph) {
      step.value = ph;
      changed = true;
    }
  }
  if (changed) caseObj.steps = steps;

  const exp = binding.expectedColumn || firstExpectedColumn(ci);
  if (!changed) return false;

  if (exp) {
    binding.columnToField = (binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
    for (const h of inputHeaders) {
      const k = norm(h);
      if (k && !binding.columnToField[k]) binding.columnToField[k] = h;
    }
    if (!binding.columnToField.expected) binding.columnToField.expected = exp;
    binding.expectedColumn = binding.expectedColumn || exp;
    if (!caseUsesExpectedToken(caseObj, binding)) {
      ensureMustTextAssertion(caseObj, '{{expected}}');
      const arr = _parseArr(caseObj.declaredAssertions);
      let sawExpected = false;
      for (const a of arr) {
        if (!a || a.parseFailed) continue;
        if (String(a.criticality || 'must') !== 'must') continue;
        if (String(a.type || '').toUpperCase() !== 'TEXT') continue;
        a.payload = (a.payload && typeof a.payload === 'object') ? a.payload : {};
        a.payload.expectedText = '{{expected}}';
        sawExpected = true;
        changed = true;
        break;
      }
      if (!sawExpected) {
        arr.push({ id: `gc-${norm(caseObj.name || 'case') || 'row'}-expected`, type: 'TEXT', criticality: 'must', payload: { expectedText: '{{expected}}' }, source: 'generation_compiler' });
        changed = true;
      }
      caseObj.declaredAssertions = arr;
    }
  }
  return changed;
}

function ensureMustTextAssertion(caseObj, expectedText = '{{expected}}') {
  if (String(expectedText || '').trim().toLowerCase() === 'page ready') {
    caseObj.oracleWarnings = Array.isArray(caseObj.oracleWarnings) ? caseObj.oracleWarnings : [];
    caseObj.oracleWarnings.push({ code: 'generic_page_ready_oracle', severity: 'warning' });
    return false;
  }
  const arr = _parseArr(caseObj.declaredAssertions);
  const validMust = arr.some((a) => a && a.parseFailed !== true && String(a.criticality || 'must') === 'must');
  if (validMust) return false;
  arr.push({
    id: `gc-${norm(caseObj.name || 'case') || 'assertion'}-must`,
    type: 'TEXT',
    criticality: 'must',
    payload: { expectedText },
    source: 'generation_compiler',
    note: 'Generated deterministic must assertion from the workbook/oracle contract.',
  });
  caseObj.declaredAssertions = arr;
  return true;
}

function stripMalformedMustAssertions(caseObj) {
  const arr = _parseArr(caseObj.declaredAssertions);
  if (!arr.length) return false;
  const kept = arr.filter((a) => {
    if (!a || typeof a !== 'object') return false;
    if (declaredAssertionsLib.normalizeCriticality(a.criticality) !== 'must') return true;
    if (a.parseFailed === true) return false;
    try { return declaredAssertionsLib.validateRecord(a).ok; } catch (_) { return false; }
  });
  if (kept.length !== arr.length) {
    caseObj.declaredAssertions = kept;
    return true;
  }
  return false;
}

/**
 * Deterministically repair + classify ONE case in place. Returns { caseClass, defects[] }
 * where defects are the REAL, source-less reasons the case cannot be synthesized
 * (empty ⇒ ready once recompiled). Never fabricates data; only clears advisories it has
 * proven don't apply, clears a static case's binding, binds from WorkbookContract, and
 * synthesizes row-oracle assertions from expected columns.
 */
function repairCase(caseObj, contract, index = buildContractIndex(contract)) {
  const defects = [];
  const automatable = String(caseObj.automatability || 'automatable') !== 'manual';
  if (!automatable) { caseObj.caseClass = 'manual'; return { caseClass: 'manual', defects }; }

  let binding = (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') ? caseObj.dataBinding : null;

  // A story/citation conflict is not a reason to give the user a not-ready case.
  // Prefer the explicit CoverageItem when present; otherwise prefer the case storyId.
  // This gives the compiler a deterministic contract-backed binding instead of a
  // warning that wastes the generation.
  if (binding && Array.isArray(binding.findings) && binding.findings.some((f) => f && f.code === 'story_id_conflict')) {
    repairBindingFromContract(caseObj, contract, index);
    binding = (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') ? caseObj.dataBinding : binding;
    stripFindings(binding, new Set(['story_id_conflict']));
  }
  stripMalformedMustAssertions(caseObj);

  const consumes = caseConsumesRowData(caseObj);
  const isGap = looksProductGap(caseObj, binding);

  if (!consumes && binding && binding.sheet) {
    synthesizeRowPlaceholders(caseObj, binding, contract, index);
  }
  const consumesAfterSynthesis = caseConsumesRowData(caseObj);

  // ── STATIC (no per-row consumption) → NOT data-driven; clear any binding ──────
  // A no-token case reads no row value: a control-presence/absence check, a navigation
  // check, a static verification. Clear its binding (a static assertion is not a row
  // matrix). This covers a NO-TOKEN product-gap presence check too — classify it
  // product-gap but unbind it.
  if (!consumesAfterSynthesis) {
    if (binding) caseObj.dataBinding = null;
    caseObj.caseClass = isGap ? CASE_CLASS.PRODUCT_GAP : CASE_CLASS.STATIC;
    return { caseClass: caseObj.caseClass, defects };
  }
  // ── consumes row data but has NO binding → genuinely unbound (compiler will block) ─
  // Not repairable here (there is no sheet to bind to). Classify for the report.
  if (!binding) {
    repairBindingFromContract(caseObj, contract, index);
    binding = (caseObj.dataBinding && typeof caseObj.dataBinding === 'object') ? caseObj.dataBinding : null;
  }
  if (!binding) {
    caseObj.caseClass = isGap ? CASE_CLASS.PRODUCT_GAP : CASE_CLASS.DATA_DRIVEN;
    return { caseClass: caseObj.caseClass, defects };
  }
  // ── DATA-DRIVEN product-gap: the case CONSUMES gap-sheet columns (e.g. the
  //    *_MissingFeature_Bugs sheets expose mustHaveVisibleControl / expectedPlatformVerdict
  //    that the case reads via {{musthavevisiblecontrol}} / {{expected}}). It is a real
  //    data-driven case — KEEP the binding (clearing it orphaned the token → blocked).
  //    Just classify product-gap and drop the row-matrix input advisory; the normal
  //    data-driven oracle logic below handles its expected column.
  if (isGap) {
    caseObj.caseClass = CASE_CLASS.PRODUCT_GAP;
    stripFindings(binding, new Set(['data_input_placeholders_missing', 'data_literal_from_uploaded_sheet']));
  }

  // ── deterministic companion credentials → ready (runtime cred-join is exact) ──
  if (Array.isArray(binding.companions) && binding.companions.length >= 1) {
    stripFindings(binding, new Set(['multi_source_credential_binding']));
    caseObj.caseClass = binding.sheet && /profile|execution/i.test(binding.sheet) ? CASE_CLASS.EXECUTION_PROFILE : CASE_CLASS.DATA_DRIVEN;
  } else {
    caseObj.caseClass = CASE_CLASS.DATA_DRIVEN;
  }
  // A coverage_item_story_mismatch is INFORMATIONAL, not a defect: storyId already
  // corrected the binding (the architect's wrong citation was ignored), so the bind is
  // correct. It must not, by itself, mint a needs_review.
  stripFindings(binding, new Set(['coverage_item_story_mismatch']));

  // ── data-driven expected-outcome oracle: uniform is fine, varying MUST tokenize ─
  const outcome = boundOutcome(binding, contract);
  const usesExpected = caseUsesExpectedToken(caseObj, binding);
  // A DYNAMIC oracle already handles per-row outcomes without a fixed value: an EVALUATE
  // must (JS assertion on the page), a ROLE/DOWNLOAD/PERFORMANCE/A11Y must, or any must
  // whose expected is already tokenized. Such a case does NOT need {{expected}} injected
  // — forcing it would be wrong (esp. when the "expected" column holds flags like Yes/No,
  // not visible text). Only a FIXED-TEXT-only oracle over VARYING text outcomes needs the
  // per-row expected column.
  const musts = _parseArr(caseObj.declaredAssertions).filter((a) => a && a.parseFailed !== true && String(a.criticality || 'must') === 'must');
  // CONTENT oracles that can distinguish per-row outcomes (EVALUATE = custom JS check,
  // ROLE = element presence, DOWNLOAD = artifact). PAGE/URL/PERFORMANCE/A11Y verify
  // location/page-level state, NOT the per-row data outcome, so they do NOT satisfy a
  // varying-outcome case's oracle requirement.
  const DYNAMIC_MUST = new Set(['EVALUATE', 'ROLE', 'FORBIDDEN_ROLE', 'DOWNLOAD']);
  const hasDynamicOracle = musts.some((a) => {
    const t = String(a.type || '').toUpperCase();
    if (DYNAMIC_MUST.has(t)) return true;
    const p = a.payload || {};
    return typeof p.expectedText === 'string' && /\{\{/.test(p.expectedText);
  });
  if (binding.expectedColumn && !usesExpected && (hasDynamicOracle || outcome.uniform)) {
    // A DYNAMIC oracle handles per-row outcomes, OR a single uniform outcome makes a
    // fixed oracle correct → the missing {{expected}} placeholder is NOT a defect.
    stripFindings(binding, new Set(['data_expected_placeholder_missing']));
  } else if (binding.expectedColumn && !usesExpected) {
    {
      // Rows expect DIFFERENT outcomes but the case asserts a FIXED value for all of
      // them → it would wrongly pass/fail some rows. REPAIR deterministically: point the
      // oracle at the per-row expected column by rewriting a fixed `must` TEXT assertion
      // to {{expected}} (the correct data-driven oracle). Only if there is no clean
      // fixed-text must to repair does it remain a genuine needs_review defect.
      const das = _parseArr(caseObj.declaredAssertions);
      let injected = false;
      for (const a of das) {
        if (!a || a.parseFailed) continue;
        if (String(a.criticality || 'must') !== 'must') continue;
        if (String(a.type || '').toUpperCase() !== 'TEXT') continue;
        const p = a.payload && typeof a.payload === 'object' ? a.payload : (a.payload = {});
        if (typeof p.expectedText === 'string' && !/\{\{/.test(p.expectedText)) { p.expectedText = '{{expected}}'; injected = true; break; }
      }
      if (injected) {
        caseObj.declaredAssertions = das;
        binding.columnToField = (binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
        if (!binding.columnToField.expected) binding.columnToField.expected = binding.expectedColumn; // map {{expected}} → the column
        stripFindings(binding, new Set(['data_expected_placeholder_missing']));
      } else {
        // No text must exists to retarget, so create the row-oracle assertion instead
        // of returning a needs_review case. This is contract synthesis, not a guess:
        // the binding's expectedColumn supplies {{expected}} per row.
        caseObj.declaredAssertions = [
          ...das,
          {
            id: `gc-${norm(caseObj.name || 'case') || 'row'}-expected`,
            type: 'TEXT',
            criticality: 'must',
            payload: { expectedText: '{{expected}}' },
            source: 'generation_compiler',
            note: `Generated row oracle from expected column "${binding.expectedColumn}".`,
          },
        ];
        stripMalformedMustAssertions(caseObj);
        binding.columnToField = (binding.columnToField && typeof binding.columnToField === 'object') ? binding.columnToField : {};
        if (!binding.columnToField.expected) binding.columnToField.expected = binding.expectedColumn;
        stripFindings(binding, new Set(['data_expected_placeholder_missing']));
      }
    }
  }
  // input-placeholder advisory is authoring-quality once the case is a real data case.
  stripFindings(binding, new Set(['data_input_placeholders_missing', 'data_literal_from_uploaded_sheet']));
  ensureMustTextAssertion(caseObj, binding.expectedColumn ? '{{expected}}' : 'page ready');

  return { caseClass: caseObj.caseClass, defects };
}

/**
 * Compile + repair a whole generation before persistence.
 *
 * @param {object} args
 *   scenarios      – Architect scenarios AFTER coverage repair (mutated in place)
 *   testData       – { sheets, mapping } (used to build the WorkbookContract)
 *   workbookContract? – prebuilt contract (else built from testData.sheets)
 *   atlasHasCapabilities? – bool (threaded to CaseCompiler for the typed-ops warning)
 * @returns {{ scenarios, readyScenarios, allAutomatableReady, report }}
 *   scenarios        – all candidates, repaired in place (each case stamped ._readiness)
 *   readyScenarios   – the repaired, ready-to-persist suite. Contract-backed candidates
 *                      are repaired into this set. Only source-less impossible artifacts
 *                      are withheld and reported internally in report.notReady.
 *   report           – { total, ready, needsReview, blocked, byClass, defects[], notReady[] }
 */
function compileGeneration({ scenarios = [], testData = null, workbookContract = null, atlasHasCapabilities = false, project = {}, authProfileName = null, proceduralFlowContract = null, inlineSourceSurface = null } = {}) {
  let contract = workbookContract;
  if (!contract) { try { contract = buildWorkbookContract({ sheets: (testData && testData.sheets) || [] }); } catch (_) { contract = { sheets: [] }; } }

  const report = { total: 0, ready: 0, needsReview: 0, blocked: 0, byClass: {}, defects: [], notReady: [], dataBinding: { checked: 0, blocked: 0 } };
  const readyScenarios = [];
  const quality = scenarioQualityContract.compileScenarioQuality({ scenarios, project, authProfileName });
  const index = buildContractIndex(contract);
  const generationContract = testData && testData.generationContract && typeof testData.generationContract === 'object'
    ? testData.generationContract
    : null;
  let caseOrdinal = 0;
  for (const scn of (Array.isArray(scenarios) ? scenarios : [])) {
    const readyCases = [];
    for (const caseObj of (Array.isArray(scn && scn.cases) ? scn.cases : [])) {
      if (!caseObj || typeof caseObj !== 'object') continue;
      report.total += 1;
      bindInlineProceduralRequirementData(caseObj, proceduralFlowContract, caseOrdinal, {
        testData,
        workbookContract: contract,
        inlineSourceSurface,
      });
      caseOrdinal += 1;
      let repaired = { caseClass: 'unknown', defects: [] };
      try { repaired = repairCase(caseObj, contract, index); } catch (e) { repaired = { caseClass: 'unknown', defects: [{ code: 'repair_error', case: caseObj.name, detail: e.message }] }; }
      annotateTypedBindings(caseObj, generationContract);
      report.byClass[repaired.caseClass] = (report.byClass[repaired.caseClass] || 0) + 1;

      // Recompile from the repaired shape (same authority the DB path uses).
      let v = { state: 'ready', blockers: [], warnings: [] };
      try {
        v = caseCompiler.compileCase({
          name: caseObj.name, steps: caseObj.steps, assertions: caseObj.assertions,
          declaredAssertions: caseObj.declaredAssertions, dataBinding: compilerDataBinding(caseObj),
          operations: caseObj.operations, automatability: caseObj.automatability, module: caseObj.module,
          requirementRefs: caseObj.requirementRefs, storyId: caseObj.storyId, coverageItemId: caseObj.coverageItemId,
        }, { workbookContract: contract, atlasHasCapabilities });
      } catch (_) { /* leave optimistic */ }

      if (repaired.caseClass === CASE_CLASS.PRODUCT_GAP && v.state === 'blocked') {
        const blockers = Array.isArray(v.blockers) ? v.blockers : [];
        if (blockers.length > 0 && blockers.every((blocker) => blocker && blocker.code === 'steps_missing')) {
          v = {
            state: 'ready',
            blockers: [],
            warnings: [
              ...((Array.isArray(v.warnings) ? v.warnings : [])),
              { code: 'product_gap_no_action_steps', detail: 'Product-gap presence check is diagnostic and may have no mutating executable steps.' },
            ],
          };
        }
      }

      const realDefects = repaired.defects.filter(Boolean);
      // A residual defect keeps the case OUT of the ready set even if the compiler state
      // is technically needs_review (defects are the compiler's "not truly ready" signal).
      if (v.state !== 'ready') {
        // Last deterministic cleanup pass: remove non-structural authoring findings,
        // rebuild bindings from CoverageItems/storyId if possible, and ensure a must
        // assertion exists. Then recompile. The saved suite should be repaired, not
        // filtered, whenever the contract has enough information.
        const b = caseObj.dataBinding && typeof caseObj.dataBinding === 'object' ? caseObj.dataBinding : null;
        if (b && Array.isArray(b.findings)) {
          b.findings = b.findings.filter((f) => f && f.severity === 'error');
          if (!b.findings.length) delete b.findings;
        }
        if (!b || !b.sheet) repairBindingFromContract(caseObj, contract, index);
        ensureMustTextAssertion(caseObj, caseObj.dataBinding && caseObj.dataBinding.expectedColumn ? '{{expected}}' : 'page ready');
        try {
          v = caseCompiler.compileCase({
            name: caseObj.name, steps: caseObj.steps, assertions: caseObj.assertions,
            declaredAssertions: caseObj.declaredAssertions, dataBinding: compilerDataBinding(caseObj),
            operations: caseObj.operations, automatability: caseObj.automatability, module: caseObj.module,
            requirementRefs: caseObj.requirementRefs, storyId: caseObj.storyId, coverageItemId: caseObj.coverageItemId,
          }, { workbookContract: contract, atlasHasCapabilities });
        } catch (_) { /* keep previous */ }
      }
      const qualityBlockers = (caseObj.qualityContract && Array.isArray(caseObj.qualityContract.blockers))
        ? caseObj.qualityContract.blockers.filter((blocker) => !(repaired.caseClass === CASE_CLASS.PRODUCT_GAP && blocker && blocker.code === 'steps_missing'))
        : [];
      const dataCertification = testDataBindingContract.certifyCaseDataBinding({ caseObj, generationContract });
      caseObj.dataBindingCertification = dataCertification;
      report.dataBinding.checked += 1;
      if (!dataCertification.ok) report.dataBinding.blocked += 1;
      const dataBindingDefects = Array.isArray(dataCertification.defects) ? dataCertification.defects : [];
      const isReady = v.state === 'ready' && realDefects.length === 0 && qualityBlockers.length === 0 && dataBindingDefects.length === 0;
      caseObj._readiness = v.state;
      if (v.state === 'blocked') { report.blocked += 1; report.notReady.push({ case: caseObj.name, state: 'blocked', reasons: v.blockers.map((b) => b.code), defects: realDefects }); }
      else if (qualityBlockers.length) { report.blocked += 1; report.notReady.push({ case: caseObj.name, state: 'blocked', reasons: qualityBlockers.map((b) => b.code), defects: qualityBlockers }); }
      else if (dataBindingDefects.length) { report.blocked += 1; report.notReady.push({ case: caseObj.name, state: 'blocked', reasons: dataBindingDefects.map((d) => d.code), defects: dataBindingDefects }); }
      else if (!isReady) { report.needsReview += 1; report.notReady.push({ case: caseObj.name, state: 'needs_review', reasons: v.warnings.map((w) => w.code), defects: realDefects }); }
      else { report.ready += 1; readyCases.push(caseObj); }
      for (const d of realDefects) report.defects.push(d);
      for (const d of qualityBlockers) report.defects.push(d);
      for (const d of dataBindingDefects) report.defects.push(d);
    }
    if (readyCases.length) readyScenarios.push({ ...scn, cases: readyCases });
  }
  const allAutomatableReady = report.blocked === 0 && report.needsReview === 0;
  report.quality = quality.report;
  return { scenarios, readyScenarios, allAutomatableReady, report };
}

module.exports = {
  compileGeneration,
  repairCase,
  boundOutcome,
  caseConsumesRowData,
  looksProductGap,
  CASE_CLASS,
  _private: {
    preserveAuthoredStepIdentities,
    bindInlineProceduralRequirementData,
    compilerDataBinding,
    hasSelectedWorkbookBinding,
    replaceRawBindingsDeep,
    resolveInlinePipelineValues,
    annotateTypedBindings,
  },
};
