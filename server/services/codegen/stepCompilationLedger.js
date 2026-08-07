'use strict';

const ACTION_VERB = {
  fill: 'fill',
  type: 'fill',
  click: 'click',
  doubleClick: 'doubleClick',
  tripleClick: 'tripleClick',
  selectOption: 'select',
  check: 'check',
  uncheck: 'uncheck',
  press: 'press',
  hover: 'hover',
  drag: 'drag',
  upload: 'upload',
};

const ACTION_VOCABULARY = Object.freeze([
  'navigate', 'navigateBack', 'navigateForward', 'reload',
  'click', 'doubleClick', 'tripleClick',
  'fill', 'type', 'selectOption', 'press', 'hover', 'drag', 'upload',
  'check', 'uncheck', 'handleDialog', 'resize', 'close', 'waitFor',
]);

const TARGETLESS_ACTIONS = new Set([
  'navigate', 'navigateBack', 'navigateForward', 'reload', 'handleDialog', 'resize', 'close',
]);

const ROLE_SUFFIXES_STRIP = [
  'Input', 'SearchInput', 'Button', 'Link', 'MenuItem', 'Tab', 'Checkbox',
  'Radio', 'Select', 'Option', 'Heading', 'Image', 'Element',
];

function clean(value, limit = 500) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return limit && text.length > limit ? text.slice(0, limit) : text;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch (_) { return fallback; }
}

function stripRoleSuffix(name) {
  const raw = String(name || '');
  for (const suffix of ROLE_SUFFIXES_STRIP) {
    if (raw.endsWith(suffix) && raw.length > suffix.length) return raw.slice(0, -suffix.length);
  }
  return raw;
}

function toCamelName(value) {
  const words = String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((word, index) => {
    const lower = word.charAt(0).toLowerCase() + word.slice(1);
    return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join('');
}

function selectorText(value) {
  const match = String(value || '').match(/getBy(?:Text|Role|Label|Placeholder)\(\s*["']([^"']+)["']/i);
  return match ? match[1] : String(value || '');
}

function legacyInlineLocatorKey(resolveStep) {
  const candidates = Array.isArray(resolveStep && resolveStep.candidates) ? resolveStep.candidates : [];
  const candidate = candidates.find((item) => item && (item.name || item.text || item.testId || item.selector));
  if (!candidate) return null;
  const label = selectorText(candidate.name || candidate.text || candidate.testId || candidate.selector);
  const role = String(candidate.role || '').toLowerCase();
  const base = toCamelName(label);
  if (!base) return null;
  if (role === 'textbox' || role === 'searchbox') return `${base}Textbox`;
  if (role === 'button') return `${base}Button`;
  if (role === 'link') return `${base}Link`;
  return base;
}

function legacyInlineLocatorKeys(resolveStep, action) {
  const candidates = Array.isArray(resolveStep && resolveStep.candidates) ? resolveStep.candidates : [];
  const candidate = candidates.find((item) => item && (item.name || item.text || item.testId || item.selector));
  if (!candidate) return [];
  const rawLabel = selectorText(candidate.name || candidate.text || candidate.testId || candidate.selector);
  const strippedLabel = rawLabel
    .replace(/\bmenu item\b/ig, '')
    .replace(/\bmenu\b/ig, '')
    .replace(/\bbutton\b/ig, '')
    .trim();
  const base = toCamelName(strippedLabel || rawLabel);
  const direct = legacyInlineLocatorKey(resolveStep);
  const keys = [direct, base];
  if (base && String(action || '').toLowerCase() === 'click') {
    keys.push(`${base}Button`, `${base}Menuitem`, `${base}MenuItem`, `${base}Link`);
  }
  return Array.from(new Set(keys.filter(Boolean)));
}

function methodNameFor(action, locatorName) {
  const verb = ACTION_VERB[action] || action || 'act';
  const base = stripRoleSuffix(locatorName || 'Element');
  return verb + base.charAt(0).toUpperCase() + base.slice(1);
}

function sourceLineOf(text, index) {
  if (!text || index == null || index < 0) return null;
  return String(text).slice(0, index).split(/\r?\n/).length;
}

function normalizePlannedSteps(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((step, index) => {
    if (typeof step === 'string') {
      return {
        plannedStepId: `planned-${index + 1}`,
        plannedOrdinal: index + 1,
        contractStepId: null,
        authoredActionId: null,
        sequenceIndex: index + 1,
        operation: null,
        plannedText: clean(step),
        raw: step,
      };
    }
    const obj = step && typeof step === 'object' ? step : {};
    const stableStepId = clean(obj.id || obj.stepId || obj.plannedStepId || obj.contractStepId || '', 120) || null;
    const text = clean(
      obj.text || obj.step || obj.description || obj.expected || obj.name || obj.title ||
      [obj.action, obj.target || obj.element || obj.field].filter(Boolean).join(' ')
    );
    return {
      plannedStepId: stableStepId || clean(obj.order || `planned-${index + 1}`, 120),
      plannedOrdinal: index + 1,
      stableStepId,
      contractStepId: clean(obj.contractStepId || obj.stepId || obj.id, 120) || null,
      authoredActionId: clean(obj.actionIdentity && obj.actionIdentity.authoredActionId || obj.authoredActionId || obj.actionId, 180) || null,
      sequenceIndex: Number.isFinite(Number((obj.actionIdentity && obj.actionIdentity.sequenceIndex) ?? obj.sequenceIndex ?? obj.actionSequenceIndex ?? obj.order))
        ? Number((obj.actionIdentity && obj.actionIdentity.sequenceIndex) ?? obj.sequenceIndex ?? obj.actionSequenceIndex ?? obj.order)
        : index + 1,
      toolUseId: clean(obj.actionIdentity && obj.actionIdentity.toolUseId || obj.toolUseId, 180) || null,
      toolName: clean(obj.actionIdentity && obj.actionIdentity.toolName || obj.toolName || obj.tool, 120) || null,
      operation: clean(obj.actionIdentity && obj.actionIdentity.operation || obj.operation || obj.action || obj.type, 80) || null,
      plannedText: text || `Planned step ${index + 1}`,
      dataBinding: obj.dataBinding || obj.data || obj.bindings || null,
      raw: obj,
    };
  });
}

function replayBusinessSteps(ir) {
  const steps = Array.isArray(ir && ir.steps) ? ir.steps : [];
  const projectedAssertionKeys = new Set(steps
    .filter((step) => step && step.op === 'act' && (
      String(step.action || '').toLowerCase() === 'customaction'
      || /\b(?:verify|assert|validate|confirm|check)\b/i.test(clean(
        step.authoredOperation || step.operation || step.instruction || step.description || '',
        240,
      ))
    ))
    .flatMap((step) => [step.contractStepId, step.sourceContractStepId, step.stepId]
      .map(normalizeContractIdentity)
      .filter(Boolean)));
  const resolveByAs = new Map();
  const out = [];
  const occurrenceBySemanticAction = new Map();
  let sequenceIndex = 0;
  const semanticResolveLabel = (resolve) => {
    const candidate = Array.isArray(resolve && resolve.candidates) ? resolve.candidates.find(Boolean) : null;
    return clean(
      resolve && (resolve.elementLabel || resolve.label || resolve.narration)
        || candidate && (candidate.name || candidate.text || candidate.testId || candidate.selector),
      180
    ).toLowerCase();
  };
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    if (step.op === 'resolve' && step.as) {
      resolveByAs.set(step.as, step);
      continue;
    }
    if (step.op === 'act') {
      sequenceIndex += 1;
      const resolveStep = step.target ? resolveByAs.get(step.target) : null;
      const semanticKey = `${step.action || 'act'}|${semanticResolveLabel(resolveStep) || step.target || step.url || 'page'}`;
      const occurrenceIndex = (occurrenceBySemanticAction.get(semanticKey) || 0) + 1;
      occurrenceBySemanticAction.set(semanticKey, occurrenceIndex);
      out.push({ replayIndex: i, kind: 'action', step, resolveStep, sequenceIndex, occurrenceIndex, semanticKey });
      continue;
    }
    if (step.op === 'assert') {
      const projectionKey = normalizeContractIdentity(step.contractRef || step.contractStepId || step.sourceContractStepId);
      if (projectionKey && projectedAssertionKeys.has(projectionKey)) continue;
      sequenceIndex += 1;
      out.push({ replayIndex: i, kind: 'assertion', step, sequenceIndex, occurrenceIndex: 1 });
      continue;
    }
    if (step.op === 'waitFor' && step.authored !== false) {
      sequenceIndex += 1;
      const target = step.target || step.condition && step.condition.target || null;
      const resolveStep = target ? resolveByAs.get(target) : null;
      out.push({ replayIndex: i, kind: 'wait', step, resolveStep, sequenceIndex, occurrenceIndex: 1 });
      continue;
    }
    if (step.op === 'humanInput') {
      out.push({ replayIndex: i, kind: 'human_input', step });
    }
  }
  return out;
}

function fileForTestCase(admitted, testCaseId) {
  for (const item of admitted || []) {
    const ids = Array.isArray(item && item.testCaseIds) ? item.testCaseIds : [item && item.testCaseId];
    if (ids.includes(testCaseId)) return item.filePath || null;
  }
  return null;
}

function blockedForTestCase(blocked, testCaseId) {
  return (blocked || []).find((item) => item && item.testCaseId === testCaseId) || null;
}

function manifestEntries(files) {
  const parsed = parseJson(files && files['evidence/locator-manifest.json'], []);
  return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
}

function pomSpecPlan(files) {
  const report = parseJson(files && files['evidence/pom-architect-report.json'], {});
  return Array.isArray(report && report.specPlan) ? report.specPlan.filter(Boolean) : [];
}

function normalizeContractIdentity(value) {
  const raw = clean(value, 180).toLowerCase();
  const authoredOrdinal = raw.match(/(?:^|[:_-])step(?:[:_-])?(\d+)(?:[:_-]|$)/i);
  if (authoredOrdinal) return `step${authoredOrdinal[1]}`;
  const normalized = raw.replace(/[^a-z0-9]+/g, '');
  return normalized.replace(/^case(?=step\d+$)/, '');
}

function pomPlanProof({ replay, plannedStep, testCaseId, plan, files, specFile }) {
  if (!replay || !replay.step || !Array.isArray(plan) || !plan.length || !specFile) return null;
  const step = replay.step;
  const authoredActionIds = [
    step.authoredActionId,
    step.actionIdentity && step.actionIdentity.authoredActionId,
    plannedStep && plannedStep.authoredActionId,
  ].map((value) => clean(value, 180)).filter(Boolean);
  const occurrenceKeys = [
    step.occurrenceKey,
    step.actionIdentity && step.actionIdentity.occurrenceKey,
  ].map((value) => clean(value, 220)).filter(Boolean);
  const contractIds = [
    step.contractStepId,
    step.sourceContractStepId,
    step.contractRef,
    step.stepId,
    plannedStep && plannedStep.contractStepId,
    plannedStep && plannedStep.plannedStepId,
  ].map(normalizeContractIdentity).filter(Boolean);
  const candidates = plan.filter((entry) => !testCaseId || !entry.testCaseId || entry.testCaseId === testCaseId);
  const match = candidates.find((entry) => authoredActionIds.includes(clean(entry.authoredActionId, 180)))
    || candidates.find((entry) => occurrenceKeys.includes(clean(entry.occurrenceKey, 220)))
    || candidates.find((entry) => contractIds.includes(normalizeContractIdentity(entry.contractStepId)));
  if (!match || !match.emittedSource) return null;
  const line = lineForNeedle(files, specFile, [String(match.emittedSource).trim()]);
  if (!line) return null;
  return { entry: match, line };
}

function manifestByResolveAs(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    if (!entry || !entry.as) continue;
    if (!map.has(entry.as)) map.set(entry.as, []);
    map.get(entry.as).push(entry);
  }
  return map;
}

function nextManifestForAs(map, as) {
  const list = map && map.get(as);
  return Array.isArray(list) && list.length ? list[0] : null;
}

function lineForNeedle(files, rel, needles) {
  const text = files && rel ? String(files[rel] || '') : '';
  if (!text) return null;
  for (const needle of needles || []) {
    if (!needle) continue;
    const idx = text.indexOf(needle);
    if (idx >= 0) return sourceLineOf(text, idx);
  }
  return null;
}

function textForFile(files, rel) {
  return files && rel ? String(files[rel] || '') : '';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function codeIdentifier(value) {
  const out = String(value || '')
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => index === 0
      ? part.charAt(0).toLowerCase() + part.slice(1)
      : part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  if (!out) return null;
  return /^[A-Za-z_$]/.test(out) ? out : `v${out}`;
}

function stripInlineJsComment(value) {
  const text = String(value || '');
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length - 1; index += 1) {
    const ch = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && (text[index + 1] === '/' || text[index + 1] === '*')) return text.slice(0, index);
  }
  return text;
}

function executableSourceLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  let inBlockComment = false;
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const code = stripInlineJsComment(raw);
    const trimmed = code.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (!trimmed) continue;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (/^(?:\/\/|#|\*)/.test(trimmed)) continue;
    if (/^throw\b/.test(trimmed)) continue;
    out.push({ text: code, line: index + 1 });
  }
  return out;
}

function lineForPatterns(files, rel, patterns) {
  const source = textForFile(files, rel);
  if (!source) return null;
  const list = (patterns || []).filter((pattern) => pattern instanceof RegExp);
  if (!list.length) return null;
  for (const entry of executableSourceLines(source)) {
    if (list.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(entry.text);
    })) return entry.line;
  }
  return null;
}

function lineForPatternsOccurrence(files, rel, patterns, occurrence = 1) {
  const source = textForFile(files, rel);
  if (!source) return null;
  const list = (patterns || []).filter((pattern) => pattern instanceof RegExp);
  if (!list.length) return null;
  const wanted = Number.isFinite(Number(occurrence)) && Number(occurrence) > 0 ? Math.floor(Number(occurrence)) : 1;
  let matched = 0;
  for (const entry of executableSourceLines(source)) {
    if (list.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(entry.text);
    })) {
      matched += 1;
      if (matched === wanted) return entry.line;
    }
  }
  return null;
}

function adapterFamily(adapterId) {
  const id = String(adapterId || '').toLowerCase();
  if (id.includes('bdd')) return 'bdd';
  if (id.includes('selenium') && id.includes('pom')) return 'selenium-pom';
  if (id.includes('selenium')) return 'selenium';
  if (id.includes('pom')) return 'playwright-pom';
  return 'playwright';
}

function receiverPattern(values) {
  const identifiers = Array.from(new Set((values || [])
    .map(codeIdentifier)
    .filter(Boolean)));
  if (!identifiers.length) return '[A-Za-z_$][\\w$]*';
  return `(?:${identifiers.map((value) => `\\b${escapeRegex(value)}\\b`).join('|')})`;
}

function bddActionPatterns(action) {
  const prefix = '(?:Given|When|Then|And|But)\\s+';
  const patterns = {
    navigate: 'I\\s+open\\s+',
    navigateBack: 'I\\s+go\\s+back\\b',
    navigateForward: 'I\\s+go\\s+forward\\b',
    reload: 'I\\s+reload\\s+(?:the\\s+)?page\\b',
    click: 'I\\s+click\\s+',
    doubleClick: 'I\\s+double[- ]?click\\s+',
    tripleClick: 'I\\s+triple[- ]?click\\s+',
    fill: 'I\\s+fill\\s+',
    type: 'I\\s+fill\\s+',
    selectOption: 'I\\s+select(?:\\s+(?:option|env|value))?\\s+',
    check: 'I\\s+check\\s+',
    uncheck: 'I\\s+uncheck\\s+',
    press: 'I\\s+press\\s+',
    hover: 'I\\s+hover\\s+',
    drag: 'I\\s+drag\\s+',
    upload: 'I\\s+upload\\s+',
    waitFor: 'I\\s+wait\\s+for\\s+',
    handleDialog: 'I\\s+(?:accept|dismiss|handle)\\s+(?:the\\s+)?dialog\\b',
    resize: 'I\\s+resize\\s+',
    close: 'I\\s+close\\s+',
  };
  return patterns[action] ? [new RegExp(prefix + patterns[action], 'i')] : [];
}

function targetlessActionPatterns(action, family) {
  if (family === 'bdd') return bddActionPatterns(action);
  if (family === 'selenium' || family === 'selenium-pom') {
    const patterns = {
      navigate: /\bdriver\.get\s*\(/,
      navigateBack: /\bdriver\.navigate\s*\(\s*\)\.back\s*\(/,
      navigateForward: /\bdriver\.navigate\s*\(\s*\)\.forward\s*\(/,
      reload: /\bdriver\.navigate\s*\(\s*\)\.refresh\s*\(/,
      handleDialog: /(?:driver\.switchTo\s*\(\s*\)\.alert\s*\(\s*\).*\.(?:accept|dismiss|sendKeys)\s*\(|\b(?:alert|dialog)\.(?:accept|dismiss|sendKeys)\s*\()/,
      resize: /\bdriver\.manage\s*\(\s*\)\.window\s*\(\s*\)\.setSize\s*\(/,
      close: /\bdriver\.close\s*\(/,
    };
    return patterns[action] ? [patterns[action]] : [];
  }
  const patterns = {
    navigate: /\bpage\.goto\s*\(/,
    navigateBack: /\bpage\.goBack\s*\(/,
    navigateForward: /\bpage\.goForward\s*\(/,
    reload: /\bpage\.reload\s*\(/,
    handleDialog: /\bpage\.(?:once|on)\s*\(\s*['"]dialog['"]\s*,/,
    resize: /\bpage\.setViewportSize\s*\(/,
    close: /\bpage\.close\s*\(/,
  };
  return patterns[action] ? [patterns[action]] : [];
}

function playwrightActionPatterns(action, receiver) {
  const patterns = {
    fill: new RegExp(`${receiver}\\.fill\\s*\\(`),
    type: new RegExp(`${receiver}\\.fill\\s*\\(`),
    click: new RegExp(`${receiver}\\.click\\s*\\((?![^)]*clickCount)`),
    doubleClick: new RegExp(`${receiver}\\.dblclick\\s*\\(`),
    tripleClick: new RegExp(`${receiver}\\.click\\s*\\([^)]*clickCount\\s*:\\s*3`),
    selectOption: new RegExp(`${receiver}\\.selectOption\\s*\\(`),
    check: new RegExp(`${receiver}\\.check\\s*\\(`),
    uncheck: new RegExp(`${receiver}\\.uncheck\\s*\\(`),
    press: new RegExp(`${receiver}\\.press\\s*\\(`),
    hover: new RegExp(`${receiver}\\.hover\\s*\\(`),
    drag: new RegExp(`${receiver}\\.dragTo\\s*\\(`),
    upload: new RegExp(`${receiver}\\.setInputFiles\\s*\\(`),
    waitFor: new RegExp(`${receiver}\\.waitFor\\s*\\(`),
  };
  return patterns[action] ? [patterns[action]] : [];
}

function seleniumActionPatterns(action, receiver) {
  const patterns = {
    fill: new RegExp(`${receiver}\\.clear\\s*\\(`),
    type: new RegExp(`${receiver}\\.clear\\s*\\(`),
    click: new RegExp(`${receiver}\\.click\\s*\\(`),
    doubleClick: new RegExp(`\\.doubleClick\\s*\\(\\s*${receiver}`),
    tripleClick: new RegExp(`\\.click\\s*\\(\\s*${receiver}\\s*\\).*\\.click\\s*\\(\\s*${receiver}\\s*\\).*\\.click\\s*\\(\\s*${receiver}`),
    selectOption: new RegExp(`new\\s+Select\\s*\\(\\s*${receiver}\\s*\\)\\.selectBy`),
    check: new RegExp(`if\\s*\\(\\s*!\\s*${receiver}\\.isSelected\\s*\\(`),
    uncheck: new RegExp(`if\\s*\\(\\s*${receiver}\\.isSelected\\s*\\(`),
    press: new RegExp(`${receiver}\\.sendKeys\\s*\\(`),
    hover: new RegExp(`\\.moveToElement\\s*\\(\\s*${receiver}`),
    drag: new RegExp(`\\.dragAndDrop\\s*\\(\\s*${receiver}\\s*,`),
    upload: new RegExp(`${receiver}\\.sendKeys\\s*\\(`),
    waitFor: new RegExp(`ExpectedConditions\\.(?:visibilityOf|presenceOfElementLocated)\\s*\\(\\s*${receiver}`),
  };
  return patterns[action] ? [patterns[action]] : [];
}

function actionProof({ step, files, specFile, adapterId, locatorKey, pageMethod, inlineKeys, occurrenceIndex = 1 }) {
  const action = String(step && step.action || '');
  const family = adapterFamily(adapterId);
  if (!ACTION_VOCABULARY.includes(action)) return { line: null, method: null };
  if (TARGETLESS_ACTIONS.has(action)) {
    return { line: lineForPatternsOccurrence(files, specFile, targetlessActionPatterns(action, family), occurrenceIndex), method: null };
  }
  if (family === 'bdd') {
    return { line: lineForPatternsOccurrence(files, specFile, bddActionPatterns(action), occurrenceIndex), method: null };
  }

  const methodPattern = pageMethod
    ? new RegExp(`(?:\\bawait\\s+)?\\b[A-Za-z_$][\\w$]*\\.${escapeRegex(pageMethod)}\\s*\\(`)
    : null;
  if ((family === 'playwright-pom' || family === 'selenium-pom') && methodPattern) {
    const line = lineForPatternsOccurrence(files, specFile, [methodPattern], occurrenceIndex);
    if (line) return { line, method: pageMethod };
  }

  const receiver = receiverPattern([
    step && step.target,
    locatorKey,
    ...(inlineKeys || []),
  ]);
  const patterns = family === 'selenium'
    ? seleniumActionPatterns(action, receiver)
    : playwrightActionPatterns(action, receiver);
  return { line: lineForPatternsOccurrence(files, specFile, patterns, occurrenceIndex), method: null };
}

function compositeCoverageForAction(step, locatorKey, specText) {
  // The ledger never infers coverage from domain words. Composite coverage requires
  // an explicit canonical step-to-method mapping and is otherwise proven as a normal
  // action by actionProof().
  return null;
}

function assertionCoverageForStep(step, specText) {
  if (!specText) return null;
  const expected = clean(step && step.expected, 160).toLowerCase();
  const hasGenericAssertion = /\bexpect(?:\.soft)?\s*\(|\bassertTextPresent\s*\(|\bassertScopedText\s*\(/.test(specText);
  if (hasGenericAssertion && (!expected || specText.toLowerCase().includes(expected) || /readData\(\s*row\s*,/.test(specText))) {
    return { method: 'canonicalAssertion', status: 'exported_assertion_method' };
  }
  return null;
}

function fixtureColumnsForExpected(files, expected) {
  const expectedText = String(expected == null ? '' : expected).trim();
  if (!expectedText) return [];
  const columns = new Set();
  const collectMatchingColumns = (value, key = null) => {
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        for (const item of value) collectMatchingColumns(item, key);
      } else {
        for (const [childKey, childValue] of Object.entries(value)) {
          collectMatchingColumns(childValue, childKey);
        }
      }
      return;
    }
    if (key && String(value == null ? '' : value).trim() === expectedText) columns.add(String(key));
  };
  for (const [fileName, source] of Object.entries(files || {})) {
    if (!/^tests\/data\/.*\.json$/i.test(fileName)) continue;
    const parsed = parseJson(source, null);
    const rows = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.rows) ? parsed.rows : (parsed && typeof parsed === 'object' ? [parsed] : []));
    for (const row of rows) collectMatchingColumns(row);
  }
  return [...columns];
}

function dataBoundAssertionProof(step, files, specFile) {
  const columns = fixtureColumnsForExpected(files, step?.expected);
  if (columns.length !== 1) return null;
  const source = textForFile(files, specFile);
  if (!source) return null;
  const lines = source.split(/\r?\n/);
  const columnPattern = new RegExp(`readData\\s*\\(\\s*row\\s*,\\s*["']${escapeRegex(columns[0])}["']\\s*\\)`);
  for (let index = 0; index < lines.length; index += 1) {
    const methodMatch = lines[index].match(/\bawait\s+[A-Za-z_$][\w$]*\.(assert[A-Za-z_$][\w$]*)\s*\(/);
    if (!methodMatch) continue;
    const callWindow = lines.slice(index, Math.min(lines.length, index + 6)).join('\n');
    if (columnPattern.test(callWindow)) {
      return { line: index + 1, method: methodMatch[1], column: columns[0] };
    }
  }
  return null;
}

function plannedCoverageInfo(plannedStep, files, specFile) {
  const specText = textForFile(files, specFile);
  const text = clean(plannedStep && plannedStep.plannedText, 200).toLowerCase();
  if (!specText || !text) return null;
  if (/(verify|assert|visible|display|show|contain|result)/.test(text)) {
    const assertion = assertionCoverageForStep({ expected: plannedStep && plannedStep.plannedText }, specText);
    if (assertion) return { status: assertion.status, exportedPageMethod: assertion.method };
  }
  if (/(extract|heading|title|label|text)/.test(text)) {
    const meaningfulTokens = text
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 3 && !['extract', 'extractdata', 'heading', 'title', 'label', 'text', 'data'].includes(token));
    if (meaningfulTokens.some((token) => specText.toLowerCase().includes(token))) {
      return { status: 'exported_assertion_method', exportedPageMethod: 'assertTextPresent' };
    }
  }
  if (/goto|open|navigate|load/.test(text) && /page\.goto\(/.test(specText)) return { status: 'covered_by_precondition', exportedPageMethod: null };
  return null;
}

function dataBindingForReplayStep(step) {
  if (!step || typeof step !== 'object') return null;
  if (step.dataRole) return { column: step.dataRole, source: 'ReplayIR.act.dataRole' };
  if (step.dataExpected) return { column: step.dataExpected, source: 'ReplayIR.assert.dataExpected' };
  if (step.domainAssertion && step.domainAssertion.role) return { column: step.domainAssertion.role, source: 'ReplayIR.assert.domainAssertion' };
  if (step.valueRef && /^data:/i.test(String(step.valueRef))) return { column: String(step.valueRef).replace(/^data:/i, ''), source: 'ReplayIR.valueRef' };
  return null;
}

function exportedInfo({ replay, plannedStep, testCaseId, files, specFile, manifestMap, adapterId, pomPlan }) {
  if (!replay || !replay.step) return {};
  const step = replay.step;
  if (!specFile || !files || !files[specFile]) {
    return { exportStatus: 'held', reason: 'No generated spec file was admitted for this test case.' };
  }
  const mappedProof = adapterFamily(adapterId) === 'playwright-pom'
    ? pomPlanProof({ replay, plannedStep, testCaseId, plan: pomPlan, files, specFile })
    : null;
  if (mappedProof) {
    const target = step.target || step.condition && step.condition.target || null;
    const manifestEntry = target ? nextManifestForAs(manifestMap, target) : null;
    return {
      exportStatus: 'exported',
      exportCoverage: 'exported_direct',
      exportedSpecFile: specFile,
      exportedSpecLine: mappedProof.line,
      exportedPageMethod: mappedProof.entry.exportedPageMethod || null,
      exportedLocatorKey: manifestEntry && manifestEntry.name || null,
      exportedPageFile: manifestEntry && manifestEntry.file
        ? `pages/${manifestEntry.file.charAt(0).toUpperCase()}${manifestEntry.file.slice(1)}.js|ts`
        : null,
      actionLocatorId: target,
      assertionId: step.contractRef || (step.op === 'assert' ? step.contractStepId || null : null),
      dataBinding: dataBindingForReplayStep(step),
      reason: null,
    };
  }
  if (step.op === 'assert') {
    const expected = clean(step.expected, 120);
    const specText = textForFile(files, specFile);
    const line = lineForNeedle(files, specFile, [
      step.contractRef,
      expected && JSON.stringify(expected),
      expected,
    ]);
    const assertionCoverage = line ? null : assertionCoverageForStep(step, specText);
    const dataBoundProof = line || assertionCoverage ? null : dataBoundAssertionProof(step, files, specFile);
    const proven = line || assertionCoverage || dataBoundProof;
    return {
      exportStatus: proven ? 'exported' : 'held',
      exportCoverage: assertionCoverage ? assertionCoverage.status : (dataBoundProof ? 'exported_assertion_method' : 'exported_direct'),
      exportedSpecFile: specFile,
      exportedSpecLine: line
        || dataBoundProof?.line
        || (assertionCoverage ? lineForNeedle(files, specFile, [`.${assertionCoverage.method}(`, assertionCoverage.method]) : null),
      exportedPageMethod: dataBoundProof?.method || (assertionCoverage ? assertionCoverage.method : null),
      assertionId: step.contractRef || null,
      dataBinding: dataBindingForReplayStep(step)
        || (dataBoundProof ? { column: dataBoundProof.column, source: 'final generated assertion fixture binding' } : null),
      reason: proven ? null : 'Could not prove assertion code in the generated package.',
    };
  }
  if (step.op === 'act') {
    if (TARGETLESS_ACTIONS.has(String(step.action || '')) || !step.target) {
      const proof = actionProof({ step, files, specFile, adapterId, locatorKey: null, pageMethod: null, inlineKeys: [], occurrenceIndex: replay.occurrenceIndex });
      return {
        exportStatus: proof.line ? 'exported' : 'held',
        exportCoverage: 'exported_direct',
        exportedSpecFile: specFile,
        exportedSpecLine: proof.line,
        dataBinding: dataBindingForReplayStep(step),
        reason: proof.line ? null : `Could not prove a concrete ${step.action || 'targetless'} call in the ${adapterId || 'generated'} source.`,
      };
    }
    const manifestEntry = nextManifestForAs(manifestMap, step.target);
    const inlineKeys = legacyInlineLocatorKeys(replay.resolveStep, step.action);
    const locatorKey = manifestEntry && manifestEntry.name || inlineKeys[0] || null;
    const pageFile = manifestEntry && manifestEntry.file || null;
    const pageMethod = locatorKey ? methodNameFor(step.action, locatorKey) : null;
    const proof = actionProof({
      step,
      files,
      specFile,
      adapterId,
      locatorKey,
      pageMethod,
      inlineKeys,
      occurrenceIndex: replay.occurrenceIndex,
    });
    return {
      exportStatus: proof.line ? 'exported' : 'held',
      exportCoverage: 'exported_direct',
      exportedSpecFile: specFile,
      exportedSpecLine: proof.line,
      exportedPageMethod: proof.method || null,
      exportedLocatorKey: locatorKey,
      exportedPageFile: pageFile ? `pages/${pageFile.charAt(0).toUpperCase()}${pageFile.slice(1)}.js|ts` : null,
      actionLocatorId: step.target || null,
      dataBinding: dataBindingForReplayStep(step),
      reason: proof.line ? null : `Could not prove a concrete ${step.action || 'action'} invocation in the ${adapterId || 'generated'} source. Locator declarations and comments are not action proof.`,
    };
  }
  return { exportStatus: 'exported', exportedSpecFile: specFile };
}

function replayDescription(replay) {
  if (!replay || !replay.step) return '';
  const step = replay.step;
  if (step.op === 'assert') return `assert ${step.channel || ''} ${step.expected || step.contractRef || ''}`.trim();
  if (step.op === 'act') return `${step.action || 'act'} ${step.target || step.url || ''}`.trim();
  if (step.op === 'humanInput') return `human input ${step.field || ''}`.trim();
  return clean(step.op || '');
}

function replayStableStepId(replay) {
  const step = replay && replay.step;
  if (!step || typeof step !== 'object') return null;
  return clean(step.contractStepId || step.targetRef || step.plannedStepId || step.stepId || '', 120) || null;
}

function replayActionIdentity(replay) {
  const step = replay && replay.step;
  if (!step || typeof step !== 'object') return {};
  const identity = step.actionIdentity && typeof step.actionIdentity === 'object' ? step.actionIdentity : {};
  return {
    authoredActionId: clean(identity.authoredActionId || step.authoredActionId || step.actionId, 180) || null,
    contractStepId: replayStableStepId(replay),
    sequenceIndex: Number.isFinite(Number(identity.sequenceIndex ?? step.sequenceIndex ?? replay.sequenceIndex))
      ? Number(identity.sequenceIndex ?? step.sequenceIndex ?? replay.sequenceIndex)
      : null,
    toolUseId: clean(identity.toolUseId || step.toolUseId, 180) || null,
    toolName: clean(identity.toolName || step.toolName || step.tool, 120) || null,
    operation: clean(identity.operation || step.action || step.channel || step.op, 80) || null,
  };
}

function plannedActionIdentity(plannedStep) {
  if (!plannedStep || typeof plannedStep !== 'object') return {};
  return {
    authoredActionId: plannedStep.authoredActionId || null,
    contractStepId: plannedStep.stableStepId || plannedStep.contractStepId || null,
    sequenceIndex: Number.isFinite(Number(plannedStep.sequenceIndex)) ? Number(plannedStep.sequenceIndex) : null,
    toolUseId: plannedStep.toolUseId || null,
    toolName: plannedStep.toolName || null,
    operation: plannedStep.operation || null,
  };
}

function plannedAssertionIntent(plannedStep) {
  const operation = String(plannedStep?.operation || '').trim().toLowerCase();
  if (['verify', 'assert', 'validate', 'confirm', 'expect', 'assertion'].includes(operation)) {
    return true;
  }
  return /^(?:verify|assert|validate|confirm|expect)\b/i.test(String(plannedStep?.plannedText || '').trim());
}

function operationsCompatible(plannedIdentity, replayIdentity) {
  const planned = String(plannedIdentity && plannedIdentity.operation || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const replay = String(replayIdentity && replayIdentity.operation || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!planned || !replay) return true;
  if (planned === replay) return true;
  if (replay === 'customaction' && ['verify', 'assert', 'validate', 'confirm', 'check'].includes(planned)) return true;
  return (planned === 'type' && replay === 'fill') || (planned === 'fill' && replay === 'type');
}

function pairPlannedAndReplay(planned, replay) {
  const plan = Array.isArray(planned) ? planned : [];
  const actual = Array.isArray(replay) ? replay : [];
  const matchedReplay = new Set();
  const replayForPlan = new Map();

  // Strongest join: immutable authored action occurrence identity.
  for (let plannedIndex = 0; plannedIndex < plan.length; plannedIndex += 1) {
    const expected = plannedActionIdentity(plan[plannedIndex]);
    if (!expected.authoredActionId) continue;
    const replayIndex = actual.findIndex((entry, index) => {
      if (matchedReplay.has(index)) return false;
      const observed = replayActionIdentity(entry);
      return observed.authoredActionId === expected.authoredActionId;
    });
    if (replayIndex < 0) continue;
    replayForPlan.set(plannedIndex, replayIndex);
    matchedReplay.add(replayIndex);
  }

  // Next, pair by contract identity plus the authored sequence occurrence and
  // operation. This keeps two identical clicks as two ordered occurrences.
  for (let plannedIndex = 0; plannedIndex < plan.length; plannedIndex += 1) {
    if (replayForPlan.has(plannedIndex)) continue;
    const expected = plannedActionIdentity(plan[plannedIndex]);
    if (!expected.contractStepId) continue;
    const replayIndex = actual.findIndex((entry, index) => {
      if (matchedReplay.has(index)) return false;
      const observed = replayActionIdentity(entry);
      if (observed.contractStepId !== expected.contractStepId) return false;
      if (!operationsCompatible(expected, observed)) return false;
      return expected.sequenceIndex == null || observed.sequenceIndex == null || expected.sequenceIndex === observed.sequenceIndex;
    });
    if (replayIndex < 0) continue;
    replayForPlan.set(plannedIndex, replayIndex);
    matchedReplay.add(replayIndex);
  }

  // Compatibility for older contracts that had stable step ids but no
  // sequence field. Consumption order still makes each occurrence unique.
  for (let plannedIndex = 0; plannedIndex < plan.length; plannedIndex += 1) {
    if (replayForPlan.has(plannedIndex)) continue;
    const expected = plannedActionIdentity(plan[plannedIndex]);
    if (!expected.contractStepId) continue;
    const replayIndex = actual.findIndex((entry, index) => {
      if (matchedReplay.has(index)) return false;
      const observed = replayActionIdentity(entry);
      return observed.contractStepId === expected.contractStepId && operationsCompatible(expected, observed);
    });
    if (replayIndex < 0) continue;
    replayForPlan.set(plannedIndex, replayIndex);
    matchedReplay.add(replayIndex);
  }

  // Order fallback is allowed only when neither side claims a stable identity.
  for (let plannedIndex = 0; plannedIndex < plan.length; plannedIndex += 1) {
    if (replayForPlan.has(plannedIndex)) continue;
    const expected = plannedActionIdentity(plan[plannedIndex]);
    const hasStableId = !!(expected.authoredActionId || expected.contractStepId);
    const replayIndex = actual.findIndex((entry, index) => {
      if (matchedReplay.has(index)) return false;
      const observed = replayActionIdentity(entry);
      return !hasStableId && !observed.authoredActionId && !observed.contractStepId;
    });
    if (replayIndex < 0) continue;
    replayForPlan.set(plannedIndex, replayIndex);
    matchedReplay.add(replayIndex);
  }

  const pairs = plan.map((plannedStep, plannedIndex) => ({
    plannedStep,
    replayStep: replayForPlan.has(plannedIndex) ? actual[replayForPlan.get(plannedIndex)] : null,
  }));
  actual.forEach((replayStep, replayIndex) => {
    if (!matchedReplay.has(replayIndex)) pairs.push({ plannedStep: null, replayStep });
  });
  return pairs;
}

function caseLedger({ result, admitted, blocked, files, manifestMap, adapterId, pomPlan }) {
  const planned = normalizePlannedSteps(result && result.declaredSteps);
  const ir = result && result.envelope && result.envelope.ir;
  const replay = replayBusinessSteps(ir);
  const emitterFindings = Array.isArray(result && result.envelope && result.envelope.findings)
    ? result.envelope.findings
    : [];
  const blockedRow = blockedForTestCase(blocked, result && result.testCaseId);
  const specFile = fileForTestCase(admitted, result && result.testCaseId);
  const rows = [];
  const pairs = pairPlannedAndReplay(planned, replay);
  const partialBoundary = (ir?.runtimeEvidence || []).find((entry) =>
    entry?.kind === 'partial_run_boundary'
    && entry?.failureBoundary?.code === 'partial_run_evidence_boundary');
  const lastExecutedOrdinal = Number(partialBoundary?.failureBoundary?.afterAuthoredStepNumber);

  for (const { plannedStep, replayStep } of pairs) {
    const exported = replayStep ? exportedInfo({
      replay: replayStep,
      plannedStep,
      testCaseId: result && result.testCaseId,
      files,
      specFile,
      manifestMap,
      adapterId,
      pomPlan,
    }) : {};
    let status = exported.exportCoverage || 'exported_direct';
    let reason = null;
    if (!replayStep && plannedStep) {
      const plannedCoverage = plannedCoverageInfo(plannedStep, files, specFile);
      if (plannedCoverage) {
        status = plannedCoverage.status;
        exported.exportStatus = 'exported';
        exported.exportedPageMethod = plannedCoverage.exportedPageMethod || null;
        exported.exportedSpecFile = specFile;
      } else {
        const isAfterRuntimeBoundary = Number.isInteger(lastExecutedOrdinal)
          && plannedStep.plannedOrdinal > lastExecutedOrdinal;
        const isAuthoredAssertionOnly = !isAfterRuntimeBoundary && plannedAssertionIntent(plannedStep);
        const isAuthoredIntentOnly = !isAfterRuntimeBoundary && !isAuthoredAssertionOnly;
        status = isAfterRuntimeBoundary
          ? 'diagnostic_only_post_boundary'
          : isAuthoredAssertionOnly
            ? 'diagnostic_only_authored_assertion'
            : 'diagnostic_only_authored_intent';
        exported.exportStatus = 'diagnostic_only';
        reason = isAfterRuntimeBoundary
          ? `Authored step ${plannedStep.plannedOrdinal} is after the recorded execution boundary at step ${lastExecutedOrdinal}; it remains diagnostic and was not emitted as runnable code.`
          : isAuthoredAssertionOnly
            ? `Authored assertion step ${plannedStep.plannedOrdinal} has no evaluated runtime assertion evidence; it remains diagnostic and was not invented as runnable code.`
            : isAuthoredIntentOnly
              ? `Authored step ${plannedStep.plannedOrdinal} has no positively executed ReplayIR occurrence; it remains diagnostic and was not invented as runnable code.`
              : blockedRow
                ? `Case was blocked before replay export: ${blockedRow.code || blockedRow.blockReason || 'blocked'}.`
                : 'Planned step has no corresponding ReplayIR action/assertion; QAAI must recapture or classify it before exporting.';
      }
    } else if (replayStep && !plannedStep) {
      const replayAssertion = replayStep.step?.op === 'assert' ? replayStep.step : null;
      const failedRuntimeAssertion = replayAssertion && (
        ['failed', 'error', 'blocked', 'skipped'].includes(String(replayAssertion.executionStatus || '').toLowerCase())
        || ['failed', 'error', 'not_matched', 'blocked', 'skipped'].includes(String(replayAssertion.liveOutcome || '').toLowerCase())
        || ['failed', 'error', 'blocked', 'skipped'].includes(String(replayAssertion.executionOutcome || '').toLowerCase())
      );
      if (failedRuntimeAssertion) {
        status = 'diagnostic_only_runtime_assertion';
        exported.exportStatus = 'diagnostic_only';
        reason = 'Runtime assertion evidence did not pass; its exact outcome remains diagnostic and was not emitted as runnable code.';
      } else {
        status = exported.exportStatus === 'held' ? 'requires_repair' : (exported.exportCoverage || 'exported_direct');
        reason = exported.exportStatus === 'held'
          ? (exported.reason || 'ReplayIR action was captured but no concrete generated call was found.')
          : 'ReplayIR contains an extra executed step with no authored planned step; kept visible for audit.';
      }
    } else if (exported.exportStatus === 'held') {
      status = 'requires_repair';
      reason = exported.reason || 'ReplayIR step was captured but not proven in generated output.';
    }
    rows.push({
      testCaseId: result && result.testCaseId || null,
      runResultId: result && result.runResultId || null,
      plannedStepId: plannedStep && plannedStep.plannedStepId || null,
      plannedOrdinal: plannedStep && plannedStep.plannedOrdinal || null,
      plannedText: plannedStep && plannedStep.plannedText || null,
      executedToolCalls: replayStep ? [replayDescription(replayStep)] : [],
      replayStepIndex: replayStep ? replayStep.replayIndex : null,
      replayOp: replayStep && replayStep.step && replayStep.step.op || null,
      replayAction: replayStep && replayStep.step && replayStep.step.action || null,
      authoredActionId: replayStep ? replayActionIdentity(replayStep).authoredActionId : plannedStep && plannedStep.authoredActionId || null,
      contractStepId: replayStep ? replayActionIdentity(replayStep).contractStepId : plannedStep && plannedStep.contractStepId || null,
      sequenceIndex: replayStep ? replayActionIdentity(replayStep).sequenceIndex : plannedStep && plannedStep.sequenceIndex || null,
      toolUseId: replayStep ? replayActionIdentity(replayStep).toolUseId : plannedStep && plannedStep.toolUseId || null,
      toolName: replayStep ? replayActionIdentity(replayStep).toolName : plannedStep && plannedStep.toolName || null,
      operation: replayStep ? replayActionIdentity(replayStep).operation : plannedStep && plannedStep.operation || null,
      occurrenceIndex: replayStep && replayStep.occurrenceIndex || null,
      actionLocatorId: exported.actionLocatorId || null,
      assertionId: exported.assertionId || null,
      dataBinding: exported.dataBinding || (plannedStep && plannedStep.dataBinding) || null,
      exportedSpecFile: exported.exportedSpecFile || null,
      exportedSpecLine: exported.exportedSpecLine || null,
      exportedPageMethod: exported.exportedPageMethod || null,
      exportedLocatorKey: exported.exportedLocatorKey || null,
      exportStatus: exported.exportStatus || (replayStep ? 'exported' : 'held'),
      status,
      reason,
    });
  }
  const hasUnresolvedRows = rows.some((row) => row.exportStatus !== 'exported' || row.status === 'requires_repair');
  const currentEmitterFindings = hasUnresolvedRows
    ? emitterFindings
    : emitterFindings.filter((finding) => finding && finding.code === 'duplicate_action_pruned');
  return {
    testCaseId: result && result.testCaseId || null,
    runResultId: result && result.runResultId || null,
    caseName: result && result.caseName || null,
    scenarioId: result && result.scenarioId || null,
    scenarioName: result && result.scenarioName || null,
    specFile,
    plannedStepCount: planned.length,
    replayStepCount: replay.length,
    emitterFindings: currentEmitterFindings,
    ledger: rows,
  };
}

function buildStepCompilationLedger({ results, admitted, blocked, files, adapterId }) {
  const manifestMap = manifestByResolveAs(manifestEntries(files));
  const pomPlan = pomSpecPlan(files);
  const cases = (results || []).map((result) => caseLedger({ result, admitted, blocked, files, manifestMap, adapterId, pomPlan }));
  const allRows = cases.flatMap((c) => c.ledger || []);
  const summary = {
    totalCases: cases.length,
    totalPlannedSteps: cases.reduce((sum, c) => sum + (c.plannedStepCount || 0), 0),
    totalReplaySteps: cases.reduce((sum, c) => sum + (c.replayStepCount || 0), 0),
    exported: allRows.filter((r) => r.exportStatus === 'exported').length,
    exportedDirect: allRows.filter((r) => r.status === 'exported_direct').length,
    exportedComposite: allRows.filter((r) => r.status === 'exported_composite').length,
    exportedAssertionMethod: allRows.filter((r) => r.status === 'exported_assertion_method').length,
    coveredByPrecondition: allRows.filter((r) => r.status === 'covered_by_precondition').length,
    skippedNoise: allRows.filter((r) => r.status === 'skipped_noise').length,
    postBoundaryDiagnostic: allRows.filter((r) => r.status === 'diagnostic_only_post_boundary').length,
    authoredAssertionDiagnostic: allRows.filter((r) => r.status === 'diagnostic_only_authored_assertion').length,
    authoredIntentDiagnostic: allRows.filter((r) => r.status === 'diagnostic_only_authored_intent').length,
    runtimeAssertionDiagnostic: allRows.filter((r) => r.status === 'diagnostic_only_runtime_assertion').length,
    blockedInternal: allRows.filter((r) => r.status === 'blocked_internal' || r.status === 'requires_repair').length,
    replayOnly: allRows.filter((r) => !r.plannedStepId && r.replayStepIndex != null).length,
    duplicateActionsPruned: cases.reduce((sum, c) => {
      const list = Array.isArray(c && c.emitterFindings) ? c.emitterFindings : [];
      return sum + list.filter((f) => f && f.code === 'duplicate_action_pruned').length;
    }, 0),
  };
  const findings = [];
  if (summary.blockedInternal > 0) {
    findings.push({
      rule: 'step_compilation_parity_gap',
      severity: 'error',
      message: `${summary.blockedInternal} planned/executed step(s) could not be proven through ReplayIR and generated output.`,
      path: 'evidence/step-parity-report.json',
    });
  }
  return {
    schemaVersion: 'qaai-step-compilation-ledger-v2',
    generatedAt: new Date().toISOString(),
    adapterId: adapterId || null,
    summary,
    cases,
    findings,
  };
}

module.exports = {
  buildStepCompilationLedger,
  _normalizePlannedSteps: normalizePlannedSteps,
  _replayBusinessSteps: replayBusinessSteps,
  _methodNameFor: methodNameFor,
  _pairPlannedAndReplay: pairPlannedAndReplay,
  _actionProof: actionProof,
  ACTION_VOCABULARY,
};
