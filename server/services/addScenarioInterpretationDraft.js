'use strict';

const semanticProjector = require('./addScenarioSemanticProjector');
const semanticValidator = require('./caseContractSemanticValidator');
const { normalizeInterpretation } = require('./addScenarioInterpretationPreview');

const STOP_WORDS = new Set('a an and are as at be been by for from has have if in into is it of on or that the then this to until was were when whose with'.split(' '));
const EFFECT_ORACLE_ACTION_TYPES = new Set([
  'Navigate', 'Click', 'DoubleClick', 'Select', 'Check', 'Uncheck', 'Radio',
  'Date', 'Time', 'DateTime', 'Expand', 'Collapse', 'Submit', 'PressKey',
  'DragAndDrop', 'SwitchContext', 'Close',
]);

class AddScenarioInterpretationDraftError extends Error {
  constructor(message, findings = [], status = 422) {
    super(message);
    this.name = 'AddScenarioInterpretationDraftError';
    this.code = 'ADD_SCENARIO_INTERPRETATION_DRAFT_INVALID';
    this.status = status;
    this.findings = Array.isArray(findings) ? findings : [];
  }
}

function projectionFindings(error) {
  if (Array.isArray(error?.findings) && error.findings.length) return error.findings;
  return [{
    path: '$.projection',
    code: clean(error?.code) || 'interpretation_projection_failed',
    message: clean(error?.message) || 'The reviewed interpretation could not be projected safely.',
    severity: 'error',
  }];
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sourceClauses(sourceText) {
  const source = clean(sourceText);
  if (!source) return [];
  const lines = [];
  const linePattern = /(^|\n)([^\n]+)/g;
  let match;
  while ((match = linePattern.exec(sourceText)) !== null) {
    const raw = match[2];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const leading = raw.indexOf(trimmed);
    lines.push({
      text: trimmed,
      start: match.index + match[1].length + leading,
      end: match.index + match[1].length + leading + trimmed.length,
      number: (trimmed.match(/^(\d+)[.)]\s+/) || [])[1] || null,
    });
  }
  if (lines.length > 1) return lines;
  const clauses = [];
  const sentencePattern = /[^.!?\r\n]+(?:[.!?]+|$)/g;
  while ((match = sentencePattern.exec(sourceText)) !== null) {
    const text = match[0].trim();
    if (!text) continue;
    const leading = match[0].indexOf(text);
    clauses.push({ text, start: match.index + leading, end: match.index + leading + text.length, number: null });
  }
  return clauses.length ? clauses : [{ text: source, start: sourceText.indexOf(source), end: sourceText.indexOf(source) + source.length, number: null }];
}

function tokens(value) {
  return clean(value).toLowerCase().match(/[a-z0-9*][a-z0-9*/&_-]*/g)?.filter((token) => token.length > 1 && !STOP_WORDS.has(token)) || [];
}

function operationSearchText(operation) {
  const values = [operation.target, operation.value, operation.expected, operation.condition, operation.reason];
  if (operation.selectionCriteria) values.push(JSON.stringify(operation.selectionCriteria));
  return values.filter(Boolean).join(' ');
}

function actionFragment(operation, clauseText) {
  if (operation.kind === 'assertion') return clauseText;
  const type = clean(operation.type);
  const verbPatterns = {
    Navigate: /\b(?:navigate|open|go)\b/i,
    Click: /\bclick\b/i,
    Fill: /\b(?:fill|enter|type)\b/i,
    Type: /\btype\b/i,
    Select: /\b(?:select|choose)\b/i,
    Expand: /\b(?:open|expand)\b/i,
    Collapse: /\bcollapse\b/i,
    Scroll: /\bscroll\b/i,
    WaitForState: /\bwait\b/i,
    Date: /\b(?:select|set|choose)\b/i,
    Time: /\b(?:select|set|choose)\b/i,
    Radio: /\b(?:select|choose|check)\b/i,
  };
  const wanted = verbPatterns[type];
  if (!wanted) return clauseText;
  const withoutNumber = clauseText.replace(/^\d+[.)]\s*/, '');
  const fragments = withoutNumber.split(/\s*(?:,?\s+and\s+then\s+|,?\s+then\s+|,?\s+and\s+)\s*/i).map(clean).filter(Boolean);
  const matching = fragments.filter((fragment) => wanted.test(fragment));
  if (matching.length === 1) return matching[0].replace(/[.;,:]+$/, '');
  return clauseText;
}

function findSourceQuote(operation, clauses, sourceText) {
  const reason = clean(operation.reason);
  const authoredStep = reason.match(/\bstep\s+(\d+)/i);
  if (authoredStep) {
    const numbered = clauses.find((clause) => clause.number === authoredStep[1]);
    if (numbered) return actionFragment(operation, numbered.text);
  }
  const wanted = new Set(tokens(operationSearchText(operation)));
  let best = null;
  for (const clause of clauses) {
    const available = new Set(tokens(clause.text));
    let score = 0;
    for (const token of wanted) if (available.has(token)) score += token.length >= 6 ? 3 : 1;
    if (!best || score > best.score || (score === best.score && clause.text.length < best.clause.text.length)) best = { clause, score };
  }
  return best && best.score > 0 ? best.clause.text : clean(sourceText);
}

function inferTarget(operation) {
  const label = clean(operation.target) || 'Current page';
  const type = clean(operation.type);
  let kind = 'control';
  let role;
  if (/Collection/.test(type) || /\b(list|options|suggestions)\b/i.test(label)) { kind = 'collection'; role = 'listbox'; }
  else if (/^(Fill|Type|Clear)$/.test(type)) { kind = 'field'; role = 'textbox'; }
  else if (/^(Select|Date|Time|DateTime)$/.test(type) || /\bdropdown\b/i.test(label)) { kind = 'field'; role = 'combobox'; }
  else if (/^(Check|Uncheck)$/.test(type)) { kind = 'control'; role = 'checkbox'; }
  else if (type === 'Radio') { kind = 'control'; role = 'radio'; }
  else if (/^(Scroll|WaitForState)$/.test(type) || /\b(page|section|form|area|heading)\b/i.test(label)) { kind = 'region'; role = /heading/i.test(label) ? 'heading' : 'region'; }
  else if (/^(Click|Expand|Collapse|Submit)$/.test(type)) { kind = 'control'; role = 'button'; }
  return { kind, label, ...(role ? { role } : {}) };
}

function actionText(type, target) {
  const verbs = {
    Navigate: 'Navigate to', Click: 'Click', Fill: 'Fill', Type: 'Type into', Clear: 'Clear', Select: 'Select from',
    Check: 'Check', Uncheck: 'Uncheck', Radio: 'Select', Date: 'Set date in', Time: 'Set time in', DateTime: 'Set date and time in',
    Scroll: 'Scroll to', Expand: 'Expand', Collapse: 'Collapse', WaitForState: 'Wait for', Upload: 'Upload to', Download: 'Download from',
    Hover: 'Hover over', Submit: 'Submit', PressKey: 'Press key on', Screenshot: 'Capture',
  };
  return `${verbs[type] || type} ${target}.`;
}

function normalizeDate(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/);
  if (!match) return value;
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function selectionCriteria(operation) {
  const supplied = operation.selectionCriteria;
  if (supplied && typeof supplied === 'object') {
    if (supplied.kind === 'predicate' && !supplied.predicate) {
      return { kind: 'predicate', predicate: `${supplied.field || 'visible label'} ${supplied.operator || 'contains'} ${supplied.value || ''}`.trim() };
    }
    return supplied;
  }
  if (operation.value !== undefined && operation.value !== null && operation.value !== '') return { kind: 'exact_text', text: String(operation.value) };
  return null;
}

function comparatorFor(operation, type) {
  const supplied = clean(operation.comparator).toLowerCase();
  const supported = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'matches', 'visible', 'hidden', 'enabled', 'disabled', 'selected', 'checked', 'collection_exact_order', 'collection_contains_all', 'before', 'after']);
  if (supported.has(supplied)) return supplied;
  if (type === 'AssertVisible') return 'visible';
  if (type === 'AssertHidden') return 'hidden';
  if (type === 'AssertEnabled') return 'enabled';
  if (type === 'AssertDisabled') return 'disabled';
  if (type === 'AssertSelected') return 'selected';
  if (type === 'AssertChecked') return 'checked';
  if (type === 'AssertCollection') return /order|ordered|\[1\]|first option/i.test(String(operation.expected || operation.reason || '')) ? 'collection_exact_order' : 'collection_contains_all';
  if (type === 'AssertTemporal') return /\bafter\b/i.test(String(operation.expected || operation.reason || '')) ? 'after' : 'before';
  if (/contains/i.test(String(operation.expected || operation.reason || ''))) return 'contains';
  return 'equals';
}

function collectionExpected(value) {
  if (Array.isArray(value)) return value;
  const text = clean(value);
  const numbered = [...text.matchAll(/(?:\[|\b)(\d+)(?:\]|[.)])\s*([^,;]+?)(?=(?:\s*(?:,|;)|\s+\[?\d+[\].)]|$))/g)].map((match) => match[2].trim());
  if (numbered.length) return numbered;
  const ordinal = [...text.matchAll(/\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?:option|item)?\s*(?::|=)\s*([\s\S]*?)(?=\s*(?:,|;)?\s*\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(?:option|item)?\s*(?::|=)|$)/gi)]
    .map((match) => match[1].replace(/^[,;\s]+|[,;\s]+$/g, '').trim())
    .filter(Boolean);
  if (ordinal.length > 1) return ordinal;
  const list = text.replace(/^.*?(?:contains|options:)\s*/i, '').split(/,|\n|\s{2,}/).map((item) => item.trim()).filter(Boolean);
  if (list.length > 1) return list;
  const paired = (list[0] || text).split(/\s+and\s+/i).map((item) => item.trim()).filter(Boolean);
  return paired.length > 1 ? paired : [text];
}

function temporalOperands(operation) {
  const text = `${operation.target || ''} ${operation.expected || ''}`;
  const targetParts = clean(operation.target).split(/\s+vs\s+/i).map(clean).filter(Boolean);
  const relation = text.match(/(.+?)\s+is\s+(?:chronologically\s+)?(?:before|after)\s+(.+)/i);
  const parts = targetParts.length === 2 ? targetParts : (relation ? [clean(relation[1]), clean(relation[2])] : []);
  if (parts.length !== 2) return [];
  return [
    { role: 'actual', kind: 'temporal_reference', name: parts[0], ref: `runtime:${parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
    { role: 'expected', kind: 'temporal_reference', name: parts[1], ref: `runtime:${parts[1].toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
  ];
}

function createSemanticPlanFromInterpretation({ sourceText, interpretation, predecessorCaseId = null }) {
  const normalized = normalizeInterpretation(interpretation);
  if (!normalized || !normalized.operations.length) throw new AddScenarioInterpretationDraftError('The reviewed interpretation contains no operations.');
  const clauses = sourceClauses(sourceText);
  const actions = [];
  const assertions = [];
  let lastActionKey = null;
  for (let operationIndex = 0; operationIndex < normalized.operations.length; operationIndex += 1) {
    const operation = normalized.operations[operationIndex];
    const sourceQuote = findSourceQuote(operation, clauses, sourceText);
    const target = inferTarget(operation);
    if (operation.kind === 'assertion') {
      let type = clean(operation.type) || 'AssertText';
      let expected = operation.expected;
      if (type === 'AssertTemporal' && !/\bvs\b/i.test(clean(operation.target)) && !/\b(?:before|after)\b/i.test(clean(operation.expected))) {
        type = /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(clean(expected)) ? 'AssertDate' : 'AssertValue';
      }
      const implicit = new Set(['AssertVisible', 'AssertHidden', 'AssertEnabled', 'AssertDisabled', 'AssertSelected', 'AssertChecked']);
      if (type === 'AssertCollection') expected = collectionExpected(expected);
      if (type === 'AssertDate') expected = normalizeDate(expected);
      const record = {
        key: operation.id,
        type,
        text: `Verify ${target.label}.`,
        sourceQuote,
        target,
        comparator: comparatorFor(operation, type),
        stepRef: lastActionKey,
        required: operation.nonBlocking !== true,
        failureBehavior: operation.nonBlocking === true ? 'continue_independent' : 'stop_descendants',
      };
      if (!implicit.has(type) && type !== 'AssertTemporal') record.expected = expected;
      if (type === 'AssertTemporal') record.operands = temporalOperands(operation);
      assertions.push(record);
      continue;
    }
    const type = clean(operation.type) || 'Click';
    const record = {
      key: operation.id,
      type,
      text: actionText(type, target.label),
      sourceQuote,
      target,
      dependsOn: lastActionKey ? [lastActionKey] : [],
      failureBehavior: 'stop_descendants',
    };
    const explicitExpected = operation.expected;
    const nextOperation = normalized.operations[operationIndex + 1];
    const nextWaitExpected = EFFECT_ORACLE_ACTION_TYPES.has(type)
      && nextOperation?.kind === 'action'
      && clean(nextOperation.type) === 'WaitForState'
      ? (clean(nextOperation.expected) || clean(nextOperation.target))
      : '';
    if (['string', 'number', 'boolean'].includes(typeof explicitExpected) && String(explicitExpected).trim()) {
      record.expected = explicitExpected;
    } else if (nextWaitExpected) {
      record.expected = nextWaitExpected;
    }
    if (type === 'Select') {
      record.selectionCriteria = selectionCriteria(operation);
    } else if (operation.value !== undefined && operation.value !== null && operation.value !== '') {
      record.value = type === 'Date' ? normalizeDate(operation.value) : operation.value;
    } else if (type === 'Radio') {
      record.value = target.label.replace(/\s+option\s*$/i, '').trim();
    }
    if (operation.condition) record.condition = operation.condition;
    actions.push(record);
    lastActionKey = operation.id;
  }
  if (!actions.length || !assertions.length) throw new AddScenarioInterpretationDraftError('The reviewed interpretation must contain at least one action and one assertion.');
  const mode = normalized.session?.mode === 'continue_from_previous_case' || predecessorCaseId ? 'continue_from_case' : 'fresh';
  const compactPlan = {
    version: 'AddScenarioSemanticPlanV1',
    cases: [{
      key: 'case-reviewed-interpretation',
      name: clean(normalized.title) || 'Reviewed Add Scenario flow',
      intent: clean(normalized.intentSummary) || 'Execute the reviewed user-authored flow.',
      initialState: clean(normalized.session?.initialState) || 'The authored starting state is available.',
      expectedFinalState: clean(normalized.session?.finalState) || 'The authored final state is verified.',
      session: { mode, ...(mode === 'continue_from_case' ? { predecessorCaseId: predecessorCaseId || normalized.session?.predecessorCaseId } : {}) },
      dependencies: mode === 'continue_from_case' && (predecessorCaseId || normalized.session?.predecessorCaseId) ? [predecessorCaseId || normalized.session.predecessorCaseId] : [],
      failurePolicy: { default: 'stop_descendants', onActionFailure: 'stop_descendants', onAssertionFailure: 'continue_independent' },
      actions,
      assertions,
    }],
  };
  let envelope;
  try {
    envelope = semanticProjector.projectSemanticPlan(compactPlan, {
      sourceText,
      reviewedInterpretation: true,
      userApproved: true,
    });
  } catch (error) {
    throw new AddScenarioInterpretationDraftError(error.message, projectionFindings(error));
  }
  const validation = semanticValidator.validateSemanticCaseContract(envelope, { sourceText, maxSteps: 100 });
  if (validation.ok !== true || !validation.contract) {
    throw new AddScenarioInterpretationDraftError(
      'The reviewed interpretation failed strict semantic validation.',
      Array.isArray(validation.findings) ? validation.findings : [],
    );
  }
  return {
    sourceCompleteness: envelope.sourceCompleteness || { complete: true, valid: true, findings: [] },
    authoritativeSourceText: sourceText,
    caseContractV1: validation.contract,
    approvalDiagnostics: [
      ...(Array.isArray(envelope.approvalDiagnostics) ? envelope.approvalDiagnostics : []),
      ...(Array.isArray(validation.findings) ? validation.findings : []),
    ],
  };
}

module.exports = {
  AddScenarioInterpretationDraftError,
  createSemanticPlanFromInterpretation,
  _private: { sourceClauses, actionFragment, findSourceQuote, inferTarget, selectionCriteria, comparatorFor, collectionExpected, temporalOperands, projectionFindings, EFFECT_ORACLE_ACTION_TYPES },
};
