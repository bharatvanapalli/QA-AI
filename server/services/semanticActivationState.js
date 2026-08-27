'use strict';

const SEMANTIC_ACTIVATION_STATE_VERSION = 'qaai-semantic-activation-state-v1';

function buildBoundActivationRecoveryFunction() {
  return `async (owner) => {
    const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
    const attr = (node, name) => node?.getAttribute ? clean(node.getAttribute(name)) : '';
    const rendered = (node) => {
      if (!node || node.nodeType !== 1) return false;
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden'
        && style.opacity !== '0' && style.pointerEvents !== 'none'
        && rect.width > 0 && rect.height > 0;
    };
    if (!owner || owner.nodeType !== 1) {
      return JSON.stringify({
        ok: false,
        reason: 'bound_activation_owner_unavailable',
        actionPerformed: false,
        ownerMatched: false,
      });
    }
    const disabled = owner.disabled === true
      || attr(owner, 'aria-disabled').toLowerCase() === 'true';
    if (owner.isConnected !== true || !rendered(owner) || disabled) {
      return JSON.stringify({
        ok: false,
        reason: disabled
          ? 'bound_activation_owner_disabled'
          : owner.isConnected !== true
            ? 'bound_activation_owner_disconnected'
            : 'bound_activation_owner_not_rendered',
        actionPerformed: false,
        ownerMatched: true,
        disabled,
      });
    }
    owner.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (owner.isConnected !== true || !rendered(owner)) {
      return JSON.stringify({
        ok: false,
        reason: 'bound_activation_owner_changed_during_reveal',
        actionPerformed: false,
        ownerMatched: true,
      });
    }
    try { owner.focus({ preventScroll: true }); } catch (_) { try { owner.focus(); } catch (_) {} }
    const evtOpts = { bubbles: true, cancelable: true, view: window, composed: true };
    try { owner.dispatchEvent(new PointerEvent('pointerdown', evtOpts)); } catch (_) {}
    try { owner.dispatchEvent(new MouseEvent('mousedown', evtOpts)); } catch (_) {}
    try { owner.dispatchEvent(new PointerEvent('pointerup', evtOpts)); } catch (_) {}
    try { owner.dispatchEvent(new MouseEvent('mouseup', evtOpts)); } catch (_) {}
    owner.click();
    return JSON.stringify({
      ok: true,
      reason: 'bound_activation_recovery_dispatched',
      actionPerformed: true,
      ownerMatched: true,
      ownerConnected: owner.isConnected === true,
      role: attr(owner, 'role') || String(owner.tagName || '').toLowerCase(),
    });
  }`;
}

module.exports = {
  SEMANTIC_ACTIVATION_STATE_VERSION,
  buildBoundActivationRecoveryFunction,
};
