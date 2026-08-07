import { describe, expect, it } from "vitest";
import readiness from "../../server/services/outputReadiness.js";
import pageObjectRepository from "../../server/services/codegen/pageObjectRepository.js";
import playwrightPomAdapter from "../../server/services/codegen/adapters/playwrightPom.js";

const verifiedLocatorFiles = {
  "locators/generated/loginPage.generated.locators.js": `export const loginPageLocators = {
  continueButton: (page) => page.getByRole("button", { name: "Continue" }),
};
`,
  "evidence/locator-manifest.json": JSON.stringify([
    {
      file: "loginPage",
      name: "continueButton",
      verified: true,
      verificationStatus: "verified",
      proof: { count: 1, sameElement: true },
    },
  ]),
};

function exactActionLocator(expression) {
  const identity = {
    scheme: "qaai-dom-node-v1",
    documentId: "document:login",
    nodeId: "node:continue",
    connected: true,
  };
  return {
    kind: "playwright",
    verified: true,
    expression,
    frameworkExpressions: { playwright: expression },
    strategy: "role",
    verificationSource: "verified_dom_inspection",
    evidenceSource: "verified_dom_inspection",
    captureBinding: { kind: "mcp_bound_ref", ref: "continue-ref" },
    proof: {
      source: "verified_dom_inspection",
      count: 1,
      sameElement: true,
      verified: true,
      actionTimeResolved: true,
      resolutionMode: "bound_mcp_ref",
      identityVerified: true,
      targetIdentity: identity,
      matchedIdentity: { ...identity },
    },
    targetFacts: { role: "button", accessibleName: "Continue" },
    domAtlas: {
      verifiedActions: [
        {
          expression,
          targetIdentity: identity,
          matchedIdentity: { ...identity },
        },
      ],
    },
  };
}

const certifiedScript = {
  bundleId: "bundle-current",
  packageHash: "hash-current",
  status: "certified",
  summary: { total: 1, passed: 1, failed: 0, skipped: 0 },
  outputQuality: {
    ok: true,
    files: ["tests/login.spec.js"],
    lintErrors: 0,
    unformatted: [],
  },
  certification: { certified: true, scriptResult: "Certified" },
};

function evaluate(overrides = {}) {
  return readiness.evaluateOutputReadiness({
    outputAvailable: true,
    preparing: 0,
    failedSafety: 0,
    exportValid: true,
    packagePassed: true,
    contractCertification: { packagePassed: true },
    contractFindings: [],
    errorFindings: [],
    files: verifiedLocatorFiles,
    scriptValidation: certifiedScript,
    currentBundleId: "bundle-current",
    currentPackageHash: "hash-current",
    ...overrides,
  });
}

describe("output readiness truth model", () => {
  it("preserves intentional mixed-case product tokens in domain page names", () => {
    expect(pageObjectRepository.pageFileName("root", "Welcome OdysseyOne")).toBe(
      "welcomeOdysseyOnePage",
    );
    expect(pageObjectRepository.pageFileName("root", "USER MANAGEMENT")).toBe(
      "userManagementPage",
    );
  });

  it("marks output ready only when package, contract, locator, quality and execution proofs all pass", () => {
    expect(evaluate()).toMatchObject({
      available: true,
      downloadable: true,
      generated: true,
      verified: true,
      runnable: true,
      certified: true,
      gaps: [],
    });
  });

  it.each([
    ["export invalid", { exportValid: false }, "export_not_validated"],
    ["package failed", { packagePassed: false }, "package_not_passed"],
    [
      "contract package failed",
      { contractCertification: { packagePassed: false } },
      "contract_not_certified",
    ],
    ["contract proof missing", { contractCertification: null }, "contract_not_certified"],
    [
      "contract errors",
      { contractFindings: [{ severity: "error", rule: "parity" }] },
      "contract_errors",
    ],
    [
      "script failed",
      {
        scriptValidation: {
          ...certifiedScript,
          status: "failed",
          summary: { total: 1, passed: 0, failed: 1 },
          certification: { certified: false },
          outputQuality: { ok: true },
        },
      },
      "script_validation_failed",
    ],
    ["script never run", { scriptValidation: null }, "script_not_run"],
    [
      "quality was never checked",
      { scriptValidation: { ...certifiedScript, outputQuality: undefined } },
      "generated_output_quality_failed",
    ],
    [
      "validation belongs to another bundle",
      { currentBundleId: "bundle-new" },
      "script_validation_stale",
    ],
    [
      "validation belongs to older package bytes",
      { currentPackageHash: "hash-new" },
      "script_validation_stale",
    ],
  ])(
    "keeps %s output downloadable but never ready",
    (_name, overrides, gap) => {
      const result = evaluate(overrides);
      expect(result.downloadable).toBe(true);
      expect(result.runnable).toBe(false);
      expect(result.certified).toBe(false);
      expect(result.gaps).toContain(gap);
    },
  );

  it("keeps guessed or unverified locator output downloadable but not certified", () => {
    const result = evaluate({
      files: {
        "evidence/locator-manifest.json": JSON.stringify([
          {
            name: "signInButton",
            guessedLocator: true,
            verified: false,
            locatorConfidence: "guessed",
          },
        ]),
      },
    });
    expect(result.downloadable).toBe(true);
    expect(result.locator).toMatchObject({
      total: 1,
      unverified: 1,
      guessed: 1,
      allVerified: false,
    });
    expect(result.certified).toBe(false);
    expect(result.gaps).toContain("locator_evidence_unverified");
  });

  it("keeps redacted safety findings downloadable and diagnostic-only", () => {
    const result = evaluate({ failedSafety: 2 });
    expect(result.downloadable).toBe(true);
    expect(result.available).toBe(true);
    expect(result.gaps).toContain("safety_findings_redacted");
  });

  it("reports authored assertion contracts separately from guessed locators", () => {
    const source = `export const welcomePageLocators = {
  welcomeMessage: (page) => page.getByText("Welcome", { exact: false }),
};
`;
    const result = readiness.summarizeLocatorReadiness({
      "locators/generated/welcomePage.generated.locators.js": source,
      "evidence/locator-manifest.json": JSON.stringify([
        {
          file: "welcomePage",
          name: "welcomeMessage",
          verified: false,
          source: "authored_assertion_contract",
          locatorProvenance: { kind: "authoredAssertionContract" },
        },
      ]),
    });
    expect(result).toMatchObject({
      required: 0,
      guessed: 0,
      contractBacked: 1,
      unverified: 0,
      coverageComplete: true,
      allVerified: true,
    });
  });

  it("does not let assertion-contract queries downgrade verified action locator coverage", () => {
    const source = `export const combinedPageLocators = {
  continueButton: (page) => page.getByRole("button", { name: "Continue" }),
  welcomeMessage: (page) => page.getByText("Welcome", { exact: false }),
};
`;
    const result = readiness.summarizeLocatorReadiness({
      "locators/generated/combinedPage.generated.locators.js": source,
      "evidence/locator-manifest.json": JSON.stringify([
        {
          file: "combinedPage",
          name: "continueButton",
          verified: true,
          verificationStatus: "verified",
          proof: { count: 1, sameElement: true },
        },
        {
          file: "combinedPage",
          name: "welcomeMessage",
          verified: false,
          source: "authored_assertion_contract",
          locatorProvenance: { kind: "authoredAssertionContract" },
        },
      ]),
    });

    expect(result).toMatchObject({
      total: 2,
      required: 1,
      identityMatched: 1,
      verified: 1,
      contractBacked: 1,
      unverified: 0,
      guessed: 0,
      coverageComplete: true,
      allVerified: true,
    });
    expect(result.unexpectedIdentities).toEqual([]);
  });

  it("preserves production action-time proof through the repository manifest and verifies the exact emitted locator", () => {
    const expression = 'getByRole("button", { name: "Continue" })';
    const repo = pageObjectRepository.buildLocatorRepository({
      cases: [
        {
          ir: {
            steps: [
              {
                op: "resolve",
                as: "continueButton",
                contractStepId: "TC-1:step:2",
                pageUrl: "https://app.test/auth/login",
                actionLocator: exactActionLocator(expression),
              },
            ],
          },
        },
      ],
    });
    const [file] = Object.keys(repo.files);
    const manifestEntry = repo.manifest[0];
    expect(manifestEntry).toMatchObject({
      file,
      name: "continueButton",
      contractStepId: "TC-1:step:2",
      verified: true,
      verificationStatus: "verified",
      proof: {
        count: 1,
        sameElement: true,
        actionTimeResolved: true,
        identityVerified: true,
      },
    });

    const locatorSource = playwrightPomAdapter._emitLocatorFileGenerated(
      file,
      repo.files[file],
      "js",
      "esm",
    );
    const result = readiness.summarizeLocatorReadiness({
      [`locators/generated/${file}.generated.locators.js`]: locatorSource,
      "evidence/locator-manifest.json": JSON.stringify(repo.manifest),
    });
    expect(result).toMatchObject({
      required: 1,
      identityMatched: 1,
      verified: 1,
      unverified: 0,
      coverageComplete: true,
      allVerified: true,
    });
  });

  it("does not let proof for a different file or method spoof emitted locator coverage", () => {
    const wrongMethod = readiness.summarizeLocatorReadiness({
      ...verifiedLocatorFiles,
      "evidence/locator-manifest.json": JSON.stringify([
        {
          file: "loginPage",
          name: "differentButton",
          verified: true,
          verificationStatus: "verified",
          proof: { count: 1, sameElement: true },
        },
      ]),
    });
    expect(wrongMethod).toMatchObject({
      required: 1,
      identityMatched: 0,
      verified: 0,
      coverageComplete: false,
      allVerified: false,
    });
    expect(wrongMethod.missingIdentities).toEqual([
      { file: "loginPage", name: "continueButton" },
    ]);
    expect(wrongMethod.unexpectedIdentities).toEqual([
      expect.objectContaining({ file: "loginPage", name: "differentButton" }),
    ]);

    const wrongFile = readiness.summarizeLocatorReadiness({
      ...verifiedLocatorFiles,
      "evidence/locator-manifest.json": JSON.stringify([
        {
          file: "otherPage",
          name: "continueButton",
          verified: true,
          verificationStatus: "verified",
          proof: { count: 1, sameElement: true },
        },
      ]),
    });
    expect(wrongFile).toMatchObject({
      identityMatched: 0,
      verified: 0,
      coverageComplete: false,
      allVerified: false,
    });
  });

  it("groups repeated authored references without inflating coverage and rejects an unverified duplicate", () => {
    const verifiedEntry = {
      file: "loginPage",
      name: "continueButton",
      verified: true,
      verificationStatus: "verified",
      proof: { count: 1, sameElement: true },
    };
    const repeatedVerified = readiness.summarizeLocatorReadiness({
      ...verifiedLocatorFiles,
      "evidence/locator-manifest.json": JSON.stringify([
        verifiedEntry,
        { ...verifiedEntry, contractStepId: "TC-1:step:3" },
      ]),
    });
    expect(repeatedVerified).toMatchObject({
      total: 1,
      required: 1,
      identityMatched: 1,
      verified: 1,
      duplicateReferences: 1,
      allVerified: true,
    });

    const mixedProof = readiness.summarizeLocatorReadiness({
      ...verifiedLocatorFiles,
      "evidence/locator-manifest.json": JSON.stringify([
        verifiedEntry,
        {
          ...verifiedEntry,
          contractStepId: "TC-1:step:3",
          verified: false,
          verificationStatus: "unverified",
          guessedLocator: true,
          proof: undefined,
        },
      ]),
    });
    expect(mixedProof).toMatchObject({
      total: 1,
      required: 1,
      verified: 0,
      unverified: 1,
      guessed: 1,
      duplicateReferences: 1,
      allVerified: false,
    });
  });

  it("never treats unknown or absent locator provenance as verified", () => {
    const unknown = evaluate({
      files: {
        "locators/generated/loginPage.generated.locators.js": verifiedLocatorFiles["locators/generated/loginPage.generated.locators.js"],
        "evidence/locator-manifest.json": JSON.stringify([
          { name: "continueButton" },
        ]),
        "evidence/locator-certification-report.json": JSON.stringify({
          summary: { total: 1, certified: 1, draft: 0, blocked: 0 },
        }),
      },
    });
    expect(unknown.locator).toMatchObject({
      total: 1,
      verified: 0,
      unverified: 1,
      allVerified: false,
    });
    expect(unknown.certified).toBe(false);

    const emptyReport = evaluate({
      files: {
        "locators/generated/loginPage.generated.locators.js": verifiedLocatorFiles["locators/generated/loginPage.generated.locators.js"],
        "evidence/locator-certification-report.json": JSON.stringify({
          summary: { total: 1, certified: 1 },
          steps: [],
        }),
      },
    });
    expect(emptyReport.locator).toMatchObject({
      required: 1,
      verified: 0,
      coverageComplete: false,
      allVerified: false,
    });
    expect(emptyReport.certified).toBe(false);

    const absent = evaluate({
      files: {
        "locators/loginPage.locators.js": "export const locators = {};\n",
      },
    });
    expect(absent.locator).toMatchObject({
      evidencePresent: false,
      allVerified: false,
    });
    expect(absent.certified).toBe(false);
  });

  it("keeps redacted safety findings diagnostic-only after successful verification", () => {
    const result = evaluate({ failedSafety: 1 });
    expect(result).toMatchObject({
      downloadable: true,
      certified: true,
    });
    expect(result.gaps).toContain("safety_findings_redacted");
  });

  it("does not allow a successful script run to bypass failed static verification", () => {
    const result = evaluate({ exportValid: false });
    expect(result.script).toMatchObject({ runPassed: true, current: true, passed: true });
    expect(result.verified).toBe(false);
    expect(result.runnable).toBe(false);
    expect(result.downloadable).toBe(true);
  });
});
