export const VERIFIED_DOM_SOURCE = 'verified_dom_inspection';

export function verifiedActionLocator(expression, {
  strategy = 'role',
  role = null,
  accessibleName = null,
  selector = null,
  context = {},
  pageUrl = 'https://portal.example.test/',
  editable = false,
  domNodeId = null,
} = {}) {
  const nodeId = domNodeId || `node:${role || strategy}:${accessibleName || selector || 'target'}`;
  const documentId = `document:${pageUrl}`;
  const targetIdentity = {
    scheme: 'qaai-dom-node-v1',
    documentId,
    nodeId,
    connected: true,
  };
  return {
    kind: 'playwright',
    strategy,
    role,
    elementLabel: accessibleName,
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: VERIFIED_DOM_SOURCE,
    evidenceSource: VERIFIED_DOM_SOURCE,
    captureBinding: { kind: 'mcp_bound_ref' },
    pageUrl,
    targetFacts: {
      role,
      accessibleName,
      selector,
      backendNodeId: nodeId,
    },
    // Mirror the action-time capture shape used by the runtime: a bound MCP
    // reference is part of the evidence context, not merely a fixture flag.
    context: {
      captureBinding: { kind: 'mcp_bound_ref', ref: `fixture:${nodeId}` },
      ...context,
    },
    proof: {
      verified: true,
      count: 1,
      sameElement: true,
      expectedBackendNodeId: nodeId,
      resolvedBackendNodeId: nodeId,
      visible: true,
      enabled: true,
      editable,
      source: VERIFIED_DOM_SOURCE,
      actionTimeResolved: true,
      actedNodeBound: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity,
      matchedIdentity: { ...targetIdentity },
    },
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: pageUrl,
      verifiedActions: [{
        expression,
        source: VERIFIED_DOM_SOURCE,
        count: 1,
        sameElement: true,
        targetIdentity,
        matchedIdentity: { ...targetIdentity },
        backendNodeId: nodeId,
      }],
    },
  };
}

export function verifiedResolve({
  as,
  expression,
  pageUrl,
  role,
  name,
  strategy = 'role',
  selector = null,
  context = {},
  authoredPageName = null,
  contractStepId = null,
  editable = false,
}) {
  const candidate = strategy === 'css'
    ? { strategy: 'css', selector, expression }
    : strategy === 'testId'
      ? { strategy: 'testId', testId: name, expression }
      : { strategy, role, name, text: name, expression };
  return {
    op: 'resolve',
    as,
    pageUrl,
    elementLabel: name,
    authoredPageName,
    contractStepId,
    candidates: [candidate],
    actionLocator: verifiedActionLocator(expression, {
      strategy,
      role,
      accessibleName: name,
      selector,
      context,
      pageUrl,
      editable,
    }),
  };
}

export function exhaustedSemanticGuess({
  as,
  pageUrl,
  role,
  name,
  contractStepId,
  authoredPageName = null,
}) {
  const expression = `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)}, exact: true })`;
  return {
    op: 'resolve',
    as,
    pageUrl,
    elementLabel: name,
    authoredPageName,
    contractStepId,
    candidates: [{ strategy: 'role', role, name, expression }],
    guessedLocator: true,
    locatorProvenance: {
      kind: 'qaai_guessed_locator',
      source: 'semantic_target_after_deterministic_exhaustion',
      confidence: 'unverified',
      semanticLabel: name,
      chosenExpression: expression.replace(/^page\./, ''),
      strategiesTried: [
        'test_id',
        'role_and_accessible_name',
        'associated_label',
        'placeholder',
        'stable_attributes',
        'scoped_text',
        'deterministic_css',
      ],
      deterministicEvidenceExhausted: true,
      warning: 'Reliable action-time DOM evidence was exhausted; replace this single semantic guess if the intended element differs.',
    },
  };
}

function caseItem(caseId, title, steps, extras = {}) {
  return {
    runResultId: `run-${caseId}`,
    testCaseId: caseId,
    caseName: title,
    ...extras,
    ir: {
      version: 1,
      caseId,
      title,
      authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
      steps,
      verdict: { status: 'pass', perAssertionOutcomes: [] },
      ...(extras.ir || {}),
    },
  };
}

export function precisionAcceptanceCases() {
  const navigationPage = 'https://portal.example.test/work-items?view=active&returnUrl=%2Fhome';
  const repeatedPage = 'https://portal.example.test/contacts';
  const complexPage = 'https://portal.example.test/embedded-editor';
  const fallbackPage = 'https://portal.example.test/preferences';

  const stableDynamicControl = verifiedResolve({
    as: 'saveWorkItemButton',
    expression: 'page.getByTestId("save-work-item")',
    pageUrl: navigationPage,
    role: 'button',
    name: 'save-work-item',
    strategy: 'testId',
    authoredPageName: 'Work items',
    contractStepId: 'work-save',
  });
  stableDynamicControl.candidates.unshift({
    strategy: 'css',
    selector: '#react-control-781346923',
    expression: 'page.locator("#react-control-781346923")',
    unstable: true,
  });

  const navigationAndWait = caseItem('precision-navigation', 'Save a work item', [
    {
      op: 'act',
      action: 'navigate',
      url: navigationPage,
      authored: true,
      contractStepId: 'work-open',
    },
    stableDynamicControl,
    {
      op: 'act',
      action: 'click',
      target: 'saveWorkItemButton',
      authored: true,
      contractStepId: 'work-save',
    },
    {
      op: 'waitFor',
      authored: true,
      contractStepId: 'work-save-wait',
      condition: {
        kind: 'visible',
        target: 'saveWorkItemButton',
        timeoutMs: 17_321,
      },
    },
    {
      op: 'assert',
      authored: true,
      contractStepId: 'work-save-assertion',
      channel: 'UI_ROLE',
      target: 'saveWorkItemButton',
      expected: 'Saved',
      timeoutMs: 17_321,
      flowCritical: true,
    },
  ]);

  const repeatedFields = caseItem('precision-repeated-fields', 'Update two contacts', [
    verifiedResolve({
      as: 'primaryContactInput',
      expression: 'page.locator("form[data-contact=\\"primary\\"]").getByLabel("Contact number", { exact: true })',
      pageUrl: repeatedPage,
      role: 'textbox',
      name: 'Primary contact number',
      context: { formSelector: 'form[data-contact="primary"]' },
      authoredPageName: 'Contacts',
      contractStepId: 'contact-primary',
      editable: true,
    }),
    {
      op: 'act', action: 'fill', target: 'primaryContactInput', authored: true,
      contractStepId: 'contact-primary', valueBinding: { kind: 'literal', value: '111-111-1111' },
    },
    verifiedResolve({
      as: 'secondaryContactInput',
      expression: 'page.locator("form[data-contact=\\"secondary\\"]").getByLabel("Contact number", { exact: true })',
      pageUrl: repeatedPage,
      role: 'textbox',
      name: 'Secondary contact number',
      context: { formSelector: 'form[data-contact="secondary"]' },
      authoredPageName: 'Contacts',
      contractStepId: 'contact-secondary',
      editable: true,
    }),
    {
      op: 'act', action: 'fill', target: 'secondaryContactInput', authored: true,
      contractStepId: 'contact-secondary', valueBinding: { kind: 'literal', value: '222-222-2222' },
    },
  ]);

  const complexContext = caseItem('precision-complex-context', 'Edit an embedded record and open details', [
    verifiedResolve({
      as: 'embeddedReferenceInput',
      expression: 'page.frameLocator("iframe[data-zone=\\"workspace\\"]").locator("record-shell").locator("reference-panel").getByRole("textbox", { name: "Reference", exact: true })',
      pageUrl: complexPage,
      role: 'textbox',
      name: 'Reference',
      context: {
        framePath: ['iframe[data-zone="workspace"]'],
        shadowPath: ['record-shell', 'reference-panel'],
      },
      authoredPageName: 'Embedded editor',
      contractStepId: 'embedded-reference',
      editable: true,
    }),
    {
      op: 'act', action: 'fill', target: 'embeddedReferenceInput', authored: true,
      contractStepId: 'embedded-reference', valueBinding: { kind: 'literal', value: 'REF-42' },
    },
    verifiedResolve({
      as: 'openDetailsButton',
      expression: 'page.getByRole("button", { name: "Open details", exact: true })',
      pageUrl: complexPage,
      role: 'button',
      name: 'Open details',
      authoredPageName: 'Embedded editor',
      contractStepId: 'details-open',
    }),
    {
      op: 'act',
      action: 'click',
      target: 'openDetailsButton',
      authored: true,
      contractStepId: 'details-open',
      eventContract: {
        kind: 'popup',
        eventKind: 'popup',
        armBeforeAction: true,
        timeoutMs: 12_345,
        expected: { urlPattern: '/details' },
      },
      popupIdentity: { pageAlias: 'detailsTab', openerAlias: 'page' },
      contextTransition: { kind: 'popup', authored: true, from: 'page', to: 'detailsTab' },
    },
    verifiedResolve({
      as: 'dismissTourButton',
      expression: 'page.getByRole("button", { name: "Dismiss tour", exact: true })',
      pageUrl: 'https://portal.example.test/details',
      role: 'button',
      name: 'Dismiss tour',
      authoredPageName: 'Details',
      contractStepId: 'tour-dismiss',
    }),
    {
      op: 'act',
      action: 'click',
      target: 'dismissTourButton',
      authored: true,
      optional: true,
      optionalAbsent: 'continue',
      contractStepId: 'tour-dismiss',
    },
  ]);

  const deterministicFallback = verifiedResolve({
    as: 'preferenceAliasInput',
    expression: 'page.locator("form[data-panel=\\"preferences\\"] input[name=\\"alias\\"]")',
    pageUrl: fallbackPage,
    role: 'textbox',
    name: 'Preference alias',
    strategy: 'css',
    selector: 'form[data-panel="preferences"] input[name="alias"]',
    authoredPageName: 'Preferences',
    contractStepId: 'preference-alias',
    editable: true,
  });
  deterministicFallback.locatorProvenance = {
    kind: 'verified_deterministic_css_fallback',
    deterministicEvidenceExhausted: false,
    semanticStrategiesTried: [
      'test_id',
      'role_and_accessible_name',
      'associated_label',
      'placeholder',
      'stable_attributes',
      'scoped_text',
    ],
    selectedStrategy: 'deterministic_css',
  };

  const fallbackAndGuess = caseItem('precision-fallbacks', 'Use deterministic fallback before one final guess', [
    deterministicFallback,
    {
      op: 'act', action: 'fill', target: 'preferenceAliasInput', authored: true,
      contractStepId: 'preference-alias', valueBinding: { kind: 'literal', value: 'North region' },
    },
    exhaustedSemanticGuess({
      as: 'launchReportButton',
      pageUrl: fallbackPage,
      role: 'button',
      name: 'Launch report',
      authoredPageName: 'Preferences',
      contractStepId: 'report-launch',
    }),
    {
      op: 'act', action: 'click', target: 'launchReportButton', authored: true,
      contractStepId: 'report-launch', guessedLocator: true,
    },
  ]);

  return [navigationAndWait, repeatedFields, complexContext, fallbackAndGuess];
}

export function precisionDataCase() {
  const pageUrl = 'https://portal.example.test/profile-data';
  const steps = [
    verifiedResolve({
      as: 'inlineCodeInput',
      expression: 'page.getByLabel("Inline code", { exact: true })',
      pageUrl,
      role: 'textbox',
      name: 'Inline code',
      authoredPageName: 'Profile data',
      contractStepId: 'data-inline',
      editable: true,
    }),
    {
      op: 'act', action: 'fill', target: 'inlineCodeInput', contractStepId: 'data-inline', authored: true,
      valueBinding: { kind: 'literal', value: 'INLINE-42' },
    },
    verifiedResolve({
      as: 'accessTokenInput',
      expression: 'page.getByLabel("Access token", { exact: true })',
      pageUrl,
      role: 'textbox',
      name: 'Access token',
      authoredPageName: 'Profile data',
      contractStepId: 'data-env',
      editable: true,
    }),
    {
      op: 'act', action: 'fill', target: 'accessTokenInput', contractStepId: 'data-env', authored: true,
      rawValue: 'must-never-be-emitted',
      valueBinding: { kind: 'secret_env', envKey: 'QAAI_ACCESS_TOKEN' },
    },
    verifiedResolve({
      as: 'regionInput',
      expression: 'page.getByLabel("Region", { exact: true })',
      pageUrl,
      role: 'textbox',
      name: 'Region',
      authoredPageName: 'Profile data',
      contractStepId: 'data-workbook',
      editable: true,
    }),
    {
      op: 'act', action: 'fill', target: 'regionInput', contractStepId: 'data-workbook', authored: true,
      valueBinding: {
        kind: 'workbook_column',
        column: 'Region',
        proof: { usable: true, caseId: 'precision-data' },
      },
    },
  ];
  return caseItem('precision-data', 'Bind inline environment and workbook data', steps, {
    ir: {
      dataRows: [{ index: 0, label: 'Region row', fields: { Region: 'West' } }],
    },
  });
}

export function continuationAcceptanceCases() {
  const pageUrl = 'https://portal.example.test/workspace';
  const continuation = caseItem('precision-dependency-continuation', 'Continue after a dependency', [
    verifiedResolve({
      as: 'dependencyResultHeading',
      expression: 'page.getByRole("heading", { name: "Dependency result", exact: true })',
      pageUrl,
      role: 'heading',
      name: 'Dependency result',
      authoredPageName: 'Workspace',
      contractStepId: 'dependency-result-visible',
    }),
    {
      op: 'assert',
      authored: true,
      contractStepId: 'dependency-result-visible',
      channel: 'UI_ROLE',
      target: 'dependencyResultHeading',
      expected: 'Dependency result',
      flowCritical: true,
    },
  ], {
    executionMode: 'continue_from_dependency',
    continuationMode: 'continue_from_dependency',
    dependsOn: ['authenticated-session-bootstrap'],
    sameSession: true,
    ir: {
      executionMode: 'continue_from_dependency',
      continuationMode: 'continue_from_dependency',
      sameSession: true,
    },
  });

  const sameSession = caseItem('precision-same-session', 'Continue in the current browser session', [
    verifiedResolve({
      as: 'currentSessionButton',
      expression: 'page.getByRole("button", { name: "Use current session", exact: true })',
      pageUrl,
      role: 'button',
      name: 'Use current session',
      authoredPageName: 'Workspace',
      contractStepId: 'current-session-use',
    }),
    {
      op: 'act',
      action: 'click',
      target: 'currentSessionButton',
      authored: true,
      contractStepId: 'current-session-use',
    },
  ], {
    executionMode: 'same_session',
    sessionMode: 'same_session',
    sameSession: true,
    ir: {
      executionMode: 'same_session',
      sessionMode: 'same_session',
      sameSession: true,
    },
  });

  return [continuation, sameSession];
}

function pageIdentityResolve({ as, title, origin, route, expression, role, name, contractStepId }) {
  const pageUrl = `${origin}${route}`;
  const resolve = verifiedResolve({
    as,
    expression,
    pageUrl,
    role,
    name,
    contractStepId,
  });
  const pageIdentity = {
    source: 'captured_browser_page',
    title,
    origin,
    route,
    url: pageUrl,
  };
  resolve.pageIdentity = pageIdentity;
  resolve.capturedPageTitle = title;
  resolve.capturedRoute = route;
  resolve.capturedOrigin = origin;
  resolve.actionLocator.pageIdentity = pageIdentity;
  resolve.actionLocator.context = {
    ...resolve.actionLocator.context,
    pageTitle: title,
    route,
    origin,
  };
  resolve.actionLocator.domAtlas.title = title;
  return resolve;
}

export function capturedPageIdentityCases() {
  const billing = pageIdentityResolve({
    as: 'billingWorkspaceHeading',
    title: 'Billing workspace',
    origin: 'https://tenant-481.hosting.example.test',
    route: '/workspace/items/981346',
    expression: 'page.getByRole("heading", { name: "Billing workspace", exact: true })',
    role: 'heading',
    name: 'Billing workspace',
    contractStepId: 'billing-visible',
  });
  const support = pageIdentityResolve({
    as: 'supportWorkspaceHeading',
    title: 'Support workspace',
    origin: 'https://tenant-927.hosting.example.test',
    route: '/workspace/items/742905',
    expression: 'page.getByRole("heading", { name: "Support workspace", exact: true })',
    role: 'heading',
    name: 'Support workspace',
    contractStepId: 'support-visible',
  });
  return [
    caseItem('precision-captured-billing-page', 'Recognize the captured billing page', [
      billing,
      {
        op: 'assert', authored: true, contractStepId: 'billing-visible', channel: 'UI_ROLE',
        target: 'billingWorkspaceHeading', expected: 'Billing workspace', flowCritical: true,
      },
    ]),
    caseItem('precision-captured-support-page', 'Recognize the captured support page', [
      support,
      {
        op: 'assert', authored: true, contractStepId: 'support-visible', channel: 'UI_ROLE',
        target: 'supportWorkspaceHeading', expected: 'Support workspace', flowCritical: true,
      },
    ]),
  ];
}

function requiredRuntimeUnit({ contractStepId, target, label, expression }) {
  return [
    verifiedResolve({
      as: target,
      expression,
      pageUrl: 'https://portal.example.test/reconciliation',
      role: 'button',
      name: label,
      authoredPageName: 'Reconciliation',
      contractStepId,
    }),
    {
      op: 'act',
      action: 'click',
      target,
      elementLabel: label,
      contractStepId,
      sourceContractStepId: contractStepId,
      authored: false,
      observedOnly: true,
      required: true,
      optional: false,
      ok: true,
      runtimeEvidence: true,
    },
  ];
}

function partialReplayResult({ id, title, currentSteps, authoredSteps }) {
  return {
    runResultId: `run-${id}`,
    testCaseId: id,
    caseName: title,
    status: 'pass',
    executionContract: {
      version: 1,
      nodes: authoredSteps.map((step, index) => ({
        contractStepId: step.id,
        stepOrdinal: index + 1,
        kind: 'action',
        actionType: step.action,
        plannedText: `${step.action} ${step.target}`,
        raw: { target: step.target },
      })),
    },
    declaredSteps: authoredSteps.map((step) => ({
      id: step.id,
      contractStepId: step.id,
      action: step.action,
      target: step.target,
    })),
    envelope: {
      complete: false,
      ir: {
        version: 1,
        caseId: id,
        title,
        authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
        steps: currentSteps,
        verdict: { status: 'pass', perAssertionOutcomes: [] },
      },
      findings: [],
      gaps: [],
    },
  };
}

export function runtimeActionReconciliationFixtures() {
  const unmatched = partialReplayResult({
    id: 'precision-unmatched-required-runtime',
    title: 'Retain an unmatched successful required runtime action',
    currentSteps: requiredRuntimeUnit({
      contractStepId: 'runtime-refresh-records',
      target: 'runtimeRefreshRecordsButton',
      label: 'Refresh records',
      expression: 'page.getByRole("button", { name: "Refresh records", exact: true })',
    }),
    authoredSteps: [{ id: 'authored-open-summary', action: 'click', target: 'Open summary' }],
  });

  const matched = partialReplayResult({
    id: 'precision-matched-runtime',
    title: 'Use matched runtime evidence exactly once',
    currentSteps: requiredRuntimeUnit({
      contractStepId: 'authored-refresh-records',
      target: 'refreshRecordsButton',
      label: 'Refresh records',
      expression: 'page.getByRole("button", { name: "Refresh records", exact: true })',
    }),
    authoredSteps: [{ id: 'authored-refresh-records', action: 'click', target: 'Refresh records' }],
  });

  const ambiguous = partialReplayResult({
    id: 'precision-ambiguous-runtime',
    title: 'Do not cross-attach ambiguous runtime evidence',
    currentSteps: requiredRuntimeUnit({
      contractStepId: 'runtime-approve-request',
      target: 'runtimeApproveRequestButton',
      label: 'Approve request',
      expression: 'page.getByRole("button", { name: "Approve request", exact: true })',
    }),
    authoredSteps: [
      { id: 'authored-approve-primary', action: 'click', target: 'Approve request' },
      { id: 'authored-approve-secondary', action: 'click', target: 'Approve request' },
    ],
  });

  return { unmatched, matched, ambiguous };
}

export function normalizationParityResult() {
  const resolve = verifiedResolve({
    as: 'readyStatus',
    expression: 'page.getByRole("status", { name: "Ready", exact: true })',
    pageUrl: 'https://portal.example.test/normalization',
    role: 'status',
    name: 'Ready',
    authoredPageName: 'Normalization',
    contractStepId: 'wait-ready',
  });
  return {
    runResultId: 'run-precision-normalization-parity',
    testCaseId: 'precision-normalization-parity',
    caseName: 'Preserve authored waits and assertions during normalization',
    status: 'pass',
    executionContract: {
      version: 1,
      nodes: [
        {
          contractStepId: 'wait-ready',
          stepOrdinal: 1,
          kind: 'action',
          actionType: 'wait',
          plannedText: 'Wait for Ready',
          raw: { target: 'Ready' },
        },
        {
          contractStepId: 'assert-ready',
          stepOrdinal: 2,
          kind: 'assertion',
          assertionType: 'UI_TEXT',
          expected: 'Ready',
          raw: { target: 'Ready', expected: 'Ready' },
        },
      ],
    },
    declaredSteps: [{
      id: 'wait-ready',
      contractStepId: 'wait-ready',
      action: 'wait',
      target: 'Ready',
      condition: { kind: 'visible', target: 'readyStatus', timeoutMs: 23_456 },
      timeoutMs: 23_456,
      recovery: { policy: 'fail', attempts: 1 },
    }],
    declaredAssertionsRaw: JSON.stringify([{
      id: 'assert-ready',
      type: 'UI_TEXT',
      payload: {
        target: 'readyStatus',
        expectedText: 'Ready',
        timeoutMs: 23_456,
        flowCritical: true,
      },
    }]),
    envelope: {
      complete: false,
      ir: {
        version: 1,
        caseId: 'precision-normalization-parity',
        title: 'Preserve authored waits and assertions during normalization',
        authProfile: { id: 'default', strategy: 'none', disposition: 'bypass_fixture' },
        steps: [
          resolve,
          {
            op: 'waitFor',
            contractStepId: 'wait-ready',
            authored: true,
            origin: 'runtime_evidence',
            canonicalExecution: true,
            status: 'passed',
            condition: { kind: 'visible', target: 'readyStatus', timeoutMs: 23_456 },
            timeoutMs: 23_456,
          },
          {
            op: 'assert',
            contractStepId: 'assert-ready',
            contractRef: 'assert-ready',
            assertionId: 'assert-ready',
            authored: true,
            origin: 'runtime_evidence',
            canonicalExecution: true,
            status: 'passed',
            checked: true,
            matched: true,
            target: 'readyStatus',
            expected: 'Ready',
            actual: 'Ready',
            flowCritical: true,
          },
        ],
        verdict: {
          status: 'pass',
          perAssertionOutcomes: [
            {
              assertionId: 'assert-ready',
              contractStepId: 'assert-ready',
              checked: true,
              matched: true,
              status: 'passed',
              expected: 'Ready',
              actual: 'Ready',
            },
          ],
        },
      },
      findings: [],
      gaps: [],
    },
  };
}
