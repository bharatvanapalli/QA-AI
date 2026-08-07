'use strict';

/**
 * Tests for the cross-case data chaining primitives shipped on Day 1:
 *   - sharedDataStore.parseSharedData / filterForCase / renderForPrompt
 *   - mcp.parseEvaluateReturnValue (browser_evaluate response shape parser)
 *   - mcp.extractData (synthetic tool dispatcher with mocked client + persistence)
 *
 * Run with:
 *   node server/services/__tests__/sharedDataExtract.test.js
 */

const sds = require('../sharedDataStore');
const mcp = require('../mcp');

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

// ─────────────────────────────────────────────────────────────────────────
console.log('sharedDataStore — key/value validation');
{
  expect('valid identifier',          sds.isPermittedKey('trackingId'), true);
  expect('valid identifier (underscore)', sds.isPermittedKey('_internal'), true);
  expect('reject leading digit',      sds.isPermittedKey('1tracking'), false);
  expect('reject hyphen',             sds.isPermittedKey('tracking-id'), false);
  expect('reject empty',              sds.isPermittedKey(''), false);
  expect('reject over-long (65 chars)', sds.isPermittedKey('a'.repeat(65)), false);
  expect('accept string value',       sds.isPermittedValue('1Z999'), true);
  expect('accept number value',       sds.isPermittedValue(42), true);
  expect('accept boolean value',      sds.isPermittedValue(false), true);
  expect('reject null value',         sds.isPermittedValue(null), false);
  expect('reject object value',       sds.isPermittedValue({ a: 1 }), false);
  expect('reject array value',        sds.isPermittedValue([1, 2]), false);
}

console.log('');
console.log('sharedDataStore — parseSharedData');
{
  expect('null raw',                  sds.parseSharedData(null), {});
  expect('empty raw',                 sds.parseSharedData(''), {});
  expect('malformed JSON',            sds.parseSharedData('{not json'), {});
  expect('array (not object)',        sds.parseSharedData('[1,2,3]'), {});
  expect('clean object',              sds.parseSharedData('{"trackingId":"1Z","count":3}'),
                                       { trackingId: '1Z', count: 3 });
  expect('filters out bad keys',      sds.parseSharedData('{"valid":"x","1bad":"y"}'),
                                       { valid: 'x' });
  expect('filters out object values', sds.parseSharedData('{"good":"x","bad":{"nested":1}}'),
                                       { good: 'x' });
}

console.log('');
console.log('sharedDataStore — filterForCase');
{
  const bag = { trackingId: '1Z999', orderId: 'WO-1', extra: 'unused' };
  const r1 = sds.filterForCase(bag, ['trackingId', 'orderId']);
  expect('two-key filter',            r1.filtered, { trackingId: '1Z999', orderId: 'WO-1' });
  expect('two-key filter: no missing', r1.missing, []);

  const r2 = sds.filterForCase(bag, ['trackingId', 'customsId']);
  expect('partial filter',            r2.filtered, { trackingId: '1Z999' });
  expect('partial filter: missing key', r2.missing, ['customsId']);

  const r3 = sds.filterForCase(bag, '["trackingId"]');  // JSON-encoded string
  expect('JSON-string requiresData',  r3.filtered, { trackingId: '1Z999' });

  const r4 = sds.filterForCase(bag, null);
  expect('null requiresData: empty filter', r4.filtered, {});

  const r5 = sds.filterForCase({}, ['trackingId']);
  expect('empty bag with requirements', r5.filtered, {});
  expect('empty bag: all keys missing', r5.missing, ['trackingId']);
}

console.log('');
console.log('sharedDataStore — renderForPrompt');
{
  const text1 = sds.renderForPrompt({ trackingId: '1Z999', orderId: 42 }, []);
  expect('renders both keys', text1.includes('`trackingId`: `1Z999`') && text1.includes('`orderId`: `42`'), true);

  const text2 = sds.renderForPrompt({ trackingId: '1Z999' }, ['customsId']);
  expect('renders missing warning', text2.includes('missing from upstream: customsId'), true);

  const text3 = sds.renderForPrompt({}, []);
  expect('empty + no missing: empty string', text3, '');

  const text4 = sds.renderForPrompt({}, ['trackingId']);
  expect('all-missing: surfaces "(none ... available yet)"',
    text4.includes('none of the requested keys are available yet'), true);
}

// ─────────────────────────────────────────────────────────────────────────
console.log('');
console.log('mcp.parseEvaluateReturnValue — browser_evaluate response parsing');
{
  expect('empty text',           mcp.parseEvaluateReturnValue(''), null);
  expect('null',                 mcp.parseEvaluateReturnValue(null), null);
  expect('no Result: marker',    mcp.parseEvaluateReturnValue('some other text'), null);
  expect('string result',        mcp.parseEvaluateReturnValue('Result: "1Z9999999999999999"'), '1Z9999999999999999');
  expect('number result',        mcp.parseEvaluateReturnValue('Result: 42'), 42);
  expect('boolean result',       mcp.parseEvaluateReturnValue('Result: true'), true);
  expect('multi-line with Result and Page state',
    mcp.parseEvaluateReturnValue('- Ran code: ...\nResult: "trackingId-xyz"\nPage state: ...'),
    'trackingId-xyz');
  expect('null literal result',  mcp.parseEvaluateReturnValue('Result: null'), null);
  expect('undefined string',     mcp.parseEvaluateReturnValue('Result: undefined'), null);
}

// ─────────────────────────────────────────────────────────────────────────
// Build a mock MCP session with a fake client that returns whatever the
// test wants. Lets us exercise extractData end-to-end without a real
// playwright-mcp subprocess.
function makeMockSession(opts = {}) {
  const persistCalls = [];
  return {
    id: 'sess-test',
    lastSnapshot: opts.snapshot || '',
    client: {
      callTool: async ({ name }) => {
        if (name !== 'browser_evaluate') {
          return { isError: true, content: [{ type: 'text', text: 'mock got unexpected tool' }] };
        }
        return opts.evaluateResponse || {
          isError: false,
          content: [{ type: 'text', text: `Result: ${JSON.stringify(opts.returnValue ?? '1Z9999')}` }],
        };
      },
    },
    sharedDataCurrentCase: opts.scratch || {},
    persistSharedData: opts.persistSharedData
      || (async (key, value) => { persistCalls.push({ key, value }); }),
    persistCalls,
  };
}

console.log('');
console.log('mcp.extractData — successful extraction (string value)');
(async () => {
  const session = makeMockSession({ returnValue: '1Z9999999999999999' });
  const out = await mcp.extractData(session, {
    target: 'e42',
    expr: 'el.textContent.trim()',
    targetKey: 'trackingId',
    element: 'Tracking number',
  });
  expect('isError=false',          out.isError, false);
  expect('text mentions binding',  /extracted trackingId =/.test(out.content[0].text), true);
  expect('current-case scratch updated', session.sharedDataCurrentCase.trackingId, '1Z9999999999999999');
  expect('persistSharedData called once', session.persistCalls.length, 1);
  expect('persistSharedData with right key', session.persistCalls[0].key, 'trackingId');
  expect('persistSharedData with right value', session.persistCalls[0].value, '1Z9999999999999999');
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — successful extraction (number value preserves type)');
(async () => {
  const session = makeMockSession({
    evaluateResponse: { isError: false, content: [{ type: 'text', text: 'Result: 42' }] },
  });
  const out = await mcp.extractData(session, {
    target: 'e42', expr: 'parseInt(el.textContent, 10)', targetKey: 'itemCount', element: 'badge',
  });
  expect('isError=false',                  out.isError, false);
  expect('number bound as number (not string)', session.sharedDataCurrentCase.itemCount, 42);
  expect('persisted as number',            session.persistCalls[0].value, 42);
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — rejects missing required args');
(async () => {
  const session = makeMockSession();
  const r1 = await mcp.extractData(session, { target: 'e1', expr: 'el.textContent', element: 'x' });
  expect('missing targetKey → isError', r1.isError, true);
  expect('missing targetKey: helpful message',
    /requires target.*expr.*targetKey/.test(r1.content[0].text), true);

  const r2 = await mcp.extractData(session, { target: 'e1', targetKey: 'x', element: 'x' });
  expect('missing expr → isError', r2.isError, true);
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — rejects bad targetKey (not a JS identifier)');
(async () => {
  const session = makeMockSession();
  const out = await mcp.extractData(session, {
    target: 'e1', expr: 'el.textContent', targetKey: 'tracking-id', element: 'x',
  });
  expect('hyphenated key rejected', out.isError, true);
  expect('hint about JS identifier',
    /JS identifier/.test(out.content[0].text), true);
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — rejects object return (flat-bag invariant)');
(async () => {
  const session = makeMockSession({
    evaluateResponse: { isError: false, content: [{ type: 'text', text: 'Result: {"a":1,"b":2}' }] },
  });
  const out = await mcp.extractData(session, {
    target: 'e1', expr: 'JSON.parse(el.textContent)', targetKey: 'data', element: 'x',
  });
  expect('object return rejected', out.isError, true);
  expect('hint about flat bag', /flat/i.test(out.content[0].text), true);
  expect('nothing written to scratch', session.sharedDataCurrentCase.data, undefined);
  expect('nothing persisted', session.persistCalls.length, 0);
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — rejects null/undefined return');
(async () => {
  const session = makeMockSession({
    evaluateResponse: { isError: false, content: [{ type: 'text', text: 'Result: null' }] },
  });
  const out = await mcp.extractData(session, {
    target: 'e1', expr: 'el.dataset.missing', targetKey: 'x', element: 'x',
  });
  expect('null return rejected', out.isError, true);
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — persistence error does NOT fail the tool');
(async () => {
  const session = makeMockSession({
    returnValue: '1Z999',
    persistSharedData: async () => { throw new Error('db unavailable'); },
  });
  const out = await mcp.extractData(session, {
    target: 'e1', expr: 'el.textContent', targetKey: 'trackingId', element: 'x',
  });
  expect('persist failure: tool still succeeds', out.isError, false);
  expect('scratch still updated (in-memory survives)', session.sharedDataCurrentCase.trackingId, '1Z999');
  expect('text warns about durable-write failure',
    /durable write to Run\.sharedData failed/.test(out.content[0].text), true);
})().catch((e) => { console.error('threw:', e); failures += 1; });

console.log('');
console.log('mcp.extractData — no client on session → clean error');
(async () => {
  const session = { id: 'no-client' };
  const out = await mcp.extractData(session, {
    target: 'e1', expr: 'el.textContent', targetKey: 'x', element: 'x',
  });
  expect('missing client → isError', out.isError, true);
  expect('text mentions MCP client', /MCP client/.test(out.content[0].text), true);
})().catch((e) => { console.error('threw:', e); failures += 1; });

setTimeout(() => {
  console.log('');
  if (failures > 0) {
    console.log(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  } else {
    console.log('OK — all assertions passed');
  }
}, 500);
