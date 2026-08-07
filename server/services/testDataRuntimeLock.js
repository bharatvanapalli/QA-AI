'use strict';

/**
 * Test-data RUNTIME LOCK — force a tool's typed/selected value to the CURRENT
 * data row's value, but ONLY for a field that is EXPLICITLY data-bound. A
 * concrete literal authored in the step (e.g. Employee Name "Alice", a new
 * "Add User" username "qaai_ess_lifecycle_01", a password "Lifecycle@2024") is
 * PRESERVED — never overwritten.
 *
 * P0 fix (was a correctness bug): the previous version matched a field by GENERIC
 * word overlap ("user"/"login"/"pass"/"name") and let that override any value —
 * so the login row's username ("Admin") leaked onto every "Username"-ish field on
 * unrelated forms (Add User), corrupting execution. We now bind ONLY when:
 *   (1) the step's authored value/element is a {{token}} (token names the column), OR
 *   (2) dataBinding.columnToField maps THIS step's field role to a row column, OR
 *   (3) a dataBinding.placeholders entry resolves the token to a column.
 * No generic label word-matching. Literals are kept verbatim.
 */

function clean(value) { return String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); }

function fieldsOf(dataRow) {
  const fields = dataRow && dataRow.fields && typeof dataRow.fields === 'object'
    ? dataRow.fields
    : (dataRow && dataRow.inputs && typeof dataRow.inputs === 'object' ? dataRow.inputs : {});
  return Object.entries(fields)
    .map(([role, value]) => [role, clean(value)])
    .filter(([, value]) => value !== '');
}

function rowValueForRole(role, entries) {
  const r = clean(role).toLowerCase();
  if (!r) return null;
  for (const [k, v] of entries) if (clean(k).toLowerCase() === r) return v;
  return null;
}

function firstToken(...candidates) {
  for (const c of candidates) {
    const m = /\{\{\s*([\w.\- ]+?)\s*\}\}/.exec(String(c == null ? '' : c));
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * The value this step is EXPLICITLY data-bound to, or null. ONLY explicit
 * binding signals count — a literal value yields null (preserve it).
 */
function boundValueForStep(declaredStep, entries) {
  if (!declaredStep) return null;
  const db = declaredStep.dataBinding || null;

  // (1) {{token}} in the authored value/expected/element — token names the column.
  const tok = firstToken(declaredStep.value, declaredStep.text, declaredStep.expected, declaredStep.expectedValue, declaredStep.element);
  if (tok) {
    let col = tok;
    if (db && db.placeholders && typeof db.placeholders === 'object' && db.placeholders[tok]) col = db.placeholders[tok];
    const v = rowValueForRole(col, entries) || rowValueForRole(tok, entries);
    if (v) return { value: v, source: `token:${tok}` };
  }

  // (2) explicit columnToField mapping for THIS step's field role.
  if (db && db.isDataBound && db.columnToField && typeof db.columnToField === 'object') {
    const fieldRole = clean(declaredStep.fieldRole || declaredStep.role || declaredStep.field || '').toLowerCase();
    if (fieldRole) {
      for (const [col, field] of Object.entries(db.columnToField)) {
        if (clean(field).toLowerCase() === fieldRole) {
          const v = rowValueForRole(col, entries) || rowValueForRole(field, entries);
          if (v) return { value: v, source: `columnToField:${col}` };
        }
      }
    }
  }
  return null; // not explicitly data-bound → preserve the authored/model value
}

function setTextArg(args, value) {
  const out = { ...(args || {}) };
  if (Object.prototype.hasOwnProperty.call(out, 'text')) out.text = value;
  else if (Object.prototype.hasOwnProperty.call(out, 'value')) out.value = value;
  else out.text = value;
  return out;
}

function lockToolInputToDataRow({ toolName, args = {}, declaredStep = null, dataRow = null } = {}) {
  const entries = fieldsOf(dataRow);
  if (!entries.length) return { args, changed: false, reason: 'no_data_row' };
  const tool = String(toolName || '');

  // browser_fill_form: per-field, ONLY fields whose own value is a {{token}}.
  // A literal field value is preserved.
  if (tool === 'browser_fill_form' && Array.isArray(args.fields)) {
    let changed = false;
    const fields = args.fields.map((field) => {
      const tok = firstToken(field.value, field.text, field.element);
      if (!tok) return field; // literal → preserve
      const v = rowValueForRole(tok, entries);
      if (!v) return field;
      const actual = clean(field.value != null ? field.value : field.text);
      if (actual === v) return field;
      changed = true;
      return { ...field, value: v };
    });
    if (!changed) return { args, changed: false, reason: 'no_token_bound_fields' };
    return { args: { ...(args || {}), fields }, changed: true, reason: 'form_fields_token_bound' };
  }

  const bound = boundValueForStep(declaredStep, entries);
  if (!bound || !bound.value) return { args, changed: false, reason: 'not_data_bound' };

  if (tool === 'browser_type' || tool === 'browser_fill') {
    const actual = clean(args.text != null ? args.text : args.value);
    if (actual === bound.value) return { args, changed: false, reason: 'already_locked' };
    return { args: setTextArg(args, bound.value), changed: true, reason: bound.source, from: actual, to: bound.value };
  }

  if (tool === 'browser_select_option' || tool === 'browser_select') {
    const actualValues = Array.isArray(args.values) ? args.values.map(clean) : [clean(args.value)].filter(Boolean);
    if (actualValues.length === 1 && actualValues[0] === bound.value) return { args, changed: false, reason: 'already_locked' };
    return { args: { ...(args || {}), values: [bound.value] }, changed: true, reason: bound.source, from: actualValues.join(', '), to: bound.value };
  }

  return { args, changed: false, reason: 'tool_not_input' };
}

module.exports = { lockToolInputToDataRow, boundValueForStep, firstToken };
