'use strict';

/**
 * P2-3 — shared role-alias map.
 *
 * Playwright's accessibility tree often represents tabular and status
 * content with role names that differ from what an assertion was authored
 * against. An assertion of expectedRole: "row" misses a perfectly valid
 * table when Playwright reports the rows as "gridcell" / "cell" /
 * "rowheader" / "columnheader". Same for alerts (sometimes rendered with
 * role="status") and form fields.
 *
 * This map was previously duplicated inside server/services/mcp.js
 * (_checkAssertionOnce). Future role-alias additions need to be applied
 * here ONCE so all consumers stay in sync.
 *
 * Generic rule: drift-prone constants live in one file.
 */

const ROLE_ALIASES = Object.freeze({
  row: ['gridcell', 'cell', 'rowheader', 'columnheader'],
  cell: ['gridcell', 'rowheader', 'columnheader'],
  gridcell: ['cell', 'rowheader', 'columnheader'],
  alert: ['status', 'alertdialog'],
  status: ['alert'],
  textbox: ['combobox', 'searchbox', 'spinbutton'],
  button: ['link'],
  link: ['button'],
});

/**
 * Return the aliases list for a given role (case-insensitive). Returns []
 * when no aliases are registered — callers should treat that as
 * "match the literal role, no aliasing".
 */
function aliasesFor(role) {
  if (!role) return [];
  return ROLE_ALIASES[String(role).toLowerCase()] || [];
}

module.exports = { ROLE_ALIASES, aliasesFor };
