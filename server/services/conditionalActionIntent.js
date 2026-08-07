'use strict';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceText(source) {
  if (typeof source === 'string') return source;
  if (!isObject(source)) return '';
  const condition = isObject(source.condition)
    ? [
        source.condition.predicate,
        source.condition.text,
        source.condition.description,
        source.condition.expected,
        source.condition.when,
      ].filter(Boolean).join(' ')
    : source.condition;
  const when = isObject(source.when)
    ? [source.when.predicate, source.when.text, source.when.description].filter(Boolean).join(' ')
    : source.when;
  return [
    source.action,
    source.actionType,
    source.operation,
    source.description,
    source.instruction,
    source.plannedText,
    source.title,
    source.name,
    condition,
    when,
  ].filter(Boolean).join(' ');
}

const CONDITIONAL_PRESENCE_RE = /\b(?:if|when)\s+(?:(?:the|this|that|it)\s+)?(?:(?:target|element|control|button|dialog|prompt|popup|overlay|banner|option)\s+)?(?:is\s+)?(?:visible|present|shown|displayed|available|found|enabled)\b|\b(?:if|when)\s+(?:(?:the|this|that|it)\s+)?(?:appears?|exists?)\b|\bonly\s+if\s+(?:(?:the|this|that|it)\s+)?(?:is\s+)?(?:visible|present|shown|displayed|available|found|enabled)\b/i;

const NESTED_INTENT_KEYS = Object.freeze([
  'contract',
  'metadata',
  'raw',
  'payload',
  'actionContract',
  'operationCheck',
  'verify',
]);

function expandIntentSources(sources) {
  const queue = [...sources];
  const expanded = [];
  const seen = new Set();
  while (queue.length) {
    const source = queue.shift();
    if (typeof source === 'string') {
      expanded.push(source);
      continue;
    }
    if (!isObject(source) || seen.has(source)) continue;
    seen.add(source);
    expanded.push(source);
    for (const key of NESTED_INTENT_KEYS) {
      if (isObject(source[key]) && !seen.has(source[key])) queue.push(source[key]);
    }
  }
  return expanded;
}

function isPresenceConditionalAction(...sources) {
  const expandedSources = expandIntentSources(sources);
  for (const source of expandedSources) {
    if (!isObject(source)) continue;
    const structuredConditions = [source.condition, source.when].filter(isObject);
    if (structuredConditions.some((condition) => {
      const onFalse = String(condition.onFalse || condition.else || '').trim().toLowerCase();
      const predicate = [condition.predicate, condition.text, condition.description, condition.expected]
        .filter(Boolean).join(' ');
      return onFalse === 'skip'
        && /\b(?:visible|present|shown|displayed|available|found|enabled|appears?|exists?)\b/i.test(predicate);
    })) return true;
    if (
      source.optional === true ||
      source.ifVisible === true ||
      source.ifPresent === true ||
      source.whenVisible === true ||
      source.whenPresent === true ||
      source.required === false ||
      source.proofRequired === false
    ) return true;
  }
  return expandedSources.some((source) => CONDITIONAL_PRESENCE_RE.test(sourceText(source)));
}

function conditionalActionRequiredByContract(...sources) {
  for (const source of expandIntentSources(sources)) {
    if (!isObject(source)) continue;
    if (
      source.contractRequired === true ||
      source.requiredEvenIfAbsent === true ||
      source.requiredForFlow === true ||
      source.flowCritical === true ||
      source.requiredForContinuation === true ||
      source.blocking === true
    ) return true;
    const contract = isObject(source.contract) ? source.contract : null;
    if (contract && (
      contract.required === true ||
      contract.proofRequired === true ||
      contract.requiredEvenIfAbsent === true ||
      contract.flowCritical === true ||
      contract.requiredForContinuation === true ||
      contract.blocking === true
    )) return true;
  }
  return false;
}

module.exports = {
  isPresenceConditionalAction,
  conditionalActionRequiredByContract,
};
