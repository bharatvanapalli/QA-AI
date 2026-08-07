import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { transformConductorSource } = require('../../server/services/agents/conductorRuntimeLoader');

const conductorPath = path.resolve(process.cwd(), 'server/services/agents/conductor.js');
const runtimeLoaderPath = path.resolve(process.cwd(), 'server/services/agents/conductorRuntimeLoader.js');

function currentConductorSource() {
  return fs.readFileSync(conductorPath, 'utf8').replace(/\r\n/g, '\n');
}

function currentRuntimeLoaderSource() {
  return fs.readFileSync(runtimeLoaderPath, 'utf8').replace(/\r\n/g, '\n');
}

describe('conductor runtime loader', () => {
  it('repairs all six residual Conductor paths and produces syntax-valid CommonJS', () => {
    const transformed = transformConductorSource(currentConductorSource());
    const transformReport = [
      {
        residual: 'single-pass validation',
        removed: !transformed.includes("source: 'single_pass_validation_snapshot'")
          && !transformed.includes('const validateSnapshotSinglePass = (options = {}) => validateSnapshotSinglePassPolicy({'),
        installed: transformed.includes('const validateSnapshotSinglePass = async (options = {}) =>')
          && transformed.includes('validateSnapshotAdaptivePolicy({')
          && transformed.includes('adaptiveValidationContractForStep(validationStep, validationKind)'),
      },
      {
        residual: 'false retry narration and authored blocking',
        removed: !transformed.includes('staying on this step so the action can be re-attempted'),
        installed: transformed.includes('const authoredBlocking = authoredAssertionBlocksStep(_stepForVerify);')
          && transformed.includes('Continuation follows the authored dependency contract.'),
      },
      {
        residual: 'action and assertion outcome separation',
        removed: !transformed.includes('evidence: assertionResult || operationResult || originalRow.evidence || null'),
        installed: transformed.includes("outcome: assertionUncheckable ? 'uncheckable' : 'not_matched'")
          && transformed.includes('evidence: actionEvidence,')
          && transformed.includes('trailEntry.stepAssertion = stepAssertion;')
          && transformed.includes('trailEntry.stepOperationCheck = stepOperationCheck;'),
      },
      {
        residual: 'all-resolved prompt',
        removed: !transformed.includes('(none - all approved steps are already resolved)')
          && !transformed.includes('All approved steps are resolved. Verify every declared assertion')
          && !transformed.includes('All approved steps are resolved. Drive the browser'),
        installed: transformed.includes('Do not claim that every planned step executed or resolved.')
          && transformed.includes('No approved step remains runnable. Preserve journal truth'),
      },
      {
        residual: 'post-ratification reconciliation ordering',
        removed: transformed.indexOf('const stepOracleRepair = reconcileRecordedOutcomesWithStepOracle({')
          < transformed.indexOf('const ratified = await postLoopRatify({'),
        installed: transformed.includes('before post-loop ratification.'),
      },
      {
        residual: 'generic page transition authority',
        removed: !transformed.includes('auth_provider_credential_page_not_reached')
          && !transformed.includes('current page has not reached the Microsoft/SSO credential entry screen yet'),
        installed: transformed.includes('mcp.awaitPageTransitionObservation(mcpSession')
          && transformed.includes('qaai_transition_evidence_inconclusive')
          && transformed.includes('Narrative step prose was not used as a visible-text requirement.')
          && transformed.includes('stableObservations = 2'),
      },
    ];

    expect(transformReport).toHaveLength(6);
    expect(transformReport.map(({ residual }) => residual)).toEqual([
      'single-pass validation',
      'false retry narration and authored blocking',
      'action and assertion outcome separation',
      'all-resolved prompt',
      'post-ratification reconciliation ordering',
      'generic page transition authority',
    ]);
    expect(transformReport.every(({ removed, installed }) => removed && installed)).toBe(true);

    expect(() => new vm.Script(Module.wrap(transformed), {
      filename: conductorPath,
      displayErrors: true,
    })).not.toThrow();
  });

  it('fails closed when an expected source signature drifts', () => {
    const drifted = currentConductorSource().replace(
      "source: 'single_pass_validation_snapshot'",
      "source: 'renamed_validation_snapshot'",
    );

    expect(() => transformConductorSource(drifted)).toThrow(
      /CONDUCTOR_RUNTIME_TRANSFORM_SIGNATURE_MISMATCH:adaptive-validation-observation-source:expected=1:actual=0/,
    );
  });

  it('cannot contain or inject password-specific prefill, submit, or recovery logic', () => {
    const loaderSource = currentRuntimeLoaderSource();
    const transformed = transformConductorSource(currentConductorSource());
    const forbidden = [
      /authPasswordSubmitPlan/,
      /prefillAuthPasswordBeforeSubmit/,
      /refreshSnapshotForPotentialAuthPasswordSubmit/,
      /scheduleDeterministicPrerequisiteRecovery/,
      /snapshotShowsMissingRequiredInput/,
      /inputKind[^\n]{0,80}password/i,
      /requiredInputKind\s*:\s*['"]password['"]/i,
      /QAAI_PASSWORD_TARGET_RESOLUTION_FAILED/,
      /qaai_password_target_resolution/,
    ];

    for (const pattern of forbidden) {
      expect(loaderSource, `runtime loader contains ${pattern}`).not.toMatch(pattern);
      expect(transformed, `runtime transform injects ${pattern}`).not.toMatch(pattern);
    }
  });
});
