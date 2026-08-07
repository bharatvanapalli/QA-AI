'use strict';

/**
 * Phase H M4 — postLoopRatify smoke.
 *
 * Stubs the mcp module so we exercise the orchestration logic (URL
 * disambiguation, primitive-unsupported routing, dry-run path) without
 * a real MCP session.
 *
 * Run with: node server/services/__tests__/postLoopRatify.test.js
 */

const { postLoopRatify, declaredToCheckArgs, legacyToOutcome } = require('../postLoopRatify');

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

// ── stub mcp module ────────────────────────────────────────────────────
const DEFAULT_SNAPSHOT = [
  '### Page',
  '- heading "Test page" [ref=e1]',
  '- main "Content" [ref=e2]',
].join('\n');

function makeMcp(responses = {}) {
  return {
    snapshot: async (session, options = {}) => {
      if (typeof responses.onSnapshot === 'function') responses.onSnapshot(options);
      if (typeof responses.snapshotApi === 'function') {
        return responses.snapshotApi(session, options);
      }
      const configured = responses.snapshot;
      if (configured?.isError) {
        return {
          text: '',
          error: configured.content?.[0]?.text || 'snapshot error',
        };
      }
      const text = configured?.content?.[0]?.text || DEFAULT_SNAPSHOT;
      if (session) session.lastSnapshot = text;
      return { text, error: null };
    },
    callTool: async (session, name, args, options = {}) => {
      if (typeof responses.onTool === 'function') responses.onTool(name, args, options);
      if (name === 'browser_snapshot') {
        return responses.snapshot || { isError: false, content: [{ type: 'text', text: DEFAULT_SNAPSHOT }] };
      }
      if (name === 'browser_evaluate') {
        return { isError: false, content: [{ type: 'text', text: 'Test page Content' }] };
      }
      if (name === 'assertion_check') {
        // responses.assertion is a function (args) → payload
        const fn = responses.assertion;
        const payload = typeof fn === 'function' ? fn(args) : { matched: true };
        return { isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }
      return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
    },
  };
}

(async () => {
  // ─────────────────────────────────────────────────────────────────────
  console.log('declaredToCheckArgs — type mapping');
  expect('TEXT translates to expectedText',
    declaredToCheckArgs({ id: 'A', type: 'TEXT', payload: { expectedText: 'Welcome' } }).args.expectedText,
    'Welcome');
  expect('URL translates to expectedUrlPattern',
    declaredToCheckArgs({ id: 'A', type: 'URL', payload: { expectedUrlPattern: '/x' } }).args.expectedUrlPattern,
    '/x');
  expect('ROLE translates to expectedRole',
    declaredToCheckArgs({ id: 'A', type: 'ROLE', payload: { expectedRole: 'heading' } }).args.expectedRole,
    'heading');
  expect('DOWNLOAD translates to expectedDownload',
    declaredToCheckArgs({ id: 'A', type: 'DOWNLOAD', payload: { minSize: 1000 } }).args.expectedDownload.minSize,
    1000);
  // Phase H+1: FORBIDDEN_TEXT is now supported via the unexpectedText
  // primitive. Translation produces args.unexpectedText so checkAssertion
  // does the inverted-match against the snapshot.
  expect('FORBIDDEN_TEXT supported via unexpectedText',
    declaredToCheckArgs({ id: 'A', type: 'FORBIDDEN_TEXT', payload: { unexpectedText: 'oops' } }).supported,
    true);
  expect('FORBIDDEN_TEXT translates to unexpectedText',
    declaredToCheckArgs({ id: 'A', type: 'FORBIDDEN_TEXT', payload: { unexpectedText: 'oops' } }).args.unexpectedText,
    'oops');
  expect('FORBIDDEN_TEXT without unexpectedText payload → unsupported',
    declaredToCheckArgs({ id: 'A', type: 'FORBIDDEN_TEXT', payload: {} }).supported,
    false);
  expect('EVALUATE → primitive_unsupported',
    declaredToCheckArgs({ id: 'A', type: 'EVALUATE', payload: { script: '() => 1' } }).supported,
    false);

  console.log('legacyToOutcome — payload mapping');
  expect('matched=true → matched',
    legacyToOutcome({ matched: true }).outcome, 'matched');
  expect('no_snapshot → uncheckable:no_snapshot',
    legacyToOutcome({ matched: false, reason: 'no_snapshot' }),
    { outcome: 'uncheckable', reason: 'no_snapshot' });
  expect('missing_criteria → uncheckable:primitive_unsupported',
    legacyToOutcome({ matched: false, reason: 'missing_criteria' }),
    { outcome: 'uncheckable', reason: 'primitive_unsupported' });
  expect('criteria_failed → not_matched',
    legacyToOutcome({ matched: false, reason: 'criteria_failed' }).outcome,
    'not_matched');

  // ─────────────────────────────────────────────────────────────────────
  console.log('postLoopRatify — nothing to ratify when all declared have recorded');
  {
    const declared = [{ id: 'ASN-1', type: 'TEXT', payload: { expectedText: 'x' } }];
    const recorded = [{ assertionId: 'ASN-1', outcome: 'matched', source: 'agent' }];
    const { recorded: out, snapshotTaken } = await postLoopRatify({
      mcp: makeMcp(), mcpSession: {}, declared, recorded,
    });
    expect('returned recorded unchanged', out.length, 1);
    expect('snapshot not taken when nothing to do', snapshotTaken, false);
  }

  console.log('postLoopRatify — ordinary batch uses one bounded validation snapshot with no stabilization polling');
  {
    const declared = [{ id: 'ASN-fast', type: 'TEXT', payload: { expectedText: 'Welcome' } }];
    const snapshotOptions = [];
    const toolCalls = [];
    const toolOptions = [];
    const mcp = makeMcp({
      onSnapshot: (options) => snapshotOptions.push(options),
      onTool: (name, _args, options) => {
        toolCalls.push(name);
        toolOptions.push({ name, options });
      },
      assertion: () => ({ matched: true, evidence: 'Welcome found' }),
    });
    const session = { lastSnapshot: '- heading "Old page" [ref=old1]' };
    const nativeSetTimeout = global.setTimeout;
    let timersScheduled = 0;
    global.setTimeout = (...args) => {
      timersScheduled += 1;
      return nativeSetTimeout(...args);
    };
    let result;
    try {
      result = await postLoopRatify({ mcp, mcpSession: session, declared, recorded: [] });
    } finally {
      global.setTimeout = nativeSetTimeout;
    }

    expect('ordinary path took one shared snapshot', snapshotOptions.length, 1);
    expect('ordinary snapshot skips stability', snapshotOptions[0].skipSnapshotStability, true);
    expect('ordinary snapshot timeout is bounded',
      snapshotOptions[0].timeoutMs >= 250 && snapshotOptions[0].timeoutMs <= 5000,
      true);
    expect('ordinary path did not dispatch raw browser_snapshot', toolCalls.includes('browser_snapshot'), false);
    expect('ordinary path scheduled no polling/stability timer', timersScheduled, 0);
    const domFallback = toolOptions.find((entry) => entry.name === 'browser_evaluate');
    expect('DOM fallback uses a bounded timeout',
      domFallback.options.timeoutMs >= 250 && domFallback.options.timeoutMs <= 5000,
      true);
    expect('DOM fallback disables action evidence', domFallback.options.strictActionEvidence, false);
    expect('DOM fallback disables telemetry', domFallback.options.telemetry, false);
    expect('DOM fallback has a validation source', domFallback.options.source, 'post_loop_ratify_dom_text_fallback');
    expect('ordinary batch snapshot recorded as taken', result.snapshotTaken, true);
    expect('ordinary batch assertion used shared snapshot', result.recorded[0].outcome, 'matched');
  }

  console.log('postLoopRatify — failed ordinary snapshot preserves cache and marks assertion uncheckable');
  {
    const declared = [{ id: 'ASN-fast-fail', type: 'TEXT', payload: { expectedText: 'Welcome' } }];
    const toolCalls = [];
    const staleSnapshot = '- heading "Prior page" [ref=old1]';
    const session = { lastSnapshot: staleSnapshot };
    const mcp = makeMcp({
      snapshotApi: async () => ({ text: '', error: 'snapshot timeout' }),
      onTool: (name) => toolCalls.push(name),
      assertion: () => ({ matched: true }),
    });

    const result = await postLoopRatify({ mcp, mcpSession: session, declared, recorded: [] });

    expect('failed shared snapshot not reported as taken', result.snapshotTaken, false);
    expect('failed shared snapshot produces uncheckable', result.recorded[0].outcome, 'uncheckable');
    expect('failed shared snapshot preserves transient reason', result.recorded[0].reason, 'transient_snapshot_timeout');
    expect('failed shared snapshot never checks stale page', toolCalls.includes('assertion_check'), false);
    expect('failed shared snapshot preserves last good cache', session.lastSnapshot, staleSnapshot);
  }

  console.log('postLoopRatify — unchecked TEXT with matching snapshot returns matched');
  {
    const declared = [{ id: 'ASN-2', type: 'TEXT', payload: { expectedText: 'Welcome' } }];
    const recorded = [];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: true, evidence: 'found Welcome' }) }),
      mcpSession: {}, declared, recorded,
    });
    expect('one new record',     out.length, 1);
    expect('id stamped',         out[0].assertionId, 'ASN-2');
    expect('outcome matched',    out[0].outcome, 'matched');
    expect('source post_loop',   out[0].source, 'post_loop');
  }

  console.log('postLoopRatify — unchecked TEXT with miss returns not_matched');
  {
    const declared = [{ id: 'ASN-3', type: 'TEXT', payload: { expectedText: 'Welcome' } }];
    const recorded = [];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: false, reason: 'criteria_failed', evidence: 'no match' }) }),
      mcpSession: {}, declared, recorded,
    });
    expect('outcome not_matched', out[0].outcome, 'not_matched');
  }

  console.log('postLoopRatify — URL three-way disambiguation: on-target → snapshot check');
  {
    const declared = [{ id: 'ASN-4', type: 'TEXT', payload: { expectedText: 'OK' }, targetUrl: '/dashboard' }];
    const recorded = [];
    const visitedUrls = new Set(['/dashboard', '/login']);
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: true }) }),
      mcpSession: {}, declared, recorded,
      currentUrl: 'https://example.com/dashboard',
      visitedUrls,
    });
    expect('outcome matched (on target)', out[0].outcome, 'matched');
  }

  console.log('postLoopRatify — URL three-way disambiguation: visited but not current → transient_window_missed');
  {
    const declared = [{ id: 'ASN-5', type: 'TEXT', payload: { expectedText: 'OK' }, targetUrl: '/dashboard' }];
    const recorded = [];
    const visitedUrls = new Set(['/dashboard', '/profile']);
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp(), mcpSession: {}, declared, recorded,
      currentUrl: 'https://example.com/profile',
      visitedUrls,
    });
    expect('outcome uncheckable',          out[0].outcome, 'uncheckable');
    expect('reason transient_window_missed', out[0].reason, 'transient_window_missed');
  }

  console.log('postLoopRatify — URL three-way disambiguation: never visited → not_matched:agent_never_reached');
  {
    const declared = [{ id: 'ASN-6', type: 'TEXT', payload: { expectedText: 'OK' }, targetUrl: '/admin' }];
    const recorded = [];
    const visitedUrls = new Set(['/login', '/dashboard']);
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp(), mcpSession: {}, declared, recorded,
      currentUrl: 'https://example.com/dashboard',
      visitedUrls,
    });
    // agent_never_reached is a navigation failure — not a verification
    // uncertainty. Maps to not_matched (FAIL), not uncheckable. See
    // postLoopRatify.js URL three-way disambiguation block.
    expect('outcome not_matched',         out[0].outcome, 'not_matched');
    expect('reason agent_never_reached',  out[0].reason, 'agent_never_reached');
  }

  console.log('postLoopRatify — parseFailed entry → uncheckable:declared_assertion_unparseable');
  {
    const declared = [{ id: 'ASN-7', type: 'TEXT', payload: {}, parseFailed: true }];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp(), mcpSession: {}, declared, recorded: [],
    });
    expect('outcome uncheckable',                     out[0].outcome, 'uncheckable');
    expect('reason declared_assertion_unparseable',   out[0].reason, 'declared_assertion_unparseable');
  }

  console.log('postLoopRatify — primitive_unsupported routes to uncheckable');
  {
    const declared = [{ id: 'ASN-8', type: 'EVALUATE', payload: { script: '() => 1' } }];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp(), mcpSession: {}, declared, recorded: [],
    });
    expect('outcome uncheckable',           out[0].outcome, 'uncheckable');
    expect('reason primitive_unsupported',  out[0].reason, 'primitive_unsupported');
  }

  console.log('postLoopRatify — dry-run (no mcpSession) → every unchecked becomes no_snapshot');
  {
    const declared = [{ id: 'ASN-9', type: 'TEXT', payload: { expectedText: 'x' } }];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp(), mcpSession: null, declared, recorded: [],
    });
    expect('outcome uncheckable',  out[0].outcome, 'uncheckable');
    expect('reason no_snapshot',   out[0].reason, 'no_snapshot');
  }

  console.log('postLoopRatify — preserves agent-recorded outcomes already in list');
  {
    const declared = [
      { id: 'ASN-10', type: 'TEXT', payload: { expectedText: 'a' } },
      { id: 'ASN-11', type: 'TEXT', payload: { expectedText: 'b' } },
    ];
    const recorded = [{ assertionId: 'ASN-10', outcome: 'matched', source: 'agent' }];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: true }) }),
      mcpSession: {}, declared, recorded,
    });
    expect('two records (one agent, one post_loop)', out.length, 2);
    expect('agent record preserved',                  out[0].source, 'agent');
    expect('post-loop record added',                  out[1].source, 'post_loop');
  }

  // ─────────────────────────────────────────────────────────────────────
  // PATH 4 — agent-initiated not_matched is non-durable and must be
  // re-evaluated against the post-loop stable snapshot. The classic
  // scenario: agent called assertion_check mid-transition, page hadn't
  // settled, got not_matched. Page later finished loading. PostLoop
  // re-checks and finds matched — verdict flips from FAIL to PASS.
  console.log('postLoopRatify — PATH 4: agent not_matched re-evaluated and may flip to matched');
  {
    const declared = [{ id: 'ASN-12', type: 'TEXT', payload: { expectedText: 'Welcome' } }];
    const recorded = [
      { assertionId: 'ASN-12', outcome: 'not_matched', reason: 'criteria_failed', source: 'agent' },
    ];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: true, evidence: 'now found' }) }),
      mcpSession: {}, declared, recorded,
    });
    expect('still one record (in-place replace)', out.length, 1);
    expect('outcome flipped to matched',          out[0].outcome, 'matched');
    expect('source now post_loop',                out[0].source, 'post_loop');
  }

  // PATH 4 — agent not_matched that STAYS not_matched after re-eval
  // remains a FAIL (overwritten with post_loop confirmation).
  console.log('postLoopRatify — PATH 4: agent not_matched re-evaluated and confirmed still not_matched');
  {
    const declared = [{ id: 'ASN-13', type: 'TEXT', payload: { expectedText: 'Welcome' } }];
    const recorded = [
      { assertionId: 'ASN-13', outcome: 'not_matched', reason: 'criteria_failed', source: 'agent' },
    ];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: false, reason: 'criteria_failed', evidence: 'still missing' }) }),
      mcpSession: {}, declared, recorded,
    });
    expect('still one record (in-place replace)', out.length, 1);
    expect('outcome still not_matched',           out[0].outcome, 'not_matched');
    expect('source updated to post_loop',         out[0].source, 'post_loop');
  }

  // PATH 4 — conductor_inline not_matched stays durable. The Conductor's
  // URL-change detection is a strong signal, not a race window.
  console.log('postLoopRatify — PATH 4: conductor_inline not_matched is DURABLE');
  {
    const declared = [{ id: 'ASN-14', type: 'URL', payload: { expectedUrlPattern: '/x' } }];
    const recorded = [
      { assertionId: 'ASN-14', outcome: 'not_matched', reason: 'criteria_failed', source: 'conductor_inline' },
    ];
    const { recorded: out } = await postLoopRatify({
      mcp: makeMcp({ assertion: () => ({ matched: true }) }),
      mcpSession: {}, declared, recorded,
    });
    expect('record left alone',                   out.length, 1);
    expect('outcome stays not_matched',           out[0].outcome, 'not_matched');
    expect('source stays conductor_inline',       out[0].source, 'conductor_inline');
  }

  // PATH 7 — postLoopRatify must raise the _assertionBatchActive flag on
  // the session before its inner assertion_check calls and lower it after.
  // Without this a per-check cache miss could request another snapshot and
  // defeat postLoop's intentional shared-snapshot design.
  console.log('postLoopRatify — PATH 7: raises _assertionBatchActive during batch, lowers after');
  {
    const declared = [{ id: 'ASN-15', type: 'TEXT', payload: { expectedText: 'x' } }];
    const session = { id: 'sess-1' };
    let seenDuringCheck = null;
    const mcpInstrumented = {
      snapshot: async (sess) => {
        sess.lastSnapshot = DEFAULT_SNAPSHOT;
        return { text: DEFAULT_SNAPSHOT, error: null };
      },
      callTool: async (sess, name) => {
        if (name === 'browser_snapshot') {
          return { isError: false, content: [{ type: 'text', text: 'snapshot' }] };
        }
        if (name === 'assertion_check') {
          // Capture the flag value AT THE MOMENT assertion_check would be
          // dispatched, which is precisely when _checkAssertionOnce would
          // gate on it.
          seenDuringCheck = sess._assertionBatchActive === true;
          return { isError: false, content: [{ type: 'text', text: JSON.stringify({ matched: true }) }] };
        }
        return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
      },
    };
    await postLoopRatify({ mcp: mcpInstrumented, mcpSession: session, declared, recorded: [] });
    expect('batch flag was set during assertion_check', seenDuringCheck, true);
    expect('batch flag cleared after return',           session._assertionBatchActive, false);
  }

  // PATH 7 — even if an inner assertion_check throws, the batch flag must
  // still be cleared (finally block).
  console.log('postLoopRatify — PATH 7: lowers batch flag even on inner failure');
  {
    const declared = [{ id: 'ASN-16', type: 'TEXT', payload: { expectedText: 'x' } }];
    const session = { id: 'sess-2' };
    const mcpThrows = {
      snapshot: async (sess) => {
        sess.lastSnapshot = DEFAULT_SNAPSHOT;
        return { text: DEFAULT_SNAPSHOT, error: null };
      },
      callTool: async (_s, name) => {
        if (name === 'browser_snapshot') return { isError: false, content: [{ type: 'text', text: 'snap' }] };
        if (name === 'assertion_check') throw new Error('boom');
        return { isError: true, content: [{ type: 'text', text: '?' }] };
      },
    };
    await postLoopRatify({ mcp: mcpThrows, mcpSession: session, declared, recorded: [] });
    expect('batch flag still cleared after throw', session._assertionBatchActive, false);
  }

  console.log('');
  if (failures > 0) {
    console.log(`FAILED — ${failures} assertion(s)`);
    process.exit(1);
  } else {
    console.log('OK — all assertions passed');
  }
})().catch((err) => {
  console.error('uncaught:', err);
  process.exit(1);
});
