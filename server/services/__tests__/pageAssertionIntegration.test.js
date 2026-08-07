'use strict';

/**
 * Integration tests for Day 3 + Day 4 of the PAGE assertion sprint.
 *
 * Exercises:
 *   - checkAssertion's PAGE dispatch path (via pageAssertion arg)
 *   - PAGE-level semantic rescue (mocked semanticVerify)
 *   - Atlas extraction on rescue success (mocked recordRescueAtlas)
 *   - Atlas signal half-weight (Day 4a)
 *   - Strict corroboration trigger (Day 4b)
 *   - computeVerdict degraded-pass tier with warnings array (FRIEND R3)
 *   - pageAtlas.extractSignalsFromSnapshot heuristic
 *   - pageAtlas.recordRescuedSignals + bumpVerifiedSignals (Prisma-free
 *     mock so the test runs without DB)
 *
 * Run with:
 *   node server/services/__tests__/pageAssertionIntegration.test.js
 */

const mcp = require('../mcp');
const { computeVerdict } = require('../computeVerdict');
const { extractSignalsFromSnapshot, recordRescuedSignals, bumpVerifiedSignals } = require('../pageAtlas');

let failures = 0;
function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  PASS  ${label}`); }
  else {
    console.log(`  FAIL  ${label}`);
    console.log(`        expected: ${JSON.stringify(expected)}`);
    console.log(`        actual:   ${JSON.stringify(actual)}`);
    failures += 1;
  }
}

const LOGIN_SNAP = `
- generic [ref=e1]:
  - heading "Swag Labs" [level=1] [ref=e3]
  - textbox "Username" [ref=e11]
  - textbox "Password" [ref=e13]
  - button "Login" [ref=e15]
  - link "Forgot password?" [ref=e30]
`.trim();

function makeSession(opts = {}) {
  return {
    id: 'sess-test',
    lastSnapshot: opts.snapshot || LOGIN_SNAP,
    currentUrl: opts.currentUrl || 'https://www.saucedemo.com/',
    pageAtlas: opts.atlas || {},
    semanticFallback: !!opts.semanticFallback,
    semanticVerify: opts.semanticVerify || null,
    recordRescueAtlas: opts.recordRescueAtlas || null,
    bumpAtlasVerifiedCount: opts.bumpAtlasVerifiedCount || null,
    visitedUrls: new Set(),
  };
}

function parseResult(toolResult) {
  try { return JSON.parse(toolResult.content[0].text); } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('Day 3 — checkAssertion dispatches PAGE assertions through the matcher');
{
  const session = makeSession();
  (async () => {
    const out = await mcp.checkAssertion(session, {
      pageAssertion: {
        pageName: 'login_page',
        expectedSignals: {
          text: ['Username'],
          role: [{ role: 'textbox', name: 'Username' }],
          url:  ['/saucedemo'],
        },
      },
    });
    const r = parseResult(out);
    expect('PAGE dispatched: matched', r.matched, true);
    expect('PAGE dispatched: source=deterministic', r.source, 'deterministic');
    expect('PAGE dispatched: signalsHit has role', !!r.signalsHit.role, true);
  })().catch((e) => { console.error('threw:', e); failures += 1; });
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('Day 3 — PAGE-level semantic rescue when quorum fails');
(async () => {
  // Architect's signals all miss. semantic verifier says it IS the login
  // page. Atlas write helper is called with extracted signals.
  const atlasWrites = [];
  const session = makeSession({
    semanticFallback: true,
    semanticVerify: async ({ assertionText, assertionType }) => {
      expect('semantic verifier received PAGE type',     assertionType, 'PAGE');
      expect('semantic verifier received page-level text',
        /login_page/.test(assertionText), true);
      return { outcome: 'matched', reasoning: 'snapshot shows Username textbox + Login button' };
    },
    recordRescueAtlas: async ({ pageName, signals, source }) => {
      atlasWrites.push({ pageName, signals, source });
      return { wrote: true, mergedSignals: 3 };
    },
  });
  const out = await mcp.checkAssertion(session, {
    pageAssertion: {
      pageName: 'login_page',
      expectedSignals: {
        text: ['Nonexistent text'],
        role: [{ role: 'textbox', name: 'Email' }],     // saucedemo says "Username", not "Email"
        url:  ['/login'],                                // saucedemo is at /
      },
    },
  });
  const r = parseResult(out);
  expect('semantic-rescued: matched=true', r.matched, true);
  expect('semantic-rescued: source=semantic_rescue', r.source, 'semantic_rescue');
  expect('atlas write happened exactly once',  atlasWrites.length, 1);
  expect('atlas write: pageName=login_page',  atlasWrites[0].pageName, 'login_page');
  expect('atlas write: source=semantic_rescue', atlasWrites[0].source, 'semantic_rescue');
  expect('atlas extracted text signals from snapshot',
    Array.isArray(atlasWrites[0].signals.text) && atlasWrites[0].signals.text.length > 0, true);
  expect('atlas extracted role signals from snapshot',
    Array.isArray(atlasWrites[0].signals.role) && atlasWrites[0].signals.role.length > 0, true);
})().catch((e) => { console.error('threw:', e); failures += 1; });

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('Day 3 — semantic verifier says not_matched: outcome stays not_matched');
(async () => {
  const session = makeSession({
    semanticFallback: true,
    semanticVerify: async () => ({ outcome: 'not_matched', reasoning: 'this looks like the checkout page, not login' }),
  });
  const out = await mcp.checkAssertion(session, {
    pageAssertion: {
      pageName: 'login_page',
      expectedSignals: { text: ['Nope'], role: [{ role: 'textbox', name: 'Nope' }] },
    },
  });
  const r = parseResult(out);
  expect('semantic verdict not_matched: matched=false', r.matched, false);
  expect('semantic verdict not_matched: reason=semantic_not_matched', r.reason, 'semantic_not_matched');
})().catch((e) => { console.error('threw:', e); failures += 1; });

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('Day 3 — no semantic fallback enabled: stays page_quorum_failed');
(async () => {
  const session = makeSession({ semanticFallback: false });
  const out = await mcp.checkAssertion(session, {
    pageAssertion: {
      pageName: 'login_page',
      expectedSignals: { text: ['Nope'], role: [{ role: 'textbox', name: 'Nope' }] },
    },
  });
  const r = parseResult(out);
  expect('no fallback: matched=false', r.matched, false);
  expect('no fallback: reason=page_quorum_failed', r.reason, 'page_quorum_failed');
})().catch((e) => { console.error('threw:', e); failures += 1; });

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('Day 4 — atlas signals at half-weight: text alone (0.5) cannot push to threshold');
{
  // Architect signal: only a non-matching URL (no contribution).
  // Atlas has unverified text="Username" (0.5pt). 0.5 < 2 → fail.
  const r = mcp.matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: { url: ['/nope'] },
  }, {
    snapshot: LOGIN_SNAP,
    currentUrl: 'https://example.com/',
    atlasSignals: {
      text: [{ value: 'Username', source: 'semantic_rescue', verifiedCount: 0 }],
    },
  });
  expect('atlas unverified text alone (0.5pt): below threshold', r.matched, false);
  expect('atlas unverified text alone: score=0.5', r.score, 0.5);
}

console.log('');
console.log('Day 4 — atlas unverified role (1pt = 2*0.5) + architect text (1pt) = 2pt PASS');
{
  const r = mcp.matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: { text: ['Swag Labs'] },             // architect text — matches LOGIN_SNAP heading
  }, {
    snapshot: LOGIN_SNAP,
    currentUrl: 'https://example.com/utterly-unrelated',
    atlasSignals: {
      role: [{ value: { role: 'textbox', name: 'Username' }, source: 'semantic_rescue', verifiedCount: 0 }],
    },
  });
  expect('atlas unverified role + architect text: passes', r.matched, true);
  expect('atlas unverified role + architect text: score=2.0', r.score, 2);
}

console.log('');
console.log('Day 4 — atlas VERIFIED role contributes full weight (2pt) and passes alone');
{
  const r = mcp.matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: { url: ['/never-going-to-appear-anywhere-promise'] },
  }, {
    snapshot: LOGIN_SNAP,
    currentUrl: 'https://example.com/totally-different-path',
    atlasSignals: {
      role: [{ value: { role: 'textbox', name: 'Username' }, source: 'verified', verifiedCount: 5 }],
    },
  });
  expect('atlas verified role alone: passes', r.matched, true);
  expect('atlas verified role: score=2', r.score, 2);
}

console.log('');
console.log('Day 4 — matchedAtlasSignals returned for corroboration trigger');
{
  const r = mcp.matchPageAssertion(null, {
    pageName: 'login_page',
    expectedSignals: {
      text: ['Username'],
      role: [{ role: 'textbox', name: 'Username' }],
    },
  }, {
    snapshot: LOGIN_SNAP,
    currentUrl: 'https://example.com/',
    atlasSignals: {
      text: [{ value: 'Username', source: 'semantic_rescue', verifiedCount: 0 }],
      role: [{ value: { role: 'textbox', name: 'Username' }, source: 'semantic_rescue', verifiedCount: 0 }],
    },
  });
  expect('matched (architect signals win, atlas was harmless)', r.matched, true);
  expect('matchedAtlasSignals.text recorded the Username hit',
    r.matchedAtlasSignals.text, ['Username']);
  expect('matchedAtlasSignals.role recorded the Username textbox',
    r.matchedAtlasSignals.role, [{ role: 'textbox', name: 'Username' }]);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('Day 4 — computeVerdict degraded-pass warnings');
{
  const base = (over = {}) => ({
    declared: [{ id: 'A', type: 'PAGE', payload: { pageName: 'p', expectedSignals: { text: ['x'] } } }],
    recorded: [{ assertionId: 'A', outcome: 'matched', source: 'deterministic', effective: 'matched' }],
    steps: [{ status: 'pass' }],
    reachedEndTurn: true,
    hitTurnCeiling: false,
    ...over,
  });
  {
    const r = computeVerdict(base());
    expect('clean pass: no warnings', r.warnings, undefined);
  }
  {
    const r = computeVerdict(base({
      recorded: [{ assertionId: 'A', outcome: 'matched', source: 'semantic_rescue', effective: 'matched' }],
    }));
    expect('rescued pass without exec noise: warning=passed_via_semantic_rescue',
      r.warnings, ['passed_via_semantic_rescue']);
  }
  {
    const r = computeVerdict(base({
      recorded: [{ assertionId: 'A', outcome: 'matched', source: 'semantic_rescue', effective: 'matched' }],
      steps: [{ status: 'pass' }, { status: 'fail' }, { status: 'pass' }],
    }));
    expect('rescued + step.fail recovered: warning=degraded_verification_with_recovered_step_errors',
      r.warnings, ['degraded_verification_with_recovered_step_errors']);
    expect('still passes (warnings are non-blocking)', r.status, 'pass');
  }
  {
    const r = computeVerdict(base({
      recorded: [{ assertionId: 'A', outcome: 'matched', source: 'semantic_rescue', effective: 'matched' }],
      steps: [{ status: 'pass' }, { status: 'blocked' }, { status: 'pass' }],
    }));
    expect('rescued + step.blocked recovered: warning=degraded_verification_with_recovered_step_errors',
      r.warnings, ['degraded_verification_with_recovered_step_errors']);
  }
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('pageAtlas.extractSignalsFromSnapshot heuristic');
{
  const sig = extractSignalsFromSnapshot(LOGIN_SNAP, 'https://www.saucedemo.com/');
  expect('role signals captured',  sig.role.length > 0, true);
  expect('text signals captured',  sig.text.length > 0, true);
  expect('url signal is /',         sig.url, ['/']);
  // Specific assertions about content
  const hasUsernameRole = sig.role.some((r) => r.role === 'textbox' && r.name === 'Username');
  expect('role includes textbox[Username]', hasUsernameRole, true);
  // "Swag Labs" heading should be in text signals
  expect('text includes Swag Labs', sig.text.includes('Swag Labs'), true);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('pageAtlas.recordRescuedSignals + bumpVerifiedSignals (Prisma mock)');
(async () => {
  // Mock Prisma in-memory.
  let storedJson = null;
  const fakePrisma = {
    project: {
      findUnique: async () => ({ pageAtlas: storedJson }),
      update: async ({ data }) => { storedJson = data.pageAtlas; return {}; },
    },
  };

  // First rescue write — creates atlas entry.
  await recordRescuedSignals(fakePrisma, 'proj-1', 'login_page', {
    text: ['Username'],
    role: [{ role: 'textbox', name: 'Username' }],
    url:  ['/'],
  }, 'semantic_rescue');
  const atlas1 = JSON.parse(storedJson);
  expect('atlas has login_page entry', !!atlas1.login_page, true);
  expect('text signal stored with verifiedCount=0',
    atlas1.login_page.signals.text[0].verifiedCount, 0);
  expect('source is semantic_rescue',
    atlas1.login_page.signals.text[0].source, 'semantic_rescue');

  // Bump #1 — verifiedCount goes from 0 to 1, still unverified.
  await bumpVerifiedSignals(fakePrisma, 'proj-1', 'login_page', {
    text: ['Username'],
    role: [{ role: 'textbox', name: 'Username' }],
  });
  const atlas2 = JSON.parse(storedJson);
  expect('after bump #1: text verifiedCount=1',
    atlas2.login_page.signals.text[0].verifiedCount, 1);
  expect('after bump #1: source still semantic_rescue',
    atlas2.login_page.signals.text[0].source, 'semantic_rescue');

  // Bump #2 — verifiedCount hits 2, source promotes to 'verified'.
  await bumpVerifiedSignals(fakePrisma, 'proj-1', 'login_page', {
    text: ['Username'],
    role: [{ role: 'textbox', name: 'Username' }],
  });
  const atlas3 = JSON.parse(storedJson);
  expect('after bump #2: text verifiedCount=2',
    atlas3.login_page.signals.text[0].verifiedCount, 2);
  expect('after bump #2: text source=verified (promoted)',
    atlas3.login_page.signals.text[0].source, 'verified');
  expect('after bump #2: role source=verified',
    atlas3.login_page.signals.role[0].source, 'verified');

  // Bump #3 — promoted entries' verifiedCount does NOT continue to climb
  // (it stays at promotion-and-above; lastSeenAt updates).
  const beforeT = atlas3.login_page.signals.text[0].verifiedCount;
  await bumpVerifiedSignals(fakePrisma, 'proj-1', 'login_page', {
    text: ['Username'],
  });
  const atlas4 = JSON.parse(storedJson);
  expect('after bump #3: already-verified entry verifiedCount unchanged',
    atlas4.login_page.signals.text[0].verifiedCount, beforeT);
})().catch((e) => { console.error('threw:', e); failures += 1; });

// Give all async test blocks a chance to finish before reporting.
setTimeout(() => {
  console.log('');
  if (failures > 0) {
    console.log(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  } else {
    console.log('OK — all assertions passed');
  }
}, 500);
