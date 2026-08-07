'use strict';

/**
 * Unit tests for the pre-dispatch role validator added to mcp.js.
 *
 * Goal: prove that browser_type({ target: <ref-of-a-button> }) is rejected
 * BEFORE it leaves the process, with a structured suggestion to use
 * browser_click instead.
 *
 * The mock client returns the LOGIN_SNAPSHOT every time, so the
 * snapshot-update path (lastSnapshot = txt; refRoleMap = buildRefRoleMap(txt))
 * keeps the map valid across calls. We assert on payload shape, not on
 * exact mock-call counts (callTool's internal stability-snapshot loop
 * issues its own browser_snapshot calls — counting those is brittle).
 *
 * Run with: node server/services/__tests__/mcpRoleValidator.test.js
 */

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

const LOGIN_SNAPSHOT = `
- generic [ref=e1]:
  - heading "Swag Labs" [level=1] [ref=e3]
  - textbox "Username" [ref=e11]
  - textbox "Password" [ref=e13]
  - textbox "Email Address" [disabled] [ref=e33]
  - textbox "Account alias" [readonly] [ref=e34]
  - combobox "Country" [disabled] [ref=e35]
  - combobox "Language" [ref=e36]
  - button "Continue" [disabled] [ref=e37]
  - button "Login" [ref=e15]
  - link "Forgot password?" [ref=e30]
  - static text "Accepted usernames are:" [ref=e40]
`.trim();

// Mock MCP client — returns LOGIN_SNAPSHOT for every call so the role map
// survives the callTool's "update lastSnapshot from result" branch. Records
// the names of the tools we get to see (the validator runs BEFORE this
// gets called, so a successful rejection means our mock is NEVER invoked
// with the rejected tool name).
function makeMockClient() {
  const namesSeen = [];
  return {
    namesSeen,
    callTool: async ({ name }) => {
      namesSeen.push(name);
      return { isError: false, content: [{ type: 'text', text: LOGIN_SNAPSHOT }] };
    },
  };
}

function makeSession() {
  return {
    id: `sess-${Math.random().toString(36).slice(2, 7)}`,
    client: makeMockClient(),
    lastSnapshot: LOGIN_SNAPSHOT,
    framePollerPaused: false,
    // Pre-populate the visitedUrls Set the conductor code expects.
    visitedUrls: new Set(),
  };
}

(async () => {
  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 1 — browser_type on a textbox: ACCEPTED (call reaches MCP)');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_type', {
      target: 'e11', element: 'Username', text: 'standard_user',
    });
    expect('valid call NOT rejected', res.isError, false);
    expect('client saw browser_type',
      sess.client.namesSeen.includes('browser_type'), true);
    expect('verified action locator attached',
      !!res.qaaiActionLocator, true);
    expect('evidence gate marked pre-dispatch',
      res.qaaiActionEvidence?.status, 'verified_pre_dispatch');
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 2 — browser_type on a submit button: REJECTED pre-dispatch');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_type', {
      target: 'e15', element: 'Login button', text: '',
    });
    expect('rejection is isError=true', res.isError, true);
    expect('client never saw browser_type',
      sess.client.namesSeen.includes('browser_type'), false);
    const text = res.content?.[0]?.text || '';
    expect('rejection text mentions browser_type cannot act',
      /browser_type cannot act on target=e15/.test(text), true);
    expect('rejection text cites role="button"',
      /role="button"/.test(text), true);
    expect('rejection text names "Login"',
      /"Login"/.test(text), true);
    expect('rejection text suggests browser_click',
      /Use browser_click instead/.test(text), true);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 3 — browser_click on a button: ACCEPTED (right tool)');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_click', {
      target: 'e15', element: 'Login button',
    });
    expect('click on button NOT rejected', res.isError, false);
    expect('client saw browser_click',
      sess.client.namesSeen.includes('browser_click'), true);
    expect('click result carries verified action locator',
      !!res.qaaiActionLocator, true);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 4 — browser_fill_form with one bad nested target: REJECTED');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_fill_form', {
      fields: [
        { name: 'Username', target: 'e11', value: 'standard_user' },
        { name: 'Password', target: 'e13', value: 'secret_sauce' },
        // The bug: pointing at the Login submit button.
        { name: 'Login',    target: 'e15', value: 'click' },
      ],
    });
    expect('fill_form rejected', res.isError, true);
    expect('client never saw browser_fill_form',
      sess.client.namesSeen.includes('browser_fill_form'), false);
    expect('rejection identifies the field by name',
      /field "Login"/.test(res.content?.[0]?.text || ''), true);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 5 — unknown ref (e999): REJECTED before dispatch');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_type', {
      target: 'e999', element: 'Hallucinated field', text: 'hi',
    });
    expect('unknown ref rejected before dispatch', res.isError, true);
    expect('client never saw browser_type',
      sess.client.namesSeen.includes('browser_type'), false);
    expect('rejection is a pre-dispatch guard',
      /Pre-dispatch validation|QAAI_LOCATOR_EVIDENCE_REQUIRED/.test(res.content?.[0]?.text || ''), true);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 6 — empty snapshot: refreshes, then still enforces role compatibility');
  {
    const sess = makeSession();
    sess.lastSnapshot = '';
    sess.refRoleMap = undefined;
    const res = await mcp.callTool(sess, 'browser_type', {
      target: 'e15', element: 'Whatever', text: 'x',
    });
    expect('empty snapshot no longer permits blind dispatch', res.isError, true);
    expect('client never saw browser_type after refresh validation',
      sess.client.namesSeen.includes('browser_type'), false);
    expect('refreshed role validation catches button target',
      /browser_type cannot act on target=e15/.test(res.content?.[0]?.text || ''), true);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 7 — browser_select_option on a button: REJECTED');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_select_option', {
      target: 'e15', element: 'Login button', values: ['x'],
    });
    expect('select_option on button rejected', res.isError, true);
    const text = res.content?.[0]?.text || '';
    expect('rejection cites browser_select_option',
      /browser_select_option cannot act on target=e15/.test(text), true);
  }

  // ──────────────────────────────────────────────────────────────────────
  console.log('PATH 8 — browser_type on a link: REJECTED (links are not text)');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_type', {
      target: 'e30', element: 'Forgot password link', text: 'foo',
    });
    expect('type on link rejected', res.isError, true);
    const text = res.content?.[0]?.text || '';
    expect('suggests browser_click for the link',
      /Use browser_click instead/.test(text), true);
  }

  console.log('PATH 9 — snapshot map preserves disabled/readonly state without marking enabled fields');
  {
    const map = mcp.buildRefRoleMap(LOGIN_SNAPSHOT);
    expect('disabled textbox state preserved', map.get('e33'), {
      role: 'textbox', name: 'Email Address', disabled: true, readonly: false,
    });
    expect('readonly textbox state preserved', map.get('e34'), {
      role: 'textbox', name: 'Account alias', disabled: false, readonly: true,
    });
    expect('normal enabled textbox remains actionable', map.get('e11'), {
      role: 'textbox', name: 'Username', disabled: false, readonly: false,
    });
  }

  console.log('PATH 10 — browser_type on the known disabled Odyssey email field: REJECTED immediately');
  {
    const sess = makeSession();
    const startedAt = Date.now();
    const res = await mcp.callTool(sess, 'browser_type', {
      target: 'e33', element: 'Email Address', text: 'configured@example.test',
    });
    expect('disabled type rejected', res.isError, true);
    expect('client never saw disabled browser_type',
      sess.client.namesSeen.includes('browser_type'), false);
    expect('fast rejection avoids Playwright action timeout', Date.now() - startedAt < 1000, true);
    expect('structured reason identifies non-actionable ref',
      res.qaaiPreDispatchRejection?.reason, 'non_actionable_ref');
    expect('structured state identifies disabled',
      res.qaaiPreDispatchRejection?.actionability, 'disabled');
    expect('error names exact disabled field',
      /Email Address/.test(res.content?.[0]?.text || ''), true);
  }

  console.log('PATH 11 — browser_fill_form with a known disabled field: REJECTED before dispatch');
  {
    const sess = makeSession();
    const res = await mcp.callTool(sess, 'browser_fill_form', {
      fields: [
        { name: 'Username', target: 'e11', value: 'standard_user' },
        { name: 'Email Address', target: 'e33', value: 'configured@example.test' },
      ],
    });
    expect('fill_form disabled field rejected', res.isError, true);
    expect('client never saw disabled browser_fill_form',
      sess.client.namesSeen.includes('browser_fill_form'), false);
    expect('rejection identifies disabled nested field',
      /field "Email Address" \(target=e33\).*disabled/.test(res.content?.[0]?.text || ''), true);
  }

  console.log('PATH 12 — readonly type and disabled select are rejected, enabled controls still dispatch');
  {
    const readonlySession = makeSession();
    const readonlyResult = await mcp.callTool(readonlySession, 'browser_type', {
      target: 'e34', element: 'Account alias', text: 'new-alias',
    });
    expect('readonly type rejected', readonlyResult.isError, true);
    expect('readonly state returned',
      readonlyResult.qaaiPreDispatchRejection?.actionability, 'readonly');
    expect('client never saw readonly browser_type',
      readonlySession.client.namesSeen.includes('browser_type'), false);

    const disabledSelectSession = makeSession();
    const disabledSelectResult = await mcp.callTool(disabledSelectSession, 'browser_select_option', {
      target: 'e35', element: 'Country', values: ['India'],
    });
    expect('disabled select rejected', disabledSelectResult.isError, true);
    expect('client never saw disabled select',
      disabledSelectSession.client.namesSeen.includes('browser_select_option'), false);

    const enabledTypeSession = makeSession();
    const enabledTypeResult = await mcp.callTool(enabledTypeSession, 'browser_type', {
      target: 'e11', element: 'Username', text: 'standard_user',
    });
    expect('enabled type still dispatches', enabledTypeResult.isError, false);
    expect('client saw enabled browser_type',
      enabledTypeSession.client.namesSeen.includes('browser_type'), true);

    const enabledSelectSession = makeSession();
    const enabledSelectResult = await mcp.callTool(enabledSelectSession, 'browser_select_option', {
      target: 'e36', element: 'Language', values: ['English'],
    });
    expect('enabled select still dispatches', enabledSelectResult.isError, false);
    expect('client saw enabled select',
      enabledSelectSession.client.namesSeen.includes('browser_select_option'), true);
  }

  console.log('PATH 13 — disabled click is rejected while readonly click and enabled click remain valid');
  {
    const disabledClickSession = makeSession();
    const disabledClickResult = await mcp.callTool(disabledClickSession, 'browser_click', {
      target: 'e37', element: 'Continue',
    });
    expect('disabled click rejected', disabledClickResult.isError, true);
    expect('disabled click returns state',
      disabledClickResult.qaaiPreDispatchRejection?.actionability, 'disabled');
    expect('client never saw disabled browser_click',
      disabledClickSession.client.namesSeen.includes('browser_click'), false);

    const readonlyClickSession = makeSession();
    const readonlyClickResult = await mcp.callTool(readonlyClickSession, 'browser_click', {
      target: 'e34', element: 'Account alias',
    });
    expect('readonly control remains clickable/focusable', readonlyClickResult.isError, false);
    expect('client saw readonly browser_click',
      readonlyClickSession.client.namesSeen.includes('browser_click'), true);

    const enabledClickSession = makeSession();
    const enabledClickResult = await mcp.callTool(enabledClickSession, 'browser_click', {
      target: 'e15', element: 'Login',
    });
    expect('enabled click still dispatches', enabledClickResult.isError, false);
    expect('client saw enabled browser_click',
      enabledClickSession.client.namesSeen.includes('browser_click'), true);
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
