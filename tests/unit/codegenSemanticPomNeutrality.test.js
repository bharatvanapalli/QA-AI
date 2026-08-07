const fs = require('fs');
const path = require('path');
const pageObjects = require('../../server/services/codegen/pageObjectRepository');
const pomArchitect = require('../../server/services/codegen/pomArchitectAgent');

function verifiedLocator(expression, role, accessibleName) {
  const identity = {
    scheme: 'qaai-dom-node-v1',
    documentId: 'document:neutral-fixture',
    nodeId: 'node:neutral-target',
    connected: true,
  };
  return {
    kind: 'playwright',
    verified: true,
    expression,
    frameworkExpressions: { playwright: expression },
    verificationSource: 'verified_dom_inspection',
    evidenceSource: 'verified_dom_inspection',
    captureBinding: { kind: 'mcp_bound_ref', ref: 'neutral-ref' },
    proof: {
      source: 'verified_dom_inspection',
      count: 1,
      sameElement: true,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: 'bound_mcp_ref',
      identityVerified: true,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    domAtlas: {
      verifiedActions: [{ expression, targetIdentity: identity, matchedIdentity: { ...identity } }],
    },
    targetFacts: { role, accessibleName },
  };
}

describe('website-neutral semantic POM architecture', () => {
  it('uses semantic or stable route page names and never emits RootPage for an unknown context', () => {
    expect(pageObjects.pageFileName(pageObjects.pageKey(''), null)).toBe('workspacePage');
    expect(pageObjects.pageFileName(pageObjects.pageKey('https://example.test/'), null)).toBe('workspacePage');
    expect(pageObjects.pageFileName(pageObjects.pageKey('https://example.test/home'), null)).toBe('homePage');
    expect(pageObjects.pageFileName(pageObjects.pageKey('https://example.test/records/9f1a1b2c-7788-49df-8db0-a224579a33ef'), null)).toBe('recordsPage');
    expect(pageObjects.pageFileName('root', 'Enter password for person@example.test')).toBe('passwordPage');
  });

  it('keeps exact action-time locator provenance while sanitizing runtime values from identifiers', () => {
    const expression = 'getByRole("textbox", { name: "Enter password for person@example.test", exact: true })';
    const repo = pageObjects.buildLocatorRepository({
      cases: [{
        ir: {
          inlineValues: { account: 'person@example.test' },
          steps: [
            { op: 'act', action: 'navigate', url: 'https://identity.example.test/session/start' },
            {
              op: 'resolve', as: 'passwordTarget', pageName: 'Account access',
              contractStepId: 'account-access-password',
              pageUrl: 'https://identity.example.test/session/start',
              actionLocator: verifiedLocator(expression, 'textbox', 'Enter password for person@example.test'),
              candidates: [{ strategy: 'role', role: 'textbox', name: 'Enter password for person@example.test' }],
            },
            { op: 'act', action: 'fill', target: 'passwordTarget', rawValue: 'person@example.test' },
          ],
        },
      }],
    });

    expect(Object.keys(repo.files)).toEqual(['accountAccessPage']);
    expect(repo.files.accountAccessPage.passwordInput.expr).toBe(`page.${expression}`);
    expect(repo.files.accountAccessPage.passwordInput.source).toBe('actionLocator');
    expect(repo.manifest[0]).toMatchObject({
      file: 'accountAccessPage',
      name: 'passwordInput',
      verified: true,
      verificationSource: 'verified_dom_inspection',
      evidenceSource: 'verified_dom_inspection',
    });
    const publicIdentifiers = [
      ...Object.keys(repo.files),
      ...Object.values(repo.files).flatMap((entries) => Object.keys(entries)),
    ].join(' ');
    expect(publicIdentifiers).not.toMatch(/person|exampletest|9f1a1b2c/i);
  });

  it('derives unrelated page objects from each case evidence without shared domain vocabulary', () => {
    const repo = pageObjects.buildLocatorRepository({
      cases: [
        { ir: { steps: [
          { op: 'act', action: 'navigate', url: 'https://alpha.example.test/orchards/inspection' },
          {
            op: 'resolve', as: 'approve', pageTitle: 'Harvest Review', pageUrl: 'https://alpha.example.test/orchards/inspection',
            actionLocator: verifiedLocator('getByRole("button", { name: "Approve harvest", exact: true })', 'button', 'Approve harvest'),
            candidates: [{ strategy: 'role', role: 'button', name: 'Approve harvest' }],
          },
        ] } },
        { ir: { steps: [
          { op: 'act', action: 'navigate', url: 'https://beta.example.test/laboratory/intake' },
          {
            op: 'resolve', as: 'record', pageTitle: 'Specimen Intake', pageUrl: 'https://beta.example.test/laboratory/intake',
            actionLocator: verifiedLocator('getByLabel("Sample mass", { exact: true })', 'textbox', 'Sample mass'),
            candidates: [{ strategy: 'label', text: 'Sample mass' }],
          },
        ] } },
      ],
    });

    expect(Object.keys(repo.files).sort()).toEqual(['harvestReviewPage', 'specimenIntakePage']);
    expect(repo.files.harvestReviewPage.approveHarvestButton).toBeTruthy();
    expect(repo.files.specimenIntakePage.sampleMassInput).toBeTruthy();
  });

  it('keeps one-off actions direct and records only repeated verified direct-method reuse', () => {
    const resolve = {
      op: 'resolve', as: 'confirmTarget',
      contractStepId: 'confirm-resolve',
      actionLocator: verifiedLocator('getByRole("button", { name: "Confirm", exact: true })', 'button', 'Confirm'),
    };
    const first = { op: 'act', action: 'click', target: 'confirmTarget', contractStepId: 'confirm-first' };
    const second = { op: 'act', action: 'click', target: 'confirmTarget', contractStepId: 'confirm-second' };
    const info = { file: 'reviewPage', name: 'confirmButton', pageVar: 'reviewPage' };
    const caseMap = new Map([['confirmTarget', info]]);
    const single = pomArchitect.buildPomArchitectGraph({ caseEntries: [{ caseItem: { ir: { steps: [resolve, first] } }, caseMap }] });
    expect(single.specPlan).toEqual([]);
    expect(single.pages).toEqual({});

    const repeated = pomArchitect.buildPomArchitectGraph({ caseEntries: [{ caseItem: { testCaseId: 'case-neutral', ir: { steps: [resolve, first, second] } }, caseMap }] });
    const report = pomArchitect.serializableReport(repeated);
    expect(report.repeatedVerifiedActions).toHaveLength(1);
    expect(report.pages.reviewPage.reusedDirectMethods[0]).toMatchObject({ action: 'click', locator: 'confirmButton', sourceStepIds: ['confirm-first', 'confirm-second'] });
    expect(report.pages.reviewPage.architectMethods).toEqual([]);
    expect(report.pages.reviewPage.assertionMethods).toEqual([]);
  });

  it('contains no domain-specific standard-method injection in the neutral architect source', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../server/services/codegen/pomArchitectAgent.js'), 'utf8');
    expect(source).not.toMatch(/CATEGORY_VALUES|SUBCATEGORY_VALUES|ensureStandardAssertionMethods|selectBrand|searchForProduct|expectProduct|features_items|brands_products/i);
  });
});
