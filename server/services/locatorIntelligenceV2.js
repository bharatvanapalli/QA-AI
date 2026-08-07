'use strict';

const crypto = require('crypto');
const actionLocatorResolver = require('./actionLocatorResolver');

const SCHEMA_VERSION = 'qaai-locator-intelligence-v2/1';
const CERTIFICATION_REPORT_SCHEMA_VERSION = 'qaai-locator-certification-report/1';
const CERTIFICATION_REPORT_SET_SCHEMA_VERSION = 'qaai-locator-certification-report-set/1';
const FINGERPRINT_SCHEMA_VERSION = 'qaai-locator-fingerprint-v1';
const HEALING_SCHEMA_VERSION = 'qaai-locator-healing-v1';
const FINGERPRINT_MATCH_THRESHOLD = 55;
const PROJECT_FLAG_KEY = 'locatorIntelligenceV2';

const GOLD_SOURCES = new Set([
  actionLocatorResolver.VERIFIED_DOM_INSPECTION_SOURCE,
  actionLocatorResolver.VERIFIED_ACCESSIBILITY_SNAPSHOT_SOURCE,
  actionLocatorResolver.ACTIVE_DOM_EXCAVATION_SOURCE,
]);

const STRATEGY_WEIGHTS = {
  testId: 98,
  testid: 98,
  dataTestId: 98,
  id: 94,
  css_id: 94,
  name: 92,
  css_name: 92,
  css_stable_attr: 91,
  stable_attr: 91,
  role: 88,
  label: 86,
  placeholder: 82,
  password_type: 88,
  sensitive_input_dom_capture: 88,
  active_dom_excavation: 84,
  scoped_role: 84,
  context_css: 80,
  css: 72,
  text: 64,
  xpath: 44,
};

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function cleanText(value, max = 180) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return max && text.length > max ? text.slice(0, max) : text;
}

function normalizeFingerprintText(value, max = 180) {
  const cleaned = actionLocatorResolver.cleanAccessibleName(cleanText(value, max)) || cleanText(value, max);
  return String(cleaned || '')
    .toLowerCase()
    .replace(/[^\w\s@#./:-]+/g, ' ')
    .replace(/\b(button|link|field|input|textbox|searchbox|combobox|dropdown|select|menu|item|icon|control|element|target)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      const arr = value.filter(Boolean);
      if (arr.length) out[key] = arr;
      continue;
    }
    if (typeof value === 'object') {
      const nested = compactObject(value);
      if (Object.keys(nested).length) out[key] = nested;
      continue;
    }
    if (String(value).trim()) out[key] = value;
  }
  return out;
}

function uniqueNormalizedList(value, limit = 8) {
  const raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
  return Array.from(new Set(raw.map((item) => normalizeFingerprintText(item)).filter(Boolean))).slice(0, limit);
}

function parseLocatorArgument(expression, method) {
  const raw = String(expression || '');
  const escaped = String(method || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = new RegExp(`${escaped}\\(\\s*(['"\`])([^'"\`]*)\\1`, 'i').exec(raw);
  if (literal) return literal[2];
  const regex = new RegExp(`${escaped}\\(\\s*\\/([^/]+)\\/`, 'i').exec(raw);
  return regex ? regex[1] : '';
}

function expressionFacts(expression) {
  const raw = String(expression || '');
  const roleMatch = /getByRole\(\s*(['"`])([^'"`]+)\1/i.exec(raw);
  const roleNameLiteral = /name\s*:\s*(?:new\s+RegExp\()?\s*(['"`])([^'"`]+)\1/i.exec(raw);
  const roleNameRegex = /name\s*:\s*\/([^/]+)\//i.exec(raw);
  const cssId = /locator\(\s*(['"`])#([^'"`\s>.[#:]+)\1/i.exec(raw);
  const nameAttr = /\[name\s*=\s*(['"`]?)([^'"`\]\s]+)\1\]/i.exec(raw);
  const typeAttr = /\[type\s*=\s*(['"`]?)([^'"`\]\s]+)\1\]/i.exec(raw);
  return compactObject({
    role: roleMatch && roleMatch[2],
    accessibleName: roleNameLiteral && roleNameLiteral[2] || roleNameRegex && roleNameRegex[1] || parseLocatorArgument(raw, 'getByText'),
    placeholder: parseLocatorArgument(raw, 'getByPlaceholder'),
    label: parseLocatorArgument(raw, 'getByLabel'),
    testId: parseLocatorArgument(raw, 'getByTestId'),
    id: cssId && cssId[2],
    nameAttr: nameAttr && nameAttr[2],
    type: typeAttr && typeAttr[2],
  });
}

function normalizeStableAttributes(targetFacts = {}) {
  const attrs = [];
  const facts = targetFacts && typeof targetFacts === 'object' ? targetFacts : {};
  const stable = facts.stableAttributes && typeof facts.stableAttributes === 'object' ? facts.stableAttributes : {};
  for (const [key, value] of Object.entries(stable)) attrs.push([key, value]);
  if (facts.testIds && typeof facts.testIds === 'object') {
    for (const [key, value] of Object.entries(facts.testIds)) attrs.push([key, value]);
  }
  for (const key of ['id', 'testId', 'testid', 'dataTestId', 'data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'nameAttr', 'name', 'autocomplete', 'ariaLabel', 'aria-label']) {
    if (facts[key]) attrs.push([key, facts[key]]);
  }
  const out = {};
  for (const [rawKey, rawValue] of attrs) {
    const key = cleanText(rawKey, 48);
    const value = normalizeFingerprintText(rawValue, 140);
    if (!key || !value) continue;
    out[key] = value;
    if (Object.keys(out).length >= 16) break;
  }
  return out;
}

function firstText(...values) {
  for (const value of values) {
    const text = normalizeFingerprintText(value);
    if (text) return text;
  }
  return '';
}

function buildLocatorFingerprint({
  expression = null,
  strategy = null,
  targetFacts = null,
  context = null,
  pageUrl = null,
} = {}) {
  const facts = targetFacts && typeof targetFacts === 'object' ? targetFacts : {};
  const ctx = context && typeof context === 'object' ? context : {};
  const fromExpression = expressionFacts(expression);
  const stableAttributes = normalizeStableAttributes(facts);
  const testIds = uniqueNormalizedList([
    facts.testId,
    facts.testid,
    facts.dataTestId,
    facts['data-testid'],
    fromExpression.testId,
    ...Object.values(facts.testIds && typeof facts.testIds === 'object' ? facts.testIds : {}),
  ]);
  const semantic = compactObject({
    role: firstText(facts.role, facts.ariaRole, fromExpression.role),
    accessibleName: firstText(facts.accessibleName, facts.normalizedAccessibleName, facts.rawAccessibleName, facts.text, facts.name, fromExpression.accessibleName),
    placeholder: firstText(facts.placeholder, fromExpression.placeholder),
    label: firstText(facts.label, facts.labelText, fromExpression.label),
    testId: testIds[0] || '',
    testIds,
    id: firstText(facts.id, fromExpression.id),
    nameAttr: firstText(facts.nameAttr, facts.name, fromExpression.nameAttr),
    title: firstText(facts.title),
    alt: firstText(facts.alt),
    tag: firstText(facts.tag, facts.tagName),
    type: firstText(facts.type, fromExpression.type),
  });
  const nearbyText = Array.from(new Set([
    ...uniqueNormalizedList(ctx.nearbyText, 8),
    ...uniqueNormalizedList(ctx.contextText, 8),
    ...uniqueNormalizedList(facts.nearbyText, 8),
  ])).slice(0, 8);
  const structural = compactObject({
    formSelector: cleanText(ctx.formSelector || facts.formSelector || '', 180),
    formAction: cleanText(ctx.formAction || facts.formAction || '', 180),
    tableSelector: cleanText(ctx.tableSelector || facts.tableSelector || '', 180),
    rowSelector: cleanText(ctx.rowSelector || facts.rowSelector || '', 180),
    rowText: firstText(ctx.rowText, facts.rowText),
    cardSelector: cleanText(ctx.cardSelector || facts.cardSelector || '', 180),
    cardText: firstText(ctx.cardText, facts.cardText),
    dialogSelector: cleanText(ctx.dialogSelector || facts.dialogSelector || '', 180),
    dialogName: firstText(ctx.dialogName, facts.dialogName),
    landmarkSelector: cleanText(ctx.landmarkSelector || ctx.sidebarSelector || facts.landmarkSelector || '', 180),
    frameSelector: cleanText(ctx.frameSelector || facts.frameSelector || '', 180),
    shadowHostSelector: cleanText(ctx.shadowHostSelector || facts.shadowHostSelector || '', 180),
    containerSelector: cleanText(ctx.containerSelector || facts.containerSelector || '', 180),
    containerText: firstText(ctx.containerText, facts.containerText),
    parentRole: firstText(ctx.parentRole, facts.parentRole),
    parentName: firstText(ctx.parentName, facts.parentName),
    nearbyText,
  });
  const identity = compactObject({ semantic, structural, stableAttributes });
  if (!Object.keys(identity).length) return null;
  const hash = sha256(stableStringify({ schemaVersion: FINGERPRINT_SCHEMA_VERSION, identity })).slice(0, 24);
  const raw = String(expression || '');
  return {
    schemaVersion: FINGERPRINT_SCHEMA_VERSION,
    hash,
    strategy: cleanText(strategy || '', 80) || null,
    pageUrl: pageUrl ? cleanText(pageUrl, 500) : null,
    semantic,
    structural,
    stableAttributes,
    expressionSignals: {
      hasTestId: /getByTestId\(/.test(raw) || !!semantic.testId,
      hasRoleName: /getByRole\(/.test(raw) && /name\s*:/.test(raw),
      hasLabel: /getByLabel\(/.test(raw),
      hasPlaceholder: /getByPlaceholder\(/.test(raw),
      hasCssId: /locator\(\s*['"]#/.test(raw) || !!semantic.id,
      hasFrameScope: /frameLocator\(/.test(raw) || !!structural.frameSelector,
      hasShadowScope: /shadowRoot|shadow_scoped|shadowHost/i.test(raw) || !!structural.shadowHostSelector,
      hasContainerScope: /\.filter\(\s*\{\s*hasText\s*:/.test(raw) || !!structural.containerText || !!structural.rowText || !!structural.cardText,
    },
  };
}

function normalizeFingerprint(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.schemaVersion === FINGERPRINT_SCHEMA_VERSION && value.hash) return value;
  if (value.fingerprint && typeof value.fingerprint === 'object') return normalizeFingerprint(value.fingerprint);
  if (value.locatorFingerprint && typeof value.locatorFingerprint === 'object') return normalizeFingerprint(value.locatorFingerprint);
  return buildLocatorFingerprint(value);
}

function tokenOverlapScore(a, b) {
  const left = new Set(normalizeFingerprintText(a).split(/\s+/).filter((token) => token.length > 2));
  const right = new Set(normalizeFingerprintText(b).split(/\s+/).filter((token) => token.length > 2));
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / Math.max(left.size, right.size);
}

function bestTextScore(expectedValues, observedValues) {
  let best = { score: 0, reason: null };
  for (const expected of expectedValues) {
    for (const observed of observedValues) {
      const a = normalizeFingerprintText(expected);
      const b = normalizeFingerprintText(observed);
      if (!a || !b) continue;
      let score = 0;
      let reason = null;
      if (a === b) {
        score = 25;
        reason = 'same_text';
      } else if (a.includes(b) || b.includes(a)) {
        score = 18;
        reason = 'contained_text';
      } else {
        const overlap = tokenOverlapScore(a, b);
        if (overlap >= 0.5) {
          score = Math.round(10 + overlap * 10);
          reason = 'overlapping_text';
        }
      }
      if (score > best.score) best = { score, reason };
    }
  }
  return best;
}

function attrOverlapScore(expectedAttrs = {}, observedAttrs = {}) {
  const reasons = [];
  let score = 0;
  for (const [key, expected] of Object.entries(expectedAttrs || {})) {
    const observed = observedAttrs && observedAttrs[key];
    if (!expected || !observed) continue;
    if (expected === observed) {
      score += 8;
      reasons.push(`same_attr:${key}`);
    }
  }
  return { score: Math.min(24, score), reasons };
}

function structuralTextValues(fp) {
  const st = fp && fp.structural || {};
  return [
    st.rowText,
    st.cardText,
    st.containerText,
    st.dialogName,
    st.parentName,
    ...(Array.isArray(st.nearbyText) ? st.nearbyText : []),
  ].filter(Boolean);
}

function scoreFingerprintMatch(expected, observed, { threshold = FINGERPRINT_MATCH_THRESHOLD } = {}) {
  const left = normalizeFingerprint(expected);
  const right = normalizeFingerprint(observed);
  if (!left || !right) {
    return { score: 0, matched: false, confidence: 'none', reasons: ['missing_fingerprint'], expectedHash: left?.hash || null, observedHash: right?.hash || null };
  }
  let score = 0;
  const reasons = [];
  const penalties = [];
  if (left.hash && right.hash && left.hash === right.hash) {
    score += 90;
    reasons.push('same_fingerprint_hash');
  }
  const ls = left.semantic || {};
  const rs = right.semantic || {};
  if (ls.testId && rs.testId) {
    if (ls.testId === rs.testId) {
      score += 40;
      reasons.push('same_testid');
    } else {
      score -= 25;
      penalties.push('different_testid');
    }
  }
  if (ls.role && rs.role) {
    if (ls.role === rs.role) {
      score += 15;
      reasons.push('same_role');
    } else {
      score -= 12;
      penalties.push('different_role');
    }
  }
  const textMatch = bestTextScore(
    [ls.accessibleName, ls.placeholder, ls.label, ls.nameAttr, ls.title, ls.alt].filter(Boolean),
    [rs.accessibleName, rs.placeholder, rs.label, rs.nameAttr, rs.title, rs.alt].filter(Boolean)
  );
  if (textMatch.score) {
    score += textMatch.score;
    reasons.push(textMatch.reason);
  } else if ((ls.accessibleName || ls.placeholder || ls.label) && (rs.accessibleName || rs.placeholder || rs.label)) {
    score -= 10;
    penalties.push('different_accessible_text');
  }
  for (const field of ['placeholder', 'label', 'nameAttr', 'id', 'type', 'tag']) {
    if (ls[field] && rs[field] && ls[field] === rs[field]) {
      score += field === 'tag' ? 5 : 10;
      reasons.push(`same_${field}`);
    }
  }
  const attrScore = attrOverlapScore(left.stableAttributes, right.stableAttributes);
  score += attrScore.score;
  reasons.push(...attrScore.reasons);
  const lstruct = left.structural || {};
  const rstruct = right.structural || {};
  for (const field of ['formSelector', 'tableSelector', 'rowSelector', 'cardSelector', 'dialogSelector', 'frameSelector', 'shadowHostSelector', 'containerSelector']) {
    if (lstruct[field] && rstruct[field]) {
      if (lstruct[field] === rstruct[field]) {
        score += field === 'frameSelector' || field === 'shadowHostSelector' ? 16 : 10;
        reasons.push(`same_${field}`);
      } else if (field === 'frameSelector' || field === 'shadowHostSelector') {
        score -= 20;
        penalties.push(`different_${field}`);
      }
    }
  }
  const structuralText = bestTextScore(structuralTextValues(left), structuralTextValues(right));
  if (structuralText.score) {
    score += Math.min(18, structuralText.score);
    reasons.push(`structural_${structuralText.reason}`);
  }
  if (left.strategy && right.strategy && left.strategy === right.strategy) {
    score += 4;
    reasons.push('same_strategy');
  }
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score: finalScore,
    matched: finalScore >= threshold,
    confidence: finalScore >= 80 ? 'high' : (finalScore >= threshold ? 'medium' : (finalScore > 0 ? 'weak' : 'none')),
    threshold,
    reasons: Array.from(new Set(reasons)),
    penalties: Array.from(new Set(penalties)),
    expectedHash: left.hash || null,
    observedHash: right.hash || null,
  };
}

function fingerprintFromCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const primary = candidate.candidate && typeof candidate.candidate === 'object' ? candidate.candidate : candidate;
  return normalizeFingerprint(primary.fingerprint || primary.locatorFingerprint || {
    expression: expressionOf(primary),
    strategy: strategyOf(primary),
    targetFacts: primary.targetFacts || {
      role: primary.role,
      accessibleName: primary.name || primary.accessibleName || primary.text,
      placeholder: primary.placeholder,
      testId: primary.testId || primary.testid,
      id: primary.idAttr,
    },
    context: primary.context || {
      parentRole: primary.parentRole,
      parentName: primary.parentName,
      nearbyText: primary.line ? [primary.line] : [],
    },
    pageUrl: primary.pageUrl,
  });
}

function rankHealingCandidatesByFingerprint(expectedFingerprint, candidates = [], { threshold = FINGERPRINT_MATCH_THRESHOLD } = {}) {
  const expected = normalizeFingerprint(expectedFingerprint);
  return (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => {
      const fingerprint = fingerprintFromCandidate(candidate);
      const fingerprintMatch = scoreFingerprintMatch(expected, fingerprint, { threshold });
      return {
        candidate,
        expression: expressionOf(candidate) || candidate?.expression || null,
        strategy: strategyOf(candidate) || candidate?.strategy || null,
        fingerprint,
        fingerprintMatch,
        score: fingerprintMatch.score,
      };
    })
    .filter((entry) => entry.fingerprint)
    .sort((a, b) => b.score - a.score);
}

function selectHealingCandidateByFingerprint(expectedFingerprint, candidates = [], options = {}) {
  const ranked = rankHealingCandidatesByFingerprint(expectedFingerprint, candidates, options);
  return ranked.find((entry) => entry.fingerprintMatch.matched) || null;
}

function triggerConfigFromProject(projectOrConfig) {
  const source = projectOrConfig && typeof projectOrConfig === 'object' ? projectOrConfig : {};
  if (source.triggerConfigJson) return parseJsonObject(source.triggerConfigJson, {});
  if (source.triggerConfig && typeof source.triggerConfig === 'object') return source.triggerConfig;
  return source;
}

function projectLocatorV2Enabled(projectOrConfig) {
  const source = projectOrConfig && typeof projectOrConfig === 'object' ? projectOrConfig : {};
  if (source.locatorIntelligenceV2 === true) return true;
  if (source.locatorIntelligenceV2 === false) return false;
  const cfg = triggerConfigFromProject(source);
  if (cfg.locatorIntelligenceV2 === true) return true;
  if (cfg.locatorIntelligenceV2 === false) return false;
  if (cfg.locatorIntelligence && typeof cfg.locatorIntelligence === 'object') {
    if (cfg.locatorIntelligence.v2 === true || cfg.locatorIntelligence.enabled === true) return true;
    if (cfg.locatorIntelligence.v2 === false || cfg.locatorIntelligence.enabled === false) return false;
  }
  return false;
}

function expressionOf(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate.frameworkExpressions?.playwright || candidate.expression || null;
}

function proofOf(candidate) {
  return candidate && candidate.proof && typeof candidate.proof === 'object' ? candidate.proof : {};
}

function sourceOf(candidate) {
  const proof = proofOf(candidate);
  return candidate?.verificationSource || candidate?.evidenceSource || proof.source || null;
}

function strategyOf(candidate) {
  return String(candidate?.strategy || candidate?.candidate?.strategy || '').trim();
}

function clampScore(value) {
  const n = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(100, n));
}

function addReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

function expressionWeaknesses(expression) {
  const raw = String(expression || '');
  const reasons = [];
  addReason(reasons, !raw, 'missing_expression');
  addReason(reasons, /\.(?:first|nth|last)\s*\(/.test(raw), 'positional_locator');
  addReason(reasons, /:(?:nth-of-type|nth-child)\s*\(/i.test(raw), 'structural_position_selector');
  addReason(reasons, /\[ref\s*=|locator\(\s*['"][^'"]*\[ref\s*=/i.test(raw), 'mcp_ref_leak');
  addReason(reasons, raw && actionLocatorResolver.containsGlyphContamination(raw), 'glyph_contamination');
  addReason(reasons, /^getByRole\(\s*["'][^"']+["']\s*\)$/i.test(raw), 'role_only_locator');
  return reasons;
}

function baseWeightFor(candidate, expression) {
  const strategy = strategyOf(candidate);
  const normalized = strategy.replace(/[^a-z0-9]+/gi, '_');
  if (STRATEGY_WEIGHTS[strategy] != null) return STRATEGY_WEIGHTS[strategy];
  if (STRATEGY_WEIGHTS[normalized] != null) return STRATEGY_WEIGHTS[normalized];
  const raw = String(expression || '');
  if (/getByTestId\(/.test(raw)) return STRATEGY_WEIGHTS.testId;
  if (/locator\(\s*['"][^'"]*#/.test(raw)) return STRATEGY_WEIGHTS.id;
  if (/locator\(\s*['"][^'"]*\[(?:data-testid|data-test|data-qa|aria-label|name|id)=/i.test(raw)) return STRATEGY_WEIGHTS.css_stable_attr;
  if (/getByRole\(/.test(raw)) return STRATEGY_WEIGHTS.role;
  if (/getByLabel\(/.test(raw)) return STRATEGY_WEIGHTS.label;
  if (/getByPlaceholder\(/.test(raw)) return STRATEGY_WEIGHTS.placeholder;
  if (/input\[type=["']?password/i.test(raw)) return STRATEGY_WEIGHTS.password_type;
  if (/xpath=|locator\(\s*['"]\/\//i.test(raw)) return STRATEGY_WEIGHTS.xpath;
  if (/getByText\(/.test(raw)) return STRATEGY_WEIGHTS.text;
  if (/locator\(/.test(raw)) return STRATEGY_WEIGHTS.css;
  return 50;
}

function scoreCandidate(candidate, { selected = false, gold = false, exportSafe = false } = {}) {
  const primary = candidate && candidate.candidate && typeof candidate.candidate === 'object'
    ? candidate.candidate
    : candidate;
  const expression = expressionOf(primary);
  const proof = proofOf(primary);
  const source = sourceOf(primary);
  const weaknesses = expressionWeaknesses(expression);
  const targetFacts = primary?.targetFacts && typeof primary.targetFacts === 'object' ? primary.targetFacts : null;
  const context = primary?.context && typeof primary.context === 'object' ? primary.context : null;
  const fingerprint = buildLocatorFingerprint({
    expression,
    strategy: strategyOf(primary),
    targetFacts,
    context,
    pageUrl: primary?.pageUrl,
  });
  let score = baseWeightFor(primary, expression);

  if (gold) score += 8;
  if (exportSafe) score += 4;
  if (primary?.verified === true || proof.verified === true) score += 5;
  if (proof.sameElement === true) score += 5;
  if (proof.count === 1) score += 5;
  if (proof.count != null && proof.count !== 1) score -= 25;
  if (proof.sameElement === false) score -= 30;
  if (primary?.diagnosticOnly === true) score -= 30;
  if (primary?.unverifiedForCodegen === true) score -= 10;
  if (source && !GOLD_SOURCES.has(String(source)) && source !== 'snapshot_ref_fallback') score -= 8;
  if (!exportSafe) score -= 30;
  if (selected) score += 2;
  score -= weaknesses.length * 15;

  const safe = exportSafe && weaknesses.length === 0;
  const confidence = gold && safe && proof.count === 1 && proof.sameElement === true
    ? 'certified'
    : (safe && score >= 75 ? 'strong' : (safe && score >= 55 ? 'weak' : 'unverified'));

  return {
    expression: expression || null,
    strategy: strategyOf(primary) || null,
    source: source || null,
    score: clampScore(score),
    confidence,
    exportSafe: !!safe,
    proof: {
      count: proof.count ?? null,
      sameElement: proof.sameElement === true,
      visible: proof.visible ?? null,
      enabled: proof.enabled ?? null,
      verified: primary?.verified === true || proof.verified === true,
      actionTimeResolved: proof.actionTimeResolved === true,
      resolutionMode: proof.resolutionMode || null,
      identityVerified: proof.identityVerified === true,
      targetIdentity: proof.targetIdentity || null,
      matchedIdentity: proof.matchedIdentity || null,
    },
    targetFacts,
    context,
    fingerprint,
    weaknesses,
  };
}

function uniqueCandidates(candidates) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw.candidate && typeof raw.candidate === 'object' ? raw.candidate : raw;
    const expression = expressionOf(candidate);
    const key = `${strategyOf(candidate)}|${expression || ''}|${candidate.selector || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function repairRecommendationFor(selected) {
  if (!selected || !selected.expression) return 'Re-capture the step with DOM evidence; no locator expression was recorded.';
  if (selected.weaknesses.includes('positional_locator')) return 'Replace positional locator with a scoped semantic, attribute, table-row, frame, or shadow-aware locator.';
  if (selected.weaknesses.includes('mcp_ref_leak')) return 'Convert MCP snapshot refs into a durable DOM locator before sealing the step.';
  if (selected.weaknesses.includes('role_only_locator')) return 'Add an accessible name, visible text filter, row/card scope, or stable attribute to disambiguate the role locator.';
  if (selected.proof.count !== 1) return 'Re-resolve locator against the live DOM until it proves exactly one same element.';
  if (!selected.exportSafe) return 'Repair the locator expression so it passes export-safety checks.';
  if (selected.confidence !== 'certified') return 'Promote this locator only after same-element count=1 proof is captured.';
  return null;
}

function hasSameElementProof(scored) {
  return !!(
    scored
    && scored.expression
    && scored.exportSafe === true
    && scored.proof
    && scored.proof.count === 1
    && scored.proof.sameElement === true
    && scored.proof.actionTimeResolved === true
    && scored.proof.identityVerified === true
    && !!scored.proof.targetIdentity?.documentId
    && !!scored.proof.targetIdentity?.nodeId
    && scored.proof.targetIdentity.documentId === scored.proof.matchedIdentity?.documentId
    && scored.proof.targetIdentity.nodeId === scored.proof.matchedIdentity?.nodeId
    && Array.isArray(scored.weaknesses)
    && scored.weaknesses.length === 0
  );
}

function certifiedFromProof(scored, { autoRepaired = false, repairedFrom = null } = {}) {
  if (!hasSameElementProof(scored)) return scored;
  return {
    ...scored,
    confidence: 'certified',
    certificationMode: scored.confidence === 'certified' ? 'gold' : 'same_element_proof',
    proof: {
      ...(scored.proof || {}),
      verified: scored.proof?.verified === true,
    },
    ...(autoRepaired ? {
      autoRepaired: true,
      repairedFrom,
      repairSource: 'locator_intelligence_v2_candidate_promotion',
    } : {}),
  };
}

function repairActionLocatorFromCandidate(scored, rawCandidate, primary, {
  toolName = null,
  elementLabel = null,
  pageUrl = null,
} = {}) {
  if (!hasSameElementProof(scored)) return null;
  const raw = rawCandidate && typeof rawCandidate === 'object' ? rawCandidate : {};
  const proof = raw.proof && typeof raw.proof === 'object' ? raw.proof : {};
  const source = scored.source
    || raw.verificationSource
    || raw.evidenceSource
    || proof.source
    || primary?.verificationSource
    || primary?.evidenceSource
    || primary?.proof?.source
    || actionLocatorResolver.ACTIVE_DOM_EXCAVATION_SOURCE;
  const playwright = scored.expression;
  return {
    kind: raw.kind || primary?.kind || 'playwright',
    verified: raw.verified === true,
    autoRepaired: true,
    repairSource: 'locator_intelligence_v2_candidate_promotion',
    verificationSource: source,
    evidenceSource: source,
    diagnosticOnly: raw.diagnosticOnly === true ? true : undefined,
    expression: playwright,
    frameworkExpressions: {
      ...(raw.frameworkExpressions && typeof raw.frameworkExpressions === 'object' ? raw.frameworkExpressions : {}),
      playwright,
    },
    strategy: scored.strategy || raw.strategy || primary?.strategy || 'candidate_promotion',
    toolName: toolName || raw.toolName || primary?.toolName || null,
    pageUrl: pageUrl || raw.pageUrl || primary?.pageUrl || null,
    elementLabel: elementLabel || raw.elementLabel || primary?.elementLabel || null,
    targetFacts: raw.targetFacts || scored.targetFacts || primary?.targetFacts || {},
    context: raw.context || scored.context || primary?.context || {},
    proof: {
      ...proof,
      count: scored.proof.count,
      sameElement: true,
      visible: scored.proof.visible,
      enabled: scored.proof.enabled,
      verified: raw.verified === true || proof.verified === true,
      actionTimeResolved: scored.proof.actionTimeResolved === true,
      resolutionMode: scored.proof.resolutionMode || proof.resolutionMode || null,
      identityVerified: scored.proof.identityVerified === true,
      targetIdentity: scored.proof.targetIdentity || proof.targetIdentity || null,
      matchedIdentity: scored.proof.matchedIdentity || proof.matchedIdentity || null,
      source,
    },
    locatorFingerprint: scored.fingerprint || null,
    ...(raw.domAtlas ? { domAtlas: raw.domAtlas } : {}),
  };
}

function buildLocatorEvidenceBundle({
  actionLocator = null,
  codegenLocator = null,
  toolName = null,
  stepOrdinal = null,
  elementLabel = null,
  pageUrl = null,
} = {}) {
  const selectedSource = actionLocatorResolver.primaryActionLocator(actionLocator)
    ? actionLocator
    : codegenLocator;
  const primary = actionLocatorResolver.primaryActionLocator(selectedSource);
  const selectedExpression = expressionOf(primary);
  const gold = actionLocatorResolver.isVerifiedActionLocator(actionLocator);
  const exportSafe = actionLocatorResolver.isExportSafeActionLocator(selectedSource);
  const rawSelected = scoreCandidate(primary || {}, { selected: true, gold, exportSafe });
  const candidatePool = uniqueCandidates([
    ...(primary?.allCandidates || []),
    ...(primary?.candidates || []),
    ...(codegenLocator && codegenLocator !== selectedSource
      ? [actionLocatorResolver.primaryActionLocator(codegenLocator)].filter(Boolean)
      : []),
  ]);
  const candidateEntries = candidatePool
    .map((candidate) => ({
      raw: candidate,
      scored: scoreCandidate(candidate, {
        selected: expressionOf(candidate) === selectedExpression,
        gold: false,
        exportSafe: actionLocatorResolver.locatorExpressionIsExportSafe(expressionOf(candidate)),
      }),
    }))
    .sort((a, b) => b.scored.score - a.scored.score);
  const promotionEntry = hasSameElementProof(rawSelected)
    ? { raw: primary, scored: rawSelected, selectedAlreadyProven: true }
    : candidateEntries.find(({ scored }) => (
      scored
      && scored.expression !== selectedExpression
      && hasSameElementProof(scored)
    ));
  const selected = promotionEntry
    ? certifiedFromProof(promotionEntry.scored, {
      autoRepaired: !promotionEntry.selectedAlreadyProven,
      repairedFrom: promotionEntry.selectedAlreadyProven ? null : selectedExpression || null,
    })
    : rawSelected;
  const candidates = candidateEntries
    .map(({ scored }) => scored)
    .slice(0, 25);
  const rejectedCandidates = [
    ...(rawSelected.expression !== selected.expression && (!rawSelected.exportSafe || rawSelected.confidence === 'unverified')
      ? [{
        expression: rawSelected.expression,
        strategy: rawSelected.strategy,
        score: rawSelected.score,
        reasons: rawSelected.weaknesses.length ? rawSelected.weaknesses : ['insufficient_proof'],
      }]
      : []),
    ...(!selected.exportSafe || selected.confidence === 'unverified'
      ? [{
        expression: selected.expression,
        strategy: selected.strategy,
        score: selected.score,
        reasons: selected.weaknesses.length ? selected.weaknesses : ['insufficient_proof'],
      }]
      : []),
    ...candidates
      .filter((candidate) => !candidate.exportSafe || candidate.confidence === 'unverified')
      .map((candidate) => ({
        expression: candidate.expression,
        strategy: candidate.strategy,
        score: candidate.score,
        reasons: candidate.weaknesses.length ? candidate.weaknesses : ['insufficient_proof'],
      })),
  ].filter((candidate, index, arr) => (
    candidate.expression
    && arr.findIndex((item) => item.expression === candidate.expression) === index
  ));
  const repairedActionLocator = promotionEntry && !promotionEntry.selectedAlreadyProven
    ? repairActionLocatorFromCandidate(selected, promotionEntry.raw, primary, { toolName, elementLabel, pageUrl })
    : null;
  const repairAttempts = promotionEntry && !promotionEntry.selectedAlreadyProven
    ? [{
      kind: 'candidate_promotion',
      status: 'applied',
      from: selectedExpression || null,
      to: selected.expression || null,
      reason: 'A captured candidate already had export-safe same-element count=1 proof, so it replaced the weaker selected locator before export.',
    }]
    : (hasSameElementProof(rawSelected) && rawSelected.confidence !== 'certified'
      ? [{
        kind: 'proof_certification',
        status: 'applied',
        from: selectedExpression || null,
        to: selectedExpression || null,
        reason: 'The selected locator already had same-element count=1 proof, so it was certified without blocking export.',
      }]
      : []);
  const weaknesses = [...new Set([
    ...selected.weaknesses,
    ...(selected.proof.count === 1 ? [] : ['count_not_proven_unique']),
    ...(selected.proof.sameElement === true ? [] : ['same_element_not_proven']),
    ...(selected.exportSafe ? [] : ['not_export_safe']),
  ])];
  const status = selected.confidence === 'certified'
    ? 'certified'
    : (selected.exportSafe && selected.expression ? 'draft' : 'blocked');
  const repairRecommendation = repairRecommendationFor(selected);

  return {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    toolName: toolName || primary?.toolName || null,
    stepOrdinal: Number.isFinite(Number(stepOrdinal)) ? Number(stepOrdinal) : null,
    elementLabel: elementLabel || primary?.elementLabel || null,
    pageUrl: pageUrl || primary?.pageUrl || null,
    fingerprint: selected.fingerprint || null,
    selected: {
      ...selected,
      provenance: selected.autoRepaired
        ? 'candidatePromotion'
        : (primary === actionLocatorResolver.primaryActionLocator(actionLocator)
        ? 'actionLocator'
        : 'codegenLocator'),
    },
    candidates,
    rejectedCandidates,
    weaknesses,
    repairAttempts,
    ...(repairedActionLocator ? { repairedActionLocator } : {}),
    repairRecommendation,
    exportGate: {
      status,
      reason: status === 'certified'
        ? (selected.autoRepaired
          ? 'Locator was auto-repaired from captured same-element evidence before export.'
          : 'Locator has export-safe expression and same-element count=1 proof.')
        : (repairRecommendation || 'Locator evidence requires repair before certification.'),
    },
    healing: selected.fingerprint ? {
      schemaVersion: HEALING_SCHEMA_VERSION,
      fingerprintHash: selected.fingerprint.hash || null,
      matchThreshold: FINGERPRINT_MATCH_THRESHOLD,
      status: status === 'certified' ? 'ready' : 'requires_certification',
    } : null,
  };
}

function normalizeGateStatus(value, fallback = 'blocked') {
  const s = String(value || '').toLowerCase();
  if (s === 'certified' || s === 'draft' || s === 'blocked') return s;
  return fallback;
}

function actSummaryForTarget(steps, target) {
  if (!target) return null;
  const match = (Array.isArray(steps) ? steps : [])
    .map((step, index) => ({ step, index }))
    .find(({ step }) => step && step.op === 'act' && step.target === target);
  if (!match) return null;
  return {
    replayStepIndex: match.index,
    action: match.step.action || null,
    locatorConfidence: match.step.locatorConfidence || null,
    stepAuthoringId: match.step.stepAuthoringId || null,
  };
}

function missingEvidenceEntry(step, index, steps) {
  const action = actSummaryForTarget(steps, step && step.as);
  return {
    replayStepIndex: index,
    replayRef: step?.as || null,
    action,
    stepAuthoringId: step?.stepAuthoringId || action?.stepAuthoringId || null,
    locatorRecipeId: step?.locatorRecipeId || null,
    elementLabel: step?.elementLabel || step?.narration || null,
    narration: step?.narration || step?.elementLabel || null,
    pageUrl: step?.actionLocator?.pageUrl || null,
    fingerprint: null,
    selected: null,
    rejectedCandidates: [],
    weaknesses: ['locator_evidence_missing'],
    repairRecommendation: 'Re-run this step with Locator Intelligence v2 enabled so QAAI captures selectable locator proof before export.',
    exportGate: {
      status: 'blocked',
      reason: 'Resolve step has no v2 locator evidence bundle.',
    },
  };
}

function certificationEntryFromResolveStep(step, index, steps) {
  const evidence = step && step.locatorEvidenceV2 && typeof step.locatorEvidenceV2 === 'object'
    ? step.locatorEvidenceV2
    : null;
  if (!evidence) return missingEvidenceEntry(step, index, steps);
  const action = actSummaryForTarget(steps, step.as);
  const selected = evidence.selected && typeof evidence.selected === 'object' ? evidence.selected : null;
  return {
    replayStepIndex: index,
    replayRef: step.as || null,
    action,
    stepAuthoringId: step.stepAuthoringId || evidence.stepAuthoringId || action?.stepAuthoringId || null,
    locatorRecipeId: step.locatorRecipeId || null,
    elementLabel: step.elementLabel || evidence.elementLabel || step.narration || null,
    narration: step.narration || step.elementLabel || evidence.elementLabel || null,
    pageUrl: evidence.pageUrl || step.actionLocator?.pageUrl || null,
    fingerprint: evidence.fingerprint || selected?.fingerprint || null,
    selected: selected ? {
      expression: selected.expression || null,
      strategy: selected.strategy || null,
      source: selected.source || null,
      score: selected.score == null ? null : Number(selected.score),
      confidence: selected.confidence || null,
      certificationMode: selected.certificationMode || null,
      autoRepaired: selected.autoRepaired === true,
      repairedFrom: selected.repairedFrom || null,
      repairSource: selected.repairSource || null,
      provenance: selected.provenance || null,
      proof: selected.proof || null,
      fingerprint: selected.fingerprint || evidence.fingerprint || null,
    } : null,
    rejectedCandidates: Array.isArray(evidence.rejectedCandidates) ? evidence.rejectedCandidates.slice(0, 25) : [],
    candidates: Array.isArray(evidence.candidates) ? evidence.candidates.slice(0, 25) : [],
    weaknesses: Array.isArray(evidence.weaknesses) ? [...new Set(evidence.weaknesses.filter(Boolean))] : [],
    repairAttempts: Array.isArray(evidence.repairAttempts) ? evidence.repairAttempts.slice(0, 10) : [],
    repairedLocator: evidence.repairedActionLocator
      ? expressionOf(actionLocatorResolver.primaryActionLocator(evidence.repairedActionLocator))
      : null,
    repairRecommendation: evidence.repairRecommendation || null,
    exportGate: {
      status: normalizeGateStatus(evidence.exportGate && evidence.exportGate.status, selected && selected.confidence === 'certified' ? 'certified' : 'draft'),
      reason: evidence.exportGate && evidence.exportGate.reason || evidence.repairRecommendation || null,
    },
  };
}

function summarizeCertificationEntries(entries) {
  const summary = {
    total: entries.length,
    certified: 0,
    draft: 0,
    blocked: 0,
    missing: 0,
    minScore: null,
    averageScore: null,
    status: entries.length ? 'certified' : 'absent',
  };
  let scoreSum = 0;
  let scoreCount = 0;
  for (const entry of entries) {
    const status = normalizeGateStatus(entry?.exportGate?.status, 'blocked');
    if (status === 'certified') summary.certified += 1;
    else if (status === 'draft') summary.draft += 1;
    else summary.blocked += 1;
    if (!entry.selected) summary.missing += 1;
    const score = entry.selected && Number(entry.selected.score);
    if (Number.isFinite(score)) {
      summary.minScore = summary.minScore == null ? score : Math.min(summary.minScore, score);
      scoreSum += score;
      scoreCount += 1;
    }
  }
  if (scoreCount) summary.averageScore = Math.round(scoreSum / scoreCount);
  summary.status = summary.blocked > 0 ? 'blocked' : (summary.draft > 0 ? 'draft' : (entries.length ? 'certified' : 'absent'));
  return summary;
}

function buildLocatorCertificationReport({ ir = null, steps = null, caseId = null, title = null } = {}) {
  const sourceSteps = Array.isArray(steps) ? steps : (Array.isArray(ir && ir.steps) ? ir.steps : []);
  const resolveSteps = sourceSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step && step.op === 'resolve');
  const hasV2Evidence = resolveSteps.some(({ step }) => step && step.locatorEvidenceV2 && typeof step.locatorEvidenceV2 === 'object');
  if (!hasV2Evidence) return null;
  const entries = resolveSteps.map(({ step, index }) => certificationEntryFromResolveStep(step, index, sourceSteps));
  const summary = summarizeCertificationEntries(entries);
  return {
    schemaVersion: CERTIFICATION_REPORT_SCHEMA_VERSION,
    evidenceSchemaVersion: SCHEMA_VERSION,
    caseId: caseId || ir?.caseId || null,
    title: title || ir?.title || null,
    summary,
    steps: entries,
  };
}

function locatorCertificationGaps(report) {
  if (!report || !Array.isArray(report.steps)) return [];
  const gaps = [];
  for (const entry of report.steps) {
    const status = normalizeGateStatus(entry?.exportGate?.status, 'blocked');
    if (status === 'certified') continue;
    const code = !entry.selected
      ? 'locator_evidence_missing'
      : (status === 'blocked' ? 'locator_certification_blocked' : 'locator_certification_draft');
    gaps.push({
      code,
      type: code,
      where: entry.stepAuthoringId || entry.replayRef || `steps[${entry.replayStepIndex}]`,
      pageUrl: entry.pageUrl || null,
      narration: entry.narration || null,
      elementLabel: entry.elementLabel || null,
      detail: entry.exportGate?.reason || entry.repairRecommendation || 'Locator certification did not reach certified status.',
      weaknesses: entry.weaknesses || [],
      selectedLocator: entry.selected?.expression || null,
    });
  }
  return gaps;
}

function locatorCertificationFindings(report, { severity = 'error' } = {}) {
  return locatorCertificationGaps(report).map((gap) => ({
    rule: gap.code || gap.type || 'locator_certification_gap',
    severity,
    stepIndex: gap.where || null,
    message: `${gap.elementLabel || gap.narration || 'Locator'} is ${gap.code === 'locator_certification_draft' ? 'draft' : 'not certified'}: ${gap.detail || 'repair required'}`,
    pageUrl: gap.pageUrl || null,
    elementLabel: gap.elementLabel || null,
    selectedLocator: gap.selectedLocator || null,
    weaknesses: gap.weaknesses || [],
  }));
}

function combineLocatorCertificationReports(reports = []) {
  const cases = (Array.isArray(reports) ? reports : []).filter((report) => report && Array.isArray(report.steps));
  if (!cases.length) return null;
  const allEntries = cases.flatMap((report) =>
    report.steps.map((entry) => ({
      ...entry,
      caseId: report.caseId || null,
      title: report.title || null,
    }))
  );
  return {
    schemaVersion: CERTIFICATION_REPORT_SET_SCHEMA_VERSION,
    evidenceSchemaVersion: SCHEMA_VERSION,
    summary: summarizeCertificationEntries(allEntries),
    cases,
  };
}

module.exports = {
  SCHEMA_VERSION,
  CERTIFICATION_REPORT_SCHEMA_VERSION,
  CERTIFICATION_REPORT_SET_SCHEMA_VERSION,
  FINGERPRINT_SCHEMA_VERSION,
  HEALING_SCHEMA_VERSION,
  FINGERPRINT_MATCH_THRESHOLD,
  PROJECT_FLAG_KEY,
  parseJsonObject,
  projectLocatorV2Enabled,
  buildLocatorFingerprint,
  scoreFingerprintMatch,
  rankHealingCandidatesByFingerprint,
  selectHealingCandidateByFingerprint,
  buildLocatorEvidenceBundle,
  buildLocatorCertificationReport,
  combineLocatorCertificationReports,
  locatorCertificationGaps,
  locatorCertificationFindings,
  scoreCandidate,
};
