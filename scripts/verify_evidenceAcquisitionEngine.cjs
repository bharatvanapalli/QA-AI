'use strict';
/*
 * Guard for Phase B-2b — Evidence Acquisition Engine (the live loop's LOGIC,
 * exercised offline via fake observers). Proves the engine ESCALATES to resolve
 * `needs_acquisition` into certified evidence, declares automation_capture_failure
 * (not a bug/pass) when it genuinely can't, and only ever hands the verdict
 * CERTIFIED input.
 *
 * ⚠ FAKE OBSERVERS — not a live-browser proof. The real MCP observer
 * (createMcpObserver) + the DOM_PROBE_FN are validated live at B-2e.
 */
const { acquireEvidence, createMcpObserver, mergeDomFacts, DOM_PROBE_FN } = require('../server/services/evidenceAcquisitionEngine');
const { buildRowEvidenceContract } = require('../server/services/testDataMatrix');
const { judgeRowEvidence } = require('../server/services/evidenceCheckers');
const { mapVerdictToRunStatus } = require('../server/services/verdictEngine');
const mcp = require('../server/services/mcp'); // real textOfContent + parseEvaluateReturnValue for the parser regression

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const URL_LOGIN = 'https://opensource-demo.orangehrmlive.com/web/index.php/auth/login';
const PATTERNS = { entryUrlPattern: 'auth/login', authedUrlPattern: 'dashboard' };
const mkRow = (inputs, extra = {}) => ({ index: 0, setName: 'AuthProfiles', sheet: 'AuthProfiles', inputs, raw: { ...inputs }, expected: null, rowClass: null, rowClassColumn: null, expectedColumn: null, label: 'row', ...extra });
const reqValidation = () => buildRowEvidenceContract(mkRow({ username: '', password: 'admin123' }));
const authContract = () => buildRowEvidenceContract(mkRow({ username: 'wrong', password: 'wrong' }, { rowClass: 'invalidCredentials', rowClassColumn: 'scenarioType' }));

const SNAP_CLEAN = ['- form "LoginForm":', '  - textbox "Username" [ref=e3]', '  - textbox "Password" [ref=e5]', '  - button "Login" [ref=e7]'].join('\n');
const SNAP_FIELD_REQUIRED = ['- form "LoginForm":', '  - textbox "Username" [ref=e3]', '  - text: Required', '  - textbox "Password" [ref=e5]', '  - button "Login" [ref=e7]'].join('\n');

// fake observer: stable snapshot each round; domProbe returns a fixed domFacts.
function observer({ snapshotText, domFacts = null, settleable = false, settled }) {
  let probes = 0;
  const o = {
    async snapshot() { return { snapshotText, url: URL_LOGIN, settled }; },
  };
  if (domFacts !== null) o.domProbe = async () => { probes++; return domFacts; };
  if (settleable) o.settle = async () => {};
  o._probes = () => probes;
  return o;
}

(async () => {
  console.log('— DOM_PROBE_FN is syntactically valid JS —');
  { let f = null; try { f = eval('(' + DOM_PROBE_FN + ')'); } catch (e) { /* */ } ok('probe parses to a function', typeof f === 'function'); }

  console.log('\n— (1) escalation RESOLVES needs_acquisition: a11y has no field error, DOM probe finds it -> certified -> works —');
  {
    const obs = observer({ snapshotText: SNAP_CLEAN, domFacts: { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [{ fieldRole: 'username', text: 'Required' }], pageErrors: [] } });
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: obs, patterns: PATTERNS });
    ok('ok:true (certified)', r.ok === true, JSON.stringify(r.pending));
    ok('took 2 rounds (snapshot -> probe -> re-certify)', r.rounds === 2, String(r.rounds));
    ok('checkerPageState produced', !!r.checkerPageState);
    const v = judgeRowEvidence(reqValidation(), r.checkerPageState);
    ok('judge -> works (validation appeared)', v.verdict === 'works', `${v.verdict}/${v.reason}`);
  }

  console.log('\n— (2) escalation certifies ABSENCE (page SETTLED): DOM probe finds nothing -> required validation missing = bug —');
  {
    const obs = observer({ snapshotText: SNAP_CLEAN, settled: true, domFacts: { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [], pageErrors: [] } });
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: obs, patterns: PATTERNS });
    ok('ok:true (absence certified)', r.ok === true);
    const v = judgeRowEvidence(reqValidation(), r.checkerPageState);
    ok('judge -> bug (empty field produced NO validation)', v.verdict === 'bug', `${v.verdict}/${v.reason}`);
    ok('maps to fail', mapVerdictToRunStatus(v).status === 'fail');
  }

  console.log('\n— (3) evidence already in the snapshot -> certified in ONE round, no probe needed —');
  {
    const obs = observer({ snapshotText: SNAP_FIELD_REQUIRED, domFacts: { inspectedSources: [], fieldErrors: [], pageErrors: [] } });
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: obs, patterns: PATTERNS });
    ok('ok:true in 1 round', r.ok === true && r.rounds === 1, String(r.rounds));
    ok('DOM probe NOT called', obs._probes() === 0, String(obs._probes()));
    ok('judge -> works', judgeRowEvidence(reqValidation(), r.checkerPageState).verdict === 'works');
  }

  console.log('\n— (4) error_present resolved by DOM page-alert probe -> works —');
  {
    const obs = observer({ snapshotText: SNAP_CLEAN, domFacts: { inspectedSources: ['dom_error_containers'], fieldErrors: [], pageErrors: [{ text: 'Invalid credentials' }] } });
    const r = await acquireEvidence({ requiredEvidence: authContract().requiredEvidence, observer: obs, patterns: PATTERNS });
    ok('ok:true (error_present certified via pageErrors)', r.ok === true, JSON.stringify(r.pending));
    ok('judge -> works (auth rejection error captured)', judgeRowEvidence(authContract(), r.checkerPageState).verdict === 'works');
  }

  console.log('\n— (5) NO fake finalization: cannot acquire -> automation_capture_failure (NOT bug/pass), no checker input —');
  {
    // observer with NO domProbe and NO settle: field-error absence can never certify.
    const obs = observer({ snapshotText: SNAP_CLEAN, domFacts: null });
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: obs, patterns: PATTERNS, maxRounds: 3 });
    ok('ok:false', r.ok === false);
    ok('status automation_capture_failure', r.status === 'automation_capture_failure', r.status);
    ok('checkerPageState is null (no verdict input ever produced)', r.checkerPageState === null);
    ok('pending names the unresolved kind', r.pending.some((p) => p.kind === 'field_error'), JSON.stringify(r.pending));
  }

  console.log('\n— (6) bounded escalation: probe that never yields evidence -> capped at maxRounds, capture_failure —');
  {
    const obs = observer({ snapshotText: SNAP_CLEAN, domFacts: { inspectedSources: ['nearby_text'], fieldErrors: [], pageErrors: [] } }); // no authoritative absence source -> never certifies fieldErrors
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: obs, patterns: PATTERNS, maxRounds: 3 });
    ok('ok:false (never certified)', r.ok === false, r.status);
    ok('stopped at maxRounds', r.rounds === 3, String(r.rounds));
    ok('still no fake checker input', r.checkerPageState === null);
  }

  console.log('\n— (P0a) createMcpObserver.domProbe parses a REAL MCP envelope (content[].text), not the raw object —');
  {
    const domFacts = { inspectedSources: ['dom_error_containers'], fieldErrors: [{ fieldRole: 'username', text: 'Required' }], pageErrors: [] };
    // Faithful @playwright/mcp shape: text result under content[], with the "### Result" marker + trailing "### Ran" heading.
    const envelopeText = '### Result\n' + JSON.stringify(domFacts) + '\n### Ran Playwright code\nawait page.evaluate(...)';
    const fakeMcp = {
      callTool: async () => ({ content: [{ type: 'text', text: envelopeText }] }),
      textOfContent: mcp.textOfContent,
      parseEvaluateReturnValue: mcp.parseEvaluateReturnValue,
    };
    const obs = createMcpObserver({ mcp: fakeMcp, session: {} });
    const probed = await obs.domProbe();
    ok('domProbe returns domFacts (not the MCP envelope)', !!probed && Array.isArray(probed.fieldErrors) && probed.fieldErrors[0] && probed.fieldErrors[0].fieldRole === 'username', JSON.stringify(probed));
    ok('did NOT return the wrapper object', !(probed && probed.content), 'returned the raw MCP envelope');
  }

  console.log('\n— (P0b) DELAYED validation: unsettled+empty does NOT prematurely bug; settle -> error appears -> works —');
  {
    let settled = false;
    const delayed = {
      async snapshot() { return { snapshotText: settled ? SNAP_FIELD_REQUIRED : SNAP_CLEAN, url: URL_LOGIN, settled }; },
      async domProbe() { return { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: settled ? [{ fieldRole: 'username', text: 'Required' }] : [], pageErrors: [] }; },
      async settle() { settled = true; },
    };
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: delayed, patterns: PATTERNS, maxRounds: 5 });
    ok('ok:true (resolved after settle)', r.ok === true, JSON.stringify(r.pending));
    const v = judgeRowEvidence(reqValidation(), r.checkerPageState);
    ok('judge -> works (late validation caught, NOT a false bug)', v.verdict === 'works', `${v.verdict}/${v.reason}`);
    ok('took >= 3 rounds (probe -> settle -> re-check)', r.rounds >= 3, String(r.rounds));
  }

  console.log('\n— (P0c) page that NEVER settles -> absence never certifies -> capture_failure (NOT a false bug) —');
  {
    const neverSettles = {
      async snapshot() { return { snapshotText: SNAP_CLEAN, url: URL_LOGIN, settled: false }; },
      async domProbe() { return { inspectedSources: ['aria_describedby', 'dom_error_containers'], fieldErrors: [], pageErrors: [] }; },
      async settle() { /* page refuses to settle */ },
    };
    const r = await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: neverSettles, patterns: PATTERNS, maxRounds: 4 });
    ok('ok:false (absence never certified on unsettled page)', r.ok === false, r.status);
    ok('status automation_capture_failure (not a website bug)', r.status === 'automation_capture_failure');
    ok('no checker input produced', r.checkerPageState === null);
  }

  console.log('\n— (P0d) settle is RE-ESTABLISHED each cycle (no stale settled across actions) —');
  {
    let resets = 0;
    const obs = { async snapshot() { return { snapshotText: SNAP_FIELD_REQUIRED, url: URL_LOGIN }; }, resetSettle() { resets++; } };
    await acquireEvidence({ requiredEvidence: reqValidation().requiredEvidence, observer: obs, patterns: PATTERNS });
    ok('acquireEvidence calls observer.resetSettle() at cycle start', resets >= 1, String(resets));
  }

  console.log('\n— mergeDomFacts unions sources + dedupes —');
  {
    const m = mergeDomFacts({ inspectedSources: ['a'], fieldErrors: [{ fieldRole: 'u', text: 'x' }], pageErrors: [] }, { inspectedSources: ['b'], fieldErrors: [{ fieldRole: 'u', text: 'x' }, { fieldRole: 'p', text: 'y' }], pageErrors: [{ text: 'z' }] });
    ok('sources unioned', m.inspectedSources.includes('a') && m.inspectedSources.includes('b'), JSON.stringify(m.inspectedSources));
    ok('fieldErrors deduped', m.fieldErrors.length === 2, JSON.stringify(m.fieldErrors));
  }

  console.log('');
  if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
  console.log('OK — Evidence Acquisition Engine loop verified (FAKE observers; live MCP observer + DOM probe proven at B-2e)');
})();
