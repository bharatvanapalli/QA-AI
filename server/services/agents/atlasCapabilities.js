'use strict';

/**
 * Enterprise Mode P3a — capability classification (NODE-deterministic).
 *
 * Given a calibrated page's already-extracted interactive elements (each with a
 * VERIFIED selectorChain), textCorpus, and raw snapshot, classify the page into
 * typed CapabilityRecords from the frozen vocabulary
 * (server/lib/capabilityVocabulary.js). The capability TYPE is detected from the
 * accessibility structure; the EVIDENCE (selectors/fields/columns) is lifted from
 * the verified elements — never invented. A capability whose evidence has no
 * usable selector is DROPPED (the "no verified selector ⇒ unusable" rule).
 *
 * v1 is fully deterministic (no LLM) — cheaper, reproducible, guardable. An
 * optional LLM *naming* pass can be layered later, but it may only rename; it can
 * never add an operation or a selector (LLM proposes, Node disposes).
 *
 * Pure (no DB/LLM/IO) → scripts/verify_atlas.cjs guards it. Imported by the
 * calibrator, which persists the result to CalibrationPage.capabilitiesJson.
 */

const crypto = require('crypto');
const vocab = require('../../lib/capabilityVocabulary');

// P3d — the FIRST non-mcp-ref selector anywhere in a capability's evidence. Used
// for the stable capabilityId hash and as the capability's anchor.
function primarySelectorOf(rec) {
  const m = /"selector"\s*:\s*"([^"]+)"/.exec(JSON.stringify((rec && rec.evidence) || {}));
  return m ? m[1] : '';
}

// P3d — deterministic, slice-scoped capability identity. Includes module + page +
// authProfile context so a "Save"/"Delete" capability on two different pages (or
// two roles) never collides. The same structure → the same id (stable across
// re-crawls when unchanged); any of {module, authProfile, page, type, name,
// selector} changing → a new id. operations[].capabilityRef binds to THIS id.
function computeCapabilityId({ module, authProfileId, pageUrl, type, name, primarySelector }) {
  const basis = [module || '', authProfileId || '', pageUrl || '', type || '', name || '', primarySelector || ''].join('|');
  return 'cap-' + crypto.createHash('sha1').update(basis).digest('hex').slice(0, 10);
}

const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'switch', 'listbox', 'slider']);
const COLLECTION_CELL_ROLES = new Set(['row', 'gridcell', 'cell', 'columnheader', 'listitem', 'option', 'treeitem']);
const SUBMIT_RE = /\b(save|submit|log\s?in|sign\s?in|add|create|update|search|apply|confirm|continue|next|place order|register|send)\b/i;
const ACTION_RE = /\b(approve|reject|delete|remove|cancel|edit|assign|export|publish|archive|deactivate|activate|withdraw)\b/i;
const SEARCH_RE = /\b(search|filter|sort)\b/i;
const FILE_RE = /\b(upload|download|choose file|attach|browse|import|export)\b/i;

// The selector a capability carries into BDD / ReplayIR — both of which run in a
// FRESH session where an mcp `ref=eN` no longer resolves. So we accept ONLY a
// durable, cross-session locator (getByRole / getByLabel / testid / css),
// preferring a verified one, then highest stability. An element whose ONLY
// locator is an ephemeral session ref returns null ⇒ it cannot anchor a usable
// capability, and validateCapabilityRecord drops the record (the "no verified
// selector ⇒ unusable" rule). This is what keeps every persisted capability
// replayable outside the calibration session.
//
// NOTE on `verified`: the calibrator marks durable selectors verified:false
// (only the ref=eN fallback is verified:true) because it derives them from the
// snapshot parse rather than click-proving them. For a capability the durable
// selector is still the correct choice — it is snapshot-DERIVED (the element is
// present in the tree we just read) and cross-session usable; deep per-selector
// resolve-proofing (occurrence==1) is a P3b hardening, not a P3a gate.
function bestSelector(el) {
  const chain = Array.isArray(el && el.selectorChain) ? el.selectorChain : [];
  const durable = chain.filter((s) => s && s.selector && s.strategy !== 'mcp-ref');
  if (!durable.length) return null;
  const byStability = (a, b) => (b.stabilityScore || 0) - (a.stabilityScore || 0);
  const verified = durable.filter((s) => s.verified).sort(byStability);
  if (verified[0]) return verified[0].selector;
  return durable.sort(byStability)[0].selector;
}

function refOf(el) {
  if (el && el.ref) return el.ref;
  const chain = Array.isArray(el && el.selectorChain) ? el.selectorChain : [];
  for (const s of chain) { const m = /ref=(\w+)/.exec((s && s.selector) || ''); if (m) return m[1]; }
  return null;
}

function labelOf(el) {
  const m = /"([^"]+)"/.exec((el && el.semanticLabel) || '');
  if (m) return m[1];
  return (el && el.name) || (el && el.semanticLabel) || '';
}

const roleOf = (el) => String((el && el.ariaRole) || '').toLowerCase();

/**
 * @returns {{ capabilities: CapabilityRecord[], dropped: Array<{name,type,violations}> }}
 */
function classifyCapabilities({ elements = [], textCorpus = [], snapshot = '', pageUrl = '', module = null, authProfileId = null } = {}) {
  const els = Array.isArray(elements) ? elements : [];
  const lower = String(snapshot || '').toLowerCase();
  const candidates = [];

  const inputs = els.filter((e) => INPUT_ROLES.has(roleOf(e)) && bestSelector(e));
  const buttons = els.filter((e) => roleOf(e) === 'button' && bestSelector(e));
  const submit = buttons.find((b) => SUBMIT_RE.test(labelOf(b)));

  // ── form ──
  if (inputs.length >= 1 && submit) {
    candidates.push({
      type: 'form',
      name: labelOf(submit) ? `${labelOf(submit)} form` : 'Form',
      operations: ['fillField', 'submitForm'],
      evidence: {
        fields: inputs.map((i) => ({ label: labelOf(i), role: i.ariaRole, selector: bestSelector(i) })),
        submit: { label: labelOf(submit), selector: bestSelector(submit) },
      },
      elementRefs: [...inputs, submit].map(refOf).filter(Boolean),
    });
  }

  // ── entity_collection (normalized table/grid/card/list) ──
  const hasTableStructure = els.some((e) => COLLECTION_CELL_ROLES.has(roleOf(e)))
    || /\b(table|grid|rowgroup|columnheader)\b/.test(lower);
  const listItems = els.filter((e) => ['listitem', 'option', 'treeitem'].includes(roleOf(e)));
  if (hasTableStructure || listItems.length >= 3) {
    // P3d — columns carry per-column durable selectors (the column header's
    // verified locator), not just labels. Validation only needs the names, but
    // ReplayIR/BDD helpers need a durable selector to actually read the column
    // ("rank by the price column"). Label-only would not be runnable.
    const columns = els.filter((e) => roleOf(e) === 'columnheader')
      .map((e) => ({ name: labelOf(e), selector: bestSelector(e) }))
      .filter((c) => c.name);
    const rowEl = els.find((e) => ['row', 'listitem'].includes(roleOf(e)) && bestSelector(e));
    if (rowEl) {
      candidates.push({
        type: 'entity_collection',
        name: columns.length ? `Collection [${columns.slice(0, 4).map((c) => c.name).join(', ')}]` : 'Entity collection',
        operations: ['selectEntityWhere', 'rankByMin', 'rankByMax', 'chooseSelected', 'assertTableContains'],
        evidence: { columns, rowSelector: { selector: bestSelector(rowEl) } },
        elementRefs: [refOf(rowEl)].filter(Boolean),
      });
    }
  }

  // ── search_filter_sort ──
  const searchBox = els.find((e) => roleOf(e) === 'searchbox' && bestSelector(e))
    || inputs.find((i) => SEARCH_RE.test(labelOf(i)));
  if (searchBox) {
    candidates.push({
      type: 'search_filter_sort',
      name: `Search/filter (${labelOf(searchBox) || 'search'})`,
      operations: ['fillField', 'selectEntityWhere'],
      evidence: { search: { label: labelOf(searchBox), selector: bestSelector(searchBox) } },
      elementRefs: [refOf(searchBox)].filter(Boolean),
    });
  }

  // ── workflow_action (action-verb buttons that aren't the form submit) ──
  for (const a of buttons.filter((b) => ACTION_RE.test(labelOf(b)) && b !== submit)) {
    candidates.push({
      type: 'workflow_action',
      name: labelOf(a) || 'Action',
      operations: ['invokeAction'],
      evidence: { action: { label: labelOf(a), selector: bestSelector(a) } },
      elementRefs: [refOf(a)].filter(Boolean),
    });
  }

  // ── modal (only if it carries an actionable control — else not usable) ──
  const isModal = els.some((e) => ['dialog', 'alertdialog'].includes(roleOf(e))) || /\bdialog\b/.test(lower);
  const modalCtrl = submit || buttons[0];
  if (isModal && modalCtrl && bestSelector(modalCtrl)) {
    candidates.push({
      type: 'modal',
      name: 'Dialog',
      operations: ['fillField', 'submitForm', 'invokeAction'],
      evidence: { submit: { label: labelOf(modalCtrl), selector: bestSelector(modalCtrl) } },
      elementRefs: [refOf(modalCtrl)].filter(Boolean),
    });
  }

  // ── file ── (scope to interactive controls: a table CELL reading "Export" is
  //    data, not a download control — the classifier now sees structural roles,
  //    so this guard keeps file capabilities anchored to a real button/link/input)
  const fileEl = els.find((e) => FILE_RE.test(labelOf(e)) && ['button', 'link', 'textbox'].includes(roleOf(e)) && bestSelector(e));
  if (fileEl) {
    candidates.push({
      type: 'file',
      name: labelOf(fileEl) || 'File',
      operations: ['downloadFile'],
      evidence: { control: { label: labelOf(fileEl), selector: bestSelector(fileEl) } },
      elementRefs: [refOf(fileEl)].filter(Boolean),
    });
  }

  // ── validate against the frozen vocabulary; drop unusable (no verified selector
  //    / op not valid for type). This is where the "unusable ⇒ dropped" rule bites.
  const capabilities = [];
  const dropped = [];
  for (const c of candidates) {
    const v = vocab.validateCapabilityRecord(c);
    if (!v.ok) { dropped.push({ name: c.name, type: c.type, violations: v.violations }); continue; }
    // P3d — stamp the deterministic, slice-scoped id operations[] will bind to.
    c.capabilityId = computeCapabilityId({
      module, authProfileId, pageUrl, type: c.type, name: c.name, primarySelector: primarySelectorOf(c),
    });
    if (pageUrl) c.pageUrl = pageUrl;
    capabilities.push(c);
  }
  return { capabilities, dropped };
}

module.exports = { classifyCapabilities, bestSelector, refOf, labelOf, computeCapabilityId, primarySelectorOf };
