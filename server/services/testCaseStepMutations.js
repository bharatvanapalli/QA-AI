'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { decodeJson, encodeJson } = require('./jsonField');
const { MAX_AUTHORED_CASE_STEPS } = require('../lib/stepShape');

const MAX_AUTHORED_TEXT_LENGTH = 16_000;
const MAX_STEP_PAYLOAD_BYTES = 128 * 1024;
const MAX_UNDO_SNAPSHOT_BYTES = 512 * 1024;

const ACTION_RULES = [
  { pattern: /^\s*(?:navigate\s+back|go\s+back)\b/i, action: 'GoBack' },
  { pattern: /^\s*(?:navigate\s+forward|go\s+forward)\b/i, action: 'GoForward' },
  { pattern: /^\s*(?:refresh|reload)\b/i, action: 'Refresh' },
  { pattern: /^\s*(?:navigate|go\s+to|visit|load)\b/i, action: 'Navigate' },
  { pattern: /^\s*open\b/i, action: 'Open' },
  // Specific mouse click rules before generic Click
  { pattern: /^\s*(?:right\s*click|context\s*menu)\b/i, action: 'RightClick' },
  { pattern: /^\s*(?:middle\s*click|aux\s*click)\b/i, action: 'MiddleClick' },
  { pattern: /^\s*(?:click\s*and\s*hold|hold\s+button|long\s*press|press\s*and\s*hold)\b/i, action: 'ClickAndHold' },
  // PressKey & Hotkey before generic Click
  { pattern: /^\s*(?:press\s+shortcut|hotkey|press\s+combination|key\s+combination)\b/i, action: 'Hotkey' },
  { pattern: /^\s*press\s+(?:the\s+)?(?:tab|enter|escape|backspace|delete|arrowup|arrowdown|arrowleft|arrowright|arrow\s+\w+|control|alt|shift|space|home|end|pageup|pagedown|page\s+up|page\s+down|f\d{1,2})\b/i, action: 'PressKey' },
  // Dialog / Alert handling
  { pattern: /^\s*(?:accept\s+(?:the\s+)?alert|confirm\s+(?:the\s+)?alert|ok\s+(?:the\s+)?alert)\b/i, action: 'AcceptAlert' },
  { pattern: /^\s*(?:dismiss\s+(?:the\s+)?alert|cancel\s+(?:the\s+)?alert)\b/i, action: 'DismissAlert' },
  { pattern: /^\s*(?:type|enter|input)\s+into\s+(?:the\s+)?(?:prompt|alert)\b/i, action: 'TypeAlert' },
  // Clipboard & Data
  { pattern: /^\s*(?:copy|copy\s+to\s+clipboard)\b/i, action: 'Copy' },
  { pattern: /^\s*(?:paste|paste\s+from\s+clipboard)\b/i, action: 'Paste' },
  { pattern: /^\s*(?:extract\s+data|extract|save\s+to\s+variable|store\s+variable|record)\b/i, action: 'ExtractData' },
  // Frame, Shadow DOM & Tab switching
  { pattern: /^\s*(?:switch\s+to\s+tab|switch\s+tab|switch\s+window)\b/i, action: 'SwitchTab' },
  { pattern: /^\s*(?:switch\s+to\s+frame|switch\s+frame|enter\s+iframe)\b/i, action: 'SwitchFrame' },
  { pattern: /^\s*(?:access\s+shadow|enter\s+shadow|access\s+open\s+shadow|access\s+closed\s+shadow)\b/i, action: 'AccessShadow' },
  // Inputs & Actions
  { pattern: /^\s*append\b/i, action: 'Type' },
  { pattern: /^\s*clear\s+and\s+(?:type|enter|fill)\b/i, action: 'ClearAndType' },
  { pattern: /^\s*clear\b/i, action: 'Clear' },
  { pattern: /^\s*(?:drag\s+and\s+drop|drag)\b/i, action: 'DragAndDrop' },
  { pattern: /^\s*(?:set\s+slider|adjust\s+slider|slide)\b/i, action: 'Slider' },
  { pattern: /^\s*(?:enter|fill|type|input|provide|populate)\b/i, action: 'Fill' },
  { pattern: /^\s*deselect\b/i, action: 'Deselect' },
  { pattern: /^\s*(?:select|choose|pick)\b/i, action: 'Select' },
  { pattern: /^\s*uncheck\b/i, action: 'Uncheck' },
  { pattern: /^\s*check\b/i, action: 'Check' },
  { pattern: /^\s*(?:click|press|tap|submit)\b/i, action: 'Click' },
  { pattern: /^\s*upload\b/i, action: 'Upload' },
  { pattern: /^\s*download\b/i, action: 'Download' },
  { pattern: /^\s*(?:wait|pause)\b/i, action: 'Wait' },
  { pattern: /^\s*hover\b/i, action: 'Hover' },
  { pattern: /^\s*(?:scroll\s+into\s+view|scroll\s+to)\b/i, action: 'ScrollIntoView' },
  { pattern: /^\s*scroll\b/i, action: 'Scroll' },
  { pattern: /^\s*expand\b/i, action: 'Expand' },
  { pattern: /^\s*collapse\b/i, action: 'Collapse' },
  // Table operations
  { pattern: /^\s*(?:find\s+row|locate\s+row)\b/i, action: 'FindRow' },
  { pattern: /^\s*(?:count\s+rows|count\s+visible)\b/i, action: 'CountRows' },
  { pattern: /^\s*(?:sort|click\s+header)\b/i, action: 'SortColumn' },
  { pattern: /^\s*(?:verify|validate|assert|expect|confirm|ensure)\b/i, action: 'Verify' },
];

const VERIFICATION_SPLIT = /\s+(?:(?:and\s+)?then\s+|and\s+)(?=(?:verify|validate|assert|expect|confirm|ensure)\b)/i;

class StepMutationError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'StepMutationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details = null) {
  throw new StepMutationError(status, code, message, details);
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function boundedString(value, limit = 500) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function technicalClone(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (_) {
    fail(400, 'MALFORMED_STEP', 'The step payload must be valid JSON.');
  }
  if (!json || json.length > MAX_STEP_PAYLOAD_BYTES) {
    fail(400, 'STEP_PAYLOAD_TOO_LARGE', `A step payload is limited to ${MAX_STEP_PAYLOAD_BYTES} bytes.`);
  }
  return JSON.parse(json);
}

function decodePersistedSteps(value) {
  let decoded = decodeJson(value, []);
  if (typeof decoded === 'string') decoded = decodeJson(decoded, []);
  if (!Array.isArray(decoded)) return [];
  return decoded.filter((step) => step && typeof step === 'object' && !Array.isArray(step));
}

function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

function stepIdentity(step) {
  return boundedString(
    step?.id || step?.contractStepId || step?.contract_step_id || step?.stepId || step?.step_id,
    180,
  );
}

function logicalIdentity(step) {
  return boundedString(step?.logicalStepId || step?.logical_step_id, 180);
}

function ensureStableSteps(value) {
  const source = decodePersistedSteps(value);
  const seenStepIds = new Set();
  const logicalByLegacyKey = new Map();
  return source.map((raw, index) => {
    const step = technicalClone(raw);
    let id = stepIdentity(step);
    if (!id || seenStepIds.has(id)) id = newId('step');
    seenStepIds.add(id);

    const explicitLogicalId = logicalIdentity(step);
    const legacyLogicalKey = boundedString(
      step.sourceContractStepId || step.sourceStepId || step.logicalOrdinal,
      180,
    );
    let logicalStepId = explicitLogicalId;
    if (!logicalStepId && legacyLogicalKey && logicalByLegacyKey.has(legacyLogicalKey)) {
      logicalStepId = logicalByLegacyKey.get(legacyLogicalKey);
    }
    if (!logicalStepId) logicalStepId = id;
    if (legacyLogicalKey) logicalByLegacyKey.set(legacyLogicalKey, logicalStepId);

    return {
      ...step,
      id,
      contractStepId: boundedString(step.contractStepId || step.contract_step_id, 180) || id,
      logicalStepId,
      order: Number.isFinite(Number(step.order)) ? Number(step.order) : index + 1,
    };
  });
}

function groupLogicalSteps(stepsInput) {
  const steps = ensureStableSteps(stepsInput);
  const groups = [];
  const byId = new Map();
  for (const step of steps) {
    const logicalStepId = step.logicalStepId;
    let group = byId.get(logicalStepId);
    if (!group) {
      group = { logicalStepId, steps: [] };
      byId.set(logicalStepId, group);
      groups.push(group);
    }
    group.steps.push(step);
  }
  return groups;
}

function composeAuthoredText(step) {
  const action = boundedString(step?.action, 160) || 'Perform';
  const target = boundedString(step?.element || step?.target, 500);
  const value = boundedString(step?.value, 1_000);
  const expected = boundedString(step?.expected || step?.validation, 1_000);
  let text = action;
  if (value) text += ` ${value}`;
  if (target) text += ` ${value ? 'in' : 'on'} ${target}`;
  if (expected) text += ` and verify ${expected}`;
  return text;
}

function authoredTextFrom(step, fallback = null) {
  for (const key of ['authoredText', 'instruction', 'text', 'description']) {
    if (!own(step, key)) continue;
    if (typeof step[key] !== 'string') {
      fail(400, 'MALFORMED_STEP', `${key} must be a string.`);
    }
    if (!step[key].trim()) {
      fail(400, 'EMPTY_STEP', 'A step instruction cannot be empty.');
    }
    if (step[key].length > MAX_AUTHORED_TEXT_LENGTH) {
      fail(400, 'STEP_TEXT_TOO_LONG', `A step instruction is limited to ${MAX_AUTHORED_TEXT_LENGTH} characters.`);
    }
    return step[key];
  }
  const structuredChanged = ['action', 'element', 'target', 'value', 'expected', 'validation', 'atomicActions']
    .some((key) => own(step, key));
  if (!structuredChanged && typeof fallback === 'string' && fallback.trim()) return fallback;
  if (!structuredChanged) {
    fail(400, 'EMPTY_STEP', 'Provide a step instruction or structured action.');
  }
  const composed = composeAuthoredText(step);
  if (!composed.trim()) fail(400, 'EMPTY_STEP', 'A step instruction cannot be empty.');
  return composed;
}

function splitCompoundInstruction(authoredText) {
  const match = VERIFICATION_SPLIT.exec(authoredText);
  if (!match) return [authoredText];
  const left = authoredText.slice(0, match.index).trim();
  const right = authoredText.slice(match.index + match[0].length).trim();
  return left && right ? [left, right] : [authoredText];
}

function inferAction(text, structured = {}) {
  const explicit = boundedString(structured.action, 160);
  if (explicit) return explicit;
  const rule = ACTION_RULES.find(({ pattern }) => pattern.test(text));
  if (!rule) return 'Semantic';
  if (rule.action === 'Check' && /\b(message|text|page|screen|status|result|displayed|visible|appears?)\b/i.test(text)
      && !/\b(check\s*box|checkbox|toggle)\b/i.test(text)) {
    return 'Verify';
  }
  return rule.action;
}

function stripLeadingAction(text) {
  return text
    .replace(/^\s*(?:navigate\s+back|go\s+back|navigate\s+forward|go\s+forward|refresh|reload|navigate|go\s+to|visit|load|open|right\s*click|middle\s*click|click\s*and\s*hold|hold\s+button|long\s*press|press\s+shortcut|hotkey|press\s+combination|accept\s+alert|dismiss\s+alert|type\s+into\s+prompt|copy|paste|extract\s+data|extract|save\s+to\s+variable|store\s+variable|switch\s+to\s+tab|switch\s+tab|switch\s+window|switch\s+to\s+frame|switch\s+frame|access\s+shadow|enter\s+shadow|append|clear\s+and\s+type|clear|drag\s+and\s+drop|drag|set\s+slider|adjust\s+slider|enter|fill|type|input|provide|populate|deselect|select|choose|pick|uncheck|check|click|press|tap|submit|upload|download|wait|pause|hover|scroll\s+into\s+view|scroll\s+to|scroll|expand|collapse|find\s+row|locate\s+row|count\s+rows|sort|click\s+header|verify|validate|assert|expect|confirm|ensure)\b\s*/i, '')
    .replace(/[.\s]+$/g, '')
    .trim();
}

function inferExecutionFields(text, structured = {}) {
  const action = inferAction(text, structured);
  let element = boundedString(structured.element || structured.target, 500);
  let value = structured.value;
  let expected = boundedString(structured.expected || structured.validation, 1_000);
  const rest = stripLeadingAction(text);

  if ((action === 'Fill' || action === 'Select' || action === 'ClearAndType') && !element) {
    const quoted = rest.match(/^[\"']([^\"']+)[\"']\s+(?:in|into|on|from)\s+(.+)$/i);
    const unquoted = rest.match(/^(.+?)\s+(?:in|into|on|from)\s+(.+)$/i);
    const match = quoted || unquoted;
    if (match) {
      if (value === undefined || value === null || value === '') value = match[1].trim();
      element = match[2].trim();
    }
  }
  if (!element && ['Click', 'RightClick', 'MiddleClick', 'ClickAndHold', 'Check', 'Uncheck', 'Open', 'Hover', 'Scroll', 'ScrollIntoView', 'Expand', 'Collapse', 'DragAndDrop', 'FindRow', 'SortColumn', 'AccessShadow', 'SwitchFrame'].includes(action)) {
    element = rest || null;
  }
  if ((action === 'Navigate' || action === 'SwitchTab') && (value === undefined || value === null || value === '')) {
    value = rest || null;
  }
  // PressKey & Hotkey — extract key name or shortcut combination
  if ((action === 'PressKey' || action === 'Hotkey') && (value === undefined || value === null || value === '')) {
    const keyMatch = rest.match(/(?:the\s+)?(\w+)\s*(?:key)?/i);
    value = keyMatch ? keyMatch[1] : rest || null;
  }
  // Clear — extract target field
  if (action === 'Clear' && !element) {
    const clearMatch = rest.match(/(?:the\s+)?["']([^"']+)["']/i);
    element = clearMatch ? clearMatch[1] : rest || null;
  }
  // ExtractData & TypeAlert — extract target and variable or prompt text
  if (action === 'ExtractData' && (value === undefined || value === null || value === '')) {
    value = rest || null;
  }
  if (action === 'TypeAlert' && (value === undefined || value === null || value === '')) {
    const promptMatch = rest.match(/^["']([^"']+)["']/i);
    value = promptMatch ? promptMatch[1] : rest || null;
  }
  if (action === 'Verify') {
    if (!expected) expected = rest || text.trim();
    if (!element) element = boundedString(structured.target, 500);
  }
  if (action === 'Semantic' && !element) {
    element = boundedString(text, 500);
  }

  return {
    action,
    element: element || null,
    target: element || null,
    value: value === undefined ? null : value,
    expected: expected || null,
    executionMode: action === 'Semantic' ? 'semantic' : 'structured',
  };
}

function interpretStep(input, fallbackAuthoredText = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'MALFORMED_STEP', 'step must be a JSON object.');
  }
  const step = technicalClone(input);
  const authoredText = authoredTextFrom(step, fallbackAuthoredText);
  const diagnostics = [];

  let atomicSources;
  if (Array.isArray(step.atomicActions) && step.atomicActions.length) {
    atomicSources = step.atomicActions.map((atomic) => {
      if (!atomic || typeof atomic !== 'object' || Array.isArray(atomic)) {
        fail(400, 'MALFORMED_STEP', 'Every atomicActions entry must be a JSON object.');
      }
      const clone = technicalClone(atomic);
      const atomicText = authoredTextFrom(clone, composeAuthoredText(clone));
      return { ...clone, atomicText };
    });
  } else {
    const fragments = splitCompoundInstruction(authoredText);
    if (fragments.length > 1) {
      diagnostics.push({
        code: 'compound_step_decomposed',
        level: 'info',
        message: `QAAI interpreted this logical step as ${fragments.length} execution actions.`,
      });
    }
    atomicSources = fragments.map((fragment, index) => ({
      ...(index === 0 ? step : {}),
      authoredText: fragment,
      atomicText: fragment,
      ...(index > 0 ? { action: null, element: null, target: null, value: null, expected: null } : {}),
    }));
  }

  const atomicActions = atomicSources.map((atomic) => {
    const atomicText = typeof atomic.atomicText === 'string'
      ? atomic.atomicText
      : authoredTextFrom(atomic, authoredText);
    const interpreted = inferExecutionFields(atomicText, atomic);
    if (interpreted.action === 'Semantic') {
      diagnostics.push({
        code: 'semantic_runtime_fallback',
        level: 'info',
        message: 'QAAI preserved this instruction for semantic execution against the live application.',
      });
    } else if (!interpreted.element && !['Navigate', 'Wait', 'Verify'].includes(interpreted.action)) {
      diagnostics.push({
        code: 'target_resolved_at_runtime',
        level: 'info',
        message: 'QAAI will resolve the target from the live page during execution.',
      });
    }
    return {
      ...atomic,
      ...interpreted,
      atomicText,
    };
  });

  return {
    authoredText,
    atomicActions,
    diagnostics: diagnostics.filter((item, index, all) => (
      all.findIndex((candidate) => candidate.code === item.code && candidate.message === item.message) === index
    )),
  };
}

function materializeLogicalStep(input, existingGroup = null, forcedLogicalStepId = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(400, 'MALFORMED_STEP', 'step must be a JSON object.');
  }
  const existingSteps = Array.isArray(existingGroup?.steps) ? existingGroup.steps : [];
  const existingHead = existingSteps[0] || null;
  const incoming = technicalClone(input);
  const fallbackAuthoredText = existingHead?.authoredText || existingHead?.text || null;
  const authoredCandidate = existingHead ? { ...existingHead, ...incoming } : { ...incoming };
  const incomingCarriesText = ['authoredText', 'instruction', 'text', 'description']
    .some((key) => own(incoming, key));
  if (existingHead && !incomingCarriesText) {
    delete authoredCandidate.authoredText;
    delete authoredCandidate.instruction;
    delete authoredCandidate.text;
    delete authoredCandidate.description;
  }
  const incomingChangesStructure = ['action', 'element', 'target', 'value', 'expected', 'validation', 'atomicActions']
    .some((key) => own(incoming, key));
  const authoredText = authoredTextFrom(
    incomingChangesStructure ? authoredCandidate : incoming,
    fallbackAuthoredText,
  );
  const mergedInput = existingHead
    ? { ...existingHead, ...incoming, authoredText }
    : { ...incoming, authoredText };
  if (own(incoming, 'target') && !own(incoming, 'element')) mergedInput.element = incoming.target;
  if (own(incoming, 'element') && !own(incoming, 'target')) mergedInput.target = incoming.element;
  const interpretation = interpretStep(mergedInput, fallbackAuthoredText);
  const logicalStepId = forcedLogicalStepId
    || existingGroup?.logicalStepId
    || logicalIdentity(mergedInput)
    || newId('logical');

  const rows = interpretation.atomicActions.map((atomic, index) => {
    const previous = existingSteps[index] || {};
    const id = stepIdentity(previous)
      || (index === 0 ? stepIdentity(mergedInput) : null)
      || newId('step');
    const row = {
      ...previous,
      ...atomic,
      id,
      contractStepId: boundedString(previous.contractStepId || mergedInput.contractStepId, 180) || id,
      logicalStepId,
      authoredText: interpretation.authoredText,
      atomicText: atomic.atomicText,
      source: 'user',
      authored: true,
      editedByUser: true,
      interpretation: {
        action: atomic.action,
        target: atomic.element || atomic.target || null,
        value: atomic.value === undefined ? null : atomic.value,
        expected: atomic.expected || null,
        executionMode: atomic.executionMode,
      },
    };
    delete row.atomicActions;
    delete row.instruction;
    delete row.description;
    return row;
  });

  if (rows.length) {
    rows[0].atomicActions = rows.map((row) => ({
      action: row.action,
      element: row.element || null,
      target: row.target || row.element || null,
      value: row.value === undefined ? null : row.value,
      expected: row.expected || null,
      atomicText: row.atomicText,
      executionMode: row.executionMode,
    }));
  }
  return { logicalStepId, rows, diagnostics: interpretation.diagnostics };
}

function reindexAndRepair(groups) {
  const rows = [];
  const diagnostics = [];
  let order = 1;
  const validIds = new Set(groups.flatMap((group) => group.steps.map((step) => step.id)));

  groups.forEach((group, logicalIndex) => {
    const atomicCount = group.steps.length;
    group.steps.forEach((source, atomicIndex) => {
      const step = {
        ...source,
        order,
        logicalOrdinal: logicalIndex + 1,
        atomicOrdinal: atomicIndex + 1,
        atomicCount,
      };
      const dependencies = Array.isArray(step.dependsOn)
        ? step.dependsOn
        : (typeof step.dependsOn === 'string' && step.dependsOn ? [step.dependsOn] : []);
      const filtered = dependencies.filter((id) => validIds.has(id) && id !== step.id);
      if (filtered.length !== dependencies.length) {
        const previous = rows[rows.length - 1];
        step.dependsOn = previous ? [previous.id] : [];
        diagnostics.push({
          code: 'dependency_reconnected',
          level: 'info',
          stepId: step.id,
          message: 'QAAI reconnected this step to the nearest surviving predecessor.',
        });
      } else if (Array.isArray(step.dependsOn)) {
        step.dependsOn = filtered;
      }
      rows.push(step);
      order += 1;
    });
  });
  return { steps: rows, diagnostics };
}

function summarize(stepsInput) {
  const groups = groupLogicalSteps(stepsInput);
  return {
    logicalStepCount: groups.length,
    atomicActionCount: groups.reduce((count, group) => count + group.steps.length, 0),
  };
}

function finalise(groups, diagnostics = []) {
  if (groups.length > MAX_AUTHORED_CASE_STEPS) {
    fail(
      400,
      'TOO_MANY_STEPS',
      `A test case is limited to ${MAX_AUTHORED_CASE_STEPS} logical steps.`,
      { logicalStepCount: groups.length },
    );
  }
  const reindexed = reindexAndRepair(groups);
  return {
    steps: reindexed.steps,
    ...summarize(reindexed.steps),
    diagnostics: [...diagnostics, ...reindexed.diagnostics],
  };
}

function resolveGroupIndex(groups, requestedId) {
  const id = boundedString(requestedId, 180);
  if (!id) fail(400, 'MISSING_STEP_ID', 'A stable step ID is required.');
  return groups.findIndex((group) => (
    group.logicalStepId === id
    || group.steps.some((step) => step.id === id || step.contractStepId === id)
  ));
}

function addStep(stepsInput, input, options = {}) {
  const groups = groupLogicalSteps(stepsInput);
  const materialized = materializeLogicalStep(input);
  let insertAt = groups.length;
  if (Number.isInteger(options.index)) {
    insertAt = Math.max(0, Math.min(groups.length, options.index));
  } else if (options.afterStepId) {
    const afterIndex = resolveGroupIndex(groups, options.afterStepId);
    if (afterIndex < 0) fail(409, 'STALE_STEP_ID', 'The step used as the insertion point no longer exists.');
    insertAt = afterIndex + 1;
  }
  groups.splice(insertAt, 0, { logicalStepId: materialized.logicalStepId, steps: materialized.rows });
  return {
    ...finalise(groups, materialized.diagnostics),
    changedStepId: materialized.logicalStepId,
  };
}

function editStep(stepsInput, requestedId, patch) {
  const groups = groupLogicalSteps(stepsInput);
  const index = resolveGroupIndex(groups, requestedId);
  if (index < 0) fail(409, 'STALE_STEP_ID', 'This step no longer exists. Refresh the case and try again.');
  const existing = groups[index];
  const materialized = materializeLogicalStep(patch, existing, existing.logicalStepId);
  groups[index] = { logicalStepId: existing.logicalStepId, steps: materialized.rows };
  return {
    ...finalise(groups, materialized.diagnostics),
    changedStepId: existing.logicalStepId,
  };
}

function removeStep(stepsInput, requestedId) {
  const groups = groupLogicalSteps(stepsInput);
  const index = resolveGroupIndex(groups, requestedId);
  if (index < 0) fail(409, 'STALE_STEP_ID', 'This step no longer exists. Refresh the case and try again.');
  const [removed] = groups.splice(index, 1);
  return {
    ...finalise(groups),
    changedStepId: removed.logicalStepId,
    removedStep: {
      logicalStepId: removed.logicalStepId,
      authoredText: removed.steps[0]?.authoredText || null,
      atomicActionCount: removed.steps.length,
    },
  };
}

function reorderSteps(stepsInput, requestedIds) {
  if (!Array.isArray(requestedIds)) {
    fail(400, 'MALFORMED_STEP_ORDER', 'stepIds must be an array of stable logical step IDs.');
  }
  const groups = groupLogicalSteps(stepsInput);
  if (requestedIds.length !== groups.length) {
    fail(409, 'STALE_STEP_ORDER', 'The submitted step order does not match the current logical step count.');
  }
  const resolved = requestedIds.map((id) => {
    const index = resolveGroupIndex(groups, id);
    if (index < 0) fail(409, 'STALE_STEP_ID', `Step "${id}" no longer exists.`);
    return index;
  });
  if (new Set(resolved).size !== groups.length) {
    fail(400, 'DUPLICATE_STEP_ID', 'Each logical step must appear exactly once in stepIds.');
  }
  return finalise(resolved.map((index) => groups[index]));
}

function stepsHash(stepsInput) {
  return createHash('sha256').update(JSON.stringify(decodePersistedSteps(stepsInput))).digest('hex');
}

function undoSnapshotFor(stepsInput) {
  const steps = decodePersistedSteps(stepsInput);
  const json = JSON.stringify(steps);
  return json.length <= MAX_UNDO_SNAPSHOT_BYTES ? steps : null;
}

async function persistMutation({
  prisma,
  projectId,
  testCaseId,
  type,
  stepId = null,
  step = null,
  stepIds = null,
  index = null,
  afterStepId = null,
  expectedStepsHash = null,
}) {
  if (!prisma || !projectId || !testCaseId) {
    fail(400, 'MALFORMED_MUTATION', 'projectId and testCaseId are required.');
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.testCase.findFirst({ where: { id: testCaseId, projectId } });
    if (!current) fail(404, 'NOT_FOUND', 'Test case not found.');

    const beforeSteps = decodePersistedSteps(current.steps);
    const beforeHash = stepsHash(beforeSteps);
    if (expectedStepsHash && expectedStepsHash !== beforeHash) {
      fail(409, 'STALE_STEP_VERSION', 'The case changed after it was opened. Refresh it and retry the edit.');
    }

    let result;
    if (type === 'add') result = addStep(beforeSteps, step, { index, afterStepId });
    else if (type === 'edit') result = editStep(beforeSteps, stepId, step);
    else if (type === 'remove') result = removeStep(beforeSteps, stepId);
    else if (type === 'reorder') result = reorderSteps(beforeSteps, stepIds);
    else fail(400, 'UNKNOWN_STEP_MUTATION', 'Unknown step mutation.');

    const encodedSteps = encodeJson(result.steps);
    const updatedCount = await tx.testCase.updateMany({
      where: { id: current.id, projectId, steps: current.steps },
      data: {
        steps: encodedSteps,
        // A source-level edit invalidates generated code. Execution state and
        // approval remain authorized; active runs must use their run-start snapshot.
        specCode: null,
      },
    });
    if (updatedCount.count !== 1) {
      fail(409, 'STALE_STEP_VERSION', 'The case changed while this edit was being saved. Refresh and retry.');
    }
    const updated = await tx.testCase.findUnique({ where: { id: current.id } });
    return {
      ...result,
      testCase: updated,
      beforeSteps,
      beforeHash,
      afterHash: stepsHash(result.steps),
      undoSnapshot: undoSnapshotFor(beforeSteps),
      mutationId: newId('step_mutation'),
      appliesTo: 'next_execution',
    };
  });
}

async function restoreSteps({
  prisma,
  projectId,
  testCaseId,
  previousSteps,
  expectedStepsHash,
}) {
  if (!Array.isArray(previousSteps)) {
    fail(404, 'NO_UNDO_AVAILABLE', 'No previous step version is available.');
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.testCase.findFirst({ where: { id: testCaseId, projectId } });
    if (!current) fail(404, 'NOT_FOUND', 'Test case not found.');
    const currentHash = stepsHash(current.steps);
    if (expectedStepsHash && currentHash !== expectedStepsHash) {
      fail(409, 'STALE_UNDO', 'The case has changed since that edit and cannot be undone automatically.');
    }
    const restored = finalise(groupLogicalSteps(previousSteps));
    const result = await tx.testCase.updateMany({
      where: { id: current.id, projectId, steps: current.steps },
      data: { steps: encodeJson(restored.steps), specCode: null },
    });
    if (result.count !== 1) {
      fail(409, 'STALE_UNDO', 'The case changed while the undo was being applied.');
    }
    const updated = await tx.testCase.findUnique({ where: { id: current.id } });
    return {
      ...restored,
      testCase: updated,
      beforeSteps: decodePersistedSteps(current.steps),
      beforeHash: currentHash,
      afterHash: stepsHash(restored.steps),
      mutationId: newId('step_undo'),
      appliesTo: 'next_execution',
    };
  });
}

module.exports = {
  MAX_AUTHORED_TEXT_LENGTH,
  MAX_STEP_PAYLOAD_BYTES,
  MAX_UNDO_SNAPSHOT_BYTES,
  StepMutationError,
  decodePersistedSteps,
  ensureStableSteps,
  groupLogicalSteps,
  interpretStep,
  addStep,
  editStep,
  removeStep,
  reorderSteps,
  summarize,
  stepsHash,
  undoSnapshotFor,
  persistMutation,
  restoreSteps,
};
