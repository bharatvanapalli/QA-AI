'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const prisma = require('../server/prisma');

const PROJECT_ID = 'f8168938-ac0a-42fe-9c30-2f820aaee9dd';
const BASE_URL = process.env.QAAI_BASE_URL || 'http://127.0.0.1:5000';
const PROOF_ID = process.env.QAAI_LIVE_PROOF_ID || 'live-proof-v2';

function loadComplexFixture() {
  const filename = path.join(__dirname, '..', 'tests', 'unit', 'addScenarioSemanticComplexAcceptance.test.js');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf("const PREDECESSOR_CASE_ID");
  const end = source.indexOf("describe('Add Scenario complex semantic acceptance'");
  if (start < 0 || end <= start) throw new Error('Complex acceptance fixture boundaries were not found.');
  const expectLength = (value) => ({
    toHaveLength(expected) {
      if (!value || value.length !== expected) throw new Error(`Fixture length mismatch: expected ${expected}, received ${value && value.length}`);
    },
  });
  const factory = new Function('expect', `${source.slice(start, end)}\nreturn complexFixture;`)(expectLength);
  return factory();
}

function canonicalDate(value) {
  const map = {
    'August 20, 2026': '08/20/2026',
    'August 21, 2026': '08/21/2026',
  };
  return map[value] || value;
}

function interpretationFromPlan(fixture, predecessorCaseId) {
  const caseIntent = fixture.plan.cases[0];
  const operations = [];
  let ordinal = 0;
  for (const record of caseIntent.actions) {
    ordinal += 1;
    operations.push({
      id: `${PROOF_ID}-action-${String(ordinal).padStart(3, '0')}`,
      ordinal,
      kind: 'action',
      type: record.type,
      target: record.target && record.target.label,
      value: record.type === 'Date' ? canonicalDate(record.value) : (record.value ?? null),
      selectionCriteria: record.selection || null,
      expected: null,
      condition: record.condition || null,
      nonBlocking: false,
      reason: record.sourceQuote,
    });
  }
  for (const record of caseIntent.assertions) {
    ordinal += 1;
    const comparison = record.comparison || null;
    const temporalTarget = comparison ? `${comparison.left} vs ${comparison.right}` : null;
    const temporalExpected = comparison ? `${comparison.left} is ${comparison.relation} ${comparison.right}` : null;
    operations.push({
      id: `${PROOF_ID}-assertion-${String(ordinal).padStart(3, '0')}`,
      ordinal,
      kind: 'assertion',
      type: record.type,
      target: temporalTarget || (record.target && record.target.label),
      value: null,
      expected: record.type === 'AssertDate' ? canonicalDate(record.expected) : (temporalExpected || record.expected || null),
      comparator: record.relation || (comparison && comparison.relation) || null,
      condition: null,
      nonBlocking: record.nonBlocking === true,
      reason: record.sourceQuote,
    });
  }
  return {
    title: caseIntent.name,
    intentSummary: caseIntent.intent,
    session: {
      mode: 'continue_from_previous_case',
      predecessorCaseId,
      initialState: caseIntent.initialState,
      finalState: caseIntent.expectedFinalState,
    },
    operations,
    questions: [],
    confidence: 'high',
  };
}

async function postJson(url, body, cookie, csrf) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      'x-xsrf-token': csrf,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function main() {
  const startedAt = Date.now();
  const project = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: {
      id: true,
      user: { select: { id: true, email: true, role: true } },
      scenarioGenerations: {
        where: { isCurrent: true },
        take: 1,
        select: {
          id: true,
          scenarios: {
            select: {
              id: true,
              name: true,
              cases: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  if (!project || !project.user || !project.scenarioGenerations[0]) throw new Error('Odyssey project owner/current generation not found.');
  const generation = project.scenarioGenerations[0];
  const predecessorCase = generation.scenarios.flatMap((scenario) => scenario.cases)[0];
  if (!predecessorCase) throw new Error('Current generation has no predecessor case.');
  const fixture = loadComplexFixture();
  const interpretation = interpretationFromPlan(fixture, predecessorCase.id);
  const token = jwt.sign(
    { sub: project.user.id, email: project.user.email, role: project.user.role },
    process.env.JWT_SECRET,
    { expiresIn: '15m' },
  );
  const csrf = crypto.randomBytes(32).toString('hex');
  const cookie = `token=${encodeURIComponent(token)}; XSRF-TOKEN=${csrf}`;
  const draftResult = await postJson(
    `${BASE_URL}/api/projects/${PROJECT_ID}/scenarios/interpret-preview/draft`,
    {
      design: fixture.source,
      interpretation,
      continuationParentCaseId: predecessorCase.id,
      generationId: generation.id,
    },
    cookie,
    csrf,
  );
  const preview = draftResult && draftResult.preview;
  if (!preview || !preview.draftId || !preview.revision || !preview.approval || !preview.approval.endpoint) {
    throw Object.assign(new Error('Draft response lacks approval identity.'), { payload: draftResult });
  }
  console.log(JSON.stringify({
    stage: 'draft_registered',
    draftId: preview.draftId,
    approvalEligible: preview.approvalEligible,
    approvalEnabled: preview.approval.enabled,
    operationCount: interpretation.operations.length,
    clarificationCount: preview.clarifications && preview.clarifications.length || 0,
  }));
  const approvalResult = await postJson(
    `${BASE_URL}/api${preview.approval.endpoint}`,
    {
      revision: preview.revision,
      sourceDigest: preview.source && preview.source.digest,
      generationId: generation.id,
    },
    cookie,
    csrf,
  );
  const persisted = await prisma.scenarioGeneration.findUnique({
    where: { id: generation.id },
    select: {
      scenarios: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, cases: { select: { id: true, name: true, status: true } } },
      },
    },
  });
  const scenarios = persisted ? persisted.scenarios : [];
  if (!approvalResult.persisted || scenarios.length < 2) {
    throw Object.assign(new Error('Approval did not persist S2 beside S1.'), { payload: { approvalResult, scenarios } });
  }
  console.log(JSON.stringify({
    stage: 'approval_persisted',
    persisted: approvalResult.persisted,
    generationId: approvalResult.generationId,
    scenarioCount: scenarios.length,
    scenarios: scenarios.map((scenario) => ({ name: scenario.name, caseCount: scenario.cases.length })),
    durationMs: Date.now() - startedAt,
  }));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      stage: 'failed',
      message: error.message,
      status: error.status || null,
      payload: error.payload ? {
        success: error.payload.success,
        code: error.payload.code,
        message: error.payload.message,
        persisted: error.payload.persisted,
      } : null,
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
