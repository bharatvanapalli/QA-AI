'use strict';

const declaredAssertionsLib = require('../lib/declaredAssertions');

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function writeArrayLike(original, next) {
  return typeof original === 'string' ? JSON.stringify(next) : next;
}

function normKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9{}]+/g, ' ').trim();
}

function actionIsVerification(step = {}) {
  step = step || {};
  return /\b(verify|assert|validate|check|confirm|expect|ensure|see)\b/i.test(clean(step.action || step.stepKind));
}

function looksLikeValidationTarget(text) {
  return /\b(error|alert|invalid|required|validation|message|toast|warning|helper)\b/i.test(clean(text));
}

function looksLikeInputOnly(step = {}) {
  const action = clean(step.action).toLowerCase();
  if (/\b(fill|type|enter|input|select|choose|check|upload)\b/.test(action)) return true;
  const kind = clean(step.verify && step.verify.kind).toLowerCase();
  return kind === 'value' || kind === 'input_value';
}

function looksSensitiveOrInputValue(text) {
  const value = clean(text);
  if (!value) return true;
  if (/\{\{[^}]+}}/.test(value)) return false;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return true;
  if (/\b(password|secret|pwd|token|otp|mfa|passcode)\b/i.test(value)) return true;
  return false;
}

function weakText(text) {
  const value = clean(text);
  const lower = value.toLowerCase();
  if (!value || value.length < 2 || value.length > 140) return true;
  if (/\{\{[^}]+}}/.test(value)) return false;
  if (looksSensitiveOrInputValue(value)) return true;
  return [
    'is',
    'are',
    'the',
    'a',
    'an',
    'it',
    'page ready',
    'form ready',
    'screen ready',
    'loaded',
    'visible',
    'displayed',
    'shown',
    'as expected',
    'success',
    'successful',
    'works',
    'working',
    'true',
    'false',
  ].includes(lower);
}

function operationalNoise(text) {
  return /\b(?:accepts?\s+(?:the\s+)?provided\s+value|field\s+accepts|entered\s+in|button\s+clicked|begins?\s+loading|advances?\s+to|submitted|process(?:es|ed|ing)\s+credentials|page\s+loaded|loaded\s+with|flow\s+continues|option\s+is\s+displayed)\b/i.test(clean(text));
}

function exactVisibleSignal(text) {
  const value = clean(text)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+(?:is|are)\s+(?:visible|displayed|shown|present|available)\.?$/i, '')
    .trim();
  if (weakText(value)) return null;
  if (looksSensitiveOrInputValue(value)) return null;
  if (operationalNoise(value)) return null;
  return value;
}

function quotedSignals(text) {
  const out = [];
  const source = clean(text);
  const re = /["'`]([^"'`]{2,120})["'`]/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const signal = exactVisibleSignal(match[1]);
    if (signal) out.push(signal);
  }
  return out;
}

function visiblePhraseSignals(text) {
  const out = [];
  const source = clean(text);
  const patterns = [
    /\b(?:text|message|label|heading|button|option|toast)\s+([^.;]{2,100}?)\s+(?:is\s+)?(?:visible|displayed|shown|present|available|appears)\b/gi,
    /\b(?:verify|assert|validate|check|confirm|expect|ensure|see)\s+(?:that\s+)?(?:the\s+)?(?:text\s+|message\s+|label\s+|heading\s+|button\s+|option\s+|toast\s+)?([^.;]{2,100}?)\s+(?:is\s+)?(?:visible|displayed|shown|present|available|appears)\b/gi,
    /\b([A-Z][A-Za-z0-9&/()' -]{1,90}[!?]?)\s+(?:is|are)\s+(?:visible|displayed|shown|present|available)\b/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const signal = exactVisibleSignal(match[1]);
      if (signal) out.push(signal);
    }
  }
  return out;
}

function pageSignals(text) {
  const source = clean(text);
  const lower = source.toLowerCase();
  const out = [];
  if (/\bhome\b/.test(lower) && /\b(dashboard|page|screen)\b/.test(lower)) out.push('Home');
  if (/\bdashboard\b/.test(lower) && !out.includes('Dashboard')) out.push('Dashboard');
  const match = source.match(/\b(?:lands?|redirects?|navigates?|arrives?)\s+(?:on|to|at)\s+(?:the\s+)?([^.;]{2,80}?)(?:\s+(?:page|screen|dashboard))?\b/i);
  if (match) {
    const signal = exactVisibleSignal(match[1]);
    if (signal) out.push(signal);
  }
  return out.filter((signal) => !weakText(signal));
}

function extractTextSignals(text) {
  const found = [
    ...quotedSignals(text),
    ...visiblePhraseSignals(text),
  ];
  return Array.from(new Set(found.map(clean).filter((v) => !weakText(v))));
}

function expectedFromVerify(verify = {}, step = {}) {
  if (!verify || typeof verify !== 'object') return '';
  return clean(
    verify.text
    || verify.expectedText
    || verify.expected
    || verify.equals
    || verify.value
    || step.expected
    || '',
  );
}

function existingKeys(assertions = []) {
  const keys = new Set();
  for (const assertion of assertions) {
    if (!assertion || typeof assertion !== 'object' || assertion.parseFailed) continue;
    const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
    const type = clean(assertion.type).toUpperCase();
    const key = [
      type,
      payload.expectedText,
      payload.unexpectedText,
      payload.expectedUrlPattern,
      payload.expectedRole,
      payload.expectedReturn,
      JSON.stringify(payload.expectedSignals || null),
    ].map(normKey).join('|');
    keys.add(key);
  }
  return keys;
}

function assertionKey(assertion) {
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  return [
    clean(assertion.type).toUpperCase(),
    payload.expectedText,
    payload.expectedUrlPattern,
    payload.expectedReturn,
    JSON.stringify(payload.expectedSignals || null),
  ].map(normKey).join('|');
}

function isValidCheckable(assertion) {
  if (!assertion || assertion.parseFailed) return false;
  try {
    return declaredAssertionsLib.validateRecord(assertion).ok;
  } catch (_) {
    return false;
  }
}

function hasMeaningfulMust(assertions = []) {
  return assertions.some((assertion) => {
    if (!isValidCheckable(assertion)) return false;
    if (declaredAssertionsLib.normalizeCriticality(assertion.criticality) !== 'must') return false;
    const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
    const type = clean(assertion.type).toUpperCase();
    if (type === 'TEXT') return !weakText(payload.expectedText);
    if (type === 'URL') return !weakText(payload.expectedUrlPattern);
    if (type === 'EVALUATE') return !weakText(payload.expectedReturn);
    if (type === 'PAGE') {
      const signals = payload.expectedSignals && typeof payload.expectedSignals === 'object' ? payload.expectedSignals : {};
      return ['text', 'url'].some((key) => Array.isArray(signals[key]) && signals[key].some((v) => !weakText(v)));
    }
    return true;
  });
}

function makeBaseAssertion({ sourceStepId, requirementRefs = [], criticality = 'must' } = {}) {
  return {
    criticality,
    provenance: 'inline_text',
    source: 'inline_assertion_inference',
    checkAt: 'end',
    requirementRefs,
    ...(sourceStepId ? { sourceStepId } : {}),
  };
}

function textAssertion(expectedText, meta = {}) {
  return {
    ...makeBaseAssertion({ ...meta, criticality: meta.criticality || 'should' }),
    type: 'TEXT',
    note: `Soft text signal inferred from uploaded flow text: "${clean(expectedText).slice(0, 80)}".`,
    payload: {
      expectedText: clean(expectedText),
      matchMode: 'contains_or_semantic',
      strict: false,
    },
  };
}

function urlAssertion(expectedUrlPattern, meta = {}) {
  return {
    ...makeBaseAssertion(meta),
    type: 'URL',
    note: 'Inferred from uploaded flow text: verify the expected URL state.',
    payload: { expectedUrlPattern: clean(expectedUrlPattern) },
  };
}

function validationMessageAssertion(expectedReturn, meta = {}) {
  return {
    ...makeBaseAssertion({ ...meta, criticality: meta.criticality || 'should' }),
    type: 'EVALUATE',
    note: 'Soft validation text inferred from uploaded flow text; wording differences should be reported as deltas.',
    payload: {
      script: "(() => { const node = document.querySelector('[role=\"alert\"], [aria-invalid=\"true\"], [class*=\"error\" i], [class*=\"invalid\" i], [class*=\"validation\" i], [class*=\"helper\" i], [class*=\"toast\" i]'); return (node && node.textContent ? node.textContent : document.body.innerText || '').replace(/\\s+/g, ' ').trim(); })()",
      expectedReturn: clean(expectedReturn),
      matchMode: 'contains_or_semantic',
      strict: false,
    },
  };
}

function pageAssertion(signals, meta = {}) {
  const text = Array.from(new Set((signals || []).map(clean).filter((v) => !weakText(v)))).slice(0, 4);
  if (!text.length) return null;
  return {
    ...makeBaseAssertion(meta),
    type: 'PAGE',
    note: `Inferred from uploaded flow text: verify page signal "${text[0]}".`,
    payload: {
      pageName: `${text[0]} page`,
      expectedSignals: { text },
      matchMode: 'semantic_quorum_relaxed',
      strictText: false,
    },
  };
}

function inferFromStep(step = {}, index = 0, caseObj = {}) {
  const candidates = [];
  const verify = step.verify && typeof step.verify === 'object' ? step.verify : null;
  const kind = clean(verify && verify.kind).toLowerCase();
  const meta = {
    sourceStepId: step.id || step.stepId || (Number.isFinite(index) ? `step-${index + 1}` : undefined),
    requirementRefs: Array.isArray(caseObj.requirementRefs) ? caseObj.requirementRefs : [],
  };
  const stepText = clean([step.action, step.element, step.target, step.expected].filter(Boolean).join(' '));

  if (verify) {
    if (kind === 'url') {
      const url = clean(verify.url || verify.expectedUrlPattern || verify.expected || step.expected);
      if (!weakText(url)) candidates.push(urlAssertion(url, meta));
    } else if (kind === 'validation_message' || kind === 'field_error' || looksLikeValidationTarget(stepText)) {
      const expected = expectedFromVerify(verify, step);
      if (!weakText(expected)) candidates.push(validationMessageAssertion(expected, meta));
    } else if ((kind === 'text' || kind === 'visible_text') && !looksLikeInputOnly(step)) {
      const expected = expectedFromVerify(verify, step);
      if (!weakText(expected)) {
        candidates.push(textAssertion(expected, meta));
        const page = pageAssertion([expected], meta);
        if (page) candidates.push(page);
      }
    } else if (kind === 'visible' && !looksLikeInputOnly(step)) {
      const element = verify.element && typeof verify.element === 'object' ? verify.element : {};
      const signals = [
        element.name,
        verify.name,
        verify.text,
        verify.expected,
        step.expected,
        step.element,
        step.target,
      ].flatMap((v) => extractTextSignals(v).length ? extractTextSignals(v) : [exactVisibleSignal(v)].filter(Boolean));
      const page = pageAssertion(signals, meta);
      if (page) candidates.push(page);
    }
  }

  if (actionIsVerification(step) && !looksLikeInputOnly(step)) {
    const expected = clean(step.expected || step.target || step.element);
    if (looksLikeValidationTarget(stepText) && !weakText(expected)) {
      candidates.push(validationMessageAssertion(expected, meta));
    }
    const signals = extractTextSignals(expected);
    for (const signal of signals) {
      candidates.push(textAssertion(signal, meta));
    }
    const page = pageAssertion(looksLikeValidationTarget(stepText) ? pageSignals(expected) : [...pageSignals(expected), ...signals], meta);
    if (page) candidates.push(page);
  }

  return candidates;
}

function isNoAssertionsPlaceholder(assertion) {
  if (!assertion || typeof assertion !== 'object') return false;
  if (assertion.parseFailed !== true) return false;
  const issue = clean(assertion.parseIssue || assertion.parseFailedReason || assertion.issue).toLowerCase();
  if (issue === 'no_assertions_declared') return true;
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  return clean(assertion.source).toLowerCase() === 'architect'
    && clean(assertion.type).toUpperCase() === 'TEXT'
    && Object.keys(payload).length === 0;
}

function stepIsVerification(step = {}) {
  step = step || {};
  return actionIsVerification(step)
    || step.verificationPoint === true
    || clean(step.stepKind).toLowerCase() === 'verification';
}

function assertionPriority(assertion = {}, step = null, index = -1, total = 0) {
  const type = clean(assertion.type).toUpperCase();
  const payload = assertion.payload && typeof assertion.payload === 'object' ? assertion.payload : {};
  const text = clean([
    payload.expectedText,
    payload.expectedReturn,
    payload.pageName,
    payload.expectedSignals && Array.isArray(payload.expectedSignals.text) ? payload.expectedSignals.text.join(' ') : '',
    step && step.expected,
    step && step.element,
    step && step.target,
  ].filter(Boolean).join(' ')).toLowerCase();
  let score = 0;
  if (stepIsVerification(step)) score += 100;
  if (index >= total - 2) score += 60;
  if (/\b(final|home|dashboard|welcome|success|authenticated|land|redirect)\b/.test(text)) score += 35;
  if (type === 'PAGE') score += 25;
  if (declaredAssertionsLib.normalizeCriticality(assertion.criticality) === 'must') score += 20;
  if (type === 'TEXT') score += 8;
  if (!step) score += 5;
  if (operationalNoise(text)) score -= 50;
  return score;
}

function inferInlineAssertionsForCase(caseObj = {}) {
  const originalDeclared = caseObj.declaredAssertions;
  const declared = parseArray(originalDeclared);
  const steps = parseArray(caseObj.steps);
  const cleanedDeclared = declared.filter((assertion) => !isNoAssertionsPlaceholder(assertion));
  const keys = existingKeys(cleanedDeclared);
  const candidates = [];

  const prose = clean(caseObj.assertions || caseObj.expectedOutcome || '');
  for (const signal of extractTextSignals(prose)) {
    const assertion = textAssertion(signal, { requirementRefs: Array.isArray(caseObj.requirementRefs) ? caseObj.requirementRefs : [] });
    const key = assertionKey(assertion);
    if (!keys.has(key)) {
      keys.add(key);
      candidates.push({ assertion, priority: assertionPriority(assertion, null, -1, steps.length) });
    }
  }

  for (let i = 0; i < steps.length; i += 1) {
    for (const assertion of inferFromStep(steps[i], i, caseObj)) {
      if (!assertion || !isValidCheckable(assertion)) continue;
      const key = assertionKey(assertion);
      if (keys.has(key)) continue;
      keys.add(key);
      candidates.push({ assertion, priority: assertionPriority(assertion, steps[i], i, steps.length) });
    }
  }

  const existingHasMust = hasMeaningfulMust(cleanedDeclared);
  const keep = candidates
    .sort((a, b) => b.priority - a.priority)
    .map((entry) => entry.assertion)
    .filter((assertion) => isValidCheckable(assertion));
  if (!keep.length) return { case: caseObj, added: [], existingHasMust };

  const nextDeclared = [...cleanedDeclared, ...keep.slice(0, existingHasMust ? 3 : 6)];
  return {
    case: { ...caseObj, declaredAssertions: writeArrayLike(originalDeclared, nextDeclared) },
    added: keep.slice(0, existingHasMust ? 3 : 6),
    existingHasMust,
  };
}

function inferInlineAssertionsForScenarios(scenarios = []) {
  const stats = { casesTouched: 0, assertionsAdded: 0 };
  if (!Array.isArray(scenarios)) return stats;
  for (const scenario of scenarios) {
    for (const caseObj of (Array.isArray(scenario && scenario.cases) ? scenario.cases : [])) {
      if (!caseObj || typeof caseObj !== 'object') continue;
      const result = inferInlineAssertionsForCase(caseObj);
      if (!result.added.length) continue;
      caseObj.declaredAssertions = result.case.declaredAssertions;
      if (!caseObj.assertions || weakText(caseObj.assertions)) {
        const first = result.added[0];
        const payload = first.payload || {};
        caseObj.assertions = payload.expectedText
          ? `Verify "${payload.expectedText}" is present.`
          : (payload.expectedReturn ? `Verify validation contains "${payload.expectedReturn}".` : caseObj.assertions);
      }
      stats.casesTouched += 1;
      stats.assertionsAdded += result.added.length;
    }
  }
  return stats;
}

module.exports = {
  inferInlineAssertionsForCase,
  inferInlineAssertionsForScenarios,
  _private: {
    clean,
    extractTextSignals,
    pageSignals,
    hasMeaningfulMust,
    weakText,
  },
};
