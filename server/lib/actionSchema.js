'use strict';

/**
 * ACTION_SCHEMA — Canonical source of truth for every user-selectable action.
 *
 * This single object is imported by:
 *   - server/services/testCaseStepMutations.js   (which fields to strip on user edit)
 *   - server/services/operationContractV2.js      (targetRequired / NEVER_HAS_TARGET_ACTIONS)
 *   - server/services/controllerTypedAdapterRegistry.js (adapterKind + toolName)
 *   - server/services/controllerMcpRuntimeAdapter.js   (narration templates)
 *   - src/lib/actionSchema.js                     (frontend copy — identical export)
 *
 * Adding a new action:
 *   1. Add one entry here.
 *   2. Sync the frontend copy at src/lib/actionSchema.js.
 *   3. Nothing else changes — all layers derive their behaviour from this schema.
 *
 * Field semantics:
 *   targetRequired    — Does execution need a DOM element reference?
 *   valueRequired     — Is a value/URL/key mandatory for this action?
 *   valueLabel        — Human label for the "value" UI field.
 *   validationAllowed — Can the user add a post-action assertion?
 *   fields            — Which UI form fields to render (drives TestCases.jsx visibility).
 *   adapterKind       — Adapter routing key for controllerTypedAdapterRegistry.js.
 *   toolName          — Primary Playwright MCP tool name (null for assertion-only actions).
 *   narrationTemplate — Template string used by controllerMcpRuntimeAdapter.js.
 *                       Placeholders: {{target}}, {{value}}, {{expected}}, {{observed}},
 *                       {{x}}, {{y}}, {{color}}, {{width}}, {{height}}, {{result}}.
 *   category          — Display group for the UI dropdown.
 */
const ACTION_SCHEMA = {

  // ─── Browser & Frames ────────────────────────────────────────────────────
  Navigate: {
    targetRequired:   false,
    valueRequired:    true,
    valueLabel:       'URL',
    validationAllowed: false,
    fields:           ['value'],
    adapterKind:      'NAVIGATION',
    toolName:         'browser_navigate',
    narrationTemplate: 'Directed the browser to navigate to {{value}}',
    category:         'Browser & Frames',
  },

  GoBack: {
    targetRequired:   false,
    valueRequired:    false,
    validationAllowed: false,
    fields:           [],
    adapterKind:      'NAVIGATION',
    toolName:         'go_back',
    narrationTemplate: 'Navigated back to the previous page',
    category:         'Browser & Frames',
  },

  GoForward: {
    targetRequired:   false,
    valueRequired:    false,
    validationAllowed: false,
    fields:           [],
    adapterKind:      'NAVIGATION',
    toolName:         'go_forward',
    narrationTemplate: 'Navigated forward to the next page',
    category:         'Browser & Frames',
  },

  Refresh: {
    targetRequired:   false,
    valueRequired:    false,
    validationAllowed: false,
    fields:           [],
    adapterKind:      'NAVIGATION',
    toolName:         'browser_reload',
    narrationTemplate: 'Refreshed the current page',
    category:         'Browser & Frames',
  },

  SwitchTab: {
    targetRequired:   false,
    valueRequired:    true,
    valueLabel:       'Tab index or title',
    validationAllowed: false,
    fields:           ['value'],
    adapterKind:      'CONTEXT',
    toolName:         'browser_tabs',
    narrationTemplate: 'Switched to browser tab "{{value}}"',
    category:         'Browser & Frames',
  },

  SwitchFrame: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'CONTEXT',
    toolName:         'browser_evaluate',
    narrationTemplate: 'Switched execution context into iframe "{{target}}"',
    category:         'Browser & Frames',
  },

  AccessShadow: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'CONTEXT',
    toolName:         'browser_evaluate',
    narrationTemplate: 'Accessed Shadow DOM of "{{target}}"',
    category:         'Browser & Frames',
  },

  Evaluate: {
    targetRequired:   false,
    valueRequired:    true,
    valueLabel:       'JavaScript expression',
    validationAllowed: false,
    fields:           ['value'],
    adapterKind:      'GENERIC',
    toolName:         'browser_evaluate',
    narrationTemplate: 'Executed custom JavaScript on the page',
    category:         'Browser & Frames',
  },

  Screenshot: {
    targetRequired:   false,
    valueRequired:    false,
    validationAllowed: false,
    fields:           [],
    adapterKind:      'GENERIC',
    toolName:         'browser_take_screenshot',
    narrationTemplate: 'Captured a visual screenshot of the page',
    category:         'Browser & Frames',
  },

  // ─── Native Dialogs & Alerts ─────────────────────────────────────────────
  AcceptAlert: {
    targetRequired:   false,
    valueRequired:    false,
    validationAllowed: false,
    fields:           [],
    adapterKind:      'DIALOG',
    toolName:         'browser_handle_dialog',
    narrationTemplate: 'Accepted the browser alert / confirm dialog',
    category:         'Native Dialogs & Alerts',
  },

  DismissAlert: {
    targetRequired:   false,
    valueRequired:    false,
    validationAllowed: false,
    fields:           [],
    adapterKind:      'DIALOG',
    toolName:         'browser_handle_dialog',
    narrationTemplate: 'Dismissed the browser alert / confirm dialog',
    category:         'Native Dialogs & Alerts',
  },

  TypeAlert: {
    targetRequired:   false,
    valueRequired:    true,
    valueLabel:       'Text to type into the prompt',
    validationAllowed: false,
    fields:           ['value'],
    adapterKind:      'DIALOG',
    toolName:         'browser_handle_dialog',
    narrationTemplate: 'Typed "{{value}}" into the browser prompt dialog',
    category:         'Native Dialogs & Alerts',
  },

  // ─── Keyboard & Shortcuts ────────────────────────────────────────────────
  PressKey: {
    targetRequired:   false,
    valueRequired:    true,
    valueLabel:       'Key name (Enter, Tab, Escape, Space…)',
    validationAllowed: false,
    fields:           ['value'],
    adapterKind:      'GENERIC',
    toolName:         'browser_press_key',
    narrationTemplate: 'Pressed the {{value}} key',
    category:         'Keyboard & Shortcuts',
  },

  Hotkey: {
    targetRequired:   false,
    valueRequired:    true,
    valueLabel:       'Key combination (Ctrl+A, Ctrl+V…)',
    validationAllowed: false,
    fields:           ['value'],
    adapterKind:      'GENERIC',
    toolName:         'browser_press_key',
    narrationTemplate: 'Pressed the {{value}} keyboard shortcut',
    category:         'Keyboard & Shortcuts',
  },

  TypeSequentially: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Text to type character-by-character',
    validationAllowed: true,
    fields:           ['target', 'value'],
    adapterKind:      'TEXT_INPUT',
    toolName:         'browser_type',
    narrationTemplate: 'Typed "{{value}}" sequentially into "{{target}}"',
    category:         'Keyboard & Shortcuts',
  },

  // ─── Files & Downloads ───────────────────────────────────────────────────
  Upload: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'File path or fixture name',
    validationAllowed: false,
    fields:           ['target', 'value'],
    adapterKind:      'UPLOAD',
    toolName:         'browser_upload_file',
    narrationTemplate: 'Uploaded file to "{{target}}"',
    category:         'Files & Downloads',
  },

  Download: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_click',
    narrationTemplate: 'Triggered file download via "{{target}}"',
    category:         'Files & Downloads',
  },

  // ─── Mouse & Interaction ─────────────────────────────────────────────────
  Click: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: true,
    fields:           ['target', 'validation', 'condition'],
    adapterKind:      'BUTTON_OR_LINK',
    toolName:         'browser_click',
    narrationTemplate: 'Located "{{target}}" and successfully clicked it',
    category:         'Mouse & Interaction',
  },

  ClickAndHold: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_click_and_hold',
    narrationTemplate: 'Located "{{target}}" and performed a click-and-hold action',
    category:         'Mouse & Interaction',
  },

  DoubleClick: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_double_click',
    narrationTemplate: 'Located "{{target}}" and double-clicked it',
    category:         'Mouse & Interaction',
  },

  RightClick: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_right_click',
    narrationTemplate: 'Right-clicked "{{target}}" to open the context menu',
    category:         'Mouse & Interaction',
  },

  Hover: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'BUTTON_OR_LINK',
    toolName:         'browser_hover',
    narrationTemplate: 'Hovered the mouse over "{{target}}"',
    category:         'Mouse & Interaction',
  },

  DragAndDrop: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Drop target element',
    validationAllowed: false,
    fields:           ['target', 'value'],
    adapterKind:      'GENERIC',
    toolName:         'browser_drag',
    narrationTemplate: 'Dragged "{{target}}" and dropped it onto "{{value}}"',
    category:         'Mouse & Interaction',
  },

  Slider: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Value to set (number or percentage)',
    validationAllowed: false,
    fields:           ['target', 'value'],
    adapterKind:      'GENERIC',
    toolName:         'browser_drag',
    narrationTemplate: 'Set the "{{target}}" slider to {{value}}',
    category:         'Mouse & Interaction',
  },

  ScrollIntoView: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'REVEAL',
    toolName:         'browser_scroll',
    narrationTemplate: 'Scrolled "{{target}}" into view',
    category:         'Mouse & Interaction',
  },

  // ─── Input Actions ───────────────────────────────────────────────────────
  Fill: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Text to type',
    validationAllowed: true,
    fields:           ['target', 'value', 'validation', 'condition'],
    adapterKind:      'TEXT_INPUT',
    toolName:         'browser_type',
    narrationTemplate: 'Found "{{target}}" and successfully typed "{{value}}" into it',
    category:         'Mouse & Interaction',
  },

  Append: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Text to append',
    validationAllowed: true,
    fields:           ['target', 'value', 'validation'],
    adapterKind:      'TEXT_INPUT',
    toolName:         'browser_type',
    narrationTemplate: 'Found "{{target}}" and successfully appended "{{value}}" to it',
    category:         'Mouse & Interaction',
  },

  Clear: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'TEXT_INPUT',
    toolName:         'browser_type',
    narrationTemplate: 'Successfully cleared all existing text from the "{{target}}" input field',
    category:         'Mouse & Interaction',
  },

  ClearAndType: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Text to type after clearing',
    validationAllowed: true,
    fields:           ['target', 'value', 'validation', 'condition'],
    adapterKind:      'TEXT_INPUT',
    toolName:         'browser_type',
    narrationTemplate: 'Cleared "{{target}}" and entered "{{value}}"',
    category:         'Mouse & Interaction',
  },

  Select: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Option label or value to select',
    validationAllowed: true,
    fields:           ['target', 'value', 'validation'],
    adapterKind:      'NATIVE_SELECT',
    toolName:         'browser_select',
    narrationTemplate: 'Selected "{{value}}" from the "{{target}}" dropdown',
    category:         'Mouse & Interaction',
  },

  SelectMultiple: {
    targetRequired:   true,
    valueRequired:    true,
    valueLabel:       'Option labels or values (comma-separated)',
    validationAllowed: true,
    fields:           ['target', 'value', 'validation'],
    adapterKind:      'NATIVE_SELECT',
    toolName:         'browser_select_option',
    narrationTemplate: 'Selected options {{value}} from the "{{target}}" multi-select dropdown',
    category:         'Mouse & Interaction',
  },

  Check: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'BOOLEAN',
    toolName:         'browser_check',
    narrationTemplate: 'Checked the "{{target}}" checkbox',
    category:         'Mouse & Interaction',
  },

  Uncheck: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'BOOLEAN',
    toolName:         'browser_uncheck',
    narrationTemplate: 'Unchecked the "{{target}}" checkbox',
    category:         'Mouse & Interaction',
  },

  Radio: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'BUTTON_OR_LINK',
    toolName:         'browser_click',
    narrationTemplate: 'Selected radio button "{{target}}"',
    category:         'Mouse & Interaction',
  },

  // ─── Element Properties & Visual Proofs ──────────────────────────────────
  GetLocation: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_evaluate',
    // {{x}} and {{y}} are substituted from the evaluate result
    narrationTemplate: '"{{target}}" is at X: {{x}}, Y: {{y}} on screen',
    category:         'Element Properties & Visual Proofs',
  },

  GetColor: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_evaluate',
    // {{color}} is substituted from the evaluate result
    narrationTemplate: '"{{target}}" color is {{color}}',
    category:         'Element Properties & Visual Proofs',
  },

  GetSize: {
    targetRequired:   true,
    valueRequired:    false,
    validationAllowed: false,
    fields:           ['target'],
    adapterKind:      'GENERIC',
    toolName:         'browser_evaluate',
    // {{width}} and {{height}} are substituted from the evaluate result
    narrationTemplate: '"{{target}}" is {{width}}px × {{height}}px',
    category:         'Element Properties & Visual Proofs',
  },

  Inspect: {
    targetRequired:   true,
    valueRequired:    false,
    valueLabel:       'Property to inspect (text, state, value)',
    validationAllowed: true,
    fields:           ['target', 'value', 'validation'],
    adapterKind:      'GENERIC',
    toolName:         'browser_evaluate',
    narrationTemplate: 'Inspected "{{target}}"',
    category:         'Element Properties & Visual Proofs',
  },

  Verify: {
    targetRequired:   true,
    valueRequired:    false,
    valueLabel:       'Expected value or state',
    validationAllowed: true,
    fields:           ['target', 'validation'],
    adapterKind:      'ASSERTION',
    toolName:         null,
    narrationTemplate: 'Verified "{{target}}" — {{result}}',
    category:         'Element Properties & Visual Proofs',
  },
};

/**
 * Set of action types that must NEVER have a target element.
 * Used by operationContractV2.js to enforce targetIdentity = null.
 * Derived from ACTION_SCHEMA so it stays automatically in sync.
 */
const NEVER_HAS_TARGET_ACTIONS = new Set(
  Object.entries(ACTION_SCHEMA)
    .filter(([, def]) => def.targetRequired === false)
    .map(([name]) => name.toLowerCase()),
);

/**
 * Render a narration template with the given data bag.
 * Unknown placeholders are left as-is.
 *
 * @param {string} template
 * @param {Record<string, string|number>} data
 * @returns {string}
 */
function renderNarration(template, data = {}) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = data[key];
    return val !== undefined && val !== null ? String(val) : `{{${key}}}`;
  });
}

/**
 * Return the schema entry for a given action name (case-insensitive).
 * Returns undefined if the action is not in the schema.
 *
 * @param {string} action
 * @returns {object|undefined}
 */
function getActionDef(action) {
  if (!action) return undefined;
  // Try exact match first, then case-insensitive scan
  if (ACTION_SCHEMA[action]) return ACTION_SCHEMA[action];
  const lower = action.toLowerCase();
  const key = Object.keys(ACTION_SCHEMA).find((k) => k.toLowerCase() === lower);
  return key ? ACTION_SCHEMA[key] : undefined;
}

module.exports = { ACTION_SCHEMA, NEVER_HAS_TARGET_ACTIONS, renderNarration, getActionDef };
