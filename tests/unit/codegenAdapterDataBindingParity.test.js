import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwrightPom = require('../../server/services/codegen/adapters/playwrightPom');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference');
const seleniumReference = require('../../server/services/codegen/adapters/seleniumReference');
const seleniumPom = require('../../server/services/codegen/adapters/seleniumPom');

const row = (fields, label = 'Case row') => ({ index: 0, label, fields });

function verifiedUserCountLocator() {
  const pageUrl = 'https://example.test/users';
  const backendNodeId = 'controlled:user-count';
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'controlled-document:users',
    nodeId: backendNodeId,
    connected: true,
  };
  const expression = 'page.getByRole("textbox", { name: "User count", exact: true })';
  return {
    kind: 'playwright',
    expression,
    frameworkExpressions: { playwright: expression },
    verified: true,
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    pageUrl,
    captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId },
    context: { captureBinding: { kind: 'mcp_bound_ref', ref: backendNodeId } },
    targetFacts: { role: 'textbox', accessibleName: 'User count', backendNodeId },
    proof: {
      verified: true,
      count: 1,
      sameElement: true,
      visible: true,
      enabled: true,
      editable: true,
      source: 'verified_dom_inspection',
      actionTimeResolved: true,
      actedNodeBound: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      expectedBackendNodeId: backendNodeId,
      resolvedBackendNodeId: backendNodeId,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    domAtlas: {
      schemaVersion: 'qaai-dom-atlas-v1',
      url: pageUrl,
      verifiedActions: [{
        expression,
        source: 'verified_dom_inspection',
        count: 1,
        sameElement: true,
        backendNodeId,
        targetIdentity: identity,
        matchedIdentity: { ...identity },
      }],
    },
  };
}

function fillStep(overrides = {}) {
  return {
    op: 'act',
    action: 'fill',
    target: 'userCount',
    dataRole: 'userCount',
    rawValue: '66',
    ...overrides,
  };
}

function pomCase({ caseId, title, rawValue = '66', dataRows, dependsOn } = {}) {
  return {
    testCaseId: caseId,
    caseName: title,
    ...(dependsOn ? { dependsOn } : {}),
    ir: {
      caseId,
      title,
      ...(dataRows ? { dataRows } : {}),
      steps: [
        {
          op: 'resolve',
          as: 'userCount',
          candidates: [{ strategy: 'role', role: 'textbox', name: 'User count' }],
          actionLocator: verifiedUserCountLocator(),
        },
        fillStep({
          rawValue,
          ...(dataRows ? {
            valueBinding: {
              kind: 'workbook_column',
              column: 'userCount',
              proof: { usable: true, caseId },
            },
          } : {}),
        }),
      ],
    },
  };
}

describe('framework adapter data-binding parity', () => {
  it('keeps safe inline values literal and never fabricates a Playwright POM data row', () => {
    const emitted = playwrightPom.emitJourneySpec([
      pomCase({ caseId: 'tc-inline', title: 'Update user count', rawValue: '66' }),
    ], { scenarioName: 'Inline values', lang: 'ts' });

    expect(emitted.content).toContain('("66")');
    expect(emitted.content).not.toContain('readData(row');
    expect(Object.keys(emitted.extraFiles).some((name) => name.startsWith('tests/data/'))).toBe(false);
    expect(JSON.stringify(emitted.extraFiles)).not.toContain('Recorded data');
  });

  it('uses a Playwright POM row only for a key exported by that exact case', () => {
    const mapped = playwrightPom.emitJourneySpec([
      pomCase({ caseId: 'tc-mapped', title: 'Mapped user count', dataRows: [row({ userCount: '66' })] }),
    ], { scenarioName: 'Mapped values', lang: 'ts' });
    expect(mapped.content).toContain('readData(row, "userCount")');
    expect(Object.keys(mapped.extraFiles).some((name) => name.startsWith('tests/data/'))).toBe(true);

    const wrongKey = playwrightPom.emitJourneySpec([
      pomCase({ caseId: 'tc-wrong-key', title: 'Unmapped user count', dataRows: [row({ activeCount: '63' })] }),
    ], { scenarioName: 'Unmapped values', lang: 'ts' });
    expect(wrongKey.content).toContain('"66"');
    expect(wrongKey.content).toContain('workbook_column lacks case-scoped usable-row proof');
    expect(wrongKey.content).not.toContain('readData(row, "userCount")');
  });

  it('keeps unverified semantic locator candidates diagnostic and non-executable', () => {
    const emitted = playwrightPom.emitJourneySpec([{
      testCaseId: 'tc-unverified',
      caseName: 'Unverified target',
      ir: {
        caseId: 'tc-unverified',
        title: 'Unverified target',
        steps: [
          {
            op: 'resolve',
            as: 'userCount',
            candidates: [{ strategy: 'role', role: 'textbox', name: 'User count' }],
          },
          fillStep(),
        ],
      },
    }], { scenarioName: 'Unverified target', lang: 'ts' });
    const source = [emitted.content, ...Object.values(emitted.extraFiles)].join('\n');
    expect(source).not.toContain('QAAI_UNVERIFIED_LOCATOR');
    expect(source).not.toContain('getByRole("textbox", { name: "User count"');
    expect(source).not.toContain('.fill("66")');
    expect(source).not.toContain('fillUserCount(');
  });

  it('does not lend a prior sibling case data row to an unrelated assertion-only case', () => {
    const setup = pomCase({
      caseId: 'tc-setup',
      title: 'Create user',
      rawValue: 'Alice',
      dataRows: [row({ userCount: 'Alice' })],
    });
    const verify = {
      testCaseId: 'tc-verify',
      caseName: 'Verify dashboard',
      ir: {
        caseId: 'tc-verify',
        title: 'Verify dashboard',
        steps: [{ op: 'assert', channel: 'PAGE', expected: 'Dashboard' }],
      },
    };

    const emitted = playwrightPom.emitJourneySpec([setup, verify], { scenarioName: 'Independent cases', lang: 'ts' });
    const dataFiles = Object.keys(emitted.extraFiles).filter((name) => name.startsWith('tests/data/'));
    expect(dataFiles).toHaveLength(1);
    expect(dataFiles[0]).toContain('create-user');
  });

  it('applies the same literal, provider-key, and environment precedence in Playwright reference', () => {
    const inlineOpts = {};
    playwrightReference.emitDataProvider([], {}, inlineOpts);
    expect(playwrightReference.emitStep(fillStep(), {}, inlineOpts)).toContain('.fill("66")');

    const mappedOpts = { dataCaseSlug: 'mapped' };
    playwrightReference.emitDataProvider([row({ userCount: '66' })], {}, mappedOpts);
    expect(playwrightReference.emitStep(fillStep(), {}, mappedOpts)).toContain('readData(row, "userCount")');

    const wrongKeyOpts = { dataCaseSlug: 'wrong-key' };
    playwrightReference.emitDataProvider([row({ activeCount: '63' })], {}, wrongKeyOpts);
    expect(playwrightReference.emitStep(fillStep(), {}, wrongKeyOpts)).toContain('.fill("66")');

    const secretStep = fillStep({ valueRef: 'env:QAAI_USER_COUNT', rawValue: 'do-not-inline' });
    expect(playwrightReference.emitStep(secretStep, {}, mappedOpts)).toContain('readEnv("QAAI_USER_COUNT")');
    expect(playwrightReference.emitStep(secretStep, {}, mappedOpts)).not.toContain('do-not-inline');
  });

  it.each([
    ['Selenium reference', seleniumReference],
    ['Selenium POM', seleniumPom],
  ])('applies the same literal, provider-key, and environment precedence in %s', (_label, adapter) => {
    const prepare = (opts, rows) => {
      if (adapter === seleniumPom) {
        adapter.emitSetup({ caseId: 'tc-data-binding', title: 'Data binding' }, opts);
        adapter.emitLocatorResolver(
          [{ strategy: 'role', role: 'textbox', name: 'User count' }],
          { op: 'resolve', as: 'userCount' },
          {},
          opts,
        );
      }
      adapter.emitDataProvider(rows, {}, opts);
    };
    const inlineOpts = {};
    prepare(inlineOpts, []);
    expect(adapter.emitStep(fillStep(), {}, inlineOpts)).toContain('"66"');
    expect(adapter.emitStep(fillStep(), {}, inlineOpts)).not.toContain('row.get(');

    const mappedOpts = { dataCaseSlug: 'mapped' };
    prepare(mappedOpts, [row({ userCount: '66' })]);
    expect(adapter.emitStep(fillStep(), {}, mappedOpts)).toContain('DataReader.required(row, "userCount")');

    const wrongKeyOpts = { dataCaseSlug: 'wrong-key' };
    prepare(wrongKeyOpts, [row({ activeCount: '63' })]);
    expect(adapter.emitStep(fillStep(), {}, wrongKeyOpts)).toContain('"66"');
    expect(adapter.emitStep(fillStep(), {}, wrongKeyOpts)).not.toContain('row.get(');

    const secretStep = fillStep({ valueRef: 'vault:user-count', rawValue: 'do-not-inline' });
    expect(adapter.emitStep(secretStep, {}, mappedOpts)).toContain('EnvReader.required("QAAI_VAULT_USER_COUNT")');
    expect(adapter.emitStep(secretStep, {}, mappedOpts)).not.toContain('do-not-inline');
  });
});
