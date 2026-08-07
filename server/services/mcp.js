'use strict';

/**
 * MCP wrapper — drives `@playwright/mcp` as a **subprocess** over stdio.
 *
 * Why subprocess instead of in-process (Phase T2 rework):
 *   - Microsoft designed @playwright/mcp to be launched this way; in-process
 *     `InMemoryTransport` works for smoke tests but doesn't isolate Chromium
 *     crashes from our long-running Express server.
 *   - When Chromium dies (alpha Playwright is unstable, corp EDR may kill
 *     chrome.exe), the subprocess dies too — our server stays clean and
 *     spawns a fresh subprocess for the next session.
 *   - StdioClientTransport from the official MCP SDK handles process lifecycle:
 *     spawning, stdin/stdout framing, and clean shutdown.
 *
 * The Conductor calls `client.listTools()` to discover available tools and
 * `client.callTool()` to invoke them. Tool responses include text snapshots
 * (yaml/json describing the page) and optionally images (jpeg/png base64).
 * Image blocks are translated to Anthropic's `{type:'image', source:{...}}`
 * shape so Claude can see screenshots when MCP returns them.
 *
 * A `frame poller` polls `browser_take_screenshot` every ~500ms and broadcasts
 * each image as a `browser.frame` WS message for the Theater UI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const http = require('http');

const mcpContextConfig = require('./mcpContextConfig');
const waitContract = require('./waitContract');
const { normalizePath } = require('../lib/urlNormalize');
// P2-3 — shared role-alias map (was duplicated inline in _checkAssertionOnce).
const { aliasesFor } = require('../lib/roleAliases');
const { recordDegradation } = require('../lib/degradationSignal');
const authoritativeCdpCapture = require('./authoritativeCdpCapture');
const locatorCaptureAnalysis = require('./locatorCaptureAnalysis');
const browserMutationTaxonomy = require('./browserMutationTaxonomy');
const inPageEventRecorder = require('./inPageEventRecorder');

const CAPTURE_RUNTIME_SCHEMA = 'qaai-capture-runtime-v1';
const CAPTURE_RUNTIME_STARTED_AT = new Date().toISOString();

function captureFileFingerprint(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return {
      file: path.relative(path.join(__dirname, '..', '..'), filePath).replace(/\\/g, '/'),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      bytes: content.length,
    };
  } catch (error) {
    return {
      file: String(filePath || ''),
      sha256: null,
      bytes: null,
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

const CAPTURE_BUILD_INPUTS = [
  __filename,
  require.resolve('./authoritativeCdpCapture'),
  require.resolve('./locatorCaptureAnalysis'),
  require.resolve('./actionLocatorResolver'),
].map(captureFileFingerprint);
const CAPTURE_BUILD_FINGERPRINT = crypto.createHash('sha256')
  .update(JSON.stringify({
    schema: CAPTURE_RUNTIME_SCHEMA,
    node: process.version,
    inputs: CAPTURE_BUILD_INPUTS.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })),
  }))
  .digest('hex');
const CAPTURE_RUNTIME_INSTANCE_ID = crypto.createHash('sha256')
  .update(`${CAPTURE_BUILD_FINGERPRINT}:${process.pid}:${CAPTURE_RUNTIME_STARTED_AT}`)
  .digest('hex');

function captureRuntimeDescriptor(extra = {}) {
  return {
    schema: CAPTURE_RUNTIME_SCHEMA,
    buildFingerprint: CAPTURE_BUILD_FINGERPRINT,
    runtimeInstanceId: CAPTURE_RUNTIME_INSTANCE_ID,
    runtimeStartedAt: CAPTURE_RUNTIME_STARTED_AT,
    processId: process.pid,
    nodeVersion: process.version,
    buildInputs: CAPTURE_BUILD_INPUTS.map((item) => ({ ...item })),
    ...extra,
  };
}

function inspectCaptureRuntime(session) {
  const observed = session?.captureRuntime || null;
  const reasons = [];
  if (!observed) reasons.push('capture_runtime_descriptor_missing');
  if (observed && observed.schema !== CAPTURE_RUNTIME_SCHEMA) reasons.push('capture_runtime_schema_mismatch');
  if (observed && observed.buildFingerprint !== CAPTURE_BUILD_FINGERPRINT) reasons.push('capture_build_fingerprint_mismatch');
  if (observed && observed.runtimeInstanceId !== CAPTURE_RUNTIME_INSTANCE_ID) reasons.push('capture_runtime_instance_mismatch');
  if (session?.closed === true) reasons.push('capture_session_closed');
  if (observed && observed.mcpSubprocessPid && session?.subprocessPid
      && Number(observed.mcpSubprocessPid) !== Number(session.subprocessPid)) {
    reasons.push('mcp_subprocess_identity_mismatch');
  }
  if (observed?.liveCdpEnabled === true && !session?.liveCdp) {
    reasons.push('live_cdp_session_missing');
  }
  if (observed?.liveCdpEnabled === true
      && !session?.liveCdp?.context
      && !session?.liveCdp?.monitorBrowser) {
    reasons.push('live_cdp_playwright_binding_missing');
  }
  if (observed?.liveCdpEndpoint && session?.liveCdp?.endpoint
      && String(observed.liveCdpEndpoint) !== String(session.liveCdp.endpoint)) {
    reasons.push('live_cdp_endpoint_mismatch');
  }
  return {
    schema: CAPTURE_RUNTIME_SCHEMA,
    status: reasons.length ? 'stale_or_unidentified' : 'current',
    current: reasons.length === 0,
    stale: reasons.length > 0,
    reasons,
    expectedBuildFingerprint: CAPTURE_BUILD_FINGERPRINT,
    expectedRuntimeInstanceId: CAPTURE_RUNTIME_INSTANCE_ID,
    observed: observed ? { ...observed } : null,
    checkedAt: new Date().toISOString(),
  };
}

function captureRuntimeEvidence(session, audit = inspectCaptureRuntime(session)) {
  const descriptor = session?.captureRuntime || {};
  return {
    schema: CAPTURE_RUNTIME_SCHEMA,
    status: audit.status,
    current: audit.current,
    stale: audit.stale,
    reasons: audit.reasons.slice(),
    buildFingerprint: descriptor.buildFingerprint || null,
    runtimeInstanceId: descriptor.runtimeInstanceId || null,
    runtimeStartedAt: descriptor.runtimeStartedAt || null,
    sessionId: session?.id || descriptor.sessionId || null,
    sessionStartedAt: descriptor.sessionStartedAt || null,
    processId: descriptor.processId || null,
    mcpSubprocessPid: session?.subprocessPid || descriptor.mcpSubprocessPid || null,
    mcpToolFingerprint: descriptor.mcpToolFingerprint || null,
    liveCdpEnabled: descriptor.liveCdpEnabled === true,
    liveCdpEndpoint: descriptor.liveCdpEndpoint || null,
    runBindings: Array.isArray(descriptor.runBindings) ? descriptor.runBindings.slice() : [],
    bindingAttempts: Array.isArray(descriptor.bindingAttempts) ? descriptor.bindingAttempts.slice() : [],
    checkedAt: audit.checkedAt,
  };
}

function stampCaptureRuntime(result, session, audit = inspectCaptureRuntime(session)) {
  if (!result || typeof result !== 'object') return result;
  result.qaaiCaptureRuntime = captureRuntimeEvidence(session, audit);
  return result;
}

/**
 * Phase H M4 — append a URL to the session's visitedUrls set, normalized
 * to its path so postLoopRatify's three-way disambiguation works. Called
 * from every site that stamps session.currentUrl. Best-effort — never
 * throws (the set is bookkeeping, not load-bearing for the tool call).
 */
function appendVisitedUrl(session, rawUrl) {
  if (!session || !rawUrl || !session.visitedUrls) return;
  try {
    const norm = normalizePath(rawUrl);
    if (norm) session.visitedUrls.add(norm);
  } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────
// CANONICAL snapshot line tokenizer — the SINGLE SOURCE OF TRUTH.
//
// Playwright MCP renders the accessibility tree top-to-bottom, one line per
// element. Lines look like:
//   `  - button "Login" [ref=e15]`
//   `  - textbox "Username" [active] [ref=e23]`
//   `  - option "X" [selected] [ref=e9]`
//   `  - generic [ref=e5]:`
//
// Every consumer that reads a snapshot MUST go through parseSnapshotLine so a
// format change in @playwright/mcp output is reconciled in ONE place. Two
// consumers exist today and they look through this exact same lens:
//   • buildRefRoleMap            → Map<ref,{role,name}> for role validation +
//                                  the stale-ref self-heal
//   • parseMcpSnapshotToCandidates → selector candidates for the KB/healer
//
// HISTORY: these used to be two independent hand-rolled regexes. buildRefRoleMap's
// required `[ref=…]` to be the FIRST bracket after the name, so when 0.0.75 began
// emitting `[active]`/`[selected]`/`[checked]`/`[expanded]`/`[disabled]` BEFORE
// the ref, every stateful/focused element was silently dropped from the role map
// (the root cause of the "empty password" stale-ref loop). parseMcpSnapshotToCandidates
// was immune because it scans the line's REST for the ref. Consolidating onto that
// approach makes the immunity systemic: if the agent can see an element, the
// healer can see it too.
//
// The line shape is: `<indent>- <role> ["name"|'name']? <rest…>` where <rest>
// carries bracketed metadata ([ref=…], [placeholder="…"], [testid="…"], [id="…"],
// [active], [checked], …). The role token may contain hyphens (e.g. menu-item).
// ─────────────────────────────────────────────────────────────────────────
const _SNAPSHOT_LINE_RE = /^\s*-\s+(\w[\w-]*)\b\s*(?:"([^"]+)"|'([^']+)')?\s*(.*)$/;
const _SNAP_REF_RE = /\[ref=([\w-]+)\]/;
const _SNAP_PLACEHOLDER_RE = /\[placeholder="([^"]+)"\]/;
const _SNAP_TESTID_RE = /\[testid="([^"]+)"\]/;
const _SNAP_ID_RE = /\[id="([^"]+)"\]/;
const _SNAP_DISABLED_RE = /\[disabled(?:=(?:true|"true"|'true'))?\]/i;
const _SNAP_READONLY_RE = /\[readonly(?:=(?:true|"true"|'true'))?\]/i;

// Parse ONE snapshot line into its structured parts, or null if the line is not
// an element row. `ref` is searched anywhere in the line's trailing metadata —
// NOT required to be adjacent to the name — which is what makes the parser
// robust to pre-ref attributes like [active]/[selected].
function parseSnapshotLine(line) {
  if (typeof line !== 'string') return null;
  const m = line.match(_SNAPSHOT_LINE_RE);
  if (!m) return null;
  const rest = m[4] || '';
  return {
    role: m[1] || '',
    name: m[2] || m[3] || '',
    rest,
    ref: (rest.match(_SNAP_REF_RE) || [])[1] || null,
    placeholder: (rest.match(_SNAP_PLACEHOLDER_RE) || [])[1] || null,
    testid: (rest.match(_SNAP_TESTID_RE) || [])[1] || null,
    idAttr: (rest.match(_SNAP_ID_RE) || [])[1] || null,
    disabled: _SNAP_DISABLED_RE.test(rest),
    readonly: _SNAP_READONLY_RE.test(rest),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// buildRefRoleMap — projects the canonical line parse into a Map<ref,{role,name}>
// so the conductor can validate role/tool compatibility BEFORE dispatching a
// tool call (browser_type on a button never reaches MCP) and the self-heal can
// resolve a stale ref by accessible name. Lines without a `[ref=...]` token are
// skipped. NAMELESS-but-ref'd elements (e.g. `- generic [ref=e5]`) ARE kept —
// the role validator needs them to reject typing into a nameless button.
// ─────────────────────────────────────────────────────────────────────────
function buildRefRoleMap(snapshotText) {
  const map = new Map();
  if (!snapshotText || typeof snapshotText !== 'string') return map;
  for (const line of snapshotText.split(/\r?\n/)) {
    const p = parseSnapshotLine(line);
    if (!p || !p.ref) continue;
    // First occurrence wins — same ref shouldn't appear twice in a snapshot
    // but if it does, the earlier (outer) element is the canonical one.
    if (!map.has(p.ref)) {
      map.set(p.ref, {
        role: (p.role || '').toLowerCase(),
        name: p.name || '',
        disabled: !!p.disabled,
        readonly: !!p.readonly,
      });
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// Tool ↔ role compatibility table.
//
// Sourced from the official Playwright MCP tool surface (verified against
// microsoft/playwright-mcp 2026-05). Each entry lists the snapshot ROLES
// the tool can act on. `permissive: true` means the tool accepts any
// interactive element (no pre-dispatch role check applied — let MCP decide).
//
// For tools with strict role constraints (browser_type, browser_select_option),
// passing an incompatible ref is a guaranteed wasted turn — the conductor
// rejects pre-dispatch with a structured hint naming the correct tool.
// ─────────────────────────────────────────────────────────────────────────
const TOOL_ROLE_RULES = {
  browser_type: {
    validRoles: new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']),
    suggestForOtherRoles: {
      button: 'browser_click',
      link: 'browser_click',
      checkbox: 'browser_click',
      radio: 'browser_click',
      menuitem: 'browser_click',
      option: 'browser_click',
      tab: 'browser_click',
      switch: 'browser_click',
      'file-input': 'browser_file_upload',
      fileinput: 'browser_file_upload',
      listbox: 'browser_select_option',
      img: '(read-only — images are not typeable)',
      image: '(read-only — images are not typeable)',
      heading: '(read-only — headings are not typeable)',
      generic: '(this element exposes no role — pick a child with role=textbox)',
    },
  },
  browser_select_option: {
    validRoles: new Set(['combobox', 'listbox', 'option', 'select']),
    suggestForOtherRoles: {
      textbox: 'browser_type',
      searchbox: 'browser_type',
      button: 'browser_click (then browser_click again on the menu option that appears)',
      checkbox: 'browser_click',
      radio: 'browser_click',
    },
  },
};

/**
 * Pre-dispatch validation: when an element-targeting tool would act on an
 * incompatible role, return a structured rejection that mirrors the MCP
 * error shape so the conductor's existing diagnoseToolError pathway fires.
 *
 * Returns:
 *   null                  — validation passed (dispatch normally)
 *   { errorText: string } — validation failed (synthesize an MCP error)
 *
 * Permissive on lookup failure: if the ref isn't in the map (stale snapshot,
 * agent referring to an element from a prior page, ref the snapshot pruned),
 * we let MCP run the call. Better to get a real MCP error than over-block.
 */
function domFactFromParsed(parsed, line, nearbyText = []) {
  if (!parsed) return null;
  return {
    role: parsed.role || null,
    accessibleName: parsed.name || null,
    text: parsed.name || null,
    placeholder: parsed.placeholder || null,
    testId: parsed.testid || null,
    idAttr: parsed.idAttr || null,
    selector: parsed.idAttr ? `#${escapeCss(parsed.idAttr)}` : null,
    ref: parsed.ref || null,
    snapshotLine: line ? String(line).trim().slice(0, 500) : null,
    nearbyText: (nearbyText || []).filter(Boolean).slice(0, 8),
  };
}

function findSnapshotDomFact(snapshotText, { ref, role, name } = {}) {
  if (!snapshotText || typeof snapshotText !== 'string') return null;
  const lines = String(snapshotText).split(/\r?\n/);
  const parsed = lines.map((line, index) => ({ line, index, parsed: parseSnapshotLine(line) })).filter((x) => x.parsed);
  let chosen = null;
  if (ref) chosen = parsed.find((x) => x.parsed.ref === ref) || null;
  if (!chosen && role && name) {
    const r = String(role).toLowerCase();
    const n = String(name).trim().toLowerCase();
    const matches = parsed.filter((x) => String(x.parsed.role || '').toLowerCase() === r && String(x.parsed.name || '').trim().toLowerCase() === n);
    if (matches.length === 1) chosen = matches[0];
  }
  if (!chosen && name) {
    const n = String(name).trim().toLowerCase();
    const matches = parsed.filter((x) => String(x.parsed.name || '').trim().toLowerCase() === n || String(x.parsed.placeholder || '').trim().toLowerCase() === n);
    if (matches.length === 1) chosen = matches[0];
  }
  if (!chosen) return null;
  const nearbyText = parsed
    .filter((x) => Math.abs(x.index - chosen.index) <= 3 && x.index !== chosen.index)
    .map((x) => x.parsed.name || x.parsed.placeholder || '')
    .filter(Boolean);
  return domFactFromParsed(chosen.parsed, chosen.line, nearbyText);
}

function extractDomFactsForTool(toolName, args, snapshotText) {
  if (!args || typeof args !== 'object' || !snapshotText) return null;
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    const fields = args.fields.map((f) => {
      if (!f || typeof f !== 'object') return null;
      const fact = findSnapshotDomFact(snapshotText, {
        ref: f.ref || f.target || null,
        role: f.type || null,
        name: f.name || f.label || f.element || null,
      });
      return fact ? { name: f.name || f.label || null, ref: f.ref || f.target || fact.ref || null, facts: fact } : null;
    }).filter(Boolean);
    return fields.length ? { fields } : null;
  }
  const fact = findSnapshotDomFact(snapshotText, {
    ref: args.ref || args.target || null,
    role: args.role || null,
    name: args.element || args.name || null,
  });
  return fact ? { target: fact } : null;
}

function validateRoleForTool(session, toolName, callArgs) {
  // browser_fill_form is multi-target browser_type — each field must
  // satisfy browser_type's role constraint. Resolve the effective rule
  // FIRST so the early-return below doesn't bail on browser_fill_form
  // (which has no rule of its own, but maps to browser_type's rule).
  const checkedTool = toolName === 'browser_fill_form' ? 'browser_type' : toolName;
  const checkedRule = TOOL_ROLE_RULES[checkedTool];
  if (!checkedRule) return null;
  const map = session?.refRoleMap;
  if (!map || !(map instanceof Map) || map.size === 0) return null;

  // Collect the refs this tool would act on.
  const refs = [];
  if (callArgs?.target && typeof callArgs.target === 'string') refs.push({ ref: callArgs.target });
  if (toolName === 'browser_fill_form' && Array.isArray(callArgs?.fields)) {
    for (const f of callArgs.fields) {
      if (f && typeof f.target === 'string') refs.push({ ref: f.target, fieldName: f.name });
    }
  }
  if (!refs.length) return null;

  for (const { ref, fieldName } of refs) {
    const entry = map.get(ref);
    if (!entry) continue; // unknown ref → permissive
    if (checkedRule.validRoles.has(entry.role)) continue;
    const suggested = checkedRule.suggestForOtherRoles[entry.role]
      || '(no automatic suggestion — inspect the snapshot for the correct interactive element)';
    const which = fieldName ? `field "${fieldName}" (target=${ref})` : `target=${ref}`;
    const errorText = [
      `Pre-dispatch validation: ${toolName} cannot act on ${which} because that ref is role="${entry.role}"`,
      entry.name ? ` ("${entry.name}")` : '',
      `. ${toolName} only operates on: ${Array.from(checkedRule.validRoles).join(', ')}.`,
      ` Use ${suggested} instead.`,
      ` Take a fresh browser_snapshot if you think the role is wrong — refs change after navigation.`,
    ].join('');
    return { errorText, role: entry.role, name: entry.name, ref, suggestedTool: suggested };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Stale-ref guard — element IDENTITY, complementing validateRoleForTool's
// element-TYPE check. Now that the model is handed the SETTLED post-action
// snapshot (see the result.content overwrite in callTool), the refs it picks
// come from the SAME tree we validate against — so a ref absent from the
// current refRoleMap reliably means the agent reused a STALE ref from an
// earlier snapshot (the classic "clicked the wrong element" after a menu
// opened / page redirected). We FIRST try to re-resolve by the element's
// accessible NAME (this is what makes name-targeting the real path, not a
// fallback); only if that's ambiguous do we reject and force a re-snapshot.
// ─────────────────────────────────────────────────────────────────────────
function lineIndent(line) {
  return (String(line || '').match(/^\s*/) || [''])[0].length;
}

function findUniqueChildRefByRole(snapshotText, parentRef, roles) {
  const roleSet = new Set([...roles || []].map((r) => String(r).toLowerCase()));
  if (!snapshotText || !parentRef || !roleSet.size) return null;
  const lines = String(snapshotText).split(/\r?\n/);
  const parentIndex = lines.findIndex((line) => {
    const parsed = parseSnapshotLine(line);
    return parsed && parsed.ref === parentRef;
  });
  if (parentIndex < 0) return null;
  const parentIndent = lineIndent(lines[parentIndex]);
  const candidates = [];
  for (let i = parentIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const parsed = parseSnapshotLine(line);
    if (!parsed) continue;
    const indent = lineIndent(line);
    if (indent <= parentIndent) break;
    if (parsed.ref && roleSet.has(String(parsed.role || '').toLowerCase())) {
      candidates.push({ ref: parsed.ref, role: String(parsed.role || '').toLowerCase(), name: parsed.name || '', line });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function findNearestAncestorRefByRole(snapshotText, childRef, roles) {
  const roleSet = new Set([...roles || []].map((r) => String(r).toLowerCase()));
  if (!snapshotText || !childRef || !roleSet.size) return null;
  const lines = String(snapshotText).split(/\r?\n/);
  const childIndex = lines.findIndex((line) => {
    const parsed = parseSnapshotLine(line);
    return parsed && parsed.ref === childRef;
  });
  if (childIndex < 0) return null;
  const childIndent = lineIndent(lines[childIndex]);
  for (let i = childIndex - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const parsed = parseSnapshotLine(line);
    if (!parsed) continue;
    const indent = lineIndent(line);
    if (indent >= childIndent) continue;
    if (parsed.ref && roleSet.has(String(parsed.role || '').toLowerCase())) {
      return { ref: parsed.ref, role: String(parsed.role || '').toLowerCase(), name: parsed.name || '', line };
    }
  }
  return null;
}

// Known snapshot state is a deterministic actionability fact. Reject only
// tools whose requested operation cannot succeed in that state; hover remains
// valid on disabled controls, and readonly controls may still be clicked or
// focused. Unknown refs stay permissive so this guard never becomes a locator
// evidence gate.
const TOOL_ACTIONABILITY_RULES = {
  browser_click: { disabled: true, readonly: false },
  browser_type: { disabled: true, readonly: true },
  browser_fill_form: { disabled: true, readonly: true },
  browser_select_option: { disabled: true, readonly: true },
  browser_select: { disabled: true, readonly: true },
  browser_file_upload: { disabled: true, readonly: true },
  browser_check: { disabled: true, readonly: false },
  browser_uncheck: { disabled: true, readonly: false },
};

function validateActionabilityForTool(session, toolName, callArgs) {
  const rule = TOOL_ACTIONABILITY_RULES[toolName];
  if (!rule) return null;
  const map = session?.refRoleMap;
  if (!map || !(map instanceof Map) || map.size === 0) return null;

  const refs = [];
  const addRef = (ref, fieldName = null) => {
    if (typeof ref !== 'string' || !ref.trim()) return;
    if (!refs.some((item) => item.ref === ref && item.fieldName === fieldName)) refs.push({ ref, fieldName });
  };
  if (toolName === 'browser_fill_form' && Array.isArray(callArgs?.fields)) {
    for (const field of callArgs.fields) {
      if (!field || typeof field !== 'object') continue;
      addRef(field.target || field.ref, field.name || field.label || null);
    }
  } else {
    addRef(callArgs?.target || callArgs?.ref);
  }

  for (const { ref, fieldName } of refs) {
    const entry = map.get(ref);
    if (!entry) continue;
    const actionability = (rule.disabled && entry.disabled)
      ? 'disabled'
      : ((rule.readonly && entry.readonly) ? 'readonly' : null);
    if (!actionability) continue;
    const which = fieldName ? `field "${fieldName}" (target=${ref})` : `target=${ref}`;
    const errorText = [
      `Pre-dispatch validation: ${toolName} cannot act on ${which} because that ref is ${actionability}`,
      ` (role="${entry.role}"${entry.name ? `, name="${entry.name}"` : ''}).`,
      ` The current accessibility snapshot marks this control [${actionability}]; dispatching it would only wait for an actionability timeout.`,
      ` Wait for the control to become actionable or take a fresh browser_snapshot before retrying.`,
    ].join('');
    return {
      errorText,
      role: entry.role,
      name: entry.name,
      ref,
      reason: 'non_actionable_ref',
      actionability,
      suggestedTool: 'browser_snapshot',
    };
  }
  return null;
}

function retargetHoverIconToTrigger(session, callArgs) {
  const map = session?.refRoleMap;
  const snapshotText = session?.lastSnapshot || '';
  if (!map || !(map instanceof Map) || !snapshotText) return null;
  const ref = _extractRefToken(callArgs);
  if (!ref) return null;
  const entry = map.get(ref);
  const role = String(entry?.role || '').toLowerCase();
  if (!['img', 'image', 'graphics-symbol', 'graphic', 'svg'].includes(role)) return null;
  const trigger = findNearestAncestorRefByRole(snapshotText, ref, CLICKABLE_ROLES);
  if (!trigger || trigger.ref === ref) return null;
  const from = ref;
  callArgs.ref = trigger.ref;
  if (typeof callArgs.target === 'string' && /^(e\d+|ref[-_].+)$/i.test(callArgs.target.trim())) callArgs.target = trigger.ref;
  return { rewrites: [{ from, to: trigger.ref, role: trigger.role, fieldName: callArgs.element || callArgs.name || trigger.name || null }] };
}

// Container roles a generic wrapper can carry in the a11y tree — we descend
// THROUGH these to the real interactive child. Angular/React apps wrap inputs
// and buttons in role-less <div>s (role 'generic'), and the page root itself is
// a 'generic'/'document' container — a ref that lands on one of these is never
// the thing the agent meant to click/type. Phase 2: generalised to ALL action
// tools (click/hover too, not just type) and a broader container set so the
// "typed into <div id=app>" / "clicked a wrapper" faults can't recur.
const CONTAINER_RETARGET_ROLES = new Set([
  'generic', 'group', 'region', 'none', 'presentation', 'document', 'main',
  'banner', 'complementary', 'contentinfo', 'list', 'listitem', 'form', 'article', 'section',
]);
function retargetGenericWrapperForTool(session, toolName, callArgs) {
  const map = session?.refRoleMap;
  const snapshotText = session?.lastSnapshot || '';
  if (!map || !(map instanceof Map) || !snapshotText) return null;
  // The interactive role-class to descend INTO depends on the tool: type/select
  // → input roles; click/hover/drag → clickable roles. rolesForTool returns null
  // for tools with no role class (then we can't safely retarget — skip).
  const targetRoles = rolesForTool(toolName === 'browser_fill_form' ? 'browser_type' : toolName);
  if (!targetRoles || !targetRoles.size) return null;
  const retargetOne = (ref) => {
    const entry = map.get(ref);
    if (!entry) return null;
    const role = String(entry.role || '').toLowerCase();
    if (!CONTAINER_RETARGET_ROLES.has(role)) return null;
    return findUniqueChildRefByRole(snapshotText, ref, targetRoles);
  };

  if (toolName === 'browser_fill_form' && Array.isArray(callArgs?.fields)) {
    const rewrites = [];
    for (const field of callArgs.fields) {
      if (!field || typeof field.target !== 'string') continue;
      const child = retargetOne(field.target);
      if (!child) continue;
      rewrites.push({ from: field.target, to: child.ref, role: child.role, fieldName: field.name || field.label || null });
      field.target = child.ref;
    }
    return rewrites.length ? { rewrites } : null;
  }

  if (typeof callArgs?.target !== 'string') return null;
  const child = retargetOne(callArgs.target);
  if (!child) return null;
  const from = callArgs.target;
  callArgs.target = child.ref;
  if (typeof callArgs.ref === 'string') callArgs.ref = child.ref;
  return { rewrites: [{ from, to: child.ref, role: child.role, fieldName: callArgs.element || callArgs.name || null }] };
}

const ACTION_REF_TOOLS = new Set([...browserMutationTaxonomy.TARGET_CAPABLE_MUTATION_TOOLS]
  .filter((tool) => tool.startsWith('browser_')));

// Tools that may MUTATE the DOM — after any of these, the accessibility tree
// (and its [ref=eN] ids) can change as the SPA re-renders, so the snapshot we
// hold is potentially transitional. We mark the session dirty after they run so
// the NEXT ref-consuming tool settles + rebuilds the ref map before the
// stale-ref guard judges it. Only the names that actually exist in this
// @playwright/mcp build are listed (e.g. browser_fill_form not browser_fill,
// browser_drag not browser_drag_and_drop, browser_file_upload not
// browser_set_input_files). browser_evaluate / run_code are "assume dirty"
// because raw JS can mutate the DOM without producing a fresh snapshot.

// Role classes a given action can sensibly target. Used to DISAMBIGUATE a
// stale-ref self-heal when an accessible name is shared across a static and an
// interactive element (e.g. a heading "Login" AND a button "Login" on the same
// page — extremely common). A click resolves to the clickable one, a type to
// the input one. Returns null for tools where any role is plausible.
const CLICKABLE_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'combobox']);
const INPUT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);
function rolesForTool(name) {
  if (name === 'browser_type') return INPUT_ROLES;
  if (name === 'browser_select_option') return new Set(['combobox', 'listbox', 'option']);
  if (name === 'browser_check' || name === 'browser_uncheck') {
    return new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
  }
  if (name === 'browser_click' || name === 'browser_hover' || name === 'browser_drag') return CLICKABLE_ROLES;
  return null;
}

function hardenFieldBlockedProbeSource(source = '') {
  const input = String(source || '');
  const strictReadback = `const expected = clean(payload.expectedValue);
        const unchanged = String(after == null ? '' : after) === String(before == null ? '' : before);
        if (!unchanged) {
          try { setValue(node, before); } catch (e) {}
        }
        return {
          ok: unchanged,
          reason: unchanged ? 'probe_rejected_value_unchanged' : 'field_value_changed_after_probe',
          fieldLabel: best.text || payload.fieldLabel,
          before,
          after,
          probeValue: payload.probeValue,
          expectedValue: expected,
          restored: !unchanged
        };`;
  return input.replace(
    /const expected = clean\(payload\.expectedValue\);\s*const expectedStillPresent =[\s\S]*?expectedValue: expected \};/,
    strictReadback,
  );
}

async function paintHoverVisualPreview(session, expectedText, callArgs = {}) {
  if (!session?.client || !expectedText) return null;
  const wanted = String(expectedText || '').trim().slice(0, 120);
  if (!wanted) return null;
  const fn = `() => {
    const wanted = ${JSON.stringify(wanted)};
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const norm = (value) => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\\s+/g, ' ').trim();
    const want = norm(wanted);
    const hasWanted = (value) => want && norm(value).includes(want);
    const visible = (el) => {
      if (!el || !(el instanceof Element)) return false;
      const style = window.getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => clean([
      el.innerText,
      el.textContent,
      el.getAttribute && el.getAttribute('aria-label'),
      el.getAttribute && el.getAttribute('title'),
      el.getAttribute && el.getAttribute('alt')
    ].filter(Boolean).join(' '));
    const tooltipish = (el) => {
      const role = clean(el.getAttribute && el.getAttribute('role')).toLowerCase();
      const id = clean(el.id).toLowerCase();
      const cls = clean(el.className && (typeof el.className === 'string' ? el.className : el.className.baseVal)).toLowerCase();
      const placement = clean(el.getAttribute && el.getAttribute('data-popper-placement')).toLowerCase();
      const qaaiVisualAid = clean(el.getAttribute && el.getAttribute('data-qaai-visual-aid')).toLowerCase();
      return role === 'tooltip'
        || !!placement
        || /tooltip|popover|popup|overlay|tippy|floating|qaai-hover-preview/.test(id)
        || /tooltip|popover|popup|overlay|tippy|floating/.test(cls)
        || /tooltip|hover-preview/.test(qaaiVisualAid);
    };
    // A diagnostic aid from an older call must never be rediscovered as an
    // application tooltip. New calls no longer manufacture a tooltip overlay.
    const priorQaaiPreview = document.getElementById('qaai-hover-preview');
    if (priorQaaiPreview) priorQaaiPreview.remove();
    const all = Array.from(document.querySelectorAll('body *'));
    for (const el of all) {
      if (visible(el) && tooltipish(el) && hasWanted(textOf(el))) {
        return { ok: true, rendered: true, source: 'app_tooltip_visible', text: textOf(el) };
      }
    }
    const hovered = Array.from(document.querySelectorAll(':hover')).filter((el) => el instanceof Element);
    const target = hovered.length ? hovered[hovered.length - 1] : document.activeElement;
    if (!target || !(target instanceof Element) || !visible(target)) return { ok: false, rendered: false, source: 'no_hover_target' };
    const label = clean([
      target.getAttribute && target.getAttribute('aria-label'),
      target.getAttribute && target.getAttribute('title'),
      target.getAttribute && target.getAttribute('alt'),
      target.textContent
    ].filter(Boolean).join(' '));
    return {
      ok: false,
      rendered: false,
      source: hasWanted(label) ? 'hover_target_semantic_attribute' : 'app_tooltip_not_visible',
      text: hasWanted(label) ? label : ''
    };
  }`;
  try {
    const { requestOptions, cleanup } = buildMcpRequestOptions(session, 5_000);
    let result;
    try {
      result = await session.client.callTool({ name: 'browser_evaluate', arguments: { function: fn } }, undefined, requestOptions);
    } finally {
      cleanup();
    }
    const rawText = textOfContent(result?.content) || '';
    let parsed = parseEvaluateReturnValue(rawText);
    // Most playwright-mcp builds wrap evaluate values in a `Result` section,
    // while a few client/proxy combinations return the JSON value directly.
    // Direct JSON is still deterministic browser evidence, so decode that
    // exact payload as a compatibility path instead of treating it as absent.
    if (parsed === null && rawText.trim()) {
      try {
        parsed = JSON.parse(rawText.trim());
      } catch (_) {
        // Keep `null`: arbitrary prose is not visual evidence.
      }
    }
    return { ok: !result?.isError && parsed?.ok !== false, result, parsed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err).slice(0, 200) };
  }
}

async function acquireTooltipVisualObservation(session, request = {}) {
  const expectedText = String(request.expectedText || request.tooltipText || '').replace(/\s+/g, ' ').trim();
  if (!expectedText) {
    return {
      observed: false,
      text: null,
      source: null,
      available: false,
      reason: 'tooltip_expected_text_missing',
    };
  }
  const preview = await paintHoverVisualPreview(session, expectedText, request.callArgs || request);
  const parsed = preview?.parsed || null;
  const observed = preview?.ok === true
    && parsed?.ok === true
    && parsed?.rendered === true
    && parsed?.source === 'app_tooltip_visible';
  return {
    observed,
    text: observed ? cleanTooltipEvidenceText(parsed?.text) : null,
    source: parsed?.source || null,
    available: !!preview,
    reason: observed ? null : parsed?.source || (preview?.error ? 'tooltip_visual_observation_failed' : 'tooltip_visual_not_observed'),
    details: parsed && typeof parsed === 'object' ? { ...parsed } : null,
  };
}

// Pull the snapshot ref token an action tool would act on (post-normalisation:
// resolved refs land in callArgs.ref; a bare "eNN" may remain in callArgs.target).
function _extractRefToken(callArgs) {
  if (typeof callArgs?.ref === 'string' && callArgs.ref.trim()) return callArgs.ref.trim();
  if (typeof callArgs?.target === 'string') {
    const t = callArgs.target.trim();
    if (/^(e\d+|ref[-_].+)$/i.test(t)) return t;
  }
  return null;
}

// Find the ONE ref in the current snapshot whose accessible name matches the
// agent's human-readable `element` description. Returns null unless exactly
// one element matches — we self-heal only when unambiguous, never guess.
function _resolveByDescription(session, description, allowedRoles = null) {
  const map = session?.refRoleMap;
  if (!map || !(map instanceof Map) || !map.size || !description) return null;
  const cleaned = String(description).toLowerCase()
    .replace(/\b(the|a|an|button|link|menuitem|menu item|icon|field|input|tab|option|checkbox|element|dropdown|toggle|label)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 2) return null;
  const matches = [];
  for (const [ref, entry] of map) {
    const n = (entry?.name || '').toLowerCase().trim();
    if (!n || n.length < 2) continue;
    if (n === cleaned || cleaned.includes(n) || n.includes(cleaned)) matches.push({ ref, role: (entry?.role || '').toLowerCase() });
  }
  // Unambiguous by name alone — heal (unchanged behaviour).
  if (matches.length === 1) return matches[0].ref;
  // Ambiguous by name (e.g. heading "Login" + button "Login"): disambiguate by
  // the action's target role-class. This recovers the common SPA case where a
  // page label shares text with the control — without it the guard rejected and
  // the agent looped on the dead ref. Purely additive: only resolves the >1 case.
  if (matches.length > 1 && allowedRoles) {
    const byRole = matches.filter((m) => allowedRoles.has(m.role));
    if (byRole.length === 1) return byRole[0].ref;
  }
  return null;
}

// Returns null (dispatch as-is) | { heal } (substitute a fresh ref by name) |
// { reject, errorText } (stale ref, no confident match — make the agent re-snapshot).
function guardActionRef(session, name, callArgs) {
  if (!ACTION_REF_TOOLS.has(name)) return null;
  const map = session?.refRoleMap;
  if (!map || !(map instanceof Map) || map.size < 3) return null; // map too thin to judge — permissive
  const ref = _extractRefToken(callArgs);
  if (!ref) return null;        // name/CSS target — MCP resolves against the live DOM itself
  if (map.has(ref)) return null; // ref is in the current snapshot — fine
  const healed = _resolveByDescription(session, callArgs?.element, rolesForTool(name));
  if (healed) return { heal: healed, staleRef: ref };
  return {
    reject: true, staleRef: ref,
    errorText: `[ref=${ref}] is not in the current page snapshot — the DOM changed since you saw that ref (a menu/dialog opened, or the page navigated, and Playwright re-issues refs on each snapshot). Call browser_snapshot, then target the element by its CURRENT [ref] or by ROLE + accessible NAME. Do NOT reuse a ref from a previous snapshot.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// resolveActionRefByDescription — deterministic role-aware ref resolution.
//
// When the model issues an element-targeting tool (browser_click / browser_type
// / browser_select_option) with only a human-readable `element` label and NO
// ref/target, the strict locator-evidence gate would block dispatch — which in
// practice pushed the model to coordinate-click a NEARBY WRONG element (the
// "tried 3-4 times, clicked something else" failure). This resolves the SINGLE
// element in the current snapshot whose accessible name (or placeholder)
// matches the label AND whose role is compatible with the tool, so the
// conductor can inject the correct ref and dispatch on the RIGHT element.
//
// Unambiguous-only: returns null on 0 or >1 plausible candidates — we never
// guess (a wrong-but-confident ref is worse than letting the strict gate ask
// for a snapshot). Role-constrained so a click that needs a button/link/combobox
// never resolves to a static heading/text that merely shares the name. Fully
// generic — keyed off role + accessible name, never a site-specific string.
// ─────────────────────────────────────────────────────────────────────────
function resolveActionRefByDescription(snapshotText, description, toolName) {
  if (!snapshotText || typeof snapshotText !== 'string' || !description) return null;
  const allowed = rolesForTool(toolName); // null → tool has no role constraint (any role plausible)
  const cleaned = String(description).toLowerCase()
    .replace(/\b(the|a|an|button|link|menuitem|menu item|icon|field|input|tab|option|checkbox|element|dropdown|drop down|toggle|label|combobox|select|box)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length < 2) return null;
  const candidates = [];
  for (const line of snapshotText.split(/\r?\n/)) {
    const p = parseSnapshotLine(line);
    if (!p || !p.ref) continue;
    const role = String(p.role || '').toLowerCase();
    const hay = `${String(p.name || '').toLowerCase().trim()} ${String(p.placeholder || '').toLowerCase().trim()}`.trim();
    if (!hay || hay.length < 2) continue;
    const exact = hay === cleaned;
    const partial = hay.includes(cleaned) || cleaned.includes(hay);
    if (!exact && !partial) continue;
    candidates.push({ ref: p.ref, role, exact });
  }
  if (!candidates.length) return null;
  // Constrain to the tool's role class when it has one — so a click that needs a
  // button/link/combobox never resolves to a static heading/text/img that merely
  // shares the accessible name (the classic wrong-element pick the user reported).
  let pool = candidates;
  if (allowed && allowed.size) {
    // Role-constrained tool (click/type/select/hover/drag): keep ONLY
    // role-compatible candidates and, if NONE match, return null. Do NOT fall
    // back to a static heading/text/img that merely shares the accessible name —
    // that fallback was the residual wrong-nearby-click path (B-2c.0). A null
    // here lets the strict locator-evidence gate ask for a real ref instead of
    // dispatching on the wrong element.
    pool = candidates.filter((c) => allowed.has(c.role));
    if (!pool.length) return null;
  }
  // Prefer an exact name match; if several elements match exactly, it is
  // genuinely ambiguous (e.g. two identical "-- Select --" triggers) → don't guess.
  const exactMatches = pool.filter((c) => c.exact);
  if (exactMatches.length === 1) return exactMatches[0].ref;
  if (exactMatches.length > 1) return null;
  return pool.length === 1 ? pool[0].ref : null;
}

const downloadWatcher = require('./downloadWatcher');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', 'playwright', 'test-results', 'live');
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return /^(1|true|yes|on)$/i.test(String(raw));
}

// #32 — browser-topology portability.
//
// The crawl/run historically baked in NON-PORTABLE choices: a headed browser
// (no display on a CI/server box), --no-sandbox, and TLS-verification DISABLED by
// default (NODE_TLS_REJECT_UNAUTHORIZED='0' for corp-proxy MITM). Those are right
// for the local corp laptop the validated lane runs on, but on a portable host
// they either fail to launch or silently weaken security. We keep the local
// defaults intact (so the validated lane is unchanged) but make every
// non-portable choice EXPLICIT and gated by a named env flag, and we emit an
// honest signal describing the posture so a non-portable boot is never silent.
//
// resolveTlsRejectUnauthorized: returns the NODE_TLS_REJECT_UNAUTHORIZED value the
// subprocess should inherit. Precedence: an explicit env value always wins; then
// QAAI_MCP_TLS_STRICT='1' opts into secure verification ('1'); otherwise the
// historical permissive default ('0') is preserved so the corp-proxy lane keeps
// working. Returning the resolved value (not mutating the default inline) lets the
// caller report which posture is active.
function resolveTlsRejectUnauthorized() {
  const explicit = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (explicit != null && explicit !== '') return String(explicit);
  if (envFlag('QAAI_MCP_TLS_STRICT')) return '1';
  return '0';
}

// Compute the topology posture for a boot and emit a single honest signal when it
// is non-portable. Pure-reporting — never changes launch behaviour. `collector`
// (optional array) lets a caller (e.g. the calibrator) capture the record for the
// UI; `onLog` mirrors it to the session log.
function reportBrowserTopologyPosture({ onLog, collector, headless, noSandbox, tlsRejectUnauthorized } = {}) {
  const reasons = [];
  if (headless === false) reasons.push('headed browser (requires a display — will fail on a headless CI/server host)');
  if (noSandbox) reasons.push('--no-sandbox (Chromium sandbox disabled)');
  if (String(tlsRejectUnauthorized) === '0') reasons.push('TLS certificate verification DISABLED (NODE_TLS_REJECT_UNAUTHORIZED=0)');
  if (!reasons.length) return null;        // fully portable posture — nothing to signal
  return recordDegradation({
    onLog,
    collector,
    stage: 'browser-topology',
    reason: `browser launched in a non-portable mode: ${reasons.join('; ')}`,
    impact: 'crawl/run may not reproduce on a different host (no display, sandbox/TLS posture differs); set QAAI_MCP_HEADLESS=1 / drop --no-sandbox / QAAI_MCP_TLS_STRICT=1 for a portable boot',
    severity: 'info',
  });
}

function parseProjectJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function loadPlaywrightForLiveCdp() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      return require('@playwright/test');
    } catch (err) {
      const e = new Error(`Playwright not installed for live CDP screencast: ${err.message}`);
      e.code = 'PLAYWRIGHT_LIVE_CDP_MISSING';
      throw e;
    }
  }
}

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error('Could not reserve a local CDP port'));
      });
    });
  });
}

function waitForHttpOk(url, timeoutMs = 8000) {
  const deadline = Date.now() + Math.max(500, timeoutMs);
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, { timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true);
        } else if (Date.now() >= deadline) {
          reject(new Error(`CDP endpoint did not become ready (${res.statusCode || 'no status'})`));
        } else {
          setTimeout(attempt, 150);
        }
      });
      req.on('timeout', () => {
        req.destroy();
      });
      req.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('CDP endpoint did not become ready'));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

async function bestEffortWithin(label, fn, timeoutMs = 2000) {
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => setTimeout(resolve, Math.max(100, timeoutMs))),
    ]);
  } catch (_) {
    // Best-effort shutdown/cleanup path.
  }
}

function contextCliArgsForMcp({ cliArgs = [], usingLiveCdp = false } = {}) {
  if (!usingLiveCdp) return cliArgs;
  const out = [];
  const singleValueFlags = new Set([
    '--device',
    '--user-agent',
    '--proxy-server',
    '--proxy-bypass',
    '--output-dir',
    '--init-script',
  ]);
  const noValueFlags = new Set(['--ignore-https-errors']);
  for (let i = 0; i < cliArgs.length; i += 1) {
    const arg = cliArgs[i];
    if (singleValueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (noValueFlags.has(arg)) continue;
    if (arg === '--grant-permissions') {
      while (i + 1 < cliArgs.length && !String(cliArgs[i + 1]).startsWith('--')) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

async function launchLiveCdpBrowser({ sessionId, viewport, userDataDir, project, contextExtras, broadcast } = {}) {
  if (envFlag('QAAI_LIVE_CDP_DISABLED') || envFlag('QAAI_CDP_LIVE_DISABLED')) return null;
  const pw = loadPlaywrightForLiveCdp();
  const gatewayBootstrapSession = { id: sessionId };
  if (!pw?.chromium?.launchPersistentContext) {
    throw new Error('Playwright chromium.launchPersistentContext is unavailable');
  }

  const port = await reserveLocalPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const profileDir = userDataDir || path.join(os.tmpdir(), 'qaai-live-cdp', sessionId, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const launchArgs = [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    '--new-window',
    '--no-default-browser-check',
    '--no-first-run',
    '--disable-sync',
    '--disable-extensions',
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
  ];

  let headlessFromConfig = null;
  if (typeof project?.contextHeadless === 'boolean') {
    headlessFromConfig = project.contextHeadless;
  } else if (project?.triggerConfigJson) {
    try {
      const parsed = JSON.parse(project.triggerConfigJson);
      if (typeof parsed?.contextHeadless === 'boolean') headlessFromConfig = parsed.contextHeadless;
    } catch (_) {}
  }
  const headless = typeof headlessFromConfig === 'boolean'
    ? headlessFromConfig
    : (envFlag('QAAI_MCP_HEADLESS') || envFlag('PLAYWRIGHT_MCP_HEADLESS') || false);

  if (headless === false) {
    launchArgs.push('--start-maximized', '--window-position=0,0', '--window-size=1400,900');
  }

  const launchOptions = {
    headless,
    channel: undefined,
    viewport: headless === false ? null : (viewport || { width: 1280, height: 720 }),
    acceptDownloads: true,
    downloadsPath: contextExtras?.downloadsDir || undefined,
    ignoreHTTPSErrors: project?.contextIgnoreHttpsErrors === true,
    args: launchArgs,
  };
  if (project?.contextDevice && pw.devices?.[project.contextDevice]) {
    Object.assign(launchOptions, pw.devices[project.contextDevice]);
    launchOptions.args = launchArgs;
    launchOptions.acceptDownloads = true;
    launchOptions.downloadsPath = contextExtras?.downloadsDir || undefined;
    launchOptions.ignoreHTTPSErrors = project?.contextIgnoreHttpsErrors === true;
  }
  if (project?.contextUserAgent) launchOptions.userAgent = project.contextUserAgent;
  if (project?.contextLocale) launchOptions.locale = project.contextLocale;
  if (project?.contextColorScheme) launchOptions.colorScheme = project.contextColorScheme;
  if (project?.contextProxyServer) {
    launchOptions.proxy = { server: project.contextProxyServer };
    if (project.contextProxyBypass) launchOptions.proxy.bypass = project.contextProxyBypass;
  }
  const geo = parseProjectJson(project?.contextGeolocation, null);
  if (geo && typeof geo.latitude === 'number' && typeof geo.longitude === 'number') {
    launchOptions.geolocation = {
      latitude: geo.latitude,
      longitude: geo.longitude,
      accuracy: typeof geo.accuracy === 'number' ? geo.accuracy : 50,
    };
  }

  const context = await pw.chromium.launchPersistentContext(profileDir, launchOptions);
  if (contextExtras?.initScriptPath) {
    try { await context.addInitScript({ path: contextExtras.initScriptPath }); } catch (_) {}
  }
  const permissions = parseProjectJson(project?.contextPermissions, null);
  if (Array.isArray(permissions) && permissions.length) {
    try { await context.grantPermissions(permissions.filter((p) => typeof p === 'string')); } catch (_) {}
  }
  if (!context.pages().length) {
    try {
      await require('./actionExecutionGateway').dispatchBrowserMutation({
        session: gatewayBootstrapSession,
        mutationName: 'playwright_context_new_page',
        args: { reason: 'live_cdp_bootstrap' },
        actionOccurrenceId: `infrastructure:${sessionId}:live-cdp-new-page:1`,
        source: 'live_cdp_bootstrap',
        dispatch: () => context.newPage(),
      });
    } catch (_) {}
  }
  if (headless === false) {
    try {
      const initPage = context.pages()[0] || await context.newPage();
      if (initPage) await initPage.bringToFront().catch(() => {});
    } catch (_) {}
  }
  await waitForHttpOk(`${endpoint}/json/version`, 8000);
  let monitorBrowser = null;
  try {
    monitorBrowser = await pw.chromium.connectOverCDP(endpoint, { timeout: 5000 });
  } catch (err) {
    try {
      broadcast?.({
        type: 'agent.phase.log',
        phase: 'conductor',
        level: 'warn',
        message: `[mcp] live CDP monitor attach failed (${err.message}); screencast will use owner context only`,
      });
    } catch (_) {}
  }
  try {
    broadcast?.({
      type: 'agent.phase.log',
      phase: 'conductor',
      level: 'info',
      message: `[mcp] live CDP browser ready on ${endpoint}`,
    });
  } catch (_) {}
  return {
    context,
    monitorBrowser,
    endpoint,
    profileDir,
    port,
    gatewayBootstrapTrail: Array.isArray(gatewayBootstrapSession.actionExecutionGatewayTrail)
      ? gatewayBootstrapSession.actionExecutionGatewayTrail
      : [],
  };
}

// Force-kill the Chrome process tree that owns a known remote-debugging port.
// The live-CDP browser is launched via chromium.launchPersistentContext with a
// unique `--remote-debugging-port=<port>` (and a unique per-session user-data-dir),
// so the listener on 127.0.0.1:<port> is exactly THIS session's Chrome — never the
// operator's own browser. context.close() SHOULD terminate it, but on Windows a
// launchPersistentContext Chrome frequently survives the close (detached child
// processes), which is what leaked ~dozens of orphan Chromes across runs and
// eventually starved new session starts (session_start_failed). This mirrors the
// taskkill /T fallback stopMcpSession already does for the MCP node subprocess.
function killBrowserTreeOnPort(port) {
  if (!port) return;
  try {
    const cp = require('child_process');
    if (process.platform === 'win32') {
      const out = cp.spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 4000 }).stdout || '';
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        // cols: [TCP, <local>, <foreign>, <STATE>, <PID>]
        if (cols.length >= 5 && cols[0] === 'TCP' && cols[1] === `127.0.0.1:${port}`) {
          const pid = cols[cols.length - 1];
          if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid);
        }
      }
      for (const pid of pids) {
        cp.spawnSync('taskkill', ['/T', '/F', '/PID', pid], { timeout: 5000 });
      }
    } else {
      const out = cp.spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 4000 }).stdout || '';
      for (const pid of out.split(/\s+/).filter((s) => /^\d+$/.test(s))) {
        try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
      }
    }
  } catch (_) { /* best-effort reaper — never throws */ }
}

async function closeLiveCdpBrowser(liveCdp) {
  if (!liveCdp) return;
  await bestEffortWithin('live_cdp_context_close', () => liveCdp.context?.close?.(), 2500);
  if (typeof liveCdp.monitorBrowser?.disconnect === 'function') {
    await bestEffortWithin('live_cdp_monitor_disconnect', () => liveCdp.monitorBrowser.disconnect(), 1000);
  }
  // Belt-and-braces: if context.close() didn't terminate the persistent-context
  // Chrome (timed out / detached on Windows), force-kill its tree by the unique
  // remote-debugging port so it cannot accumulate and starve later sessions.
  killBrowserTreeOnPort(liveCdp.port);
}

function screencastOptionsFor(viewport) {
  const quality = Math.max(25, Math.min(90, Number(process.env.QAAI_LIVE_CDP_JPEG_QUALITY) || 60));
  const everyNthFrame = Math.max(1, Math.min(10, Number(process.env.QAAI_LIVE_CDP_EVERY_NTH_FRAME) || 1));
  const maxWidth = Math.max(320, Math.min(1920, Number(process.env.QAAI_LIVE_CDP_MAX_WIDTH) || Number(viewport?.width) || 1280));
  const maxHeight = Math.max(240, Math.min(1080, Number(process.env.QAAI_LIVE_CDP_MAX_HEIGHT) || Number(viewport?.height) || 720));
  return { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame };
}

const AUTHORITATIVE_CDP_MARKER_ATTRIBUTE = 'data-qaai-cdp-action-target';
const AUTHORITATIVE_CANDIDATE_MARKER_PREFIX = 'data-qaai-cdp-candidate-';
const CAPTURE_BINDING_HISTORY_LIMIT = 512;
const AUTHORITATIVE_SESSION_PAGES = new WeakMap();
const AUTHORITATIVE_CLOSED_PAGE_IDS = new WeakMap();
const AUTHORITATIVE_PAGE_CLOSE_LISTENERS = new WeakSet();
const AUTHORITATIVE_CLOSED_PAGE_HISTORY_LIMIT = 128;

function actionBindingIdentity(input = {}) {
  const source = input.actionIdentity && typeof input.actionIdentity === 'object'
    ? { ...input, ...input.actionIdentity }
    : input;
  const out = {};
  for (const field of [
    'schemaVersion',
    'caseId',
    'contractStepId',
    'sourceContractStepId',
    'authoredStepId',
    'authoredActionId',
    'actionOccurrenceId',
    'sourceActionOccurrenceId',
    'occurrenceKey',
    'sequence',
    'sequenceIndex',
    'occurrenceOrdinal',
    'toolUseId',
    'toolName',
    'operation',
  ]) {
    const value = source?.[field];
    if (value !== undefined && value !== null && value !== '') out[field] = value;
  }
  return out;
}

function actionEvidenceIdentity(_args = {}, options = {}) {
  const callOptions = options && typeof options === 'object' ? options : {};
  return actionBindingIdentity({
    ...callOptions,
    actionIdentity: callOptions.actionIdentity || null,
  });
}

function appendCaptureBindingHistory(session, field, entry) {
  const descriptor = session?.captureRuntime;
  if (!descriptor || !entry) return entry || null;
  const current = Array.isArray(descriptor[field]) ? descriptor[field] : [];
  descriptor[field] = [...current, entry].slice(-CAPTURE_BINDING_HISTORY_LIMIT);
  return entry;
}

function captureBindingAttempt(session, request = {}, details = {}) {
  const capturedAt = details.capturedAt || new Date().toISOString();
  const entry = {
    kind: 'mcp_bound_ref',
    sessionId: session?.id || session?.captureRuntime?.sessionId || null,
    phase: request.phase || 'pre_action',
    ref: request.ref ? String(request.ref) : null,
    pageId: details.pageId || null,
    backendNodeId: Number(details.backendNodeId) || null,
    capturedAt,
    status: details.status || (Number(details.backendNodeId) > 0 ? 'bound' : 'not_bound'),
    reason: details.reason || null,
    pageUrl: details.pageUrl || request.pageUrl || null,
    ...actionBindingIdentity(request),
  };
  appendCaptureBindingHistory(session, 'bindingAttempts', entry);
  if (entry.status === 'bound' && entry.pageId && entry.backendNodeId) {
    appendCaptureBindingHistory(session, 'runBindings', entry);
    if (session?.captureRuntime) {
      session.captureRuntime.lastBindingAt = capturedAt;
      session.captureRuntime.lastBindingPageId = entry.pageId;
      session.captureRuntime.lastBindingBackendNodeId = entry.backendNodeId;
    }
  }
  return entry;
}

function pagesFromPlaywrightContext(context) {
  try { return Array.isArray(context?.pages?.()) ? context.pages() : []; }
  catch (_) { return []; }
}

function authoritativePageRegistry(session, create = false) {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return null;
  let registry = AUTHORITATIVE_SESSION_PAGES.get(session) || null;
  if (!registry && create) {
    registry = new Map();
    AUTHORITATIVE_SESSION_PAGES.set(session, registry);
  }
  return registry;
}

function authoritativeClosedPageRegistry(session, create = false) {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return null;
  let registry = AUTHORITATIVE_CLOSED_PAGE_IDS.get(session) || null;
  if (!registry && create) {
    registry = new Map();
    AUTHORITATIVE_CLOSED_PAGE_IDS.set(session, registry);
  }
  return registry;
}

function rememberClosedAuthoritativePage(session, pageId) {
  if (!pageId) return;
  const closed = authoritativeClosedPageRegistry(session, true);
  closed.delete(pageId);
  closed.set(pageId, Date.now());
  while (closed.size > AUTHORITATIVE_CLOSED_PAGE_HISTORY_LIMIT) {
    closed.delete(closed.keys().next().value);
  }
}

async function requiredWithin(label, fn, timeoutMs = 5000) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms.`)), Math.max(100, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pruneClosedAuthoritativePages(session) {
  const registry = authoritativePageRegistry(session);
  if (!registry) return;
  for (const [pageId, page] of registry.entries()) {
    let isClosed = true;
    try { isClosed = page?.isClosed?.() === true; } catch (_) { isClosed = true; }
    if (!isClosed) continue;
    registry.delete(pageId);
    rememberClosedAuthoritativePage(session, pageId);
  }
}

function rememberAuthoritativePage(session, page) {
  const pageId = transitionPageId(page);
  if (!pageId) return null;
  pruneClosedAuthoritativePages(session);
  let isClosed = true;
  try { isClosed = page?.isClosed?.() === true; } catch (_) { isClosed = true; }
  if (isClosed) {
    rememberClosedAuthoritativePage(session, pageId);
    return pageId;
  }
  const registry = authoritativePageRegistry(session, true);
  authoritativeClosedPageRegistry(session)?.delete(pageId);
  registry.set(pageId, page);
  if (typeof page?.once === 'function' && !AUTHORITATIVE_PAGE_CLOSE_LISTENERS.has(page)) {
    AUTHORITATIVE_PAGE_CLOSE_LISTENERS.add(page);
    page.once('close', () => {
      authoritativePageRegistry(session)?.delete(pageId);
      rememberClosedAuthoritativePage(session, pageId);
    });
  }
  return pageId;
}

async function cdpTargetIdForPage(page) {
  let cdp = null;
  try {
    const context = page?.context?.();
    if (!context || typeof context.newCDPSession !== 'function') return null;
    cdp = await context.newCDPSession(page);
    const response = await cdp.send('Target.getTargetInfo');
    return String(response?.targetInfo?.targetId || '').trim() || null;
  } catch (_) {
    return null;
  } finally {
    try { await cdp?.detach?.(); } catch (_) {}
  }
}

async function authoritativePageIdentity(session, page, { popupIdentity = null } = {}) {
  if (!page) return null;
  const pageId = rememberAuthoritativePage(session, page);
  let opener = null;
  if (typeof page.opener === 'function') {
    try { opener = await page.opener(); } catch (_) { opener = null; }
  }
  const openerPageId = opener ? rememberAuthoritativePage(session, opener) : null;
  let closed = false;
  try { closed = page.isClosed() === true; } catch (_) { closed = true; }
  return {
    pageId,
    url: (() => { try { return page.url(); } catch (_) { return null; } })(),
    targetId: closed ? null : await cdpTargetIdForPage(page),
    isPopup: !!opener,
    openerPageId,
    popupIdentity: popupIdentity || null,
  };
}

function exactAuthoritativePageForIdentity(session, pageIdentity = {}) {
  const pageId = String(pageIdentity?.pageId || '').trim();
  if (!pageId) return { page: null, reason: 'page_identity_missing' };
  pruneClosedAuthoritativePages(session);
  if (authoritativeClosedPageRegistry(session)?.has(pageId)) {
    return { page: null, reason: 'page_closed', pageId };
  }
  const remembered = authoritativePageRegistry(session)?.get(pageId) || null;
  if (remembered) {
    try {
      if (remembered.isClosed()) return { page: null, reason: 'page_closed', pageId };
    } catch (_) {
      return { page: null, reason: 'page_closed', pageId };
    }
    return { page: remembered, reason: null, pageId };
  }
  const exact = livePlaywrightPagesForSession(session)
    .filter((page) => transitionPageId(page) === pageId);
  if (exact.length === 1) {
    rememberAuthoritativePage(session, exact[0]);
    return { page: exact[0], reason: null, pageId };
  }
  return { page: null, reason: exact.length > 1 ? 'page_identity_ambiguous' : 'page_not_found', pageId };
}

function authoritativePageRegistryStats(session) {
  pruneClosedAuthoritativePages(session);
  return {
    livePages: authoritativePageRegistry(session)?.size || 0,
    closedPageIds: authoritativeClosedPageRegistry(session)?.size || 0,
  };
}

function livePlaywrightPagesForSession(session) {
  const pages = [];
  const seen = new Set();
  const add = (page) => {
    if (!page || seen.has(page)) return;
    try { if (page.isClosed()) return; } catch (_) { return; }
    seen.add(page);
    pages.push(page);
  };
  // The owner persistent context and connectOverCDP monitor expose distinct
  // Playwright Page wrapper objects for the same Chromium target. Scanning
  // both made one marked node appear twice and every action capture failed as
  // candidate_marker_ambiguous. The owner context is the browser launched for
  // this MCP session and is therefore authoritative. Monitor/screencast pages
  // are used only when owner pages are temporarily unavailable.
  const ownerPages = pagesFromPlaywrightContext(session?.liveCdp?.context);
  if (ownerPages.length) {
    ownerPages.forEach(add);
    return pages;
  }
  try {
    for (const context of session?.liveCdp?.monitorBrowser?.contexts?.() || []) {
      for (const page of pagesFromPlaywrightContext(context)) add(page);
    }
  } catch (_) {}
  if (!pages.length) add(session?.cdpScreencast?.page);
  return pages;
}

function livePlaywrightPageForSession(session, preferredUrl = null) {
  const preferred = String(preferredUrl || session?.currentUrl || '').trim();
  const pages = livePlaywrightPagesForSession(session);
  if (!pages.length) return null;
  if (preferred) {
    const exact = pages.filter((page) => {
      try { return page.url() === preferred; } catch (_) { return false; }
    });
    if (exact.length === 1) return exact[0];
  }
  const usable = pages.filter((page) => {
    try { return page.url() && page.url() !== 'about:blank'; } catch (_) { return false; }
  });
  return (usable.length ? usable : pages).at(-1) || null;
}

function gatewayInfrastructureOccurrence(session, kind) {
  if (!session || typeof session !== 'object') return `infrastructure:session:${kind || 'mutation'}:1`;
  session.actionExecutionInfrastructureSequence = (Number(session.actionExecutionInfrastructureSequence) || 0) + 1;
  return `infrastructure:${session.id || 'session'}:${kind || 'mutation'}:${session.actionExecutionInfrastructureSequence}`;
}

async function captureInPageBrowserEvents(session, {
  mode = 'drain',
  maxEvents = inPageEventRecorder.DEFAULT_MAX_EVENTS,
  timeoutMs = 1_500,
} = {}) {
  const pages = livePlaywrightPagesForSession(session);
  const frames = pages.flatMap((page) => {
    try {
      return page.frames().map((frame) => ({ page, frame }));
    } catch (_) {
      return [];
    }
  }).slice(0, 32);
  const expression = mode === 'peek'
    ? inPageEventRecorder.peekExpression()
    : inPageEventRecorder.drainExpression();
  const installSource = inPageEventRecorder.installExpression({ maxEvents });
  const settled = await Promise.allSettled(frames.map(async ({ page, frame }, frameIndex) => {
    await requiredWithin(
      'in-page event recorder install',
      () => require('./actionExecutionGateway').dispatchBrowserMutation({
        session,
        mutationName: 'playwright_frame_install_event_recorder',
        args: { frameIndex, mode, maxEvents },
        actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'event-recorder-install'),
        source: 'browser_evidence_event_recorder',
        dispatch: () => frame.evaluate(installSource),
      }),
      timeoutMs,
    );
    const events = await requiredWithin(
      `in-page event recorder ${mode}`,
      () => frame.evaluate(expression),
      timeoutMs,
    );
    return {
      pageUrl: (() => { try { return page.url(); } catch (_) { return null; } })(),
      frameUrl: (() => { try { return frame.url(); } catch (_) { return null; } })(),
      events: Array.isArray(events) ? events : [],
    };
  }));
  const events = [];
  let recorderFrameCount = 0;
  let captureErrorCount = 0;
  for (const result of settled) {
    if (result.status !== 'fulfilled') {
      captureErrorCount += 1;
      continue;
    }
    recorderFrameCount += 1;
    events.push(...result.value.events);
  }
  events.sort((left, right) => {
    const atDelta = Number(left?.at || 0) - Number(right?.at || 0);
    return atDelta || Number(left?.sequence || 0) - Number(right?.sequence || 0);
  });
  return {
    events: events.slice(-Math.max(1, Math.min(1_000, Number(maxEvents) || inPageEventRecorder.DEFAULT_MAX_EVENTS))),
    pageCount: pages.length,
    frameCount: frames.length,
    recorderFrameCount,
    captureErrorCount,
    mode: mode === 'peek' ? 'peek' : 'drain',
  };
}

async function captureLiveEvidenceScreenshot(session, {
  label = 'browser-evidence',
  timeoutMs = 2_000,
  persist = true,
} = {}) {
  const page = livePlaywrightPageForSession(session);
  if (!page || typeof page.screenshot !== 'function') return null;
  const image = await requiredWithin(
    'browser evidence screenshot',
    () => page.screenshot({
      type: 'jpeg',
      quality: 65,
      animations: 'disabled',
      caret: 'hide',
      timeout: Math.max(250, Number(timeoutMs) || 2_000),
    }),
    timeoutMs,
  );
  if (!Buffer.isBuffer(image) || image.length === 0) return null;
  const viewport = (() => {
    try { return page.viewportSize?.() || null; } catch (_) { return null; }
  })();
  const imgBlock = { data: image.toString('base64'), mediaType: 'image/jpeg' };
  return {
    artifactRef: persist ? saveScreenshotToDisk(imgBlock, label) : null,
    sha256: crypto.createHash('sha256').update(image).digest('hex'),
    width: Number(viewport?.width) || null,
    height: Number(viewport?.height) || null,
    capturedAt: Date.now(),
    redacted: false,
    bytes: image.length,
  };
}

function markerSelector(markerAttribute, markerValue) {
  const attribute = String(markerAttribute || '').replace(/[^a-zA-Z0-9_:-]/g, '');
  return attribute ? `[${attribute}=${JSON.stringify(String(markerValue || ''))}]` : null;
}

async function findUniqueMarkedTarget(session, markerAttribute, markerValue) {
  const selector = markerSelector(markerAttribute, markerValue);
  if (!selector) return { ok: false, reason: 'candidate_marker_invalid', matchCount: 0 };
  const matches = [];
  const pages = livePlaywrightPagesForSession(session);
  let inspectablePageCount = 0;
  for (const page of pages) {
    let frames = [];
    try {
      if (typeof page.frames !== 'function') continue;
      frames = page.frames();
      inspectablePageCount += 1;
    } catch (_) { continue; }
    for (const frame of frames) {
      try {
        const locator = frame.locator(selector);
        const count = await locator.count();
        if (count === 1) matches.push({ page, frame, locator });
        else if (count > 1) return { ok: false, reason: 'candidate_marker_ambiguous', matchCount: count };
      } catch (_) {}
    }
  }
  if (!inspectablePageCount && pages.length === 1) {
    return { ok: true, page: pages[0], frame: pages[0], locator: null, matchCount: null, locatorScanUnavailable: true };
  }
  return matches.length === 1
    ? { ok: true, ...matches[0], matchCount: 1 }
    : { ok: false, reason: matches.length ? 'candidate_marker_ambiguous' : 'candidate_marker_not_found', matchCount: matches.length };
}

async function findUniqueCdpMarkedTarget(session, markerAttribute, markerValue, phase = 'pre_action') {
  const matches = [];
  const gaps = [];
  for (const page of livePlaywrightPagesForSession(session)) {
    const capture = await authoritativeCdpCapture.captureMarkedTarget({
      page,
      markerAttribute,
      markerValue,
      phase,
    });
    if (capture?.captured === true && Number(capture?.identity?.backendNodeId) > 0) {
      matches.push({ page, capture });
      continue;
    }
    if (capture?.reason === 'marker_ambiguous') {
      return {
        ok: false,
        reason: 'candidate_marker_ambiguous',
        matchCount: Number(capture.matchCount) || 2,
        gaps,
      };
    }
    if (capture?.reason && capture.reason !== 'marker_not_found') {
      gaps.push({ pageId: transitionPageId(page), reason: capture.reason });
    }
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      reason: matches.length > 1
        ? 'candidate_marker_ambiguous'
        : gaps.length
          ? 'candidate_marker_cdp_probe_incomplete'
          : 'candidate_marker_not_found',
      matchCount: matches.length,
      gaps,
    };
  }
  if (gaps.length) {
    return {
      ok: false,
      reason: 'candidate_marker_cdp_probe_incomplete',
      matchCount: 1,
      gaps,
    };
  }
  return {
    ok: true,
    page: matches[0].page,
    frame: null,
    locator: null,
    authoritativeCapture: matches[0].capture,
    matchCount: 1,
    locatorScanUnavailable: true,
    resolutionMode: 'authoritative_cdp_marker_page_probe',
  };
}

function frameOwnerSelector(frameOwner = {}) {
  const attributes = frameOwner.attributes && typeof frameOwner.attributes === 'object' ? frameOwner.attributes : {};
  for (const attribute of ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw']) {
    if (attributes[attribute]) return `[${attribute}=${JSON.stringify(String(attributes[attribute]))}]`;
  }
  for (const attribute of ['id', 'name', 'title', 'src']) {
    const value = String(attributes[attribute] || '').trim();
    if (!value) continue;
    const selector = attribute === 'id' ? `#${value}` : `[${attribute}=${JSON.stringify(value)}]`;
    if (!locatorCaptureAnalysis.isGeneratedOrUnstableSelector(selector)) return selector;
  }
  return null;
}

function framePathSelectors(capture = {}) {
  return (Array.isArray(capture.framePath) ? capture.framePath : []).map(frameOwnerSelector).filter(Boolean);
}

function authoritativeDescriptorLocator(scope, descriptor = {}) {
  if (!scope || !descriptor?.strategy) return null;
  const exact = descriptor.exact !== false;
  let locator = null;
  let expression = null;
  if (descriptor.strategy === 'testid') {
    if (descriptor.attribute === 'data-testid' && typeof scope.getByTestId === 'function') {
      locator = scope.getByTestId(descriptor.value);
      expression = `getByTestId(${JSON.stringify(descriptor.value)})`;
    } else {
      const selector = markerSelector(descriptor.attribute, descriptor.value);
      locator = selector ? scope.locator(selector) : null;
      expression = selector ? `locator(${JSON.stringify(selector)})` : null;
    }
  } else if (descriptor.strategy === 'role') {
    locator = scope.getByRole(descriptor.role, { name: descriptor.name, exact });
    expression = `getByRole(${JSON.stringify(descriptor.role)}, { name: ${JSON.stringify(descriptor.name)}, exact: ${exact} })`;
  } else if (descriptor.strategy === 'label') {
    locator = scope.getByLabel(descriptor.text, { exact });
    expression = `getByLabel(${JSON.stringify(descriptor.text)}, { exact: ${exact} })`;
  } else if (descriptor.strategy === 'placeholder') {
    locator = scope.getByPlaceholder(descriptor.text, { exact });
    expression = `getByPlaceholder(${JSON.stringify(descriptor.text)}, { exact: ${exact} })`;
  } else if (descriptor.strategy === 'scoped_semantic' && descriptor.scopeSelector && descriptor.semantic) {
    const container = scope.locator(descriptor.scopeSelector);
    if (descriptor.semantic.strategy === 'role') {
      locator = container.getByRole(descriptor.semantic.role, { name: descriptor.semantic.name, exact: descriptor.semantic.exact !== false });
      expression = `locator(${JSON.stringify(descriptor.scopeSelector)}).getByRole(${JSON.stringify(descriptor.semantic.role)}, { name: ${JSON.stringify(descriptor.semantic.name)}, exact: ${descriptor.semantic.exact !== false} })`;
    } else if (descriptor.semantic.strategy === 'label') {
      locator = container.getByLabel(descriptor.semantic.text, { exact: descriptor.semantic.exact !== false });
      expression = `locator(${JSON.stringify(descriptor.scopeSelector)}).getByLabel(${JSON.stringify(descriptor.semantic.text)}, { exact: ${descriptor.semantic.exact !== false} })`;
    }
  } else if (['stable_attribute', 'generated_css', 'verified_xpath'].includes(descriptor.strategy) && descriptor.selector) {
    const shadowHosts = Array.isArray(descriptor.shadowHostSelectors) ? descriptor.shadowHostSelectors.filter(Boolean) : [];
    let container = scope;
    const expressionParts = [];
    for (const hostSelector of shadowHosts) {
      container = container.locator(hostSelector);
      expressionParts.push(`locator(${JSON.stringify(hostSelector)})`);
    }
    locator = container.locator(descriptor.selector);
    expressionParts.push(`locator(${JSON.stringify(descriptor.selector)})`);
    expression = expressionParts.join('.');
  }
  return locator && expression ? { locator, expression } : null;
}

async function verifyAuthoritativeCandidateBatch({ session, page, scope, capture, descriptors, phase, requireBackendMatch = true } = {}) {
  const expectedBackendNodeId = Number(capture?.identity?.backendNodeId) || null;
  if (!page || !scope || !expectedBackendNodeId) return [];
  const token = crypto.randomBytes(10).toString('hex');
  const prepared = [];
  // Candidate construction is already bounded to facts from the exact acted
  // node. Do not apply a second global cap here: a valid lower-tier CSS/XPath
  // candidate must still be verified when earlier semantic candidates are
  // ambiguous or do not resolve.
  for (const [index, descriptor] of (Array.isArray(descriptors) ? descriptors : []).entries()) {
    const built = authoritativeDescriptorLocator(scope, descriptor);
    if (!built) continue;
    let count = null;
    try { count = await built.locator.count(); } catch (_) { count = null; }
    if (count !== 1) continue;
    const markerAttribute = `${AUTHORITATIVE_CANDIDATE_MARKER_PREFIX}${index}`;
    const markerValue = `${token}-${index}`;
    try {
      const marked = await require('./actionExecutionGateway').dispatchBrowserMutation({
        session,
        mutationName: 'playwright_locator_add_capture_marker',
        args: { markerAttribute, markerValue, phase: phase || 'candidate_verification' },
        actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'candidate-marker-add'),
        source: 'browser_evidence_candidate_marker',
        dispatch: () => built.locator.evaluate((element, marker) => {
          if (!element?.setAttribute) return false;
          element.setAttribute(marker.attribute, marker.value);
          return true;
        }, { attribute: markerAttribute, value: markerValue }),
      });
      if (marked !== true) continue;
      prepared.push({ id: `candidate-${index}`, descriptor, ...built, count, markerAttribute, markerValue });
    } catch (_) {}
  }
  let captures = [];
  try {
    captures = await authoritativeCdpCapture.captureMarkedCandidates({
      page,
      markers: prepared.map((item) => ({ id: item.id, markerAttribute: item.markerAttribute, markerValue: item.markerValue })),
      phase: phase || 'candidate_verification',
    });
  } finally {
    await Promise.all(prepared.map(async (item) => {
      try {
        await require('./actionExecutionGateway').dispatchBrowserMutation({
          session,
          mutationName: 'playwright_locator_remove_capture_marker',
          args: { markerAttribute: item.markerAttribute, markerValue: item.markerValue, phase: phase || 'candidate_verification' },
          actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'candidate-marker-remove'),
          source: 'browser_evidence_candidate_marker_cleanup',
          dispatch: () => item.locator.evaluate((element, marker) => {
            if (element?.getAttribute?.(marker.attribute) === marker.value) element.removeAttribute(marker.attribute);
          }, { attribute: item.markerAttribute, value: item.markerValue }),
        });
      } catch (_) {}
    }));
  }
  const byId = new Map(captures.map((item) => [item.id, item]));
  return prepared.map((item) => {
    const matchedCapture = byId.get(item.id) || null;
    const matchedBackendNodeId = Number(matchedCapture?.identity?.backendNodeId) || null;
    const backendNodeVerified = matchedCapture?.captured === true && matchedBackendNodeId === expectedBackendNodeId;
    return {
      ...item.descriptor,
      expression: item.expression,
      count: item.count,
      matchedCapture,
      backendNodeVerified,
      verified: requireBackendMatch ? backendNodeVerified : matchedCapture?.captured === true,
      proof: {
        count: item.count,
        sameElement: backendNodeVerified,
        candidateUnique: item.count === 1,
        identityVerified: backendNodeVerified,
        backendNodeVerified,
        expectedBackendNodeId,
        matchedBackendNodeId,
        targetIdentity: capture.identity,
        matchedIdentity: matchedCapture?.identity || null,
        actionTimeResolved: true,
        actedNodeBound: true,
        resolutionMode: 'authoritative_cdp_backend_node',
        source: 'authoritative_chromium_cdp',
        verified: requireBackendMatch ? backendNodeVerified : matchedCapture?.captured === true,
      },
    };
  });
}

function authoritativeLogicalNodeAgreement(before, after) {
  if (!before?.captured || !after?.captured) return false;
  if (String(before.identity?.documentUrl || '') !== String(after.identity?.documentUrl || '')) return false;
  if (String(before.node?.nodeName || '').toLowerCase() !== String(after.node?.nodeName || '').toLowerCase()) return false;
  const beforeRole = String(before.accessibility?.role || '').toLowerCase();
  const afterRole = String(after.accessibility?.role || '').toLowerCase();
  const beforeName = String(before.accessibility?.name || '').replace(/\s+/g, ' ').trim();
  const afterName = String(after.accessibility?.name || '').replace(/\s+/g, ' ').trim();
  if (beforeRole && beforeName && beforeRole === afterRole && beforeName === afterName) return true;
  const stableNames = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'id', 'name'];
  return stableNames.some((name) => before.node?.attributes?.[name]
    && before.node.attributes[name] === after.node?.attributes?.[name]);
}

function cdpMarkerFunction(markerAttribute, markerValue, remove = false) {
  const attribute = JSON.stringify(String(markerAttribute));
  const value = JSON.stringify(String(markerValue));
  if (remove) {
    return `(el) => { try { if (el && el.getAttribute && el.getAttribute(${attribute}) === ${value}) el.removeAttribute(${attribute}); return true; } catch (_) { return false; } }`;
  }
  return `(el) => { try { if (!el || !el.setAttribute) return false; el.setAttribute(${attribute}, ${value}); return true; } catch (_) { return false; } }`;
}

async function rawEvaluateBoundRef(session, {
  ref,
  element,
  functionSource,
  timeoutMs = 2_000,
  recoverOnTimeout = true,
  actionOccurrenceId = null,
  transactionId = null,
  operationId = null,
  mutationPhaseId = 'browser_evaluate',
  source = 'authoritative_bound_ref_evidence',
} = {}) {
  if (!session?.client || typeof session.client.callTool !== 'function' || !ref || !functionSource) return null;
  const effectiveTimeoutMs = Math.max(100, Number(timeoutMs) || 2_000);
  const gateway = require('./actionExecutionGateway').defaultGateway;
  try {
    return await gateway.dispatchMcpTool({
      callTool: async (mcpSession, toolName, toolArgs, toolOptions) => {
        const authorization = gateway.authorizeMcpCall({
          session: mcpSession,
          toolName,
          args: toolArgs,
          permit: toolOptions.executionPermit,
        });
        const { requestOptions, cleanup } = buildMcpRequestOptions(mcpSession, effectiveTimeoutMs);
        const sdkRequestOptions = gateway.markSdkCallAuthorized(requestOptions, {
          session: mcpSession,
          authorization: authorization.permit,
        });
        let hardTimer = null;
        try {
          const sdkCall = mcpSession.client.callTool(
            { name: toolName, arguments: toolArgs },
            undefined,
            sdkRequestOptions,
          );
          if (!sdkCall || typeof sdkCall.then !== 'function') return sdkCall || null;
          sdkCall.catch(() => {});
          return await Promise.race([
            sdkCall,
            new Promise((_, reject) => {
              hardTimer = setTimeout(() => {
                const error = new Error(`MCP bound-ref evaluation exceeded ${effectiveTimeoutMs}ms.`);
                error.code = 'MCP_HARD_TIMEOUT';
                reject(error);
              }, effectiveTimeoutMs);
            }),
          ]);
        } finally {
          if (hardTimer) clearTimeout(hardTimer);
          cleanup();
        }
      },
      session,
      toolName: 'browser_evaluate',
      args: {
        element: element || `<locator ${ref}>`,
        target: ref,
        function: functionSource,
      },
      options: {
        timeoutMs: effectiveTimeoutMs,
        transactionId,
        operationId,
        mutationPhaseId,
        requireVerifiedTarget: true,
        targetAuthorization: {
          liveMutationAllowed: true,
          diagnosticOnly: false,
          isGuess: false,
          status: 'verified_internal_bound_ref',
          reason: 'exact_mcp_snapshot_ref_for_authoritative_identity_capture',
        },
      },
      actionOccurrenceId: actionOccurrenceId || gatewayInfrastructureOccurrence(session, 'bound-ref-evaluate'),
      source,
    });
  } catch (error) {
    if (error?.code === 'MCP_HARD_TIMEOUT' && recoverOnTimeout) {
      try {
        await recoverMcpTransport(session, 'bound_ref_evaluation_timeout');
      } catch (recoveryError) {
        error.mcpRecoveryError = String(recoveryError?.message || recoveryError);
      }
    }
    throw error;
  }
}

function optionalTargetAbsentCapture(capture, request = {}, originalReason = null) {
  if (request.optional !== true) return capture;
  return {
    ...capture,
    available: true,
    captured: false,
    authoritative: false,
    optional: true,
    nonBlocking: true,
    reason: 'optional_target_absent',
    originalReason: originalReason || capture?.reason || null,
  };
}

function markerFailureProvesTargetAbsence(result) {
  if (!result || result.isError !== true) return false;
  const explicitCode = String(result?.error?.code || result?.code || '').trim().toLowerCase();
  if (['element_not_found', 'locator_not_found', 'ref_not_found', 'target_not_found', 'zero_matches'].includes(explicitCode)) {
    return true;
  }
  const contentText = (Array.isArray(result.content) ? result.content : [])
    .map((block) => typeof block === 'string' ? block : block?.text || block?.message || '')
    .filter(Boolean)
    .join(' ');
  const message = [result?.error?.message, result?.message, contentText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!message) return false;
  const subject = '(?:element|locator|target|ref(?:erence)?)';
  const absence = '(?:not found|does not exist|no longer exists|resolved to (?:0|zero)|matched (?:0|zero)|no matches|zero matches|no elements)';
  const explicitAbsence = new RegExp(`${subject}.{0,160}${absence}`).test(message)
    || new RegExp(`${absence}.{0,160}${subject}`).test(message);
  // Playwright locator.evaluate waits for its locator to resolve to an attached
  // element before it runs the callback. This exact three-part call-log shape
  // therefore proves that the bound target never resolved. Do not accept a
  // generic timeout: transport/request/browser timeouts lack this locator
  // operation + call-log + waiting-for combination.
  const locatorResolutionWait = /\blocator\.evaluate\s*:\s*timeout\b/.test(message)
    && /\bcall log\s*:/.test(message)
    && /\bwaiting for\b/.test(message);
  return explicitAbsence || locatorResolutionWait;
}

function cleanTooltipEvidenceText(value, max = 1_000) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function tooltipTextMatchesExpected(actual, expected) {
  const observed = cleanTooltipEvidenceText(actual);
  const wanted = cleanTooltipEvidenceText(expected);
  if (!observed || !wanted) return false;
  const left = observed.toLocaleLowerCase();
  const right = wanted.toLocaleLowerCase();
  return left === right || left.includes(right) || right.includes(left);
}

async function captureTooltipEvidence(request = {}, capture = {}, locator = null) {
  if (request.observationKind !== 'tooltip') return null;
  let liveDom = null;
  if (locator && typeof locator.evaluate === 'function') {
    try {
      liveDom = await locator.evaluate((node) => {
        const attribute = (name) => node?.getAttribute?.(name) || null;
        const role = String(attribute('role') || '').trim().toLowerCase();
        const describedByValues = String(attribute('aria-describedby') || '')
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => node?.ownerDocument?.getElementById?.(id))
          .filter(Boolean)
          .map((description) => description.innerText || description.textContent)
          .filter(Boolean);
        const semanticAttributeValues = [
          attribute('title'),
          attribute('aria-description'),
          attribute('data-tooltip'),
          attribute('data-original-title'),
          ...describedByValues,
        ].filter(Boolean);
        const elementTextValues = [node?.innerText, node?.textContent, attribute('aria-label')].filter(Boolean);
        return {
          role,
          values: [...elementTextValues, ...semanticAttributeValues],
          semanticValues: role === 'tooltip'
            ? [...elementTextValues, ...semanticAttributeValues]
            : semanticAttributeValues,
          semanticRelationship: role === 'tooltip' || semanticAttributeValues.length > 0,
        };
      });
    } catch (_) {
      liveDom = null;
    }
  }
  const attributes = capture?.node?.attributes && typeof capture.node.attributes === 'object'
    ? capture.node.attributes
    : {};
  const role = String(liveDom?.role || capture?.accessibility?.role || attributes.role || '').trim().toLowerCase();
  const capturedSemanticValues = [
    attributes.title,
    attributes['aria-description'],
    attributes['data-tooltip'],
    attributes['data-original-title'],
    capture?.accessibility?.description,
  ].map((value) => cleanTooltipEvidenceText(value)).filter(Boolean);
  if (role === 'tooltip') {
    capturedSemanticValues.push(
      cleanTooltipEvidenceText(capture?.accessibility?.name),
      cleanTooltipEvidenceText(capture?.node?.nodeValue),
      cleanTooltipEvidenceText(attributes['aria-label']),
    );
  }
  const semanticTextCandidates = [
    ...(Array.isArray(liveDom?.semanticValues) ? liveDom.semanticValues : []),
    ...capturedSemanticValues,
  ].map((value) => cleanTooltipEvidenceText(value)).filter(Boolean);
  const uniqueSemanticTextCandidates = Array.from(new Set(semanticTextCandidates));
  const expectedText = cleanTooltipEvidenceText(request.expectedText);
  const expectedMatch = expectedText
    ? uniqueSemanticTextCandidates.find((value) => tooltipTextMatchesExpected(value, expectedText)) || null
    : null;
  const semanticRelationship = liveDom?.semanticRelationship === true
    || role === 'tooltip'
    || capturedSemanticValues.some(Boolean)
    || !!attributes['aria-describedby'];
  const domText = expectedMatch || uniqueSemanticTextCandidates[0] || null;
  const domPresent = capture?.captured === true
    && semanticRelationship
    && (expectedText ? !!expectedMatch : true);

  const visualInput = request.visualObservation && typeof request.visualObservation === 'object'
    ? request.visualObservation
    : null;
  const visualObserved = visualInput?.observed === true;
  const visualText = cleanTooltipEvidenceText(visualInput?.text);
  const semantics = domPresent && visualObserved
    ? 'dom_and_visual_confirmed'
    : domPresent
      ? 'dom_confirmed_visual_unavailable'
      : visualObserved
        ? 'visual_only'
        : 'not_observed';
  return {
    dom: { present: domPresent, text: domText },
    visual: { observed: visualObserved, text: visualText },
    semantics,
    nonBlocking: true,
    explanation: semantics === 'dom_confirmed_visual_unavailable'
      ? 'DOM/accessibility evidence confirmed the tooltip; visual confirmation was unavailable. The authored flow may continue without blocking.'
      : null,
  };
}

/**
 * Bind an MCP target ref to the same DOM node seen by the owner Playwright
 * context, then capture Chromium-authoritative identity.  The marker is always
 * removed.  No live Playwright Page means an explicit unavailable result; the
 * caller must retain its existing MCP proof and may not promote this result.
 */
async function captureAuthoritativeActionTarget(session, request = {}) {
  const { ref, element, pageUrl, phase = 'pre_action' } = request;
  const withCaptureBinding = async (capture, page = null, targetLocator = null) => {
    const tooltipEvidence = await captureTooltipEvidence(request, capture, targetLocator);
    const enrichedCapture = tooltipEvidence ? { ...capture, tooltipEvidence } : capture;
    const pageId = enrichedCapture?.pageIdentity?.pageId
      || (page ? transitionPageId(page) : null);
    const backendNodeId = Number(enrichedCapture?.identity?.backendNodeId) || null;
    const captureBinding = captureBindingAttempt(session, { ...request, phase }, {
      pageId,
      backendNodeId,
      capturedAt: enrichedCapture?.capturedAt || new Date().toISOString(),
      status: enrichedCapture?.captured === true && pageId && backendNodeId ? 'bound' : 'not_bound',
      reason: enrichedCapture?.reason || (backendNodeId ? null : 'backend_node_id_missing'),
      pageUrl: enrichedCapture?.pageIdentity?.url || enrichedCapture?.identity?.documentUrl || pageUrl || null,
    });
    return { ...enrichedCapture, captureBinding };
  };
  if (!livePlaywrightPagesForSession(session).length) {
    return withCaptureBinding({
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: false,
      captured: false,
      authoritative: false,
      source: 'chromium_cdp',
      phase,
      reason: 'playwright_page_unavailable',
      capturedAt: new Date().toISOString(),
    });
  }
  if (!ref) {
    return withCaptureBinding({
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: true,
      captured: false,
      authoritative: false,
      source: 'chromium_cdp',
      phase,
      reason: 'mcp_bound_ref_missing',
      capturedAt: new Date().toISOString(),
    });
  }
  const markerValue = `qaai-${session?.id || 'session'}-${crypto.randomBytes(12).toString('hex')}`;
  const markerTransactionId = gatewayInfrastructureOccurrence(session, 'authoritative-target-marker');
  try {
    const marked = await rawEvaluateBoundRef(session, {
      ref,
      element,
      functionSource: cdpMarkerFunction(AUTHORITATIVE_CDP_MARKER_ATTRIBUTE, markerValue, false),
      actionOccurrenceId: `${markerTransactionId}:add`,
      transactionId: markerTransactionId,
      operationId: `${markerTransactionId}:add`,
      mutationPhaseId: 'marker_add',
      source: 'authoritative_target_marker_add',
    });
    if (!marked || marked.isError) {
      const failedCapture = {
        schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
        available: true,
        captured: false,
        authoritative: false,
        source: 'chromium_cdp',
        phase,
        reason: 'mcp_target_marker_failed',
        capturedAt: new Date().toISOString(),
      };
      return withCaptureBinding(
        markerFailureProvesTargetAbsence(marked)
          ? optionalTargetAbsentCapture(failedCapture, request, 'mcp_target_marker_failed')
          : failedCapture,
      );
    }
    let boundTarget = await findUniqueMarkedTarget(session, AUTHORITATIVE_CDP_MARKER_ATTRIBUTE, markerValue);
    if (!boundTarget.ok && boundTarget.reason === 'candidate_marker_not_found') {
      boundTarget = await findUniqueCdpMarkedTarget(
        session,
        AUTHORITATIVE_CDP_MARKER_ATTRIBUTE,
        markerValue,
        phase,
      );
    }
    if (!boundTarget.ok) {
      const failedCapture = {
        schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
        available: true,
        captured: false,
        authoritative: false,
        source: 'chromium_cdp',
        phase,
        reason: boundTarget.reason,
        matchCount: boundTarget.matchCount,
        capturedAt: new Date().toISOString(),
      };
      return withCaptureBinding(
        boundTarget.reason === 'candidate_marker_not_found'
          ? optionalTargetAbsentCapture(failedCapture, request, boundTarget.reason)
          : failedCapture,
      );
    }
    const { page, frame, locator: targetLocator } = boundTarget;
    const captured = boundTarget.authoritativeCapture || await authoritativeCdpCapture.captureMarkedTarget({
      page,
      markerAttribute: AUTHORITATIVE_CDP_MARKER_ATTRIBUTE,
      markerValue,
      phase,
    });
    if (!captured?.captured || !captured?.identity?.backendNodeId) {
      const failedCapture = {
        ...captured,
      };
      return withCaptureBinding(
        captured?.reason === 'marker_not_found'
          ? optionalTargetAbsentCapture(failedCapture, request, captured.reason)
          : failedCapture,
        page,
        targetLocator,
      );
    }
    const analysis = targetLocator
      ? await locatorCaptureAnalysis.analyzeLiveTarget({ frame, locator: targetLocator })
      : { schema: locatorCaptureAnalysis.LIVE_ANALYSIS_SCHEMA, ok: false, reason: 'playwright_locator_scan_unavailable' };
    const descriptors = locatorCaptureAnalysis.buildAuthoritativeCandidateDescriptors({ analysis, capture: captured });
    const declaredFramePath = framePathSelectors(captured);
    const completeFramePath = declaredFramePath.length === (Array.isArray(captured.framePath) ? captured.framePath.length : 0);
    const firstPass = completeFramePath
      ? await verifyAuthoritativeCandidateBatch({
          session,
          page,
          scope: frame,
          capture: captured,
          descriptors,
          phase: 'candidate_verification_before_stabilization',
          requireBackendMatch: true,
        })
      : [];
    const firstSelected = firstPass.find((candidate) => candidate.verified === true) || null;
    let selectedCandidate = null;
    let stabilization = {
      attempted: !!firstSelected,
      countBefore: firstSelected?.count ?? null,
      countAfter: null,
      stableAcrossSnapshots: false,
      sameElementAcrossSnapshots: false,
      logicalReplacement: false,
      reason: firstSelected ? 'stabilization_pending' : 'no_backend_verified_candidate',
    };
    if (firstSelected) {
      try { await page.waitForTimeout(60); } catch (_) {}
      const secondPass = await verifyAuthoritativeCandidateBatch({
        session,
        page,
        scope: frame,
        capture: captured,
        descriptors: [firstSelected],
        phase: 'candidate_verification_after_stabilization',
        requireBackendMatch: false,
      });
      const stabilized = secondPass[0] || null;
      const postCapture = stabilized?.matchedCapture || null;
      const sameElementAcrossSnapshots = Number(postCapture?.identity?.backendNodeId) === Number(captured.identity.backendNodeId);
      const logicalReplacement = !sameElementAcrossSnapshots && authoritativeLogicalNodeAgreement(captured, postCapture);
      const stableAcrossSnapshots = stabilized?.count === 1 && (sameElementAcrossSnapshots || logicalReplacement);
      stabilization = {
        attempted: true,
        countBefore: firstSelected.count,
        countAfter: stabilized?.count ?? null,
        backendNodeIdBefore: captured.identity.backendNodeId,
        backendNodeIdAfter: postCapture?.identity?.backendNodeId || null,
        stableAcrossSnapshots,
        sameElementAcrossSnapshots,
        logicalReplacement,
        reason: stableAcrossSnapshots ? null : 'candidate_did_not_survive_stabilization',
      };
      if (stableAcrossSnapshots) {
        selectedCandidate = {
          ...firstSelected,
          framePath: declaredFramePath,
          proof: {
            ...(firstSelected.proof || {}),
            countBefore: firstSelected.count,
            countAfter: stabilized.count,
            stableAcrossSnapshots: true,
            sameElementAcrossSnapshots,
            logicalReplacement,
            backendNodeIdBefore: captured.identity.backendNodeId,
            backendNodeIdAfter: postCapture.identity.backendNodeId,
            postStabilizationIdentity: postCapture.identity,
            authoritativeCdpVerified: true,
          },
        };
      }
    }
    const pageIdentity = await authoritativePageIdentity(session, page, {
      popupIdentity: request.popupIdentity || session?.activePopupIdentity || null,
    });
    return withCaptureBinding({
      ...captured,
      pageIdentity,
      frameIdentity: {
        url: (() => { try { return frame.url(); } catch (_) { return null; } })(),
        name: (() => { try { return frame.name(); } catch (_) { return null; } })(),
        isMainFrame: (() => { try { return page.mainFrame() === frame; } catch (_) { return null; } })(),
      },
      framePathSelectors: declaredFramePath,
      framePathExportable: completeFramePath,
      candidateAnalysis: analysis,
      candidateDescriptors: descriptors,
      verifiedCandidates: firstPass.filter((candidate) => candidate.backendNodeVerified === true),
      selectedCandidate,
      stabilization,
    }, page, targetLocator);
  } catch (error) {
    return withCaptureBinding({
      schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
      available: true,
      captured: false,
      authoritative: false,
      source: 'chromium_cdp',
      phase,
      reason: 'authoritative_capture_failed',
      detail: String(error?.message || error).slice(0, 1_000),
      capturedAt: new Date().toISOString(),
    });
  } finally {
    try {
      await rawEvaluateBoundRef(session, {
        ref,
        element,
        functionSource: cdpMarkerFunction(AUTHORITATIVE_CDP_MARKER_ATTRIBUTE, markerValue, true),
        timeoutMs: 750,
        recoverOnTimeout: false,
        actionOccurrenceId: `${markerTransactionId}:remove`,
        transactionId: markerTransactionId,
        operationId: `${markerTransactionId}:remove`,
        mutationPhaseId: 'marker_remove',
        source: 'authoritative_target_marker_remove',
      });
    } catch (_) {}
  }
}

function authoritativePreCaptures(actionLocator) {
  const out = [];
  const visit = (locator) => {
    if (!locator || typeof locator !== 'object') return;
    if (locator.kind === 'multi' && Array.isArray(locator.fields)) {
      locator.fields.forEach((field) => visit(field?.actionLocator));
      return;
    }
    const capture = locator?.context?.authoritativeCdp?.pre || locator?.authoritativeCdp?.pre;
    if (capture?.captured && capture?.identity?.backendNodeId) out.push(capture);
  };
  visit(actionLocator);
  return out;
}

function authoritativeCaptureIdentitySummary(capture) {
  if (!capture || typeof capture !== 'object') return null;
  return {
    schema: capture.schema || null,
    available: capture.available !== false,
    captured: capture.captured === true,
    authoritative: capture.authoritative === true,
    source: capture.source || null,
    phase: capture.phase || null,
    reason: capture.reason || null,
    capturedAt: capture.capturedAt || null,
    identity: capture.identity ? { ...capture.identity } : null,
    backendNodeId: capture.identity?.backendNodeId || capture.backendNodeId || null,
    captureBinding: capture.captureBinding ? { ...capture.captureBinding } : null,
    pageIdentity: capture.pageIdentity ? { ...capture.pageIdentity } : null,
    frameIdentity: capture.frameIdentity ? { ...capture.frameIdentity } : null,
    framePath: Array.isArray(capture.framePath) ? capture.framePath.slice() : [],
    framePathSelectors: Array.isArray(capture.framePathSelectors) ? capture.framePathSelectors.slice() : [],
    shadowPath: Array.isArray(capture.shadowPath) ? capture.shadowPath.slice() : [],
    accessibility: capture.accessibility ? { ...capture.accessibility } : null,
    node: capture.node ? { ...capture.node } : null,
    presentInSnapshot: typeof capture.presentInSnapshot === 'boolean' ? capture.presentInSnapshot : null,
    sameBackendNode: typeof capture.sameBackendNode === 'boolean' ? capture.sameBackendNode : null,
    replacement: capture.replacement ? { ...capture.replacement } : null,
    removed: typeof capture.removed === 'boolean' ? capture.removed : null,
    nonBlocking: capture.nonBlocking === true,
    optional: capture.optional === true,
    originalReason: capture.originalReason || null,
    tooltipEvidence: capture.tooltipEvidence ? { ...capture.tooltipEvidence } : null,
    gap: capture.gap ? { ...capture.gap } : null,
  };
}

function authoritativeCaptureBundles(actionLocator) {
  const bundles = [];
  const visit = (locator, fieldIndex = null) => {
    if (!locator || typeof locator !== 'object') return;
    if (locator.kind === 'multi' && Array.isArray(locator.fields)) {
      locator.fields.forEach((field, index) => visit(field?.actionLocator, index));
      return;
    }
    const authoritative = locator?.context?.authoritativeCdp || locator?.authoritativeCdp || null;
    if (!authoritative?.pre && !authoritative?.post) return;
    bundles.push({
      fieldIndex,
      pre: authoritativeCaptureIdentitySummary(authoritative.pre),
      post: authoritativeCaptureIdentitySummary(authoritative.post),
    });
  };
  visit(actionLocator);
  return bundles;
}

function authoritativeCaptureKey(capture = {}) {
  const pageId = String(capture?.pageIdentity?.pageId || 'page-identity-missing');
  const backendNodeId = Number(capture?.identity?.backendNodeId || capture?.backendNodeId) || null;
  return backendNodeId ? `${pageId}:${backendNodeId}` : null;
}

function authoritativePostGap(pre, reason, detail = null) {
  const code = `authoritative_post_${String(reason || 'capture_gap')}`;
  return {
    schema: authoritativeCdpCapture.CAPTURE_SCHEMA,
    available: false,
    captured: false,
    authoritative: false,
    source: 'chromium_cdp',
    phase: 'post_action',
    reason,
    detail: detail ? String(detail).slice(0, 1_000) : null,
    capturedAt: new Date().toISOString(),
    nonBlocking: true,
    identity: pre?.identity ? { ...pre.identity, connected: false } : null,
    backendNodeId: Number(pre?.identity?.backendNodeId) || null,
    pageIdentity: pre?.pageIdentity
      ? { ...pre.pageIdentity, closed: reason === 'page_closed' }
      : null,
    presentInSnapshot: false,
    sameBackendNode: false,
    replacement: null,
    removed: false,
    gap: {
      code,
      nonBlocking: true,
      reason,
      pageId: pre?.pageIdentity?.pageId || null,
      backendNodeId: Number(pre?.identity?.backendNodeId) || null,
      detail: detail ? String(detail).slice(0, 1_000) : null,
    },
  };
}

function normalizeAuthoritativePostCapture(pre, post) {
  if (!post || typeof post !== 'object') return authoritativePostGap(pre, 'post_capture_missing');
  const captured = post.captured === true;
  const presentInSnapshot = captured && post.presentInSnapshot === true;
  const sameBackendNode = presentInSnapshot
    && Number(post?.identity?.backendNodeId) === Number(pre?.identity?.backendNodeId);
  return {
    ...post,
    identity: post.identity || (pre?.identity ? { ...pre.identity, connected: false } : null),
    backendNodeId: Number(post?.identity?.backendNodeId || post?.backendNodeId || pre?.identity?.backendNodeId) || null,
    pageIdentity: pre?.pageIdentity ? { ...pre.pageIdentity } : null,
    presentInSnapshot,
    sameBackendNode,
    replacement: null,
    removed: captured && post.presentInSnapshot === false,
  };
}

function bindAuthoritativePostCapture(session, pre, post) {
  const preBinding = pre?.captureBinding && typeof pre.captureBinding === 'object'
    ? pre.captureBinding
    : {};
  const postPageId = post?.pageIdentity?.pageId || pre?.pageIdentity?.pageId || preBinding.pageId || null;
  const postBackendNodeId = Number(post?.identity?.backendNodeId) || null;
  const sameConnectedNode = post?.captured === true
    && post?.presentInSnapshot === true
    && post?.sameBackendNode === true
    && post?.identity?.connected !== false
    && !!postPageId
    && postBackendNodeId > 0;
  const replacementObserved = !sameConnectedNode && post?.replacement?.resolved === true;
  const status = sameConnectedNode ? 'bound' : replacementObserved ? 'observed_replacement' : 'not_bound';
  const reason = sameConnectedNode
    ? null
    : post?.reason
      || (post?.removed === true ? 'acted_node_removed' : null)
      || (post?.identity?.connected === false ? 'acted_node_disconnected' : null)
      || (replacementObserved ? 'replacement_observed' : 'post_identity_not_bound');
  const captureBinding = captureBindingAttempt(session, {
    phase: 'post_action',
    ref: preBinding.ref || null,
    pageUrl: post?.pageIdentity?.url || post?.identity?.documentUrl || preBinding.pageUrl || null,
    actionIdentity: preBinding,
  }, {
    pageId: postPageId,
    backendNodeId: postBackendNodeId,
    capturedAt: post?.capturedAt || new Date().toISOString(),
    status,
    reason,
    pageUrl: post?.pageIdentity?.url || post?.identity?.documentUrl || preBinding.pageUrl || null,
  });
  return { ...post, captureBinding };
}

function authoritativeStableAttributeAgreement(before, after) {
  const stableNames = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'id', 'name'];
  return stableNames.some((name) => before?.node?.attributes?.[name]
    && before.node.attributes[name] === after?.node?.attributes?.[name]);
}

function authoritativePathBackendIds(path) {
  return (Array.isArray(path) ? path : [])
    .map((item) => Number(item?.backendNodeId) || null)
    .filter(Boolean);
}

function sameAuthoritativePath(before, after) {
  const left = authoritativePathBackendIds(before);
  const right = authoritativePathBackendIds(after);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function authoritativeBoundsAgreement(before, after) {
  const left = before?.layout?.bounds;
  const right = after?.layout?.bounds;
  if (!left || !right) return false;
  const tolerance = Math.max(4, Math.min(24, Math.max(Number(left.width) || 0, Number(left.height) || 0) * 0.1));
  return ['x', 'y', 'width', 'height'].every((field) =>
    Math.abs((Number(left[field]) || 0) - (Number(right[field]) || 0)) <= tolerance);
}

function authoritativeStrongContextAgreement(before, after) {
  const beforeAncestry = Array.isArray(before?.ancestry) ? before.ancestry : [];
  const afterAncestry = Array.isArray(after?.ancestry) ? after.ancestry : [];
  let matchingBackendPrefix = 0;
  const limit = Math.min(beforeAncestry.length, afterAncestry.length, 6);
  while (matchingBackendPrefix < limit
      && Number(beforeAncestry[matchingBackendPrefix]?.backendNodeId) > 0
      && Number(beforeAncestry[matchingBackendPrefix]?.backendNodeId) === Number(afterAncestry[matchingBackendPrefix]?.backendNodeId)) {
    matchingBackendPrefix += 1;
  }
  const stableNames = ['data-testid', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'id', 'name'];
  const stableAncestorAgreement = beforeAncestry.slice(0, limit).some((node, index) =>
    stableNames.some((name) => node?.attributes?.[name]
      && node.attributes[name] === afterAncestry[index]?.attributes?.[name]));
  const framePathAgreement = sameAuthoritativePath(before?.framePath, after?.framePath);
  const shadowPathAgreement = sameAuthoritativePath(before?.shadowPath, after?.shadowPath);
  const boundsAgreement = authoritativeBoundsAgreement(before, after);
  const strong = matchingBackendPrefix >= 1
    && (stableAncestorAgreement || matchingBackendPrefix >= 2)
    && framePathAgreement
    && shadowPathAgreement
    && boundsAgreement;
  return {
    strong,
    matchingBackendPrefix,
    stableAncestorAgreement,
    framePathAgreement,
    shadowPathAgreement,
    boundsAgreement,
  };
}

function authoritativeReplacementScope(page, pre) {
  const framePath = Array.isArray(pre?.framePath) ? pre.framePath : [];
  const selectors = Array.isArray(pre?.framePathSelectors) ? pre.framePathSelectors.filter(Boolean) : [];
  const selectedPath = Array.isArray(pre?.selectedCandidate?.framePath)
    ? pre.selectedCandidate.framePath.filter(Boolean)
    : selectors;
  if (framePath.length && (pre?.framePathExportable !== true || selectors.length !== framePath.length)) {
    return { scope: null, reason: 'replacement_frame_context_not_exportable' };
  }
  if (JSON.stringify(selectedPath) !== JSON.stringify(selectors)) {
    return { scope: null, reason: 'replacement_frame_context_mismatch' };
  }
  let scope = page;
  for (const selector of selectors) {
    if (!scope || typeof scope.frameLocator !== 'function') {
      return { scope: null, reason: 'replacement_frame_locator_unavailable' };
    }
    scope = scope.frameLocator(selector);
  }
  return { scope, reason: null };
}

async function reacquireAuthoritativeReplacement(session, page, pre) {
  const selected = pre?.selectedCandidate || null;
  const baseProof = {
    source: 'authoritative_chromium_cdp',
    pageId: pre?.pageIdentity?.pageId || null,
    expectedBackendNodeId: Number(pre?.identity?.backendNodeId) || null,
    strategy: selected?.strategy || null,
    expression: selected?.expression || null,
  };
  if (!selected?.expression
      || selected?.proof?.authoritativeCdpVerified !== true
      || selected?.proof?.backendNodeVerified !== true
      || pre?.stabilization?.stableAcrossSnapshots !== true) {
    return {
      matchedCapture: null,
      sameBackendNode: false,
      replacement: {
        resolved: false,
        backendNodeId: null,
        count: null,
        stable: false,
        logicalTargetPresent: false,
        proof: {
          ...baseProof,
          stable: false,
          logicalTargetPresent: false,
          reason: 'verified_replacement_recipe_unavailable',
        },
      },
    };
  }
  const scoped = authoritativeReplacementScope(page, pre);
  if (!scoped.scope) {
    return {
      matchedCapture: null,
      sameBackendNode: false,
      replacement: {
        resolved: false,
        backendNodeId: null,
        count: null,
        stable: false,
        logicalTargetPresent: false,
        proof: { ...baseProof, stable: false, logicalTargetPresent: false, reason: scoped.reason },
      },
    };
  }
  let candidates = [];
  try {
    candidates = await verifyAuthoritativeCandidateBatch({
      session,
      page,
      scope: scoped.scope,
      capture: pre,
      descriptors: [selected],
      phase: 'post_action_replacement_verification',
      requireBackendMatch: false,
    });
  } catch (error) {
    return {
      matchedCapture: null,
      sameBackendNode: false,
      replacement: {
        resolved: false,
        backendNodeId: null,
        count: null,
        stable: false,
        logicalTargetPresent: false,
        proof: {
          ...baseProof,
          stable: false,
          logicalTargetPresent: false,
          reason: 'replacement_capture_failed',
          detail: String(error?.message || error).slice(0, 500),
        },
      },
    };
  }
  const candidate = candidates[0] || null;
  const matchedCapture = candidate?.matchedCapture || null;
  const backendNodeId = Number(matchedCapture?.identity?.backendNodeId) || null;
  if (candidate?.count !== 1 || matchedCapture?.captured !== true || !backendNodeId) {
    return {
      matchedCapture,
      sameBackendNode: false,
      replacement: {
        resolved: false,
        backendNodeId,
        count: candidate?.count ?? null,
        stable: false,
        logicalTargetPresent: false,
        proof: {
          ...baseProof,
          count: candidate?.count ?? null,
          stable: false,
          logicalTargetPresent: false,
          reason: 'replacement_candidate_not_unique_or_unavailable',
        },
      },
    };
  }
  if (backendNodeId === Number(pre.identity.backendNodeId)) {
    return { matchedCapture, sameBackendNode: true, replacement: null };
  }
  const logicalAgreement = authoritativeLogicalNodeAgreement(pre, matchedCapture);
  const stableAttributeAgreement = authoritativeStableAttributeAgreement(pre, matchedCapture);
  const strongContextAgreement = authoritativeStrongContextAgreement(pre, matchedCapture);
  const semanticStrategy = ['testid', 'role', 'label', 'placeholder', 'scoped_semantic'].includes(selected.strategy);
  const structuralSelector = /:nth-(?:child|of-type)\(/.test(String(selected.selector || selected.expression || ''));
  const identityStrongEnough = stableAttributeAgreement || strongContextAgreement.strong;
  const resolved = logicalAgreement && identityStrongEnough;
  return {
    matchedCapture,
    sameBackendNode: false,
    replacement: {
      resolved,
      backendNodeId,
      count: candidate.count,
      stable: resolved,
      logicalTargetPresent: resolved,
      proof: {
        ...baseProof,
        count: candidate.count,
        unique: candidate.count === 1,
        logicalAgreement,
        stableAttributeAgreement,
        strongContextAgreement,
        semanticStrategy,
        structuralSelector,
        stable: resolved,
        logicalTargetPresent: resolved,
        matchedIdentity: matchedCapture.identity || null,
        reason: resolved ? null : 'replacement_identity_not_strong_enough',
      },
    },
  };
}

function attachAuthoritativePostCaptures(actionLocator, postCaptures) {
  const byCaptureKey = new Map(
    (postCaptures || [])
      .map((capture) => [authoritativeCaptureKey(capture), capture])
      .filter(([key]) => !!key),
  );
  const visit = (locator) => {
    if (!locator || typeof locator !== 'object') return locator;
    if (locator.kind === 'multi' && Array.isArray(locator.fields)) {
      return {
        ...locator,
        fields: locator.fields.map((field) => field?.actionLocator
          ? { ...field, actionLocator: visit(field.actionLocator) }
          : field),
      };
    }
    const pre = locator?.context?.authoritativeCdp?.pre || locator?.authoritativeCdp?.pre;
    const post = pre ? byCaptureKey.get(authoritativeCaptureKey(pre)) || null : null;
    if (!pre) return locator;
    const authoritativeCdp = { pre, post };
    return {
      ...locator,
      authoritativeCdp,
      context: { ...(locator.context || {}), authoritativeCdp },
    };
  };
  return visit(actionLocator);
}

async function captureAuthoritativePostAction(session, actionLocator, _options = {}) {
  const preCaptures = authoritativePreCaptures(actionLocator);
  if (!preCaptures.length) return actionLocator;
  const postCaptures = [];
  const groups = new Map();
  for (const pre of preCaptures) {
    const resolved = exactAuthoritativePageForIdentity(session, pre.pageIdentity);
    if (!resolved.page) {
      postCaptures.push(bindAuthoritativePostCapture(
        session,
        pre,
        authoritativePostGap(pre, resolved.reason),
      ));
      continue;
    }
    const key = pre.pageIdentity.pageId;
    if (!groups.has(key)) groups.set(key, { page: resolved.page, captures: [] });
    groups.get(key).captures.push(pre);
  }
  for (const { page, captures } of groups.values()) {
    let observed = [];
    try {
      observed = await authoritativeCdpCapture.captureBackendNodeStates({
        page,
        previousCaptures: captures,
        phase: 'post_action',
      });
    } catch (error) {
      observed = captures.map((pre) => authoritativePostGap(pre, 'post_capture_failed', error?.message || error));
    }
    for (let index = 0; index < captures.length; index += 1) {
      const pre = captures[index];
      let post = normalizeAuthoritativePostCapture(pre, observed[index]);
      if (post.captured === true && post.presentInSnapshot === false) {
        const reacquired = await reacquireAuthoritativeReplacement(session, page, pre);
        if (reacquired.sameBackendNode && reacquired.matchedCapture) {
          post = {
            ...reacquired.matchedCapture,
            phase: 'post_action',
            pageIdentity: { ...pre.pageIdentity },
            presentInSnapshot: true,
            sameBackendNode: true,
            replacement: null,
            removed: false,
            reobservedAfterInitialMiss: true,
          };
        } else {
          post = {
            ...post,
            replacement: reacquired.replacement,
            removed: reacquired.replacement?.resolved !== true,
          };
        }
      }
      post = bindAuthoritativePostCapture(session, pre, post);
      postCaptures.push(post);
    }
  }
  return attachAuthoritativePostCaptures(actionLocator, postCaptures);
}

async function startCdpScreencast(session) {
  const liveCdp = session?.liveCdp;
  const ownerContext = liveCdp?.context;
  const monitorBrowser = liveCdp?.monitorBrowser;
  if (!session || (!ownerContext && !monitorBrowser)) return false;
  const state = {
    stopping: false,
    attachToken: 0,
    cdp: null,
    page: null,
    reattachTimer: null,
    pageScanTimer: null,
    started: false,
    lastFrameAt: 0,
    lastPageUrl: null,
  };
  session.cdpScreencast = state;

  const pageUrl = (page) => {
    try { return page?.url?.() || ''; } catch (_) { return ''; }
  };

  const isUsablePage = (page) => {
    if (!page) return false;
    try { if (page.isClosed()) return false; } catch (_) { return false; }
    const url = pageUrl(page);
    return !/^devtools:|^chrome:|^chrome-extension:/i.test(url);
  };

  const pageContext = (page) => {
    try { return page.context(); } catch (_) { return ownerContext; }
  };

  const listPages = () => {
    const pages = [];
    const seen = new Set();
    const addPage = (page) => {
      if (!isUsablePage(page) || seen.has(page)) return;
      seen.add(page);
      pages.push(page);
    };
    try {
      for (const ctx of monitorBrowser?.contexts?.() || []) {
        for (const page of ctx.pages()) addPage(page);
      }
    } catch (_) {}
    try {
      for (const page of ownerContext?.pages?.() || []) addPage(page);
    } catch (_) {}
    return pages;
  };

  const choosePage = () => {
    const pages = listPages();
    if (!pages.length) return null;
    const nonBlank = pages.filter((page) => {
      const url = pageUrl(page);
      return url && url !== 'about:blank';
    });
    return (nonBlank.length ? nonBlank : pages).at(-1) || null;
  };

  const detachCurrent = async () => {
    const cdp = state.cdp;
    state.cdp = null;
    if (!cdp) return;
    await bestEffortWithin('cdp_stop_screencast', () => cdp.send('Page.stopScreencast'), 1000);
    await bestEffortWithin('cdp_detach', () => cdp.detach(), 1000);
  };

  const attachToPage = async (page, reason = 'attach') => {
    if (!page || state.stopping || session.closed) return false;
    try { if (page.isClosed()) return false; } catch (_) { return false; }
    const url = pageUrl(page);
    if (state.page === page && state.cdp && reason !== 'frame_stall' && state.lastPageUrl === url) {
      return true;
    }
    const token = ++state.attachToken;
    await detachCurrent();
    const ctx = pageContext(page);
    if (!ctx?.newCDPSession) return false;
    const cdp = await ctx.newCDPSession(page);
    if (token !== state.attachToken || state.stopping || session.closed) {
      try { await cdp.detach(); } catch (_) {}
      return false;
    }
    state.cdp = cdp;
    state.page = page;
    state.lastPageUrl = url;
    cdp.on('Page.screencastFrame', (params) => {
      state.lastFrameAt = Date.now();
      try {
        if (!session.closed && params?.data) {
          session.broadcast?.({
            type: 'browser.frame',
            sessionId: session.id,
            frame: params.data,
            mediaType: 'image/jpeg',
            ts: Date.now(),
            source: 'cdp_screencast',
          });
        }
      } catch (_) {}
      try {
        if (params?.sessionId != null) {
          cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
        }
      } catch (_) {}
    });
    page.once('close', () => {
      if (!state.stopping && !session.closed) {
        clearTimeout(state.reattachTimer);
        state.reattachTimer = setTimeout(() => {
          attachToPage(choosePage(), 'page_closed').catch(() => {});
        }, 100);
      }
    });
    await cdp.send('Page.startScreencast', screencastOptionsFor(session.viewport));
    state.started = true;
    state.lastFrameAt = Date.now();
    session.liveFrameMode = 'cdp';
    try {
      session.broadcast?.({
        type: 'browser.stream',
        sessionId: session.id,
        mode: 'cdp_screencast',
        status: 'running',
        reason,
        ts: Date.now(),
      });
    } catch (_) {}
    return true;
  };

  const scheduleAttach = (page, reason) => {
    clearTimeout(state.reattachTimer);
    state.reattachTimer = setTimeout(() => {
      attachToPage(page || choosePage(), reason).catch(() => {});
    }, 100);
  };

  const bindContext = (ctx) => {
    try {
      ctx.on('page', (page) => scheduleAttach(page, 'new_page'));
    } catch (_) {}
  };

  try { bindContext(ownerContext); } catch (_) {}
  try {
    for (const ctx of monitorBrowser?.contexts?.() || []) bindContext(ctx);
  } catch (_) {}

  state.pageScanTimer = setInterval(() => {
    if (state.stopping || session.closed) return;
    const page = choosePage();
    if (!page) return;
    const url = pageUrl(page);
    if (page !== state.page || url !== state.lastPageUrl) {
      attachToPage(page, 'page_scan').catch(() => {});
      return;
    }
    if (state.started && state.lastFrameAt && Date.now() - state.lastFrameAt > 3000) {
      attachToPage(page, 'frame_stall').catch(() => {});
    }
  }, 500);

  let page = choosePage();
  if (!page) {
    try {
      if (typeof ownerContext?.newPage === 'function') {
        page = await require('./actionExecutionGateway').dispatchBrowserMutation({
          session,
          mutationName: 'playwright_context_new_page',
          args: { reason: 'cdp_screencast_initial_attach' },
          actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'screencast-new-page'),
          source: 'cdp_screencast',
          dispatch: () => ownerContext.newPage(),
        });
      }
    } catch (_) {}
  }
  return attachToPage(page, 'initial');
}

async function stopCdpScreencast(session) {
  const state = session?.cdpScreencast;
  if (!state) return;
  state.stopping = true;
  clearTimeout(state.reattachTimer);
  clearInterval(state.pageScanTimer);
  const cdp = state.cdp;
  state.cdp = null;
  await bestEffortWithin('cdp_stop_screencast', () => cdp?.send?.('Page.stopScreencast'), 1000);
  await bestEffortWithin('cdp_detach', () => cdp?.detach?.(), 1000);
  session.cdpScreencast = null;
  if (session.liveFrameMode === 'cdp') session.liveFrameMode = null;
}

/**
 * Parse Project.contextViewport ("{width:1920,height:1080}" or
 * '{"width":...}') into a {width, height} object. Returns null on
 * garbage so the caller falls back to the default.
 */
function parseProjectViewport(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.width === 'number' && typeof v.height === 'number'
        && v.width > 0 && v.height > 0) return { width: v.width, height: v.height };
  } catch (_) {}
  return null;
}

// Resolve the @playwright/mcp CLI path once at module load so spawn() can find it.
// The package's `exports` field only allows '.' and './package.json' subpaths,
// so we resolve via package.json and join 'cli.js' manually.
let MCP_CLI_PATH = null;
function resolveMcpCliPath() {
  if (MCP_CLI_PATH) return MCP_CLI_PATH;
  try {
    const pkgPath = require.resolve('@playwright/mcp/package.json');
    const cliPath = path.join(path.dirname(pkgPath), 'cli.js');
    if (!fs.existsSync(cliPath)) {
      throw new Error(`cli.js not found at ${cliPath}`);
    }
    MCP_CLI_PATH = cliPath;
    return MCP_CLI_PATH;
  } catch (err) {
    const e = new Error(`@playwright/mcp not installed: ${err.message}`);
    e.code = 'MCP_MISSING';
    throw e;
  }
}

function loadSdk() {
  try {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    return { Client, StdioClientTransport };
  } catch (err) {
    const e = new Error(`@modelcontextprotocol/sdk not installed: ${err.message}`);
    e.code = 'MCP_SDK_MISSING';
    throw e;
  }
}

/**
 * Build CLI args for the @playwright/mcp subprocess based on our config.
 *
 * @param {object} opts
 * @returns {string[]}
 */
function buildMcpCliArgs({ viewport, headless, isolated, userDataDir, caps, noSandbox, cdpEndpoint } = {}) {
  const args = [];
  // Browser channel — the alpha Playwright accepts 'chrome' / 'firefox' / 'webkit' / 'msedge';
  // omit to get the bundled Chromium build.
  // `--isolated` keeps the profile in memory (no disk persistence).
  if (cdpEndpoint) {
    args.push('--cdp-endpoint', cdpEndpoint);
  } else if (isolated && !userDataDir) {
    args.push('--isolated');
  }
  if (!cdpEndpoint && userDataDir) { args.push('--user-data-dir', userDataDir); }
  if (!cdpEndpoint && viewport?.width && viewport?.height) {
    args.push('--viewport-size', `${viewport.width}x${viewport.height}`);
  }
  // Confirmed live on this host (2026-08-06): Playwright's bundled Chromium
  // build crashes on launch in headed mode with exit code 3221225477
  // (0xC0000005 access violation) — reproduced directly via
  // chromium.launchPersistentContext, independent of this CLI. Because this
  // function never passed --browser, every headed MCP session has been
  // launching bundled Chromium, crashing immediately, with no visible
  // window — while the session kept working because CDP screencast/action
  // execution degrades gracefully. --browser chrome selects the system
  // Chrome binary, which launches headed cleanly on this host (also
  // confirmed live) and is what launchLiveCdpBrowser already uses for the
  // screencast-observer browser above; this brings the actual
  // automation-driving browser in line with it. The CLI's own --headless
  // flag was also never being passed, so an explicit headless=true request
  // had no effect on this subprocess either.
  if (headless === true) {
    args.push('--headless');
  } else {
    args.push('--browser', 'chromium');
  }
  args.push('--no-sandbox');
  args.push('--image-responses', 'allow');
  args.push('--snapshot-mode', 'full');
  // Keep accessibility snapshots in the JSON-RPC response. Recent MCP builds
  // can otherwise choose file-backed output and expose a resource before its
  // contents are durable, leaving the conductor with an empty snapshot while
  // the connected browser DOM is already ready.
  args.push('--output-mode', 'stdout');
  // Slow SPAs need more than the 5 s default.
  args.push('--timeout-action', '30000');
  return args;
}

/**
 * Start an MCP session by spawning @playwright/mcp as a stdio subprocess.
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.targetUrl]      Initial URL to navigate to (best-effort)
 * @param {object} [opts.viewport]       { width, height }
 * @param {string} [opts.userDataDir]    Optional persistent profile path
 * @param {function} [opts.broadcast]    (msg) => void — for frame events and logs
 * @param {string[]} [opts.extraCaps]    Extra capabilities beyond core (vision, pdf, devtools)
 * @param {object}  [opts.project]       Project row — drives browser context
 *                                       configuration (Phase E10.5). When omitted,
 *                                       the session boots with MCP defaults +
 *                                       auto-accept dialogs.
 * @returns {Promise<object>} session
 */
async function startMcpSession({
  userId,
  targetUrl,
  viewport,
  userDataDir,
  broadcast,
  extraCaps,
  project,
  authorityMode = 'legacy',
} = {}) {
  const cliPath = resolveMcpCliPath();
  const { Client, StdioClientTransport } = loadSdk();
  const projectViewport = parseProjectViewport(project?.contextViewport);
  const vp = projectViewport || viewport || { width: 1280, height: 720 };

  // Generate a stable session id BEFORE the context-config call so the
  // downloads dir + init-script paths are deterministic.
  const sessionId = crypto.randomBytes(8).toString('hex');

  // Phase E10.5 — browser context configuration. Adds CLI args + writes
  // a per-session init-script with locale / geo / color-scheme / fetch
  // header / dialog shims as needed. Always sets --output-dir so the
  // downloads watcher has a known location to poll.
  let contextExtras = { cliArgs: [], initScriptPath: null, downloadsDir: null };
  try {
    contextExtras = mcpContextConfig.buildContextArgs(project || {}, { id: sessionId });
  } catch (err) {
    // Bad project config shouldn't prevent the session — log and continue
    // with MCP defaults.
    try {
      (broadcast || (() => {}))({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `[mcp] browser context config failed: ${err.message} — booting with defaults`,
      });
    } catch (_) {}
  }

  let liveCdp = null;
  try {
    liveCdp = await launchLiveCdpBrowser({
      sessionId,
      viewport: vp,
      userDataDir,
      project,
      contextExtras,
      broadcast: broadcast || (() => {}),
    });
  } catch (err) {
    console.error(`[mcp] launchLiveCdpBrowser failed for session ${sessionId}:`, err);
    try {
      (broadcast || (() => {}))({
        type: 'agent.phase.log',
        phase: 'conductor',
        level: 'warn',
        message: `[mcp] live CDP screencast unavailable (${err.code || err.message}); falling back to screenshot polling`,
      });
    } catch (_) {}
    liveCdp = null;
  }

  // #32 — resolve the non-portable knobs ONCE so we can both apply them and
  // honestly report the resulting posture. Defaults preserve the validated local
  // lane (headed, no-sandbox on corp laptops, permissive TLS for corp MITM); each
  // is overridable by a named env flag for a portable host.
  const noSandbox = envFlag('QAAI_MCP_NO_SANDBOX') || envFlag('PLAYWRIGHT_MCP_NO_SANDBOX');
  // Project.contextHeadless (explicit per-project toggle, Test Cases page)
  // takes priority when set; null falls back to the env default (headed).
  let headlessFromConfig = null;
  if (typeof project?.contextHeadless === 'boolean') {
    headlessFromConfig = project.contextHeadless;
  } else if (project?.triggerConfigJson) {
    try {
      const parsed = JSON.parse(project.triggerConfigJson);
      if (typeof parsed?.contextHeadless === 'boolean') headlessFromConfig = parsed.contextHeadless;
    } catch (_) {}
  }
  const headless = typeof headlessFromConfig === 'boolean'
    ? headlessFromConfig
    : (envFlag('QAAI_MCP_HEADLESS') || envFlag('PLAYWRIGHT_MCP_HEADLESS') || false);
  const tlsRejectUnauthorized = resolveTlsRejectUnauthorized();

  const args = [
    cliPath,
    ...buildMcpCliArgs({
      viewport: vp,
      headless,
      // Gate on the actual endpoint, not just a truthy liveCdp object — a
      // liveCdp launch that returned without a usable endpoint previously
      // fell through with neither --cdp-endpoint nor --isolated nor
      // --user-data-dir set at all, so Playwright's CLI defaulted to its
      // own shared, persistent profile (ms-playwright/mcp-chrome-<hash>,
      // reused across every session on this machine). That profile can
      // collide with the operator's own already-running Chrome via
      // Chrome's single-instance lock, silently opening the automation as
      // a background tab in the operator's own window instead of a
      // distinguishable one — reproduced live on this host. `--isolated`
      // guarantees an in-memory, never-persisted, never-shared profile.
      isolated: !userDataDir && !liveCdp?.endpoint,
      userDataDir: liveCdp?.endpoint ? null : userDataDir,
      cdpEndpoint: liveCdp?.endpoint || null,
      caps: Array.isArray(extraCaps) && extraCaps.length ? extraCaps : ['vision', 'pdf', 'devtools'],
      // --no-sandbox helps on corp laptops where EDR/AV blocks sandboxed launches.
      // Safe in dev; do NOT enable for production multi-tenant scenarios.
      noSandbox,
    }),
    ...contextCliArgsForMcp({ cliArgs: contextExtras.cliArgs, usingLiveCdp: !!liveCdp }),
  ];

  // Emit an honest posture signal when this boot is non-portable (headed /
  // no-sandbox / TLS verification off) instead of silently relying on host
  // specifics. Pure-reporting — does not change the launch above.
  try {
    reportBrowserTopologyPosture({
      onLog: (level, message) => { try { (broadcast || (() => {}))({ type: 'agent.phase.log', phase: 'conductor', level, message }); } catch (_) {} },
      headless,
      noSandbox,
      tlsRejectUnauthorized,
    });
  } catch (_) { /* posture reporting must never block a session */ }

  // The MCP SDK's StdioClientTransport spawns the subprocess and pipes JSON-RPC
  // over stdin/stdout. The subprocess inherits NODE_TLS_REJECT_UNAUTHORIZED so
  // corp-proxy MITM doesn't kill Playwright's internal HTTPS calls (permissive by
  // default; set QAAI_MCP_TLS_STRICT=1 — or an explicit env value — for portable,
  // verified TLS).
  const subprocessEnv = {
    ...process.env,
    NODE_TLS_REJECT_UNAUTHORIZED: tlsRejectUnauthorized,
    // Suppress Playwright's own debug noise unless explicitly asked for.
    DEBUG: process.env.QAAI_MCP_DEBUG ? process.env.DEBUG : '',
  };

  const transport = new StdioClientTransport({
    command: process.execPath,   // current node binary
    args,
    env: subprocessEnv,
    stderr: 'pipe',
  });

  const client = new Client({ name: 'qaai-conductor', version: '2.0.0' }, { capabilities: {} });
  let toolList;
  try {
    await client.connect(transport);
  } catch (err) {
    try { await closeLiveCdpBrowser(liveCdp); } catch (_) {}
    throw err;
  }

  // Cache the tool list once — stable for the session lifetime.
  try {
    toolList = await client.listTools();
  } catch (err) {
    try { await closeLiveCdpBrowser(liveCdp); } catch (_) {}
    throw err;
  }

  const mcpSubprocessPid = transport._process?.pid ?? null;
  const mcpToolFingerprint = crypto.createHash('sha256')
    .update(JSON.stringify((toolList.tools || []).map((tool) => ({
      name: tool?.name || null,
      inputSchema: tool?.inputSchema || null,
    })).sort((left, right) => String(left.name).localeCompare(String(right.name)))))
    .digest('hex');
  const sessionCaptureRuntime = captureRuntimeDescriptor({
    sessionId,
    sessionStartedAt: new Date().toISOString(),
    mcpSubprocessPid,
    mcpCli: captureFileFingerprint(cliPath),
    mcpToolFingerprint,
    liveCdpEnabled: !!liveCdp,
    liveCdpEndpoint: liveCdp?.endpoint || null,
    runBindings: [],
    bindingAttempts: [],
  });

  const session = {
    id: sessionId,
    userId,
    client,
    transport,
    subprocessPid: mcpSubprocessPid,
    mcpCommand: process.execPath,
    mcpArgs: [...args],
    mcpSubprocessEnv: { ...subprocessEnv },
    mcpTransportRecovery: null,
    captureRuntime: sessionCaptureRuntime,
    captureRuntimeAudit: null,
    mcpTools: toolList.tools || [],
    viewport: vp,
    broadcast: broadcast || (() => {}),
    framePoller: null,
    framePollerPaused: false,
    framePollerInFlight: false,
    liveCdp,
    liveFrameMode: liveCdp ? 'cdp_pending' : 'poller',
    cdpScreencast: null,
    mcpScheduler: {
      chain: Promise.resolve(),
      active: null,
      pendingCount: 0,
      criticalQueued: 0,
    },
    closed: false,
    lastSnapshot: '',
    activeTransitionObservation: null,
    lastTransitionEvidence: null,
    activeTarget: null,
    transitionSequence: 0,
    // Phase E10.5 — context-config bookkeeping. The download watcher
    // polls `downloadsDir`; init-script path is held so we can unlink
    // it at session close.
    downloadsDir: contextExtras.downloadsDir,
    initScriptPath: contextExtras.initScriptPath,
    projectId: project?.id || null,
    // Phase H M4 — every URL the session has been at, normalized to its
    // path. Used by postLoopRatify's three-way disambiguation
    // (currentUrl vs visitedUrls vs neither) to distinguish
    // transient_window_missed (agent visited then moved on) from
    // agent_never_reached (target never appeared). Insertion sites are
    // every place callTool stamps session.currentUrl below — keep them
    // in lock-step or the comparison breaks.
    visitedUrls: new Set(),
    actionExecutionGatewayTrail: Array.isArray(liveCdp?.gatewayBootstrapTrail)
      ? [...liveCdp.gatewayBootstrapTrail]
      : [],
  };
  session.authorityMode = authorityMode === 'browser_transaction_controller'
    ? 'browser_transaction_controller'
    : 'legacy';
  if (session.authorityMode !== 'browser_transaction_controller') {
    require('./actionExecutionGateway').protectMcpSessionClient(session, { source: 'mcp_sdk_boundary' });
  }

  session.captureRuntimeAudit = inspectCaptureRuntime(session);
  try {
    session.broadcast({
      type: 'mcp.capture.runtime',
      sessionId,
      status: session.captureRuntimeAudit.status,
      buildFingerprint: CAPTURE_BUILD_FINGERPRINT,
      runtimeInstanceId: CAPTURE_RUNTIME_INSTANCE_ID,
      mcpSubprocessPid,
      mcpToolFingerprint,
      message: session.captureRuntimeAudit.current
        ? `Locator capture runtime ${CAPTURE_BUILD_FINGERPRINT.slice(0, 12)} is current for this browser session.`
        : `Locator capture runtime is stale or unidentified: ${session.captureRuntimeAudit.reasons.join(', ')}.`,
      ts: Date.now(),
    });
  } catch (_) {}

  if (liveCdp) {
    try {
      await startCdpScreencast(session);
    } catch (err) {
      session.liveFrameMode = 'poller';
      try {
        session.broadcast({
          type: 'agent.phase.log',
          phase: 'conductor',
          level: 'warn',
          message: `[mcp] live CDP screencast failed (${err.message}); falling back to screenshot polling`,
        });
      } catch (_) {}
    }
  }

  // Start the downloads watcher as soon as we have the session shell.
  // Safe to start before initial navigate — no downloads can fire yet.
  if (session.downloadsDir && session.projectId) {
    try {
      downloadWatcher.startWatcher(session, session.projectId);
    } catch (err) {
      try {
        session.broadcast({
          type: 'agent.phase.log', phase: 'conductor', level: 'warn',
          message: `[mcp] downloadWatcher start failed: ${err.message}`,
        });
      } catch (_) {}
    }
  }

  // Capture subprocess stderr to the broadcast channel — these are the real
  // Playwright/Chromium errors. The Critic and the Theater log both consume them.
  attachMcpStderr(session, transport);

  // Best-effort initial navigation. If the subprocess died during boot the
  // first callTool will reject — we surface and re-throw so the caller knows.
  if (targetUrl) {
    // Bootstrap through the Playwright context we already own when live CDP is
    // enabled. Some MCP builds can reach the URL but leave browser_navigate
    // waiting indefinitely on its response snapshot, blocking every later
    // action even though the DOM is ready. Authored actions still use MCP.
    let bootstrapNavigated = false;
    if (liveCdp?.context) {
      try {
        let page = liveCdp.context.pages()[0] || null;
        if (!page) {
          page = await require('./actionExecutionGateway').dispatchBrowserMutation({
            session,
            mutationName: 'playwright_context_new_page',
            args: { reason: 'initial_navigation' },
            actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'context-new-page'),
            source: 'mcp_initial_navigation',
            dispatch: () => liveCdp.context.newPage(),
          });
        }
        await require('./actionExecutionGateway').dispatchBrowserMutation({
          session,
          mutationName: 'playwright_page_goto',
          args: { url: targetUrl, waitUntil: 'domcontentloaded', timeout: 60_000 },
          actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'page-goto'),
          source: 'mcp_initial_navigation',
          dispatch: () => page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
        });
        session.currentUrl = page.url() || targetUrl;
        appendVisitedUrl(session, session.currentUrl);
        bootstrapNavigated = true;
      } catch (err) {
        session.broadcast({
          type: 'agent.phase.log', phase: 'conductor', level: 'warn',
          message: `Direct browser bootstrap navigation failed: ${err.message}; retrying through MCP.`,
        });
      }
    }
    try {
      if (!bootstrapNavigated) {
        await callTool(session, 'browser_navigate', { url: targetUrl }, { timeoutMs: 60_000 });
      }
    } catch (err) {
      session.broadcast({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `MCP initial navigate failed: ${err.message}`,
      });
    }
  }

  return session;
}

/**
 * Stop the MCP session cleanly. Closes the client, which terminates the
 * subprocess. The frame poller is stopped first to prevent racing tool calls.
 */
async function stopMcpSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
  stopFramePoller(session);
  await stopCdpScreencast(session);
  // Phase E10.5 — stop the downloads watcher and unlink the init-script
  // BEFORE killing the subprocess so we don't race on file handles.
  try { downloadWatcher.stopWatcher(session); } catch (_) {}
  try {
    mcpContextConfig.cleanupContextArtifacts({
      initScriptPath: session.initScriptPath,
      downloadsDir: session.downloadsDir,
      // Keep the downloads dir on disk — the Download rows reference it
      // and Reports needs to serve the bytes. Periodic cleanup is a
      // separate concern handled by the reaper.
      keepDownloads: true,
    });
  } catch (_) {}
  await bestEffortWithin('mcp_client_close', () => session.client?.close?.(), 2000);
  // StdioClientTransport.close() kills the subprocess for us. Belt and braces:
  await bestEffortWithin('mcp_transport_close', () => session.transport?.close?.(), 2000);
  await closeLiveCdpBrowser(session.liveCdp);
  // Force-kill the whole process tree (node MCP subprocess → Chromium → GPU/renderer workers).
  // Transport.close() shuts the stdio pipe which should terminate the node subprocess, but
  // Chrome child processes are often detached and survive the pipe closure on Windows.
  // taskkill /T kills the entire tree rooted at the MCP node subprocess PID.
  const pid = session.subprocessPid;
  if (pid) {
    try {
      if (process.platform === 'win32') {
        require('child_process').spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 5000 });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch (_) {}
  }
}

/**
 * Invoke an MCP tool. Returns the raw MCP CallToolResult
 * (`{ content: [...], isError?: boolean }`).
 *
 * NEVER throws on tool errors — those come back as `result.isError = true`
 * with the failure message in `content`. Throws only on transport-level
 * failures (client disconnected, etc.).
 */
// ─────────────────────────────────────────────────────────────────────────
// Phase F.3 — Tool argument normalisation.
//
// Why this exists: across every blocked/failed case in the May-26 run, the
// dominant turn-waster wasn't the browser or the model — it was the agent
// passing `target` strings in formats the MCP backend's CSS parser doesn't
// understand. Concretely:
//
//   • target: "ref=e59"               → "Unknown engine 'ref'"
//   • target: 'button "Login"'        → "Unexpected token while parsing CSS"
//   • target: '[ref=e132], textbox..' → "does not match any elements"
//
// Each failure cost 1–2 turns (retry on every browser_click / browser_type /
// browser_fill_form) and in a 12-turn budget that's catastrophic. The agent
// learned mid-case to retry with plain CSS, but the budget was already gone.
//
// Fix: deterministically translate the agent's freeform target before it
// reaches MCP. Three transformations, all best-effort and reversible:
//
//   1. `ref=eN` or `[ref=eN]` → set args.ref = "eN", drop the bad target.
//      MCP accepts ref as a first-class arg and prefers it over target.
//   2. `role "name"` → look up the matching `[ref=eX]` line in the cached
//      snapshot, set args.ref = "eX". Falls back to `role:has-text("name")`
//      CSS if no snapshot row matches.
//   3. Compound CSS containing `[ref=eN]` → strip the [ref=...] part and use
//      the cleaned selector + lift the ref to args.ref.
//
// Logged so the Theater shows when normalisation fired — operators can see
// whether the agent's raw or the normaliser's selector was used.
// ─────────────────────────────────────────────────────────────────────────
function _findRefInSnapshot(snapshotText, role, name) {
  if (!snapshotText || !role) return null;
  const escapedName = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Snapshot lines: `- button "Login" [ref=e59]` or `- textbox "Username" [ref=e62 cursor=text]`
  // Match the role token at the start of an indented "- " bullet, optional
  // quoted name (single or double quotes), then anywhere on the line a
  // `[ref=X]` marker.
  const lines = String(snapshotText).split(/\r?\n/);
  const tryPatterns = [];
  if (name) {
    tryPatterns.push(new RegExp(`^\\s*-\\s+${role}\\s+["']${escapedName}["'].*?\\[ref=([^\\]\\s]+)\\]`, 'i'));
  }
  // Role-only fallback (use when only one ref of that role exists)
  tryPatterns.push(new RegExp(`^\\s*-\\s+${role}\\b.*?\\[ref=([^\\]\\s]+)\\]`, 'i'));
  for (const re of tryPatterns) {
    const matches = [];
    for (const line of lines) {
      const m = line.match(re);
      if (m) matches.push(m[1]);
    }
    if (matches.length === 1) return matches[0]; // unique match wins
    if (matches.length > 1 && name) return matches[0]; // disambiguated by name
  }
  return null;
}

function _normaliseTarget(target, role, name, snapshotText) {
  if (typeof target !== 'string' || !target.length) {
    return { target, ref: undefined, transformed: false };
  }
  // 1. `ref=eN` (whole target)
  let m = /^\s*ref=([A-Za-z0-9_-]+)\s*$/.exec(target);
  if (m) return { target: undefined, ref: m[1], transformed: true, reason: 'ref-prefix' };
  // 2. `[ref=eN]` standalone
  m = /^\s*\[ref=([A-Za-z0-9_-]+)\]\s*$/.exec(target);
  if (m) return { target: undefined, ref: m[1], transformed: true, reason: 'ref-bracket' };
  // 3. Compound CSS with `[ref=eN]` mixed in (e.g. "textbox[placeholder='X'], [ref=e132]")
  m = /\[ref=([A-Za-z0-9_-]+)\]/.exec(target);
  if (m) {
    const ref = m[1];
    const cleaned = target
      .replace(/,\s*\[ref=[^\]]+\]/g, '')
      .replace(/\[ref=[^\]]+\]\s*,?/g, '')
      .replace(/^\s*,|,\s*$/g, '')
      .trim();
    return { target: cleaned || undefined, ref, transformed: true, reason: 'ref-mixed' };
  }
  // 4. `role "name"` style (e.g. `button "Login"`, `textbox "Username"`)
  m = /^\s*([a-z][a-z_-]*)\s+["']([^"']+)["']\s*$/i.exec(target);
  if (m) {
    const r = m[1].toLowerCase();
    const n = m[2];
    const ref = _findRefInSnapshot(snapshotText, r, n);
    if (ref) {
      return { target: undefined, ref, transformed: true, reason: 'role-name-resolved' };
    }
    // No snapshot match — emit a :has-text fallback that usually works.
    return {
      target: `${r}:has-text("${n.replace(/"/g, '\\"')}")`,
      ref: undefined,
      transformed: true,
      reason: 'role-name-fallback',
    };
  }
  return { target, ref: undefined, transformed: false };
}

function attachMcpStderr(session, transport) {
  if (!transport?.stderr || typeof transport.stderr.on !== 'function') return;
  transport.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (!text.trim()) return;
    try {
      session.broadcast?.({
        type: 'agent.phase.log', phase: 'conductor', level: 'info',
        message: `[mcp.stderr] ${text.trim().slice(0, 600)}`,
      });
    } catch (_) {}
  });
}

async function recoverMcpTransport(session, reason = 'transport_timeout') {
  if (!session || session.closed) return false;
  if (session.mcpTransportRecovery) return session.mcpTransportRecovery;

  session.mcpTransportRecovery = (async () => {
    const oldClient = session.client;
    const oldTransport = session.transport;
    const oldPid = session.subprocessPid;

    await bestEffortWithin('mcp_recovery_client_close', () => oldClient?.close?.(), 1000);
    await bestEffortWithin('mcp_recovery_transport_close', () => oldTransport?.close?.(), 1500);
    if (oldPid && process.platform === 'win32') {
      try {
        require('child_process').spawnSync(
          'taskkill', ['/T', '/F', '/PID', String(oldPid)], { timeout: 3000 },
        );
      } catch (_) {}
    }

    let client;
    let transport;
    let toolList;
    if (typeof session.mcpTransportFactory === 'function') {
      ({ client, transport, toolList } = await session.mcpTransportFactory());
    } else {
      const { Client, StdioClientTransport } = loadSdk();
      transport = new StdioClientTransport({
        command: session.mcpCommand || process.execPath,
        args: Array.isArray(session.mcpArgs) ? [...session.mcpArgs] : [],
        env: { ...(session.mcpSubprocessEnv || process.env) },
        stderr: 'pipe',
      });
      client = new Client({ name: 'qaai-conductor', version: '2.0.0' }, { capabilities: {} });
      try {
        await requiredWithin('mcp_recovery_connect', () => client.connect(transport), 8000);
        toolList = await requiredWithin('mcp_recovery_list_tools', () => client.listTools(), 5000);
      } catch (error) {
        const replacementPid = transport?._process?.pid ?? null;
        await bestEffortWithin('mcp_failed_recovery_client_close', () => client?.close?.(), 1000);
        await bestEffortWithin('mcp_failed_recovery_transport_close', () => transport?.close?.(), 1000);
        if (replacementPid && process.platform === 'win32') {
          try {
            require('child_process').spawnSync(
              'taskkill', ['/T', '/F', '/PID', String(replacementPid)], { timeout: 3000 },
            );
          } catch (_) {}
        }
        throw error;
      }
    }

    session.client = client;
    if (session.authorityMode !== 'browser_transaction_controller') {
      require('./actionExecutionGateway').protectMcpSessionClient(session, { source: 'mcp_recovered_sdk_boundary' });
    }
    session.transport = transport;
    session.subprocessPid = transport._process?.pid ?? null;
    session.mcpTools = toolList.tools || [];
    attachMcpStderr(session, transport);
    try {
      session.broadcast?.({
        type: 'agent.phase.log', phase: 'conductor', level: 'warn',
        message: `Recovered the browser tool transport after ${reason}; the authenticated browser page was preserved.`,
      });
    } catch (_) {}
    return true;
  })();

  try {
    return await session.mcpTransportRecovery;
  } finally {
    session.mcpTransportRecovery = null;
  }
}

function _toolRequiresInputField(session, toolName, fieldName) {
  if (!Array.isArray(session?.mcpTools) || !toolName || !fieldName) return false;
  const tool = session.mcpTools.find((candidate) => candidate?.name === toolName);
  return Array.isArray(tool?.inputSchema?.required)
    && tool.inputSchema.required.includes(fieldName);
}

function _bridgeRequiredExactTarget(toolName, args, session, notes) {
  if (!_toolRequiresInputField(session, toolName, 'target')) return args;
  if (typeof args?.target === 'string' && args.target.trim()) return args;
  const ref = typeof args?.ref === 'string' ? args.ref.trim() : '';
  // Playwright MCP snapshot refs are `eN` in the main frame and `fNeN` in a
  // child frame. Never promote narration or a loose selector into the exact
  // target channel: only a ref emitted by the snapshot is transport-safe.
  if (!/^(?:f\d+)?e\d+$/.test(ref)) return args;
  notes.push(`${toolName} target: required-schema-exact-ref`);
  return { ...args, target: ref };
}

function normaliseToolArgs(toolName, args, session) {
  if (!args || typeof args !== 'object') return { args, notes: [] };
  const notes = [];
  const snap = session?.lastSnapshot || '';

  // browser_fill_form has args.fields[] — normalise each field's target
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    const newFields = args.fields.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const out = { ...f };
      const norm = _normaliseTarget(f.target, f.type || null, f.name || null, snap);
      if (norm.transformed) {
        if (norm.ref) out.ref = norm.ref;
        if (norm.target !== undefined) out.target = norm.target; else delete out.target;
        notes.push(`field "${f.name || f.element || '?'}": ${norm.reason}`);
      }
      return out;
    });
    return { args: { ...args, fields: newFields }, notes };
  }

  // Single-target tools (browser_click, browser_type, browser_hover, etc.)
  let singleTargetArgs = args;
  if (typeof args.target === 'string') {
    const norm = _normaliseTarget(args.target, null, args.element || null, snap);
    if (norm.transformed) {
      const out = { ...args };
      if (norm.ref) out.ref = norm.ref;
      if (norm.target !== undefined) out.target = norm.target; else delete out.target;
      notes.push(`${toolName} target: ${norm.reason}`);
      singleTargetArgs = out;
    }
  }
  singleTargetArgs = _bridgeRequiredExactTarget(toolName, singleTargetArgs, session, notes);
  return { args: singleTargetArgs, notes };
}

let _actionLocatorResolver = null;
function getActionLocatorResolver() {
  if (!_actionLocatorResolver) {
    // Lazy-load to avoid a module-load cycle: actionLocatorResolver imports
    // mcp.js helpers, while mcp.js only needs the resolver at call time.
    _actionLocatorResolver = require('./actionLocatorResolver');
  }
  return _actionLocatorResolver;
}

function locatorEvidenceRequiredForTool(toolName, args = {}) {
  try {
    if (!browserMutationTaxonomy.TARGET_CAPABLE_MUTATION_TOOLS.has(toolName)) return false;
    if (toolName === 'browser_press_key' || toolName === 'browser_scroll') {
      return !!String(args.ref || args.target || args.element || args.label || args.name || '').trim();
    }
    return true;
  }
  catch (_) { return false; }
}

function strictActionEvidenceEnabled(session, options = {}, toolName = null, args = {}) {
  // Locator-bearing actions may come from the model, project-memory fast path,
  // deterministic retry, or healing recovery. None of those callers may opt
  // out of action-time evidence; a missing capture is recorded as a gap and the
  // live action still dispatches. The false override remains meaningful only
  // for non-element utility calls such as validation snapshots/evaluations.
  if (locatorEvidenceRequiredForTool(toolName, args)) return true;
  if (options?.strictActionEvidence === false) return false;
  if (session?.strictActionEvidence === false) return false;
  if (session?.strictActionEvidence === true) return true;
  const raw = String(process.env.QAAI_STRICT_ACTION_EVIDENCE ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function actionEvidenceElementLabel(toolName, args = {}) {
  if (toolName === 'browser_fill_form' && Array.isArray(args.fields)) {
    return args.fields
      .map((field, index) => String(field?.element || field?.label || field?.name || field?.placeholder || field?.type || `field ${index + 1}`).trim())
      .filter(Boolean)
      .join(', ')
      .slice(0, 240) || 'form fields';
  }
  return String(args.element || args.label || args.name || args.placeholder || args.role || args.target || args.ref || toolName).trim().slice(0, 240);
}

function actionEvidenceRefreshAttempts(session) {
  const raw = Number(session?.actionEvidenceRefreshAttempts ?? process.env.QAAI_ACTION_EVIDENCE_REFRESH_ATTEMPTS ?? 3);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(8, Math.floor(raw)));
}

async function acquireVerifiedActionEvidence(session, toolName, args, evidenceContext = {}) {
  const resolver = getActionLocatorResolver();
  if (!locatorEvidenceRequiredForTool(toolName, args)) return { required: false, ok: true };
  const { pageUrlBeforeCall } = evidenceContext;
  const actionIdentity = actionBindingIdentity(evidenceContext);
  const elementLabel = actionEvidenceElementLabel(toolName, args);
  const pageUrl = session?.currentUrl || pageUrlBeforeCall || null;
  const maxAttempts = actionEvidenceRefreshAttempts(session);
  let lastResult = null;
  let refreshed = false;

  for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 0 && session?.client) {
      try {
        await _refreshSnapshot(session);
        refreshed = true;
      } catch (_) {}
    }
    const snapshotText = session?.lastSnapshot || '';
    try {
      lastResult = await resolver.resolveVerifiedForTool({
        session,
        toolName,
        args: args || {},
        snapshotText,
        pageUrl,
        elementLabel,
        ...actionIdentity,
      });
    } catch (err) {
      lastResult = {
        ok: false,
        actionLocator: null,
        diagnostic: null,
        gap: {
          code: 'locator_resolver_exception',
          where: toolName,
          detail: String(err && err.message || err).slice(0, 300),
          hasSnapshot: !!snapshotText,
          pageUrl,
          elementLabel,
        },
      };
    }
    if (lastResult?.ok && resolver.isVerifiedActionLocator(lastResult.actionLocator)) {
      return {
        required: true,
        ok: true,
        actionLocator: lastResult.actionLocator,
        attempts: attempt + 1,
        refreshed,
        pageUrl,
        elementLabel,
        actionIdentity,
      };
    }
  }

  return {
    required: true,
    ok: false,
    attempts: maxAttempts + 1,
    refreshed,
    pageUrl,
    elementLabel,
    actionIdentity,
    diagnostic: lastResult?.diagnostic || null,
    gap: lastResult?.gap || {
      code: 'missing_verified_action_locator',
      where: toolName,
      detail: 'QAAI did not obtain browser-side verified same-element locator evidence before dispatch.',
      hasSnapshot: !!(session?.lastSnapshot),
      pageUrl,
      elementLabel,
    },
  };
}

const BACKGROUND_SCREENSHOT_TIMEOUT_MS = Math.max(500, Math.min(10_000, Number(process.env.QAAI_BACKGROUND_SCREENSHOT_TIMEOUT_MS) || 2_000));
const AUDIT_SCREENSHOT_TIMEOUT_MS = Math.max(1_000, Math.min(15_000, Number(process.env.QAAI_AUDIT_SCREENSHOT_TIMEOUT_MS) || 5_000));
// Validation reads must be fast and bounded. This timeout applies only to the
// single fresh snapshot an assertion may request after its cached action-time
// snapshot misses; it never shortens a mutating browser action.
const VALIDATION_SNAPSHOT_TIMEOUT_MS = Math.max(250, Math.min(5_000, Number(process.env.QAAI_VALIDATION_SNAPSHOT_TIMEOUT_MS) || 1_200));

function getMcpScheduler(session) {
  if (!session.mcpScheduler) {
    session.mcpScheduler = {
      chain: Promise.resolve(),
      active: null,
      pendingCount: 0,
      criticalQueued: 0,
    };
  }
  return session.mcpScheduler;
}

function skippedMcpResult(reason, { name, lane, source } = {}) {
  return {
    isError: true,
    qaaiSkipped: true,
    qaaiBackgroundSkipped: lane === 'background',
    qaaiSkipReason: reason,
    content: [{
      type: 'text',
      text: `QAAI_BACKGROUND_SKIPPED: ${reason}${source ? ` (${source})` : ''}${name ? ` for ${name}` : ''}`,
    }],
  };
}

function noteSkippedMcp(session, payload) {
  try {
    session?.telemetry?.recordTool?.({
      tool: payload.name || 'mcp_background',
      input: payload.input || {},
      ok: false,
      isError: true,
      elapsedMs: 0,
      pageUrlBefore: session?.currentUrl || null,
      pageUrlAfter: session?.currentUrl || null,
      snapshotText: '',
      domFacts: null,
      stability: null,
      errorPreview: `skipped:${payload.reason || 'busy'}`,
      qaaiLane: payload.lane || null,
      qaaiSource: payload.source || null,
    });
  } catch (_) {}
}

async function runScheduledMcp(session, { name, lane = 'critical', skipIfBusy = false, source = null, telemetry = true } = {}, fn) {
  const scheduler = getMcpScheduler(session);
  const effectiveLane = lane === 'background' ? 'background' : 'critical';
  if (effectiveLane === 'background' && skipIfBusy && (scheduler.active || scheduler.pendingCount > 0 || scheduler.criticalQueued > 0)) {
    if (telemetry) noteSkippedMcp(session, { name, lane: effectiveLane, source, reason: 'critical_or_mcp_busy' });
    return skippedMcpResult('critical_or_mcp_busy', { name, lane: effectiveLane, source });
  }

  const isCritical = effectiveLane !== 'background';
  if (isCritical) scheduler.criticalQueued += 1;
  scheduler.pendingCount += 1;
  let queued = true;

  const run = async () => {
    if (isCritical && queued) {
      scheduler.criticalQueued = Math.max(0, scheduler.criticalQueued - 1);
      queued = false;
    }
    scheduler.active = effectiveLane;
    try {
      return await fn();
    } finally {
      scheduler.active = null;
      scheduler.pendingCount = Math.max(0, scheduler.pendingCount - 1);
      if (isCritical && queued) {
        scheduler.criticalQueued = Math.max(0, scheduler.criticalQueued - 1);
        queued = false;
      }
    }
  };

  const next = scheduler.chain.then(run, run);
  scheduler.chain = next.catch(() => {});
  return await next;
}

function buildMcpRequestOptions(session, timeoutMs) {
  const baseSignal = session?.cancelSignal || null;
  const ms = Number(timeoutMs);
  if (!baseSignal && (!Number.isFinite(ms) || ms <= 0)) {
    return { requestOptions: undefined, cleanup: () => {} };
  }
  const controller = new AbortController();
  let timer = null;
  const abortFromBase = () => {
    try { controller.abort(baseSignal?.reason || new Error('MCP call cancelled')); } catch (_) { controller.abort(); }
  };
  if (baseSignal) {
    if (baseSignal.aborted) abortFromBase();
    else baseSignal.addEventListener('abort', abortFromBase, { once: true });
  }
  if (Number.isFinite(ms) && ms > 0) {
    timer = setTimeout(() => {
      try { controller.abort(new Error(`MCP call timed out after ${ms}ms`)); } catch (_) { controller.abort(); }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }
  // Hand the MCP SDK its OWN `timeout` so it does NOT fall back to its built-in
  // 60s default (the source of transient `MCP error -32001: Request timed out`
  // on slow SPA navigations — the click had navigated, but the SDK gave up
  // at 60s). This is a HARD per-call cap: every call ends in ≤ms.
  // NOTE: deliberately NO `resetTimeoutOnProgress` — it resets the clock on each
  // subprocess progress ping, so a call that keeps "progressing" can wait
  // FOREVER. That hung run finalization (browser never closed, output files
  // never generated) after the case had already passed. A plain hard timeout
  // can never hang.
  const sdkRequestOptions = { signal: controller.signal };
  if (Number.isFinite(ms) && ms > 0) {
    sdkRequestOptions.timeout = ms;
  }
  return {
    requestOptions: sdkRequestOptions,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (baseSignal) {
        try { baseSignal.removeEventListener('abort', abortFromBase); } catch (_) {}
      }
    },
  };
}

async function callTool(session, name, args, options = {}) {
  if (!session?.client) {
    const e = new Error('MCP session not connected');
    e.code = 'MCP_NO_SESSION';
    throw e;
  }
  if (session.executionGatewayRequired === true) {
    const gateway = require('./actionExecutionGateway').defaultGateway;
    if (browserMutationTaxonomy.isMutatingTool(name, args || {}) && !options.executionPermit) {
      session.actionExecutionGatewaySequence = (Number(session.actionExecutionGatewaySequence) || 0) + 1;
      return gateway.dispatchMcpTool({
        callTool,
        session,
        toolName: name,
        args: args || {},
        options,
        actionOccurrenceId: options.actionOccurrenceId
          || `mcp:${session.id || 'session'}:${name}:${session.actionExecutionGatewaySequence}`,
        source: options.source || 'mcp_call_boundary',
      });
    }
    const gatewayAuthorization = gateway.authorizeMcpCall({
      session,
      toolName: name,
      args: args || {},
      permit: options.executionPermit || null,
    });
    if (gatewayAuthorization.mutating) {
      options = { ...options, _gatewaySdkAuthorization: gatewayAuthorization.permit };
    }
  }
  const lane = options.lane === 'background' ? 'background' : 'critical';
  return runScheduledMcp(session, {
    name,
    lane,
    skipIfBusy: options.skipIfBusy === true,
    source: options.source || null,
    telemetry: options.telemetry !== false,
  }, () => callToolInner(session, name, args, options));
}

async function callToolInner(session, name, args, options = {}) {
  if (!session?.client) {
    const e = new Error('MCP session not connected');
    e.code = 'MCP_NO_SESSION';
    throw e;
  }
  // Phase E2.1 — `assertion_check` is a SYNTHETIC tool. Instead of round-
  // tripping to the MCP subprocess (which doesn't know about it), the
  // server fabricates the response from the cached snapshot. Verifies a
  // declared assertion against the live page accessibility tree. Used by
  // the Conductor to ratify "RESULT: pass" claims BEFORE end_turn, so a
  // hallucinated success can self-correct mid-run instead of being caught
  // post-hoc by the Critic.
  if (name === 'assertion_check') {
    const result = await checkAssertion(session, args || {});
    // Don't update lastSnapshot — this tool reads cache, doesn't refresh it.
    // Phase H M2 — when QAAI_ASSERTION_V2 is on, augment the response with
    // the structured `outcome` field so the agent reads the three-outcome
    // contract (matched | not_matched | uncheckable). Legacy `matched` field
    // is preserved for backward compat with any caller that hasn't been
    // updated. The M4 mechanical verdict reads `outcome`; legacy code paths
    // continue reading `matched`. No-op when the flag is off.
    if (isAssertionV2Enabled()) {
      return augmentWithOutcome(result);
    }
    return result;
  }
  // Synthetic browser_extract_data — cross-case data chaining sprint Day 1.
  // Runs the supplied JS expression via the real browser_evaluate tool,
  // validates the result is a primitive, writes through to the current-case
  // scratch + durable Run.sharedData (via session.persistSharedData if
  // bound by the conductor).
  if (name === 'browser_extract_data') {
    return await extractData(session, args || {});
  }
  const callStartedAt = Date.now();
  // Pause frame polling while a "real" tool is in flight — otherwise polled
  // screenshots compete with the tool call and we get flaky responses.
  session.framePollerPaused = true;
  // If a prior browser_evaluate mutated the DOM without producing a snapshot
  // (session.snapshotDirty), refresh the snapshot BEFORE we resolve targets or
  // validate refs for an action tool — otherwise name-resolution and the
  // stale-ref guard below would run against a snapshot that no longer matches
  // the live page. Only costs a round-trip in the rare dirty case.
  // Pre-dispatch quiescence gate. If a prior DOM-mutating action/evaluate may
  // have left the page mid-re-render (snapshotDirty), bring the snapshot + ref
  // map to a SETTLED state BEFORE we resolve targets or run the stale-ref guard
  // for a ref-consuming tool. Otherwise the guard judges against a TRANSITIONAL
  // map — the old [ref] is already gone (guard fires) but the re-rendered
  // element isn't painted yet (self-heal finds nothing) → reject → the agent
  // loops on a dead ref. (This was the root cause of the "empty password"
  // step_failed: type into a React field → next action's ref was stale and the
  // map hadn't settled.) For non-ref STABILITY tools a single refresh suffices;
  // when the page is in stability-downgrade mode (a live ticker/animation that
  // never settles) we take one fresh snapshot rather than burn the settle budget.
  const _consumesRefs = ACTION_REF_TOOLS.has(name) || !!TOOL_ROLE_RULES[name] || name === 'browser_fill_form';
  if (session.snapshotDirty && session?.client && (STABILITY_TOOLS.has(name) || _consumesRefs)) {
    if (_consumesRefs && !session.stabilityDowngraded) {
      try { await _waitForStableSnapshot(session, Date.now() + STABILITY_COMPARISON_DELAY_MS * 3); }
      catch (_) { try { await _refreshSnapshot(session); } catch (__) {} }
    } else {
      await _refreshSnapshot(session);
    }
    session.snapshotDirty = false;
  }
  // Phase F.3 — normalise the agent's freeform target strings into formats
  // the MCP backend accepts BEFORE invoking. See normaliseToolArgs comment
  // for the three transformations. Best-effort; on no-op the original args
  // pass through unchanged.
  const norm = normaliseToolArgs(name, args || {}, session);
  const callArgs = norm.args;
  const pageUrlBeforeCall = session.currentUrl || null;
  const captureRuntimeAudit = inspectCaptureRuntime(session);
  session.captureRuntimeAudit = captureRuntimeAudit;
  if (captureRuntimeAudit.stale && session.captureRuntimeWarningFingerprint !== captureRuntimeAudit.reasons.join('|')) {
    session.captureRuntimeWarningFingerprint = captureRuntimeAudit.reasons.join('|');
    try {
      session.broadcast?.({
        type: 'mcp.capture.runtime.stale',
        sessionId: session.id,
        tool: name,
        status: captureRuntimeAudit.status,
        reasons: captureRuntimeAudit.reasons,
        expectedBuildFingerprint: captureRuntimeAudit.expectedBuildFingerprint,
        observedBuildFingerprint: captureRuntimeAudit.observed?.buildFingerprint || null,
        message: `Browser action is continuing, but locator evidence will record a stale-runtime diagnostic: ${captureRuntimeAudit.reasons.join(', ')}.`,
        ts: Date.now(),
      });
    } catch (_) {}
  }
  let preDispatchActionEvidence = null;
  if (norm.notes && norm.notes.length) {
    try {
      session.broadcast?.({
        type: 'mcp.args.normalised',
        sessionId: session.id,
        tool: name,
        notes: norm.notes,
        ts: Date.now(),
      });
    } catch (_) {}
  }
  // ── Pre-dispatch role/tool validation ────────────────────────────────
  //
  // Catch known incompatibilities BEFORE the MCP round-trip. The validator
  // looks up each target ref in session.refRoleMap (built lazily from
  // session.lastSnapshot — refreshed after every snapshot-producing tool)
  // and rejects browser_type on a non-typeable role, etc. The rejection
  // shape mirrors a real MCP error so the conductor's existing error
  // pathway (consecutive_errors, diagnoseToolError, Critic) all work
  // unchanged.
  //
  // Generic rule: role/tool incompatibility is deterministic — there's
  // nothing the MCP backend can tell us that the snapshot doesn't already
  // say. Rejecting pre-dispatch saves a wasted browser action AND the
  // wasted turn the agent would have spent reading the rejection from MCP.
  // Lazy-build the map if a prior snapshot landed before this feature
  // existed (or if a code path bypassed the explicit refresh).
  if ((TOOL_ROLE_RULES[name] || name === 'browser_fill_form' || TOOL_ACTIONABILITY_RULES[name])
      && !session.refRoleMap && session.lastSnapshot) {
    session.refRoleMap = buildRefRoleMap(session.lastSnapshot);
  }
  if (TOOL_ROLE_RULES[name] || name === 'browser_fill_form') {
    const wrapperRetarget = retargetGenericWrapperForTool(session, name, callArgs);
    if (wrapperRetarget?.rewrites?.length) {
      try {
        session.broadcast?.({
          type: 'mcp.args.normalised',
          sessionId: session.id,
          tool: name,
          notes: wrapperRetarget.rewrites.map((r) => `retargeted ${r.from} -> ${r.to} (${r.role})`),
          ts: Date.now(),
        });
      } catch (_) {}
    }
    const validation = validateRoleForTool(session, name, callArgs);
    if (validation) {
      try {
        session.broadcast?.({
          type: 'mcp.args.rejected',
          sessionId: session.id,
          tool: name,
          ref: validation.ref,
          role: validation.role,
          suggestedTool: validation.suggestedTool,
          reason: validation.reason || 'role_mismatch',
          actionability: validation.actionability || null,
          ts: Date.now(),
        });
      } catch (_) {}
      session.framePollerPaused = false;
      return {
        isError: true,
        content: [{ type: 'text', text: `### Error ${validation.errorText}` }],
        qaaiPreDispatchRejection: {
          reason: validation.reason || 'role_mismatch',
          ref: validation.ref,
          role: validation.role,
          name: validation.name || null,
          actionability: validation.actionability || null,
        },
      };
    }
  }
  // ── Pre-dispatch stale-ref guard (element IDENTITY) ───────────────────
  // Prefer re-resolving by the element's NAME against the current snapshot;
  // only reject (forcing a re-snapshot) when the name is ambiguous. This is
  // what makes ROLE+NAME the real targeting path and stops the agent from
  // clicking a stale ref after a menu/dialog opened or the page redirected.
  if (ACTION_REF_TOOLS.has(name)) {
    // ── Phase 2: container retarget for click/hover/drag ────────────────────
    // type/select were already retargeted above (TOOL_ROLE_RULES path). Clicks
    // were NOT — so a click whose ref landed on a generic wrapper or the page
    // root would dispatch on the container and "click a random nearby element."
    // Descend to the UNIQUE interactive child when one exists. If the generic is
    // ITSELF the clickable target (a custom-widget trigger with no interactive
    // child), findUniqueChildRefByRole returns null and the ref is left alone —
    // so legitimate nameless-div dropdown triggers keep working.
    if (!TOOL_ROLE_RULES[name] && name !== 'browser_fill_form') {
      const cretarget = retargetGenericWrapperForTool(session, name, callArgs);
      if (cretarget?.rewrites?.length) {
        try {
          session.broadcast?.({
            type: 'mcp.args.normalised', sessionId: session.id, tool: name,
            notes: cretarget.rewrites.map((r) => `retargeted container ${r.from} -> ${r.to} (${r.role})`),
            ts: Date.now(),
          });
        } catch (_) {}
      }
    }
    if (name === 'browser_hover') {
      const hoverRetarget = retargetHoverIconToTrigger(session, callArgs);
      if (hoverRetarget?.rewrites?.length) {
        try {
          session.broadcast?.({
            type: 'mcp.args.normalised', sessionId: session.id, tool: name,
            notes: hoverRetarget.rewrites.map((r) => `retargeted hover icon ${r.from} -> ${r.to} (${r.role})`),
            ts: Date.now(),
          });
        } catch (_) {}
      }
    }
    // Staleness-triggered quiescence (the real fix for the looping retry).
    // If the agent targets a [ref] that is NOT in the current map, the page has
    // re-rendered (or a PRIOR action was rejected — a rejection is an early
    // return that never marks the snapshot dirty, so a naive dirty-gated settle
    // would skip and the agent would reject the same dead ref forever). Settle +
    // rebuild the map HERE, keyed off the actual staleness signal, so the guard's
    // self-heal resolves against the live DOM. Only fires when the ref is missing
    // (the normal fresh-ref path pays nothing); single snapshot under downgrade.
    const _stRef = _extractRefToken(callArgs);
    if (_stRef && session?.client && session.refRoleMap instanceof Map
        && session.refRoleMap.size >= 3 && !session.refRoleMap.has(_stRef)) {
      try {
        if (!session.stabilityDowngraded) await _waitForStableSnapshot(session, Date.now() + STABILITY_COMPARISON_DELAY_MS * 3);
        else await _refreshSnapshot(session);
        session.snapshotDirty = false;
      } catch (_) { /* fall through — guard will reject with re-snapshot guidance */ }
    }
    const guard = guardActionRef(session, name, callArgs);
    if (guard?.heal) {
      callArgs.ref = guard.heal;
      if (typeof callArgs.target === 'string' && /^(e\d+|ref[-_].+)$/i.test(callArgs.target.trim())) delete callArgs.target;
      try {
        session.broadcast?.({
          type: 'mcp.args.normalised', sessionId: session.id, tool: name,
          notes: [`retargeted stale [ref=${guard.staleRef}] → [ref=${guard.heal}] by name ("${callArgs.element || ''}")`],
          ts: Date.now(),
        });
      } catch (_) {}
    } else if (guard?.reject) {
      try {
        session.broadcast?.({ type: 'mcp.args.rejected', sessionId: session.id, tool: name, ref: guard.staleRef, reason: 'stale_ref', ts: Date.now() });
      } catch (_) {}
      session.framePollerPaused = false;
      return { isError: true, content: [{ type: 'text', text: `### Error Pre-dispatch validation: ${guard.errorText}` }] };
    }
  }

  // State-based actionability is independent from role compatibility. Run it
  // after stale-ref/name retargeting so the state belongs to the ref that will
  // actually be dispatched, but before locator-evidence work or the MCP call.
  if (TOOL_ACTIONABILITY_RULES[name]) {
    const validation = validateActionabilityForTool(session, name, callArgs);
    if (validation) {
      try {
        session.broadcast?.({
          type: 'mcp.args.rejected',
          sessionId: session.id,
          tool: name,
          ref: validation.ref,
          role: validation.role,
          suggestedTool: validation.suggestedTool,
          reason: validation.reason,
          actionability: validation.actionability,
          ts: Date.now(),
        });
      } catch (_) {}
      session.framePollerPaused = false;
      return {
        isError: true,
        content: [{ type: 'text', text: `### Error ${validation.errorText}` }],
        qaaiPreDispatchRejection: {
          reason: validation.reason,
          ref: validation.ref,
          role: validation.role,
          name: validation.name || null,
          actionability: validation.actionability,
        },
      };
    }
  }
  // Cancellation — if the user terminated the run, do NOT dispatch another
  // browser action. The conductor breaks its loop on the next turn; this stops
  // a queued tool call from firing in the gap and keeps cancel feeling instant.
  if (strictActionEvidenceEnabled(session, options, name, callArgs)) {
    try {
      preDispatchActionEvidence = await acquireVerifiedActionEvidence(session, name, callArgs, {
        pageUrlBeforeCall,
        ...actionEvidenceIdentity(callArgs, options),
      });
    } catch (err) {
      preDispatchActionEvidence = {
        required: locatorEvidenceRequiredForTool(name, callArgs),
        ok: false,
        gap: {
          code: 'locator_evidence_gate_exception',
          where: name,
          detail: String(err && err.message || err).slice(0, 300),
          pageUrl: pageUrlBeforeCall,
          elementLabel: actionEvidenceElementLabel(name, callArgs),
        },
      };
    }
    if (preDispatchActionEvidence?.required) {
      session.lastActionEvidence = preDispatchActionEvidence;
      if (preDispatchActionEvidence.refreshed
          && (TOOL_ROLE_RULES[name] || name === 'browser_fill_form' || TOOL_ACTIONABILITY_RULES[name])) {
        const validation = validateRoleForTool(session, name, callArgs)
          || validateActionabilityForTool(session, name, callArgs);
        if (validation) {
          try {
            session.broadcast?.({
              type: 'mcp.args.rejected',
              sessionId: session.id,
              tool: name,
              ref: validation.ref,
              role: validation.role,
              suggestedTool: validation.suggestedTool,
              reason: 'role_validation_after_evidence_refresh',
              validationReason: validation.reason || 'role_mismatch',
              actionability: validation.actionability || null,
              ts: Date.now(),
            });
          } catch (_) {}
          session.framePollerPaused = false;
          return {
            isError: true,
            content: [{ type: 'text', text: `### Error ${validation.errorText}` }],
            qaaiPreDispatchRejection: {
              reason: validation.reason || 'role_mismatch',
              ref: validation.ref,
              role: validation.role,
              name: validation.name || null,
              actionability: validation.actionability || null,
            },
          };
        }
      }
      if (!preDispatchActionEvidence.ok) {
        // Locator evidence is capture metadata, not permission to execute. Keep the
        // gap for Reports/codegen, but dispatch the browser action so a missing
        // verified locator never pre-emptively skips this step or its descendants.
        try {
          session.broadcast?.({
            type: 'mcp.locator.evidence.warning',
            sessionId: session.id,
            tool: name,
            gap: preDispatchActionEvidence.gap || null,
            message: 'QAAI is continuing with the live action and will emit an editable guessed locator if DOM evidence remains unavailable.',
            ts: Date.now(),
          });
        } catch (_) {}
      }
    }
  }

  if (session.cancelSignal?.aborted) {
    session.framePollerPaused = false;
    return { isError: true, content: [{ type: 'text', text: 'Cancelled by user — tool dispatch skipped.' }] };
  }
  try {
    // Pass the cancel signal as a RequestOptions arg so an in-flight MCP
    // round-trip (e.g. a slow navigation on a heavy SUT) is aborted the moment
    // the user clicks Terminate. The MCP SDK accepts { signal } as the third
    // arg; older SDKs ignore the extra arg harmlessly.
    // Default a GENEROUS per-request timeout for navigation/mutating tools so a
    // slow SUT doesn't trip the SDK's 60s default mid-action
    // (the -32001 "Request timed out" that looked like a failure even though the
    // click had navigated). 90s comfortably covers the 30s action-timeout + page
    // settle + any queue wait; resetTimeoutOnProgress (above) extends it while
    // the call is genuinely still progressing. Screenshots/snapshots keep their
    // explicit (shorter) timeouts; only fill in a default when none was given.
    const SLOW_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
    const STANDARD_TOOL_DEFAULT_TIMEOUT_MS = Number(process.env.QAAI_MCP_TOOL_TIMEOUT_MS) || 30_000;
    const effectiveTimeoutMs = (options.timeoutMs != null)
      ? options.timeoutMs
      : (ACTION_REF_TOOLS.has(name) || name === 'browser_navigate' || name === 'browser_fill_form' || name === 'browser_click' || name === 'browser_type' || name === 'browser_select_option'
        ? SLOW_TOOL_DEFAULT_TIMEOUT_MS
        : STANDARD_TOOL_DEFAULT_TIMEOUT_MS);
    const { requestOptions, cleanup } = buildMcpRequestOptions(session, effectiveTimeoutMs);
    let transitionObservation = null;
    if (PAGE_TRANSITION_ACTION_TOOLS.has(name) && options.observeTransition !== false) {
      transitionObservation = await armPageTransitionObservation(session, {
        toolName: name,
        waitContract: options.waitContract || null,
      });
    }
    let result;
    try {
      if (
        name === 'browser_evaluate'
        && options.source === 'field_blocked_probe'
        && typeof callArgs.function === 'string'
      ) {
        // Enforce the platform contract at the browser-dispatch boundary: a
        // writable field passes this probe only when post-probe readback is
        // exactly equal to its pre-probe value. The rewritten probe also
        // restores the original value after any mutation.
        callArgs.function = hardenFieldBlockedProbeSource(callArgs.function);
      }
      const sdkRequestOptions = options._gatewaySdkAuthorization
        ? require('./actionExecutionGateway').defaultGateway.markSdkCallAuthorized(requestOptions, {
          session,
          authorization: options._gatewaySdkAuthorization,
        })
        : requestOptions;
      const sdkCall = session.client.callTool(
        { name, arguments: callArgs || {} },
        undefined,
        sdkRequestOptions,
      );
      // The SDK timeout and AbortSignal are advisory to some MCP builds. Keep
      // an independent wall-clock boundary so a subprocess call can never hold
      // the critical scheduler lane forever after the browser has already
      // reached a usable state.
      let hardTimer = null;
      const hardTimeout = new Promise((_, reject) => {
        hardTimer = setTimeout(() => {
          const error = new Error(`MCP ${name} exceeded the hard ${effectiveTimeoutMs}ms boundary.`);
          error.code = 'MCP_HARD_TIMEOUT';
          reject(error);
        }, effectiveTimeoutMs);
      });
      sdkCall.catch(() => {});
      try {
        result = await Promise.race([sdkCall, hardTimeout]);
      } finally {
        if (hardTimer) clearTimeout(hardTimer);
      }
      if (transitionObservation) {
        transitionObservation.dispatchedAt = Date.now();
        transitionObservation.actionError = result?.isError === true;
        transitionObservation.actionResultReceived = true;
        result.qaaiTransitionArm = transitionObservationPublicView(transitionObservation);
      }
    } catch (dispatchError) {
      if (transitionObservation) {
        transitionObservation.dispatchedAt = Date.now();
        transitionObservation.actionError = true;
        transitionObservation.dispatchError = String(dispatchError?.message || dispatchError || 'browser action dispatch failed');
      }
      if (dispatchError?.code === 'MCP_HARD_TIMEOUT') {
        try {
          await recoverMcpTransport(session, `${name}_hard_timeout`);
        } catch (recoveryError) {
          dispatchError.mcpRecoveryError = String(recoveryError?.message || recoveryError);
          try {
            session.broadcast?.({
              type: 'agent.phase.log', phase: 'conductor', level: 'error',
              message: `Browser tool transport recovery failed after ${name}: ${dispatchError.mcpRecoveryError}`,
            });
          } catch (_) {}
        }
      }
      throw dispatchError;
    } finally {
      cleanup();
    }
    stampCaptureRuntime(result, session, captureRuntimeAudit);
    if (preDispatchActionEvidence?.ok && preDispatchActionEvidence.actionLocator) {
      try {
        preDispatchActionEvidence.actionLocator = await captureAuthoritativePostAction(
          session,
          preDispatchActionEvidence.actionLocator,
          { pageUrl: session?.currentUrl || pageUrlBeforeCall || null },
        );
      } catch (_) {
        // CDP post-state is supplemental evidence. The already verified MCP
        // locator remains valid when Chromium capture is unavailable.
      }
      result.qaaiActionLocator = preDispatchActionEvidence.actionLocator;
      const cdpBundles = authoritativeCaptureBundles(preDispatchActionEvidence.actionLocator);
      result.qaaiActionEvidence = {
        status: 'verified_pre_dispatch',
        toolName: name,
        attempts: preDispatchActionEvidence.attempts || 1,
        refreshed: !!preDispatchActionEvidence.refreshed,
        pageUrl: preDispatchActionEvidence.pageUrl || pageUrlBeforeCall || null,
        elementLabel: preDispatchActionEvidence.elementLabel || actionEvidenceElementLabel(name, callArgs),
        captureRuntime: result.qaaiCaptureRuntime,
        authoritativeCdp: cdpBundles.length
          ? {
              status: 'captured',
              source: 'chromium_cdp',
              backendNodeIds: cdpBundles.map((bundle) => bundle.pre?.backendNodeId).filter(Boolean),
              captures: cdpBundles,
            }
          : { status: 'unavailable_or_not_captured', source: 'chromium_cdp' },
      };
    } else if (preDispatchActionEvidence?.required) {
      const gap = {
        ...(preDispatchActionEvidence.gap || {
          code: 'missing_verified_action_locator',
          where: name,
          detail: 'The action dispatched without a verified same-element locator capture.',
        }),
        captureRuntimeStatus: captureRuntimeAudit.status,
        captureBuildFingerprint: result.qaaiCaptureRuntime?.buildFingerprint || null,
        captureRuntimeInstanceId: result.qaaiCaptureRuntime?.runtimeInstanceId || null,
      };
      result.actionLocatorGap = gap;
      result.qaaiActionEvidence = {
        status: 'locator_capture_gap',
        toolName: name,
        attempts: preDispatchActionEvidence.attempts || 0,
        refreshed: !!preDispatchActionEvidence.refreshed,
        pageUrl: preDispatchActionEvidence.pageUrl || pageUrlBeforeCall || null,
        elementLabel: preDispatchActionEvidence.elementLabel || actionEvidenceElementLabel(name, callArgs),
        gap,
        diagnostic: preDispatchActionEvidence.diagnostic || null,
        captureRuntime: result.qaaiCaptureRuntime,
      };
    }
    if (!result?.isError && name === 'browser_hover') {
      const hoverText = options.hoverExpectedText || options.hoverTooltipText || callArgs.tooltipText || callArgs.expectedTooltip || '';
      const visualObservation = await acquireTooltipVisualObservation(session, {
        expectedText: hoverText,
        callArgs,
      });
      const tooltipCapture = authoritativePreCaptures(preDispatchActionEvidence?.actionLocator)[0] || {};
      const tooltipEvidence = await captureTooltipEvidence({
        observationKind: 'tooltip',
        expectedText: hoverText,
        visualObservation,
      }, tooltipCapture, null);
      result.qaaiTooltipVisualObservation = visualObservation;
      result.tooltipEvidence = tooltipEvidence;
      if (visualObservation?.observed) {
        result.qaaiHoverPreview = {
          source: 'browser_evaluate_visual_observation',
          expectedText: hoverText || null,
        };
        if (visualObservation.details?.ok === true) {
          result.qaaiHoverTooltip = visualObservation.details;
        }
      }
    }
    // Cache the snapshot text on the session so the inline Critic (and the
    // synthetic assertion_check) can read it without burning another tool call.
    //
    // CRITICAL (Phase F.3 fix): ONLY snapshot-producing tools should update
    // lastSnapshot. Previously every tool's text response was cached as if it
    // were a snapshot — so calling browser_network_requests or browser_evaluate
    // between browser_snapshot and assertion_check would overwrite the page
    // snapshot with a network log, and assertion_check would substring-search
    // the network log for page text. That's why the agent kept reporting
    // "assertion_check seems to have trouble reading the current page" while
    // the alert text was visibly present on screen.
    let txt = textOfContent(result?.content);
    // Phase H Stage 1.3 — Snapshot stability check. For tools that CHANGE
    // visual state (click, type, fill_form, navigate, etc., but NOT
    // browser_snapshot itself), the @playwright/mcp-returned snapshot is
    // captured at action-complete time — Playwright's contract is "click
    // dispatched" not "navigation finished". So a click that triggers a
    // 200-500ms redirect returns a snapshot of the pre-redirect page.
    // The agent then reasons over a transitional state and burns turns.
    //
    // We close that gap deterministically here: take the first snapshot,
    // sleep 200ms, re-snapshot, compare structurally. If the page is
    // settled (matching shape), accept. Cap at 3 iterations / 1.5s total.
    //
    // Escape hatch: pages with live feeds / tickers / animation always
    // burn the cap. After 3 consecutive cap-hits in one case we downgrade
    // to single-snapshot mode for the rest of that case (the conductor
    // resets these counters at runOneCase start). Without this guardrail
    // dashboard-style cases would regress in wall-clock time.
    let stabilityRecord = null;
    let cappedThisCall = false; // did THIS call fail to settle within budget? (Fix 1.3 — per-call, not latched)
    // Mark II — recoverable downgrade. The downgrade-to-single-snapshot was
    // meant for ONE pathological page (live ticker/animation that never
    // settles), but it latched for the WHOLE case and was only reset at
    // runOneCase start — so one slow page (e.g. a dashboard) permanently
    // disabled settling for every later page, re-introducing stale refs. A
    // navigation is a brand-new page: give settling another chance.
    // Stabilise for any state-changing tool AND for an explicit browser_snapshot
    // (Fix 1.2 — the agent's "look" must return a SETTLED tree, not a mid-render
    // one; stabiliseSnapshot re-snaps via the RAW client so this does not recurse).
    // Fix 1.3 — the whole-case "downgrade to single-snapshot" latch is REMOVED:
    // with the interactive-skeleton settle (normaliseForStability), dynamic pages
    // settle on their controls, so one briefly-busy page no longer disables
    // settling for the rest of the case (which is what cascaded into stale refs).
    // Each call settles up to the budget INDEPENDENTLY; a cap only flags THIS
    // call's refs as possibly-transient (note appended below), never latches.
    // A validation-only explicit snapshot may opt out of the additional
    // stability cycle because the immediately preceding action already
    // supplied the cached, stabilised snapshot. Scope this escape hatch to
    // browser_snapshot itself: passing the option to click/navigate/select can
    // never bypass their post-action stabilisation.
    const shouldStabiliseSnapshot = STABILITY_TOOLS.has(name)
      || (name === 'browser_snapshot' && options.skipSnapshotStability !== true);
    if (txt && !result?.isError && shouldStabiliseSnapshot) {
      const stableResult = await stabiliseSnapshot(session, txt, name);
      stabilityRecord = stableResult.record;
      txt = stableResult.txt;
      cappedThisCall = !!stableResult.record.capped;
      try { if (cappedThisCall) session.telemetry?.noteStabilityCapHit(); } catch (_) {}
    }
    if (txt && SNAPSHOT_PRODUCING_TOOLS.has(name) && isSnapshotText(txt)) {
      session.lastSnapshot = txt;
      session.lastSnapshotOriginatingTool = name;
      session.lastSnapshotCapturedAt = Date.now();
      // Refresh the ref→role map so the next tool call's pre-dispatch
      // validator has the freshest ground truth. Cheap (single regex
      // pass over the snapshot text). Built lazily on first use otherwise.
      session.refRoleMap = buildRefRoleMap(txt);
      // ── ROOT FIX for stale-ref "wrong clicks" ──────────────────────────
      // The model MUST reason over the SAME settled, post-action snapshot we
      // just stored — not the raw, transitional one @playwright/mcp returned
      // at action-complete time. A click that triggers a redirect/AJAX returns
      // a snapshot whose [ref=eN] tokens are already stale; if the model sees
      // THAT, its next click lands on the wrong element. We computed the
      // stabilised tree above (stabiliseSnapshot) and kept it in
      // session.lastSnapshot — surface that exact text as the tool result so
      // the agent sees current reality. This is the seam that finally makes
      // the system prompt's promise true ("the click already includes the
      // fresh snapshot — you don't need to re-snapshot"). The conductor reads
      // result.content verbatim, so one assignment closes the whole gap.
      let outText = txt;
      if (cappedThisCall) {
        // THIS snapshot did not settle within the budget — warn the model the refs
        // may move (per-call only; settling stays ON for the next call).
        outText += '\n\n[note: this page did not settle within the snapshot budget, so element refs here may be transient. If a click seems to miss, call browser_snapshot and retarget by ROLE + NAME before retrying.]';
      }
      result.content = [{ type: 'text', text: outText }];
      // F.3 follow-up (2026-05-28 SauceDemo bug) — derive the freshest known
      // URL from the snapshot itself. Previously session.currentUrl was set
      // from browser_navigate's ARGS (pre-redirect URL) and only refreshed
      // via opportunistic browser_evaluate calls. SauceDemo's login redirect
      // (saucedemo.com → /inventory.html) and the post-logout redirect
      // (/inventory.html → /) exposed the gap: assertion_check read the
      // STALE pre-redirect URL and reported a regex miss against the page
      // the agent had actually landed on. The snapshot reflects the
      // post-stabilisation DOM, so its URL field is authoritative.
      const snapUrl = extractUrlFromSnapshot(txt);
      if (snapUrl) { session.currentUrl = snapUrl; appendVisitedUrl(session, snapUrl); }
      // Phase E1.4 — broadcast a truncated preview of the accessibility tree
      // so the Theater DOM-snapshot pane can render what the agent is
      // actually looking at. 8 KB is enough for the visible viewport on
      // typical SaaS pages; the picker / healer already operate on the
      // (untruncated) `lastSnapshot`. Best-effort — never throws.
      try {
        session.broadcast({
          type: 'mcp.snapshot.preview',
          sessionId: session.id,
          tool: name,
          snapshot: txt.slice(0, 8_000),
          truncated: txt.length > 8_000,
          length: txt.length,
          ts: Date.now(),
        });
      } catch (_) {}
    }
    // Phase F.3 — track the active page URL on the session so checkAssertion
    // can resolve expectedUrlPattern without regex-grepping the snapshot text.
    // The snapshot-derived URL above is the authoritative source (post-redirect);
    // this navigate-args setter is now a fallback for the rare case the
    // snapshot's URL extraction fails — DO NOT overwrite a snapshot URL with
    // the navigate-args URL (the navigate arg is what we ASKED for, the
    // snapshot is what we GOT).
    if (!result?.isError && name === 'browser_navigate' && callArgs?.url && !session.currentUrl) {
      session.currentUrl = String(callArgs.url);
      appendVisitedUrl(session, callArgs.url);
    }
    // Phase F.3 — opportunistic URL capture from browser_evaluate. Login
    // submissions, registration submissions, and other in-app navigations
    // happen WITHOUT calling browser_navigate, so session.currentUrl goes
    // stale immediately after. Across the May-26 traces every agent
    // self-recovered by calling browser_evaluate("() => window.location.href")
    // — so capture that return value here. Supports both bare-string returns
    // and structured returns ({ url: "..." }) so we catch the common
    // `() => ({ url: window.location.href, alertText: ... })` shape.
    if (!result?.isError && name === 'browser_evaluate' && callArgs?.function && /location\.(href|pathname)/.test(String(callArgs.function))) {
      const evalText = textOfContent(result?.content) || '';
      const parsed = (() => {
        try { return JSON.parse(evalText); } catch (_) { return null; }
      })();
      let captured = null;
      if (typeof parsed === 'string' && /^https?:\/\//.test(parsed)) captured = parsed;
      else if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string' && /^https?:\/\//.test(parsed.url)) captured = parsed.url;
      else if (/^"https?:\/\//.test(evalText)) {
        // Bare JSON-stringified URL from a `() => window.location.href` eval
        try { const s = JSON.parse(evalText); if (typeof s === 'string') captured = s; } catch (_) {}
      } else {
        // Last resort: any URL-shaped string in the response text
        const m = evalText.match(/https?:\/\/[^\s"'<>]+/);
        if (m) captured = m[0];
      }
      if (captured) { session.currentUrl = captured; appendVisitedUrl(session, captured); }
    }
    // Phase F.3.1 — cache the most recent browser_evaluate text response as
    // FALLBACK ASSERTION EVIDENCE. The natural agent pattern for dynamic
    // content (data tables, custom-rendered charts, virtualised lists,
    // shadow-DOM widgets) is: snapshot → browser_evaluate to extract DOM
    // text → assertion_check to verify. Today step 3 ignores step 2's
    // result and only searches the a11y snapshot — so a perfectly-valid
    // assertion against table cell text returns matched=false because the
    // table contents weren't surfaced in the snapshot. We cache the
    // evaluate result here (capped at 20 KB) so checkAssertion can use it
    // as a SECOND haystack. The agent doesn't need to know — it just
    // works.
    if (!result?.isError && name === 'browser_evaluate') {
      const evalText = textOfContent(result?.content) || '';
      if (evalText) session.lastEvaluateResult = evalText.slice(0, 20_000);
      // PATH 7 — browser_evaluate runs arbitrary JS that can mutate the DOM
      // but does NOT refresh the accessibility snapshot the assertion checker
      // reads. Flag the snapshot dirty so the next assertion_check refreshes
      // it before evaluating. Generic rule: tools that may mutate the page
      // without producing a snapshot mark the cached snapshot as stale.
      session.snapshotDirty = true;
    }
    // Clear the dirty flag when the snapshot has just been refreshed
    // (snapshot-producing tools updated session.lastSnapshot above).
    if (!result?.isError && SNAPSHOT_PRODUCING_TOOLS.has(name)) {
      session.snapshotDirty = false;
    }
    // …but a DOM-MUTATING action returns its snapshot at action-complete time,
    // which on an SPA is frequently still mid-re-render (or stabilisation was
    // downgraded on an animated page). Re-mark dirty so the NEXT ref-consuming
    // tool settles + rebuilds the map before the stale-ref guard runs. This is
    // the post-execution half of the quiescence fix — it deliberately overrides
    // the SNAPSHOT_PRODUCING clear above for mutators. (browser_snapshot is NOT
    // a mutator, so an explicit snapshot still clears dirty and is trusted.)
    if (!result?.isError && browserMutationTaxonomy.isMutatingTool(name, callArgs || {})) {
      session.snapshotDirty = true;
    }
    // Phase H Stage 0.5 — best-effort telemetry capture. Absent telemetry
    // recorder = no-op (preserves existing call paths). Never throws.
    try {
      if (session.telemetry && options.telemetry !== false) {
        const domFacts = extractDomFactsForTool(name, callArgs, session.lastSnapshot || '');
        session.telemetry.recordTool({
          tool: name,
          input: callArgs,
          ok: !result?.isError,
          isError: !!result?.isError,
          elapsedMs: Date.now() - callStartedAt,
          pageUrlBefore: pageUrlBeforeCall,
          pageUrlAfter: session.currentUrl || null,
          snapshotText: SNAPSHOT_PRODUCING_TOOLS.has(name) ? txt : '',
          domFacts,
          stability: stabilityRecord,
          errorPreview: result?.isError ? (textOfContent(result?.content) || '').slice(0, 600) : '',
          qaaiLane: options.lane || 'critical',
          qaaiSource: options.source || null,
        });
        if (preDispatchActionEvidence?.ok && preDispatchActionEvidence.actionLocator) {
          try {
            session.telemetry.annotateLastToolResult?.({
              actionLocator: preDispatchActionEvidence.actionLocator,
              actionLocatorKernel: {
                status: 'verified_pre_dispatch',
                attempts: preDispatchActionEvidence.attempts || 1,
                source: 'mcp_action_evidence_gate',
              },
            });
          } catch (_) {}
        }
      }
    } catch (_) {}
    return result;
  } finally {
    session.framePollerPaused = false;
  }
}

// Phase H Stage 1.3 — Snapshot stability primitives.
//
// STABILITY_TOOLS are the subset of SNAPSHOT_PRODUCING_TOOLS whose action
// can ACTUALLY change visual state (i.e. trigger navigation, mutate DOM,
// open a dialog, etc.). browser_snapshot itself is excluded because it's
// a read — calling it twice in a row never produces a stability mismatch
// for a real-page reason; including it would just double the snapshot
// cost on every explicit snapshot call.
// Tools that trigger post-action snapshot stability polling. These are tools
// whose side-effects include async DOM re-renders (navigation, click-triggered
// SPA transitions, dialog handling). browser_type and browser_fill_form are
// intentionally excluded: text entry is a synchronous DOM update, so stability
// polling adds 600ms+ overhead for no benefit. The session is still marked dirty
// via DOM_MUTATOR_TOOLS, so the NEXT ref-consuming tool will call
// _waitForStableSnapshot() before dispatch — any JS-triggered autocomplete or
// validation DOM changes from the type action are caught there instead.
const STABILITY_TOOLS = new Set([
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_click',
  'browser_press_key',
  'browser_select_option',
  'browser_handle_dialog',
  'browser_drag',
]);

const STABILITY_MAX_ITERATIONS = 3;        // initial snap + up to 3 re-snaps (Mark II: was 2)
const STABILITY_INTERVAL_MS = 150;         // tighter poll interval (was 200ms)
const STABILITY_TOTAL_BUDGET_MS = 1400;    // Mark II: was 900ms. Stale refs on slow
                                           // Angular SPAs (the #1 cause of "8/10
                                           // snapshots fail") come from snapshotting
                                           // before the DOM settles. Reliability > the
                                           // ~500ms; the user explicitly wants "not in a
                                           // hurry" over fast-but-wrong.
const STABILITY_CAP_HITS_BEFORE_DOWNGRADE = 3;

/**
 * Normalise a snapshot text for stability comparison. Strips digits,
 * timestamps, and other content that legitimately changes between
 * snapshots on the same logical page state (clock ticks, IDs, etc.) so
 * we don't burn the stability budget chasing a page that's actually
 * settled but has a live clock in the header.
 */
/**
 * Pull the active page URL out of a captured snapshot string. The snapshot
 * format varies by @playwright/mcp build — some emit "Page URL: …" headers,
 * others lead with the URL followed by " - Page Title: …". We try the most
 * specific formats first and fall back to any URL-shaped token last, while
 * skipping common XML/SVG namespace URLs that appear as attribute values in
 * the snapshot (the SauceDemo XSS case picked up "http://www.w3.org/2000/svg"
 * from an SVG icon's xmlns attribute when no fresh URL was set).
 * Returns null when no plausible page URL is found — callers should keep
 * their existing fallback (session.currentUrl) in that case.
 */
function extractUrlFromSnapshot(snap) {
  if (!snap || typeof snap !== 'string') return null;
  const headerMatch = snap.match(/Page URL:\s*(\S+)/i);
  if (headerMatch?.[1]) return headerMatch[1];
  const leadMatch = snap.match(/^(https?:\/\/[^\s]+)\s+-\s+Page Title:/);
  if (leadMatch?.[1]) return leadMatch[1];
  const candidates = snap.match(/https?:\/\/[^\s"'<>]+/g) || [];
  for (const u of candidates) {
    if (/^https?:\/\/(www\.)?w3\.org\//.test(u)) continue;
    if (/^https?:\/\/schemas\./.test(u)) continue;
    if (/^https?:\/\/purl\.org\//.test(u)) continue;
    if (/^https?:\/\/xmlns\./.test(u)) continue;
    return u;
  }
  return null;
}

// Roles that define a page's ACTIONABLE SKELETON + identity + load state. The
// stability diff (normaliseForStability) is computed over THESE lines ONLY — so a
// page is recognized as "settled" the moment its controls/structure are stable,
// regardless of volatile CONTENT (a ticking clock, a live feed, progressively-
// rendering charts, prose). A still-appearing control, an opening modal, or a
// loading spinner correctly keeps the page UNSETTLED (their roles ARE in this set).
// This is the fix for "dynamic dashboards never settle → cap → downgrade → stale
// refs": we diff the accessibility tree's actionable skeleton, not raw text.
const STABILITY_SKELETON_ROLES = new Set([
  // actionable controls
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'switch', 'slider', 'spinbutton', 'menu', 'menubar', 'tablist',
  // page identity / containers whose appearance or disappearance is meaningful
  // (a modal/dialog opening, nav changing, a heading defining the page)
  'heading', 'dialog', 'alertdialog', 'navigation', 'form', 'banner', 'main', 'search',
  // transition signals — while present, the page is legitimately NOT settled
  'progressbar', 'status', 'alert',
]);

// Project a snapshot to its stability key: role|name for each skeleton element,
// with volatile numerics/times normalised and the per-snapshot [ref=eN] DROPPED.
// Refs are renumbered by Playwright across snapshots, so including them would make
// an unchanged page look like it never settles. (The DELIVERED snapshot text is
// untouched — only the settle COMPARISON uses this projection.)
function normaliseForStability(text) {
  if (typeof text !== 'string') return '';
  const out = [];
  for (const rawLine of text.split('\n')) {
    const parsed = parseSnapshotLine(rawLine);
    const role = parsed && parsed.role ? String(parsed.role).toLowerCase() : '';
    if (!role || !STABILITY_SKELETON_ROLES.has(role)) continue;
    const name = String(parsed.name == null ? '' : parsed.name)
      .replace(/\d{1,4}-\d{1,2}-\d{1,2}[T\s]\d{1,2}:\d{1,2}(:\d{1,2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      .replace(/\b\d{1,2}:\d{1,2}(:\d{1,2})?\b/g, '<time>')
      .replace(/\b\d{4,}\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim();
    out.push(`${role}|${name}`);
  }
  return out.join('\n');
}

const PAGE_TRANSITION_ACTION_TOOLS = new Set([
  'browser_click',
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
]);
const TRANSITION_PAGE_IDS = new WeakMap();
let transitionPageSequence = 0;

function transitionPageId(page) {
  if (!page || (typeof page !== 'object' && typeof page !== 'function')) return null;
  if (!TRANSITION_PAGE_IDS.has(page)) TRANSITION_PAGE_IDS.set(page, `page-${++transitionPageSequence}`);
  return TRANSITION_PAGE_IDS.get(page);
}

function safeTransitionPageUrl(page) {
  try { return String(page?.url?.() || ''); } catch (_) { return ''; }
}

function transitionOrigin(url) {
  try { return new URL(String(url || '')).origin; } catch (_) { return ''; }
}

function usableTransitionPage(page) {
  if (!page) return false;
  try { if (page.isClosed()) return false; } catch (_) { return false; }
  return !/^(?:devtools|chrome|chrome-extension):/i.test(safeTransitionPageUrl(page));
}

function collectTransitionPages(session) {
  const pages = [];
  const seen = new Set();
  const add = (page) => {
    if (!usableTransitionPage(page) || seen.has(page)) return;
    seen.add(page);
    pages.push(page);
  };
  try {
    for (const page of session?.liveCdp?.context?.pages?.() || []) add(page);
  } catch (_) {}
  try {
    for (const context of session?.liveCdp?.monitorBrowser?.contexts?.() || []) {
      for (const page of context.pages()) add(page);
    }
  } catch (_) {}
  return pages;
}

function transitionPageRecord(page) {
  const url = safeTransitionPageUrl(page);
  return { pageId: transitionPageId(page), url, origin: transitionOrigin(url) };
}

function parseBrowserTabList(result) {
  const text = textOfContent(result?.content);
  const tabs = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const indexMatch = line.match(/(?:^|[-*]\s*|\bindex\s*[=:]\s*)(\d+)\s*(?::|\b)/i);
    const urlMatch = line.match(/https?:\/\/[^\s)\]}>"']+/i);
    if (!indexMatch) continue;
    tabs.push({
      index: Number(indexMatch[1]),
      url: urlMatch?.[0] || '',
      current: /\bcurrent\b/i.test(line),
      raw: line.slice(0, 500),
    });
  }
  return tabs;
}

async function rawTransitionTool(session, name, args = {}, timeoutMs = 2_000) {
  const { requestOptions, cleanup } = buildMcpRequestOptions(session, timeoutMs);
  let hardTimer = null;
  try {
    const sdkCall = session.client.callTool({ name, arguments: args }, undefined, requestOptions);
    sdkCall.catch(() => {});
    return await Promise.race([
      sdkCall,
      new Promise((_, reject) => {
        hardTimer = setTimeout(() => {
          const error = new Error(`MCP transition ${name} exceeded ${timeoutMs}ms.`);
          error.code = 'MCP_HARD_TIMEOUT';
          reject(error);
        }, Math.max(100, Number(timeoutMs) || 2000));
      }),
    ]);
  } catch (error) {
    if (error?.code === 'MCP_HARD_TIMEOUT') {
      try {
        await recoverMcpTransport(session, `${name}_transition_timeout`);
      } catch (recoveryError) {
        error.mcpRecoveryError = String(recoveryError?.message || recoveryError);
      }
    }
    throw error;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
    cleanup();
  }
}

async function listBrowserTabsForTransition(session, timeoutMs = 2_000) {
  try {
    const result = await rawTransitionTool(session, 'browser_tabs', { action: 'list' }, timeoutMs);
    return result?.isError ? [] : parseBrowserTabList(result);
  } catch (_) {
    return [];
  }
}

function cleanupTransitionObservation(observation) {
  if (!observation || observation.cleaned) return;
  observation.cleaned = true;
  clearTimeout(observation.cleanupTimer);
  for (const remove of observation.cleanupFns || []) {
    try { remove(); } catch (_) {}
  }
  observation.cleanupFns = [];
}

function transitionObservationPublicView(observation) {
  if (!observation) return null;
  return {
    transitionId: observation.transitionId,
    armedAt: observation.armedAt,
    dispatchedAt: observation.dispatchedAt || null,
    toolName: observation.toolName,
    baseline: observation.baseline,
    eventCount: observation.events?.length || 0,
  };
}

async function armPageTransitionObservation(session, options = {}) {
  if (!session || typeof session !== 'object') return null;
  cleanupTransitionObservation(session.activeTransitionObservation);
  const pages = collectTransitionPages(session);
  const baselineTabs = pages.length ? [] : await listBrowserTabsForTransition(session);
  const baselineSnapshot = String(session.lastSnapshot || '');
  const baselineUrl = String(session.currentUrl || extractUrlFromSnapshot(baselineSnapshot) || '');
  const observation = {
    version: 'TransitionObservationV1',
    transitionId: `${session.id || 'session'}-${++session.transitionSequence}`,
    toolName: String(options.toolName || ''),
    armedAt: Date.now(),
    dispatchedAt: null,
    actionError: false,
    actionResultReceived: false,
    events: [],
    cleanupFns: [],
    cleaned: false,
    baseline: {
      url: baselineUrl,
      origin: transitionOrigin(baselineUrl),
      fingerprint: normaliseForStability(baselineSnapshot),
      pages: pages.map(transitionPageRecord),
      tabIndexes: baselineTabs.map((tab) => tab.index),
      currentTabIndex: baselineTabs.find((tab) => tab.current)?.index ?? null,
    },
    waitContract: options.waitContract || null,
  };
  const attachPage = (page) => {
    if (!page) return;
    const onFrameNavigated = (frame) => {
      try { if (frame !== page.mainFrame()) return; } catch (_) { return; }
      observation.events.push({
        kind: 'main_frame_url_changed',
        pageId: transitionPageId(page),
        url: safeTransitionPageUrl(page),
        observedAt: Date.now(),
      });
    };
    try {
      page.on('framenavigated', onFrameNavigated);
      observation.cleanupFns.push(() => page.off('framenavigated', onFrameNavigated));
    } catch (_) {}
  };
  for (const page of pages) attachPage(page);
  const ownerContext = session?.liveCdp?.context;
  if (ownerContext?.on) {
    const onPage = (page) => {
      observation.events.push({
        kind: 'new_page',
        pageId: transitionPageId(page),
        url: safeTransitionPageUrl(page),
        observedAt: Date.now(),
      });
      attachPage(page);
    };
    try {
      ownerContext.on('page', onPage);
      observation.cleanupFns.push(() => ownerContext.off('page', onPage));
    } catch (_) {}
  }
  const budgetMs = Number(options.waitContract?.timeoutMs) || waitContract.DEFAULT_TIMEOUTS.navigation;
  observation.cleanupTimer = setTimeout(
    () => cleanupTransitionObservation(observation),
    Math.max(budgetMs + 5_000, 120_000),
  );
  if (typeof observation.cleanupTimer.unref === 'function') observation.cleanupTimer.unref();
  session.activeTransitionObservation = observation;
  return observation;
}

function fingerprintMateriallyChanged(before, after) {
  if (!before || !after || before === after) return false;
  const beforeSet = new Set(before.split('\n').filter(Boolean));
  const afterSet = new Set(after.split('\n').filter(Boolean));
  if (!beforeSet.size || !afterSet.size) return false;
  let common = 0;
  for (const item of beforeSet) if (afterSet.has(item)) common += 1;
  const union = new Set([...beforeSet, ...afterSet]).size;
  return union > 0 && (1 - common / union) >= 0.25;
}

async function selectObservedTransitionTarget(session, observation, pages, tabs, remainingMs) {
  const baselinePageIds = new Set((observation.baseline.pages || []).map((page) => page.pageId));
  const newPages = pages.filter((page) => !baselinePageIds.has(transitionPageId(page)));
  const liveCandidate = [...newPages].reverse().find((page) => {
    const url = safeTransitionPageUrl(page);
    return url && url !== 'about:blank';
  }) || newPages.at(-1) || null;
  const baselineTabs = new Set(observation.baseline.tabIndexes || []);
  const newTabs = tabs.filter((tab) => !baselineTabs.has(tab.index));
  let chosenTab = null;
  if (liveCandidate) {
    const candidateUrl = safeTransitionPageUrl(liveCandidate);
    const exact = tabs.filter((tab) => candidateUrl && tab.url === candidateUrl);
    if (exact.length === 1) chosenTab = exact[0];
  }
  if (!chosenTab && newTabs.length === 1) chosenTab = newTabs[0];
  if (!chosenTab) return { selected: false, page: liveCandidate, tab: null };
  try {
    const selected = await rawTransitionTool(
      session,
      'browser_tabs',
      { action: 'select', index: chosenTab.index },
      Math.max(250, Math.min(2_000, remainingMs)),
    );
    if (selected?.isError) return { selected: false, page: liveCandidate, tab: chosenTab };
    try {
      if (typeof liveCandidate?.bringToFront === 'function') {
        await require('./actionExecutionGateway').dispatchBrowserMutation({
          session,
          mutationName: 'playwright_page_bring_to_front',
          args: { tabIndex: chosenTab.index },
          actionOccurrenceId: gatewayInfrastructureOccurrence(session, 'page-bring-to-front'),
          source: 'page_transition_observer',
          dispatch: () => liveCandidate.bringToFront(),
        });
      }
    } catch (_) {}
    session.activeTarget = {
      tabIndex: chosenTab.index,
      pageId: liveCandidate ? transitionPageId(liveCandidate) : null,
      url: chosenTab.url || safeTransitionPageUrl(liveCandidate),
      reason: 'observed_new_page',
      observedAt: Date.now(),
    };
    return { selected: true, page: liveCandidate, tab: chosenTab };
  } catch (_) {
    return { selected: false, page: liveCandidate, tab: chosenTab };
  }
}

async function awaitPageTransitionObservation(session, options = {}) {
  let observation = session?.activeTransitionObservation || null;
  const destinationOnly = !observation;
  if (!observation) {
    observation = await armPageTransitionObservation(session, {
      toolName: 'page_ready_observation',
      waitContract: options.waitContract || null,
    });
  }
  if (!observation) {
    return {
      status: 'inconclusive',
      matched: null,
      qaaiEvidenceError: true,
      retryable: true,
      retryExhausted: true,
      reason: 'qaai_transition_observer_unavailable',
    };
  }
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? options.waitContract?.timeoutMs)
    || waitContract.DEFAULT_TIMEOUTS.navigation);
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs) || waitContract.POLL_INTERVAL_MS);
  const stableRequired = Math.max(1, Number(options.stableObservations) || waitContract.STABLE_OBSERVATIONS);
  const now = typeof options.qaaiNow === 'function' ? options.qaaiNow : Date.now;
  const sleep = typeof options.qaaiSleep === 'function'
    ? options.qaaiSleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const customObserve = typeof options.qaaiObserve === 'function' ? options.qaaiObserve : null;
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let previousKey = null;
  let consecutiveEquivalent = 0;
  let lastSample = null;

  while (now() <= deadline) {
    attempts += 1;
    const remainingMs = Math.max(1, deadline - now());
    let sample = customObserve ? await customObserve({ observation, attempts, remainingMs }) : null;
    if (!sample) {
      const pages = collectTransitionPages(session);
      const tabs = await listBrowserTabsForTransition(session, Math.max(250, Math.min(2_000, remainingMs)));
      const selectedTarget = await selectObservedTransitionTarget(session, observation, pages, tabs, remainingMs);
      let snapshotText = '';
      try {
        const snapshotResult = await rawTransitionTool(
          session,
          'browser_snapshot',
          {},
          Math.max(250, Math.min(2_000, remainingMs)),
        );
        if (!snapshotResult?.isError) snapshotText = textOfContent(snapshotResult?.content);
      } catch (_) {}
      const usableSnapshot = isSnapshotText(snapshotText);
      if (usableSnapshot) {
        session.lastSnapshot = snapshotText;
        session.lastSnapshotOriginatingTool = 'transition_observation';
        session.lastSnapshotCapturedAt = Date.now();
      }
      const pageRecords = pages.map(transitionPageRecord);
      const baselineById = new Map((observation.baseline.pages || []).map((page) => [page.pageId, page]));
      const newPage = pageRecords.find((page) => !baselineById.has(page.pageId));
      const changedPage = pageRecords.find((page) => {
        const before = baselineById.get(page.pageId);
        return before && page.url && before.url && page.url !== before.url;
      });
      const currentUrl = extractUrlFromSnapshot(snapshotText)
        || selectedTarget.tab?.url
        || safeTransitionPageUrl(selectedTarget.page)
        || session.currentUrl
        || '';
      const fingerprint = normaliseForStability(snapshotText);
      const signals = [];
      if (newPage || observation.events.some((event) => event.kind === 'new_page')) signals.push('new_page');
      if (selectedTarget.selected) signals.push('active_page_changed');
      if (changedPage || (currentUrl && observation.baseline.url && currentUrl !== observation.baseline.url)) signals.push('url_changed');
      if (transitionOrigin(currentUrl) && observation.baseline.origin && transitionOrigin(currentUrl) !== observation.baseline.origin) signals.push('origin_changed');
      if (fingerprintMateriallyChanged(observation.baseline.fingerprint, fingerprint)) signals.push('fingerprint_changed');
      if (destinationOnly && fingerprint) signals.push('stable_destination_fingerprint');
      sample = { currentUrl, fingerprint, signals: [...new Set(signals)].sort(), usableSnapshot };
    }
    lastSample = sample;
    const signals = Array.isArray(sample?.signals) ? sample.signals.filter(Boolean) : [];
    const hasTransitionSignal = signals.length > 0;
    const key = hasTransitionSignal
      ? JSON.stringify({ signals, currentUrl: sample.currentUrl || '', fingerprint: sample.fingerprint || '' })
      : null;
    consecutiveEquivalent = key && key === previousKey ? consecutiveEquivalent + 1 : (key ? 1 : 0);
    previousKey = key;
    if (hasTransitionSignal && consecutiveEquivalent >= stableRequired) {
      cleanupTransitionObservation(observation);
      const evidence = {
        version: 'TransitionEvidenceV1',
        status: 'confirmed',
        transitionId: observation.transitionId,
        signals,
        currentUrl: sample.currentUrl || null,
        attempts,
        stableObservations: consecutiveEquivalent,
        durationMs: now() - startedAt,
      };
      if (sample.currentUrl) {
        session.currentUrl = sample.currentUrl;
        appendVisitedUrl(session, sample.currentUrl);
      }
      session.lastTransitionEvidence = evidence;
      session.activeTransitionObservation = null;
      return { ...evidence, matched: true, qaaiEvidenceError: false };
    }
    const remainingAfterRead = deadline - now();
    if (remainingAfterRead <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingAfterRead));
  }

  cleanupTransitionObservation(observation);
  const evidence = {
    version: 'TransitionEvidenceV1',
    status: 'inconclusive',
    matched: null,
    qaaiEvidenceError: true,
    retryable: true,
    retryExhausted: true,
    failureType: 'qaai_transition_evidence_inconclusive',
    reason: 'qaai_transition_evidence_inconclusive',
    transitionId: observation.transitionId,
    attempts,
    stableObservations: consecutiveEquivalent,
    durationMs: now() - startedAt,
    observedSignals: lastSample?.signals || [],
  };
  session.lastTransitionEvidence = evidence;
  session.activeTransitionObservation = null;
  return evidence;
}

/**
 * After a state-changing tool call, re-snapshot up to MAX_ITERATIONS times
 * (or until TOTAL_BUDGET_MS elapses), returning the FIRST stable snapshot
 * we observe. "Stable" means two consecutive normalised snapshots match.
 * The first snapshot is what callTool already received; we only need
 * additional MCP roundtrips when the page is still settling.
 *
 * Returns: { txt: <final snapshot text>, record: { iterations, capped, elapsedMs } }
 *
 * Never throws — any MCP failure during stabilisation returns the most
 * recent successful snapshot, so a flaky transitional snapshot is the
 * worst case (same as before the stability check existed).
 */
async function stabiliseSnapshot(session, firstSnapshot, originatingTool, options = {}) {
  const startedAt = Date.now();
  let lastTxt = firstSnapshot;
  let lastNormal = normaliseForStability(firstSnapshot);
  let iterations = 0;
  let stabilised = false;

  while (iterations < STABILITY_MAX_ITERATIONS && (Date.now() - startedAt) < STABILITY_TOTAL_BUDGET_MS) {
    iterations += 1;
    // Sleep first — gives the page a chance to advance between observations.
    const elapsed = Date.now() - startedAt;
    const remaining = STABILITY_TOTAL_BUDGET_MS - elapsed;
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(STABILITY_INTERVAL_MS, remaining)));
    let nextResult;
    try {
      // This helper runs from inside callTool's scheduler lane, so it must not
      // recursively enqueue another scheduled call. rawTransitionTool applies
      // the same hard timeout/transport recovery without scheduler re-entry.
      nextResult = await rawTransitionTool(
        session,
        'browser_snapshot',
        {},
        Math.max(100, Number(options.timeoutMs) || 5000),
      );
    } catch (_) {
      // MCP transient; accept whatever we had.
      break;
    }
    if (nextResult?.isError) break;
    const nextTxt = textOfContent(nextResult?.content);
    if (!nextTxt) break;
    const nextNormal = normaliseForStability(nextTxt);
    if (nextNormal === lastNormal) {
      // Two consecutive observations match — page is settled.
      stabilised = true;
      lastTxt = nextTxt;
      break;
    }
    lastTxt = nextTxt;
    lastNormal = nextNormal;
  }

  return {
    txt: lastTxt,
    record: {
      iterations,
      capped: !stabilised,
      stabilised,
      elapsedMs: Date.now() - startedAt,
      originatingTool,
    },
  };
}

// Returns true when the given text looks like a real Playwright MCP accessibility
// snapshot (the "### Page ..." DOM tree). Tools like browser_type and browser_fill_form
// return "### Ran Playwright code\n```js\nawait page..." — NOT a DOM snapshot.
// We gate session.lastSnapshot writes on this check so Playwright code strings
// can never pollute the snapshot cache and corrupt snapshotBeforeAction reads.
function isSnapshotText(txt) {
  if (typeof txt !== 'string' || !txt) return false;
  // Real snapshots always contain [ref=eN] accessibility references.
  // Playwright code outputs never do.
  return /\[ref=/m.test(txt);
}

// A snapshot is a TRANSIENT failure (not a real page state) when it is empty, or
// lacks accessibility refs (not a real snapshot), or looks like a timeout / nav
// error payload. The assertion layer uses this to RETRY (re-settle + re-snapshot)
// rather than decide a verdict from a garbage snapshot. Site-agnostic — keyed off
// the snapshot's STRUCTURE, never the assertion content.
function isTransientSnapshotFailure(txt) {
  if (typeof txt !== 'string' || !txt.trim()) return true;       // empty → transient
  if (isSnapshotText(txt)) return false;                          // real snapshot (has refs)
  // No refs: a non-snapshot payload. Treat timeout/navigation/error shapes as transient.
  return /timeout|timed out|navigation (failed|timeout)|net::ERR|Target closed|Execution context was destroyed|page\.[a-z]+:|^###?\s*error|\berror\b/i.test(txt);
}

// Phase F.3 — tools whose text response is the page accessibility tree.
// Snapshot-producing tools update session.lastSnapshot so the synthetic
// assertion_check can verify against the freshest page state. Tools NOT in
// this set (network_requests, console_messages, evaluate, screenshot,
// wait_for, etc.) return non-snapshot data — caching their text would
// pollute lastSnapshot and break assertion_check.
const SNAPSHOT_PRODUCING_TOOLS = new Set([
  'browser_snapshot',
  'browser_navigate',
  'browser_click',
  'browser_fill_form',
  'browser_type',
  'browser_press_key',
  'browser_select_option',
  'browser_check',
  'browser_uncheck',
  'browser_file_upload',
  'browser_hover',
  'browser_drag',
  'browser_handle_dialog',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_resize',
]);

/**
 * Return the most recent snapshot text captured from any tool result.
 * Used by the inline Critic to evaluate where the page currently is without
 * spending another MCP roundtrip.
 */
function getLastSnapshot(session) {
  return session?.lastSnapshot || '';
}

const ADAPTIVE_VALIDATION_SNAPSHOT_SOURCES = new Set([
  'single_pass_validation_snapshot',
  'adaptive_validation_snapshot',
]);

function validationSnapshotBudgetMs(session, options = {}) {
  const explicit = Number(
    options.validationBudgetMs
    ?? options.waitContract?.timeoutMs
    ?? session?.activeWaitContract?.timeoutMs,
  );
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const origin = String(
    options.validationKind
    || session?.lastSnapshotOriginatingTool
    || '',
  ).toLowerCase();
  if (/navigate|navigation|url/.test(origin)) return waitContract.DEFAULT_TIMEOUTS.navigation;
  if (/stabili[sz]|wait/.test(origin)) return waitContract.DEFAULT_TIMEOUTS.stabilization;
  return waitContract.DEFAULT_TIMEOUTS.assertion;
}

async function adaptiveValidationSnapshot(session, options = {}) {
  const requestedSource = String(options.source || 'adaptive_validation_snapshot');
  const budgetMs = validationSnapshotBudgetMs(session, options);
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs) || waitContract.POLL_INTERVAL_MS);
  const stableObservations = Math.max(1, Number(options.stableObservations) || waitContract.STABLE_OBSERVATIONS);
  const now = typeof options.qaaiNow === 'function' ? options.qaaiNow : Date.now;
  const sleep = typeof options.qaaiSleep === 'function'
    ? options.qaaiSleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const observe = typeof options.qaaiObserve === 'function' ? options.qaaiObserve : null;
  const startedAt = now();
  const deadline = startedAt + budgetMs;
  let attempts = 0;
  let usableObservations = 0;
  let unusableObservations = 0;
  let consecutiveEquivalent = 0;
  let previousKey = null;
  let lastText = '';

  const publishEvidence = (status, extra = {}) => {
    const evidence = {
      source: requestedSource,
      status,
      attempts,
      usableObservations,
      unusableObservations,
      stableObservations,
      pollIntervalMs,
      budgetMs,
      durationMs: now() - startedAt,
      ...extra,
    };
    if (session && typeof session === 'object') session.lastValidationEvidence = evidence;
    return evidence;
  };

  while (now() <= deadline) {
    const remainingMs = Math.max(1, deadline - now());
    attempts += 1;
    let result = null;
    try {
      result = observe
        ? await observe({ attempt: attempts, remainingMs, source: requestedSource })
        : await callTool(session, 'browser_snapshot', {}, {
            ...options,
            qaaiNow: undefined,
            qaaiSleep: undefined,
            qaaiObserve: undefined,
            validationBudgetMs: undefined,
            waitContract: undefined,
            validationKind: undefined,
            pollIntervalMs: undefined,
            stableObservations: undefined,
            source: requestedSource,
            skipSnapshotStability: true,
            timeoutMs: Math.max(250, Math.min(Number(options.timeoutMs) || 2_000, remainingMs)),
          });
    } catch (_) {
      result = null;
    }
    const text = typeof result === 'string'
      ? result
      : String(result?.text || textOfContent(result?.content) || '');
    const usable = result?.isError !== true && isSnapshotText(text);
    if (usable) {
      usableObservations += 1;
      lastText = text;
      const key = normaliseForStability(text)
        || text.replace(/\[ref=[^\]]+\]/g, '[ref]').replace(/\s+/g, ' ').trim();
      consecutiveEquivalent = key && key === previousKey ? consecutiveEquivalent + 1 : 1;
      previousKey = key;
      if (consecutiveEquivalent >= stableObservations) {
        return {
          text: lastText,
          error: null,
          qaaiValidation: publishEvidence('stable', { consecutiveEquivalent }),
        };
      }
    } else {
      unusableObservations += 1;
      consecutiveEquivalent = 0;
      previousKey = null;
    }

    const remainingAfterRead = deadline - now();
    if (remainingAfterRead <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingAfterRead));
  }

  const status = lastText ? 'unstable' : 'unavailable';
  const reason = status === 'unstable'
    ? 'qaai_validation_evidence_unstable'
    : 'qaai_validation_evidence_unavailable';
  return {
    text: '',
    error: reason,
    qaaiEvidenceError: true,
    qaaiValidation: publishEvidence(status, {
      reason,
      consecutiveEquivalent,
      lastUsableSnapshotLength: lastText.length,
    }),
  };
}

/**
 * Convenience: ask for a page snapshot (yaml/json text describing every
 * visible element with role/name/ref). Returns the raw text, suitable for
 * embedding in a prompt or parsing for the picker.
 */
async function snapshot(session, options = {}) {
  if (ADAPTIVE_VALIDATION_SNAPSHOT_SOURCES.has(String(options.source || ''))) {
    return adaptiveValidationSnapshot(session, options);
  }
  const result = await callTool(session, 'browser_snapshot', {}, options);
  if (result.isError) {
    return { text: '', error: textOfContent(result.content) };
  }
  return { text: textOfContent(result.content), error: null };
}

/**
 * Convenience: take a screenshot. Returns the first image block as
 * `{ data: base64, mediaType }`, or null if no image was returned.
 */
async function screenshot(session, params = {}) {
  const {
    lane = 'critical',
    timeoutMs = lane === 'background' ? BACKGROUND_SCREENSHOT_TIMEOUT_MS : AUDIT_SCREENSHOT_TIMEOUT_MS,
    skipIfBusy = false,
    telemetry = true,
    source = null,
    ...toolParams
  } = params || {};
  let result;
  try {
    result = await callTool(session, 'browser_take_screenshot', {
      type: toolParams.type || 'jpeg',
      ...toolParams,
    }, {
      lane,
      timeoutMs,
      skipIfBusy,
      telemetry,
      source,
    });
  } catch (err) {
    try {
      if (telemetry !== false) session?.telemetry?.recordTool?.({
        tool: 'browser_take_screenshot',
        input: toolParams || {},
        ok: false,
        isError: true,
        elapsedMs: Number(timeoutMs) || 0,
        pageUrlBefore: session?.currentUrl || null,
        pageUrlAfter: session?.currentUrl || null,
        snapshotText: '',
        domFacts: null,
        stability: null,
        errorPreview: String(err && err.message || err).slice(0, 600),
        qaaiLane: lane,
        qaaiSource: source,
      });
    } catch (_) {}
    return null;
  }
  if (result?.qaaiSkipped) return null;
  if (result.isError) return null;
  const img = (result.content || []).find((c) => c.type === 'image');
  if (!img) return null;
  return { data: img.data, mediaType: img.mimeType || 'image/jpeg' };
}

/**
 * Save a screenshot blob to disk and return the served URL path.
 */
function saveScreenshotToDisk(imgBlock, label) {
  if (!imgBlock?.data) return null;
  const safe = String(label || crypto.randomBytes(4).toString('hex')).replace(/[^a-zA-Z0-9_-]/g, '_');
  const ext = imgBlock.mediaType === 'image/png' ? '.png' : '.jpg';
  const file = path.join(ARTIFACT_DIR, `${safe}${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(imgBlock.data, 'base64'));
    return '/artifacts/live/' + path.basename(file);
  } catch (_) {
    return null;
  }
}

/**
 * Start polling browser_take_screenshot at ~2 fps. Each frame is broadcast
 * via the session's `broadcast` function as `{ type:'browser.frame', frame, sessionId }`.
 */
function startFramePoller(session, { fps = 3 } = {}) {
  if (!session || session.framePoller) return;
  if (session.liveFrameMode === 'cdp' || session.liveFrameMode === 'cdp_pending' || session.cdpScreencast?.started) return;
  const intervalMs = Math.max(333, Math.floor(1000 / Math.max(1, fps)));
  session.framePoller = setInterval(async () => {
    if (session.closed) return;
    // REVERTED (2026-06-21): we DO bail on framePollerPaused again. Un-pausing it
    // let polled screenshots queue into the same serial MCP pipe DURING long
    // navigation-causing tool calls (e.g. the Add-button click that waits for
    // "scheduled navigations to finish"), contending for the browser and causing
    // 30s callTool timeouts that failed the run mid-step. Execution reliability
    // beats a smoother live view. Per-action blocking frames (conductor
    // VISUAL_STATE_TOOLS) still give a frame right after each action; the proper
    // continuous-live fix is an OUT-OF-BAND CDP screencast (Page.startScreencast)
    // that doesn't touch the tool pipe — deferred, NOT this poller.
    if (session.framePollerPaused) return;
    if (session.framePollerInFlight) return;
    session.framePollerInFlight = true;
    try {
      const shot = await screenshot(session, {
        type: 'jpeg',
        lane: 'background',
        timeoutMs: BACKGROUND_SCREENSHOT_TIMEOUT_MS,
        // skipIfBusy was true here — it dropped EVERY frame while any MCP tool was
        // queued (pendingCount > 0), which is nearly the entire run. Changed to false
        // so frames queue behind active work via the sequential scheduler chain and
        // deliver after each tool completes. framePollerInFlight prevents stacking.
        skipIfBusy: false,
        telemetry: false,
        source: 'live_frame',
      });
      if (shot && !session.closed) {
        session.broadcast({
          type: 'browser.frame',
          sessionId: session.id,
          frame: shot.data,
          mediaType: shot.mediaType,
          ts: Date.now(),
          source: 'live_frame',
        });
      }
    } catch (_) {
      // Polled screenshots are best-effort
    } finally {
      session.framePollerInFlight = false;
    }
  }, intervalMs);
}

function stopFramePoller(session) {
  if (session?.framePoller) {
    clearInterval(session.framePoller);
    session.framePoller = null;
  }
}

// ── Phase E2.1 — synthetic `assertion_check` tool ───────────────────────
//
// The Conductor calls this BEFORE emitting `RESULT: pass` for a test case.
// We don't roundtrip MCP — instead, we read the cached accessibility-tree
// snapshot and verify the declared assertion against it. Fast (sub-millisecond),
// no extra browser cost.
//
// Schema:
//   { assertion: string,            // human-readable claim being checked
//     expectedRole?: string,         // e.g. "heading", "alert"
//     expectedText?: string,         // case-insensitive substring match
//     expectedUrlPattern?: string }  // RegExp pattern matched against any url=
//
// Response:
//   { matched: bool, evidence: string, reason: string }
//
// At least one of expectedRole / expectedText / expectedUrlPattern must be
// supplied — passing none returns matched=false with reason=missing_criteria.

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic human_input tool — Phase D paused-automation pattern.
//
// Agent calls this when a step truly requires an out-of-band human action
// (open inbox, paste OTP, approve push notification, etc.). The conductor
// intercepts the tool call BEFORE it reaches MCP, broadcasts an
// agent.awaitingInput WS event, awaits the user's response via the
// pauseRegistry, and feeds the result back as the tool result so the
// agent's reasoning chain stays intact.
//
// The tool description is INTENTIONALLY conservative — Claude should reach
// for browser_* tools first and only fall back to human_input when the
// action genuinely cannot be automated. The classifier in the Architect
// also pre-marks cases that need this so it's not pure improvisation.
// ─────────────────────────────────────────────────────────────────────────────
const HUMAN_INPUT_TOOL = {
  name: 'human_input',
  description:
    'Pause the run and ask the human operator to perform an action you cannot automate (open their email inbox, paste an OTP, approve a push notification on their phone, confirm a real payment, etc.). Only use this when the step CANNOT be done via browser_* tools — never as a shortcut for "I am not sure what to do next". The UI surfaces your prompt verbatim, so write it as a clear instruction to a tester. Returns the human\'s input as the tool result, or BLOCKED if they skip/abort/timeout.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The instruction the human will see. Be specific — name the channel ("your inbox at <email>"), the action ("click the reset link"), and what they need to give back ("paste the URL here").',
      },
      inputType: {
        type: 'string',
        enum: ['confirm', 'text', 'choice'],
        description: '"confirm" = no input, just a Done button (best for "approve on your phone"). "text" = free-form text (paste OTP, link). "choice" = pick one of the listed options.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required when inputType="choice". The radio-button options the human picks from.',
      },
    },
    required: ['prompt'],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Synthetic remember_credential tool — cross-scenario / cross-run credential
// persistence. When the agent establishes a working credential for a
// non-default user (e.g. after resetting an ESS user's password), call this
// tool so the credential is stored in the project's Knowledge Base and
// surfaced to subsequent scenarios and future runs — preventing repeated
// password-reset ceremonies on the same site.
//
// Stored in KnowledgeBaseLocator with role='discovered_credential' as a
// marker so the credential rows are queried and rendered separately from
// element locators.
// ─────────────────────────────────────────────────────────────────────────
const REMEMBER_CREDENTIAL_TOOL = {
  name: 'remember_credential',
  description:
    'Persist a working username/password credential into the project Knowledge Base so future test cases and runs can reuse it without repeating the password-reset ceremony. Call this IMMEDIATELY after you successfully log in with a credential you just established (e.g. after resetting a user\'s password). Do NOT call for the default admin credential — only for credentials you discovered or set up during a run.',
  input_schema: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'The login username.' },
      password: { type: 'string', description: 'The working password.' },
      role: {
        type: 'string',
        description: 'The user role in the application (e.g. "Admin", "Editor", "Viewer"). Used to label the credential for future reference.',
      },
      notes: {
        type: 'string',
        description: 'Optional one-line note about this credential (e.g. "password reset during run 2026-06-09").',
      },
    },
    required: ['username', 'password'],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Synthetic browser_extract_data tool — cross-case data chaining.
//
// Lets the Conductor grab a dynamic value from the page (a generated
// tracking ID, an order number, a confirmation code) and bind it to a
// named key in the run's shared-data bag. The value is available
// IMMEDIATELY to subsequent steps in the same case via ${targetKey}
// substitution (working scratch), AND to downstream cases that declare
// requiresData (durable Run.sharedData).
//
// The intercept lives in callTool: when name === 'browser_extract_data',
// the server delegates to extractData() — which internally calls
// browser_evaluate to run the supplied JS expression, validates the
// result is a primitive (string/number/boolean), and writes through to
// session.sharedDataCurrentCase (synchronous) + session.persistSharedData
// (async, best-effort durable write).
//
// Why a synthetic tool wrapping browser_evaluate instead of teaching the
// agent to call browser_evaluate directly and then write somewhere?
//   - Single source of truth for value extraction — the architect emits
//     one ExtractData step and the agent makes one tool call.
//   - Guarded result validation — rejects object/array returns so the
//     bag stays flat without the agent having to reason about it.
//   - Deterministic persistence path — the tool ALWAYS writes through to
//     both scratch and durable storage; the agent can't "forget" to
//     persist after extracting.
// ─────────────────────────────────────────────────────────────────────────
const BROWSER_EXTRACT_DATA_TOOL = {
  name: 'browser_extract_data',
  description: [
    'Extract a primitive value from the current page and bind it to a named key in the run\'s shared-data bag.',
    'Use this when a test scenario needs to carry a generated identifier (tracking number, order ID,',
    'confirmation code, customs ID, etc.) from one step or case to the next.',
    '',
    'The extracted value is available IMMEDIATELY to subsequent steps in the SAME case via ${targetKey}',
    'substitution in their input fields, AND to downstream cases that declare the same key in their',
    'requiresData array.',
    '',
    'The expression is evaluated against the element identified by `target` (the [ref=eN] token from a',
    'fresh browser_snapshot). The element is passed as `el`. Examples:',
    '  - { expr: "el.textContent.trim()", targetKey: "trackingId" }',
    '  - { expr: "el.getAttribute(\'data-order-id\')", targetKey: "orderId" }',
    '  - { expr: "el.value", targetKey: "couponCode" }',
    '',
    'The expression MUST return a primitive (string/number/boolean). Objects/arrays/null/undefined are',
    'rejected — the shared-data bag is FLAT. If you need compound data, make multiple extraction calls',
    'with distinct targetKey values.',
  ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'The [ref=eN] of the element to extract from. Bare ref token, no brackets, no "ref=" prefix (e.g. "e42").',
      },
      expr: {
        type: 'string',
        description: 'A JavaScript expression with `el` bound to the element. Must return a primitive (string/number/boolean). Examples: "el.textContent.trim()", "el.value", "el.getAttribute(\'href\')".',
      },
      targetKey: {
        type: 'string',
        description: 'Name to bind the extracted value under. Must be a JS identifier (camelCase preferred, e.g. "trackingId", "orderId", "confirmationCode"). Used by downstream steps and cases via ${targetKey} substitution.',
      },
      element: {
        type: 'string',
        description: 'Human-readable label for the trace, e.g. "Tracking number on confirmation page".',
      },
    },
    required: ['target', 'expr', 'targetKey', 'element'],
  },
};

const { isAssertionV2Enabled } = require('../lib/verdictFlags');

// ─────────────────────────────────────────────────────────────────────────
// Synthetic final_verdict tool — Phase H M4 (mechanical_v1 mode only).
//
// In mechanical mode the agent no longer determines the case status. The
// backend (computeVerdict + postLoopRatify) does. But we still need a
// SIGNAL from the agent meaning "I believe I'm done". `final_verdict` is
// that signal. The tool's argument value is RECORDED as the
// `agentClaimedVerdict` (for the disagreement metric) but is DISCARDED
// for verdict computation.
//
// The conductor intercepts the call:
//   - If any declared assertionId hasn't been checked yet, the tool
//     returns a structured error listing missing IDs; on the FIRST
//     rejection only it also grants a one-shot turn-budget bonus so the
//     agent isn't strangled by the gate.
//   - On the first successful call (all declared IDs covered), the
//     conductor records the claim and ends the loop.
//
// Visibility: only included in listAnthropicTools when the per-run
// verdictMode is 'mechanical_v1' — legacy mode keeps the old end_turn
// flow and the agent doesn't see this tool at all.
// ─────────────────────────────────────────────────────────────────────────
const FINAL_VERDICT_TOOL = {
  name: 'final_verdict',
  description:
    [
      'Signal that you have finished verifying every declared assertion and are ready for the case to be tallied. Call this EXACTLY ONCE per case, after you have called assertion_check for every declared assertionId in the DECLARED ASSERTIONS list.',
      '',
      'Behaviour:',
      '  · If any declared assertionId has no assertion_check on record, the tool returns an error listing the missing IDs. Call assertion_check for each missing assertionId, in order, then call final_verdict again.',
      '  · On success, the case ends. Your final_verdict argument is recorded for telemetry but the case status is computed mechanically from the assertion_check results, not from this value.',
      '',
      'Do NOT call final_verdict before the assertions are checked. Do NOT call any other browser_* tool between an unsuccessful final_verdict and the follow-up assertion_check calls — re-do the missing checks first, then re-call final_verdict.',
    ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      claimedStatus: {
        type: 'string',
        enum: ['pass', 'fail', 'blocked'],
        description: 'Your best read of the case outcome from what you observed. RECORDED for the disagreement metric, but does NOT determine the case status — the backend computes that from assertion_check results.',
      },
      reasoning: {
        type: 'string',
        description: 'One-sentence summary of why you arrived at this claimed status. Optional but useful for the post-mortem report.',
      },
    },
    required: ['claimedStatus'],
  },
};

// Legacy tool description — used when QAAI_ASSERTION_V2 is off (current
// production behaviour). Returns { matched: bool, ... } and any matched=false
// flips the case to fail at the verdict layer.
const ASSERTION_CHECK_TOOL_LEGACY = {
  name: 'assertion_check',
  description:
    'Verify an assertion against the current page snapshot AND/OR the captured downloads for this case. Call this for EACH assertion BEFORE you emit RESULT: pass — any matched=false flips the test case to fail. Pass at least one of expectedRole, expectedText, expectedUrlPattern, or expectedDownload.',
  input_schema: {
    type: 'object',
    properties: {
      assertion: { type: 'string', description: 'Human-readable claim being verified (e.g. "user lands on dashboard").' },
      expectedRole: { type: 'string', description: 'ARIA role expected to appear (e.g. "heading", "alert", "main").' },
      expectedText: { type: 'string', description: 'Case-insensitive substring expected on the page.' },
      expectedUrlPattern: { type: 'string', description: 'JavaScript-regex pattern expected to match a URL on the page (e.g. "/dashboard"). Pass the pattern from the declared assertion VERBATIM — do not add escape characters. The pattern "/inventory\\.html" stays as "/inventory\\.html"; do NOT inflate to "/inventory\\\\.html". Matching is case-insensitive and tolerant of path-only patterns vs full URLs.' },
      containerSelector: {
        type: 'string',
        description: 'CSS selector of the container element this text assertion is scoped to. Pass the same selector used in browser_evaluate so the scope is recorded and the exported test spec asserts against the same element (not the whole page). Example: ".features_items", "[data-testid=\\"search-results\\"]", ".product-grid". Prevents false passes from nav/footer/sidebar text. Only effective when combined with expectedText.',
      },
      pageAssertion: {
        type: 'object',
        description: 'For PAGE-type declared assertions: pass the assertion\'s payload object verbatim. Multi-signal page-identity verification with weighted quorum (role=2, text=1, url=1, threshold=2). Use this INSTEAD of expectedText/expectedUrlPattern when the declared assertion is type=PAGE.',
        properties: {
          pageName: { type: 'string', description: 'Machine-readable page identity (e.g. "login_page", "order_confirmation").' },
          expectedSignals: { type: 'object', description: 'Channels of evidence — text (array of strings), role (array of {role,name}), url (array of patterns). At least two channels populated.' },
          primaryIndicator: { type: 'object', description: 'Optional single canonical signal that authoritatively identifies the page — short-circuits to PASS if matched.' },
        },
        required: ['pageName', 'expectedSignals'],
      },
      expectedDownload: {
        type: 'object',
        description: 'Verify a file was actually downloaded during this case. The download watcher records every file the browser saves; provide a filenamePattern (regex) and/or minSize (bytes) and/or mimeType.',
        properties: {
          filenamePattern: { type: 'string', description: 'Case-insensitive regex against suggested filename (e.g. "report.*\\\\.pdf$").' },
          minSize: { type: 'number', description: 'Minimum file size in bytes — guards against empty/0-byte downloads.' },
          mimeType: { type: 'string', description: 'Exact MIME type (e.g. "application/pdf").' },
        },
      },
    },
    required: ['assertion'],
  },
};

// Phase H M2 — V2 tool description, active when QAAI_ASSERTION_V2=on.
// Teaches the three-outcome contract; the response payload carries both the
// new `outcome` field AND the legacy `matched` field (additive — old callers
// keep working). The M4 mechanical verdict reads `outcome`; legacy code paths
// continue reading `matched`.
const ASSERTION_CHECK_TOOL_V2 = {
  name: 'assertion_check',
  description:
    [
      'Verify an assertion against the current page snapshot AND/OR the captured downloads for this case. Pass at least one of expectedRole, expectedText, expectedUrlPattern, or expectedDownload.',
      '',
      'RETURN SHAPE — three outcomes, NOT a boolean:',
      '  outcome: "matched"      → assertion passed; do NOT re-check; proceed.',
      '  outcome: "not_matched"  → assertion FAILED against settled page; case',
      '                            will be marked fail at the verdict layer.',
      '                            Do NOT retry the same check. If you believe',
      '                            the page state has not reached the assertion\'s',
      '                            preconditions, re-execute the STEP that should',
      '                            establish them (the click, the form submit,',
      '                            the original navigation that should have caused',
      '                            the redirect) and re-check ONCE. Do NOT navigate',
      '                            directly to the asserted target URL — that',
      '                            bypasses the behaviour under test.',
      '  outcome: "uncheckable"  → verification primitive could not return',
      '                            yes/no (timeout, missing context, broken',
      '                            session); do NOT treat as fail; do NOT retry;',
      '                            move on to the next assertion.',
      '',
      'POSITIVE EVIDENCE IS DURABLE: if polling caught a match on ANY iteration,',
      'the outcome is matched even if a later poll missed (mid-transition state).',
    ].join('\n'),
  input_schema: ASSERTION_CHECK_TOOL_LEGACY.input_schema,
};

// Phase H M4 — mechanical-mode tool description. Adds assertionId to the
// schema (REQUIRED) so the backend can correlate the agent's check to a
// declared assertion. Without an assertionId we can't tell whether a
// declared assertion has been covered yet, and the final_verdict gate
// can't function.
//
// Listing rule: this variant supersedes both LEGACY and V2 whenever
// listAnthropicTools is called with verdictMode === 'mechanical_v1'.
// In other modes the existing env-flag-driven choice continues to apply
// (V2 if QAAI_ASSERTION_V2=on, LEGACY otherwise).
const ASSERTION_CHECK_TOOL_MECHANICAL = {
  name: 'assertion_check',
  description:
    [
      'Verify a DECLARED assertion against the current page snapshot AND/OR the captured downloads for this case. The case has a fixed list of DECLARED ASSERTIONS — see the per-case user message; each has a stable assertionId (ASN-xxxxxxxx). Call this tool ONCE per declared assertionId before calling final_verdict.',
      '',
      'REQUIRED: assertionId. The tool result is recorded against this id; final_verdict will reject if any declared assertionId has no recorded check.',
      'Also pass at least one verification criterion: expectedRole, expectedText, expectedUrlPattern, or expectedDownload. (The declared assertion\'s payload tells you which.)',
      '',
      'RETURN SHAPE — three outcomes, NOT a boolean:',
      '  outcome: "matched"      → assertion passed; do NOT re-check; proceed.',
      '  outcome: "not_matched"  → assertion FAILED against settled page; case',
      '                            will be marked fail. Do NOT retry the same',
      '                            check. If preconditions weren\'t established,',
      '                            re-execute the STEP that should establish them',
      '                            then re-check ONCE. Do NOT navigate directly',
      '                            to the asserted target URL — that bypasses the',
      '                            behaviour under test.',
      '  outcome: "uncheckable"  → verification primitive could not return yes/no;',
      '                            do NOT treat as fail; do NOT retry; move on.',
      '',
      'POSITIVE EVIDENCE IS DURABLE: if polling caught a match on ANY iteration,',
      'the outcome is matched even if a later poll missed (mid-transition state).',
    ].join('\n'),
  input_schema: {
    type: 'object',
    properties: {
      assertionId: {
        type: 'string',
        description: 'REQUIRED. The ASN-<hex> id from the DECLARED ASSERTIONS list for this case.',
      },
      assertion: { type: 'string', description: 'Human-readable claim being verified (optional but useful for the trace).' },
      expectedRole: { type: 'string', description: 'ARIA role expected to appear (e.g. "heading", "alert", "main").' },
      expectedText: { type: 'string', description: 'Case-insensitive substring expected on the page.' },
      expectedUrlPattern: { type: 'string', description: 'JavaScript-regex pattern expected to match a URL on the page (e.g. "/dashboard"). Pass the pattern from the declared assertion VERBATIM — do not add escape characters. The pattern "/inventory\\.html" stays as "/inventory\\.html"; do NOT inflate to "/inventory\\\\.html". Matching is case-insensitive and tolerant of path-only patterns vs full URLs, so a literal "/checkout" matches "https://site.com/checkout.html".' },
      containerSelector: {
        type: 'string',
        description: 'CSS selector of the container element this text assertion is scoped to. Pass the same selector used in browser_evaluate so the scope is recorded and the exported test spec asserts against the same element (not the whole page). Example: ".features_items", "[data-testid=\\"search-results\\"]", ".product-grid". Prevents false passes from nav/footer/sidebar text. Only effective when combined with expectedText.',
      },
      pageAssertion: {
        type: 'object',
        description: 'For PAGE-type declared assertions: pass the assertion\'s payload object verbatim. Multi-signal page-identity verification with weighted quorum (role=2, text=1, url=1, threshold=2). Use this INSTEAD of expectedText/expectedUrlPattern when the declared assertion is type=PAGE.',
        properties: {
          pageName: { type: 'string', description: 'Machine-readable page identity (e.g. "login_page", "order_confirmation").' },
          expectedSignals: { type: 'object', description: 'Channels of evidence — text (array of strings), role (array of {role,name}), url (array of patterns). At least two channels populated.' },
          primaryIndicator: { type: 'object', description: 'Optional single canonical signal that authoritatively identifies the page — short-circuits to PASS if matched.' },
        },
        required: ['pageName', 'expectedSignals'],
      },
      expectedDownload: {
        type: 'object',
        description: 'Verify a file was actually downloaded during this case.',
        properties: {
          filenamePattern: { type: 'string', description: 'Case-insensitive regex against suggested filename.' },
          minSize: { type: 'number', description: 'Minimum file size in bytes — guards against empty/0-byte downloads.' },
          mimeType: { type: 'string', description: 'Exact MIME type.' },
        },
      },
      // FORBIDDEN_* primitives — inverted match. Use these when the declared
      // assertion's type is FORBIDDEN_TEXT / FORBIDDEN_ROLE etc. Outcome
      // "matched" here means "the page did NOT contain the forbidden value"
      // (which is the success condition). Do NOT use expectedText to verify
      // the absence of a string — that returns "not_matched" and the
      // backend will mark the case as fail.
      unexpectedText: { type: 'string', description: 'Forbidden substring. Outcome "matched" = text was absent (the success case).' },
      unexpectedRole: { type: 'string', description: 'Forbidden ARIA role. Outcome "matched" = role was absent.' },
      unexpectedUrlPattern: { type: 'string', description: 'Forbidden URL regex. Outcome "matched" = current URL did NOT match.' },
    },
    required: ['assertionId'],
  },
};

// Dispatcher: pick the active tool definition.
//   - mechanical_v1 mode (Phase H M4) supersedes everything and demands
//     assertionId in the schema. Returned even when QAAI_ASSERTION_V2 is
//     off because mechanical mode requires the V2 outcome contract too.
//   - V2 (Phase H M2) when env flag is on.
//   - LEGACY otherwise.
// Computed per-listing so flipping the env var takes effect on the next
// agent turn.
function getAssertionCheckTool(opts = {}) {
  if (opts.verdictMode === 'mechanical_v1') return ASSERTION_CHECK_TOOL_MECHANICAL;
  return isAssertionV2Enabled() ? ASSERTION_CHECK_TOOL_V2 : ASSERTION_CHECK_TOOL_LEGACY;
}

// Backward-compat export under the old name; some call sites referenced it
// directly. Resolves to the active tool at access time.
const ASSERTION_CHECK_TOOL = new Proxy({}, {
  get(_t, prop) { return getAssertionCheckTool()[prop]; },
  has(_t, prop) { return prop in getAssertionCheckTool(); },
  ownKeys() { return Reflect.ownKeys(getAssertionCheckTool()); },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(getAssertionCheckTool(), prop);
  },
});

// These constants belong to pre-dispatch action/ref quiescence only.
// Assertion validation does not sleep or poll: it checks the cached action
// snapshot and, on a miss, makes at most one bounded fresh-snapshot request.
const STABILITY_COMPARISON_DELAY_MS = 600;
const STABILITY_EARLY_EXIT_REMAINING_MS = 3_000;

/**
 * Phase H M2 — V2 outcome augmentation.
 *
 * Takes the legacy `_checkAssertionOnce`/`checkAssertion` response payload
 * (which carries `{ matched, reason?, evidence?, pollCapped? }`) and adds
 * the V2 contract fields `{ outcome, reason }` mapped from the legacy fields:
 *
 *   matched=true                                  → outcome="matched"
 *   matched=false, reason="no_snapshot"           → outcome="uncheckable", reason="no_snapshot"
 *   matched=false, reason="missing_criteria"      → outcome="uncheckable", reason="primitive_unsupported"
 *   matched=false, reason="criteria_failed"       → outcome="not_matched"
 *   matched=false, pollCapped=true                → outcome="not_matched" (Phase 1)
 *                                                   (Phase 2 will refine to "uncheckable:stability_timeout"
 *                                                   when the stability layer can confirm "still mutating")
 *
 * Legacy `matched` field is preserved on the payload — additive, never
 * removed. Both the legacy and the V2 readers can consume the same tool
 * result.
 *
 * Positive evidence wins: `checkAssertion` evaluates the cached action-time
 * snapshot first and, only on a miss, one bounded fresh snapshot. This
 * augmenter respects the resulting `matched=true` regardless of which of
 * those two observations supplied the proof.
 *
 * Cross-call durability (across multiple assertion_check calls for the
 * same declared assertion) lands in M4 where the conductor aggregates
 * `assertionCheckResults[]`; this function operates per-call only.
 */
function augmentWithOutcome(result) {
  if (!result || !Array.isArray(result.content)) return result;
  try {
    const text = result.content[0]?.text;
    if (typeof text !== 'string') return result;
    const parsed = JSON.parse(text);
    // Already has outcome (a future code path migrated) — leave alone.
    if (parsed && typeof parsed === 'object' && parsed.outcome) return result;

    let outcome, structuredReason;
    if (parsed.matched === true) {
      outcome = 'matched';
      structuredReason = null;
    } else if (parsed.reason === 'no_snapshot') {
      outcome = 'uncheckable';
      structuredReason = 'no_snapshot';
    } else if (parsed.reason === 'transient_snapshot_timeout') {
      // The snapshot we evaluated against was itself a transient failure (empty
      // or a timeout/error payload with no page content) — NOT a settled page on
      // which the value is genuinely absent. Never a fail/miss; uncheckable and
      // RETRYABLE (postLoopRatify re-snapshots + re-checks before finalizing).
      outcome = 'uncheckable';
      structuredReason = 'transient_snapshot_timeout';
    } else if (parsed.reason === 'missing_criteria') {
      outcome = 'uncheckable';
      structuredReason = 'primitive_unsupported';
    } else if (parsed.reason === 'transient_window_missed') {
      // Phase H+2 (Rule 2) — URL three-way disambiguation. The agent
      // briefly reached the target page but the current state has moved
      // on. Honest verdict is "we couldn't tell", not "fail".
      outcome = 'uncheckable';
      structuredReason = 'transient_window_missed';
    } else if (parsed.reason === 'agent_never_reached') {
      // The agent was supposed to navigate to this URL and never did.
      // That is an execution failure (navigation not completed), not a
      // verification uncertainty. Map to not_matched so it shows as FAIL
      // rather than hiding inside the uncheckable/needs_human bucket.
      outcome = 'not_matched';
      structuredReason = 'agent_never_reached';
    } else if (parsed.pollCapped === true) {
      // Compatibility for persisted/older callers: polling exhausted its
      // budget without ever seeing
      // a match. This does NOT mean the assertion is false — it means the
      // page hadn't settled within our window. On a slow CI runner, a heavy
      // React app, or a distant server, content that is visually correct can
      // arrive 4-5 s after the action. Mapping this to not_matched (→ FAIL)
      // punishes slow environments for being slow, not for being wrong.
      //
      // Correct outcome: uncheckable("stability_timeout") — we couldn't
      // determine the state within the budget. The verdict layer routes this
      // to needs_human (for the uncheckable bucket), NOT to fail. This is the
      // "Phase 2 refinement" promised in the original Phase H comment — now
      // implemented because the false-fail rate on slow pages is unacceptable.
      outcome = 'uncheckable';
      structuredReason = 'stability_timeout';
    } else {
      // criteria_failed — polling ran its full budget AND the final settled
      // snapshot does not contain the expected content. This is a genuine miss.
      outcome = 'not_matched';
      structuredReason = parsed.reason || 'criteria_failed';
    }

    const augmented = {
      ...parsed,
      outcome,
      // Structured reason for the V2 contract. The legacy `evidence` field
      // continues to carry human-readable detail; `reason` is the machine
      // code consumed by computeVerdict() in M4.
      ...(structuredReason ? { reason: structuredReason } : {}),
    };
    // Preserve the original `reason` value (if any) under `legacyReason` so
    // we don't lose data for telemetry / debugging when remapping.
    if (parsed.reason && parsed.reason !== structuredReason) {
      augmented.legacyReason = parsed.reason;
    }

    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(augmented) }],
    };
  } catch (_) {
    // If payload isn't parseable JSON, leave it alone — the V2 contract is
    // best-effort additive; never break the tool response on a parse blip.
    return result;
  }
}

/**
 * Take a fresh snapshot from the MCP subprocess and update session.lastSnapshot.
 * Returns the snapshot text, or null on error.
 */
async function _refreshSnapshot(session, options = {}) {
  const timeoutMs = Number(options?.timeoutMs);
  try {
    const snap = await rawTransitionTool(
      session,
      'browser_snapshot',
      {},
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000,
    );
    const txt = textOfContent(snap?.content);
    // Only cache a REAL snapshot ([ref=...]). A timeout/error payload (no refs)
    // must NEVER overwrite a previously-good session.lastSnapshot — otherwise an
    // assertion gets evaluated against garbage and a transient snapshot timeout
    // reads as a genuine miss. Mirror the main-dispatch isSnapshotText guard.
    // Returning null tells callers the refresh failed so they keep the prior good
    // snapshot (or retry).
    if (txt && isSnapshotText(txt)) {
      session.lastSnapshot = txt;
      session.refRoleMap = buildRefRoleMap(txt);
      return txt;
    }
  } catch (_) {
    // A failed validation refresh must never replace the last known-good
    // action snapshot. The caller can classify the read as uncheckable.
  }
  return null;
}

async function _refreshValidationSnapshotOnce(session) {
  if (!session?.client) return null;
  const fresh = await _refreshSnapshot(session, { timeoutMs: VALIDATION_SNAPSHOT_TIMEOUT_MS });
  if (!fresh) return null;
  const snapUrl = extractUrlFromSnapshot(fresh);
  if (snapUrl) {
    session.currentUrl = snapUrl;
    appendVisitedUrl(session, snapUrl);
  }
  session.snapshotDirty = false;
  return fresh;
}

/**
 * Wait until two consecutive snapshots are identical (page has settled) or
 * until `deadlineMs` is reached. Returns the stable snapshot text.
 *
 * Strategy: take snapshot A, wait STABILITY_COMPARISON_DELAY_MS, take snapshot B.
 * If A === B the DOM has stopped mutating — return B.
 * If A !== B the page is still rendering — update A = B and repeat.
 *
 * This is the root fix for "live browser passes, system reports FAIL":
 * assertion_check was running against a mid-render DOM (e.g. a React
 * hydration in progress) and seeing incomplete content, returning not_matched.
 * By waiting for the DOM to settle we evaluate against the finished page.
 */
async function _waitForStableSnapshot(session, deadlineMs) {
  // Settle on the interactive SKELETON (normaliseForStability — roles+names),
  // NOT raw text. Comparing raw text never settles on a dynamic page (a ticking
  // clock / live feed changes every poll), so this would always burn the full
  // deadline and the assertion / stale-ref settle would run against an
  // arbitrarily-timed snapshot. Skeleton comparison settles the moment the
  // CONTROLS are stable (a real control/modal change still keeps it unsettled).
  let prevKey = normaliseForStability(session.lastSnapshot || '');
  while (Date.now() < deadlineMs) {
    await new Promise((r) => setTimeout(r, STABILITY_COMPARISON_DELAY_MS));
    const next = await _refreshSnapshot(session) || session.lastSnapshot || '';
    const nextKey = normaliseForStability(next);
    if (next && nextKey === prevKey) return next;
    prevKey = nextKey;
    // If we burned more than half the remaining budget on stability, stop
    // waiting and proceed with whatever we have — better to check a
    // slightly-moving page than to never check at all.
    if (deadlineMs - Date.now() < STABILITY_EARLY_EXIT_REMAINING_MS) break;
  }
  return session.lastSnapshot || '';
}

/**
 * LLM-string normalization — generic JSON-relay corruption recovery.
 *
 * When the agent constructs a tool-call's JSON payload, it occasionally
 * over-escapes backslash sequences. The Anthropic SDK already JSON-encodes
 * the call, so the agent's extra `\` becomes a literal backslash in the
 * runtime string and breaks downstream consumers (regex constructors,
 * substring search on file paths like "C:\\Users\\admin", formatted prices
 * with escaped dollar signs, etc.). This isn't a URL-specific bug — every
 * string-valued assertion payload is exposed to the same relay corruption.
 *
 * The function collapses any '\\\\' (two consecutive backslashes in memory)
 * to a single '\'. It's idempotent: a correctly-escaped string with one
 * backslash is unchanged. Applied at the boundary where assertion args
 * enter the matcher — defensive normalization the friend RFC explicitly
 * called for as a generic JSON-artifact sanitiser.
 *
 * Limitations: collapses every doubled backslash, including legitimate
 * `\\\\\\\\` (intent: a literal `\\` in a regex). In practice the architect
 * never emits literal-backslash regexes against snapshot text — those would
 * be looking for filesystem-style paths in a webpage's accessibility tree,
 * which never happens. If that ever changes, the architect can wrap the
 * literal in a character class `[\\]` instead and the normalizer leaves
 * it alone.
 */
function normalizeLlmString(s) {
  if (typeof s !== 'string' || s.length === 0) return s;
  // Only run the replace when the over-escape signature is present.
  // Saves a regex evaluation on every clean string (the common case).
  if (s.indexOf('\\\\') === -1) return s;
  return s.replace(/\\\\/g, '\\');
}

/**
 * Tolerant URL-pattern matcher used by expectedUrlPattern / unexpectedUrlPattern
 * verification and the visitedUrls fallback search.
 *
 * Why three stages? The LLM occasionally corrupts the pattern in tool-call
 * relay (e.g. /inventory\\.html instead of /inventory\.html) — the regex then
 * looks for a literal backslash that real URLs never contain. The architect
 * sometimes also emits anchored regexes (^/inventory$) that can't match a
 * full URL "https://host/inventory" because of the protocol prefix. Both
 * produce FALSE failures on perfectly-correct pages, which destroys trust
 * in URL assertions overall.
 *
 * Stages, escalating from strict to forgiving — first match wins:
 *
 *   1. Regex match (case-insensitive). The original pattern, as-is.
 *      Covers the happy path and is the same behavior as before.
 *
 *   2. De-escaped regex retry. If the pattern contains '\\\\' (literal
 *      backslash sequences typical of LLM over-escape), collapse one level
 *      and try again. Only triggers when stage 1 missed AND the pattern
 *      shows the over-escape signature — won't change behavior for
 *      well-formed patterns.
 *
 *   3. Semantic path compare. Strip regex anchors and escape characters
 *      to recover the INTENDED path, parse the URL with WHATWG URL, and
 *      check pathname equality / suffix / contains. Recovers from
 *      anchor-on-full-URL and from purely-literal patterns. Bounded to
 *      a single comparison; no regex evaluation involved here.
 *
 * Returns { matched, stage, debug } so the caller can include a hint in
 * the evidence string when stages 2 or 3 had to rescue the match.
 */
function matchUrlPattern(pattern, url) {
  if (typeof pattern !== 'string' || !pattern || typeof url !== 'string' || !url) {
    return { matched: false, stage: 'invalid_input' };
  }

  // Stage 1: original pattern as regex, case-insensitive (URL hosts/paths
  // can be canonicalised by the server with different casing than the
  // declared assertion — /Login vs /login should not be a false miss).
  try {
    if (new RegExp(pattern, 'i').test(url)) {
      return { matched: true, stage: 'regex_original' };
    }
  } catch (_) { /* malformed regex falls through to stage 2/3 */ }

  // Stage 2: de-escaped variant. Only attempt when the pattern contains
  // a backslash — otherwise nothing to de-escape.
  if (pattern.indexOf('\\') !== -1) {
    const deEscaped = pattern.replace(/\\\\/g, '\\');
    if (deEscaped !== pattern) {
      try {
        if (new RegExp(deEscaped, 'i').test(url)) {
          return { matched: true, stage: 'regex_deescaped' };
        }
      } catch (_) { /* fall through */ }
    }
  }

  // Stage 3: semantic path comparison. Strip regex anchors + escape
  // characters from the pattern to recover the intended path, then
  // compare against the URL's parsed pathname.
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch (_) { /* keep raw url */ }

  // Detect whether the pattern uses non-trivial regex syntax beyond a
  // simple path. If it does, semantic path-compare doesn't apply — a
  // pattern like "(login|signup)" or "[0-9]+" is genuinely a regex and
  // should fail rather than be mangled into a path string.
  const hasComplexRegexSyntax = /[\[\]\(\)\|\+\?\{\}\*]|\\[bsdwSDWB]/.test(pattern);
  if (!hasComplexRegexSyntax) {
    const literalPath = pattern
      .replace(/^\^/, '')        // strip leading anchor
      .replace(/\$$/, '')         // strip trailing anchor
      .replace(/\\\\\./g, '.')    // \\. → . (paranoid; covers triple-escape too)
      .replace(/\\\./g, '.')      // \. → .
      .replace(/\\\//g, '/')      // \/ → /
      .replace(/^\/+/, '/');      // collapse leading slashes

    if (pathname && literalPath) {
      if (pathname === literalPath) return { matched: true, stage: 'path_exact' };
      if (pathname.endsWith(literalPath)) return { matched: true, stage: 'path_suffix' };
      if (pathname.indexOf(literalPath) !== -1) return { matched: true, stage: 'path_contains' };
    }
  }

  // Stage 4 (Edge Case 2 — full-URL / query-string tolerance). A 'must' URL
  // assertion must NOT hard-fail on volatile parts of the address: a dynamic
  // token (?session_id=…), a trailing slash, or an environment subdomain. This
  // fires when the pattern was authored as a full URL ("https://app/x?token=1")
  // or otherwise carries a query/fragment — the earlier stages skip it because
  // '?' reads as regex syntax. We compare PATHS only, query/host stripped and
  // trailing slashes normalised. This stage only ever ADDS a match (it can
  // never turn a real match into a miss), so it cannot introduce false fails.
  try {
    const stripToPath = (s) => {
      let p = s;
      if (/^https?:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch (_) { /* keep raw */ } }
      return p.split('?')[0].split('#')[0]
        .replace(/^\^/, '').replace(/\$$/, '')
        .replace(/\\\./g, '.').replace(/\\\//g, '/')
        .replace(/\/+$/, '');                 // normalise trailing slash
    };
    const patHadVolatile = /^https?:\/\//i.test(pattern) || pattern.indexOf('?') !== -1 || pattern.indexOf('#') !== -1;
    if (patHadVolatile) {
      const patPath = stripToPath(pattern);
      let urlPath = url;
      try { urlPath = new URL(url).pathname; } catch (_) { urlPath = url.split('?')[0].split('#')[0]; }
      urlPath = urlPath.replace(/\/+$/, '');
      // Guard against the empty/root path matching everything.
      if (patPath && patPath !== '' && patPath !== '/' && urlPath) {
        if (urlPath === patPath
          || urlPath.endsWith(patPath)
          || urlPath.indexOf(patPath) !== -1) {
          return { matched: true, stage: 'path_query_stripped' };
        }
      }
    }
  } catch (_) { /* fall through to no_match */ }

  return { matched: false, stage: 'no_match' };
}

/**
 * Edge Case 3 — exact-data guard for the semantic fallback.
 *
 * The semantic verifier exists to bridge WORDING differences ("confirmation
 * page" ≈ "Thank you for your order!"). It must NEVER paper over a mismatch in
 * hard data — an account number, a price, an order ID, a security token. The
 * verifier's prompt already forbids this, but a prompt is not a guarantee, so
 * we wall it off in code: when the assertion's expected VALUE *is itself* a
 * data token, we skip the LLM rescue entirely and let the deterministic miss
 * stand. (ACT-888 vs ACT-999 must FAIL, not be rescued as "close enough".)
 *
 * Deliberately ANCHORED to the whole string so it fires only when the expected
 * value is data-DOMINANT — "Order #12345 confirmed" (a sentence) is NOT caught,
 * but "ACT-999", "$99.99", "50%", "100482" are.
 */
function isExactDataAssertion(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (!t) return false;
  if (/^[$€£¥]?\s?\d[\d,]*(\.\d+)?\s*%?$/.test(t)) return true;        // 1,234.56 · $99.99 · 50%
  if (/^[A-Za-z]{1,6}[-_# ]?\d{3,}[A-Za-z0-9-]*$/.test(t)) return true; // ACT-999 · ORD#12345 · INV_0001
  if (/^[0-9a-f]{16,}$/i.test(t)) return true;                         // hex token / hash
  if (/^\d{4,}$/.test(t)) return true;                                 // raw account / token digits
  return false;
}

/**
 * PAGE assertion matcher — multi-signal page identity verification.
 *
 * Replaces the brittle "URL pattern alone identifies a page" model. A PAGE
 * assertion declares text + role + url signals; this matcher scores the
 * current snapshot against them and returns a deterministic verdict.
 *
 * Scoring (locked by RFC with two friends, 2026-05-30):
 *   role  match  = 2 points   (most structural — accessibility tree role+name
 *                              is the strongest evidence of page identity;
 *                              survives copy changes and route refactors)
 *   text  match  = 1 point    (content; vulnerable to marketing wording shifts)
 *   url   match  = 1 point    (location; vulnerable to SUT path variance)
 *   threshold    = 2 points to pass
 *
 *   Each signal TYPE contributes at most its declared weight — multiple
 *   variants within the same channel never double-count. This prevents
 *   "navbar pollution" false passes (text:["Login","Sign in"] both matching
 *   the navbar on a homepage doesn't add up to 2).
 *
 *   primaryIndicator: optional fast-path. If declared AND it matches, the
 *   matcher returns immediately with stage='primary_indicator' and the
 *   trace records "✓ identified by primary indicator". No scoring required.
 *
 * Per-signal matching is DETERMINISTIC ONLY (FRIEND R2). The page-level
 * semantic LLM rescue (Day 3 wiring) escalates if the deterministic quorum
 * fails — but per-signal text/role evaluation never invokes the semantic
 * fallback by itself. This keeps the rescue mechanisms strictly scoped:
 *   - Fix 5 semantic equivalence → for content drift within an element
 *   - PAGE-level rescue → for identity drift across the whole page
 *
 * Day 4 will add atlas-augmented signals (half-weight until verifiedCount
 * ≥ 2). Today's matcher only sees the architect-declared signals.
 *
 * @param session       MCP session (for default snapshot, project equivalence
 *                      map; pass `null` only in unit tests that supply opts)
 * @param payload       The PAGE assertion's payload:
 *                      { pageName, expectedSignals: { text?, role?, url? },
 *                        primaryIndicator? }
 * @param opts          Optional overrides for testability + future atlas wiring:
 *                      { snapshot, currentUrl, signalWeightMultipliers,
 *                        atlasSignals }
 * @returns             { matched, score, threshold, signalsHit, primaryMatched,
 *                        evidence, stage }
 */
// A PAGE assertion's `pageName` is a human IDENTITY LABEL, not data. The
// architect sometimes fills it with a row-variable data token
// ("{{expectedValidationError}}"), an error phrase, "(none)", etc. Such a label
// must NEVER drive a PAGE verdict. This predicate marks a pageName as UNTRUSTED
// (purely off SHAPE — never a site string) so the semantic-rescue claim is built
// from the declared structural signals instead of the garbage label.
// Shared with the data-matrix binder so the two de-poison layers never drift.
const { isUntrustedPageName } = require('../lib/pageIdentity');

function matchPageAssertion(session, payload, opts = {}) {
  const SCORE_WEIGHTS = { role: 2, text: 1, url: 1 };
  // Day 4 — atlas signals contribute at half weight until verifiedCount>=2,
  // at which point they're promoted to 'verified' and contribute at full
  // weight. This is the strict-corroboration trigger from the friend RFC.
  const ATLAS_UNVERIFIED_FACTOR = 0.5;
  const THRESHOLD = 2;

  const snapshot = typeof opts.snapshot === 'string'
    ? opts.snapshot
    : (session && typeof session.lastSnapshot === 'string' ? session.lastSnapshot : '');
  const currentUrl = typeof opts.currentUrl === 'string'
    ? opts.currentUrl
    : (session && typeof session.currentUrl === 'string' ? session.currentUrl : '');

  const result = {
    matched: false,
    score: 0,
    threshold: THRESHOLD,
    signalsHit: { text: null, role: null, url: null },
    primaryMatched: false,
    evidence: '',
    stage: 'no_match',
  };

  if (!payload || typeof payload !== 'object') {
    result.evidence = 'PAGE matcher received empty payload';
    return result;
  }

  const signals = (payload.expectedSignals && typeof payload.expectedSignals === 'object')
    ? payload.expectedSignals
    : {};

  // Day 4 — merge architect-declared signals (full weight) with atlas signals
  // (full weight if verified, half weight if unverified). Each entry is
  // tagged { value, weightFactor, source } so the trace can report WHICH
  // signal source actually contributed.
  const declToEntries = (arr, source) => (Array.isArray(arr) ? arr : []).map((v) => ({
    value: v, weightFactor: 1, source,
  }));
  const atlasToEntries = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map((e) => {
      if (!e || typeof e !== 'object') return null;
      const verified = e.source === 'verified' || (typeof e.verifiedCount === 'number' && e.verifiedCount >= 2);
      return {
        value: e.value,
        weightFactor: verified ? 1 : ATLAS_UNVERIFIED_FACTOR,
        source: verified ? 'atlas_verified' : 'atlas_unverified',
      };
    }).filter(Boolean);
  };
  const atlasSignals = (opts.atlasSignals && typeof opts.atlasSignals === 'object')
    ? opts.atlasSignals
    : {};
  const textSignals = [
    ...declToEntries(signals.text, 'architect'),
    ...atlasToEntries(atlasSignals.text),
  ];
  const roleSignals = [
    ...declToEntries(signals.role, 'architect'),
    ...atlasToEntries(atlasSignals.role),
  ];
  const urlSignals  = [
    ...declToEntries(signals.url, 'architect'),
    ...atlasToEntries(atlasSignals.url),
  ];

  // ── Helpers — deterministic-only, scoped to this call ──────────────────
  const normalizeText = (s) => {
    if (typeof s !== 'string') return '';
    let v = normalizeLlmString(s).toLowerCase().replace(/\s+/g, ' ').trim();
    // Project equivalences: collapse architect-declared synonyms before
    // substring search. Reuses the same map populated by the Fix 5 flow
    // (Project.assertionEquivalences). Deterministic — pure lookup, no LLM.
    const equiv = session && typeof session.assertionEquivalences === 'object'
      ? session.assertionEquivalences
      : null;
    if (equiv && equiv.canonicalForVariant && typeof equiv.canonicalForVariant === 'function') {
      v = equiv.canonicalForVariant(v) || v;
    }
    return v;
  };
  const normalizedSnap = normalizeText(snapshot);

  // Substring text-channel match (any text signal in the snapshot).
  const matchTextSignal = (needle) => {
    const n = normalizeText(needle);
    if (!n || n.length < 2) return false;          // guard against degenerate signals
    return normalizedSnap.indexOf(n) !== -1;
  };

  // Role-channel match. Each role signal is { role, name? }.
  //   { role: "textbox", name: "Username" }
  //     ↔ snapshot line "  - textbox \"Username\" [ref=e11]"
  //
  // We don't depend on the brittle ref token; we match the role keyword at
  // line-start and the accessible-name string anywhere on the same line.
  const matchRoleSignal = (sig) => {
    if (!sig || typeof sig !== 'object') return false;
    const role = typeof sig.role === 'string' ? sig.role.toLowerCase().trim() : '';
    if (!role) return false;
    const nameNeedle = typeof sig.name === 'string' ? sig.name.trim() : '';
    const lineRe = new RegExp(`^\\s*-?\\s*${role.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'mi');
    if (!nameNeedle) return lineRe.test(snapshot);
    // role + name: find every line where the role appears at start, then
    // check the name substring (case-insensitive) on the SAME line.
    const lines = snapshot.split(/\r?\n/);
    const nameNeedleLc = nameNeedle.toLowerCase();
    for (const l of lines) {
      if (lineRe.test(l) && l.toLowerCase().indexOf(nameNeedleLc) !== -1) return true;
    }
    return false;
  };

  // URL-channel match. Reuses the 3-stage tolerant matcher from Fix 10 so
  // over-escape / anchor-on-full-URL / case-mismatch failures don't drop
  // the URL point on otherwise-correct pages.
  const matchUrlSignal = (pattern) => {
    if (typeof pattern !== 'string' || !pattern) return false;
    const cleaned = normalizeLlmString(pattern);
    if (!currentUrl) return false;
    return matchUrlPattern(cleaned, currentUrl).matched;
  };

  // ── forbiddenSignals hard-deny channel ────────────────────────────────
  // A PAGE assertion may declare signals that MUST be ABSENT (e.g. a negative
  // login row asserts "remain on login" — the dashboard/home markers must NOT
  // appear). If ANY forbidden signal is present on the settled page, the page
  // identity is REJECTED outright. This both implements the "dashboard absent"
  // requirement for negative rows AND gates the single-signal primaryIndicator
  // fast-path below — so a transitional/authenticated page that still happens
  // to show a login affordance can no longer fast-pass a remain-on-login claim.
  // Keyed off declared signals + ARIA role/name, never a site string. Inert
  // unless an assertion declares forbiddenSignals, so existing PAGE assertions
  // are unaffected.
  const forbidden = (payload.forbiddenSignals && typeof payload.forbiddenSignals === 'object')
    ? payload.forbiddenSignals : null;
  if (forbidden) {
    const fbText = Array.isArray(forbidden.text) ? forbidden.text : [];
    const fbRole = Array.isArray(forbidden.role) ? forbidden.role : [];
    for (const t of fbText) {
      if (matchTextSignal(t)) {
        result.matched = false;
        result.score = 0;
        result.stage = 'forbidden_present';
        result.evidence = `PAGE rejected: forbidden text "${String(t).slice(0, 40)}" is present — the page is NOT the expected one (e.g. it navigated to a post-auth destination when it should have stayed).`;
        return result;
      }
    }
    for (const r of fbRole) {
      if (matchRoleSignal(r)) {
        result.matched = false;
        result.score = 0;
        result.stage = 'forbidden_present';
        result.evidence = `PAGE rejected: forbidden role ${r && r.role}${r && r.name ? `[name=${r.name}]` : ''} is present — the page is NOT the expected one.`;
        return result;
      }
    }
    // review P1d — forbidden URL: a negative-login row that lands on /dashboard
    // without visible "Dashboard" text must still be caught by the hard-deny.
    const fbUrl = Array.isArray(forbidden.url) ? forbidden.url : [];
    for (const u of fbUrl) {
      if (matchUrlSignal(u)) {
        result.matched = false;
        result.score = 0;
        result.stage = 'forbidden_present';
        result.evidence = `PAGE rejected: current URL matches forbidden destination "${String(u).slice(0, 60)}" — navigated to a page that should NOT be reached.`;
        return result;
      }
    }
  }

  // ── primaryIndicator fast-path ─────────────────────────────────────────
  if (payload.primaryIndicator && typeof payload.primaryIndicator === 'object') {
    const pi = payload.primaryIndicator;
    let primaryHit = false;
    let primaryHow = '';
    if (typeof pi.role === 'string' && pi.role) {
      if (matchRoleSignal(pi)) { primaryHit = true; primaryHow = `role=${pi.role}${pi.name ? `[name=${pi.name}]` : ''}`; }
    } else if (typeof pi.text === 'string' && pi.text) {
      if (matchTextSignal(pi.text)) { primaryHit = true; primaryHow = `text=${pi.text}`; }
    } else if (typeof pi.url === 'string' && pi.url) {
      if (matchUrlSignal(pi.url)) { primaryHit = true; primaryHow = `url=${pi.url}`; }
    }
    if (primaryHit) {
      result.matched = true;
      result.primaryMatched = true;
      result.score = THRESHOLD;          // primary indicator authoritatively confirms identity
      result.stage = 'primary_indicator';
      result.evidence = `identified by primary indicator: ${primaryHow}`;
      result.signalsHit = { text: null, role: null, url: null };
      return result;
    }
  }

  // ── Channel scoring (each channel contributes at most its declared weight) ─
  //
  // For each channel we iterate EVERY variant (architect + atlas), find the
  // matching variant with the HIGHEST weightFactor, and credit the channel
  // with (SCORE_WEIGHTS[channel] * bestFactor). This way:
  //   - architect signal alone (factor=1) → full channel weight
  //   - atlas verified signal alone (factor=1) → full channel weight
  //   - atlas unverified signal alone (factor=0.5) → half channel weight
  //   - both architect AND atlas matching → architect wins (factor=1, no double-count)
  // The matched* tracker keeps a structured record so the corroboration
  // trigger (Day 4b) can identify WHICH atlas entries deserve a
  // verifiedCount bump.
  let score = 0;
  const evidenceParts = [];
  const matchedAtlasSignals = { text: [], role: [], url: [] };

  const scoreChannel = (channel, entries, channelWeight, matchFn, valueDescriber) => {
    let bestFactor = 0;
    let bestValue = null;
    let bestSource = null;
    for (const e of entries) {
      if (!matchFn(e.value)) continue;
      if (e.source === 'atlas_verified' || e.source === 'atlas_unverified') {
        matchedAtlasSignals[channel].push(e.value);
      }
      if (e.weightFactor > bestFactor) {
        bestFactor = e.weightFactor;
        bestValue = e.value;
        bestSource = e.source;
      }
    }
    if (bestFactor > 0) {
      const contribution = channelWeight * bestFactor;
      score += contribution;
      result.signalsHit[channel] = channel === 'role'
        ? `${bestValue.role}${bestValue.name ? `[name=${bestValue.name}]` : ''}`
        : bestValue;
      evidenceParts.push(`${channel}=${valueDescriber(bestValue)} (+${contribution.toFixed(1)} via ${bestSource})`);
    }
  };

  scoreChannel('role', roleSignals, SCORE_WEIGHTS.role, matchRoleSignal,
    (v) => `${v.role}${v.name ? `[name=${v.name}]` : ''}`);
  scoreChannel('text', textSignals, SCORE_WEIGHTS.text, matchTextSignal, JSON.stringify);
  scoreChannel('url',  urlSignals,  SCORE_WEIGHTS.url,  matchUrlSignal,  JSON.stringify);

  result.score = score;
  result.matchedAtlasSignals = matchedAtlasSignals;     // for the corroboration trigger
  if (score >= THRESHOLD) {
    result.matched = true;
    result.stage = score >= SCORE_WEIGHTS.role + SCORE_WEIGHTS.text + SCORE_WEIGHTS.url
      ? 'all_channels_matched'
      : 'quorum_reached';
    result.evidence = `PAGE score ${score}/${THRESHOLD}: ${evidenceParts.join(' & ')}`;
  } else {
    result.stage = 'below_threshold';
    result.evidence = score === 0
      ? `PAGE score 0/${THRESHOLD}: no signal matched`
      : `PAGE score ${score}/${THRESHOLD}: only ${evidenceParts.join(' & ')} matched — needs threshold ${THRESHOLD}`;
  }
  return result;
}

/**
 * PAGE assertion check — Day 3 dispatcher.
 *
 * Combines:
 *   1. The deterministic matcher (matchPageAssertion)
 *   2. PAGE-level semantic LLM rescue (when quorum fails AND session has
 *      semantic fallback enabled). The rescue asks ONE question of the LLM:
 *      "is this the <pageName> page?" — NOT a per-signal text/role question
 *      (FRIEND R2 boundary).
 *   3. Atlas write on rescue success — session.recordRescueAtlas persists
 *      distinctive signals extracted from the rescued page so future runs
 *      identify it deterministically.
 *
 * Returns the legacy assertion-check shape so the caller (conductor /
 * postLoopRatify / agent tool call) doesn't need a new code path:
 *
 *   {
 *     content: [{ type: 'text', text: JSON.stringify({
 *       matched, reason, evidence, source?, score?, threshold?, signalsHit?
 *     })}],
 *     isError: false
 *   }
 *
 * Outcome mapping:
 *   - score >= threshold                       → matched, source='deterministic'
 *   - score < threshold + no semantic fallback → not_matched (reason='page_quorum_failed')
 *   - score < threshold + semantic matched     → matched, source='semantic_rescue'
 *                                                + atlas write
 *   - score < threshold + semantic not_matched → not_matched (reason='semantic_not_matched')
 *   - score < threshold + semantic uncheckable → uncheckable (reason='semantic_uncheckable')
 *   - empty snapshot                           → uncheckable (reason='no_snapshot')
 */
async function _checkPageAssertion(session, pagePayload, args) {
  // Cached-first validation: a matching action-time snapshot returns
  // immediately; a miss may acquire one bounded fresh snapshot. Batch callers
  // intentionally retain their shared snapshot and never refresh here.
  const inBatch = session && session._assertionBatchActive === true;
  let snap = session?.lastSnapshot || '';
  let currentUrl = session?.currentUrl || '';
  let refreshed = false;
  let refreshAcquired = false;
  const refreshOnce = async () => {
    if (refreshed || inBatch || !session?.client) return null;
    refreshed = true;
    const fresh = await _refreshValidationSnapshotOnce(session);
    if (fresh) {
      refreshAcquired = true;
      snap = fresh;
      currentUrl = session?.currentUrl || currentUrl;
    }
    return fresh;
  };
  if (isTransientSnapshotFailure(snap)) {
    try { await refreshOnce(); } catch (_) {}
  }
  if (isTransientSnapshotFailure(snap)) {
    // Empty OR a timeout/error payload — never a settled page on which the
    // signals are genuinely absent. Uncheckable + RETRYABLE (postLoopRatify
    // re-snapshots and re-checks), NEVER a miss decided from one bad snapshot.
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false, reason: 'transient_snapshot_timeout',
        evidence: 'PAGE assertion: no usable snapshot (empty or a timeout/error payload) to evaluate signals against — retryable, re-checked by postLoopRatify; not a genuine miss.',
      }) }],
      isError: false,
    };
  }

  // Day 4 — read atlas-augmented signals if the session has them bound.
  // We pass them through opts to matchPageAssertion so the matcher can
  // apply half-weight to unverified entries. For Day 3, we just pass the
  // raw atlas; matchPageAssertion's signature accepts opts.atlasSignals
  // (no-op until Day 4 wires the read path).
  let atlasSignals = null;
  if (session?.pageAtlas && typeof session.pageAtlas === 'object') {
    const entry = session.pageAtlas[pagePayload.pageName];
    if (entry && entry.signals) atlasSignals = entry.signals;
  }

  let result = matchPageAssertion(session, pagePayload, {
    snapshot: snap,
    currentUrl,
    atlasSignals,
  });

  if (!result.matched && !refreshed && !inBatch && session?.client) {
    try {
      const fresh = await refreshOnce();
      if (fresh) {
        result = matchPageAssertion(session, pagePayload, {
          snapshot: snap,
          currentUrl,
          atlasSignals,
        });
      }
    } catch (_) { /* keep the cached deterministic result */ }
  }

  if (!result.matched && refreshed && !refreshAcquired && !inBatch) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'transient_snapshot_timeout',
        evidence: 'The cached PAGE observation did not match, but the single bounded fresh-snapshot read failed. QAAI preserved the cache and treats this as uncheckable, not a genuine page miss.',
      }) }],
      isError: false,
    };
  }

  // Deterministic pass — record source for telemetry. Strict-corroboration
  // bump (Day 4b): if the deterministic pass agrees with atlas entries
  // (i.e., the architect's signals matched AND atlas signals would have
  // also matched), increment verifiedCount on those atlas entries. The
  // matcher returns matchedAtlasSignals capturing exactly which atlas
  // entries hit on this run.
  if (result.matched) {
    // Best-effort atlas bump (don't block the verdict on it).
    const matchedAtlas = result.matchedAtlasSignals || { text: [], role: [], url: [] };
    const anyAtlasMatched = (matchedAtlas.text.length || matchedAtlas.role.length || matchedAtlas.url.length) > 0;
    if (session?.bumpAtlasVerifiedCount && pagePayload.pageName && anyAtlasMatched) {
      try {
        await session.bumpAtlasVerifiedCount({
          pageName: pagePayload.pageName,
          matchedSignals: matchedAtlas,
        });
      } catch (_) { /* telemetry only */ }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: true,
        reason: result.stage,
        evidence: result.evidence,
        source: 'deterministic',
        score: result.score,
        threshold: result.threshold,
        signalsHit: result.signalsHit,
        primaryMatched: result.primaryMatched,
      }) }],
      isError: false,
    };
  }

  // Quorum failed. If semantic fallback is OFF for this run, surface the
  // deterministic miss as-is.
  if (!(session?.semanticFallback === true && typeof session?.semanticVerify === 'function')) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'page_quorum_failed',
        evidence: result.evidence,
        score: result.score,
        threshold: result.threshold,
      }) }],
      isError: false,
    };
  }

  // PAGE-level semantic rescue. ONE question, page-scoped — never recurses
  // into per-signal LLM checks (FRIEND R2). Build a human-readable claim
  // from the declared signals so the verifier knows what "this page" means.
  const pageName = String(pagePayload.pageName || 'this page');
  const signalsDecl = pagePayload.expectedSignals || {};
  const signalSummary = [
    Array.isArray(signalsDecl.text) && signalsDecl.text.length
      ? `text=[${signalsDecl.text.slice(0, 3).map((v) => `"${String(v).slice(0, 40)}"`).join(', ')}]`
      : null,
    Array.isArray(signalsDecl.role) && signalsDecl.role.length
      ? `role=[${signalsDecl.role.slice(0, 3)
          .map((r) => r && typeof r === 'object' ? `${r.role}${r.name ? `[name=${r.name}]` : ''}` : '')
          .filter(Boolean).join(', ')}]`
      : null,
    Array.isArray(signalsDecl.url) && signalsDecl.url.length
      ? `url=[${signalsDecl.url.slice(0, 3).map((v) => `"${v}"`).join(', ')}]`
      : null,
  ].filter(Boolean).join(' ');
  // De-poison the rescue claim: when pageName is an UNTRUSTED label (an unbound
  // data token, a sentence/error phrase, "(none)", …) it is DATA, not a page
  // identity — asking the LLM "is this the '{{expectedValidationError}}' page?"
  // wrongly rejects a correct page. Phrase the claim from the declared
  // structural signals (the real fingerprint) instead. The LLM stays in the
  // loop (no looser deterministic match), so a genuinely-wrong page still fails.
  const pageNameTrusted = !isUntrustedPageName(pagePayload.pageName);
  const assertionText = pageNameTrusted
    ? `The user is on the "${pageName}" page${signalSummary ? `, normally identified by ${signalSummary}` : ''}.`
    : (signalSummary
        ? `The user is on the page identified by ${signalSummary}.`
        : `The user is on the "${pageName}" page.`);

  let verdict = null;
  try {
    verdict = await session.semanticVerify({
      assertionText,
      assertionType: 'PAGE',
      snapshot: snap,
    });
  } catch (err) {
    verdict = null;
  }

  if (!verdict || !verdict.outcome) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'page_quorum_failed',
        evidence: `${result.evidence}; semantic rescue unavailable`,
        score: result.score,
      }) }],
      isError: false,
    };
  }

  if (verdict.outcome === 'matched') {
    // Write atlas — extract distinctive signals from the rescued page so
    // future runs identify it deterministically. The conductor's binding
    // (session.recordRescueAtlas) merges them into Project.pageAtlas and
    // refreshes session.pageAtlas in place.
    if (session?.recordRescueAtlas && pageNameTrusted) {
      try {
        const extracted = extractPageSignals(snap, currentUrl);
        await session.recordRescueAtlas({
          pageName,
          signals: extracted,
          source: 'semantic_rescue',
        });
      } catch (_) { /* telemetry only — don't block the verdict on atlas write */ }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: true,
        reason: 'semantic_rescue',
        evidence: `PAGE-level semantic rescue: ${verdict.reasoning || 'matched by LLM'} (deterministic score was ${result.score}/${result.threshold})`,
        source: 'semantic_rescue',
        score: result.score,
        threshold: result.threshold,
      }) }],
      isError: false,
    };
  }
  if (verdict.outcome === 'uncheckable') {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'semantic_uncheckable',
        evidence: `PAGE-level semantic rescue inconclusive: ${verdict.reasoning || 'LLM could not decide'}`,
      }) }],
      isError: false,
    };
  }
  // verdict.outcome === 'not_matched'
  return {
    content: [{ type: 'text', text: JSON.stringify({
      matched: false,
      reason: 'semantic_not_matched',
      evidence: `PAGE-level semantic rescue rejected: ${verdict.reasoning || 'LLM said this is not the page'}`,
    }) }],
    isError: false,
  };
}

// Translate a matcher signalsHit.role tag ("textbox[name=Username]" or just
// "textbox") back into a {role, name} object — for the atlas verifiedCount
// bump path which needs the structured form.
function parseSignalHitToRole(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  const m = tag.match(/^([a-z][a-z0-9_-]*)(?:\[name=([^\]]+)\])?$/i);
  if (!m) return null;
  const role = (m[1] || '').toLowerCase();
  const name = m[2] || '';
  return { role, name };
}

/**
 * Synthetic browser_extract_data dispatcher.
 *
 * Wraps browser_evaluate with input validation, primitive-only result
 * guards, and dual-write persistence (session.sharedDataCurrentCase for
 * same-case substitution + session.persistSharedData for durable storage
 * read by downstream cases).
 *
 * The tool ALWAYS returns a tool_result the agent can read — even on
 * validation failures — so the agent learns from a clear text message
 * instead of getting an unhelpful protocol error.
 */
async function extractData(session, args) {
  const { isPermittedKey, isPermittedValue } = require('./sharedDataStore');

  const target    = typeof args.target    === 'string' ? args.target.trim()    : '';
  const expr      = typeof args.expr      === 'string' ? args.expr.trim()      : '';
  const targetKey = typeof args.targetKey === 'string' ? args.targetKey.trim() : '';
  const element   = typeof args.element   === 'string' ? args.element.trim()   : '';

  if (!target || !expr || !targetKey) {
    return {
      isError: true,
      content: [{ type: 'text', text:
        '### Error browser_extract_data requires target, expr, AND targetKey. ' +
        'target is the [ref=eN] of the element; expr is a JS expression on `el` returning a primitive; ' +
        'targetKey is the JS-identifier name to bind the value under (e.g. "trackingId").' }],
    };
  }
  if (!isPermittedKey(targetKey)) {
    return {
      isError: true,
      content: [{ type: 'text', text:
        `### Error browser_extract_data: targetKey "${targetKey}" is not a valid JS identifier. ` +
        'Use camelCase up to 64 chars (e.g. "trackingId", "orderId", "confirmationCode").' }],
    };
  }

  // Wrap the user expression in a try/catch so a broken expression returns
  // null rather than throwing — we want a structured tool result, not a
  // protocol exception.
  const fnString = `(el) => { try { return ${expr}; } catch (e) { return null; } }`;

  let evalResult;
  try {
    if (!session?.client || typeof session.client.callTool !== 'function') {
      return {
        isError: true,
        content: [{ type: 'text', text: '### Error browser_extract_data: no MCP client on session — cannot evaluate.' }],
      };
    }
    evalResult = await session.client.callTool({
      name: 'browser_evaluate',
      arguments: {
        element: element || `<extract ${targetKey}>`,
        ref: target,
        function: fnString,
      },
    });
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `### Error browser_extract_data: browser_evaluate failed — ${err.message || err}` }],
    };
  }

  if (evalResult?.isError) {
    return {
      isError: true,
      content: [{ type: 'text', text:
        `### Error browser_extract_data: browser_evaluate returned an error. ` +
        `Make sure target=${JSON.stringify(target)} is a current [ref=eN] from a fresh browser_snapshot. ` +
        (textOfContent(evalResult.content) || '') }],
    };
  }

  // Parse the result text. browser_evaluate's MCP response shape varies
  // a bit across the playwright-mcp versions, but the captured text always
  // includes a "Result:" line followed by the JSON-stringified return.
  const fullText = textOfContent(evalResult?.content) || '';
  const value = parseEvaluateReturnValue(fullText);

  if (value === null || value === undefined) {
    // A failed READ must NEVER hard-block the journey. Returning isError here made the
    // conductor treat an empty extraction as a tool failure → retry → burn the error
    // budget → stop the run and block every remaining (often unrelated) step. A value
    // simply not being readable is not proof the step failed. So return a SOFT,
    // non-error signal: the agent stops retrying the extraction and confirms the
    // step by OBSERVING the current snapshot (presence of mind), exactly as the user
    // directed. Generic — applies to any extraction on any site.
    return {
      isError: false,
      content: [{ type: 'text', text:
        `QAAI_EXTRACT_EMPTY: no readable value found for "${targetKey}" (the element holds no text/attribute/property, or is not present yet). ` +
        'This is NOT a failure and must NOT be retried. If this step verifies that something appears, read the current page from browser_snapshot and emit the step verdict from what you actually observe — do not block on the empty read.' }],
    };
  }
  if (typeof value === 'object') {
    return {
      isError: true,
      content: [{ type: 'text', text:
        `### Error browser_extract_data: expression returned an object/array (typeof=${Array.isArray(value) ? 'array' : 'object'}). ` +
        'The shared-data bag is FLAT — return a string, number, or boolean only. ' +
        'For compound data, make multiple extraction calls with distinct targetKey values.' }],
    };
  }
  if (!isPermittedValue(value)) {
    return {
      isError: true,
      content: [{ type: 'text', text:
        `### Error browser_extract_data: expression returned an unsupported type (${typeof value}). ` +
        'Permitted types: string, number, boolean.' }],
    };
  }

  // SAME-CASE working scratch — synchronous bind so any subsequent step
  // in this case can reference ${targetKey} immediately.
  if (!session.sharedDataCurrentCase || typeof session.sharedDataCurrentCase !== 'object') {
    session.sharedDataCurrentCase = {};
  }
  session.sharedDataCurrentCase[targetKey] = value;

  // DURABLE Run.sharedData write — async, best-effort. Bound by the
  // conductor's session setup. Failing this should NOT fail the tool
  // call — the working scratch already carries the value for this case;
  // downstream cases just won't see it. The error surfaces in the trace.
  let persistedDurably = false;
  let persistError = null;
  if (typeof session.persistSharedData === 'function') {
    try {
      await session.persistSharedData(targetKey, value);
      persistedDurably = true;
    } catch (err) {
      persistError = err?.message || String(err);
    }
  }

  const valueDisplay = JSON.stringify(value);
  const lines = [
    `extracted ${targetKey} = ${valueDisplay}`,
    persistError
      ? `(warning: durable write to Run.sharedData failed — ${persistError}. The value is available to LATER STEPS in this case via \${${targetKey}} but will NOT be visible to downstream cases.)`
      : persistedDurably
        ? `(persisted to Run.sharedData — visible to downstream cases that declare requiresData=["${targetKey}"])`
        : `(in-memory only — no durable persistence binding on this session; later steps in THIS case can reference \${${targetKey}}, downstream cases cannot.)`,
  ];
  return {
    isError: false,
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

/**
 * Parse the "Result:" line from a browser_evaluate response text.
 *
 * playwright-mcp returns text along the lines of:
 *
 *   - Ran Playwright code: ...
 *   - Result: "1Z9999999999999999"
 *   - Page state: ...
 *
 * (Or sometimes just "Result: <value>" with no quotes around primitive numbers.)
 *
 * We grab the substring after the LAST "Result:" marker (handles the rare
 * case where the page snapshot contains the literal string), strip trailing
 * sections separated by "Page state:" / blank lines, JSON.parse if possible
 * (preserves type for numbers/booleans/strings), otherwise return raw.
 */
function parseEvaluateReturnValue(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // The MCP labels the return value as either "Result:" (older playwright-mcp)
  // or "### Result" (markdown heading, no colon — newer @playwright/mcp). The
  // old code only matched "Result:", so on the newer build EVERY evaluate
  // return parsed as null — silently breaking DOM-extraction AND any
  // browser_evaluate-backed assertion. Match the LAST occurrence of either
  // marker form (specific markers only — never a bare "Result" in page copy).
  const re = /(?:#{1,6}\s*Result|Result:)\s*/g;
  let markerIdx = -1, markerLen = 0, mm;
  while ((mm = re.exec(text)) !== null) { markerIdx = mm.index; markerLen = mm[0].length; }
  if (markerIdx === -1) return null;
  let tail = text.slice(markerIdx + markerLen);
  // Cut at the next section break (heuristic for the common shapes). Newer
  // @playwright/mcp appends a "### Ran Playwright code" markdown heading AFTER the
  // result block, so cut at any subsequent markdown heading too — otherwise the
  // trailing "### Ran..." text gets concatenated onto the JSON and JSON.parse fails
  // (which silently broke every object-returning browser_evaluate, incl. DOM excavation).
  const breakIdx = tail.search(/(\n#{1,6}\s|\n\s*-\s|\n\n|\nPage state:|\nAccessibility tree:)/);
  if (breakIdx !== -1) tail = tail.slice(0, breakIdx);
  tail = tail.trim();
  if (tail === '' || tail === 'undefined' || tail === 'null') return null;
  // Best-effort JSON parse — preserves number/boolean/string types.
  try {
    return JSON.parse(tail);
  } catch (_) {
    // Raw string fallback (strip surrounding quotes if present).
    if (tail.startsWith('"') && tail.endsWith('"')) {
      try { return JSON.parse(tail); } catch (_) { /* fall through */ }
    }
    return tail;
  }
}

// Public helper — extract candidate atlas signals from a snapshot. Lives
// here so unit tests can exercise it without booting the pageAtlas module
// (which requires Prisma).
function extractPageSignals(snapshot, currentUrl) {
  // Lazy-load pageAtlas only when this code path is exercised, so the
  // matcher module can be unit-tested without depending on Prisma.
  try {
    const { extractSignalsFromSnapshot } = require('./pageAtlas');
    return extractSignalsFromSnapshot(snapshot, currentUrl);
  } catch (_) {
    return { text: [], role: [], url: [] };
  }
}

async function checkAssertion(session, args) {
  // FRIEND R1 — generic JSON-relay normalization. Every string-valued payload
  // on `args` is run through normalizeLlmString BEFORE the matcher sees it,
  // so over-escape (\\ → \) is collapsed for TEXT, ROLE, URL — not just URL.
  // Idempotent on well-formed strings. Rebuilds args once at the boundary
  // so all downstream functions (matchUrlPattern, _checkAssertionOnce,
  // semanticVerify) see a clean payload.
  if (args && typeof args === 'object') {
    args = { ...args };
    for (const k of [
      'expectedText', 'expectedRole', 'expectedUrlPattern',
      'unexpectedText', 'unexpectedRole', 'unexpectedUrlPattern',
      'assertion',
    ]) {
      if (typeof args[k] === 'string') args[k] = normalizeLlmString(args[k]);
    }
  }
  // PAGE assertion sprint — Day 3. If the caller passed a pageAssertion
  // payload, dispatch through matchPageAssertion + semantic rescue. PAGE
  // assertions are self-contained — they do NOT mix with the legacy flat
  // expectedX criteria below.
  if (args && args.pageAssertion && typeof args.pageAssertion === 'object') {
    return _checkPageAssertion(session, args.pageAssertion, args);
  }
  const { expectedRole, expectedText, expectedUrlPattern, expectedDownload,
          unexpectedText, unexpectedRole, unexpectedUrlPattern } = args || {};
  // Guard: at least one criterion must be supplied.
  if (!expectedRole && !expectedText && !expectedUrlPattern && !expectedDownload
      && !unexpectedRole && !unexpectedText && !unexpectedUrlPattern) {
    return _checkAssertionOnce(session, args);
  }
  // Download-only assertion: no snapshot involvement, polling adds no value.
  const isPageCriterion = !!(expectedRole || expectedText || expectedUrlPattern
                          || unexpectedRole || unexpectedText || unexpectedUrlPattern);
  if (!isPageCriterion) {
    return _checkAssertionOnce(session, args);
  }

  const evaluateCachedThenOneFresh = async () => {
    const startedAt = Date.now();
    const inBatch = session && session._assertionBatchActive === true;
    let attempts = 1;
    let refreshAttempted = false;
    let refreshAcquired = false;
    let result = await _checkAssertionOnce(session, args);
    let parsed = null;
    try { parsed = JSON.parse(result?.content?.[0]?.text); } catch (_) {}

    if (parsed?.matched !== true && session?.client && !inBatch) {
      refreshAttempted = true;
      try {
        const fresh = await _refreshValidationSnapshotOnce(session);
        if (fresh) {
          refreshAcquired = true;
          attempts += 1;
          result = await _checkAssertionOnce(session, args);
          try { parsed = JSON.parse(result?.content?.[0]?.text); } catch (_) { parsed = null; }
        }
      } catch (_) { /* preserve the cached observation */ }
    }

    if (refreshAttempted && !refreshAcquired && parsed?.matched !== true) {
      parsed = {
        ...(parsed || {}),
        matched: false,
        reason: 'transient_snapshot_timeout',
        evidence: 'The cached observation did not match, but the single bounded fresh-snapshot read failed. QAAI preserved the last good cache and treats this as uncheckable, not a genuine UI miss.',
      };
      result = {
        ...(result || {}),
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(parsed) }],
      };
    }

    if (parsed && result?.content?.[0]) {
      const elapsedMs = Date.now() - startedAt;
      parsed.validationAttempts = attempts;
      parsed.validationElapsedMs = elapsedMs;
      parsed.freshSnapshotAttempted = refreshAttempted;
      parsed.freshSnapshotAcquired = refreshAcquired;
      // Preserve the established telemetry/result keys for downstream readers,
      // but polling is no longer performed and therefore can never be capped.
      parsed.pollAttempts = attempts;
      parsed.pollElapsedMs = elapsedMs;
      result.content[0].text = JSON.stringify(parsed);
      try { session.telemetry?.noteAssertionPoll?.({ attempts, elapsedMs, capped: false }); } catch (_) {}
    }
    return result;
  };

  // Forbidden assertions use the same no-wait contract. Cached proof wins;
  // otherwise one fresh read confirms whether the forbidden state is present.
  if (unexpectedRole || unexpectedText || unexpectedUrlPattern) {
    return evaluateCachedThenOneFresh();
  }

  // Positive assertions follow the same cached-then-one-fresh path. Async page
  // readiness belongs to the action's postcondition, not a hidden 30-second
  // validation loop after the action has already completed.
  return evaluateCachedThenOneFresh();
}

async function _checkAssertionOnce(session, args) {
  // Snapshot freshness is orchestrated once by checkAssertion. This evaluator
  // is intentionally side-effect free so one assertion cannot trigger nested
  // refresh/stability cycles.
  const snap = session?.lastSnapshot || '';
  const { assertion, expectedRole, expectedText, expectedUrlPattern, expectedDownload,
          unexpectedRole, unexpectedText, unexpectedUrlPattern } = args || {};
  // Guard: at least one criterion must be supplied — otherwise we can't
  // verify anything and a naive matched=true would let hallucinated passes
  // through. Reject explicitly so the agent learns to supply criteria.
  if (!expectedRole && !expectedText && !expectedUrlPattern && !expectedDownload
      && !unexpectedRole && !unexpectedText && !unexpectedUrlPattern) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'missing_criteria',
        evidence: 'No expectedRole / expectedText / expectedUrlPattern / expectedDownload / unexpectedRole / unexpectedText / unexpectedUrlPattern supplied. Provide at least one so the assertion can actually be checked.',
      }) }],
      isError: false,
    };
  }
  // Download-only assertion: no snapshot needed.
  const isPageCriterion = !!(expectedRole || expectedText || expectedUrlPattern
                          || unexpectedRole || unexpectedText || unexpectedUrlPattern);
  if (isPageCriterion && isTransientSnapshotFailure(snap)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        matched: false,
        reason: 'transient_snapshot_timeout',
        evidence: 'No usable cached page snapshot is available. The assertion dispatcher may make one bounded fresh-snapshot attempt; this observation alone is not a genuine UI miss.',
      }) }],
      isError: false,
    };
  }

  const reasons = [];
  const evidenceBits = [];

  // Phase F.3.1 — whitespace-normalised comparison helper.
  //
  // Without this, table cell text rendered as "Chrome\n0.2%\n8.9 Mbps" never
  // matches an expectedText of "Chrome 0.2% 8.9 Mbps". The normaliser:
  //   1. JSON.parse pre-pass: when the haystack is the text of a JSON-shaped
  //      MCP response (typical for browser_evaluate, which JSON-stringifies
  //      the function's return value), parse it so literal "\n" / "\t"
  //      escapes become real whitespace.
  //   2. Lowercase.
  //   3. Strip JSON punctuation (`{ } [ ] " , :`) so structured returns like
  //      {"Browser":"Chrome","CPU":"0.2%"} flow together as searchable text.
  //   4. Collapse runs of whitespace to a single space.
  //   5. Trim ends.
  // Applied to BOTH sides of the comparison, so the normalisation is
  // symmetric.
  const decodeJsonish = (s) => {
    if (typeof s !== 'string') return '';
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch (_) {}
    return s;
  };
  // Generic connector-normalisation (load-bearing).
  //
  // The deterministic verifier used to fail on text differences that any
  // human tester would consider equivalent:
  //   "Name (A to Z)"     vs   assertion "A-Z"
  //   "Sort: A → Z"       vs   assertion "A-Z"
  //   "Sort: A -> Z"      vs   assertion "A-Z"
  //   "foo & bar"         vs   assertion "foo and bar"
  //   "10 – 20"            vs   assertion "10-20"
  //
  // Generic rule: between two short tokens (≤4 chars of alphanum/digit),
  // the connectors `to | -> | → | – | —` collapse to a single hyphen.
  // The ampersand collapses to "and" everywhere. Applied to BOTH sides
  // of the comparison so the normalisation stays symmetric.
  //
  // This is INTENTIONALLY generic — it has no knowledge of any SUT.
  // Project-specific synonyms (e.g. "confirmation page" ↔ "Thank you
  // for your order!") live in Project.assertionEquivalences and are
  // applied by applyProjectEquivalences below.
  const applyConnectorNorm = (s) => s
    .replace(/(\b[a-z0-9]{1,4})\s*(?:to|->|→|–|—)\s*([a-z0-9]{1,4}\b)/g, '$1-$2')
    .replace(/\s+&\s+/g, ' and ');

  // Project-scoped synonym layer. session.assertionEquivalences is an
  // array of { canonical, variants[] } the Conductor seeds at run start
  // from Project.assertionEquivalences. Each variant occurrence in the
  // input is collapsed to its canonical form so the substring match
  // sees the same text on both sides.
  const applyProjectEquivalences = (s) => {
    const eqs = session?.assertionEquivalences;
    if (!Array.isArray(eqs) || !eqs.length) return s;
    let out = s;
    for (const eq of eqs) {
      if (!eq || typeof eq.canonical !== 'string' || !Array.isArray(eq.variants)) continue;
      const canon = eq.canonical.toLowerCase();
      for (const variant of eq.variants) {
        if (typeof variant !== 'string' || !variant.trim()) continue;
        const v = variant.toLowerCase();
        if (!v || v === canon) continue;
        // Word-bounded global replace; escape regex specials in the variant.
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(escaped, 'g'), canon);
      }
    }
    return out;
  };

  const norm = (s) => {
    let v = decodeJsonish(s)
      .toLowerCase()
      .replace(/[{}\[\]",:]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    v = applyConnectorNorm(v);
    v = applyProjectEquivalences(v);
    // Re-collapse whitespace after equivalence substitutions.
    return v.replace(/\s+/g, ' ').trim();
  };
  // Phase F.3.1 — fallback haystack: the last browser_evaluate text response.
  // The natural agent pattern for dynamic / table / shadow-DOM content is to
  // extract data via JS evaluation, then verify with assertion_check. We use
  // that JS result as a second source of truth.
  const evalCache = session?.lastEvaluateResult || '';

  if (expectedRole) {
    // Snapshot lines look like: `- role "name" [ref=eN] ...`. Match the
    // role token at the start of any line, optionally indented.
    const buildRoleRe = (r) => new RegExp(`^\\s*-?\\s*${r.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'mi');
    const roleRe = buildRoleRe(expectedRole);
    let m = snap.match(roleRe);
    if (m) {
      const line = snap.split(/\r?\n/).find((l) => roleRe.test(l));
      evidenceBits.push(`role:OK (${(line || '').trim().slice(0, 120)})`);
    } else {
      // Phase F.3.1 — role aliases for tabular / status content. Map lives
      // in server/lib/roleAliases.js (P2-3); imported at module scope.
      const aliases = aliasesFor(expectedRole);
      let aliasMatched = null;
      for (const alt of aliases) {
        const altRe = buildRoleRe(alt);
        if (altRe.test(snap)) { aliasMatched = alt; break; }
      }
      if (aliasMatched) {
        evidenceBits.push(`role:OK via alias "${aliasMatched}" for "${expectedRole}"`);
      } else {
        reasons.push(`expectedRole "${expectedRole}" not found in snapshot (also tried aliases: ${aliases.join(', ') || 'none'})`);
      }
    }
  }

  // ── ASSERTION-TYPE CORPUS RULES (Phase H+2 — invariant, 2026-05-29) ────
  //
  // Every assertion type evaluates against EXACTLY ONE haystack. Silently
  // merging two corpora is what produced the FORBIDDEN_TEXT="null" false
  // positive — the inverted check accidentally also searched the agent's
  // browser_evaluate output, which contained the literal token `null` as
  // a normal JS return value.
  //
  // When adding a new assertion type, declare its corpus here and DO NOT
  // share with another type unless the rule explicitly says so:
  //
  //   expectedText        AOM snapshot (full text + structural metadata)
  //                       UNION  browser_evaluate cache (agent's deliberate
  //                       extraction for dynamic / table / shadow-DOM content)
  //
  //   expectedRole        AOM snapshot's role layer ONLY (line-start match)
  //
  //   expectedUrlPattern  page URL ONLY (current + visited; three-way)
  //
  //   unexpectedText      AOM snapshot with bracket metadata STRIPPED.
  //                       NO eval cache — the agent's own JS output is
  //                       NOT a valid source for "is this text on the page"
  //                       (the agent can return literally anything).
  //
  //   unexpectedRole      AOM snapshot's role layer, structural metadata
  //                       stripped. NO eval cache (same rule as above).
  //
  //   unexpectedUrlPattern  page URL ONLY (current; no visited fallback —
  //                       a forbidden URL the agent merely passed through
  //                       briefly is acceptable, only the final state counts).
  //
  // ── Helper: strip Playwright MCP snapshot's structural content.
  // Step 1 — bracket metadata: [ref=e144], [cursor=pointer], [level=5].
  //   These tokens have nothing to do with rendered text but routinely
  //   contain strings like "null", "e_null_btn" that cause false matches.
  // Step 2 — link/button href paths: the a11y tree emits
  //   `- link "My Profile" [ref=e34]: /app/profile/view`
  //   The `: /path` or `: https://...` suffix is the href, not visible text.
  //   Without stripping it, `unexpectedText: "Profile"` incorrectly matches
  //   because "/profile/" appears in the link's URL even though "Profile"
  //   is not present as a visible navigation item (false fail on RBAC checks).
  const stripSnapStructural = (s) => {
    if (typeof s !== 'string') return '';
    return s
      .replace(/\[[^\]]*\]/g, ' ')                     // bracket metadata
      .replace(/:\s*(?:https?:\/\/\S+|\/\S+)/g, ' ');  // href paths after ": "
  };

  if (expectedText) {
    // Corpus: AOM snapshot UNION browser_evaluate cache.
    const needleNorm = norm(expectedText);
    const snapNorm = norm(snap);
    if (snapNorm.includes(needleNorm)) {
      const rawIdx = snap.toLowerCase().indexOf(String(expectedText).toLowerCase());
      if (rawIdx >= 0) {
        const start = Math.max(0, rawIdx - 20);
        const end = Math.min(snap.length, rawIdx + String(expectedText).length + 40);
        evidenceBits.push(`text:OK ("…${snap.slice(start, end).replace(/\s+/g, ' ').trim()}…")`);
      } else {
        evidenceBits.push(`text:OK (whitespace-normalised match)`);
      }
    } else if (evalCache && norm(evalCache).includes(needleNorm)) {
      const ci = norm(evalCache).indexOf(needleNorm);
      const start = Math.max(0, ci - 20);
      const end = Math.min(evalCache.length, ci + needleNorm.length + 60);
      evidenceBits.push(`text:OK from browser_evaluate ("…${evalCache.slice(start, end).replace(/\s+/g, ' ').trim()}…")`);
    } else {
      reasons.push(`expectedText "${String(expectedText).slice(0, 80)}" not found in page text or recent browser_evaluate result`);
    }
  }

  if (expectedUrlPattern) {
    // Corpus: page URL only. Three-way temporal disambiguation:
    //   currentUrl matches            → matched
    //   any visitedUrl matches        → uncheckable("transient_window_missed")
    //   neither                       → uncheckable("agent_never_reached")
    //
    // Matching goes through matchUrlPattern (3-stage tolerant matcher) so
    // LLM over-escapes (\\. instead of \.) and anchored-regex-on-full-URL
    // patterns don't produce false agent_never_reached verdicts.
    const headerMatch = snap.match(/Page URL:\s*(\S+)/i);
    const looseMatch = snap.match(/https?:\/\/[^\s"'<>]+/);
    const currentUrl = session?.currentUrl || headerMatch?.[1] || looseMatch?.[0] || '';
    const currentResult = currentUrl ? matchUrlPattern(expectedUrlPattern, currentUrl) : { matched: false };
    if (currentResult.matched) {
      const rescue = currentResult.stage !== 'regex_original' ? ` (matched via ${currentResult.stage})` : '';
      evidenceBits.push(`url:OK (${currentUrl.slice(0, 120)})${rescue}`);
    } else {
      // Look at visited paths/URLs. Both forms are checked: the raw
      // visitedUrls set holds normalised paths like "/inventory.html",
      // and patterns are often path-shaped too. Same tolerant matcher.
      let everVisited = false;
      const visited = session?.visitedUrls || new Set();
      for (const v of visited) {
        if (matchUrlPattern(expectedUrlPattern, v).matched) { everVisited = true; break; }
      }
      if (everVisited) {
        // Short-circuit return with uncheckable — DO NOT push to reasons[],
        // that would land as a generic not_matched (verdict-layer FAIL).
        return {
          content: [{ type: 'text', text: JSON.stringify({
            matched: false,
            reason: 'transient_window_missed',
            evidence: `URL pattern "${expectedUrlPattern}" matched a previously-visited URL but the current URL is "${currentUrl || '(unknown)'}"`,
          }) }],
          isError: false,
        };
      }
      // Never visited a matching URL → agent never reached the asserted page.
      return {
        content: [{ type: 'text', text: JSON.stringify({
          matched: false,
          reason: 'agent_never_reached',
          evidence: `URL pattern "${expectedUrlPattern}" did not match current URL "${currentUrl || '(unknown)'}" and no visited URL ever matched it`,
        }) }],
        isError: false,
      };
    }
  }

  if (unexpectedText) {
    // Corpus: AOM snapshot with bracket metadata stripped. NO eval cache.
    const visibleSnap = stripSnapStructural(snap);
    const needleNorm = norm(unexpectedText);
    const snapNorm = norm(visibleSnap);
    if (snapNorm.includes(needleNorm)) {
      reasons.push(`unexpectedText "${String(unexpectedText).slice(0, 80)}" was found on the page — forbidden text is present`);
    } else {
      evidenceBits.push(`forbidden-text:OK ("${String(unexpectedText).slice(0, 60)}" correctly absent)`);
    }
  }

  if (unexpectedRole) {
    // Corpus: AOM snapshot role layer, structural metadata stripped. NO eval cache.
    const visibleSnap = stripSnapStructural(snap);
    const buildRoleRe = (r) => new RegExp(`^\\s*-?\\s*${r.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'mi');
    const roleRe = buildRoleRe(unexpectedRole);
    if (roleRe.test(visibleSnap)) {
      reasons.push(`unexpectedRole "${unexpectedRole}" was found on the page — forbidden role is present`);
    } else {
      evidenceBits.push(`forbidden-role:OK ("${unexpectedRole}" correctly absent)`);
    }
  }

  if (unexpectedUrlPattern) {
    // Corpus: current URL only. The visitedUrls set is intentionally NOT
    // consulted here — a forbidden URL the agent briefly passed through
    // is acceptable; only the final state matters for the negative claim.
    // Same tolerant matcher as expectedUrlPattern so over-escapes don't
    // FALSELY pass a forbidden-URL check (i.e. don't silently accept a
    // page that genuinely matches the forbidden pattern just because the
    // LLM corrupted the relay).
    const headerMatch = snap.match(/Page URL:\s*(\S+)/i);
    const looseMatch = snap.match(/https?:\/\/[^\s"'<>]+/);
    const url = session?.currentUrl || headerMatch?.[1] || looseMatch?.[0] || '';
    const result = url ? matchUrlPattern(unexpectedUrlPattern, url) : { matched: false };
    if (result.matched) {
      reasons.push(`unexpectedUrlPattern "${unexpectedUrlPattern}" matched current URL "${url}" — forbidden URL pattern is present`);
    } else {
      evidenceBits.push(`forbidden-url:OK (current URL "${url || '(unknown)'}" does not match "${unexpectedUrlPattern}")`);
    }
  }

  // E10.5 — Download verification. Reads the watcher's records for the
  // active RunResult and matches against the spec. Async so the prisma
  // query can complete before we shape the response.
  if (expectedDownload) {
    const activeRunResultId = session?._dlWatcher?.activeRunResultId;
    if (!activeRunResultId) {
      reasons.push('expectedDownload was set but no RunResult is active — the watcher cannot attribute downloads to a case');
    } else {
      try {
        const dlCheck = await downloadWatcher.checkDownloadExpectation(activeRunResultId, expectedDownload);
        if (dlCheck.matched) evidenceBits.push(`download:OK (${dlCheck.evidence})`);
        else reasons.push(`expectedDownload not satisfied: ${dlCheck.evidence}`);
      } catch (err) {
        reasons.push(`download check threw: ${err.message}`);
      }
    }
  }

  let matched = reasons.length === 0;
  let semanticRescue = null;

  // ── Semantic fallback (two-stage verifier) ───────────────────────────
  // If the deterministic stage said "no" AND the operator enabled
  // semantic-fallback for this run (Run.verifierMode === 'semantic_fallback'
  // → session.semanticFallback === true), ask the LLM whether the page
  // semantically satisfies the assertion's intent. This closes the
  // "BRD wording vs SUT wording" gap: assertion "confirmation page" can
  // match snapshot "Thank you for your order!" via the model's judgment.
  //
  // Cost discipline: ONLY runs on stage-1 misses, ONLY when the operator
  // opted in. A deterministic pass is absolute — never second-guessed.
  //
  // Edge Case 3 — exact-data wall. If the expected value IS a data token
  // (account number, price, ID, security token), the deterministic miss is
  // authoritative: an exact-data mismatch is a real bug, never a wording gap
  // the LLM should rescue. Skip the rescue and let the miss stand.
  const exactDataGuarded = isExactDataAssertion(expectedText) || isExactDataAssertion(unexpectedText);
  if (exactDataGuarded && !matched) {
    reasons.push('semantic-rescue skipped: expected value is exact data (number/ID/token) — must match exactly');
  }

  // ── Vector similarity Stage 1.5 ──────────────────────────────────────
  // Sits between the deterministic layer (free, instant) and the LLM rescue
  // (expensive, slow). Uses Gemini text-embedding-004 to compute cosine
  // similarity between the assertion text and page sentence chunks.
  //
  // When sim ≥ MATCH_THRESHOLD (0.82): accept as a semantic match — the same
  // "yes" a human tester would give for wording variants like "order placed"
  // vs "order confirmed". No LLM call needed.
  //
  // When sim < threshold: evidence is insufficient for a confident match;
  // the LLM rescue runs next as the authoritative judge (handles harder
  // conceptual equivalences that pure cosine similarity can't resolve).
  //
  // Only fires for TEXT assertions (expectedText). Role, URL, download,
  // and forbidden-type assertions are deterministic-only — wording variants
  // don't arise there. Skipped when vectorSim is not bound (Gemini key
  // unavailable), ensuring graceful degradation to the existing LLM path.
  if (!matched && !exactDataGuarded && expectedText && typeof session?.vectorSim === 'function') {
    try {
      const { MATCH_THRESHOLD } = require('../lib/similarity/embed');
      const sim = await session.vectorSim(String(expectedText), snap);
      if (sim >= MATCH_THRESHOLD) {
        matched = true;
        semanticRescue = {
          rescued: true,
          reasoning: `vector similarity ${(sim * 100).toFixed(1)}% — semantic wording match (no LLM)`,
          originalReasons: reasons.slice(),
        };
        evidenceBits.push(`vector-sim: ${(sim * 100).toFixed(1)}%`);
      }
    } catch (_vecErr) {
      // Embedding unavailable — fall through to LLM rescue unchanged
    }
  }

  if (!matched && !exactDataGuarded && session?.semanticFallback === true && session?.semanticVerify) {
    // Build a human-readable assertion description for the LLM. Prefer
    // the explicit assertion text the agent passed (when available)
    // and fall back to the constructed criteria so the model knows what
    // it's checking even if `assertion` was empty.
    const assertionText = (typeof assertion === 'string' && assertion.trim())
      ? assertion.trim()
      : [
          expectedText && `text contains "${expectedText}"`,
          expectedRole && `role "${expectedRole}" present`,
          expectedUrlPattern && `URL matches /${expectedUrlPattern}/`,
          unexpectedText && `text "${unexpectedText}" absent`,
          unexpectedRole && `role "${unexpectedRole}" absent`,
          unexpectedUrlPattern && `URL does not match /${unexpectedUrlPattern}/`,
        ].filter(Boolean).join(' AND ');

    // Single LLM call. session.semanticVerify is a bound async function
    // the Conductor installed at run start carrying { apiKey, model,
    // provider, signal, onRateLimit, intent } — keeps this module free
    // of cross-cutting plumbing.
    try {
      const verdict = await session.semanticVerify({
        assertionText,
        assertionType: expectedRole ? 'ROLE'
          : expectedUrlPattern ? 'URL'
          : unexpectedRole ? 'FORBIDDEN_ROLE'
          : unexpectedText ? 'FORBIDDEN_TEXT'
          : unexpectedUrlPattern ? 'FORBIDDEN_URL'
          : 'TEXT',
        snapshot: snap,
      });
      if (verdict && verdict.outcome === 'matched') {
        matched = true;
        semanticRescue = {
          rescued: true,
          reasoning: verdict.reasoning || '',
          originalReasons: reasons.slice(),
        };
        // Surface the rescue in the evidence bag so the trace shows WHY
        // the deterministic miss was overridden.
        evidenceBits.push(`semantic-rescue: ${verdict.reasoning || 'LLM judged matched'}`);
      } else if (verdict && verdict.outcome === 'uncheckable') {
        // Stage 2 also couldn't decide — leave the deterministic miss
        // as-is, but stash the uncheckable reason so the verdict layer
        // can route to needs_human instead of fail.
        semanticRescue = { rescued: false, uncheckable: true, reasoning: verdict.reasoning || '' };
      }
      // verdict.outcome === 'not_matched' → no override, deterministic miss stands.
    } catch (err) {
      // Transport errors must NOT silently rescue. Leave the deterministic
      // miss intact and stash the error reasoning for the trace.
      semanticRescue = { rescued: false, error: err.message };
    }
  }

  // domGrounded: true when the text was found literally in the ARIA snapshot.
  // false when matched only via browser_evaluate cache or via semantic/vector rescue.
  // The codegen uses this to decide between assertTextPresent (DOM-searchable) and
  // uncheckable annotation (text not findable by Playwright locators in the export).
  const textMatchedViaEvalCache = expectedText && evidenceBits.some((e) => e.startsWith('text:OK from browser_evaluate'));
  const textMatchedViaRescue = !!(semanticRescue && semanticRescue.rescued);
  const domGrounded = matched && expectedText
    ? (!textMatchedViaEvalCache && !textMatchedViaRescue)
    : true; // non-text assertions (role, URL, download) are always grounded
  const payload = matched
    ? {
        matched: true,
        assertion: assertion || null,
        evidence: evidenceBits.join(' · ') || 'all criteria matched',
        domGrounded,
        // Tag rescued outcomes so the Conductor records source='semantic_fallback'.
        ...(semanticRescue && semanticRescue.rescued ? { rescuedBy: 'semantic_fallback', semanticReasoning: semanticRescue.reasoning } : {}),
      }
    : (semanticRescue && semanticRescue.uncheckable)
    ? { matched: false, assertion: assertion || null, reason: 'semantic_uncheckable', evidence: semanticRescue.reasoning || reasons.join(' · ') }
    : {
        matched: false,
        assertion: assertion || null,
        reason: 'criteria_failed',
        evidence: reasons.join(' · '),
        // Tag when semantic rescue was attempted and ALSO returned not_matched.
        // Signals genuine behavioral absence (not a wording gap). computeVerdict
        // uses this to promote a 'should' tier miss to a hard fail — because if
        // the semantic verifier also says no, the behavior is genuinely absent.
        ...(semanticRescue && !semanticRescue.rescued && !semanticRescue.uncheckable && !semanticRescue.error
          ? { semanticConfirmedNotMatched: true, semanticReasoning: semanticRescue.reasoning }
          : {}),
      };
  // Echo containerSelector back so the conductor can record assertion scope
  // into v2Recorded and buildReplayIR can carry it through to assert.scope.
  const containerSelector = (args || {}).containerSelector;
  if (containerSelector && typeof containerSelector === 'string') payload.containerSelector = containerSelector;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  };
}

/**
 * Map MCP tools to Anthropic's tool-use schema. Strip keys Anthropic rejects.
 * Phase E2.1 — also appends the synthetic `assertion_check` tool so the
 * Conductor can call it like any other MCP tool.
 *
 * Phase H M4 — `opts.verdictMode === 'mechanical_v1'` ALSO appends the
 * synthetic `final_verdict` tool. The conductor passes the per-run mode
 * (captured at run-start from Project.verdictMode → env default,
 * immutable mid-run). Legacy runs never see final_verdict.
 */
function listAnthropicTools(session, opts = {}) {
  const REJECTED = new Set(['outputSchema', 'annotations', '_meta', 'execution', 'icons', 'title']);
  const real = (session.mcpTools || []).map((t) => {
    const inputSchema = sanitiseSchema(t.inputSchema) || { type: 'object', properties: {} };
    const tool = {
      name: t.name,
      description: t.description || `MCP tool ${t.name}`,
      input_schema: inputSchema,
    };
    for (const k of REJECTED) delete tool[k];
    return tool;
  });
  // Append the synthetic assertion_check + human_input tools. Both are
  // intercepted server-side (conductor.js for human_input, callTool for
  // assertion_check) so MCP doesn't see them. In mechanical_v1 mode we
  // additionally append the final_verdict gate.
  const assertionTool = getAssertionCheckTool(opts);
  const tools = [...real, assertionTool, HUMAN_INPUT_TOOL, BROWSER_EXTRACT_DATA_TOOL, REMEMBER_CREDENTIAL_TOOL];
  if (opts && opts.verdictMode === 'mechanical_v1') {
    tools.push(FINAL_VERDICT_TOOL);
  }
  return tools;
}

/**
 * Map MCP tools to Anthropic's tool-use schema shape ALSO used as the
 * canonical input to the provider abstraction. The Gemini provider re-shapes
 * `input_schema` -> `parameters` internally; callers don't have to branch
 * on provider. This is just listAnthropicTools by another name — kept as
 * a separate export so the intent is visible at call sites that loop over
 * providers (e.g. the future failover work).
 */
function listProviderTools(session, opts = {}) {
  return listAnthropicTools(session, opts);
}

/**
 * Strip JSON Schema keys that Anthropic's tool-use validator rejects.
 * Walks recursively into `properties` and `items`.
 */
function sanitiseSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const REJECTED_AT_ANY_LEVEL = new Set(['$schema', '$id', '$ref', 'definitions', '$defs', 'examples']);
  const out = Array.isArray(schema) ? [] : {};
  for (const [k, v] of Object.entries(schema)) {
    if (REJECTED_AT_ANY_LEVEL.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) {
        out.properties[pk] = sanitiseSchema(pv);
      }
    } else if (k === 'items') {
      out.items = sanitiseSchema(v);
    } else if (v && typeof v === 'object') {
      out[k] = sanitiseSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Extract concatenated text from an MCP content array.
 */
function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

/**
 * Translate an MCP content array into Anthropic-friendly content blocks
 * suitable for a `tool_result` message:
 *   - text → text block (full a11y tree preserved — the agent needs
 *     paragraph text, role hints, AND interactive refs to act
 *     effectively; an earlier "trim" attempt at this layer hurt
 *     accuracy enough that it was reverted, see PHASE_LOG Phase F.1)
 *   - image (base64) → image block with base64 source
 *   - resource_link → text block pointing at the resource
 *
 * Anthropic accepts an array OR a plain string for tool_result content.
 * We return an array to preserve any image blocks.
 */
function normaliseMcpContentForAnthropic(content) {
  if (!Array.isArray(content) || content.length === 0) {
    return [{ type: 'text', text: '(empty result)' }];
  }
  const out = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && typeof c.text === 'string') {
      out.push({ type: 'text', text: c.text });
    } else if (c.type === 'image' && c.data) {
      out.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: c.mimeType || 'image/jpeg',
          data: c.data,
        },
      });
    } else if (c.type === 'resource_link') {
      out.push({ type: 'text', text: `[resource: ${c.uri || c.name || 'link'}]` });
    } else if (c.type === 'resource' && c.resource) {
      const r = c.resource;
      if (r.text) out.push({ type: 'text', text: r.text });
      else out.push({ type: 'text', text: `[resource ${r.uri || ''}]` });
    }
  }
  if (out.length === 0) out.push({ type: 'text', text: '(unrecognised MCP content)' });
  return out;
}

/**
 * Parse the MCP page snapshot text into picker-candidate rows. The snapshot
 * from `@playwright/mcp` is a YAML-ish accessibility tree where each
 * interactable line looks like:
 *
 *   - button "Sign in" [ref=e42]
 *   - textbox "Email" [ref=e10] [placeholder="you@example.com"]
 *   - link "Forgot password?" [ref=e51]
 *
 * We extract role + name + ref and synthesise Playwright locator expressions
 * for each candidate. The `ref=` value is the MCP element ref — useful for
 * subsequent `browser_click({ element, ref })` calls.
 */
function parseMcpSnapshotToCandidates(snapText) {
  if (!snapText || typeof snapText !== 'string') return [];
  const out = [];
  // Grouping roles whose named instances can scope child locators.
  // When a combobox lives inside group[name='User Role'], the expression
  // getByRole('group',{name:'User Role'}).getByRole('combobox') is unique
  // even when getByRole('combobox',{name:'-- Select --'}) matches N elements.
  const GROUPING_ROLES = new Set(['group', 'region', 'form', 'list', 'listitem', 'row', 'cell', 'gridcell', 'dialog']);
  const groupStack = []; // { depth, role, name }

  for (const line of snapText.split(/\r?\n/)) {
    const parsed = parseSnapshotLine(line);
    if (!parsed) continue;
    const { role, name, ref, placeholder, testid, idAttr } = parsed;

    // Maintain the parent-context stack by indentation depth.
    const depth = (line.match(/^(\s*)/) || ['', ''])[1].length;
    while (groupStack.length > 0 && groupStack[groupStack.length - 1].depth >= depth) {
      groupStack.pop();
    }

    const semanticMetadata = {
      placeholder: placeholder || null,
      testid: testid || null,
      idAttr: idAttr || null,
    };
    if (testid) {
      out.push({
        strategy: 'testid',
        expression: `getByTestId("${escapeJs(testid)}")`,
        stability: 98,
        ref,
        role,
        name,
        ...semanticMetadata,
      });
    }
    if (role && name) {
      out.push({
        strategy: 'role',
        expression: `getByRole("${escapeJs(role)}", { name: ${JSON.stringify(name)} })`,
        stability: 92,
        ref,
        role,
        name,
        ...semanticMetadata,
      });
    }
    if (placeholder) {
      out.push({
        strategy: 'placeholder',
        expression: `getByPlaceholder(${JSON.stringify(placeholder)})`,
        stability: 80,
        ref,
        role,
        name,
        ...semanticMetadata,
      });
    }
    if (name && /\S/.test(name) && name.length < 80) {
      out.push({
        strategy: 'text',
        expression: `getByText(${JSON.stringify(name)})`,
        stability: 65,
        ref,
        role,
        name,
        ...semanticMetadata,
      });
    }
    if (idAttr) {
      out.push({
        strategy: 'css',
        expression: `locator("#${escapeCss(idAttr)}")`,
        stability: 60,
        ref,
        role,
        name,
        ...semanticMetadata,
      });
    }

    // Scoped locator: if this element sits inside a named grouping element,
    // emit a parent-scoped expression. Wins when the plain role expression is
    // not unique (count > 1) but the group name makes it unique.
    if (ref && role) {
      const ctx = groupStack.length > 0 ? groupStack[groupStack.length - 1] : null;
      if (ctx && ctx.name) {
        const innerPart = name
          ? `getByRole("${escapeJs(role)}", { name: ${JSON.stringify(name)} })`
          : `getByRole("${escapeJs(role)}")`;
        const scopedExpr = `getByRole("${escapeJs(ctx.role)}", { name: ${JSON.stringify(ctx.name)} }).${innerPart}`;
        out.push({
          strategy: 'scoped_role',
          expression: scopedExpr,
          stability: 88,
          ref,
          role,
          name,
          parentRole: ctx.role,
          parentName: ctx.name,
          ...semanticMetadata,
        });
      }
    }

    // Push named grouping elements onto the context stack for their children.
    if (role && GROUPING_ROLES.has(role) && name) {
      groupStack.push({ depth, role, name });
    }
  }
  return out;
}

function escapeJs(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function escapeCss(s) { return String(s).replace(/([^\w-])/g, '\\$1'); }

module.exports = {
  startMcpSession,
  launchLiveCdpBrowser,
  stopMcpSession,
  callTool,
  snapshot,
  adaptiveValidationSnapshot,
  armPageTransitionObservation,
  awaitPageTransitionObservation,
  validationSnapshotBudgetMs,
  screenshot,
  saveScreenshotToDisk,
  startFramePoller,
  stopFramePoller,
  listAnthropicTools,
  listProviderTools,
  normaliseMcpContentForAnthropic,
  textOfContent,
  parseMcpSnapshotToCandidates,
  extractDomFactsForTool,
  getLastSnapshot,
  normaliseToolArgs,
  checkAssertion,
  matchUrlPattern,
  matchPageAssertion,
  isUntrustedPageName,
  normalizeLlmString,
  extractData,
  parseEvaluateReturnValue,
  BROWSER_EXTRACT_DATA_TOOL,
  FINAL_VERDICT_TOOL,
  // exported for unit tests (stale-ref role-aware self-heal)
  guardActionRef,
  _resolveByDescription,
  resolveActionRefByDescription,
  rolesForTool,
  CLICKABLE_ROLES,
  INPUT_ROLES,
  // exported for unit tests (snapshot-parser consolidation)
  buildRefRoleMap,
  parseSnapshotLine,
  retargetGenericWrapperForTool,
  retargetHoverIconToTrigger,
  findUniqueChildRefByRole,
  // exported for generic operational-probe regression tests
  hardenFieldBlockedProbeSource,
  _parseBrowserTabList: parseBrowserTabList,
  _fingerprintMateriallyChanged: fingerprintMateriallyChanged,
  // exported for conductor.js snapshot-pollution guard
  isSnapshotText,
  // #32 — exported for unit tests (browser-topology portability)
  resolveTlsRejectUnauthorized,
  reportBrowserTopologyPosture,
  // Chromium-authoritative locator evidence. These helpers operate only when
  // startMcpSession created a real Playwright live-CDP context.
  captureAuthoritativeActionTarget,
  captureAuthoritativePostAction,
  acquireTooltipVisualObservation,
  livePlaywrightPageForSession,
  captureInPageBrowserEvents,
  captureLiveEvidenceScreenshot,
  captureRuntimeDescriptor,
  inspectCaptureRuntime,
  captureRuntimeEvidence,
  _livePlaywrightPagesForSession: livePlaywrightPagesForSession,
  _authoritativePageIdentity: authoritativePageIdentity,
  _exactAuthoritativePageForIdentity: exactAuthoritativePageForIdentity,
  _authoritativePageRegistryStats: authoritativePageRegistryStats,
  _reacquireAuthoritativeReplacement: reacquireAuthoritativeReplacement,
  _captureTooltipEvidence: captureTooltipEvidence,
  _captureBindingAttempt: captureBindingAttempt,
  _bindAuthoritativePostCapture: bindAuthoritativePostCapture,
  _authoritativePostGap: authoritativePostGap,
  _verifyAuthoritativeCandidateBatch: verifyAuthoritativeCandidateBatch,
  _actionEvidenceIdentity: actionEvidenceIdentity,
  _strictActionEvidenceEnabled: strictActionEvidenceEnabled,
  _authorizeExecutionGatewayCall(session, name, args, options = {}) {
    return require('./actionExecutionGateway').defaultGateway.authorizeMcpCall({
      session, toolName: name, args: args || {}, permit: options.executionPermit || null,
    });
  },
  _recoverMcpTransport: recoverMcpTransport,
  _rawEvaluateBoundRef: rawEvaluateBoundRef,
  _rawTransitionTool: rawTransitionTool,
  _stabiliseSnapshot: stabiliseSnapshot,
  _refreshSnapshot,
  CAPTURE_RUNTIME_SCHEMA,
  CAPTURE_BUILD_FINGERPRINT,
};
