'use strict';
/*
 * Guard for B-2c.3 — Universal Interaction Kernel: classification + protocol
 * routing + certification via the right adapter. Proves enterprise interactions
 * map to reusable protocols (not one-off handlers), and that the unimplemented
 * protocols (grid/upload/rich) still certify honestly via generic effect.
 * SYNTHETIC fixtures, not live.
 */
const { classifyInteraction, certifyInteraction, PROTOCOLS } = require('../server/services/interactionProtocols');

let fail = 0;
const ok = (label, cond, detail) => { if (!cond) fail++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  <<< ' + (detail || '')}`); };
const cls = (ctx) => classifyInteraction(ctx);

console.log('— classification: interaction pattern -> protocol —');
{
  ok('type on textbox -> input', cls({ toolName: 'browser_type', targetRole: 'textbox' }) === 'input');
  ok('select_option -> choice', cls({ toolName: 'browser_select_option' }) === 'choice');
  ok('click on combobox -> choice', cls({ toolName: 'browser_click', targetRole: 'combobox' }) === 'choice');
  ok('click on checkbox -> choice', cls({ toolName: 'browser_click', targetRole: 'checkbox' }) === 'choice');
  ok('click on button -> command', cls({ toolName: 'browser_click', targetRole: 'button' }) === 'command');
  ok('click on link -> command', cls({ toolName: 'browser_click', targetRole: 'link' }) === 'command');
  ok('modal intent -> container', cls({ toolName: 'browser_click', intentKind: 'modal' }) === 'container');
  ok('file upload tool -> upload', cls({ toolName: 'browser_file_upload' }) === 'upload');
  ok('row_action intent -> grid', cls({ toolName: 'browser_click', intentKind: 'row_action' }) === 'grid');
  ok('date intent -> rich', cls({ toolName: 'browser_click', intentKind: 'date' }) === 'rich');
  ok('click on unknown role -> command (click+observe-effect is the right generic)', cls({ toolName: 'browser_click', targetRole: 'figure' }) === 'command');
  ok('unrecognized tool+role -> rich fallback (never crash)', cls({ toolName: 'browser_mystery', targetRole: 'figure' }) === 'rich');
}

console.log('\n— routing: each protocol certifies via its adapter —');
{
  // input -> field readback
  const inp = certifyInteraction({ toolName: 'browser_type', targetRole: 'textbox' }, { fieldLabel: 'Username', intendedValue: 'Admin', snapshotAfter: '- textbox "Username" [ref=e3]: Admin' });
  ok('input protocol -> field readback certified', inp.protocol === 'input' && inp.certified === true, JSON.stringify(inp));

  // choice (dropdown) -> two-step
  const CLOSED = '- combobox "User Role" [ref=e1]';
  const OPEN = ['- combobox "User Role" [ref=e1]', '- listbox:', '  - option "ESS" [ref=e2]'].join('\n');
  const SEL = '- combobox "User Role" [ref=e1]: ESS';
  const ch = certifyInteraction({ toolName: 'browser_click', targetRole: 'combobox' }, { controlLabel: 'User Role', optionLabel: 'ESS', snapshotBeforeOpen: CLOSED, snapshotAfterOpen: OPEN, snapshotAfterSelect: SEL });
  ok('choice protocol -> dropdown two-step certified', ch.protocol === 'choice' && ch.certified === true, JSON.stringify(ch).slice(0, 160));

  // command -> effect
  const cmd = certifyInteraction({ toolName: 'browser_click', targetRole: 'button' }, { urlBefore: 'https://x/login', urlAfter: 'https://x/dashboard', snapshotBefore: 'a', snapshotAfter: 'b' });
  ok('command protocol -> effect certified (navigation)', cmd.protocol === 'command' && cmd.certified === true && cmd.effect.kind === 'navigated', JSON.stringify(cmd.effect));
  const cmdNo = certifyInteraction({ toolName: 'browser_click', targetRole: 'button' }, { urlBefore: 'https://x/login', urlAfter: 'https://x/login', snapshotBefore: 'a', snapshotAfter: 'a' });
  ok('command with no effect -> not certified', cmdNo.certified === false);

  // container -> modal outcome
  const cont = certifyInteraction({ intentKind: 'modal', toolName: 'browser_click' }, { snapshotBefore: '- dialog "Confirm":\n  - button "Yes"', snapshotAfter: '- heading "Users"', expect: 'dismissed' });
  ok('container protocol -> modal dismissed certified', cont.protocol === 'container' && cont.certified === true, JSON.stringify(cont));
}

console.log('\n— unimplemented protocols certify via GENERIC effect (honest, flagged adapterImplemented:false) —');
{
  const grid = certifyInteraction({ intentKind: 'row_action', toolName: 'browser_click' }, { urlBefore: 'u', urlAfter: 'u', snapshotBefore: 'a', snapshotAfter: 'b' });
  ok('grid certifies on observed effect', grid.protocol === 'grid' && grid.certified === true);
  ok('grid flagged adapterImplemented:false', grid.adapterImplemented === false, JSON.stringify({ a: grid.adapterImplemented }));
  const rich = certifyInteraction({ intentKind: 'date', toolName: 'browser_click' }, { urlBefore: 'u', urlAfter: 'u', snapshotBefore: 'a', snapshotAfter: 'a' });
  ok('rich with no effect -> not certified, adapter pending', rich.certified === false && rich.adapterImplemented === false);
}

console.log('\n— every protocol declares a plan (the executor follows it at B-2d) —');
{
  ok('all 7 protocols have a non-empty plan', Object.values(PROTOCOLS).every((p) => Array.isArray(p.plan) && p.plan.length > 0), Object.keys(PROTOCOLS).join(','));
  ok('4 adapters implemented, 3 generic-fallback', Object.values(PROTOCOLS).filter((p) => p.adapterImplemented).length === 4 && Object.values(PROTOCOLS).filter((p) => !p.adapterImplemented).length === 3);
}

console.log('');
if (fail) { console.log(`FAILED — ${fail} assertion(s)`); process.exit(1); }
console.log('OK — Universal Interaction Kernel verified (SYNTHETIC; protocols wired into dispatch at B-2d, fleshed out post-B-2e)');
