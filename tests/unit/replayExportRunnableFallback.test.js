const replayExport = require('../../server/services/codegen/replayExport');
const registry = require('../../server/services/codegen/adapters');
const playwrightReference = require('../../server/services/codegen/adapters/playwrightReference').playwrightReferenceJs;
const certify = require('../../server/services/codegen/_certify');

afterEach(() => vi.restoreAllMocks());

function authoredResult(overrides = {}) {
  return {
    runResultId: '8dcd9ec1-4b64-46ff-91d7-b94fa820df5f',
    testCaseId: 'tc-73fe4685-43da-4768-9d50-d8b30bb8dc28',
    caseName: 'Manage active users',
    moduleName: 'User administration',
    status: 'blocked',
    dependsOnIds: ['tc-internal-prerequisite'],
    declaredSteps: [
      { action: 'navigate', url: 'https://app.example.test/users' },
      { action: 'fill', target: 'User search', value: 'Pranavijay Ikhar' },
      { action: 'click', target: 'Search button' },
      { action: 'wait', target: 'Results table', waitContract: { timeoutMs: 5000 } },
      { action: 'synchronize external account', target: 'Directory service' },
    ],
    declaredAssertionsRaw: JSON.stringify([{ type: 'UI_TEXT', target: 'Results table', expected: 'Pranavijay Ikhar' }]),
    ...overrides,
  };
}

describe('replay export diagnostic-only last-resort behavior', () => {
  it('keeps authored-only operations downloadable as non-test diagnostics without guessed runnable locators', () => {
    vi.spyOn(registry, 'getAdapter').mockReturnValue({ id: 'playwright-reference' });
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-reference',
      adapterVersion: 'playwright-reference-1',
      targetUrl: 'https://app.example.test',
      results: [authoredResult(), authoredResult({ runResultId: 'rr-second', testCaseId: 'tc-second' })],
      blocked: [{ code: 'source_evidence_incomplete' }],
    });

    const specs = Object.keys(files).filter((rel) => /\.spec\.[cm]?[jt]sx?$/i.test(rel));
    const diagnostics = Object.keys(files).filter((rel) => rel.includes('.diagnostic.'));
    expect(specs).toHaveLength(0);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.join('\n')).not.toMatch(/8dcd9ec1|73fe4685|rr-second|tc-second/);
    for (const diagnostic of diagnostics) {
      expect(files[diagnostic]).toContain('No Playwright test was emitted');
      expect(files[diagnostic]).not.toMatch(
        /test\s*\(|QAAI_GUESSED_LOCATOR|getByRole|getByText|\.fill\(|\.click\(/,
      );
    }

    const live = JSON.parse(files['evidence/live-output-status.json']);
    expect(live).toMatchObject({
      status: 'generated_draft',
      allBlocked: false,
      outputAvailable: true,
      exportValid: false,
      validationStatus: 'not_run',
      runnable: false,
      certified: false,
    });
  });

  it('uses deterministic semantic data filenames instead of run identifiers', () => {
    const files = replayExport.collectDataFiles([
      authoredResult({ envelope: { ir: { dataRow: { index: 0, label: 'Primary', fields: { Role: 'Admin' } } } } }),
      authoredResult({ runResultId: 'rr-second', envelope: { ir: { dataRow: { index: 1, label: 'Secondary', fields: { Role: 'User' } } } } }),
    ]);
    expect(Object.keys(files)).toEqual([
      'tests/data/manage-active-users.json',
      'tests/data/manage-active-users-2.json',
    ]);
  });

  it('keeps an unexecuted duration-only authored wait diagnostic instead of inventing a sleep', () => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'playwright-reference',
      adapterVersion: 'playwright-reference-1',
      targetUrl: 'https://app.example.test',
      results: [authoredResult({
        declaredSteps: [{ action: 'wait', timeoutMs: 750, description: 'Wait briefly' }],
        declaredAssertionsRaw: [],
      })],
      blocked: [{ code: 'source_evidence_incomplete' }],
    });

    const specs = Object.keys(files).filter((rel) => /\.spec\.[cm]?[jt]sx?$/i.test(rel));
    const diagnostics = Object.keys(files).filter((rel) => rel.endsWith('.diagnostic.ts'));
    expect(specs).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    const source = files[diagnostics[0]];
    expect(source).toContain('No Playwright test was emitted');
    expect(source).not.toContain('waitForTimeout');
    expect(source).not.toContain('duration_only');
    expect(source).not.toContain('expect.soft(false');
    expect(source).not.toContain('brieflyButton');
  });

  it('keeps an empty Selenium selection in Selenium with an enabled failing diagnostic', () => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId: 'selenium-reference',
      adapterVersion: 'selenium-reference-1',
      results: [],
    });
    const javaTest = Object.keys(files).find((rel) => /MissingAuthoredSourceContractTest\.java$/.test(rel));
    expect(javaTest).toBeTruthy();
    expect(files[javaTest]).toContain('soft.assertTrue(false');
    expect(Object.keys(files).some((rel) => rel.endsWith('.spec.ts') || rel.endsWith('.feature'))).toBe(false);
    const live = JSON.parse(files['evidence/live-output-status.json']);
    expect(live).toMatchObject({
      status: 'generated_draft',
      allBlocked: false,
      outputAvailable: true,
      exportValid: false,
      validationStatus: 'not_run',
      runnable: false,
      certified: false,
    });
  });

  it.each(['replayir-bdd', 'selenium-bdd-reference'])('keeps an empty %s selection in BDD output', (adapterId) => {
    const files = replayExport.buildBlockedPreviewPackage({
      adapterId,
      adapterVersion: `${adapterId}-1`,
      results: [],
    });

    const featurePath = Object.keys(files).find((rel) => rel.endsWith('.feature'));
    expect(featurePath).toBeTruthy();
    expect(files[featurePath]).toContain('@runnable-unverified');
    expect(files[featurePath]).not.toContain('@skip');
    expect(Object.keys(files).some((rel) => rel.endsWith('.spec.ts'))).toBe(false);
    const live = JSON.parse(files['evidence/live-output-status.json']);
    expect(live).toMatchObject({
      adapterId,
      status: 'generated_draft',
      allBlocked: false,
      outputAvailable: true,
      exportValid: false,
      validationStatus: 'not_run',
      runnable: false,
      certified: false,
    });
  });

  it('preserves invalid adapter source as evidence and emits a non-test diagnostic', () => {
    vi.spyOn(certify, 'certifyFile').mockReturnValue({
      parseOk: false,
      parseError: 'Unexpected token',
      findings: [{ rule: 'source_parse_error', severity: 'error' }],
      rewrites: [],
    });
    const result = authoredResult({
      status: 'pass',
      envelope: {
        complete: true,
        ir: {
          caseId: 'semantic-manage-active-users',
          title: 'Manage active users',
          authProfile: { mode: 'none' },
          steps: [{
            op: 'act',
            action: 'navigate',
            url: 'https://app.example.test/users',
            origin: 'runtime_evidence',
            executionStatus: 'passed',
          }],
          verdict: { status: 'pass' },
        },
      },
    });
    const compiled = replayExport.compileResults({ adapter: playwrightReference, results: [result] });
    expect(compiled.admitted).toHaveLength(1);
    expect(compiled.admitted[0]).toMatchObject({
      diagnosticOnly: true,
      diagnosticReason: 'generated_source_syntax_diagnostic',
    });
    expect(compiled.admitted[0].filePath).toMatch(/\.diagnostic\.js$/);
    expect(compiled.admitted[0].filePath).not.toMatch(/\.spec\.[cm]?[jt]sx?$/i);
    expect(compiled.admitted[0].content).toContain('No Playwright test was emitted');
    expect(compiled.admitted[0].content).not.toMatch(
      /test\s*\(|QAAI_GUESSED_LOCATOR|getByRole|getByText/,
    );
    const evidencePath = Object.keys(compiled.admitted[0].extraFiles).find((rel) => rel.endsWith('.generated-source.txt'));
    expect(evidencePath).toBeTruthy();
    expect(compiled.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule: 'generated_source_syntax_diagnostic',
        severity: 'warning',
        nonBlocking: true,
      }),
    ]));
  });

  it('emits non-test diagnostics when a required journey emitter is unavailable', () => {
    const adapter = { ...playwrightReference, emitJourneySpec: undefined };
    const first = authoredResult({
      runResultId: 'rr-login',
      testCaseId: 'tc-login',
      scenarioId: 'scenario-users',
      scenarioName: 'Authenticated user management',
      dependsOnIds: [],
      envelope: { complete: true, ir: { caseId: 'open-users', title: 'Open users', authProfile: { mode: 'none' }, steps: [{ op: 'act', action: 'navigate', url: 'https://app.example.test/users', origin: 'runtime_evidence', executionStatus: 'passed' }], verdict: { status: 'pass' } } },
    });
    const second = authoredResult({
      runResultId: 'rr-search',
      testCaseId: 'tc-search',
      scenarioId: 'scenario-users',
      scenarioName: 'Authenticated user management',
      dependsOnIds: ['tc-login'],
      envelope: { complete: true, ir: { caseId: 'search-users', title: 'Search users', authProfile: { mode: 'none' }, steps: [{ op: 'act', action: 'navigate', url: 'https://app.example.test/users?search=active', origin: 'runtime_evidence', executionStatus: 'passed' }], verdict: { status: 'pass' } } },
    });
    const compiled = replayExport.compileResults({ adapter, results: [first, second] });
    expect(compiled.admitted).toHaveLength(2);
    for (const diagnostic of compiled.admitted) {
      expect(diagnostic.diagnosticOnly).toBe(true);
      expect(diagnostic.filePath).toMatch(/\.diagnostic\.js$/);
      expect(diagnostic.filePath).not.toMatch(/\.spec\.[cm]?[jt]sx?$/i);
      expect(diagnostic.content).toContain('No Playwright test was emitted');
      expect(diagnostic.content).not.toMatch(
        /test\s*\(|QAAI_GUESSED_LOCATOR|getByRole|getByText/,
      );
    }
    expect(compiled.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'journey_emit_unsupported_diagnostic', nonBlocking: true }),
    ]));
    expect(compiled.findings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: 'journey_emit_unsupported_fell_back_per_case' }),
    ]));
  });
});
