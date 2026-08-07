'use strict';

const path = require('path');
const parser = require('@babel/parser');
const { assessParity } = require('./_parity');

const PLAYWRIGHT_BDD_FRAMEWORKS = new Set(['playwright-bdd', 'cucumber-playwright']);
const SELENIUM_BDD_FRAMEWORKS = new Set(['selenium-bdd']);

function finding(rule, severity, relPath, line, message, snippet) {
  return {
    rule,
    severity,
    path: relPath || null,
    line: line || 1,
    message,
    snippet: snippet ? String(snippet).trim().slice(0, 160) : undefined,
    engine: 'export',
  };
}

function lineOf(code, index) {
  if (!Number.isFinite(index) || index < 0) return 1;
  return String(code || '').slice(0, index).split(/\r?\n/).length;
}

function normalizeFramework(framework) {
  return String(framework || '').trim().toLowerCase();
}

function stripCommentsAndStrings(code) {
  const src = String(code || '');
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      out += '  ';
      i += 2;
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ' ';
      i += 1;
      while (i < src.length) {
        const c = src[i];
        out += c === '\n' ? '\n' : ' ';
        if (c === '\\') {
          i += 2;
          out += ' ';
          continue;
        }
        i += 1;
        if (c === quote) break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

function delimiterFinding(relPath, code) {
  const cleaned = stripCommentsAndStrings(code);
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push({ ch, index: i });
    } else if (ch === ')' || ch === ']' || ch === '}') {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        return finding('export_unbalanced_delimiters', 'error', relPath, lineOf(cleaned, i), `Unbalanced delimiter "${ch}".`);
      }
    }
  }
  if (stack.length) {
    const top = stack[stack.length - 1];
    return finding('export_unbalanced_delimiters', 'error', relPath, lineOf(cleaned, top.index), `Unclosed delimiter "${top.ch}".`);
  }
  return null;
}

function parseJsTs(relPath, code) {
  try {
    parser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      allowImportExportEverywhere: true,
      plugins: [
        'typescript',
        'jsx',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'objectRestSpread',
        'optionalChaining',
        'nullishCoalescingOperator',
        'topLevelAwait',
        'dynamicImport',
      ],
    });
    return null;
  } catch (err) {
    return finding(
      'export_syntax_error',
      'error',
      relPath,
      err.loc?.line || 1,
      `Generated JavaScript/TypeScript does not parse: ${String(err.message || err).slice(0, 180)}`
    );
  }
}

// Descriptor patterns: getByText("long description") that could never match real DOM text.
// These are agent narrations accidentally stored/emitted as locators.
const DESCRIPTOR_LOCATOR_RE = /getByText\s*\(\s*["'`]([^"'`]{40,}|[^"'`]*\b(?:button|icon|menu|row|container|toggle|field|panel|section|dropdown|checkbox|cell)\s+(?:for|in|of)\b[^"'`]*)["'`]/gi;

// getByText with a parenthetical context, e.g. "User profile menu (top right)"
const DESCRIPTOR_PAREN_RE = /getByText\s*\(\s*["'`][^"'`]*\([^)]+\)[^"'`]*["'`]/gi;

function descriptorLocatorFindings(relPath, code) {
  const findings = [];
  const text = String(code || '');
  let m;
  DESCRIPTOR_LOCATOR_RE.lastIndex = 0;
  while ((m = DESCRIPTOR_LOCATOR_RE.exec(text)) !== null) {
    findings.push(finding(
      'export_descriptor_locator',
      'error',
      relPath,
      lineOf(text, m.index),
      `Descriptor-text locator detected: getByText argument "${m[1].slice(0, 80)}" is an agent narration, not visible DOM text. This locator will always timeout.`,
      m[0].slice(0, 160)
    ));
  }
  DESCRIPTOR_PAREN_RE.lastIndex = 0;
  while ((m = DESCRIPTOR_PAREN_RE.exec(text)) !== null) {
    // Avoid double-reporting lines already caught by the length rule
    if (!findings.some((f) => f.line === lineOf(text, m.index))) {
      findings.push(finding(
        'export_descriptor_locator',
        'error',
        relPath,
        lineOf(text, m.index),
        `Descriptor-text locator detected: parenthetical context in getByText argument is an agent narration, not visible DOM text.`,
        m[0].slice(0, 160)
      ));
    }
  }
  return findings;
}

function positionalLocatorFindings(relPath, code) {
  const findings = [];
  const text = String(code || '');
  // Skip support/helper files — only enforce on spec/test files.
  if (/[\\/](?:support|helpers?|fixtures?|utils?|replayir|_[a-z])/.test(relPath)) return findings;
  // .first(), .nth(), .last(), and CSS :nth-* selectors silently narrow
  // ambiguous locators by position. Certified output must make the locator
  // specific enough to match one element by semantics/scope instead.
  const POSITIONAL_RE = /\.(first|nth|last)\s*\(\s*(?:\d+\s*)?\)/g;
  let m;
  while ((m = POSITIONAL_RE.exec(text)) !== null) {
    const call = `.${m[1]}()`;
    findings.push(finding(
      m[1] === 'first' ? 'export_first_ambiguity' : 'export_positional_locator',
      'error',
      relPath,
      lineOf(text, m.index),
      `\`${call}\` detected in certified output. Positional locator narrowing is unstable — make the locator specific enough to match exactly one element.`,
      text.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\n/g, ' ')
    ));
  }
  const POSITIONAL_CSS_RE = /:(nth-of-type|nth-child)\s*\(\s*[^)]*\)/gi;
  while ((m = POSITIONAL_CSS_RE.exec(text)) !== null) {
    findings.push(finding(
      'export_positional_locator',
      'error',
      relPath,
      lineOf(text, m.index),
      `\`:${m[1]}(...)\` detected in certified output. Use a scoped semantic locator or stable attribute instead of positional CSS.`,
      text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\n/g, ' ')
    ));
  }
  return findings;
}

function unresolvedLocatorFindings(relPath, code) {
  const findings = [];
  const text = String(code || '');
  const LOCATOR_RE = /QAAI_UNRESOLVED_LOCATOR\s*:/g;
  const LOGIN_RE = /QAAI_BROKEN_LOGIN_FLOW\s*:/g;
  let m;
  while ((m = LOCATOR_RE.exec(text)) !== null) {
    findings.push(finding(
      'export_unresolved_locator',
      'error',
      relPath,
      lineOf(text, m.index),
      'Unresolved locator marker detected. This action has no verified DOM locator from the run. Re-run the test case to capture DOM evidence, then re-export.',
      text.slice(m.index, m.index + 120).replace(/\n/g, ' ')
    ));
  }
  while ((m = LOGIN_RE.exec(text)) !== null) {
    findings.push(finding(
      'export_broken_login_flow',
      'error',
      relPath,
      lineOf(text, m.index),
      'Broken login flow detected: page.goto() was substituted for a Login button click. Use the login() helper or add an explicit Login button click.',
      text.slice(m.index, m.index + 120).replace(/\n/g, ' ')
    ));
  }
  return findings;
}

function validateCommon(relPath, code) {
  const findings = [];
  const text = String(code || '');
  if (!text.trim()) {
    findings.push(finding('export_empty_file', 'error', relPath, 1, 'Generated export file is empty.'));
    return findings;
  }
  if (/^\s*\{\s*["'](?:pageObject|test|feature|steps)["']\s*:/.test(text)) {
    findings.push(finding('export_raw_json_envelope', 'error', relPath, 1, 'Raw codegen JSON envelope leaked into a source file.'));
  }
  if (/```/.test(text)) {
    findings.push(finding('export_markdown_fence', 'error', relPath, lineOf(text, text.indexOf('```')), 'Markdown code fence leaked into generated source.'));
  }
  if (/QAAI CODEGEN FAILED/i.test(text)) {
    findings.push(finding('export_codegen_failed_stub', 'error', relPath, lineOf(text, text.search(/QAAI CODEGEN FAILED/i)), 'Generated file is a codegen failure stub, not runnable source.'));
  }
  return findings;
}

function normalizeBddStep(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'`.,;:!?()[\]{}-]+|[\s"'`.,;:!?()[\]{}-]+$/g, '')
    .trim();
}

function collectFeatureSteps(relPath, code) {
  const steps = [];
  String(code || '').split(/\r?\n/).forEach((raw, index) => {
    const match = raw.match(/^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/i);
    if (!match) return;
    const normalized = normalizeBddStep(match[2]);
    if (!normalized) return;
    steps.push({ relPath, line: index + 1, raw: raw.trim(), normalized });
  });
  return steps;
}

function validateFeature(relPath, code) {
  const findings = [];
  if (!/^\s*Feature\s*:/mi.test(code)) {
    findings.push(finding('export_feature_missing_feature', 'error', relPath, 1, 'Gherkin file has no Feature: header.'));
  }
  if (!/^\s*Scenario(?: Outline)?\s*:/mi.test(code)) {
    findings.push(finding('export_feature_missing_scenario', 'error', relPath, 1, 'Gherkin file has no Scenario: block.'));
  }
  return findings;
}

function validateBddDuplicates(featureSteps) {
  const byStep = new Map();
  for (const step of featureSteps) {
    const list = byStep.get(step.normalized) || [];
    list.push(step);
    byStep.set(step.normalized, list);
  }

  const findings = [];
  for (const [step, list] of byStep.entries()) {
    if (list.length < 2) continue;
    const last = list[list.length - 1];
    findings.push(finding(
      'export_bdd_duplicate_step',
      'error',
      last.relPath,
      last.line,
      `Duplicate BDD step sentence "${step}" appears ${list.length} times and can create duplicate step definitions.`,
      last.raw
    ));
  }
  return findings;
}

function validateJava(relPath, code, framework) {
  const findings = [];
  const balance = delimiterFinding(relPath, code);
  if (balance) findings.push(balance);

  const classMatch = String(code || '').match(/\b(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
  const expectedClass = path.basename(relPath).replace(/\.java$/i, '');
  if (classMatch && classMatch[1] !== expectedClass) {
    findings.push(finding(
      'export_java_class_filename_mismatch',
      'error',
      relPath,
      lineOf(code, classMatch.index),
      `Java class "${classMatch[1]}" does not match file name "${expectedClass}.java".`
    ));
  }

  if (/Test\.java$/i.test(relPath) && !/@Test\b/.test(code)) {
    findings.push(finding('export_java_missing_test_annotation', 'error', relPath, 1, 'Selenium TestNG test file has no @Test method.'));
  }

  const fw = normalizeFramework(framework);
  if (SELENIUM_BDD_FRAMEWORKS.has(fw) && /[\\/]steps[\\/].+\.java$/i.test(relPath) && !/@(?:Given|When|Then|And|But)\s*\(/.test(code)) {
    findings.push(finding('export_bdd_missing_step_annotation', 'error', relPath, 1, 'Cucumber step class has no Given/When/Then/And/But annotation.'));
  }

  return findings;
}

function validateExport({ framework, caseStatus, files } = {}) {
  const entries = Object.entries(files || {}).filter(([, content]) => typeof content === 'string');
  const findings = [];
  const featureSteps = [];
  const fw = normalizeFramework(framework);

  if (!entries.length) {
    findings.push(finding('export_no_files', 'error', null, 1, 'Codegen produced no export files.'));
  }

  for (const [relPath, code] of entries) {
    findings.push(...validateCommon(relPath, code));

    if (/\.(ts|js)$/i.test(relPath)) {
      const syntax = parseJsTs(relPath, code);
      if (syntax) findings.push(syntax);
      findings.push(...descriptorLocatorFindings(relPath, code));
      findings.push(...positionalLocatorFindings(relPath, code));
      findings.push(...unresolvedLocatorFindings(relPath, code));
    }

    if (/\.java$/i.test(relPath)) {
      findings.push(...validateJava(relPath, code, fw));
    }

    if (/\.feature$/i.test(relPath)) {
      findings.push(...validateFeature(relPath, code));
      featureSteps.push(...collectFeatureSteps(relPath, code));
    }
  }

  if (PLAYWRIGHT_BDD_FRAMEWORKS.has(fw) || SELENIUM_BDD_FRAMEWORKS.has(fw)) {
    findings.push(...validateBddDuplicates(featureSteps));
  }

  const parityCode = entries
    .filter(([relPath]) => !/\.feature$/i.test(relPath))
    .map(([relPath, content]) => `// ${relPath}\n${content}`)
    .join('\n\n');
  const parity = assessParity({ framework: fw, caseStatus, code: parityCode });
  if (!parity.enforced) {
    findings.push(finding(
      'export_parity_inversion',
      'error',
      null,
      1,
      parity.reason || 'Non-pass export does not contain a hard failing assertion.'
    ));
  }

  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  return {
    exportPassed: errorCount === 0,
    findings,
    errorCount,
    warningCount,
  };
}

module.exports = {
  validateExport,
  normalizeBddStep,
};
