'use strict';

/**
 * Universal Interaction Kernel (Phase B-2c.3) — handle enterprise UI through a
 * small set of REUSABLE PROTOCOLS instead of one-off widget handlers. An
 * interaction is classified into a protocol; the protocol declares a generic
 * action PLAN (what the executor does at B-2d) and a CERTIFY readback (what
 * proves it worked). Specific widgets are ADAPTERS under a protocol, not new
 * architecture.
 *
 *   Input      — text/password/textarea/number/date-like: focus → fill → readback → validation/counter/read-only
 *   Choice     — dropdown/combobox/autocomplete/radio/checkbox/switch/multiselect: open/focus → discover → select EXACT → readback selected
 *   Command    — button/link/menuitem/row-action: click → observe expected effect (nav/modal/toast/row/download/state)
 *   Container  — modal/drawer/accordion/tab/wizard: open/activate → confirm visible/current → scoped actions → close/advance
 *   Grid/Table — identify row by anchor data → scope to that row → act → verify row/cell/status change
 *   Upload/DL  — attach/download → verify filename/event/UI result
 *   Rich       — date picker/rich text/virtual list/drag-drop: detect signature → specific adapter if known → else DOM + effect
 *
 * Pure + deterministic. Input/Choice/Command/Container are wired to the existing
 * deterministic routines; Grid/Upload/Rich are declared with a GENERIC
 * effect-certification fallback (adapterImplemented:false) until their specific
 * adapters land post-B-2e — they still certify honestly via observed effect, they
 * just don't yet have widget-specific readback.
 */

const { certifyDropdownSelection, certifyFieldReadback, certifyToggleState, certifyModalOutcome } = require('./widgetRoutines');
const { classifyEffect } = require('./precisionActionKernel');

const INPUT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'textarea']);
const CHOICE_ROLES = new Set(['combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const COMMAND_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'treeitem']);
const CONTAINER_INTENTS = new Set(['modal', 'dialog', 'drawer', 'accordion', 'tab', 'wizard']);
const RICH_INTENTS = new Set(['date', 'datepicker', 'richtext', 'virtuallist', 'dragdrop']);

/**
 * Classify an interaction into a protocol. Intent (when the Architect/step
 * declares it) wins; otherwise role + tool decide. Unknown → 'rich' (the generic
 * DOM+effect fallback) so we never crash on an unrecognised widget.
 */
function classifyInteraction({ toolName = '', targetRole = '', intentKind = null } = {}) {
  const role = String(targetRole || '').toLowerCase();
  const tool = String(toolName || '').toLowerCase();
  if (intentKind && CONTAINER_INTENTS.has(intentKind)) return 'container';
  if (intentKind === 'upload' || intentKind === 'download' || /file_upload|download/.test(tool)) return 'upload';
  if (intentKind === 'grid' || intentKind === 'row_action') return 'grid';
  if (intentKind && RICH_INTENTS.has(intentKind)) return 'rich';
  if (/select_option/.test(tool) || CHOICE_ROLES.has(role)) return 'choice';
  if (/type|fill/.test(tool) || INPUT_ROLES.has(role)) return 'input';
  if (/click|hover|drag/.test(tool) || COMMAND_ROLES.has(role)) return 'command';
  return 'rich';
}

function genericEffectCertify(widget, obs) {
  const effect = classifyEffect(obs || {});
  return {
    widget,
    certified: effect.observed === true,
    effect,
    adapterImplemented: false,
    reason: effect.observed
      ? `generic effect "${effect.kind}" observed (specific ${widget} adapter pending post-B-2e)`
      : `no observable effect (specific ${widget} adapter pending post-B-2e)`,
  };
}

const PROTOCOLS = {
  input: {
    name: 'input',
    plan: ['focus target', 'fill/type value', 'DOM readback of value', 'check validation/counter/read-only'],
    adapterImplemented: true,
    certify: (obs) => certifyFieldReadback(obs),
  },
  choice: {
    name: 'choice',
    plan: ['open/focus control', 'discover options/current state', 'select EXACT intended value', 'readback selected state'],
    adapterImplemented: true,
    // dropdown/autocomplete/multiselect -> two-step; radio/checkbox/switch -> toggle.
    certify: (obs) => ((obs && obs.optionLabel != null && obs.snapshotAfterOpen != null)
      ? certifyDropdownSelection(obs)
      : certifyToggleState(obs)),
  },
  command: {
    name: 'command',
    plan: ['click target', 'observe expected effect (nav/modal/toast/row/download/state)'],
    adapterImplemented: true,
    certify: (obs) => {
      const effect = classifyEffect(obs || {});
      const expected = obs && obs.expectedEffect;
      const certified = effect.observed && (!expected || expected === effect.kind);
      return {
        widget: 'command',
        certified,
        effect,
        reason: !effect.observed ? 'no observable effect after command'
          : (expected && expected !== effect.kind) ? `effect "${effect.kind}" != expected "${expected}"`
            : `command effect "${effect.kind}" observed`,
      };
    },
  },
  container: {
    name: 'container',
    plan: ['open/activate container', 'confirm container visible/current', 'scoped actions inside', 'close/advance if required'],
    adapterImplemented: true,
    certify: (obs) => certifyModalOutcome(obs),
  },
  grid: {
    name: 'grid',
    plan: ['identify row by anchor data', 'scope action to that row', 'perform action', 'verify row/cell/status change'],
    adapterImplemented: false,
    certify: (obs) => genericEffectCertify('grid', obs),
  },
  upload: {
    name: 'upload',
    plan: ['attach file / trigger download', 'verify filename/event/UI result'],
    adapterImplemented: false,
    certify: (obs) => genericEffectCertify('upload', obs),
  },
  rich: {
    name: 'rich',
    plan: ['detect role/DOM signature', 'use specific protocol if recognized', 'else inspect DOM + action effect'],
    adapterImplemented: false,
    certify: (obs) => genericEffectCertify('rich', obs),
  },
};

/** Resolve the protocol for a context (without certifying). */
function protocolFor(ctx) { return PROTOCOLS[classifyInteraction(ctx)]; }

/**
 * Classify + certify an interaction. Returns { protocol, plan, adapterImplemented,
 * ...certification }. The certification still feeds widgetStateBefore/effect into
 * the PrecisionActionRecord at B-2d — this is the routing layer above the routines.
 */
function certifyInteraction(ctx, obs) {
  const name = classifyInteraction(ctx);
  const proto = PROTOCOLS[name];
  const result = proto.certify(obs || {});
  return { protocol: name, plan: proto.plan, adapterImplemented: proto.adapterImplemented, ...result };
}

module.exports = { classifyInteraction, certifyInteraction, protocolFor, PROTOCOLS };
