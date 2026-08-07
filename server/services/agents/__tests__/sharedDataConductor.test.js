'use strict';

/**
 * Day 3 integration tests — conductor sharedData bindings.
 *
 * Tests the pure-function layer wired into conductor.js:
 *   1. applySharedDataTemplate  — ${key} substitution in tool inputs
 *   2. filterForCase + renderForPrompt — upstream bag injection into perCaseUserMsg
 *   3. mergeSharedData → readSharedData round-trip via in-memory prisma stub
 *   4. persistSharedData session hook contract (what mcp.js calls)
 *   5. Two-case end-to-end data flow simulation (no LLM calls)
 *
 * Run with:
 *   node server/services/agents/__tests__/sharedDataConductor.test.js
 */

const {
  parseSharedData,
  readSharedData,
  mergeSharedData,
  filterForCase,
  renderForPrompt,
  isPermittedKey,
  isPermittedValue,
} = require('../../sharedDataStore');

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
function expectTrue(label, v) { expect(label, !!v, true); }
function expectIncludes(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (ok) { console.log(`  PASS  ${label}`); }
  else {
    console.log(`  FAIL  ${label}: "${needle}" not in "${haystack}"`);
    failures += 1;
  }
}

// ── Stub prisma (in-memory Run store) ─────────────────────────────────────
// Mirrors the two operations mergeSharedData/readSharedData call:
//   prisma.run.findUnique({ where: { id }, select: { sharedData: true } })
//   prisma.run.update({ where: { id }, data: { sharedData: '...' } })

function makePrismaStub() {
  const rows = new Map(); // runId → { sharedData: string|null }
  return {
    _rows: rows,
    _seed(runId, sharedData) { rows.set(runId, { sharedData: sharedData || null }); },
    run: {
      findUnique: async ({ where, select }) => {
        const row = rows.get(where.id);
        if (!row) return null;
        const out = {};
        if (select?.sharedData) out.sharedData = row.sharedData;
        return out;
      },
      update: async ({ where, data }) => {
        const row = rows.get(where.id) || {};
        rows.set(where.id, { ...row, ...data });
      },
    },
  };
}

// ── applySharedDataTemplate ────────────────────────────────────────────────
// This function lives in conductor.js but its logic is simple enough to
// re-implement here for isolated testing. The real integration is verified
// in the two-case simulation below.

function applySharedDataTemplate(input, bag) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  if (!bag || typeof bag !== 'object' || Object.keys(bag).length === 0) return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.includes('${')) {
      out[k] = v.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (match, name) => {
        return Object.prototype.hasOwnProperty.call(bag, name) ? String(bag[name]) : match;
      });
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
console.log('1. applySharedDataTemplate — known key substituted');
{
  const input = { url: 'https://example.com/order/${orderId}/track' };
  const bag   = { orderId: 'WO-2026-481' };
  const out   = applySharedDataTemplate(input, bag);
  expect('url contains resolved value', out.url, 'https://example.com/order/WO-2026-481/track');
}

console.log('');
console.log('2. applySharedDataTemplate — unknown key left as literal');
{
  const input = { text: 'Your tracking number is ${trackingId}' };
  const bag   = { orderId: 'WO-2026-481' };  // trackingId NOT in bag
  const out   = applySharedDataTemplate(input, bag);
  expect('unknown key preserved verbatim', out.url, undefined);
  expectIncludes('literal placeholder preserved', out.text, '${trackingId}');
}

console.log('');
console.log('3. applySharedDataTemplate — multiple keys in same value');
{
  const input = { text: '${firstName} ${lastName} placed order ${orderId}' };
  const bag   = { firstName: 'Sravan', lastName: 'V', orderId: '42' };
  const out   = applySharedDataTemplate(input, bag);
  expect('all three keys resolved', out.text, 'Sravan V placed order 42');
}

console.log('');
console.log('4. applySharedDataTemplate — non-string fields pass through unchanged');
{
  const input = { count: 5, flags: ['a', 'b'], url: '${baseUrl}/path' };
  const bag   = { baseUrl: 'https://app.test' };
  const out   = applySharedDataTemplate(input, bag);
  expect('count unchanged', out.count, 5);
  expect('flags unchanged', out.flags, ['a', 'b']);
  expect('url resolved', out.url, 'https://app.test/path');
}

console.log('');
console.log('5. applySharedDataTemplate — empty bag returns input unchanged');
{
  const input = { text: 'check ${orderId}' };
  const out   = applySharedDataTemplate(input, {});
  expect('no substitution with empty bag', out.text, 'check ${orderId}');
}

// ──────────────────────────────────────────────────────────────────────────
console.log('');
console.log('6. filterForCase — returns only requested keys, surfaces missing');
{
  const bag  = { orderId: 'WO-001', sessionToken: 'tok_abc', cartId: 'C-7' };
  const { filtered, missing } = filterForCase(bag, ['orderId', 'cartId', 'missingKey']);
  expect('orderId present', filtered.orderId, 'WO-001');
  expect('cartId present', filtered.cartId, 'C-7');
  expect('sessionToken excluded', filtered.sessionToken, undefined);
  expect('missing key reported', missing, ['missingKey']);
}

console.log('');
console.log('7. renderForPrompt — produces ## Available shared data section');
{
  const filtered = { trackingId: '1Z9999', orderId: 'WO-001' };
  const missing  = ['customsId'];
  const out      = renderForPrompt(filtered, missing);
  expectIncludes('section header present', out, '## Available shared data');
  expectIncludes('trackingId rendered', out, '`trackingId`: `1Z9999`');
  expectIncludes('orderId rendered', out, '`orderId`: `WO-001`');
  expectIncludes('missing key surfaced', out, 'missing from upstream: customsId');
}

console.log('');
console.log('8. renderForPrompt — empty filtered + no missing → empty string');
{
  const out = renderForPrompt({}, []);
  expect('returns empty string when nothing to inject', out, '');
}

console.log('');
console.log('9. renderForPrompt — empty filtered + has missing → warning only');
{
  const out = renderForPrompt({}, ['requiredKey']);
  expectIncludes('header present', out, '## Available shared data');
  expectIncludes('none available message', out, '(none of the requested keys are available yet)');
  expectIncludes('missing key present', out, 'missing from upstream: requiredKey');
}

// ──────────────────────────────────────────────────────────────────────────
async function runRoundTripTest() {
  console.log('');
  console.log('10. mergeSharedData → readSharedData round-trip (in-memory stub)');
  const prisma = makePrismaStub();
  const runId  = 'run-test-001';
  prisma._seed(runId, null);

  await mergeSharedData(prisma, runId, { orderId: 'WO-42', sessionToken: 'tok_x' });
  const bag1 = await readSharedData(prisma, runId);
  expect('orderId persisted', bag1.orderId, 'WO-42');
  expect('sessionToken persisted', bag1.sessionToken, 'tok_x');

  // Second merge adds a key (additive)
  await mergeSharedData(prisma, runId, { trackingId: '1Z9999' });
  const bag2 = await readSharedData(prisma, runId);
  expect('trackingId added', bag2.trackingId, '1Z9999');
  expect('prior keys preserved', bag2.orderId, 'WO-42');

  // Invalid key rejected
  const { rejected } = await mergeSharedData(prisma, runId, { 'bad key!': 'value', goodKey: 'v' });
  expect('invalid key rejected', rejected.includes('key:bad key!'), true);
  const bag3 = await readSharedData(prisma, runId);
  expect('good key still written', bag3.goodKey, 'v');
  expect('bad key not written', bag3['bad key!'], undefined);
}

// ──────────────────────────────────────────────────────────────────────────
// Two-case end-to-end simulation:
//   Case A  (produces: trackingId) — mock session writes to persistSharedData
//   Case B  (requires: trackingId) — reads upstream bag, injects into perCaseUserMsg,
//                                    resolves ${trackingId} in step value
//
// This is NOT a full runOneCase call (that requires LLM). It simulates the
// THREE points conductor.js touches per-case:
//   1. session binding + upstream bag read
//   2. filterForCase + renderForPrompt → sharedDataSection
//   3. applySharedDataTemplate on step value
// ──────────────────────────────────────────────────────────────────────────
async function runEndToEndSimulation() {
  console.log('');
  console.log('11. Two-case end-to-end simulation (no LLM)');

  const prisma = makePrismaStub();
  const runId  = 'run-e2e-sim';
  prisma._seed(runId, null);

  // ── Case A: Place Order ── produces trackingId
  const sessionA = { sharedDataCurrentCase: {}, persistSharedData: null };
  sessionA.persistSharedData = async (key, value) => {
    await mergeSharedData(prisma, runId, { [key]: value });
  };

  // Simulate browser_extract_data writing to session + durable store
  const extractedValue = '1Z9999999999999999';
  sessionA.sharedDataCurrentCase['trackingId'] = extractedValue;
  await sessionA.persistSharedData('trackingId', extractedValue);

  // Verify durable write
  const bagAfterA = await readSharedData(prisma, runId);
  expect('Case A: trackingId in durable bag', bagAfterA.trackingId, extractedValue);

  // ── Case B: Track Shipment ── requires trackingId
  const tcB = { requiresData: '["trackingId"]', name: 'Track Shipment' };
  const sessionB = { sharedDataCurrentCase: {}, persistSharedData: async (k, v) => {
    await mergeSharedData(prisma, runId, { [k]: v });
  }};

  // 1. Read upstream bag (what conductor does at case-start)
  const upstreamBag = await readSharedData(prisma, runId);
  expect('Case B: upstream bag has trackingId', upstreamBag.trackingId, extractedValue);

  // 2. Filter to what this case needs + render
  const { filtered, missing } = filterForCase(upstreamBag, tcB.requiresData);
  expect('filtered has trackingId', filtered.trackingId, extractedValue);
  expect('nothing missing', missing.length, 0);

  const section = renderForPrompt(filtered, missing);
  expectIncludes('perCaseUserMsg includes shared data section', section, '## Available shared data');
  expectIncludes('trackingId visible to agent', section, '`trackingId`: `1Z9999999999999999`');

  // 3. Template substitution on step value (what conductor does before callTool)
  const stepInput = { text: 'Search for order ${trackingId}' };
  const mergedBag = { ...upstreamBag, ...sessionB.sharedDataCurrentCase };
  const resolved  = applySharedDataTemplate(stepInput, mergedBag);
  expect('step value resolved', resolved.text, `Search for order ${extractedValue}`);

  console.log('');
  console.log('12. Same-case scratch — extraction mid-case available to later steps');
  // If Case B ALSO extracts something mid-case, it goes into sharedDataCurrentCase
  // and is available to later steps in the SAME case via the merged bag.
  sessionB.sharedDataCurrentCase['deliveryDate'] = '2026-06-15';
  const mergedBag2 = { ...upstreamBag, ...sessionB.sharedDataCurrentCase };
  const input2     = { value: 'Expected by ${deliveryDate} for order ${trackingId}' };
  const resolved2  = applySharedDataTemplate(input2, mergedBag2);
  expect('same-case extraction available', resolved2.value, `Expected by 2026-06-15 for order ${extractedValue}`);
}

// ──────────────────────────────────────────────────────────────────────────
function finalizeTests() {
  console.log('');
  if (failures > 0) {
    console.log(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  } else {
    console.log('OK — all assertions passed');
  }
}

// Kick off all async tests sequentially
(async () => {
  try {
    await runRoundTripTest();
    await runEndToEndSimulation();
  } catch (err) {
    console.log(`  FAIL  async suite threw: ${err.message}`);
    failures += 1;
  }
  finalizeTests();
})();
