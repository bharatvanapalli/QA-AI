'use strict';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Website-neutral adapter contract fixture. It exercises the frozen ReplayIR
 * vocabulary without encoding a particular application, route, or page role.
 */
const neutralReplayIR = deepFreeze({
  version: 1,
  caseId: 'CONTRACT_CASE',
  authProfile: {
    id: 'contract-profile',
    strategy: 'bypass_fixture',
    storageStateRef: 'auth/contract-profile.storageState.json',
  },
  bindings: [
    {
      name: 'authoredInput',
      kind: 'workbook_column',
      valueType: 'string',
      column: 'authoredInput',
      source: 'case_scoped_data_rows',
      proof: {
        usable: true,
        caseId: 'CONTRACT_CASE',
      },
    },
  ],
  dataRow: {
    index: 0,
    caseScopeId: 'CONTRACT_CASE',
    label: 'Row 1 - primary contract data',
    fields: {
      authoredInput: 'primary-contract-value',
    },
    sensitivity: {
      authoredInput: 'synthetic',
    },
  },
  dataRows: [
    {
      index: 0,
      caseScopeId: 'CONTRACT_CASE',
      label: 'Row 1 - primary contract data',
      fields: {
        authoredInput: 'primary-contract-value',
      },
      sensitivity: {
        authoredInput: 'synthetic',
      },
    },
    {
      index: 1,
      caseScopeId: 'CONTRACT_CASE',
      label: 'Row 2 - alternate contract data',
      fields: {
        authoredInput: 'alternate-contract-value',
      },
      sensitivity: {
        authoredInput: 'synthetic',
      },
    },
  ],
  contextTransitions: [
    {
      kind: 'popup_observed',
      authored: false,
      observed: true,
      pageAlias: 'secondaryPage',
    },
  ],
  steps: [
    {
      id: 'STEP_HANDLE_OVERLAY',
      op: 'handlePopup',
      authored: true,
      known: [
        {
          strategy: 'css',
          selector: '[data-qa="dismiss-overlay"]',
          verificationStatus: 'verified',
          verificationSource: 'runtime_dom',
        },
      ],
    },
    {
      id: 'STEP_RESOLVE_INPUT',
      op: 'resolve',
      as: 'authoredInputField',
      authored: true,
      candidates: [
        {
          strategy: 'css',
          selector: '[data-qa="contract-input"]',
          verificationStatus: 'verified',
          verificationSource: 'runtime_dom',
          unique: true,
          actionable: true,
        },
      ],
      actionLocator: {
        strategy: 'css-attr',
        expression: 'locator("[data-qa=\\"contract-input\\"]")',
        frameworkExpressions: {
          playwright: 'locator("[data-qa=\\"contract-input\\"]")',
        },
        verified: true,
        verificationSource: 'verified_dom_inspection',
        proof: {
          source: 'verified_dom_inspection',
          verified: true,
          count: 1,
          sameElement: true,
          visible: true,
          enabled: true,
        },
        domAtlas: {
          verifiedActions: [
            {
              contractStepId: 'STEP_RESOLVE_INPUT',
              action: 'fill',
              expression: 'locator("[data-qa=\\"contract-input\\"]")',
            },
          ],
        },
      },
    },
    {
      id: 'STEP_FILL_INPUT',
      op: 'act',
      target: 'authoredInputField',
      action: 'fill',
      dataRole: 'authoredInput',
      valueBinding: {
        kind: 'workbook_column',
        column: 'authoredInput',
        proof: {
          usable: true,
          caseId: 'CONTRACT_CASE',
        },
      },
      authored: true,
    },
    {
      id: 'STEP_WAIT_FOR_INPUT',
      op: 'waitFor',
      condition: {
        kind: 'visible',
        target: 'authoredInputField',
        timeoutMs: 5000,
      },
      authored: true,
    },
    {
      id: 'STEP_ASSERT_STATE',
      op: 'assert',
      contractRef: 'ASSERT_CONTRACT_STATE',
      channel: 'UI_TEXT',
      target: 'authoredInputField',
      expected: 'editable',
      authored: true,
      evidence: {
        source: 'runtime_dom',
        status: 'verified',
      },
    },
    {
      id: 'STEP_READ_TEST_HOOK',
      op: 'humanInput',
      field: 'contractNote',
      disposition: 'test_hook',
      valueRef: 'env:QAAI_CONTRACT_NOTE',
      authored: true,
    },
  ],
  verdict: {
    status: 'pass',
    perAssertionOutcomes: [
      {
        contractRef: 'ASSERT_CONTRACT_STATE',
        status: 'pass',
      },
    ],
  },
});

const cases = deepFreeze([
  {
    id: 'playwright-reference-neutral-contract',
    adapterId: 'playwright-reference',
    replayIR: neutralReplayIR,
    compileOptions: {
      dependsOn: ['CONTRACT_PREREQUISITE'],
    },
    expectedFragments: [
      'resolveLocator',
      'readData(row, "authoredInput")',
      'primary-contract-value',
      'alternate-contract-value',
      'page.locator("[data-qa=\\"contract-input\\"]")',
      'Row 1 - primary contract data',
      'Row 2 - alternate contract data',
    ],
  },
  {
    id: 'selenium-reference-neutral-contract',
    adapterId: 'selenium-reference',
    replayIR: neutralReplayIR,
    expectedFragments: [
      'LocatorCandidate.css',
      'primary-contract-value',
      'alternate-contract-value',
      '[data-qa="contract-input"]',
    ],
  },
]);

function forAdapter(adapterId) {
  return cases.filter((entry) => entry.adapterId === adapterId);
}

module.exports = { cases, forAdapter, neutralReplayIR };
