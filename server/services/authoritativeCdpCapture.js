'use strict';

const { normalizeAuthoritativeElementState } = require('./authoritativeElementState');

/**
 * Chromium-authoritative action target capture.
 *
 * The caller binds the authored MCP ref to a short-lived marker before invoking
 * this service.  We then inspect the same browser page through a real Playwright
 * CDP session.  DOMSnapshot is the source of node/document/frame/shadow/layout
 * identity; Accessibility.getPartialAXTree supplies the browser-computed role
 * and accessible name.  This module never guesses a target and never promotes a
 * locator.  A missing/ambiguous marker is returned as an explicit capture gap.
 */

const CAPTURE_SCHEMA = 'qaai-authoritative-cdp-action-target/1';
const DEFAULT_COMPUTED_STYLES = ['display', 'visibility', 'opacity', 'pointer-events'];
const DEFAULT_CDP_CAPTURE_TIMEOUT_MS = 2_500;
const CDP_DETACH_TIMEOUT_MS = 250;
const EXACT_ELEMENT_STATE_FUNCTION = `function() {
  const element = this;
  if (!element || element.nodeType !== 1 || !element.ownerDocument) {
    return { available: false, reason: 'resolved_node_is_not_an_element' };
  }
  const document = element.ownerDocument;
  const view = document.defaultView;
  const styleFor = (node) => {
    try { return view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(node) : null; }
    catch (_) { return null; }
  };
  const ownStyle = styleFor(element);
  const rect = element.getBoundingClientRect();
  let effectiveInert = false;
  let effectiveHidden = false;
  let effectiveOpacity = 1;
  let ancestorCount = 0;
  let cursor = element;
  while (cursor && cursor.nodeType === 1 && ancestorCount < 64) {
    ancestorCount += 1;
    const style = styleFor(cursor);
    if (cursor.inert === true || cursor.hasAttribute('inert')) effectiveInert = true;
    if (cursor.hidden === true || cursor.hasAttribute('hidden')) effectiveHidden = true;
    if (style) {
      if (style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden') effectiveHidden = true;
      const opacity = Number(style.opacity);
      if (Number.isFinite(opacity)) effectiveOpacity *= opacity;
    }
    if (cursor.parentElement) {
      cursor = cursor.parentElement;
    } else {
      const root = typeof cursor.getRootNode === 'function' ? cursor.getRootNode() : null;
      cursor = root && root.host && root.host.nodeType === 1 ? root.host : null;
    }
  }

  const centerX = Number(rect.left) + (Number(rect.width) / 2);
  const centerY = Number(rect.top) + (Number(rect.height) / 2);
  let localHitTest = {
    available: false,
    targetOrDescendant: null,
    reason: 'element_from_point_unavailable',
    point: { x: centerX, y: centerY },
  };
  const root = typeof element.getRootNode === 'function' ? element.getRootNode() : document;
  const hitSource = root && typeof root.elementFromPoint === 'function' ? root : document;
  const inViewport = !!view && centerX >= 0 && centerY >= 0
    && centerX < Number(view.innerWidth) && centerY < Number(view.innerHeight);
  if (inViewport && hitSource && typeof hitSource.elementFromPoint === 'function') {
    const hit = hitSource.elementFromPoint(centerX, centerY);
    localHitTest = {
      available: true,
      targetOrDescendant: !!hit && (hit === element || element.contains(hit)),
      reason: hit ? null : 'no_node_at_action_point',
      point: { x: centerX, y: centerY },
      hit: hit ? {
        tagName: String(hit.localName || hit.nodeName || '').toLowerCase() || null,
        id: String(hit.id || '').slice(0, 200) || null,
        role: String(hit.getAttribute && hit.getAttribute('role') || '').slice(0, 120) || null,
      } : null,
    };
  } else if (!inViewport) {
    localHitTest.reason = 'action_point_outside_viewport';
  }

  let matchesDisabled = null;
  try { matchesDisabled = element.matches(':disabled'); } catch (_) {}
  return {
    available: true,
    isConnected: element.isConnected === true,
    tagName: String(element.localName || element.nodeName || '').toLowerCase() || null,
    inputType: typeof element.type === 'string'
      ? String(element.type).toLowerCase()
      : String(element.getAttribute('type') || '').toLowerCase() || null,
    matchesDisabled,
    disabledProperty: typeof element.disabled === 'boolean' ? element.disabled : null,
    readOnlyProperty: typeof element.readOnly === 'boolean' ? element.readOnly : null,
    isContentEditable: element.isContentEditable === true,
    contentEditable: typeof element.contentEditable === 'string' ? element.contentEditable : null,
    effectiveInert,
    effectiveHidden,
    effectiveOpacity,
    pointerEvents: ownStyle ? String(ownStyle.pointerEvents || '').toLowerCase() || null : null,
    rect: {
      x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height),
      top: Number(rect.top), right: Number(rect.right), bottom: Number(rect.bottom), left: Number(rect.left),
    },
    ancestorCount,
    localHitTest,
  };
}`;

function clean(value, max = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function booleanOrNull(value) {
  return value === true || value === false ? value : null;
}

function stringAt(strings, index) {
  return Number.isInteger(index) && index >= 0 && index < (strings || []).length
    ? String(strings[index])
    : '';
}

function rareValueAt(rare, nodeIndex, fallback = null) {
  if (!rare || !Array.isArray(rare.index)) return fallback;
  const position = rare.index.indexOf(nodeIndex);
  if (position < 0) return fallback;
  if (Array.isArray(rare.value)) return rare.value[position] ?? fallback;
  return true;
}

function attributesAt(documentSnapshot, nodeIndex, strings) {
  const raw = documentSnapshot?.nodes?.attributes?.[nodeIndex];
  const out = {};
  if (!Array.isArray(raw)) return out;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = stringAt(strings, raw[index]);
    if (!name) continue;
    out[name] = stringAt(strings, raw[index + 1]);
  }
  return out;
}

function nodeSummary(documentSnapshot, nodeIndex, strings) {
  const nodes = documentSnapshot?.nodes || {};
  return {
    nodeIndex,
    backendNodeId: Number(nodes.backendNodeId?.[nodeIndex]) || null,
    nodeType: Number(nodes.nodeType?.[nodeIndex]) || null,
    nodeName: clean(stringAt(strings, nodes.nodeName?.[nodeIndex]), 120) || null,
    nodeValue: clean(stringAt(strings, nodes.nodeValue?.[nodeIndex]), 240) || null,
    attributes: attributesAt(documentSnapshot, nodeIndex, strings),
    shadowRootType: clean(stringAt(strings, rareValueAt(nodes.shadowRootType, nodeIndex, -1)), 40) || null,
  };
}

function layoutAt(documentSnapshot, nodeIndex, strings) {
  const layout = documentSnapshot?.layout || {};
  const position = Array.isArray(layout.nodeIndex) ? layout.nodeIndex.indexOf(nodeIndex) : -1;
  if (position < 0) return { visible: false, bounds: null, styles: {} };
  const bounds = Array.isArray(layout.bounds?.[position])
    ? layout.bounds[position].slice(0, 4).map((value) => Number(value) || 0)
    : null;
  const styleIndexes = Array.isArray(layout.styles?.[position]) ? layout.styles[position] : [];
  const styles = {};
  DEFAULT_COMPUTED_STYLES.forEach((name, index) => {
    const value = stringAt(strings, styleIndexes[index]);
    if (value) styles[name] = value;
  });
  const [x = 0, y = 0, width = 0, height = 0] = bounds || [];
  const hiddenByStyle = styles.display === 'none'
    || styles.visibility === 'hidden'
    || styles.visibility === 'collapse'
    || Number(styles.opacity) === 0;
  return {
    visible: !!bounds && width > 0 && height > 0 && !hiddenByStyle,
    bounds: bounds ? { x, y, width, height } : null,
    styles,
  };
}

function documentMetadata(documentSnapshot, documentIndex, strings) {
  return {
    documentIndex,
    frameId: clean(stringAt(strings, documentSnapshot?.frameId), 200) || null,
    documentUrl: clean(stringAt(strings, documentSnapshot?.documentURL), 2_000) || null,
    baseUrl: clean(stringAt(strings, documentSnapshot?.baseURL), 2_000) || null,
    contentLanguage: clean(stringAt(strings, documentSnapshot?.contentLanguage), 80) || null,
    encodingName: clean(stringAt(strings, documentSnapshot?.encodingName), 80) || null,
  };
}

function findMarkerMatches(snapshot, markerAttribute, markerValue) {
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const matches = [];
  documents.forEach((documentSnapshot, documentIndex) => {
    const total = documentSnapshot?.nodes?.nodeName?.length || 0;
    for (let nodeIndex = 0; nodeIndex < total; nodeIndex += 1) {
      const attributes = attributesAt(documentSnapshot, nodeIndex, strings);
      if (attributes[markerAttribute] !== markerValue) continue;
      matches.push({ documentIndex, nodeIndex, documentSnapshot, attributes });
    }
  });
  return { matches, documents, strings };
}

function findBackendNode(snapshot, backendNodeId) {
  const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
  const strings = Array.isArray(snapshot?.strings) ? snapshot.strings : [];
  const target = Number(backendNodeId);
  for (let documentIndex = 0; documentIndex < documents.length; documentIndex += 1) {
    const ids = documents[documentIndex]?.nodes?.backendNodeId || [];
    const nodeIndex = ids.indexOf(target);
    if (nodeIndex >= 0) {
      return { documentIndex, nodeIndex, documentSnapshot: documents[documentIndex], documents, strings };
    }
  }
  return null;
}

function frameOwners(documents) {
  const out = new Map();
  documents.forEach((documentSnapshot, documentIndex) => {
    const contentDocuments = documentSnapshot?.nodes?.contentDocumentIndex;
    if (!contentDocuments || !Array.isArray(contentDocuments.index) || !Array.isArray(contentDocuments.value)) return;
    contentDocuments.index.forEach((ownerNodeIndex, position) => {
      const childDocumentIndex = Number(contentDocuments.value[position]);
      if (Number.isInteger(childDocumentIndex) && childDocumentIndex >= 0) {
        out.set(childDocumentIndex, { parentDocumentIndex: documentIndex, ownerNodeIndex });
      }
    });
  });
  return out;
}

function buildFramePath(documents, documentIndex, strings) {
  const owners = frameOwners(documents);
  const path = [];
  let current = documentIndex;
  const seen = new Set();
  while (owners.has(current) && !seen.has(current) && path.length < 16) {
    seen.add(current);
    const owner = owners.get(current);
    const parentDocument = documents[owner.parentDocumentIndex];
    const summary = nodeSummary(parentDocument, owner.ownerNodeIndex, strings);
    path.unshift({
      parentDocumentIndex: owner.parentDocumentIndex,
      childDocumentIndex: current,
      backendNodeId: summary.backendNodeId,
      nodeName: summary.nodeName,
      attributes: summary.attributes,
    });
    current = owner.parentDocumentIndex;
  }
  return path;
}

function buildDomAncestry(documentSnapshot, nodeIndex, strings) {
  const parents = documentSnapshot?.nodes?.parentIndex || [];
  const ancestry = [];
  const shadowHostsInsideOut = [];
  const shadowGapsInsideOut = [];
  const seenShadowHosts = new Set();

  const recordShadowBoundary = (rootType, hostIndex, boundaryNodeIndex) => {
    const normalizedRootType = clean(rootType, 40).toLowerCase();
    if (!Number.isInteger(hostIndex) || hostIndex < 0) {
      shadowGapsInsideOut.push({
        reason: 'shadow_host_missing',
        rootType: normalizedRootType || null,
        boundaryNodeIndex,
      });
      return;
    }

    const host = nodeSummary(documentSnapshot, hostIndex, strings);
    const hostKey = host.backendNodeId ? `backend:${host.backendNodeId}` : `node:${hostIndex}`;
    if (seenShadowHosts.has(hostKey)) return;
    seenShadowHosts.add(hostKey);

    if (normalizedRootType !== 'open') {
      shadowGapsInsideOut.push({
        reason: normalizedRootType === 'closed' ? 'closed_shadow_root' : 'shadow_root_type_unavailable',
        rootType: normalizedRootType || null,
        boundaryNodeIndex,
        host,
      });
      return;
    }

    shadowHostsInsideOut.push({
      ...host,
      rootType: 'open',
      evidenceSource: 'dom_snapshot_shadow_boundary',
    });
  };

  let current = nodeIndex;
  const seen = new Set();
  while (Number.isInteger(current) && current >= 0 && !seen.has(current) && ancestry.length < 32) {
    seen.add(current);
    const currentSummary = nodeSummary(documentSnapshot, current, strings);
    const parent = Number(parents[current]);
    if (!Number.isInteger(parent) || parent < 0) break;
    const parentSummary = nodeSummary(documentSnapshot, parent, strings);
    ancestry.push(parentSummary);

    // DOMSnapshot has two Chromium representations for an open shadow root:
    // older/synthetic snapshots retain an explicit #document-fragment row,
    // while current flattened snapshots attach shadowRootType to the root
    // child and make its immediate parent the host. Read both forms from the
    // same immutable snapshot. Walking every ancestor also preserves nested
    // host chains; the collection is reversed below to emit outer -> inner.
    if (currentSummary.shadowRootType) {
      const hostIndex = parentSummary.nodeName === '#document-fragment'
        ? Number(parents[parent])
        : parent;
      recordShadowBoundary(currentSummary.shadowRootType, hostIndex, current);
    }

    if (parentSummary.shadowRootType || parentSummary.nodeName === '#document-fragment') {
      const hostIndex = Number(parents[parent]);
      recordShadowBoundary(parentSummary.shadowRootType, hostIndex, parent);
    }
    current = parent;
  }
  return {
    ancestry,
    shadowHosts: shadowHostsInsideOut.reverse(),
    shadowGaps: shadowGapsInsideOut.reverse(),
  };
}

function axValue(value) {
  if (value == null) return null;
  if (typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) return value.value;
  return value;
}

function accessibilitySummary(nodes, backendNodeId) {
  const list = Array.isArray(nodes) ? nodes : [];
  // Never borrow AX facts from a relative/ancestor. getPartialAXTree returns
  // relatives as well as the requested node, and list[0] is not guaranteed to
  // be the target. Only an exact backend-node match is authoritative.
  const target = list.find((node) => Number(node?.backendDOMNodeId) === Number(backendNodeId)) || null;
  if (!target) return { role: null, name: null, description: null, ignored: null, properties: {} };
  const properties = {};
  for (const property of target.properties || []) {
    if (property?.name) properties[property.name] = axValue(property.value);
  }
  return {
    axNodeId: target.nodeId || null,
    backendNodeId: Number(target.backendDOMNodeId) || Number(backendNodeId) || null,
    role: clean(axValue(target.role), 120) || null,
    name: clean(axValue(target.name), 500) || null,
    description: clean(axValue(target.description), 500) || null,
    ignored: target.ignored === true,
    properties,
  };
}

async function captureSnapshot(cdp) {
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  return await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles: DEFAULT_COMPUTED_STYLES,
    includePaintOrder: true,
    includeDOMRects: true,
  });
}

function captureFailure(reason, detail = null, extra = {}) {
  return {
    schema: CAPTURE_SCHEMA,
    available: extra.available !== false,
    captured: false,
    authoritative: false,
    source: 'chromium_cdp',
    phase: extra.phase || 'pre_action',
    reason,
    detail: clean(detail, 1_000) || null,
    capturedAt: new Date().toISOString(),
    ...extra,
  };
}

function pageContext(page) {
  try { return page?.context?.() || null; } catch (_) { return null; }
}

function isNonChromiumCdpError(error) {
  const message = clean(error?.message || error, 1_000).toLowerCase();
  return /(?:cdp|devtools protocol).*(?:only|not).*(?:chromium|supported)/.test(message)
    || /(?:only|not).*(?:chromium|supported).*(?:cdp|devtools protocol)/.test(message);
}

function cdpCaptureTimeoutMs(value) {
  const configured = Number(value ?? process.env.QAAI_CDP_CAPTURE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_CDP_CAPTURE_TIMEOUT_MS;
  return Math.max(25, Math.min(15_000, Math.floor(configured)));
}

function cdpCaptureTimeoutError(timeoutMs) {
  const error = new Error(`Authoritative CDP evidence capture exceeded ${timeoutMs}ms.`);
  error.code = 'QAAI_CDP_CAPTURE_TIMEOUT';
  return error;
}

async function detachCdpSession(cdp) {
  if (!cdp || typeof cdp.detach !== 'function') return;
  const detach = Promise.resolve().then(() => cdp.detach());
  detach.catch(() => {});
  await Promise.race([
    detach,
    new Promise((resolve) => setTimeout(resolve, CDP_DETACH_TIMEOUT_MS)),
  ]).catch(() => {});
}

async function withCdpSession(page, operation, timeoutMs = null) {
  const context = pageContext(page);
  if (!page || !context || typeof context.newCDPSession !== 'function') {
    return captureFailure('playwright_page_unavailable', null, { available: false });
  }
  const captureTimeoutMs = cdpCaptureTimeoutMs(timeoutMs);
  let cdp = null;
  let expired = false;
  let timer = null;
  const timeoutError = cdpCaptureTimeoutError(captureTimeoutMs);
  const capture = (async () => {
    cdp = await context.newCDPSession(page);
    if (expired) {
      await detachCdpSession(cdp);
      throw timeoutError;
    }
    return await operation(cdp);
  })();
  capture.catch(() => {});
  try {
    return await Promise.race([
      capture,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(timeoutError);
        }, captureTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await detachCdpSession(cdp);
  }
}

async function captureExactDomState(cdp, backendNodeId) {
  let objectId = null;
  try {
    const resolved = await cdp.send('DOM.resolveNode', {
      backendNodeId,
      objectGroup: 'qaai-authoritative-element-state',
    });
    objectId = resolved?.object?.objectId || null;
    if (!objectId) {
      return { available: false, source: 'runtime_exact_node', reason: 'dom_resolve_node_unavailable' };
    }
    const invoked = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: EXACT_ELEMENT_STATE_FUNCTION,
      returnByValue: true,
      awaitPromise: false,
      userGesture: false,
    });
    if (invoked?.exceptionDetails) {
      return {
        available: false,
        source: 'runtime_exact_node',
        reason: 'runtime_element_state_exception',
        detail: clean(invoked.exceptionDetails?.text, 500) || null,
      };
    }
    const value = invoked?.result?.value;
    if (!value || typeof value !== 'object' || value.available !== true) {
      return {
        available: false,
        source: 'runtime_exact_node',
        reason: clean(value?.reason, 200) || 'runtime_element_state_unavailable',
      };
    }
    return { source: 'runtime_exact_node', ...value, available: true };
  } catch (error) {
    return {
      available: false,
      source: 'runtime_exact_node',
      reason: 'runtime_element_state_failed',
      detail: clean(error?.message || error, 500) || null,
    };
  } finally {
    if (objectId) {
      try { await cdp.send('Runtime.releaseObject', { objectId }); } catch (_) {}
    }
  }
}

function boxModelCenter(boxModel) {
  const quad = Array.isArray(boxModel?.content) && boxModel.content.length >= 8
    ? boxModel.content
    : (Array.isArray(boxModel?.border) && boxModel.border.length >= 8 ? boxModel.border : null);
  if (!quad) return null;
  const x = (Number(quad[0]) + Number(quad[2]) + Number(quad[4]) + Number(quad[6])) / 4;
  const y = (Number(quad[1]) + Number(quad[3]) + Number(quad[5]) + Number(quad[7])) / 4;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

async function capturePointerHitTest(cdp, {
  backendNodeId,
  documentFrameId,
  framePath = [],
  boxModel = null,
  domState = null,
} = {}) {
  const local = domState?.localHitTest && typeof domState.localHitTest === 'object'
    ? domState.localHitTest
    : { available: false, targetOrDescendant: null, reason: 'runtime_hit_test_unavailable' };
  const point = boxModelCenter(boxModel) || local.point || null;
  let cdpHit = { available: false, backendNodeId: null, frameId: null, reason: 'box_model_unavailable' };
  if (point) {
    try {
      const hit = await cdp.send('DOM.getNodeForLocation', {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: true,
        ignorePointerEventsNone: false,
      });
      cdpHit = {
        available: Number(hit?.backendNodeId) > 0,
        backendNodeId: Number(hit?.backendNodeId) || null,
        frameId: clean(hit?.frameId, 200) || null,
        reason: Number(hit?.backendNodeId) > 0 ? null : 'cdp_action_point_empty',
      };
    } catch (error) {
      cdpHit = {
        available: false,
        backendNodeId: null,
        frameId: null,
        reason: 'cdp_hit_test_failed',
        detail: clean(error?.message || error, 500) || null,
      };
    }
  }

  let targetOrDescendant = local.available === true
    ? booleanOrNull(local.targetOrDescendant)
    : null;
  let reason = local.reason || null;
  const frameOwnerIds = new Set((framePath || []).map((entry) => Number(entry?.backendNodeId)).filter(Boolean));
  if (targetOrDescendant === true && framePath.length && cdpHit.available) {
    const reachesTargetFrame = cdpHit.backendNodeId === Number(backendNodeId)
      || frameOwnerIds.has(cdpHit.backendNodeId)
      || (cdpHit.frameId && cdpHit.frameId === documentFrameId);
    if (!reachesTargetFrame) {
      targetOrDescendant = false;
      reason = 'cross_frame_action_point_occluded';
    }
  } else if (targetOrDescendant === null && cdpHit.available) {
    if (cdpHit.backendNodeId === Number(backendNodeId) || frameOwnerIds.has(cdpHit.backendNodeId)) {
      targetOrDescendant = true;
      reason = null;
    }
  }

  return {
    available: targetOrDescendant === true || targetOrDescendant === false,
    targetOrDescendant,
    occluded: targetOrDescendant === null ? null : !targetOrDescendant,
    reason,
    point,
    local,
    cdp: cdpHit,
  };
}

async function captureLocatedNode(cdp, snapshot, located, phase) {
  const { documentIndex, nodeIndex, documentSnapshot, documents, strings } = located;
  const node = nodeSummary(documentSnapshot, nodeIndex, strings);
  if (!node.backendNodeId) return captureFailure('backend_node_id_missing', null, { phase });
  const document = documentMetadata(documentSnapshot, documentIndex, strings);
  const dom = buildDomAncestry(documentSnapshot, nodeIndex, strings);
  const framePath = buildFramePath(documents, documentIndex, strings);
  const layout = layoutAt(documentSnapshot, nodeIndex, strings);
  let axNodes = [];
  let described = null;
  let boxModel = null;
  try {
    const ax = await cdp.send('Accessibility.getPartialAXTree', {
      backendNodeId: node.backendNodeId,
      fetchRelatives: true,
    });
    axNodes = ax?.nodes || [];
  } catch (_) {}
  try {
    const description = await cdp.send('DOM.describeNode', {
      backendNodeId: node.backendNodeId,
      depth: 1,
      pierce: true,
    });
    described = description?.node || null;
  } catch (_) {}
  try {
    const box = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    boxModel = box?.model || null;
  } catch (_) {}
  const accessibility = accessibilitySummary(axNodes, node.backendNodeId);
  const capturedNode = {
    ...node,
    localName: described?.localName || null,
    nodeName: described?.nodeName || node.nodeName,
    nodeValue: clean(described?.nodeValue || node.nodeValue, 240) || null,
  };
  const domState = await captureExactDomState(cdp, node.backendNodeId);
  const pointerHitTest = await capturePointerHitTest(cdp, {
    backendNodeId: node.backendNodeId,
    documentFrameId: document.frameId,
    framePath,
    boxModel,
    domState,
  });
  const state = normalizeAuthoritativeElementState({
    node: capturedNode,
    accessibility,
    layout,
    domState,
    pointerHitTest,
    connected: true,
  });
  return {
    schema: CAPTURE_SCHEMA,
    available: true,
    captured: true,
    authoritative: true,
    source: 'chromium_cdp',
    phase,
    capturedAt: new Date().toISOString(),
    identity: {
      scheme: 'qaai-cdp-backend-node-v1',
      backendNodeId: node.backendNodeId,
      documentIndex,
      nodeIndex,
      frameId: document.frameId,
      documentUrl: document.documentUrl,
      connected: state.connected,
    },
    node: capturedNode,
    document,
    framePath,
    shadowPath: dom.shadowHosts,
    shadowContext: dom.shadowGaps.length
      ? { available: false, reason: dom.shadowGaps[0].reason, gaps: dom.shadowGaps }
      : { available: true, reason: null, gaps: [] },
    ancestry: dom.ancestry,
    accessibility,
    domState,
    pointerHitTest,
    state,
    layout: { ...layout, boxModel },
  };
}

async function captureMarkedTarget({ page, markerAttribute, markerValue, phase = 'pre_action', timeoutMs = null } = {}) {
  const attribute = clean(markerAttribute, 120);
  const value = clean(markerValue, 300);
  if (!attribute || !value) return captureFailure('marker_missing', null, { phase });
  try {
    return await withCdpSession(page, async (cdp) => {
      const snapshot = await captureSnapshot(cdp);
      const found = findMarkerMatches(snapshot, attribute, value);
      if (found.matches.length !== 1) {
        return captureFailure(found.matches.length ? 'marker_ambiguous' : 'marker_not_found', null, {
          phase,
          matchCount: found.matches.length,
        });
      }
      const match = found.matches[0];
      return await captureLocatedNode(cdp, snapshot, {
        ...match,
        documents: found.documents,
        strings: found.strings,
      }, phase);
    }, timeoutMs);
  } catch (error) {
    const nonChromium = isNonChromiumCdpError(error);
    return captureFailure(nonChromium ? 'chromium_cdp_unavailable' : 'cdp_capture_failed', error?.message || error, {
      phase,
      available: !nonChromium,
    });
  }
}

/**
 * Resolve multiple temporary candidate markers from one immutable DOMSnapshot.
 * Each marker is independent, so a candidate is accepted only when its own
 * marker occurs exactly once.  This is the batch proof used to compare every
 * Playwright candidate with the acted target's backendNodeId.
 */
async function captureMarkedCandidates({ page, markers, phase = 'candidate_verification', timeoutMs = null } = {}) {
  const requested = (Array.isArray(markers) ? markers : [])
    .map((marker, index) => ({
      id: clean(marker?.id || `candidate-${index}`, 200),
      markerAttribute: clean(marker?.markerAttribute, 120),
      markerValue: clean(marker?.markerValue, 300),
    }))
    .filter((marker) => marker.id && marker.markerAttribute && marker.markerValue)
    .slice(0, 32);
  if (!requested.length) return [];
  try {
    return await withCdpSession(page, async (cdp) => {
      const snapshot = await captureSnapshot(cdp);
      const capturedByNode = new Map();
      const out = [];
      for (const marker of requested) {
        const found = findMarkerMatches(snapshot, marker.markerAttribute, marker.markerValue);
        if (found.matches.length !== 1) {
          out.push({
            id: marker.id,
            ...captureFailure(found.matches.length ? 'candidate_marker_ambiguous' : 'candidate_marker_not_found', null, {
              phase,
              matchCount: found.matches.length,
            }),
          });
          continue;
        }
        const match = found.matches[0];
        const backendNodeId = Number(match.documentSnapshot?.nodes?.backendNodeId?.[match.nodeIndex]) || null;
        let captured = backendNodeId ? capturedByNode.get(backendNodeId) : null;
        if (!captured) {
          captured = await captureLocatedNode(cdp, snapshot, {
            ...match,
            documents: found.documents,
            strings: found.strings,
          }, phase);
          if (captured?.captured && backendNodeId) capturedByNode.set(backendNodeId, captured);
        }
        out.push({ id: marker.id, ...captured });
      }
      return out;
    }, timeoutMs);
  } catch (error) {
    const nonChromium = isNonChromiumCdpError(error);
    return requested.map((marker) => ({
      id: marker.id,
      ...captureFailure(nonChromium ? 'chromium_cdp_unavailable' : 'cdp_candidate_capture_failed', error?.message || error, {
        phase,
        available: !nonChromium,
      }),
    }));
  }
}

async function captureBackendNodeStates({ page, previousCaptures, phase = 'post_action', timeoutMs = null } = {}) {
  const previous = (Array.isArray(previousCaptures) ? previousCaptures : [previousCaptures])
    .filter((capture) => capture?.captured && capture?.identity?.backendNodeId);
  if (!previous.length) return [];
  try {
    return await withCdpSession(page, async (cdp) => {
      const snapshot = await captureSnapshot(cdp);
      const out = [];
      for (const capture of previous) {
        const backendNodeId = Number(capture.identity.backendNodeId);
        const located = findBackendNode(snapshot, backendNodeId);
        if (!located) {
          out.push({
            schema: CAPTURE_SCHEMA,
            available: true,
            captured: true,
            authoritative: true,
            source: 'chromium_cdp',
            phase,
            capturedAt: new Date().toISOString(),
            identity: { ...capture.identity, connected: false },
            presentInSnapshot: false,
            pageTransitioned: clean(capture.identity.documentUrl) !== clean(page?.url?.()),
          });
          continue;
        }
        const current = await captureLocatedNode(cdp, snapshot, located, phase);
        out.push({
          ...current,
          presentInSnapshot: true,
          sameBackendNode: current?.identity?.backendNodeId === backendNodeId,
          pageTransitioned: clean(capture.identity.documentUrl) !== clean(current?.identity?.documentUrl),
        });
      }
      return out;
    }, timeoutMs);
  } catch (error) {
    const nonChromium = isNonChromiumCdpError(error);
    return previous.map((capture) => captureFailure(nonChromium ? 'chromium_cdp_unavailable' : 'cdp_post_capture_failed', error?.message || error, {
      phase,
      available: !nonChromium,
      backendNodeId: capture.identity.backendNodeId,
    }));
  }
}

module.exports = {
  CAPTURE_SCHEMA,
  DEFAULT_COMPUTED_STYLES,
  captureMarkedTarget,
  captureMarkedCandidates,
  captureBackendNodeStates,
  findMarkerMatches,
  findBackendNode,
  attributesAt,
  layoutAt,
  buildFramePath,
  buildDomAncestry,
  accessibilitySummary,
  captureExactDomState,
  capturePointerHitTest,
  boxModelCenter,
  isNonChromiumCdpError,
};
