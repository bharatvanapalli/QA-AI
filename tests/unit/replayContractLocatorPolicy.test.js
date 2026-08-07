const replayContract = require('../../server/services/codegen/_replayContract');

function baseContract(overrides = {}) {
  return replayContract.validateContract({
    actions: [],
    declaredAssertions: [],
    authInfo: { preAuthenticated: true },
    credProfile: { missing: [] },
    exportStrictness: 'strict',
    replayIrItems: [],
    ...overrides,
  });
}

describe('journey replay contract locator policy', () => {
  test('keeps missing exact locator evidence diagnostic without changing action dependencies', () => {
    const original = {
      id: 'action-2',
      dependsOn: ['action-1'],
      disposition: 'committed',
      tool: 'browser_click',
      args: { element: 'Submit order button', role: 'button' },
      narration: 'Submit the order',
      kbMiss: true,
    };
    const contract = baseContract({ actions: [original] });

    expect(original).toMatchObject({
      id: 'action-2',
      dependsOn: ['action-1'],
      kbMiss: true,
    });
    expect(original).not.toHaveProperty('locator');
    expect(original).not.toHaveProperty('guessedLocator');
    expect(contract.verdict).toBe('exportable');
    expect(contract.warningGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'qaai_exact_locator_evidence_missing',
        severity: 'warning',
        nonBlocking: true,
        guessedLocator: false,
        guessedLocatorRequired: false,
      }),
    ]));
  });

  test('accepts exact live-node proof but rejects a snapshot-only semantic locator', () => {
    const expression = 'getByRole("button", { name: "Save changes" })';
    const snapshot = {
      kind: 'playwright',
      verified: true,
      verificationSource: 'verified_mcp_accessibility_snapshot',
      expression,
      frameworkExpressions: { playwright: expression },
      proof: { count: 1, sameElement: true, verified: true, source: 'verified_mcp_accessibility_snapshot' },
      domAtlas: { verifiedActions: [{ expression }] },
    };
    expect(replayContract.isVerifiedActionLocator(snapshot)).toBe(false);

    const identity = { documentId: 'doc-live', nodeId: 'node-save' };
    const live = {
      ...snapshot,
      verificationSource: 'verified_dom_inspection',
      proof: {
        count: 1,
        sameElement: true,
        verified: true,
        identityVerified: true,
        targetIdentity: identity,
        matchedIdentity: { ...identity },
        source: 'verified_dom_inspection',
      },
    };
    expect(replayContract.isVerifiedActionLocator(live)).toBe(true);
  });

  test('keeps locator-only incomplete ReplayIR exportable as diagnostics without guessed steps', () => {
    const action = {
      disposition: 'committed',
      tool: 'browser_click',
      args: { element: 'Save button', role: 'button' },
      narration: 'Save changes',
      kbMiss: true,
    };
    const replayIrJson = {
      complete: false,
      gaps: [{ code: 'missing_verified_action_locator', where: 'browser_click' }],
      evidenceSummary: { missingLocatorCount: 1 },
      steps: [],
    };
    const contract = baseContract({
      actions: [action],
      replayIrItems: [{ replayIrJson }],
    });

    expect(contract.verdict).toBe('exportable');
    expect(contract.irOk).toBe(true);
    expect(contract.kbMissCount).toBe(1);
    expect(contract.notExportableGaps).toEqual([]);
    expect(contract.repairableGaps).toEqual([]);
    expect(contract.warningGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'warning', nonBlocking: true }),
      expect.objectContaining({
        code: 'qaai_exact_locator_evidence_missing',
        guessedLocator: false,
        guessedLocatorRequired: false,
      }),
    ]));
    expect(JSON.stringify(replayIrJson)).not.toContain('qaai_guessed_locator');
  });

  test('does not hide non-locator ReplayIR incompleteness', () => {
    const contract = baseContract({
      replayIrItems: [{
        replayIrJson: {
          complete: false,
          gaps: [{ code: 'missing_assertion_expected' }],
          evidenceSummary: { missingAssertionCount: 1 },
          steps: [],
        },
      }],
    });

    expect(contract.verdict).toBe('not_exportable');
    expect(contract.irOk).toBe(false);
    expect(contract.notExportableGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: replayContract.GAP.INCOMPLETE_REPLAY_IR }),
    ]));

    const missingMember = baseContract({ replayIrItems: [{ replayIrJson: null }] });
    expect(missingMember.verdict).toBe('not_exportable');
    expect(missingMember.notExportableGaps[0].description).toContain('ordered actions and dependencies');

    const malformedMember = baseContract({ replayIrItems: [{ replayIrJson: '{bad json' }] });
    expect(malformedMember.verdict).toBe('not_exportable');
    expect(malformedMember.notExportableGaps[0].description).toContain('malformed ReplayIR JSON');
  });

  test('does not weaken auth or non-locator repair gates', () => {
    const authBlocked = baseContract({ authInfo: {} });
    expect(authBlocked.verdict).toBe('not_exportable');
    expect(authBlocked.notExportableGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: replayContract.GAP.MISSING_AUTH }),
    ]));

    const assertionRepair = baseContract({
      declaredAssertions: [{ id: 'assert-1', type: 'text', value: 'Order saved' }],
    });
    expect(assertionRepair.verdict).toBe('repairable');
    expect(assertionRepair.repairableGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: replayContract.GAP.UNSCOPED_ASSERTION }),
    ]));
  });
});
