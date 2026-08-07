'use strict';

// Deterministic action policy for normal UI operations. This module is pure on
// purpose: the conductor owns browser I/O; this file owns what should be
// handled deterministically and how tool results/readback are interpreted.

function targetLabel(step = {}) {
  return String(
    step.element
    || step.target
    || step.locator_hint
    || step.verify?.field?.name
    || step.verify?.element?.name
    || ''
  ).trim();
}

function stepValue(step = {}) {
  const value = step.value != null ? step.value
    : step.text != null ? step.text
      : step.verify?.equals != null ? step.verify.equals
        : step.verify?.value != null ? step.verify.value
          : null;
  return value == null ? '' : String(value);
}

function stepKind(step = {}, contract = null) {
  if (!step) return 'unknown';
  const verb = String(step.action || step.verb || '').trim().toLowerCase();
  if (/^(?:date|set date|choose date|select date)$/.test(verb)) return 'date';
  if (/^(?:fill|type|enter|input)$/.test(verb)) return 'fill';
  if (/^(?:navigate|open url|open page|go to|visit|load)$/.test(verb)) return 'navigate';
  if (/^(?:select|choose|pick)$/.test(verb)) return 'select';
  if (/^(?:click|tap|press|submit|save|create|add|delete|remove|edit|open)$/.test(verb)) return 'click';
  if (contract && typeof contract.isFillOrTypeStep === 'function' && contract.isFillOrTypeStep(step)) return 'fill';
  if (contract && typeof contract.isNavigateStep === 'function' && contract.isNavigateStep(step)) return 'navigate';
  if (contract && typeof contract.isSelectStep === 'function' && contract.isSelectStep(step)) return 'select';
  if (contract && typeof contract.isClickStep === 'function' && contract.isClickStep(step)) return 'click';
  return 'unknown';
}

function isSensitiveTarget(label = '') {
  return /\b(pass(?:word)?|pwd|secret|token|api[-_\s]?key|pin|otp|security\s*answer)\b/i.test(String(label || ''));
}

function readbackDisposition({ label = '', value = '', readback = 'unknown', sensitive = false } = {}) {
  const rb = String(readback || 'unknown');
  // Execution truth is identical for every editable control. Sensitivity may
  // change what is rendered in reports, but it may never weaken the required
  // postcondition or select a different execution path.
  const matched = rb === 'confirmed';
  const reason = rb === 'confirmed'
    ? 'value_readback_confirmed'
    : `value_readback_${rb}`;
  const evidence = rb === 'confirmed'
    ? `DOM/readback confirms "${label}" contains the approved value.`
    : `The exact control used for Fill did not read back the approved value for "${label}"; the dependent action will not advance.`;
  return {
    status: matched ? 'pass' : 'blocked',
    matched,
    checked: true,
    reason,
    evidence,
    expected: sensitive ? '(masked)' : String(value == null ? '' : value),
    kind: 'input_value_readback',
  };
}

function canDelegateEffectToNextVerify({ idx = 0, steps = [], contract = null } = {}) {
  const next = Array.isArray(steps) ? steps[idx + 1] : null;
  return !!(next && contract && typeof contract.isVerificationStep === 'function' && contract.isVerificationStep(next));
}

function toolNameForKind(kind) {
  if (kind === 'fill') return 'browser_fill_form';
  if (kind === 'navigate') return 'browser_navigate';
  if (kind === 'select') return 'browser_select_option';
  if (kind === 'date') return 'browser_type';
  if (kind === 'click') return 'browser_click';
  return null;
}

function buildToolCall({ kind, label = '', value = '', ref = null } = {}) {
  const toolName = toolNameForKind(kind);
  if (!toolName) return null;
  if (kind === 'fill') {
    return {
      toolName,
      args: { fields: [{ name: label, element: label, type: 'textbox', target: ref, text: String(value == null ? '' : value), value: String(value == null ? '' : value) }] },
    };
  }
  if (kind === 'navigate') {
    return {
      toolName,
      args: { url: String(value == null ? '' : value) },
    };
  }
  if (kind === 'select') {
    return {
      toolName,
      args: { element: label, target: ref, values: [String(value == null ? '' : value)].filter(Boolean) },
    };
  }
  return {
    toolName,
    args: { element: label, target: ref },
  };
}

function actionNarration({ kind, label = '' } = {}) {
  if (kind === 'fill') return `Deterministic engine filled ${label} and will read it back.`;
  if (kind === 'navigate') return `Deterministic engine opened ${label} and will verify the declared destination.`;
  if (kind === 'select') return `Deterministic engine selected an option in ${label} and will verify the declared effect.`;
  if (kind === 'date') return `Deterministic engine set ${label} and will verify the committed date after rerender.`;
  if (kind === 'click') return `Deterministic engine clicked ${label} and will verify the declared effect.`;
  return `Deterministic engine handled ${label}.`;
}

module.exports = {
  actionNarration,
  buildToolCall,
  canDelegateEffectToNextVerify,
  isSensitiveTarget,
  readbackDisposition,
  stepKind,
  stepValue,
  targetLabel,
  toolNameForKind,
};
