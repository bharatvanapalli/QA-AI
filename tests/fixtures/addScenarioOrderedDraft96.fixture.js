export const SENSITIVE_SENTINEL = 'Phase1-Sensitive-Sentinel-Do-Not-Persist!';
export const SENSITIVE_REFERENCE = 'secret:phase1.access-token';

export const NORMAL_LITERAL_EXPECTATIONS = Object.freeze({
  title: 'Service Request 042',
  requesterEmail: 'qa.user+phase1@example.test',
  accountCode: '001207',
  comments: 'Priority: medium; retain commas, + signs, and 001 zeros.',
  phone: '+1-555-0102',
});

function pad(value) {
  return String(value).padStart(3, '0');
}

function target(name, role, kind = 'control', context = 'Service Request Workspace') {
  return { kind, role, name, context };
}

function clone(value) {
  return structuredClone(value);
}

const DEFAULT_ASSERTION_COMPARATOR = Object.freeze({
  AssertChecked: 'checked',
  AssertCollection: 'collection_exact',
  AssertDate: 'equals',
  AssertHidden: 'hidden',
  AssertNumber: 'equals',
  AssertPage: 'equals',
  AssertSelected: 'equals',
  AssertText: 'equals',
  AssertTime: 'equals',
  AssertValue: 'equals',
  AssertVisible: 'visible',
});

/**
 * Builds an independently sourced, website-neutral ordered-draft fixture.
 * The first 96 operations are the Phase 1 acceptance corpus. Four additional
 * operations exercise the exact 100 boundary; a fifth exercises rejection.
 */
export function buildOrderedDraftFixture(operationCount = 96) {
  if (!Number.isInteger(operationCount) || operationCount < 96 || operationCount > 101) {
    throw new RangeError('operationCount must be an integer from 96 through 101.');
  }

  const operations = [];
  const sourceClauses = [];

  const append = ({ kind, type, targetIdentity, sourceText, ...semantics }) => {
    const ordinal = operations.length + 1;
    const ref = `operation-${pad(ordinal)}`;
    const sourceRef = `source.clause.${pad(ordinal)}`;
    const operation = {
      ref,
      ordinal: ordinal * 10,
      kind,
      type,
      text: sourceText,
      target: clone(targetIdentity),
      required: semantics.required !== false,
      condition: semantics.condition === undefined ? null : clone(semantics.condition),
      failureBehavior: clone(semantics.failureBehavior || 'block_dependents'),
      dependencies: ordinal === 1 ? [] : [`operation-${pad(ordinal - 1)}`],
      sourceRefs: [sourceRef],
    };
    if (kind === 'action' && Object.prototype.hasOwnProperty.call(semantics, 'value')) {
      operation.value = clone(semantics.value);
    }
    if (kind === 'action' && Object.prototype.hasOwnProperty.call(semantics, 'valueRef')) {
      operation.valueRef = semantics.valueRef;
    }
    if (kind === 'action' && Object.prototype.hasOwnProperty.call(semantics, 'selection')) {
      operation.selection = clone(semantics.selection);
    }
    if (kind === 'assertion') {
      if (Object.prototype.hasOwnProperty.call(semantics, 'expected')) {
        operation.expected = clone(semantics.expected);
      }
      if (Object.prototype.hasOwnProperty.call(semantics, 'expectedRef')) {
        operation.expectedRef = semantics.expectedRef;
      }
      operation.comparator = clone(
        semantics.comparator || DEFAULT_ASSERTION_COMPARATOR[type],
      );
    }
    operations.push(operation);
    sourceClauses.push({
      ref: sourceRef,
      disposition: kind,
      sourceQuote: sourceText,
      sensitive: semantics.sensitive === true,
    });
    return operation;
  };

  const action = (type, targetIdentity, sourceText, semantics = {}) => append({
    kind: 'action', type, targetIdentity, sourceText, ...semantics,
  });
  const assertion = (type, targetIdentity, expected, sourceText, semantics = {}) => {
    const payload = {
      kind: 'assertion', type, targetIdentity, sourceText, ...semantics,
    };
    if (expected !== undefined) payload.expected = expected;
    return append(payload);
  };

  const workspaceUrl = 'https://qa.example.test/requests/new';
  const page = target('Service Request page', 'document', 'page');
  const form = target('New Service Request form', 'form', 'region');
  const title = target('Request Title', 'textbox', 'field');

  action('Navigate', workspaceUrl, `Navigate to ${workspaceUrl}.`, { value: workspaceUrl });
  assertion('AssertPage', page, workspaceUrl, 'Verify the Service Request page URL is the authored request URL.');
  action('WaitForState', page, 'Wait for the Service Request page to become ready.');
  assertion('AssertVisible', target('Service Requests heading', 'heading', 'region'), true, 'Verify the Service Requests heading is visible.');
  action('Click', target('New Request', 'button'), 'Click New Request.');
  action('WaitForState', form, 'Wait for the New Service Request form to become ready.');
  assertion('AssertVisible', form, true, 'Verify the New Service Request form is visible.');
  action('Clear', title, 'Clear the Request Title field.');
  action('Fill', title, `Enter ${NORMAL_LITERAL_EXPECTATIONS.title} in the Request Title field.`, { value: NORMAL_LITERAL_EXPECTATIONS.title });
  assertion('AssertValue', title, NORMAL_LITERAL_EXPECTATIONS.title, `Verify Request Title equals ${NORMAL_LITERAL_EXPECTATIONS.title}.`);
  action('Click', target('Details tab', 'tab'), 'Click the Details tab.');
  action('Scroll', target('Details section', 'region', 'region'), 'Scroll the Details section into view.');

  const priority = target('Priority', 'combobox', 'field');
  action('Select', priority, 'Select High from the Priority dropdown.', { selection: { kind: 'exact_text', text: 'High' } });
  assertion('AssertSelected', priority, 'High', 'Verify High is selected in the Priority dropdown.');
  const status = target('Status', 'combobox', 'field');
  action('Click', status, 'Open the Status dropdown.');
  assertion('AssertCollection', target('Status options', 'listbox', 'collection'), ['Draft', 'Pending', 'Closed'], 'Verify the Status options are Draft, Pending, and Closed in that order.', { comparator: 'collection_exact_order' });
  action('Select', status, 'Select Draft from the Status dropdown.', { selection: { kind: 'exact_text', text: 'Draft' } });
  assertion('AssertValue', status, 'Draft', 'Verify the Status field equals Draft.');
  const team = target('Assigned Team', 'combobox', 'field');
  action('Select', team, 'Select the second option, Support East, from Assigned Team.', { selection: { kind: 'ordinal', ordinal: 2 } });
  assertion('AssertSelected', team, 'Support East', 'Verify Support East is selected in Assigned Team.');
  const category = target('Category', 'combobox', 'field');
  action('Select', category, 'Select an option whose visible label contains General from Category.', { selection: { kind: 'predicate', predicate: 'visible label contains General' } });
  assertion('AssertText', category, 'General', 'Verify the selected Category contains General.', { comparator: 'contains' });
  const locale = target('Locale', 'combobox', 'field');
  action('Click', locale, 'Open the Locale dropdown.');
  action('Select', locale, 'Select English from the Locale dropdown.', { selection: { kind: 'exact_text', text: 'English' } });
  assertion('AssertSelected', locale, 'English', 'Verify English is selected in Locale.');
  action('WaitForState', target('Locale options', 'listbox', 'collection'), 'Wait for the Locale options to close.', { value: { state: 'hidden' } });
  action('Scroll', target('Assignment section', 'region', 'region'), 'Scroll the Assignment section into view.');
  assertion('AssertVisible', target('Assignment section', 'region', 'region'), true, 'Verify the Assignment section is visible.');

  const email = target('Requester Email', 'textbox', 'field');
  action('Fill', email, `Enter ${NORMAL_LITERAL_EXPECTATIONS.requesterEmail} in Requester Email.`, { value: NORMAL_LITERAL_EXPECTATIONS.requesterEmail });
  assertion('AssertValue', email, NORMAL_LITERAL_EXPECTATIONS.requesterEmail, `Verify Requester Email equals ${NORMAL_LITERAL_EXPECTATIONS.requesterEmail}.`);
  const accountCode = target('Account Code', 'textbox', 'field');
  action('Fill', accountCode, `Enter ${NORMAL_LITERAL_EXPECTATIONS.accountCode} in Account Code.`, { value: NORMAL_LITERAL_EXPECTATIONS.accountCode });
  assertion('AssertValue', accountCode, NORMAL_LITERAL_EXPECTATIONS.accountCode, `Verify Account Code equals ${NORMAL_LITERAL_EXPECTATIONS.accountCode}.`);
  const accessToken = target('Access Token', 'textbox', 'field');
  action('Fill', accessToken, `Enter ${SENSITIVE_SENTINEL} in Access Token.`, {
    valueRef: SENSITIVE_REFERENCE,
    sensitive: true,
  });
  assertion('AssertValue', accessToken, undefined, 'Verify Access Token resolves to the approved protected reference without exposing it.', {
    expectedRef: SENSITIVE_REFERENCE,
    comparator: 'equals',
    sensitive: true,
  });
  const comments = target('Comments', 'textbox', 'field');
  action('Type', comments, `Type "${NORMAL_LITERAL_EXPECTATIONS.comments}" in Comments.`, { value: NORMAL_LITERAL_EXPECTATIONS.comments });
  assertion('AssertText', comments, 'retain commas, + signs, and 001 zeros', 'Verify Comments contains retain commas, + signs, and 001 zeros.', { comparator: 'contains' });
  const attachment = target('Attachment', 'file_input', 'field');
  action('Upload', attachment, 'Upload the approved sample-request.pdf fixture.', { valueRef: 'fixture:sample-request.pdf' });
  assertion('AssertValue', attachment, 'sample-request.pdf', 'Verify Attachment displays sample-request.pdf.');
  const urgent = target('Urgent', 'checkbox', 'field');
  action('Check', urgent, 'Check Urgent.');
  assertion('AssertChecked', urgent, true, 'Verify Urgent is checked.');
  const notification = target('Email notification', 'radio', 'field');
  action('Radio', notification, 'Select Email notification.');
  assertion('AssertSelected', notification, true, 'Verify Email notification is selected.');
  const phone = target('Contact Phone', 'textbox', 'field');
  action('Fill', phone, `Enter ${NORMAL_LITERAL_EXPECTATIONS.phone} in Contact Phone.`, { value: NORMAL_LITERAL_EXPECTATIONS.phone });
  assertion('AssertValue', phone, NORMAL_LITERAL_EXPECTATIONS.phone, `Verify Contact Phone equals ${NORMAL_LITERAL_EXPECTATIONS.phone}.`);

  const schedule = target('Scheduling section', 'region', 'region');
  action('Scroll', schedule, 'Scroll the Scheduling section into view.');
  assertion('AssertVisible', schedule, true, 'Verify the Scheduling section is visible.');
  const advanced = target('Advanced Scheduling section', 'region', 'region');
  action('Expand', advanced, 'If Advanced Scheduling is collapsed, expand it.', {
    condition: { kind: 'target_state', comparator: 'equals', operands: [{ property: 'expanded' }, { value: false }] },
  });
  assertion('AssertVisible', advanced, true, 'Verify Advanced Scheduling is visible.');
  const startDate = target('Start Date', 'textbox', 'field');
  action('Click', startDate, 'Open the Start Date calendar.');
  action('Date', startDate, 'Select August 20, 2026 in the Start Date calendar.', { value: '2026-08-20' });
  assertion('AssertDate', startDate, '2026-08-20', 'Verify Start Date equals August 20, 2026.');
  const startTime = target('Start Time', 'combobox', 'field');
  action('Click', startTime, 'Open the Start Time dropdown.');
  action('Select', startTime, 'Select 09:00 AM from the Start Time dropdown.', { selection: { kind: 'exact_text', text: '09:00 AM' } });
  assertion('AssertTime', startTime, '09:00', 'Verify Start Time equals 09:00 AM.');
  const dueDate = target('Due Date', 'textbox', 'field');
  action('Click', dueDate, 'Open the Due Date calendar.');
  action('Date', dueDate, 'Select August 21, 2026 in the Due Date calendar.', { value: '2026-08-21' });
  assertion('AssertDate', dueDate, '2026-08-21', 'Verify Due Date equals August 21, 2026.');
  const dueTime = target('Due Time', 'combobox', 'field');
  action('Click', dueTime, 'Open the Due Time dropdown.');
  action('Select', dueTime, 'Select 05:30 PM from the Due Time dropdown.', { selection: { kind: 'exact_text', text: '05:30 PM' } });
  assertion('AssertTime', dueTime, '17:30', 'Verify Due Time equals 05:30 PM.');
  action('Collapse', advanced, 'If Advanced Scheduling is expanded, collapse it.', {
    condition: { kind: 'target_state', comparator: 'equals', operands: [{ property: 'expanded' }, { value: true }] },
  });
  assertion('AssertHidden', target('Advanced Scheduling body', 'region', 'region'), false, 'Verify the Advanced Scheduling body is hidden.');
  action('Scroll', target('Request form top', 'viewport', 'viewport'), 'Scroll to the top of the request form.');
  assertion('AssertVisible', target('Request summary badge', 'status', 'region'), true, 'Verify the Request summary badge is visible.');

  const itemCodes = [];
  for (let row = 1; row <= 4; row += 1) {
    const code = `ITEM-${pad(row)}`;
    const quantity = row;
    itemCodes.push(code);
    const rowScope = `Line item ${row}`;
    action('Click', target('Add Item', 'button', 'control', rowScope), `Click Add Item for line item ${row}.`);
    const codeField = target('Item Code', 'textbox', 'field', rowScope);
    action('Fill', codeField, `Enter ${code} in Item Code for line item ${row}.`, { value: code });
    const quantityField = target('Quantity', 'spinbutton', 'field', rowScope);
    action('Fill', quantityField, `Enter ${quantity} in Quantity for line item ${row}.`, { value: quantity });
    const unitField = target('Unit', 'combobox', 'field', rowScope);
    action('Select', unitField, `Select Each from Unit for line item ${row}.`, { selection: { kind: 'exact_text', text: 'Each' } });
    assertion('AssertValue', codeField, code, `Verify Item Code for line item ${row} equals ${code}.`);
    assertion('AssertNumber', quantityField, quantity, `Verify Quantity for line item ${row} equals ${quantity}.`);
  }

  action('Scroll', target('Review section', 'region', 'region'), 'Scroll the Review section into view.');
  assertion('AssertCollection', target('Line item summary', 'list', 'collection'), itemCodes, 'Verify the Review summary lists ITEM-001, ITEM-002, ITEM-003, and ITEM-004 in order.', { comparator: 'collection_exact_order' });
  const acknowledgement = target('Information is accurate', 'checkbox', 'field');
  action('Check', acknowledgement, 'Check Information is accurate.');
  assertion('AssertChecked', acknowledgement, true, 'Verify Information is accurate is checked.');
  action('Click', target('Save Draft', 'button'), 'Click Save Draft.');
  action('WaitForState', target('Draft saved notification', 'status', 'region'), 'Wait for the Draft saved notification to become visible.');
  assertion('AssertVisible', target('Draft saved notification', 'status', 'region'), true, 'Verify the Draft saved notification is visible.');
  assertion('AssertText', target('Request identifier', 'status', 'region'), 'REQ-', 'Verify the Request identifier contains REQ-.', { comparator: 'contains' });

  const tail = [
    () => action('Hover', target('Help', 'button'), 'Hover over Help.'),
    () => assertion('AssertVisible', target('Help tooltip', 'tooltip', 'region'), true, 'Verify the Help tooltip is visible.'),
    () => action('Screenshot', target('Review snapshot', 'viewport', 'viewport'), 'Capture the Review snapshot.'),
    () => assertion('AssertText', target('Audit marker', 'status', 'region'), 'Draft', 'Verify the Audit marker contains Draft.', { comparator: 'contains' }),
    () => action('Click', target('Close preview', 'button'), 'Click Close preview.'),
  ];
  while (operations.length < operationCount) tail[operations.length - 96]();

  let sourceCursor = 0;
  const rawSource = sourceClauses.map((clause) => clause.sourceQuote).join('\n');
  const exactSourceClauses = sourceClauses.map((clause, index) => {
    const start = sourceCursor;
    const end = start + clause.sourceQuote.length;
    sourceCursor = end + 1;
    return {
      ...clause,
      ordinal: (index + 1) * 10,
      sourceSpan: { start, end },
    };
  });
  const input = {
    version: 'AddScenarioOrderedDraftV1',
    sourceText: rawSource,
    sourceClauses: exactSourceClauses,
    cases: [{
      ref: 'case-service-request',
      ordinal: 90,
      name: 'Website-neutral service request with ordered validations',
      intent: 'Complete one service request draft while preserving every authored validation in order.',
      initialState: { page: 'Service Request Workspace', authentication: 'available' },
      expectedFinalState: { requestState: 'Draft saved', identifierPrefix: 'REQ-' },
      sessionIntent: { mode: 'fresh' },
      parentCaseRef: null,
      operations,
    }],
  };
  const signatures = operations.map((operation) => `${operation.kind}:${operation.type}`);

  return {
    input,
    operations,
    signatures,
    sourceClauses: exactSourceClauses,
    rawSource,
    sensitiveReference: clone(SENSITIVE_REFERENCE),
    options: { sensitiveValues: [SENSITIVE_SENTINEL] },
  };
}
