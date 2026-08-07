'use strict';

const PLAYWRIGHT_FRAMEWORKS = new Set([
  'playwright-reference',
  'playwright-reference-js',
  'playwright-pom',
  'playwright-pom-js',
  'playwright-flat',
  'playwright-js',
  'playwright-bdd',
  'replayir-bdd',
]);

const SELENIUM_FRAMEWORKS = new Set([
  'selenium-reference',
  'selenium-pom',
  'selenium-java',
  'selenium-bdd',
  'selenium-bdd-reference',
]);

function normalizeStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function stripComments(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function findMatchingBrace(code, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === '{') depth += 1;
    if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryCatchRanges(code) {
  const ranges = [];
  const re = /\btry\s*\{/g;
  let match;
  while ((match = re.exec(code))) {
    const openIndex = code.indexOf('{', match.index);
    const closeIndex = findMatchingBrace(code, openIndex);
    if (closeIndex < 0) continue;
    if (/^\s*catch\b/.test(code.slice(closeIndex + 1))) {
      ranges.push([openIndex, closeIndex]);
    }
    re.lastIndex = closeIndex + 1;
  }
  return ranges;
}

function hardPlaywrightExpectIndexes(code) {
  const indexes = [];
  const re = /\bexpect\s*(?:\(|\.poll\s*\()/g;
  let match;
  while ((match = re.exec(code))) indexes.push(match.index);
  return indexes;
}

function isInsideRange(index, ranges) {
  return ranges.some(([start, end]) => index >= start && index <= end);
}

function expectationChainHasCatch(code, index) {
  const semicolon = code.indexOf(';', index);
  const newline = code.indexOf('\n', index);
  const endCandidates = [semicolon, newline].filter((value) => value >= 0);
  const end = endCandidates.length ? Math.min(...endCandidates) : Math.min(code.length, index + 1200);
  return /\.\s*catch\s*\(/.test(code.slice(index, end));
}

function assessPlaywrightParity(code) {
  const cleaned = stripComments(code);
  const hardExpectIndexes = hardPlaywrightExpectIndexes(cleaned);

  if (hardExpectIndexes.length < 1) {
    return {
      enforced: false,
      reason: 'Non-pass live case has no hard Playwright expect() assertion.',
    };
  }

  const swallowedTryCatchRanges = tryCatchRanges(cleaned);
  const hasNonSwallowedHardExpect = hardExpectIndexes.some((index) => {
    return !isInsideRange(index, swallowedTryCatchRanges) && !expectationChainHasCatch(cleaned, index);
  });

  if (!hasNonSwallowedHardExpect) {
    return {
      enforced: false,
      reason: 'Non-pass live case has no non-swallowed hard Playwright assertion.',
    };
  }

  return { enforced: true, reason: null };
}

function assessSeleniumParity(code) {
  const cleaned = stripComments(code);
  const hardAssertNames = '(?:fail|assertTrue|assertEquals|assertFalse|assertNotNull|assertNotEquals)';
  const hardAssert = new RegExp(`\\bAssert\\.${hardAssertNames}\\s*\\(|(^|[^\\w$.])${hardAssertNames}\\s*\\(`, 'm').test(cleaned);
  if (hardAssert) return { enforced: true, reason: null };

  const usesSoftAssert = /\bsoftAssert\s*\./.test(cleaned) || /\bSoftAssert\b/.test(cleaned);
  if (usesSoftAssert && /\bassertAll\s*\(/.test(cleaned)) {
    return { enforced: true, reason: null };
  }

  return {
    enforced: false,
    reason: usesSoftAssert
      ? 'Non-pass live case only uses Selenium soft assertions without assertAll().'
      : 'Non-pass live case has no hard Selenium assertion.',
  };
}

function assessParity({ framework, caseStatus, code } = {}) {
  const status = normalizeStatus(caseStatus);
  if (!status || status === 'pass' || status === 'passed') {
    return { enforced: true, reason: null };
  }

  if (status !== 'fail' && status !== 'failed' && status !== 'blocked') {
    return { enforced: true, reason: null };
  }

  const key = String(framework || '').trim().toLowerCase();
  if (PLAYWRIGHT_FRAMEWORKS.has(key)) return assessPlaywrightParity(code);
  if (SELENIUM_FRAMEWORKS.has(key)) return assessSeleniumParity(code);

  return { enforced: true, reason: null };
}

module.exports = { assessParity };
