'use strict';

const caseContractV1 = require('./caseContractV1');

const SECTION_RE = /^\s*([A-Za-z][A-Za-z0-9 /_-]{0,80})\s*:\s*(.*)$/;
const MAX_FINAL_ASSERTIONS = 100;
const KNOWN_SECTION_HEADERS = new Set([
  'requirement title',
  'target url',
  'test data',
  'scenario',
  'authoring rule',
  'test case',
  'steps',
  'final validation',
  'preferred validation',
  'preferred final assertion',
  'session policy',
  'data binding rule',
  'expected scenario test case shape',
  'expected scenario shape',
  'expected test case shape',
]);

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function tokenName(label) {
  const text = clean(label).toLowerCase();
  if (/\b(email|e-mail|mail)\b/.test(text)) return 'email';
  if (/\b(pass(word)?|pwd|secret)\b/.test(text)) return 'password';
  if (/\b(user(name)?|login|account)\b/.test(text)) return 'username';
  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || null;
}

function normalizeHeader(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function splitSections(text) {
  const sections = [];
  let current = null;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const match = rawLine.match(SECTION_RE);
    const normalized = match ? normalizeHeader(match[1]) : '';
    if (match && KNOWN_SECTION_HEADERS.has(normalized)) {
      current = {
        header: normalized,
        rawHeader: clean(match[1]),
        lines: match[2] ? [match[2]] : [],
      };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  return sections;
}

function sectionBody(sections, headers) {
  const wanted = new Set(headers.map(normalizeHeader));
  const found = sections.find((section) => wanted.has(section.header));
  return found ? found.lines.join('\n').trim() : '';
}

function firstNumber(text, pattern) {
  const match = String(text || '').match(pattern);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseTestData(body) {
  const entries = [];
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
    if (!line) continue;
    const match = line.match(/^([^:]{2,80})\s*:\s*(.+)$/);
    if (!match) continue;
    const label = clean(match[1]);
    const value = clean(match[2]);
    const token = tokenName(label);
    if (!token || !value) continue;
    entries.push({ label, token, value });
  }
  const seen = new Set();
  return entries.filter((entry) => {
    if (seen.has(entry.token)) return false;
    seen.add(entry.token);
    return true;
  });
}

function parseFinalAssertions(text) {
  const sectionText = [
    sectionBody(splitSections(text), ['Preferred Final Assertion']),
    sectionBody(splitSections(text), ['Final Validation']),
  ].filter(Boolean).join('\n');
  const fallbackLines = [];
  if (!sectionText) {
    for (const rawLine of String(text || '').split(/\r?\n/)) {
      const line = rawLine.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim();
      if (!line) continue;
      if (/\b(final validation|preferred final assertion|test passes only when|passes only when|verify that|validate that|assert that|should show|should display|is visible|is displayed)\b/i.test(line)) {
        fallbackLines.push(line);
      }
    }
  }
  const body = sectionText || fallbackLines.join('\n');
  const quoted = [];
  const re = /"([^"]{2,120})"/g;
  let match;
  while ((match = re.exec(body)) !== null) quoted.push(clean(match[1]));
  if (quoted.length) return [...new Set(quoted)].slice(0, MAX_FINAL_ASSERTIONS);
  if (!sectionText) return [];
  const bullets = [];
  for (const rawLine of sectionText.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, '').trim();
    if (line && line.length <= 120 && !/:$/.test(line)) bullets.push(line);
  }
  return [...new Set(bullets)].slice(0, MAX_FINAL_ASSERTIONS);
}

function extractProceduralFlowContract(requirements = []) {
  const docs = Array.isArray(requirements) ? requirements : [];
  const text = docs.map((r) => `${r && r.title || ''}\n${r && r.content || ''}`).join('\n\n---\n\n');
  const compiledCaseContract = caseContractV1.compileCaseContractV1(docs);
  const sections = splitSections(text);
  const hasScenario = /^\s*scenario\s*:/im.test(text);
  const hasTestCase = /^\s*test\s*case\s*:/im.test(text);
  const hasTestCaseList = /^\s*test\s*cases\s*:/im.test(text);
  const hasSteps = /^\s*steps\s*:/im.test(text) && /^\s*\d+[.)]\s+\S+/m.test(text);
  const hasTestData = /^\s*test\s+data\s*:/im.test(text);
  const finalAssertions = parseFinalAssertions(text);
  const hasFinalOracle = /^\s*(final|preferred)\s+validation\s*:/im.test(text)
    || /^\s*preferred\s+final\s+assertion\s*:/im.test(text)
    || finalAssertions.length > 0
    || /\b(test passes only when|passes only when|final validation|verify that .{2,120}\b(?:is|are)\s+(?:visible|displayed|shown))\b/i.test(text);
  const hasCompiledSteps = compiledCaseContract.cases.some((item) => Array.isArray(item.steps) && item.steps.length > 0);
  const isProcedural = !!((hasSteps && (hasScenario || hasTestCase || hasTestData))
    || hasCompiledSteps
    || hasTestCaseList
    || compiledCaseContract.cases.length > 1);

  const expectedScenarioCount = firstNumber(text, /expected\s+scenario\s+count\s*:\s*(\d+)/i);
  const expectedTestCaseCount = firstNumber(text, /expected\s+test\s+case\s+count\s*:\s*(\d+)/i);
  const explicitOneFlow = !!compiledCaseContract.partitioning.explicitOneFlow;
  // `strictOneCase` remains for legacy readers, but it is now derived only from
  // an authored one-flow behavioral partition. Numeric count hints alone never
  // impose a quota on generation.
  const singleBehavioralPartition = isProcedural && explicitOneFlow && compiledCaseContract.cases.length === 1;
  const strictOneCase = singleBehavioralPartition;

  const testData = compiledCaseContract.dataDictionary.map((entry) => {
    const source = entry && entry.source || {};
    const safeValue = source.kind === 'inline' && entry.classification !== 'sensitive'
      ? source.value
      : (source.kind === 'environment' ? `\${${source.name}}` : `{{${entry.name}}}`);
    return {
      label: entry.label,
      token: entry.name,
      value: safeValue,
      classification: entry.classification,
      source,
    };
  });
  const targetUrl = (sectionBody(sections, ['Target URL']).match(/https?:\/\/\S+/i) || [])[0] || null;

  return {
    isProcedural,
    strictOneCase,
    singleBehavioralPartition,
    controlsFixedQuota: false,
    explicitOneFlow,
    expectedScenarioCount,
    expectedTestCaseCount,
    testData,
    targetUrl,
    finalAssertions,
    caseContractV1: compiledCaseContract,
  };
}

function tokenSet(contract) {
  const legacy = contract && Array.isArray(contract.testData) ? contract.testData : [];
  const dictionary = contract && contract.caseContractV1 && Array.isArray(contract.caseContractV1.dataDictionary)
    ? contract.caseContractV1.dataDictionary
    : [];
  return new Set([
    ...legacy.map((entry) => entry.token),
    ...dictionary.map((entry) => entry.name),
  ].filter(Boolean));
}

module.exports = {
  extractProceduralFlowContract,
  tokenSet,
  _private: {
    clean,
    splitSections,
    parseTestData,
    parseFinalAssertions,
    tokenName,
  },
};
