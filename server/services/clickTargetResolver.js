'use strict';

const { parseSnapshotLine } = require('./mcp');

const CLICKABLE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menu-item',
  'option',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'treeitem',
  'combobox',
  'textbox',
  'searchbox',
  'spinbutton',
]);
const OPTION_LIKE_ROLES = new Set([
  'option', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'treeitem', 'listitem',
]);

const IDENTITY_STOP_WORDS = new Set([
  'a', 'an', 'the', 'button', 'link', 'control', 'item', 'click', 'tap',
  'press', 'select', 'choose', 'on', 'with', 'please', 'field', 'input',
  'calendar', 'picker',
]);

const ROLE_HINT_PATTERNS = [
  { phrase: 'radio button', role: 'radio' },
  { phrase: 'menu item', role: 'menuitem' },
  { phrase: 'tree item', role: 'treeitem' },
  { phrase: 'check box', role: 'checkbox' },
  { phrase: 'button', role: 'button' },
  { phrase: 'link', role: 'link' },
  { phrase: 'menuitem', role: 'menuitem' },
  { phrase: 'option', role: 'option' },
  { phrase: 'tab', role: 'tab' },
  { phrase: 'checkbox', role: 'checkbox' },
  { phrase: 'radio', role: 'radio' },
  { phrase: 'switch', role: 'switch' },
  { phrase: 'treeitem', role: 'treeitem' },
  { phrase: 'combo box', role: 'combobox' },
  { phrase: 'combobox', role: 'combobox' },
  { phrase: 'dropdown', role: 'combobox' },
  { phrase: 'text box', role: 'textbox' },
  { phrase: 'textbox', role: 'textbox' },
];

const CONTEXT_SURFACE_NOUNS = 'page|screen|dialog|form|section';

function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value) {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length > 1 && !IDENTITY_STOP_WORDS.has(token));
}

function parseAuthoredIntent(authoredLabel, explicitContextTokens, explicitRole) {
  const authoredNormalized = normalize(authoredLabel);
  // Greedy identity capture intentionally selects the final scope preposition;
  // for example, "Sign in button on Account page" keeps "Sign in" intact.
  const scopeMatch = authoredNormalized.match(
    new RegExp(`^(.*)\\s+(?:on|in)\\s+(.+?)\\s+(${CONTEXT_SURFACE_NOUNS})$`, 'i'),
  );
  const identityClause = normalize(scopeMatch ? scopeMatch[1] : authoredNormalized);
  const scopeClause = normalize(scopeMatch ? scopeMatch[2] : '');

  let roleHint = CLICKABLE_ROLES.has(normalize(explicitRole)) ? normalize(explicitRole) : null;
  let identityWithoutRole = identityClause;
  for (const hint of ROLE_HINT_PATTERNS) {
    const phrasePattern = new RegExp(`\\b${hint.phrase.replace(/ /g, '\\s+')}\\b`, 'i');
    if (!roleHint && phrasePattern.test(identityClause)) roleHint = hint.role;
    identityWithoutRole = identityWithoutRole.replace(phrasePattern, ' ');
  }

  const identityTokens = Array.from(new Set(tokens(identityWithoutRole)));
  const suppliedContext = Array.isArray(explicitContextTokens)
    ? explicitContextTokens.join(' ')
    : explicitContextTokens;
  const contextTokens = Array.from(new Set([
    ...tokens(scopeClause),
    ...tokens(suppliedContext),
  ]));

  return {
    identityTokens,
    identityNormalized: normalize(identityTokens.join(' ')),
    contextTokens,
    roleHint,
    hasScopeClause: !!scopeMatch,
  };
}

function safeDiagnostics(intent) {
  return {
    contract: {
      identityTokenCount: intent.identityTokens.length,
      contextTokenCount: intent.contextTokens.length,
      roleHint: intent.roleHint,
      hasScopeClause: intent.hasScopeClause,
    },
    considered: [],
    rejected: [],
    scored: [],
  };
}

function publicCandidate(candidate) {
  return {
    ref: candidate.ref,
    role: candidate.role,
    name: candidate.name,
    score: candidate.score,
    nameHitCount: candidate.nameHits.length,
    contextHitCount: candidate.contextHits.length,
    roleMatch: candidate.roleMatch,
  };
}

function indentation(line) {
  return (String(line || '').match(/^\s*/) || [''])[0].length;
}

function structuralContext(rows, candidateIndex) {
  const candidate = rows[candidateIndex];
  if (!candidate) return '';
  let parentIndex = -1;
  for (let index = candidateIndex - 1; index >= 0; index -= 1) {
    if (rows[index].indent < candidate.indent) {
      parentIndex = index;
      break;
    }
  }

  const selected = [];
  if (parentIndex >= 0) {
    let segmentStart = parentIndex;
    for (let index = parentIndex; index < candidateIndex; index += 1) {
      if (rows[index].clickable) segmentStart = index + 1;
    }
    for (let index = segmentStart; index < candidateIndex; index += 1) {
      if (!rows[index].clickable) selected.push(rows[index].identityText);
    }
    let parentIndent = rows[parentIndex].indent;
    for (let index = parentIndex - 1; index >= 0 && parentIndent > 0; index -= 1) {
      if (rows[index].indent < parentIndent) {
        if (!rows[index].clickable) selected.push(rows[index].identityText);
        parentIndent = rows[index].indent;
      }
    }
  } else {
    for (let index = candidateIndex - 1; index >= Math.max(0, candidateIndex - 4); index -= 1) {
      if (rows[index].clickable) break;
      if (rows[index].identityText) selected.unshift(rows[index].identityText);
    }
  }
  return selected.filter(Boolean).join(' ');
}

function snapshotRows(snapshotText) {
  return String(snapshotText || '').split(/\r?\n/).map((line, index) => {
    const parsed = parseSnapshotLine(line);
    const role = String(parsed?.role || '').toLowerCase();
    const identityText = [
      parsed?.name,
      parsed?.placeholder,
      parsed?.idAttr,
      parsed?.testid,
      parsed?.rest,
    ].filter(Boolean).join(' ');
    return {
      index,
      line,
      indent: indentation(line),
      parsed,
      role,
      clickable: CLICKABLE_ROLES.has(role),
      identityText,
    };
  });
}

function resolveClickableControl(snapshotText, targetContract = {}) {
  const allowNonInteractive = targetContract?.allowNonInteractive === true;
  const authoredLabel = String(
    targetContract?.authoredLabel
    || targetContract?.label
    || targetContract?.name
    || targetContract?.target
    || targetContract
    || '',
  ).trim();
  const intent = parseAuthoredIntent(
    authoredLabel,
    targetContract?.contextTokens,
    targetContract?.role,
  );
  const diagnostics = safeDiagnostics(intent);
  if (!snapshotText || !intent.identityTokens.length) {
    return {
      ok: false,
      ref: null,
      control: null,
      reason: allowNonInteractive ? 'missing_snapshot_target_identity' : 'missing_clickable_target_identity',
      candidates: [],
      diagnostics,
    };
  }

  const rows = snapshotRows(snapshotText);
  const candidates = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const parsed = row.parsed;
    if ((!row.clickable && !allowNonInteractive) || !parsed?.ref) continue;

    const diagnosticBase = {
      candidateIndex: index,
      role: row.role,
      disabled: !!parsed.disabled,
    };
    diagnostics.considered.push(diagnosticBase);
    if (parsed.disabled) {
      diagnostics.rejected.push({ ...diagnosticBase, reason: 'disabled' });
      continue;
    }

    const liveName = String(parsed.name || '').trim();
    const liveNormalized = normalize(liveName);
    const liveTokens = new Set(tokens(liveName));
    const contextText = structuralContext(rows, index);
    const contextTokenSet = new Set(tokens(contextText));
    const nameHits = intent.identityTokens.filter((token) => liveTokens.has(token));
    const structuralIdentityHits = !liveNormalized
      ? intent.identityTokens.filter((token) => contextTokenSet.has(token))
      : [];
    const contextHits = intent.contextTokens.filter((token) => contextTokenSet.has(token));
    const exactName = !!liveNormalized && liveNormalized === intent.identityNormalized;
    const containedName = !!liveNormalized
      && !!intent.identityNormalized
      && (intent.identityNormalized.includes(liveNormalized)
        || liveNormalized.includes(intent.identityNormalized));
    const roleMatch = intent.roleHint ? row.role === intent.roleHint : null;
    if (intent.roleHint === 'option' && !OPTION_LIKE_ROLES.has(row.role)) {
      diagnostics.rejected.push({ ...diagnosticBase, reason: 'option_role_required' });
      continue;
    }
    const identityCoverage = intent.identityTokens.length
      ? nameHits.length / intent.identityTokens.length
      : 0;
    const structuralIdentityCoverage = intent.identityTokens.length
      ? structuralIdentityHits.length / intent.identityTokens.length
      : 0;

    if (!exactName && nameHits.length === 0 && structuralIdentityCoverage < (2 / 3)) {
      diagnostics.rejected.push({ ...diagnosticBase, reason: 'no_identity_overlap' });
      continue;
    }
    if (!exactName && !containedName
      && Math.max(identityCoverage, structuralIdentityCoverage) < (2 / 3)) {
      diagnostics.rejected.push({
        ...diagnosticBase,
        reason: 'semantic_identity_incomplete',
        nameHitCount: nameHits.length,
        identityTokenCount: intent.identityTokens.length,
      });
      continue;
    }

    let score = nameHits.length * 20 + contextHits.length * 25;
    score += structuralIdentityHits.length * 25;
    if (exactName) score += 200;
    else if (containedName) score += 100;
    if (nameHits.length === intent.identityTokens.length) score += 80;
    if (!liveNormalized && structuralIdentityHits.length === intent.identityTokens.length) score += 90;
    if (roleMatch) score += 30;

    const scoredDiagnostic = {
      ...diagnosticBase,
      exactName,
      containedName,
      roleMatch,
      nameHitCount: nameHits.length,
      identityCoverage,
      structuralIdentityHitCount: structuralIdentityHits.length,
      structuralIdentityCoverage,
      contextHitCount: contextHits.length,
      score,
    };
    diagnostics.scored.push(scoredDiagnostic);
    if (score < 80) {
      diagnostics.rejected.push({ ...scoredDiagnostic, reason: 'score_below_threshold' });
      continue;
    }

    candidates.push({
      ref: parsed.ref,
      role: row.role,
      name: liveName,
      score,
      nameHits,
      structuralIdentityHits,
      contextHits,
      roleMatch,
      index,
    });
  }

  candidates.sort((left, right) => right.score - left.score || left.index - right.index);
  const best = candidates[0];
  if (!best) {
    return {
      ok: false,
      ref: null,
      control: null,
      reason: allowNonInteractive ? 'no_snapshot_element' : 'no_clickable_control',
      candidates: [],
      diagnostics,
    };
  }
  const runnerUp = candidates[1];
  if (runnerUp && best.score - runnerUp.score < 20) {
    return {
      ok: false,
      ref: null,
      control: null,
      reason: allowNonInteractive ? 'ambiguous_snapshot_element' : 'ambiguous_clickable_control',
      candidates: candidates.slice(0, 5).map(publicCandidate),
      diagnostics,
    };
  }

  const control = { ref: best.ref, role: best.role, name: best.name };
  return {
    ok: true,
    ref: best.ref,
    control,
    reason: allowNonInteractive ? 'snapshot_element_resolved' : 'clickable_control_resolved',
    confidenceMargin: runnerUp ? best.score - runnerUp.score : best.score,
    evidence: {
      nameHitCount: best.nameHits.length,
      contextHitCount: best.contextHits.length,
      identityTokenCount: intent.identityTokens.length,
      contextTokenCount: intent.contextTokens.length,
      roleHint: intent.roleHint,
      roleMatch: best.roleMatch,
    },
    candidates: candidates.slice(0, 5).map(publicCandidate),
    diagnostics,
  };
}

function resolveSnapshotElement(snapshotText, targetContract = {}) {
  return resolveClickableControl(snapshotText, {
    ...targetContract,
    allowNonInteractive: true,
  });
}

module.exports = {
  CLICKABLE_ROLES,
  resolveClickableControl,
  resolveSnapshotElement,
};
